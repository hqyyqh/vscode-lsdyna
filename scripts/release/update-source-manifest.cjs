'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const ROLES = new Set(['editable-source', 'authoring-input', 'generated-artifact', 'source-snapshot']);
const ROOT_FILES = new Set(['.gitattributes', '.gitignore', '.vscodeignore', 'CHANGELOG.md',
    'CONTRIBUTING.md', 'LICENSE', 'README.md', 'README_zh.md',
    'language-configuration.json', 'language-configuration-lspp-cfile.json',
    'package.json', 'package-lock.json', 'package.nls.json', 'package.nls.zh-cn.json', 'tsconfig.json',
    'requirements-dev.txt']);
const OMIT_ROOTS = new Set(['.git', '.artifacts', '.vscode-test', 'node_modules', 'out', 'dist', 'tmp',
    'coverage', 'pydyna']);
const SHA = /^[0-9a-f]{64}$/;
const BUILD_ONLY_REFERENCE = 'keywords/runtime/references/field_reference_index.json';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function safePath(file) {
    assert.ok(typeof file === 'string' && !file.includes('\\') && !path.isAbsolute(file) &&
        !file.split('/').some(part => !part || part === '.' || part === '..'), `Unsafe public path: ${file}`);
    return file;
}
function classifyPath(file) {
    if (file === 'keywords/README.md') return 'editable-source';
    safePath(file);
    if (file.startsWith('keywords/authoring/')) return 'authoring-input';
    if (file.startsWith('keywords/runtime/') || file === 'keywords/provenance/current-data.json' ||
        file.startsWith('snippets/') || file.startsWith('runtime-data/')) return 'generated-artifact';
    if (file.startsWith('keywords/sources/') || file.startsWith('keywords/provenance/') ||
        file.startsWith('test/evidence/') || file.startsWith('test/fixtures/relaxed-model-v1/'))
        return 'source-snapshot';
    if (ROOT_FILES.has(file) || /^(src|webview|test|scripts|docs|images|syntaxes|\.github|\.vscode)\//.test(file))
        return 'editable-source';
    throw Error(`Unknown public file responsibility: ${file}; declare an authoring/compiler boundary before adding engineering data`);
}
function inventory(root) {
    const files = [];
    const visit = relative => {
        for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
            if (!relative && (OMIT_ROOTS.has(entry.name) || entry.name === 'public-source-manifest.json' ||
                /\.vsix(?:\..*)?$/.test(entry.name))) continue;
            if (entry.name === 'node_modules' || entry.name === '__pycache__' ||
                entry.name.endsWith('.pyc') || entry.name === '.DS_Store') continue;
            const file = relative ? `${relative}/${entry.name}` : entry.name;
            assert.equal(entry.isSymbolicLink(), false, `Symlink in public source: ${file}`);
            if (file === BUILD_ONLY_REFERENCE) continue;
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile()) files.push(safePath(file));
            else throw Error(`Unsupported public entry: ${file}`);
        }
    };
    visit('');
    return files.sort();
}
function readManifest(root) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public-source-manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 2, 'Unsupported public source manifest');
    assert.equal(manifest.kind, 'dynasense-public-source');
    assert.equal(manifest.dataPolicy, 'publicly-regenerable-with-source-snapshots');
    assert.equal(manifest.generatorVersion, 2, 'Unsupported source export tool version');
    assert.match(manifest.generatorSha256, SHA);
    assert.ok(Array.isArray(manifest.files));
    const seen = new Set();
    for (const item of manifest.files) {
        safePath(item.path);
        assert.ok(!seen.has(item.path), `Duplicate public path: ${item.path}`);
        seen.add(item.path);
        assert.ok(ROLES.has(item.role), `Unknown role: ${item.path}`);
        assert.equal(item.role, classifyPath(item.path), `Role does not match responsibility: ${item.path}`);
        assert.match(item.sha256, SHA);
    }
    return manifest;
}
function checkSnapshotIdentity(root, manifest, actualFiles) {
    const actual = new Set(actualFiles);
    for (const item of manifest.files.filter(item => item.role === 'source-snapshot')) {
        assert.ok(actual.has(item.path), `Original source snapshot removed: ${item.path}`);
        assert.equal(sha256(fs.readFileSync(path.join(root, item.path))), item.sha256,
            `Original source snapshot changed: ${item.path}; preserve it and import a separately reviewed source version`);
    }
    const known = new Set(manifest.files.map(item => item.path));
    for (const file of actualFiles.filter(file => classifyPath(file) === 'source-snapshot'))
        assert.ok(known.has(file), `New source snapshot requires reviewed source import: ${file}`);
}
function checkData(root) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build/keywords/data.cjs'), '--check'],
        { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw Error(result.error?.message || result.stderr || result.stdout || 'Public data check failed');
}
function updateSourceManifest(root, { write = false, verifyData = checkData } = {}) {
    root = fs.realpathSync(root);
    const manifest = readManifest(root), actualFiles = inventory(root);
    checkSnapshotIdentity(root, manifest, actualFiles);
    verifyData(root);
    const previous = new Map(manifest.files.map(item => [item.path, item]));
    const files = actualFiles.map(file => ({
        path: file, role: classifyPath(file), sha256: sha256(fs.readFileSync(path.join(root, file))),
        reason: previous.get(file)?.reason || 'public-contribution'
    }));
    if (write) {
        // Keep exporter and historical acceptance identities. Inventory refresh does not certify external sources.
        const changed = JSON.stringify(files.map(({ path, role, sha256 }) => ({ path, role, sha256 }))) !==
            JSON.stringify(manifest.files.map(({ path, role, sha256 }) => ({ path, role, sha256 })));
        if (changed) manifest.acceptance = { ...manifest.acceptance, status: 'requires-independent-validation' };
        manifest.files = files;
        if (manifest.tests) manifest.tests.public = files.map(item => item.path).filter(file => /\.test\.[cm]?js$/.test(file));
        const stagingRoot = path.join(root, '.artifacts');
        fs.mkdirSync(stagingRoot, { recursive: true });
        const stage = fs.mkdtempSync(path.join(stagingRoot, 'source-manifest-'));
        try {
            const temporary = path.join(stage, 'public-source-manifest.json');
            fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n');
            fs.renameSync(temporary, path.join(root, 'public-source-manifest.json'));
        } finally {
            assert.equal(path.dirname(stage), stagingRoot);
            assert.match(path.basename(stage), /^source-manifest-/);
            fs.rmSync(stage, { recursive: true, force: true });
        }
    } else {
        assert.deepEqual(files.map(({ path, role, sha256 }) => ({ path, role, sha256 })),
            manifest.files.map(({ path, role, sha256 }) => ({ path, role, sha256 })),
            'Public inventory or bytes changed; run data:update, data:check and update:source-manifest -- --write');
    }
    return manifest;
}
module.exports = { ROLES, BUILD_ONLY_REFERENCE, sha256, safePath, classifyPath, inventory, readManifest,
    checkSnapshotIdentity, updateSourceManifest, checkData };
if (require.main === module) {
    try {
        assert.ok(process.argv.length === 3 && ['--check', '--write'].includes(process.argv[2]),
            'Usage: node scripts/release/update-source-manifest.cjs --check|--write');
        const result = updateSourceManifest(path.resolve(__dirname, '../..'), { write: process.argv[2] === '--write' });
        console.log(`Public source manifest ${process.argv[2].slice(2)} passed: ${result.files.length} files; external source identities unchanged.`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}

