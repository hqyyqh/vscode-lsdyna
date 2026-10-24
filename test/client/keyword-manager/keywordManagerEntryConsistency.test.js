'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), zlib = require('node:zlib');
const vscode = require('vscode');
const api = require('../../../out/extension')._internals;
const { documentFor, editorFor } = require('../../support/keyword-manager/conditional-fixtures.cjs')({ vscode });
const fixture = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-suffix-write-matrix.json.gz'))));
const markdown = hover => (hover?.contents || []).map(content => content.value || '').join('\n');
const command = '](command:extension.lsdynaChooseKeywordOptions?';

describe('keyword manager entry and selector consistency', function () {
    this.timeout(300000);
    it('offers the manager in compact and detailed hovers and CodeLens for every verified native suffix', async () => {
        const previous = vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration = (...args) => {
            const config = previous(...args);
            return { ...config, get: (key, fallback) => key === 'codeLens.showOnAllKeywords' ? true : config.get(key, fallback) };
        };
        try {
            let count = 0;
            for (const task of fixture().cases.filter(task => task.id.endsWith('/standard'))) {
                const document = documentFor([...task.lines, '*END']);
                const provider = new api.LsdynaFieldHoverProvider();
                for (const detailed of [false, true]) {
                    const hover = await (detailed ? provider.provideDetailedHover(document, new vscode.Position(0, 3))
                        : provider.provideHover(document, new vscode.Position(0, 3)));
                    const text = markdown(hover);
                    assert.ok(text.includes(command), task.id + '/' + detailed);
                    assert.ok(!text.includes('command:extension.addCustomValidKeyword'), task.id);
                    const match = text.match(/command:extension\.lsdynaChooseKeywordOptions\?([^\s)]+)/);
                    const request = JSON.parse(decodeURIComponent(match[1]))[0];
                    assert.equal(request.keywordLine, 0);
                    assert.equal(request.documentVersion, document.version);
                }
                const lenses = new api.LsdynaKeywordOptionsCodeLensProvider().provideCodeLenses(document);
                assert.ok(lenses.some(lens => lens.command.command === 'extension.lsdynaChooseKeywordOptions' && lens.range.start.line === 0), task.id);
                count++;
            }
            assert.equal(count, 1065);
        } finally { vscode.workspace.getConfiguration = previous; }
    });

    it('does not give unknown keywords a manager link or turn recognition into write authority', async () => {
        const document = documentFor(['*NOT_A_VERIFIED_NATIVE_KEYWORD', '1', '*END']);
        const provider = new api.LsdynaFieldHoverProvider();
        assert.ok(!markdown(await provider.provideHover(document, new vscode.Position(0, 3))).includes(command));
        assert.ok(!markdown(await provider.provideDetailedHover(document, new vscode.Position(0, 3))).includes(command));
        const task = fixture().cases.find(task => task.keyword === 'CONSTRAINED_JOINT_CYLINDRICAL_ID');
        const previous = vscode.workspace.fs;
        try {
            vscode.workspace.fs = { ...previous, isWritableFileSystem: () => false };
            const doc = documentFor([...task.lines, '*END']);
            doc.uri.scheme = 'file';
            const model = api.buildKeywordOptionViewModel(editorFor(doc), 0, {});
            assert.ok(model.managerCards.flatMap(card => card.fields).every(field => !field.editable));
            assert.ok(model.controls.every(control => !control.enabled));
            assert.equal(api.buildKeywordOptionsViewState(model).canApply, false);
            assert.ok(markdown(await provider.provideHover(doc, new vscode.Position(0, 3))).includes(command));
        } finally { vscode.workspace.fs = previous; }
    });

    it('derives selector choices and capability claims from the same guarded transition plans', () => {
        for (const name of ['CONSTRAINED_JOINT_CYLINDRICAL', 'CONSTRAINED_JOINT_REVOLUTE']) {
            const row = '         1         2         3         4         0         0         1         1';
            for (const suffix of ['', '_ID']) {
                const document = documentFor(['*' + name + suffix, ...(suffix ? ['         1joint'] : []), row, '*END']);
                const editor = editorFor(document), initial = api.buildKeywordOptionViewModel(editor, 0, {});
                const control = initial.controls[0];
                assert.ok(control);
                for (const value of ['', ...control.choices.map(choice => choice.value)]) {
                    const candidate = api.buildKeywordOptionViewModel(editor, 0, { draftControlState: { [control.controlId]: value } });
                    const current = value === (initial.currentControlState[control.controlId] || '');
                    assert.equal(value === '' ? control.emptyEnabled : control.choices.find(choice => choice.value === value).enabled,
                        current || api.buildKeywordOptionsViewState(candidate).canApply, name + suffix + '/' + value);
                }
                const capability = initial.capabilities.find(item => item.capabilityId === 'spelling-switch');
                assert.equal(capability.availability, suffix ? 'view-only' : 'available');
                assert.equal(control.enabled, !suffix);
                assert.ok(initial.managerCards.flatMap(card => card.fields).some(field => field.editable));
            }
        }
    });
});
