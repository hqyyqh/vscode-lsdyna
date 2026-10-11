'use strict';

const assert = require('assert');
const path = require('node:path');
const vscode = require('vscode');
const {
    LsdynaEntityReferenceProvider,
    entityQueryKey,
} = require('../../../src/client/providers/entityReferenceProvider');

function identity(id, filePath = path.resolve('deck.key'), kind = 'material') {
    return { targetKind: kind, id, scope: { kind: 'single-file', filePath } };
}

function result(filePath = path.resolve('deck.key'), referenceCount = 2) {
    return {
        state: 'complete',
        locations: [
            { role: 'definition', keyword: '*MAT_ELASTIC', fieldName: 'MID', filePath, line: 203, startCharacter: 3, endCharacter: 10 },
            ...Array.from({ length: referenceCount }, (_, index) => ({
                role: 'reference', keyword: '*PART', fieldName: 'MID', filePath,
                line: 195 + index, startCharacter: 23, endCharacter: 30,
            })),
        ],
        reasons: [],
    };
}

function memoryState(initial = []) {
    const values = new Map([['legacy-pinned-state', initial]]);
    const updates = [];
    return {
        values,
        updates,
        get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
        async update(key, value) { updates.push({ key, value }); values.set(key, value); },
    };
}

describe('LsdynaEntityReferenceProvider', () => {
    it('appends worker pages once and rejects pages from a replaced query or revision', async () => {
        const provider = new LsdynaEntityReferenceProvider();
        let finish;
        const first = () => ({ ...result(undefined, 1), revision: 'v1',
            page: { counts: { definition: 1, reference: 2 }, next: { reference: { offset: 1 } } },
            loadPage: () => new Promise(resolve => { finish = resolve; }) });
        const session = provider.publish(identity(1), first());
        const pending = provider.loadNextPage(session, 'reference');
        assert.equal(await provider.loadNextPage(session, 'reference'), false);
        finish({ status: 'ready', revision: 'v1', result: { locations: result(undefined, 1).locations.slice(1),
            page: { appendRole: 'reference', next: {} } } });
        assert.equal(await pending, true);
        assert.equal(session.locations.length, 3);
        assert.equal(session.page.next.reference, undefined);
        provider.publish(identity(1), first());
        const old = provider.loadNextPage(session, 'reference');
        provider.publish(identity(1), result(undefined, 0));
        finish({ status: 'expired' });
        assert.equal(await old, false);
        assert.equal(session.state, 'ready');
        assert.equal(session.locations.length, 1);
        provider.publish(identity(1), first());
        const expired = provider.loadNextPage(session, 'reference');
        finish({ status: 'ready', revision: 'v2' });
        assert.equal(await expired, false);
        assert.equal(session.state, 'needs-refresh');
        assert.equal(session.locations.length, 0);
    });

    it('uses one pinned session for equivalent numeric IDs and rejects unsupported identities', async () => {
        const provider = new LsdynaEntityReferenceProvider();
        for (const id of [0, '0', '+0', '9007199254740992', Infinity, NaN, null, undefined,
            false, 17n, { toString: () => '17' }]) {
            assert.equal(entityQueryKey(identity(id)), '');
            assert.equal(provider.publish(identity(id), result()), null);
        }
        const named = provider.publish(identity('MAT_LABEL_1'), result());
        assert.equal(named.identity.id, 'MAT_LABEL_1');
        const pinned = provider.publish(identity(17), result());
        await provider.pin(pinned);
        for (const id of ['17', '+17', '0017']) {
            assert.equal(entityQueryKey(identity(id)), pinned.key);
            assert.strictEqual(provider.publish(identity(id), result()), pinned);
            assert.equal(pinned.identity.id, 17);
        }
        assert.equal(provider.listSessions().length, 1);
        assert.equal(pinned.pinned, true);
    });

    it('replaces the current query while preserving newest-first pinned queries', async () => {
        const state = memoryState();
        const provider = new LsdynaEntityReferenceProvider({ workspaceState: state });
        const first = provider.publish(identity(1), result());
        await provider.pin(first);
        const second = provider.publish(identity(2), result());
        await provider.pin(second);
        const current = provider.publish(identity(3), result());
        provider.publish(identity(4), result());

        assert.equal(provider.getSession(current.key), null);
        assert.deepEqual(provider.listSessions().map(session => session.identity.id), [4, 2, 1]);
        assert.deepEqual(state.values.get('legacy-pinned-state'), []);
        assert.deepEqual(state.updates, []);
    });

    it('refreshes and activates an identical pinned identity without creating a duplicate', async () => {
        const provider = new LsdynaEntityReferenceProvider({ workspaceState: memoryState() });
        const pinned = provider.publish(identity(7), result());
        await provider.pin(pinned);
        const refreshed = provider.publish(identity(7), result(path.resolve('deck.key'), 4));

        assert.strictEqual(refreshed, pinned);
        assert.equal(provider.listSessions().length, 1);
        assert.equal(provider.getActiveSession().key, pinned.key);
        assert.equal(refreshed.locations.filter(location => location.role === 'reference').length, 4);
    });

    it('enforces the pinned limit explicitly and never silently evicts identities', async () => {
        const provider = new LsdynaEntityReferenceProvider({ workspaceState: memoryState(), maxPinned: 2 });
        await provider.pin(provider.publish(identity(1), result()));
        await provider.pin(provider.publish(identity(2), result()));
        const rejected = await provider.pin(provider.publish(identity(3), result()));

        assert.deepEqual(rejected, { ok: false, reason: 'limit', limit: 2 });
        assert.deepEqual(provider.pinnedKeys.map(key => provider.getSession(key).identity.id), [2, 1]);
    });

    it('does not restore pinned identities from workspace state', async () => {
        const projectRoot = path.resolve('project', 'root.k');
        const state = memoryState([{
            targetKind: 'curve', id: 1001,
            scope: { kind: 'project', rootFile: projectRoot },
        }]);
        const provider = new LsdynaEntityReferenceProvider({ workspaceState: state });
        assert.deepEqual(provider.listSessions(), []);
    });

    it('clears only the unpinned current query and keeps session pins', async () => {
        const provider = new LsdynaEntityReferenceProvider({ workspaceState: memoryState() });
        const current = provider.publish(identity(1), result());
        const pinned = provider.publish(identity(2), result());
        await provider.pin(pinned);
        provider.publish(identity(3), result());

        assert.equal(provider.clearCurrent(), true);
        assert.deepEqual(provider.listSessions().map(session => session.identity.id), [2]);
        assert.equal(provider.getSession(current.key), null);
        assert.equal(provider.clearCurrent(), false);
    });

    it('evicts result coordinates by LRU while retaining query identities', async () => {
        let tick = 0;
        const sampleBytes = 1_000;
        const fixtureRoot = path.join(path.parse(process.cwd()).root, 'lru');
        const provider = new LsdynaEntityReferenceProvider({
            workspaceState: memoryState(),
            resultBudgetBytes: sampleBytes,
            clock: () => ++tick,
        });
        const first = provider.publish(identity(1), result(path.join(fixtureRoot, 'a.key'), 1));
        await provider.pin(first);
        const second = provider.publish(identity(2), result(path.join(fixtureRoot, 'b.key'), 1));

        assert.equal(provider.getSession(first.key).state, 'needs-refresh');
        assert.deepEqual(provider.getSession(first.key).locations, []);
        assert.equal(provider.getSession(second.key).state, 'ready');
    });

    it('keeps verified locations in the query session and marks matching files stale', () => {
        const filePath = path.resolve('rogue-v3.key');
        const provider = new LsdynaEntityReferenceProvider({ workspaceState: memoryState() });
        const session = provider.publish(identity(2000101, filePath), result(filePath));
        assert.equal(session.key, entityQueryKey(session.identity));
        assert.equal(session.locations.filter(location => location.role === 'definition').length, 1);
        assert.equal(session.locations.filter(location => location.role === 'reference').length, 2);

        provider.markStaleForPath(filePath);
        assert.equal(session.state, 'stale');
    });

    it('cycles only references of the active query in both directions', async () => {
        const provider = new LsdynaEntityReferenceProvider({ workspaceState: memoryState() });
        const first = provider.publish(identity(1), result(path.resolve('a.key'), 2));
        await provider.pin(first);
        const second = provider.publish(identity(2), result(path.resolve('b.key'), 1));
        await provider.pin(second);

        provider.setActive(first);
        assert.equal(provider.nextReference().location.line, 195);
        assert.equal(provider.nextReference().location.line, 196);
        assert.equal(provider.nextReference().location.line, 195);
        assert.equal(provider.previousReference().location.line, 196);
        assert.equal(provider.getActiveSession().identity.id, 1);
    });

    it('creates exact-token side and current-editor open arguments only for ready results', () => {
        const filePath = path.resolve('deck.key');
        const provider = new LsdynaEntityReferenceProvider({ workspaceState: memoryState() });
        const session = provider.publish(identity(1, filePath), result(filePath));
        const node = { session, location: session.locations.find(candidate => candidate.role === 'reference') };
        const side = LsdynaEntityReferenceProvider.openArguments(node, true);
        const current = LsdynaEntityReferenceProvider.openArguments(node, false);

        assert.equal(side[0].fsPath, filePath);
        assert.equal(side[1].viewColumn, vscode.ViewColumn.Beside);
        assert.equal(side[1].selection.start.line, 195);
        assert.equal(side[1].selection.start.character, 23);
        assert.equal(side[1].selection.end.character, 30);
        assert.equal(current[1].viewColumn, vscode.ViewColumn.Active);

        session.state = 'stale';
        assert.equal(LsdynaEntityReferenceProvider.openArguments(node, true), null);
    });

    it('shows and navigates verified locations from an explicitly partial query', () => {
        const filePath = path.resolve('partial.key');
        const provider = new LsdynaEntityReferenceProvider({ workspaceState: memoryState() });
        const partial = { ...result(filePath, 1), state: 'partial', reasons: ['transform-offset-unresolved'] };
        const session = provider.publish(identity(2000102, filePath), partial);
        const referenceNode = {
            session,
            location: session.locations.find(candidate => candidate.role === 'reference'),
        };

        assert.equal(session.state, 'partial');
        assert.equal(session.locations.length, 2);
        assert.equal(provider.nextReference().location.line, 195);
        assert.ok(LsdynaEntityReferenceProvider.openArguments(referenceNode, true));
    });
});
