'use strict';

// Explicit test-process injection: exercise real shards without declaring the
// unpublished catalog release-ready. Never imported by the extension runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getCatalogInputFormCatalogV4 } = require("../../out/core/semantics/catalogInputFormCatalogV4");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname,
    '../../keywords/lspp-input-form/manifest.json'), 'utf8'));
assert.equal(manifest.schemaVersion, 4);
assert.equal(manifest.kind, "keyword-input-form-manifest");
assert.match(manifest.dataset.sha256, /^[a-f0-9]{64}$/);
const catalog = getCatalogInputFormCatalogV4();
const productionLoad = catalog.loadManifest;
const productionForm = catalog.formForKeyword;
let candidateSource = null;
if (process.env.KEYWORD_MANAGER_CANDIDATE_PATH) {
    const bytes = fs.readFileSync(process.env.KEYWORD_MANAGER_CANDIDATE_PATH);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, process.env.KEYWORD_MANAGER_CANDIDATE_SHA256, 'test candidate identity changed');
    const candidate = JSON.parse(bytes);
    assert.equal(candidate.schemaVersion, 1);
    assert.equal(candidate.kind, 'lspp-input-form-diagnostic-candidate');
    assert.equal(candidate.closureReady, false);
    assert.equal(candidate.publicationAccepted, false);
    assert.equal(candidate.dataset.sha256, manifest.dataset.sha256);
    candidateSource = { path: process.env.KEYWORD_MANAGER_CANDIDATE_PATH, sha256: digest,
        authoringSha256: candidate.authoringSha256, geometryAuditSha256: candidate.geometryAuditSha256 };
    catalog.formForKeyword = keyword => {
        const normalized = String(keyword || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
        const reference = candidate.keywords[normalized];
        if (!reference) return null;
        const ids = Object.values(reference).filter(Array.isArray).flat();
        assert.ok(ids.every(id => candidate.rules[id]), 'candidate omitted referenced rules');
        return { keyword: normalized, reference,
            rules: Object.fromEntries(ids.map(id => [id, candidate.rules[id]])),
            source: { schemaVersion: 4, datasetVersion: candidate.dataset.datasetVersion,
                datasetSha256: candidate.dataset.sha256, conservationSatisfied: false } };
    };
} else {
    catalog.loadManifest = () => manifest;
    catalog.formForKeyword = function (keyword) {
        const form = productionForm.call(this, keyword);
        if (form) form.source.conservationSatisfied = false;
        return form;
    };
}

process.stderr.write(`DIAGNOSTIC ONLY: ${candidateSource ? 'SHA-bound EXE-reprojected candidate' : 'real shards with integrity checks'}; publication gate is not under test and is not passed.\n`);
module.exports = {
    manifest, candidateSource,
    restore() {
        catalog.loadManifest = productionLoad;
        catalog.formForKeyword = productionForm;
    },
};
