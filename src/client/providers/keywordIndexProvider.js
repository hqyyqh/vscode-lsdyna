'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const readline = require('readline');

const keywordScanner = require('../../core/parser/keywordScanner');
const { BlockIndex } = require('../../core/incremental/blockIndex');

const KEYWORD_FOLDING_THRESHOLD = 100;
const FILE_FOLDING_THRESHOLD = 50;

class KeywordItem extends vscode.TreeItem {
    constructor(keyword) {
        super(keyword, vscode.TreeItemCollapsibleState.Collapsed);
        this.children = [];
        this.iconPath = new vscode.ThemeIcon('symbol-keyword');
    }
}

class KeywordUsageItem extends vscode.TreeItem {
    constructor(filePath, lineIndex, rootDir) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
        this.resourceUri = vscode.Uri.file(filePath);
        this.description = `:line ${lineIndex + 1}`;
        this.contextValue = 'file';
        
        const rel = path.relative(rootDir, filePath);
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### Keyword Occurrence\n\n`);
        tooltip.appendMarkdown(`- **File**: \`${rel}\`\n`);
        tooltip.appendMarkdown(`- **Path**: \`${filePath}\`\n`);
        tooltip.appendMarkdown(`- **Line**: ${lineIndex + 1}\n`);
        this.tooltip = tooltip;

        this.command = {
            command: 'extension.goToKeywordUsage',
            title: 'Go to keyword',
            arguments: [filePath, lineIndex],
        };
    }
}

class AggregatedKeywordUsageItem extends vscode.TreeItem {
    constructor(filePath, count, firstLineIndex, rootDir) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
        this.resourceUri = vscode.Uri.file(filePath);
        this.description = `${count} usages`;
        this.contextValue = 'file';
        
        const rel = path.relative(rootDir, filePath);
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`### Aggregated Usages\n\n`);
        tooltip.appendMarkdown(`- **File**: \`${rel}\`\n`);
        tooltip.appendMarkdown(`- **Path**: \`${filePath}\`\n`);
        tooltip.appendMarkdown(`- **Total Usages**: ${count}\n`);
        tooltip.appendMarkdown(`- **First Occurrence**: Line ${firstLineIndex + 1}\n`);
        this.tooltip = tooltip;

        this.command = {
            command: 'extension.goToKeywordUsage',
            title: 'Go to keyword',
            arguments: [filePath, firstLineIndex],
        };
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

class LsdynaKeywordIndexProvider {
    constructor({ collectIncludeFiles, loadProjectSnapshot, shouldSkipAutomaticDocumentScan } = {}) {
        this.collectIncludeFiles = collectIncludeFiles;
        this.loadProjectSnapshot = loadProjectSnapshot;
        this.shouldSkipAutomaticDocumentScan = shouldSkipAutomaticDocumentScan;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.roots = [];
        this._mode = 'local'; // 'local' | 'recursive'
        this.documentIndices = new Map(); // uri.toString() -> BlockIndex
    }

    _setMode(mode) {
        this._mode = mode;
        vscode.commands.executeCommand('setContext', 'lsdyna.keywordIndexMode', mode);
    }

    _buildRootsFromKeywordMap(keywordMap, rootDir) {
        return [...keywordMap.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([keyword, usages]) => {
                const item = new KeywordItem(keyword);
                item.description = `${usages.length} usage${usages.length === 1 ? '' : 's'}`;

                const tooltip = new vscode.MarkdownString();
                tooltip.appendMarkdown(`### Keyword: **${keyword}**\n\n`);
                tooltip.appendMarkdown(`- **Total Occurrences**: ${usages.length}\n`);
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

    _buildRootsFromSnapshot(snapshot, rootDir) {
        return this._buildRootsFromKeywordMap(snapshot.keywordMap, rootDir);
    }

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

    refreshFromDocument(document) {
        return this.refreshFromUriOrDocument(document);
    }

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
                        { location: vscode.ProgressLocation.Window, title: 'Indexing keywords…' },
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
        const rootFile = uri.fsPath;
        const rootDir = path.dirname(rootFile);
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Scanning keywords…', cancellable: false },
            async (progress) => {
                if (this.loadProjectSnapshot) {
                    const snapshot = await this.loadProjectSnapshot(rootFile);
                    this.roots = this._buildRootsFromSnapshot(snapshot, rootDir);
                } else {
                    const files = await this.collectIncludeFiles(rootFile, (count) => {
                        progress.report({ message: `${count} file${count === 1 ? '' : 's'} found` });
                    });
                    this.roots = await this._buildRootsAsync(files, rootDir);
                }
                this._setMode('recursive');
                this._onDidChangeTreeData.fire(undefined);
            }
        );
    }

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

    getTreeItem(element) { return element; }

    getChildren(element) {
        if (element) return element.children;
        return this.roots;
    }
}

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
