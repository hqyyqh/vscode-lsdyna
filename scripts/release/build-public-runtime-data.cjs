'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sourceManifest = require('./update-source-manifest.cjs');
const root = path.resolve(__dirname, '../..');
const sha256 = sourceManifest.sha256;

function verifyPublicData(directory = root, { snapshotsOnly = false } = {}) {
    directory = fs.realpathSync(directory);
    const manifest = sourceManifest.readManifest(directory);
    const locked = manifest.files.filter(item => item.role !== 'editable-source');
    const actual = sourceManifest.inventory(directory).filter(file => sourceManifest.classifyPath(file) !== 'editable-source');
    assert.deepEqual(actual, locked.map(item => item.path).sort(), 'Unlisted or missing public engineering input');
    for (const item of locked) {
        if (snapshotsOnly && item.role !== 'source-snapshot') continue;
        const file = path.join(directory, item.path);
        assert.equal(fs.lstatSync(file).isSymbolicLink(), false, `Symlink engineering input: ${item.path}`);
        const relative = path.relative(directory, fs.realpathSync(file));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Input escaped candidate: ${item.path}`);
        assert.equal(sha256(fs.readFileSync(file)), item.sha256,
            `Public engineering input changed: ${item.path}; run data:update, data:check and update:source-manifest -- --write`);
    }
    for (const file of ['keywords/sources/manifest.json', 'keywords/provenance/current-data.json',
        'keywords/runtime/schema/field_data.json', 'keywords/authoring/field_data_zh.json',
        'keywords/provenance/schema/pydyna-source.json', 'keywords/runtime/references/field_reference_index.json',
        'runtime-data/lspp-input-form/manifest.json', 'snippets/lsdyna.json'])
        assert.ok(locked.some(item => item.path === file), `Missing published data input: ${file}`);
    const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'keywords/provenance/schema/pydyna-source.json')));
    assert.equal(provenance.upstream?.repository, 'ansys/pydyna');
    assert.equal(provenance.upstream?.commit, '367fea6c13ca7c8d2e28bd290d943395d84e77a3',
        'The original PyDYNA baseline identity must be retained');
    return manifest;
}

function buildPublicRuntimeData(directory = root) {
    directory = fs.realpathSync(directory);
    if (fs.existsSync(path.join(directory, 'public-source-manifest.json'))) verifyPublicData(directory, { snapshotsOnly: true });
    const result = require('../build/keywords/data.cjs').main(['--build'], directory);
    const out = path.join(directory, 'out');
    assert.equal(fs.lstatSync(out).isSymbolicLink(), false, 'Build output must not be a symlink');
    assert.equal(fs.realpathSync(out), out, 'Build output escaped checkout');
    const staged = path.join(out, 'data-build/out/runtime');
    assert.ok(fs.existsSync(staged), 'Public data compiler did not create runtime output');
    const runtime = path.join(out, 'runtime');
    if (fs.existsSync(runtime)) {
        assert.equal(fs.lstatSync(runtime).isSymbolicLink(), false, 'Runtime output must not be a symlink');
        assert.equal(path.dirname(fs.realpathSync(runtime)), out, 'Runtime output escaped build directory');
        fs.rmSync(runtime, { recursive: true });
    }
    fs.cpSync(staged, runtime, { recursive: true });
    return result;
}
module.exports = { verifyPublicData, buildPublicRuntimeData, sha256 };
if (require.main === module) {
    try { buildPublicRuntimeData(); console.log('Verified public engineering inputs and built runtime data.'); }
    catch (error) { console.error(error); process.exitCode = 1; }
}

