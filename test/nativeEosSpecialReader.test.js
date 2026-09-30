'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { fakeDoc } = require('./helpers');
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve,
    buildKeywordOptionViewModel: model, cacheReferenceIndexFromSnapshot, clearReferenceIndexCacheForTesting } = require('../out/extension')._internals;
const fixtures = require('./fixtures/public-behavior/eos-special-readers.json');

describe('native EOS special readers', () => {
    afterEach(() => clearReferenceIndexCacheForTesting());
    it('maps every native field through shared parsing, real hover and source manager', async function () {
        this.timeout(60000);
        const provider = new LsdynaFieldHoverProvider();
        for (const bundle of fixtures) for (const job of bundle.jobs) {
            const doc = { ...fakeDoc(job.input, path.resolve('out/eos-special-regression', String(fixtures.indexOf(bundle)), `${job.id}.k`)), version: 1 };
            const { collectBlocksFromLineReader } = require('../out/core/parser/blockScanner');
            const { scanParameterEventsFromFileIndex } = require('../out/core/references/parameterDefinitionScanner');
            const keywordBlocks = collectBlocksFromLineReader(doc.lineCount, line => doc.lineAt(line).text);
            const parameterEvents = await scanParameterEventsFromFileIndex({ keywordBlocks }, block =>
                Promise.resolve(Array.from({ length: block.endLine - block.startLine + 1 }, (_, i) => doc.lineAt(block.startLine + i).text).join('\n')));
            const fileIndex = { filePath: doc.uri.fsPath, documentVersion: 1, keywordBlocks, parameterEvents, referenceDefinitions: { curves: [], tables: [] } };
            cacheReferenceIndexFromSnapshot({ rootFile: doc.uri.fsPath, files: [doc.uri.fsPath], graph: { includeOccurrences: [] }, fileIndexes: new Map([[doc.uri.fsPath, fileIndex]]) });
            const reads = new Map(job.reads.map(record => [record.sourceLine, record]));
            let start = 1;
            for (const id of job.tasks) {
                const task = bundle.plan.tasks.find(t => t.id === id);
                const line = start + task.expectedRecords[0].lineOffset;
                const manager = model({ document: doc, selection: { active: { line, character: 0 } } }, line, {});
                const malformed = task.expectedRecords.some(r => r.fields.some(f => f.value === '3junk'));
                if (malformed) assert.equal(manager.plan.status, 'blocked', 'field recognition must not expand numeric write permissions');
                else {
                    assert.notEqual(manager.plan.status, 'blocked', `${task.keyword} ${task.format} ${id}: ${manager.plan.reason}`);
                    assert.deepEqual(manager.plan.replacementRecords.map(r => r.text), task.lines.slice(task.keywordLineOffset + 1));
                }
                for (const record of task.expectedRecords) {
                    const line = start + record.lineOffset, info = resolve(doc, line).cardInfo;
                    assert.ok(info, `${task.keyword} ${task.format} ${id}: ${resolve(doc, line).reason}`);
                    assert.equal(info.nativeInstanceStart, 0);
                    assert.deepEqual(info.card.map(f => f.nativeIdentity.fieldRecordId), reads.get(line).fields.map(f => f.descriptorAddress));
                    assert.deepEqual(info.card.map(f => f.rawValue), record.fields.map(f => f.value));
                    if (!malformed) assert.deepEqual(manager.managerCards.find(c => c.line === line).fields.map(f => f.value), record.fields.map(f => f.value));
                    for (const [index, field] of info.card.entries()) {
                        const expected = reads.get(line).fields[index];
                        assert.equal(field.t, reads.get(line).fields[index].type === 1 ? 'integer' : 'real');
                        const width = task.format === 'long' ? 20 : expected.width;
                        const position = task.format === 'comma' ? record.fields.slice(0, index).reduce((n, f) => n + f.value.length + 1, 0)
                            : task.format === 'long' ? index * 20 : expected.position;
                        const hover = await provider.provideHover(doc, { line, character: field.p });
                        assert.ok(hover?.contents[0].value.includes(`**${field.n}**`), field.n);
                        assert.equal(hover.range.start.character, position);
                        assert.equal(hover.range.end.character, position + (task.format === 'comma' ? record.fields[index].value.length : width));
                    }
                }
                start += task.lines.length;
            }
        }
    });

    it('checks whole draft records and keeps branch migration closed without changing source hover', () => {
        for (const task of fixtures[1].plan.tasks) {
            const doc = fakeDoc([...task.lines, '*END'].join('\n'));
            const line = task.expectedRecords[1].lineOffset;
            const editor = { document: doc, selection: { active: { line, character: 0 } } };
            const base = model(editor, line, {});
            const card = base.managerCards.find(c => c.line === line);
            const field = card.fields[1];
            const edited = model(editor, line, { fieldDrafts: { [field.fieldId]: '2' } });
            assert.equal(edited.plan.status === 'blocked', task.format !== 'comma', 'blank OPT allows atof to read the following fixed field');
            if (task.format === 'comma') assert.equal(edited.plan.replacementRecords[line - 1].text.split(',')[1], '2');
            assert.equal(resolve(doc, line).cardInfo.card[1].n, task.format === 'comma' ? 'QT' : 'Q0');
            const raw = model(editor, line, { recordDrafts: { [field.fieldId.replace(/:field:\d+$/, '')]: '2,1,2,3,4,5,6,7' } });
            assert.equal(raw.plan.status === 'blocked', task.format !== 'comma');
            for (const invalid of ['2,1,2,3,4,5,6,7,8', '2,\n1,2,3,4,5,6,7']) {
                const rejected = model(editor, line, { recordDrafts: { [field.fieldId.replace(/:field:\d+$/, '')]: invalid } });
                assert.equal(rejected.plan.status, 'blocked', 'comma drafts still reject invalid field counts and control characters');
            }
            if (task.format === 'comma') {
                const badNumber = model(editor, line, { recordDrafts: { [field.fieldId.replace(/:field:\d+$/, '')]: '2,bad,2,3,4,5,6,7' } });
                assert.ok(badNumber.managerCards.some(c => c.fields.some(f => f.diagnostic?.code === 'number')));
                const badChoice = model(editor, line, { recordDrafts: { [field.fieldId.replace(/:field:\d+$/, '')]: '9,1,2,3,4,5,6,7' } });
                assert.ok(badChoice.managerCards.some(c => c.fields.some(f => f.diagnostic?.code === 'choice')));
            } else {
                for (const invalid of ['2,bad,2,3,4,5,6,7', '9,1,2,3,4,5,6,7']) {
                    const rejected = model(editor, line, { recordDrafts: { [field.fieldId.replace(/:field:\d+$/, '')]: invalid } });
                    assert.equal(rejected.plan.status, 'blocked');
                }
            }
        }
    });

    it('uses raw record prefixes, ignores annotations and retains repeated source identities', () => {
        for (const annotation of ['', '$# OPT Q0 QA\n', '$ ordinary\n$HMNAME metadata\n']) {
            for (const [prefix, card, field] of [['3',3,'Q0'], ['&missing',2,'QT']]) {
                const doc = fakeDoc(`*EOS_JWL_AFTERBURN\n1,2,3,4,5,6,7,8\n${annotation}${prefix},1,2,3,4,5,6,7\n*END`);
                const info = resolve(doc, doc.lineCount - 2).cardInfo;
                assert.equal(info.nativeCardIndex, card);
                assert.equal(info.card[1].n, field);
                assert.deepEqual(info.nativeConditions, [`raw record prefix (float32)${card === 3 ? '=' : '≠'}3`]);
            }
        }
        const doc = fakeDoc('*EOS_USER_DEFINED\n1,1,&missing,1,1,1,1,1\n2,3\n4,5\n*END');
        assert.equal(resolve(doc, 2).cardInfo.card[0].n, 'P1');
        assert.equal(resolve(doc, 3).cardInfo.card[0].nativeIdentity.recordKey, 'instance:0:card:2:repeat:1');
        const { selectNativeFileLayout } = require("../out/core/semantics/catalogNativeFileLayout");
        const rows = ['1,2', '                   3'];
        assert.equal(selectNativeFileLayout('eos-afterburn', rows, false, () => '', undefined, false, false, 3,
            undefined, () => '                   2'), null, 'changing a later field can change the raw prefix');
        assert.equal(selectNativeFileLayout('eos-afterburn', ['1,2', '0x3'], false, () => '', undefined, false, true, 3).current.length, 1);
    });
});
