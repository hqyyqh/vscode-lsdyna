'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), assert = require('node:assert/strict');
const { sha } = require('./compact-release-stage.cjs');
function compactFieldHelp(stage) {
    const root = path.join(stage, 'out/runtime/field_help'), file = path.join(root, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file));
    for (const entry of [...manifest.shards, manifest.textIndex].filter(Boolean)) {
        const prefix = entry === manifest.textIndex ? '' : 'shards/';
        assert.match(entry.file, /^(\d{4}|text-index)\.json\.gz$/);
        const original = path.join(root, prefix, entry.file), compressed = fs.readFileSync(original);
        assert.equal(sha(compressed), entry.sha256);
        const raw = zlib.gunzipSync(compressed, { maxOutputLength: 16 * 1024 * 1024 });
        const encoded = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
        assert.deepEqual(zlib.brotliDecompressSync(encoded), raw);
        entry.file = entry.file.replace(/\.gz$/, '.br'); entry.sha256 = sha(encoded);
        if ('compressedBytes' in entry) entry.compressedBytes = encoded.length;
        fs.writeFileSync(path.join(root, prefix, entry.file), encoded); fs.unlinkSync(original);
    }
    manifest.storageCodec = 'br';
    fs.writeFileSync(file, JSON.stringify(manifest));
}
module.exports = { compactFieldHelp };
