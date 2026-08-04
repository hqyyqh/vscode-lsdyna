'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('editor safety native close-dialog runner contract', () => {
    const sourcePath = path.resolve(
        __dirname,
        '..',
        '..',
        'scripts',
        'run-editor-safety-close-dialog.cjs',
    );
    const nativeDialogSourcePath = path.resolve(
        __dirname,
        '..',
        '..',
        'scripts',
        'editor-safety-native-dialog.ps1',
    );
    const source = fs.readFileSync(sourcePath, 'utf8');
    const nativeDialogSource = fs.readFileSync(nativeDialogSourcePath, 'utf8');

    it('stores evidence under the platform temporary directory', () => {
        assert.ok(
            source.includes(
                "path.join(os.tmpdir(), 'vscode-lsdyna-editor-safety-evidence')",
            ),
            'evidence storage must not require a machine-specific drive',
        );
        assert.doesNotMatch(
            source,
            /[A-Za-z]:\\\\temp\\\\vscode-lsdyna-editor-safety-evidence/,
        );
    });

    it('can be imported without launching VS Code', () => {
        assert.match(source, /if \(require\.main === module\) \{\s*main\(\)/);
    });

    it('rejects a missing configured VS Code executable before launch', () => {
        const { resolveVSCodeExecutable } = require(sourcePath);
        assert.strictEqual(
            typeof resolveVSCodeExecutable,
            'function',
            'the executable path decision must be directly testable',
        );

        const previous = process.env.VSCODE_EXECUTABLE_PATH;
        process.env.VSCODE_EXECUTABLE_PATH = path.join(
            os.tmpdir(),
            `vscode-lsdyna-missing-${process.pid}.exe`,
        );
        try {
            assert.throws(
                () => resolveVSCodeExecutable(),
                /VS Code executable does not exist/,
            );
        } finally {
            if (previous === undefined) {
                delete process.env.VSCODE_EXECUTABLE_PATH;
            } else {
                process.env.VSCODE_EXECUTABLE_PATH = previous;
            }
        }
    });

    it('does not authorize runtime cleanup until VS Code exits', async () => {
        const { stopChildProcess } = require(sourcePath);
        assert.strictEqual(
            typeof stopChildProcess,
            'function',
            'the process-exit decision must be directly testable',
        );

        const child = new EventEmitter();
        child.pid = 12345;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => true;

        assert.strictEqual(await stopChildProcess(child, 5), false);
        assert.match(source, /if \(passed && stopped\) \{/);
    });

    it('limits recursive cleanup to its own direct temporary directory', () => {
        const { removeRuntimeDirectory } = require(sourcePath);
        const allowed = fs.mkdtempSync(path.join(
            os.tmpdir(),
            'vscode-lsdyna-editor-safety-close-dialog-contract-',
        ));
        const unrelated = fs.mkdtempSync(path.join(
            os.tmpdir(),
            'vscode-lsdyna-editor-safety-unrelated-',
        ));
        try {
            fs.writeFileSync(path.join(allowed, 'sentinel.txt'), 'test', 'utf8');
            removeRuntimeDirectory(allowed);
            assert.strictEqual(fs.existsSync(allowed), false);
            assert.throws(
                () => removeRuntimeDirectory(unrelated),
                /Refusing to remove unexpected runtime directory/,
            );
            assert.strictEqual(fs.existsSync(unrelated), true);
        } finally {
            fs.rmSync(unrelated, { recursive: true, force: true });
        }
    });

    it('targets only the launched process native dialog', () => {
        assert.match(source, /'-OwnerProcessId',\s*String\(child\.pid\)/);
        assert.match(nativeDialogSource, /\$_\.ProcessId -eq \$OwnerProcessId/);
        assert.match(nativeDialogSource, /\$_\.ClassName -eq '#32770'/);
        assert.match(nativeDialogSource, /\$_\.Visible/);
        assert.doesNotMatch(nativeDialogSource, /Stop-Process|taskkill/i);
    });

    it('validates the dirty-close TaskDialog before cancelling it', () => {
        assert.match(nativeDialogSource, /AutomationId -eq 'MainInstruction'/);
        for (const automationId of [
            'CommandButton_100',
            'CommandButton_101',
            'CommandButton_102',
        ]) {
            assert.ok(nativeDialogSource.includes(automationId));
        }
        assert.match(
            nativeDialogSource,
            /\[System\.IntPtr\]\$dialog\.Handle,\s*0x0010/,
        );
    });
});
