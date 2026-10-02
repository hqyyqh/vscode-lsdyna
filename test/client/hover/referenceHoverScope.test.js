'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { fakeDoc, vscodeMock } = require("../../support/helpers");
const api = require("../../../out/extension")._internals;
const text = ['*LOAD_BODY_Z', '         1         1', '*DEFINE_CURVE', '         1',
    '                   0                   1', '                   5                   1',
    '*DEFINE_TABLE_2D', '         2', '                   0                   1',
    '*DEFINE_TABLE', '         3', '                   0',
    '*DEFINE_CURVE', '         4', '                   0                   1', '                   5                   1',
    '*DEFINE_TABLE_3D', '         5', '                   0                   3'].join('\n');
const svg = hover => JSON.stringify(hover)?.includes('data:image/svg+xml;base64,');

describe('Hover after project snapshot cache rejection', () => {
    let doc, snapshot;
    beforeEach(async () => {
        api.clearReferenceIndexCacheForTesting();
        api.setReferenceSnapshotLoaderForTesting(null);
        doc = { ...fakeDoc(text, path.resolve('scope-hover.k')), version: 1 };
        snapshot = (await api.getReferenceIndexForDocument(doc)).snapshot;
        assert.equal(api.cacheReferenceIndexFromSnapshot(snapshot, { maxBytes: 1 }), false);
    });
    afterEach(() => {
        api.clearReferenceIndexCacheForTesting();
        api.setReferenceSnapshotLoaderForTesting(null);
    });

    it('restores curve and table definition and reference previews without increasing the cache budget', async () => {
        let loads = 0;
        api.setReferenceSnapshotLoaderForTesting(async root => {
            assert.equal(root, snapshot.rootFile); loads++; return snapshot;
        });
        const provider = new api.LsdynaFieldHoverProvider();
        for (const [line, character] of [[1, 9], [2, 2], [6, 2], [18, 39]]) {
            const hover = await provider.provideHover(doc, { line, character });
            assert.ok(svg(hover), `line ${line + 1}: ${JSON.stringify(hover).slice(0, 3000)}`);
        }
        assert.equal(loads, 4);
        assert.equal(api.getMainDeckContextForDocumentPath(doc.uri.fsPath).project.snapshot, undefined);
    });

    it('keeps ambiguous scopes separate and loads only the explicitly selected main deck', async () => {
        api.clearReferenceIndexCacheForTesting();
        const roots = ['a.k', 'b.k'].map(name => path.resolve(name));
        for (const rootFile of roots) api.cacheReferenceIndexFromSnapshot({ ...snapshot, rootFile,
            files: [rootFile, doc.uri.fsPath] }, { maxBytes: 1 });
        const loads = [];
        api.setReferenceSnapshotLoaderForTesting(async rootFile => {
            loads.push(rootFile); return { ...snapshot, rootFile, files: [rootFile, doc.uri.fsPath] };
        });
        const ambiguous = await api.getReferenceIndexForDocument(doc);
        assert.equal(ambiguous.projectContextAmbiguous, true);
        assert.deepEqual(ambiguous.candidateRootFiles, roots);
        assert.deepEqual(loads, []);
        const pick = vscodeMock.window.showQuickPick, info = vscodeMock.window.showInformationMessage;
        vscodeMock.window.showQuickPick = async items => items.find(item => item.rootFile === roots[1]);
        vscodeMock.window.showInformationMessage = async () => {};
        try { assert.equal(await api.handleSelectMainDeckContextCommand(doc.uri.fsPath), true); }
        finally { vscodeMock.window.showQuickPick = pick; vscodeMock.window.showInformationMessage = info; }
        const selected = await api.getReferenceIndexForDocument(doc);
        assert.equal(selected.rootFile, roots[1]);
        assert.equal(selected.projectContextSelected, true);
        assert.deepEqual(loads, [roots[1]]);
    });

    it('fails explicitly for unavailable or wrong-project snapshots rather than using local data as a project', async () => {
        for (const result of [null, { ...snapshot, rootFile: path.resolve('wrong.k') },
            { ...snapshot, files: [] }, { ...snapshot, scope: 'single-file' }]) {
            api.setReferenceSnapshotLoaderForTesting(async () => result);
            const state = await api.getReferenceIndexForDocument(doc);
            assert.equal(state.unavailable, true);
            assert.equal(state.referenceIndex, undefined);
            assert.deepEqual(state.incompleteReasons, ['project-scan-unavailable']);
        }
    });

    it('returns an unavailable state when the existing snapshot loader fails', async () => {
        const log = console.error;
        console.error = () => {};
        api.setReferenceSnapshotLoaderForTesting(async () => { throw new Error('read failed'); });
        try {
            const state = await api.getReferenceIndexForDocument(doc);
            assert.equal(state.unavailable, true);
            assert.deepEqual(state.incompleteReasons, ['project-scan-unavailable']);
        } finally { console.error = log; }
    });

    for (const change of ['cancel', 'edit', 'invalidate']) it(`discards a snapshot after ${change}`, async () => {
        const token = { isCancellationRequested: false };
        api.setReferenceSnapshotLoaderForTesting(async (root, options, progress, passedToken) => {
            assert.equal(passedToken, token);
            if (change === 'cancel') token.isCancellationRequested = true;
            if (change === 'edit') doc.version++;
            if (change === 'invalidate') api.clearReferenceIndexForRoot(snapshot.rootFile);
            return snapshot;
        });
        assert.equal(await api.getReferenceIndexForDocument(doc, token), null);
    });
});
