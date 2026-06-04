'use strict';

class Position {
    constructor(line, character) { this.line = line; this.character = character; }
}

class Range {
    constructor(startLine, startChar, endLine, endChar) {
        if (startLine instanceof Position) {
            this.start = startLine;
            this.end = startChar;
        } else {
            this.start = new Position(startLine, startChar);
            this.end = new Position(endLine, endChar);
        }
    }
    contains(pos) {
        if (pos.line < this.start.line || pos.line > this.end.line) return false;
        if (pos.line === this.start.line && pos.character < this.start.character) return false;
        if (pos.line === this.end.line && pos.character > this.end.character) return false;
        return true;
    }
}

class Selection extends Range {
    constructor(anchor, active) {
        super(anchor, active);
        this.anchor = anchor;
        this.active = active;
    }
}

class MarkdownString {
    constructor(value = '') {
        this.value = value;
    }

    appendMarkdown(value) {
        this.value += value;
        return this;
    }

    appendText(value) {
        this.value += String(value).replace(/\r?\n/g, '  \n');
        return this;
    }
}

class Hover {
    constructor(contents, range) {
        this.contents = Array.isArray(contents) ? contents : [contents];
        this.range = range;
    }
}

class CompletionItem {
    constructor(label, kind) {
        this.label = label;
        this.kind = kind;
    }
}

const CompletionItemKind = {
    File: 17,
    Snippet: 27,
    Field: 5
};

class SnippetString {
    constructor(value = '') {
        this.value = value;
    }
}

class CompletionList {
    constructor(items, isIncomplete = false) {
        this.items = items;
        this.isIncomplete = isIncomplete;
    }
}

class WorkspaceEdit {
    constructor() {
        this.edits = [];
    }

    replace(uri, range, text) {
        this.edits.push({ uri, range, text });
    }
}

module.exports = {
    Position,
    Range,
    Selection,
    MarkdownString,
    Hover,
    CompletionItem,
    CompletionItemKind,
    SnippetString,
    CompletionList,
    WorkspaceEdit,
    Uri: {
        file: p => ({ fsPath: p }),
        parse: value => ({ fsPath: value, scheme: String(value).split(':')[0], toString: () => value })
    },
    FoldingRange: class FoldingRange { constructor(s, e) { this.start = s; this.end = e; } },
    DocumentSymbol: class DocumentSymbol {},
    DocumentLink: class DocumentLink { constructor(r, t) { this.range = r; this.target = t; } },
    InlayHint: class InlayHint { constructor(p, l) { this.position = p; this.label = l; } },
    InlayHintKind: { Parameter: 2 },
    Diagnostic: class Diagnostic { constructor(r, m, s) { this.range = r; this.message = m; this.severity = s; } },
    DiagnosticSeverity: { Warning: 1 },
    SymbolKind: { Property: 6 },
    ThemeColor: class ThemeColor {},
    ThemeIcon: class ThemeIcon {},
    TreeItem: class TreeItem { constructor(l, s) { this.label = l; this.collapsibleState = s; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: class EventEmitter { constructor() { this.event = null; } fire() {} },
    window: {
        activeTextEditor: null,
        showErrorMessage: () => {},
        showWarningMessage: () => {},
        createTreeView: (id, options) => ({
            title: '',
            dispose() {}
        }),
        createOutputChannel: () => ({ appendLine: () => {} }),
        registerFileDecorationProvider: () => ({ dispose() {} }),
        registerTreeDataProvider: () => ({ dispose() {} }),
        onDidChangeActiveTextEditor: () => ({ dispose() {} }),
        onDidChangeTextEditorSelection: () => ({ dispose() {} }),
        createTextEditorDecorationType: () => ({ dispose() {} }),
        tabGroups: { onDidChangeTabs: () => ({ dispose() {} }) },
        createWebviewPanel: (viewType, title, showOptions, options) => {
            const panel = {
                webview: {
                    asWebviewUri: uri => uri,
                    cspSource: 'vscode-resource:',
                    postMessage: () => Promise.resolve(true)
                },
                reveal: () => {},
                onDidDispose: (callback) => {
                    panel._disposeCallback = callback;
                    return { dispose() {} };
                },
                dispose: () => {
                    if (panel._disposeCallback) panel._disposeCallback();
                }
            };
            return panel;
        }
    },
    workspace: {
        textDocuments: [],
        onDidOpenTextDocument: () => ({}),
        onDidChangeTextDocument: () => ({}),
        onDidCloseTextDocument: () => ({}),
        onDidSaveTextDocument: () => ({ dispose() {} }),
        onDidChangeConfiguration: () => ({ dispose() {} }),
        applyEdit: () => Promise.resolve(true),
        createFileSystemWatcher: () => ({
            onDidChange: () => ({}),
            onDidCreate: () => ({}),
            onDidDelete: () => ({}),
            dispose() {},
        }),
        getConfiguration: () => ({
            get: (key) => key === 'language' ? 'en' : undefined
        }),
    },
    languages: { registerFoldingRangeProvider: () => ({}), registerDocumentSymbolProvider: () => ({}), registerDocumentLinkProvider: () => ({}), registerHoverProvider: () => ({}), registerCodeLensProvider: () => ({}), registerInlayHintsProvider: () => ({}), registerDefinitionProvider: () => ({}), registerReferenceProvider: () => ({}), registerRenameProvider: () => ({}), registerCompletionItemProvider: () => ({}), createDiagnosticCollection: () => ({ set: () => {}, delete: () => {} }), setTextDocumentLanguage: (doc, langId) => { doc.languageId = langId; return Promise.resolve(doc); } },
    commands: { registerCommand: () => ({}), executeCommand: () => {} },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
};
