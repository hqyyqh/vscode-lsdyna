'use strict';
// Runs in an isolated VS Code extension development host; uses the existing GUI driver transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.run = async () => {
    const root = process.env.KEYWORD_MANAGER_HOST_EVIDENCE;
    assert.ok(root, 'Set KEYWORD_MANAGER_HOST_EVIDENCE to the isolated evidence directory');
    const { LsdynaKeywordIndexProvider: Index } = require('../../out/client/providers/keywordIndexProvider');
    const { EntityReferencesWebviewProvider: View } = require('../../out/client/EntityReferencesWebviewProvider');
    const { EntityReferenceQueryService: Query } = require('../../out/core/references/entityReferenceQueryService');
    let index, view, scans = 0, queries = 0, prepares = 0;
    const original = { attach: Index.prototype.attachTreeView, create: Index.prototype._createDocumentIndex,
        resolve: View.prototype.resolveWebviewView, query: Query.prototype.queryById };
    const tokens = [];
    Index.prototype.attachTreeView = function (...args) { index = this; return original.attach.apply(this, args); };
    Index.prototype._createDocumentIndex = function (...args) { scans++; return original.create.apply(this, args); };
    View.prototype.resolveWebviewView = function (...args) {
        view = this;
        const prepare = this.prepareKinds;
        this.prepareKinds = async () => { prepares++; return prepare?.(); };
        return original.resolve.apply(this, args);
    };
    Query.prototype.queryById = function (...args) { queries++; if (args[3]?.cancellationToken) tokens.push(args[3].cancellationToken); return original.query.apply(this, args); };
    const stats = () => ({ scans, queries, prepares, following: view?.isFollowingCursor() || false,
        indexFollowing: index?.followCursor || false, indexVisible: index?._treeView?.visible,
        cancelledTokens: tokens.filter(token => token.isCancellationRequested).length,
        id: view?.model.getActiveSession()?.identity.id, state: view?.model.getActiveSession()?.state });
    try {
        await vscode.extensions.getExtension('hqyyqh.dynasense').activate();
        await vscode.commands.executeCommand('workbench.view.explorer');
        const file = path.join(root, 'workspace', 'first.k');
        fs.writeFileSync(file, '*KEYWORD\n*DEFINE_CURVE\n       101\n       0.0       0.0\n*DEFINE_CURVE\n       202\n       1.0       1.0\n*END\n');
        const doc = await vscode.workspace.openTextDocument(file);
        let editor = await vscode.window.showTextDocument(doc, { preview: false });
        const select = line => { editor.selection = new vscode.Selection(line, 5, line, 5); };
        select(2); await delay(350);
        const second = path.join(root, 'workspace', 'second.k'); fs.writeFileSync(second, '*NODE\n1,0,0,0\n');
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(second), { preview: false }); await delay(350);
        editor = await vscode.window.showTextDocument(doc, { preview: false }); select(2); await delay(650);
        assert.equal(index._treeView.visible, false, 'Opening a file must leave Explorer visible');
        assert.equal(index.followCursor, false);
        assert.equal(scans, 0); assert.equal(queries, 0);
        fs.writeFileSync(path.join(root, 'host-ready.json'), JSON.stringify(stats()));
        const end = Date.now() + 180000;
        while (!fs.existsSync(path.join(root, 'gui-finish.json'))) {
            if (Date.now() > end) throw Error('GUI timeout');
            const request = path.join(root, 'request.json');
            if (fs.existsSync(request)) {
                const { action } = JSON.parse(fs.readFileSync(request)); fs.unlinkSync(request);
                if (action === 'show') await vscode.commands.executeCommand('lsdynaEntityReferences.focus');
                if (action === 'select-second') { editor = await vscode.window.showTextDocument(doc, { preview: false }); select(5); }
                if (action === 'hide') await vscode.commands.executeCommand('workbench.view.explorer');
                if (action === 'edit-hidden') {
                    const before = scans;
                    for (let i = 0; i < 3; i++) {
                        const edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, new vscode.Position(3, 0), ' ');
                        await vscode.workspace.applyEdit(edit);
                    }
                    select(2); await delay(650);
                    assert.equal(scans, before, 'Hidden edits must not build a sidebar index');
                }
                if (action === 'explicit') await vscode.commands.executeCommand('extension.queryLsdynaEntityId', { targetKind: 'curve', id: 202 });
                if (action === 'refresh') await vscode.commands.executeCommand('extension.entityReferences.refresh');
                await delay(650);
                fs.writeFileSync(path.join(root, 'response.json'), JSON.stringify(stats()));
            }
            await delay(30);
        }
    } finally {
        Index.prototype.attachTreeView = original.attach; Index.prototype._createDocumentIndex = original.create;
        View.prototype.resolveWebviewView = original.resolve; Query.prototype.queryById = original.query;
    }
};
