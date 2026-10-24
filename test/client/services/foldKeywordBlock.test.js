const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeDoc, vscodeMock: vscode } = require('../../support/helpers');
const { foldKeywordBlock, foldAllKeywordBlocks, foldKeywordAtCursor, unfoldAllKeywordBlocks } = require('../../../src/client/services/foldKeywordBlock');

describe('foldKeywordBlock', () => {
    let root, item, tab, calls, warnings, settings, saved, onProgress;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-keyword-'));
        const filePath = path.join(root, 'model.k');
        fs.writeFileSync(filePath, '*NODE\n  1,0,0,0\n29000001,1,1,1\n*END\n');
        item = { occurrence: { filePath, startLine: 0, endLine: 2, rawKeyword: 'NODE' } };
        tab = { input: { uri: vscode.Uri.file(filePath) }, isDirty: false };
        calls = []; warnings = []; settings = { largeFileOptimizations: false, folding: true };
        saved = { execute: vscode.commands.executeCommand, progress: vscode.window.withProgress,
            getCommands: vscode.commands.getCommands, editor: vscode.window.activeTextEditor,
            warning: vscode.window.showWarningMessage, groups: vscode.window.tabGroups,
            docs: vscode.workspace.textDocuments, config: vscode.workspace.getConfiguration, locations: vscode.ProgressLocation };
        vscode.ProgressLocation = { Window: 10 };
        vscode.commands.executeCommand = async (...args) => { calls.push(args); };
        vscode.commands.getCommands = async () => [];
        vscode.window.activeTextEditor = undefined;
        vscode.window.showWarningMessage = async message => warnings.push(message);
        onProgress = () => {};
        vscode.window.withProgress = async (_options, run) => { onProgress(); return run({}, { isCancellationRequested: false }); };
        vscode.window.tabGroups = { activeTabGroup: { activeTab: tab }, all: [{ tabs: [tab] }] };
        vscode.workspace.textDocuments = [];
        vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => settings[key] ?? fallback });
    });
    afterEach(() => {
        vscode.commands.executeCommand = saved.execute; vscode.window.withProgress = saved.progress;
        vscode.commands.getCommands = saved.getCommands; vscode.window.activeTextEditor = saved.editor;
        vscode.window.showWarningMessage = saved.warning; vscode.window.tabGroups = saved.groups;
        vscode.workspace.textDocuments = saved.docs; vscode.workspace.getConfiguration = saved.config;
        vscode.ProgressLocation = saved.locations;
        fs.rmSync(root, { recursive: true, force: true });
    });
    const folded = () => calls.some(call => call[0] === 'editor.createFoldingRangeFromSelection');
    const nativeCommands = ['runCommands', 'setSelection', 'createCursor', '_lastCursorMoveToSelect'];
    const cursorCommands = [...nativeCommands, 'editor.action.setSelectionAnchor',
        'editor.action.goToSelectionAnchor', 'editor.action.cancelSelectionAnchor'];
    it('folds only the primary cursor block in a live document, including unsaved content', async () => {
        const doc = fakeDoc('*NODE\n1,0,0,0\n*PART\nPart\n1,0,0\n*END', item.occurrence.filePath);
        doc.uri = tab.input.uri; doc.version = 1; doc.isDirty = true; tab.isDirty = true;
        vscode.workspace.textDocuments = [doc];
        const selections = [];
        vscode.window.activeTextEditor = { document: doc, selection: { active: { line: 4 } },
            set selections(value) { selections.push(value); } };
        await foldKeywordAtCursor();
        assert.equal(selections.length, 1); assert.equal(selections[0].length, 1);
        assert.equal(selections[0][0].start.line, 2); assert.equal(selections[0][0].end.line, 5);
        assert(!calls.some(call => call[0] === 'editor.unfoldAll'));
    });
    it('initializes an unsynchronized file once, restores its cursor, and then folds locally', async () => {
        vscode.commands.getCommands = async () => cursorCommands;
        await foldKeywordAtCursor();
        const order = calls.map(call => call[0]);
        assert(order.indexOf('editor.action.setSelectionAnchor') < order.indexOf('runCommands'));
        assert(order.indexOf('runCommands') < order.indexOf('editor.unfoldAll'));
        assert(order.indexOf('editor.unfoldAll') < order.indexOf('editor.action.goToSelectionAnchor'));
        assert(order.indexOf('editor.action.goToSelectionAnchor') < order.indexOf('editor.fold'));
        assert(order.includes('editor.action.cancelSelectionAnchor'));
        calls.length = 0;
        await foldKeywordAtCursor();
        assert(calls.some(call => call[0] === 'editor.fold'));
        assert(!calls.some(call => ['runCommands', 'editor.unfoldAll', 'editor.action.setSelectionAnchor'].includes(call[0])));
        fs.appendFileSync(item.occurrence.filePath, '*PART\nPart\n2,0,0\n');
        calls.length = 0; await foldKeywordAtCursor();
        assert(calls.some(call => call[0] === 'editor.action.setSelectionAnchor'));
        assert(calls.some(call => call[0] === 'runCommands'));
    });
    it('restores the anchor after cancellation and retries incomplete initialization', async () => {
        vscode.commands.getCommands = async () => cursorCommands;
        const token = { isCancellationRequested: false };
        vscode.window.withProgress = async (_options, run) => run({}, token);
        vscode.commands.executeCommand = async (...args) => { calls.push(args); if(args[0] === 'runCommands') token.isCancellationRequested = true; };
        await foldKeywordAtCursor();
        assert(!calls.some(call => call[0] === 'editor.fold' || call[0] === 'editor.unfoldAll'));
        assert(calls.some(call => call[0] === 'editor.action.goToSelectionAnchor'));
        assert(calls.some(call => call[0] === 'editor.action.cancelSelectionAnchor'));
        token.isCancellationRequested = false; calls.length = 0;
        vscode.commands.executeCommand = async (...args) => { calls.push(args); };
        await foldKeywordAtCursor();assert(calls.some(call => call[0] === 'runCommands'));
    });
    it('does not restore an old anchor into another tab', async () => {
        vscode.commands.getCommands = async () => cursorCommands;
        vscode.commands.executeCommand = async (...args) => { calls.push(args); if(args[0] === 'runCommands') vscode.window.tabGroups.activeTabGroup.activeTab = {}; };
        await foldKeywordAtCursor();
        assert(!calls.some(call => ['editor.fold', 'editor.unfoldAll', 'editor.action.goToSelectionAnchor',
            'editor.action.cancelSelectionAnchor'].includes(call[0])));
    });
    it('reports unavailable native cursor commands without moving or folding', async () => {
        await foldKeywordAtCursor();
        assert.equal(warnings.length, 1);assert(!folded());
        assert(!calls.some(call => call[0] === 'editor.action.setSelectionAnchor'));
    });
    it('refuses native cursor folding of indented headers even after global preparation', async () => {
        fs.writeFileSync(item.occurrence.filePath, '*KEYWORD\n  *NODE\n  1,0,0,0\n*END\n');
        vscode.commands.getCommands = async () => cursorCommands;
        await foldAllKeywordBlocks();
        calls.length = 0;
        await foldKeywordAtCursor();
        assert.equal(warnings.length, 1);
        assert(!calls.some(call => ['editor.fold', 'editor.unfoldAll', 'editor.action.setSelectionAnchor', 'runCommands'].includes(call[0])));
    });
    it('includes the final data line when the file has no trailing newline or END keyword', async () => {
        fs.writeFileSync(item.occurrence.filePath, '*NODE\n1,0,0,0');
        vscode.commands.getCommands = async () => nativeCommands;
        await foldAllKeywordBlocks();
        const selection = calls.find(call => call[0] === 'runCommands')[1].commands[0].args.selection;
        assert.equal(selection.positionLineNumber, 2);
        assert(selection.positionColumn > 1, 'a column-one endpoint would exclude the last data line');
    });
    it('batches unsynchronized ranges and keeps adjacent selections separate', async () => {
        fs.writeFileSync(item.occurrence.filePath, '*PART\nPart\n1,0,0\n'.repeat(270) + '*END\n');
        vscode.commands.getCommands = async () => nativeCommands;
        await foldAllKeywordBlocks();
        const batches = calls.filter(call => call[0] === 'runCommands').map(call => call[1].commands);
        assert.equal(batches.length, 3);
        assert.equal(batches.flat().filter(command => command === 'editor.createFoldingRangeFromSelection').length, 3);
        assert.deepEqual(batches[0][0].args.selection, { selectionStartLineNumber: 1,
            selectionStartColumn: 2, positionLineNumber: 4, positionColumn: 1 });
        assert.deepEqual(batches[0][1].args.position, { lineNumber: 4, column: 2 });
        assert.deepEqual(batches[2][0].args.selection, { selectionStartLineNumber: 769,
            selectionStartColumn: 2, positionLineNumber: 772, positionColumn: 1 });
        assert.equal(warnings.length, 0);
    });
    it('uses public selections for synchronized documents and respects the cursor limit', async () => {
        const doc = fakeDoc('*PART\nPart\n1,0,0\n'.repeat(5) + '*END', item.occurrence.filePath);
        doc.uri = tab.input.uri; doc.version = 1;
        vscode.workspace.textDocuments = [doc]; settings.multiCursorLimit = 2;
        const batches = [];
        vscode.window.activeTextEditor = { document: doc, set selections(value) { batches.push(value); } };
        await foldAllKeywordBlocks();
        assert.deepEqual(batches.map(batch => batch.length), [2, 2, 1]);
        assert.equal(batches[0][0].start.character, 1);
        assert.equal(batches[0][1].start.line, 3);
        assert.equal(calls.filter(call => call[0] === 'editor.createFoldingRangeFromSelection').length, 3);
    });
    it('reuses only the structure and rebuilds native ranges after they may have been removed', async () => {
        const { BlockIndex } = require('../../../src/core/incremental/blockIndex');
        const original = BlockIndex.prototype.buildIndexFromFile; let scans = 0;
        BlockIndex.prototype.buildIndexFromFile = function (...args) { scans++; return original.apply(this, args); };
        try {
            await foldAllKeywordBlocks(); await unfoldAllKeywordBlocks(); await foldAllKeywordBlocks();
            assert.equal(scans, 1);
            assert.equal(calls.filter(call => call[0] === 'editor.createFoldingRangeFromSelection').length, 2);
            fs.appendFileSync(item.occurrence.filePath, '*PART\nPart\n2,0,0\n');
            await foldAllKeywordBlocks(); assert.equal(scans, 2);
            const reopened = { input: tab.input, isDirty: false };
            vscode.window.tabGroups.activeTabGroup.activeTab = reopened;
            vscode.window.tabGroups.all[0].tabs = [reopened];
            await foldAllKeywordBlocks(); assert.equal(scans, 3);
        } finally { BlockIndex.prototype.buildIndexFromFile = original; }
    });
    it('invalidates a cached live structure when the document version changes', async () => {
        const doc = fakeDoc('*NODE\n1,0,0,0\n*END', item.occurrence.filePath);
        doc.uri = tab.input.uri; doc.version = 1; vscode.workspace.textDocuments = [doc];
        await foldAllKeywordBlocks();
        let reads = 0; const lineAt = doc.lineAt;
        doc.lineAt = (...args) => { reads++; return lineAt(...args); };
        await foldAllKeywordBlocks(); assert.equal(reads, 0);
        doc.version++; await foldAllKeywordBlocks(); assert(reads > 0);
    });
    it('stops after a native batch when cancelled, changed, or switched to another tab', async () => {
        fs.writeFileSync(item.occurrence.filePath, '*PART\nPart\n1,0,0\n'.repeat(270) + '*END\n');
        vscode.commands.getCommands = async () => nativeCommands;
        for (const change of ['cancel', 'disk', 'tab']) {
            calls.length = 0; warnings.length = 0;
            const token = { isCancellationRequested: false };
            vscode.window.withProgress = async (_options, run) => run({}, token);
            vscode.commands.executeCommand = async (...args) => {
                calls.push(args);
                if (args[0] !== 'runCommands') return;
                if (change === 'cancel') token.isCancellationRequested = true;
                if (change === 'disk') fs.appendFileSync(item.occurrence.filePath, '$ changed\n');
                if (change === 'tab') vscode.window.tabGroups.activeTabGroup.activeTab = {};
            };
            await foldAllKeywordBlocks();
            assert.equal(calls.filter(call => call[0] === 'runCommands').length, 1, change);
            assert.equal(warnings.length, change === 'disk' ? 1 : 0, change);
        }
    });
    it('does not submit a batch if the tab changes during its disk check', async () => {
        vscode.commands.getCommands = async () => nativeCommands;
        const stat = fs.promises.stat; let checks = 0;
        fs.promises.stat = async (...args) => {
            const result = await stat(...args);
            if (++checks === 3) vscode.window.tabGroups.activeTabGroup.activeTab = {};
            return result;
        };
        try {
            await foldAllKeywordBlocks();
            assert.equal(checks, 3);
            assert(!calls.some(call => call[0] === 'runCommands'));
        } finally { fs.promises.stat = stat; }
    });
    it('unfolding supersedes a pending fold scan', async () => {
        let release, ready;
        const started = new Promise(resolve => { ready = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        vscode.window.withProgress = async (_options, run) => { ready(); await gate; return run({}, { isCancellationRequested: false }); };
        const pending = foldAllKeywordBlocks(); await started;
        await unfoldAllKeywordBlocks(); release(); await pending;
        assert(!folded()); assert(calls.some(call => call[0] === 'editor.unfoldAll'));
    });
    it('scans the active file and creates each nonempty keyword range', async () => {
        fs.writeFileSync(item.occurrence.filePath, '*NODE\n1,0,0,0\n*PART\nPart\n1,0,0\n*END\n');
        const before = fs.readFileSync(item.occurrence.filePath);
        await foldAllKeywordBlocks();
        assert.equal(calls.filter(call => call[0] === 'editor.createFoldingRangeFromSelection').length, 2);
        assert.deepEqual(calls.filter(call => call[3]?.selection).map(call =>
            [call[3].selection.start.line, call[3].selection.end.line]), [[0, 2], [2, 5], [0, 0]]);
        assert.deepEqual(fs.readFileSync(item.occurrence.filePath), before);
    });
    it('stops a batch if the disk changes after the first range', async () => {
        fs.writeFileSync(item.occurrence.filePath, '*NODE\n1,0,0,0\n*PART\nPart\n1,0,0\n*END\n');
        vscode.commands.executeCommand = async (...args) => {
            calls.push(args);
            if (args[0] === 'editor.createFoldingRangeFromSelection') fs.appendFileSync(item.occurrence.filePath, '$ changed\n');
        };
        await foldAllKeywordBlocks();
        assert.equal(calls.filter(call => call[0] === 'editor.createFoldingRangeFromSelection').length, 1);
        assert.equal(warnings.length, 1);
    });
    it('stops a batch on cancellation after the first range', async () => {
        fs.writeFileSync(item.occurrence.filePath, '*NODE\n1,0,0,0\n*PART\nPart\n1,0,0\n*END\n');
        const token = { isCancellationRequested: false };
        vscode.window.withProgress = async (_options, run) => run({}, token);
        vscode.commands.executeCommand = async (...args) => {
            calls.push(args);
            if (args[0] === 'editor.createFoldingRangeFromSelection') token.isCancellationRequested = true;
        };
        await foldAllKeywordBlocks();
        assert.equal(calls.filter(call => call[0] === 'editor.createFoldingRangeFromSelection').length, 1);
        assert.equal(warnings.length, 0);
    });
    it('folds the full disk block across indentation changes without changing bytes', async () => {
        const before = fs.readFileSync(item.occurrence.filePath);
        await foldKeywordBlock(item);
        assert(folded(), JSON.stringify({ warnings, calls })); assert.equal(warnings.length, 0);
        const range = calls.find(call => call[3]?.selection)[3].selection;
        assert.equal(range.start.line, 0); assert.equal(range.end.line, 3);
        assert.deepEqual(fs.readFileSync(item.occurrence.filePath), before);
    });
    it('uses live document content, including unsaved edits', async () => {
        const doc = fakeDoc('*NODE\n1,0,0,0\n2,0,0,0\n3,0,0,0\n*END', item.occurrence.filePath);
        doc.uri = tab.input.uri; doc.version = 2; doc.isDirty = true;
        vscode.workspace.textDocuments = [doc]; tab.isDirty = true; item.occurrence.endLine = 3;
        await foldKeywordBlock(item); assert(folded());
    });
    it('rejects unsynchronized dirty files and stale block boundaries', async () => {
        tab.isDirty = true; await foldKeywordBlock(item); assert(!folded()); assert.equal(warnings.length, 1);
        tab.isDirty = false; item.occurrence.endLine = 1;
        await foldKeywordBlock(item); assert(!folded()); assert.equal(warnings.length, 2);
    });
    it('stops when the user switches tabs during scanning', async () => {
        onProgress = () => { vscode.window.tabGroups.activeTabGroup.activeTab = {}; };
        await foldKeywordBlock(item); assert(!folded());
        assert.equal(calls.filter(call => call[0] === 'vscode.openWith').length, 1);
    });
    it('does not fold a changed disk snapshot', async () => {
        onProgress = () => fs.appendFileSync(item.occurrence.filePath, '$ external edit\n');
        await foldKeywordBlock(item); assert(!folded()); assert.equal(warnings.length, 1);
    });
    it('cancels without showing an error or applying a fold', async () => {
        vscode.window.withProgress = async (_options, run) => run({}, { isCancellationRequested: true });
        await foldKeywordBlock(item); assert(!folded()); assert.equal(warnings.length, 0);
    });
    it('only applies the latest request when scans overlap', async () => {
        let release, started;
        const scanning = new Promise(resolve => { started = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        let count = 0;
        vscode.window.withProgress = async (_options, run) => {
            if (++count === 1) { started(); await gate; }
            return run({}, { isCancellationRequested: false });
        };
        const first = foldKeywordBlock(item); await scanning;
        await foldKeywordBlock(item); release(); await first;
        assert.equal(calls.filter(call => call[0] === 'editor.createFoldingRangeFromSelection').length, 1);
    });
    it('reports a missing file without applying a fold', async () => {
        fs.unlinkSync(item.occurrence.filePath);
        await foldKeywordBlock(item); assert(!folded()); assert.equal(warnings.length, 1);
    });
    it('does not change settings when native folding is disabled', async () => {
        settings.largeFileOptimizations = true;
        await foldKeywordBlock(item); assert(!folded()); assert.equal(warnings.length, 1);
        settings.largeFileOptimizations = false; settings.folding = false;
        await foldKeywordBlock(item); assert(!folded()); assert.equal(warnings.length, 2);
    });
});
