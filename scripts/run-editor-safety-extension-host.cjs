'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');
const {
    createOfficialEdgeCaseCorpus,
} = require('../test/editor-safety/createOfficialCorpus');

const repoRoot = path.resolve(__dirname, '..');

function right(value, width) {
    return String(value).padStart(width, ' ');
}

function resolveVSCodeExecutable() {
    if (process.env.VSCODE_EXECUTABLE_PATH) {
        return path.resolve(process.env.VSCODE_EXECUTABLE_PATH);
    }
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        const candidate = path.join(
            process.env.LOCALAPPDATA,
            'Programs',
            'Microsoft VS Code',
            'Code.exe',
        );
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(
        'Set VSCODE_EXECUTABLE_PATH to a VS Code executable for Extension Host tests.',
    );
}

function reserveLoopbackPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? address.port : 0;
            server.close(error => {
                if (error) {
                    reject(error);
                } else if (!port) {
                    reject(new Error('Failed to reserve a loopback port for VS Code DevTools'));
                } else {
                    resolve(port);
                }
            });
        });
    });
}

function createFixtureWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-lsdyna-editor-safety-host-'));
    const nodeLine = [
        right('1', 8),
        right('0.0', 16),
        right('1.0', 16),
        right('-2.5E-3', 16),
        right('0', 8),
        right('0', 8),
    ].join('');
    const nodeLineWithEmptySecondField = [
        right('1', 8),
        ' '.repeat(16),
        right('1.0', 16),
        right('-2.5E-3', 16),
        right('0', 8),
        right('0', 8),
    ].join('');
    const nodeLineWithOnlyFirstField = right('1', 8) + ' '.repeat(nodeLine.length - 8);

    fs.writeFileSync(
        path.join(root, 'fixed.key'),
        `*KEYWORD\r\n*NODE\r\n${nodeLine}\r\n*END\r\n`,
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'renderer-multi.key'),
        `*KEYWORD\r\n*NODE\r\n${nodeLine}\r\n${nodeLine}\r\n*END\r\n`,
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'renderer-multi-indented.key'),
        `*KEYWORD\r\n*NODE\r\n    ${nodeLine}\r\n    ${nodeLine}\r\n*END\r\n`,
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'fixed-empty-field.key'),
        `*KEYWORD\r\n*NODE\r\n${nodeLineWithEmptySecondField}\r\n*END\r\n`,
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'fixed-readonly.key'),
        `*KEYWORD\r\n*NODE\r\n${nodeLine}\r\n*END\r\n`,
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'fixed-external-edit.key'),
        `*KEYWORD\r\n*NODE\r\n${nodeLine}\r\n*END\r\n`,
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'fixed-stale-nav.key'),
        `*KEYWORD\r\n*NODE\r\n${nodeLine}\r\n*END\r\n`,
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'empty-row.key'),
        `*KEYWORD\r\n*NODE\r\n${nodeLineWithOnlyFirstField}\r\n*END\r\n`,
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'comma.key'),
        '*KEYWORD\n*NODE\n1,2.0,-3.0,4.0\n*END\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'enter-lf.key'),
        '*KEYWORD\n*NODE\n       1\n*END\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'enter-crlf.key'),
        '*KEYWORD\r\n*NODE\r\n       1\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'enter-multi.key'),
        '*KEYWORD\r\n*NODE\r\n       1\r\n       2\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'option-title.key'),
        '*KEYWORD\r\n*MAT_001\r\n       1\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'option-title-other-condition.key'),
        '*KEYWORD\r\n*MAT_001\r\n       2\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'option-title-readonly.key'),
        '*KEYWORD\r\n*MAT_001\r\n       3\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'option-contact.key'),
        [
            '*KEYWORD',
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base 1',
            'base 2',
            'base 3',
            '$ engineer comment must stay',
            '*END',
            '',
        ].join('\r\n'),
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'rename.key'),
        [
            '*KEYWORD',
            '*PARAMETER',
            'R endtime 1.0',
            '*PARAMETER_EXPRESSION',
            'R dtplot endtime/100.0',
            '*CONTROL_TERMINATION',
            '&endtime',
            '*END',
            '',
        ].join('\r\n'),
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'rename-other-version.key'),
        '*KEYWORD\r\n*PARAMETER\r\nR endtime 2.0\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'hover-functional.key'),
        [
            '*KEYWORD',
            '*PARAMETER_MUTABLE_NOECHO_LOCAL',
            'IAB_CD_EF,7',
            '*PARAMETER_EXPRESSION_LOCAL_MUTABLE_NOECHO',
            'IRESULT,AB_CD_EF+1',
            '*CONTROL_TERMINATION',
            '  -&AB_CD_EF',
            '  &UNKNOWN',
            '*INCLUDE',
            'Sub/Part.key',
            '*INCLUDE',
            'missing-hover.key',
            '*NODE',
            nodeLine,
            '*NOT_A_REAL_KEYWORD',
            '*END',
            '',
        ].join('\r\n'),
        'utf8',
    );
    fs.mkdirSync(path.join(root, 'Sub'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'Sub', 'Part.key'),
        '*KEYWORD\r\n*NODE\r\n       1\r\n*END\r\n',
        'utf8',
    );
    fs.mkdirSync(path.join(root, 'CaseOnly'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'CaseOnly', 'Part.key'),
        '*KEYWORD\r\n*NODE\r\n       2\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'include-case.key'),
        '*KEYWORD\r\n*INCLUDE\r\nsub/part.key\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'include-case-continued.key'),
        '*KEYWORD\r\n*INCLUDE\r\nsub/ +\r\npart.key\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'include-case-other-condition.key'),
        '*KEYWORD\r\n*INCLUDE\r\nSub/Part.key\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'include-case-readonly.key'),
        '*KEYWORD\r\n*INCLUDE\r\nsub/part.key\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'include-case-only.key'),
        '*KEYWORD\r\n*INCLUDE\r\ncaseonly/part.key\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'passive.key'),
        '*KEYWORD\n*INCLUDE\nmissing-but-passive.key\n*END\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'completion.key'),
        '*KEYWORD\r\n*INCLUDE\r\nSub/\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'completion-other-condition.key'),
        '*KEYWORD\r\n*INCLUDE\r\nSub/Part.key\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'completion-mixed-cursors.key'),
        '*KEYWORD\r\n*INCLUDE\r\nSub/\r\n$ keep this comment\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'completion-multi-include.key'),
        '*KEYWORD\r\n*INCLUDE\r\nSub/\r\nSub/\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'format-on-save.key'),
        '*KEYWORD\n*NODE\n1 2.0 -3.0 4.0\n*END\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'format-selection.key'),
        [
            '*KEYWORD',
            '*NODE',
            '1 2.0 -3.0 4.0',
            '*INCLUDE',
            'p'.repeat(100),
            '*END',
            '',
        ].join('\r\n'),
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'format-selection-overlap.key'),
        [
            '*KEYWORD',
            '*NODE',
            '1 2.0 -3.0 4.0',
            '*INCLUDE',
            'p'.repeat(100),
            '*END',
            '',
        ].join('\r\n'),
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'format-selection-other-condition.key'),
        '*KEYWORD\r\n*NODE\r\n9 8.0 7.0 6.0\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'on-blur-active-condition.key'),
        '*KEYWORD\r\n*NODE\r\n1 2 3\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'on-blur-inactive-condition.key'),
        '*KEYWORD\r\n*NODE\r\n4 5 6\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'on-blur-next-condition.key'),
        '*KEYWORD\r\n*NODE\r\n7 8 9\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'on-blur-disabled.key'),
        '*KEYWORD\r\n*NODE\r\n10 11 12\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'on-blur-readonly.key'),
        '*KEYWORD\r\n*NODE\r\n13 14 15\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'on-blur-os-readonly.key'),
        '*KEYWORD\r\n*NODE\r\n14 15 16\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'on-blur-external-change.key'),
        '*KEYWORD\r\n*NODE\r\n16 17 18\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'on-blur-rapid-close.key'),
        '*KEYWORD\r\n*NODE\r\n17 18 19\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'autosave.key'),
        '*KEYWORD\r\n*NODE\r\n18 19 20\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'autosave-other-condition.key'),
        '*KEYWORD\r\n*NODE\r\n21 22 23\r\n*END\r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'plain-notes.txt'),
        'Engineer notes: \r\n',
        'utf8',
    );
    fs.writeFileSync(
        path.join(root, 'ime-comment.key'),
        '*KEYWORD\r\n$ Engineer note: \r\n*NODE\r\n       1\r\n*END\r\n',
        'utf8',
    );
    // 0 *KEYWORD | 1 *NODE | 2 data(indented) | 3 $col0 | 4 "    $ legacy" | 5 empty | 6 $# header | 7 data | 8 *END
    fs.writeFileSync(
        path.join(root, 'comment-toggle.key'),
        `*KEYWORD\r\n*NODE\r\n${nodeLine}\r\n$ existing\r\n    $ legacy indented\r\n\r\n$#   secid       mid    elform\r\n${nodeLine}\r\n*END\r\n`,
        'utf8',
    );
    createOfficialEdgeCaseCorpus(path.join(root, 'official-corpus'));
    return root;
}

function removeTempDirectory(root, expectedPrefix) {
    const resolved = path.resolve(root);
    const tempRoot = path.resolve(os.tmpdir());
    if (path.dirname(resolved) !== tempRoot ||
        !path.basename(resolved).startsWith(expectedPrefix)) {
        throw new Error(`Refusing to remove unexpected temporary directory: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}

async function main() {
    const workspaceDir = createFixtureWorkspace();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-lsdyna-editor-safety-user-'));
    const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-lsdyna-editor-safety-ext-'));
    const devToolsPort = await reserveLoopbackPort();
    let passed = false;

    console.log(`Extension Host fixture: ${workspaceDir}`);
    try {
        await runTests({
            vscodeExecutablePath: resolveVSCodeExecutable(),
            extensionDevelopmentPath: repoRoot,
            extensionTestsPath: path.join(
                repoRoot,
                'test',
                'editor-safety',
                'extension-host',
                'index.js',
            ),
            launchArgs: [
                workspaceDir,
                '--disable-extensions',
                '--disable-gpu',
                '--disable-workspace-trust',
                '--remote-debugging-address=127.0.0.1',
                `--remote-debugging-port=${devToolsPort}`,
                '--skip-welcome',
                '--skip-release-notes',
                `--user-data-dir=${userDataDir}`,
                `--extensions-dir=${extensionsDir}`,
            ],
            extensionTestsEnv: {
                LSDYNA_EDITOR_SAFETY_CDP_PORT: String(devToolsPort),
                LSDYNA_EDITOR_SAFETY_WORKSPACE: workspaceDir,
            },
        });
        passed = true;
    } finally {
        if (passed) {
            removeTempDirectory(workspaceDir, 'vscode-lsdyna-editor-safety-host-');
            removeTempDirectory(userDataDir, 'vscode-lsdyna-editor-safety-user-');
            removeTempDirectory(extensionsDir, 'vscode-lsdyna-editor-safety-ext-');
        } else {
            console.error(`Extension Host fixture preserved after failure: ${workspaceDir}`);
            console.error(`Extension Host user data preserved after failure: ${userDataDir}`);
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
