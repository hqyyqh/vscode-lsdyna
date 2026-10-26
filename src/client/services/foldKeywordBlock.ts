export {};
const fs = require('fs');
const vscode = require('vscode');
const i18n = require('../../core/i18n');
const { BlockIndex } = require('../../core/incremental/blockIndex');
let request = 0;
const structures = new WeakMap();

/** Manual native ranges also work when a large editor is not synchronized to extensions. */
async function foldKeywordBlock(item, all = false, atCursor = false) {
    const occurrence = item?.occurrence;
    if (!all && !atCursor && (!occurrence?.filePath || !Number.isInteger(occurrence.startLine) || occurrence.startLine < 0)) return;
    const generation = ++request;
    const uri = all || atCursor ? vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri
        : vscode.Uri.file(occurrence.filePath);
    if (!uri || (uri.scheme && uri.scheme !== 'file')) return;
    const warn = key => vscode.window.showWarningMessage(i18n.get(key));
    let restoreCursor;
    try {
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        const current = () => generation === request && vscode.window.tabGroups.activeTabGroup.activeTab === tab &&
            tab?.input?.uri?.toString() === uri.toString();
        if (!current()) return;
        const document = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.toString() === uri.toString());
        const editor = vscode.window.activeTextEditor;
        const synchronized = document && editor?.document === document;
        const cursorLine = atCursor && synchronized ? editor.selection.active.line : undefined;
        const nativeCursor = atCursor && !synchronized;
        if (!document && vscode.workspace.getConfiguration('editor', uri).get('largeFileOptimizations', true)) {
            return warn('keywordFoldLargeFileOptimizations');
        }
        if (!vscode.workspace.getConfiguration('editor', uri).get('folding', true)) return warn('keywordFoldDisabled');
        const version = document?.version;
        const clean = () => current() && (document
            ? !document.isClosed && document.version === version
            : !vscode.window.tabGroups.all.some(group => group.tabs.some(candidate =>
                candidate.input?.uri?.toString() === uri.toString() && candidate.isDirty)));
        if (!clean()) return warn('keywordFoldChanged');
        const stamp = stat => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const before = document ? null : stamp(await fs.promises.stat(uri.fsPath));
        const cached = structures.get(tab);
        const reusable = cached?.uri === uri.toString() && cached.document === document &&
            cached.version === version && cached.stamp === before;
        const index = reusable ? cached.index : new BlockIndex(uri.fsPath);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Window,
            title: i18n.get('keywordFoldProgress'), cancellable: true }, async (_progress, token) => {
            const options = { cancellationToken: { get isCancellationRequested() { return token.isCancellationRequested || !clean(); } } };
            try {
                // Reuse the scan independently of native range preparation.
                if (!reusable) {
                    if (document) await index.buildIndexAsync(document.lineCount, line => document.lineAt(line).text,
                        { shouldCancel: () => options.cancellationToken.isCancellationRequested });
                    else await index.buildIndexFromFile(uri.fsPath, options);
                }
            } catch (error) {
                if (!options.cancellationToken.isCancellationRequested) throw error;
            }
            if (options.cancellationToken.isCancellationRequested) return;
            if (!clean() || (!document && before !== stamp(await fs.promises.stat(uri.fsPath)))) return warn('keywordFoldChanged');
            const snapshot = reusable ? cached : { uri: uri.toString(), document, version, stamp: before, index, nativeRangesReady: false };
            structures.set(tab, snapshot);
            // Native fold-up would also collapse indentation parents spanning multiple keyword blocks.
            if (nativeCursor && index.blocks.some(block => block.keywordStartChar > 0)) return warn('keywordFoldCursorIndented');
            // ponytail: manual range removals are not observable; rebuild with Fold All until VS Code exposes range-change events.
            if (nativeCursor && snapshot.nativeRangesReady) {
                if (!clean()) return;
                await vscode.commands.executeCommand('removeSecondaryCursors');
                if (clean()) await vscode.commands.executeCommand('editor.fold', { direction: 'up', levels: Number.MAX_SAFE_INTEGER });
                return;
            }
            const blocks = all || nativeCursor ? index.blocks : atCursor ? [index.findBlockAtLine(cursorLine)].filter(Boolean)
                : index.blocks.filter(candidate => candidate.startLine === occurrence.startLine &&
                candidate.endLine === occurrence.endLine && candidate.keyword === occurrence.rawKeyword);
            if (!all && !blocks.length) return atCursor ? undefined : warn('keywordFoldChanged');
            const foldable = blocks.filter(block => block.endLine > block.startLine);
            if (!foldable.length) return;
            const commands = synchronized ? [] : await vscode.commands.getCommands();
            if (nativeCursor) {
                if (!['editor.action.setSelectionAnchor', 'editor.action.goToSelectionAnchor', 'editor.action.cancelSelectionAnchor']
                    .every(command => commands.includes(command))) return warn('keywordFoldCursorUnavailable');
                if (!clean()) return;
                await vscode.commands.executeCommand('removeSecondaryCursors');
                if (!clean()) return;
                await vscode.commands.executeCommand('editor.action.setSelectionAnchor');
                restoreCursor = async () => {
                    if (!current()) return;
                    if (clean()) await vscode.commands.executeCommand('editor.action.goToSelectionAnchor');
                    if (current()) await vscode.commands.executeCommand('editor.action.cancelSelectionAnchor');
                };
            }
            // ponytail: native multi-cursor commands are version-dependent; use single ranges if unavailable.
            const nativeBatch = ['runCommands', 'setSelection', 'createCursor', '_lastCursorMoveToSelect']
                .every(command => commands.includes(command));
            const batchSize = synchronized || nativeBatch
                ? Math.max(1, Math.min(128, vscode.workspace.getConfiguration('editor', uri).get('multiCursorLimit', 10000))) : 1;
            for (let offset = 0; offset < foldable.length; offset += batchSize) {
                if (options.cancellationToken.isCancellationRequested) return;
                if (!document && before !== stamp(await fs.promises.stat(uri.fsPath))) return warn('keywordFoldChanged');
                if (options.cancellationToken.isCancellationRequested) return;
                const batch = foldable.slice(offset, offset + batchSize);
                const selections = batch.map(block => ({
                    selectionStartLineNumber: block.startLine + 1, selectionStartColumn: 2,
                    positionLineNumber: Math.min(block.endLine + 2, index.lineCount),
                    positionColumn: block.endLine + 1 < index.lineCount ? 1 : 2147483647,
                }));
                if (synchronized) {
                    // Start after '*' so adjacent keyword selections do not merge at their shared boundary.
                    editor.selections = selections.map(s => new vscode.Selection(
                        new vscode.Position(s.selectionStartLineNumber - 1, 1),
                        new vscode.Position(s.positionLineNumber - 1, s.positionColumn - 1)));
                    await vscode.commands.executeCommand('editor.createFoldingRangeFromSelection');
                } else if (nativeBatch) {
                    const batchCommands: any[] = [{ command: 'setSelection', args: { selection: selections[0] } }];
                    for (const selection of selections.slice(1)) batchCommands.push(
                        { command: 'createCursor', args: { position: { lineNumber: selection.selectionStartLineNumber, column: 2 } } },
                        { command: '_lastCursorMoveToSelect', args: { position: { lineNumber: selection.positionLineNumber, column: selection.positionColumn } } });
                    await vscode.commands.executeCommand('runCommands', { commands: [...batchCommands, 'editor.createFoldingRangeFromSelection'] });
                } else {
                    const s = selections[0];
                    await vscode.commands.executeCommand('vscode.openWith', uri, 'default', {
                        selection: new vscode.Range(s.selectionStartLineNumber - 1, 1, s.positionLineNumber - 1, s.positionColumn - 1),
                    });
                    if (options.cancellationToken.isCancellationRequested) return;
                    await vscode.commands.executeCommand('editor.createFoldingRangeFromSelection');
                }
            }
            if (options.cancellationToken.isCancellationRequested) return;
            if (!document && before !== stamp(await fs.promises.stat(uri.fsPath))) return warn('keywordFoldChanged');
            if (options.cancellationToken.isCancellationRequested) return;
            if (all || nativeCursor) snapshot.nativeRangesReady = true;
            if (nativeCursor) {
                await vscode.commands.executeCommand('editor.unfoldAll');
                await restoreCursor(); restoreCursor = undefined;
                if (!options.cancellationToken.isCancellationRequested) {
                    await vscode.commands.executeCommand('editor.fold', { direction: 'up', levels: Number.MAX_SAFE_INTEGER });
                }
            }
            if (all && !options.cancellationToken.isCancellationRequested) await vscode.commands.executeCommand('vscode.openWith', uri, 'default', {
                selection: new vscode.Range(0, 0, 0, 0),
            });
        });
    } catch (error) {
        if (error?.name !== 'CancellationError' && error?.code !== 'CANCELLED') await warn('keywordFoldFailed');
    } finally {
        if (restoreCursor) await restoreCursor();
    }
}

async function unfoldAllKeywordBlocks() {
    request++;
    await vscode.commands.executeCommand('editor.unfoldAll');
}

module.exports = { foldKeywordBlock, foldAllKeywordBlocks: () => foldKeywordBlock(undefined, true),
    foldKeywordAtCursor: () => foldKeywordBlock(undefined, false, true), unfoldAllKeywordBlocks };
