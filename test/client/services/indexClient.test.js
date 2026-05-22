'use strict';

const assert = require('assert');
const path = require('path');

describe('createIndexClient', () => {
    it('exposes loadProjectSnapshot as the shared snapshot entry point', async () => {
        let createIndexClient;
        try {
            ({ createIndexClient } = require('../../../src/client/services/indexClient'));
        } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
        }

        assert.equal(typeof createIndexClient, 'function');

        const snapshot = { rootFile: path.join('project', 'main.k') };
        const client = createIndexClient({
            buildProjectIndex: async (rootFile) => {
                assert.equal(rootFile, snapshot.rootFile);
                return snapshot;
            },
        });

        assert.equal(typeof client.loadProjectSnapshot, 'function');
        assert.strictEqual(await client.loadProjectSnapshot(snapshot.rootFile), snapshot);
    });
});
