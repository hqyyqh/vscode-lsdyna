'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fakeDoc, vscodeMock } = require("../../support/helpers");
const { LsdynaKeywordIndexProvider } = require('../../../src/client/providers/keywordIndexProvider');

function modelDocument(filePath = path.join('project', 'model.k')) {
    const document = fakeDoc([
        '*KEYWORD',
        '*PART',
        'Front Bumper',
        '      1201        12        24',
        '*MAT_ELASTIC_TITLE',
        'Steel 6061-T6',
        '        24   2.70E-9   70000.0       0.3',
        '*NODE',
        '       1             0.0             0.0             0.0',
        '       2             1.0             0.0             0.0',
        '*END',
    ].join('\n'), filePath);
    document.languageId = 'lsdyna';
    return document;
}

function mutableDocument(filePath, initialLines) {
    let lines = initialLines.slice();
    const uri = {
        fsPath: filePath,
        toString() { return `file://${filePath.replace(/\\/g, '/')}`; },
    };
    return {
        uri,
        languageId: 'lsdyna',
        version: 1,
        isDirty: true,
        isClosed: false,
        lineReadCount: 0,
        get lineCount() { return lines.length; },
        lineAt(index) {
            this.lineReadCount++;
            if (index < 0 || index >= lines.length) throw new RangeError(`line ${index}`);
            return { text: lines[index] };
        },
        replace(nextLines) {
            lines = nextLines.slice();
            this.version++;
        },
    };
}

async function waitFor(predicate, timeoutMs = 2000) {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for keyword index');
        await new Promise(resolve => setImmediate(resolve));
    }
}

describe('keyword index layouts and cursor following', () => {
    let savedEditor;
    beforeEach(() => { savedEditor = vscodeMock.window.activeTextEditor; });
    afterEach(() => { vscodeMock.window.activeTextEditor = savedEditor; });
    it('settles a server-cancelled project scan without rejecting the command', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const { ResponseError, LSPErrorCodes } = require('vscode-languageserver-protocol');
        const client = createIndexClient({ languageClient: {
            sendNotification() {},
            sendRequest: async () => { throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Operation cancelled'); },
        } });
        const provider = new LsdynaKeywordIndexProvider({ loadProjectSnapshot: client.loadProjectSnapshot });
        const progress = vscodeMock.window.withProgress, location = vscodeMock.ProgressLocation;
        vscodeMock.ProgressLocation = { Notification: 1 };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} }, { isCancellationRequested: false });
        try {
            vscodeMock.window.activeTextEditor = { document: modelDocument(path.resolve('project', 'main.k')) };
            assert.equal(await provider.setRecursive(), false);
            assert.equal(provider.mode, 'local');
            assert.equal(provider.scanState, 'incomplete');
        } finally {
            provider.stopAutomaticWork();
            vscodeMock.window.withProgress = progress;
            vscodeMock.ProgressLocation = location;
        }
    });
    it('exposes the return-to-file action while scanning and ignores a late project result', async () => {
        const progress = vscodeMock.window.withProgress, location = vscodeMock.ProgressLocation;
        const execute = vscodeMock.commands.executeCommand;
        const contexts = new Map();
        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        const document = modelDocument(path.resolve('project', 'main.k'));
        const provider = new LsdynaKeywordIndexProvider({ loadProjectSnapshot: () => pending });
        const view = {};
        provider.attachTreeView(view);
        vscodeMock.ProgressLocation = { Notification: 1 };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} }, { isCancellationRequested: false });
        vscodeMock.commands.executeCommand = async (command, key, value) => {
            if (command === 'setContext') contexts.set(key, value);
        };
        try {
            vscodeMock.window.activeTextEditor = { document };
            const scanning = provider.scan();
            assert.equal(contexts.get('lsdyna.keywordIndexScanning'), true);
            assert.equal(provider.scanState, 'scanning');
            await provider.setLocal();
            assert.equal(contexts.get('lsdyna.keywordIndexScanning'), false);
            assert.equal(provider.mode, 'local');
            finish({ files: [document.uri.fsPath], fileIndexes: new Map() });
            assert.equal(await scanning, false);
            assert.equal(provider.mode, 'local');
            assert.ok(provider.findOccurrence(document.uri.fsPath, 2));
        } finally {
            finish({ files: [], fileIndexes: new Map() });
            provider.stopAutomaticWork();
            vscodeMock.window.withProgress = progress;
            vscodeMock.ProgressLocation = location;
            vscodeMock.commands.executeCommand = execute;
        }
    });
    it('clears local lookups and projections when the progress host rejects, then recovers', async () => {
        const progress = vscodeMock.window.withProgress, location = vscodeMock.ProgressLocation;
        const provider = new LsdynaKeywordIndexProvider();
        const previous = modelDocument(path.resolve('project', 'previous.k'));
        const next = path.resolve('project', 'next.k');
        vscodeMock.ProgressLocation = { Window: 1 };
        try {
            await provider.refreshFromUriOrDocument(previous);
            assert.equal(provider.findOccurrence(previous.uri.fsPath, 2)?.keyword, 'PART');
            vscodeMock.window.withProgress = async () => { throw new Error('controlled progress-host rejection'); };
            await provider.refreshFromUriOrDocument(vscodeMock.Uri.file(next));
            assert.equal(provider.scanState, 'incomplete');
            assert.deepEqual(provider.roots, []);
            assert.deepEqual(provider.listSearchEntries(), []);
            assert.equal(provider.findOccurrence(previous.uri.fsPath, 2), null);
            assert.equal(provider.findOccurrence(next, 0), null);
            provider.setLayout('category');
            assert.deepEqual(provider.roots, []);
            await provider.refreshFromUriOrDocument(modelDocument(next));
            assert.equal(provider.findOccurrence(next, 2)?.keyword, 'PART');
            assert.equal(provider.findOccurrence(previous.uri.fsPath, 2), null);
        } finally {
            provider.stopAutomaticWork();
            vscodeMock.window.withProgress = progress;
            vscodeMock.ProgressLocation = location;
        }
    });
    it('replaces local occurrence state for both legacy project scan inputs', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-legacy-index-'));
        const progress = vscodeMock.window.withProgress;
        const location = vscodeMock.ProgressLocation;
        const project = path.join(directory, 'main.k');
        const previous = path.join(directory, 'previous.k');
        fs.writeFileSync(project, '*NODE\n1,0,0,0\n');
        vscodeMock.ProgressLocation = { Notification: 1 };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} }, { isCancellationRequested: false });
        try {
            for (const snapshotMode of [false, true]) {
                const provider = new LsdynaKeywordIndexProvider(snapshotMode ? {
                    loadProjectSnapshot: async () => ({ files: [project], keywordMap: new Map([
                        ['NODE', [{ filePath: project, lineIndex: 0 }]],
                    ]) }),
                } : { collectIncludeFiles: async () => [project] });
                try {
                    const document = mutableDocument(previous, ['*PART', 'Old part', '1,1,1']);
                    await provider.refreshFromUriOrDocument(document);
                    assert.ok(provider.findOccurrence(previous, 1));
                    assert.equal(await provider.scan({ rootFile: project }), true);
                    assert.equal(provider.mode, 'recursive');
                    assert.deepEqual(provider.roots.map(item => item.label), ['NODE']);
                    assert.equal(provider.findOccurrence(previous, 1), null);
                    assert.equal(provider.findOccurrence(project, 0)?.keyword, 'NODE');
                    provider.setLayout('category');
                    assert.deepEqual(provider._occurrences.map(item => item.keyword), ['NODE']);
                    assert.equal(provider._baseProjectOccurrences.length, 1);
                    assert.equal(provider._documentOverlays.size, 0);
                    assert.equal(provider._projectFileOrderByKey.size, 1);
                    await provider.setLocal();
                    const liveProject = mutableDocument(project, ['*PART', 'Live part', '2,1,1']);
                    await provider.refreshFromUriOrDocument(liveProject);
                    provider.setLayout('alphabetical');
                    assert.equal(await provider.scan({ rootFile: project }), true);
                    assert.deepEqual(provider.roots.map(item => item.label), ['PART']);
                    assert.equal(provider.findOccurrence(project, 1)?.keyword, 'PART');
                } finally { provider.stopAutomaticWork(); }
            }
        } finally {
            vscodeMock.window.withProgress = progress;
            vscodeMock.ProgressLocation = location;
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    it('shows an unfinished Include scan even when no structure was published', () => {
        const { LsdynaIncludeTreeProvider } = require('../../../src/client/providers/includeTreeProvider');
        const i18n = require('../../../src/core/i18n');
        const provider = new LsdynaIncludeTreeProvider();
        const view = {};
        provider.attachTreeView(view);
        provider.markReferencesIncomplete();
        assert.equal(view.message, i18n.get('sidebarIncomplete'));
        const main = path.resolve('project', 'main.k');
        provider.root = provider._buildItemFromTreeNode({ filePath: main, missing: true, children: [] });
        provider.scanPhase = 'complete';
        provider.refresh();
        assert.equal(view.message, i18n.get('sidebarNoIncludes'));
        const [root] = provider.getChildren();
        assert.strictEqual(provider.getTreeItem(root), provider.root);
        assert.equal(root.label, 'main.k');
        assert.equal(root.filePath, main);
        assert.equal(root.resourceUri.fsPath, main);
        assert.ok(root.tooltip.value.includes(main));
        provider.clearProjectSnapshot();
        assert.equal(provider.root, null);
        assert.deepEqual(provider.getChildren(), []);
        assert.ok(!view.message.includes('main.k'));
    });

    it('keeps project refresh anchored to its main file and exposes incomplete scans', async () => {
        const roots = [];
        let cancel = false;
        const provider = new LsdynaKeywordIndexProvider({
            loadProjectSnapshot: async (root, _options, _progress, token) => {
                roots.push(root);
                token.isCancellationRequested = cancel;
                return { files: [root], fileIndexes: new Map() };
            },
        });
        const view = {};
        provider.attachTreeView(view);
        const editor = vscodeMock.window.activeTextEditor;
        const progress = vscodeMock.window.withProgress;
        const location = vscodeMock.ProgressLocation;
        const main = path.resolve('project', 'main.k');
        vscodeMock.ProgressLocation = { Notification: 1 };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} }, { isCancellationRequested: false });
        try {
            vscodeMock.window.activeTextEditor = { document: modelDocument(main) };
            assert.equal(await provider.scan(), true);
            assert.ok(view.message.includes('main.k'));
            vscodeMock.window.activeTextEditor = { document: modelDocument(path.resolve('project', 'child.k')) };
            assert.equal(await provider.refreshScope(), true);
            assert.deepEqual(roots, [main, main]);
            cancel = true;
            assert.equal(await provider.refreshScope(), false);
            assert.equal(provider.scanState, 'incomplete');
            assert.ok(view.message.includes('main.k'));
            await provider.setLocal();
            assert.equal(provider.mode, 'local');
            assert.ok(view.message.includes('child.k'));
            vscodeMock.window.activeTextEditor = { document: fakeDoc('text', 'notes.txt') };
            await provider.setLocal();
            assert.equal(provider.roots.length, 0);
            assert.ok(!view.message.includes('child.k'));
        } finally {
            vscodeMock.window.activeTextEditor = editor;
            vscodeMock.window.withProgress = progress;
            vscodeMock.ProgressLocation = location;
        }
    });

    it('rebuilds for a different document object at the same URI and version', async () => {
        const file = path.resolve('project', 'reopened.k');
        const before = mutableDocument(file, ['*KEYWORD', '*NODE', '1,0,0,0', '*END']);
        const after = mutableDocument(file, ['*KEYWORD', '*PART', 'new title', '*END']);
        const provider = new LsdynaKeywordIndexProvider();
        await provider.refreshFromDocument(before);
        before.isClosed = true;
        assert.equal(provider.getDocumentBlockIndexIfReady(before), null);
        assert.equal(provider.getDocumentBlockIndexIfReady(after), null);
        await provider.refreshFromDocument(after);
        assert.ok(provider.getDocumentBlockIndexIfReady(after));
        assert.equal(provider.findOccurrence(file, 2).keyword, 'PART');
    });

    it('discards an in-flight index when a same-URI document is replaced', async () => {
        const file = path.resolve('project', 'reopened-async.k');
        const before = mutableDocument(file, ['*KEYWORD', '*NODE', ...Array(100).fill('1,0,0,0'), '*END']);
        const after = mutableDocument(file, ['*KEYWORD', '*PART', 'new title', '*END']);
        const provider = new LsdynaKeywordIndexProvider({ asyncDocumentIndexThreshold: 1, documentIndexYieldInterval: 1 });
        const oldBuild = provider.refreshFromDocument(before);
        before.isClosed = true;
        const newBuild = provider.refreshFromDocument(after);
        await Promise.all([oldBuild, newBuild]);
        assert.equal(provider.getDocumentBlockIndexIfReady(before), null);
        assert.ok(provider.getDocumentBlockIndexIfReady(after));
        assert.equal(provider.findOccurrence(file, 2).keyword, 'PART');
    });

    it('projects the same occurrences as A-Z, source order, and LSPP categories', async () => {
        const provider = new LsdynaKeywordIndexProvider({ shouldSkipAutomaticDocumentScan: () => false });
        await provider.refreshFromDocument(modelDocument());

        const partRoot = provider.roots.find(item => item.label === 'PART');
        assert.ok(partRoot);
        const partLeaf = provider.getChildren(partRoot)[0];
        assert.equal(partLeaf.label, 'Front Bumper');
        assert.match(partLeaf.description, /PID 1201/);
        const partUsage = provider.listSearchEntries().find(entry => entry.keyword === 'PART').usages[0];
        assert.equal(partUsage.dataLineCount, 2);
        assert.equal(partUsage.fileOrder, 0);

        provider.setLayout('order');
        assert.deepEqual(provider.roots.slice(0, 3).map(item => item.label), [
            '*KEYWORD',
            '*PART — Front Bumper',
            '*MAT_ELASTIC_TITLE — Steel 6061-T6',
        ]);

        provider.setLayout('category');
        const partCategory = provider.roots.find(item => item.label === 'PART');
        assert.ok(partCategory);
        const categoryKeyword = provider.getChildren(partCategory).find(item => item.label === 'PART');
        assert.ok(categoryKeyword);
        assert.equal(provider.getChildren(categoryKeyword)[0].label, 'Front Bumper');
    });

    it('does not repeat a filename in a bare occurrence description', async () => {
        const root = path.join('project');
        const provider = new LsdynaKeywordIndexProvider({ shouldSkipAutomaticDocumentScan: () => false });
        const document = fakeDoc('*KEYWORD\n*DATABASE_RCFORC\n*END', path.join(root, 'combine_save.key'));
        document.languageId = 'lsdyna';
        await provider.refreshFromDocument(document);

        const occurrence = provider.getChildren(provider.roots.find(item => item.label === 'DATABASE_RCFORC'))[0];
        assert.equal(occurrence.label, 'combine_save.key');
        assert.equal(occurrence.description, 'L2');
    });

    it('follows the cursor without expanding keyword contents', async () => {
        const provider = new LsdynaKeywordIndexProvider({ shouldSkipAutomaticDocumentScan: () => false });
        const document = modelDocument();
        await provider.refreshFromDocument(document);
        const revealCalls = [];
        provider.attachTreeView({
            visible: true,
            async reveal(item, options) { revealCalls.push({ item, options }); },
        });
        const editor = {
            document,
            selection: { active: { line: 3, character: 2 } },
        };

        for (const layout of ['alphabetical', 'order', 'category']) {
            provider.setLayout(layout);
            revealCalls.length = 0;
            vscodeMock.window.activeTextEditor = editor;
            provider._followCursor = true;
            assert.equal(await provider.revealForEditor(editor, { force: true }), true);
            assert.equal(revealCalls.length, 1);
            const finalCall = revealCalls.at(-1);
            if (layout === 'order') {
                assert.equal(finalCall.item.occurrence.keyword, 'PART');
                assert.equal(finalCall.item.occurrence.startLine, 1);
            } else {
                assert.equal(finalCall.item.keyword, 'PART');
                assert.equal(finalCall.item.collapsibleState, vscodeMock.TreeItemCollapsibleState.Collapsed);
            }
            assert.equal(finalCall.options.focus, false);
            assert.equal(finalCall.options.select, true);
            assert.equal(finalCall.options.expand, false);
        }
    });

    it('keeps large source-order lists paged and materializes only an opened page', () => {
        const filePath = path.join('project', 'many.k');
        const blocks = Array.from({ length: 450 }, (_, index) => ({
            keyword: '*PART',
            startLine: index * 3,
            endLine: index * 3 + 2,
            displayIdentity: {
                kind: 'identified',
                keyword: 'PART',
                canonicalKeyword: 'PART',
                identity: { field: 'PID', value: String(index + 1) },
                dataLineCount: 2,
                confidence: 'verified',
            },
        }));
        const provider = new LsdynaKeywordIndexProvider({ initialLayout: 'order' });
        provider._buildRootsFromSnapshot({
            files: [filePath],
            fileIndexes: new Map([[filePath, { keywordBlocks: blocks }]]),
        }, path.dirname(filePath));

        assert.equal(provider.roots.length, 3);
        assert.deepEqual(provider.roots.map(item => item.label), ['1–200', '201–400', '401–450']);
        assert.equal(provider.roots[0]._children, null);
        assert.equal(provider.getChildren(provider.roots[0]).length, 200);
        assert.equal(provider.roots[1]._children, null);
    });

    it('persists layout but resets cursor following on every startup', () => {
        const state = new Map();
        const workspaceState = {
            get(key, fallback) { return state.has(key) ? state.get(key) : fallback; },
            update(key, value) { state.set(key, value); },
        };
        const provider = new LsdynaKeywordIndexProvider({ workspaceState });
        provider.setLayout('category');
        assert.equal(provider.toggleFollowCursor(), true);
        state.set('lsdyna.keywordIndex.followCursor', true);

        const restored = new LsdynaKeywordIndexProvider({ workspaceState });
        assert.equal(restored.layout, 'category');
        assert.equal(restored.followCursor, false);
    });

    it('reports explicit scan completion and keeps cancellation from reusing an older recursive snapshot', async () => {
        const filePath = path.resolve('project', 'cancelled-main.k');
        const provider = new LsdynaKeywordIndexProvider({
            loadProjectSnapshot: async (_root, _options, onPartial, token) => {
                onPartial({ files: [filePath] });
                token.isCancellationRequested = true;
                return {
                    files: [filePath],
                    fileIndexes: new Map([[filePath, { keywordBlocks: [
                        { keyword: '*PART', startLine: 0, endLine: 2, dataLineCount: 2 },
                    ] }]]),
                };
            },
        });
        provider._setMode('recursive');
        const originalEditor = vscodeMock.window.activeTextEditor;
        const originalWithProgress = vscodeMock.window.withProgress;
        const originalProgressLocation = vscodeMock.ProgressLocation;
        vscodeMock.window.activeTextEditor = { document: modelDocument(filePath) };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} }, { isCancellationRequested: false });
        vscodeMock.ProgressLocation = { Notification: 1 };
        const partials = [];
        try {
            assert.equal(await provider.scan({ onPartial: value => partials.push(value) }), false);
            assert.equal(provider.mode, 'recursive');
            assert.deepEqual(partials, [{ filesScanned: 1 }]);
        } finally {
            vscodeMock.window.activeTextEditor = originalEditor;
            vscodeMock.window.withProgress = originalWithProgress;
            vscodeMock.ProgressLocation = originalProgressLocation;
        }
    });

    it('replaces a recursive snapshot with the latest dirty include overlay and restores it on close', async () => {
        const filePath = path.resolve('project', 'dirty-include.k');
        const baseBlocks = [
            { keyword: '*KEYWORD', startLine: 0, endLine: 0 },
            {
                keyword: '*PART',
                startLine: 1,
                endLine: 3,
                displayIdentity: {
                    kind: 'named',
                    keyword: 'PART',
                    canonicalKeyword: 'PART',
                    title: 'Snapshot part',
                    identity: { field: 'PID', value: '10' },
                    dataLineCount: 2,
                    confidence: 'verified',
                },
            },
            { keyword: '*END', startLine: 4, endLine: 4 },
        ];
        const provider = new LsdynaKeywordIndexProvider({
            initialLayout: 'alphabetical',
            asyncDocumentIndexThreshold: 1,
            documentIndexYieldInterval: 2,
        });
        provider._setMode('recursive');
        provider._buildRootsFromSnapshot({
            files: [filePath],
            fileIndexes: new Map([[filePath, { keywordBlocks: baseBlocks }]]),
        }, path.dirname(filePath));

        const document = mutableDocument(filePath, [
            '*KEYWORD',
            '*PART',
            'Obsolete live part',
            '20,1,1',
            '*END',
        ]);
        const firstRefresh = provider.refreshFromDocument(document);
        assert.ok(document.lineReadCount <= 2, 'the first live scan must yield after its configured chunk');

        document.replace([
            '*KEYWORD',
            '*NODE',
            '1,0,0,0',
            '*MAT_ELASTIC_TITLE',
            'Live aluminum',
            '24,2.7e-9,70000,0.3',
            '*END',
        ]);
        provider.updateDocumentIndex(document, {
            contentChanges: [{
                range: { start: { line: 1, character: 0 }, end: { line: 4, character: 4 } },
                text: '*NODE\n1,0,0,0\n*MAT_ELASTIC_TITLE\nLive aluminum\n24,2.7e-9,70000,0.3\n*END',
            }],
        });

        await firstRefresh;
        await waitFor(() => provider._documentIndexBuilds.size === 0 && provider.findOccurrence(filePath, 5));
        assert.ok(provider.roots.some(item => item.label === 'MAT_ELASTIC_TITLE'));
        assert.ok(!provider.roots.some(item => item.label === 'PART'));
        assert.equal(provider.findOccurrence(filePath, 5).startLine, 3);

        const revealCalls = [];
        provider.attachTreeView({
            visible: true,
            async reveal(item, options) { revealCalls.push({ item, options }); },
        });
        const editor = { document, selection: { active: { line: 5, character: 1 } } };
        for (const layout of ['alphabetical', 'order', 'category']) {
            provider.setLayout(layout);
            revealCalls.length = 0;
            vscodeMock.window.activeTextEditor = editor;
            provider._followCursor = true;
            assert.equal(await provider.revealForEditor(editor, { force: true }), true);
            assert.equal(revealCalls.length, 1);
            const target = revealCalls.at(-1).item;
            if (layout === 'order') {
                assert.equal(target.kind, 'file-group');
                assert.equal(target.filePath, filePath);
            } else {
                assert.equal(target.keyword, 'MAT_ELASTIC_TITLE');
            }
            assert.equal(revealCalls.at(-1).options.expand, false);
        }

        document.isClosed = true;
        provider.disposeDocument(document);
        provider.setLayout('alphabetical');
        assert.ok(provider.roots.some(item => item.label === 'PART'));
        assert.ok(!provider.roots.some(item => item.label === 'MAT_ELASTIC_TITLE'));
        assert.equal(provider.findOccurrence(filePath, 2).keyword, 'PART');
    });

    it('keeps an already indexed dirty editor authoritative when a project snapshot loads', async () => {
        const filePath = path.resolve('project', 'dirty-main.k');
        const document = mutableDocument(filePath, [
            '*KEYWORD',
            '*MAT_ELASTIC_TITLE',
            'Unsaved live material',
            '77,7.8e-9,210000,0.3',
            '*END',
        ]);
        const provider = new LsdynaKeywordIndexProvider({ asyncDocumentIndexThreshold: 1000 });
        await provider.refreshFromDocument(document);
        assert.ok(provider.roots.some(item => item.label === 'MAT_ELASTIC_TITLE'));

        provider._setMode('recursive');
        provider._buildRootsFromSnapshot({
            files: [filePath],
            fileIndexes: new Map([[filePath, {
                keywordBlocks: [
                    { keyword: '*KEYWORD', startLine: 0, endLine: 0 },
                    { keyword: '*PART', startLine: 1, endLine: 3 },
                    { keyword: '*END', startLine: 4, endLine: 4 },
                ],
            }]]),
        }, path.dirname(filePath));

        assert.ok(provider.roots.some(item => item.label === 'MAT_ELASTIC_TITLE'));
        assert.ok(!provider.roots.some(item => item.label === 'PART'));
        assert.equal(provider.findOccurrence(filePath, 3).keyword, 'MAT_ELASTIC_TITLE');
    });

    it('does not let an obsolete large-file refresh replace the newly active local file', async () => {
        const slowPath = path.resolve('project', 'slow-large.k');
        const currentPath = path.resolve('project', 'current.k');
        const slowDocument = mutableDocument(slowPath, [
            '*KEYWORD', '*NODE',
            ...Array.from({ length: 20 }, (_, index) => `${index + 1},0,0,0`),
            '*END',
        ]);
        const currentDocument = mutableDocument(currentPath, ['*KEYWORD', '*END']);
        const provider = new LsdynaKeywordIndexProvider({
            asyncDocumentIndexThreshold: 5,
            documentIndexYieldInterval: 2,
        });

        const obsoleteRefresh = provider.refreshFromDocument(slowDocument);
        await provider.refreshFromDocument(currentDocument);
        await obsoleteRefresh;

        assert.deepEqual(provider.roots.map(item => item.label), ['END', 'KEYWORD']);
        assert.equal(provider.findOccurrence(currentPath, 1).keyword, 'END');
        assert.equal(provider.findOccurrence(slowPath, 2), null);
    });

    it('exposes only a ready line-count-matched block index without starting a scan', async () => {
        const filePath = path.resolve('project', 'ready-index.k');
        const document = mutableDocument(filePath, ['*KEYWORD', '*PART', '1', '*END']);
        const provider = new LsdynaKeywordIndexProvider({ asyncDocumentIndexThreshold: 1000 });
        let builds = 0;
        const originalDocumentIndex = provider._documentIndex.bind(provider);
        provider._documentIndex = actualDocument => {
            builds++;
            return originalDocumentIndex(actualDocument);
        };

        assert.equal(provider.getDocumentBlockIndexIfReady(document), null);
        assert.equal(builds, 0);

        await provider.refreshFromDocument(document);
        const ready = provider.getDocumentBlockIndexIfReady(document);
        assert.ok(ready);
        assert.equal(ready.lineCount, document.lineCount);
        assert.equal(builds, 1);

        document.replace(['*KEYWORD', '*MAT_ELASTIC', '1', '*END']);
        assert.equal(provider.getDocumentBlockIndexIfReady(document), null);
        assert.equal(builds, 1);
    });

    it('upgrades a clean disk index to the live version when VS Code adds its virtual EOF line', async () => {
        const filePath = path.resolve('project', 'disk-to-live.k');
        const document = mutableDocument(filePath, [
            '*KEYWORD', '*MAT_DAMAGE_1', ' '.repeat(80), ' '.repeat(80), '*END', '',
        ]);
        document.isDirty = false;
        const provider = new LsdynaKeywordIndexProvider({ asyncDocumentIndexThreshold: 1000 });
        const uriKey = document.uri.toString();
        const diskIndex = provider._createDocumentIndex(document);
        diskIndex.buildIndex(
            document.lineCount - 1,
            index => document.lineAt(index).text,
        );
        provider.documentIndices.set(uriKey, diskIndex);
        provider._documentIndexVersions.set(uriKey, null);

        assert.equal(provider.getDocumentBlockIndexIfReady(document), null);
        await provider.refreshFromDocument(document);

        const ready = provider.getDocumentBlockIndexIfReady(document);
        assert.ok(ready);
        assert.equal(ready.lineCount, document.lineCount);
        assert.equal(provider._documentIndexVersions.get(uriKey), document.version);
        assert.equal(ready.findBlockAtLine(3).startLine, 1);
        assert.equal(ready.findBlockAtLine(4).startLine, 4);
    });

    it('keeps an open live document authoritative when a tab URI refresh arrives later', async () => {
        const filePath = path.resolve('project', 'tab-uri-race.k');
        const document = mutableDocument(filePath, [
            '*KEYWORD', '*MAT_DAMAGE_1', ' '.repeat(80), ' '.repeat(80), '*END', '',
        ]);
        document.isDirty = false;
        const provider = new LsdynaKeywordIndexProvider({ asyncDocumentIndexThreshold: 1000 });
        const originalTextDocuments = vscodeMock.workspace.textDocuments;
        vscodeMock.workspace.textDocuments = [document];
        try {
            await provider.refreshFromUriOrDocument(document.uri);
        } finally {
            vscodeMock.workspace.textDocuments = originalTextDocuments;
        }

        const ready = provider.getDocumentBlockIndexIfReady(document);
        assert.ok(ready);
        assert.equal(ready.lineCount, document.lineCount);
        assert.equal(provider._documentIndexVersions.get(document.uri.toString()), document.version);
    });
});


describe('keyword sidebar on-demand work', () => {
    let previous;
    beforeEach(() => { previous = vscodeMock.window.activeTextEditor; });
    afterEach(() => { vscodeMock.window.activeTextEditor = previous; });
    it('does no hidden scanning and refreshes only the latest document version when shown', async () => {
        const document = mutableDocument(path.resolve('hidden.k'), ['*PART', 'title', '1']);
        const editor = { document, selection: { active: { line: 0, character: 0 } } };
        vscodeMock.window.activeTextEditor = editor;
        const provider = new LsdynaKeywordIndexProvider();
        const view = { visible: false, reveal() { throw Error('unexpected reveal'); } };
        provider.attachTreeView(view);
        for (let i = 0; i < 10; i++) {
            document.replace(['*NODE', String(i)]);
            provider.updateDocumentAutomatically(document, { contentChanges: [] });
            await provider.refreshAutomatically(document);
        }
        assert.equal(document.lineReadCount, 0);
        view.visible = true;
        await Promise.all([provider.refreshAutomatically(document), provider.refreshAutomatically(document)]);
        const reads = document.lineReadCount;
        assert.ok(reads > 0);
        await provider.refreshAutomatically(document.uri);
        assert.equal(document.lineReadCount, reads);
        assert.equal(provider.findOccurrence(document.uri.fsPath, 0).keyword, 'NODE');
        assert.equal(await provider.revealForEditor(editor, { force: true }), false);
        provider.stopAutomaticWork();
    });
    it('never reveals hidden trees, disabled following, or a superseded editor', async () => {
        const document = modelDocument();
        const editor = { document, selection: { active: { line: 1 } } };
        const provider = new LsdynaKeywordIndexProvider();
        await provider.refreshFromDocument(document);
        let reveals = 0;
        const view = { visible: true, async reveal() { reveals++; } };
        provider.attachTreeView(view);
        vscodeMock.window.activeTextEditor = editor;
        assert.equal(await provider.revealForEditor(editor, { force: true }), false);
        provider._followCursor = true; view.visible = false;
        assert.equal(await provider.revealForEditor(editor, { force: true }), false);
        view.visible = true; vscodeMock.window.activeTextEditor = { ...editor };
        assert.equal(await provider.revealForEditor(editor, { force: true }), false);
        vscodeMock.window.activeTextEditor = editor;
        assert.equal(await provider.revealForEditor(editor), true);
        assert.equal(reveals, 1);
    });
    it('stops a hidden automatic build while allowing a new explicit index request', async () => {
        const document = mutableDocument(path.resolve('cancel-hidden.k'), ['*PART', ...Array(5000).fill('1')]);
        vscodeMock.window.activeTextEditor = { document };
        const provider = new LsdynaKeywordIndexProvider({ asyncDocumentIndexThreshold: 1, documentIndexYieldInterval: 1 });
        const view = { visible: true }; provider.attachTreeView(view);
        const pending = provider.refreshAutomatically(document);
        view.visible = false; provider.stopAutomaticWork();
        await pending;
        assert.equal(provider.roots.length, 0);
        const index = await provider._documentIndexAsync(document);
        assert.ok(index);
        assert.strictEqual(provider.getDocumentBlockIndexIfReady(document), index);
    });
    it('does not publish a previous document after a fast editor switch or same-URI reopen', async () => {
        const old = mutableDocument(path.resolve('reopen.k'), ['*PART', ...Array(2000).fill('1')]);
        const fresh = mutableDocument(path.resolve('reopen.k'), ['*NODE', '2']);
        const provider = new LsdynaKeywordIndexProvider({ asyncDocumentIndexThreshold: 1, documentIndexYieldInterval: 1 });
        provider.attachTreeView({ visible: true }); vscodeMock.window.activeTextEditor = { document: old };
        const pending = provider.refreshAutomatically(old);
        old.isClosed = true; provider.disposeDocument(old); provider.stopAutomaticWork();
        vscodeMock.window.activeTextEditor = { document: fresh };
        await Promise.all([pending, provider.refreshAutomatically(fresh)]);
        assert.equal(provider.findOccurrence(fresh.uri.fsPath, 0).keyword, 'NODE');
    });
    it('updates a project overlay after hidden edits and save without rescanning the project', async () => {
        const filePath = path.resolve('saved-include.k');
        const document = mutableDocument(filePath, ['*PART', '1']);
        const provider = new LsdynaKeywordIndexProvider({ loadProjectSnapshot() { throw Error('unexpected project scan'); } });
        const view = { visible: false }; provider.attachTreeView(view);
        provider._setMode('recursive');
        provider._buildRootsFromSnapshot({ files: [filePath], fileIndexes: new Map([[filePath, {
            keywordBlocks: [{ keyword: '*PART', startLine: 0, endLine: 1 }],
        }]]) }, path.dirname(filePath));
        document.replace(['*NODE', '1,0,0,0']);
        provider.updateDocumentAutomatically(document, { contentChanges: [] }); document.isDirty = false;
        assert.equal(document.lineReadCount, 0);
        vscodeMock.window.activeTextEditor = { document }; view.visible = true;
        await provider.refreshAutomatically(document);
        assert.equal(provider.mode, 'recursive');
        assert.equal(provider.findOccurrence(filePath, 0).keyword, 'NODE');
    });

});


describe('project selection during keyword session opening', () => {
    it('ignores a late old-project refresh and unrelated local work while opening the selected project', async () => {
        const progress = vscodeMock.window.withProgress, location = vscodeMock.ProgressLocation;
        let finish;
        const opening = new Promise(resolve => { finish = resolve; });
        const provider = new LsdynaKeywordIndexProvider({ projectSession: async request => {
            if (request.action === 'open') { await opening; return { lease: 'new', generation: 1 }; }
            return { state: 'complete', sequence: 1 };
        } });
        vscodeMock.ProgressLocation = { Notification: 1 };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} }, { isCancellationRequested: false });
        try {
            provider.attachTreeView({ visible: true });
            provider.refreshFromUriOrDocument = () => { throw Error('must not start unrelated local scan'); };
            const pending = provider.scan({ rootFile: path.resolve('new-main.k') });
            await provider.refreshAutomatically(modelDocument(path.resolve('other.k')));
            provider._mode = 'recursive'; provider.projectRoot = path.resolve('old-main.k');
            provider.projectPages = { dispose() {} };
            const generation = provider.scanGeneration;
            await provider.updateProjectStructure({ rootFile: provider.projectRoot });
            assert.equal(provider.scanGeneration, generation);
            finish();
            assert.equal(await pending, true);
            assert.equal(provider.projectRoot, path.resolve('new-main.k'));
        } finally {
            finish(); provider.dispose();
            vscodeMock.window.withProgress = progress; vscodeMock.ProgressLocation = location;
        }
    });
});
