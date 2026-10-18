'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeDoc } = require('../../support/helpers');
const temporary = require('../../support/tempDirectories').trackTempDirectories();
const api = require('../../../out/extension')._internals;
const { createWorkerPool } = require('../../../out/worker/workerPool');
const { followProjectStructure } = require('../../../out/client/services/projectSessionClient');
const { INDEX_PROTOCOL_VERSION } = require('../../../out/shared/indexPages');

describe('main deck curve hover after automatic refresh', function () {
    this.timeout(30000);
    it('keeps an included material in the scanned main deck after a single-file query', async () => {
        const directory = temporary(path.join(os.tmpdir(), 'main-deck-hover-'));
        const root = path.join(directory, 'main.k');
        const material = path.join(directory, 'materials.k');
        const curve = path.join(directory, 'curves.k');
        fs.writeFileSync(root, '*KEYWORD\n*INCLUDE\nmaterials.k\n*INCLUDE\ncurves.k\n*END');
        fs.writeFileSync(material, '*MAT_PIECEWISE_LINEAR_PLASTICITY\n' +
            '         1   7.86E-6     210.0       0.3      0.25       0.0       0.0       0.0\n' +
            '       0.0       0.0         2         0       0.0\n');
        fs.writeFileSync(curve, '*DEFINE_CURVE\n         2\n                 0.0               250.0\n                 1.0               610.0\n');
        const pool = createWorkerPool({ workerPath: path.resolve('out/worker/scanWorker.js') });
        const request = value => pool.projectSession({ protocolVersion: INDEX_PROTOCOL_VERSION, ...value });
        const loads = [];
        const client = { loadProjectStructure: async rootFile => {
            loads.push(rootFile);
            const snapshot = await followProjectStructure(request, rootFile);
            api.cacheReferenceIndexFromSnapshot(snapshot, { maxBytes: 1 });
            return snapshot;
        } };
        api.clearReferenceIndexCacheForTesting();
        try {
            await client.loadProjectStructure(root);
            const doc = { ...fakeDoc(fs.readFileSync(material, 'utf8'), material), version: 1 };
            const source = api.fieldReferenceAtPosition(doc, { line: 2, character: 25 }, { semanticScope: "keyword-catalog" });
            await request({ action: 'source-analysis', rootFile: material, scope: 'single-file',
                filePath: material, line: 2, mode: 'hover', source });
            assert.ok((await request({ action: 'affected', rootFile: material })).roots.includes(material));
            assert.equal(await api.refreshScannedProjectStructure(client, material), null);
            await api.refreshScannedProjectStructure(client, root);
            assert.deepEqual(loads, [root, root]);
            assert.equal(api.getMainDeckContextForDocumentPath(material).rootFile, root);
            api.setReferenceQueryClientForTesting({ sourceAnalysis: query => {
                assert.equal(query.rootFile, root);
                assert.equal(query.scope, 'project');
                return request({ action: 'source-analysis', ...query });
            } });
            const hover = await new api.LsdynaFieldHoverProvider().provideHover(doc, { line: 2, character: 25 });
            assert.ok(JSON.stringify(hover).includes('data:image/svg+xml;base64,'));
            api.clearReferenceIndexForRoot(root);
            assert.equal(await api.refreshScannedProjectStructure(client, root), null);
        } finally {
            api.setReferenceQueryClientForTesting(null);
            api.clearReferenceIndexCacheForTesting();
            await pool.dispose();
        }
    });
});
