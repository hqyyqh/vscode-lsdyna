'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const VERSION = '5.1.14-vscode';
const relative = 'node_modules/@vscode/sqlite3';
const binary = 'build/Release/vscode-sqlite3.node';
const manifest = 'build/native-build.json';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function copyNativeSqlite(root, stage, target) {
    const source = path.join(root, relative), destination = path.join(stage, relative);
    const built = JSON.parse(fs.readFileSync(path.join(source, manifest), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages[relative];
    if (built.driver !== VERSION || built.target !== target || built.integrity !== lock.integrity ||
        built.sha256 !== sha(path.join(source, binary))) throw Error('SQLite native build identity does not match this package');
    for (const file of [binary, manifest]) {
        fs.mkdirSync(path.dirname(path.join(destination, file)), { recursive: true });
        fs.copyFileSync(path.join(source, file), path.join(destination, file));
    }
    return built;
}

async function build(root = path.resolve(__dirname, '../..')) {
    const source = path.join(root, relative);
    if (JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version !== VERSION)
        throw Error(`Expected @vscode/sqlite3 ${VERSION}`);
    const env = { ...process.env, ...(process.platform === 'win32'
        ? { _LINK_: `${process.env._LINK_ || ''} /PDBALTPATH:%_PDB%` } : {}) };
    const rebuild = spawnSync('npm', ['rebuild', '@vscode/sqlite3', '--foreground-scripts', '--ignore-scripts=false'],
        { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
    if (rebuild.status !== 0) {
        const libraries = process.env.LSDYNA_SPECTRE_LIBS;
        if (process.platform !== 'win32' || process.arch !== 'x64' || !libraries)
            throw Error('SQLite native build failed. Install the matching MSVC Spectre libraries, or set LSDYNA_SPECTRE_LIBS to their verified build-only directory.');
        const lib = fs.realpathSync(libraries);
        for (const name of ['libcmt.lib', 'libvcruntime.lib']) if (!fs.existsSync(path.join(lib, name)))
            throw Error(`Missing Spectre library: ${name}`);
        const config = JSON.parse(fs.readFileSync(path.join(source, 'build/config.gypi'), 'utf8').replace(/^#.*\n/, ''));
        const result = spawnSync(config.variables.msbuild_path, ['build/binding.sln', '/nologo',
            '/p:Configuration=Release;Platform=x64',
            `/p:VC_LibraryPath_VC_Desktop_CurrentPlatform_spectre=${lib}`,
            `/p:VC_LibraryPath_VC_x64_Desktop_spectre=${lib}`], { cwd: source, env, stdio: 'inherit', windowsHide: true });
        if (result.status !== 0) throw Error('SQLite native build failed with the supplied Spectre libraries');
    }
    if (fs.readFileSync(path.join(source, binary)).toString('latin1').toLowerCase().includes(root.toLowerCase()))
        throw Error('SQLite binary embeds the private build directory');
    const sqlite = require(source);
    const db = await new Promise((resolve, reject) => {
        const value = new sqlite.Database(':memory:', error => error ? reject(error) : resolve(value));
    });
    try {
        const row = await new Promise((resolve, reject) => db.get('SELECT sqlite_version() AS version',
            (error, row) => error ? reject(error) : resolve(row)));
        const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages[relative];
        fs.writeFileSync(path.join(source, manifest), JSON.stringify({ driver: VERSION,
            target: `${process.platform}-${process.arch}`, integrity: lock.integrity,
            sha256: sha(path.join(source, binary)), sqlite: row.version, buildNode: process.version }, null, 2));
    } finally { await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }
}
module.exports = { build, copyNativeSqlite };
if (require.main === module) build().catch(error => { console.error(error); process.exitCode = 1; });
