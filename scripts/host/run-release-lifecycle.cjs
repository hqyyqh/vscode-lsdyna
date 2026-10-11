'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { runTests } = require('./vsix-host.cjs');
const { createTempRun, finishTempRun } = require('./temp-runs.cjs');
const PREVIOUS = { version: '3.1.5', sha256: '00905264af35bdfeaf0ca7990eb39408d35de024d165d449ea7a823f516c925d' };
async function main() {
    const phase = process.argv[2];
    assert.ok(['upgrade', 'reload', 'offline', 'missing-external-manual', 'ordinary-project-f5'].includes(phase));
    const candidate = path.resolve(process.env.LSDYNA_TEST_VSIX);
    const executable = process.env.VSCODE_EXECUTABLE_PATH;
    assert.ok(executable, 'Acceptance must select the host before lifecycle tests');
    const root = createTempRun('dynasense-release-lifecycle-'), workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'core.k'), '*KEYWORD\n*NODE\n       1               0               1               2       0       0\n*END\n');
    if (phase === 'offline') require('../../test/support/release/manual-fixture.cjs').createManualFixture(path.join(workspace, 'lsdyna_manual_pack'));
    const server = require('node:net').createServer();
    const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        const value = server.address().port; server.close(() => resolve(value));
    }));
    const launch = async stage => runTests({ vscodeExecutablePath: executable, reloadLifecycle: stage === 'reload',
        extensionDevelopmentPath: path.resolve(__dirname, '../..'),
        extensionTestsPath: path.resolve(__dirname, '../../test/host/release/lifecycle.cjs'),
        extensionTestsEnv: { LSDYNA_RELEASE_HOST_ROOT: root, LSDYNA_RELEASE_LIFECYCLE: stage,
            LSDYNA_RELEASE_CDP_PORT: String(port), LSDYNA_PREVIOUS_VERSION: PREVIOUS.version },
        launchArgs: [workspace, '--new-window', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
            `--user-data-dir=${path.join(root, 'profile')}`, `--extensions-dir=${path.join(root, 'extensions')}`,
            '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`],
    });
    try {
        if (phase === 'upgrade') {
            const previous = path.join(root, 'previous.vsix');
            const url = `https://github.com/hqyyqh/vscode-lsdyna/releases/download/v${PREVIOUS.version}/dynasense-${PREVIOUS.version}.vsix`;
            const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
            assert.ok(response.ok, `Previous release download: ${response.status}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), PREVIOUS.sha256);
            fs.writeFileSync(previous, bytes);
            const expectedCandidateHash = process.env.LSDYNA_TEST_VSIX_SHA256;
            process.env.LSDYNA_TEST_VSIX_SHA256 = PREVIOUS.sha256;
            process.env.LSDYNA_TEST_VSIX = previous;
            process.env.LSDYNA_TEST_PACKAGE_VERSION = PREVIOUS.version;
            await launch('before-upgrade');
            process.env.LSDYNA_TEST_VSIX = candidate;
            if (expectedCandidateHash) process.env.LSDYNA_TEST_VSIX_SHA256 = expectedCandidateHash;
            else delete process.env.LSDYNA_TEST_VSIX_SHA256;
            process.env.LSDYNA_TEST_PACKAGE_VERSION = require('../../package.json').version;
        }
        await launch(phase);
        const result = JSON.parse(fs.readFileSync(path.join(root, 'lifecycle-result.json'), 'utf8'));
        assert.equal(result.phase, phase); assert.equal(result.passed, true);
        fs.copyFileSync(path.join(root, 'lifecycle-result.json'),
            path.join(process.env.LSDYNA_TEST_VSIX_EVIDENCE, `${phase}.json`));
        console.log(JSON.stringify(result));
    } catch (error) {
        if (error.signal || error.runtimeMayBeActive || error.evidenceSaveFailed) finishTempRun(root, { retain: true });
        throw error;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
