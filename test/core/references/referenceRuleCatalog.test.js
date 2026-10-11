'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os');
const path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto');
const { ReferenceRuleCatalog } = require('../../../out/core/references/referenceRuleCatalog');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
describe('bounded reference rule catalog', () => {
    let root, manifest;
    function part(key, value) {
        const raw = Buffer.from(JSON.stringify(value)), encoded = zlib.brotliCompressSync(raw);
        const file = `${key}.json.br`;
        manifest.parts[key] = { file, sha256: sha(encoded), contentSha256: sha(raw),
            compressedBytes: encoded.length, uncompressedBytes: raw.length };
        fs.writeFileSync(path.join(root, file), encoded);
    }
    function save() { fs.writeFileSync(path.join(root, 'reference-rules.manifest.json'), JSON.stringify(manifest)); }
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-rules-test-'));
        manifest = { storageVersion: 1, codec: 'br', parts: {}, keywords: { A: 'a', B: 'b' }, referenceKinds: ['curve'] };
        part('identity', { schemaVersion: 8 });
        part('a', { A: [{ relation: { kind: 'reference', targetKind: 'curve' } }] });
        part('b', { B: [{ relation: { kind: 'reference', targetKind: 'table' } }] });
        save();
    });
    afterEach(() => {
        assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    });
    it('reads identity and keyword names without loading unrelated records', () => {
        fs.unlinkSync(path.join(root, 'b.json.br'));
        const catalog = new ReferenceRuleCatalog(root);
        assert.equal(catalog.identity().schemaVersion, 8);
        assert.deepEqual(catalog.keywords(), ['A', 'B']);
        assert.equal(catalog.records('A')[0].relation.targetKind, 'curve');
        assert.equal(catalog.records('MISSING'), undefined);
        assert.throws(() => catalog.records('B'), /ENOENT/);
        assert.throws(() => { catalog.records('A')[0].relation.targetKind = 'wrong'; }, TypeError);
    });
    it('merges concurrent reads and bounds the retained cache', async () => {
        const catalog = new ReferenceRuleCatalog(root, 100);
        const read = fs.promises.readFile;
        let reads = 0;
        fs.promises.readFile = async (...args) => { reads++; return read.apply(fs.promises, args); };
        try { await Promise.all([catalog.prepareKeyword('A'), catalog.prepareKeyword('A')]); }
        finally { fs.promises.readFile = read; }
        assert.equal(reads, 1);
        const first = catalog.records('A');
        catalog.records('B');
        const restored = catalog.records('A');
        assert.notEqual(restored, first);
        assert.equal(catalog.matchRecord(restored, first[0]), restored[0]);
        assert.equal(catalog.matchRecord(catalog.records('B'), first[0]), undefined);
        assert.equal(new ReferenceRuleCatalog(root).matchRecord(restored, first[0]), undefined);
    });
    for (const failure of ['compressed', 'decoded', 'path', 'limit', 'missing']) {
        it(`rejects ${failure} corruption instead of loading legacy data`, () => {
            fs.writeFileSync(path.join(root, 'field_reference_index.json'), JSON.stringify({ references: { A: [] } }));
            if (failure === 'compressed') fs.writeFileSync(path.join(root, 'a.json.br'), 'broken');
            if (failure === 'decoded') manifest.parts.a.contentSha256 = '0'.repeat(64);
            if (failure === 'path') manifest.parts.a.file = '../escape.json.br';
            if (failure === 'limit') manifest.parts.a.uncompressedBytes = 17 * 1024 * 1024;
            if (failure === 'missing') delete manifest.parts.a;
            save();
            assert.throws(() => new ReferenceRuleCatalog(root).records('A'), /Reference rule catalog/);
        });
    }
    it('loads the old developer format only when the new manifest is absent', () => {
        fs.unlinkSync(path.join(root, 'reference-rules.manifest.json'));
        fs.writeFileSync(path.join(root, 'field_reference_index.json'), JSON.stringify({ references: { A: [1] } }));
        const records = new ReferenceRuleCatalog(root).records('A');
        assert.deepEqual(records, [1]);
        assert.equal(records, require(path.join(root, 'field_reference_index.json')).references.A);
    });
    it('bounds actual decompression even when the compressed hash is valid', () => {
        part('a', { A: [{ text: 'x'.repeat(2048) }] });
        manifest.parts.a.uncompressedBytes = 64;
        save();
        assert.throws(() => new ReferenceRuleCatalog(root).records('A'), /larger than|size|length/i);
    });
    it('rejects a truncated stream whose compressed descriptor was recomputed', () => {
        const file = path.join(root, 'a.json.br');
        const truncated = fs.readFileSync(file).subarray(0, 5);
        fs.writeFileSync(file, truncated);
        manifest.parts.a.compressedBytes = truncated.length;
        manifest.parts.a.sha256 = sha(truncated);
        save();
        assert.throws(() => new ReferenceRuleCatalog(root).records('A'));
    });
    it('does not reuse a catalog from another data root', () => {
        const { getReferenceRuleCatalog } = require('../../../out/core/references/referenceRuleCatalog');
        const { setKeywordDataRootForBuild } = require('../../../out/core/keywordDataPath');
        try {
            setKeywordDataRootForBuild(root);
            const first = getReferenceRuleCatalog();
            setKeywordDataRootForBuild(path.join(root, 'other'));
            assert.notEqual(getReferenceRuleCatalog(), first);
        } finally { setKeywordDataRootForBuild(); }
    });
});
