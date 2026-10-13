const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const temporary = require('../support/tempDirectories').trackTempDirectories();
const { createDocumentSource } = require('../../out/client/services/documentSource');
const { BlockIndex } = require('../../out/core/incremental/blockIndex');
const { LiveFileSource } = require('../../out/worker/liveFileSource');
const { createWorkerPool } = require('../../out/worker/workerPool');
const { followEntityQuery } = require('../../out/client/services/progressiveEntityClient');

describe('versioned live document source', function() {
    this.timeout(60000);
    const cleanup = [];
    afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
    function fixture(text) {
        const root = temporary(path.join(os.tmpdir(), 'dynasense-live-source-'));
        const file = path.join(root, 'main.k');
        fs.writeFileSync(file, '*KEYWORD\n*PART\ndisk\n7,0,5\n*END\n');
        let lines = text.split('\n');
        const document = { uri: { scheme: 'file', fsPath: file, toString: () => 'file:///' + file },
            version: 1, isDirty: true, isClosed: false, get lineCount() { return lines.length; },
            lineAt: line => ({ text: lines[line] }) };
        let documents = [document], builds = 0;
        const indexes = new WeakMap();
        const read = createDocumentSource(() => documents, async doc => {
            let cached = indexes.get(doc);
            if (cached?.version === doc.version) return cached.index;
            const index = new BlockIndex(file);
            index.buildIndex(doc.lineCount, line => doc.lineAt(line).text);
            indexes.set(doc, { index, version: doc.version }); builds++;
            return index;
        });
        const reads = [];
        const source = request => { if (request.action === 'lines') reads.push(request); return read(request); };
        return { root, file, document, source, reads, builds: () => builds,
            edit: text => { lines = text.split('\n'); document.version++; },
            editCharacter: (line, character, text) => {
                const cached = indexes.get(document);
                lines[line] = lines[line].slice(0, character) + text + lines[line].slice(character + text.length);
                document.version++;
                assert(cached.index.updateIndex({ startLine: line, endLine: line, startCharacter: character,
                    endCharacter: character + text.length }, text, lines.length, line => lines[line]));
                cached.version = document.version;
            },
            reopen: () => { document.isClosed = true; documents = [{ ...document, isClosed: false,
                version: 1, lineCount: lines.length }]; } };
    }
    it('reuses the document block owner and rejects edits and reopened instances', async () => {
        const f = fixture('*KEYWORD\n*PART\nlive\n8,0,5\n*END\n');
        const source = new LiveFileSource(f.source);
        const first = await source.structure(f.file, {});
        const second = await source.structure(f.file, {});
        assert.equal(f.builds(), 1);
        const part = first.keywordBlocks.find(block => block.keyword === '*PART');
        assert.match(await source.blockText(part), /8,0,5/);
        assert.equal(first.documentRevision, second.documentRevision);
        f.edit('*KEYWORD\n*PART\nchanged\n9,0,5\n*END\n');
        await assert.rejects(source.blockText(part), { name: 'ScanChangedError' });
        const current = await source.signature(f.file);
        f.reopen();
        assert.notEqual((await source.signature(f.file)).sourceRevision, current.sourceRevision);
    });
    it('bounds Unicode line windows and reports an oversized line as incomplete', async () => {
        const f = fixture('*NODE\n' + Array.from({ length: 500 }, () => '中'.repeat(4000)).join('\n'));
        const live = await f.source({ protocolVersion: 1, action: 'describe', filePath: f.file });
        const page = await f.source({ protocolVersion: 1, action: 'lines', filePath: f.file,
            revision: live.revision, offset: 1, endLine: 500 });
        assert(page.rows.length < 200);
        assert(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
        f.edit('*NODE\n' + 'x'.repeat(65537));
        const source = new LiveFileSource(f.source);
        const index = await source.structure(f.file, {});
        const result = await source.scanBlockLines(index.keywordBlocks[0], () => assert.fail('Oversized text must not be published'));
        assert.equal(result.complete, false);
    });
    it('queries unsaved definitions through a real worker and invalidates old pages after an edit', async () => {
        const f = fixture('*KEYWORD\n*PART\nlive\n8,0,5\n*MAT_ELASTIC\n5,1,1,0.3\n*END\n');
        const pool = createWorkerPool({ workerPath: path.resolve('out/worker/scanWorker.js'),
            entityStorageDirectory: path.join(f.root, 'storage'), readDocumentSource: f.source });
        cleanup.push(() => pool.dispose());
        let handle;
        const request = async params => {
            const result = await pool.projectSession({ protocolVersion: 1, ...params });
            if (params.action === 'query-open') handle = result;
            return result;
        };
        const result = await followEntityQuery(request, { rootFile: f.file, scope: 'single-file', id: 8, targetKind: 'part' });
        assert.equal(result.state, 'complete');
        assert.equal(result.result.page.counts.definition, 1);
        assert.equal(result.result.locations[0].line, 3);
        f.edit('*KEYWORD\n*PART\nchanged\n9,0,5\n*END\n');
        const page = await result.result.loadPage({ ...handle, role: 'definition' });
        assert.equal(page.status, 'stale');
        result.result.release();
        const updated = await followEntityQuery(request, { rootFile: f.file, scope: 'single-file', id: 9, targetKind: 'part' });
        assert.equal(updated.result.page.counts.definition, 1);
        updated.result.release();
    });
    it('reuses unaffected live blocks after a normal record edit', async () => {
        const f = fixture('*KEYWORD\n*PART\nfirst\n18,0,5\n*PART\nsecond\n28,0,5\n*MAT_ELASTIC\n5,1,1,0.3\n*END\n');
        const pool = createWorkerPool({ workerPath: path.resolve('out/worker/scanWorker.js'),
            entityStorageDirectory: path.join(f.root, 'storage'), readDocumentSource: f.source });
        cleanup.push(() => pool.dispose());
        const request = params => pool.projectSession({ protocolVersion: 1, ...params });
        const first = await followEntityQuery(request, { rootFile: f.file, scope: 'single-file', id: 18, targetKind: 'part' });
        assert.equal(first.state, 'complete'); first.result.release();
        f.reads.length = 0; f.editCharacter(3, 1, '9');
        const updated = await followEntityQuery(request, { rootFile: f.file, scope: 'single-file', id: 19, targetKind: 'part' });
        assert.equal(updated.state, 'complete'); assert.equal(updated.result.page.counts.definition, 1);
        assert(f.reads.some(row => row.offset === 1));
        assert(!f.reads.some(row => row.offset === 4), 'the untouched second PART must reuse its block facts');
        updated.result.release();
    });
});
