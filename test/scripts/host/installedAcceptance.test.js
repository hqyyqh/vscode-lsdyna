'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const script = path.resolve(__dirname, '../../../scripts/host/run-installed-acceptance.cjs');
async function scenario({ executable, actualVersion = '1.100.0', explicitEvidence = true, resume, failScript, selected }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-acceptance-test-'));
    const vsix = path.join(root, 'candidate.vsix'), evidence = path.join(root, 'evidence');
    fs.writeFileSync(vsix, 'synthetic package identity');
    fs.writeFileSync(vsix + '.data-equivalence.json', JSON.stringify({ keywords: 1, formsFingerprint: 'synthetic' }));
    const digest = crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex');
    let downloads = 0; const executables = [], commands = [], errors = [];
    const processMock = { argv: [], platform: process.platform, arch: process.arch, execPath: process.execPath, env: {
        LSDYNA_TEST_VSIX: vsix, ...(explicitEvidence ? { LSDYNA_TEST_VSIX_EVIDENCE: evidence } : {}), VSCODE_TEST_VERSION: '1.100.0',
        ...(executable ? { VSCODE_EXECUTABLE_PATH: executable } : {}),
        ...(selected ? { LSDYNA_ACCEPTANCE_CASE: selected } : {}),
    } };
    if (resume) {
        processMock.env.LSDYNA_ACCEPTANCE_RESUME = path.join(root, 'previous.json');
        fs.writeFileSync(processMock.env.LSDYNA_ACCEPTANCE_RESUME, JSON.stringify({ vsixSha256: digest,
            platform: process.platform, arch: process.arch, requestedVscodeVersion: '1.100.0', ...resume }));
    }
    const context = { process: processMock, __dirname: path.dirname(script), console: { error(value) { errors.push(String(value)); } }, require(name) {
        if (name === 'node:path') return { ...path, resolve: (...args) => args[0] === '.artifacts/release-rebuild/installed-hosts' ? evidence : path.resolve(...args) };
        if (name === '@vscode/test-electron') return { async downloadAndUnzipVSCode() { downloads++; return 'downloaded-vscode'; } };
        if (name === './vsix-host.cjs') return { resolveExecutable: value => value };
        if (name === 'node:child_process') return { spawnSync(_node, _args, { env }) {
            assert.equal(env.LSDYNA_TEST_VSIX_EVIDENCE, evidence);
            assert.equal(path.dirname(env.LSDYNA_EXPECTED_CATALOG), evidence);
            assert.equal(JSON.parse(fs.readFileSync(env.LSDYNA_EXPECTED_CATALOG)).fingerprint, 'synthetic');
            executables.push(env.VSCODE_EXECUTABLE_PATH);
            commands.push(_args.slice(1).join(' ') || path.basename(_args[0]));
            if (path.basename(_args[0]) === failScript) return { status: 1, stdout: 'failed assertion detail', stderr: 'host stderr' };
            fs.writeFileSync(path.join(evidence, '1-1.json'), JSON.stringify({ sha256: digest, status: 'passed', vscodeVersion: actualVersion }));
            return { status: 0, stdout: '', stderr: '' };
        } };
        return require(name);
    } };
    try {
        vm.runInNewContext(fs.readFileSync(script, 'utf8').replace('main().catch', 'globalThis.completed = main().catch'), context);
        await context.completed;
        const file = path.join(evidence, 'acceptance.json');
        const report = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
        return { downloads, executables, commands, errors, report, exitCode: processMock.exitCode };
    } finally {
        assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    }
}
describe('installed acceptance executable and measured version', () => {
    it('keeps functional scenario evidence separate and records a real failure before stopping', async () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../../host/editor-safety/extension-host/index.js'), 'utf8');
        const body = source.split('            functional: async () => {')[1].split("            'parameter-rename':")[0];
        const names = [...body.matchAll(/^                        (assert\w+),$/gm)].map(match => match[1]);
        assert.equal(names.length, 32);
        for (const required of ['assertPasteIntoSelectedCellKeepsColumns', 'assertCellTypeIsLocalAndUndoable',
            'assertCellDeleteCannotModifyReadonlyDeck', 'assertOnBlurFormattingCannotModifyOsReadonlyDeck',
            'assertCloseUnsavedRevertKeepsDiskAndOtherFilesUnchanged']) assert.ok(names.includes(required));
        assert.ok(!names.some(name => /Latency|ContextMenu/.test(name)));
        for (const [platform, fail] of [['win32', null], ['linux', null], ['win32', names[2]]]) {
            let report; const called = [];
            const context = { process: { platform }, console: { log() {} }, workspaceRoot: 'fixture', path,
                fs: { writeFileSync(_file, value) { report = JSON.parse(value); } } };
            for (const name of names) context[name] = Object.defineProperty(async () => {
                called.push(name); if (name === fail) throw Error('safety assertion failed');
            }, 'name', { value: name });
            const run = vm.runInNewContext('({ functional: async () => {' + body + '}).functional', context);
            if (fail) await assert.rejects(run(), /safety assertion failed/); else await run();
            assert.equal(report.performance, 'unverified');
            assert.equal(report.nativeMenu, 'unverified');
            assert.equal(report.scope, 'editing-functional-only');
            assert.deepEqual(called, fail ? names.slice(0, 3) : names.filter(name => platform === 'win32' || name !== 'assertOnBlurFormattingCannotModifyOsReadonlyDeck'));
            if (platform !== 'win32') assert.equal(report.cases.find(item => item.name === 'assertOnBlurFormattingCannotModifyOsReadonlyDeck').status, 'unverified');
            assert.equal(report.cases.at(-1).status, fail ? 'failed' : 'passed');
        }
    });
    it('runs functional editing separately without passing the complete editor or performance gate', async () => {
        const result = await scenario({ selected: 'run-editor-safety-extension-host.cjs-functional' });
        assert.equal(result.exitCode, undefined);
        assert.equal(result.commands.length, 2);
        assert.ok(result.commands.includes('--functional'));
        assert.equal(result.report.complete, false);
        assert.ok(result.report.cases.some(item => item.name === 'run-editor-safety-extension-host.cjs-functional' && item.passed));
        assert.ok(!result.report.cases.some(item => item.name === 'run-editor-safety-extension-host.cjs'));
    });
    it('runs a selected batch once without claiming unselected cases passed', async () => {
        const result = await scenario({ selected: 'run-release-host.cjs-catalog, reload,run-release-host.cjs-catalog' });
        assert.equal(result.exitCode, undefined);
        assert.equal(result.commands.length, 3);
        assert.equal(result.commands.filter(name => name === 'catalog').length, 1);
        assert.ok(result.commands.includes('reload'));
        assert.equal(result.report.complete, false);
        assert.ok(!result.report.cases.some(item => item.name === 'run-editor-safety-extension-host.cjs'));
        const failed = await scenario({ selected: 'run-release-host.cjs-catalog,reload', failScript: 'run-release-host.cjs' });
        assert.equal(failed.exitCode, 1);
        assert.ok(failed.commands.includes('reload'));
        assert.equal(failed.report.complete, false);
        assert.equal(failed.report.cases.find(item => item.name === 'run-release-host.cjs-catalog').passed, false);
        assert.equal(failed.report.cases.find(item => item.name === 'reload').passed, true);
        const invalid = await scenario({ selected: 'reload,misspelled-case' });
        assert.equal(invalid.exitCode, 1);
        assert.equal(invalid.commands.length, 0);
    });
    it('reuses only the selected platform successful package job, without requiring unrelated platforms', () => {
        const { validateBuild } = require('../../../scripts/host/run-installed-acceptance-retry.cjs');
        const run = { workflowName: 'Public collaboration / 公开协作', jobs: [
            {name:'Build, data, tests, audit and actual VSIX (windows-2022, win32-x64)',conclusion:'success'},
            {name:'Build, data, tests, audit and actual VSIX (ubuntu-22.04, linux-x64)',conclusion:'failure'},
        ] };
        validateBuild(run, 'win32-x64');
        assert.throws(() => validateBuild(run, 'linux-x64'));
        run.jobs = [{name:'Selected node / Node / win32-x64 / package',conclusion:'success'}];
        validateBuild(run, 'win32-x64');
        run.jobs[0].conclusion = 'failure';
        assert.throws(() => validateBuild(run, 'win32-x64'));
        run.jobs[0].conclusion = 'success'; run.workflowName = 'unrelated';
        assert.throws(() => validateBuild(run, 'win32-x64'));
    });
    it('runs only the selected failed case and integrity check, retaining earlier passes as partial evidence', async () => {
        const result = await scenario({ selected: 'run-keyword-manager-gui.cjs', resume: {
            sourceRun: '123', cases: [{ name: 'run-release-host.cjs-catalog', passed: true }],
        } });
        assert.equal(result.exitCode, undefined);
        assert.equal(result.commands.length, 2);
        assert.ok(result.commands.includes('run-keyword-manager-gui.cjs'));
        assert.equal(result.report.complete, false);
        assert.ok(result.report.cases.find(item => item.name.endsWith('-catalog')).reused);
        const invalid = await scenario({ selected: 'misspelled-case' });
        assert.equal(invalid.exitCode, 1);
        assert.equal(invalid.commands.length, 0);
    });
    it('resumes passed cases but reruns failed cases and preserves diagnostics', async () => {
        const resume = { sourceRun: '123', cases: [
            { name: 'run-release-host.cjs-catalog', passed: true },
            { name: 'run-release-host.cjs-smoke', passed: false }] };
        const result = await scenario({ resume });
        assert.ok(!result.commands.includes('catalog'));
        assert.ok(result.commands.includes('smoke'));
        assert.equal(result.report.complete, true);
        assert.equal(result.report.reusedFromRun, '123');
        assert.ok(result.report.cases.find(item => item.name.endsWith('-catalog')).reused);
        const failed = await scenario({ resume, failScript: 'run-release-host.cjs' });
        assert.equal(failed.exitCode, 1);
        assert.equal(failed.report.complete, false);
        assert.ok(failed.errors.join('\n').includes('failed assertion detail'));
        assert.ok(failed.errors.join('\n').includes('host stderr'));
        for (const identity of [{ vsixSha256: 'wrong' }, { requestedVscodeVersion: '1.139.1' }, { arch: 'wrong' }]) {
            const rejected = await scenario({ resume: { ...resume, ...identity } });
            assert.equal(rejected.exitCode, 1);
            assert.equal(rejected.commands.length, 0);
        }
    });
    it('rejects evidence reuse after product or case changes and mismatched report identities', () => {
        const { validateChanges, validateReport } = require('../../../scripts/host/run-installed-acceptance-retry.cjs');
        validateChanges(['scripts/host/run-installed-acceptance.cjs', '.github/workflows/public-ci.yml']);
        for (const file of ['src/extension.ts', 'package-lock.json', 'test/support/devtools.cjs'])
            assert.throws(() => validateChanges([file]), /Cannot reuse/);
        assert.deepEqual([...validateChanges(['test/host/release/host.cjs', 'test/scripts/host/hostInstrumentation.test.js'])], ['*']);
        assert.deepEqual([...validateChanges(['test/host/editor-safety/extension-host/index.js'])], ['run-editor-safety-extension-host.cjs', 'run-editor-safety-extension-host.cjs-functional']);
        assert.deepEqual([...validateChanges(['test/support/editor-safety/native-menu.cjs', 'test/scripts/host/nativeMenu.test.js'])],
            ['run-editor-safety-extension-host.cjs', 'run-editor-safety-extension-host.cjs-functional']);
        assert.deepEqual([...validateChanges(['scripts/host/run-keyword-manager-gui.cjs', 'test/host/keyword-manager/extension-host.cjs'])],
            ['run-keyword-manager-gui.cjs', 'run-keyword-manager-gui.cjs-incomplete']);
        assert.deepEqual([...validateChanges(['scripts/host/vsix-host.cjs'])], ['*']);
        assert.deepEqual([...validateChanges(['test/support/release/rendered.cjs'])], ['performance', 'offline', 'missing-external-manual']);
        assert.deepEqual([...validateChanges(['scripts/benchmark/benchmark-release-hosts.cjs'])], ['performance']);
        const report = { vsixSha256: 'a', platform: 'linux', arch: 'x64', cases: [] };
        const expected = { digest: 'a', target: 'linux-x64', version: '1.100.0' };
        validateReport(report, expected);
        assert.throws(() => validateReport({ ...report, vsixSha256: 'b' }, expected), /another VSIX/);
        assert.throws(() => validateReport({ ...report, arch: 'arm64' }, expected), /target mismatch/);
        assert.throws(() => validateReport({ ...report, vscodeVersion: '1.139.1' }, expected), /actual version/);
    });
    it('uses an explicit executable before downloading and records the actual host identity', async () => {
        const explicit = await scenario({ executable: 'existing-vscode' });
        assert.equal(explicit.downloads, 0);
        assert.deepEqual([...new Set(explicit.executables)], ['existing-vscode']);
        assert.equal(explicit.report.vscodeVersion, '1.100.0');
        assert.equal(explicit.report.complete, true);
        const defaults = await scenario({ explicitEvidence: false });
        assert.equal(defaults.exitCode, undefined);
        assert.equal(defaults.report.complete, true);
        assert.ok(defaults.report.cases.some(item => item.name === 'upgrade' && item.passed));
        const downloaded = await scenario({});
        assert.equal(downloaded.downloads, 1);
        assert.deepEqual([...new Set(downloaded.executables)], ['downloaded-vscode']);
        const wrongVersion = await scenario({ executable: 'existing-vscode', actualVersion: '1.139.1' });
        assert.equal(wrongVersion.exitCode, 1);
        assert.equal(wrongVersion.report.complete, false);
        assert.equal(wrongVersion.report.vscodeVersion, null);
    });
});
