'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
exports.run = async () => {
    const root = process.env.LARGE_VIEWER_EVIDENCE;
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    await extension.activate();
    fs.writeFileSync(path.join(root, 'host.json'), JSON.stringify({ language: vscode.env.language, version: vscode.version }));
    const file = path.join(root, 'large-model.k');
    assert.equal(await vscode.commands.executeCommand('extension.openLsdynaLargeFileViewer', { uri: vscode.Uri.file(file), line: JSON.parse(fs.readFileSync(path.join(root, 'model.json'))).rows + 3, startCharacter: 0, endCharacter: 10 }), true);
    const deadline = Date.now() + 180000;
    let lastCommand = 0;
    let recoveryDocument, recoveryPanel, recoveryProvider;
    const reply = value => {
        const file = path.join(root, `editor-command-result-${value.id}.json`);
        fs.writeFileSync(file + '.tmp', JSON.stringify(value));
        fs.renameSync(file + '.tmp', file);
    };
    while (!fs.existsSync(path.join(root, 'renderer-finished.json'))) {
        const commandFile = path.join(root, `editor-command-${lastCommand + 1}.json`);
        if (fs.existsSync(commandFile)) {
            const request = JSON.parse(fs.readFileSync(commandFile, 'utf8'));
            if (request.id > lastCommand) {
                lastCommand = request.id;
                try {
                    if (request.command === 'test.progressiveViewer') {
                        const { LargeFileViewerProvider } = require(path.join(extension.extensionPath, 'out/client/LargeFileViewerProvider.js'));
                        const { buildFileStructure } = require(path.join(extension.extensionPath, 'out/core/scanner/fileIndexBuilder.js'));
                        const source = vscode.Uri.file(path.join(root, 'progressive.k')).fsPath;
                        const output = fs.openSync(source, 'w');
                        try {
                            fs.writeSync(output, '*KEYWORD\n*MAT_ELASTIC\n         7    7.8e-9    210000       0.3\n');
                            for await (const chunk of fs.createReadStream(file)) fs.writeSync(output, chunk);
                        } finally { fs.closeSync(output); }
                        const provider = new LargeFileViewerProvider(extension.extensionPath, { get(_key, fallback){return fallback;},update(){} }, {
                            loadFileIndex: async (file, cancellationToken, onProgress) => {
                                let progress, held = false, last = 0;
                                return buildFileStructure(file, { largeFileThresholdBytes:0, highWaterMark:64*1024, cancellationToken,
                                    onLargeFileProgress: value => { progress = value; },
                                    flushStructure: async () => {
                                        if (progress && Date.now() - last > 200) { last = Date.now(); await onProgress(progress); }
                                        if (!held) {
                                            held = true;
                                            fs.writeFileSync(path.join(root, 'index-paused.json'), JSON.stringify({ scannedBytes:progress.scannedBytes, lines:progress.largeFileLineMap.lineCount, size:progress.size }));
                                            while (!fs.existsSync(path.join(root, 'continue-index')) && !cancellationToken.isCancellationRequested)
                                                await new Promise(resolve => setTimeout(resolve, 50));
                                        }
                                    } });
                            }, queryObject: async () => { throw Error('Partial object query must not run'); },
                        }, path.join(root, 'progressive-storage'));
                        const document = await provider.openCustomDocument(vscode.Uri.file(source), {});
                        const panel = vscode.window.createWebviewPanel('lsdyna.progressiveFixture', 'Progressive fixture', vscode.ViewColumn.Active, { enableScripts:true });
                        panel.onDidDispose(() => { provider.dispose(); document.dispose(); });
                        await provider.resolveCustomEditor(document, panel);
                    } else if (request.command === 'test.manualSidebar') {
                        const { ManualSidebarProvider } = require(path.join(extension.extensionPath, 'out/manual/ManualSidebarProvider.js'));
                        const panel = vscode.window.createWebviewPanel('manual-sidebar-test', 'Manual sidebar fixture', vscode.ViewColumn.Active, { enableScripts: true });
                        const provider = new ManualSidebarProvider(() => {});
                        provider.resolveWebviewView({ webview: panel.webview });
                        provider.refresh({
                            listDocuments: () => [{ manualId: 'vol-i', title: 'Volume I', order: 1 }],
                            listSections: () => [{ manualId: 'vol-i', sectionId: 'node', titleEn: '*NODE', titleZh: '节点', level: 2,
                                anchors: ['node'], pathEn: 'documents/en/vol-i/chunks/06_nodes/node.md', pathZh: 'documents/zh/vol-i/chunks/06_nodes/node.md', pdfPage: 7 }],
                            search: () => [],
                        });
                    } else if (request.command === 'test.recovery') {
                        const { LargeFileEditDocument } = require(path.join(extension.extensionPath, 'out/core/edit/largeFileEditDocument.js'));
                        const { LargeFileViewerProvider } = require(path.join(extension.extensionPath, 'out/client/LargeFileViewerProvider.js'));
                        const { buildFileIndex } = require(path.join(extension.extensionPath, 'out/core/scanner/fileIndexBuilder.js'));
                        const source = vscode.Uri.file(path.join(root, 'recovery.k')).fsPath;
                        fs.writeFileSync(source, '*KEYWORD\n*MAT_ELASTIC\n         7    7.8e-9    210000       0.3\n*END\n');
                        const legacy = new LargeFileEditDocument(source, path.join(root, 'legacy'));
                        await legacy.prepare(2, 2);
                        const backup = await legacy.backup(path.join(root, 'legacy-backup'), { firstLine:2,lastLine:2,text:'         7    7.8e-9    230000       0.3\n' });
                        await legacy.dispose();
                        recoveryProvider = new LargeFileViewerProvider(extension.extensionPath, { get(_key, fallback){return fallback;},update(){} }, {
                            loadFileIndex: file => buildFileIndex(file, { largeFileThresholdBytes:0 }), queryObject: async () => false,
                        }, path.join(root, 'recovery-storage'));
                        recoveryDocument = await recoveryProvider.openCustomDocument(vscode.Uri.file(source), { backupId: backup.id });
                        recoveryPanel = vscode.window.createWebviewPanel('lsdyna.recoveryFixture', 'Recovery fixture', vscode.ViewColumn.Active, { enableScripts:true });
                        await recoveryProvider.resolveCustomEditor(recoveryDocument, recoveryPanel);
                    } else if (request.command === 'test.recoveryRetained') {
                        assert.ok(recoveryDocument.edits.dirty);
                        assert.ok(fs.readFileSync(recoveryDocument.edits.contentPath, 'utf8').includes('230000'));
                        assert.ok(fs.readFileSync(path.join(root, 'recovery.k'), 'utf8').includes('210000'));
                        assert.ok(fs.existsSync(path.join(root, 'legacy-backup')));
                        recoveryPanel.dispose(); recoveryProvider.dispose(); recoveryDocument.dispose();
                    } else if (request.command === 'test.nativeEdit') {
                        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                        await vscode.commands.executeCommand('type', { text: '8' });
                        const deadline = Date.now() + 10000;
                        while (!vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty && Date.now() < deadline)
                            await new Promise(resolve => setTimeout(resolve, 25));
                        assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty, true);
                        await vscode.commands.executeCommand('undo');
                        while (vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty && Date.now() < deadline)
                            await new Promise(resolve => setTimeout(resolve, 25));
                        assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty, false);
                    } else if (request.command === 'test.dirtyText') {
                        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                        const edit = new vscode.WorkspaceEdit();
                        edit.insert(document.uri, document.lineAt(document.lineCount - 1).range.end, '$ UNSAVED_NATIVE');
                        assert.equal(await vscode.workspace.applyEdit(edit), true);
                        assert.equal(document.isDirty, true);
                    } else if (request.command === 'test.nativeSelection') {
                        const deadline = Date.now() + 15000;
                        if (fs.statSync(file).size >= 50 * 1024 * 1024) {
                            while (!(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText) && Date.now() < deadline)
                                await new Promise(resolve => setTimeout(resolve, 50));
                            assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText);
                            reply({ id: request.id }); continue;
                        }
                        while ((vscode.window.activeTextEditor?.document.uri.fsPath.toLowerCase() !== file.toLowerCase() || vscode.window.activeTextEditor?.selection.start.line !== request.args.line) && Date.now() < deadline)
                            await new Promise(resolve => setTimeout(resolve, 50));
                        const editor = vscode.window.activeTextEditor;
                        assert.equal(editor?.document.uri.fsPath.toLowerCase(), file.toLowerCase());
                        assert.equal(editor.selection.start.line, request.args.line);
                        assert.equal(editor.document.getText(editor.selection), request.args.text);
                        if (request.args.dirty) {
                            assert.equal(editor.document.isDirty, true);
                            assert.ok(editor.document.getText().includes('$ UNSAVED_NATIVE'));
                            await vscode.commands.executeCommand('workbench.action.files.revert');
                        }
                    } else if (request.command === 'test.reopenViewer') {
                        await vscode.commands.executeCommand('extension.openLsdynaLargeFileViewer', { uri: vscode.Uri.file(file), line: request.args.line });
                    } else throw Error('Unknown test command');
                    reply({ id: request.id });
                } catch (error) { reply({ id: request.id, error: String(error) }); }
            }
        }
        if (Date.now() > deadline) throw Error('Large-file viewer renderer validation timed out');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(!vscode.workspace.textDocuments.some(d => d.uri.fsPath === file && d.isDirty));
};
