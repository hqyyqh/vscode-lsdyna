'use strict';
// Public deterministic compiler; external collection and certification are separate.
const crypto = require('node:crypto');

function projectRuntimeManifest(bytes) {
    const source = JSON.parse(bytes.toString('utf8'));
    const publicData = source.kind === 'keyword-input-form-manifest';
    const identity = publicData ? source.dataset : source.dataset;
    if (source.schemaVersion !== 4 || (!publicData && source.kind !== "keyword-input-form-manifest") ||
        !/^[a-f0-9]{64}$/.test(identity?.sha256 || '') ||
        !/^[a-f0-9]{64}$/.test(source.auditSha256 || '') ||
        source.summary?.conservationSatisfied !== true || source.summary.unresolvedRelations !== 0 ||
        source.summary.safeWriteGaps !== 0 || !source.shards || !source.keywords) {
        throw new Error('Cannot project an unverified Input Form manifest');
    }
    // Projection preserves authority and shard identities; it does not issue a new audit.
    const result = {};
    for (const key of ['schemaVersion', 'kind', publicData ? 'dataset' : "dataset", 'summary', 'authoringSha256',
        'auditSha256', 'shards', 'keywords']) result[key] = source[key];
    result.sourceManifestSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    return Buffer.from(JSON.stringify(result) + '\n');
}

module.exports = { projectRuntimeManifest };
