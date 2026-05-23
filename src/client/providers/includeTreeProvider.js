'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const includeScanner = require('../../core/parser/includeScanner');

class IncludeItem extends vscode.TreeItem {
    constructor(filePath, exists) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.Collapsed);
        this.filePath = filePath;
        this.children = [];
        this.tooltip = filePath;
        this.iconPath = new vscode.ThemeIcon(exists ? 'file' : 'warning');
        if (!exists) this.description = 'not found';
        if (exists) {
            this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(filePath)] };
        }
    }
}

function getActiveUri() {
    const editor = vscode.window.activeTextEditor;
    if (editor) return editor.document.uri;
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (activeTab && activeTab.input) {
        const input = activeTab.input;
        if (input.uri) return input.uri;
        if (input.resource) return input.resource;
        if (input.modified) return input.modified;
        if (input.original) return input.original;
    }
    return null;
}

function isLsdynaUri(uri) {
    if (!uri) return false;
    const ext = path.extname(uri.fsPath).toLowerCase();
    return ext === '.k' || ext === '.key' || ext === '.dyna';
}

function isLsdynaFile(document) {
    if (!document || !document.uri) return false;
    return isLsdynaUri(document.uri) || document.languageId === 'lsdyna';
}

class LsdynaIncludeTreeProvider {
    constructor({ searchFileFromPaths, loadProjectSnapshot } = {}) {
        this.searchFileFromPaths = searchFileFromPaths;
        this.loadProjectSnapshot = loadProjectSnapshot;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.root = null;
    }

    async scan() {
        const uri = getActiveUri();
        if (!uri || !isLsdynaUri(uri)) {
            const editor = vscode.window.activeTextEditor;
            const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
            const debugInfo = [
                `activeEditor=${!!editor}`,
                `tabGroups=${!!vscode.window.tabGroups}`,
                `activeTab=${!!activeTab}`,
                `inputType=${activeTab?.input?.constructor?.name || 'none'}`,
                `inputKeys=${activeTab?.input ? JSON.stringify(Object.keys(activeTab.input)) : 'none'}`
            ].join(', ');
            vscode.window.showWarningMessage(`Open an LS-DYNA file first. (Debug: ${debugInfo})`);
            return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Scanning includes…', cancellable: false },
            async (progress) => {
                if (this.loadProjectSnapshot) {
                    const snapshot = await this.loadProjectSnapshot(uri.fsPath);
                    this.root = this._buildRootFromSnapshot(snapshot, uri.fsPath);
                } else {
                    this.root = await this._buildItem(uri.fsPath, new Set(), progress);
                }
                this.root.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                this._onDidChangeTreeData.fire(undefined);
            }
        );
    }

    _buildItemFromTreeNode(node) {
        const exists = !node.missing && fs.existsSync(node.filePath);
        const item = new IncludeItem(node.filePath, exists);
        if (node.cycle) {
            item.description = 'circular';
            item.iconPath = new vscode.ThemeIcon('sync');
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else if (node.missing) {
            item.description = 'missing';
            item.iconPath = new vscode.ThemeIcon('warning');
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else {
            item.children = (node.children || []).map(childNode => this._buildItemFromTreeNode(childNode));
            item.collapsibleState = item.children.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None;
        }
        return item;
    }

    _buildRootFromSnapshot(snapshot, rootFile) {
        return this._buildItemFromTreeNode(snapshot.graph.toTree(rootFile));
    }

    async _buildItem(filePath, visited, progress) {
        const exists = fs.existsSync(filePath);
        const item = new IncludeItem(filePath, exists);

        if (!exists || visited.has(filePath)) {
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            return item;
        }

        visited.add(filePath);
        progress.report({ message: path.basename(filePath) });

        let includeEntries;
        let searchPaths;
        try {
            ({ includeEntries, searchPaths } = await includeScanner.collectIncludeDirectivesFromFile(filePath));
        } catch (error) {
            item.description = 'scan failed';
            item.tooltip = `${filePath}\n${error.message}`;
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            return item;
        }

        for (const { fileName } of includeEntries) {
            let childPath;
            try {
                childPath = this.searchFileFromPaths(fileName, searchPaths);
            } catch (e) {
                childPath = path.resolve(path.dirname(filePath), fileName);
            }
            item.children.push(await this._buildItem(childPath, new Set(visited), progress));
        }

        item.collapsibleState = item.children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        await new Promise(r => setImmediate(r));
        return item;
    }

    getTreeItem(element) { return element; }

    getChildren(element) {
        if (!this.root) return [];
        return element ? element.children : [this.root];
    }
}

module.exports = {
    LsdynaIncludeTreeProvider,
};
