'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const includeScanner = require('../../core/parser/includeScanner');

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < sizes.length - 1) {
        val /= 1024;
        i++;
    }
    return `${val.toFixed(1)} ${sizes[i]}`;
}

function formatShortBytes(bytes) {
    if (bytes <= 0) return '0';
    if (bytes < 1024) {
        return '1k';
    }
    const kb = bytes / 1024;
    if (kb < 10) {
        return `${Math.round(kb)}k`;
    }
    if (kb < 1024) {
        return 'K';
    }
    const mb = kb / 1024;
    if (mb < 10) {
        return `${Math.round(mb)}M`;
    }
    if (mb < 1024) {
        return 'M';
    }
    const gb = mb / 1024;
    if (gb < 10) {
        return `${Math.round(gb)}G`;
    }
    return 'G';
}

function formatVividBytes(bytes) {
    if (bytes === 0) return '▏ 0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < sizes.length - 1) {
        val /= 1024;
        i++;
    }
    let block = '▌';
    if (bytes < 10 * 1024) {
        block = '▏';
    } else if (bytes >= 1024 * 1024) {
        block = '█';
    }
    return `${block} ${val.toFixed(1)} ${sizes[i]}`;
}

function applyVividDescription(item, relDir) {
    let statusText = '';
    if (item.description === 'not found') {
        statusText = 'not found';
    } else if (item.description === 'missing') {
        statusText = 'missing';
    } else if (item.description === 'circular') {
        statusText = 'circular';
    } else if (item.description === 'scan failed') {
        statusText = 'scan failed';
    } else if (item.fileSizeVal !== undefined) {
        statusText = formatVividBytes(item.fileSizeVal);
    }

    if (relDir && statusText) {
        item.description = `${relDir}  •  ${statusText}`;
    } else if (relDir) {
        item.description = relDir;
    } else if (statusText) {
        item.description = statusText;
    } else {
        item.description = '';
    }
}

function normalizePathKey(filePath) {
    if (!filePath) return '';
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

class IncludeItem extends vscode.TreeItem {
    constructor(filePath, exists) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.Collapsed);
        this.filePath = filePath;
        this.children = [];
        this.resourceUri = vscode.Uri.file(filePath);
        this.fileSizeStr = '';
        this.fileSizeVal = undefined;
        
        if (!exists) {
            this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
            this.description = 'not found';
            this.contextValue = 'file-missing';
        } else {
            this.contextValue = 'file';
            try {
                if (fs.existsSync(filePath)) {
                    const stats = fs.statSync(filePath);
                    this.fileSizeStr = formatBytes(stats.size);
                    this.fileSizeVal = stats.size;
                }
            } catch (e) {
                // ignore
            }
        }
        
        if (exists) {
            this.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(filePath)] };
        }
        applyVividDescription(this, '');
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
        this.resolvedPaths = new Map();
        this.missingPaths = new Set();
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
                this.resolvedPaths.clear();
                this.missingPaths.clear();
                if (this.loadProjectSnapshot) {
                    const snapshot = await this.loadProjectSnapshot(uri.fsPath);
                    this.root = this._buildRootFromSnapshot(snapshot, uri.fsPath);
                    
                    const collectPaths = (node) => {
                        const key = normalizePathKey(node.filePath);
                        if (node.missing) {
                            this.missingPaths.add(key);
                        } else {
                            let shortSize = '';
                            try {
                                if (fs.existsSync(node.filePath)) {
                                    const stats = fs.statSync(node.filePath);
                                    shortSize = formatShortBytes(stats.size);
                                }
                            } catch (e) {}
                            this.resolvedPaths.set(key, shortSize);
                        }
                        if (node.children) {
                            node.children.forEach(collectPaths);
                        }
                    };
                    if (snapshot && snapshot.graph) {
                        collectPaths(snapshot.graph.toTree(uri.fsPath));
                    }
                } else {
                    this.root = await this._buildItem(uri.fsPath, new Set(), progress, uri.fsPath);
                    
                    const collectTreePaths = (item) => {
                        const key = normalizePathKey(item.filePath);
                        if (item.contextValue === 'file-missing') {
                            this.missingPaths.add(key);
                        } else {
                            let shortSize = '';
                            try {
                                if (fs.existsSync(item.filePath)) {
                                    const stats = fs.statSync(item.filePath);
                                    shortSize = formatShortBytes(stats.size);
                                }
                            } catch (e) {}
                            this.resolvedPaths.set(key, shortSize);
                        }
                        if (item.children) {
                            item.children.forEach(collectTreePaths);
                        }
                    };
                    collectTreePaths(this.root);
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
            item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
        } else {
            item.children = (node.children || []).map(childNode => this._buildItemFromTreeNode(childNode, rootPath || node.filePath));
            item.collapsibleState = item.children.length > 0
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None;
        }

        let dirStr = '';
        if (rootPath && rootPath !== node.filePath) {
            const dir = path.dirname(rootPath);
            const rel = path.relative(dir, node.filePath);
            const relDir = path.dirname(rel);
            dirStr = relDir === '.' ? '' : relDir;
        }
        applyVividDescription(item, dirStr);

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### Include File: **${path.basename(node.filePath)}**\n\n`);
        tooltip.appendMarkdown(`- **Path**: \`${node.filePath}\`\n`);
        if (node.cycle) {
            tooltip.appendMarkdown(`- **Status**: ⚠️ *Circular dependency*\n`);
        } else if (!node.missing && item.children.length > 0) {
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

        let dirStr = '';
        if (actualRootPath !== filePath) {
            const dir = path.dirname(actualRootPath);
            const rel = path.relative(dir, filePath);
            const relDir = path.dirname(rel);
            dirStr = relDir === '.' ? '' : relDir;
        }

        if (!exists || visited.has(filePath)) {
            if (visited.has(filePath)) {
                item.description = 'circular';
                item.iconPath = new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.orange'));
            }
            item.collapsibleState = vscode.TreeItemCollapsibleState.None;
            applyVividDescription(item, dirStr);

            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`### Include File: **${path.basename(filePath)}**\n\n`);
            tooltip.appendMarkdown(`- **Path**: \`${filePath}\`\n`);
            if (visited.has(filePath)) {
                tooltip.appendMarkdown(`- **Status**: ⚠️ *Circular dependency*\n`);
            }
            item.tooltip = tooltip;

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
            applyVividDescription(item, dirStr);

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

        applyVividDescription(item, dirStr);

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### Include File: **${path.basename(filePath)}**\n\n`);
        tooltip.appendMarkdown(`- **Path**: \`${filePath}\`\n`);
        if (item.children.length > 0) {
            tooltip.appendMarkdown(`- **Sub-includes**: ${item.children.length}\n`);
        }
        item.tooltip = tooltip;

        await new Promise(r => setImmediate(r));
        return item;
    }

    async resolveTreeItem(item, element, token) {
        if (!item.filePath || !fs.existsSync(item.filePath)) {
            return item;
        }
        try {
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`### Include File: **${path.basename(item.filePath)}**\n\n`);
            tooltip.appendMarkdown(`- **Path**: \`${item.filePath}\`\n`);
            if (item.fileSizeStr) {
                tooltip.appendMarkdown(`- **Size**: \`${item.fileSizeStr}\`\n`);
            }
            
            if (item.contextValue !== 'file-missing') {
                if (item.children && item.children.length > 0) {
                    tooltip.appendMarkdown(`- **Sub-includes**: ${item.children.length}\n`);
                }
            }
            
            tooltip.appendMarkdown(`\n---\n`);
            tooltip.appendMarkdown(`[Open Editor](command:vscode.open?${encodeURIComponent(JSON.stringify(vscode.Uri.file(item.filePath)))}) | `);
            tooltip.appendMarkdown(`[Open to Side](command:extension.openToSide?${encodeURIComponent(JSON.stringify({ resourceUri: vscode.Uri.file(item.filePath) }))})`);
            tooltip.isTrusted = true;
            
            item.tooltip = tooltip;
        } catch (e) {
            // Fallback to basic tooltip
        }
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
    formatBytes,
    formatShortBytes,
    formatVividBytes,
    applyVividDescription,
    normalizePathKey,
};
