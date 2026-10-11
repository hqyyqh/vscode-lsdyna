'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const script = path.resolve(__dirname, '../../../scripts/host/run-installed-acceptance.cjs');
async function scenario({ executable, actualVersion = '1.100.0', explicitEvidence = true }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-acceptance-test-'));
    const vsix = path.join(root, 'candidate.vsix'), evidence = path.join(root, 'evidence');
    fs.writeFileSync(vsix, 'synthetic package identity');
    fs.writeFileSync(vsix + '.data-equivalence.json', JSON.stringify({ keywords: 1, formsFingerprint: 'synthetic' }));
    const digest = crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex');
    let downloads = 0; const executables = [];
    const processMock = { argv: [], platform: process.platform, execPath: process.execPath, env: {
        LSDYNA_TEST_VSIX: vsix, ...(explicitEvidence ? { LSDYNA_TEST_VSIX_EVIDENCE: evidence } : {}), VSCODE_TEST_VERSION: '1.100.0',
        ...(executable ? { VSCODE_EXECUTABLE_PATH: executable } : {}),
    } };
    const context = { process: processMock, __dirname: path.dirname(script), console: { error() {} }, require(name) {
        if (name === 'node:path') return { ...path, resolve: (...args) => args[0] === '.artifacts/release-rebuild/installed-hosts' ? evidence : path.resolve(...args) };
        if (name === '@vscode/test-electron') return { async downloadAndUnzipVSCode() { downloads++; return 'downloaded-vscode'; } };
        if (name === 'node:child_process') return { spawnSync(_node, _args, { env }) {
            assert.equal(env.LSDYNA_TEST_VSIX_EVIDENCE, evidence);
            assert.equal(path.dirname(env.LSDYNA_EXPECTED_CATALOG), evidence);
            assert.equal(JSON.parse(fs.readFileSync(env.LSDYNA_EXPECTED_CATALOG)).fingerprint, 'synthetic');
            executables.push(env.VSCODE_EXECUTABLE_PATH);
            fs.writeFileSync(path.join(evidence, '1-1.json'), JSON.stringify({ sha256: digest, status: 'passed', vscodeVersion: actualVersion }));
            return { status: 0, stdout: '', stderr: '' };
        } };
        return require(name);
    } };
    try {
        vm.runInNewContext(fs.readFileSync(script, 'utf8').replace('main().catch', 'globalThis.completed = main().catch'), context);
        await context.completed;
        const report = JSON.parse(fs.readFileSync(path.join(evidence, 'acceptance.json')));
        return { downloads, executables, report, exitCode: processMock.exitCode };
    } finally {
        assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    }
}
describe('installed acceptance executable and measured version', () => {
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
