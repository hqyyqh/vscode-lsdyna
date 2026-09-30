'use strict';

const path = require('path');
const { runTests } = require('./vsix-host.cjs');

async function main() {
    const required = [
        'LSDYNA_WATCHDOG_VSCODE_EXECUTABLE',
        'LSDYNA_WATCHDOG_REPO_ROOT',
        'LSDYNA_WATCHDOG_WORKSPACE',
        'LSDYNA_WATCHDOG_USER_DATA',
        'LSDYNA_WATCHDOG_EXTENSIONS_DIR',
    ];
    for (const name of required) {
        if (!process.env[name]) throw new Error(`Missing ${name}`);
    }

    await runTests({
        vscodeExecutablePath: process.env.LSDYNA_WATCHDOG_VSCODE_EXECUTABLE,
        extensionDevelopmentPath: process.env.LSDYNA_WATCHDOG_REPO_ROOT,
        extensionTestsPath: path.join(
            process.env.LSDYNA_WATCHDOG_REPO_ROOT,
            'test',
            'editor-safety',
            'large-file-extension-host',
            'index.js',
        ),
        launchArgs: [
            process.env.LSDYNA_WATCHDOG_WORKSPACE,
            '--disable-extensions',
            '--disable-gpu',
            '--disable-workspace-trust',
            '--skip-welcome',
            '--skip-release-notes',
            `--user-data-dir=${process.env.LSDYNA_WATCHDOG_USER_DATA}`,
            `--extensions-dir=${process.env.LSDYNA_WATCHDOG_EXTENSIONS_DIR}`,
        ],
        extensionTestsEnv: {
            LSDYNA_EDITOR_SAFETY_LARGE_WORKSPACE:
                process.env.LSDYNA_EDITOR_SAFETY_LARGE_WORKSPACE,
            LSDYNA_EDITOR_SAFETY_LARGE_TARGET:
                process.env.LSDYNA_EDITOR_SAFETY_LARGE_TARGET,
            LSDYNA_EDITOR_SAFETY_LARGE_RESULT:
                process.env.LSDYNA_EDITOR_SAFETY_LARGE_RESULT,
            LSDYNA_EDITOR_SAFETY_PROGRESS_FILE:
                process.env.LSDYNA_EDITOR_SAFETY_PROGRESS_FILE,
            LSDYNA_EDITOR_SAFETY_NO_PROGRESS_TIMEOUT_MS: '10000',
            LSDYNA_EDITOR_SAFETY_SCENARIO_TIMEOUT_MS: '120000',
        },
    });
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
