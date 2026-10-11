'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { digest } = require('./compare-release-data.cjs');
const { sha } = require('./compact-release-stage.cjs');

// Transform only an isolated release stage; semantic payload bytes remain identical.
function compactSemanticRuntime(stage) {
    assert.ok(!fs.existsSync(path.join(stage, '.git')), 'Semantic compaction requires an isolated release stage');
    const root = path.join(stage, 'keywords/runtime/semantic-v2');
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    const { contentSha256, ...core } = manifest;
    assert.equal(digest(core), contentSha256);
    for (const descriptor of [...manifest.referenceShards, ...manifest.optionShards]) {
        assert.match(descriptor.path, /^(references|options)\/[0-9a-f]\.json\.gz$/);
        const source = path.join(root, descriptor.path);
        const encoded = fs.readFileSync(source);
        assert.equal(encoded.length, descriptor.compressedBytes);
        assert.equal(sha(encoded), descriptor.sha256);
        assert.ok(Number.isSafeInteger(descriptor.uncompressedBytes) && descriptor.uncompressedBytes > 0 &&
            descriptor.uncompressedBytes <= 16 * 1024 * 1024);
        const raw = zlib.gunzipSync(encoded, { maxOutputLength: descriptor.uncompressedBytes });
        assert.equal(raw.length, descriptor.uncompressedBytes);
        assert.equal(sha(raw), descriptor.contentSha256);
        const compressed = zlib.brotliCompressSync(raw, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
        });
        assert.deepEqual(zlib.brotliDecompressSync(compressed, { maxOutputLength: raw.length }), raw);
        assert.ok(compressed.length <= manifest.capacity.maxCompressedShardBytes);
        descriptor.path = descriptor.path.replace(/\.gz$/, '.br');
        descriptor.codec = 'br';
        descriptor.sha256 = sha(compressed);
        descriptor.compressedBytes = compressed.length;
        fs.writeFileSync(path.join(root, descriptor.path), compressed);
        fs.unlinkSync(source);
    }
    const { contentSha256: ignored, ...updated } = manifest;
    manifest.contentSha256 = digest(updated);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
}
module.exports = { compactSemanticRuntime };
