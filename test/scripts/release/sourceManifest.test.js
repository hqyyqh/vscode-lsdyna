'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyPath, inventory, sha256, updateSourceManifest } =
    require('../../../scripts/release/update-source-manifest.cjs');

describe('public source contribution inventory', () => {
    let root;
    const write = (file, value) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), value);
    };
    const manifest = () => JSON.parse(fs.readFileSync(path.join(root, 'public-source-manifest.json')));
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-source-inventory-'));
        write('package.json', '{}\n');
        write('src/old.ts', 'export {};\n');
        write('keywords/sources/manifest.json', '{}\n');
        write('keywords/authoring/help.json', '{}\n');
        write('keywords/runtime/help.json', '{}\n');
        const files = inventory(root).map(file => ({ path: file, role: classifyPath(file),
            sha256: sha256(fs.readFileSync(path.join(root, file))), reason: 'fixture' }));
        write('public-source-manifest.json', JSON.stringify({
            schemaVersion: 2, kind: 'dynasense-public-source',
            dataPolicy: 'publicly-regenerable-with-source-snapshots', generatorVersion: 2,
            generatorSha256: 'a'.repeat(64), acceptance: { status: 'requires-independent-validation' }, files
        }));
    });
    afterEach(() => {
        assert.equal(path.dirname(root), os.tmpdir());
        assert.match(path.basename(root), /^dynasense-source-inventory-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    it('permits source additions, deletions and ordinary JSON fixtures after the public compiler check', () => {
        fs.unlinkSync(path.join(root, 'src/old.ts'));
        write('src/new.ts', 'export const answer = 42;\n');
        write('package.nls.zh-cn.json', '{"hello":"你好"}\n');
        write('test/fixtures/local-regression.json', '{}\n');
        write('keywords/authoring/help.json', '{"revision":2}\n');
        let checks = 0;
        const verifyData = () => { checks++; };
        assert.throws(() => updateSourceManifest(root, { verifyData }), /inventory or bytes changed/);
        const before = manifest();
        updateSourceManifest(root, { write: true, verifyData });
        assert.equal(checks, 2);
        assert.deepEqual(manifest().acceptance, before.acceptance);
        assert.equal(manifest().generatorSha256, before.generatorSha256);
        assert.ok(!manifest().files.some(item => item.path === 'src/old.ts'));
        assert.equal(manifest().files.find(item => item.path === 'test/fixtures/local-regression.json').role, 'editable-source');
        updateSourceManifest(root, { verifyData });
    });
    it('excludes nested Webview dependency caches while retaining ordinary Webview source', () => {
        write('webview/manual-reader/node_modules/.vite/vitest/results.json', '{}\n');
        updateSourceManifest(root, { verifyData: () => {} });
        write('webview/manual-reader/src/new.ts', 'export {};\n');
        updateSourceManifest(root, { write: true, verifyData: () => {} });
        assert.ok(manifest().files.some(item => item.path === 'webview/manual-reader/src/new.ts'));
        assert.ok(!manifest().files.some(item => item.path.includes('/node_modules/')));
    });
    it('cannot accept stale generated output or rewrite historical snapshots by refreshing hashes', () => {
        const original = fs.readFileSync(path.join(root, 'public-source-manifest.json'), 'utf8');
        write('keywords/runtime/help.json', '{"unbuilt":true}\n');
        assert.throws(() => updateSourceManifest(root, { write: true,
            verifyData: () => { throw Error('two-stage generated data mismatch'); } }), /generated data mismatch/);
        assert.equal(fs.readFileSync(path.join(root, 'public-source-manifest.json'), 'utf8'), original);
        write('keywords/sources/manifest.json', '{"fake-source":true}\n');
        assert.throws(() => updateSourceManifest(root, { write: true, verifyData: () => {} }), /source snapshot changed/);
        const modified = manifest();
        modified.files.find(item => item.path === 'keywords/sources/manifest.json').role = 'editable-source';
        write('public-source-manifest.json', JSON.stringify(modified));
        assert.throws(() => updateSourceManifest(root, { write: true, verifyData: () => {} }), /Role does not match/);
    });
    it('invalidates a previous current pass after a real contribution while retaining historical proof identity', () => {
        const accepted = manifest();
        accepted.acceptance = { status: 'passed', historicalProof: { commit: 'b'.repeat(40), sha256: 'c'.repeat(64) } };
        write('public-source-manifest.json', JSON.stringify(accepted));
        updateSourceManifest(root, { write: true, verifyData: () => {} });
        assert.deepEqual(manifest().acceptance, accepted.acceptance, 'Unchanged inventory need not invalidate acceptance');
        write('src/old.ts', 'export const revised = true;\n');
        updateSourceManifest(root, { write: true, verifyData: () => {} });
        assert.equal(manifest().acceptance.status, 'requires-independent-validation');
        assert.deepEqual(manifest().acceptance.historicalProof, accepted.acceptance.historicalProof);
        assert.equal(manifest().generatorSha256, accepted.generatorSha256);
    });
    it('classifies author rules and fixed evidence precisely and rejects undeclared engineering data', () => {
        assert.equal(classifyPath('keywords/authoring/engineering/keywordLayoutCorrections.json'), 'authoring-input');
        assert.equal(classifyPath('keywords/authoring/engineering/keywordSpellingAliases.json'), 'authoring-input');
        assert.equal(classifyPath('keywords/authoring/engineering/runtimeSemanticRelationCorrections.json'), 'authoring-input');
        assert.equal(classifyPath('keywords/authoring/engineering/runtimeTableLayoutCorrections.json'), 'authoring-input');
        assert.equal(classifyPath('scripts/build/keywords/text_sanitization.py'), 'editable-source');
        assert.equal(classifyPath('test/fixtures/relaxed-model-v1/fields/a.json.gz'), 'source-snapshot');
        assert.equal(classifyPath('test/fixtures/new-regression.k'), 'editable-source');
        assert.throws(() => classifyPath('keywords/unowned-engineering.json'), /Unknown public file responsibility/);
        assert.throws(() => classifyPath('../escaped.json'), /Unsafe public path/);
        write('keywords/sources/new-version.json', '{}\n');
        assert.throws(() => updateSourceManifest(root, { write: true, verifyData: () => {} }), /reviewed source import/);
    });
    it('scans a newly added source even before the contributor refreshes its inventory', () => {
        const location = ['C:', 'Users', 'private-owner', 'report.json'].join('/');
        write('src/unlisted.ts', `export const localPath = ${JSON.stringify(location)};\n`);
        const { validatePublicSourceBoundary } = require('../../../scripts/release/validate-public-source-boundary.cjs');
        assert.throws(() => validatePublicSourceBoundary(root), /src\/unlisted.ts/);
    });
});

