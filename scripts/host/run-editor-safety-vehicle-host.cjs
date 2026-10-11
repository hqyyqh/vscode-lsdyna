'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runTests } = require('./vsix-host.cjs');
const { createTempRun, finishTempRun, createEvidenceDirectory, writeEvidence } = require('./temp-runs.cjs');

const {
    copyDirectoryExact,
    diffSnapshots,
    snapshotDirectory,
} = require("../../test/support/editor-safety/fileOracle");

const repoRoot = path.resolve(__dirname, "../..");

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

async function snapshotModels(root, modelNames, evidenceDirectory, phase) {
    const result = {};
    for (const modelName of modelNames) {
        const started = Date.now();
        const snapshot = await snapshotDirectory(path.join(root, modelName));
        result[modelName] = snapshot;
        writeEvidence(
            path.join(evidenceDirectory, `${modelName}.${phase}.json`),
            `${JSON.stringify(snapshot, null, 2)}\n`,
            'utf8',
        );
        console.log(
            `[vehicle safety] ${phase} manifest ${modelName}: ` +
            `${snapshot.summary.fileCount} files, ${snapshot.summary.totalBytes} bytes, ` +
            `${snapshot.summary.treeSha256}, ${Date.now() - started} ms`,
        );
    }
    return result;
}

function assertCleanModelDiffs(before, after) {
    const summaries = {};
    for (const modelName of Object.keys(before)) {
        const diff = diffSnapshots(before[modelName], after[modelName]);
        assert.deepStrictEqual(
            diff,
            { clean: true, added: [], removed: [], modified: [] },
            `${modelName} changed during passive Extension Host workflows`,
        );
        summaries[modelName] = {
            before: before[modelName].summary,
            after: after[modelName].summary,
            clean: true,
        };
    }
    return summaries;
}

async function main() {
    const sourceRoot = resolveSourceRoot();
    const sourceStat = fs.statSync(sourceRoot);
    if (!sourceStat.isDirectory()) {
        throw new Error(`Vehicle model source is not a directory: ${sourceRoot}`);
    }

    const modelNames = modelDirectoryNames(sourceRoot);
    assert.strictEqual(
        modelNames.length,
        6,
        `Expected the six supplied vehicle directories, found ${modelNames.length}`,
    );

    const isolationRoot = createTempRun('dynasense-editor-safety-vehicles-');
    const evidenceDirectory = createEvidenceDirectory('editor-safety-vehicles');
    const workspaceDirectory = path.join(isolationRoot, 'workspace');
    const userDataDirectory = path.join(isolationRoot, 'user-data');
    const extensionsDirectory = path.join(isolationRoot, 'extensions');
    const progressFile = path.join(evidenceDirectory, 'extension-host-progress.json');
    fs.mkdirSync(userDataDirectory);
    fs.mkdirSync(extensionsDirectory);

    let before;
    let after;
    try {
        const sourceBefore = await snapshotDirectory(sourceRoot);
        writeEvidence(path.join(evidenceDirectory, 'source-before.json'), JSON.stringify(sourceBefore));
        console.log(`[vehicle safety] source baseline: ${sourceBefore.summary.treeSha256}`);
        console.log(`[vehicle safety] copying isolated workspace to ${workspaceDirectory}`);
        await copyDirectoryExact(sourceRoot, workspaceDirectory);
        before = await snapshotModels(
            workspaceDirectory,
            modelNames,
            evidenceDirectory,
            'before',
        );

        await runTests({
            vscodeExecutablePath: resolveVSCodeExecutable(),
            extensionDevelopmentPath: repoRoot,
            extensionTestsPath: path.join(
                repoRoot,
                "test/host/editor-safety/vehicle-extension-host/index.js",
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
                LSDYNA_EDITOR_SAFETY_VEHICLE_WORKSPACE: workspaceDirectory,
                LSDYNA_EDITOR_SAFETY_PROGRESS_FILE: progressFile,
                LSDYNA_EDITOR_SAFETY_NO_PROGRESS_TIMEOUT_MS: '120000',
            },
        });

        after = await snapshotModels(
            workspaceDirectory,
            modelNames,
            evidenceDirectory,
            'after',
        );
        const modelResults = assertCleanModelDiffs(before, after);
        const sourceAfter = await snapshotDirectory(sourceRoot);
        const sourceDiff = diffSnapshots(sourceBefore, sourceAfter);
        assert.deepStrictEqual(
            sourceDiff,
            { clean: true, added: [], removed: [], modified: [] },
            'The supplied Vehicle_Modeling source changed during isolated testing',
        );

        const result = {
            capturedAt: new Date().toISOString(),
            sourceRoot,
            sourceBefore: sourceBefore.summary,
            sourceAfter: sourceAfter.summary,
            sourceClean: true,
            noProgressTimeoutMs: 120000,
            models: modelResults,
        };
        writeEvidence(
            path.join(evidenceDirectory, 'result.json'),
            `${JSON.stringify(result, null, 2)}\n`,
            'utf8',
        );
        console.log(`[vehicle safety] evidence: ${evidenceDirectory}`);
        console.log('[vehicle safety] six isolated vehicle workflows are byte-clean');
    } catch (error) {
        const retainRuntime = Boolean(error.signal || error.runtimeMayBeActive || error.evidenceSaveFailed);
        if (retainRuntime) finishTempRun(isolationRoot, { retain: true });
        try {
            writeEvidence(path.join(evidenceDirectory, 'failure.json'), JSON.stringify({
                status: 'failed', sourceRoot, error: error.stack || String(error),
                runtimeReservation: retainRuntime ? isolationRoot : null,
            }, null, 2));
            if (!retainRuntime && fs.existsSync(workspaceDirectory) && !after) {
                try { await snapshotModels(workspaceDirectory, modelNames, evidenceDirectory, 'after'); }
                catch (captureError) {
                    if (captureError.evidenceSaveFailed) throw captureError;
                    writeEvidence(path.join(evidenceDirectory, 'snapshot-error.json'), JSON.stringify({ error: String(captureError) }));
                }
            }
        } catch (saveError) {
            if (!retainRuntime) finishTempRun(isolationRoot, { retain: true });
            console.error(`[vehicle safety] diagnostics could not be saved; runtime retained: ${isolationRoot}`, saveError);
            throw Object.assign(error, { evidenceSaveFailed: true, evidenceError: saveError });
        }
        if (retainRuntime) console.error(`[vehicle safety] runtime reservation retained: ${isolationRoot}`);
        console.error(`[vehicle safety] failure evidence: ${evidenceDirectory}`);
        throw error;
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
