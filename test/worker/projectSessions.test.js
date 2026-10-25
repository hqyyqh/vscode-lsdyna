'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temporary = require('../support/tempDirectories').trackTempDirectories();
const { ProjectSessions } = require('../../out/worker/projectSessions');
const { createProjectIndexer } = require('../../out/core/project/projectIndexer');
const { entityFileSignature } = require('../../out/core/cache/entityFileRevision');
const { INDEX_PROTOCOL_VERSION, INDEX_MESSAGE_BYTES, indexJsonBytes, boundedIndexPage } = require('../../out/shared/indexPages');

describe('bounded project sessions', () => {
    it('finishes every concurrent subscription when the initial row exceeds the budget', async () => {
        for (const bytes of [0, 1]) {
            let builds = 0;
            const sessions = new ProjectSessions(async () => { builds++; throw Error('must not build'); }, bytes);
            const rootFile = path.resolve('initial-row-budget.k');
            try {
                const opened = await Promise.allSettled([sessions.open(rootFile), sessions.open(rootFile)]);
                assert(opened.every(result => result.status === 'fulfilled'), 'all subscribers must receive a terminal session');
                await tick();
                for (const result of opened) {
                    const page = await sessions.read(result.value);
                    assert.equal(page.state, 'incomplete');
                    assert.equal(page.error, 'index-budget-exceeded');
                    assert.equal(page.pending, false);
                    sessions.release(result.value.lease);
                }
                assert.equal(builds, 0);
            } finally { await sessions.clear(); }
        }
    });
    it('reports a source change between structure completion and query handoff as retryable', async () => {
        const root = path.resolve('handoff.k');
        const sessions = new ProjectSessions(async () => ({ rootFile: root, fileIndexes: new Map(), missingFiles: [] }),
            undefined, async () => false);
        try {
            await assert.rejects(sessions.loadStructure(root, { reconcileChanges: true }), { name: 'ScanChangedError' });
        } finally { await sessions.clear(); }
    });
    it('cancels polling-token structure waiters without cancelling a remaining subscriber', async () => {
        const root = path.resolve('cancel-reconciliation.k');
        let finish, buildToken;
        const gate = new Promise(resolve => { finish = resolve; });
        const sessions = new ProjectSessions(async (_, options) => {
            buildToken = options.cancellationToken;
            await gate;
            return { rootFile: root, fileIndexes: new Map(), missingFiles: [] };
        });
        const firstToken = { isCancellationRequested: false }, secondToken = { isCancellationRequested: false };
        const first = sessions.loadStructure(root, { reconcileChanges: true }, firstToken);
        const second = sessions.loadStructure(root, { reconcileChanges: true }, secondToken);
        try {
            await tick(); sessions.invalidate(root);
            firstToken.isCancellationRequested = true;
            await assert.rejects(first, { name: 'CancellationError' });
            assert.equal(buildToken.isCancellationRequested, false);
            secondToken.isCancellationRequested = true;
            await assert.rejects(second, { name: 'CancellationError' });
            assert.equal(buildToken.isCancellationRequested, true);
        } finally { finish(); await sessions.clear(); }
    });
    it('reopens one invalidated subscription, clears old projection rows and releases every lease', async () => {
        const { followProjectStructure } = require('../../out/client/services/projectSessionClient');
        for (const continuouslyChanging of [false,true]) {
            let opened=0, reads=0; const released=[], progress=[];
            const request=async input=> {
                if(input.action==='open') return {lease:String(++opened),generation:opened};
                if(input.action==='release') { released.push(input.lease); return {}; }
                if(++reads===1) return {state:'scanning',rows:[{type:'file',filePath:'old.k',state:'complete'}],after:1,pending:true};
                if(input.lease==='1' || continuouslyChanging) return {state:'stale',generation:Number(input.lease)};
                assert.equal(input.after,0);
                return {state:'complete',rows:[{type:'file',filePath:'main.k',state:'complete'}],after:1,pending:false};
            };
            const task=followProjectStructure(request,'main.k',{},event=>progress.push([...event.snapshot.files]));
            if(continuouslyChanging) await assert.rejects(task,{name:'ScanChangedError'});
            else assert.deepEqual((await task).files,['main.k']);
            assert.equal(opened,2); assert.deepEqual(released,['1','2']);
            assert(progress.some((files,i)=>i>0 && files.length===0));
        }
    });
    const request = (sessions, value) => sessions.request({ protocolVersion: INDEX_PROTOCOL_VERSION, ...value });
    it('retries only unpublished viewer scans and releases cancelled or failed subscriptions', async () => {
        const { followLargeFileIndex } = require('../../out/client/services/projectSessionClient');
        for (const mode of ['retry', 'cancel', 'published-stale', 'repeated-stale']) {
            let opens = 0, reads = 0;
            const releases = [], progress = [], token = { isCancellationRequested:false };
            const request = async input => {
                if(input.action === 'file-view-open') return { lease:String(++opens),generation:opens };
                if(input.action === 'release') { releases.push(input.lease); return {}; }
                reads++;
                if(mode === 'retry') return {state: reads === 1 ? 'stale' : 'complete',lineCount:50};
                if(mode === 'repeated-stale' || reads > 1) return {state:'stale'};
                return {state:'scanning',lineCount:20,scannedBytes:100};
            };
            const task = followLargeFileIndex(request, 'main.k', async value => {
                progress.push(value); if(mode === 'cancel') token.isCancellationRequested=true;
            }, token);
            if(mode === 'retry') { assert.equal((await task).lease,'2'); assert.deepEqual(releases,['1']); }
            else {
                await assert.rejects(task);
                assert.deepEqual(releases,mode === 'repeated-stale' ? ['1','2'] : ['1']);
                assert.equal(opens,mode === 'repeated-stale' ? 2 : 1);
            }
        }
    });

    it('opens a progressive viewer immediately and serves confirmed context while the scan is paused', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-partial-'));
        const file = path.join(root, 'deck.k');
        fs.writeFileSync(file, '*KEYWORD I10=Y\n*MAT_ELASTIC\n         7\n*NODE\n' + '       1       0\n'.repeat(9000) + '*END');
        const indexer = createProjectIndexer({ getFileSignature: entityFileSignature });
        let resume, paused;
        const waiting = new Promise(resolve => { paused = resolve; });
        const gate = new Promise(resolve => { resume = resolve; });
        const sessions = new ProjectSessions((root, options) => indexer.buildProjectIndex(root, { ...options,
            flushStructure: async () => { paused(); await gate; await options.flushStructure(); } }));
        try {
            const handle = await request(sessions, { action: 'file-view-open', rootFile: file, progressive: true });
            assert.equal(handle.state, 'scanning');
            await waiting;
            const progress = await request(sessions, { ...handle, action: 'file-view', mode: 'progress' });
            assert.equal(progress.state, 'scanning');
            assert(progress.scannedBytes > 0 && progress.scannedBytes < fs.statSync(file).size);
            const page = await request(sessions, { ...handle, action: 'file-view', mode: 'window', line: 2 });
            assert.equal(page.largeFileLineMap.complete, false);
            assert.equal(page.inputFormat, 'i10');
            assert(page.keywordBlocks.some(block => block.keyword === '*MAT_ELASTIC'));
            assert(!page.keywordBlocks.some(block => block.keyword === '*NODE'));
            assert.equal((await request(sessions, { ...handle, action: 'file-view', mode: 'name', id: 7 })).state, 'scanning');
            resume(); await sessions.leases.get(handle.lease).ready;
            assert.equal((await request(sessions, { ...handle, action: 'file-view', mode: 'progress' })).state, 'complete');
        } finally { resume(); await sessions.clear(); }
    });

    it('reopens an unpublished viewer invalidated during scanning, but rejects repeated invalidation', async () => {
        const root = path.resolve('viewer-refresh.k');
        for (const continuouslyChanging of [false, true]) {
            let scans = 0;
            const sessions = new ProjectSessions(async () => {
                if (++scans === 1 || continuouslyChanging) sessions.invalidate(root);
                return { rootFile: root, fileIndexes: new Map([[root, {
                    size: 12, mtimeMs: scans, scannerVersion: 1,
                    largeFileLineMap: { lineCount: 2 },
                }]]) };
            }, undefined, async () => true);
            try {
                const opening = request(sessions, { action: 'file-view-open', rootFile: root });
                if (continuouslyChanging) await assert.rejects(opening, /Project structure is not current/);
                else {
                    const handle = await opening;
                    assert.equal(handle.state, 'complete');
                    assert.equal(handle.mtimeMs, 2);
                    await request(sessions, { action: 'release', lease: handle.lease });
                }
                assert.equal(scans, 2);
                assert.equal(sessions.leases.size, 0);
            } finally { await sessions.clear(); }
        }
    });
    const tick = () => new Promise(resolve => setImmediate(resolve));
    async function drain(sessions, handle) {
        let after = 0, page, rows = new Map();
        do {
            page = await request(sessions, { action: 'read', ...handle, after });
            assert(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: page })) <= INDEX_MESSAGE_BYTES);
            for (const row of page.rows || []) rows.set(JSON.stringify([row.type, row.filePath, row.startLine, row.lineIndex]), row);
            after = page.after;
            if (!page.pending && page.state !== 'scanning') break;
            await tick();
        } while (true);
        return { page, rows: [...rows.values()] };
    }

    it('measures JSON escaping and Unicode without creating a full serialized string', () => {
        for (const value of [null, true, 1.5, '中文😀\ud800\u0001\n\\"', { a: undefined, b: [null, 'x'] }])
            assert.equal(indexJsonBytes(value), Buffer.byteLength(JSON.stringify(value)));
        assert.throws(() => indexJsonBytes({ text: 'x'.repeat(2048) }, 1024), /budget/);
        const rows = boundedIndexPage(Array.from({ length: 300 }, (_, id) => ({ id, text: '中'.repeat(3000) })), {});
        assert(rows.length < 200);
        assert(Buffer.byteLength(JSON.stringify({ rows })) < INDEX_MESSAGE_BYTES);
    });

    it('shares a scan, returns keywords before completion, and cancellation has subscription ownership', async () => {
        const root = path.resolve('shared.k');
        let finish, calls = 0;
        const sessions = new ProjectSessions(async (_, options) => {
            calls++;
            options.onStructureBlock({ filePath: root, keyword: '*NODE', startLine: 0 }, false);
            await new Promise(resolve => { finish = resolve; });
            return { fileIndexes: new Map(), missingFiles: [] };
        });
        const first = await request(sessions, { action: 'open', rootFile: root });
        const second = await request(sessions, { action: 'open', rootFile: root });
        await tick();
        assert.equal(calls, 1);
        const page = await request(sessions, { action: 'read', ...first });
        assert.equal(page.state, 'scanning');
        assert(page.rows.some(row => row.keyword === '*NODE' && !row.complete));
        await request(sessions, { action: 'release', lease: first.lease });
        finish(); await tick();
        assert.equal((await request(sessions, { action: 'read', ...second })).state, 'complete');
        sessions.clear();
    });

    it('scans only structure, reuses unchanged files, and invalidates old cursors on refresh', async () => {
        const directory = temporary(path.join(os.tmpdir(), 'dynasense-session-'));
        const root = path.join(directory, 'main.k'), child = path.join(directory, 'child.k');
        fs.writeFileSync(root, '*KEYWORD\n*INCLUDE\nchild.k\n*END\n');
        fs.writeFileSync(child, '*NODE\n1,0,0,0\n*END\n');
        const indexer = createProjectIndexer({ getFileSignature: entityFileSignature, maxFileScanCacheBytes: 1 });
        const sessions = new ProjectSessions(indexer.buildProjectIndex);
        const first = await request(sessions, { action: 'open', rootFile: root });
        const result = await drain(sessions, first);
        assert.equal(result.page.state, 'complete');
        assert(result.rows.some(row => row.type === 'include' && row.filePath === child));
        const snapshot = await sessions.snapshot(first.lease, first.generation);
        for (const index of snapshot.fileIndexes.values()) assert.equal(index.registryReferences, undefined);
        const second = await request(sessions, { action: 'open', rootFile: root });
        assert.equal(second.generation, first.generation);
        fs.writeFileSync(child, '*NODE\n1,0,0,0\n2,1,0,0\n*END\n');
        const third = await request(sessions, { action: 'open', rootFile: root });
        assert.notEqual(third.generation, first.generation);
        assert.equal((await request(sessions, { action: 'read', ...first })).state, 'stale');
        await drain(sessions, third);
        const updated = await sessions.snapshot(third.lease, third.generation);
        assert.equal(updated.stats.reusedFileCount, 1);
        assert.equal(updated.stats.scannedFileCount, 1);
        fs.appendFileSync(child, '$ external change\n');
        await request(sessions, { action: 'invalidate', rootFile: child });
        assert.equal((await request(sessions, { action: 'read', ...third })).state, 'stale');
        const fourth = await request(sessions, { action: 'open', rootFile: root });
        await drain(sessions, fourth);
        const refreshed = await sessions.snapshot(fourth.lease, fourth.generation);
        assert.equal(refreshed.stats.reusedFileCount, 1);
        assert.equal(refreshed.stats.scannedFileCount, 1);
        sessions.clear();
    });

    it('reports an oversized row as incomplete rather than claiming empty results are complete', async () => {
        const root = path.resolve('oversize.k');
        const sessions = new ProjectSessions(async (_, options) => {
            options.onStructureBlock({ filePath: root, keyword: 'x'.repeat(INDEX_MESSAGE_BYTES), startLine: 0 }, false);
            throw new Error('must not reach');
        });
        const handle = await request(sessions, { action: 'open', rootFile: root });
        const { page } = await drain(sessions, handle);
        assert.equal(page.state, 'incomplete');
        assert.equal(page.error, 'index-budget-exceeded');
        sessions.clear();
    });

    it('stores dense keyword pages on disk and returns only the requested viewer window', async function() {
        this.timeout(10000);
        const directory = temporary(path.join(os.tmpdir(), 'dynasense-project-pages-'));
        const root = path.join(directory, 'main.k');
        fs.writeFileSync(root, '*KEYWORD\n' + '*CONTROL_TIMESTEP\n'.repeat(450) + '*END\n');
        const { EntityIndexStore } = require('../../out/core/cache/entityIndexStore');
        const store = await EntityIndexStore.open(path.join(directory, 'storage'));
        const indexer = createProjectIndexer({ getFileSignature: entityFileSignature });
        const sessions = new ProjectSessions(indexer.buildProjectIndex, 1024 * 1024, undefined, async () => store);
        try {
            const handle = await request(sessions, { action: 'file-view-open', rootFile: root });
            const first = await request(sessions, { action: 'keywords', ...handle, search: 'ctl time' });
            assert.equal(first.total, 450); assert.equal(first.rows.length, 200);
            const next = await request(sessions, { action: 'keywords', ...handle, search: 'ctl time',
                revision: first.revision, offset: first.next });
            assert.equal(next.rows.length, 200);
            assert(first.rows.at(-1).startLine < next.rows[0].startLine);
            const window = await request(sessions, { action: 'file-view', ...handle, mode: 'window', line: 200 });
            assert.equal(window.keywordBlocks.length, 200); assert(window.next !== undefined);
            assert.equal(window.largeFileLineMap.offsets.length, 1);
            assert(!window.fileIndexes); assert(!window.referenceDefinitions);
            const tail = await request(sessions, { action: 'file-view', ...handle, mode: 'window', line: 200, blockOffset: window.next });
            assert(tail.keywordBlocks[0].startLine > window.keywordBlocks.at(-1).startLine);
            const destination = await request(sessions, { action: 'file-view', ...handle, mode: 'keyword', line: 300, direction: 1, filter: 'CONTROL' });
            assert.equal(destination.count, 450); assert.equal(destination.block.startLine, 301);
        } finally { await sessions.clear(); await store.close(); }
    });

    it('bounds retained structure even when every pending page has already been flushed', async () => {
        const root = path.resolve('retained-budget.k');
        const store = { begin: async () => ({}), appendProjectRows: async () => {},
            abandon: async () => {}, renew: async () => {}, projectRows: async () => ({ values: [] }) };
        const sessions = new ProjectSessions(async (_, options) => {
            await options.flushStructure();
            for (let line = 0; line < 1000; line++) {
                options.onStructureBlock({ filePath: root, keyword: '*PART', startLine: line, endLine: line }, true);
                await options.flushStructure();
            }
            throw Error('must stop at the retained structure budget');
        }, 4096, undefined, async () => store);
        try {
            const handle = await request(sessions, { action: 'open', rootFile: root });
            const { page } = await drain(sessions, handle);
            assert.equal(page.state, 'incomplete'); assert.equal(page.error, 'index-budget-exceeded');
            const metrics = await request(sessions, { action: 'metrics' });
            assert(metrics.projects[0].retainedStructureBytes <= 4096 * 4);
        } finally { await sessions.clear(); }
    });

    it('does not retain disk projection reservations after flushing physical keyword blocks', async () => {
        const root = path.resolve('nested-'.repeat(20), 'physical.k');
        const store = { begin: async () => ({}), appendProjectRows: async () => {},
            abandon: async () => {}, renew: async () => {}, projectRows: async () => ({ values: [] }) };
        const sessions = new ProjectSessions(async (_, options) => {
            await options.flushStructure();
            const blocks = [];
            for (let line = 0; line < 1000; line++) {
                const block = { filePath: root, keyword: '*PART', rawKeyword: '*PART', startLine: line,
                    endLine: line, startOffset: line * 20, endOffset: line * 20 + 19, dataLineCount: 1 };
                blocks.push(block);
                options.onStructureBlock(block, true);
                await options.flushStructure();
            }
            return { fileIndexes: new Map([[root, { keywordBlocks: blocks }]]) };
        }, 256 * 1024, undefined, async () => store);
        try {
            const handle = await request(sessions, { action: 'open', rootFile: root });
            const { page } = await drain(sessions, handle);
            assert.equal(page.state, 'complete');
            const metrics = await request(sessions, { action: 'metrics' });
            assert(metrics.projects[0].retainedStructureBytes > 0);
            assert.equal(metrics.projects[0].projectionBytes, 0);
        } finally { await sessions.clear(); }
    });

    it('coalesces a physical file scan across different project roots', async function() {
        this.timeout(10000);
        const directory = temporary(path.join(os.tmpdir(), 'dynasense-shared-roots-'));
        const roots = ['a.k', 'b.k'].map(name => path.join(directory, name)), child = path.join(directory, 'shared.k');
        for (const root of roots) fs.writeFileSync(root, '*INCLUDE\nshared.k\n');
        fs.writeFileSync(child, '*NODE\n1,0,0,0\n');
        const calls = new Map();
        const indexer = createProjectIndexer({ getFileSignature: entityFileSignature,
            loadFileStructure: async (file, options) => {
                calls.set(file, (calls.get(file) || 0) + 1);
                await new Promise(resolve => setTimeout(resolve, 30));
                return require('../../out/core/scanner/fileIndexBuilder').buildFileStructure(file, options);
            } });
        const sessions = new ProjectSessions(indexer.buildProjectIndex);
        try {
            const handles = await Promise.all(roots.map(rootFile => request(sessions, { action: 'open', rootFile })));
            const results = await Promise.all(handles.map(handle => drain(sessions, handle)));
            assert(results.every(result => result.page.state === 'complete'));
            assert.equal(calls.get(child), 1);
            assert(results.every(result => result.rows.some(row => row.filePath === child && row.keyword === '*NODE')));
        } finally { await sessions.clear(); }
    });

    it('invalidates old cursors after one controlled retry and never returns a new snapshot under an old generation', async () => {
        const root = path.resolve('retry.k');
        let restart, finish;
        const sessions = new ProjectSessions(async (_, options) => {
            await new Promise(resolve => { restart = resolve; });
            await options.onStructureRestart();
            options.onStructureBlock({ filePath: root, keyword: '*PART', startLine: 4 }, true);
            await new Promise(resolve => { finish = resolve; });
            return { fileIndexes: new Map(), graph: { includeOccurrences: [] } };
        });
        try {
            const handle = await request(sessions, { action: 'open', rootFile: root });
            await tick();
            const staleSnapshot = assert.rejects(sessions.snapshot(handle.lease, handle.generation), /Expired/);
            restart(); await tick();
            const stale = await request(sessions, { action: 'read', ...handle });
            assert.equal(stale.state, 'stale'); assert.notEqual(stale.generation, handle.generation);
            finish(); await staleSnapshot;
            const result = await drain(sessions, { ...handle, generation: stale.generation });
            assert.equal(result.page.state, 'complete');
            assert(result.rows.some(row => row.keyword === '*PART'));
        } finally { await sessions.clear(); }
    });

    it('keeps readable branches and failure state when one included file cannot be scanned', async function() {
        this.timeout(10000);
        const directory = temporary(path.join(os.tmpdir(), 'dynasense-failed-branch-'));
        const root = path.join(directory, 'main.k'), failed = path.join(directory, 'failed.k'), good = path.join(directory, 'good.k');
        fs.writeFileSync(root, '*INCLUDE\nfailed.k\n*INCLUDE\ngood.k\n');
        fs.writeFileSync(failed, '*NODE\n1,0,0,0\n'); fs.writeFileSync(good, '*PART\ngood\n7,0,0\n');
        const indexer = createProjectIndexer({ getFileSignature: entityFileSignature, loadFileStructure: async (file, options) => {
            if (file === failed) throw new Error('fixture read failure');
            return require('../../out/core/scanner/fileIndexBuilder').buildFileStructure(file, options);
        } });
        const sessions = new ProjectSessions(indexer.buildProjectIndex);
        try {
            const handle = await request(sessions, { action: 'open', rootFile: root });
            const result = await drain(sessions, handle);
            assert.equal(result.page.state, 'incomplete');
            assert(result.rows.some(row => row.type === 'file' && row.filePath === failed && row.state === 'failed'));
            assert(result.rows.some(row => row.filePath === good && row.keyword === '*PART'));
            const snapshot = await sessions.snapshot(handle.lease, handle.generation);
            assert.deepEqual(snapshot.failedFiles, [failed]);
            const reference = require('../../out/core/references/projectReferenceIndex').buildProjectReferenceIndex(snapshot);
            assert(reference.completenessReasons.includes('project-scan-unavailable'));
        } finally { await sessions.clear(); }
    });

    it('retries a changing physical source once and stops when it keeps changing', async () => {
        const directory = temporary(path.join(os.tmpdir(), 'dynasense-changing-source-'));
        const root = path.join(directory, 'main.k');
        fs.writeFileSync(root, '*NODE\n1,0,0,0\n');
        let scans = 0, restarts = 0;
        const indexer = createProjectIndexer({ getFileSignature: entityFileSignature, loadFileStructure: async (file, options) => {
            scans++;
            const result = await require('../../out/core/scanner/fileIndexBuilder').buildFileStructure(file, options);
            fs.appendFileSync(file, '$ changed\n');
            return result;
        } });
        await assert.rejects(indexer.buildProjectIndex(root, { structureOnly: true,
            onStructureRestart: () => { restarts++; } }), error => error.name === 'ScanChangedError');
        assert.equal(scans, 2); assert.equal(restarts, 1);
    });

    it('reconciles repeated changes for an entity scan and reuses unchanged physical files', async () => {
        const directory = temporary(path.join(os.tmpdir(), 'dynasense-reconcile-source-'));
        const root = path.join(directory, 'main.k'), child = path.join(directory, 'child.k');
        fs.writeFileSync(root, '*INCLUDE\nchild.k\n'); fs.writeFileSync(child, '*NODE\n1,0,0,0\n');
        const scans = new Map();
        const indexer = createProjectIndexer({ getFileSignature: entityFileSignature, loadFileStructure: async (file, options) => {
            scans.set(file, (scans.get(file) || 0) + 1);
            const result = await require('../../out/core/scanner/fileIndexBuilder').buildFileStructure(file, options);
            if (file === child && scans.get(file) <= 2) fs.appendFileSync(file, '$ changed\n');
            return result;
        } });
        const snapshot = await indexer.buildProjectIndex(root, { structureOnly: true, reconcileChanges: true });
        assert.equal(snapshot.fileIndexes.size, 2);
        assert.equal(scans.get(root), 1, 'unchanged main deck must not be scanned again');
        assert.equal(scans.get(child), 3);
    });

    it('rejects wrong protocol versions and malformed cursors', async () => {
        const sessions = new ProjectSessions(async () => ({ fileIndexes: new Map() }));
        await assert.rejects(sessions.request({ action: 'open', protocolVersion: -1 }), /protocol mismatch/);
        const handle = await request(sessions, { action: 'open', rootFile: path.resolve('root.k') });
        await assert.rejects(request(sessions, { action: 'read', ...handle, after: -1 }), /cursor/);
        sessions.clear();
    });
});
