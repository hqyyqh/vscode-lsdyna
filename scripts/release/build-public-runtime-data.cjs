'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sourceManifest = require('./update-source-manifest.cjs');
const root = path.resolve(__dirname, '../..');
const sha256 = sourceManifest.sha256;
const { BUILD_ONLY_REFERENCE } = sourceManifest;

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
        'keywords/provenance/schema/pydyna-source.json',
        'runtime-data/lspp-input-form/manifest.json', 'snippets/lsdyna.json'])
        assert.ok(locked.some(item => item.path === file), `Missing published data input: ${file}`);
    if (!snapshotsOnly) {
        const expected = JSON.parse(fs.readFileSync(path.join(directory, 'keywords/provenance/current-data.json'))).outputs?.[BUILD_ONLY_REFERENCE];
        assert.match(expected || '', /^[0-9a-f]{64}$/, 'Missing generated reference identity');
        assert.equal(sha256(fs.readFileSync(path.join(directory, BUILD_ONLY_REFERENCE))), expected,
            'Generated reference index changed; rebuild and verify data');
    }
    const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'keywords/provenance/schema/pydyna-source.json')));
    assert.equal(provenance.upstream?.repository, 'ansys/pydyna');
    assert.equal(provenance.upstream?.commit, '367fea6c13ca7c8d2e28bd290d943395d84e77a3',
        'The original PyDYNA baseline identity must be retained');
    return manifest;
}

// Hash bytes and path sets, not timestamps: restored files and missing outputs must invalidate reuse.
function debugFingerprint(directory, roots) {
    const files = [];
    function visit(relative) {
        if (relative === BUILD_ONLY_REFERENCE && roots.includes('keywords')) return;
        const file = path.join(directory, relative);
        let stat;
        try { stat = fs.lstatSync(file); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            files.push([relative, null]); return;
        }
        assert.equal(stat.isSymbolicLink(), false, `Linked debug build input/output: ${relative}`);
        assert.equal(fs.realpathSync(file), file, `Debug build path escaped checkout: ${relative}`);
        if (stat.isDirectory()) {
            files.push([relative, 'directory']);
            for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`);
        } else {
            assert.ok(stat.isFile(), `Not a regular debug build file: ${relative}`);
            files.push([relative, sha256(fs.readFileSync(file))]);
        }
    }
    for (const relative of roots) visit(relative);
    return sha256(Buffer.from(JSON.stringify([process.versions, files])));
}

function buildPublicRuntimeData(directory = root, { ifCurrent = false } = {}) {
    directory = fs.realpathSync(directory);
    if (fs.existsSync(path.join(directory, 'public-source-manifest.json'))) verifyPublicData(directory, { snapshotsOnly: true });
    const out = path.join(directory, 'out');
    fs.mkdirSync(out, { recursive: true });
    assert.equal(fs.lstatSync(out).isSymbolicLink(), false, 'Build output must not be a symlink');
    assert.equal(fs.realpathSync(out), out, 'Build output escaped checkout');
    const stageRoot = path.join(out, 'data-build');
    if (fs.existsSync(stageRoot)) assert.equal(fs.realpathSync(stageRoot), stageRoot, 'Data stage escaped build directory');
    const lineagePath = path.join(stageRoot, 'keywords/provenance/current-data.json');
    const previousLineage = fs.existsSync(lineagePath) ? lineagePath : path.join(directory, 'keywords/provenance/current-data.json');
    const cachePath = path.join(out, 'debug-runtime-cache.json');
    const inputs = ['keywords', 'src/core', 'src/shared', 'src/manual', 'out/core', 'out/shared', 'out/manual', 'scripts',
        'package-lock.json', 'public-source-manifest.json'];
    const outputs = ['out/runtime', 'out/data-build/keywords/provenance/current-data.json', BUILD_ONLY_REFERENCE];
    let inputFingerprint;
    if (ifCurrent) {
        inputFingerprint = debugFingerprint(directory, inputs);
        let cached;
        try {
            assert.ok(fs.lstatSync(cachePath).isFile(), 'Debug runtime cache must be a regular file');
            cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        if (cached?.inputs === inputFingerprint && cached.outputs === debugFingerprint(directory, outputs)) return null;
    }
    // A failed or interrupted rebuild must never leave a previous success marker usable.
    if (fs.existsSync(cachePath)) {
        assert.ok(fs.lstatSync(cachePath).isFile(), 'Debug runtime cache must be a regular file');
        fs.unlinkSync(cachePath);
    }
    const owned = fs.existsSync(previousLineage) ? JSON.parse(fs.readFileSync(previousLineage)).derived || {} : {};
    const data = require('../build/keywords/data.cjs');
    const result = data.main(['--build'], directory);
    const staged = path.join(out, 'data-build/out/runtime');
    assert.ok(fs.existsSync(staged), 'Public data compiler did not create runtime output');
    assert.equal(fs.realpathSync(staged), staged, 'Staged runtime output escaped build directory');
    const runtime = path.join(out, 'runtime');
    if (fs.existsSync(runtime)) {
        assert.equal(fs.lstatSync(runtime).isSymbolicLink(), false, 'Runtime output must not be a symlink');
        assert.equal(path.dirname(fs.realpathSync(runtime)), out, 'Runtime output escaped build directory');
    }
    const files = new Map();
    function collect(folder, remove = false) {
        for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
            const file = path.join(folder, item.name);
            assert.equal(item.isSymbolicLink(), false, `Symlink runtime output: ${file}`);
            if (item.isDirectory()) collect(file, remove);
            else {
                assert.ok(item.isFile(), `Runtime output is not a regular file: ${file}`);
                const relative = `out/runtime/${path.relative(remove ? runtime : staged, file).split(path.sep).join('/')}`;
                if (!remove) files.set(relative, fs.readFileSync(file));
                else if (!files.has(relative)) {
                    assert.ok(Object.hasOwn(owned, relative), `Unlisted runtime artifact; review before removing: ${relative}`);
                    assert.equal(sha256(fs.readFileSync(file)), owned[relative], `Obsolete generated artifact was edited: ${relative}`);
                    files.set(relative, null);
                }
            }
        }
    }
    collect(staged);
    if (fs.existsSync(runtime)) collect(runtime, true);
    // This large derived file is omitted from public Git; compile restores it for
    // existing consumers. Its exact bytes remain checked by data lineage.
    if (fs.existsSync(path.join(directory, 'public-source-manifest.json')) &&
        !fs.existsSync(path.join(directory, BUILD_ONLY_REFERENCE))) {
        files.set(BUILD_ONLY_REFERENCE, fs.readFileSync(path.join(stageRoot, BUILD_ONLY_REFERENCE)));
    }
    data.publish(directory, files, undefined, { derived: true });
    if (ifCurrent) {
        assert.equal(debugFingerprint(directory, inputs), inputFingerprint, 'Debug data inputs changed during build; run again');
        require('../build/publish-files.cjs')([{ path: cachePath,
            bytes: JSON.stringify({ inputs: inputFingerprint, outputs: debugFingerprint(directory, outputs) }) + '\n' }]);
    }
    return result;
}
module.exports = { verifyPublicData, buildPublicRuntimeData, sha256 };
if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        assert.ok(!args.length || args.length === 1 && args[0] === '--if-current', 'Use --if-current or no arguments');
        const result = buildPublicRuntimeData(root, { ifCurrent: args.length === 1 });
        console.log(result === null ? 'Runtime data unchanged; verified cached input and output bytes.' :
            'Verified public engineering inputs and built runtime data.');
    }
    catch (error) { console.error(error); process.exitCode = 1; }
}

