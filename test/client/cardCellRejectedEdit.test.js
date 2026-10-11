'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../../src/extension.ts');
const source = fs.readFileSync(filename, 'utf8');
const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
const names = ['handleCardCellDelete', 'finalizeCardCellComposition', 'cancelCardCellComposition', 'startEmptyCellBoundaryTypeChoice', 'handleCardCellTypeWithNavigation'];
const declarations = names.map(name => {
    const node = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, `Missing current production handler: ${name}`);
    return node.getText(parsed);
}).join('\n');

describe('card cell callers preserve rejected edit state', () => {
    async function run(flow, outcome) {
        const effects = { edits: 0, marks: 0, typing: 0, contextTrue: 0, released: 0, owned: 0 };
        const document = { isClosed: false, lineCount: 1, lineAt: () => ({ text: 'original' }) };
        const selection = { active: { line: 0, character: 0 } };
        const editor = { document, selection, selections: [selection] };
        const plan = { lineNum: 0, fieldIndex: 0, newText: 'edited', selStart: 0, selEnd: 1, caret: 1, markAp: true };
        if (flow === 'delete-line') Object.assign(plan, { deleteLine: true, markA: { fieldIndex: 0 } });
        if (flow === 'merge') plan.mergeLeft = { line: 'edited', caretCol: 1, leftFieldIndex: 0 };
        const guard = { clearNav() {}, shouldCellEditActive: () => true,
            markAp: () => { effects.marks++; }, planDelete: () => plan, planType: () => plan,
            getNav: () => ({ line: 0, fieldIndex: 0 }) };
        const apply = async () => { effects.edits++; return outcome; };
        const compositions = new Map();
        const context = { module: { exports: {} },
            vscode: { window: { activeTextEditor: editor }, commands: { executeCommand: async (name, ...args) => {
                if (name === 'setContext' && args[1] === true) effects.contextTrue++;
            } } },
            inlineEditChoiceSession: null, clearCardCellTypingSession() {}, waitForPendingCardCellPostEdit: async () => false,
            isLsdynaFile: () => true, isActiveLsdynaSemanticLocation: () => true, ensureCardCellEditGuard: () => guard,
            applyCardCellLineEdit: apply, applyCardCellLineDelete: apply,
            markCardCellA: () => { effects.marks++; }, rememberCardCellTypingSession: () => { effects.typing++; },
            canContinueCardCellTypingSession: () => false, cardCellCompositions: compositions,
            beginCardCellPostEditBarrier: () => () => { effects.released++; },
            beginCardCellOwnedEdit: () => { effects.owned++; }, endCardCellOwnedEdit: () => { effects.owned--; },
            readCardCellCompositionText: () => '9', planCardCellComposition: () => plan,
            getCardFieldsForLine: () => [{}, {}], i18n: { get: key => key }, fixedCellPreview: () => '',
            cardCellModel: { readCellValue: () => '1', writeCellR1: () => 'edited', valueIndexAtCaret: () => 0, caretAfterCellValue: () => 1 },
            startInlineEditChoiceSession: async (_editor, _line, _source, choices) => choices[flow === 'merge' ? 1 : 0].apply(),
        };
        // Complete current production handlers execute unchanged. VS Code,
        // planner and edit-return boundaries are explicit fault-injection models.
        vm.runInNewContext(declarations + '\nmodule.exports = {' + names.join(',') + '};', context, { filename });
        const handlers = context.module.exports;
        if (['delete-line', 'delete-text', 'merge'].includes(flow)) await handlers.handleCardCellDelete('left');
        else if (flow === 'composition') {
            const state = { editor, phase: 'composing', lineNum: 0, fieldIndex: 0, originalLine: 'original' };
            compositions.set(document, state);
            await handlers.finalizeCardCellComposition(document, state);
        } else if (flow === 'boundary') await handlers.startEmptyCellBoundaryTypeChoice(editor,
            { lineNum: 0, ambiguousPreviousFieldIndex: 0, fieldIndex: 1, caretCol: 1 }, '9', guard);
        else await handlers.handleCardCellTypeWithNavigation({ text: '9' }, '9', editor, guard);
        assert.equal(effects.edits, 1, `${flow} must reach the intended edit boundary`);
        assert.equal(effects.marks, outcome === false ? 0 : 1);
        assert.equal(effects.contextTrue, outcome === false ? 0 : 1);
        assert.equal(effects.typing, outcome === false || flow.startsWith('delete-') || flow === 'merge' ? 0 : 1);
        assert.equal(effects.owned, 0);
        assert.equal(effects.released, flow === 'composition' ? 1 : 0, 'composition barrier always releases');
    }
    for (const flow of ['merge', 'delete-line', 'delete-text', 'composition', 'boundary', 'typing']) {
        for (const outcome of [false, undefined, true]) {
            it(`${flow} handles explicit ${String(outcome)} without inventing a successful edit`, () => run(flow, outcome));
        }
    }
});

describe('composition undo stays with its captured editor', () => {
    async function run(flow, transition) {
        const effects = { commands: [], edits: 0, marks: 0, selections: 0, released: 0, owned: 0, contextTrue: 0 };
        const interruptedUndo = transition.startsWith('undo-') || transition === 'normal-redo';
        const a = { history: [interruptedUndo ? 'prior' : 'original', 'preedit'], index: 1 };
        const b = { history: ['other-original', 'other-edited'], index: transition.startsWith('undo-') ? 0 : 1 };
        if (transition === 'already-restored') a.index = 0;
        const documentFor = file => ({ isClosed: false, version: 1, lineCount: 1,
            lineAt: () => ({ text: file.history[file.index] }) });
        const document = documentFor(a), otherDocument = documentFor(b);
        const files = new Map([[document, a], [otherDocument, b]]);
        const editor = { document, get selection() { return {}; }, set selection(_value) { effects.selections++; } };
        const otherEditor = { document: otherDocument };
        const sameDocumentEditor = { document };
        const state = { editor, phase: 'composing', lineNum: 0, fieldIndex: 0, mode: 'A',
            originalLine: 'original', expectedStart: 0, expectedEnd: 1 };
        const compositions = new Map([[document, state]]);
        let settle, releaseUndo;
        const vscode = { window: { activeTextEditor: editor },
            Position: function(line, character) { Object.assign(this, { line, character }); },
            Selection: function(anchor, active) { Object.assign(this, { anchor, active }); },
            commands: { executeCommand: async (command, ...args) => {
                if (command === 'setContext') { if (args[1] === true) effects.contextTrue++; return; }
                assert.ok(['undo', 'redo'].includes(command));
                const activeDocument = vscode.window.activeTextEditor.document;
                const file = files.get(activeDocument);
                assert.ok(file, 'global history command must resolve the actual active document');
                effects.commands.push(`${command}:${activeDocument === document ? 'A' : 'B'}`);
                file.index += command === 'undo' ? -1 : 1;
                activeDocument.version++;
                if (command === 'undo') await new Promise(resolve => { releaseUndo = resolve; });
            } } };
        const context = { module: { exports: {} }, vscode, cardCellCompositions: compositions,
            ensureCardCellEditGuard: () => ({ clearNav() {}, shouldCellEditActive: () => true, markAp() { effects.marks++; } }),
            beginCardCellPostEditBarrier: () => () => { effects.released++; },
            beginCardCellOwnedEdit: () => { effects.owned++; }, endCardCellOwnedEdit: () => { effects.owned--; },
            readCardCellCompositionText: () => '9', planCardCellComposition: () => ({ newText: 'corrected', caret: 1 }),
            applyCardCellLineEdit: async () => { effects.edits++; a.history.splice(a.index + 1); a.history.push('corrected'); a.index++; return true; },
            markCardCellA: () => { effects.marks++; }, rememberCardCellTypingSession() {},
            i18n: { get: key => key }, CARD_IME_CANCEL_SETTLE_MS: 100,
            setTimeout(callback, delay) { assert.equal(delay, 100); settle = callback; },
        };
        vm.runInNewContext(declarations + '\nmodule.exports = { finalizeCardCellComposition, cancelCardCellComposition };', context, { filename });
        if (transition === 'inactive-entry') vscode.window.activeTextEditor = otherEditor;
        const pending = context.module.exports[`${flow}CardCellComposition`](document, state);
        const changeOwnership = () => {
            if (transition.endsWith('switch-other')) vscode.window.activeTextEditor = otherEditor;
            else if (transition.endsWith('switch-same-document')) vscode.window.activeTextEditor = sameDocumentEditor;
            else if (transition.endsWith('replace-document')) editor.document = otherDocument;
            else if (transition.endsWith('close')) document.isClosed = true;
        };
        if (flow === 'cancel' && transition !== 'inactive-entry') {
            assert.equal(typeof settle, 'function', 'cancel must retain the native settle boundary');
            if (transition.startsWith('settle-')) changeOwnership();
            settle();
            await Promise.resolve();
        }
        if (transition.startsWith('undo-')) {
            assert.equal(typeof releaseUndo, 'function', 'test transition must occur during the actual awaited Undo');
            changeOwnership();
        }
        if (releaseUndo) releaseUndo();
        await pending;
        const rejectedBeforeUndo = transition.startsWith('settle-') || transition === 'inactive-entry';
        const rejectedAfterUndo = transition.startsWith('undo-');
        const expected = rejectedBeforeUndo || transition === 'already-restored' ? []
            : transition === 'normal-redo' ? ['undo:A', 'redo:A'] : ['undo:A'];
        assert.deepEqual(effects.commands, expected);
        assert.equal(b.index, transition.startsWith('undo-') ? 0 : 1, 'unrelated history position must not move');
        assert.equal(otherDocument.lineAt(0).text, transition.startsWith('undo-') ? 'other-original' : 'other-edited');
        const applies = flow === 'finalize' && transition === 'normal-restore';
        assert.equal(effects.edits, applies ? 1 : 0);
        assert.equal(document.lineAt(0).text, rejectedBeforeUndo || transition === 'normal-redo' ? 'preedit'
            : rejectedAfterUndo ? 'prior' : applies ? 'corrected' : 'original');
        if (rejectedBeforeUndo || rejectedAfterUndo || transition === 'normal-redo') {
            assert.equal(effects.marks, 0);
            assert.equal(effects.selections, 0);
            assert.equal(effects.contextTrue, 0);
        }
        assert.equal(effects.owned, 0);
        assert.equal(effects.released, 1, 'the document barrier must release on every exit');
        assert.equal(compositions.has(document), false);
    }
    for (const flow of ['cancel', 'finalize']) {
        const transitions = ['inactive-entry', 'undo-switch-other', 'undo-switch-same-document',
            'undo-replace-document', 'undo-close', 'normal-restore', 'normal-redo'];
        if (flow === 'cancel') transitions.push('settle-switch-other', 'settle-switch-same-document',
            'settle-replace-document', 'settle-close', 'already-restored');
        for (const transition of transitions) it(`${flow} preserves ownership (${transition})`, () => run(flow, transition));
    }
});
