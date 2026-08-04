'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const vscode = require('vscode');

const workspaceRoot = process.env.LSDYNA_EDITOR_SAFETY_LARGE_WORKSPACE;
const targetRelativePath = process.env.LSDYNA_EDITOR_SAFETY_LARGE_TARGET;
const resultFile = process.env.LSDYNA_EDITOR_SAFETY_LARGE_RESULT;
const progressFile = process.env.LSDYNA_EDITOR_SAFETY_PROGRESS_FILE;
const noProgressTimeoutMs = Number(
    process.env.LSDYNA_EDITOR_SAFETY_NO_PROGRESS_TIMEOUT_MS || 120000,
);

const metrics = [];

function writeProgress(label, state, details = {}) {
    const record = {
        at: new Date().toISOString(),
        label,
        state,
        ...details,
    };
    if (progressFile) {
        fs.writeFileSync(progressFile, `${JSON.stringify(record)}\n`, 'utf8');
    }
    console.log(
        `[large file] ${state}: ${label}` +
        (details.durationMs === undefined ? '' : ` (${details.durationMs} ms)`),
    );
}

async function measureStep(label, operation) {
    const started = performance.now();
    const rssBefore = process.memoryUsage().rss;
    let lastTick = started;
    let maxEventLoopGapMs = 0;
    const intervalMs = 25;
    const interval = setInterval(() => {
        const now = performance.now();
        maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastTick - intervalMs);
        lastTick = now;
    }, intervalMs);
    let timeout;
    writeProgress(label, 'started');

    try {
        const value = await Promise.race([
            Promise.resolve().then(operation),
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error(
                        `${label} made no observable progress for ` +
                        `${noProgressTimeoutMs} ms`,
                    )),
                    noProgressTimeoutMs,
                );
            }),
        ]);
        const measurement = {
            label,
            durationMs: Math.round(performance.now() - started),
            maxEventLoopGapMs: Math.max(0, Math.round(maxEventLoopGapMs)),
            rssBefore,
            rssAfter: process.memoryUsage().rss,
        };
        metrics.push(measurement);
        writeProgress(label, 'completed', measurement);
        return value;
    } finally {
        clearInterval(interval);
        clearTimeout(timeout);
    }
}

function firstKeywordPosition(document) {
    const limit = Math.min(document.lineCount, 200);
    for (let line = 0; line < limit; line++) {
        const text = document.lineAt(line).text;
        if (text.trimStart().startsWith('*')) {
            return new vscode.Position(line, Math.min(2, text.length));
        }
    }
    return new vscode.Position(0, 0);
}

function activeTabUri() {
    const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    const input = tab && tab.input;
    if (!input) return null;
    return input.uri || input.modified || input.original || null;
}

async function waitForActiveTab(targetPath, timeoutMs = 10000) {
    const normalizedTarget = path.resolve(targetPath).toLowerCase();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const uri = activeTabUri();
        if (
            uri &&
            uri.scheme === 'file' &&
            path.resolve(uri.fsPath).toLowerCase() === normalizedTarget
        ) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Workbench did not activate the large deck tab: ${targetPath}`);
}

function writeResult(result) {
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

async function run() {
    assert.ok(workspaceRoot);
    assert.ok(targetRelativePath);
    assert.ok(resultFile);
    assert.strictEqual(noProgressTimeoutMs, 120000);

    const targetPath = path.join(workspaceRoot, targetRelativePath);
    const targetStat = fs.statSync(targetPath);
    const result = {
        target: targetRelativePath.split(path.sep).join('/'),
        bytes: targetStat.size,
        noProgressTimeoutMs,
        openStatus: 'pending',
        lineCount: null,
        languageId: null,
        metrics,
    };

    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    assert.ok(extension);
    await measureStep('activate extension', () => extension.activate());
    assert.strictEqual(extension.isActive, true);
    assert.strictEqual(
        vscode.workspace.getConfiguration('lsdyna').get('autoFormat'),
        'disabled',
    );

    let document;
    let editor;
    const targetUri = vscode.Uri.file(targetPath);
    try {
        document = await measureStep(
            'openTextDocument',
            () => vscode.workspace.openTextDocument(targetUri),
        );
        editor = await measureStep(
            'showTextDocument',
            () => vscode.window.showTextDocument(document, {
                preview: false,
                preserveFocus: false,
            }),
        );
        result.openStatus = 'opened';
        result.lineCount = document.lineCount;
        result.languageId = document.languageId;
    } catch (error) {
        result.openStatus = 'refused';
        result.openError = error && error.message ? error.message : String(error);
        console.log(
            `[large file] VS Code refused ${targetRelativePath}: ${result.openError}`,
        );
        await measureStep('open large deck in workbench', async () => {
            await vscode.commands.executeCommand('vscode.open', targetUri, {
                preview: false,
            });
            await waitForActiveTab(targetPath);
            await new Promise(resolve => setTimeout(resolve, 250));
        });
        result.openStatus = 'workbench-only';
        result.providersStatus = 'not-synchronized-above-50mb';
    }

    if (document) {
        assert.strictEqual(document.isDirty, false);
        const position = firstKeywordPosition(document);
        editor.selection = new vscode.Selection(position, position);

        await measureStep('hover provider', () => vscode.commands.executeCommand(
            'vscode.executeHoverProvider',
            document.uri,
            position,
        ));
        await measureStep('completion provider', () => vscode.commands.executeCommand(
            'vscode.executeCompletionItemProvider',
            document.uri,
            position,
        ));
        await measureStep('document symbols', () => vscode.commands.executeCommand(
            'vscode.executeDocumentSymbolProvider',
            document.uri,
        ));
        await measureStep('folding ranges', () => vscode.commands.executeCommand(
            'vscode.executeFoldingRangeProvider',
            document.uri,
        ));
        await measureStep('code lenses', () => vscode.commands.executeCommand(
            'vscode.executeCodeLensProvider',
            document.uri,
        ));
    } else {
        assert.ok(
            !vscode.workspace.textDocuments.some(
                opened => opened.uri.toString() === targetUri.toString(),
            ),
            'The >50 MiB deck must remain outside Extension Host text synchronization',
        );
    }

    const modelRoot = path.dirname(targetPath);
    const combinePath = path.join(modelRoot, 'combine.key');
    if (fs.existsSync(combinePath)) {
        const combineDocument = await measureStep(
            'switch to combine.key',
            async () => {
                const opened = await vscode.workspace.openTextDocument(
                    vscode.Uri.file(combinePath),
                );
                await vscode.window.showTextDocument(opened, {
                    preview: false,
                    preserveFocus: false,
                });
                return opened;
            },
        );
        assert.strictEqual(combineDocument.isDirty, false);
        if (document) {
            editor = await measureStep(
                'switch back to large deck',
                () => vscode.window.showTextDocument(document, {
                    preview: false,
                    preserveFocus: false,
                }),
            );
        } else {
            await measureStep('switch back to large deck', async () => {
                await vscode.commands.executeCommand('vscode.open', targetUri, {
                    preview: false,
                });
                await waitForActiveTab(targetPath);
            });
        }
    }

    await measureStep('include scan', () => vscode.commands.executeCommand(
        'extension.scanIncludeTree',
    ));
    await measureStep('keyword scan', () => vscode.commands.executeCommand(
        'extension.scanKeywordIndex',
    ));
    if (document) {
        await measureStep('save clean document', () => document.save());
        assert.strictEqual(document.isDirty, false);
    } else {
        await measureStep('save clean workbench tab', () =>
            vscode.commands.executeCommand('workbench.action.files.save')
        );
    }
    await measureStep('close all editors', () => vscode.commands.executeCommand(
        'workbench.action.closeAllEditors',
    ));

    writeResult(result);
    console.log(
        `Editor safety large file: ${targetRelativePath} passed ` +
        `(${targetStat.size} bytes)`,
    );
}

module.exports = { run };
