'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fakeDoc } = require('./helpers');
const { buildFileIndex } = require('../out/core/scanner/fileIndexBuilder');
const { buildProjectReferenceIndex, analyzeIntegerParameterValueAtLocation, analyzeParameterReferenceAtLocation } = require('../out/core/references/projectReferenceIndex');
const { cacheReferenceIndexFromSnapshot, clearReferenceIndexCacheForTesting,
    setMainDeckContextForDocument,
    getCardInfoForDocumentLineWithSuggest: resolve, buildKeywordOptionViewModel: model,
    LsdynaFieldHoverProvider } = require('../out/extension')._internals;

describe('native controller parameter context', () => {
    afterEach(() => clearReferenceIndexCacheForTesting());
    it('resolves the already observed Rnip value through real hover and manager without using headers', async () => {
        const file = path.join(__dirname, 'fixtures/public-behavior/mixed-field-input.k');
        const doc = { ...fakeDoc(fs.readFileSync(file, 'utf8'), file), version: 1, isDirty: false };
        const index = await buildFileIndex(file);
        cacheReferenceIndexFromSnapshot({ rootFile: file, files: [file], graph: { includeOccurrences: [] }, fileIndexes: new Map([[file, index]]) });
        const native = require('./fixtures/public-behavior/mixed-field-records.json');
        const rows = native.observations.filter(o => o.kind === 'fields' && o.sourceLine >= 38 && o.sourceLine <= 41);
        assert.equal(rows.length, 4);
        const provider = new LsdynaFieldHoverProvider();
        for (const row of rows) {
            const info = resolve(doc, row.sourceLine).cardInfo;
            assert.ok(info);
            assert.deepEqual(info.card.map(f => f.nativeIdentity.fieldRecordId), row.fields.map(f => f.descriptorAddress));
            assert.ok(info.nativeConditions.includes('NIP=3'));
            const hover = await provider.provideHover(doc, { line: row.sourceLine, character: info.card[1].p });
            assert.ok(hover.contents[0].value.includes(`**${info.card[1].n}**`));
        }
        const manager = model({ document: doc, selection: { active: { line: 39, character: 0 } } }, 39, {});
        assert.notEqual(manager.plan.status, 'blocked', manager.plan.reason);
        assert.equal(manager.managerCards.filter(card => card.fields.some(field => field.name === 'XI')).length, 3);
        const warm = resolve(doc, 39).cardInfo;
        doc.version = 2; doc.isDirty = true;
        assert.equal(resolve(doc, 39).cardInfo, null, 'never reuse a stale controller across versions');
        assert.ok(resolve(doc, 39).reason.includes('parameter-context-stale'));
        const staleHover = await provider.provideHover(doc, { line: 39, character: 1 });
        const i18n = require('../out/core/i18n');
        assert.ok(staleHover.contents[0].value.includes(i18n.get('referenceReasonParameterContextStale')));
        index.documentVersion = 2;
        cacheReferenceIndexFromSnapshot({ rootFile: file, files: [file], graph: { includeOccurrences: [] }, fileIndexes: new Map([[file, index]]) });
        assert.deepEqual(resolve(doc, 39).cardInfo.card, warm.card);
    });

    it('allows zero for a controller while preserving the reference ID rule and signed values', () => {
        const file = path.resolve('out/parameter-value-test.k');
        const event = value => ({ type: 'definition', keyword: '*PARAMETER', lineIndex: 1, sequence: 0,
            name: 'CTRL', rawName: 'CTRL', parameterType: 'I', rawValue: String(value), value,
            valueState: 'integer', local: false, mutable: false, expression: false });
        const make = value => buildProjectReferenceIndex({ rootFile: file, files: [file], graph: { includeOccurrences: [] }, fileIndexes: new Map([[file, {
            filePath: file, parameterEvents: [event(value)], keywordBlocks: [], referenceDefinitions: { curves: [], tables: [] },
        }]]) });
        const options = { documentPath: file, lineIndex: 2 };
        assert.equal(analyzeIntegerParameterValueAtLocation(make(0), '&CTRL', options).value, 0);
        assert.equal(analyzeParameterReferenceAtLocation(make(0), 'CTRL', options).resolved, false);
        assert.equal(analyzeIntegerParameterValueAtLocation(make(3), '-&CTRL', options).value, -3);
        assert.equal(analyzeIntegerParameterValueAtLocation(make(3), '&CTRL', { ...options, lineIndex: 0 }).resolved, false);
    });

    it('invalidates layout caches when the selected main file changes, and rejects a dirty ancestor', () => {
        const shared = path.resolve('out/shared-parameter-beam.k');
        const roots = [path.resolve('out/root-parameter-a.k'), path.resolve('out/root-parameter-b.k')];
        const doc = { ...fakeDoc('*SECTION_BEAM\n1,&CTRL\n1,2,3,4,5\n*END', shared), version: 1, isDirty: false };
        const child = { filePath: shared, documentVersion: 1, parameterEvents: [],
            keywordBlocks: [{ keyword: '*SECTION_BEAM', startLine: 0, endLine: 2 }], referenceDefinitions: { curves: [], tables: [] } };
        roots.forEach((root, i) => cacheReferenceIndexFromSnapshot({ rootFile: root, files: [root, shared],
            graph: { includeOccurrences: [{ occurrenceId: root + ':child', fromFile: root, filePath: shared, keywordLine: 3, lineIndex: 4 }] },
            fileIndexes: new Map([[shared, child], [root, { filePath: root, parameterEvents: [{
                type: 'definition', keyword: '*PARAMETER', lineIndex: 1, sequence: 0, name: 'CTRL', rawName: 'CTRL',
                parameterType: 'I', rawValue: String(i + 1), value: i + 1, valueState: 'integer', local: false, mutable: false,
            }], referenceDefinitions: { curves: [], tables: [] } }]]) }));
        assert.equal(resolve(doc, 2).cardInfo, null);
        assert.ok(resolve(doc, 2).reason.includes('parameter-main-file-ambiguous'));
        assert.equal(setMainDeckContextForDocument(shared, roots[0]), true);
        assert.equal(resolve(doc, 2).cardInfo.nativeCardIndex, 2);
        const { keywordManagerInstances } = require('../out/extension')._internals;
        const lineAt = doc.lineAt;
        let directoryReads = 0;
        doc.lineAt = line => { directoryReads++; return lineAt(line); };
        keywordManagerInstances(doc, 0, null);
        const firstReads = directoryReads;
        keywordManagerInstances(doc, 2, null);
        assert.equal(directoryReads, firstReads, 'reuse the directory within the same parameter context');
        assert.equal(setMainDeckContextForDocument(shared, roots[1]), true);
        keywordManagerInstances(doc, 0, null);
        assert.ok(directoryReads > firstReads, 'rebuild directory when a different main file supplies parameters');
        assert.equal(resolve(doc, 2).cardInfo.nativeCardIndex, 3);
        const vscode = require('vscode'), previous = vscode.workspace.textDocuments;
        try {
            vscode.workspace.textDocuments = [{ uri: { fsPath: roots[1] }, version: 2, isDirty: true }];
            assert.equal(resolve(doc, 2).cardInfo, null);
            assert.ok(resolve(doc, 2).reason.includes('parameter-context-stale'));
        } finally { vscode.workspace.textDocuments = previous; }
        assert.equal(resolve(doc, 2).cardInfo.nativeCardIndex, 3);
    });
});
