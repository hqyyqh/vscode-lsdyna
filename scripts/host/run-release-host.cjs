'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { runTests } = require('./vsix-host.cjs');
const { resolveVSCodeExecutable } = require('./run-editor-safety-extension-host.cjs');
async function main() {
    const phase = process.argv[2] || 'smoke';
    if (!['smoke', 'activation', 'hover', 'manager', 'choices', 'catalog', 'completion', 'reference-hover'].includes(phase)) throw Error('Unknown release host phase');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-release-host-'));
    const workspace = path.join(root, 'workspace'), profile = path.join(root, 'profile');
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none' }));
    const node = '       1' + ['0.0', '1.0', '-2.5E-3'].map(value => value.padStart(16)).join('') + '       0       0';
    fs.writeFileSync(path.join(workspace, 'core.k'), `*KEYWORD\n*NODE\n${node}\n*END\n`);
    if (phase === 'choices') fs.writeFileSync(path.join(workspace, 'core.k'), '*KEYWORD\n*MAT_DAMAGE_1\n' +
        ' '.repeat(80) + '\n' + ' '.repeat(70) + '0'.padStart(10) + '\n*END\n');
    fs.writeFileSync(path.join(workspace, 'main.k'), '*KEYWORD\n*INCLUDE\ncore.k\n*END\n');
    if (process.env.LSDYNA_RELEASE_INTERACTION_MODEL) {
        fs.copyFileSync(process.env.LSDYNA_RELEASE_INTERACTION_MODEL, path.join(workspace, 'interaction.k'));
    }
    if (process.env.LSDYNA_RELEASE_MANUAL_PACK) {
        const source = path.resolve(process.env.LSDYNA_RELEASE_MANUAL_PACK);
        if (!fs.existsSync(path.join(source, 'manifest.json'))) throw Error('Manual pack manifest missing');
        fs.symlinkSync(source, path.join(workspace, 'lsdyna_manual_pack'), process.platform === 'win32' ? 'junction' : 'dir');
    } else if (process.env.LSDYNA_RELEASE_MANUAL_FIXTURE === '1') {
        require("../../test/support/release/manual-fixture.cjs").createManualFixture(path.join(workspace, 'lsdyna_manual_pack'));
    }
    console.log(`Release host evidence: ${root}`);
    const executable = process.env.VSCODE_TEST_VERSION && !process.env.VSCODE_EXECUTABLE_PATH
        ? await require('@vscode/test-electron').downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION)
        : resolveVSCodeExecutable();
    await runTests({ vscodeExecutablePath: executable,
        extensionDevelopmentPath: path.resolve(__dirname, "../.."),
        extensionTestsPath: path.resolve(__dirname, "../../test/host/release/host.cjs"),
        extensionTestsEnv: { LSDYNA_RELEASE_HOST_ROOT: root, LSDYNA_RELEASE_HOST_PHASE: phase },
        launchArgs: [workspace, '--new-window', '--disable-extensions', '--disable-gpu', '--disable-workspace-trust',
            '--skip-welcome', '--skip-release-notes', `--user-data-dir=${profile}`, `--extensions-dir=${path.join(root, 'extensions')}`,
            ...(process.env.LSDYNA_RELEASE_CDP_PORT ? ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${process.env.LSDYNA_RELEASE_CDP_PORT}`] : [])],
    });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
