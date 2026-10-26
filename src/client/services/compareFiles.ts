export {};
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const i18n = require('../../core/i18n');

async function compareFiles(contextUri?) {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    // A diff/custom editor is not an implicit right-hand text file.
    const current = contextUri?.scheme === 'file' ? contextUri
        : active instanceof vscode.TabInputText && active.uri.scheme === 'file' ? active.uri : undefined;
    const key = uri => process.platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath;
    async function pick(title, exclude?) {
        const files = new Map();
        for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) {
            if (!(tab.input instanceof vscode.TabInputText) || tab.input.uri.scheme !== 'file') continue;
            const uri = tab.input.uri;
            if (exclude && key(uri) === key(exclude)) continue;
            files.set(key(uri), { label: path.basename(uri.fsPath), description: uri.fsPath,
                detail: tab.isDirty ? i18n.get('compareDirty') : undefined, uri });
        }
        const selected = await vscode.window.showQuickPick([...files.values(), { label: i18n.get('compareBrowse') }],
            { title, matchOnDescription: true, ignoreFocusOut: true });
        if (!selected) return;
        if (selected.uri) return selected.uri;
        let defaultUri;
        if (current) {
            defaultUri = vscode.workspace.getWorkspaceFolder(current)?.uri
                || vscode.Uri.file(path.dirname(current.fsPath));
        } else if (exclude) {
            defaultUri = vscode.Uri.file(path.dirname(exclude.fsPath));
        } else {
            const folders = vscode.workspace.workspaceFolders || [];
            if (folders.length === 1) defaultUri = folders[0].uri;
            else if (folders.length > 1) {
                const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: i18n.get('comparePickWorkspace') });
                if (!folder) return;
                defaultUri = folder.uri;
            }
        }
        return (await vscode.window.showOpenDialog({ title, canSelectFiles: true, canSelectFolders: false,
            canSelectMany: false, defaultUri }))?.[0];
    }
    try {
        const left = await pick(current ? i18n.get('comparePickWith', path.basename(current.fsPath)) : i18n.get('comparePickLeft'), current);
        if (!left) return;
        const right = current || await pick(i18n.get('comparePickRight'), left);
        if (!right) return;
        const [a, b] = await Promise.all([fs.promises.realpath(left.fsPath), fs.promises.realpath(right.fsPath)]);
        if (key({ fsPath: a }) === key({ fsPath: b })) {
            await vscode.window.showWarningMessage(i18n.get('compareSame')); return;
        }
        for (const uri of [left, right]) {
            const stat = await fs.promises.stat(uri.fsPath);
            if (!stat.isFile()) throw new Error(uri.fsPath);
            await fs.promises.access(uri.fsPath, fs.constants.R_OK);
        }
        await vscode.commands.executeCommand('vscode.diff', left, right);
    } catch (error) {
        await vscode.window.showWarningMessage(i18n.get('compareFailed', String(error?.message || error)));
    }
}
module.exports = { compareFiles };
