 'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const snippets = require("../../../snippets/lsdyna.json");
const legacy = require("../../fixtures/incomplete-native-templates.json").templates;
const I = require("../../../out/extension")._internals;
const model = I.buildKeywordOptionViewModel, view = I.buildKeywordOptionsViewState;
function text(keyword = '*MAT_DAMAGE_1_TITLE', current = false) {
    const body = current || !legacy[keyword] ? snippets[keyword].body : legacy[keyword];
    return [...body.map(line => line.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '')), '*END'].join('\n');
}
function editor(source) {
    const lines = source.split(/\r?\n/);
    return { document: { languageId: 'lsdyna', version: 1, eol: source.includes('\r\n') ? 2 : 1, lineCount: lines.length,
        uri: vscode.Uri.file('D:/temp/incomplete-template.k'), getText: () => source, lineAt: i => ({ text: lines[i] }) },
        selection: { active: new vscode.Position(0, 0) } };
}
function fields(m) { return m.managerCards.flatMap(card => card.fields); }
function change(e, values) {
    const base = model(e, 0, {});
    return model(e, 0, { fieldDrafts: Object.fromEntries(Object.entries(values).map(([name, value]) =>
        [fields(base).find(f => f.name === name).fieldId, value])) });
}
async function apply(m, e) {
    const old = vscode.workspace.applyEdit, active = vscode.window.activeTextEditor;
    let edit;
    vscode.window.activeTextEditor = e;
    vscode.workspace.applyEdit = async value => { edit = value; return true; };
    try { await I.applyKeywordOptionViewModel({ getModel: () => m, markStale() {} }, e); return edit?.edits[0]; }
    finally { vscode.workspace.applyEdit = old; vscode.window.activeTextEditor = active; }
}
describe('incomplete native templates', () => {
    for (const keyword of ['*MAT_DAMAGE_1_TITLE', '*MAT_DAMAGE_1', '*MAT_104_TITLE', '*MAT_104',
        '*MAT_PLASTIC_KINEMATIC_TITLE', '*MAT_PLASTIC_KINEMATIC']) {
        it(`opens the real ${keyword} snippet including its cursor tail`, () => {
            const m = model(editor(text(keyword, true)), 0, {});
            assert.notEqual(m.plan.status, 'blocked', m.plan.reason);
            const ro = fields(m).find(f => f.name === 'RO');
            assert.ok(ro.editable);
            assert.equal(ro.value, '');
            assert.equal(ro.diagnostic, undefined);
            assert.notEqual(view(m).status, 'error');
        });
        it(`retains local editing of the legacy unfinished ${keyword} template`, () => {
            const m = model(editor(text(keyword)), 0, {});
            assert.notEqual(m.plan.status, 'blocked', m.plan.reason);
            assert.ok(fields(m).find(f => f.name === 'RO').editable);
            assert.equal(fields(m).find(f => f.name === 'RO').diagnostic.code, 'number');
            assert.equal(fields(m).find(f => f.name === 'RO').diagnostic.blocksApply, false);
            assert.notEqual(view(m).status, 'error');
        });
    }
    it('applies only RO and preserves every other byte, comments, blank tail and next keyword', async () => {
        const source = text().replace(/\n/g, '\r\n'), e = editor(source), m = change(e, { RO: '7.85' });
        assert.equal(view(m).canApply, true);
        const edit = await apply(m, e);
        assert.ok(edit);
        const expected = source.replace('        RO', '      7.85').slice(0, -4);
        assert.equal(edit.text, expected);
        const reopened = model(editor(edit.text + '*END'), 0, {});
        assert.equal(fields(reopened).find(f => f.name === 'RO').value, '7.85');
        assert.equal(fields(reopened).find(f => f.name === 'E').value, 'E');
        assert.notEqual(reopened.plan.status, 'blocked');
        assert.equal(fields(reopened).find(f => f.name === 'TITLE').diagnostic, undefined);
    });
    for (const [name, value, code] of [['RO','oops','number'],['MID','1.5','integer'],['RO','12345678901','width'],
        ['RO','1\n2','characters'],['FLAG','2','choice']]) {
        it(`distinguishes advisory and unsafe input ${name}=${JSON.stringify(value)}`, async () => {
            const e = editor(text()), m = change(e, { E: '210000', [name]: value });
            assert.equal(view(m).canApply, !['width','characters'].includes(code));
            const field = fields(m).find(f => f.name === name);
            assert.equal(field.diagnostic.code, code);
            assert.equal(field.diagnostic.source, 'draft');
            assert.equal(field.editable, true);
            assert.equal(!!await apply(m,e), !['width','characters'].includes(code));
        });
    }
    for (const value of ['1.5', '1.5D+3', '', '&rho', '-&rho']) {
        it(`retains a safe scalar draft ${JSON.stringify(value)}`, () => {
            const m = change(editor(text()), { RO: value });
            assert.equal(view(m).canApply, true, m.plan.reason);
            if (value.includes('&')) assert.equal(fields(m).find(f => f.name === 'RO').diagnostic, undefined);
        });
    }
    for (const value of ['&flag', '-&flag', '<a+1>']) {
        it(`preserves parameterized enum text ${value}`, async () => {
            const e = editor(text()), m = change(e, { FLAG: value });
            assert.equal(view(m).canApply, true, m.plan.reason);
            assert.equal(fields(m).find(f => f.name === 'FLAG').diagnostic, undefined);
            assert.ok((await apply(m,e)).text.includes(value));
        });
    }
    it('accepts a numeric hint in a whole-record draft through the same host staging path', async () => {
        const e = editor(text()), base = model(e,0,{}), record = base.targetLayout.records[1];
        const source = base.block.records[1].text;
        const m = model(e,0,{recordDrafts:{[record.recordMigrationId]:source.slice(0,10)+'      oops'+source.slice(20)}});
        assert.equal(view(m).canApply,true);
        assert.ok(await apply(m,e));
    });
    it('rejects control characters at the edge of a whole-record field', async () => {
        const e = editor(text()), base = model(e,0,{}), record = base.targetLayout.records[1];
        const source = base.block.records[1].text;
        const m = model(e,0,{recordDrafts:{[record.recordMigrationId]:source.slice(0,10)+'     7.85\n'+source.slice(20)}});
        assert.equal(view(m).canApply,false);
        assert.equal(await apply(m,e),undefined);
    });
    it('keeps conditional templates read-only without claiming unverified fixed record counts', () => {
        const conditional = model(editor(text('*MAT_ELASTIC_TITLE')),0,{});
        assert.equal(conditional.plan.status,'blocked');
        assert.ok(view(conditional).layoutDiagnostics.length);
        const extra = model(editor(text().replace('*END','garbage\n*END')),0,{});
        assert.equal(view(extra).layoutDiagnostics[0].code,'repeatUnsupported');
        assert.equal(view(extra).layoutDiagnostics[0].expectedRecords, undefined);
    });
    it('opens a verified title-only template and preserves its title when filling the missing body', async () => {
        const source = '*MAT_DAMAGE_1_TITLE\nTITLE\n*END', e = editor(source);
        const missing = model(e,0,{});
        assert.deepEqual(view(missing).layoutDiagnostics, []);
        assert.equal(fields(missing).find(field => field.name === 'TITLE').value, 'TITLE');
        const untitled = model(editor('*MAT_DAMAGE_1\n*END'),0,{});
        assert.deepEqual(missing.managerCards.slice(1).map(card => card.fields.map(field => field.name)),
            untitled.managerCards.map(card => card.fields.map(field => field.name)));
        const staged = change(e, { RO: '7.85' });
        assert.equal(view(staged).canApply, true, staged.plan.reason);
        assert.equal(e.document.getText(), source, 'A template preview must not change the document');
        const edit = await apply(staged, e);
        assert.ok(edit.text.startsWith('*MAT_DAMAGE_1_TITLE\nTITLE\n'));
        const reopened = model(editor(edit.text + '*END'),0,{});
        assert.equal(fields(reopened).find(field => field.name === 'TITLE').value, 'TITLE');
        assert.equal(fields(reopened).find(field => field.name === 'RO').value, '7.85');
        assert.notEqual(reopened.plan.status, 'blocked', reopened.plan.reason);
    });
    for (const format of ['long', 'i10', 'comma']) {
        it(`preserves unfinished values and coordinates in ${format} records`, () => {
            const base = model(editor(text('*MAT_DAMAGE_1')),0,{});
            const records = base.managerCards.map(card => format === 'comma'
                ? card.fields.map(f => f.value).join(',')
                : card.fields.map(f => f.value.padStart(format === 'long' ? 20 : f.width)).join(''));
            const lines = [...(format === 'i10' ? ['*KEYWORD I10=Y'] : []),
                '*MAT_DAMAGE_1' + (format === 'long' ? '+' : ''), ...records, '', '*END'];
            const e = editor(lines.join('\n')), line = format === 'i10' ? 1 : 0;
            const m = model(e,line,{}), ro = fields(m).find(f => f.name === 'RO');
            assert.ok(ro.editable, m.plan.reason);
            const staged = model(e,line,{fieldDrafts:{[ro.fieldId]:'7.85'}});
            assert.equal(view(staged).canApply,true, staged.plan.reason);
            assert.equal(fields(staged).find(f => f.name === 'E').value,'E');
            assert.ok(staged.plan.replacementRecords[0].text.includes('7.85'));
            assert.deepEqual(staged.plan.replacementRecords.slice(1).map(r => r.text), records.slice(1));
        });
    }
    it('rejects a stale document at application time', async () => {
        const e = editor(text()), m = change(e,{RO:'7.85'});
        e.document.version++;
        assert.equal(await apply(m,e),undefined);
    });
});
