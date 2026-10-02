'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { compactFieldHelp } = require("../../../scripts/release/compact-field-help.cjs");
const { sha } = require("../../../scripts/release/compact-release-stage.cjs");
describe('release field help codec', () => {
    it('preserves every English/localized byte, slot identity and source binding', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-help-test-'));
        const dir = path.join(root, 'out/runtime/field_help');
        try {
            fs.mkdirSync(path.join(dir, 'shards'), { recursive: true });
            const raw = Buffer.from(JSON.stringify({ english: ['full help', '', 'line\ntext'], localized: ['中文', null, '段落\n内容'] }));
            const bytes = zlib.gzipSync(raw), descriptor = { file: '0000.json.gz', sha256: sha(bytes), compressedBytes: bytes.length, start: 0, count: 3 };
            fs.writeFileSync(path.join(dir, 'shards', descriptor.file), bytes);
            fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ baseSha256: 'schema', shards: [descriptor] }));
            compactFieldHelp(root);
            const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'))), item = m.shards[0];
            assert.equal(m.baseSha256, 'schema'); assert.equal(m.storageCodec, 'br');
            assert.equal(item.count, 3); assert.equal(item.start, 0);
            const compressed = fs.readFileSync(path.join(dir, 'shards', item.file));
            assert.equal(sha(compressed), item.sha256); assert.equal(compressed.length, item.compressedBytes);
            assert.deepEqual(zlib.brotliDecompressSync(compressed), raw);
            assert.ok(!fs.existsSync(path.join(dir, 'shards/0000.json.gz')));
        } finally { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); }
    });
});
