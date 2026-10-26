'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const repo = path.resolve(__dirname, '../../..');
const create = require(path.join(repo, 'test/support/tempDirectories.js')).trackTempDirectories();
const script = path.join(repo, 'scripts/host/vsix-host.cjs');

describe('installed host diagnostic failure propagation', () => {
    async function scenario({ failure, hostError, development = false, driverCheck } = {}) {
        const root = create(path.join(os.tmpdir(), 'vsix-diagnostic-test-'));
        const executable = path.join(root, process.platform === 'darwin' ? 'Code.app/Contents/MacOS/Electron' : 'Code.exe');
        const extensions = path.join(root, 'extensions');
        const profile = path.join(root, 'profile'), evidence = path.join(root, 'evidence');
        const vsix = path.join(root, 'fixture.vsix');
        const cli = path.join(root, process.platform === 'darwin'
            ? 'Code.app/Contents/Resources/app/out/cli.js' : 'resources/app/out/cli.js');
        fs.mkdirSync(path.dirname(cli), { recursive: true });
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.writeFileSync(executable, 'synthetic executable');
        fs.writeFileSync(cli, '');
        fs.writeFileSync(vsix, 'synthetic install identity; subprocess verification is stubbed');
        const saveError = Object.assign(Error('Injected diagnostic failure'), { code: 'ENOSPC' });
        let hostFinished = false, calls = 0, resultFile;
        const logs = [];
        const adapter = { ...fs,
            readFileSync(file, ...args) {
                if (hostFinished && file === resultFile && failure === 'read') throw saveError;
                return fs.readFileSync(file, ...args);
            },
            writeFileSync(file, ...args) {
                if (hostFinished && file === resultFile && failure === 'write') throw saveError;
                return fs.writeFileSync(file, ...args);
            },
        };
        const options = { vscodeExecutablePath: executable, extensionDevelopmentPath: repo,
            extensionTestsPath: path.join(root, 'host.cjs'), launchArgs: ['--disable-extensions',
                `--extensions-dir=${extensions}`, `--user-data-dir=${profile}`] };
        const runDevelopmentTests = async received => {
            calls++;
            if (!development) {
                assert.notEqual(received.extensionDevelopmentPath, repo);
                assert.equal(received.launchArgs.includes('--disable-extensions'), false);
                assert.equal(received.extensionTestsEnv.NODE_PATH, '');
                resultFile = path.join(evidence, fs.readdirSync(evidence)[0]);
                const identity = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
                if (driverCheck) await driverCheck(received.extensionTestsPath, identity.installed, options.extensionTestsPath);
                fs.writeFileSync(resultFile, failure === 'json' ? 'invalid JSON' : JSON.stringify({ ...identity, vscodeVersion: '1.100.0' }));
            } else assert.equal(received, options);
            hostFinished = true;
            if (hostError) throw hostError;
            return 7;
        };
        const context = { module: { exports: {} }, console: { log() {}, error(...args) { logs.push(args); } },
            process: { platform: process.platform, pid: process.pid, env: development ? {} : {
                LSDYNA_TEST_VSIX: vsix, LSDYNA_TEST_VSIX_EVIDENCE: evidence } },
            require(name) {
                if (name === 'node:fs') return adapter;
                if (name === '@vscode/test-electron') return { runTests: runDevelopmentTests };
                if (name === 'node:child_process') return { spawnSync(_exe, args) {
                    if (args.includes('--install-extension')) {
                        const installed = path.join(extensions, 'hqyyqh.dynasense-fixture');
                        fs.mkdirSync(installed, { recursive: true });
                        fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ publisher: 'hqyyqh', name: 'dynasense', version: '1.0.0' }));
                    }
                    return { status: 0 };
                } };
                return require(name);
            },
        };
        vm.runInNewContext(fs.readFileSync(script, 'utf8'), context, { filename: script });
        let value, error;
        try { value = await context.module.exports.runTests(options); } catch (caught) { error = caught; }
        return { value, error, saveError, calls, logs, resultFile };
    }

    for (const failure of ['read', 'write', 'json']) {
        it(`preserves the primary host error and uncertainty when final ${failure} fails`, async () => {
            const primary = Object.assign(Error('Injected host failure'), { signal: 'SIGTERM', runtimeMayBeActive: true });
            const result = await scenario({ failure, hostError: primary });
            assert.equal(result.error, primary);
            assert.equal(result.error.signal, 'SIGTERM');
            assert.equal(result.error.runtimeMayBeActive, true);
            assert.equal(result.error.evidenceSaveFailed, true);
            assert.ok(result.error.evidenceError);
            if (failure !== 'json') assert.equal(result.error.evidenceError, result.saveError);
            assert.ok(result.logs.some(args => args.includes(result.error.evidenceError)));
        });
    }
    it('rejects a successful host whose final evidence cannot be saved', async () => {
        const result = await scenario({ failure: 'write' });
        assert.equal(result.error, result.saveError);
        assert.equal(result.error.evidenceSaveFailed, true);
    });
    it('preserves the measured host version and primary error on a clean evidence write', async () => {
        const passed = await scenario();
        assert.equal(passed.value, 7);
        assert.equal(passed.error, undefined);
        const saved = JSON.parse(fs.readFileSync(passed.resultFile, 'utf8'));
        assert.equal(saved.status, 'passed');
        assert.equal(saved.vscodeVersion, '1.100.0');
        const primary = Object.assign(Error('Injected cleanly closed host failure'), { signal: 'SIGTERM' });
        const failed = await scenario({ hostError: primary });
        assert.equal(failed.error, primary);
        assert.equal(JSON.parse(fs.readFileSync(failed.resultFile, 'utf8')).status, 'failed');
    });
    it('keeps development runs as direct calls', async () => {
        const result = await scenario({ development: true });
        assert.equal(result.value, 7);
        assert.equal(result.calls, 1);
        assert.equal(result.resultFile, undefined);
    });

    it('accepts canonical installed paths through a directory alias but rejects real dependency escapes', async () => {
        for (const canonicalParent of [false, true]) for (const escape of [false, 'outside', 'linked']) {
            const result = await scenario({ driverCheck: async (entry, installed, host) => {
                const alias = path.join(path.dirname(installed), 'alias');
                fs.symlinkSync(installed, alias, process.platform === 'win32' ? 'junction' : 'dir');
                const parent = path.join(canonicalParent ? installed : alias, 'index.js');
                fs.writeFileSync(parent, '');
                const inside = path.join(installed, 'dependency.js');
                const outside = path.join(path.dirname(installed), 'outside');
                fs.mkdirSync(outside);
                fs.writeFileSync(inside, '');
                fs.writeFileSync(path.join(outside, 'dependency.js'), '');
                const link = path.join(installed, 'linked');
                fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
                const resolved = escape === 'linked' ? path.join(link, 'dependency.js')
                    : escape ? path.join(outside, 'dependency.js') : inside;
                const Module = { _resolveFilename: () => resolved };
                const context = { exports: {}, process: { platform: process.platform, env: {} }, require(name) {
                    if (name === 'vscode') return { version: '1.100.0', extensions: { getExtension: () => ({ extensionPath: alias }) } };
                    if (name === 'node:module') return Module;
                    if (name === host) return { run: async () => Module._resolveFilename('dependency', { filename: parent }) };
                    return require(name);
                } };
                vm.runInNewContext(fs.readFileSync(entry, 'utf8'), context);
                await context.exports.run();
            } });
            if (escape) assert.match(String(result.error), /Installed runtime escaped its package/);
            else assert.equal(result.error, undefined);
        }
    });
});

// The macOS executable lives inside Contents/MacOS; resources are its sibling.
it('resolves the macOS installed CLI inside the app bundle', () => {
    const executable = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
    const expected = '/Applications/Visual Studio Code.app/Contents/Resources/app/out/cli.js';
    const context = { module: { exports: {} }, process: { platform: 'darwin' }, require(name) {
        if (name === 'node:path') return path.posix;
        if (name === 'node:fs') return { existsSync: file => file === expected, readdirSync: () => [] };
        return require(name);
    } };
    vm.runInNewContext(fs.readFileSync(script, 'utf8'), context);
    assert.equal(context.module.exports.resolveCliEntry(executable), expected);
});

it('resolves a renamed macOS executable from the bundle declaration and rejects traversal', () => {
    const root = create(path.join(os.tmpdir(), 'vscode-bundle-test-'));
    const old = path.join(root, 'Contents/MacOS/Electron'), actual = path.join(root, 'Contents/MacOS/Code');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(actual, 'synthetic executable');
    const plist = path.join(root, 'Contents/Info.plist');
    const { resolveExecutable } = require(script);
    assert.equal(resolveExecutable(undefined, 'darwin'), undefined);
    fs.writeFileSync(plist, '<key>CFBundleExecutable</key>\n<string>Code</string>');
    assert.equal(resolveExecutable(old, 'darwin'), actual);
    assert.equal(resolveExecutable(actual, 'darwin'), actual);
    assert.equal(resolveExecutable(old, 'linux'), old);
    fs.writeFileSync(plist, '<key>CFBundleExecutable</key><string>../outside</string>');
    assert.throws(() => resolveExecutable(old, 'darwin'), /unsafe/);
    fs.writeFileSync(plist, '<key>CFBundleExecutable</key><string>missing</string>');
    assert.throws(() => resolveExecutable(old, 'darwin'), /ENOENT/);
});

it('uses macOS Command shortcuts without changing Control-Space', async () => {
    const source = fs.readFileSync(path.join(repo, 'test/host/editor-safety/extension-host/index.js'), 'utf8');
    const start = source.indexOf('async function dispatchRendererKey(');
    const body = source.slice(start, source.indexOf('\n}', start) + 2);
    for (const platform of ['win32', 'linux', 'darwin']) {
        const context = { process: { platform } };
        vm.runInNewContext(body, context);
        for (const code of ['KeyA', 'KeyZ', 'Slash', 'Enter', 'Space']) {
            const events = [];
            await context.dispatchRendererKey({ call: async (_name, args) => events.push(args) }, '', code, 0, 2);
            assert.equal(events.length, 2);
            assert.ok(events.every(event => event.modifiers === (platform === 'darwin' && code !== 'Space' ? 4 : 2)));
        }
    }
});

it('case-sensitive host acceptance rejects invented fixes and document mutations', async () => {
    const source = fs.readFileSync(path.join(repo, 'test/host/editor-safety/extension-host/index.js'), 'utf8');
    const start = source.indexOf('async function assertCaseSensitiveIncludeRemainsUnresolved()');
    const body = source.slice(start, source.indexOf('\n}', start) + 2);
    for (const failure of [null, 'resolved', 'diagnostic', 'action', 'mutation']) {
        let text = '*INCLUDE\nsub/part.key', opened = 0;
        const document = { getText: () => text, isDirty: false, lineAt: () => ({ text: 'sub/part.key' }) };
        const context = { assert, path, workspaceRoot: '/fixture',
            fs: { existsSync: file => file.endsWith(path.join('Sub', 'Part.key')) },
            workspaceSnapshot: () => ({ original: true }),
            openFixture: async () => { opened++; return { document }; },
            vscode: { extensions: { getExtension: () => ({ extensionPath: '/installed' }) }, Range: class {} },
            require: () => ({ resolveIncludeWithCaseCheck: async () => ({ status: failure === 'resolved' ? 'exact' : 'missing' }),
                _internals: {
                    collectIncludePathCaseDiagnostics: async () => failure === 'diagnostic' ? [{ code: 'include-path-case-mismatch' }] : [],
                    LsdynaIncludePathCaseCodeActionProvider: class {
                        provideCodeActions() {
                            if (failure === 'mutation') text = 'changed';
                            return failure === 'action' ? [{ edit: {} }] : [];
                        }
                    },
                } }),
        };
        vm.runInNewContext(body, context);
        if (failure) await assert.rejects(context.assertCaseSensitiveIncludeRemainsUnresolved());
        else { await context.assertCaseSensitiveIncludeRemainsUnresolved(); assert.equal(opened, 2); }
    }
});
