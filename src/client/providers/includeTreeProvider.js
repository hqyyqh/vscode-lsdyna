'use strict';

/**
 * @fileoverview VS Code TreeDataProvider for scanning and visualizing the project Include Tree.
 * @module client/providers/includeTreeProvider
 * 
 * This module builds the hierarchy of include files (*INCLUDE) to display in the side bar.
 * It reads from active project snapshots, formats file sizes, tracks circular inclusion paths
 * and missing file warnings, and adds file decoration tooltip overlays.
 * 
 * Role in System: Client-side VS Code Tree View UI provider.
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const includeScanner = require('../../core/parser/includeScanner');
const i18n = require('../../core/i18n');

/**
 * Formats a size in bytes into a human-readable size string (e.g. "1.2 MB").
 * 
 * @param {number} bytes - Byte count.
 * @returns {string} Formatted size string.
 */
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

/**
 * Formats a size in bytes into a short size suffix representation (e.g. "1.2M" as "1M" or similar short strings).
 * Used inside small badges.
 * 
 * @param {number} bytes - Byte count.
 * @returns {string} Formatted short string.
 */
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

/**
 * Formats a size in bytes into a detailed description string prefixing a block visual character.
 * 
 * @param {number} bytes - Byte count.
 * @returns {string} Visual description string (e.g. "█ 12.3 MB").
 */
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

/**
 * Modifies a TreeItem description, applying file size visualization badges or status text.
 * 
 * @param {IncludeItem} item - Target tree node.
 * @param {string} relDir - Relative folder directory to record.
 */
function applyVividDescription(item, relDir) {
    let statusText = '';
    const desc = item.description;
    if (desc === 'not found' || desc === i18n.get('notFound')) {
        statusText = i18n.get('notFound');
    } else if (desc === 'missing' || desc === i18n.get('missing')) {
        statusText = i18n.get('missing');
    } else if (desc === 'circular' || desc === i18n.get('circular')) {
        statusText = i18n.get('circular');
    } else if (desc === 'scan failed' || desc === i18n.get('scanFailed')) {
        statusText = i18n.get('scanFailed');
    } else if (item.fileSizeVal !== undefined) {
        statusText = formatVividBytes(item.fileSizeVal);
    }

    item.relDir = relDir || '';
    if (statusText) {
        item.description = statusText;
    } else {
        item.description = '';
    }
}

/**
 * Normalizes file paths for map lookups. Handles Windows casing.
 * 
 * @param {string} filePath - Input path.
 * @returns {string} Normalized path.
 */
function normalizePathKey(filePath) {
    if (!filePath) return '';
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Represents a single Include File Node in the Tree View.
 * @extends vscode.TreeItem
 */
class IncludeItem extends vscode.TreeItem {
    /**
     * Creates an IncludeItem.
     * 
     * @param {string} filePath - Absolute path to the file.
     * @param {boolean} exists - True if the file exists on disk.
     */
    constructor(filePath, exists) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.Collapsed);
        /**
         * Absolute path to the file.
         * @type {string}
         */
        this.filePath = filePath;
        /**
         * Child include nodes.
         * @type {IncludeItem[]}
         */
        this.children = [];
        this.resourceUri = vscode.Uri.file(filePath);
        /**
         * Formatted file size string.
         * @type {string}
         */
        this.fileSizeStr = '';
        /**
         * Size in bytes.
         * @type {number|undefined}
         */
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

/**
 * Resolves the URI of the currently active editor or tab.
 * 
 * @returns {import('vscode').Uri|null} Active file URI.
 */
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

/**
 * Checks if a URI targets an LS-DYNA file type.
 * 
 * @param {import('vscode').Uri|null} uri - URI to inspect.
 * @returns {boolean} True if file matches lsdyna extensions.
 */
function isLsdynaUri(uri) {
    if (!uri) return false;
    const ext = path.extname(uri.fsPath).toLowerCase();
    const configExtensions = vscode.workspace.getConfiguration('lsdyna').get('additionalExtensions') || ['.k', '.key', '.dyna', '.asc'];
    const normalizedExtensions = configExtensions.map(e => {
        const trimmed = e.trim().toLowerCase();
        return trimmed.startsWith('.') ? trimmed : '.' + trimmed;
    });
    return normalizedExtensions.includes(ext);
}

/**
 * Checks if a VS Code TextDocument corresponds to LS-DYNA.
 * 
 * @param {import('vscode').TextDocument|null} document - Document.
 * @returns {boolean} True if lsdyna.
 */
function isLsdynaFile(document) {
    if (!document || !document.uri) return false;
    return isLsdynaUri(document.uri) || document.languageId === 'lsdyna';
}

/**
 * VS Code TreeDataProvider implementation for LS-DYNA Include Tree side bar.
 * @implements {vscode.TreeDataProvider<IncludeItem>}
 */
class LsdynaIncludeTreeProvider {
    /**
     * Creates an instance of LsdynaIncludeTreeProvider.
     * 
     * @param {Object} [options={}] - Dependencies.
     * @param {function(string, string[]): string} [options.searchFileFromPaths] - Absolute path resolver helper.
     * @param {function(string): Promise<import('../../core/project/projectIndexer').ProjectIndexResult>} [options.loadProjectSnapshot] - Snapshot loader.
     */
    constructor({ searchFileFromPaths, loadProjectSnapshot } = {}) {
        this.searchFileFromPaths = searchFileFromPaths;
        this.loadProjectSnapshot = loadProjectSnapshot;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        /**
         * Root include tree item.
         * @type {IncludeItem|null}
         */
        this.root = null;
        /**
         * Map matching resolved file paths to their short sizes.
         * @type {Map<string, string>}
         */
        this.resolvedPaths = new Map();
        /**
         * Set tracking missing dependency paths.
         * @type {Set<string>}
         */
        this.missingPaths = new Set();
    }

    /**
     * Triggers a workspace scan starting from the active editor document to rebuild the tree.
     * 
     * @returns {Promise<void>}
     */
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
            vscode.window.showWarningMessage(i18n.get('openFileFirst', debugInfo));
            return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: i18n.get('scanningIncludes'), cancellable: false },
            async (progress) => {
                this.resolvedPaths.clear();
                this.missingPaths.clear();
                if (this.loadProjectSnapshot) {
                    const snapshot = await this.loadProjectSnapshot(uri.fsPath, (partialSnapshot) => {
                        this.root = this._buildRootFromSnapshot(partialSnapshot, uri.fsPath);
                        this.root.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                        
                        let scannedCount = 0;
                        if (partialSnapshot && partialSnapshot.files) {
                            scannedCount = partialSnapshot.files.length;
                        }
                        progress.report({ message: i18n.get('scannedFilesProgress', scannedCount) || `Scanned ${scannedCount} files...` });
                        this._onDidChangeTreeData.fire(undefined);
                    });
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

    /**
     * Converts a ProjectGraph node representation recursively into TreeItem structures.
     * 
     * @private
     * @param {import('../../core/project/projectGraph').GraphTreeNode} node - Graph node.
     * @param {string} rootPath - Ancestor file path.
     * @returns {IncludeItem} Assembled tree item.
     */
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
        tooltip.appendMarkdown(`### ${i18n.get('includeFile')}: **${path.basename(node.filePath)}**\n\n`);
        tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${node.filePath}\`\n`);
        if (node.cycle) {
            tooltip.appendMarkdown(`- **${i18n.get('status')}**: ${i18n.get('circularDependency')}\n`);
        } else if (!node.missing && item.children.length > 0) {
            tooltip.appendMarkdown(`- **${i18n.get('subIncludes')}**: ${item.children.length}\n`);
        }
        item.tooltip = tooltip;

        return item;
    }

    /**
     * Generates include tree from a resolved project snapshot.
     * 
     * @private
     * @param {import('../../core/project/projectIndexer').ProjectIndexResult} snapshot - Project index snapshot.
     * @param {string} rootFile - Absolute path of the root file.
     * @returns {IncludeItem} Assembled tree.
     */
    _buildRootFromSnapshot(snapshot, rootFile) {
        return this._buildItemFromTreeNode(snapshot.graph.toTree(rootFile), rootFile);
    }

    /**
     * Recursively parses and builds a TreeItem list for files without using global LSP snapshots.
     * (Deprecated fallback path for non-LSP mode).
     * 
     * @private
     * @param {string} filePath - Absolute path to scan.
     * @param {Set<string>} visited - Tracks visited paths.
     * @param {import('vscode').Progress<{message: string}>} progress - Progress dialog handle.
     * @param {string} rootPath - Ancestor file path.
     * @returns {Promise<IncludeItem>} Assembled tree item.
     */
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
            tooltip.appendMarkdown(`### ${i18n.get('includeFile')}: **${path.basename(filePath)}**\n\n`);
            tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${filePath}\`\n`);
            if (visited.has(filePath)) {
                tooltip.appendMarkdown(`- **${i18n.get('status')}**: ${i18n.get('circularDependency')}\n`);
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
            tooltip.appendMarkdown(`### ${i18n.get('includeFile')}: **${path.basename(filePath)}**\n\n`);
            tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${filePath}\`\n`);
            tooltip.appendMarkdown(`- **${i18n.get('status')}**: ${i18n.get('scanFailedStatus')}\n`);
            tooltip.appendMarkdown(`- **${i18n.get('error')}**: ${error.message}\n`);
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
        tooltip.appendMarkdown(`### ${i18n.get('includeFile')}: **${path.basename(filePath)}**\n\n`);
        tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${filePath}\`\n`);
        if (item.children.length > 0) {
            tooltip.appendMarkdown(`- **${i18n.get('subIncludes')}**: ${item.children.length}\n`);
        }
        item.tooltip = tooltip;

        await new Promise(r => setImmediate(r));
        return item;
    }

    /**
     * Resolves metadata details when a user hovers over/selects a tree node.
     * Generates clickable command links for commands inside tooltips.
     * 
     * @param {IncludeItem} item - Target tree item.
     * @param {IncludeItem} element - Parent element.
     * @param {import('vscode').CancellationToken} token - Cancellation token.
     * @returns {Promise<IncludeItem>} Resolved tree item.
     */
    async resolveTreeItem(item, element, token) {
        if (!item.filePath || !fs.existsSync(item.filePath)) {
            return item;
        }
        try {
            const tooltip = new vscode.MarkdownString();
            tooltip.appendMarkdown(`### ${i18n.get('includeFile')}: **${path.basename(item.filePath)}**\n\n`);
            if (item.relDir) {
                tooltip.appendMarkdown(`- **${i18n.get('folder')}**: \`${item.relDir}\`\n`);
            }
            tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${item.filePath}\`\n`);
            if (item.fileSizeStr) {
                tooltip.appendMarkdown(`- **${i18n.get('size')}**: \`${item.fileSizeStr}\`\n`);
            }
            
            if (item.contextValue !== 'file-missing') {
                if (item.children && item.children.length > 0) {
                    tooltip.appendMarkdown(`- **${i18n.get('subIncludes')}**: ${item.children.length}\n`);
                }
            }
            
            tooltip.appendMarkdown(`\n---\n`);
            tooltip.appendMarkdown(`[${i18n.get('openFile')}](command:vscode.open?${encodeURIComponent(JSON.stringify(vscode.Uri.file(item.filePath)))}) | `);
            tooltip.appendMarkdown(`[${i18n.get('openToSide')}](command:extension.openToSide?${encodeURIComponent(JSON.stringify({ resourceUri: vscode.Uri.file(item.filePath) }))}) | `);
            tooltip.appendMarkdown(`[${i18n.get('revealInExplorer')}](command:extension.revealInExplorer?${encodeURIComponent(JSON.stringify({ resourceUri: vscode.Uri.file(item.filePath) }))})`);
            tooltip.isTrusted = true;
            
            item.tooltip = tooltip;
        } catch (e) {
            // Fallback to basic tooltip
        }
        return item;
    }

    /**
     * Simple node identity resolver.
     * 
     * @param {IncludeItem} element - Element to fetch.
     * @returns {IncludeItem} Input element.
     */
    getTreeItem(element) { return element; }

    /**
     * Fetches nested child items for a node.
     * 
     * @param {IncludeItem} [element] - Target element.
     * @returns {IncludeItem[]} Nested children list.
     */
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
