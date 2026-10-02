'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { handleIndexedEntityIdQueryCommand, isEntityReferenceNavigationPosition } = require('../../src/extension')._internals;
const { LsdynaEntityReferenceProvider } = require('../../src/client/providers/entityReferenceProvider');

describe('automatic object-reference queries', () => {
    before(async function () {
        this.timeout(15000); // Cold integrity preparation is measured by the installed-host benchmark.
        assert.equal(await require('../../src/core/references/definitionRegistry').getDefinitionRegistryCatalog().prepare(), true);
        await require('../../src/core/references/familyDefinitionScannerCatalog').prepareFamilyDefinitionScannerCatalog();
    });
    it('ignores the navigation destination but resumes for another field or file', () => {
        const filePath = path.resolve('main.k');
        const location = { filePath, line: 12, startCharacter: 10, endCharacter: 20 };
        const editor = { document: { uri: { fsPath: filePath } }, selection: { active: { line: 12, character: 20 } } };
        assert.equal(isEntityReferenceNavigationPosition(editor, location), true);
        editor.selection.active.character = 21;
        assert.equal(isEntityReferenceNavigationPosition(editor, location), false);
        editor.selection.active = { line: 13, character: 10 };
        assert.equal(isEntityReferenceNavigationPosition(editor, location), false);
        editor.selection.active = { line: 12, character: 10 };
        editor.document.uri.fsPath = path.resolve('other.k');
        assert.equal(isEntityReferenceNavigationPosition(editor, location), false);
    });
    it('keeps the previous result during loading and rejects a superseded result', async () => {
        const model = new LsdynaEntityReferenceProvider();
        const filePath = path.resolve('main.k');
        const scope = { kind: 'single-file', filePath };
        model.publish({ targetKind: 'curve', id: 1, scope }, { state: 'complete', locations: [] });
        let current = true;
        let finish;
        let started;
        const enteredQuery = new Promise(resolve => { started = resolve; });
        const pending = new Promise(resolve => { finish = resolve; });
        const task = handleIndexedEntityIdQueryCommand(
            { loadProjectSnapshot() { throw new Error('must use supplied scope'); } },
            { targetKind: 'curve', id: 2 },
            {
                scope: { ...scope, snapshot: { fileIndexes: new Map() } },
                prepareSnapshot: async snapshot => ({ state: 'ready', snapshot }),
                query: () => { started(); return pending; },
                entityReferenceProvider: model,
                preserveResultsWhileLoading: true,
                isCurrentRequest: () => current,
                presentResult: false,
                silentStatus: true,
                runWithProgress: operation => operation(),
            },
        );
        await enteredQuery;
        assert.equal(model.getActiveSession().identity.id, 1);
        assert.equal(model.getActiveSession().state, 'ready');
        current = false;
        finish({ state: 'complete', locations: [] });
        assert.equal(await task, null);
        assert.equal(model.getActiveSession().identity.id, 1);
        model.dispose();
    });
});

describe('object-reference query recovery', () => {
    for (const outcome of ['cancel', 'throw', 'superseded']) it(`finishes only its own loading state on ${outcome}`, async () => {
        const model = new LsdynaEntityReferenceProvider();
        const scope = { kind: 'single-file', filePath: path.resolve('recovery.k') };
        const identity = { targetKind: 'curve', id: 1, scope };
        const token = { isCancellationRequested: false };
        const task = handleIndexedEntityIdQueryCommand({ loadProjectSnapshot() { throw Error('unexpected'); } }, identity, {
            scope: { ...scope, snapshot: { fileIndexes: new Map() } },
            prepareSnapshot: async snapshot => ({ state: 'ready', snapshot }),
            query: async () => {
                if (outcome === 'throw') throw Error('query failed');
                if (outcome === 'superseded') model.publish(identity, { state: 'loading', locations: [] });
                token.isCancellationRequested = true;
                return { state: 'cancelled', locations: [] };
            },
            entityReferenceProvider: model, presentResult: false, silentStatus: true,
            runWithProgress: operation => operation(null, token),
        });
        if (outcome === 'throw') await assert.rejects(task, /query failed/);
        else assert.equal(await task, null);
        assert.equal(model.getActiveSession().state, outcome === 'superseded' ? 'loading' : 'needs-refresh');
        model.dispose();
    });
});


describe('reference query cancellation forwarding', () => {
    it('passes the token to snapshot preparation and stops before querying after cancellation', async () => {
        const token = { isCancellationRequested: false };
        let queries = 0;
        const result = await handleIndexedEntityIdQueryCommand({ loadProjectSnapshot() { throw Error('unexpected'); } },
            { targetKind: 'curve', id: 101 }, {
                scope: { kind: 'single-file', filePath: path.resolve('cancel-prepare.k'), snapshot: { fileIndexes: new Map() } },
                prepareSnapshot: async (snapshot, received) => { assert.strictEqual(received, token); token.isCancellationRequested = true; return { state: 'ready', snapshot }; },
                query: async () => { queries++; return { state: 'complete', locations: [] }; },
                runWithProgress: operation => operation(null, token), silentStatus: true, presentResult: false,
            });
        assert.equal(result, null); assert.equal(queries, 0);
    });
});
