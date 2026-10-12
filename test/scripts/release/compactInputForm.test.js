'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), zlib = require('node:zlib');
const { compactInputForm } = require("../../../scripts/release/compact-input-form.cjs");
const { sha } = require("../../../scripts/release/compact-release-stage.cjs");
const { CatalogInputFormCatalogV4 } = require("../../../out/core/semantics/catalogInputFormCatalogV4");
for (const codec of ['gzip', 'br']) describe(`shared Input Form release format (${codec})`, () => {
    let root, directory, manifestPath;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-input-test-'));
        directory = path.join(root, "keywords/runtime/input-form");
        manifestPath = path.join(root, 'out/runtime/lspp-input-form/manifest.json');
        fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        const raw = Buffer.from(JSON.stringify({ schemaVersion: 4, kind: "keyword-input-form-shard", datasetSha256: 'a'.repeat(64),
            keywords: { A: { formRuleIds: ['rule'] }, B: { formRuleIds: ['rule'], aliasOf: 'A' } },
            rules: { rule: { ruleId: 'rule', cards: [], values: [null, '', 0, false] } } }));
        const bytes = zlib.gzipSync(raw), hash = sha(raw);
        fs.writeFileSync(path.join(directory, hash + '.json.gz'), bytes);
        fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 4, kind: "keyword-input-form-manifest",
            dataset: { sha256: 'a'.repeat(64), datasetVersion: 'fixture', executable: 'private/path' }, auditSha256: 'b'.repeat(64),
            summary: { conservationSatisfied: true, unresolvedRelations: 0, safeWriteGaps: 0 },
            keywords: { A: { shard: hash }, B: { shard: hash } },
            shards: { [hash]: { file: hash + '.json.gz', sha256: sha(bytes), compressedBytes: bytes.length,
                uncompressedBytes: raw.length, uncompressedSha256: hash } } }));
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
    function catalog() {
        fs.copyFileSync(manifestPath, path.join(directory, 'manifest.json'));
        return new CatalogInputFormCatalogV4({ rootDir: directory });
    }
    it('preserves functional values, async loading and alias isolation', async () => {
        const expected = catalog().formForKeyword('A');
        compactInputForm(root, codec);
        const compact = catalog(); await compact.prepareKeyword('A');
        assert.deepEqual(compact.formForKeyword('A'), expected);
        compact.formForKeyword('A').rules.rule.values.push('mutation');
        assert.deepEqual(compact.formForKeyword('B').rules.rule.values, expected.rules.rule.values);
        assert.equal(compact.formForKeyword('UNKNOWN'), null);
        assert.ok(!fs.readFileSync(manifestPath, 'utf8').includes('private/path'));
    });
    it('reuses shared projections without sharing mutable form values or exceeding the cache budget', () => {
        compactInputForm(root, codec);
        const compact = catalog();
        const original = compact.formForKeyword('A');
        const manifest = JSON.parse(fs.readFileSync(manifestPath));
        const hash = manifest.keywords.A.ruleShards[0];
        const owner = compact.cache.get(hash), encoded = owner.projectedRules.get('rule');
        assert.ok(Buffer.isBuffer(encoded), 'shared projections must persist with their source shard');
        const bytes = owner.cacheBytes;
        original.rules.rule.values.push('mutation'); original.reference.formRuleIds.push('mutation');
        assert.deepEqual(compact.formForKeyword('B').rules.rule.values, [null, '', 0, false]);
        assert.deepEqual(compact.formForKeyword('A').reference.formRuleIds, ['rule']);
        assert.equal(owner.projectedRules.get('rule'), encoded);
        assert.equal(owner.cacheBytes, bytes);
        assert.equal(compact.cache.bytes, bytes);
        const limited = new CatalogInputFormCatalogV4({ rootDir: directory,
            maximumCacheBytes: manifest.shards[hash].uncompressedBytes });
        limited.formForKeyword('A');
        assert.equal(limited.cache.get(hash).projectedRules.size, 0);
        assert.equal(limited.cache.bytes, manifest.shards[hash].uncompressedBytes);
        compact.cache.set('evict', {}, 64 * 1024 * 1024);
        fs.appendFileSync(path.join(directory, manifest.shards[hash].file), 'tampered');
        assert.throws(() => compact.formForKeyword('A'), /integrity mismatch/);
    });
    it('keeps projected dataset bindings through shared-rule compaction', () => {
        // Construct the old schema keys: source projection also rewrites literal field names in tests.
        const sourceKey = ['pro', 'ducer'].join(''), shardSourceKey = sourceKey + 'Sha256';
        const manifest = JSON.parse(fs.readFileSync(manifestPath));
        const oldHash = manifest.keywords.A.shard, old = manifest.shards[oldHash];
        const shard = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(directory, old.file))));
        shard.kind = 'keyword-input-form-shard';
        manifest.kind = 'keyword-input-form-manifest';
        shard.datasetSha256 = shard.datasetSha256 || shard[shardSourceKey]; delete shard[shardSourceKey];
        const raw = Buffer.from(JSON.stringify(shard)), bytes = zlib.gzipSync(raw), hash = sha(raw);
        fs.writeFileSync(path.join(directory, hash + '.json.gz'), bytes);
        manifest.dataset = { sha256: (manifest.dataset || manifest[sourceKey]).sha256, datasetVersion: 'catalog-v1' };
        delete manifest[sourceKey];
        manifest.shards = { [hash]: { file: hash + '.json.gz', sha256: sha(bytes), compressedBytes: bytes.length,
            uncompressedBytes: raw.length, uncompressedSha256: hash } };
        for (const item of Object.values(manifest.keywords)) item.shard = hash;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        const released = path.join(root, 'out/runtime/catalog-input-form');
        fs.renameSync(path.dirname(manifestPath), released);
        manifestPath = path.join(released, 'manifest.json');
        compactInputForm(root, codec);
        const compact = JSON.parse(fs.readFileSync(manifestPath));
        assert.deepEqual(compact.dataset, manifest.dataset); assert.equal(compact[sourceKey], undefined);
        for (const item of Object.values(compact.shards)) {
            const compressed = fs.readFileSync(path.join(directory, item.file));
            const decoded = JSON.parse(codec === 'br' ? zlib.brotliDecompressSync(compressed) : zlib.gunzipSync(compressed));
            assert.equal(decoded.kind, shard.kind);
            assert.equal(decoded.datasetSha256, manifest.dataset.sha256); assert.equal(decoded[shardSourceKey], undefined);
            assert.deepEqual(decoded.rules.rule.values, [null, '', 0, false]);
        }
    });
    for (const fault of ['missing', 'tampered', 'path', 'version', 'length', 'reference']) it(`rejects ${fault} data`, () => {
        compactInputForm(root, codec);
        const m = JSON.parse(fs.readFileSync(manifestPath)), hash = m.keywords.A.ruleShards[0], s = m.shards[hash];
        if (fault === 'missing') fs.unlinkSync(path.join(directory, s.file));
        if (fault === 'tampered') fs.appendFileSync(path.join(directory, s.file), 'bad');
        if (fault === 'path') s.file = '../escape.json.gz';
        if (fault === 'version') m.storageVersion = 999;
        if (fault === 'length') s.uncompressedBytes = 1;
        if (fault === 'reference') m.keywords.A.reference.formRuleIds = ['missing-rule'];
        fs.writeFileSync(manifestPath, JSON.stringify(m));
        assert.throws(() => catalog().formForKeyword('A'));
    });
});
