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
        
        if (!exists) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
            this.description = 'not found';
        } else {
            this.resourceUri = vscode.Uri.file(filePath);
        }
        
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
                    this.root = await this._buildItem(uri.fsPath, new Set(), progress, uri.fsPath);
                }
                this.root.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                this._onDidChangeTreeData.fire(undefined);
            }
        );
    }

    _buildItemFromTreeNode(node, rootPath) {
        const exists = !node.missing && fs.existsSync(node.filePath);
        const item = new IncludeItem(node.filePath, exists);
        if (node.cycle) {
            item.description = 'circular';
            item.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.orange'));
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else if (node.missing) {
            item.description = 'missing';
            item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else {
            item.children = (node.children || []).map(childNode => this._buildItemFromTreeNode(childNode, rootPath || node.filePath));
            item.collapsibleState = item.children.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None;

            if (rootPath && rootPath !== node.filePath) {
                const dir = path.dirname(rootPath);
                const rel = path.relative(dir, node.filePath);
                const relDir = path.dirname(rel);
                item.description = relDir === '.' ? '' : relDir;
            }
        }

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### Include File: **${path.basename(node.filePath)}**\n\n`);
        tooltip.appendMarkdown(`- **Path**: \`${node.filePath}\`\n`);
        if (node.cycle) {
            tooltip.appendMarkdown(`- **Status**: ⚠️ *Circular dependency*\n`);
        } else if (node.missing) {
            tooltip.appendMarkdown(`- **Status**: ❌ *Missing / Not found*\n`);
        } else {
            tooltip.appendMarkdown(`- **Status**: ✅ *Resolved*\n`);
            tooltip.appendMarkdown(`- **Sub-includes**: ${item.children.length}\n`);
        }
        item.tooltip = tooltip;

        return item;
    }

    _buildRootFromSnapshot(snapshot, rootFile) {
        return this._buildItemFromTreeNode(snapshot.graph.toTree(rootFile), rootFile);
    }

    async _buildItem(filePath, visited, progress, rootPath) {
        const exists = fs.existsSync(filePath);
        const item = new IncludeItem(filePath, exists);
        const actualRootPath = rootPath || filePath;

        if (!exists || visited.has(filePath)) {
            if (visited.has(filePath)) {
                item.description = 'circular';
                item.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.orange'));
            }
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;

            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`### Include File: **${path.basename(filePath)}**\n\n`);
            tooltip.appendMarkdown(`- **Path**: \`${filePath}\`\n`);
            if (visited.has(filePath)) {
                tooltip.appendMarkdown(`- **Status**: ⚠️ *Circular dependency*\n`);
            } else {
                tooltip.appendMarkdown(`- **Status**: ❌ *Missing / Not found*\n`);
            }
            item.tooltip = tooltip;

            return item;
        }

        visited.add(filePath);
        progress.report({ message: path.basename(filePath) });

        if (actualRootPath !== filePath) {
            const dir = path.dirname(actualRootPath);
            const rel = path.relative(dir, filePath);
            const relDir = path.dirname(rel);
            item.description = relDir === '.' ? '' : relDir;
        }

        let includeEntries;
        let searchPaths;
        try {
            ({ includeEntries, searchPaths } = await includeScanner.collectIncludeDirectivesFromFile(filePath));
        } catch (error) {
            item.description = 'scan failed';

            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`### Include File: **${path.basename(filePath)}**\n\n`);
            tooltip.appendMarkdown(`- **Path**: \`${filePath}\`\n`);
            tooltip.appendMarkdown(`- **Status**: ❌ *Scan failed*\n`);
            tooltip.appendMarkdown(`- **Error**: ${error.message}\n`);
            item.tooltip = tooltip;

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
            item.children.push(await this._buildItem(childPath, new Set(visited), progress, actualRootPath));
        }

        item.collapsibleState = item.children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### Include File: **${path.basename(filePath)}**\n\n`);
        tooltip.appendMarkdown(`- **Path**: \`${filePath}\`\n`);
        tooltip.appendMarkdown(`- **Status**: ✅ *Resolved*\n`);
        tooltip.appendMarkdown(`- **Sub-includes**: ${item.children.length}\n`);
        item.tooltip = tooltip;

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
