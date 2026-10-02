const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    ManualSemanticCatalog,
} = require('../../../out/core/semantics/manualSemanticCatalog');

const runtimeRoot = path.resolve(__dirname, "../../../keywords/runtime/manual-semantics");

describe('manual semantic catalog', () => {
    it('shares asynchronous preparation, preserves values and reloads evicted shards', async () => {
        const sync = new ManualSemanticCatalog({ rootDir: runtimeRoot });
        const catalog = new ManualSemanticCatalog({ rootDir: runtimeRoot });
        await Promise.all(Array.from({ length: 8 }, () => catalog.prepareKeyword('MAT_DAMAGE_1')));
        assert.deepStrictEqual(catalog.rulesForKeyword('MAT_DAMAGE_1'), sync.rulesForKeyword('MAT_DAMAGE_1'));
        assert.equal(catalog.cacheStats().manifestReads, 1);
        assert.equal(catalog.cacheStats().shardReads, 1);
        catalog.clearCache();
        await catalog.prepareKeyword('MAT_DAMAGE_1');
        assert.equal(catalog.cacheStats().shardReads, 2);
    });
    it('does not read the manifest or a shard during construction', () => {
        const reads = [];
        const catalog = new ManualSemanticCatalog({
            rootDir: runtimeRoot,
            readFile(filePath) {
                reads.push(filePath);
                return fs.readFileSync(filePath);
            },
        });
        assert.deepEqual(catalog.cacheStats(), {
            manifestLoaded: false,
            manifestReads: 0,
            shardReads: 0,
            entries: 0,
            bytes: 0,
            maximumBytes: 2 * 1024 * 1024,
        });
        assert.deepEqual(reads, []);
    });

    it('loads one hash shard lazily and reuses it for warm lookups', () => {
        const catalog = new ManualSemanticCatalog({ rootDir: runtimeRoot });
        const first = catalog.fieldRules('CONTROL_THERMAL_TIMESTEP', 1, 'TMAX');
        assert.ok(first.some(rule => rule.kind === 'entity-reference'));
        assert.ok(first.some(rule => rule.kind === 'value-branch'));
        const coldStats = catalog.cacheStats();
        assert.equal(coldStats.manifestReads, 1);
        assert.equal(coldStats.shardReads, 1);
        assert.equal(coldStats.entries, 1);

        const second = catalog.fieldRules('*CONTROL_THERMAL_TIMESTEP', 1, 'TMAX');
        assert.equal(second.length, first.length);
        assert.equal(catalog.cacheStats().shardReads, 1);
    });

    it('exposes only uniquely mapped field selectors', () => {
        const catalog = new ManualSemanticCatalog({ rootDir: runtimeRoot });
        const material = catalog.fieldRules('*MAT_ADD_DAMAGE_GISSMO', 1, 'MID');
        assert.ok(material.some(rule =>
            rule.kind === 'entity-reference' &&
            rule.relation.targetKinds.includes('material')
        ));
        assert.ok(material.every(rule => rule.selector.cardIndex === 1));
        assert.deepEqual(catalog.fieldRules('*MAT_BARLAT_YLD2000', 2, 'A'), []);
    });

    it('exposes the reviewed profile registry and committed FLAG locations', () => {
        const catalog = new ManualSemanticCatalog({ rootDir: runtimeRoot });
        const summary = catalog.summary();
        const rules = catalog.fieldRules('*MAT_DAMAGE_1', 2, 'FLAG');
        const choice = rules.find(rule => rule.kind === 'field-choice');
        assert.equal(
            summary.evidenceAuthority.defaultSourceProfileId,
            '7228f3a1ffa8d305ed8800136c8447f288d95090cb540b170c52d7acef6be1e6',
        );
        assert.equal(summary.evidenceAuthority.profiles.length, 2);
        assert.ok(choice.evidence.length > 0);
        assert.ok(choice.evidence.every(item =>
            item.locations.some(location =>
                location.sourceProfileId === summary.evidenceAuthority.defaultSourceProfileId &&
                location.manualId === 'ls-dyna-dev-keyword-manual-vol-ii-material-models' &&
                location.page === 832
            ) &&
            item.locations.some(location =>
                location.sourceProfileId ===
                    'b4dfa3ef1f41ba19eee0a48679031c7bfb24081f4ef9ff523b42d6cec4e543b3' &&
                location.manualId === 'ls-dyna-dev-keyword-manual-vol-ii-material-models' &&
                location.page === 814
            )
        ));
    });

    it('uses a byte budget and can decline to retain an oversized shard', () => {
        const catalog = new ManualSemanticCatalog({
            rootDir: runtimeRoot,
            maximumCacheBytes: 1,
        });
        assert.ok(catalog.rulesForKeyword('*CONTROL_THERMAL_TIMESTEP').length > 0);
        assert.equal(catalog.cacheStats().entries, 0);
        assert.ok(catalog.rulesForKeyword('*CONTROL_THERMAL_TIMESTEP').length > 0);
        assert.equal(catalog.cacheStats().shardReads, 2);
    });

    it('checks the compressed shard hash before parsing', () => {
        const catalog = new ManualSemanticCatalog({
            rootDir: runtimeRoot,
            readFile(filePath) {
                const bytes = fs.readFileSync(filePath);
                if (filePath.endsWith('.json.gz')) {
                    const changed = Buffer.from(bytes);
                    changed[changed.length - 1] ^= 0xff;
                    return changed;
                }
                return bytes;
            },
        });
        assert.throws(
            () => catalog.rulesForKeyword('*CONTROL_THERMAL_TIMESTEP'),
            /integrity mismatch/,
        );
    });

    it('binds the current runtime manifest and conserves the protected checkpoint counts', () => {
        const crypto = require('node:crypto');
        const zlib = require('node:zlib');
        const repoRoot = path.resolve(__dirname, '../../..');
        const manifestFile = 'keywords/runtime/manual-semantics/manifest.json';
        const sourceFile = 'keywords/sources/manual-semantics/logical.json.gz';
        const manifestBytes = fs.readFileSync(path.join(repoRoot, manifestFile));
        const sourceBytes = fs.readFileSync(path.join(repoRoot, sourceFile));
        const manifest = JSON.parse(manifestBytes);
        const checkpoint = JSON.parse(zlib.gunzipSync(sourceBytes)).manifest.value;
        const lineage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'keywords/provenance/current-data.json')));
        const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
        assert.equal(lineage.outputs[manifestFile], sha(manifestBytes));
        assert.equal(lineage.inputs[sourceFile], sha(sourceBytes));
        assert.deepEqual(manifest.counts, checkpoint.counts);
        assert.deepEqual(manifest.sourceRuntime.counts, checkpoint.sourceRuntime.counts);
        assert.equal(manifest.counts.sourceRules, manifest.sourceRuntime.counts.rules);
        assert.equal(manifest.counts.packagedRules + manifest.counts.blockedRules, manifest.counts.sourceRules);
        assert.equal(manifest.counts.mappedFieldRules + manifest.counts.keywordRules, manifest.counts.packagedRules);
        assert.equal(Object.values(manifest.counts.blockedByReason).reduce((sum, count) => sum + count, 0), manifest.counts.blockedRules);
    });
});
