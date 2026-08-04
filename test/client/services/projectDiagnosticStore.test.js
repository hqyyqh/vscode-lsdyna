'use strict';

const assert = require('assert');

describe('createProjectDiagnosticStore', () => {
    it('merges shared-file diagnostics by project root and removes stale files', () => {
        const { createProjectDiagnosticStore } = require('../../../out/client/services/projectDiagnosticStore');
        const collection = {
            sets: new Map(),
            deletes: [],
            set(uri, diagnostics) { this.sets.set(uri.fsPath, diagnostics); },
            delete(uri) {
                this.deletes.push(uri.fsPath);
                this.sets.delete(uri.fsPath);
            },
        };
        const store = createProjectDiagnosticStore(collection);
        const rootA = '/project/a.k';
        const rootB = '/project/b.k';
        const shared = '/project/shared.k';
        const childA = '/project/child-a.k';
        const diagA = { message: 'A' };
        const diagB = { message: 'B' };

        store.publish(rootA, new Map([[shared, [diagA]], [childA, [diagA]]]));
        store.publish(rootB, new Map([[shared, [diagB]]]));
        assert.deepStrictEqual(collection.sets.get(shared), [diagA, diagB]);

        store.publish(rootA, new Map());
        assert.deepStrictEqual(collection.sets.get(shared), [diagB]);
        assert.ok(collection.deletes.includes(childA));

        store.clear(rootB);
        assert.equal(collection.sets.has(shared), false);
        assert.ok(collection.deletes.includes(shared));
    });

    it('shows only the selected root and suppresses an ambiguous shared file', () => {
        const { createProjectDiagnosticStore } = require('../../../out/client/services/projectDiagnosticStore');
        const collection = {
            sets: new Map(),
            set(uri, diagnostics) { this.sets.set(uri.fsPath, diagnostics); },
            delete(uri) { this.sets.delete(uri.fsPath); },
        };
        const rootA = '/project/a.k';
        const rootB = '/project/b.k';
        const shared = '/project/shared.k';
        const diagA = { message: 'A' };
        const diagB = { message: 'B' };
        let selectedRoot = null;
        const store = createProjectDiagnosticStore(collection, {
            resolveRootForFile() {
                return selectedRoot;
            },
        });

        store.publish(rootA, new Map([[shared, [diagA]]]));
        store.publish(rootB, new Map([[shared, [diagB]]]));
        assert.equal(collection.sets.has(shared), false);

        selectedRoot = rootA;
        store.refresh(shared);
        assert.deepStrictEqual(collection.sets.get(shared), [diagA]);

        selectedRoot = rootB;
        store.refresh(shared);
        assert.deepStrictEqual(collection.sets.get(shared), [diagB]);

        selectedRoot = undefined;
        store.refresh(shared);
        assert.deepStrictEqual(collection.sets.get(shared), [diagA, diagB]);
    });
});
