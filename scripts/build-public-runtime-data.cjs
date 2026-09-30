'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const dataInput = file => /^(keywords|runtime-data|snippets)\//.test(file) || /^src\/.*\.json$/.test(file);

function verifyPublicData(directory = root) {
    directory = fs.realpathSync(directory);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'public-source-manifest.json')));
    assert.equal(manifest.schemaVersion, 1, 'Unsupported public source manifest');
    assert.equal(manifest.kind, 'dynasense-public-source');
    assert.equal(manifest.dataPolicy, 'verified-final-data');
    assert.equal(manifest.generatorVersion, 1, 'Unsupported source export tool version');
    assert.match(manifest.generatorSha256, /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 6);
    const paths = new Set();
    const dataPaths = new Set();
    for (const item of manifest.files) {
        assert.ok(typeof item.path === 'string' && !item.path.includes('\\') && !path.isAbsolute(item.path) &&
            !item.path.split('/').some(part => !part || part === '.' || part === '..'), 'Unsafe manifest path');
        assert.ok(!paths.has(item.path), `Duplicate manifest path: ${item.path}`);
        paths.add(item.path);
        assert.match(item.sha256, /^[0-9a-f]{64}$/);
        if (!dataInput(item.path)) continue;
        dataPaths.add(item.path);
        const file = path.join(directory, item.path);
        const resolved = fs.realpathSync(file);
        const relative = path.relative(directory, resolved);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `Data escaped candidate: ${item.path}`);
        assert.equal(fs.lstatSync(file).isSymbolicLink(), false, `Symlink data: ${item.path}`);
        assert.equal(sha256(fs.readFileSync(file)), item.sha256, `Published data changed: ${item.path}`);
    }
    const actual = new Set();
    const visit = relative => {
        const physical = path.join(directory, relative);
        assert.equal(fs.lstatSync(physical).isSymbolicLink(), false, `Symlink data path: ${relative}`);
        for (const entry of fs.readdirSync(physical, { withFileTypes: true })) {
            const child = `${relative}/${entry.name}`;
            assert.equal(entry.isSymbolicLink(), false, `Symlink data path: ${child}`);
            if (entry.isDirectory()) visit(child);
            else if (entry.isFile()) {
                if (dataInput(child) && !/\/(?:__pycache__\/[^/]+|[^/]+\.pyc)$/.test(child)) actual.add(child);
            }
            else throw Error(`Unsupported data entry: ${child}`);
        }
    };
    for (const name of ['keywords', 'runtime-data', 'snippets']) visit(name);
    if (fs.existsSync(path.join(directory, 'src'))) visit('src');
    assert.deepEqual([...actual].sort(), [...dataPaths].sort(), 'Unlisted or missing public data input');
    for (const file of ['keywords/field_data.json', 'keywords/field_data_zh.json',
        'keywords/pydyna-source.json', 'keywords/field_reference_index.json',
        'runtime-data/lspp-input-form/manifest.json', 'snippets/lsdyna.json']) {
        assert.ok(paths.has(file), `Missing published data input: ${file}`);
    }
    const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'keywords/pydyna-source.json')));
    assert.equal(provenance.upstream?.repository, 'ansys/pydyna');
    assert.equal(provenance.upstream?.commit, '367fea6c13ca7c8d2e28bd290d943395d84e77a3');
    return manifest;
}

function buildPublicRuntimeData(directory = root) {
    verifyPublicData(directory);
    require('./generate-field-schema-runtime.cjs').generateFieldSchemaRuntime({
        inputPath: path.join(directory, 'keywords/field_data.json'),
        schemaOutputPath: path.join(directory, 'out/runtime/field_schema.runtime.json.gz'),
    });
    // Run the candidate's help generator against its verified local data.
    const { spawnSync } = require('node:child_process');
    const help = spawnSync(process.execPath, [path.join(directory, 'scripts/generate-field-help-runtime.cjs')],
        { cwd: directory, encoding: 'utf8', windowsHide: true });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    fs.cpSync(path.join(directory, 'runtime-data'), path.join(directory, 'out/runtime'), { recursive: true });
}

module.exports = { verifyPublicData, buildPublicRuntimeData, sha256 };
if (require.main === module) {
    try { buildPublicRuntimeData(); console.log('Verified final data and built public runtime data.'); }
    catch (error) { console.error(error); process.exitCode = 1; }
}
