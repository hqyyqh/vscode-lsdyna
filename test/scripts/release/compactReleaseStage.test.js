'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { compactStage, sha } = require("../../../scripts/release/compact-release-stage.cjs");
const { validateStaticRuntimeDependencies } = require("../../../scripts/release/validate-package-contents.cjs");
describe('release stage compaction', () => {
    it('removes only orphan shards and alternate font encodings, preserving active bytes and font faces', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-release-test-'));
        const write = (file, bytes) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
        try {
            const raw = Buffer.from('{"rules":{}}'), encoded = zlib.gzipSync(raw), hash = sha(raw);
            const manifestFile = 'out/runtime/lspp-input-form/manifest.json';
            write(manifestFile, JSON.stringify({ shards: { [hash]: { file: hash + '.json.gz', sha256: sha(encoded),
                uncompressedSha256: hash, compressedBytes: encoded.length, uncompressedBytes: raw.length } } }));
            const active = `keywords/runtime/input-form/${hash}.json.gz`, orphan = "keywords/runtime/input-form/stale.json.gz";
            write(active, encoded); write(orphan, 'stale'); write('.vscodeignore', '');
            write("keywords/provenance/semantic-v2/build-report.json", '{}');
            const assets = 'out/webview/manual-reader/assets/';
            write(assets + 'font.css', '@font-face{font-family:Math;src:url(font.woff2) format("woff2"),url(font.woff) format("woff"),url(font.ttf) format("truetype")}');
            for (const ext of ['woff2', 'woff', 'ttf']) write(assets + 'font.' + ext, 'font');
            assert.match(validateStaticRuntimeDependencies([manifestFile, active, orphan], root).join(), /unreferenced/);
            compactStage(root);
            assert.deepEqual(fs.readFileSync(path.join(root, active)), encoded);
            assert.ok(!fs.existsSync(path.join(root, orphan)));
            assert.deepEqual(validateStaticRuntimeDependencies([manifestFile, active], root), []);
            const css = fs.readFileSync(path.join(root, assets + 'font.css'), 'utf8');
            assert.equal(css, '@font-face{font-family:Math;src:url(font.woff2) format("woff2")}');
            assert.ok(fs.existsSync(path.join(root, assets + 'font.woff2')));
            assert.ok(!fs.existsSync(path.join(root, assets + 'font.ttf')));
        } finally { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); }
    });
});
