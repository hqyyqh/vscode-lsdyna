'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const keywordScanner = require('../../core/parser/keywordScanner');

class KeywordItem extends vscode.TreeItem {
    constructor(keyword) {
        super(keyword, vscode.TreeItemCollapsibleState.Collapsed);
        this.children = [];
        this.iconPath = new vscode.ThemeIcon('symbol-keyword');
    }
}

class KeywordUsageItem extends vscode.TreeItem {
    constructor(filePath, lineIndex, rootDir) {
        const rel = path.relative(rootDir, filePath);
        super(`${rel}  :${lineIndex + 1}`, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('file');
        this.tooltip = `${filePath}:${lineIndex + 1}`;
        this.command = {
            command: 'extension.goToKeywordUsage',
            title: 'Go to keyword',
            arguments: [filePath, lineIndex],
        };
    }
}

class LsdynaKeywordIndexProvider {
    constructor({ collectIncludeFiles, buildProjectIndex, shouldSkipAutomaticDocumentScan } = {}) {
        this.collectIncludeFiles = collectIncludeFiles;
        this.buildProjectIndex = buildProjectIndex;
        this.shouldSkipAutomaticDocumentScan = shouldSkipAutomaticDocumentScan;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.roots = [];
        this._mode = 'local'; // 'local' | 'recursive'
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
                item.children = usages.map(({ filePath, lineIndex }) =>
                    new KeywordUsageItem(filePath, lineIndex, rootDir)
                );
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

    refreshFromDocument(document) {
        if (this._mode !== 'local') return;
        if (!document || document.languageId !== 'lsdyna') return;
        if (this.shouldSkipAutomaticDocumentScan(document)) {
            this.roots = [];
            this._onDidChangeTreeData.fire(undefined);
            return;
        }
        const filePath = document.uri.fsPath;
        const rootDir = path.dirname(filePath);
        const keywordMap = new Map();
        for (const { keyword, lineIndex } of keywordScanner.collectKeywordsFromLineReader(
            document.lineCount,
            i => document.lineAt(i).text,
            filePath
        )) {
            if (!keywordMap.has(keyword)) keywordMap.set(keyword, []);
            keywordMap.get(keyword).push({ filePath, lineIndex });
        }
        this.roots = this._buildRootsFromKeywordMap(keywordMap, rootDir);
        this._onDidChangeTreeData.fire(undefined);
    }

    async scan() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'lsdyna') {
            vscode.window.showWarningMessage('Open an LS-DYNA file first.');
            return;
        }
        const rootFile = editor.document.uri.fsPath;
        const rootDir = path.dirname(rootFile);
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Scanning keywords…', cancellable: false },
            async (progress) => {
                if (this.buildProjectIndex) {
                    const snapshot = await this.buildProjectIndex(rootFile);
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
        if (vscode.window.activeTextEditor) {
            this.refreshFromDocument(vscode.window.activeTextEditor.document);
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

module.exports = {
    LsdynaKeywordIndexProvider,
};
