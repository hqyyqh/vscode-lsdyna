'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { ProjectGraph } = require('../../src/core/project/projectGraph');
const { serializeProjectSnapshot, serializeProjectSnapshotForClient } = require('../../src/core/cache/snapshotSerializer');
const { createIndexClient } = require('../../src/client/services/indexClient');
const protocol = require('../../src/shared/protocol');

function snapshot(name, count = 1200) {
    const rootFile = path.resolve('transfer', name);
    return { rootFile, files: [rootFile], graph: new ProjectGraph(), keywordMap: new Map(),
        fileIndexes: new Map([[rootFile, { filePath: rootFile, keywordBlocks: [],
            registryReferences: { complete: true, reasons: [],
                referenceOccurrences: Array.from({ length: count }, (_, id) => ({ id, path: rootFile })),
                valueDomainOccurrences: Array.from({ length: count }, (_, id) => ({ id, value: id * 2 })),
            } }]]) };
}
function bridge(sendRequest) {
    const handlers = new Map();
    const client = createIndexClient({ languageClient: {
        onNotification(name, callback) { handlers.set(name, callback); }, sendNotification() {},
        sendRequest: (method, params, token) => sendRequest(params, (name, body) => handlers.get(name)?.(body), token),
    } });
    return { client, handlers };
}

describe('request-scoped project reference transfer', () => {
    it('round-trips all records across bounded batches without mutating cached snapshots', async () => {
        const original = snapshot('large.k');
        const expected = serializeProjectSnapshot(original);
        let batches = 0;
        const { client } = bridge(async (params, notify) => {
            const result = await serializeProjectSnapshotForClient(original, chunk => {
                batches++;
                assert.ok(chunk.items.length <= 512);
                notify(protocol.SNAPSHOT_REFERENCES_NOTIFICATION,
                    JSON.parse(JSON.stringify({ requestId: params.requestId, ...chunk })));
            });
            assert.equal(result.fileIndexes[0][1].registryReferences.referenceOccurrences.length, 0);
            return result;
        });
        const actual = await client.loadProjectSnapshot(original.rootFile);
        assert.deepEqual(serializeProjectSnapshot(actual), expected);
        assert.equal(batches, 6);
        assert.equal(original.fileIndexes.get(original.rootFile).registryReferences.referenceOccurrences.length, 1200);
    });

    it('never labels deferred progress records complete', async () => {
        const original = snapshot('progress.k');
        const progress = await serializeProjectSnapshotForClient(original);
        const refs = progress.fileIndexes[0][1].registryReferences;
        assert.equal(refs.complete, false);
        assert.ok(refs.reasons.includes('scan-progress-references-deferred'));
        assert.equal(original.fileIndexes.get(original.rootFile).registryReferences.complete, true);
    });

    it('round-trips keyword blocks and templated references for every physical file', async () => {
        const original = snapshot('main.k', 513), child = snapshot('child.k', 513);
        original.files.push(child.rootFile);
        original.fileIndexes.set(child.rootFile, child.fileIndexes.get(child.rootFile));
        for (const [filePath, index] of original.fileIndexes) {
            index.keywordBlocks = Array.from({ length: 513 }, (_, lineIndex) => ({
                keyword: 'PART', filePath, lineIndex,
            }));
            for (const field of ['referenceOccurrences', 'valueDomainOccurrences']) {
                for (const record of index.registryReferences[field]) {
                    Object.assign(record, { filePath, keyword: 'PART', fieldName: 'PID',
                        operationalProjection: { kind: 'controlled transport fixture' }, targetKinds: ['part'] });
                }
            }
        }
        const expected = JSON.parse(JSON.stringify(serializeProjectSnapshot(original)));
        let batches = 0, templateBatches = 0;
        const { client } = bridge(async (params, notify) => serializeProjectSnapshotForClient(original, chunk => {
            batches++;
            if (chunk.templates) templateBatches++;
            assert.ok(chunk.items.length <= 512);
            notify(protocol.SNAPSHOT_REFERENCES_NOTIFICATION,
                JSON.parse(JSON.stringify({ requestId: params.requestId, ...chunk })));
        }));
        assert.deepEqual(JSON.parse(JSON.stringify(serializeProjectSnapshot(await client.loadProjectSnapshot(original.rootFile)))), expected);
        assert.deepEqual(JSON.parse(JSON.stringify(serializeProjectSnapshot(original))), expected);
        assert.deepEqual({ batches, templateBatches }, { batches: 12, templateBatches: 8 });
    });

    it('rejects reference templates that inject source coordinates', async () => {
        const original = snapshot('invalid-template.k', 513);
        for (const record of original.fileIndexes.get(original.rootFile).registryReferences.referenceOccurrences) {
            record.operationalProjection = { kind: 'controlled transport fixture' };
        }
        const { client } = bridge(async (params, notify) => serializeProjectSnapshotForClient(original, chunk => {
            const wire = JSON.parse(JSON.stringify({ requestId: params.requestId, ...chunk }));
            if (wire.templates) wire.templates[0].lineIndex = 999;
            notify(protocol.SNAPSHOT_REFERENCES_NOTIFICATION, wire);
        }));
        await assert.rejects(client.loadProjectSnapshot(original.rootFile), /invalid reference template/i);
        assert.ok(original.fileIndexes.get(original.rootFile).registryReferences.referenceOccurrences
            .every(record => !Object.hasOwn(record, 'lineIndex')));
    });

    it('stops between batches when the scan is cancelled', async () => {
        const original = snapshot('cancel.k');
        const token = { isCancellationRequested: false };
        let batches = 0;
        await assert.rejects(serializeProjectSnapshotForClient(original, () => {
            batches++;
            token.isCancellationRequested = true;
        }, token), /cancel/i);
        assert.equal(batches, 1);
        assert.equal(original.fileIndexes.get(original.rootFile).registryReferences.complete, true);
    });

    it('rejects a final snapshot for a different main file', async () => {
        const wrong = snapshot('wrong.k', 0);
        const { client } = bridge(async () => serializeProjectSnapshot(wrong));
        await assert.rejects(client.loadProjectSnapshot(path.resolve('transfer', 'requested.k')), /root/);
    });

    it('routes concurrent progress by request and ignores completed or cancelled requests', async () => {
        const pending = new Map();
        const { client, handlers } = bridge(params => new Promise(resolve => pending.set(params.requestId, { params, resolve })));
        const a = snapshot('a.k', 0), b = snapshot('b.k', 0), seenA = [], seenB = [];
        const token = { isCancellationRequested: false };
        const first = client.loadProjectSnapshot(a.rootFile, {}, s => seenA.push(s.rootFile), token);
        const second = client.loadProjectSnapshot(b.rootFile, {}, s => seenB.push(s.rootFile));
        const notify = (id, value) => handlers.get(protocol.SCAN_PROGRESS_NOTIFICATION)({ requestId: id, snapshot: serializeProjectSnapshot(value) });
        notify('1', a); notify('2', b); notify('2', a);
        token.isCancellationRequested = true;
        notify('1', a);
        pending.get('1').resolve(serializeProjectSnapshot(a));
        await assert.rejects(first, /cancel/i);
        notify('1', a); notify('2', b);
        pending.get('2').resolve(serializeProjectSnapshot(b));
        await second;
        notify('2', b);
        assert.deepEqual(seenA, [a.rootFile]);
        assert.deepEqual(seenB, [b.rootFile, b.rootFile]);
    });

    for (const fault of ['missing', 'out-of-order', 'extra']) it(`rejects ${fault} reference batches`, async () => {
        const original = snapshot('broken.k');
        const { client } = bridge(async (params, notify) => {
            const result = await serializeProjectSnapshotForClient(original, chunk => {
                if (fault === 'missing' && chunk.offset === 512) return;
                notify(protocol.SNAPSHOT_REFERENCES_NOTIFICATION, { requestId: params.requestId, ...chunk,
                    ...(fault === 'out-of-order' ? { offset: chunk.offset + 1 } : {}) });
            });
            if (fault === 'extra') notify(protocol.SNAPSHOT_REFERENCES_NOTIFICATION, {
                requestId: params.requestId, filePath: 'unexpected.k', field: 'referenceOccurrences', offset: 0, items: [{}],
            });
            return result;
        });
        await assert.rejects(client.loadProjectSnapshot(original.rootFile), /reference/i);
    });
});
