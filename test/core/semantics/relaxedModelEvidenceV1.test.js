'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
    RelaxedModelEvidenceV1Catalog,
    relaxedModelEvidenceV1Root,
    getRelaxedModelEvidenceV1Catalog,
    resetRelaxedModelEvidenceV1CatalogForTesting,
} = require('../../../out/core/semantics/relaxedModelEvidenceV1');

const sourceRoot = path.resolve(
    __dirname, '..', '..', 'fixtures', 'relaxed-model-v1',
);

describe('isolated relaxed-model evidence v1 catalog', () => {
    it('loads only the source-locked relaxed description records', function () {
        const catalog = new RelaxedModelEvidenceV1Catalog(sourceRoot);
        assert.equal(catalog.status().ready, true);
        assert.equal(catalog.status().sourceManifestSha256,
            crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, 'manifest.json'))).digest('hex'));
        assert.equal(catalog.runtimeEligible(), false);
        assert.equal(catalog.mutationEligible(), false);
        const records = catalog.records();
        assert.equal(records.length, 1);
        assert.equal(records[0].finalPhysicalFieldId,
            'global-manual-physical-field:58fe2ebe068155446803495b');
        assert.equal(records[0].descriptionEvidence.modelSemanticAuthorizationGranted, true);
        assert.equal(records[0].descriptionEvidence.humanReviewed, false);
        assert.match(records[0].officialDescriptionText, /Friction angle/i);
        assert.equal(catalog.recordForField(records[0].finalPhysicalFieldId), records[0]);
    });

    it('fails closed when the locked policy is changed', function () {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relaxed-model-v1-'));
        try {
            fs.cpSync(sourceRoot, root, { recursive: true });
            const manifestPath = path.join(root, 'manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            manifest.policy.pluginRuntimePermission = true;
            fs.writeFileSync(manifestPath, JSON.stringify(manifest));
            const catalog = new RelaxedModelEvidenceV1Catalog(root);
            assert.equal(catalog.status().ready, false);
            assert.deepEqual(catalog.recordsForFieldName('FRPLANE'), []);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not treat an absent source as an empty authorized catalog', () => {
        const catalog = new RelaxedModelEvidenceV1Catalog(
            path.join(os.tmpdir(), 'relaxed-model-v1-does-not-exist'),
        );
        assert.equal(catalog.status().ready, false);
        assert.equal(catalog.recordForField('anything'), null);
    });

    it('keeps an unconfigured catalog unavailable without any implicit disk reads', () => {
        let reads = 0;
        const catalog = new RelaxedModelEvidenceV1Catalog(null, () => { reads++; throw new Error('unexpected source read'); });
        assert.equal(catalog.status().ready, false);
        assert.equal(catalog.status().sourceManifestSha256, null);
        assert.match(catalog.status().failureReason, /source is not configured/);
        assert.deepEqual(catalog.recordsForFieldName('FRPLANE'), []);
        assert.equal(catalog.recordForField('anything'), null);
        assert.equal(catalog.runtimeEligible(), false);
        assert.equal(catalog.mutationEligible(), false);
        assert.equal(reads, 0);
        catalog.clear();
        assert.equal(catalog.status().ready, false);
        assert.equal(reads, 0);
    });

    it('loads the fixed source through the existing explicit environment root', () => {
        const previous = process.env.DYNASENSE_RELAXED_MODEL_ROOT;
        try {
            process.env.DYNASENSE_RELAXED_MODEL_ROOT = `  ${sourceRoot}  `;
            resetRelaxedModelEvidenceV1CatalogForTesting();
            assert.equal(relaxedModelEvidenceV1Root(), sourceRoot);
            const catalog = getRelaxedModelEvidenceV1Catalog();
            assert.equal(catalog.status().ready, true);
            assert.equal(catalog.recordsForFieldName('FRPLANE').length, 1);
            assert.equal(catalog.runtimeEligible(), false);
            assert.equal(catalog.mutationEligible(), false);
        } finally {
            if (previous === undefined) delete process.env.DYNASENSE_RELAXED_MODEL_ROOT;
            else process.env.DYNASENSE_RELAXED_MODEL_ROOT = previous;
            resetRelaxedModelEvidenceV1CatalogForTesting();
        }
    });

    it('reads the complete sixteen-shard source and rejects a missing or corrupted shard', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'manifest.json')));
        assert.equal(manifest.fieldShards.length, 16);
        assert.equal(new Set(manifest.fieldShards.map(shard => shard.prefix)).size, 16);
        assert.equal(manifest.fieldShards.reduce((sum, shard) => sum + shard.records, 0), manifest.summary.finalPhysicalFields);
        const reads = [];
        const valid = new RelaxedModelEvidenceV1Catalog(sourceRoot, file => { reads.push(file); return fs.readFileSync(file); });
        assert.equal(valid.status().ready, true);
        assert.equal(reads.length, 17);
        for (const damagedPrefix of ['0', 'f']) {
            const damaged = new RelaxedModelEvidenceV1Catalog(sourceRoot, file => {
                if (file.endsWith(path.join('fields', `${damagedPrefix}.json.gz`))) {
                    if (damagedPrefix === '0') throw new Error('missing shard');
                    return Buffer.from('corrupted shard');
                }
                return fs.readFileSync(file);
            });
            assert.equal(damaged.status().ready, false);
            assert.deepEqual(damaged.recordsForFieldName('FRPLANE'), []);
            assert.equal(damaged.recordForField('anything'), null);
        }
    });

    it('rejects forged origin identities instead of trusting manifest declarations', () => {
        for (const key of ['originManifestSha256', 'originContentSha256']) {
            const catalog = new RelaxedModelEvidenceV1Catalog(sourceRoot, file => {
                const bytes = fs.readFileSync(file);
                if (path.basename(file) !== 'manifest.json') return bytes;
                const manifest = JSON.parse(bytes);
                manifest[key] = '0'.repeat(64);
                return Buffer.from(JSON.stringify(manifest));
            });
            assert.equal(catalog.status().ready, false);
            assert.match(catalog.status().failureReason, /source manifest file identity drift/);
            assert.deepEqual(catalog.recordsForFieldName('FRPLANE'), []);
            assert.equal(catalog.recordForField('anything'), null);
            assert.equal(catalog.runtimeEligible(), false);
            assert.equal(catalog.mutationEligible(), false);
        }
    });
});
