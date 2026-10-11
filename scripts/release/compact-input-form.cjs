'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { sha } = require('./compact-release-stage.cjs');

// Only the staged release is transformed. Authoring evidence and v4 fixtures remain unchanged.
function compactInputForm(stage, codec = 'gzip') {
    const releaseManifest = path.join(stage, 'out/runtime/catalog-input-form/manifest.json');
    const manifestPath = fs.existsSync(releaseManifest) ? releaseManifest : path.join(stage, 'out/runtime/lspp-input-form/manifest.json');
    const source = JSON.parse(fs.readFileSync(manifestPath));
    const binding = source.dataset || source.dataset;
    const publicData = Boolean(source.dataset);
    assert.equal(source.schemaVersion, 4);
    assert.equal(source.summary.conservationSatisfied, true);
    assert.equal(source.summary.safeWriteGaps, 0);
    assert.equal(source.summary.unresolvedRelations, 0);
    assert.match(source.auditSha256, /^[a-f0-9]{64}$/);
    const directory = path.join(stage, "keywords/runtime/input-form");
    const rules = new Map(), references = new Map();
    let shardKind;
    for (const [hash, descriptor] of Object.entries(source.shards)) {
        const bytes = fs.readFileSync(path.join(directory, path.basename(descriptor.file)));
        assert.equal(sha(bytes), descriptor.sha256);
        assert.equal(bytes.length, descriptor.compressedBytes);
        const decoded = zlib.gunzipSync(bytes, { maxOutputLength: descriptor.uncompressedBytes });
        assert.equal(sha(decoded), hash);
        assert.equal(decoded.length, descriptor.uncompressedBytes);
        const shard = JSON.parse(decoded);
        if (shardKind === undefined) shardKind = shard.kind;
        assert.equal(shard.kind, shardKind, 'Input Form shard kinds differ');
        assert.equal(publicData ? shard.datasetSha256 : shard.datasetSha256, binding.sha256);
        for (const [id, rule] of Object.entries(shard.rules)) {
            if (rules.has(id)) assert.deepEqual(rules.get(id), rule, `Conflicting rule ${id}`);
            else rules.set(id, rule);
        }
        for (const [keyword, reference] of Object.entries(shard.keywords)) {
            if (source.keywords[keyword]?.shard !== hash) continue;
            references.set(keyword, reference);
        }
    }
    const buckets = Array.from({ length: 16 }, () => ({}));
    const bucketFor = id => parseInt(sha(Buffer.from(id))[0], 16);
    for (const id of [...rules.keys()].sort()) buckets[bucketFor(id)][id] = rules.get(id);
    // Keep 16 stable logical buckets but page them: a form must not parse megabytes
    // of unrelated rules just because their IDs share a hash prefix.
    const pages = [];
    for (const bucket of buckets) {
        let page = {}, bytes = 0;
        for (const [id, rule] of Object.entries(bucket)) {
            const size = Buffer.byteLength(JSON.stringify(rule));
            if (bytes && bytes + size > 256 * 1024) { pages.push(page); page = {}; bytes = 0; }
            page[id] = rule; bytes += size;
        }
        if (bytes) pages.push(page);
    }
    const shards = {}, ruleHashes = new Map(), output = new Map();
    for (const bucket of pages) {
        const decoded = Buffer.from(JSON.stringify({ schemaVersion: 4, kind: shardKind,
            [publicData ? 'datasetSha256' : "datasetSha256"]: binding.sha256, keywords: {}, rules: bucket }));
        assert.ok(['gzip', 'br'].includes(codec));
        const hash = sha(decoded), encoded = codec === 'br' ? zlib.brotliCompressSync(decoded,
            { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : zlib.gzipSync(decoded, { level: 9 });
        assert.ok(decoded.length <= 16 * 1024 * 1024, 'Shared rule shard exceeds decoded limit');
        const file = `${hash}.json.${codec === 'br' ? 'br' : 'gz'}`;
        shards[hash] = { file, sha256: sha(encoded), uncompressedSha256: hash,
            compressedBytes: encoded.length, uncompressedBytes: decoded.length };
        for (const id of Object.keys(bucket)) ruleHashes.set(id, hash);
        output.set(file, encoded);
    }
    const keywords = {};
    for (const keyword of Object.keys(source.keywords).sort()) {
        const reference = references.get(keyword);
        assert.ok(reference, `Missing keyword ${keyword}`);
        const ids = Object.values(reference).filter(Array.isArray).flat();
        for (const id of ids) assert.ok(rules.has(id), `Missing rule ${id}`);
        keywords[keyword] = { reference, ruleShards: [...new Set(ids.map(id => ruleHashes.get(id)))] };
    }
    const manifest = { schemaVersion: 4, storageVersion: 1, kind: source.kind,
        [publicData ? 'dataset' : "dataset"]: { sha256: binding.sha256,
            [publicData ? 'datasetVersion' : "datasetVersion"]: publicData ? binding.datasetVersion : binding.datasetVersion },
        summary: { conservationSatisfied: true, unresolvedRelations: 0, safeWriteGaps: 0 },
        auditSha256: source.auditSha256, sourceShardCount: Object.keys(source.shards).length, shards, keywords };
    for (const [file, bytes] of output) fs.writeFileSync(path.join(directory, file), bytes);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    for (const file of fs.readdirSync(directory)) if (/\.json\.(gz|br)$/.test(file) && !output.has(file)) fs.unlinkSync(path.join(directory, file));
    return { keywords: references.size, uniqueRules: rules.size, shards: output.size,
        compressedBytes: [...output.values()].reduce((sum, value) => sum + value.length, 0) };
}
module.exports = { compactInputForm };
