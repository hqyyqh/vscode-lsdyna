'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const vscode = require('vscode');
const api = require('../../../out/extension')._internals;
const native = require("../../../out/core/semantics/catalogNativeFileLayout");
const { documentFor, editorFor } = require('../../support/keyword-manager/conditional-fixtures.cjs')({ vscode, generateCommentLine: api.generateCommentLine });

function model(lines, line = 0) {
    const editor = editorFor(documentFor(lines));
    return { editor, initial: api.buildKeywordOptionViewModel(editor, line, {}) };
}

async function applyStaged(lines, editor, staged, label, confirmLoss = true) {
    const oldApply = vscode.workspace.applyEdit, oldEditor = vscode.window.activeTextEditor, oldWarning = vscode.window.showWarningMessage;
    let edits, warnings = 0;
    vscode.window.activeTextEditor = editor;
    vscode.workspace.applyEdit = async edit => { edits = edit.edits; return true; };
    vscode.window.showWarningMessage = async (...args) => { warnings++; return confirmLoss ? args[2] : undefined; };
    try { await api.applyKeywordOptionViewModel({ getModel: () => staged, markStale() {} }, editor); }
    finally { vscode.workspace.applyEdit = oldApply; vscode.window.activeTextEditor = oldEditor; vscode.window.showWarningMessage = oldWarning; }
    if (!confirmLoss) { assert.equal(edits, undefined); return { next: lines, warnings }; }
    assert.equal(edits?.length, 1, label + ': no single atomic edit');
    const edit = edits[0];
    assert.equal(edit.range.start.character, 0);
    assert.equal(edit.range.end.character, 0);
    const replacement = edit.text.split('\n');
    if (replacement.at(-1) === '') replacement.pop();
    const next = [...lines.slice(0, edit.range.start.line), ...replacement, ...lines.slice(edit.range.end.line)];
    return { next, warnings };
}

async function editAndReopen(lines, line, fieldIndex, value, label, linkedNames = []) {
    const { editor, initial } = model(lines, line);
    const fields = initial.managerCards.flatMap(card => card.fields);
    const field = fields[fieldIndex];
    const drafts = api.keywordManagerEditField(initial, field.fieldId, value);
    assert.ok(drafts, label + ': rejected draft');
    const staged = api.buildKeywordOptionViewModel(editor, line, drafts);
    assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true, label + ': ' + staged.plan.reason);
    const { next } = await applyStaged(lines,editor,staged,label);
    assert.equal(next.length, lines.length, label + ': record count changed');
    next.forEach((text, index) => {
        if (index !== field.line) assert.equal(text, lines[index], label + ': unrelated line ' + index);
    });
    const reopened = model(next, line).initial.managerCards.flatMap(card => card.fields);
    assert.deepEqual(reopened.map(f => f.value), fields.map((f, index) => index === fieldIndex ||
        f.line === field.line && linkedNames.includes(f.name) ? value : f.value), label + ': reopened fields');
    const keywordLine = next.findIndex(text => text.startsWith('*'));
    const body = [];
    for (let i = keywordLine + 1; i < next.length && !next[i].startsWith('*'); i++)
        if (!next[i].trimStart().startsWith('$')) body.push({ line: i, text: next[i] });
    const reading = require('../../../out/core/semantics/nativeFileReadContext').nativeKeywordReadContext(
        next[keywordLine], body.map(row => row.text), 'standard');
    const rowIndex = body.findIndex(row => row.line === field.line), record = reading?.select(false)?.current[rowIndex];
    if (record?.cardIndex > 0) {
        const nativeIndex = initial.managerCards.find(card => card.fields.some(f => f.fieldId === field.fieldId))
            .fields.findIndex(f => f.fieldId === field.fieldId);
        assert.equal(reading.read(body[rowIndex].text, record.cardIndex, nativeIndex), value, label + ': native reader');
    }
    assert.equal(editor.document.getText(), lines.join('\n'), label + ': preview mutated source');
}

describe('native suffix fixed-field writing', function () {
    this.timeout(300000);
    it('keeps extra EM control records read-only instead of treating a readable first row as repeat authority', () => {
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-suffix-write-inputs.json.gz'))));
        const cases = fixture.cases.filter(task => task.keyword === 'EM_CONTROL_TITLE');
        assert.equal(cases.length, 8);
        for (const task of cases) {
            const {initial} = model([...task.lines, '*END']);
            assert.equal(api.buildKeywordOptionsViewState(initial).canApply, false, task.id);
            assert.ok(initial.managerCards.flatMap(card => card.fields).every(field => !field.editable), task.id);
        }
    });
    it('recognizes, edits, applies and rereads every verified suffix in all four formats', async () => {
        const { keywordDataPath } = require('../../../out/core/keywordDataPath');
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-suffix-write-matrix.json.gz'))));
        const expectedNames = new Set(fixture.readers.flatMap(({ file }) =>
            Object.keys(require(keywordDataPath('native-readers/' + file)).bindings)));
        for (const base of ['INTERFACE_COMPONENT_NODE', 'INTERFACE_COMPONENT_SEGMENT', 'INTERFACE_COMPONENT_SPH'])
            for (const suffix of ['ID', 'TITLE']) expectedNames.add(base + '_' + suffix);
        assert.equal(fixture.sourceSha256, native.NATIVE_FILE_SOURCE);
        assert.deepEqual(fixture.cases.map(task => task.id).sort(), [...expectedNames]
            .flatMap(name => ['standard', 'long', 'i10', 'comma'].map(format => name + '/' + format)).sort());
        let edits = 0;
        for (const task of fixture.cases) {
            assert.equal(require('../../../out/core/keywordSuggest').isKnownKeywordName(task.keyword), true, task.id);
            const lines = [...task.lines, '$ retained after records', '*TITLE', 'other block', '*END'];
            const { editor, initial } = model(lines), fields = initial.managerCards.flatMap(c => c.fields);
            const editable = fields.filter(f => f.editable && f.name !== 'UNUSED');
            const free = editable.filter(f => !f.choices?.length), candidates = free.length ? free : editable;
            assert.ok(candidates.length, task.id + ': ' + initial.plan.reason);
            for (const field of new Set([candidates[0], candidates.at(-1)])) {
                const value = field.choices?.find(value => value !== field.value) ??
                    (['', '0', 'string'].includes(field.type) ? 'edit'.slice(0, Math.max(1, field.width)) : field.value === '1' ? '2' : '1');
                const drafts = api.keywordManagerEditField(initial, field.fieldId, value);
                assert.ok(drafts, task.id + '/' + field.name + ': rejected draft');
                const staged = api.buildKeywordOptionViewModel(editor, 0, drafts);
                assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true, task.id + '/' + field.name + ': ' + staged.plan.reason);
                const { next } = await applyStaged(lines, editor, staged, task.id);
                const reopened = model(next).initial.managerCards.flatMap(c => c.fields);
                assert.equal(reopened.find(f => f.fieldId === field.fieldId)?.value, value, task.id + '/' + field.name);
                assert.deepEqual(reopened.filter(f => f.fieldId !== field.fieldId && !(f.line === field.line && field.linkedFields?.includes(f.name)))
                    .map(f => [f.fieldId, f.value]), fields.filter(f => f.fieldId !== field.fieldId && !(f.line === field.line && field.linkedFields?.includes(f.name)))
                    .map(f => [f.fieldId, f.value]), task.id + ': unrelated fields changed');
                next.forEach((text, i) => { if (i !== field.line) assert.equal(text, lines[i], task.id + ': unrelated source line'); });
                assert.equal(next.length, lines.length, task.id + ': record count');
                assert.equal(editor.document.getText(), lines.join('\n'), task.id + ': preview changed source');
                edits++;
            }
        }
        console.log(`    ${expectedNames.size} names; ${fixture.cases.length} format cases; ${edits} edit/apply/reread checks`);
    });

    it('cross-checks the remaining native reader suffixes and preserves their write restrictions', async () => {
        const {keywordDataPath} = require('../../../out/core/keywordDataPath');
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-suffix-reader-crosscheck.json.gz'))));
        const main = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-suffix-write-matrix.json.gz'))));
        const mainNames = new Set(main.cases.map(task => task.keyword));
        const names = new Set(fixture.readers.flatMap(file => {
            const source = require(keywordDataPath('native-readers/' + file));
            assert.equal(source.sourceSha256, fixture.sourceSha256, file);
            return Object.keys(source.bindings).filter(name => /_(ID|TITLE|MPP)$/.test(name) && !mainNames.has(name));
        }).concat(fixture.savedAliases));
        assert.deepEqual(fixture.cases.map(task => task.id).sort(), [...names]
            .flatMap(name => ['standard', 'long', 'i10', 'comma'].map(format => name + '/' + format)).sort());
        let edits = 0, readonly = 0;
        for (const task of fixture.cases) {
            assert.equal(require('../../../out/core/keywordSuggest').isKnownKeywordName(task.keyword), true, task.id);
            const lines = [...task.lines, '$ retained after records', '*TITLE', 'other block', '*END'];
            const {initial} = model(lines), fields = initial.managerCards.flatMap(card => card.fields);
            assert.ok(fields.length, task.id + ': no fields');
            if (task.readonlyReason) {
                assert.equal(initial.plan.reason, task.readonlyReason, task.id);
                assert.equal(api.buildKeywordOptionsViewState(initial).canApply, false, task.id);
                assert.ok(fields.every(field => !field.editable), task.id);
                assert.equal(api.keywordManagerEditField(initial, fields[0].fieldId, '2'), null, task.id);
                readonly++;
                continue;
            }
            const editable = fields.filter(field => field.editable && field.name !== 'UNUSED');
            const first = editable.find(field => !field.choices?.length) || editable[0];
            const bodyFields = initial.managerCards.filter(card => card.cardIndex > 0).flatMap(card => card.fields)
                .filter(field => field.editable && field.name !== 'UNUSED');
            const body = bodyFields.find(field => !field.choices?.length) || bodyFields[0];
            assert.ok(first && body, task.id + ': ' + initial.plan.reason);
            for (const field of new Set([first, body])) {
                const value = field.choices?.find(value => value !== field.value) ??
                    (['', '0', 'string'].includes(field.type) ? 'edit'.slice(0, Math.max(1, field.width)) : field.value === '1' ? '2' : '1');
                await editAndReopen(lines, 0, fields.indexOf(field), value, task.id, field.linkedFields);
                edits++;
            }
        }
        console.log(`    ${names.size} additional names; ${fixture.cases.length} format cases; ${edits} edits; ${readonly} read-only cases`);
    });

    it('preserves complete slash/hyphen tokens, attached markers and header suffixes in both replacement modes', () => {
        for (const keyword of ['MAT_054/055_TITLE', 'MAT_3-PARAMETER_BARLAT_TITLE']) for (const marker of ['', '+', '%', '-']) {
            const token = '*' + keyword + marker, line = '  ' + token + ', retained header';
            const {editor} = model([line, '*END']);
            for (const applicationMode of ['keyword-only-preserve-block', 'layout-migration']) {
                const replacement = api.optionSwitchReplacement(editor.document, {keywordLine: 0}, {
                    plan: {applicationMode, targetKeyword: '*' + keyword, replacementRecords: []},
                    block: {blockEnd: 1, records: []},
                });
                if (applicationMode === 'layout-migration') assert.equal(replacement.text, line + '\n');
                else {
                    assert.equal(replacement.text, token);
                    assert.equal(line.slice(replacement.range.start.character, replacement.range.end.character), token);
                }
            }
        }
    });

    it('writes the exact comma decks independently read, saved and reopened by native LSPP', async () => {
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-conditional-comma-roundtrip.json.gz'))));
        const cross = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-suffix-reader-crosscheck.json.gz'))));
        assert.equal(fixture.sourceSha256, native.NATIVE_FILE_SOURCE);
        assert.deepEqual(fixture.cases.map(c => c.id).sort(), cross.cases.filter(c => c.previousReadonlyReason).map(c => c.id).sort());
        let edits = 0;
        for (const task of fixture.cases) {
            const binding = require('../../../out/core/semantics/nativeConditionalLayout').nativeConditionalBinding(task.keyword);
            assert.deepEqual(binding.reader, task.reader);
            assert.equal(binding.cardSetId, task.cardSetId);
            const source = task.lines.slice();
            for (const edit of task.edits) {
                const index = task.records.findIndex(record => record.cardIndex === edit.card);
                const tokens = source[index + 1].split(','); tokens[edit.field] = '0'; source[index + 1] = tokens.join(',');
            }
            const lines = [...source, '$ retained comment', '*END'];
            const {editor, initial} = model(lines); let staged = initial;
            const changes = task.edits;
            for (const edit of changes) {
                const card = staged.managerCards.find(card => card.cardIndex === edit.card), field = card?.fields[edit.field];
                assert.ok(field?.editable, task.id + '/' + edit.card + '/' + edit.field + ': ' + staged.plan.reason);
                const drafts = api.keywordManagerEditField(staged, field.fieldId, edit.value);
                assert.ok(drafts, task.id + '/' + field.name);
                staged = api.buildKeywordOptionViewModel(editor, 0, drafts);
                assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true, task.id + ': ' + staged.plan.reason);
                edits++;
            }
            const {next} = await applyStaged(lines, editor, staged, task.id);
            assert.deepEqual(next, [...task.lines, '$ retained comment', '*END'], task.id + ': differs from native input bytes');
            const reopened = model(next).initial;
            assert.deepEqual(reopened.managerCards.map(card => card.cardIndex), task.records.map(record => record.cardIndex));
            for (const edit of changes) assert.equal(reopened.managerCards.find(card => card.cardIndex === edit.card).fields[edit.field].value, edit.value);
        }
        console.log(`    ${fixture.cases.length} native comma decks; ${edits} field drafts; exact native input bytes preserved`);
    });

    it('preserves title commas, switches native comma branches, and confirms removal of nonempty cards', async () => {
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-conditional-comma-roundtrip.json.gz'))));
        const task = fixture.cases.find(task => task.keyword === 'MAT_BARLAT_YLD2000_TITLE');
        const lines = [...task.lines, '$ retained comment', '*END'];
        await editAndReopen(lines, 0, 0, 'edited, title', task.id + '/title');
        const {editor, initial} = model(lines), fields = initial.managerCards.flatMap(card => card.fields);
        const fit = fields.find(field => field.name === 'FIT');
        assert.equal(api.keywordManagerEditField(initial, fit.fieldId, '0,1'), null);
        const staged = api.buildKeywordOptionViewModel(editor, 0, api.keywordManagerEditField(initial, fit.fieldId, '0'));
        assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true, staged.plan.reason);
        assert.deepEqual(staged.targetLayout.records.map(record => record.lsppCardIndex), [0, 1, 2, 4, 7, 8, 9]);
        assert.ok(staged.plan.discardedFields.length);
        const rejected = await applyStaged(lines, editor, staged, task.id, false);
        assert.equal(rejected.warnings, 1);
        const {next, warnings} = await applyStaged(lines, editor, staged, task.id);
        assert.equal(warnings, 1);
        assert.equal(next[0], lines[0]); assert.equal(next[1], lines[1]);
        assert.ok(next.slice(2, -2).every(line => line.includes(',')));
        const reopened = model(next).initial;
        assert.deepEqual(reopened.managerCards.map(card => card.cardIndex), [0, 1, 2, 4, 7, 8, 9]);
        assert.equal(reopened.managerCards.flatMap(card => card.fields).find(field => field.name === 'FIT').value, '0');
    });

    it('keeps unverified comma boundaries, unresolved controls and source mismatches closed without losing surplus tokens', async () => {
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-suffix-reader-crosscheck.json.gz'))));
        const spr3 = fixture.cases.find(task => task.id === 'MAT_CONSTRAINED_SPR3_TITLE/comma');
        const source = model([...spr3.lines, '*MAT_ELASTIC_TITLE', 'next material', '2,1,1,0,0,0,0,0', '*END']).initial;
        assert.equal(source.plan.reason, 'native-file-write-unverified');
        assert.ok(source.managerCards.flatMap(card => card.fields).every(field => !field.editable));
        const task = fixture.cases.find(task => task.id === 'MAT_034_TITLE/comma');
        const unresolved = [...task.lines, '*END'], tokens = unresolved[4].split(',');
        tokens[6] = '&MISSING'; unresolved[4] = tokens.join(',');
        const state = model(unresolved).initial;
        assert.equal(api.buildKeywordOptionsViewState(state).canApply, false);
        assert.ok(state.managerCards.flatMap(card => card.fields).every(field => !field.editable));
        const surplus = [...task.lines, '*END']; surplus[2] += ',99';
        await editAndReopen(surplus, 0, 1, '2', task.id + '/surplus-preserved');
        const full = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-conditional-comma-roundtrip.json.gz'))));
        const barlat = full.cases.find(task => task.keyword === 'MAT_BARLAT_YLD2000_TITLE');
        const removing = [...barlat.lines, '*END']; removing[barlat.records.findIndex(record => record.cardIndex === 5) + 1] += ',99';
        const {editor, initial} = model(removing), fit = initial.managerCards.flatMap(card => card.fields).find(field => field.name === 'FIT');
        const staged = api.buildKeywordOptionViewModel(editor, 0, api.keywordManagerEditField(initial, fit.fieldId, '0'));
        assert.equal(api.buildKeywordOptionsViewState(staged).canApply, false);
        assert.equal(staged.plan.reason, 'source-record-coverage-unproven');
        const {keywordDataPath} = require('../../../out/core/keywordDataPath');
        const data = require(keywordDataPath('native-readers/lspp-conditional-layout-readers.json')), sourceHash = data.sourceSha256;
        try {
            data.sourceSha256 = 'unverified';
            const state = model([...task.lines, '*END']).initial;
            assert.equal(api.buildKeywordOptionsViewState(state).canApply, false);
            assert.ok(state.managerCards.flatMap(card => card.fields).every(field => !field.editable));
        } finally { data.sourceSha256 = sourceHash; }
    });

    it('explains a lost source location and prevents stale comma drafts from being applied', async () => {
        const {editor, initial} = model(['*MAT_034_TITLE', 'title', ...Array(5).fill('1,0,0,0,0,0,0,0'), '*END']);
        const stale = {...initial, stale: true, sourceAnchorInvalid: true};
        const i18n = require('../../../out/core/i18n'), originalConfiguration = vscode.workspace.getConfiguration;
        const originalApply = vscode.workspace.applyEdit;
        let writes = 0;
        vscode.workspace.applyEdit = async () => { writes++; return true; };
        try {
            for (const [language, text] of [['en', 'Open the intended keyword instance again from the source file.'],
                ['zh-cn', '请在源文件中重新打开目标关键字实例。']]) {
                vscode.workspace.getConfiguration = (...args) => {
                    const config = originalConfiguration(...args);
                    return {...config, get: (key, ...rest) => key === 'language' ? language : config.get(key, ...rest)};
                };
                i18n.updateLanguage();
                const state = api.buildKeywordOptionsViewState(stale);
                assert.equal(state.status, 'stale'); assert.equal(state.canApply, false);
                assert.ok(state.message.includes(text));
                await api.applyKeywordOptionViewModel({getModel: () => stale, markStale() {}}, editor);
            }
            assert.equal(writes, 0);
        } finally { vscode.workspace.getConfiguration = originalConfiguration; vscode.workspace.applyEdit = originalApply; i18n.updateLanguage(); }
    });

    it('keeps marked native instances stable when the deferred directory finishes loading', async () => {
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-suffix-write-matrix.json.gz'))));
        for (const keyword of ['CONSTRAINED_JOINT_REVOLUTE_ID', 'IGA_INTEGRATION_SHELL_REDUCE_TITLE'])
            for (const [format, marker] of [['standard', '-'], ['long', '+'], ['i10', '%']]) {
                const task = fixture.cases.find(task => task.id === keyword + '/' + format);
                const lines = ['*' + keyword + marker, ...task.lines.slice(1), '*END'];
                const editor = editorFor(documentFor(lines));
                const early = api.buildKeywordOptionViewModel(editor, 0, {deferInstances: true});
                assert.equal(early.directoryStatus, 'loading');
                await api.prepareKeywordManagerInstances(editor.document, null);
                const field = early.managerCards.flatMap(card => card.fields).find(field => field.editable);
                const drafts = api.keywordManagerEditField(early, field.fieldId, '7');
                const ready = api.buildKeywordOptionViewModel(editor, 0, {...drafts, selectedFieldId: field.fieldId});
                assert.equal(ready.directoryStatus, 'ready');
                assert.equal(ready.selectedInstanceId, early.selectedInstanceId, task.id);
                assert.deepEqual(ready.managerInstances.map(instance => instance.instanceId), early.managerInstances.map(instance => instance.instanceId), task.id);
                assert.equal(api.buildKeywordOptionsViewState(ready).canApply, true, task.id);
            }
    });

    it('does not report the standard 80-column limit for explicit or inherited long/I10 input', () => {
        const longRecord = '1'.padStart(160);
        for (const marker of ['+', '%']) {
            const lines = ['*CONSTRAINED_JOINT_REVOLUTE_ID' + marker, '1'.padStart(20) + 'title', longRecord, '*END'];
            assert.deepEqual(api.collectLineLengthDiagnostics(documentFor(lines)), []);
        }
        for (const control of ['LONG=Y', 'I10=Y']) {
            const lines = ['*KEYWORD ' + control, '*NODE', longRecord, '*END'];
            assert.deepEqual(api.collectLineLengthDiagnostics(documentFor(lines)), []);
            lines[1] += '-';
            assert.equal(api.collectLineLengthDiagnostics(documentFor(lines)).length, 1);
        }
    });

    it('preserves the existing DMN manual-supported path without granting native suffix authority', async () => {
        for (const keyword of ['MAT_DMN_COMPOSITE_FRC_TITLE', 'MAT_303_TITLE'])
            for (const format of ['standard', 'long', 'i10', 'comma']) {
                assert.equal(require('../../../out/core/keywordSuggest').isKnownKeywordName(keyword), true);
                assert.equal(native.isVerifiedNativeSpelling(keyword), false);
                const rows = [[1], [0.5, 1, 1, 1, 1, 1], [1, 0.3, 0, 0], [1, 0.3, 1, 1, 1, 1, 0], [100, 101]];
                const lines = ['*' + keyword + (format === 'long' ? '+' : format === 'i10' ? '%' : ''), 'title',
                    ...rows.map(row => format === 'comma' ? row.join(',') : row.map(value => String(value).padStart(format === 'long' ? 20 : 10)).join('')), '*END'];
                const initial = model(lines).initial;
                assert.equal(api.buildKeywordOptionsViewState(initial).canApply, false, keyword + '/' + format);
                const fields = initial.managerCards.flatMap(card => card.fields);
                if (format === 'comma') {
                    assert.equal(initial.plan.reason, 'conditional-comma-write-unverified');
                    assert.ok(fields.every(field => !field.editable));
                } else await editAndReopen(lines, 0, fields.findIndex(field => field.name === 'MID'), '2', keyword + '/' + format);
            }
    });

    it('preserves empty-source shared drafts and reports suggested-value warnings', async () => {
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-suffix-write-matrix.json.gz'))));
        const task = fixture.cases.find(t => t.id === 'DUALCESE_BOUNDARY_BLAST_LOAD_SEGMENT_SET_TITLE/i10');
        const lines = [...task.lines, '*END'], fields = model(lines).initial.managerCards.flatMap(c => c.fields);
        await editAndReopen(lines, 0, fields.findIndex(f => f.name === 'SSID'), '1', task.id, ['BID']);
        const invalid = fixture.cases.find(t => t.id === 'IGA_INTEGRATION_SOLID_REDUCE_TITLE/i10');
        const {editor, initial} = model([...invalid.lines, '*END']);
        const field = initial.managerCards.flatMap(c => c.fields).find(f => f.name === 'NRDT');
        const drafts = api.keywordManagerEditField(initial, field.fieldId, '7');
        assert.ok(drafts);
        const staged = api.buildKeywordOptionViewModel(editor, 0, drafts);
        assert.equal(staged.managerCards.flatMap(c => c.fields).find(f => f.name === 'NRDT').diagnostic.code, 'choice');
        assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true);
    });

    it('keeps every suffix catalog source-bound and retains incomplete-contact restrictions', () => {
        const {keywordDataPath} = require('../../../out/core/keywordDataPath');
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-suffix-write-matrix.json.gz'))));
        for (const {file} of fixture.readers) {
            const source = require(keywordDataPath('native-readers/' + file));
            const task = fixture.cases.find(t => source.bindings[t.keyword] && t.format === 'standard');
            const lines = [...task.lines, '*END'], hash = source.sourceSha256;
            assert.ok(model(lines).initial.managerCards.some(c => c.fields.some(f => f.editable)), file);
            try {
                source.sourceSha256 = 'unverified';
                assert.equal(api.buildKeywordOptionsViewState(model(lines).initial).canApply, false, file);
                assert.ok(model(lines).initial.managerCards.every(c => c.fields.every(f => !f.editable)), file);
            } finally { source.sourceSha256 = hash; }
        }
        const task = fixture.cases.find(t => t.id === 'CONTACT_AIRBAG_SINGLE_SURFACE_ID_MPP/standard');
        const incomplete = model([...task.lines.slice(0, -1), '*END']).initial;
        assert.ok(incomplete.managerCards.every(c => c.fields.every(f => !f.editable)));
    });
    for (const filename of ['single-card-prefix-scope-display.json', 'remaining-title-prefix-display.json']) {
        it('edits and reopens verified prefix/body records from ' + filename, async () => {
            const fixture = require('../../fixtures/public-behavior/' + filename);
            const enabled = new Set();
            let edits = 0;
            for (const identity of fixture.identities) {
                if (!native.nativeSpellingBinding(identity.keyword)) continue;
                for (const task of identity.cases) {
                    const lines = [...task.lines, '*END'];
                    const initial = model(lines).initial;
                    const fields = initial.managerCards.flatMap(card => card.fields);
                    const candidates = fields.map((field, index) => ({ field, index }))
                        .filter(({ field }) => field.editable && !field.choices?.length && field.name !== 'UNUSED');
                    if (!candidates.length) {
                        assert.equal(api.buildKeywordOptionsViewState(initial).canApply, false, task.id);
                        continue;
                    }
                    enabled.add(identity.keyword);
                    for (const { field, index } of [candidates[0], candidates.at(-1)]) {
                        const value = ['', '0', '-2', 'string'].includes(field.type) ? 'edit'.slice(0, Math.max(1, field.width || 4)) : field.value === '7' ? '8' : '7';
                        await editAndReopen(lines, 0, index, value, task.id + '/' + field.name);
                        edits++;
                    }
                }
            }
            assert.ok(enabled.size >= (filename.startsWith('remaining') ? 10 : 60), String(enabled.size));
            console.log(`    ${enabled.size} suffix names; ${edits} edit/apply/reopen cases (${filename})`);
        });
    }

    it('reuses body writers for native aliases without inventing a prefix card', async () => {
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/single-card-suffix-display.json.gz'))));
        let checked = 0;
        for (const keyword of fixture.identities) {
            if (!native.nativeSpellingBinding(keyword)) continue;
            const task = fixture.tasks.find(t => t.keyword === keyword && t.format === 'standard' && t.repeatCount === 2);
            const lines = [...task.lines, '*END'], initial = model(lines).initial;
            const fields = initial.managerCards.flatMap(card => card.fields);
            const index = fields.findIndex(f => f.editable && !f.choices?.length && !['0', '-2', 'string'].includes(f.type));
            if (index < 0) continue;
            await editAndReopen(lines, 0, index, fields[index].value === '7' ? '8' : '7', keyword);
            checked++;
        }
        assert.ok(checked > 100, String(checked));
        console.log(`    ${checked} no-prefix aliases edited and reopened`);
    });

    it('isolates each joint instance and preserves comments, format markers and other blocks', async () => {
        for (const keyword of ['CONSTRAINED_JOINT_REVOLUTE_ID', 'CONSTRAINED_JOINT_CYLINDRICAL_ID']) {
            for (const format of ['standard', 'long', 'comma']) {
                const row = values => format === 'comma' ? values.join(',') : values.map(v => String(v).padStart(format === 'long' ? 20 : 10)).join('');
                const prefix = id => format === 'comma' ? id + ',joint' : row([id]) + 'joint'.padEnd(70);
                const lines = ['*' + keyword + (format === 'long' ? ' +' : ''), '$ first', prefix(1), row([1,2,3,4,0,0,1,1]),
                    '$ second', prefix(2), row([5,6,7,8,0,0,1,1]), '$ after', '*TITLE', 'untouched', '*END'];
                for (const line of [2, 5]) {
                    const fields = model(lines, line).initial.managerCards.flatMap(c => c.fields);
                    for (let index = 0; index < fields.length; index++) {
                        assert.equal(fields[index].editable, true, keyword + '/' + format);
                        await editAndReopen(lines, line, index, fields[index].name === 'TITLE' ? 'edited title' : '9', keyword + '/' + format + '/' + line);
                    }
                }
            }
        }
    });

    it('edits SET_SHELL_TITLE without treating title commas as delimiters', async () => {
        for (const marker of ['', ' +', ' %']) {
            const width = marker === ' +' ? 20 : 10;
            const lines = ['*SET_SHELL_TITLE' + marker, 'original, title', '1'.padStart(width), '11'.padStart(width) + '12'.padStart(width), '*END'];
            await editAndReopen(lines, 0, 0, 'a longer new title', 'shell title' + marker);
            await editAndReopen(lines, 0, 1, '7', 'shell SID' + marker);
        }
    });

    it('retains conditional, format, spelling-transition and filesystem write restrictions', () => {
        const { nativeKeywordReadContext } = require('../../../out/core/semantics/nativeFileReadContext');
        const conditional = nativeKeywordReadContext('*EFV_EOS_JWL_TITLE', ['title', '         1'], 'standard');
        assert.ok(conditional);
        assert.equal(conditional.writeCompatible([]), false);
        const lines = ['*CONSTRAINED_JOINT_REVOLUTE_ID', '         1joint', '         1         2         3         4', '*END'];
        const { editor } = model(lines);
        const switched = api.buildKeywordOptionViewModel(editor, 0, { targetKeyword: '*CONSTRAINED_JOINT_REVOLUTE' });
        assert.equal(api.buildKeywordOptionsViewState(switched).canApply, false);
        const i10 = model([lines[0] + ' %', ...lines.slice(1)]).initial;
        assert.ok(i10.managerCards.flatMap(c => c.fields).some(f => f.editable));
        const old = vscode.workspace.fs;
        try {
            vscode.workspace.fs = { ...old, isWritableFileSystem: () => false };
            const document = documentFor(lines);
            document.uri.scheme = 'file';
            const readonly = api.buildKeywordOptionViewModel(editorFor(document), 0, {});
            assert.ok(readonly.managerCards.flatMap(c => c.fields).every(f => !f.editable));
        } finally { vscode.workspace.fs = old; }
    });

    it('edits conditional suffix fields without changing the selected native record sequence', async () => {
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-conditional-suffix-write.json.gz'))));
        const enabled = new Set();
        let edits = 0;
        for (const task of fixture.cases) {
            const lines = [...task.lines, '*END'];
            const initial = model(lines).initial, fields = initial.managerCards.flatMap(c => c.fields);
            const controlIds = new Set(Object.values(native.nativeSpellingBinding(task.keyword).layout.controls)
                .flatMap(control => initial.targetLayout.records.filter(record => (control.sourceCards || [control.card]).includes(record.lsppCardIndex))
                    .map(record => record.fields[control.field]?.fieldMigrationId)));
            const candidates = fields.map((field, index) => ({ field, index }))
                .filter(({ field }) => field.editable && !field.choices?.length && !controlIds.has(field.fieldId));
            assert.ok(candidates.length, task.id + ': no editable fields');
            enabled.add(task.keyword);
            for (const {field,index} of [candidates[0], candidates.find(c => c.field.line > fields[0].line) || candidates[0], candidates.at(-1)]) {
                const value = ['', '0', '-2', 'string'].includes(field.type) ? 'edit' : field.value === '7' ? '8' : '7';
                const drafts = api.keywordManagerEditField(initial,field.fieldId,value);
                const staged = drafts && api.buildKeywordOptionViewModel(model(lines).editor,0,drafts);
                assert.ok(staged && api.buildKeywordOptionsViewState(staged).canApply, task.id+'/'+field.name+': blocked');
                await editAndReopen(lines,0,index,value,task.id+'/'+field.name); edits++;
            }
        }
        assert.equal(enabled.size, 20, [...enabled].join(','));
        assert.equal(edits, fixture.cases.length * 3);
        console.log(`    ${enabled.size} conditional suffixes; ${edits} edit/apply/reopen cases`);
    });

    it('retains truncated record and mixed-format restrictions', () => {
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-conditional-suffix-write.json.gz'))));
        const task = fixture.cases.find(t => t.id === 'EFV_EOS_JWL_TITLE/standard/ADD=0');
        const lines = [...task.lines, '*END'], {editor,initial} = model(lines);
        const add = initial.managerCards.flatMap(c=>c.fields).find(f=>f.name==='ADD');
        const drafts = api.keywordManagerEditField(initial,add.fieldId,'2');
        assert.ok(drafts);
        const staged=api.buildKeywordOptionViewModel(editor,0,drafts);
        assert.equal(api.buildKeywordOptionsViewState(staged).canApply,true);
        assert.equal(editor.document.getText(),lines.join('\n'));
        const truncated=model([...task.lines.slice(0,2),'*END']).initial;
        assert.ok(truncated.managerCards.flatMap(c=>c.fields).every(f=>!f.editable));
        const mixed=model(['*KEYWORD LONG=Y','*CONSTRAINED_JOINT_REVOLUTE_ID %',
            '         1joint','         1         2         3         4','*END'],1).initial;
        assert.ok(mixed.managerCards.flatMap(c=>c.fields).every(f=>!f.editable));
    });

    it('edits shared G/C bytes only in equivalent windows and previews both linked fields', async () => {
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-conditional-suffix-write.json.gz'))));
        for (const keyword of ['EFV_EOS_011_TITLE','EFV_EOS_POWDER_BURN_TITLE']) {
            for (const format of ['standard','long','comma','i10']) {
                const task=fixture.cases.find(t=>t.keyword===keyword&&t.format===format), lines=[...task.lines,'*END'];
                for (const name of ['G','C']) {
                    const {editor,initial}=model(lines), fields=initial.managerCards.flatMap(c=>c.fields), index=fields.findIndex(f=>f.name===name);
                    const drafts=api.keywordManagerEditField(initial,fields[index].fieldId,'7');
                    assert.ok(drafts,keyword+'/'+format+'/'+name);
                    const staged=api.buildKeywordOptionViewModel(editor,0,drafts);
                    const linked=['standard','i10'].includes(format);
                    if(linked) {
                        assert.equal(Object.keys(drafts.recordDrafts).length,1);
                        assert.deepEqual(staged.managerCards.flatMap(c=>c.fields).filter(f=>['G','C'].includes(f.name)).map(f=>f.draft),['7','7']);
                    }
                    await editAndReopen(lines,0,index,'7',keyword+'/'+format+'/'+name,linked?['G','C']:[]);
                }
            }
            const task=fixture.cases.find(t=>t.keyword===keyword&&t.format==='standard');
            const reading=require('../../../out/core/semantics/nativeFileReadContext').nativeKeywordReadContext(task.lines[0],task.lines.slice(1),'standard');
            const proof=reading.cards.get(1).sharedByteEditing, saved=proof.branchSha256;
            try {
                proof.branchSha256='unverified';
                assert.equal(reading.writeCompatible(reading.select(false).current),false);
            } finally { proof.branchSha256=saved; }
        }
    });

    it('adds conditional records, preserves comments, and confirms data loss before removing them', async () => {
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-conditional-suffix-write.json.gz'))));
        for (const format of ['standard','long','comma','i10']) {
            const task=fixture.cases.find(t=>t.id===`EFV_EOS_JWL_TITLE/${format}/ADD=0`);
            const lines=[task.lines[0],'$ keep prefix',...task.lines.slice(1),'$ keep tail','*TITLE','unrelated','*END'];
            const {editor,initial}=model(lines), add=initial.managerCards.flatMap(c=>c.fields).find(f=>f.name==='ADD');
            const staged=api.buildKeywordOptionViewModel(editor,0,api.keywordManagerEditField(initial,add.fieldId,'2'));
            assert.equal(api.buildKeywordOptionsViewState(staged).canApply,true,format);
            assert.deepEqual(staged.targetLayout.records.map(r=>r.lsppCardIndex),[0,1,2,4]);
            const {next}=await applyStaged(lines,editor,staged,format+'/grow');
            assert.ok(next.includes('$ keep prefix')&&next.includes('$ keep tail'));
            assert.deepEqual(next.slice(-3),['*TITLE','unrelated','*END']);
            const grown=model(next), appended=grown.initial.managerCards.at(-1).fields[0];
            const filled=api.buildKeywordOptionViewModel(grown.editor,0,api.keywordManagerEditField(grown.initial,appended.fieldId,'17'));
            const populated=await applyStaged(next,grown.editor,filled,format+'/fill');
            const current=model(populated.next), control=current.initial.managerCards.flatMap(c=>c.fields).find(f=>f.name==='ADD');
            const shrink=api.buildKeywordOptionViewModel(current.editor,0,api.keywordManagerEditField(current.initial,control.fieldId,'0'));
            assert.equal(shrink.plan.requiresLossConfirmation,true,format);
            assert.ok(shrink.plan.discardedFields.some(f=>f.value==='17'));
            const cancelled=await applyStaged(populated.next,current.editor,shrink,format+'/cancel',false);
            assert.equal(cancelled.warnings,1);
            assert.equal(current.editor.document.getText(),populated.next.join('\n'));
            const accepted=await applyStaged(populated.next,current.editor,shrink,format+'/shrink');
            assert.equal(accepted.warnings,1);
            const reopened=model(accepted.next).initial;
            assert.deepEqual(reopened.currentLayout.records.map(r=>r.lsppCardIndex),[0,1,2]);
            assert.equal(reopened.managerCards.flatMap(c=>c.fields).find(f=>f.name==='ADD').value,'0');
            assert.ok(accepted.next.includes('$ keep prefix')&&accepted.next.includes('$ keep tail'));
            assert.deepEqual(accepted.next.slice(-3),['*TITLE','unrelated','*END']);
        }
    });

    it('applies native branch transitions across suffix families and input formats', async () => {
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-conditional-suffix-write.json.gz'))));
        let checked=0;
        const keywords=new Set();
        for(const keyword of new Set(fixture.cases.map(t=>t.keyword))) for(const format of ['standard','long','comma','i10']) {
            const controls=native.nativeSpellingBinding(keyword).layout.controls;
            const states=fixture.cases.filter(t=>t.keyword===keyword&&t.format===format).map(task=>{
                const lines=[...task.lines,'*END'], state=model(lines), fields=state.initial.managerCards.flatMap(c=>c.fields);
                const values=Object.fromEntries(Object.entries(controls).map(([name,control])=>{
                    const fieldId=state.initial.currentLayout.records.find(record=>(control.sourceCards||[control.card]).includes(record.lsppCardIndex))?.fields[control.field]?.fieldMigrationId;
                    return [name,fields.find(f=>f.fieldId===fieldId)];
                }));
                return {task,lines,...state,values,indexes:state.initial.currentLayout.records.map(r=>r.lsppCardIndex)};
            });
            let pair;
            for(const from of states) for(const to of states) {
                if(pair || to.indexes.length<=from.indexes.length) continue;
                if(from.task.id.match(/omit=\w+/)?.[0]!==to.task.id.match(/omit=\w+/)?.[0]) continue;
                const changes=Object.keys(controls).filter(name=>from.values[name]?.value!==to.values[name]?.value);
                if(changes.length!==1) continue;
                const name=changes[0], field=from.values[name], value=to.values[name]?.value;
                if(!field?.editable || !/^[0-9]+$/.test(value||'') || field.choices?.length&&!field.choices.some(c=>String(c.value??c)===value)) continue;
                const drafts=api.keywordManagerEditField(from.initial,field.fieldId,value);
                if(!drafts) continue;
                const staged=api.buildKeywordOptionViewModel(from.editor,0,drafts);
                if(!api.buildKeywordOptionsViewState(staged).canApply) continue;
                pair={from,to,staged};
            }
            if(!pair) continue;
            const {from,to,staged}=pair;
            assert.deepEqual(staged.targetLayout.records.map(r=>r.lsppCardIndex),to.indexes,keyword+'/'+format);
            const {next}=await applyStaged(from.lines,from.editor,staged,keyword+'/'+format);
            const reopened=model(next).initial;
            assert.deepEqual(reopened.currentLayout.records.map(r=>r.lsppCardIndex),to.indexes,keyword+'/'+format+'/reopen');
            assert.equal(next[0],from.lines[0],keyword+'/'+format+'/header');
            keywords.add(keyword); checked++;
        }
        assert.ok(keywords.size>=15, [...keywords].join(','));
        assert.ok(checked>=60, String(checked));
        console.log(`    ${keywords.size} suffix families; ${checked} branch transitions applied and reopened`);
    });

    it('writes joint suffix I10 bodies using the native normalized format', async () => {
        for (const suffix of ['ID', 'TITLE']) {
            const lines = ['*CONSTRAINED_JOINT_REVOLUTE_' + suffix + ' %', '         1joint',
                [1,2,3,4,0,0,1,1].map(v=>String(v).padStart(10)).join(''), '*END'];
            const fields=model(lines).initial.managerCards.flatMap(c=>c.fields);
            for(let index=0;index<fields.length;index++)
                await editAndReopen(lines,0,index,fields[index].name==='TITLE'?'new title':'9','I10/'+suffix+'/'+fields[index].name);
        }
    });

    it('composes TITLE with dynamic bodies, edits, reopens and confirms title removal across families', async () => {
        for (const keyword of ['DEFINE_TRANSFORMATION', 'DEFINE_TRANSFORM', 'SET_SHELL']) {
            for (const format of keyword === 'SET_SHELL' ? ['standard', 'comma', 'long', 'i10'] : ['standard']) {
                const row = (...values) => format === 'comma' ? values.join(',') :
                    values.map(value => String(value).padStart(format === 'long' ? 20 : 10)).join('');
                const marker = format === 'long' ? ' +' : format === 'i10' ? ' %' : '';
                const body = keyword === 'SET_SHELL' ? [row(1), row(2, 3)] :
                    [row(1), row('MATRIX'), row(1,0,0,0,0,1,0,0), row(0,0,1,0,0,0,0,1),
                        '$ keep operation comment', row('TRANSL',1,2,3), row('ROTATE',0,0,1,0,0,0,90)];
                const lines = ['*' + keyword + marker, '$ keep leading comment', ...body, '$ keep tail', '*END'];
                const { editor, initial } = model(lines);
                const control = initial.controls.find(control => control.choices.some(choice => choice.value === 'TITLE'));
                assert.ok(control?.choices.find(choice => choice.value === 'TITLE').enabled, keyword + '/' + format);
                const draftControlState = { [control.controlId]: 'TITLE' };
                const titled = api.buildKeywordOptionViewModel(editor, 0, { draftControlState });
                assert.equal(titled.managerCards[0].fields[0].name, 'TITLE');
                assert.equal(titled.managerCards[0].fields[0].editable, true);
                assert.deepEqual(titled.currentLayout.records, initial.currentLayout.records, 'Source identities must not move');
                const title = '标题, transformation title';
                const edited = api.buildKeywordOptionViewModel(editor, 0, { draftControlState,
                    fieldDrafts: { [titled.managerCards[0].fields[0].fieldId]: title } });
                assert.equal(api.buildKeywordOptionsViewState(edited).canApply, true, edited.plan.reason);
                const { next } = await applyStaged(lines, editor, edited, keyword + '/' + format);
                assert.equal(next[0], '*' + keyword + '_TITLE' + marker);
                for (const line of lines.slice(1)) assert.ok(next.includes(line), 'Preserve original line: ' + line);
                const reopened = model(next);
                assert.notEqual(reopened.initial.plan.status, 'blocked', reopened.initial.plan.reason);
                assert.equal(reopened.initial.managerCards[0].fields[0].value, title);
                const remove = api.buildKeywordOptionViewModel(reopened.editor, 0,
                    { draftControlState: { [control.controlId]: '' } });
                assert.equal(remove.plan.status, 'ready', remove.plan.reason);
                const cancelled = await applyStaged(next, reopened.editor, remove, keyword, false);
                assert.ok(cancelled.warnings > 0, 'Removing a nonempty title requires confirmation');
                const removed = await applyStaged(next, reopened.editor, remove, keyword);
                assert.ok(removed.warnings > 0);
                assert.equal(removed.next[0], lines[0]);
                assert.deepEqual(removed.next.filter(line => !line.startsWith('$')), lines.filter(line => !line.startsWith('$')));
                assert.notEqual(model(removed.next).initial.plan.status, 'blocked');
            }
        }
    });

    it('materializes static prefix options on templates and partial bodies without expanding optional tails', async () => {
        for (const keyword of ['DEFINE_CPM_VENT', 'ALE_STRUCTURED_FSI', 'CONSTRAINED_INTERPOLATION_SPOTWELD']) {
            for (const format of ['standard', 'comma', 'long', 'i10']) for (const partial of [false, true]) {
                const marker = format === 'long' ? ' +' : format === 'i10' ? ' %' : '';
                const lines = ['*' + keyword + marker, '$ keep source comment',
                    ...(partial ? Array(keyword === 'CONSTRAINED_INTERPOLATION_SPOTWELD' ? 5 : 1)
                        .fill(format === 'comma' ? '1,' : '1'.padStart(format === 'long' ? 20 : 10)) : []), '*END'];
                const { editor, initial } = model(lines);
                const control = initial.controls.find(control => control.choices.some(choice => choice.value === 'TITLE'));
                for (const choice of control.choices) {
                    assert.equal(choice.enabled, true, keyword + '/' + format + '/' + choice.value);
                    const draftControlState = { [control.controlId]: choice.value };
                    const staged = api.buildKeywordOptionViewModel(editor, 0, { draftControlState });
                    assert.equal(staged.managerCards[0].cardIndex, 0);
                    const title = staged.managerCards[0].fields.find(field => field.name === 'TITLE');
                    if (keyword === 'CONSTRAINED_INTERPOLATION_SPOTWELD' && format === 'i10') {
                        assert.equal(title.editable, false);
                        assert.equal(title.reason, 'input-format-i10');
                        continue;
                    }
                    assert.ok(title?.editable, `${keyword}/${format}/${partial}/${choice.value}: ${staged.plan.reason}`);
                    const edited = api.buildKeywordOptionViewModel(editor, 0, { draftControlState,
                        fieldDrafts: { [title.fieldId]: 'option title' } });
                    const { next } = await applyStaged(lines, editor, edited, keyword);
                    const reopened = model(next).initial;
                    assert.equal(reopened.plan.status, 'no-change', keyword + ': ' + reopened.plan.reason);
                    assert.deepEqual(reopened.managerCards.map(card => card.fields.map(field => field.name)),
                        edited.managerCards.map(card => card.fields.map(field => field.name)), keyword);
                    assert.equal(reopened.managerCards[0].fields.find(field => field.name === 'TITLE').value, 'option title');
                    assert.ok(next.includes('$ keep source comment'));
                    assert.equal(editor.document.getText(), lines.join('\n'));
                    if (keyword === 'CONSTRAINED_INTERPOLATION_SPOTWELD') {
                        const optional = reopened.controls.find(control => control.controlId === 'optional-cards');
                        assert.equal(optional.value, '');
                        const added = api.buildKeywordOptionViewModel(model(next).editor, 0,
                            { draftControlState: { 'optional-cards': '2' } });
                        assert.equal(added.managerCards.length, reopened.managerCards.length + 2);
                        assert.equal(added.managerCards[0].fields[0].value, 'option title');
                    }
                }
            }
        }
    });

    it('rejects selector drafts whose source or target layout cannot represent the selected option', () => {
        for (const keyword of ['CONTACT_AUTOMATIC_SURFACE_TO_SURFACE', 'ALE_COUPLING_NODAL_DRAG',
            'ALE_COUPLING_NODAL_CONSTRAINT', 'ALE_COUPLING_NODAL_PENALTY', 'LOAD_SEGMENT']) {
            const empty = model(['*' + keyword, '*END']);
            for (const control of empty.initial.controls) for (const choice of control.choices) {
                if (keyword === 'LOAD_SEGMENT' && choice.value === 'TITLE') {
                    assert.equal(choice.enabled, true);
                    continue;
                }
                assert.equal(choice.enabled, false, keyword + '/' + choice.value);
                const staged = api.buildKeywordOptionViewModel(empty.editor, 0,
                    { draftControlState: { [control.controlId]: choice.value } });
                assert.equal(api.buildKeywordOptionsViewState(staged).canApply, false, keyword);
            }
        }
        const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../../fixtures/public-behavior/native-suffix-write-matrix.json.gz'))));
        const cases = fixture.cases.filter(task => ['EFV_OUTPUT_TITLE', 'EFV_COUPLING_TITLE', 'EFV_INITIAL_TITLE'].includes(task.keyword));
        assert.equal(cases.length, 12);
        for (const task of cases) {
            const { editor, initial } = model([...task.lines, '*END']);
            const control = initial.controls.find(control => control.value === 'TITLE');
            const supported = task.id === 'EFV_INITIAL_TITLE/standard';
            assert.equal(control.emptyEnabled, supported, task.id);
            const staged = api.buildKeywordOptionViewModel(editor, 0, { draftControlState: { [control.controlId]: '' } });
            assert.equal(api.buildKeywordOptionsViewState(staged).canApply, supported, task.id);
        }
    });

    it('keeps empty prefixed seismic templates unresolved without throwing in partial reads', () => {
        for (const suffix of ['NODE', 'SET', 'DECONV', 'POINT']) {
            const keyword = '*LOAD_SEISMIC_SSI_' + suffix + '_ID';
            const reading = require('../../../out/core/semantics/nativeFileReadContext').nativeKeywordReadContext(keyword, [], 'standard');
            assert.deepEqual(reading.select(true).current, []);
            assert.deepEqual(reading.select(true).counts, []);
            assert.equal(reading.select(false), null);
            const { initial } = model([keyword, '*END']);
            assert.equal(api.buildKeywordOptionsViewState(initial).canApply, false);
        }
    });

    it('does not let TITLE rescue an incomplete body or an unverified input format', () => {
        for (const lines of [
            ['*DEFINE_TRANSFORMATION', '         1', '    MATRIX', '*END'],
            ['*DEFINE_TRANSFORMATION', '1', 'TRANSL,1,2,3', '*END'],
            ['*DEFINE_TRANSFORMATION +', '                   1', '              TRANSL                   1', '*END'],
        ]) {
            const { editor, initial } = model(lines);
            const control = initial.controls.find(control => control.choices.some(choice => choice.value === 'TITLE'));
            const titled = api.buildKeywordOptionViewModel(editor, 0, { draftControlState: { [control.controlId]: 'TITLE' } });
            assert.equal(titled.plan.status, 'blocked');
            assert.equal(api.buildKeywordOptionsViewState(titled).canApply, false);
            assert.equal(editor.document.getText(), lines.join('\n'));
        }
    });

    it('requires verified title geometry and preserves native no-title decisions', () => {
        const catalog = require("../../../out/core/semantics/catalogInputFormCatalogV4").getCatalogInputFormCatalogV4();
        const original = catalog.formForKeyword;
        const keyword = 'DEFINE_TRANSFORMATION_TITLE';
        assert.ok(native.nativeFilePrefixBinding(keyword));
        try {
            for (const corrupt of [form => { form.source.datasetSha256 = 'unverified'; },
                form => { form.rules[form.reference.selectorRuleIds[0]].selectors[0].values[0].cards[0].fields[0].width = -1; }]) {
                catalog.formForKeyword = function (...args) {
                    const form = original.apply(this, args);
                    if (args[0] === keyword) corrupt(form);
                    return form;
                };
                assert.equal(native.nativeFilePrefixBinding(keyword), undefined);
            }
        } finally { catalog.formForKeyword = original; }
        const { keywordDataPath } = require('../../../out/core/keywordDataPath');
        const ordinal = require(keywordDataPath('native-readers/lspp-ordinal-file-readers.json'));
        for (const name of Object.keys(ordinal.bindings)) assert.equal(native.nativeFilePrefixBinding(name + '_TITLE'), undefined);
        const suffixes = require(keywordDataPath('native-readers/lspp-suffix-fixed-readers.json'));
        for (const [name, binding] of Object.entries(suffixes.bindings))
            if (name.endsWith('_TITLE') && binding.prefixSemantics === 'none' && !native.nativeSpellingBinding(name))
                assert.equal(native.nativeFilePrefixBinding(name), undefined);
    });

    it('rejects changed native provenance and unsafe prefix geometry', () => {
        const { keywordDataPath } = require('../../../out/core/keywordDataPath');
        const source = require(keywordDataPath('native-readers/lspp-spelling-file-readers.json'));
        const keyword = 'CONSTRAINED_JOINT_REVOLUTE_ID';
        const lines = ['*' + keyword, '         1joint', '         1         2         3         4', '*END'];
        const fields = () => model(lines).initial.managerCards.flatMap(c => c.fields);
        assert.ok(fields().some(f => f.editable));
        const hash = source.sourceSha256;
        try {
            source.sourceSha256 = 'unverified';
            assert.ok(fields().every(f => !f.editable));
        } finally { source.sourceSha256 = hash; }
        const prefix = native.nativeSpellingBinding(keyword).prefixCard.fields[0], width = prefix.width;
        try {
            prefix.width = -1;
            assert.ok(fields().every(f => !f.editable));
        } finally { prefix.width = width; }
        assert.ok(fields().some(f => f.editable));
    });
});
