'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const os = require('node:os'), zlib = require('node:zlib');
const { scanPublicSourceBoundary } = require("../../../scripts/release/validate-public-source-boundary.cjs");
describe('public source and package production boundary', () => {
    it('preserves the exact required relative source identity without allowing private paths or a renamed source', () => {
        const file = 'keywords/sources/definition-registry/authoring.json.gz';
        const location = ['lspp-keyword-' + 'database', 'normalized', 'link_census', 'authoring_semantic_handoff'].join('/');
        const scan = source => scanPublicSourceBoundary('', [file], {
            readFile: () => zlib.gzipSync(Buffer.from(JSON.stringify({ authorityLock: { source } })))
        });
        const expected = scan({ repositoryPath: location });
        assert.equal(expected.findings.length, 0);
        assert.equal(expected.exceptions.length, 1);
        assert.equal(scan({ repositoryPath: location + '-different' }).findings.length, 1);
        assert.equal(scan({ repositoryPath: ['C:', 'Users', 'maintainer', 'private-source'].join('/') }).findings.length, 1);
        const other = scanPublicSourceBoundary('', ['keywords/sources/other.json'], {
            readFile: () => Buffer.from(JSON.stringify({ source: { repositoryPath: location } }))
        });
        assert.equal(other.findings.length, 1);
    });
    it('inspects nested source paths in plain, gzip and Brotli data before packaging', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-boundary-'));
        try {
            const json = JSON.stringify({ rules: { observed: { proof: { path: 'E:' + '/custom-work/private-proof.json' } } } });
            for (const [file, bytes] of [['plain.json', json], ['gzip.json.gz', zlib.gzipSync(json)],
                ['brotli.json.br', zlib.brotliCompressSync(Buffer.from(json))]]) fs.writeFileSync(path.join(root, file), bytes);
            fs.writeFileSync(path.join(root, 'unc.json'), JSON.stringify({ rules: { observed: { proof: {
                path: String.fromCharCode(92).repeat(2) + 'server/share/private-proof.json' } } } }));
            const result = scanPublicSourceBoundary(root, ['plain.json', 'gzip.json.gz', 'brotli.json.br', 'unc.json']);
            assert.equal(result.findings.length, 4);
            assert.ok(result.findings.every(item => item.location === '$.rules.observed.proof.path'));
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
    it('detects private comments after nested templates while retaining synthetic model URIs', () => {
        const dataset = 'test/' + 'fixtures/' + 'lspp-native-' + 'formats/provenance.json';
        const code = "const uri = 'D:/model/main.k'; const x = `outer ${true ? `inner${1}` : ''}`;\n// " + dataset;
        const result = scanPublicSourceBoundary('', ['src/product.ts'], { readFile: () => Buffer.from(code) });
        assert.equal(result.findings.length, 1);
        assert.match(result.findings[0].location, /^comment:/);
    });
    it('rejects producer source paths without an isolated fixture exception', () => {
        const file = 'test/fixtures/relaxed-model-v1/manifest.json';
        const source = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../fixtures/relaxed-model-v1/manifest.json")));
        // Construct a fixture-shaped payload: the gate rejects paths even when an old source hash is present.
        source.source = { approval: { path: 'E:' + '/custom-work/unreviewed-source.json' } };
        const result = scanPublicSourceBoundary('', [file], { readFile: () => Buffer.from(JSON.stringify(source)) });
        assert.equal(result.findings.length, 1);
        assert.equal(result.findings[0].location, '$.source.approval.path');
    });
});
