'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const auditFiles = ['authority-lock.json', 'build-report.json', 'proof-report.json'];
function pruneInputFormShards(stage) {
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'out/runtime/lspp-input-form/manifest.json')));
    const directory = path.join(stage, "keywords/runtime/input-form");
    const expected = new Set(Object.values(manifest.shards).map(item => path.basename(item.file)));
    for (const [hash, item] of Object.entries(manifest.shards)) {
        const bytes = fs.readFileSync(path.join(directory, path.basename(item.file)));
        assert.equal(bytes.length, item.compressedBytes);
        assert.equal(sha(bytes), item.sha256);
        const decoded = zlib.gunzipSync(bytes, { maxOutputLength: item.uncompressedBytes });
        assert.equal(decoded.length, item.uncompressedBytes);
        assert.equal(sha(decoded), hash);
    }
    // Only remove individual files in our newly created release stage, never authoring data.
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (item.isFile() && item.name.endsWith('.json.gz') && !expected.has(item.name))
            fs.unlinkSync(path.join(directory, item.name));
    }
    return expected;
}
function compactStage(stage) {
    const expected = pruneInputFormShards(stage);
    for (const name of auditFiles) fs.rmSync(path.join(stage, "keywords/runtime/semantic-v2", name), { force: true });
    const assets = path.join(stage, 'out/webview/manual-reader/assets');
    for (const name of fs.readdirSync(assets)) {
        const file = path.join(assets, name);
        if (name.endsWith('.css')) {
            const css = fs.readFileSync(file, 'utf8');
            // Some WOFF2 sources are data: URLs containing semicolons and commas.
            // Remove only the known trailing format alternatives, never split URLs.
            const compact = css.replace(/,\s*url\([^)]*\.(?:woff|ttf)["']?\)\s*format\(["'](?:woff|truetype)["']\)/g, '');
            assert.equal((compact.match(/@font-face/g) || []).length, (css.match(/@font-face/g) || []).length);
            assert.ok(!/url\([^)]*\.(woff|ttf)["')]/.test(compact), 'Legacy font references remain');
            fs.writeFileSync(file, compact);
        }
    }
    for (const name of fs.readdirSync(assets)) if (/\.(woff|ttf)$/.test(name)) fs.unlinkSync(path.join(assets, name));
    fs.appendFileSync(path.join(stage, '.vscodeignore'), '\n**/*.d.ts\n**/*.d.mts\n**/*.d.cts\nnode_modules/**/README*\nnode_modules/**/CHANGELOG*\nnode_modules/**/test/**\nnode_modules/**/tests/**\nnode_modules/**/docs/**\n');
    return { inputFormShards: expected.size };
}
module.exports = { compactStage, pruneInputFormShards, sha };
