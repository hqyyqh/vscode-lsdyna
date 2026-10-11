'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { fakeDoc } = require("../../support/helpers");
const { buildKeywordOptionViewModel: model, buildKeywordOptionsViewState: view, applyKeywordOptionViewModel: apply,
    keywordManagerHelpState, keywordManagerEditField } = require("../../../out/extension")._internals;
const { getCatalogInputFormCatalogV4 } = require("../../../out/core/semantics/catalogInputFormCatalogV4");
const fixtures = path.join(__dirname, "../../fixtures/public-behavior/native-inputs");
const cases = require("../../fixtures/public-behavior/dynamic-file-layout-cases.json");
function editor(text, line = 0) {
    const lines = text.split(/\r?\n/);
    return { document: { languageId: 'lsdyna', version: 1, eol: 1, lineCount: lines.length,
        uri: vscode.Uri.file('D:/temp/native-file-layout.k'), getText: () => text,
        lineAt: i => ({ text: lines[i] }) }, selection: { active: new vscode.Position(line, 0) } };
}
function cards(keyword) {
    const f = getCatalogInputFormCatalogV4().formForKeyword(keyword);
    return f.rules[f.reference.formRuleIds[0]].cards;
}
function source(keyword, indexes, values = {}, title = false) {
    const schemaCards = cards(keyword);
    return ['*' + keyword + (title ? '_TITLE' : ''), ...(title ? ['keep this title'] : []),
        ...indexes.map(i => schemaCards[i - 1].fields.map(f => Number(f.type) === 0 ?
            String(values[f.name] ?? '').padEnd(f.width) : String(values[f.name] ?? '').padStart(f.width)).join('')), '*END'].join('\n');
}
function changed(text, name, value, line = 0) {
    const e = editor(text, line), base = model(e, line, {});
    const field = base.managerCards.flatMap(c => c.fields).find(f => f.name === name);
    assert.ok(field, name);
    return model(e, line, { fieldDrafts: { [field.fieldId]: value } });
}
function reopen(m) {
    const text = [m.targetKeyword, ...m.plan.replacementRecords.flatMap(r => [...(r.comments || []), r.text]), '*END'].join('\n');
    const next = model(editor(text), 0, {});
    assert.notEqual(next.plan.status, 'blocked', next.plan.reason);
    return { text, next };
}

describe('native file-reader dynamic layouts', () => {
    it('reads the AIRBAG file cards while retaining the original source pool and refusing unverified writes', async () => {
        const text = '*AIRBAG_FLUID_AND_GAS\n1,2,3,4,5,6,7,8\n9,10,11,12,13,14,15\n*END';
        const e = editor(text), m = model(e, 0, {});
        assert.equal(m.inputFormResolution.status, 'resolved');
        assert.deepEqual(m.managerCards.map(card => card.fields[0].name), ['XWINI', 'GDIR']);
        assert.deepEqual(m.managerCards.map(card => card.fields[0].value), ['1', '9']);
        assert.equal(m.helpContext.nativeForm.cards.length, 3);
        assert.equal(m.helpContext.nativeForm.cardSetId, "record:40a8cc6df9c65f8a9f28a264:2a5c4d96e1cf1d9a46301da1");
        assert.equal(m.plan.status, 'blocked');
        assert.equal(m.plan.reason, 'native-file-write-unverified');
        assert.deepEqual(m.plan.replacementRecords, []);
        assert.ok(m.managerCards.every(card => card.fields.every(field => !field.editable)));
        const first = m.managerCards[0].fields[0];
        const help = keywordManagerHelpState({ ...m, selectedFieldId: first.fieldId });
        assert.equal(help.schemaName, 'XWINI');
        const form = getCatalogInputFormCatalogV4().formForKeyword('AIRBAG_FLUID_AND_GAS');
        const rule = form.rules[form.reference.formRuleIds[0]];
        assert.equal(help.english, rule.cards[1].fields[0].help.trim());
        assert.equal(keywordManagerEditField(m, first.fieldId, '42'), null);
        assert.equal(view(m).mode, 'fields');
        assert.equal(view(m).canApply, false);
        const original = vscode.workspace.applyEdit;
        let writes = 0;
        vscode.workspace.applyEdit = async () => { writes++; return true; };
        try {
            for (const proposed of [m, { ...m, plan: { ...m.plan, status: 'ready', reason: 'forged-ready' } }]) {
                assert.equal(await apply({ getModel: () => proposed, markStale() {} }, e), null);
            }
            assert.equal(writes, 0);
        } finally { vscode.workspace.applyEdit = original; }
        assert.equal(e.document.getText(), text);
    });
    it('keeps omitted GUI cards out of each projected reader and isolates repeated source instances', () => {
        for (const [keyword, indexes, names] of [
            ['DEFINE_DEATH_TIMES_RIGID', [1, 2], ['GEO', 'X_T']],
            ['USER_NONLOCAL_SEARCH', [1, 2], ['SSID', 'NFREQ']],
            ['LOAD_NODE_SET', [1], ['NSID']],
            ['ELEMENT_SOLID_T20', [1, 2, 3], ['EID', 'N1', 'N11']],
        ]) {
            const text = source(keyword, indexes), e = editor(text), m = model(e, 0, {});
            assert.equal(m.inputFormResolution.status, 'resolved', keyword);
            assert.deepEqual(m.managerCards.map(card => card.fields[0].name), names, keyword);
            assert.equal(view(m).canApply, false, keyword);
            assert.deepEqual(m.plan.replacementRecords, [], keyword);
            assert.equal(e.document.getText(), text);
        }
        const text = '*AIRBAG_FLUID_AND_GAS\n1,2,3,4,5,6,7,8\n9,10,11,12,13,14,15\n21,22,23,24,25,26,27,28\n29,30,31,32,33,34,35\n*END';
        const m = model(editor(text, 3), 3, {});
        const instances = m.managerInstances.filter(instance => instance.keyword === '*AIRBAG_FLUID_AND_GAS');
        assert.equal(instances.length, 2);
        assert.equal(instances.filter(instance => instance.selected).length, 1);
        assert.deepEqual(m.managerCards.map(card => card.fields[0].value), ['21', '29']);
        assert.equal(view(m).canApply, false);
    });
    it('rejects empty, incomplete, extra and unapproved projected sources without writing', async () => {
        const text = '*AIRBAG_FLUID_AND_GAS\n1,2,3,4,5,6,7,8\n9,10,11,12,13,14,15\n*END';
        const catalog = getCatalogInputFormCatalogV4(), originalForm = catalog.formForKeyword;
        const originalApply = vscode.workspace.applyEdit;
        let writes = 0;
        vscode.workspace.applyEdit = async () => { writes++; return true; };
        try {
            for (const [input, status] of [['*AIRBAG_FLUID_AND_GAS\n*END', 'no-change'],
                ['*AIRBAG_FLUID_AND_GAS\n1,2,3,4,5,6,7,8\n*END', 'blocked'],
                [text.replace('*END', '21,22,23,24,25,26,27,28\n*END'), 'blocked'],
                [text.replace('*AIRBAG_FLUID_AND_GAS', '*AIRBAG_FLUID_AND_GAS_UNVERIFIED'), 'blocked']]) {
                const e = editor(input), m = model(e, 0, {});
                assert.equal(m.plan.status, status);
                assert.deepEqual(m.plan.replacementRecords, []);
                assert.equal(view(m).canApply, false);
                assert.ok(m.managerCards.every(card => card.fields.every(field => !field.editable)));
                if (status === 'no-change') {
                    assert.deepEqual(m.managerCards, []);
                    assert.equal(view(m).mode, 'none');
                }
                assert.equal(await apply({ getModel: () => m, markStale() {} }, e), null);
                assert.equal(e.document.getText(), input);
            }
            for (const defect of ['source', 'address', 'captured-card-count']) {
                catalog.formForKeyword = function(keyword) {
                    const form = originalForm.call(this, keyword);
                    if (keyword.replace(/^\*/, '') !== 'AIRBAG_FLUID_AND_GAS' || !form) return form;
                    if (defect === 'source') form.source.datasetSha256 = '0'.repeat(64);
                    else for (const id of form.reference.formRuleIds) {
                        if (defect === 'address') form.rules[id].cardSetId = '0x0';
                        else form.rules[id].cards = form.rules[id].cards.slice(1);
                    }
                    return form;
                };
                const e = editor(text), m = model(e, 0, {});
                assert.equal(m.plan.status, 'blocked', defect);
                assert.equal(m.plan.reason, 'lspp-input-form-source-layout-unresolved', defect);
                assert.deepEqual(m.plan.replacementRecords, [], defect);
                assert.equal(view(m).canApply, false, defect);
                assert.equal(await apply({ getModel: () => m, markStale() {} }, e), null, defect);
                assert.equal(e.document.getText(), text);
            }
            assert.equal(writes, 0);
        } finally { catalog.formForKeyword = originalForm; vscode.workspace.applyEdit = originalApply; }
    });
    it('edits one rubber tail occurrence without changing the others', function () {
        this.timeout(10000);
        for (const [keyword, tail, prefix] of [['MAT_077_O', 6, [1, 4, 5]], ['MAT_077_H', 5, [1, 4]]]) {
            const text = source(keyword, [...prefix, tail, tail, tail], { MID: 77, PR: 0.3, N: 0, GI: 1, BETAI: 2 });
            const e = editor(text), initial = model(e, 0, {});
            const fields = initial.managerCards.filter(c => c.cardIndex === tail).map(c => c.fields.find(f => f.name === 'GI'));
            assert.equal(fields.length, 3);
            assert.equal(new Set(fields.map(f => f.fieldId)).size, 3);
            const edited = model(e, 0, { fieldDrafts: { [fields[1].fieldId]: '9' } });
            assert.equal(view(edited).canApply, true, edited.plan.reason);
            const values = edited.plan.replacementRecords.slice(prefix.length).map(r => Number(r.text.slice(0, 10)));
            assert.deepEqual(values, [1, 9, 1]);
            assert.equal(reopen(edited).next.managerCards.filter(c => c.cardIndex === tail).length, 3);
        }
    });
    it('preserves omitted optional groups on open, ordinary edits and save/reopen', function () {
        this.timeout(10000); // Six cold-catalog open/edit/reopen scenarios; not a performance benchmark.
        for (const count of [8, 11, 14]) for (const title of [false, true]) {
            const indexes = Array.from({ length: count }, (_, i) => i + 1);
            const text = source('MAT_119', indexes, { MID: 119, IFLAG: 2, IUNLD: 0, RO: 1 }, title);
            const initial = model(editor(text), 0, {});
            assert.equal(initial.plan.status, 'no-change', initial.plan.reason);
            assert.deepEqual(initial.managerCards.filter(c => c.cardIndex).map(c => c.cardIndex), indexes);
            assert.equal(initial.plan.replacementRecords.length, count + Number(title));
            const edited = changed(text, 'RO', '2');
            assert.equal(edited.plan.replacementRecords.length, count + Number(title));
            assert.deepEqual(reopen(edited).next.managerCards.filter(c => c.cardIndex).map(c => c.cardIndex), indexes);
        }
    });
    it('changes SOLID NIP and LMC using source instances without consuming the adjacent entity', () => {
        const text = '*SECTION_SOLID\n901,101\n3,0,0,0,9\n1,2,3,4\n5,6,7,8\n9,10,11,12\n1,1,1,1,1,1,1,1\n1,0,0,0,0,0,0,0\n902,1\n*END';
        for (const [name, value, count] of [['NIP', '1', 6], ['LMC', '8', 7]]) {
            const m = changed(text, name, value);
            assert.equal(view(m).canApply, true, m.plan.reason);
            assert.equal(m.plan.replacementRecords.length, count);
            assert.equal(m.plan.replacementRecords.at(-1).text, '902,1');
            assert.equal(reopen(m).next.managerInstances.filter(i => i.keyword === '*SECTION_SOLID').length, 2);
        }
        const invalid = changed('*SECTION_SOLID\n901,1\n902,1\n*END', 'ELFORM', '101');
        assert.equal(view(invalid).canApply, false, 'a new controller cannot borrow fields from entity 902');
    });
    it('shares TSHELL instance boundaries when NIP changes and retains the next entity', () => {
        const text = '*SECTION_TSHELL\n701,1,1,9,1,0,1\n1,1,1,1,1,1,1,1\n1,0,0,0,0,0,0,0\n702,1,1,2,1,0,0\n*END';
        const m = changed(text, 'NIP', '8');
        assert.equal(view(m).canApply, true, m.plan.reason);
        assert.equal(m.plan.replacementRecords.length, 3);
        assert.equal(m.plan.replacementRecords[2].text, '702,1,1,2,1,0,0');
        const { next } = reopen(m);
        assert.equal(next.managerInstances.filter(i => i.keyword === '*SECTION_TSHELL').length, 2);
    });
    it('retains IGA and POINT_SOURCE source tails without treating them as extra entities', () => {
        const iga = source('SECTION_IGA_SHELL', [1, 2, 3, 3], { SECID: 702, NIP: 9, ICOMP: 0 });
        const m = changed(iga, 'ICOMP', '1');
        assert.equal(view(m).canApply, true, m.plan.reason);
        assert.equal(m.plan.replacementRecords.length, 4);
        assert.deepEqual(reopen(m).next.managerCards.map(c => c.cardIndex), [1, 2, 3, 3]);
        for (const keyword of ['SECTION_POINT_SOURCE', 'SECTION_POINT_SOURCE_MIXTURE']) {
            const indexes = keyword.endsWith('MIXTURE') ? [1, 2, 3, 3, 3] : [1, 2, 2, 2];
            const text = source(keyword, indexes, { SECID: 703, NODEID: 804 });
            const m = model(editor(text), 0, {});
            assert.notEqual(m.plan.status, 'blocked', m.plan.reason);
            assert.deepEqual(m.managerCards.map(c => c.cardIndex), indexes);
        }
    });
    it('retains all 39 edited values in the independent native save with no extra entity', () => {
        const evidence = require("../../fixtures/public-behavior/dynamic-file-layout-bindings.json");
        for (const [file, expected] of Object.entries(evidence.fixtures)) {
            assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(fixtures, file))).digest('hex'), expected);
        }
        const expected = require("../../fixtures/public-behavior/dynamic-file-layout-edited-cases.json");
        const text = fs.readFileSync(path.join(fixtures, 'dynamic-file-layout-edited-saved.k'), 'utf8');
        const lines = text.split(/\r?\n/), entities = [];
        let entity;
        // Read the native export's own headers and cells independently of the
        // manager's layout selector; a self-consistent manager bug cannot pass.
        for (let i = 0; i < lines.length; i++) {
            if (!/^\$#/.test(lines[i])) continue;
            const names = lines[i].slice(2).trim().toUpperCase().split(/\s+/);
            const values = lines[i + 1].split(',');
            if (['MID','SECID'].includes(names[0])) { entity = { id: Number(values[0]), values: {} }; entities.push(entity); }
            if (entity) names.forEach((name, j) => { entity.values[name] = values[j] || ''; });
            if (names[0] === 'YS') assert.ok(values.every(value => Number(value) === 0));
        }
        assert.equal(entities.length, expected.length);
        for (const c of expected) {
            const native = entities.find(e => e.id === c.id);
            assert.ok(native, `native entity ${c.id}`);
            assert.equal(Number(native.values[c.field]), c.value, `${c.k} ${c.id} ${c.field}`);
            if (c.k === 'MAT_213') assert.equal(Number(native.values.VEVP), 1);
        }
        assert.equal(entities.some(e => e.id === 901), false);
        assert.equal(text.includes('Unrecognized'), false);
    });
    it('binds five aliases to their native callbacks and excludes eight thermal candidates', () => {
        const evidence = require("../../fixtures/public-behavior/dynamic-file-layout-bindings.json");
        for (const [keyword, id] of Object.entries(evidence.aliasBindings)) {
            const f = getCatalogInputFormCatalogV4().formForKeyword(keyword);
            assert.ok(f.reference.fieldRuleIds.includes(id));
            const r = f.rules[id];
            if (keyword === 'MAT_265' || keyword === 'MAT_265_TITLE') {
                // Pinned registration and material-instances archive: two cards
                // per entity. The GUI pool's four-card state is not file order.
                const m = model(editor(source('MAT_265', [1, 2], {}, keyword.endsWith('_TITLE'))), 0, {});
                assert.notEqual(m.plan.status, 'blocked', `${keyword}: ${m.plan.reason}`);
                assert.deepEqual(m.managerCards.filter(c => c.cardIndex).map(c => c.cardIndex), [1, 2]);
                continue;
            }
            if (keyword === 'CONTROL_IMPLICIT_EIGENVALUES') {
                // Independent native dispatch and boundary archive: EIGMTH=2
                // consumes descriptors 1,2,3,8, not the GUI's first state.
                const m = model(editor(source(keyword, [1, 2, 3, 8], { EIGMTH: 2 })), 0, {});
                assert.notEqual(m.plan.status, 'blocked', `${keyword}: ${m.plan.reason}`);
                assert.deepEqual(m.managerCards.map(card => card.cardIndex), [1, 2, 3, 8]);
                continue;
            }
            const text = ['*' + keyword, ...(/_TITLE$/.test(keyword) ? ['alias title'] : []),
                ...r.states[0].cardIndexes.flatMap(i => {
                    const fields = r.cards.find(c => c.cardIndex === i).fields;
                    return [require("../../../out/extension")._internals.generateCommentLine(fields.map(f => ({ n: f.name, p: f.position, w: f.width, t: f.type }))), fields.map(field => {
                    const control = r.controllerFields.find(c => c.cardIndex === i && c.name === field.name);
                    return String(control?.optionValues[0] ?? '').padStart(field.width);
                }).join('')]; }), '*END'].join('\n');
            const m = model(editor(text), 0, {});
            assert.notEqual(m.plan.status, 'blocked', `${keyword}: ${m.plan.reason}`);
            assert.deepEqual(m.managerCards.filter(c => c.cardIndex).map(c => c.cardIndex), r.states[0].cardIndexes);
        }
        for (const keyword of evidence.excludedCandidates) {
            assert.equal(getCatalogInputFormCatalogV4().formForKeyword(keyword).reference.fieldRuleIds, undefined);
        }
    });
    it('keeps a changed source binding from falling back to the static descriptor pool', () => {
        const { nativeFileLayoutKind, selectNativeFileLayout } = require("../../../out/core/semantics/catalogNativeFileLayout");
        const kind = nativeFileLayoutKind({ cardSetId: "record:ddd1735d5be2589e912a6edc:d3e1ed7489caab75dfd9d057", catalogSource: { datasetSha256: '0'.repeat(64) } }, '*SECTION_BEAM');
        assert.equal(kind, 'unsupported-source');
        assert.equal(selectNativeFileLayout(kind, ['101,1',''], false, () => ''), null);
    });
    it('consumes all 61 independently headless-verified source cases without adding cards', () => {
        for (const c of cases) {
            const text = source(c.keyword, c.cards, { MID: c.id, SECID: c.id, ...c.values });
            const m = model(editor(text), 0, {});
            assert.notEqual(m.plan.status, 'blocked', `${c.keyword} ${c.id}: ${m.plan.reason}`);
            assert.deepEqual(m.managerCards.map(c => c.cardIndex), c.cards, `${c.keyword} ${c.id}`);
            assert.equal(m.plan.replacementRecords.length, c.cards.length);
        }
    });
    it('opens every native saved block and preserves its source record count', () => {
        const text = fs.readFileSync(path.join(fixtures, 'dynamic-file-layout-saved.k'), 'utf8');
        const lines = text.split(/\r?\n/), e = editor(text);
        for (let line = 0; line < lines.length; line++) {
            if (!/^\*(SECTION_BEAM|SECTION_SHELL|MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE)$/.test(lines[line])) continue;
            const m = model(e, line, {});
            assert.notEqual(m.plan.status, 'blocked', `${line}: ${m.plan.reason}`);
            assert.equal(m.plan.replacementRecords.length, m.block.records.length);
        }
    });
    it('round trips every FTYPE transition, retaining the controller and VEVP', () => {
        for (let from = 0; from <= 4; from++) for (let to = 0; to <= 4; to++) for (const title of [false, true]) {
            const b = from ? 10 + from * 2 : 8;
            const text = source('MAT_213', [1,2,3,4,5,6,7,b,b+1,10,11], { MID: 213, FTYPE: from, VEVP: 1 }, title);
            const m = changed(text, 'FTYPE', String(to));
            assert.notEqual(m.plan.status, 'blocked', `${from}->${to}: ${m.plan.reason}`);
            assert.equal(m.plan.replacementRecords.length, 11 + Number(title));
            const { next } = reopen(m);
            const values = next.managerCards.flatMap(c => c.fields);
            assert.equal(values.find(f => f.name === 'FTYPE').value, String(to));
            assert.equal(values.find(f => f.name === 'VEVP').value, '1');
        }
    });
    it('writes MAT_213 LONG FTYPE inside the native ten-byte prefix', () => {
        const { blankRecord, writeRecordField } = require("../../../out/core/edit/keywordRecordSerializer");
        const rows = [1,2,3,4,5,6,7,12,13,10,11].map(i => {
            const fields = cards('MAT_213')[i - 1].fields.map(f => ({ ...f,
                ...(f.name === 'FTYPE' ? { nativeReadWidth: 10 } : {}) }));
            let text = blankRecord(fields, 'long');
            for (let j = 0; j < fields.length; j++) if (['MID','FTYPE','VEVP'].includes(fields[j].name))
                text = writeRecordField(text, fields, j, fields[j].name === 'MID' ? '213' : '1', 'long');
            return text;
        });
        const text = ['*MAT_213 +', ...rows, '*END'].join('\n');
        const m = changed(text, 'FTYPE', '2');
        assert.equal(view(m).canApply, true, m.plan.reason);
        assert.equal(m.plan.replacementRecords[7].text.slice(0,10).trim(), '2');
        assert.equal(m.plan.replacementRecords[7].text.slice(10,20).trim(), '');
        const nextText = ['*MAT_213 +', ...m.plan.replacementRecords.map(r => r.text), '*END'].join('\n');
        const next = model(editor(nextText), 0, {});
        assert.equal(next.managerCards.flatMap(c => c.fields).find(f => f.name === 'FTYPE').value, '2');
        rows[7] = '1'.padStart(20) + rows[7].slice(20);
        const bad = ['*MAT_213 +', ...rows, '*END'].join('\n');
        assert.equal(model(editor(bad), 0, {}).plan.status, 'blocked');
    });
    it('does not expose or serialize the inactive BEAM A field', () => {
        const text = source('SECTION_BEAM', [1,2], { SECID: 101, ELFORM: 1 });
        const e = editor(text), base = model(e, 0, {});
        assert.equal(base.managerCards.flatMap(c => c.fields).some(f => f.name === 'A'), false);
        const m = model(e, 0, { fieldDrafts: { 'lspp-input:SECTION_BEAM:card:3:field:0': '901' } });
        assert.equal(view(m).canApply, false);
        const edit = changed(text, 'SHRF', '2');
        assert.equal(view(edit).canApply, true);
        assert.equal(edit.plan.replacementRecords.length, 2);
        assert.equal(reopen(edit).next.managerInstances.filter(i => i.keyword === '*SECTION_BEAM').length, 1);
    });
    it('changes one variable-length BEAM instance and preserves the following entity', () => {
        const text = '*SECTION_BEAM\n101,1\n1,2,3,4\n102,2\nSECTION_01,1,1\n*END';
        const m = changed(text, 'ELFORM', '12');
        assert.equal(view(m).canApply, true, m.plan.reason);
        assert.deepEqual(m.managerCards.map(c => c.cardIndex), [1,10,11]);
        assert.equal(m.plan.replacementRecords.length, 5);
        const { next } = reopen(m);
        assert.equal(next.managerInstances.filter(i => i.keyword === '*SECTION_BEAM').length, 2);
        assert.equal(m.plan.replacementRecords[3].text, '102,2');
        assert.equal(m.plan.replacementRecords[4].text, 'SECTION_01,1,1');
    });
    it('adds TITLE per BEAM instance while retaining the evaluated dynamic layout', () => {
        const text = '*SECTION_BEAM\n101,1\n1,2,3,4\n102,2\nSECTION_01,1,1\n*END';
        const e = editor(text), base = model(e, 0, {});
        const control = base.controls.find(c => c.choices.some(v => v.value === 'TITLE'));
        assert.ok(control);
        const titled = model(e, 0, { draftControlState: { [control.controlId]: 'TITLE' } });
        assert.equal(titled.targetKeyword, '*SECTION_BEAM_TITLE');
        assert.equal(titled.plan.replacementRecords.length, 6);
        assert.deepEqual(titled.targetLayout.records.map(r => r.lsppCardIndex), [0,1,2,0,1,12]);
        assert.notEqual(reopen(titled).next.plan.status, 'blocked');
    });
    it('keeps source record identities isolated from a TITLE spelling draft', () => {
        const fixture = { text: fs.readFileSync(path.join(__dirname,
            "../../fixtures/public-behavior/title-record-identity-input.k"), 'utf8') };
        const line = fixture.text.split(/\r?\n/).findIndex(text => text === '*MAT_166');
        const document = fakeDoc(fixture.text, 'D:/temp/native-file-layout.k');
        Object.assign(document, { languageId: 'lsdyna', version: 1, eol: 1, isDirty: false, isUntitled: false,
            uri: vscode.Uri.file('D:/temp/native-file-layout.k') });
        const e = { document, selection: { active: new vscode.Position(line, 0) } };
        const base = model(e, line, { provisional: true });
        const control = base.controls.find(c => c.choices.some(v => v.value === 'TITLE'));
        const current = base.currentLayout.records.map(r => [r.recordMigrationId, r.lsppCardIndex]);
        const drafted = model(e, line, { provisional: true,
            draftControlState: { [control.controlId]: 'TITLE' } });
        assert.deepEqual(drafted.currentLayout.records.map(r => [r.recordMigrationId, r.lsppCardIndex]), current);
        assert.equal(drafted.plan.status, 'blocked');
        assert.equal(view(drafted).canApply, false);
        assert.equal(e.document.getText(), fixture.text);
    });
    it('keeps SHELL repeated Bi rows distinct and handles ICOMP/NIP changes', () => {
        const text = source('SECTION_SHELL', [1,2,5,5], { SECID: 301, ELFORM: 2, NIP: 9, ICOMP: 1 });
        const m = changed(text, 'NIP', '8');
        assert.equal(view(m).canApply, true, m.plan.reason);
        assert.deepEqual(m.managerCards.map(c => c.cardIndex), [1,2,5]);
        assert.deepEqual(reopen(m).next.managerCards.map(c => c.cardIndex), [1,2,5]);
        const off = changed(text, 'ICOMP', '0');
        assert.deepEqual(reopen(off).next.managerCards.map(c => c.cardIndex), [1,2]);
    });
    it('applies an active edit through the real consumer with only two BEAM records', async () => {
        const text = source('SECTION_BEAM', [1,2], { SECID: 101, ELFORM: 1 });
        const m = changed(text, 'SHRF', '2'), e = { ...editor(text), document: m.sourceDocument };
        const original = vscode.workspace.applyEdit, active = vscode.window.activeTextEditor;
        let edit;
        vscode.workspace.applyEdit = async value => { edit = value; return true; };
        vscode.window.activeTextEditor = e;
        try {
            assert.ok(await apply({ getModel: () => m, markStale() {} }, e));
            assert.ok(edit);
            assert.equal(edit.edits[0].text.split(/\r?\n/).filter(l => l && !/^[\$*]/.test(l)).length, 2);
        } finally { vscode.workspace.applyEdit = original; vscode.window.activeTextEditor = active; }
    });
});
