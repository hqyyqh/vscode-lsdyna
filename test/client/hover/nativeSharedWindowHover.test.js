'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), zlib = require('node:zlib'), crypto = require('node:crypto');
const { fakeDoc } = require("../../support/helpers");
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve,
    buildKeywordOptionViewModel: model, keywordManagerEditField: edit, keywordManagerHelpState: helpState, generateCommentLine } = require("../../../out/extension")._internals;
const grammar = require("../../../keywords/runtime/native-readers/lspp-batch-fixed-readers.json");
// Explicit native windows, independent of the production formatter. The five
// overlaps also have the earlier native-shared-bytes-v1 span contracts.
const windows = {
    DEFINE_CONTROL_VOLUME_FLOW_AREA: [[[0,10],[10,10],[10,10],[20,10]]],
    INITIAL_DETONATION_GEOMETRY: [[[0,10],[10,10],[20,10]],[[0,10],[10,10],[20,10],[20,10]],[[0,10],[10,10],[20,10],[30,10]]],
    DUALCESE_BOUNDARY_BLAST_LOAD_SEGMENT_SET: [[[0,10],[0,10]]],
    BOUNDARY_FLUIDM: [[[0,10],[10,10],[20,10],[30,10],[30,10]]],
    IGA_INTEGRATION_SHELL_REDUCE: [[[152,10],[10,10],[20,20]]],
    IGA_INTEGRATION_SOLID_REDUCE: [[[0,10],[10,10],[20,20],[30,20]]],
};
const tasks = JSON.parse(zlib.gunzipSync(fs.readFileSync('test/fixtures/public-behavior/window-reader-cases.json.gz')));
function expected(task, record, index) {
    const text = task.lines[record.lineOffset], original = windows[task.keyword][index];
    if (task.format === 'comma') {
        let start = 0;
        return text.split(',').map(value => { const span = [start, value.length]; start += value.length + 1; return span; });
    }
    return task.format === 'long' ? original.map((_span, index) => [index * 20, 20]) : original;
}
describe('native shared file windows', () => {
    it('retains the observed SHELL offset and the existing shared-byte contracts', () => {
        const shell = JSON.parse(zlib.gunzipSync(fs.readFileSync('test/fixtures/public-behavior/windowShell-reader-cases.json.gz')));
        for (const task of shell.filter(task => task.keyword === 'IGA_INTEGRATION_SHELL_REDUCE' &&
            ['standard', 'i10'].includes(task.format))) {
            assert.equal(task.lines[1].slice(152, 162).trim(), '101');
            assert.equal(task.lines[1].slice(0, 10), ' '.repeat(10));
        }
        const previous = require("../../fixtures/public-behavior/shared-byte-cases.json");
        const addresses = ["record:c327cd5c63b30cf2cfc02ae7:43759c507cb591409365450e","record:1cd1189cbb8b718bfe96753f:2a22037948c50866f00b942e","record:ddd1735d5be2589e912a6edc:11271eedc53053f62a102bf5","record:b2612da025eff895bd80cc2c:8c1741bd14a9daceadda3601","record:b5726ceb0e7380a0d894b59c:cc3c024e7dbc580dc8368ae1"];
        assert.ok(addresses.every(address => previous.cards.some(({card}) =>
            card.sharedByteEditing.fields.some(field => field.fieldRecordId === address))));
    });
    it('locates all identities, text and hover boundaries in the 104 native probes without field comments', async function () {
        this.timeout(60000);
        assert.equal(tasks.length, 104);
        const provider = new LsdynaFieldHoverProvider();
        for (const task of tasks) {
            const doc = { ...fakeDoc(task.lines.join('\n'), `/native-windows/${task.id}.k`), version: 1 };
            for (const [index, record] of task.expectedRecords.entries()) {
                const info = resolve(doc, record.lineOffset).cardInfo;
                assert.ok(info, task.id);
                const spans = expected(task, record, index), text = task.lines[record.lineOffset];
                assert.deepEqual(info.card.map(field => field.nativeIdentity.fieldRecordId), record.fields.map(field => field.address));
                assert.ok(info.card.every(field => !field.nativeStaticBinding));
                assert.deepEqual(info.card.map(field => [field.p, field.w]), spans);
                assert.deepEqual(info.card.map(field => field.rawValue), spans.map(([p,w]) => text.slice(p,p+w).trim()));
                const edges = [...new Set(spans.flatMap(([p,w]) => [Math.min(text.length,p), Math.min(text.length,p+w)]))].sort((a,b) => a-b);
                for (let edge = 0; edge < edges.length-1; edge++) {
                    const column = edges[edge];
                    const matching = info.card.filter(field => column >= field.p && column < field.p + field.w);
                    if (!matching.length) continue;
                    const hover = await provider.provideHover(doc, { line: record.lineOffset, character: column });
                    assert.ok(hover, task.id);
                    for (const field of matching) assert.ok(hover.contents[0].value.includes(`**${field.n}**`), `${task.id}: ${field.n}`);
                    assert.equal(hover.range.start.character, column, task.id);
                    assert.equal(hover.range.end.character, edges[edge+1], task.id);
                }
            }
        }
    });
    it('shows the same source values in manager views while preserving format write restrictions', function () {
        this.timeout(60000);
        for (const task of tasks) {
            const doc = { ...fakeDoc([task.lines[0], '$# WRONG FIELD NAMES', ...task.lines.slice(1)].join('\n'), `/native-window-manager/${task.id}.k`), version: 1 };
            const view = model({ document: doc, selection: { active: { line: 2, character: 0 } } }, 2, {});
            for (const [index, record] of task.expectedRecords.entries()) {
                const card = view.managerCards.find(card => card.line === record.lineOffset + 1);
                assert.ok(card, `${task.id}: manager source`);
                const spans = expected(task, record, index), text = task.lines[record.lineOffset];
                assert.deepEqual(card.fields.map(field => field.value), spans.map(([p,w]) => text.slice(p,p+w).trim()), task.id);
                assert.deepEqual(card.fields.map(field => [field.position,field.width]), spans, task.id);
                card.fields.forEach((field, index) => {
                    const help = helpState({ ...view, selectedFieldId: field.fieldId });
                    assert.equal(help.schemaName, record.fields[index].name, task.id);
                    assert.equal(field.type, String(record.fields[index].type), task.id);
                });
                if (task.format !== 'standard') {
                    assert.ok(card.fields.every(field => !field.editable), task.id);
                    assert.equal(edit(view, card.fields[0].fieldId, '1'), null, task.id);
                }
            }
        }
    });
    it('retains both shared names in comments and follows edits, version changes and undo', async () => {
        const task = tasks.find(task => task.keyword === 'BOUNDARY_FLUIDM' && task.format === 'standard');
        const original = task.lines[1];
        let text = original;
        const doc = { ...fakeDoc('*BOUNDARY_FLUIDM\n' + text, '/native-window-edit.k'), version: 1,
            lineAt: line => ({ text: line === 0 ? '*BOUNDARY_FLUIDM' : text }), getText: () => '*BOUNDARY_FLUIDM\n' + text };
        const provider = new LsdynaFieldHoverProvider();
        const check = async () => {
            const hover = await provider.provideHover(doc, { line: 1, character: 35 });
            assert.ok(hover.contents[0].value.includes('**ICURV**'));
            assert.ok(hover.contents[0].value.includes('**BESIMF**'));
            const card = resolve(doc, 1).cardInfo.card;
            const comment = generateCommentLine(card);
            assert.ok(comment.toUpperCase().includes('ICURV [31-40]'));
            assert.ok(comment.toUpperCase().includes('BESIMF [31-40]'));
            return card.slice(3).map(field => field.rawValue);
        };
        await check();
        text = original.slice(0,30) + '         1' + original.slice(40); doc.version++;
        assert.deepEqual(await check(), ['1','1']);
        text = original; doc.version++;
        assert.deepEqual(await check(), [original.slice(30,40).trim(),original.slice(30,40).trim()]);
    });
    it('previews shared standard edits, reopens them and preserves adjacent records', () => {
        for (const keyword of Object.keys(windows)) {
            const task = tasks.find(task => task.keyword === keyword && task.format === 'standard');
            const rows = task.lines.slice(1);
            const makeDoc = records => ({ ...fakeDoc(['*' + keyword, ...records, '*NODE', '     999       1       2       3'].join('\n'), `/window-apply/${keyword}.k`), version: 1 });
            const document = makeDoc(rows), editor = { document, selection: { active: { line: 1, character: 0 } } };
            const before = model(editor, 1, {});
            const field = before.managerCards[0].fields[0];
            if (keyword === 'IGA_INTEGRATION_SHELL_REDUCE') {
                assert.equal(field.editable, false);
                assert.equal(edit(before, field.fieldId, '42'), null);
                continue; // Read-window evidence does not expand this unsorted card's write permission.
            }
            assert.ok(field.editable, keyword);
            const staged = edit(before, field.fieldId, '42');
            assert.ok(staged, keyword);
            const after = model(editor, 1, staged);
            assert.equal(after.plan.status, 'ready', `${keyword}: ${after.plan.reason}`);
            const saved = after.plan.replacementRecords.map(record => record.text);
            assert.equal(saved.length, rows.length, keyword);
            for (let index = 1; index < rows.length; index++) assert.equal(saved[index], rows[index]);
            const [p,w] = windows[keyword][0][0];
            assert.equal(saved[0].slice(0,p), rows[0].slice(0,p).padEnd(p));
            assert.equal(saved[0].slice(p+w), rows[0].slice(p+w));
            const reopened = makeDoc(saved);
            const info = resolve(reopened,1).cardInfo;
            assert.equal(info.card[0].rawValue, '42', keyword);
            assert.ok(reopened.getText().endsWith('*NODE\n     999       1       2       3'));
            assert.equal(document.getText(), makeDoc(rows).getText());
        }
    });
    it('generates nonoverlapping template placeholders and verifies native retained values independently', () => {
        const { nativeKeywordTemplate } = require("../../../out/core/completion/nativeKeywordTemplate");
        const expand = text => text.replace(/\$\{\d+:((?:\\.|[^\\}])*)\}/g, (_, value) => value.replace(/\\([\\$}])/g, '$1'));
        for (const keyword of Object.keys(windows)) {
            const template = nativeKeywordTemplate(keyword);
            assert.equal(template.status, 'native-layout');
            const stops = [...template.body.join('\n').matchAll(/\$\{(\d+):/g)].map(match => match[1]);
            assert.equal(new Set(stops).size, stops.length);
            const text = template.body.slice(0,-1).map(expand).join('\n');
            const doc = { ...fakeDoc(text, `/window-template/${keyword}.k`), version:1 };
            let cardIndex = 0;
            for (let line = 1; line < doc.lineCount; line++) {
                if (doc.lineAt(line).text.startsWith('$')) continue;
                const info = resolve(doc,line).cardInfo;
                assert.ok(info, keyword);
                assert.deepEqual(info.card.map(field => [field.p,field.w]), windows[keyword][cardIndex++]);
                for (const field of info.card) assert.ok(text.toUpperCase().includes(field.n), `${keyword}: header ${field.n}`);
            }
            assert.equal(cardIndex, windows[keyword].length);
        }
        const observed = JSON.parse(zlib.gunzipSync(fs.readFileSync('test/fixtures/public-behavior/windowValues-reader-cases.json.gz')));
        // Expected retained numbers are explicit; neither the template generator
        // nor the production parser computes this correctness oracle.
        assert.deepEqual(observed,
            [[10001,0,0,1],[10002,0,0],[0,0,0,0],[0,0,0,0],[10003,10003],[10004,0,0,0,0],[10005,0,0],[10006,0,0,0]]);
    });
    it('keeps separately observed same-header instances distinct in parsing and manager selection', () => {
        const repeatTasks = JSON.parse(zlib.gunzipSync(fs.readFileSync('test/fixtures/public-behavior/windowRepeat-reader-cases.json.gz')));
        for (const task of repeatTasks) {
            const doc = { ...fakeDoc(task.lines.join('\n'), `/window-repeat/${task.keyword}.k`), version:1 };
            const count = windows[task.keyword].length;
            for (const [index, record] of task.expectedRecords.entries()) {
                const info = resolve(doc,record.lineOffset).cardInfo;
                assert.equal(info.nativeInstanceStart, index < count ? 0 : count);
                assert.deepEqual(info.card.map(field => field.nativeIdentity.fieldRecordId), record.fields.map(field => field.address));
            }
            const line = task.expectedRecords[count].lineOffset;
            const view = model({ document:doc, selection:{ active:{ line, character:0 } } },line,{});
            assert.equal(view.managerCards[0].fields[0].value, task.expectedRecords[count].fields[0].value, task.keyword);
            assert.equal(view.managerCards[0].line, line);
        }
    });
    it('keeps fixed identities for unknown parameters and honors cancellation', async () => {
        const doc = { ...fakeDoc('*BOUNDARY_FLUIDM\n' + '         1'.repeat(3) + '   &METHOD', '/window-parameter.k'), version:1 };
        const provider = new LsdynaFieldHoverProvider();
        assert.equal(await provider.provideHover(doc,{line:1,character:35},{isCancellationRequested:true}), null);
        const hover = await provider.provideHover(doc,{line:1,character:35});
        assert.ok(hover.contents[0].value.includes('**ICURV**'));
        assert.ok(hover.contents[0].value.includes('**BESIMF**'));
        assert.deepEqual(resolve(doc,1).cardInfo.card.slice(3).map(field => field.rawValue), ['&METHOD','&METHOD']);
    });
});
