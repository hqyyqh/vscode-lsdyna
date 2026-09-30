'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { buildKeywordOptionViewModel, keywordManagerInstances, keywordManagerReadFieldHelp } = require('../out/extension')._internals;

function fixture() {
    const lines = ['*DATABASE_BINARY_BLSTFOR', '11,1,1,1,1', '*DATABASE_BINARY_CPMFOR', '12,1,1,1,1', '*END'];
    let reads = 0;
    const document = { languageId: 'lsdyna', version: 1, eol: 1, lineCount: lines.length,
        uri: vscode.Uri.file('D:/temp/manager-refresh.k'),
        lineAt: i => { reads++; return { text: lines[i] }; }, getText: () => lines.join('\n') };
    return { document, lines, reads: () => reads, editor: { document, selection: { active: new vscode.Position(0, 0) } } };
}

describe('keyword manager refresh boundaries', () => {
    it('reads help without document reads or model mutation, and rejects stale contexts', () => {
        const { document, editor } = fixture();
        const model = buildKeywordOptionViewModel(editor, 0, { provisional: true });
        const before = JSON.stringify(model);
        const request = { instanceId: model.selectedInstanceId, fieldId: model.managerCards[0].fields[1].fieldId };
        document.lineAt = () => { throw new Error('Help must not rebuild or enumerate the document'); };
        assert.equal(keywordManagerReadFieldHelp(model, editor, request).fieldId, request.fieldId);
        assert.equal(JSON.stringify(model), before);
        assert.equal(keywordManagerReadFieldHelp(model, editor, { ...request, instanceId: 'other' }), null);
        assert.equal(keywordManagerReadFieldHelp(model, editor, { ...request, fieldId: 'absent' }), null);
        assert.equal(keywordManagerReadFieldHelp({ ...model, stale: true }, editor, request), null);
        document.version++;
        assert.equal(keywordManagerReadFieldHelp(model, editor, request), null);
    });

    it('reuses enumeration but projects selection and file state afresh; invalidates on version and index changes', () => {
        const { document, lines, reads } = fixture();
        const first = keywordManagerInstances(document, 0, null);
        const count = reads();
        first[0].editLevel = 'editable';
        first[0].displayName = 'must not leak';
        document.isDirty = true;
        const next = keywordManagerInstances(document, 2, null);
        assert.equal(reads(), count);
        assert.equal(next[0].selected, false);
        assert.equal(next[1].selected, true);
        assert.equal(next[0].dirty, true);
        assert.equal(next[0].editLevel, 'view-only');
        assert.notEqual(next[0].displayName, first[0].displayName);
        document.version++;
        lines[0] = '*DATABASE_BINARY_CPMFOR';
        assert.equal(keywordManagerInstances(document, 0, null)[0].keyword, '*DATABASE_BINARY_CPMFOR');
        assert.ok(reads() > count);
        let enumerations = 0;
        const index = { lineCount: document.lineCount, getOccurrences() { enumerations++; return []; } };
        assert.deepEqual(keywordManagerInstances(document, 0, index), []);
        keywordManagerInstances(document, 2, index);
        assert.equal(enumerations, 1);
        keywordManagerInstances(document, 2, { ...index });
        assert.equal(enumerations, 2);
        assert.ok(keywordManagerInstances(document, 0, null).length > 0);
    });
});
