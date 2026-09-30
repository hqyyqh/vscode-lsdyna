'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { runTests } = require('./vsix-host.cjs');
const { resolveVSCodeExecutable } = require('./run-editor-safety-extension-host.cjs');

async function main() {
    const repo = path.resolve(__dirname, '..');
    const candidateArg = process.argv.indexOf('--candidate');
    const candidate = candidateArg >= 0 ? path.resolve(process.argv[candidateArg + 1]) : '';
    const candidateHash = candidate
        ? crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex') : '';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-keyword-usability-'));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    for (const format of ['standard', 'long', 'i10', 'free']) {
        for (const family of ['node', 'material', 'curve']) {
            fs.copyFileSync(path.join(repo, 'test/fixtures/lspp-native-formats', `native-${format}.k`),
                path.join(workspace, `${format}-${family}.k`));
        }
    }
    const profile = path.join(root, 'user-data');
    fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({
        'workbench.startupEditor': 'none',
    }));
    console.log(`Keyword Manager host evidence: ${root}`);
    await runTests({
        vscodeExecutablePath: resolveVSCodeExecutable(),
        extensionDevelopmentPath: repo,
        extensionTestsPath: path.join(repo, 'test/keyword-manager/extension-host.cjs'),
        launchArgs: [workspace, '--new-window', '--disable-extensions', '--disable-gpu',
            '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
            `--user-data-dir=${profile}`, `--extensions-dir=${path.join(root, 'extensions')}`],
        extensionTestsEnv: { KEYWORD_MANAGER_HOST_EVIDENCE: root,
            KEYWORD_MANAGER_REPEATED: process.argv.includes('--repeated') ? '1' : '',
            KEYWORD_MANAGER_EXPLICIT: process.argv.includes('--explicit-navigation') ? '1' : '',
            KEYWORD_MANAGER_STARTUP_SAFETY: process.argv.includes('--startup-safety') ? '1' : '',
            KEYWORD_MANAGER_CONDITIONAL: process.argv.includes('--conditional') ? '1' : '',
            KEYWORD_MANAGER_CANDIDATE_PATH: candidate, KEYWORD_MANAGER_CANDIDATE_SHA256: candidateHash,
            KEYWORD_MANAGER_DIAGNOSTIC: candidate || process.argv.includes('--diagnostic') ? '1' : '',
            KEYWORD_MANAGER_SAFETY: process.argv.includes('--safety') ? '1' : '',
            KEYWORD_MANAGER_GUI: process.argv.includes('--gui') || process.argv.includes('--gui-shared') ? '1' : '',
            KEYWORD_MANAGER_GUI_SHARED: process.argv.includes('--gui-shared') ? '1' : '' },
    });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
