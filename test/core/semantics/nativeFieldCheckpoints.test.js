'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require("../../support/helpers");
const schema = require("../../../out/core/keywordSchema");
const { LsdynaFieldHoverProvider, cacheReferenceIndexFromSnapshot, clearReferenceIndexCacheForTesting } = require("../../../out/extension")._internals;
const options = { keywordLine: 0, globalInputFormat: 'standard' };

describe('native fixed-record checkpoints', () => {
    afterEach(() => clearReferenceIndexCacheForTesting());
    it('counts a million physical lines in bounded resumable steps without retaining their text', async function () {
        this.timeout(20000);
        let reads = 0;
        const doc = { version: 1, lineCount: 1000001, lineAt(line) {
            reads++;
            return { text: line === 0 ? '*EOS_GRUNEISEN' : line === 1000000 ? '*END' :
                line % 3 === 1 ? '$# WRONG FIELD TITLES' : line % 3 === 2 ? '1,2,3,4,5,6,7,8' : '2,3' };
        } };
        const first = schema.resolveCardForDocumentLine(doc, 999999, undefined, options);
        assert.equal(first.reason, 'field-context-checkpoint-pending');
        assert.ok(reads <= 256);
        let yielded = false;
        setImmediate(() => { yielded = true; });
        const result = await schema.resolveCardForDocumentLineAsync(doc, 999999, undefined, options);
        assert.equal(yielded, true);
        assert.equal(result.status, 'resolved');
        assert.equal(result.cardInfo.nativeCardIndex, 2);
        assert.equal(result.cardInfo.nativeInstanceStart, 666664);
        assert.equal(result.cardInfo.observedDataLineOrdinal, 666666);
        const before = reads;
        const repeated = await schema.resolveCardForDocumentLineAsync(doc, 999999, undefined, options);
        assert.equal(repeated.cardInfo, result.cardInfo);
        assert.equal(reads, before, 'mouse movement in a cached row never rescans');
        const context = schema.readCardContext(doc, 999999, schema.loadKeywordSchema(), options);
        assert.equal(context.context.recordOrdinalOnly, true);
        assert.deepEqual(context.context.observedDataLines, []);
        const earlier = await schema.resolveCardForDocumentLineAsync(doc, 12345, undefined, options);
        assert.equal(earlier.cardInfo.nativeInstanceStart, 8228);
        assert.ok(reads - before < 4096, 'backward reads reuse sparse checkpoints');
    });

    it('cancels between chunks, resumes later and discards results across version changes', async () => {
        let reads = 0;
        const doc = { version: 1, lineCount: 20002, lineAt(line) {
            reads++; return { text: line === 0 ? '*EOS_GRUNEISEN' : line === 20001 ? '*END' : '1,2,3,4,5,6,7,8' };
        } };
        const token = { isCancellationRequested: false };
        setImmediate(() => { token.isCancellationRequested = true; });
        assert.equal((await schema.resolveCardForDocumentLineAsync(doc, 20000, undefined, { ...options, cancellationToken: token })).reason, 'field-context-cancelled');
        assert.ok(reads <= 256);
        const resumed = await schema.resolveCardForDocumentLineAsync(doc, 20000, undefined, options);
        assert.equal(resumed.cardInfo.nativeInstanceStart, 19998);
        doc.version++;
        setImmediate(() => { doc.version++; });
        assert.equal((await schema.resolveCardForDocumentLineAsync(doc, 20000, undefined, options)).reason, 'field-context-version-changed');
        assert.equal((await schema.resolveCardForDocumentLineAsync(doc, 20000, undefined, options)).cardInfo.nativeInstanceStart, 19998);
    });

    it('keeps byte limits terminal and retains actual conditional records between chunks', async () => {
        const tiny = { ...fakeDoc('*EOS_GRUNEISEN\n1,2,3\n4,5'), version: 1 };
        assert.equal((await schema.resolveCardForDocumentLineAsync(tiny, 2, undefined,
            { ...options, maximumPhysicalLines: 2 })).reason, 'field-context-line-limit');
        const huge = { ...fakeDoc('*EOS_GRUNEISEN\n' + '1'.repeat(65537)), version: 1 };
        assert.equal((await schema.resolveCardForDocumentLineAsync(huge, 1, undefined, options)).reason, 'field-context-byte-limit');
        const doc = { ...fakeDoc('*EOS_GRUNEISEN\n' + '1'.repeat(200) + '\n2,3'), version: 1 };
        assert.equal((await schema.resolveCardForDocumentLineAsync(doc, 2, undefined, { ...options, maximumInputBytes: 100 })).reason, 'field-context-byte-limit');
        const beam = { ...fakeDoc(['*SECTION_BEAM', ...Array(1000).fill('1,2'), '*END'].join('\n')), version: 1 };
        const result = await schema.resolveCardForDocumentLineAsync(beam, 1000, undefined, options);
        assert.equal(result.cardInfo.nativeInstanceStart, 998);
        assert.equal(result.cardInfo.card[0].n, 'A');
        const token = { isCancellationRequested: false };
        beam.version++;
        setImmediate(() => { token.isCancellationRequested = true; });
        assert.equal((await schema.resolveCardForDocumentLineAsync(beam, 1000, undefined,
            { ...options, cancellationToken: token })).reason, 'field-context-cancelled');
        assert.equal((await schema.resolveCardForDocumentLineAsync(beam, 1000, undefined, options)).cardInfo.card[0].n, 'A');
        beam.version++;
        setImmediate(() => { beam.version++; });
        assert.equal((await schema.resolveCardForDocumentLineAsync(beam, 1000, undefined, options)).reason, 'field-context-version-changed');
        const oversized = { ...fakeDoc(['*SECTION_BEAM', ...Array(5000).fill('1,2'), '*END'].join('\n')), version: 1 };
        assert.equal((await schema.resolveCardForDocumentLineAsync(oversized, 5000, undefined, options)).reason, 'field-context-record-limit');
    });

    it('continues through the real hover provider using a current-version block index', async () => {
        const doc = { ...fakeDoc(['*EOS_GRUNEISEN', ...Array(4000).fill('1,2,3,4,5,6,7,8'), '*END'].join('\n'), 'D:/temp/native-checkpoint.k'), version: 1 };
        const fileIndex = { filePath: doc.uri.fsPath, documentVersion: 1,
            keywordBlocks: [{ keyword: '*EOS_GRUNEISEN', startLine: 0, endLine: 4000 }],
            parameterEvents: [], referenceDefinitions: { curves: [], tables: [] } };
        cacheReferenceIndexFromSnapshot({ rootFile: doc.uri.fsPath, files: [doc.uri.fsPath], graph: { includeOccurrences: [] }, fileIndexes: new Map([[doc.uri.fsPath, fileIndex]]) });
        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 4000, character: 0 });
        assert.ok(hover?.contents[0].value.includes('**V0**'));
        assert.equal(hover.range.start.character, 0);
        assert.equal(hover.range.end.character, 1);
    });
});
