'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { fakeDoc } = require('./helpers');
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve,
    buildKeywordOptionViewModel: model, cacheReferenceIndexFromSnapshot, clearReferenceIndexCacheForTesting } = require('../out/extension')._internals;
const grammar = require('../keywords/lspp-generic-file-readers.json');
const fixtures = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/public-behavior/generic-reader-cases.json.gz'))));

describe('shared generic native file readers', () => {
    afterEach(() => clearReferenceIndexCacheForTesting());

    it('matches native field identities and literal input values through real hover and manager source mapping', async function () {
        this.timeout(30000);
        const provider = new LsdynaFieldHoverProvider();
        for (const bundle of fixtures) {
            const tasks = new Map(bundle.tasks.map(task => [task.id, task]));
            for (const job of bundle.jobs) {
                const documentPath = path.resolve('out/native-batch-regression', String(job.id), `job-${job.id}.k`);
                const doc = { ...fakeDoc(job.input, documentPath), version: 1 };
                if (job.tasks.some(id => tasks.get(id).keywordLineOffset)) {
                    const { collectBlocksFromLineReader } = require('../out/core/parser/blockScanner');
                    const { scanParameterEventsFromFileIndex } = require('../out/core/references/parameterDefinitionScanner');
                    const keywordBlocks = collectBlocksFromLineReader(doc.lineCount, line => doc.lineAt(line).text);
                    const parameterEvents = await scanParameterEventsFromFileIndex({ keywordBlocks }, block =>
                        Promise.resolve(Array.from({ length: block.endLine - block.startLine + 1 }, (_, i) => doc.lineAt(block.startLine + i).text).join('\n')));
                    const fileIndex = { filePath: doc.uri.fsPath, documentVersion: 1, keywordBlocks, parameterEvents,
                        referenceDefinitions: { curves: [], tables: [] } };
                    cacheReferenceIndexFromSnapshot({ rootFile: doc.uri.fsPath, files: [doc.uri.fsPath],
                        graph: { includeOccurrences: [] }, fileIndexes: new Map([[doc.uri.fsPath, fileIndex]]) });
                }
                const reads = new Map(job.reads.map(read => [read.sourceLine, read]));
                let start = 1;
                for (const id of job.tasks) {
                    const task = tasks.get(id), first = new Map();
                    let manager;
                    for (const record of task.expectedRecords) {
                        const line = start + record.lineOffset;
                        if (!first.has(record.caseId)) {
                            first.set(record.caseId, record.lineOffset - 1 - Number(task.keyword.endsWith('_TITLE')) - (task.keywordLineOffset || 0));
                            manager = model({ document: doc, selection: { active: { line, character: 0 } } }, line, {});
                            assert.notEqual(manager.plan.status, 'blocked', `${task.keyword}: ${manager.plan.reason}`);
                            if (task.keywordLineOffset) assert.deepEqual(manager.plan.replacementRecords.map(r => r.text),
                                task.lines.slice(task.keywordLineOffset + 1), 'reading parameters must not write evaluated values back');
                        }
                        const info = resolve(doc, line).cardInfo;
                        assert.ok(info, `${task.keyword} ${task.format} ${record.caseId} line ${line}: ${resolve(doc, line).reason}`);
                        assert.equal(info.nativeInstanceStart, first.get(record.caseId));
                        assert.deepEqual(info.card.map(f => f.nativeIdentity.fieldRecordId), reads.get(line).fields.map(f => f.descriptorAddress));
                        const managerCard = manager.managerCards.find(c => c.line === line);
                        assert.ok(managerCard, `manager source line ${line}`);
                        assert.deepEqual(managerCard.fields.map(f => f.value), record.fields.map(f => f.value));
                        for (const [i, expected] of record.fields.entries()) {
                            const field = info.card[i];
                            assert.equal(field.rawValue, expected.value);
                            assert.equal(field.t, expected.type === 1 ? 'integer' : expected.type === 2 ? 'real' : 'string');
                            const hover = await provider.provideHover(doc, { line, character: field.p });
                            assert.ok(hover?.contents[0].value.includes(`**${field.n}**`), `${task.keyword} ${field.n}`);
                            assert.equal(hover.range.start.character, field.nativeRange.start);
                            assert.equal(hover.range.end.character, field.nativeRange.end);
                        }
                    }
                    start += task.lines.length;
                }
            }
        }
    });

    it('keeps unknown-control prefixes and ignores ordinary or misleading field comments', () => {
        for (const keyword of ['DEFINE_CURVE_STRESS', 'EM_CIRCUIT']) for (const control of ['&missing', '0xB', '4294967307', '11.0']) for (const comments of ['', '$ ordinary\n', '   $# WRONG TITLE\n$HMNAME metadata\n']) {
            const source = `*${keyword}\n1,${control}\n${comments}1,2,3,4,5,6,7,8\n*END`;
            const doc = fakeDoc(source);
            assert.ok(resolve(doc, 1).cardInfo);
            assert.equal(resolve(doc, source.split('\n').length - 2).cardInfo, null);
        }
    });

    it('preserves source instance identities when shrinking a draft and keeps unverified tail initialization closed', () => {
        const { selectNativeFileLayout } = require("../out/core/semantics/catalogNativeFileLayout");
        const rows = ['1,11', '2,3,4,5,6,7,8,9', '2,0'];
        const selection = selectNativeFileLayout('generic-stress-curve', rows, false,
            row => rows[row]?.split(',')[1] || '', record => record.instanceStart === 0 ? '1' : '0');
        assert.deepEqual(selection.current.map(r => [r.cardIndex, r.instanceStart]), [[1,0],[2,0],[1,2]]);
        assert.deepEqual(selection.target.map(r => [r.cardIndex, r.instanceStart]), [[1,0],[1,2]]);
        assert.equal(selectNativeFileLayout('generic-stress-curve', ['1,0','2,0'], false, () => '0', () => '11'), null);
    });

    it('explains the earlier EOS controller, resets on a new header and keeps input comments independent', () => {
        const task = fixtures[1].tasks.find(t => t.keyword === 'EOS_LEE-TARVER' && t.format === 'comma');
        for (const comment of ['', '$# WRONG HEADER', '   $ ordinary comment']) {
            const lines = [], physical = [];
            task.lines.forEach((text, index) => {
                if (index && comment) lines.push(comment);
                physical[index] = lines.length;
                lines.push(text);
            });
            const second = task.expectedRecords.filter(r => r.caseId === task.caseIds[1]);
            const record = second.at(-1);
            const doc = fakeDoc([...lines, '*END'].join('\n'));
            const info = resolve(doc, physical[record.lineOffset]).cardInfo;
            assert.equal(info.nativeCardIndex, 6);
            assert.ok(info.nativeConditions.includes('EOSUNRE=2 (earlier instance)'));
            const isolated = fakeDoc(['*EOS_LEE-TARVER', ...second.slice(0,5).map(r => task.lines[r.lineOffset]), '*END'].join('\n'));
            assert.equal(resolve(isolated, 5).cardInfo.nativeCardIndex, 5);
        }
    });
});
