const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const temporary = require('../support/tempDirectories').trackTempDirectories();
const { ProgressiveEntityQueries } = require('../../out/worker/progressiveEntityQueries');
const { EntityIndexStore } = require('../../out/core/cache/entityIndexStore');
const { entityFileRevision } = require('../../out/core/cache/entityFileRevision');
const { createWorkerPool } = require('../../out/worker/workerPool');
const { followEntityQuery } = require('../../out/client/services/progressiveEntityClient');
const { entityIndexBudget } = require('../../out/core/cache/entityIndexBudget');
describe('progressive entity queries', function() {
    this.timeout(60000);
    const cleanup = [];
    afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
    function fixture() {
        const root = temporary(path.join(os.tmpdir(), 'dynasense-progressive-')), file = path.join(root, 'main.k');
        fs.writeFileSync(file, '*NODE\n1,0,0,0\n');
        return { root, file, query: { rootFile: file, scope: 'single-file', targetKind: 'node', id: 1 } };
    }
    it('rejects concurrent low-memory queries before reading files or creating SQLite storage', async () => {
        const { root, file, query } = fixture();
        fs.unlinkSync(file);
        const budget = entityIndexBudget('auto', undefined, { available: () => 1024 ** 3, free: () => 0, total: () => 16 * 1024 ** 3 });
        assert.equal(budget.blocked, true);
        const storage = path.join(root, 'storage');
        const pool = createWorkerPool({ workerPath: path.resolve('out/worker/scanWorker.js'), entityStorageDirectory: storage,
            entityMemoryBytes: budget.workerBytes });
        cleanup.push(() => pool.dispose());
        const request = params => pool.projectSession({ protocolVersion: 1, ...params });
        const results = await Promise.all([1, 2].map(id => followEntityQuery(request, { ...query, id })));
        for (const result of results) {
            assert.deepEqual(result.result.reasons, ['entity-query-low-memory']);
            assert.equal(result.result.page.complete, false);
            assert.deepEqual(result.result.page.counts, { definition: 0, reference: 0 });
            result.result.release();
        }
        assert.equal(fs.existsSync(storage), false);
    });
    for (const [error, reason] of [
        [new RangeError('unrelated range error'), 'entity-query-incomplete'],
        [new (require('../../out/core/references/entityQueryBudgetError').EntityQueryBudgetError)('entity-query-index-budget', 1024), 'entity-query-index-budget'],
    ]) it(`classifies ${reason} without calling it a result limit`, async () => {
        const { query } = fixture();
        const service = new ProgressiveEntityQueries(async () => undefined, async () => { throw error; });
        cleanup.push(() => service.clear());
        const result = await followEntityQuery(value => service.request(value), query);
        assert.equal(result.result.page.complete, false);
        assert.deepEqual(result.result.reasons, [reason]);
        result.result.release();
    });
    it('does not publish a superseded query after awaiting optional diagnostics', async () => {
        let current = true, published = false;
        const releases = [];
        const result = await followEntityQuery(async request => {
            if (request.action === 'query-open') return { lease: 'test', revision: 'r' };
            if (request.action === 'query-release') { releases.push(request); return {}; }
            if (request.action === 'query-diagnostics') { current = false; return { epoch: 1 }; }
            return { status: 'ready', state: 'complete', result: { locations: [],
                page: { epoch: 1, counts: { definition: 0, reference: 0 }, next: {} } } };
        }, { diagnostics: true }, () => { published = true; }, undefined, () => current);
        assert.equal(result.status, 'stale'); assert.equal(published, false);
        assert.equal(releases.length, 1); assert.equal(releases[0].retain, true);
    });
    it('returns anonymous INCLUDE_TRANSFORM diagnostics without changing query results', async () => {
        const { root, file } = fixture();
        fs.writeFileSync(path.join(root, 'child.k'), '*KEYWORD\n*DEFINE_CURVE\n1\n0,0\n1,1\n*END\n');
        fs.writeFileSync(file, '*KEYWORD\n*INCLUDE_TRANSFORM\nchild.k\n0,0,0,0,0,100,0\n0\n0\n*LOAD_BODY_Z\n101,1\n*END\n');
        const pool = createWorkerPool({ workerPath: path.resolve('out/worker/scanWorker.js'), entityStorageDirectory: path.join(root, 'storage') });
        cleanup.push(() => pool.dispose());
        const request = params => pool.projectSession({ protocolVersion: 1, ...params });
        const query = { rootFile: file, scope: 'project', id: 101, targetKind: 'curve' };
        const ordinary = await followEntityQuery(request, query);
        const traced = await followEntityQuery(request, { ...query, diagnostics: true });
        assert.equal(ordinary.diagnostics, undefined);
        assert.deepEqual(traced.result.page.counts, ordinary.result.page.counts);
        assert.equal(traced.result.page.counts.definition, 1);
        assert.equal(traced.result.page.counts.reference, 1);
        assert.equal(traced.diagnostics.structure.includes[0].transform.offsets.idfoff.value, 100);
        assert(traced.diagnostics.structure.contexts.some(row => row.offsets.idfoff === 100));
        assert(!JSON.stringify(traced.diagnostics).includes(root));
        ordinary.result.release(); traced.result.release();
    });
    it('builds inherited parameter context across 20 files without exhausting a result-sized reservation', async function () {
        this.timeout(60000);
        const { root, file } = fixture();
        let directory = root;
        for (let depth = 0; depth < 5; depth++) {
            fs.mkdirSync(path.join(directory, 'level'));
            fs.writeFileSync(path.join(directory, depth ? 'branch.k' : 'main.k'), '*KEYWORD\n*INCLUDE\nlevel/branch.k\n*END\n');
            directory = path.join(directory, 'level');
        }
        let main = '*KEYWORD\n';
        for (let i = 0; i < 20; i++) {
            main += `*INCLUDE\nparameters-${i}.k\n`;
            fs.writeFileSync(path.join(directory, `parameters-${i}.k`), '*PARAMETER\n' +
                Array.from({ length: 600 }, (_, j) => `Ip${i * 600 + j},1\n`).join(''));
        }
        fs.writeFileSync(path.join(directory, 'branch.k'), main + '*DEFINE_CURVE\n&p0\n0,0\n1,1\n*LOAD_BODY_Z\n&p11999,1\n*END\n');
        const pool = createWorkerPool({ workerPath: path.resolve('out/worker/scanWorker.js'), entityStorageDirectory: path.join(root, 'storage') });
        cleanup.push(() => pool.dispose());
        const result = await followEntityQuery(params => pool.projectSession({ protocolVersion: 1, ...params }),
            { rootFile: file, scope: 'project', targetKind: 'curve', id: 1, excludeMeshEntities: true, diagnostics: true });
        assert.equal(result.result.page.complete, true, JSON.stringify(result.result.reasons));
        assert.deepEqual(result.result.page.counts, { definition: 1, reference: 1 });
        assert.equal(result.diagnostics.structure.fileCount, 26);
        assert.equal(result.diagnostics.error, undefined);
        result.result.release();
    });
    for (const depth of [4, 5]) it(`resolves transformed references through ${depth} directory and Include levels`, async function () {
        this.timeout(120000);
        const { root, file } = fixture();
        let directory = root;
        for (let level = 0; level < depth; level++) {
            fs.mkdirSync(path.join(directory, 'child'), { recursive: true });
            fs.writeFileSync(path.join(directory, level ? 'branch.k' : 'main.k'),
                '*KEYWORD\n*INCLUDE\nchild/branch.k\n*END\n');
            directory = path.join(directory, 'child');
        }
        fs.writeFileSync(path.join(directory, 'branch.k'), '*KEYWORD\n*INCLUDE_TRANSFORM\ncurves.k\n0,0,0,0,0,100,0\n0\n0\n*INCLUDE\nloads.k\n*INCLUDE\nloads.k\n*END\n');
        // Large physical input with small semantic rows must not consume the index budget as source text.
        const padding = ('$ ' + 'padding '.repeat(120) + '\n').repeat(18);
        fs.writeFileSync(path.join(directory, 'curves.k'), '*KEYWORD\n' +
            Array.from({ length: 1200 }, (_, i) => `*DEFINE_CURVE\n${i + 1}\n0,0\n1,1\n${padding}`).join('') + '*END\n');
        fs.writeFileSync(path.join(directory, 'loads.k'), '*KEYWORD\n' + '*LOAD_BODY_Z\n101,1\n'.repeat(250) + '*END\n');
        let available = 8 * 1024 ** 3, reads = 0, progress = 0;
        const budget = entityIndexBudget('auto', undefined, { available: () => { reads++; return available; },
            free: () => 0, total: () => 16 * 1024 ** 3 });
        const pool = createWorkerPool({ workerPath: path.resolve('out/worker/scanWorker.js'), entityStorageDirectory: path.join(root, 'storage'),
            entityMemoryBytes: budget.workerBytes });
        cleanup.push(() => pool.dispose());
        const request = params => pool.projectSession({ protocolVersion: 1, ...params });
        const results = await Promise.all([101, 102].map(id => followEntityQuery(request, { rootFile: file, scope: 'project', id,
            targetKind: 'curve', excludeMeshEntities: true, diagnostics: true }, () => { available = 0; progress++; })));
        const [result, second] = results;
        assert(progress > 0); assert.equal(available, 0); assert.equal(reads, 1);
        assert.equal(second.result.page.complete, true); assert.equal(second.result.page.counts.definition, 1);
        second.result.release();
        assert.equal(result.result.page.complete, true, JSON.stringify({ reasons: result.result.reasons, diagnostics: result.diagnostics }));
        assert.equal(result.result.page.counts.definition, 1);
        assert.equal(result.result.page.counts.reference, 250, 'physical reference locations are deduplicated across include occurrences');
        assert.equal(result.diagnostics.structure.missingCount, 0);
        assert.equal(result.diagnostics.structure.failedCount, 0);
        assert(result.diagnostics.structure.contexts.some(row => row.offsets.idfoff === 100));
        result.result.release();
    });
    for (const persistent of [false, true]) it(`reconciles repeated edits without cancelling the producer (${persistent ? 'SQLite' : 'memory'})`, async () => {
        const { root, file, query } = fixture();
        const store = persistent ? await EntityIndexStore.open(path.join(root, 'storage')) : undefined;
        let pass = 0;
        const gates = [], tokens = [];
        const service = new ProgressiveEntityQueries(async () => store, async (_, token, accept, sources) => {
            const current = ++pass;
            tokens.push(token);
            sources({ fileIndexes: new Map([[file, { sourceRevision: await entityFileRevision(file) }]]) });
            await accept([{ role: 'reference', filePath: file, line: current, startCharacter: 0, endCharacter: 1 }]);
            if (current < 3) await new Promise(resolve => gates.push(resolve));
            return { state: 'complete', reasons: [] };
        });
        cleanup.push(async () => { gates.forEach(resolve => resolve()); await service.clear(); await store?.close(); });
        const handle = await service.request({ action: 'query-open', query });
        for (let i = 0; i < 2; i++) {
            while (gates.length <= i) await new Promise(resolve => setTimeout(resolve, 5));
            fs.appendFileSync(file, `$ change ${i}\n`);
            // Exercise both explicit watcher invalidation and revision detection during paging.
            if (i === 0) service.invalidate(file);
            const updating = await service.request({ action: 'query-page', ...handle });
            assert.equal(updating.status, 'ready'); assert.equal(updating.state, 'scanning');
            assert.deepEqual(updating.result.locations, []);
            assert.equal(tokens[i].isCancellationRequested, false);
            gates[i]();
        }
        let final;
        do {
            await new Promise(resolve => setTimeout(resolve, 5));
            final = await service.request({ action: 'query-page', ...handle });
        } while (final.state === 'scanning');
        assert.equal(final.state, 'complete');
        assert.deepEqual(final.result.locations.map(row => row.line), [3], 'old matches must be removed');
        assert.equal(pass, 3);
        assert.equal((await service.request({ action: 'query-page', ...handle, epoch: 1, after: 1 })).status, 'stale');
    });
    it('retains one switched query and reconnects without restarting its producer', async () => {
        const { file, query } = fixture();
        const tokens = [], finish = [];
        const service = new ProgressiveEntityQueries(async () => undefined, async (_, token, accept, sources) => {
            tokens.push(token);
            sources({ fileIndexes: new Map([[file, { sourceRevision: await entityFileRevision(file) }]]) });
            await accept([{ role: 'reference', filePath: file, line: 1, startCharacter: 0, endCharacter: 1 }]);
            await new Promise(resolve => finish.push(resolve));
            return { state: 'complete', reasons: [] };
        });
        const first = await service.request({ action: 'query-open', query });
        while (!finish.length) await new Promise(resolve => setTimeout(resolve, 5));
        await service.request({ action: 'query-release', lease: first.lease, retain: true });
        const second = await service.request({ action: 'query-open', query: { ...query, id: 2 } });
        while (finish.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(tokens[0].isCancellationRequested, false);
        const resumed = await service.request({ action: 'query-open', query });
        assert.equal(resumed.revision, first.revision);
        assert.equal(tokens.length, 2);
        const page = await service.request({ action: 'query-page', ...resumed });
        assert.equal(page.result.locations.length, 1);
        service.release(resumed.lease, true); service.release(second.lease, true);
        assert.equal(tokens[0].isCancellationRequested, true, 'only one detached producer is retained');
        finish.forEach(resolve => resolve()); await service.clear();
    });
    it('honors user cancellation while a changed scan is waiting to reconcile', async () => {
        const { file, query } = fixture();
        let finish, started, producerToken, calls = 0;
        const gate = new Promise(resolve => { finish = resolve; });
        const ready = new Promise(resolve => { started = resolve; });
        const service = new ProgressiveEntityQueries(async () => undefined, async (_, token, accept, sources) => {
            calls++; producerToken = token;
            sources({ fileIndexes: new Map([[file, { sourceRevision: await entityFileRevision(file) }]]) });
            started(); await gate; return { state: 'complete', reasons: [] };
        });
        const handle = await service.request({ action: 'query-open', query });
        await ready; service.invalidate(file); service.release(handle.lease);
        assert.equal(producerToken.isCancellationRequested, true);
        finish(); await service.clear(); assert.equal(calls, 1);
    });
    it('detaches a superseded query before its first page without publishing stale results', async () => {
        let current = true, pageStarted, finishPage;
        const started = new Promise(resolve => { pageStarted = resolve; });
        const page = new Promise(resolve => { finishPage = resolve; });
        const releases = [];
        let publications = 0;
        const pending = followEntityQuery(async request => {
            if (request.action === 'query-open') return { lease: 'old', revision: 'version' };
            if (request.action === 'query-release') { releases.push(request); return {}; }
            pageStarted(); await page;
            return { status: 'ready', state: 'scanning', result: { locations: [], page: { counts: { definition: 0, reference: 0 }, next: {} } } };
        }, {}, () => { publications++; }, undefined, () => current);
        await started; current = false; finishPage();
        assert.equal((await pending).status, 'stale');
        assert.equal(publications, 0);
        assert.deepEqual(releases, [{ action: 'query-release', lease: 'old', retain: true }]);
    });
    it('resolves inherited parameter chains through a bounded production request and rejects forward use', async () => {
        const { root, file } = fixture(), child = path.join(root,'child.k');
        fs.writeFileSync(file, '*PARAMETER_EXPRESSION\nRbase,2.0\n*INCLUDE\nchild.k\n');
        fs.writeFileSync(child, '*PARAMETER_EXPRESSION\n' + Array.from({length:8},(_,i)=>
            `Rp${i},${i ? 'p'+(i-1) : 'base'}*2\n`).join('') + '*CONTROL_TERMINATION\n&p7\n');
        const pool = createWorkerPool({ workerPath:path.resolve('out/worker/scanWorker.js'), entityStorageDirectory:path.join(root,'storage') });
        cleanup.push(()=>pool.dispose());
        const request = () => pool.projectSession({protocolVersion:1,action:'source-analysis',mode:'parameters',
            rootFile:file,scope:'project',filePath:child,line:10,fields:[
                {raw:'&p7',line:10,allowReal:true},{raw:'&p7',line:0,allowReal:true},{raw:'<p7/2>',line:10,allowReal:true}]});
        const response = await request();
        assert.equal(response.status,'ready'); assert.equal(response.results[0].value,512);
        assert.equal(response.results[1].resolved,false); assert.equal(response.results[2].value,256);
        assert(Buffer.byteLength(JSON.stringify(response))<2048);
        fs.writeFileSync(file,'*PARAMETER_EXPRESSION\nRbase,3.0\n*INCLUDE\nchild.k\n');
        assert.equal((await request()).results[0].value,768);
    });
    it('binds inline field expressions and keeps unresolved expressions incomplete', async () => {
        const { root, file } = fixture();
        const pool = createWorkerPool({ workerPath:path.resolve('out/worker/scanWorker.js'), entityStorageDirectory:path.join(root,'storage') });
        cleanup.push(()=>pool.dispose());
        const request = params => pool.projectSession({protocolVersion:1,...params});
        const query = {rootFile:file,scope:'single-file',targetKind:'material',id:5};
        for (const [expression, resolved] of [['<p7>',true],['<missing>',false],['<unknown(5)>',false]]) {
            fs.writeFileSync(file, '*KEYWORD\n*PARAMETER_EXPRESSION\nRp0,5.0\n' +
                Array.from({length:7},(_,i)=>`Rp${i+1},p${i}\n`).join('') +
                `*PART\npart\n7,0,${expression}\n*MAT_ELASTIC\n5,1,1,0.3\n*END\n`);
            const page = await followEntityQuery(request,query);
            const references = page.result.locations.filter(row=>row.role==='reference');
            if(resolved) {
                assert.equal(references.length,1,JSON.stringify(page.result));
                assert.equal(references[0].line,12);
            } else {
                assert.equal(references.length,0);
                assert.notEqual(page.result.state,'none');
                assert.notEqual(page.result.page.complete,true,JSON.stringify(page.result));
                assert(page.result.reasons.some(reason=>/parameter|expression/.test(reason)),JSON.stringify(page.result.reasons));
            }
            page.result.release();
        }
    });
    it('shows references even when hundreds of competing definitions already exist', async () => {
        const { file, query } = fixture();
        const service = new ProgressiveEntityQueries(async () => undefined, async (_, token, accept, sources) => {
            sources({ fileIndexes: new Map([[file, { sourceRevision: await entityFileRevision(file) }]]) });
            await accept(Array.from({ length: 250 }, (_, line) => ({ role: 'definition', filePath: file,
                line, startCharacter: 0, endCharacter: 1 })));
            await accept([{ role: 'reference', filePath: file, line: 300, startCharacter: 0, endCharacter: 1 }]);
            return { state: 'complete', reasons: [] };
        });
        cleanup.push(() => service.clear());
        const result = (await followEntityQuery(value => service.request(value), query)).result;
        assert.equal(result.locations.filter(row => row.role === 'definition').length, 100);
        assert.equal(result.locations.filter(row => row.role === 'reference').length, 1);
        const rest = await result.loadPage(result.page.next.definition);
        assert.equal(rest.result.locations.length, 150);
        result.release();
    });
    it('queries a dense definition file within a small workspace without preparing every definition preview', async () => {
        const { root, file } = fixture();
        fs.writeFileSync(file, '*KEYWORD\n' + Array.from({ length: 2000 }, (_, i) =>
            `*PART\npart ${i + 1}\n${i + 1},0,0\n`).join('') + '*SET_PART_LIST\n8000\n1500\n*END\n');
        const pool = createWorkerPool({ workerPath: path.resolve('out/worker/scanWorker.js'),
            entityMemoryBytes: 32 * 1024 * 1024, entityStorageDirectory: path.join(root, 'storage') });
        cleanup.push(() => pool.dispose());
        const result = await followEntityQuery(params => pool.projectSession({ protocolVersion: 1, ...params }),
            { rootFile: file, scope: 'single-file', id: 1500, targetKind: 'part' });
        assert.equal(result.state, 'complete', JSON.stringify(result.result.reasons));
        assert.equal(result.result.page.counts.definition, 1);
        assert.equal(result.result.page.counts.reference, 1);
        assert.equal(result.result.locations.filter(row => row.role === 'definition')[0].line, 4500);
        result.result.release();
    });
    it('resolves source navigation in the worker without returning its project index', async () => {
        const { root, file } = fixture();
        fs.writeFileSync(file, '*KEYWORD\n*PART\npart\n7,0,5\n*MAT_ELASTIC\n5,1,1,0.3\n*END\n');
        const pool = createWorkerPool({ workerPath: path.resolve('out/worker/scanWorker.js'), entityStorageDirectory: path.join(root, 'storage') });
        cleanup.push(() => pool.dispose());
        for (const mode of ['navigation', 'hover']) {
        const response = await pool.projectSession({ protocolVersion: 1, action: 'source-analysis', rootFile: file,
            scope: 'project', filePath: file, line: 3, mode,
            source: { referenceValue: { kind: 'numeric', id: 5, raw: '5', targetKinds: ['material'] },
                referenceInfo: { targetKinds: ['material'], targetDefinitions: [] } } });
        assert.equal(response.status, 'ready');
        assert.equal(response.analysis.state, 'exact', JSON.stringify({ reasons: response.analysis.reasons,
            definitions: response.analysis.definitions.map(row => ({ kind: row.kind, keyword: row.keyword, id: row.id,
                line: row.idLine, occurrenceId: row.occurrenceId })) }));
        assert.equal(response.analysis.definitions.length, 1);
        assert.equal(response.analysis.definitions[0].filePath, file);
        assert(!response.referenceIndex); assert(!response.snapshot); assert(!response.fileIndexes);
        assert(Buffer.byteLength(JSON.stringify(response)) < 1024 * 1024);
        }
    });
    it('publishes verified positions before completion, preserves page order, and deduplicates without whole-result memory', async () => {
        const { root, file, query } = fixture();
        const store = await EntityIndexStore.open(path.join(root, 'storage'));
        let proceed, started;
        const gate = new Promise(resolve => { proceed = resolve; });
        const first = new Promise(resolve => { started = resolve; });
        const service = new ProgressiveEntityQueries(async () => store, async (_, token, accept, sources) => {
            sources({ fileIndexes: new Map([[file, { sourceRevision: await entityFileRevision(file) }]]) });
            const rows = Array.from({ length: 230 }, (_, i) => ({ role: 'reference', filePath: file,
                line: i, startCharacter: 0, endCharacter: 1 }));
            await accept([{ role: 'definition', filePath: file, line: 1, startCharacter: 0, endCharacter: 1 }]);
            await accept(rows.slice(0, 100)); started(); await gate;
            await accept(rows);
            return { state: 'complete', reasons: [] };
        });
        cleanup.push(async () => { proceed(); await service.clear(); await store.close(); });
        const handle = await service.request({ action: 'query-open', query });
        await first;
        const partial = await service.request({ action: 'query-page', ...handle, role: 'reference' });
        assert.equal(partial.state, 'scanning');
        assert.equal(partial.result.state, 'partial');
        assert.equal(partial.result.locations.length, 100);
        assert.equal(partial.result.page.counts.reference, 100);
        proceed();
        let final;
        do { await new Promise(resolve => setTimeout(resolve, 5));
            final = await service.request({ action: 'query-page', ...handle, role: 'reference' });
        } while (final.state === 'scanning');
        assert.equal(final.state, 'complete');
        assert.equal(final.result.page.counts.reference, 230);
        assert.equal(final.result.locations.length, 200);
        const next = await service.request({ action: 'query-page', ...final.result.page.next.reference });
        assert.equal(next.result.locations.length, 30);
        assert.equal(new Set([...final.result.locations, ...next.result.locations].map(row => row.line)).size, 230);
        const combined = await followEntityQuery(value => service.request(value), query);
        assert.equal(combined.result.locations.length, 200);
        assert.equal(combined.result.locations.filter(row => row.role === 'reference').length, 199);
        const tail = await combined.result.loadPage(combined.result.page.next.reference);
        assert.equal(tail.result.locations.length, 31);
        assert.equal(new Set([...combined.result.locations.filter(row => row.role === 'reference'),
            ...tail.result.locations].map(row => row.line)).size, 230);
        combined.result.release();
        fs.appendFileSync(file, '$ edit\n');
        assert.equal((await service.request({ action: 'query-page', ...handle })).status, 'stale');
    });
    it('uses a bounded memory fallback and never calls a partial scan complete', async () => {
        const { file, query } = fixture();
        const service = new ProgressiveEntityQueries(async () => undefined, async (_, token, accept, sources) => {
            sources({ fileIndexes: new Map([[file, { sourceRevision: await entityFileRevision(file) }]]) });
            await accept(Array.from({ length: 100 }, (_, i) => ({ role: 'reference', filePath: file,
                line: i, startCharacter: 0, endCharacter: 1 })));
            return { state: 'complete', reasons: [] };
        }, 1024);
        cleanup.push(() => service.clear());
        const handle = await service.request({ action: 'query-open', query });
        let page;
        do { await new Promise(resolve => setImmediate(resolve)); page = await service.request({ action: 'query-page', ...handle }); }
        while (page.state === 'scanning');
        assert.equal(page.state, 'incomplete'); assert.equal(page.result.page.complete, false);
        assert(page.result.reasons.includes('entity-query-result-budget'));
    });
    it('serves real worker results through bounded pulls without a project snapshot', async () => {
        const { root, file } = fixture();
        fs.writeFileSync(file, '*KEYWORD\n*PART\npart\n7,0,5\n*MAT_ELASTIC\n5,1,1,0.3\n*END\n');
        const pool = createWorkerPool({ workerPath: path.resolve('out/worker/scanWorker.js'), entityStorageDirectory: path.join(root, 'storage') });
        cleanup.push(() => pool.dispose());
        const request = params => pool.projectSession({ protocolVersion: 1, ...params });
        const updates = [];
        const result = await followEntityQuery(request, { rootFile: file, scope: 'single-file', id: 7, targetKind: 'part' },
            response => updates.push(response));
        assert.equal(result.status, 'ready');
        assert.equal(result.state, 'complete');
        assert.equal(result.result.page.counts.definition, 1);
        assert.equal(result.result.locations[0].line, 3);
        assert(updates.some(update => update.state === 'scanning'));
        assert(!JSON.stringify(result).includes('fileIndexes'));
        result.result.release();
    });
});
