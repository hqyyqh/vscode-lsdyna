const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('./vsix-host.cjs');
const { resolveVSCodeExecutable } = require('./run-editor-safety-extension-host.cjs');
(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-field-help-'));
    const profile = path.join(root, 'profile');
    fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({
        'workbench.startupEditor': 'none',
    }));
    console.log(`Field help host evidence: ${root}`);
    await runTests({ vscodeExecutablePath: resolveVSCodeExecutable(),
        extensionDevelopmentPath: path.resolve(__dirname, '..'),
        extensionTestsPath: path.resolve(__dirname, '../test/keyword-manager/help-host.cjs'),
        extensionTestsEnv: { KEYWORD_HELP_EVIDENCE: root },
        launchArgs: [root, '--new-window', '--disable-extensions', '--disable-gpu',
            '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
            `--user-data-dir=${profile}`, `--extensions-dir=${path.join(root, 'extensions')}`],
    });
})().catch(error => { console.error(error); process.exitCode = 1; });
