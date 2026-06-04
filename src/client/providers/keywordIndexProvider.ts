'use strict';

/**
 * @fileoverview VS Code TreeDataProvider for scanning and listing the Keyword Index.
 * @module client/providers/keywordIndexProvider
 * 
 * This module aggregates keywords used across the workspace or the current document.
 * It groups them by keyword name and file origin, handles pagination and folding above limits 
 * (to prevent UI lag on millions of nodes), resolves hover previews, and listens to incremental 
 * editor edits to update positions.
 * 
 * Role in System: Client-side VS Code Tree View UI provider.
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const readline = require('readline');

const keywordScanner = require('../../core/parser/keywordScanner');
const { BlockIndex } = require('../../core/incremental/blockIndex');
const i18n = require('../../core/i18n');

type KeywordUsage = {
    filePath: string;
    lineIndex: number;
};

type KeywordIndexProviderOptions = {
    collectIncludeFiles?: (rootFile: string, onProgress?: (count: number) => void) => Promise<string[]>;
    loadProjectSnapshot?: (rootFile: string, options?: object, onProgress?: (snapshot: any) => void) => Promise<any>;
    invalidateProjectSnapshot?: (rootFile: string) => Promise<void>;
    shouldSkipAutomaticDocumentScan?: (document: any) => boolean;
};

function getLsdynaConfigurationValue(key, defaultValue) {
    const config = vscode.workspace.getConfiguration('lsdyna');
    if (!config || typeof config.get !== 'function') {
        return defaultValue;
    }
    return config.get(key, defaultValue);
}

/**
 * Folding limit threshold for nesting single-keyword occurrences under folders.
 * @type {number}
 */
const KEYWORD_FOLDING_THRESHOLD = 100;

/**
 * Folding limit threshold for nesting occurrences inside a single file under that file node.
 * @type {number}
 */
const FILE_FOLDING_THRESHOLD = 50;

/**
 * Tree node representing a Keyword definition name.
 * @extends vscode.TreeItem
 */
class KeywordItem extends vscode.TreeItem {
    /**
     * Creates a KeywordItem.
     * 
     * @param {string} keyword - The keyword name.
     */
    constructor(keyword) {
        super(keyword, vscode.TreeItemCollapsibleState.Collapsed);
        this.children = [];
        this.iconPath = new vscode.ThemeIcon('symbol-keyword');
    }
}

/**
 * Tree node representing a single keyword occurrence in a file.
 * @extends vscode.TreeItem
 */
class KeywordUsageItem extends vscode.TreeItem {
    /**
     * Creates a KeywordUsageItem.
     * 
     * @param {string} filePath - Absolute path to the file containing the keyword.
     * @param {number} lineIndex - 0-indexed line number of the keyword.
     * @param {string} rootDir - Parent directory for relative path formatting.
     */
    constructor(filePath, lineIndex, rootDir) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
        this.resourceUri = vscode.Uri.file(filePath);
        this.description = i18n.get('linePrefix', lineIndex + 1);
        this.contextValue = 'file';
        
        const rel = path.relative(rootDir, filePath);
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### ${i18n.get('keywordOccurrence')}\n\n`);
        tooltip.appendMarkdown(`- **${i18n.get('file')}**: \`${rel}\`\n`);
        tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${filePath}\`\n`);
        tooltip.appendMarkdown(`- **${i18n.get('line')}**: ${lineIndex + 1}\n`);
        this.tooltip = tooltip;

        this.command = {
            command: 'extension.goToKeywordUsage',
            title: i18n.get('goToKeyword'),
            arguments: [filePath, lineIndex],
        };
    }
}

/**
 * Tree node representing aggregated keyword occurrences in a single file above folding threshold.
 * @extends vscode.TreeItem
 */
class AggregatedKeywordUsageItem extends vscode.TreeItem {
    /**
     * Creates an AggregatedKeywordUsageItem.
     * 
     * @param {string} filePath - Absolute path to the file.
     * @param {number} count - Total number of occurrences in the file.
     * @param {number} firstLineIndex - 0-indexed line number of the first occurrence.
     * @param {string} rootDir - Parent directory for relative path formatting.
     */
    constructor(filePath, count, firstLineIndex, rootDir) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
        this.resourceUri = vscode.Uri.file(filePath);
        this.description = count === 1 ? i18n.get('usageSingular') : i18n.get('usagesPlural', count);
        this.contextValue = 'file';
        
        const rel = path.relative(rootDir, filePath);
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### ${i18n.get('aggregatedUsages')}\n\n`);
        tooltip.appendMarkdown(`- **${i18n.get('file')}**: \`${rel}\`\n`);
        tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${filePath}\`\n`);
        tooltip.appendMarkdown(`- **${i18n.get('totalUsages')}**: ${count}\n`);
        tooltip.appendMarkdown(`- **${i18n.get('firstOccurrence')}**: ${i18n.get('lineLabel', firstLineIndex + 1)}\n`);
        this.tooltip = tooltip;

        this.command = {
            command: 'extension.goToKeywordUsage',
            title: i18n.get('goToKeyword'),
            arguments: [filePath, firstLineIndex],
        };
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
    const configExtensions = getLsdynaConfigurationValue('additionalExtensions', ['.k', '.key', '.dyna', '.asc']) || ['.k', '.key', '.dyna', '.asc'];
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
 * VS Code TreeDataProvider implementation for LS-DYNA Keyword Index side bar.
 * @implements {vscode.TreeDataProvider<vscode.TreeItem>}
 */
class LsdynaKeywordIndexProvider {
    collectIncludeFiles?: (rootFile: string, onProgress?: (count: number) => void) => Promise<string[]>;
    loadProjectSnapshot?: (rootFile: string, options?: object, onProgress?: (snapshot: any) => void) => Promise<any>;
    invalidateProjectSnapshot?: (rootFile: string) => Promise<void>;
    shouldSkipAutomaticDocumentScan?: (document: any) => boolean;
    _onDidChangeTreeData: any;
    onDidChangeTreeData: any;
    roots: any[];
    _mode: 'local' | 'recursive';
    documentIndices: Map<string, any>;

    /**
     * Creates an instance of LsdynaKeywordIndexProvider.
     * 
     * @param {Object} [options={}] - Dependencies.
     * @param {function(string): Promise<string[]>} [options.collectIncludeFiles] - Includes scanner callback.
     * @param {function(string): Promise<import('../../core/project/projectIndexer').ProjectIndexResult>} [options.loadProjectSnapshot] - Snapshot loader.
     * @param {function(string): Promise<void>} [options.invalidateProjectSnapshot] - Cache invalidator.
     * @param {function(import('vscode').TextDocument): boolean} [options.shouldSkipAutomaticDocumentScan] - Large file guard callback.
     */
    constructor({ collectIncludeFiles, loadProjectSnapshot, invalidateProjectSnapshot, shouldSkipAutomaticDocumentScan }: KeywordIndexProviderOptions = {}) {
        this.collectIncludeFiles = collectIncludeFiles;
        this.loadProjectSnapshot = loadProjectSnapshot;
        this.invalidateProjectSnapshot = invalidateProjectSnapshot;
        this.shouldSkipAutomaticDocumentScan = shouldSkipAutomaticDocumentScan;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        /**
         * Root tree items lists.
         * @type {vscode.TreeItem[]}
         */
        this.roots = [];
        /**
         * Active display mode.
         * @type {'local'|'recursive'}
         */
        this._mode = 'local';
        /**
         * Map indexing open document block indexes.
         * @type {Map<string, BlockIndex>}
         */
        this.documentIndices = new Map();
    }

    /**
     * Sets view mode and updates VS Code context state.
     * 
     * @private
     * @param {'local'|'recursive'} mode - Active mode.
     */
    _setMode(mode) {
        this._mode = mode;
        vscode.commands.executeCommand('setContext', 'lsdyna.keywordIndexMode', mode);
    }

    /**
     * Transforms keyword occurrences map into sorted TreeItem arrays, applying folding.
     * 
     * @private
     * @param {Map<string, Array<{filePath: string, lineIndex: number}>>} keywordMap - Occurrences map.
     * @param {string} rootDir - Root path folder.
     * @returns {KeywordItem[]} Transformed tree items.
     */
    _buildRootsFromKeywordMap(keywordMap, rootDir) {
        return [...keywordMap.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([keyword, usages]) => {
                const item = new KeywordItem(keyword);
                item.description = usages.length === 1 ? i18n.get('usageSingular') : i18n.get('usagesPlural', usages.length);

                const tooltip = new vscode.MarkdownString();
                tooltip.appendMarkdown(`### ${i18n.get('keywordLabel')}: **${keyword}**\n\n`);
                tooltip.appendMarkdown(`- **${i18n.get('totalUsages')}**: ${usages.length}\n`);
                item.tooltip = tooltip;

                if (usages.length > KEYWORD_FOLDING_THRESHOLD) {
                    const groups = new Map();
                    for (const usage of usages) {
                        if (!groups.has(usage.filePath)) groups.set(usage.filePath, []);
                        groups.get(usage.filePath).push(usage);
                    }

                    const children = [];
                    for (const [filePath, fileUsages] of groups.entries()) {
                        if (fileUsages.length > FILE_FOLDING_THRESHOLD) {
                            children.push(new AggregatedKeywordUsageItem(filePath, fileUsages.length, fileUsages[0].lineIndex, rootDir));
                        } else {
                            for (const usage of fileUsages) {
                                children.push(new KeywordUsageItem(usage.filePath, usage.lineIndex, rootDir));
                            }
                        }
                    }
                    item.children = children;
                } else {
                    item.children = usages.map(({ filePath, lineIndex }) =>
                        new KeywordUsageItem(filePath, lineIndex, rootDir)
                    );
                }
                return item;
            });
    }

    /**
     * Helper to index file lists and assemble the Keyword Map (non-LSP fallback).
     * 
     * @private
     * @param {string[]} filePaths - Array of absolute paths.
     * @param {string} rootDir - Root folder.
     * @returns {Promise<KeywordItem[]>} Assembled roots.
     */
    async _buildRootsAsync(filePaths, rootDir) {
        const keywordMap = new Map();
        for (const filePath of filePaths) {
            if (!fs.existsSync(filePath)) continue;
            const keywords = await keywordScanner.collectKeywordsFromFile(filePath);
            for (const { keyword, lineIndex } of keywords) {
                if (!keywordMap.has(keyword)) keywordMap.set(keyword, []);
                keywordMap.get(keyword).push({ filePath, lineIndex });
            }
        }
        return this._buildRootsFromKeywordMap(keywordMap, rootDir);
    }

    /**
     * Resolves TreeItems from project snapshot map.
     * 
     * @private
     * @param {import('../../core/project/projectIndexer').ProjectIndexResult} snapshot - Project index.
     * @param {string} rootDir - Root folder.
     * @returns {KeywordItem[]} Assembled roots.
     */
    _buildRootsFromSnapshot(snapshot, rootDir) {
        return this._buildRootsFromKeywordMap(snapshot.keywordMap, rootDir);
    }

    /**
     * Listens to change events to incrementally update the active document's block index.
     * 
     * @param {import('vscode').TextDocument} document - Document.
     * @param {import('vscode').TextDocumentChangeEvent} event - Change event details.
     */
    updateDocumentIndex(document, event) {
        if (this._mode !== 'local') return;
        if (!document || !isLsdynaFile(document)) return;

        const uriStr = document.uri.toString();
        let blockIndex = this.documentIndices.get(uriStr);
        if (!blockIndex) {
            this.refreshFromUriOrDocument(document);
            return;
        } else if (event && event.contentChanges) {
            for (const change of event.contentChanges) {
                const { range, text } = change;
                blockIndex.updateIndex(
                    { startLine: range.start.line, endLine: range.end.line },
                    text,
                    document.lineCount,
                    i => document.lineAt(i).text
                );
            }
        }
    }

    /**
     * Triggers active document refresh from editor text.
     * 
     * @param {import('vscode').TextDocument} document - Target document.
     */
    refreshFromDocument(document) {
        return this.refreshFromUriOrDocument(document);
    }

    /**
     * Bootstraps or refreshes active document block index and updates tree view.
     * 
     * @param {import('vscode').Uri|import('vscode').TextDocument} uriOrDoc - Active editor target.
     * @returns {Promise<void>}
     */
    async refreshFromUriOrDocument(uriOrDoc) {
        if (this._mode !== 'local') return;
        if (!uriOrDoc) return;

        const isDoc = typeof uriOrDoc.uri !== 'undefined';
        const uri = isDoc ? uriOrDoc.uri : uriOrDoc;
        if (!isLsdynaUri(uri)) return;

        const filePath = uri.fsPath;
        const uriStr = uri.toString();
        let blockIndex = this.documentIndices.get(uriStr);

        if (!blockIndex) {
            blockIndex = new BlockIndex(filePath);
            const isLarge = isDoc ? this.shouldSkipAutomaticDocumentScan(uriOrDoc) : true;
            if (isLarge) {
                try {
                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Window, title: i18n.get('indexingKeywordsProgress') },
                        async () => {
                            await blockIndex.buildIndexFromFile(filePath);
                        }
                    );
                } catch (e) {
                    this.roots = [];
                    this._onDidChangeTreeData.fire(undefined);
                    return;
                }
            } else {
                blockIndex.buildIndex(uriOrDoc.lineCount, i => uriOrDoc.lineAt(i).text);
            }
            this.documentIndices.set(uriStr, blockIndex);
        }

        const rootDir = path.dirname(filePath);
        const keywordMap = new Map();
        for (const { keyword, lineIndex } of blockIndex.getKeywords()) {
            if (!keywordMap.has(keyword)) keywordMap.set(keyword, []);
            keywordMap.get(keyword).push({ filePath, lineIndex });
        }
        this.roots = this._buildRootsFromKeywordMap(keywordMap, rootDir);
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Traverses the project inclusions recursively to build the project keyword index.
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
        const rootFile = uri.fsPath;
        const rootDir = path.dirname(rootFile);
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: i18n.get('indexingKeywords'), cancellable: false },
            async (progress) => {
                if (this.invalidateProjectSnapshot) {
                    await this.invalidateProjectSnapshot(uri.fsPath);
                }
                if (this.loadProjectSnapshot) {
                    const options = { fullScanLargeFiles: getLsdynaConfigurationValue('scanner.fullScanLargeFiles', false) };
                    const snapshot = await this.loadProjectSnapshot(rootFile, options, (partialSnapshot) => {
                        this.roots = this._buildRootsFromSnapshot(partialSnapshot, rootDir);
                        
                        let scannedCount = 0;
                        if (partialSnapshot && partialSnapshot.files) {
                            scannedCount = partialSnapshot.files.length;
                        }
                        progress.report({ message: i18n.get('scannedFilesProgress', scannedCount) || `Scanned ${scannedCount} files...` });
                        this._onDidChangeTreeData.fire(undefined);
                    });
                    this.roots = this._buildRootsFromSnapshot(snapshot, rootDir);
                } else {
                    const files = await this.collectIncludeFiles(rootFile, (count) => {
                        progress.report({ message: i18n.get('filesFound', count) });
                    });
                    this.roots = await this._buildRootsAsync(files, rootDir);
                }
                this._setMode('recursive');
                this._onDidChangeTreeData.fire(undefined);
            }
        );
    }

    /**
     * Reverts active mode to Local Document view, refreshing values.
     */
    setLocal() {
        this._setMode('local');
        const uri = getActiveUri();
        if (uri) {
            this.refreshFromUriOrDocument(uri);
        } else {
            this.roots = [];
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    /**
     * Resolves card previews for keyword usage rows on tree selection.
     * 
     * @param {vscode.TreeItem} item - Selected item.
     * @param {vscode.TreeItem} element - Parent element.
     * @param {import('vscode').CancellationToken} token - Cancellation token.
     * @returns {Promise<vscode.TreeItem>} Resolved item.
     */
    async resolveTreeItem(item, element, token) {
        if (element instanceof KeywordUsageItem) {
            const filePath = item.resourceUri.fsPath;
            const lineIndex = item.command.arguments[1];
            const snippet = await readFileSnippet(filePath, lineIndex, 8);
            if (snippet) {
                const tooltip = new vscode.MarkdownString();
                tooltip.appendMarkdown(`### ${i18n.get('keywordOccurrence')}\n\n`);
                tooltip.appendMarkdown(`- **${i18n.get('file')}**: \`${path.basename(filePath)}\`\n`);
                tooltip.appendMarkdown(`- **${i18n.get('path')}**: \`${filePath}\`\n`);
                tooltip.appendMarkdown(`- **${i18n.get('line')}**: ${lineIndex + 1}\n\n`);
                tooltip.appendMarkdown(`**${i18n.get('cardDataPreview')}:**\n`);
                tooltip.appendMarkdown(`\`\`\`lsdyna\n${snippet}\n\`\`\``);
                
                tooltip.appendMarkdown(`\n---\n`);
                tooltip.appendMarkdown(`[${i18n.get('openFile')}](command:vscode.open?${encodeURIComponent(JSON.stringify(item.resourceUri))}) | `);
                tooltip.appendMarkdown(`[${i18n.get('openToSide')}](command:extension.openToSide?${encodeURIComponent(JSON.stringify({ resourceUri: item.resourceUri }))}) | `);
                tooltip.appendMarkdown(`[${i18n.get('revealInExplorer')}](command:extension.revealInExplorer?${encodeURIComponent(JSON.stringify({ resourceUri: item.resourceUri }))})`);
                tooltip.isTrusted = true;
                
                item.tooltip = tooltip;
            }
        }
        return item;
    }

    /**
     * Simple identity resolver.
     * 
     * @param {vscode.TreeItem} element - Element to fetch.
     * @returns {vscode.TreeItem} Input element.
     */
    getTreeItem(element) { return element; }

    /**
     * Fetches nested child items for a node.
     * 
     * @param {vscode.TreeItem} [element] - Target element.
     * @returns {vscode.TreeItem[]} Nested children list.
     */
    getChildren(element) {
        if (element) return element.children;
        return this.roots;
    }
}

/**
 * Asynchronously reads a snippet (contiguous lines) starting from a specific line index.
 * 
 * @param {string} filePath - Absolute path to the file.
 * @param {number} lineIndex - 0-indexed starting line number.
 * @param {number} [maxLines=6] - Number of lines to extract.
 * @returns {Promise<string|null>} Snapped text block, or null if read error/file missing.
 */
function readFileSnippet(filePath, lineIndex, maxLines = 6) {
    return new Promise((resolve) => {
        if (!fs.existsSync(filePath)) {
            return resolve(null);
        }
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        
        let current = 0;
        const lines = [];
        
        rl.on('line', (line) => {
            if (current >= lineIndex && current < lineIndex + maxLines) {
                lines.push(line);
            }
            if (current >= lineIndex + maxLines) {
                rl.close();
            }
            current++;
        });
        
        rl.on('close', () => {
            stream.destroy();
            resolve(lines.join('\n'));
        });
        
        rl.on('error', () => {
            stream.destroy();
            resolve(null);
        });
    });
}

module.exports = {
    LsdynaKeywordIndexProvider,
    readFileSnippet,
};

export {};
