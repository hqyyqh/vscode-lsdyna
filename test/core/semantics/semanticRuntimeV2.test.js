'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {
    SemanticRuntimeCatalogV2,
    semanticRuntimeV2Root,
} = require('../../../out/core/semantics/semanticRuntimeV2');

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stable(prefix, value) {
    return `${prefix}:${sha(Buffer.from(JSON.stringify(canonical(value)))).slice(0, 24)}`;
}

function derivedBindings(layout) {
    return layout.records.flatMap(record => record.fields.map(field => ({
        sourceFieldMigrationId: field.fieldMigrationId,
        targetFieldMigrationId: field.fieldMigrationId,
        evidenceId: stable('option-binding-evidence', [layout.profileId, field.fieldMigrationId]),
        ...(field.canonicalFieldIdentity ? { strategy: 'stable-physical-field-identity' } : {}),
    })));
}

function rewriteFirstOptionCandidate(root, mutate) {
    const manifestFile = path.join(root, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    for (const descriptor of manifest.optionShards) {
        const shardFile = path.join(root, descriptor.path);
        const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(shardFile)));
        for (const grammar of payload.records) for (const target of grammar.targets || []) {
            const candidate = target.layouts?.[0];
            if (!candidate) continue;
            mutate(candidate);
            const raw = Buffer.from(JSON.stringify(canonical(payload)));
            const compressed = zlib.gzipSync(raw, { level: 9, mtime: 0 });
            fs.writeFileSync(shardFile, compressed);
            Object.assign(descriptor, {
                compressedBytes: compressed.length,
                uncompressedBytes: raw.length,
                sha256: sha(compressed),
                contentSha256: sha(raw),
            });
            const { contentSha256: _contentSha256, ...core } = manifest;
            manifest.contentSha256 = sha(Buffer.from(JSON.stringify(canonical(core))));
            fs.writeFileSync(manifestFile, JSON.stringify(manifest));
            return target.spelling;
        }
    }
    throw new Error('option candidate fixture unavailable');
}

describe('semantic runtime catalog v2', () => {
    it('keeps synchronous shard failures closed during async preparation until a new catalog is created', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-runtime-v2-retry-'));
        try {
            fs.cpSync(semanticRuntimeV2Root(), root, { recursive: true });
            for (const domain of ['references', 'options']) {
                const catalog = new SemanticRuntimeCatalogV2(root);
                const descriptor = catalog.manifest()[domain === 'references' ? 'referenceShards' : 'optionShards'][0];
                const file = path.join(root, descriptor.path), bytes = fs.readFileSync(file);
                fs.writeFileSync(file, 'broken shard');
                assert.deepEqual(domain === 'references' ? catalog.allReferenceRecords() : catalog.allOptionGrammars(), []);
                fs.writeFileSync(file, bytes);
                await assert.rejects(() => catalog.prepareReferences(), /shard compressed drift/);
                assert.equal(catalog.status().ready, false);
                assert.deepEqual(catalog.allReferenceRecords(), []);
                const restored = new SemanticRuntimeCatalogV2(root);
                assert.equal((await restored.prepareReferences()).records.length, restored.manifest().summary.referenceRelations);
                assert.equal(restored.status().ready, true);
            }
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    it('loads the reference and option domains lazily from a source-locked manifest', () => {
        const catalog = new SemanticRuntimeCatalogV2();
        assert.equal(catalog.status().ready, true);
        const manifest = catalog.manifest();
        assert.ok(manifest.summary.referenceRelations >= 4021);
        assert.equal(manifest.summary.sourceManualRelations, 4021);
        assert.equal(manifest.summary.distinctManualRelations, 4021);
        assert.equal(manifest.summary.optionTargets, 4475);
        assert.equal(manifest.summary.editableOptionTargets, 4475);
        assert.equal(manifest.summary.optionMutationStates, 4535);
        assert.equal(manifest.summary.editableOptionMutationEdges, 130090);
        assert.equal(manifest.summary.blockedCrossCanonicalOptionMutationEdges, 77730);
        assert.equal(manifest.summary.definitionScanners, 1678);
        assert.equal(catalog.referenceRecordsForKeyword('PART').length > 0, true);
        assert.ok(catalog.optionGrammarForSpelling('*MAT_024_TITLE'));
    });

    it('fails closed when a permission or source identity is changed', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-runtime-v2-manifest-'));
        fs.cpSync(semanticRuntimeV2Root(), root, { recursive: true });
        const file = path.join(root, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        manifest.permissions.completenessClaim = true;
        fs.writeFileSync(file, JSON.stringify(manifest));
        const catalog = new SemanticRuntimeCatalogV2(root);
        assert.equal(catalog.status().ready, false);
        assert.deepEqual(catalog.referenceRecordsForKeyword('PART'), []);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('does not touch an unused shard until that shard is requested', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-runtime-v2-lazy-'));
        fs.cpSync(semanticRuntimeV2Root(), root, { recursive: true });
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
        const [badSpelling, badPrefix] = Object.entries(manifest.optionSpellingIndex)[0];
        const [goodSpelling] = Object.entries(manifest.optionSpellingIndex)
            .find(([, prefix]) => prefix !== badPrefix);
        const descriptor = manifest.optionShards.find(item => item.prefix === badPrefix);
        const file = path.join(root, descriptor.path);
        const corrupted = fs.readFileSync(file);
        corrupted[0] ^= 0xff;
        fs.writeFileSync(file, corrupted);

        const catalog = new SemanticRuntimeCatalogV2(root);
        assert.equal(catalog.status().ready, true);
        assert.ok(catalog.optionGrammarForSpelling(goodSpelling));
        assert.equal(catalog.status().ready, true);
        assert.equal(catalog.optionGrammarForSpelling(badSpelling), null);
        assert.equal(catalog.status().ready, false);
        assert.match(catalog.status().failureReason, /compressed drift/);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('materializes compact bindings and remains compatible with explicit bindings', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-runtime-v2-explicit-'));
        fs.cpSync(semanticRuntimeV2Root(), root, { recursive: true });
        const spelling = rewriteFirstOptionCandidate(root, candidate => {
            const bindings = derivedBindings(candidate.layout);
            delete candidate.bindingEncoding;
            candidate.bindings = bindings;
        });
        const grammar = new SemanticRuntimeCatalogV2(root).optionGrammarForSpelling(spelling);
        const candidate = grammar.targets.find(target => target.spelling === spelling).layouts[0];
        assert.deepEqual(candidate.bindings, derivedBindings(candidate.layout));
        assert.equal('bindingEncoding' in candidate, false);
        fs.rmSync(root, { recursive: true, force: true });
    });

    for (const [name, mutate] of [
        ['unknown encoding', candidate => {
            delete candidate.bindings;
            candidate.bindingEncoding = 'unknown-v1';
        }],
        ['encoding mixed with explicit bindings', candidate => {
            candidate.bindings = derivedBindings(candidate.layout);
            candidate.bindingEncoding = 'identity-derived-v1';
        }],
        ['encoding without a layout', candidate => {
            delete candidate.bindings;
            candidate.bindingEncoding = 'identity-derived-v1';
            delete candidate.layout;
        }],
    ]) {
        it(`fails closed for ${name}`, () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-runtime-v2-encoding-'));
            fs.cpSync(semanticRuntimeV2Root(), root, { recursive: true });
            const spelling = rewriteFirstOptionCandidate(root, mutate);
            const catalog = new SemanticRuntimeCatalogV2(root);
            assert.equal(catalog.optionGrammarForSpelling(spelling), null);
            assert.equal(catalog.status().ready, false);
            assert.match(catalog.status().failureReason, /binding (?:encoding|layout) invalid/);
            fs.rmSync(root, { recursive: true, force: true });
        });
    }
});
