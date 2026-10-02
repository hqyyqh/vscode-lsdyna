'use strict';
const assert = require('node:assert/strict');
const { fakeDoc, vscodeMock } = require("../../support/helpers");
const { analyzeReference } = require('../../../out/core/references/projectReferenceIndex');
const {
    getReferenceIndexForDocument, getFileIndexForDocument,
    buildLiveRegistryReferenceFileIndex, cacheReferenceIndexFromSnapshot,
    clearReferenceIndexCacheForTesting,
} = require('../../../out/extension')._internals;

describe('asynchronous reference input identity', () => {
    beforeEach(clearReferenceIndexCacheForTesting);
    afterEach(clearReferenceIndexCacheForTesting);
    const document = () => Object.assign(fakeDoc('*DEFINE_CURVE\n         1\n                 0.0                 0.0\n*END', '/read-identity/main.k'), {
        version: 1, isClosed: false, isDirty: true,
    });
    for (const change of ['version', 'close']) {
        it(`does not cache a local scan after a document ${change} change`, async () => {
            const doc = document();
            const pending = getReferenceIndexForDocument(doc);
            queueMicrotask(() => change === 'version' ? doc.version++ : doc.isClosed = true);
            assert.equal(await pending, null);
            assert.ok(!getFileIndexForDocument(doc));
        });
        it(`does not return a dirty overlay after a document ${change} change`, async () => {
            const doc = document();
            const pending = buildLiveRegistryReferenceFileIndex(doc, null);
            queueMicrotask(() => change === 'version' ? doc.version++ : doc.isClosed = true);
            assert.equal(await pending, null);
        });
    }
    it('discards a local scan if its main-deck context changes while awaiting input', async () => {
        const doc = document();
        const pending = getReferenceIndexForDocument(doc);
        queueMicrotask(() => cacheReferenceIndexFromSnapshot({
            rootFile: '/read-identity/root.k', files: ['/read-identity/root.k', doc.uri.fsPath],
            graph: { includeOccurrences: [] }, fileIndexes: new Map(),
        }));
        assert.equal(await pending, null);
    });
    it('uses dirty curve definitions instead of a cached project definition', async () => {
        const doc = document();
        const previous = vscodeMock.workspace.textDocuments;
        vscodeMock.workspace.textDocuments = [doc];
        try {
            cacheReferenceIndexFromSnapshot({
                rootFile: doc.uri.fsPath, files: [doc.uri.fsPath], graph: { includeOccurrences: [] },
                fileIndexes: new Map([[doc.uri.fsPath, {
                    filePath: doc.uri.fsPath, keywordBlocks: [{ keyword: '*DEFINE_CURVE', startLine: 0, endLine: 2 }],
                    referenceDefinitions: { curves: [{ kind: 'curve', keyword: '*DEFINE_CURVE', id: 9,
                        filePath: doc.uri.fsPath, startLine: 0, endLine: 2, points: [] }], tables: [], genericDefinitions: [] },
                    parameterEvents: [],
                }]]),
            });
            const state = await getReferenceIndexForDocument(doc);
            assert.ok(state.liveReferenceOverlay);
            const query = id => analyzeReference(state.referenceIndex, { kind: 'numeric', id, raw: String(id) },
                ['curve'], { projectScoped: true, documentPath: doc.uri.fsPath, lineIndex: 1 });
            assert.equal(query(9).definitions.length, 0);
            assert.equal(query(1).definitions.length, 1);
        } finally {
            vscodeMock.workspace.textDocuments = previous;
        }
    });
});
