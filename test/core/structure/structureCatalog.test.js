'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    DEFAULT_STRUCTURE_SOURCE_PROFILE_BILINGUAL,
    DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
    KeywordStructureCatalog,
    keywordStructureRuntimeInternals,
} = require('../../../src/core/structure');

const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
const runtimeRoot = path.join(repositoryRoot, "keywords/runtime/structure-v2");

describe('KeywordStructureCatalog', () => {
    it('prepares one validated manifest for concurrent callers without loading a grammar', async () => {
        const catalog = new KeywordStructureCatalog({ runtimeRoot });
        const read = fs.promises.readFile;
        let reads = 0;
        fs.promises.readFile = async (...args) => { reads++; return read(...args); };
        try {
            await Promise.all([catalog.prepare(), catalog.prepare()]);
            assert.equal(reads, 1);
            assert.equal(catalog.hasKeywordIdentity('*NODE'), true);
            assert.equal(catalog.cacheStats().manifestReads, 1);
            assert.equal(catalog.cacheStats().shardReads, 0);
        } finally { fs.promises.readFile = read; }
    });

    it('does not reinstall a manifest after clear interrupts its asynchronous read', async () => {
        const catalog = new KeywordStructureCatalog({ runtimeRoot });
        const bytes = fs.readFileSync(path.join(runtimeRoot, 'manifest.json'));
        const read = fs.promises.readFile;
        let release;
        fs.promises.readFile = () => new Promise(resolve => { release = resolve; });
        try {
            const pending = catalog.prepare();
            catalog.clear(); release(bytes); await pending;
            assert.equal(catalog.cacheStats().manifestReads, 0);
            assert.equal(catalog.hasKeywordIdentity('*NODE'), true);
            assert.equal(catalog.cacheStats().manifestReads, 1);
        } finally { fs.promises.readFile = read; }
    });

    it('retains fail-closed manifest validation after asynchronous preparation', async () => {
        const catalog = new KeywordStructureCatalog({ runtimeRoot });
        const read = fs.promises.readFile;
        fs.promises.readFile = async () => Buffer.from('{"schemaVersion":2}');
        try {
            await catalog.prepare();
            assert.equal(catalog.hasKeywordIdentity('*NODE'), null);
            assert.equal(catalog.lookupBinding(DEFAULT_STRUCTURE_SOURCE_PROFILE_EN, '*NODE').status, 'unsupported-input');
        } finally { fs.promises.readFile = read; }
    });

    it('selects exact source profiles and does not load a shard for inventory-only lookups', () => {
        const catalog = new KeywordStructureCatalog({ runtimeRoot });
        const verified = catalog.lookupBinding(
            DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            '*mat_winfrith_concrete',
        );
        assert.equal(verified.status, 'verified');
        assert.equal(verified.binding.status, 'verified-full');
        assert.equal(catalog.cacheStats().manifestReads, 1);
        assert.equal(catalog.cacheStats().shardReads, 0);

        const grammar = catalog.grammarForKeyword(
            DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            '*MAT_WINFRITH_CONCRETE',
        );
        assert.equal(grammar.status, 'verified');
        assert.equal(grammar.grammar.keyword, '*MAT_WINFRITH_CONCRETE');
        assert.equal(grammar.grammar.verificationStatus, 'verified-full');
        assert.equal(catalog.cacheStats().shardReads, 1);
        catalog.grammarForKeyword(
            DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            '*MAT_WINFRITH_CONCRETE',
        );
        assert.equal(catalog.cacheStats().shardReads, 1, 'the verified shard must be cached');
    });

    it('reports every trust-boundary failure without falling back to English', () => {
        const catalog = new KeywordStructureCatalog({ runtimeRoot });
        assert.deepEqual(
            catalog.lookupBinding(null, '*MAT_WINFRITH_CONCRETE').status,
            'profile-unverified',
        );
        assert.equal(
            catalog.lookupBinding('f'.repeat(64), '*MAT_WINFRITH_CONCRETE').reason,
            'source-profile-not-packaged',
        );
        const title = catalog.lookupBinding(
            DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            '*MAT_WINFRITH_CONCRETE_TITLE',
        );
        assert.equal(title.status, 'profile-unverified');
        assert.equal(title.reason, 'variant-requires-reviewed-option-expansion');
        const bilingual = catalog.grammarForKeyword(
            DEFAULT_STRUCTURE_SOURCE_PROFILE_BILINGUAL,
            '*MAT_WINFRITH_CONCRETE',
        );
        assert.equal(bilingual.status, 'verified');
        assert.equal(bilingual.grammar.sourceProfileId, DEFAULT_STRUCTURE_SOURCE_PROFILE_BILINGUAL);
        assert.notEqual(
            bilingual.grammar.grammarId,
            catalog.grammarForKeyword(
                DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
                '*MAT_WINFRITH_CONCRETE',
            ).grammar.grammarId,
        );
    });

    it('fails closed on content-addressed shard tampering', () => {
        const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-catalog-tamper-'));
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'manifest.json'), 'utf8'));
            fs.writeFileSync(path.join(temporaryRoot, 'manifest.json'), JSON.stringify(manifest));
            const shardId = keywordStructureRuntimeInternals.shardIdForKeyword(
                '*MAT_WINFRITH_CONCRETE',
            );
            const descriptor = manifest.shards[shardId];
            const shardTarget = path.join(temporaryRoot, descriptor.file);
            fs.mkdirSync(path.dirname(shardTarget), { recursive: true });
            fs.copyFileSync(path.join(runtimeRoot, descriptor.file), shardTarget);
            fs.appendFileSync(shardTarget, '\n');

            const result = new KeywordStructureCatalog({ runtimeRoot: temporaryRoot })
                .grammarForKeyword(
                    DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
                    '*MAT_WINFRITH_CONCRETE',
                );
            assert.equal(result.status, 'unsupported-input');
            assert.match(result.reason, /shard-integrity-mismatch/);
        } finally {
            fs.rmSync(temporaryRoot, { recursive: true, force: true });
        }
    });

    it('rejects semantic tampering even when transport hashes are recomputed', () => {
        const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-catalog-rehash-'));
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'manifest.json'), 'utf8'));
            const shardId = keywordStructureRuntimeInternals.shardIdForKeyword(
                '*MAT_WINFRITH_CONCRETE',
            );
            const original = manifest.shards[shardId];
            const payload = JSON.parse(fs.readFileSync(path.join(runtimeRoot, original.file), 'utf8'));
            const grammarId = manifest.sourceProfiles[DEFAULT_STRUCTURE_SOURCE_PROFILE_EN]
                .bindings['*MAT_WINFRITH_CONCRETE'].grammarId;
            payload.grammars[grammarId].root.tampered = true;
            const bytes = Buffer.from(JSON.stringify(payload));
            const digest = crypto.createHash('sha256').update(bytes).digest('hex');
            const file = `shards/${shardId}.${digest.slice(0, 16)}.json`;
            manifest.shards[shardId] = { ...original, file, sha256: digest, bytes: bytes.length };
            fs.mkdirSync(path.join(temporaryRoot, 'shards'));
            fs.writeFileSync(path.join(temporaryRoot, file), bytes);
            fs.writeFileSync(path.join(temporaryRoot, 'manifest.json'), JSON.stringify(manifest));

            const result = new KeywordStructureCatalog({ runtimeRoot: temporaryRoot })
                .grammarForKeyword(
                    DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
                    '*MAT_WINFRITH_CONCRETE',
                );
            assert.equal(result.status, 'unsupported-input');
            assert.match(result.reason, /grammar-node-content-hash-mismatch/);
        } finally {
            fs.rmSync(temporaryRoot, { recursive: true, force: true });
        }
    });

    it('enforces a byte-bounded LRU and exposes deterministic cache metrics', () => {
        const catalog = new KeywordStructureCatalog({ runtimeRoot, cacheBytes: 60_000 });
        catalog.grammarForKeyword(
            DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            '*MAT_WINFRITH_CONCRETE',
        );
        catalog.grammarForKeyword(DEFAULT_STRUCTURE_SOURCE_PROFILE_EN, '*MAT_DAMAGE_1');
        const stats = catalog.cacheStats();
        assert.ok(stats.bytes <= stats.maximumBytes);
        assert.ok(stats.entries <= 1);
        assert.equal(stats.manifestReads, 1);
        assert.equal(stats.shardReads, 2);
    });
});
