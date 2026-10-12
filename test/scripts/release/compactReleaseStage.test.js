'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { compactStage, sha } = require("../../../scripts/release/compact-release-stage.cjs");
const { validateStaticRuntimeDependencies } = require("../../../scripts/release/validate-package-contents.cjs");
describe('release stage compaction', () => {
    it('retains staging when a required report cannot be saved, including after saving the failure report', async () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../../../scripts/release/package-hover-release.cjs'), 'utf8');
        const runtime = path.resolve(os.tmpdir(), 'dynasense-package-report-test');
        const evidence = path.resolve(os.tmpdir(), 'dynasense-package-evidence-test');
        for (const { failedReport, producerBytes, retain } of [
            { failedReport: 'failure.json', retain: true },
            { failedReport: 'baseline-metadata.json', retain: true },
            { failedReport: 'projection.json', retain: true },
            { failedReport: 'baseline-identity.json', retain: true },
            { failedReport: 'baseline-identity.json', producerBytes: '{', retain: true },
            { failedReport: 'baseline-identity.json', producerBytes: '{"complete":false}', retain: false },
            { failedReport: null, retain: false },
        ]) {
            const writes = [], releases = [], errors = [];
            const context = {
                __dirname: path.resolve(__dirname, '../../../scripts/release'),
                process: { argv: ['node', 'package-hover-release.cjs'], env: {}, execPath: process.execPath, platform: process.platform },
                console: { log() {}, error: message => errors.push(String(message)) },
                require: name => {
                    if (name === 'node:fs') return {
                        realpathSync: file => file,
                        existsSync: file => file.endsWith('public-source-manifest.json') && failedReport !== 'projection.json',
                        mkdirSync() {}, copyFileSync() {}, rmSync() {}, appendFileSync() {},
                        readFileSync: file => {
                            if (/^(projection|baseline-identity)\.json$/.test(path.basename(file))) {
                                if (producerBytes === undefined) throw Error('Missing producer report');
                                return producerBytes;
                            }
                            return JSON.stringify({ kind: 'dynasense-local-data-projection', outputs: {}, derived: {} });
                        },
                        writeFileSync: (file, bytes) => {
                            if (path.basename(file) === failedReport) throw Error('Injected report write failure');
                            writes.push({ file, bytes });
                        },
                    };
                    if (name === '../host/temp-runs.cjs') return {
                        createTempRun: () => runtime, createEvidenceDirectory: () => evidence,
                        finishTempRun: (root, options) => releases.push({ root, retain: options.retain }),
                    };
                    if (name === 'node:child_process') return { spawnSync: (command, args) => command === 'npm'
                        ? { status: !failedReport || failedReport === 'failure.json' ? 1 : 0, stderr: 'installation failed' }
                        : args.some(arg => arg.endsWith('verify-hover-vsix-identity.py'))
                            ? { status: 1, stderr: 'identity failed' } : { status: 0, stdout: '{}' } };
                    if (name === '@vscode/vsce/out/package') return { pack: async () => {} };
                    if (name === './validate-package-contents.cjs') return { listVsixFiles: () => [], validateVsix: () => [] };
                    if (name === './compact-release-stage.cjs') return { pruneInputFormShards() {} };
                    if (name === './public-release-reports.cjs') return {};
                    if (name === './build-public-runtime-data.cjs') return { verifyPublicData() {} };
                    if (name === './build-native-sqlite.cjs') return { copyNativeSqlite() {} };
                    if (name === './prepare-release-metadata.cjs') return { prepareReleaseMetadata: () => ({}) };
                    if (name === './project-public-runtime-data.cjs') return { projectPublicRuntimeData: () => { throw Error('Projection report write failed'); } };
                    if (name === '../../package.json') return { name: 'test', version: '0.0.0' };
                    return require(name);
                },
            };
            require('node:vm').runInNewContext(source.replace('main().catch(', 'globalThis.completion = main().catch('), context);
            await context.completion;
            assert.deepEqual(releases, [{ root: runtime, retain }]);
            assert.equal(context.process.exitCode, 1);
            assert.equal(errors.some(message => message.includes(runtime)), retain);
            assert.equal(writes.some(({ file }) => path.basename(file) === 'failure.json'), failedReport !== 'failure.json');
        }
    });
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
            write('node_modules/tar/dist/commonjs/index.js', 'build helper');
            write('node_modules/tar/LICENSE.md', 'license');
            write('node_modules/@vscode/sqlite3/build/Release/vscode-sqlite3.node', 'native driver');
            assert.match(validateStaticRuntimeDependencies([manifestFile, active, orphan], root).join(), /unreferenced/);
            compactStage(root);
            assert.deepEqual(fs.readFileSync(path.join(root, active)), encoded);
            assert.ok(!fs.existsSync(path.join(root, orphan)));
            assert.deepEqual(validateStaticRuntimeDependencies([manifestFile, active], root), []);
            const css = fs.readFileSync(path.join(root, assets + 'font.css'), 'utf8');
            assert.equal(css, '@font-face{font-family:Math;src:url(font.woff2) format("woff2")}');
            assert.ok(fs.existsSync(path.join(root, assets + 'font.woff2')));
            assert.ok(!fs.existsSync(path.join(root, assets + 'font.ttf')));
            const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
            assert.ok(ignore.includes('node_modules/tar/dist/commonjs/index.js'));
            assert.ok(!ignore.includes('node_modules/tar/LICENSE.md'));
            assert.ok(!ignore.includes('vscode-sqlite3.node'));
        } finally { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); }
    });
});
