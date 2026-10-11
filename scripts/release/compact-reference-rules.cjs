'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { sha } = require('./compact-release-stage.cjs');
const PAGE_BYTES = 256 * 1024;

function compactReferenceRules(stage) {
    assert.ok(!fs.existsSync(path.join(stage, '.git')), 'Reference compaction requires an isolated release stage');
    const root = path.join(stage, 'keywords/runtime/references');
    const source = path.join(root, 'field_reference_index.json');
    const original = JSON.parse(fs.readFileSync(source));
    const manifest = { storageVersion: 1, codec: 'br', parts: {}, keywords: {}, referenceKinds: [] };
    const kinds = new Set();
    const { relationNamespaces } = require(path.join(stage, 'out/core/references/registryReferenceScanner.js'));
    for (const records of Object.values(original.references)) for (const record of records) {
        if (record.relation?.kind === 'non-reference') continue;
        for (const kind of relationNamespaces(record, undefined, null).targetKinds) kinds.add(kind);
    }
    manifest.referenceKinds = [...kinds].sort();
    const write = (key, value) => {
        const raw = Buffer.from(JSON.stringify(value));
        assert.ok(raw.length <= 16 * 1024 * 1024, `Reference part exceeds bound: ${key}`);
        const encoded = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
        assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(encoded)), value);
        const file = `${key.toLowerCase()}.json.br`;
        assert.ok(!Object.values(manifest.parts).some(part => part.file === file), 'Reference part filename collision');
        manifest.parts[key] = { file, compressedBytes: encoded.length, uncompressedBytes: raw.length,
            sha256: sha(encoded), contentSha256: sha(raw) };
        fs.writeFileSync(path.join(root, file), encoded);
    };
    const identity = {};
    for (const [key, value] of Object.entries(original)) {
        if (key === 'references') continue;
        if (['schemaVersion', 'generatedFrom', 'userReferenceExclusions'].includes(key)) identity[key] = value;
        write(key, value);
    }
    write('identity', identity);
    const buckets = Array.from({ length: 16 }, () => []);
    for (const keyword of Object.keys(original.references).sort()) {
        buckets[parseInt(sha(Buffer.from(keyword))[0], 16)].push(keyword);
    }
    for (let bucket = 0; bucket < buckets.length; bucket++) {
        let page = {}, bytes = 2, number = 0;
        const flush = () => {
            if (!Object.keys(page).length) return;
            const key = `references-${bucket.toString(16)}-${number++}`;
            write(key, page);
            for (const keyword of Object.keys(page)) manifest.keywords[keyword] = key;
            page = {}; bytes = 2;
        };
        for (const keyword of buckets[bucket]) {
            const entryBytes = Buffer.byteLength(JSON.stringify(keyword)) + 2 + Buffer.byteLength(JSON.stringify(original.references[keyword]));
            // Small pages keep alternating keywords resident in the 32 MiB cache.
            // One larger keyword stays whole; write() enforces the 16 MiB hard bound.
            if (bytes + entryBytes > PAGE_BYTES) flush();
            page[keyword] = original.references[keyword]; bytes += entryBytes;
        }
        flush();
    }
    assert.deepEqual(Object.keys(manifest.keywords).sort(), Object.keys(original.references).sort());
    fs.writeFileSync(path.join(root, 'reference-rules.manifest.json'), JSON.stringify(manifest));
    fs.unlinkSync(source);
    return { keywords: Object.keys(manifest.keywords).length, parts: Object.keys(manifest.parts).length };
}
module.exports = { compactReferenceRules };
