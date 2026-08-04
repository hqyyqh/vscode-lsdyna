'use strict';

const assert = require('assert');
const { createChangeMarksController } = require('../../../src/client/changeMarks/changeMarksController');
const { emptyChangeMarks } = require('../../../src/client/changeMarks/types');

function fullConfig(overrides = {}) {
    return {
        enabled: true,
        maxLineCount: 100000,
        debounceMs: 0,
        showOverviewRuler: true,
        showLineBackground: true,
        showMinimap: true,
        ...overrides,
    };
}

function createMockDocument(text, opts = {}) {
    const lines = text == null ? [''] : String(text).replace(/\r\n/g, '\n').split('\n');
    let lineTexts = lines.slice();
    const uri = opts.uri || { toString: () => opts.uriString || 'file:///deck.k', fsPath: 'deck.k' };
    return {
        uri,
        languageId: opts.languageId || 'lsdyna',
        lineCount: lineTexts.length,
        getText: () => text == null ? '' : String(text),
        lineAt(line) {
            return { text: lineTexts[line] != null ? lineTexts[line] : '' };
        },
        _setText(next) {
            text = next;
            lineTexts = String(next).replace(/\r\n/g, '\n').split('\n');
            this.lineCount = lineTexts.length;
        },
    };
}

function createMockEditor(document, line = 0) {
    const decorations = [];
    return {
        document,
        selection: {
            active: { line, character: 0 },
        },
        setDecorations(type, ranges) {
            decorations.push({ type, ranges: Array.isArray(ranges) ? ranges.slice() : ranges });
        },
        revealRange() {},
        _decorations: decorations,
    };
}

function createMockVscode(editor) {
    const openDocs = editor ? [editor.document] : [];
    const visible = editor ? [editor] : [];
    const configListeners = [];
    const cmdHandlers = new Map();
    const contentProviders = new Map();
    const createdTypes = [];

    return {
        Uri: {
            parse(s) {
                const str = String(s);
                const qIdx = str.indexOf('?');
                return {
                    scheme: str.split(':')[0],
                    path: qIdx >= 0 ? str.slice(str.indexOf(':') + 1, qIdx) : str.slice(str.indexOf(':') + 1),
                    query: qIdx >= 0 ? str.slice(qIdx + 1) : '',
                    toString: () => str,
                };
            },
        },
        Position: function Position(line, character) {
            this.line = line;
            this.character = character;
        },
        Range: function Range(a, b) {
            this.start = a;
            this.end = b;
        },
        Selection: function Selection(a, b) {
            this.start = a;
            this.end = b;
            this.active = a;
        },
        ThemeColor: function ThemeColor(id) { this.id = id; },
        OverviewRulerLane: { Left: 1 },
        MinimapPosition: { Inline: 1 },
        TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
        window: {
            visibleTextEditors: visible,
            activeTextEditor: editor || null,
            activeColorTheme: { kind: 2 },
            createTextEditorDecorationType(opts) {
                const t = { opts, dispose() {} };
                createdTypes.push(t);
                return t;
            },
            onDidChangeVisibleTextEditors() { return { dispose() {} }; },
            onDidChangeActiveColorTheme() { return { dispose() {} }; },
            showInformationMessage() { return Promise.resolve(); },
            showErrorMessage() { return Promise.resolve(); },
        },
        workspace: {
            textDocuments: openDocs,
            registerTextDocumentContentProvider(scheme, provider) {
                contentProviders.set(scheme, provider);
                return { dispose() {}, provider };
            },
            onDidOpenTextDocument() { return { dispose() {} }; },
            onDidChangeTextDocument() { return { dispose() {} }; },
            onDidSaveTextDocument() { return { dispose() {} }; },
            onDidCloseTextDocument() { return { dispose() {} }; },
            onDidChangeConfiguration(cb) {
                configListeners.push(cb);
                return { dispose() {} };
            },
        },
        commands: {
            executeCommand(id, ...args) {
                cmdHandlers.set(id, args);
                return Promise.resolve();
            },
        },
        _createdTypes: createdTypes,
        _cmdHandlers: cmdHandlers,
        _contentProviders: contentProviders,
        _configListeners: configListeners,
    };
}

describe('changeMarksController', () => {
    it('recomputeNow paints unsavedModified marks after edit', () => {
        const doc = createMockDocument('A\nB\nC');
        const editor = createMockEditor(doc);
        const vscode = createMockVscode(editor);
        const controller = createChangeMarksController({
            vscode,
            isLsdynaDocument: () => true,
            getConfig: () => fullConfig(),
        });
        controller.register({ subscriptions: [] });

        doc._setText('A\nB2\nC');
        controller.recomputeNow(doc);

        const marks = controller.getMarksForDocument(doc);
        assert.deepStrictEqual(marks.unsavedModifiedLines, [1]);
        assert.ok(editor._decorations.length >= 1);

        controller.dispose();
    });

    it('save promotes dirty line to savedModified', () => {
        const doc = createMockDocument('A\nB');
        const editor = createMockEditor(doc);
        const vscode = createMockVscode(editor);
        const controller = createChangeMarksController({
            vscode,
            isLsdynaDocument: () => true,
            getConfig: () => fullConfig({ showOverviewRuler: false }),
        });
        controller.register({ subscriptions: [] });

        doc._setText('A\nB2');
        controller.recomputeNow(doc);
        assert.deepStrictEqual(controller.getMarksForDocument(doc).unsavedModifiedLines, [1]);

        const store = controller.getStore();
        store.save(doc.uri.toString(), doc.getText());
        controller.recomputeNow(doc);
        const after = controller.getMarksForDocument(doc);
        assert.deepStrictEqual(after.unsavedModifiedLines, []);
        assert.deepStrictEqual(after.savedModifiedLines, [1]);

        controller.dispose();
    });

    it('jumpNext wraps to first mark', () => {
        const doc = createMockDocument('A\nB\nC\nD');
        const editor = createMockEditor(doc, 0);
        const vscode = createMockVscode(editor);
        const controller = createChangeMarksController({
            vscode,
            isLsdynaDocument: () => true,
            getConfig: () => fullConfig(),
        });
        controller.register({ subscriptions: [] });
        doc._setText('A\nB2\nC\nD2');
        controller.recomputeNow(doc);

        assert.strictEqual(controller.jumpNext(editor), true);
        assert.strictEqual(editor.selection.active.line, 1);
        assert.strictEqual(controller.jumpNext(editor), true);
        assert.strictEqual(editor.selection.active.line, 3);
        assert.strictEqual(controller.jumpNext(editor), true);
        assert.strictEqual(editor.selection.active.line, 1);

        controller.dispose();
    });

    it('skips non-eligible documents', () => {
        const doc = createMockDocument('A');
        const editor = createMockEditor(doc);
        const vscode = createMockVscode(editor);
        const controller = createChangeMarksController({
            vscode,
            isLsdynaDocument: () => false,
            getConfig: () => fullConfig(),
        });
        controller.register({ subscriptions: [] });
        doc._setText('B');
        controller.recomputeNow(doc);
        assert.deepStrictEqual(controller.getMarksForDocument(doc), emptyChangeMarks());
        controller.dispose();
    });

    it('register does not throw when open docs lack getText', () => {
        const stub = {
            uri: { fsPath: '/test/file.asc' },
            languageId: 'lsdyna',
            lineCount: 1,
        };
        const vscode = createMockVscode(null);
        vscode.workspace.textDocuments = [stub];
        const controller = createChangeMarksController({
            vscode,
            isLsdynaDocument: (doc) => doc === stub || doc?.languageId === 'lsdyna',
            getConfig: () => fullConfig(),
        });
        assert.doesNotThrow(() => controller.register({ subscriptions: [] }));
        controller.dispose();
    });

    it('preserves an encoded Windows URI when loading the diff origin baseline', async () => {
        const uriString = 'file:///d%3A/Project/My%20Deck+Variant/model.k';
        const doc = createMockDocument('ORIGINAL', { uriString });
        const editor = createMockEditor(doc);
        const vscode = createMockVscode(editor);
        const controller = createChangeMarksController({
            vscode,
            isLsdynaDocument: () => true,
            getConfig: () => fullConfig(),
        });
        controller.register({ subscriptions: [] });

        doc._setText('CHANGED');
        await controller.showDiffSinceOpened(editor);

        const [left] = vscode._cmdHandlers.get('vscode.diff');
        const provider = vscode._contentProviders.get('lsdyna-change-marks');
        assert.ok(provider, 'diff content provider registered');
        assert.strictEqual(provider.provideTextDocumentContent(left), 'ORIGINAL');

        controller.dispose();
    });

    it('preserves encoded spaces and literal plus signs in the save-point diff key', async () => {
        const uriString = 'file:///d%3A/Project/A%20B+C/model.k';
        const doc = createMockDocument('SAVED', { uriString });
        const editor = createMockEditor(doc);
        const vscode = createMockVscode(editor);
        const controller = createChangeMarksController({
            vscode,
            isLsdynaDocument: () => true,
            getConfig: () => fullConfig(),
        });
        controller.register({ subscriptions: [] });

        doc._setText('DIRTY');
        await controller.showDiffUnsaved(editor);

        const [left] = vscode._cmdHandlers.get('vscode.diff');
        const provider = vscode._contentProviders.get('lsdyna-change-marks');
        assert.strictEqual(provider.provideTextDocumentContent(left), 'SAVED');

        controller.dispose();
    });

    it('creates decoration types with restrained line background by default', () => {
        const doc = createMockDocument('A');
        const editor = createMockEditor(doc);
        const vscode = createMockVscode(editor);
        const controller = createChangeMarksController({
            vscode,
            isLsdynaDocument: () => true,
            getConfig: () => fullConfig({ showLineBackground: true }),
        });
        controller.register({ subscriptions: [] });
        assert.ok(vscode._createdTypes.length >= 6, 'six visual states');
        const withBg = vscode._createdTypes.filter(t => t.opts && t.opts.backgroundColor);
        assert.ok(withBg.length >= 1, 'expected backgroundColor on types');
        for (const t of withBg) {
            assert.strictEqual(t.opts.isWholeLine, true, 'whole-line tint');
            const bg = String(t.opts.backgroundColor);
            assert.ok(bg.includes('rgba'), `expected rgba tint: ${bg}`);
            const m = bg.match(/[\d.]+(?=\))/);
            if (m) {
                const alpha = Number(m[0]);
                assert.ok(alpha < 0.20, `alpha too strong: ${alpha}`);
            }
            assert.ok(!t.opts.borderColor && !t.opts.borderStyle, 'no content border');
        }
        controller.dispose();
    });

    it('omits line background when showLineBackground is false', () => {
        const doc = createMockDocument('A');
        const editor = createMockEditor(doc);
        const vscode = createMockVscode(editor);
        const controller = createChangeMarksController({
            vscode,
            isLsdynaDocument: () => true,
            getConfig: () => fullConfig({ showLineBackground: false }),
        });
        controller.register({ subscriptions: [] });
        for (const t of vscode._createdTypes) {
            assert.ok(!t.opts.backgroundColor, 'no background when disabled');
        }
        controller.dispose();
    });
});
