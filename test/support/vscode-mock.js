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

    appendCodeblock(value, language = '') {
        this.value += `\n\`\`\`${language}\n${value}\n\`\`\``;
        return this;
    }
}

class Hover {
    constructor(contents, range) {
        this.contents = Array.isArray(contents) ? contents : [contents];
        this.range = range;
    }
}

class Location {
    constructor(uri, rangeOrPosition) {
        this.uri = uri;
        this.range = rangeOrPosition instanceof Position
            ? new Range(rangeOrPosition, rangeOrPosition)
            : rangeOrPosition;
    }
}

class CodeLens {
    constructor(range, command) {
        this.range = range;
        this.command = command;
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
    Folder: 19,
    Snippet: 27,
    Field: 5,
    Value: 12,
    EnumMember: 20
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

    replace(uri, range, text, metadata) {
        this.edits.push({ uri, range, text, ...(metadata ? { metadata } : {}) });
    }
}

class TextEdit {
    static replace(range, newText) {
        return { range, newText };
    }
}

class CodeAction {
    constructor(title, kind) {
        this.title = title;
        this.kind = kind;
        this.edit = undefined;
        this.diagnostics = [];
        this.isPreferred = false;
    }
}

const CodeActionKind = {
    QuickFix: { value: 'quickfix' },
};

module.exports = {
    TabInputText: class { constructor(uri) { this.uri = uri; } },
    CancellationTokenSource: class CancellationTokenSource {
        constructor() {
            this.listeners = new Set();
            this.token = { isCancellationRequested: false, onCancellationRequested: listener => {
                this.listeners.add(listener);
                return { dispose: () => this.listeners.delete(listener) };
            } };
        }
        cancel() {
            if (this.token.isCancellationRequested) return;
            this.token.isCancellationRequested = true;
            for (const listener of this.listeners) listener();
        }
        dispose() { this.listeners.clear(); }
    },
    Position,
    Range,
    Selection,
    MarkdownString,
    Hover,
    Location,
    CodeLens,
    CompletionItem,
    CompletionItemKind,
    SnippetString,
    CompletionList,
    WorkspaceEdit,
    EndOfLine: { LF: 1, CRLF: 2 },
    TextEdit,
    CodeAction,
    CodeActionKind,
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
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    SymbolKind: { Property: 6 },
    ThemeColor: class ThemeColor {
        constructor(id) { this.id = id; }
    },
    ThemeIcon: class ThemeIcon {},
    TreeItem: class TreeItem { constructor(l, s) { this.label = l; this.collapsibleState = s; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: class EventEmitter { constructor() { this.event = null; } fire() {} dispose() {} },
    window: {
        activeTextEditor: null,
        showQuickPick: () => Promise.resolve(undefined),
        showInformationMessage: () => {},
        showErrorMessage: () => {},
        showWarningMessage: () => {},
        setStatusBarMessage: () => ({ dispose() {} }),
        createStatusBarItem: () => ({
            text: '',
            tooltip: '',
            command: '',
            show() {},
            hide() {},
            dispose() {},
        }),
        createTreeView: (id, options) => ({
            title: '',
            dispose() {}
        }),
        createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose() {} }),
        registerFileDecorationProvider: () => ({ dispose() {} }),
        registerTreeDataProvider: () => ({ dispose() {} }),
        registerWebviewViewProvider: () => ({ dispose() {} }),
        onDidChangeActiveTextEditor: () => ({ dispose() {} }),
        onDidChangeTextEditorSelection: () => ({ dispose() {} }),
        onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
        onDidChangeActiveColorTheme: () => ({ dispose() {} }),
        visibleTextEditors: [],
        activeColorTheme: { kind: 2 },
        createTextEditorDecorationType: () => ({ dispose() {} }),
        tabGroups: { onDidChangeTabs: () => ({ dispose() {} }) },
        createWebviewPanel: (viewType, title, showOptions, options) => {
            const panel = {
                webview: {
                    asWebviewUri: uri => uri,
                    cspSource: 'vscode-resource:',
                    postMessage: () => Promise.resolve(true),
                    onDidReceiveMessage: callback => {
                        panel._messageCallback = callback;
                        return { dispose() {} };
                    }
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
        registerTextDocumentContentProvider: () => ({ dispose() {} }),
        createFileSystemWatcher: () => ({
            onDidChange: () => ({}),
            onDidCreate: () => ({}),
            onDidDelete: () => ({}),
            dispose() {},
        }),
        getConfiguration: () => ({
            get: (key, defaultValue) => key === 'language' ? 'en' : defaultValue
        }),
    },
    languages: { _documentFormattingRegistrations: [], _documentRangeFormattingRegistrations: [], registerFoldingRangeProvider: () => ({}), registerDocumentSymbolProvider: () => ({}), registerDocumentLinkProvider: () => ({}), registerHoverProvider: () => ({}), registerDocumentFormattingEditProvider(selector, provider) { this._documentFormattingRegistrations.push({ selector, provider }); return { dispose() {} }; }, registerDocumentRangeFormattingEditProvider(selector, provider) { this._documentRangeFormattingRegistrations.push({ selector, provider }); return { dispose() {} }; }, registerCodeLensProvider: () => ({}), registerCodeActionsProvider: () => ({}), registerInlayHintsProvider: () => ({}), registerDefinitionProvider: () => ({}), registerReferenceProvider: () => ({}), registerRenameProvider: () => ({}), registerCompletionItemProvider: () => ({}), createDiagnosticCollection: () => ({ set: () => {}, delete: () => {}, clear: () => {}, dispose: () => {} }), setTextDocumentLanguage: (doc, langId) => { doc.languageId = langId; return Promise.resolve(doc); }, getDiagnostics: () => [], onDidChangeDiagnostics: () => ({ dispose() {} }) },
    commands: { registerCommand: () => ({}), executeCommand: () => {} },
    env: { language: 'en', clipboard: { writeText: () => Promise.resolve() } },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    MinimapPosition: { Inline: 1, Gutter: 2 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
};

module.exports.CompletionTriggerKind = { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 };
