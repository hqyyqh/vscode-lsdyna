'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

const {
    copyDirectoryExact,
    diffSnapshots,
    snapshotDirectory,
} = require('../test/editor-safety/fileOracle');

const repoRoot = path.resolve(__dirname, '..');
const isolationPrefix = 'vscode-lsdyna-editor-safety-large-';

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

function resolveSourceRoot() {
    const argument = process.argv[2];
    const configured = argument || process.env.LSDYNA_VEHICLE_MODELING_ROOT;
    if (configured) return path.resolve(configured);
    if (process.platform === 'win32') return 'D:\\temp\\Vehicle_Modeling';
    throw new Error(
        'Pass the Vehicle_Modeling root or set LSDYNA_VEHICLE_MODELING_ROOT.',
    );
}

function modelDirectoryNames(root) {
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right, 'en'));
}

function largestDeckName(modelRoot) {
    const candidates = fs.readdirSync(modelRoot, { withFileTypes: true })
        .filter(entry => entry.isFile() && /\.(?:key|k|dyna|asc)$/i.test(entry.name))
        .map(entry => ({
            name: entry.name,
            size: fs.statSync(path.join(modelRoot, entry.name)).size,
        }))
        .sort((left, right) => right.size - left.size);
    if (candidates.length === 0) {
        throw new Error(`No LS-DYNA deck found in ${modelRoot}`);
    }
    return candidates[0];
}

function createEvidenceDirectory(sourceRoot) {
    const evidenceParent = path.join(
        path.dirname(sourceRoot),
        'vscode-lsdyna-editor-safety-evidence',
    );
    fs.mkdirSync(evidenceParent, { recursive: true });
    return fs.mkdtempSync(path.join(evidenceParent, 'large-files-'));
}

function removeIsolationDirectory(isolationRoot, sourceRoot) {
    const resolved = path.resolve(isolationRoot);
    const expectedParent = path.resolve(path.dirname(sourceRoot));
    if (
        path.dirname(resolved) !== expectedParent ||
        !path.basename(resolved).startsWith(isolationPrefix)
    ) {
        throw new Error(`Refusing to remove unexpected isolation directory: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}

async function runModel({
    sourceRoot,
    modelName,
    evidenceDirectory,
    vscodeExecutablePath,
}) {
    const sourceModelRoot = path.join(sourceRoot, modelName);
    const target = largestDeckName(sourceModelRoot);
    assert.ok(
        target.size >= 100 * 1024 * 1024,
        `${modelName}/${target.name} is below the 100 MiB large-file test floor`,
    );

    const isolationRoot = fs.mkdtempSync(
        path.join(path.dirname(sourceRoot), isolationPrefix),
    );
    const workspaceDirectory = path.join(isolationRoot, 'workspace');
    const isolatedModelRoot = path.join(workspaceDirectory, modelName);
    const userDataDirectory = path.join(isolationRoot, 'user-data');
    const extensionsDirectory = path.join(isolationRoot, 'extensions');
    const progressFile = path.join(isolationRoot, 'progress.json');
    const resultFile = path.join(evidenceDirectory, `${modelName}.runtime.json`);
    fs.mkdirSync(workspaceDirectory);
    fs.mkdirSync(userDataDirectory);
    fs.mkdirSync(extensionsDirectory);

    let passed = false;
    console.log(
        `[large file] ${modelName}: copying ${target.name} ecosystem ` +
        `(${target.size} bytes)`,
    );
    const sourceBefore = await snapshotDirectory(sourceModelRoot);

    try {
        await copyDirectoryExact(sourceModelRoot, isolatedModelRoot);
        const before = await snapshotDirectory(isolatedModelRoot);
        fs.writeFileSync(
            path.join(evidenceDirectory, `${modelName}.before.json`),
            `${JSON.stringify(before, null, 2)}\n`,
            'utf8',
        );

        await runTests({
            vscodeExecutablePath,
            extensionDevelopmentPath: repoRoot,
            extensionTestsPath: path.join(
                repoRoot,
                'test',
                'editor-safety',
                'large-file-extension-host',
                'index.js',
            ),
            launchArgs: [
                workspaceDirectory,
                '--disable-extensions',
                '--disable-gpu',
                '--disable-workspace-trust',
                '--skip-welcome',
                '--skip-release-notes',
                `--user-data-dir=${userDataDirectory}`,
                `--extensions-dir=${extensionsDirectory}`,
            ],
            extensionTestsEnv: {
                LSDYNA_EDITOR_SAFETY_LARGE_WORKSPACE: workspaceDirectory,
                LSDYNA_EDITOR_SAFETY_LARGE_TARGET: path.join(modelName, target.name),
                LSDYNA_EDITOR_SAFETY_LARGE_RESULT: resultFile,
                LSDYNA_EDITOR_SAFETY_PROGRESS_FILE: progressFile,
                LSDYNA_EDITOR_SAFETY_NO_PROGRESS_TIMEOUT_MS: '120000',
            },
        });

        const after = await snapshotDirectory(isolatedModelRoot);
        fs.writeFileSync(
            path.join(evidenceDirectory, `${modelName}.after.json`),
            `${JSON.stringify(after, null, 2)}\n`,
            'utf8',
        );
        assert.deepStrictEqual(
            diffSnapshots(before, after),
            { clean: true, added: [], removed: [], modified: [] },
            `${modelName} changed during large-file testing`,
        );
        const sourceAfter = await snapshotDirectory(sourceModelRoot);
        assert.deepStrictEqual(
            diffSnapshots(sourceBefore, sourceAfter),
            { clean: true, added: [], removed: [], modified: [] },
            `${modelName} source changed during isolated large-file testing`,
        );
        passed = true;
        return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    } finally {
        if (passed) {
            removeIsolationDirectory(isolationRoot, sourceRoot);
        } else {
            console.error(`[large file] failed isolation preserved: ${isolationRoot}`);
        }
    }
}

async function main() {
    const sourceRoot = resolveSourceRoot();
    const allModelNames = modelDirectoryNames(sourceRoot);
    assert.strictEqual(allModelNames.length, 6);
    const requestedModel = process.env.LSDYNA_LARGE_MODEL;
    const modelNames = requestedModel
        ? allModelNames.filter(modelName => modelName === requestedModel)
        : allModelNames;
    if (requestedModel) {
        assert.strictEqual(
            modelNames.length,
            1,
            `Unknown LSDYNA_LARGE_MODEL: ${requestedModel}`,
        );
    }
    const evidenceDirectory = createEvidenceDirectory(sourceRoot);
    const vscodeExecutablePath = resolveVSCodeExecutable();
    const results = [];

    for (const modelName of modelNames) {
        results.push(await runModel({
            sourceRoot,
            modelName,
            evidenceDirectory,
            vscodeExecutablePath,
        }));
    }

    const summary = {
        capturedAt: new Date().toISOString(),
        sourceRoot,
        noProgressTimeoutMs: 120000,
        modelCount: results.length,
        models: results,
    };
    fs.writeFileSync(
        path.join(evidenceDirectory, 'summary.json'),
        `${JSON.stringify(summary, null, 2)}\n`,
        'utf8',
    );
    console.log(`[large file] evidence: ${evidenceDirectory}`);
    console.log(
        `[large file] ${results.length} isolated large-file workflow(s) are byte-clean`,
    );
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
