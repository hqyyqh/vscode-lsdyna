'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../../src/extension.ts');
const source = fs.readFileSync(filename, 'utf8'), parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
const names = ['buildUnknownKeywordHoverMarkdown', 'handlePickSimilarKeywordHelpCommand'];
const declarations = names.map(name => {
    const node = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, name); return node.getText(parsed);
}).join('\n');
const javascript = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

describe('similar keyword help document ownership', () => {
    function scenario() {
        const document = uri => ({ uri: { toString: () => uri }, lineCount: 2, isClosed: false, version: 1,
            lineAt: line => { assert.ok(line >= 0 && line < 2); return { text: '*UNKNOWN' }; } });
        const a = document('file:///A.k'), b = document('file:///B.k');
        const editor = document => ({ document, selection: { active: { line: 1 } } });
        const ea = editor(a), eb = editor(b), choices = new Map(), commands = [];
        let resolvePick, shown = 0;
        const vscode = { workspace: { textDocuments: [a, b] }, window: { activeTextEditor: ea,
            showQuickPick: () => { shown++; return new Promise(resolve => { resolvePick = resolve; }); } },
            commands: { executeCommand: async name => commands.push(name) },
            Position: class { constructor(line, character) { this.line = line; this.character = character; } },
            Selection: class { constructor(anchor, active) { this.anchor = anchor; this.active = active; } } };
        const context = { module: { exports: {} }, vscode, i18n: { get: key => key },
            suggestSimilarKeywords: () => ({ tier: 'medium', items: [{ keyword: 'NODE' }, { keyword: 'ELEMENT' }] }),
            getRememberedSimilarKeywordChoice: () => null, lookupKeywordInfo: () => null,
            rememberSimilarKeywordChoice: (document, line, unknown, chosen) => choices.set(document, { line, unknown, chosen }) };
        vm.runInNewContext(javascript + '\nmodule.exports = {' + names.join(',') + '};', context, { filename });
        return { ...context.module.exports, a, b, ea, eb, vscode, choices, commands,
            get shown() { return shown; }, pick: value => resolvePick(value) };
    }
    it('puts the original document URI into the actual hover command payload', () => {
        const f = scenario(), built = f.buildUnknownKeywordHoverMarkdown('UNKNOWN', { document: f.a, line: 1 });
        const encoded = built.markdown.match(/command:extension\.pickSimilarKeywordHelp\?([^\s]+)/)[1];
        const [payload] = JSON.parse(decodeURIComponent(encoded));
        assert.equal(payload.uri, 'file:///A.k'); assert.equal(payload.line, 1);
        assert.deepEqual(payload.suggestions, ['NODE', 'ELEMENT']);
    });
    it('remembers the original document after switching editors during the picker', async () => {
        const f = scenario(), selectionB = f.eb.selection;
        const pending = f.handlePickSimilarKeywordHelpCommand({ keyword: 'UNKNOWN', line: 1, suggestions: ['NODE'], uri: 'file:///A.k' });
        f.vscode.window.activeTextEditor = f.eb; f.pick({ keyword: 'NODE' }); await pending;
        assert.equal(f.choices.get(f.a)?.chosen, 'NODE'); assert.equal(f.choices.has(f.b), false);
        assert.equal(f.eb.selection, selectionB); assert.deepEqual(f.commands, []);
    });
    it('honors a hover URI when another editor is already active', async () => {
        const f = scenario(); f.vscode.window.activeTextEditor = f.eb;
        const pending = f.handlePickSimilarKeywordHelpCommand({ keyword: 'UNKNOWN', line: 1, suggestions: ['NODE'], uri: 'file:///A.k' });
        f.pick({ keyword: 'NODE' }); await pending;
        assert.equal(f.choices.get(f.a)?.chosen, 'NODE'); assert.equal(f.choices.has(f.b), false);
        assert.deepEqual(f.commands, []);
    });
    it('captures the original line for ordinary document-local invocation', async () => {
        const f = scenario();
        const pending = f.handlePickSimilarKeywordHelpCommand({ keyword: 'UNKNOWN', suggestions: ['NODE'] });
        f.ea.selection = { active: { line: 0 } }; f.pick({ keyword: 'NODE' }); await pending;
        assert.equal(f.choices.get(f.a)?.line, 1); assert.equal(f.ea.selection.active.line, 1);
        assert.deepEqual(f.commands, ['editor.action.showHover']);
    });
    it('does not retain a choice for a document closed while awaiting selection', async () => {
        const f = scenario();
        const pending = f.handlePickSimilarKeywordHelpCommand({ keyword: 'UNKNOWN', line: 1, suggestions: ['NODE'] });
        f.a.isClosed = true; f.pick({ keyword: 'NODE' }); await pending;
        assert.equal(f.choices.size, 0); assert.deepEqual(f.commands, []);
    });
    it('preserves cancellation without any remembered choice or cursor movement', async () => {
        const f = scenario(), selection = f.ea.selection;
        const pending = f.handlePickSimilarKeywordHelpCommand({ keyword: 'UNKNOWN', line: 1, suggestions: ['NODE'] });
        f.pick(undefined); await pending;
        assert.equal(f.choices.size, 0); assert.equal(f.ea.selection, selection); assert.deepEqual(f.commands, []);
    });
    it('rejects a choice whose source document changed while the picker was open', async () => {
        const f = scenario();
        const pending = f.handlePickSimilarKeywordHelpCommand({ keyword: 'UNKNOWN', line: 1, suggestions: ['NODE'] });
        f.a.version++; f.pick({ keyword: 'NODE' }); await pending;
        assert.equal(f.choices.size, 0); assert.deepEqual(f.commands, []);
    });
    it('ignores an unavailable source document without an active editor', async () => {
        const f = scenario(); f.vscode.window.activeTextEditor = undefined;
        await f.handlePickSimilarKeywordHelpCommand({ keyword: 'UNKNOWN', suggestions: ['NODE'], uri: 'file:///absent.k' });
        assert.equal(f.shown, 0); assert.equal(f.choices.size, 0); assert.deepEqual(f.commands, []);
    });
});
