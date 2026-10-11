'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createTempRun, finishTempRun, createEvidenceDirectory, writeEvidence } = require('./temp-runs.cjs');

const {
    copyDirectoryExact,
    diffSnapshots,
    snapshotDirectory,
} = require("../../test/support/editor-safety/fileOracle");

const repoRoot = path.resolve(__dirname, "../..");
const noProgressTimeoutMs = 10_000;
const setupNoProgressTimeoutMs = 30_000;
const scenarioTimeoutMs = 120_000;

function terminateProcessTree(child) {
    if (!child || !child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
        });
    } else {
        child.kill('SIGKILL');
    }
}

function runExtensionHostWithWatchdog(options) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        let lastProgress = started;
        let lastProgressRecord = null;
        let watchdogError = null;
        const workerPath = path.join(
            repoRoot,
            "scripts/host/run-editor-safety-large-file-host-worker.cjs",
        );
        const child = spawn(process.execPath, [workerPath], {
            cwd: repoRoot,
            windowsHide: true,
            stdio: 'inherit',
            env: {
                ...process.env,
                LSDYNA_WATCHDOG_VSCODE_EXECUTABLE: options.vscodeExecutablePath,
                LSDYNA_WATCHDOG_REPO_ROOT: repoRoot,
                LSDYNA_WATCHDOG_WORKSPACE: options.workspaceDirectory,
                LSDYNA_WATCHDOG_USER_DATA: options.userDataDirectory,
                LSDYNA_WATCHDOG_EXTENSIONS_DIR: options.extensionsDirectory,
                LSDYNA_EDITOR_SAFETY_LARGE_WORKSPACE: options.workspaceDirectory,
                LSDYNA_EDITOR_SAFETY_LARGE_TARGET: options.targetRelativePath,
                LSDYNA_EDITOR_SAFETY_LARGE_RESULT: options.resultFile,
                LSDYNA_EDITOR_SAFETY_PROGRESS_FILE: options.progressFile,
            },
        });

        const watchdog = setInterval(() => {
            try {
                if (fs.existsSync(options.progressFile)) {
                    const progressText = fs.readFileSync(options.progressFile, 'utf8').trim();
                    if (progressText) lastProgressRecord = JSON.parse(progressText);
                    lastProgress = Math.max(
                        lastProgress,
                        fs.statSync(options.progressFile).mtimeMs,
                    );
                }
            } catch (_) {
                // A concurrent heartbeat replacement is retried on the next tick.
            }
            const now = Date.now();
            if (now - started > scenarioTimeoutMs) {
                watchdogError = new Error(
                    `Large-file Extension Host exceeded ${scenarioTimeoutMs} ms`,
                );
                clearInterval(watchdog);
                terminateProcessTree(child);
            } else {
                const label = String(lastProgressRecord?.label || 'startup');
                const isFormattingStep = /format/i.test(label) && !/^open synthetic/i.test(label);
                const inactivityLimit = isFormattingStep
                    ? noProgressTimeoutMs
                    : setupNoProgressTimeoutMs;
                if (now - lastProgress <= inactivityLimit) return;
                watchdogError = new Error(
                    `Large-file Extension Host produced no heartbeat for ${inactivityLimit} ms ` +
                    `during ${label}`,
                );
                clearInterval(watchdog);
                terminateProcessTree(child);
            }
        }, 250);

        child.once('error', error => {
            clearInterval(watchdog);
            reject(error);
        });
        child.once('close', (code, signal) => {
            clearInterval(watchdog);
            if (watchdogError) {
                watchdogError.runtimeMayBeActive = true;
                reject(watchdogError);
            } else if (code === 0) {
                resolve();
            } else {
                // ponytail: failed workers may hide a signalled host; inspect retained runs or add a closure handshake.
                reject(Object.assign(new Error(
                    `Large-file Extension Host worker exited with code ${code} signal ${signal || 'none'}`,
                ), { runtimeMayBeActive: true }));
            }
        });
    });
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

    const isolationRoot = createTempRun('dynasense-editor-safety-large-');
    const workspaceDirectory = path.join(isolationRoot, 'workspace');
    const isolatedModelRoot = path.join(workspaceDirectory, modelName);
    const userDataDirectory = path.join(isolationRoot, 'user-data');
    const extensionsDirectory = path.join(isolationRoot, 'extensions');
    const progressFile = path.join(evidenceDirectory, `${modelName}.progress.json`);
    const resultFile = path.join(evidenceDirectory, `${modelName}.runtime.json`);
    fs.mkdirSync(workspaceDirectory);
    fs.mkdirSync(userDataDirectory);
    fs.mkdirSync(extensionsDirectory);

    let retainRuntime = false;
    console.log(
        `[large file] ${modelName}: copying ${target.name} ecosystem ` +
        `(${target.size} bytes)`,
    );
    try {
        const sourceBefore = await snapshotDirectory(sourceModelRoot);
        writeEvidence(path.join(evidenceDirectory, `${modelName}.source-before.json`), JSON.stringify(sourceBefore));
        await copyDirectoryExact(sourceModelRoot, isolatedModelRoot);
        const before = await snapshotDirectory(isolatedModelRoot);
        writeEvidence(
            path.join(evidenceDirectory, `${modelName}.before.json`),
            `${JSON.stringify(before, null, 2)}\n`,
            'utf8',
        );

        await runExtensionHostWithWatchdog({
            vscodeExecutablePath,
            workspaceDirectory,
            userDataDirectory,
            extensionsDirectory,
            targetRelativePath: path.join(modelName, target.name),
            resultFile,
            progressFile,
        });

        const after = await snapshotDirectory(isolatedModelRoot);
        writeEvidence(
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
        return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    } catch (error) {
        process.exitCode = 1;
        retainRuntime = Boolean(error.runtimeMayBeActive || error.evidenceSaveFailed);
        try {
            writeEvidence(path.join(evidenceDirectory, `${modelName}.failure.json`), JSON.stringify({
                status: 'failed', sourceModelRoot, error: error.stack || String(error),
                runtimeReservation: retainRuntime ? isolationRoot : null,
            }, null, 2));
            if (!retainRuntime && fs.existsSync(isolatedModelRoot)) {
                try {
                    writeEvidence(path.join(evidenceDirectory, `${modelName}.after.json`),
                        JSON.stringify(await snapshotDirectory(isolatedModelRoot)));
                } catch (captureError) {
                    if (captureError.evidenceSaveFailed) throw captureError;
                    writeEvidence(path.join(evidenceDirectory, `${modelName}.snapshot-error.json`), JSON.stringify({ error: String(captureError) }));
                }
            }
        } catch (saveError) {
            retainRuntime = true;
            console.error(`[large file] diagnostics could not be saved; runtime retained: ${isolationRoot}`, saveError);
            throw Object.assign(error, { evidenceSaveFailed: true, evidenceError: saveError });
        }
        if (retainRuntime) console.error(`[large file] runtime reservation retained: ${isolationRoot}`);
        throw error;
    } finally {
        finishTempRun(isolationRoot, { retain: retainRuntime });
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
    const evidenceDirectory = createEvidenceDirectory('editor-safety-large-files');
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
        noProgressTimeoutMs,
        scenarioTimeoutMs,
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
