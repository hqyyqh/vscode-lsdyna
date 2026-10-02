'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const workspaceRoot = process.env.LSDYNA_EDITOR_SAFETY_VEHICLE_WORKSPACE;
const progressFile = process.env.LSDYNA_EDITOR_SAFETY_PROGRESS_FILE;
const noProgressTimeoutMs = Number(
    process.env.LSDYNA_EDITOR_SAFETY_NO_PROGRESS_TIMEOUT_MS || 120000,
);

function reportProgress(label, state, elapsedMs = null) {
    const record = {
        at: new Date().toISOString(),
        label,
        state,
        elapsedMs,
    };
    if (progressFile) {
        fs.writeFileSync(progressFile, `${JSON.stringify(record)}\n`, 'utf8');
    }
    console.log(
        `[vehicle safety] ${state}: ${label}` +
        (elapsedMs === null ? '' : ` (${elapsedMs} ms)`),
    );
}

async function withProgressTimeout(label, operation) {
    const started = Date.now();
    reportProgress(label, 'started');
    let timer;
    try {
        const result = await Promise.race([
            Promise.resolve().then(operation),
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(
                        `${label} made no observable progress for ` +
                        `${noProgressTimeoutMs} ms`,
                    )),
                    noProgressTimeoutMs,
                );
            }),
        ]);
        reportProgress(label, 'completed', Date.now() - started);
        return result;
    } finally {
        clearTimeout(timer);
    }
}

function listModelDirectories() {
    return fs.readdirSync(workspaceRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right, 'en'));
}

function listSmallDecks(modelName) {
    const modelRoot = path.join(workspaceRoot, modelName);
    return fs.readdirSync(modelRoot, { withFileTypes: true })
        .filter(entry =>
            entry.isFile() &&
            /\.(?:key|k|dyna|asc)$/i.test(entry.name) &&
            fs.statSync(path.join(modelRoot, entry.name)).size <= 1024 * 1024)
        .map(entry => entry.name)
        .sort((left, right) => left.localeCompare(right, 'en'));
}

async function openDeck(modelName, fileName) {
    const uri = vscode.Uri.file(path.join(workspaceRoot, modelName, fileName));
    let document = await vscode.workspace.openTextDocument(uri);
    if (document.languageId !== 'lsdyna') {
        document = await vscode.languages.setTextDocumentLanguage(document, 'lsdyna');
    }
    const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
    });
    assert.strictEqual(document.isDirty, false, `${modelName}/${fileName}`);
    return { document, editor };
}

function firstKeywordPosition(document) {
    for (let line = 0; line < document.lineCount; line++) {
        const text = document.lineAt(line).text;
        if (text.trimStart().startsWith('*')) {
            return new vscode.Position(line, Math.min(text.length, 2));
        }
    }
    return new vscode.Position(0, 0);
}

async function exerciseReadOnlyProviders(modelName, fileName, document, editor) {
    const position = firstKeywordPosition(document);
    editor.selection = new vscode.Selection(position, position);
    await vscode.commands.executeCommand(
        'vscode.executeHoverProvider',
        document.uri,
        position,
    );
    await vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider',
        document.uri,
        position,
    );
    await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
    );
    await vscode.commands.executeCommand(
        'vscode.executeCodeActionProvider',
        document.uri,
        new vscode.Range(position, position),
    );
    assert.strictEqual(document.isDirty, false, `${modelName}/${fileName}`);
    assert.strictEqual(await document.save(), true, `${modelName}/${fileName}`);
    assert.strictEqual(document.isDirty, false, `${modelName}/${fileName}`);
}

async function cancelQuickPickCommand(commandId, argument) {
    const commandPromise = vscode.commands.executeCommand(commandId, argument);
    await new Promise(resolve => setTimeout(resolve, 100));
    await vscode.commands.executeCommand('quickInput.hide');
    return Promise.race([
        commandPromise,
        new Promise((_, reject) => setTimeout(
            () => reject(new Error(`${commandId} did not settle after cancellation`)),
            3000,
        )),
    ]);
}

async function exerciseModel(modelName) {
    const smallDecks = listSmallDecks(modelName);
    assert.ok(smallDecks.length >= 2, `${modelName} needs multiple small condition decks`);
    assert.ok(smallDecks.includes('combine.key'), `${modelName} is missing combine.key`);

    const combine = await openDeck(modelName, 'combine.key');
    await exerciseReadOnlyProviders(
        modelName,
        'combine.key',
        combine.document,
        combine.editor,
    );
    await withProgressTimeout(
        `${modelName}: include scan from combine.key`,
        () => vscode.commands.executeCommand('extension.scanIncludeTree'),
    );
    await withProgressTimeout(
        `${modelName}: keyword scan from combine.key`,
        () => vscode.commands.executeCommand('extension.scanKeywordIndex'),
    );
    await withProgressTimeout(
        `${modelName}: cancel include search`,
        () => cancelQuickPickCommand('extension.searchIncludeTree'),
    );
    await withProgressTimeout(
        `${modelName}: cancel keyword search`,
        () => cancelQuickPickCommand('extension.searchKeywordIndex'),
    );

    let contextDeck = null;
    for (const fileName of smallDecks) {
        if (fileName === 'combine.key') continue;
        const opened = await openDeck(modelName, fileName);
        await exerciseReadOnlyProviders(modelName, fileName, opened.document, opened.editor);
        if (!contextDeck) contextDeck = opened;
    }

    assert.ok(contextDeck);
    await vscode.window.showTextDocument(contextDeck.document, {
        preview: false,
        preserveFocus: false,
    });
    await withProgressTimeout(
        `${modelName}: include scan from alternate condition`,
        () => vscode.commands.executeCommand('extension.scanIncludeTree'),
    );
    await withProgressTimeout(
        `${modelName}: cancel main-deck context selection`,
        () => cancelQuickPickCommand(
            'extension.selectMainDeckContext',
            { documentPath: contextDeck.document.uri.fsPath },
        ),
    );

    await vscode.commands.executeCommand('workbench.action.files.saveAll');
    for (const document of vscode.workspace.textDocuments) {
        if (document.uri.scheme === 'file' &&
            document.uri.fsPath.startsWith(path.join(workspaceRoot, modelName))) {
            assert.strictEqual(document.isDirty, false, document.uri.fsPath);
        }
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function run() {
    assert.ok(workspaceRoot, 'Missing isolated vehicle workspace');
    assert.strictEqual(noProgressTimeoutMs, 120000);
    const models = listModelDirectories();
    assert.strictEqual(models.length, 6);

    const autoFormat = vscode.workspace.getConfiguration('lsdyna').get('autoFormat');
    assert.strictEqual(autoFormat, 'disabled');

    for (const modelName of models) {
        await withProgressTimeout(
            `${modelName}: passive workflow`,
            () => exerciseModel(modelName),
        );
    }

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('Editor safety vehicles: 6 isolated model workflows passed');
}

module.exports = { run };
