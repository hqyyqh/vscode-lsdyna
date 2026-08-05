'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeDoc, vscodeMock } = require('./helpers');
const i18n = require('../src/core/i18n');
const extensionModule = require('../src/extension');
const { LsdynaIncludeTreeProvider } = require('../src/client/providers/includeTreeProvider');
const { LsdynaKeywordIndexProvider } = require('../src/client/providers/keywordIndexProvider');
const { buildProjectIndex } = require('../src/core/project/projectIndexer');
const {
    collectIncludeDecorationSets,
    createIncludeDecorationTypes,
    createLatestDocumentRequestGuard,
    collectKeywordDecorationRanges,
    collectIncludeDocumentLinks,
    collectLineLengthDiagnostics,
    createActiveDocumentDebouncer,
    findParameterDefinitions,
    findParameterReferences,
    LsdynaDefinitionProvider,
    LsdynaReferenceProvider,
    LsdynaRenameProvider,
    findIncludeFileLines,
    getFilenameFromDocument,
    getSearchPath,
    getParameterAtCursor,
    isIncludeLine,
    isLsdynaUri,
    LsdynaFieldHoverProvider,
    setSessionFieldHoverMutedForTesting,
    resetFieldHoverQuietStateForTesting,
    LsdynaParameterCodeLensProvider,
    LsdynaKeywordOptionsCodeLensProvider,
    LsdynaKeywordSymbolProvider,
    LsDynaFoldingProvider,
    findNextKeywordInDocument,
    findPreviousKeywordInDocument,
    startLineOfCurrentKeyword,
    endLineOfCurrentKeyword,
    getFilenameFromKeyword,
    searchFileFromPaths,
    findNextKeyword,
    findPreviousKeyword,
    collectIncludeFiles,
    shouldSkipAutomaticDocumentScan,
    createManifestDrivenInvalidator,
    createBatchedManifestInvalidator,
    createProjectSnapshotRefreshQueue,
    createProjectIndexLoader,
    createProjectSnapshotPersistentCache,
    chooseKeywordOptionsForEditor,
    updateDocumentDiagnostics,
    collectIncludePathCaseDiagnostics,
    setResolveIncludeWithCaseCheckForTesting,
    LsdynaIncludePathCaseCodeActionProvider,
    LsdynaUnknownKeywordCodeActionProvider,
    cacheReferenceIndexFromSnapshot,
    clearReferenceIndexCacheForTesting,
    clearReferenceIndexForRoot,
    getMainDeckContextForDocumentPath,
    setMainDeckContextForDocument,
    clearMainDeckContextForDocument,
    handleSelectMainDeckContextCommand,
    cacheEffectiveSearchPathsFromSnapshot,
    clearEffectiveSearchPathCacheForTesting,
    setFileIndexForTesting,
    buildStatusDashboardDiagnosticItems,
    getManualChapterPresentation,
    buildManualChapterPickItems,
    appendManualLinks,
    pickManualLocation,
    startLanguageClient,
} = extensionModule._internals;

function createRuntimeManualPack({
    documents = [{
        slug: 'keyword-vol-ii-material-models',
        title: 'LS-DYNA dev Keyword Manual Vol II - Material Models',
        order: 2,
        pdfFile: 'pdf/keyword-vol-ii.pdf',
    }],
    sections = [],
    keywords = {},
    createPdfs = true,
} = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-runtime-pack-'));
    const indexes = path.join(root, 'indexes');
    fs.mkdirSync(indexes);
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-07-28T00:00:00Z',
        flavor: 'bilingual',
        languages: ['en', 'zh-CN'],
        documents,
    }));
    fs.writeFileSync(path.join(indexes, 'keywords.json'), JSON.stringify({
        schemaVersion: 1,
        keywords,
    }));
    fs.writeFileSync(path.join(indexes, 'sections.json'), JSON.stringify({
        schemaVersion: 1,
        sections,
    }));
    fs.writeFileSync(path.join(indexes, 'anchors.json'), JSON.stringify({
        schemaVersion: 1,
        anchors: {},
    }));
    if (createPdfs) {
        for (const document of documents) {
            if (!document.pdfFile) continue;
            const pdfPath = path.join(root, document.pdfFile);
            fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
            fs.writeFileSync(pdfPath, '');
        }
    }
    return root;
}

describe('language client lifecycle', () => {
    it('waits for asynchronous startup before returning the client', async () => {
        let releaseStart;
        let startCalls = 0;
        const startGate = new Promise(resolve => {
            releaseStart = resolve;
        });
        const client = {
            async start() {
                startCalls += 1;
                await startGate;
            },
            async dispose() {},
        };
        const context = { subscriptions: [] };
        let settled = false;

        const started = startLanguageClient(client, context).then(result => {
            settled = true;
            return result;
        });
        await Promise.resolve();

        assert.equal(startCalls, 1);
        assert.equal(settled, false);
        assert.equal(context.subscriptions.length, 1);

        releaseStart();
        assert.strictEqual(await started, client);
        assert.equal(settled, true);
    });

    it('disposes once after startup failure and across repeated shutdown requests', async () => {
        let disposeCalls = 0;
        const startupError = new Error('language server failed to start');
        const client = {
            async start() {
                throw startupError;
            },
            async dispose() {
                disposeCalls += 1;
            },
        };
        const context = { subscriptions: [] };

        await assert.rejects(
            startLanguageClient(client, context),
            error => error === startupError
        );
        context.subscriptions[0].dispose();
        context.subscriptions[0].dispose();
        await Promise.resolve();

        assert.equal(disposeCalls, 1);
    });
});

describe('updateDocumentDiagnostics', () => {
    it('deletes stale diagnostics when a document is no longer LS-DYNA', async () => {
        const deleted = [];
        const document = fakeDoc('plain text', '/project/readme.txt');
        document.languageId = 'plaintext';
        await updateDocumentDiagnostics(document, {
            set() {},
            delete(uri) { deleted.push(uri.fsPath); },
        });

        assert.deepStrictEqual(deleted, ['/project/readme.txt']);
    });

    it('emits include-path-case-mismatch warning under crossPlatform mode', async () => {
        const document = fakeDoc('*INCLUDE\nsub/part.k\n', '/project/main.k');
        document.languageId = 'lsdyna';
        setResolveIncludeWithCaseCheckForTesting(async () => ({
            status: 'case-mismatch',
            resolvedPath: path.resolve('/project/Sub/Part.k'),
            realPath: path.resolve('/project/Sub/Part.k'),
            diffs: [{ index: 0, deck: 'sub', disk: 'Sub' }],
            deckRelative: 'sub/part.k',
            diskRelative: 'Sub/Part.k',
        }));

        try {
            const collected = [];
            await updateDocumentDiagnostics(document, {
                set(_uri, diags) { collected.push(...diags); },
                delete() {},
            }, { mode: 'crossPlatform' });

            const caseDiags = collected.filter(d => d.code === 'include-path-case-mismatch');
            assert.equal(caseDiags.length, 1);
            assert.equal(caseDiags[0].severity, vscodeMock.DiagnosticSeverity.Warning);
            assert.equal(caseDiags[0].source, 'lsdyna');
            assert.match(caseDiags[0].message, /Sub\/Part\.k|sub\/part\.k/);
        } finally {
            setResolveIncludeWithCaseCheckForTesting(null);
        }
    });

    it('uses Error severity for include path case mismatch in strict mode', async () => {
        const document = fakeDoc('*INCLUDE\nsub/part.k\n', '/project/main.k');
        document.languageId = 'lsdyna';
        setResolveIncludeWithCaseCheckForTesting(async () => ({
            status: 'case-mismatch',
            resolvedPath: '/project/Sub/Part.k',
            realPath: '/project/Sub/Part.k',
            diffs: [],
            deckRelative: 'sub/part.k',
            diskRelative: 'Sub/Part.k',
        }));

        try {
            const diags = await collectIncludePathCaseDiagnostics(document, { mode: 'strict' });
            assert.equal(diags.length, 1);
            assert.equal(diags[0].severity, vscodeMock.DiagnosticSeverity.Error);
        } finally {
            setResolveIncludeWithCaseCheckForTesting(null);
        }
    });

    it('skips include path case diagnostics when mode is off', async () => {
        const document = fakeDoc('*INCLUDE\nsub/part.k\n', '/project/main.k');
        document.languageId = 'lsdyna';
        let called = false;
        setResolveIncludeWithCaseCheckForTesting(async () => {
            called = true;
            return { status: 'case-mismatch', resolvedPath: 'x', realPath: 'x', diffs: [], deckRelative: 'a', diskRelative: 'A' };
        });

        try {
            const diags = await collectIncludePathCaseDiagnostics(document, { mode: 'off' });
            assert.deepStrictEqual(diags, []);
            assert.equal(called, false);
        } finally {
            setResolveIncludeWithCaseCheckForTesting(null);
        }
    });

    it('offers a quick fix to rewrite include path casing to match disk', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-case-action-'));
        const realFile = path.join(root, 'Sub', 'Part.k');
        fs.mkdirSync(path.dirname(realFile), { recursive: true });
        fs.writeFileSync(realFile, '*KEYWORD\n*END\n');
        const document = fakeDoc('*INCLUDE\nsub/part.k\n', path.join(root, 'main.k'));
        document.languageId = 'lsdyna';
        setResolveIncludeWithCaseCheckForTesting(async () => ({
            status: 'case-mismatch',
            resolvedPath: realFile,
            realPath: realFile,
            diffs: [],
            deckRelative: 'sub/part.k',
            diskRelative: 'Sub/Part.k',
        }));

        try {
            const diags = await collectIncludePathCaseDiagnostics(document, { mode: 'crossPlatform' });
            assert.equal(diags.length, 1);
            const provider = new LsdynaIncludePathCaseCodeActionProvider();
            const actions = provider.provideCodeActions(document, diags[0].range, { diagnostics: diags });
            assert.equal(actions.length, 1);
            assert.equal(actions[0].edit, undefined);
            provider.resolveCodeAction(actions[0]);
            assert.equal(actions[0].edit.edits.length, 1);
            assert.equal(actions[0].edit.edits[0].text, 'Sub/Part.k');
        } finally {
            setResolveIncludeWithCaseCheckForTesting(null);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('preserves continued include layout while fixing path casing', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-continued-case-action-'));
        const realFile = path.join(root, 'Sub', 'Part.k');
        fs.mkdirSync(path.dirname(realFile), { recursive: true });
        fs.writeFileSync(realFile, '*KEYWORD\n*END\n');
        const document = fakeDoc(
            '*INCLUDE\nsub/ +\npart.k\n',
            path.join(root, 'main.k'),
        );
        document.languageId = 'lsdyna';
        setResolveIncludeWithCaseCheckForTesting(async () => ({
            status: 'case-mismatch',
            resolvedPath: realFile,
            realPath: realFile,
            diffs: [
                { index: 0, deck: 'sub', disk: 'Sub' },
                { index: 1, deck: 'part.k', disk: 'Part.k' },
            ],
            deckRelative: 'sub/part.k',
            diskRelative: 'Sub/Part.k',
        }));

        try {
            const diags = await collectIncludePathCaseDiagnostics(document, { mode: 'strict' });
            assert.equal(diags.length, 1);
            const provider = new LsdynaIncludePathCaseCodeActionProvider();
            const actions = provider.provideCodeActions(
                document,
                diags[0].range,
                { diagnostics: diags },
            );
            assert.equal(actions.length, 1);
            provider.resolveCodeAction(actions[0]);
            assert.equal(actions[0].edit.edits.length, 2);
            assert.deepStrictEqual(
                actions[0].edit.edits.map(edit => edit.text),
                ['Sub/ +', 'Part.k'],
            );
        } finally {
            setResolveIncludeWithCaseCheckForTesting(null);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not offer a stale include casing fix after the target is removed', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-stale-include-action-'));
        const realFile = path.join(root, 'Sub', 'Part.k');
        fs.mkdirSync(path.dirname(realFile), { recursive: true });
        fs.writeFileSync(realFile, '*KEYWORD\n*END\n');
        const document = fakeDoc('*INCLUDE\nsub/part.k\n', path.join(root, 'main.k'));
        document.languageId = 'lsdyna';
        setResolveIncludeWithCaseCheckForTesting(async () => ({
            status: 'case-mismatch',
            resolvedPath: realFile,
            realPath: realFile,
            diffs: [],
            deckRelative: 'sub/part.k',
            diskRelative: 'Sub/Part.k',
        }));

        try {
            const diags = await collectIncludePathCaseDiagnostics(document, { mode: 'strict' });
            fs.rmSync(realFile);
            const provider = new LsdynaIncludePathCaseCodeActionProvider();
            const actions = provider.provideCodeActions(document, diags[0].range, { diagnostics: diags });
            assert.deepStrictEqual(actions, []);
        } finally {
            setResolveIncludeWithCaseCheckForTesting(null);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not resolve an include casing edit after the target is removed while the action is open', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-open-include-action-'));
        const realFile = path.join(root, 'Sub', 'Part.k');
        fs.mkdirSync(path.dirname(realFile), { recursive: true });
        fs.writeFileSync(realFile, '*KEYWORD\n*END\n');
        const document = fakeDoc('*INCLUDE\nsub/part.k\n', path.join(root, 'main.k'));
        document.languageId = 'lsdyna';
        setResolveIncludeWithCaseCheckForTesting(async () => ({
            status: 'case-mismatch',
            resolvedPath: realFile,
            realPath: realFile,
            diffs: [],
            deckRelative: 'sub/part.k',
            diskRelative: 'Sub/Part.k',
        }));

        try {
            const diags = await collectIncludePathCaseDiagnostics(document, { mode: 'strict' });
            const provider = new LsdynaIncludePathCaseCodeActionProvider();
            const actions = provider.provideCodeActions(document, diags[0].range, { diagnostics: diags });
            assert.equal(actions.length, 1);
            fs.rmSync(realFile);
            provider.resolveCodeAction(actions[0]);
            assert.equal(actions[0].edit, undefined);
        } finally {
            setResolveIncludeWithCaseCheckForTesting(null);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not offer a stale include casing fix over newly edited path text', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-edited-include-action-'));
        const realFile = path.join(root, 'Sub', 'Part.k');
        fs.mkdirSync(path.dirname(realFile), { recursive: true });
        fs.writeFileSync(realFile, '*KEYWORD\n*END\n');
        const originalDocument = fakeDoc('*INCLUDE\nsub/part.k\n', path.join(root, 'main.k'));
        originalDocument.languageId = 'lsdyna';
        setResolveIncludeWithCaseCheckForTesting(async () => ({
            status: 'case-mismatch',
            resolvedPath: realFile,
            realPath: realFile,
            diffs: [],
            deckRelative: 'sub/part.k',
            diskRelative: 'Sub/Part.k',
        }));

        try {
            const diags = await collectIncludePathCaseDiagnostics(originalDocument, { mode: 'strict' });
            const editedDocument = fakeDoc('*INCLUDE\nother/part.k\n', path.join(root, 'main.k'));
            editedDocument.languageId = 'lsdyna';
            const provider = new LsdynaIncludePathCaseCodeActionProvider();
            const actions = provider.provideCodeActions(editedDocument, diags[0].range, { diagnostics: diags });
            assert.deepStrictEqual(actions, []);
        } finally {
            setResolveIncludeWithCaseCheckForTesting(null);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('offers quick fixes to add unknown keywords to the custom valid list', () => {
        const document = fakeDoc('*FOO_BAR\n', '/project/main.k');
        document.languageId = 'lsdyna';
        const diagnostic = new vscodeMock.Diagnostic(
            new vscodeMock.Range(0, 0, 0, 8),
            'Unknown keyword: *FOO_BAR',
            vscodeMock.DiagnosticSeverity.Error
        );
        diagnostic.code = 'unknown-keyword';
        diagnostic.unknownKeyword = 'FOO_BAR';
        const provider = new LsdynaUnknownKeywordCodeActionProvider();
        const actions = provider.provideCodeActions(document, diagnostic.range, {
            diagnostics: [diagnostic],
        });
        assert.ok(actions.length >= 2);
        const preferred = actions.find(action => action.isPreferred);
        assert.ok(preferred);
        assert.equal(preferred.command.command, 'extension.addCustomValidKeyword');
        assert.equal(preferred.command.arguments[0].keyword, '*FOO_BAR');
        assert.equal(preferred.command.arguments[0].mode, 'exact');
        const workspaceAction = actions.find(action =>
            action.command
            && action.command.arguments
            && action.command.arguments[0]
            && action.command.arguments[0].target === 'workspace'
        );
        assert.ok(workspaceAction);
        const prefixAction = actions.find(action =>
            action.command
            && action.command.arguments
            && action.command.arguments[0]
            && action.command.arguments[0].mode === 'prefix'
        );
        assert.ok(prefixAction);
        const batch = actions.find(action =>
            action.command && action.command.command === 'extension.addAllUnknownKeywordsInFile'
        );
        assert.ok(batch);
        assert.equal(batch.command.arguments[0].target, 'global');
    });
});

describe('status dashboard diagnostic details', () => {
    it('builds actions and jump targets for visible diagnostics', () => {
        const document = fakeDoc('*KEYWORD\n' + 'x'.repeat(81) + '\n', '/project/main.k');
        document.languageId = 'lsdyna';
        const editor = { document };
        const diagnostics = [
            {
                severity: vscodeMock.DiagnosticSeverity.Warning,
                message: 'Line exceeds 80 characters',
                range: new vscodeMock.Range(1, 80, 1, 81),
            },
        ];

        const items = buildStatusDashboardDiagnosticItems(editor, diagnostics, {
            keyword: '*KEYWORD',
        });

        assert.deepStrictEqual(items.map(item => item.id), [
            'openProblems',
            'copyDiagnostics',
            'diagnostic',
        ]);
        assert.match(items[0].label, /问题|Problems/);
        assert.match(items[1].label, /复制|Copy/);
        assert.match(items[2].label, /第 2 行|Line 2/);
        assert.strictEqual(items[2].diagnostic, diagnostics[0]);
    });
});

describe('indented keyword editor features', () => {
    it('provides symbols and folds for indented mixed-case keywords', () => {
        const document = fakeDoc(' \t*node\n1,2,3\n  *Part\ntitle\n');
        document.languageId = 'lsdyna';

        const symbols = new LsdynaKeywordSymbolProvider().provideDocumentSymbols(document);
        const folds = new LsDynaFoldingProvider().provideFoldingRanges(document);

        assert.equal(symbols.length, 2);
        assert.deepStrictEqual(folds.map(range => [range.start, range.end]), [[0, 1], [2, 4]]);
    });
});

const FIXTURE_DIR = path.join(__dirname, 'Bolt_A_Explicit');

function decodeCommandUriArgs(uri) {
    const text = uri.toString ? uri.toString() : uri.fsPath;
    const query = text.slice(text.indexOf('?') + 1);
    return JSON.parse(decodeURIComponent(query));
}

function makeEditableEditor(lines, activeLine = 0) {
    const editableLines = lines.slice();
    const document = {
        get lineCount() {
            return editableLines.length;
        },
        uri: { fsPath: '/project/main.k' },
        languageId: 'lsdyna',
        lineAt(index) {
            const text = editableLines[index] || '';
            return { text, range: new vscodeMock.Range(index, 0, index, text.length) };
        },
        getText(range) {
            if (!range) return editableLines.join('\n');
            if (range.start.line === range.end.line) {
                return editableLines[range.start.line].slice(range.start.character, range.end.character);
            }
            return editableLines.slice(range.start.line, range.end.line + 1)
                .map((line, index, all) => {
                    if (index === 0) return line.slice(range.start.character);
                    if (index === all.length - 1) return line.slice(0, range.end.character);
                    return line;
                })
                .join('\n');
        },
    };

    function applyReplace(range, text) {
        const before = editableLines.slice(0, range.start.line);
        const after = editableLines.slice(range.end.line);
        if (range.end.line < editableLines.length) {
            after[0] = editableLines[range.end.line].slice(range.end.character);
        }
        const firstPrefix = editableLines[range.start.line].slice(0, range.start.character);
        const lastSuffix = range.end.line < editableLines.length
            ? editableLines[range.end.line].slice(range.end.character)
            : '';
        const replacement = (firstPrefix + text + lastSuffix).split('\n');
        editableLines.splice(0, editableLines.length, ...before, ...replacement, ...after.slice(1));
    }

    let selection = new vscodeMock.Selection(
        new vscodeMock.Position(activeLine, 0),
        new vscodeMock.Position(activeLine, 0)
    );

    return {
        document,
        lines: editableLines,
        get selection() { return selection; },
        set selection(value) { selection = value; },
        async edit(callback) {
            const edits = [];
            callback({
                replace(range, text) {
                    edits.push({ range, text });
                },
                insert(position, text) {
                    edits.push({ range: new vscodeMock.Range(position, position), text });
                },
            });
            edits.sort((a, b) => {
                if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
                return b.range.start.character - a.range.start.character;
            });
            for (const edit of edits) {
                applyReplace(edit.range, edit.text);
            }
            return true;
        },
    };
}

// ---------------------------------------------------------------------------
// findParameterDefinitions
// ---------------------------------------------------------------------------

describe('findParameterDefinitions', () => {
    it('handles indented mixed-case parameter keywords', () => {
        const doc = fakeDoc('  *parameter\nR  tEnd  5.0\n\t*parameter_expression\nR  dtPlot  tEnd/100.0\n');
        const defs = findParameterDefinitions(doc);

        assert.ok(defs.has('TEND'));
        assert.ok(defs.has('DTPLOT'));
        assert.equal(findParameterReferences(doc).filter(ref => ref.name === 'TEND').length, 1);
    });

    it('finds basic *PARAMETER definitions', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\nI  count  10\n');
        const defs = findParameterDefinitions(doc);
        assert.equal(defs.size, 2);
        assert.ok(defs.has('TEND'));
        assert.equal(defs.get('TEND')[0].value, '5.0');
        assert.equal(defs.get('COUNT')[0].value, '10');
    });

    it('finds *PARAMETER_EXPRESSION definitions', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*PARAMETER_EXPRESSION\nR  dtPlot  tEnd/100.0\n');
        const defs = findParameterDefinitions(doc);
        assert.ok(defs.has('DTPLOT'));
        assert.equal(defs.get('DTPLOT')[0].value, 'tEnd/100.0');
    });

    it('is case-insensitive on key lookup', () => {
        const doc = fakeDoc('*PARAMETER\nR  MyParam  42.0\n');
        const defs = findParameterDefinitions(doc);
        assert.ok(defs.has('MYPARAM'));
        assert.equal(defs.get('MYPARAM')[0].name, 'MyParam');
    });

    it('skips comment lines inside *PARAMETER block', () => {
        const doc = fakeDoc('*PARAMETER\n$ a comment\nR  tEnd  5.0\n');
        const defs = findParameterDefinitions(doc);
        assert.equal(defs.size, 1);
    });

    it('stops collecting at next keyword', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*CONTROL_TERMINATION\nR  notAParam  0\n');
        const defs = findParameterDefinitions(doc);
        assert.equal(defs.size, 1);
    });

    it('records correct line and column for definition', () => {
        const doc = fakeDoc('*PARAMETER\nR   tEnd   5.0\n');
        const defs = findParameterDefinitions(doc);
        const def = defs.get('TEND')[0];
        assert.equal(def.lineIndex, 1);
        assert.equal(doc.lineAt(def.lineIndex).text.slice(def.startChar, def.startChar + def.length), 'tEnd');
    });

    it('parses the real fixture file', () => {
        const fs = require('fs');
        const text = fs.readFileSync(path.join(FIXTURE_DIR, 'mainboltaexpl.k'), 'utf8');
        const doc = fakeDoc(text, path.join(FIXTURE_DIR, 'mainboltaexpl.k'));
        const defs = findParameterDefinitions(doc);
        assert.ok(defs.has('TEND'));
        assert.ok(defs.has('DTPLOT'));
        assert.ok(defs.has('BLTFORCE'));
    });
});

// ---------------------------------------------------------------------------
// findParameterReferences
// ---------------------------------------------------------------------------

describe('findParameterReferences', () => {
    it('finds &name references', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*CONTROL_TERMINATION\n     &tEnd\n');
        const refs = findParameterReferences(doc);
        const r = refs.filter(r => r.name === 'TEND');
        assert.equal(r.length, 1);
        assert.equal(r[0].lineIndex, 3);
    });

    it('finds multiple references to same parameter', () => {
        const doc = fakeDoc('*PARAMETER\nR  t  5.0\n*KEYWORD\n&t  &t\n');
        const refs = findParameterReferences(doc).filter(r => r.name === 'T');
        assert.equal(refs.length, 2);
    });

    it('finds bare name references in *PARAMETER_EXPRESSION values', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*PARAMETER_EXPRESSION\nR  dtPlot  tEnd/100.0\n');
        const refs = findParameterReferences(doc).filter(r => r.name === 'TEND');
        assert.equal(refs.length, 1);
        assert.equal(refs[0].lineIndex, 3);
    });

    it('does not treat expression definition name as a reference', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*PARAMETER_EXPRESSION\nR  dtPlot  tEnd/100.0\n');
        const refs = findParameterReferences(doc).filter(r => r.name === 'DTPLOT');
        assert.equal(refs.length, 0);
    });

    it('skips comment lines', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n$ &tEnd this is a comment\n');
        const refs = findParameterReferences(doc).filter(r => r.name === 'TEND');
        assert.equal(refs.length, 0);
    });
});

describe('parameter navigation and rename providers', () => {
    function applyWorkspaceEdits(document, workspaceEdit) {
        const lines = document.getText().split('\n');
        const edits = workspaceEdit.edits.slice().sort((a, b) => {
            if (a.range.start.line !== b.range.start.line) {
                return b.range.start.line - a.range.start.line;
            }
            return b.range.start.character - a.range.start.character;
        });
        for (const edit of edits) {
            assert.equal(edit.range.start.line, edit.range.end.line);
            const lineIndex = edit.range.start.line;
            const line = lines[lineIndex];
            lines[lineIndex] =
                line.slice(0, edit.range.start.character) +
                edit.text +
                line.slice(edit.range.end.character);
        }
        return lines.join('\n');
    }

    it('renames definitions, ampersand references, and bare expression references exactly', () => {
        const doc = fakeDoc(
            '*PARAMETER\n' +
            'R  tEnd  5.0\n' +
            '*PARAMETER_EXPRESSION\n' +
            'R  dtPlot  tEnd/100.0\n' +
            '*CONTROL_TERMINATION\n' +
            '     &tEnd\n'
        );
        const provider = new LsdynaRenameProvider();
        const edit = provider.provideRenameEdits(
            doc,
            new vscodeMock.Position(1, 4),
            'finish'
        );

        assert.equal(edit.edits.length, 3);
        for (const replacement of edit.edits) {
            assert.equal(doc.getText(replacement.range), 'tEnd');
            assert.equal(replacement.text, 'finish');
        }
        assert.equal(
            applyWorkspaceEdits(doc, edit),
            '*PARAMETER\n' +
            'R  finish  5.0\n' +
            '*PARAMETER_EXPRESSION\n' +
            'R  dtPlot  finish/100.0\n' +
            '*CONTROL_TERMINATION\n' +
            '     &finish\n'
        );
    });

    it('rejects parameter names forbidden by the official LS-DYNA syntax', () => {
        const doc = fakeDoc('*PARAMETER\nR endtime 1.0\n*END\n');
        const provider = new LsdynaRenameProvider();

        for (const invalidName of [
            '',
            '2finish',
            'bad-name',
            'bad name',
            'tenletters',
            'time',
            'TIME',
            'pi',
            'CURVE',
            'Int',
            'abort',
            'rename',
            'xdr_int',
            'Vector1',
            'Matrix1x1',
        ]) {
            assert.throws(
                () => provider.provideRenameEdits(
                    doc,
                    new vscodeMock.Position(1, 3),
                    invalidName,
                ),
                /parameter name/i,
                invalidName,
            );
        }
    });

    it('can start the same rename from a bare expression reference', () => {
        const doc = fakeDoc(
            '*PARAMETER\n' +
            'R  tEnd  5.0\n' +
            '*PARAMETER_EXPRESSION\n' +
            'R  dtPlot  tEnd/100.0\n'
        );
        const provider = new LsdynaRenameProvider();
        const edit = provider.provideRenameEdits(
            doc,
            new vscodeMock.Position(3, 12),
            'finish'
        );

        assert.ok(edit);
        assert.equal(edit.edits.length, 2);
        assert.equal(applyWorkspaceEdits(doc, edit).includes('finish/100.0'), true);
        assert.equal(applyWorkspaceEdits(doc, edit).includes('tfinish'), false);
    });

    it('navigates to every definition on a multi-parameter line', () => {
        const dataLine = 'R p1 1.0 I p2 2 R p3 3.0 C p4 text';
        const doc = fakeDoc(
            '*PARAMETER\n' +
            dataLine + '\n' +
            '*KEYWORD\n' +
            '&p1 &p2 &p3 &p4\n'
        );
        const definitionProvider = new LsdynaDefinitionProvider();
        const codeLensProvider = new LsdynaParameterCodeLensProvider();
        const renameProvider = new LsdynaRenameProvider();

        for (const name of ['p1', 'p2', 'p3', 'p4']) {
            const referenceColumn = doc.lineAt(3).text.indexOf(`&${name}`) + 1;
            const location = definitionProvider.provideDefinition(
                doc,
                new vscodeMock.Position(3, referenceColumn)
            );
            const expectedColumn = dataLine.indexOf(name);

            assert.ok(location);
            assert.equal(location.range.start.line, 1);
            assert.equal(location.range.start.character, expectedColumn);
            assert.equal(
                getParameterAtCursor(
                    doc,
                    new vscodeMock.Position(1, expectedColumn)
                ).name,
                name
            );
        }
        assert.equal(codeLensProvider.provideCodeLenses(doc).length, 4);

        const p3Column = dataLine.indexOf('p3');
        const renameEdit = renameProvider.provideRenameEdits(
            doc,
            new vscodeMock.Position(1, p3Column),
            'third'
        );
        assert.equal(renameEdit.edits.length, 2);
        assert.equal(
            applyWorkspaceEdits(doc, renameEdit).includes('R third 3.0'),
            true
        );
        assert.equal(
            applyWorkspaceEdits(doc, renameEdit).includes('&p2 &third &p4'),
            true
        );
    });

    it('supports prepare rename, references, and definition lookup for compact syntax', () => {
        const doc = fakeDoc(
            '*PARAMETER\n' +
            'Rrho     7850.\n' +
            '*KEYWORD\n' +
            '&rho\n'
        );
        const renameProvider = new LsdynaRenameProvider();
        const definitionProvider = new LsdynaDefinitionProvider();
        const referenceProvider = new LsdynaReferenceProvider();
        const definitionPosition = new vscodeMock.Position(1, 2);

        const renameRange = renameProvider.prepareRename(doc, definitionPosition);
        assert.equal(doc.getText(renameRange), 'rho');

        const definition = definitionProvider.provideDefinition(
            doc,
            new vscodeMock.Position(3, 2)
        );
        assert.equal(definition.range.start.line, 1);
        assert.equal(definition.range.start.character, 1);

        const references = referenceProvider.provideReferences(
            doc,
            definitionPosition,
            { includeDeclaration: true }
        );
        assert.equal(references.length, 2);
        assert.equal(references[0].range.start.line, 1);
        assert.equal(references[1].range.start.line, 3);
    });

    it('preserves duplicate declarations across definition, references, and rename', () => {
        const doc = fakeDoc([
            '*PARAMETER_MUTABLE',
            'IPARAM,1',
            '*PARAMETER',
            'IPARAM,2',
            '*PARAMETER_EXPRESSION',
            'IRESULT,PARAM+1',
            '*CONTROL_TERMINATION',
            '&PARAM',
        ].join('\n'));
        const definitionProvider = new LsdynaDefinitionProvider();
        const referenceProvider = new LsdynaReferenceProvider();
        const renameProvider = new LsdynaRenameProvider();

        const definitions = definitionProvider.provideDefinition(
            doc,
            new vscodeMock.Position(7, 2),
        );
        assert.ok(Array.isArray(definitions));
        assert.deepEqual(definitions.map(location => location.range.start.line), [1, 3]);

        const references = referenceProvider.provideReferences(
            doc,
            new vscodeMock.Position(1, 2),
            { includeDeclaration: true },
        );
        assert.deepEqual(references.map(location => location.range.start.line), [1, 3, 5, 7]);

        const rename = renameProvider.provideRenameEdits(
            doc,
            new vscodeMock.Position(5, 10),
            'UPDATED',
        );
        assert.equal(rename.edits.length, 4);
        assert.equal(applyWorkspaceEdits(doc, rename).match(/UPDATED/g).length, 4);
    });
});

describe('LsdynaParameterCodeLensProvider', () => {
    it('localizes parameter reference counts in Chinese', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'language' ? 'zh-cn' : defaultValue
        });
        i18n.updateLanguage();

        try {
            const provider = new LsdynaParameterCodeLensProvider();
            const lenses = provider.provideCodeLenses(fakeDoc('*PARAMETER\nR  t  1.0\n*KEYWORD\n&t  &t\n'));

            assert.equal(lenses.length, 1);
            assert.equal(lenses[0].command.title, '2 处引用');
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });
});

// ---------------------------------------------------------------------------
// findIncludeFileLines
// ---------------------------------------------------------------------------

describe('findIncludeFileLines', () => {
    it('finds a basic *INCLUDE', () => {
        const doc = fakeDoc('*INCLUDE\ngeometry.k\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].fileName, 'geometry.k');
    });

    it('finds multiple filenames under a single *INCLUDE block', () => {
        const doc = fakeDoc('*INCLUDE\na.key\nb.key\nc.key\n');
        const lines = findIncludeFileLines(doc);
        assert.deepEqual(lines.map(line => line.fileName), ['a.key', 'b.key', 'c.key']);
    });

    it('skips *INCLUDE_PATH entries', () => {
        const doc = fakeDoc('*INCLUDE_PATH\n/some/dir\n*INCLUDE\ngeometry.k\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].fileName, 'geometry.k');
    });

    it('skips *INCLUDE_PATH_RELATIVE entries', () => {
        const doc = fakeDoc('*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\ngeometry.k\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines.length, 1);
    });

    it('handles multiple *INCLUDE blocks', () => {
        const doc = fakeDoc('*INCLUDE\na.k\n*INCLUDE\nb.k\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines.length, 2);
        assert.equal(lines[0].fileName, 'a.k');
        assert.equal(lines[1].fileName, 'b.k');
    });

    it('skips commented include filename lines', () => {
        const doc = fakeDoc('*INCLUDE\n$commented.k\nreal.k\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].fileName, 'real.k');
    });

    it('skips comment lines inside include continuations', () => {
        const doc = fakeDoc('*INCLUDE\npart_a +\n$ skip me\npart_b.key\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].fileName, 'part_apart_b.key');
        assert.equal(lines[0].endLineIndex, 3);
    });

    it('finds correct line index and startChar', () => {
        const doc = fakeDoc('*KEYWORD\n*INCLUDE\n  geometry.k\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines[0].lineIndex, 2);
        assert.equal(lines[0].startChar, 2);
    });

    it('parses includes from the real fixture file', () => {
        const fs = require('fs');
        const text = fs.readFileSync(path.join(FIXTURE_DIR, 'mainboltaexpl.k'), 'utf8');
        const doc = fakeDoc(text, path.join(FIXTURE_DIR, 'mainboltaexpl.k'));
        const lines = findIncludeFileLines(doc);
        const names = lines.map(l => l.fileName);
        assert.ok(names.includes('includes.k'));
        assert.ok(names.includes('material_props.k'));
        assert.ok(names.includes('missing_geometry.k'));
    });
});

// ---------------------------------------------------------------------------
// getSearchPath
// ---------------------------------------------------------------------------

describe('getSearchPath', () => {
    it('always includes the document directory as first path', () => {
        const doc = fakeDoc('*KEYWORD\n', '/project/main.k');
        const paths = getSearchPath(doc);
        assert.equal(paths[0], '/project');
    });

    it('appends *INCLUDE_PATH directories', () => {
        const doc = fakeDoc('*INCLUDE_PATH\n/shared/libs\n', '/project/main.k');
        const paths = getSearchPath(doc);
        assert.ok(paths.includes('/shared/libs'));
    });

    it('resolves *INCLUDE_PATH_RELATIVE against document directory', () => {
        const doc = fakeDoc('*INCLUDE_PATH_RELATIVE\nsubmodels\n', '/project/main.k');
        const paths = getSearchPath(doc);
        assert.ok(paths.some(p => p.endsWith('submodels')));
    });

    it('handles both path types together', () => {
        const doc = fakeDoc(
            '*INCLUDE_PATH\n/abs/path\n*INCLUDE_PATH_RELATIVE\nreldir\n',
            '/project/main.k'
        );
        const paths = getSearchPath(doc);
        assert.equal(paths.length, 3);
    });

    it('resolves *INCLUDE_PATH_RELATIVE correctly in real fixture', () => {
        const fs = require('fs');
        const fixturePath = path.join(FIXTURE_DIR, 'mainboltaexpl.k');
        const text = fs.readFileSync(fixturePath, 'utf8');
        const doc = fakeDoc(text, fixturePath);
        const paths = getSearchPath(doc);
        const submodels = path.join(FIXTURE_DIR, 'submodels');
        assert.ok(paths.includes(submodels), 'should include submodels/');
    });

    it('reuses one include parse for repeated lookups on the same document version', () => {
        const doc = fakeDoc('*INCLUDE_PATH\n/shared\n*INCLUDE\na.key\n', '/project/main.k');
        doc.version = 1;

        let lineAtCalls = 0;
        const originalLineAt = doc.lineAt;
        doc.lineAt = (index) => {
            lineAtCalls++;
            return originalLineAt(index);
        };

        getSearchPath(doc);
        findIncludeFileLines(doc);
        getSearchPath(doc);

        assert.equal(lineAtCalls, doc.lineCount);
    });

    it('invalidates cached include parse results when the document version changes', () => {
        const doc = fakeDoc('*INCLUDE\na.key\n', '/project/main.k');
        doc.version = 1;

        let lineAtCalls = 0;
        const originalLineAt = doc.lineAt;
        doc.lineAt = (index) => {
            lineAtCalls++;
            return originalLineAt(index);
        };

        getSearchPath(doc);
        doc.version = 2;
        findIncludeFileLines(doc);

        assert.equal(lineAtCalls, doc.lineCount * 2);
    });

    it('uses ancestor PATH from project snapshot when body has no local PATH', () => {
        clearEffectiveSearchPathCacheForTesting();
        const bodyPath = path.resolve('/job/body.k');
        const matsDir = path.resolve('/job/mats');
        const bodyDir = path.dirname(bodyPath);

        cacheEffectiveSearchPathsFromSnapshot({
            rootFile: path.resolve('/job/main.k'),
            effectiveSearchPathsByFile: new Map([
                [bodyPath, [bodyDir, matsDir]],
            ]),
        });

        try {
            const doc = fakeDoc('*INCLUDE\nsteel.k\n', bodyPath);
            const paths = getSearchPath(doc);
            assert.ok(
                paths.some(p => path.normalize(p) === path.normalize(matsDir)),
                `expected mats in search paths after snapshot cache, got ${JSON.stringify(paths)}`
            );
        } finally {
            clearEffectiveSearchPathCacheForTesting();
        }
    });

    it('uses the selected main deck for conflicting ancestor PATH context', () => {
        clearReferenceIndexCacheForTesting();
        clearEffectiveSearchPathCacheForTesting();
        const sharedFile = path.resolve('/shared/body.k');
        const rootA = path.resolve('/jobA/main.k');
        const rootB = path.resolve('/jobB/main.k');
        const matsA = path.resolve('/jobA/mats');
        const matsB = path.resolve('/jobB/mats');
        const emptyIndex = { parameterEvents: [], referenceDefinitions: { curves: [], tables: [] } };

        function cacheRoot(rootFile, matsDir) {
            const snapshot = {
                rootFile,
                files: [rootFile, sharedFile],
                graph: {
                    includeOccurrences: [{
                        occurrenceId: `${rootFile}:shared`,
                        fromFile: rootFile,
                        filePath: sharedFile,
                        fileName: path.basename(sharedFile),
                        keywordLine: 1,
                        lineIndex: 2,
                        keyword: '*INCLUDE',
                    }],
                },
                fileIndexes: new Map([
                    [rootFile, emptyIndex],
                    [sharedFile, emptyIndex],
                ]),
                effectiveSearchPathsByFile: new Map([[
                    sharedFile,
                    [path.dirname(sharedFile), matsDir],
                ]]),
            };
            cacheReferenceIndexFromSnapshot(snapshot);
            cacheEffectiveSearchPathsFromSnapshot(snapshot);
        }

        try {
            cacheRoot(rootA, matsA);
            cacheRoot(rootB, matsB);
            const doc = fakeDoc('*INCLUDE\nsteel.k\n', sharedFile);
            const ambiguousPaths = getSearchPath(doc);
            assert.ok(!ambiguousPaths.includes(matsA));
            assert.ok(!ambiguousPaths.includes(matsB));

            assert.equal(setMainDeckContextForDocument(sharedFile, rootA), true);
            const pathsA = getSearchPath(doc);
            assert.ok(pathsA.includes(matsA));
            assert.ok(!pathsA.includes(matsB));

            assert.equal(setMainDeckContextForDocument(sharedFile, rootB), true);
            const pathsB = getSearchPath(doc);
            assert.ok(pathsB.includes(matsB));
            assert.ok(!pathsB.includes(matsA));
        } finally {
            clearReferenceIndexCacheForTesting();
            clearEffectiveSearchPathCacheForTesting();
        }
    });

    it('falls back to file-local paths when no snapshot is cached', () => {
        clearEffectiveSearchPathCacheForTesting();
        const bodyPath = path.resolve('/job/body.k');
        const doc = fakeDoc('*INCLUDE\nsteel.k\n', bodyPath);
        const paths = getSearchPath(doc);
        assert.equal(paths.length, 1);
        assert.equal(path.normalize(paths[0]), path.normalize(path.dirname(bodyPath)));
    });
});

// ---------------------------------------------------------------------------
// searchFileFromPaths
// ---------------------------------------------------------------------------

describe('searchFileFromPaths', () => {
    it('resolves a file that exists', () => {
        const result = searchFileFromPaths('mainboltaexpl.k', [FIXTURE_DIR]);
        assert.equal(result, path.join(FIXTURE_DIR, 'mainboltaexpl.k'));
    });

    it('checks paths in order and returns first match', () => {
        const result = searchFileFromPaths('material_props.k', [
            FIXTURE_DIR,
            path.join(FIXTURE_DIR, 'submodels'),
        ]);
        assert.equal(result, path.join(FIXTURE_DIR, 'submodels', 'material_props.k'));
    });

    it('throws when file is not found in any path', () => {
        assert.throws(
            () => searchFileFromPaths('missing_geometry.k', [FIXTURE_DIR]),
            /not found/
        );
    });

    it('resolves material_props.k via INCLUDE_PATH_RELATIVE in real fixture', () => {
        const fs = require('fs');
        const fixturePath = path.join(FIXTURE_DIR, 'mainboltaexpl.k');
        const text = fs.readFileSync(fixturePath, 'utf8');
        const doc = fakeDoc(text, fixturePath);
        const paths = getSearchPath(doc);
        const result = searchFileFromPaths('material_props.k', paths);
        assert.ok(result.endsWith('material_props.k'));
    });

    it('resolves prescribed_motion.k via ../  from submodels/loading/', () => {
        const loadingDir = path.join(FIXTURE_DIR, 'submodels', 'loading');
        const result = searchFileFromPaths('../material_props.k', [loadingDir]);
        assert.ok(result.endsWith('material_props.k'));
    });
});

// ---------------------------------------------------------------------------
// Keyword navigation
// ---------------------------------------------------------------------------

describe('findNextKeyword', () => {
    it('finds indented mixed-case keyword lines', () => {
        assert.equal(findNextKeyword(['*A', 'data', ' \t*b'], 0), 2);
    });

    it('finds the next * line', () => {
        assert.equal(findNextKeyword(['*A', 'data', '*B', 'data'], 0), 2);
    });

    it('throws when no next keyword exists', () => {
        assert.throws(() => findNextKeyword(['*A', 'data'], 0));
    });

    it('skips over data lines', () => {
        assert.equal(findNextKeyword(['*A', 'x', 'y', 'z', '*B'], 0), 4);
    });
});

describe('findPreviousKeyword', () => {
    it('finds indented mixed-case keyword lines', () => {
        assert.equal(findPreviousKeyword([' \t*a', 'data', '*B'], 2), 0);
    });

    it('finds the previous * line', () => {
        assert.equal(findPreviousKeyword(['*A', 'data', '*B', 'data'], 3), 2);
    });

    it('throws when no previous keyword exists', () => {
        assert.throws(() => findPreviousKeyword(['data', 'data'], 1));
    });
});

describe('startLineOfCurrentKeyword', () => {
    it('finds an indented mixed-case enclosing keyword', () => {
        assert.equal(startLineOfCurrentKeyword([' \t*node', 'data'], 1), 0);
    });

    it('returns own line when on a keyword', () => {
        assert.equal(startLineOfCurrentKeyword(['*A', 'data'], 0), 0);
    });

    it('searches backwards to find enclosing keyword', () => {
        assert.equal(startLineOfCurrentKeyword(['*A', 'data', 'more'], 2), 0);
    });

    it('throws when not under any keyword', () => {
        assert.throws(() => startLineOfCurrentKeyword(['data', 'data'], 1));
    });
});

describe('endLineOfCurrentKeyword', () => {
    it('ends before an indented mixed-case keyword', () => {
        assert.equal(endLineOfCurrentKeyword(['*A', 'data', ' \t*node'], 0), 1);
    });

    it('ends one line before the next keyword', () => {
        assert.equal(endLineOfCurrentKeyword(['*A', 'data', '*B'], 0), 1);
    });

    it('returns last line when no next keyword', () => {
        assert.equal(endLineOfCurrentKeyword(['*A', 'data', 'more'], 0), 2);
    });
});

// ---------------------------------------------------------------------------
// getFilenameFromKeyword
// ---------------------------------------------------------------------------

describe('getFilenameFromKeyword', () => {
    it('extracts filenames from indented mixed-case include keywords', () => {
        assert.equal(getFilenameFromKeyword([' \t*Include', 'geometry.k'], 1), 'geometry.k');
    });

    it('extracts filename from *INCLUDE', () => {
        const lines = ['*INCLUDE', 'geometry.k'];
        assert.equal(getFilenameFromKeyword(lines, 1), 'geometry.k');
    });

    it('combines continued filenames inside *INCLUDE blocks', () => {
        const lines = ['*INCLUDE', 'part_a +', 'part_b.key'];
        assert.equal(getFilenameFromKeyword(lines, 1), 'part_apart_b.key');
    });

    it('returns the selected filename inside a multi-file *INCLUDE block', () => {
        const lines = ['*INCLUDE', 'a.key', 'b.key', 'c.key'];
        assert.equal(getFilenameFromKeyword(lines, 2), 'b.key');
    });

    it('throws on *INCLUDE_PATH (no filename card)', () => {
        const lines = ['*INCLUDE_PATH', '/some/path'];
        assert.throws(() => getFilenameFromKeyword(lines, 1));
    });

    it('throws when not on an include keyword', () => {
        const lines = ['*CONTROL_TERMINATION', '  5.0'];
        assert.throws(() => getFilenameFromKeyword(lines, 1));
    });

    it('skips comment lines before filename', () => {
        const lines = ['*INCLUDE', '$ a comment', 'real.k'];
        assert.equal(getFilenameFromKeyword(lines, 0), 'real.k');
    });
});

// ---------------------------------------------------------------------------
// document-based keyword helpers
// ---------------------------------------------------------------------------

describe('document-based keyword helpers', () => {
    it('extracts include filenames without reading the whole document text', () => {
        const doc = fakeDoc('*INCLUDE\na.key\nb.key\n');
        doc.getText = () => { throw new Error('getText should not be used'); };

        assert.equal(getFilenameFromDocument(doc, 2), 'b.key');
    });

    it('navigates between keyword lines without reading the whole document text', () => {
        const doc = fakeDoc('*A\ndata\n*B\nmore\n*C\n');
        doc.getText = () => { throw new Error('getText should not be used'); };

        assert.equal(findNextKeywordInDocument(doc, 0), 2);
        assert.equal(findPreviousKeywordInDocument(doc, 4), 2);
    });
});

// ---------------------------------------------------------------------------
// LsdynaIncludeTreeProvider
// ---------------------------------------------------------------------------

describe('LsdynaIncludeTreeProvider', () => {
    it('builds include trees without readFileSync on scanned files', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-tree-'));
        const submodelsDir = path.join(tempRoot, 'submodels');
        const mainFile = path.join(tempRoot, 'main.k');
        const aFile = path.join(tempRoot, 'a.key');
        const bFile = path.join(submodelsDir, 'b.key');

        fs.mkdirSync(submodelsDir);
        fs.writeFileSync(mainFile, '*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\na.key\nb.key\n');
        fs.writeFileSync(aFile, '*KEYWORD\n');
        fs.writeFileSync(bFile, '*KEYWORD\n');

        const provider = new LsdynaIncludeTreeProvider({ searchFileFromPaths });
        const originalReadFileSync = fs.readFileSync;
        fs.readFileSync = function patchedReadFileSync(filePath) {
            if (filePath === mainFile || filePath === aFile || filePath === bFile) {
                throw new Error('include tree scanning should not use readFileSync for deck files');
            }
            return originalReadFileSync.apply(this, arguments);
        };

        try {
            const root = await provider._buildItem(mainFile, new Set(), { report() {} });
            assert.deepEqual(
                root.children.map(child => child.filePath).sort(),
                [aFile, bFile].sort()
            );
        } finally {
            fs.readFileSync = originalReadFileSync;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('builds include tree items from a project snapshot', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-tree-'));
        const mainFile = path.join(tempRoot, 'main.k');
        const aFile = path.join(tempRoot, 'a.key');
        const bFile = path.join(tempRoot, 'b.key');

        fs.writeFileSync(mainFile, '*KEYWORD\n');
        fs.writeFileSync(aFile, '*KEYWORD\n');
        fs.writeFileSync(bFile, '*KEYWORD\n');

        const provider = new LsdynaIncludeTreeProvider({ searchFileFromPaths });
        const snapshot = {
            graph: {
                toTree(filePath) {
                    assert.equal(filePath, mainFile);
                    return {
                        filePath: mainFile,
                        children: [
                            {
                                filePath: aFile,
                                children: [
                                    {
                                        filePath: bFile,
                                        children: [],
                                    },
                                ],
                            },
                        ],
                    };
                },
            },
        };

        try {
            const root = provider._buildRootFromSnapshot(snapshot, mainFile);
            assert.equal(root.filePath, mainFile);
            assert.deepEqual(root.children.map(child => child.filePath), [aFile]);
            assert.deepEqual(root.children[0].children.map(child => child.filePath), [bFile]);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('preserves missing include nodes when building tree items from a project snapshot', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-tree-'));
        const mainFile = path.join(tempRoot, 'main.k');
        const childFile = path.join(tempRoot, 'child.key');
        const missingFile = path.join(tempRoot, 'missing.key');
        const provider = new LsdynaIncludeTreeProvider({ searchFileFromPaths });

        fs.writeFileSync(mainFile, '*INCLUDE\nchild.key\nmissing.key\n', 'utf8');
        fs.writeFileSync(childFile, '*KEYWORD\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(mainFile);
            const root = provider._buildRootFromSnapshot(snapshot, mainFile);

            assert.deepEqual(root.children.map(child => child.filePath), [childFile, missingFile]);
            assert.equal(root.children[1].description, 'missing');
            assert.equal(root.children[1].command, undefined);
            assert.equal(root.children[1].collapsibleState, vscodeMock.TreeItemCollapsibleState.None);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('preserves duplicate missing include nodes when building tree items from a project snapshot', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-tree-'));
        const mainFile = path.join(tempRoot, 'main.k');
        const childFile = path.join(tempRoot, 'child.key');
        const missingFile = path.join(tempRoot, 'missing.key');
        const provider = new LsdynaIncludeTreeProvider({ searchFileFromPaths });

        fs.writeFileSync(mainFile, '*INCLUDE\nmissing.key\nmissing.key\nchild.key\n', 'utf8');
        fs.writeFileSync(childFile, '*KEYWORD\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(mainFile);
            const root = provider._buildRootFromSnapshot(snapshot, mainFile);

            assert.deepEqual(root.children.map(child => child.filePath), [missingFile, missingFile, childFile]);
            assert.equal(root.children[0].description, 'missing');
            assert.equal(root.children[1].description, 'missing');
            assert.equal(root.children[0].command, undefined);
            assert.equal(root.children[1].command, undefined);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('uses the shared project snapshot loader during scans when available', async () => {
        const rootFile = path.join('project', 'snapshot-root', 'main.k');
        const aFile = path.join('project', 'snapshot-root', 'a.key');
        const provider = new LsdynaIncludeTreeProvider({
            searchFileFromPaths() {
                throw new Error('searchFileFromPaths should not be used when loadProjectSnapshot is available');
            },
            loadProjectSnapshot: async (filePath) => {
                assert.equal(filePath, rootFile);
                return {
                    graph: {
                        toTree(treeRootFile) {
                            assert.equal(treeRootFile, rootFile);
                            return {
                                filePath: rootFile,
                                children: [
                                    { filePath: aFile, children: [] },
                                ],
                            };
                        },
                    },
                };
            },
        });
        const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
        const originalWithProgress = vscodeMock.window.withProgress;
        const originalProgressLocation = vscodeMock.ProgressLocation;

        vscodeMock.window.activeTextEditor = {
            document: {
                languageId: 'lsdyna',
                uri: { fsPath: rootFile },
            },
        };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} });
        vscodeMock.ProgressLocation = { Notification: 15 };

        try {
            await provider.scan();

            assert.ok(provider.root);
            assert.equal(provider.root.filePath, rootFile);
            assert.deepEqual(provider.root.children.map(child => child.filePath), [aFile]);
        } finally {
            vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            vscodeMock.window.withProgress = originalWithProgress;
            vscodeMock.ProgressLocation = originalProgressLocation;
        }
    });
});

// ---------------------------------------------------------------------------
// LsdynaKeywordIndexProvider
// ---------------------------------------------------------------------------

describe('LsdynaKeywordIndexProvider', () => {
    it('builds keyword roots from a project snapshot', () => {
        const rootDir = path.join('project', 'snapshot-root');
        const aFile = path.join(rootDir, 'submodels', 'a.key');
        const bFile = path.join(rootDir, 'b.key');
        const provider = new LsdynaKeywordIndexProvider();
        const snapshot = {
            keywordMap: new Map([
                ['PART', [
                    { filePath: aFile, lineIndex: 1 },
                    { filePath: bFile, lineIndex: 7 },
                ]],
                ['MAT_ELASTIC', [
                    { filePath: bFile, lineIndex: 4 },
                ]],
            ]),
        };

        const roots = provider._buildRootsFromSnapshot(snapshot, rootDir);

        assert.deepEqual(roots.map(item => item.label), ['MAT_ELASTIC', 'PART']);
        assert.deepEqual(
            roots[1].children.map(child => child.command.arguments),
            [
                [aFile, 1],
                [bFile, 7],
            ]
        );
    });

    it('uses the project snapshot during recursive scans when available', async () => {
        const rootFile = path.join('project', 'snapshot-root', 'main.k');
        const provider = new LsdynaKeywordIndexProvider({
            collectIncludeFiles: async () => {
                throw new Error('collectIncludeFiles should not be called when loadProjectSnapshot is available');
            },
            loadProjectSnapshot: async (filePath) => {
                assert.equal(filePath, rootFile);
                return {
                    keywordMap: new Map([
                        ['PART', [{ filePath: rootFile, lineIndex: 2 }]],
                    ]),
                };
            },
            shouldSkipAutomaticDocumentScan,
        });
        const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
        const originalWithProgress = vscodeMock.window.withProgress;
        const originalProgressLocation = vscodeMock.ProgressLocation;

        vscodeMock.window.activeTextEditor = {
            document: {
                languageId: 'lsdyna',
                uri: { fsPath: rootFile },
            },
        };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} });
        vscodeMock.ProgressLocation = { Notification: 15 };

        try {
            await provider.scan();

            assert.equal(provider._mode, 'recursive');
            assert.deepEqual(provider.roots.map(item => item.label), ['PART']);
            assert.deepEqual(
                provider.roots[0].children.map(child => child.command.arguments),
                [[rootFile, 2]]
            );
        } finally {
            vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            vscodeMock.window.withProgress = originalWithProgress;
            vscodeMock.ProgressLocation = originalProgressLocation;
        }
    });

    it('yields during large single-file keyword scans', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-keyword-index-'));
        const bigFile = path.join(tempRoot, 'big.k');
        const lines = ['*KEYWORD'];
        for (let i = 0; i < 50000; i++) lines.push(`$ line ${i}`);
        fs.writeFileSync(bigFile, lines.join('\n'));

        const provider = new LsdynaKeywordIndexProvider({ collectIncludeFiles, shouldSkipAutomaticDocumentScan });
        const originalSetImmediate = global.setImmediate;
        let yieldCount = 0;
        global.setImmediate = (callback, ...args) => {
            yieldCount++;
            callback(...args);
            return yieldCount;
        };

        try {
            await provider._buildRootsAsync([bigFile], tempRoot);
            assert.ok(yieldCount >= 2, `expected at least 2 yields, got ${yieldCount}`);
        } finally {
            global.setImmediate = originalSetImmediate;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});

describe('activate', () => {
    it('creates diagnostics before snippet loading can request a refresh', async () => {
        const context = { subscriptions: [] };
        const document = fakeDoc('*KEYWORD\n', '/project/main.k');
        document.languageId = 'lsdyna';
        const originalReadFile = fs.readFile;
        const originalTextDocuments = vscodeMock.workspace.textDocuments;
        const originalConsoleError = console.error;
        const errors = [];

        fs.readFile = (_filePath, _encoding, callback) => {
            callback(null, JSON.stringify({ '*KEYWORD': {} }));
        };
        vscodeMock.workspace.textDocuments = [document];
        console.error = (...args) => {
            errors.push(args.map(String).join(' '));
        };

        try {
            await extensionModule.activate(context);
            assert.equal(
                errors.some(message => message.includes("Cannot access 'diagnostics' before initialization")),
                false
            );
        } finally {
            fs.readFile = originalReadFile;
            vscodeMock.workspace.textDocuments = originalTextDocuments;
            console.error = originalConsoleError;
        }
    });

    it('registers internal PDF and main-deck context commands', async () => {
        const context = { subscriptions: [] };
        const disposable = { dispose() {} };
        const originalRegisterCommand = vscodeMock.commands.registerCommand;
        let pickerCommand;
        let mainDeckCommand;

        vscodeMock.commands.registerCommand = (id, callback) => {
            if (id === 'extension.manual.pickPdfLocation') pickerCommand = callback;
            if (id === 'extension.selectMainDeckContext') mainDeckCommand = callback;
            return disposable;
        };

        try {
            await extensionModule.activate(context);
            assert.equal(typeof pickerCommand, 'function');
            assert.equal(typeof mainDeckCommand, 'function');
        } finally {
            vscodeMock.commands.registerCommand = originalRegisterCommand;
        }
    });

    it('registers document links for clickable include paths', async () => {
        const context = { subscriptions: [] };
        const disposable = { dispose() {} };
        let registration;
        const originalRegisterTreeDataProvider = vscodeMock.window.registerTreeDataProvider;
        const originalOnDidChangeActiveTextEditor = vscodeMock.window.onDidChangeActiveTextEditor;
        const originalOnDidChangeTextEditorSelection = vscodeMock.window.onDidChangeTextEditorSelection;
        const originalCreateTextEditorDecorationType = vscodeMock.window.createTextEditorDecorationType;
        const originalRegisterHoverProvider = vscodeMock.languages.registerHoverProvider;
        const originalRegisterCodeLensProvider = vscodeMock.languages.registerCodeLensProvider;
        const originalRegisterDocumentLinkProvider = vscodeMock.languages.registerDocumentLinkProvider;

        vscodeMock.window.registerTreeDataProvider = () => disposable;
        vscodeMock.window.onDidChangeActiveTextEditor = () => disposable;
        vscodeMock.window.onDidChangeTextEditorSelection = () => disposable;
        vscodeMock.window.createTextEditorDecorationType = () => disposable;
        vscodeMock.languages.registerHoverProvider = () => disposable;
        vscodeMock.languages.registerCodeLensProvider = () => disposable;
        vscodeMock.languages.registerDocumentLinkProvider = (selector, provider) => {
            registration = { selector, provider };
            return disposable;
        };

        try {
            await extensionModule.activate(context);

            assert.deepEqual(registration.selector, { language: 'lsdyna' });
            assert.equal(typeof registration.provider.provideDocumentLinks, 'function');
        } finally {
            vscodeMock.window.registerTreeDataProvider = originalRegisterTreeDataProvider;
            vscodeMock.window.onDidChangeActiveTextEditor = originalOnDidChangeActiveTextEditor;
            vscodeMock.window.onDidChangeTextEditorSelection = originalOnDidChangeTextEditorSelection;
            vscodeMock.window.createTextEditorDecorationType = originalCreateTextEditorDecorationType;
            vscodeMock.languages.registerHoverProvider = originalRegisterHoverProvider;
            vscodeMock.languages.registerCodeLensProvider = originalRegisterCodeLensProvider;
            vscodeMock.languages.registerDocumentLinkProvider = originalRegisterDocumentLinkProvider;
        }
    });

    it('injects a shared project snapshot loader into both tree providers', async () => {
        const context = { subscriptions: [] };
        const registrations = new Map();
        const disposable = { dispose() {} };
        const originalRegisterTreeDataProvider = vscodeMock.window.registerTreeDataProvider;
        const originalCreateTreeView = vscodeMock.window.createTreeView;
        const originalOnDidChangeActiveTextEditor = vscodeMock.window.onDidChangeActiveTextEditor;
        const originalOnDidChangeTextEditorSelection = vscodeMock.window.onDidChangeTextEditorSelection;
        const originalCreateTextEditorDecorationType = vscodeMock.window.createTextEditorDecorationType;
        const originalRegisterHoverProvider = vscodeMock.languages.registerHoverProvider;
        const originalRegisterCodeLensProvider = vscodeMock.languages.registerCodeLensProvider;

        vscodeMock.window.registerTreeDataProvider = (viewId, provider) => {
            registrations.set(viewId, provider);
            return disposable;
        };
        vscodeMock.window.createTreeView = (viewId, options) => {
            registrations.set(viewId, options.treeDataProvider);
            return {
                title: '',
                dispose() {}
            };
        };
        vscodeMock.window.onDidChangeActiveTextEditor = () => disposable;
        vscodeMock.window.onDidChangeTextEditorSelection = () => disposable;
        vscodeMock.window.createTextEditorDecorationType = () => disposable;
        vscodeMock.languages.registerHoverProvider = () => disposable;
        vscodeMock.languages.registerCodeLensProvider = () => disposable;

        try {
            await extensionModule.activate(context);

            const includeTreeProvider = registrations.get('lsdynaIncludeTree');
            const keywordIndexProvider = registrations.get('lsdynaKeywordIndex');
            assert.ok(includeTreeProvider instanceof LsdynaIncludeTreeProvider);
            assert.ok(keywordIndexProvider instanceof LsdynaKeywordIndexProvider);
            assert.equal(typeof includeTreeProvider.loadProjectSnapshot, 'function');
            assert.equal(typeof keywordIndexProvider.loadProjectSnapshot, 'function');
            assert.strictEqual(keywordIndexProvider.loadProjectSnapshot, includeTreeProvider.loadProjectSnapshot);
        } finally {
            vscodeMock.window.registerTreeDataProvider = originalRegisterTreeDataProvider;
            vscodeMock.window.createTreeView = originalCreateTreeView;
            vscodeMock.window.onDidChangeActiveTextEditor = originalOnDidChangeActiveTextEditor;
            vscodeMock.window.onDidChangeTextEditorSelection = originalOnDidChangeTextEditorSelection;
            vscodeMock.window.createTextEditorDecorationType = originalCreateTextEditorDecorationType;
            vscodeMock.languages.registerHoverProvider = originalRegisterHoverProvider;
            vscodeMock.languages.registerCodeLensProvider = originalRegisterCodeLensProvider;
        }
    });

    it('registers a workspace watcher for LS-DYNA project files', async () => {
        const context = { subscriptions: [] };
        const disposable = { dispose() {} };
        const watcherGlobs = [];
        const originalCreateFileSystemWatcher = vscodeMock.workspace.createFileSystemWatcher;
        const originalRegisterTreeDataProvider = vscodeMock.window.registerTreeDataProvider;
        const originalOnDidChangeActiveTextEditor = vscodeMock.window.onDidChangeActiveTextEditor;
        const originalOnDidChangeTextEditorSelection = vscodeMock.window.onDidChangeTextEditorSelection;
        const originalCreateTextEditorDecorationType = vscodeMock.window.createTextEditorDecorationType;
        const originalRegisterHoverProvider = vscodeMock.languages.registerHoverProvider;
        const originalRegisterCodeLensProvider = vscodeMock.languages.registerCodeLensProvider;

        vscodeMock.workspace.createFileSystemWatcher = (glob) => {
            watcherGlobs.push(glob);
            return {
                onDidChange: () => disposable,
                onDidCreate: () => disposable,
                onDidDelete: () => disposable,
                dispose() {},
            };
        };
        vscodeMock.window.registerTreeDataProvider = () => disposable;
        vscodeMock.window.onDidChangeActiveTextEditor = () => disposable;
        vscodeMock.window.onDidChangeTextEditorSelection = () => disposable;
        vscodeMock.window.createTextEditorDecorationType = () => disposable;
        vscodeMock.languages.registerHoverProvider = () => disposable;
        vscodeMock.languages.registerCodeLensProvider = () => disposable;

        try {
            await extensionModule.activate(context);
            assert.deepEqual(watcherGlobs, ['**/*.asc', '**/*.dyna', '**/*.k', '**/*.key']);
        } finally {
            vscodeMock.workspace.createFileSystemWatcher = originalCreateFileSystemWatcher;
            vscodeMock.window.registerTreeDataProvider = originalRegisterTreeDataProvider;
            vscodeMock.window.onDidChangeActiveTextEditor = originalOnDidChangeActiveTextEditor;
            vscodeMock.window.onDidChangeTextEditorSelection = originalOnDidChangeTextEditorSelection;
            vscodeMock.window.createTextEditorDecorationType = originalCreateTextEditorDecorationType;
            vscodeMock.languages.registerHoverProvider = originalRegisterHoverProvider;
            vscodeMock.languages.registerCodeLensProvider = originalRegisterCodeLensProvider;
        }
    });
});

describe('createManifestDrivenInvalidator', () => {
    it('invalidates every affected project root for a changed tracked file', () => {
        const rootA = path.resolve('project', 'root-a.k');
        const rootB = path.resolve('project', 'root-b.k');
        const changedFile = path.resolve('project', 'shared.key');
        const invalidatedRoots = [];
        const invalidateChangedFile = createManifestDrivenInvalidator({
            indexClient: {
                getManifestEntries() {
                    return [
                        { rootFile: rootA, trackedFiles: [rootA, changedFile] },
                        { rootFile: rootB, trackedFiles: [rootB, changedFile] },
                    ];
                },
                invalidate(rootFile) {
                    invalidatedRoots.push(rootFile);
                },
            },
        });

        invalidateChangedFile({ fsPath: changedFile });

        assert.deepEqual(invalidatedRoots, [rootA, rootB]);
    });

    it('ignores untracked files', () => {
        const rootFile = path.resolve('project', 'root.k');
        const invalidatedRoots = [];
        const invalidateChangedFile = createManifestDrivenInvalidator({
            indexClient: {
                getManifestEntries() {
                    return [
                        { rootFile, trackedFiles: [rootFile] },
                    ];
                },
                invalidate(root) {
                    invalidatedRoots.push(root);
                },
            },
        });

        invalidateChangedFile({ fsPath: path.resolve('project', 'other.key') });

        assert.deepEqual(invalidatedRoots, []);
    });
});

describe('createBatchedManifestInvalidator', () => {
    it('waits for asynchronous LSP manifest entries before batching invalidation', async () => {
        const rootFile = path.resolve('project', 'root.k');
        const changedFile = path.resolve('project', 'shared.key');
        const invalidatedRoots = [];
        const scheduled = [];
        const batchedInvalidator = createBatchedManifestInvalidator({
            indexClient: {
                async getManifestEntries() {
                    return [{ rootFile, trackedFiles: [rootFile, changedFile] }];
                },
                invalidate(root) {
                    invalidatedRoots.push(root);
                },
            },
            schedule(callback) {
                scheduled.push(callback);
                return callback;
            },
        });

        await batchedInvalidator({ fsPath: changedFile });
        assert.equal(scheduled.length, 1);

        scheduled[0]();

        assert.deepEqual(invalidatedRoots, [rootFile]);
    });

    it('reports asynchronous manifest lookup failures without scheduling invalidation', async () => {
        const changedFile = path.resolve('project', 'shared.key');
        const errors = [];
        let scheduledCount = 0;
        const batchedInvalidator = createBatchedManifestInvalidator({
            indexClient: {
                async getManifestEntries() {
                    throw new Error('manifest unavailable');
                },
                invalidate() {
                    throw new Error('invalidate should not run');
                },
            },
            onError(error, filePath) {
                errors.push({ error, filePath });
            },
            schedule() {
                scheduledCount += 1;
            },
        });

        await batchedInvalidator({ fsPath: changedFile });

        assert.equal(scheduledCount, 0);
        assert.equal(errors.length, 1);
        assert.match(errors[0].error.message, /manifest unavailable/);
        assert.equal(errors[0].filePath, changedFile);
    });

    it('coalesces rapid file events into one invalidation per affected root', () => {
        const rootFile = path.resolve('project', 'root.k');
        const changedFile = path.resolve('project', 'shared.key');
        const invalidatedRoots = [];
        const scheduled = new Map();
        let nextTimerId = 1;
        const batchedInvalidator = createBatchedManifestInvalidator({
            indexClient: {
                getManifestEntries() {
                    return [{ rootFile, trackedFiles: [rootFile, changedFile] }];
                },
                invalidate(root) {
                    invalidatedRoots.push(root);
                },
            },
            delayMs: 50,
            schedule(callback) {
                const timerId = nextTimerId++;
                scheduled.set(timerId, callback);
                return timerId;
            },
            cancel(timerId) {
                scheduled.delete(timerId);
            },
        });

        batchedInvalidator({ fsPath: changedFile });
        batchedInvalidator({ fsPath: changedFile });
        scheduled.forEach(callback => callback());

        assert.deepEqual(invalidatedRoots, [rootFile]);
    });

    it('batches multiple roots discovered across rapid file events', () => {
        const rootA = path.resolve('project', 'root-a.k');
        const rootB = path.resolve('project', 'root-b.k');
        const invalidatedRoots = [];
        const scheduled = new Map();
        let nextTimerId = 1;
        const batchedInvalidator = createBatchedManifestInvalidator({
            indexClient: {
                getManifestEntries() {
                    return [
                        { rootFile: rootA, trackedFiles: [rootA, path.resolve('project', 'a.key')] },
                        { rootFile: rootB, trackedFiles: [rootB, path.resolve('project', 'b.key')] },
                    ];
                },
                invalidate(root) {
                    invalidatedRoots.push(root);
                },
            },
            delayMs: 50,
            schedule(callback) {
                const timerId = nextTimerId++;
                scheduled.set(timerId, callback);
                return timerId;
            },
            cancel(timerId) {
                scheduled.delete(timerId);
            },
        });

        batchedInvalidator({ fsPath: path.resolve('project', 'a.key') });
        batchedInvalidator({ fsPath: path.resolve('project', 'b.key') });
        scheduled.forEach(callback => callback());

        assert.deepEqual(invalidatedRoots.sort(), [rootA, rootB].sort());
    });

    it('does not reschedule the timer for untracked file events', () => {
        const rootFile = path.resolve('project', 'root.k');
        const trackedFile = path.resolve('project', 'tracked.key');
        const untrackedFile = path.resolve('project', 'other.key');
        const invalidatedRoots = [];
        const scheduled = new Map();
        let nextTimerId = 1;
        let scheduledCount = 0;
        let cancelledCount = 0;
        const batchedInvalidator = createBatchedManifestInvalidator({
            indexClient: {
                getManifestEntries() {
                    return [{ rootFile, trackedFiles: [rootFile, trackedFile] }];
                },
                invalidate(root) {
                    invalidatedRoots.push(root);
                },
            },
            delayMs: 50,
            schedule(callback) {
                scheduledCount += 1;
                const timerId = nextTimerId++;
                scheduled.set(timerId, callback);
                return timerId;
            },
            cancel(timerId) {
                cancelledCount += 1;
                scheduled.delete(timerId);
            },
        });

        batchedInvalidator({ fsPath: trackedFile });
        batchedInvalidator({ fsPath: untrackedFile });
        scheduled.forEach(callback => callback());

        assert.equal(scheduledCount, 1);
        assert.equal(cancelledCount, 0);
        assert.deepEqual(invalidatedRoots, [rootFile]);
    });
});

describe('createProjectSnapshotRefreshQueue', () => {
    it('refreshes queued roots sequentially and deduplicates repeated roots', async () => {
        const rootA = path.resolve('project', 'root-a.k');
        const rootB = path.resolve('project', 'root-b.k');
        const startedRoots = [];
        const resolvers = [];
        const scheduled = [];
        const enqueueRefresh = createProjectSnapshotRefreshQueue({
            loadProjectSnapshot(rootFile) {
                startedRoots.push(rootFile);
                return new Promise(resolve => resolvers.push(resolve));
            },
            schedule(callback) {
                scheduled.push(callback);
                return scheduled.length;
            },
        });

        enqueueRefresh(rootA);
        enqueueRefresh(rootA);
        enqueueRefresh(rootB);

        assert.equal(scheduled.length, 1);

        scheduled.shift()();
        assert.deepEqual(startedRoots, [rootA]);

        resolvers.shift()();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(startedRoots, [rootA, rootB]);
    });

    it('continues refreshing later roots after a refresh failure', async () => {
        const rootA = path.resolve('project', 'root-a.k');
        const rootB = path.resolve('project', 'root-b.k');
        const errors = [];
        const startedRoots = [];
        const scheduled = [];
        const enqueueRefresh = createProjectSnapshotRefreshQueue({
            async loadProjectSnapshot(rootFile) {
                startedRoots.push(rootFile);
                if (rootFile === rootA) throw new Error('refresh failed');
            },
            onError(error, rootFile) {
                errors.push({ message: error.message, rootFile });
            },
            schedule(callback) {
                scheduled.push(callback);
                return scheduled.length;
            },
        });

        enqueueRefresh(rootA);
        enqueueRefresh(rootB);
        scheduled.shift()();
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(startedRoots, [rootA, rootB]);
        assert.deepEqual(errors, [{ message: 'refresh failed', rootFile: rootA }]);
    });

    it('keeps refreshes sequential when new roots are enqueued during active processing', async () => {
        const rootA = path.resolve('project', 'root-a.k');
        const rootB = path.resolve('project', 'root-b.k');
        const startedRoots = [];
        const activeRoots = new Set();
        let maxConcurrent = 0;
        let resolveRootA;
        const scheduled = [];
        const enqueueRefresh = createProjectSnapshotRefreshQueue({
            loadProjectSnapshot(rootFile) {
                startedRoots.push(rootFile);
                activeRoots.add(rootFile);
                maxConcurrent = Math.max(maxConcurrent, activeRoots.size);
                if (rootFile === rootA) {
                    return new Promise(resolve => {
                        resolveRootA = () => {
                            activeRoots.delete(rootFile);
                            resolve();
                        };
                    });
                }
                activeRoots.delete(rootFile);
                return Promise.resolve();
            },
            schedule(callback) {
                scheduled.push(callback);
                return scheduled.length;
            },
        });

        enqueueRefresh(rootA);
        scheduled.shift()();
        assert.deepEqual(startedRoots, [rootA]);

        enqueueRefresh(rootB);
        assert.equal(scheduled.length, 0);

        resolveRootA();
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(startedRoots, [rootA, rootB]);
        assert.equal(maxConcurrent, 1);
    });
});

describe('createProjectIndexLoader', () => {
    it('creates the worker pool lazily on first project index request and disposes it', async () => {
        const createdPools = [];
        let disposed = false;
        const snapshot = { rootFile: path.resolve('project', 'main.k') };
        const loader = createProjectIndexLoader({
            createPool({ workerPath }) {
                createdPools.push(workerPath);
                return {
                    buildProjectIndex: async () => snapshot,
                    dispose: async () => {
                        disposed = true;
                    },
                };
            },
            workerPath: path.resolve('custom', 'scanWorker.js'),
        });

        assert.deepEqual(createdPools, []);
        assert.strictEqual(await loader.buildProjectIndex(snapshot.rootFile), snapshot);
        assert.deepEqual(createdPools, [path.resolve('custom', 'scanWorker.js')]);

        await loader.dispose();
        assert.equal(disposed, true);
    });

    it('recreates the worker pool after a fatal worker failure', async () => {
        const createdPools = [];
        const snapshot = { rootFile: path.resolve('project', 'main.k') };
        let firstPoolDisposed = false;
        const loader = createProjectIndexLoader({
            createPool() {
                createdPools.push(createdPools.length + 1);
                if (createdPools.length === 1) {
                    return {
                        async buildProjectIndex() {
                            firstPoolDisposed = true;
                            throw new Error('worker crashed');
                        },
                        isDisposed() {
                            return firstPoolDisposed;
                        },
                        dispose: async () => {},
                    };
                }

                return {
                    async buildProjectIndex() {
                        return snapshot;
                    },
                    isDisposed() {
                        return false;
                    },
                    dispose: async () => {},
                };
            },
        });

        await assert.rejects(loader.buildProjectIndex(snapshot.rootFile), /worker crashed/);
        assert.strictEqual(await loader.buildProjectIndex(snapshot.rootFile), snapshot);
        assert.deepEqual(createdPools, [1, 2]);
    });

    it('does not recreate a worker pool once disposal starts and disposes idempotently', async () => {
        const createdPools = [];
        let releaseDispose;
        let signalDisposeStarted;
        let disposeCalls = 0;
        const disposeStarted = new Promise(resolve => {
            signalDisposeStarted = resolve;
        });
        const disposeGate = new Promise(resolve => {
            releaseDispose = resolve;
        });
        const loader = createProjectIndexLoader({
            createPool() {
                const pool = {
                    disposed: false,
                    async buildProjectIndex() {
                        return { rootFile: path.resolve('project', 'main.k') };
                    },
                    isDisposed() {
                        return pool.disposed;
                    },
                    async dispose() {
                        disposeCalls += 1;
                        pool.disposed = true;
                        signalDisposeStarted();
                        await disposeGate;
                    },
                };
                createdPools.push(pool);
                return pool;
            },
        });

        await loader.buildProjectIndex(path.resolve('project', 'main.k'));
        const firstDispose = loader.dispose();
        await disposeStarted;
        const secondDispose = loader.dispose();

        try {
            await assert.rejects(
                loader.buildProjectIndex(path.resolve('project', 'late.k')),
                /disposed/i,
            );
            assert.strictEqual(createdPools.length, 1);
            assert.strictEqual(loader.isDisposed(), true);
        } finally {
            releaseDispose();
            await Promise.all([firstDispose, secondDispose]);
        }

        assert.strictEqual(disposeCalls, 1);
        await assert.rejects(
            loader.buildProjectIndex(path.resolve('project', 'after.k')),
            /disposed/i,
        );
        assert.strictEqual(createdPools.length, 1);
    });
});

describe('createProjectSnapshotPersistentCache', () => {
    it('returns null when no global storage path is available', () => {
        assert.equal(createProjectSnapshotPersistentCache(), null);
        assert.equal(createProjectSnapshotPersistentCache({ storageUri: {} }), null);
    });

    it('creates the disk snapshot store under the extension global storage directory', () => {
        const created = [];
        const persistentCache = createProjectSnapshotPersistentCache({
            storageUri: { fsPath: path.resolve('storage-root') },
            createStore(options) {
                created.push(options);
                return { kind: 'disk-store' };
            },
        });

        assert.deepEqual(created, [{
            cacheDirectory: path.resolve('storage-root', 'project-snapshots'),
            maxCacheBytes: 256 * 1024 * 1024,
        }]);
        assert.deepEqual(persistentCache, { kind: 'disk-store' });
    });
});

// ---------------------------------------------------------------------------
// Debounce helpers
// ---------------------------------------------------------------------------

describe('createActiveDocumentDebouncer', () => {
    it('refreshes only if the changed document is still active when the timer fires', () => {
        const scheduled = new Map();
        let nextTimerId = 1;
        let activeDocument = { uri: { fsPath: '/a.k' } };
        const refreshed = [];

        const debouncer = createActiveDocumentDebouncer(
            () => activeDocument,
            (document) => refreshed.push(document.uri.fsPath),
            500,
            (callback) => {
                const timerId = nextTimerId++;
                scheduled.set(timerId, callback);
                return timerId;
            },
            (timerId) => scheduled.delete(timerId)
        );

        const changedDocument = { uri: { fsPath: '/a.k' } };
        debouncer(changedDocument);
        activeDocument = { uri: { fsPath: '/b.k' } };
        scheduled.forEach(callback => callback());

        assert.deepEqual(refreshed, []);
    });
});

// ---------------------------------------------------------------------------
// large document guards
// ---------------------------------------------------------------------------

describe('large document guards', () => {
    let originalGetConfiguration;

    before(() => {
        originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'largeFile.enableRendering' ? false : defaultValue
        });
    });

    after(() => {
        vscodeMock.workspace.getConfiguration = originalGetConfiguration;
    });

    function createHugeDoc() {
        return {
            languageId: 'lsdyna',
            lineCount: 100001,
            version: 1,
            uri: { fsPath: '/project/huge.k' },
            lineAt() {
                throw new Error('lineAt should not be used for very large automatic scans');
            },
        };
    }

    it('uses file index for folding and symbols without scanning huge documents', () => {
        const document = createHugeDoc();
        const fileIndex = {
            keywordBlocks: [
                { keyword: '*KEYWORD', startLine: 0, endLine: 9, keywordStartChar: 0 },
                { keyword: '*NODE', startLine: 10, endLine: 100, keywordStartChar: 0 },
                { keyword: '*END', startLine: 101, endLine: 101, keywordStartChar: 0 },
            ],
        };

        setFileIndexForTesting(document.uri.fsPath, fileIndex);
        try {
            const folds = new LsDynaFoldingProvider().provideFoldingRanges(document);
            const symbols = new LsdynaKeywordSymbolProvider().provideDocumentSymbols(document);

            assert.deepStrictEqual(folds.map(range => [range.start, range.end]), [[0, 9], [10, 100]]);
            assert.equal(symbols.length, 3);
        } finally {
            setFileIndexForTesting(document.uri.fsPath, null);
        }
    });

    it('skips automatic line-length diagnostics for very large documents', () => {
        assert.deepEqual(collectLineLengthDiagnostics(createHugeDoc()), []);
    });

    it('skips automatic keyword decorations for very large documents', () => {
        assert.deepEqual(collectKeywordDecorationRanges(createHugeDoc()), []);
    });

    it('collects keyword decoration ranges correctly', () => {
        const doc = fakeDoc('*NODE\n*ELEMENT_MASS, id=1\n  *MAT_ADD_EROSION\n$ comment line\n', '/project/main.k');
        doc.languageId = 'lsdyna';

        const ranges = collectKeywordDecorationRanges(doc);
        assert.equal(ranges.length, 3);

        assert.equal(ranges[0].start.line, 0);
        assert.equal(ranges[0].start.character, 0);
        assert.equal(ranges[0].end.line, 0);
        assert.equal(ranges[0].end.character, 5);

        assert.equal(ranges[1].start.line, 1);
        assert.equal(ranges[1].start.character, 0);
        assert.equal(ranges[1].end.line, 1);
        assert.equal(ranges[1].end.character, 13);

        assert.equal(ranges[2].start.line, 2);
        assert.equal(ranges[2].start.character, 2);
        assert.equal(ranges[2].end.line, 2);
        assert.equal(ranges[2].end.character, 18);
    });

    it('skips automatic include decorations for very large documents', async () => {
        assert.deepEqual(await collectIncludeDecorationSets(createHugeDoc()), {
            resolved: [],
            missing: [],
            missingIndicators: [],
        });
    });

    it('puts one missing indicator after the final segment of a continued include', async () => {
        const doc = fakeDoc('*INCLUDE\npart_a +\npart_b.key\n', '/project/main.k');
        doc.languageId = 'lsdyna';

        const { missing, missingIndicators } = await collectIncludeDecorationSets(doc);

        assert.equal(missing.length, 1);
        assert.equal(missing[0].range.start.line, 1);
        assert.equal(missing[0].range.end.line, 2);
        assert.equal(missing[0].range.end.character, 'part_b.key'.length);
        assert.equal(missing[0].hoverMessage, i18n.get('includeDecorationMissingLocal', 'part_apart_b.key'));
        assert.equal(missingIndicators.length, 1);
        assert.equal(missingIndicators[0].range.start.line, 2);
        assert.equal(missingIndicators[0].range.start.character, 'part_b.key'.length);
        assert.equal(missingIndicators[0].range.end.line, 2);
        assert.equal(missingIndicators[0].range.end.character, 'part_b.key'.length);
        assert.equal(
            missingIndicators[0].hoverMessage,
            i18n.get('includeDecorationMissingLocal', 'part_apart_b.key')
        );
    });

    it('splits missing path styling around comments but keeps one trailing indicator', async () => {
        const doc = fakeDoc('*INCLUDE\npart_a +\n$ skip me\npart_b.key\n', '/project/main.k');
        doc.languageId = 'lsdyna';

        const { missing, missingIndicators } = await collectIncludeDecorationSets(doc);

        assert.equal(missing.length, 2);
        assert.deepEqual(
            missing.map(item => [item.range.start.line, item.range.end.line]),
            [[1, 1], [3, 3]]
        );
        assert.equal(missingIndicators.length, 1);
        assert.equal(missingIndicators[0].range.start.line, 3);
        assert.equal(missingIndicators[0].range.start.character, 'part_b.key'.length);
    });

    it('creates include decorations without consuming the glyph margin', () => {
        const created = [];
        const vscodeApi = {
            Uri: { parse: value => ({ value, toString: () => value }) },
            ThemeColor: function ThemeColor(id) { this.id = id; },
            window: {
                createTextEditorDecorationType(options) {
                    const type = { options, dispose() {} };
                    created.push(type);
                    return type;
                },
            },
        };

        const types = createIncludeDecorationTypes(vscodeApi);

        assert.equal(created.length, 3);
        for (const type of created) {
            assert.equal(type.options.gutterIconPath, undefined);
        }
        assert.equal(types.missingIndicatorDecoration.options.after.contentText, ' \u26A0\uFE0E');
        assert.equal(types.missingIndicatorDecoration.options.after.color.id, 'editorWarning.foreground');
        assert.equal(types.missingIndicatorDecoration.options.after.margin, '0 0 0 0.35em');
        assert.equal(types.missingPathDecoration.options.fontStyle, 'italic');
        assert.equal(types.missingPathDecoration.options.color.id, 'editorWarning.foreground');
    });

    it('rejects stale asynchronous include decoration results', () => {
        const guard = createLatestDocumentRequestGuard();
        const document = {};
        const first = guard.begin(document);
        const second = guard.begin(document);

        assert.equal(guard.isLatest(document, first), false);
        assert.equal(guard.isLatest(document, second), true);
    });

    it('uses only a document link for an existing include and only a warning attachment for a missing one', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-affordance-'));
        const mainFile = path.join(tempRoot, 'main.k');
        const childFile = path.join(tempRoot, 'child.k');
        fs.writeFileSync(childFile, '*KEYWORD\n');

        try {
            const resolvedDoc = fakeDoc('*INCLUDE\nchild.k\n', mainFile);
            resolvedDoc.languageId = 'lsdyna';
            const resolvedDecorations = await collectIncludeDecorationSets(resolvedDoc);
            const resolvedLinks = await collectIncludeDocumentLinks(resolvedDoc);
            assert.equal(resolvedDecorations.resolved.length, 1);
            assert.equal(resolvedDecorations.missing.length, 0);
            assert.equal(resolvedDecorations.missingIndicators.length, 0);
            assert.equal(resolvedLinks.length, 1);

            const missingDoc = fakeDoc('*INCLUDE\nmissing.k\n', mainFile);
            missingDoc.languageId = 'lsdyna';
            const missingDecorations = await collectIncludeDecorationSets(missingDoc);
            const missingLinks = await collectIncludeDocumentLinks(missingDoc);
            assert.equal(missingDecorations.resolved.length, 0);
            assert.equal(missingDecorations.missing.length, 1);
            assert.equal(missingDecorations.missingIndicators.length, 1);
            assert.equal(missingLinks.length, 0);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('skips automatic include document links for very large documents', async () => {
        assert.deepEqual(await collectIncludeDocumentLinks(createHugeDoc()), []);
    });

    it('splits continued include document links around skipped comment lines', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-links-'));
        const includeFile = path.join(tempRoot, 'part_apart_b.key');
        const mainFile = path.join(tempRoot, 'main.k');

        fs.writeFileSync(includeFile, '*KEYWORD\n');
        fs.writeFileSync(mainFile, '*INCLUDE\npart_a +\n$ skip me\npart_b.key\n');

        try {
            const doc = fakeDoc(fs.readFileSync(mainFile, 'utf8'), mainFile);
            const links = await collectIncludeDocumentLinks(doc);

            assert.equal(links.length, 2);
            assert.deepEqual(
                links.map(link => [link.range.start.line, link.range.end.line]),
                [[1, 1], [3, 3]]
            );
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('creates document links for valid *INCLUDE_PATH directories', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-path-link-'));
        const includeDir = path.join(tempRoot, 'includes');
        const mainFile = path.join(tempRoot, 'main.k');
        fs.mkdirSync(includeDir);
        const mainFileContent = `*INCLUDE_PATH\n${includeDir}\n`;
        fs.writeFileSync(mainFile, mainFileContent);

        try {
            const doc = fakeDoc(mainFileContent, mainFile);
            const links = await collectIncludeDocumentLinks(doc);

            assert.equal(links.length, 1);
            const targetText = links[0].target.toString();
            assert.ok(targetText.startsWith('command:extension.revealInExplorer?'));
            assert.equal(path.normalize(decodeCommandUriArgs(links[0].target)[0].resourceUri.fsPath), path.normalize(includeDir));
            assert.equal(links[0].range.start.line, 1);
            assert.equal(links[0].range.start.character, 0);
            assert.equal(links[0].range.end.line, 1);
            assert.equal(links[0].range.end.character, includeDir.length);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('creates document links for continued *INCLUDE_PATH directories', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-continued-path-link-'));
        const includeDir = path.join(tempRoot, 'long-' + 'a'.repeat(50), 'includes');
        const mainFile = path.join(tempRoot, 'main.k');
        fs.mkdirSync(includeDir, { recursive: true });

        const part1 = includeDir.slice(0, 78);
        const part2 = includeDir.slice(78);
        const mainFileContent = `*INCLUDE_PATH\n${part1} +\n${part2}\n`;
        fs.writeFileSync(mainFile, mainFileContent);

        try {
            const doc = fakeDoc(mainFileContent, mainFile);
            const links = await collectIncludeDocumentLinks(doc);

            assert.equal(links.length, 1);
            const targetText = links[0].target.toString();
            assert.ok(targetText.startsWith('command:extension.revealInExplorer?'));
            assert.equal(path.normalize(decodeCommandUriArgs(links[0].target)[0].resourceUri.fsPath), path.normalize(includeDir));
            assert.equal(links[0].range.start.line, 1);
            assert.equal(links[0].range.end.line, 2);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('resolves include document links through continued *INCLUDE_PATH directories', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-path-links-'));
        const includeDir = path.join(tempRoot, 'shared', 'includes');
        const includeFile = path.join(includeDir, 'continued.k');
        const mainFile = path.join(tempRoot, 'main.k');
        fs.mkdirSync(includeDir, { recursive: true });
        fs.writeFileSync(includeFile, '*KEYWORD\n');

        const part1 = includeDir.slice(0, 78);
        const part2 = includeDir.slice(78);
        const mainFileContent = `*INCLUDE_PATH\n${part1} +\n${part2}\n*INCLUDE\ncontinued.k\n`;
        fs.writeFileSync(mainFile, mainFileContent);

        try {
            const doc = fakeDoc(mainFileContent, mainFile);
            const links = await collectIncludeDocumentLinks(doc);
            const includeLink = links.find(link => path.normalize(link.target.fsPath) === path.normalize(includeFile));

            assert.ok(includeLink);
            assert.equal(path.normalize(includeLink.target.fsPath), path.normalize(includeFile));
            assert.equal(includeLink.range.start.line, 4);
            assert.equal(includeLink.range.end.line, 4);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('blocks include document links for casing mismatches in strict mode', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-strict-case-'));
        const realFile = path.join(tempRoot, 'Part.k');
        const mainFile = path.join(tempRoot, 'main.k');
        fs.writeFileSync(realFile, '*KEYWORD\n');
        fs.writeFileSync(mainFile, '*INCLUDE\npart.k\n');

        setResolveIncludeWithCaseCheckForTesting(async () => ({
            status: 'case-mismatch',
            resolvedPath: realFile,
            realPath: realFile,
            diffs: [{ index: 0, deck: 'part.k', disk: 'Part.k' }],
            deckRelative: 'part.k',
            diskRelative: 'Part.k',
        }));

        try {
            const doc = fakeDoc('*INCLUDE\npart.k\n', mainFile);
            doc.languageId = 'lsdyna';
            const strictLinks = await collectIncludeDocumentLinks(doc, { mode: 'strict' });
            const openLinks = await collectIncludeDocumentLinks(doc, { mode: 'crossPlatform' });
            assert.equal(strictLinks.filter(l => l.target && l.target.fsPath).length, 0);
            const norm = (p) => process.platform === 'win32'
                ? path.normalize(p).toLowerCase()
                : path.normalize(p);
            assert.ok(openLinks.some(l => l.target && norm(l.target.fsPath) === norm(realFile)));

            const strictDeco = await collectIncludeDecorationSets(doc, { mode: 'strict' });
            assert.equal(strictDeco.resolved.length, 0);
            assert.ok(strictDeco.missing.length >= 1);
            assert.equal(strictDeco.missingIndicators.length, 1);
        } finally {
            setResolveIncludeWithCaseCheckForTesting(null);
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });


    it('treats very large documents as not being on an include line without scanning', () => {
        assert.equal(isIncludeLine(createHugeDoc(), 10), false);
    });

    it('treats continuation lines as include lines but skips comment gaps', () => {
        const doc = fakeDoc('*INCLUDE\npart_a +\n$ skip me\npart_b.key\n');
        doc.languageId = 'lsdyna';

        assert.equal(isIncludeLine(doc, 1), true);
        assert.equal(isIncludeLine(doc, 2), false);
        assert.equal(isIncludeLine(doc, 3), true);
    });

    it('skips local keyword index refresh for very large documents', async () => {
        const provider = new LsdynaKeywordIndexProvider({ collectIncludeFiles, shouldSkipAutomaticDocumentScan });
        provider.roots = [{ label: 'stale' }];

        await provider.refreshFromDocument(createHugeDoc());

        assert.deepEqual(provider.roots, []);
    });

    it('skips folding ranges for very large documents', () => {
        const provider = new LsDynaFoldingProvider();
        assert.deepEqual(provider.provideFoldingRanges(createHugeDoc()), []);
    });

    it('skips keyword symbols for very large documents', () => {
        const provider = new LsdynaKeywordSymbolProvider();
        assert.deepEqual(provider.provideDocumentSymbols(createHugeDoc()), []);
    });

    it('skips keyword option CodeLens for very large documents', () => {
        const provider = new LsdynaKeywordOptionsCodeLensProvider();
        assert.deepEqual(provider.provideCodeLenses(createHugeDoc()), []);
    });

    it('skips hover work for very large documents', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(createHugeDoc(), { line: 0, character: 0 });
        assert.equal(hover, null);
    });

    it('skips parameter definitions for very large documents', () => {
        assert.equal(findParameterDefinitions(createHugeDoc()).size, 0);
    });

    it('skips parameter references for very large documents', () => {
        assert.deepEqual(findParameterReferences(createHugeDoc()), []);
    });

    it('returns no parameter at cursor for very large documents', () => {
        assert.equal(getParameterAtCursor(createHugeDoc(), { line: 0, character: 0 }), null);
    });
});

// ---------------------------------------------------------------------------
// getParameterAtCursor
// ---------------------------------------------------------------------------

describe('getParameterAtCursor', () => {
    const { Position } = require('./vscode-mock');

    it('detects &name reference', () => {
        const doc = fakeDoc('*KEYWORD\n  &tEnd\n');
        const result = getParameterAtCursor(doc, new Position(1, 3));
        assert.ok(result);
        assert.equal(result.name, 'tEnd');
    });

    it('detects parameter definition name', () => {
        const doc = fakeDoc('*PARAMETER\nR   tEnd   5.0\n');
        const result = getParameterAtCursor(doc, new Position(1, 5));
        assert.ok(result);
        assert.equal(result.name, 'tEnd');
    });

    it('detects bare name reference in *PARAMETER_EXPRESSION value', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*PARAMETER_EXPRESSION\nR  dtPlot  tEnd/100.0\n');
        const result = getParameterAtCursor(doc, new Position(3, 11));
        assert.ok(result);
        assert.equal(result.name.toUpperCase(), 'TEND');
    });

    it('returns null outside any parameter context', () => {
        const doc = fakeDoc('*KEYWORD\nsome data line\n');
        const result = getParameterAtCursor(doc, new Position(1, 3));
        assert.equal(result, null);
    });
});

// ---------------------------------------------------------------------------
// LsdynaFieldHoverProvider
// ---------------------------------------------------------------------------

describe('LsdynaFieldHoverProvider', () => {
    afterEach(() => {
        if (typeof clearReferenceIndexCacheForTesting === 'function') {
            clearReferenceIndexCacheForTesting();
        }
        if (typeof resetFieldHoverQuietStateForTesting === 'function') {
            resetFieldHoverQuietStateForTesting();
        }
    });

    it('lets the user choose and clear a main deck without an automatic prompt', async () => {
        const rootA = path.resolve('pick-case', 'condition-a.k');
        const rootB = path.resolve('pick-case', 'condition-b.k');
        const sharedFile = path.resolve('pick-case', 'shared.k');
        const fileIndex = { parameterEvents: [], referenceDefinitions: { curves: [], tables: [] } };
        for (const rootFile of [rootA, rootB]) {
            cacheReferenceIndexFromSnapshot({
                rootFile,
                files: [rootFile, sharedFile],
                graph: {
                    includeOccurrences: [{
                        occurrenceId: `${rootFile}:shared`,
                        fromFile: rootFile,
                        filePath: sharedFile,
                        fileName: path.basename(sharedFile),
                        keywordLine: 1,
                        lineIndex: 2,
                        keyword: '*INCLUDE',
                    }],
                },
                fileIndexes: new Map([
                    [rootFile, fileIndex],
                    [sharedFile, fileIndex],
                ]),
            });
        }

        const originalShowQuickPick = vscodeMock.window.showQuickPick;
        const originalShowInformationMessage = vscodeMock.window.showInformationMessage;
        let quickPickCalls = 0;
        vscodeMock.window.showInformationMessage = () => Promise.resolve(undefined);
        vscodeMock.window.showQuickPick = async items => {
            quickPickCalls += 1;
            return quickPickCalls === 1
                ? items.find(item => item.rootFile === rootA)
                : items.find(item => item.action === 'clear');
        };
        try {
            assert.equal(
                await handleSelectMainDeckContextCommand({ documentPath: sharedFile }),
                true
            );
            assert.equal(getMainDeckContextForDocumentPath(sharedFile).rootFile, rootA);
            assert.equal(
                await handleSelectMainDeckContextCommand({ documentPath: sharedFile }),
                true
            );
            assert.equal(getMainDeckContextForDocumentPath(sharedFile).state, 'ambiguous');
            assert.equal(quickPickCalls, 2);
        } finally {
            vscodeMock.window.showQuickPick = originalShowQuickPick;
            vscodeMock.window.showInformationMessage = originalShowInformationMessage;
        }
    });

    it('labels a later current-file parameter definition as source information only', async () => {
        const filePath = path.resolve('parameter-hover', 'local-source.k');
        const doc = fakeDoc([
            '*CONTROL_TERMINATION',
            '     &CID',
            '*PARAMETER',
            'I CID 1001',
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';

        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 1, character: 8 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('Current-file source definition'));
        assert.ok(value.includes('`1001`'));
        assert.ok(value.includes('not claimed as the effective value'));
        assert.ok(!value.includes('Effective value in the current main-deck context'));
    });

    it('provides the same local parameter hover from declaration, bare, and ampersand positions', async () => {
        const filePath = path.resolve('parameter-hover', 'all-trigger-positions.k');
        const doc = fakeDoc([
            '*PARAMETER',
            'IAB_CD_EF,7',
            '*PARAMETER_EXPRESSION',
            'IRESULT,AB_CD_EF+1',
            '*CONTROL_TERMINATION',
            '  -&AB_CD_EF',
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';
        const provider = new LsdynaFieldHoverProvider();

        const cases = [
            { position: { line: 1, character: 3 }, text: 'AB_CD_EF' },
            { position: { line: 3, character: 10 }, text: 'AB_CD_EF' },
            { position: { line: 5, character: 5 }, text: '-&AB_CD_EF' },
        ];
        for (const item of cases) {
            const hover = await provider.provideHover(doc, item.position);
            assert.ok(hover, JSON.stringify(item.position));
            assert.ok(hover.contents[0].value.includes('Current-file source definition'));
            assert.ok(hover.contents[0].value.includes('`7`'));
            assert.equal(doc.getText(hover.range), item.text);
        }
    });

    it('keeps an unresolved parameter hover actionable without inventing a definition', async () => {
        const filePath = path.resolve('parameter-hover', 'unresolved.k');
        const doc = fakeDoc('*CONTROL_TERMINATION\n  &UNKNOWN\n', filePath);
        doc.languageId = 'lsdyna';

        const hover = await new LsdynaFieldHoverProvider().provideHover(
            doc,
            { line: 1, character: 5 },
        );
        const value = hover.contents[0].value;

        assert.equal(doc.getText(hover.range), '&UNKNOWN');
        assert.ok(value.includes('UNKNOWN'));
        assert.ok(value.includes('complete project scan is unavailable'));
        assert.ok(!value.includes('Current-file source definition'));
    });

    it('shows an inherited parameter as an effective value in a unique main-deck context', async () => {
        const rootFile = path.resolve('parameter-hover', 'main.k');
        const childFile = path.resolve('parameter-hover', 'child.k');
        const parameterEvent = {
            type: 'definition',
            keyword: '*PARAMETER',
            lineIndex: 1,
            sequence: 0,
            name: 'CID',
            rawName: 'CID',
            parameterType: 'I',
            rawValue: '1001',
            value: 1001,
            valueState: 'integer',
            reason: null,
            local: false,
            mutable: false,
            expression: false,
        };
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, childFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:child',
                    fromFile: rootFile,
                    filePath: childFile,
                    fileName: 'child.k',
                    keywordLine: 3,
                    lineIndex: 4,
                }],
            },
            fileIndexes: new Map([
                [rootFile, {
                    parameterEvents: [parameterEvent],
                    referenceDefinitions: { curves: [], tables: [] },
                }],
                [childFile, {
                    parameterEvents: [],
                    referenceDefinitions: { curves: [], tables: [] },
                }],
            ]),
        });
        const doc = fakeDoc('*CONTROL_TERMINATION\n     &CID\n', childFile);
        doc.languageId = 'lsdyna';

        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 1, character: 8 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('Effective value in the current main-deck context'));
        assert.ok(value.includes('`1001`'));
        assert.ok(!value.includes('Current-file source definition'));
    });

    it('does not present an unresolved parameter expression as an effective numeric value', async () => {
        const filePath = path.resolve('parameter-hover', 'expression.k');
        cacheReferenceIndexFromSnapshot({
            rootFile: filePath,
            files: [filePath],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[filePath, {
                parameterEvents: [{
                    type: 'definition',
                    keyword: '*PARAMETER_EXPRESSION',
                    lineIndex: 1,
                    sequence: 0,
                    name: 'CID',
                    rawName: 'CID',
                    parameterType: 'I',
                    rawValue: '&BASE+1',
                    value: null,
                    valueState: 'unknown',
                    reason: 'parameter-expression-unresolved',
                    local: false,
                    mutable: false,
                    expression: true,
                }],
                referenceDefinitions: { curves: [], tables: [] },
            }]]),
        });
        const doc = fakeDoc([
            '*PARAMETER_EXPRESSION',
            'I CID &BASE+1',
            '*CONTROL_TERMINATION',
            '     &CID',
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';

        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 3, character: 8 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('Current-file source definition'));
        assert.ok(value.includes('`&BASE+1`'));
        assert.ok(value.includes('cannot be determined reliably'));
        assert.ok(!value.includes('Effective value in the current main-deck context:'));
    });

    it('does not borrow a parameter value from either ambiguous main deck', async () => {
        const sharedFile = path.resolve('parameter-hover', 'shared.k');
        for (const [name, parameterValue] of [['a.k', 1001], ['b.k', 2002]]) {
            const rootFile = path.resolve('parameter-hover', name);
            cacheReferenceIndexFromSnapshot({
                rootFile,
                files: [rootFile, sharedFile],
                graph: {
                    includeOccurrences: [{
                        occurrenceId: `${name}:shared`,
                        fromFile: rootFile,
                        filePath: sharedFile,
                        fileName: 'shared.k',
                        keywordLine: 3,
                        lineIndex: 4,
                    }],
                },
                fileIndexes: new Map([
                    [rootFile, {
                        parameterEvents: [{
                            type: 'definition',
                            keyword: '*PARAMETER',
                            lineIndex: 1,
                            sequence: 0,
                            name: 'CID',
                            rawName: 'CID',
                            parameterType: 'I',
                            rawValue: String(parameterValue),
                            value: parameterValue,
                            valueState: 'integer',
                            reason: null,
                            local: false,
                            mutable: false,
                            expression: false,
                        }],
                        referenceDefinitions: { curves: [], tables: [] },
                    }],
                    [sharedFile, {
                        parameterEvents: [],
                        referenceDefinitions: { curves: [], tables: [] },
                    }],
                ]),
            });
        }
        const doc = fakeDoc([
            '*PARAMETER',
            'I CID 3003',
            '*CONTROL_TERMINATION',
            '     &CID',
        ].join('\n'), sharedFile);
        doc.languageId = 'lsdyna';

        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 3, character: 8 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('Current-file source definition'));
        assert.ok(value.includes('`3003`'));
        assert.ok(value.includes('Choose main deck context'));
        assert.ok(!value.includes('Effective value in the current main-deck context'));
        assert.ok(!value.includes('`1001`'));
        assert.ok(!value.includes('`2002`'));
    });

    it('appends quiet-switch links on field hover when enabled', async () => {
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        manualIndexer.getManualLocations = () => [];
        manualIndexer.getManualFilesCount = () => 1;
        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*CONTROL_TERMINATION\n                                                            \n');
            const hover = await provider.provideHover(doc, { line: 1, character: 45 });
            assert.ok(hover);
            const value = hover.contents[0].value;
            assert.ok(value.includes('command:extension.muteFieldHoverSession'));
            assert.ok(value.includes('command:extension.disableFieldHover'));
            assert.ok(value.includes('$(bell-slash)'), 'session quiet uses bell-slash icon');
            assert.ok(value.includes('$(lock)'), 'persistent quiet uses lock icon');
            assert.ok(value.includes(i18n.get('fieldHoverQuietSessionLink')));
            assert.ok(value.includes(i18n.get('fieldHoverDisableGlobalLink')));
            // Short labels in the action row (not the old long footer sentences as visible link text)
            assert.ok(!value.includes('](command:extension.muteFieldHoverSession "现在先关掉'));
            assert.ok(!value.includes('$(eye-closed)'));
            assert.ok(!value.includes('$(circle-slash)'));
        } finally {
            manualIndexer.getManualLocations = originalGetManualLocations;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
        }
    });

    it('suppresses field hover when enableFieldHover is false but keeps keyword hover', async () => {
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        manualIndexer.getManualLocations = () => [];
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => (key === 'enableFieldHover' ? false : defaultValue),
        });
        try {
            const provider = new LsdynaFieldHoverProvider();
            const fieldDoc = fakeDoc('*CONTROL_TERMINATION\n                                                            \n');
            const fieldHover = await provider.provideHover(fieldDoc, { line: 1, character: 45 });
            assert.strictEqual(fieldHover, null);

            const kwDoc = fakeDoc('*NODE\n');
            const kwHover = await provider.provideHover(kwDoc, { line: 0, character: 2 });
            // Keyword line may still produce hover (known keyword or manuals fallback)
            // At minimum must not be blocked solely by field-hover config when manuals empty:
            // if null, ensure it is not because of field gate — field gate only runs on card lines.
            // When manuals empty and keyword known, hover is still returned with help.
            if (kwHover) {
                const value = kwHover.contents[0].value;
                assert.ok(!value.includes('command:extension.muteFieldHoverSession'));
            }
        } finally {
            manualIndexer.getManualLocations = originalGetManualLocations;
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('suppresses field hover when session-muted', async () => {
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        manualIndexer.getManualLocations = () => [];
        setSessionFieldHoverMutedForTesting(true);
        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*CONTROL_TERMINATION\n                                                            \n');
            const hover = await provider.provideHover(doc, { line: 1, character: 45 });
            assert.strictEqual(hover, null);
        } finally {
            manualIndexer.getManualLocations = originalGetManualLocations;
            resetFieldHoverQuietStateForTesting();
        }
    });

    it('preserves embedded help newlines as markdown hard breaks', async () => {
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        manualIndexer.getManualLocations = () => [];

        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*CONTROL_TERMINATION\n                                                            \n');

            const hover = await provider.provideHover(doc, { line: 1, character: 45 });

            assert.ok(hover);
            const value = hover.contents[0].value;
            assert.ok(value.startsWith('### $(symbol-field) <span style="color:var(--vscode-textLink-foreground);">**ENDMAS**</span> *(real)*'));
            assert.ok(value.includes('DT2MS.  \nLT.0.0:'));
            assert.ok(value.includes('**$(table) Card Columns:**'));
            assert.ok(value.includes('**&nbsp;ENDMAS&nbsp;**'));
        } finally {
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });

    it('shows Chinese-primary field help with muted English under zh-cn UI', async () => {
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        manualIndexer.getManualLocations = () => [];
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'language' ? 'zh-cn' : defaultValue,
        });
        i18n.updateLanguage();

        try {
            assert.strictEqual(i18n.getLanguage(), 'zh-cn');
            const provider = new LsdynaFieldHoverProvider();
            // SID at columns 1-10 of *SET_NODE_LIST card 1
            const doc = fakeDoc([
                '*SET_NODE_LIST',
                '         1',
            ].join('\n'));

            const hover = await provider.provideHover(doc, { line: 1, character: 5 });
            assert.ok(hover);
            const value = hover.contents[0].value;

            const zhAt = value.indexOf('节点集');
            const enAt = value.indexOf('Node set ID');
            assert.ok(zhAt >= 0, 'expected Chinese help as primary');
            assert.ok(enAt >= 0, 'expected English help as secondary');
            assert.ok(zhAt < enAt, 'Chinese primary should appear before English secondary');
            assert.ok(
                value.includes('descriptionForeground') || value.includes('opacity:0.72'),
                'expected muted English styling'
            );
            assert.ok(!value.includes('Node set ID.\n节点集'), 'should not leave raw stacked bilingual block as primary-only');
        } finally {
            manualIndexer.getManualLocations = originalGetManualLocations;
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });

    it('keeps English-only field help without muted secondary under en UI', async () => {
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        manualIndexer.getManualLocations = () => [];
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'language' ? 'en' : defaultValue,
        });
        i18n.updateLanguage();

        try {
            assert.strictEqual(i18n.getLanguage(), 'en');
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc([
                '*SET_NODE_LIST',
                '         1',
            ].join('\n'));

            const hover = await provider.provideHover(doc, { line: 1, character: 5 });
            assert.ok(hover);
            const value = hover.contents[0].value;
            assert.ok(value.includes('Node set ID'));
            assert.ok(!value.includes('节点集'));
            assert.ok(!value.includes('opacity:0.72'));
            assert.ok(!value.includes('descriptionForeground'));
        } finally {
            manualIndexer.getManualLocations = originalGetManualLocations;
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });

    it('shows a local curve candidate but keeps the result uncertain until the project is scanned', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-hover-curve-'));
        const filePath = path.join(tempRoot, 'main.k');
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0      1001         0       0.0',
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';

        const fileIndex = {
            filePath,
            referenceDefinitions: {
                curves: [{
                    kind: 'curve',
                    id: 1001,
                    keyword: '*DEFINE_CURVE',
                    filePath,
                    startLine: 10,
                    endLine: 13,
                    points: [
                        { x: 0, y: 400, xRaw: '0', yRaw: '400', lineIndex: 12 },
                        { x: 0.1, y: 450, xRaw: '0.1', yRaw: '450', lineIndex: 13 },
                    ],
                }],
                tables: [],
            },
        };

        try {
            setFileIndexForTesting(filePath, fileIndex);
            const provider = new LsdynaFieldHoverProvider();
            const hover = await provider.provideHover(doc, { line: 4, character: 24 });
            const value = hover.contents[0].value;

            assert.ok(value.includes('**LCSS**'));
            assert.ok(value.includes('LCSS reference'));
            assert.ok(value.includes('*DEFINE_CURVE'));
            assert.ok(value.includes('Current-file candidate'));
            assert.ok(value.includes('command:extension.openLsdynaReferenceDefinition'));
            assert.ok(value.includes('data:image/svg+xml;base64,'));
            assert.ok(value.includes('insufficient to resolve'));
            assert.ok(value.includes('Scan Include Tree'));
            assert.ok(!value.includes('No matching curve/table definition'));
        } finally {
            setFileIndexForTesting(filePath, null);
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('suggests scanning the include tree when a reference field has no cached project index', async () => {
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0      1001         0       0.0',
        ].join('\n'), '/project/main.k');
        doc.languageId = 'lsdyna';

        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 4, character: 24 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('LCSS reference'));
        assert.ok(value.includes('Scan Include Tree'));
    });

    it('shows parameter-controlled LCSS references as uncertain instead of missing', async () => {
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0      &CID         0       0.0',
        ].join('\n'), '/project/parameter-reference.k');
        doc.languageId = 'lsdyna';

        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 4, character: 24 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('`&CID`'));
        assert.ok(value.includes('parameter-controlled'));
        assert.ok(!value.includes('No matching curve/table definition'));
    });

    it('resolves cross-file references from cached project snapshots', async () => {
        const rootFile = path.resolve('model', 'main.k');
        const childFile = path.resolve('model', 'curves.k');
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0      1001         0       0.0',
        ].join('\n'), rootFile);
        doc.languageId = 'lsdyna';

        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, childFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:curves',
                    fromFile: rootFile,
                    filePath: childFile,
                    fileName: 'curves.k',
                    lineIndex: 1,
                    keyword: '*INCLUDE',
                }],
            },
            fileIndexes: new Map([[childFile, {
                referenceDefinitions: {
                    curves: [{
                        kind: 'curve',
                        id: 1001,
                        keyword: '*DEFINE_CURVE',
                        filePath: childFile,
                        startLine: 2,
                        endLine: 4,
                        points: [
                            { x: 0, y: 1, xRaw: '0', yRaw: '1' },
                            { x: 1, y: 2, xRaw: '1', yRaw: '2' },
                        ],
                    }],
                    tables: [],
                },
            }]]),
        });

        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 4, character: 24 });
        const value = hover.contents[0].value;

        assert.ok(value.includes(childFile));
        assert.ok(value.includes('*DEFINE_CURVE'));
        assert.ok(!value.includes('Scan Include Tree'));
    });

    it('resolves an integer parameter reference in the selected main deck', async () => {
        const rootFile = path.resolve('parameter-case', 'main.k');
        const curveFile = path.resolve('parameter-case', 'curves.k');
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0      &CID         0       0.0',
        ].join('\n'), rootFile);
        doc.languageId = 'lsdyna';

        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, curveFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:curves',
                    fromFile: rootFile,
                    filePath: curveFile,
                    fileName: 'curves.k',
                    keywordLine: 5,
                    lineIndex: 6,
                    keyword: '*INCLUDE',
                }],
            },
            fileIndexes: new Map([
                [rootFile, {
                    parameterEvents: [{
                        type: 'definition',
                        keyword: '*PARAMETER',
                        lineIndex: 1,
                        sequence: 0,
                        name: 'CID',
                        rawName: 'CID',
                        parameterType: 'I',
                        rawValue: '1001',
                        value: 1001,
                        valueState: 'integer',
                        reason: null,
                        local: false,
                        mutable: false,
                        expression: false,
                    }],
                    referenceDefinitions: { curves: [], tables: [] },
                }],
                [curveFile, {
                    parameterEvents: [],
                    referenceDefinitions: {
                        curves: [{
                            kind: 'curve',
                            id: 1001,
                            keyword: '*DEFINE_CURVE',
                            filePath: curveFile,
                            startLine: 1,
                            endLine: 3,
                            points: [],
                        }],
                        tables: [],
                    },
                }],
            ]),
        });

        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 4, character: 24 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('evaluates this to ID `1001`'));
        assert.ok(value.includes(curveFile));
        assert.ok(!value.includes('parameter-controlled and parameters have not been evaluated'));
        assert.ok(!value.includes('Scan Include Tree'));
    });

    it('does not borrow definitions from an arbitrary main deck for a shared child file', async () => {
        const rootA = path.resolve('multi-case', 'condition-a.k');
        const rootB = path.resolve('multi-case', 'condition-b.k');
        const sharedFile = path.resolve('multi-case', 'shared-material.k');
        const curveA = path.resolve('multi-case', 'curves-a.k');
        const curveB = path.resolve('multi-case', 'curves-b.k');
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0      1001         0       0.0',
        ].join('\n'), sharedFile);
        doc.languageId = 'lsdyna';

        function cacheCondition(rootFile, curveFile, curveId) {
            cacheReferenceIndexFromSnapshot({
                rootFile,
                files: [rootFile, sharedFile, curveFile],
                graph: {
                    includeOccurrences: [
                        {
                            occurrenceId: `${rootFile}:shared`,
                            fromFile: rootFile,
                            filePath: sharedFile,
                            fileName: path.basename(sharedFile),
                            keywordLine: 1,
                            lineIndex: 2,
                            keyword: '*INCLUDE',
                        },
                        {
                            occurrenceId: `${rootFile}:curves`,
                            fromFile: rootFile,
                            filePath: curveFile,
                            fileName: path.basename(curveFile),
                            keywordLine: 3,
                            lineIndex: 4,
                            keyword: '*INCLUDE',
                        },
                    ],
                },
                fileIndexes: new Map([
                    [rootFile, { parameterEvents: [], referenceDefinitions: { curves: [], tables: [] } }],
                    [sharedFile, { parameterEvents: [], referenceDefinitions: { curves: [], tables: [] } }],
                    [curveFile, {
                        parameterEvents: [],
                        referenceDefinitions: {
                            curves: [{
                                kind: 'curve',
                                id: curveId,
                                keyword: '*DEFINE_CURVE',
                                filePath: curveFile,
                                startLine: 1,
                                endLine: 3,
                                points: [],
                            }],
                            tables: [],
                        },
                    }],
                ]),
            });
        }

        cacheCondition(rootA, curveA, 1001);
        cacheCondition(rootB, curveB, 2002);

        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 4, character: 24 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('multiple main decks'));
        assert.ok(value.includes('Choose main deck context'));
        assert.ok(!value.includes(curveA));
        assert.ok(!value.includes(curveB));
        assert.ok(!value.includes('No matching curve/table definition'));

        assert.equal(setMainDeckContextForDocument(sharedFile, rootA), true);
        const selectedA = getMainDeckContextForDocumentPath(sharedFile);
        assert.equal(selectedA.state, 'selected');
        assert.equal(selectedA.rootFile, rootA);
        const hoverA = await provider.provideHover(doc, { line: 4, character: 24 });
        const valueA = hoverA.contents[0].value;
        assert.ok(valueA.includes('Current main deck context'));
        assert.ok(valueA.includes(path.basename(rootA)));
        assert.ok(valueA.includes(curveA));
        assert.ok(!valueA.includes(curveB));

        assert.equal(setMainDeckContextForDocument(sharedFile, rootB), true);
        const docB = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0      2002         0       0.0',
        ].join('\n'), sharedFile);
        docB.languageId = 'lsdyna';
        const hoverB = await provider.provideHover(docB, { line: 4, character: 24 });
        const valueB = hoverB.contents[0].value;
        assert.ok(valueB.includes(path.basename(rootB)));
        assert.ok(valueB.includes(curveB));
        assert.ok(!valueB.includes(curveA));

        assert.equal(clearMainDeckContextForDocument(sharedFile), true);
        assert.equal(getMainDeckContextForDocumentPath(sharedFile).state, 'ambiguous');
    });

    it('drops a selected main deck when that root cache is invalidated', () => {
        const rootA = path.resolve('multi-case', 'condition-a.k');
        const rootB = path.resolve('multi-case', 'condition-b.k');
        const sharedFile = path.resolve('multi-case', 'shared-material.k');
        const emptyIndex = { parameterEvents: [], referenceDefinitions: { curves: [], tables: [] } };
        for (const rootFile of [rootA, rootB]) {
            cacheReferenceIndexFromSnapshot({
                rootFile,
                files: [rootFile, sharedFile],
                graph: {
                    includeOccurrences: [{
                        occurrenceId: `${rootFile}:shared`,
                        fromFile: rootFile,
                        filePath: sharedFile,
                        fileName: path.basename(sharedFile),
                        keywordLine: 1,
                        lineIndex: 2,
                        keyword: '*INCLUDE',
                    }],
                },
                fileIndexes: new Map([
                    [rootFile, emptyIndex],
                    [sharedFile, emptyIndex],
                ]),
            });
        }

        assert.equal(setMainDeckContextForDocument(sharedFile, rootA), true);
        assert.equal(getMainDeckContextForDocumentPath(sharedFile).state, 'selected');
        cacheReferenceIndexFromSnapshot({
            rootFile: rootA,
            files: [rootA, sharedFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: `${rootA}:shared-refreshed`,
                    fromFile: rootA,
                    filePath: sharedFile,
                    fileName: path.basename(sharedFile),
                    keywordLine: 1,
                    lineIndex: 2,
                    keyword: '*INCLUDE',
                }],
            },
            fileIndexes: new Map([
                [rootA, emptyIndex],
                [sharedFile, emptyIndex],
            ]),
        });
        assert.equal(getMainDeckContextForDocumentPath(sharedFile).state, 'selected');
        assert.equal(clearReferenceIndexForRoot(rootA), true);
        const remaining = getMainDeckContextForDocumentPath(sharedFile);
        assert.equal(remaining.state, 'unique');
        assert.equal(remaining.rootFile, rootB);
    });

    it('resolves _TITLE suffix title and data lines through keyword schema', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc('*MAT_001_TITLE\nSteel\n$      MID|       RO|\n    100000    2.7E-9\n');

        const titleHover = await provider.provideHover(doc, { line: 1, character: 2 });
        assert.ok(titleHover);
        assert.ok(titleHover.contents[0].value.includes('**TITLE**'));
        assert.ok(titleHover.contents[0].value.includes('Additional title line'));

        // Hovering on comment line (line 2) should return null
        const commentHover = await provider.provideHover(doc, { line: 2, character: 2 });
        assert.strictEqual(commentHover, null);

        // Hovering on data line (line 3) for character 5 (MID field, width 10)
        const dataHover = await provider.provideHover(doc, { line: 3, character: 5 });
        assert.ok(dataHover);
        assert.ok(dataHover.contents[0].value.includes('<span style="color:var(--vscode-badge-foreground);background-color:var(--vscode-badge-background);">**&nbsp;MID&nbsp;**</span>'));
    });

    it('previews TITLE-variant local LCSS candidates before the project is scanned', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-hover-title-curve-'));
        const filePath = path.join(tempRoot, 'main.k');
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY_TITLE',
            'Material Title',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0         1         0       0.0',
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';

        const fileIndex = {
            filePath,
            referenceDefinitions: {
                curves: [{
                    kind: 'curve',
                    id: 1,
                    keyword: '*DEFINE_CURVE',
                    filePath,
                    startLine: 10,
                    endLine: 13,
                    points: [
                        { x: 0, y: 400, xRaw: '0', yRaw: '400', lineIndex: 12 },
                        { x: 0.1, y: 450, xRaw: '0.1', yRaw: '450', lineIndex: 13 },
                    ],
                }],
                tables: [],
            },
        };

        try {
            setFileIndexForTesting(filePath, fileIndex);
            const provider = new LsdynaFieldHoverProvider();
            const hover = await provider.provideHover(doc, { line: 5, character: 24 });
            const value = hover.contents[0].value;

            assert.ok(value.includes('**LCSS**'));
            assert.ok(value.includes('LCSS reference'));
            assert.ok(value.includes('*DEFINE_CURVE'));
            assert.ok(value.includes('Current-file candidate'));
            assert.ok(value.includes('command:extension.openLsdynaReferenceDefinition'));
            assert.ok(value.includes('Scan Include Tree'));
            assert.ok(value.includes('data:image/svg+xml;base64,'));
        } finally {
            setFileIndexForTesting(filePath, null);
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('prepends curve definition preview when hovering on *DEFINE_CURVE definition keyword line', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-hover-def-curve-'));
        const filePath = path.join(tempRoot, 'main.k');
        const doc = fakeDoc([
            '*DEFINE_CURVE_TITLE',
            'My Curve Title',
            '      1001         0       1.0       1.0       0.0       0.0',
            '       0.0     400.0',
            '       0.1     450.0',
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';

        const fileIndex = {
            filePath,
            referenceDefinitions: {
                curves: [{
                    kind: 'curve',
                    id: 1001,
                    keyword: '*DEFINE_CURVE_TITLE',
                    filePath,
                    startLine: 0,
                    endLine: 4,
                    title: 'My Curve Title',
                    points: [
                        { x: 0, y: 400, xRaw: '0.0', yRaw: '400.0', lineIndex: 3 },
                        { x: 0.1, y: 450, xRaw: '0.1', yRaw: '450.0', lineIndex: 4 },
                    ],
                }],
                tables: [],
            },
        };

        try {
            setFileIndexForTesting(filePath, fileIndex);
            const provider = new LsdynaFieldHoverProvider();
            // Hover directly on line 0 (the *DEFINE_CURVE_TITLE keyword line)
            const hover = await provider.provideHover(doc, { line: 0, character: 5 });
            assert.ok(hover);
            const value = hover.contents[0].value;

            // Assert it contains both the graph preview and the keyword documentation
            assert.ok(value.includes('### $(graph-line) **\\*DEFINE_CURVE_TITLE (ID: 1001)** - _My Curve Title_'));
            assert.ok(value.includes('data:image/svg+xml;base64,'));
            assert.ok(value.includes('**\\*DEFINE_CURVE')); // Manual/help text
        } finally {
            setFileIndexForTesting(filePath, null);
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('resolves CONTACT optional card fields by data line count', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base card 1',
            'base card 2',
            'base card 3',
            'optional card A',
            'optional card B',
            'optional card C',
            'optional card D',
            'optional card E',
            'optional card F',
            ''
        ].join('\n'));

        const hover = await provider.provideHover(doc, { line: 9, character: 2 });
        assert.ok(hover);
        assert.ok(hover.contents[0].value.includes('**PSTIFF**'));
    });

    it('adds keyword actions to keyword hovers with their explicit line target', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc([
            '*NODE',
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
        ].join('\n'));

        const ordinaryHover = await provider.provideHover(doc, { line: 0, character: 3 });
        const optionHover = await provider.provideHover(doc, { line: 1, character: 3 });

        assert.ok(ordinaryHover);
        assert.ok(optionHover);
        const ordinaryValue = ordinaryHover.contents[0].value;
        const optionValue = optionHover.contents[0].value;
        assert.ok(ordinaryValue.includes('command:extension.selectKeyword?%5B0%5D'));
        assert.ok(ordinaryValue.includes('command:extension.lsdynaFormatSelection?%5B0%5D'));
        assert.ok(!ordinaryValue.includes('command:extension.lsdynaChooseKeywordOptions'));
        assert.ok(optionValue.includes('command:extension.selectKeyword?%5B1%5D'));
        assert.ok(optionValue.includes('command:extension.lsdynaFormatSelection?%5B1%5D'));
        assert.ok(optionValue.includes('command:extension.lsdynaChooseKeywordOptions?%5B1%5D'));
    });

    it('returns custom hover actions for existing include files', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-hover-test-'));
        const includeFile = path.join(tempRoot, 'sub.key');
        const mainFile = path.join(tempRoot, 'main.k');

        fs.writeFileSync(includeFile, '*KEYWORD\n');
        fs.writeFileSync(mainFile, '*INCLUDE\nsub.key\n');

        try {
            const doc = fakeDoc(fs.readFileSync(mainFile, 'utf8'), mainFile);
            doc.languageId = 'lsdyna';
            const provider = new LsdynaFieldHoverProvider();

            // Hovering over 'sub.key' on line 1, character 3
            const hover = await provider.provideHover(doc, { line: 1, character: 3 });

            assert.ok(hover);
            assert.strictEqual(hover.contents[0].supportThemeIcons, true);
            assert.ok(hover.contents[0].value.includes('extension.openIncludeNewTab'));
            assert.ok(hover.contents[0].value.includes('extension.openIncludeSplit'));
            assert.ok(hover.contents[0].value.includes('extension.openIncludeFolder'));
            assert.ok(hover.contents[0].value.includes('"' + i18n.get('openNewTab') + '"'));
            assert.ok(hover.contents[0].value.includes('"' + i18n.get('openSplit') + '"'));
            assert.ok(hover.contents[0].value.includes('"' + i18n.get('openFolder') + '"'));
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('falls back to default field hover for non-existent include files', async () => {
        const doc = fakeDoc('*INCLUDE\nmissing_file.key\n', '/project/main.k');
        doc.languageId = 'lsdyna';
        const provider = new LsdynaFieldHoverProvider();

        const hover = await provider.provideHover(doc, { line: 1, character: 3 });
        assert.ok(hover);
        assert.ok(hover.contents[0].value.includes('<span style="color:var(--vscode-badge-foreground);background-color:var(--vscode-badge-background);">**&nbsp;FILENAME&nbsp;**</span>'));
    });

    it('prefers the structured chapter over live PDF bookmarks on keyword and field hovers', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        const manualId = 'keyword-vol-ii-material-models';
        const tempRoot = createRuntimeManualPack({
            sections: [{
                manualId,
                sectionId: 'control-termination',
                level: 2,
                titleEn: '*CONTROL_TERMINATION',
                titleZh: '终止控制',
                anchors: ['control-termination'],
                pathEn: 'documents/en/vol-ii/control-termination.md',
                pathZh: 'documents/zh/vol-ii/control-termination.md',
                pdfPage: 1881,
            }],
            keywords: {
                '*CONTROL_TERMINATION': {
                    manualId,
                    sectionId: 'control-termination',
                    anchorId: 'control-termination',
                    pdfPage: 1881,
                },
            },
        });
        const noisyPdf = path.join(tempRoot, 'old-version.pdf');
        let liveBookmarkReads = 0;
        
        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? tempRoot : undefined
        });
        manualIndexer.getManualFilesCount = () => {
            liveBookmarkReads++;
            return 1;
        };
        manualIndexer.getManualLocations = () => {
            liveBookmarkReads++;
            return [
                { file: noisyPdf, page: 1881 },
                { file: noisyPdf, page: 3998 },
            ];
        };

        try {
            const provider = new LsdynaFieldHoverProvider();
            
            // Hovering over keyword line *CONTROL_TERMINATION
            const doc = fakeDoc('*CONTROL_TERMINATION\n');
            const kwHover = await provider.provideHover(doc, { line: 0, character: 3 });
            assert.ok(kwHover);
            assert.strictEqual(kwHover.contents[0].supportThemeIcons, true);
            assert.ok(kwHover.contents[0].value.includes('[$(file-pdf) PDF · Vol II · P1881](command:extension.manual.openPackChapter?'));
            assert.ok(kwHover.contents[0].value.includes(`[$(book) ${i18n.get('manualReaderBilingual')}](command:extension.manual.openPackChapter?`));
            assert.ok(kwHover.contents[0].value.includes(
                i18n.get(
                    'openPdfManualLocation',
                    'LS-DYNA dev Keyword Manual Vol II - Material Models',
                    i18n.get('page', 1881),
                )
            ));
            assert.ok(!kwHover.contents[0].value.includes('P3998'));
            assert.ok(!kwHover.contents[0].value.includes('PDF ×'));
            assert.ok(kwHover.contents[0].value.includes('**\\*CONTROL_TERMINATION**'));
            assert.ok(!kwHover.contents[0].value.includes('&nbsp;&nbsp; **\\*CONTROL_TERMINATION**'));

            // Hovering over field line ENDENG under *CONTROL_TERMINATION
            const docField = fakeDoc('*CONTROL_TERMINATION\n                                                            \n');
            const fieldHover = await provider.provideHover(docField, { line: 1, character: 35 });
            assert.ok(fieldHover);
            assert.strictEqual(fieldHover.contents[0].supportThemeIcons, true);
            assert.ok(fieldHover.contents[0].value.includes('[$(file-pdf) PDF · Vol II · P1881](command:extension.manual.openPackChapter?'));
            assert.ok(fieldHover.contents[0].value.includes(`[$(book) ${i18n.get('manualReaderBilingual')}](command:extension.manual.openPackChapter?`));
            assert.ok(!fieldHover.contents[0].value.includes('**\\*CONTROL_TERMINATION**'));
            // Quiet controls share the manual action row (same line group as PDF)
            const fieldValue = fieldHover.contents[0].value;
            assert.ok(fieldValue.includes('command:extension.muteFieldHoverSession'));
            assert.ok(fieldValue.includes('$(bell-slash)'));
            assert.ok(fieldValue.includes(' &nbsp;·&nbsp; '));
            // Keyword hover must not get field-quiet controls
            assert.ok(!kwHover.contents[0].value.includes('command:extension.muteFieldHoverSession'));
            assert.strictEqual(liveBookmarkReads, 0);

        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('labels approximate manual fallbacks and keeps the original keyword in reader links', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        const manualId = 'keyword-vol-ii-material-models';
        const tempRoot = createRuntimeManualPack({
            sections: [{
                manualId,
                sectionId: 'some',
                level: 2,
                titleEn: '*SOME',
                titleZh: '示例章节',
                anchors: ['some'],
                pathEn: 'documents/en/vol-ii/some.md',
                pathZh: 'documents/zh/vol-ii/some.md',
                pdfPage: 90,
            }],
            keywords: {
                '*SOME': {
                    manualId,
                    sectionId: 'some',
                    anchorId: 'some',
                    pdfPage: 90,
                },
            },
        });
        const pdfFile = path.join(tempRoot, 'legacy.pdf');
        const requestedKeyword = '*SOME_UNUSUAL_KEYWORD';

        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? tempRoot : undefined
        });
        manualIndexer.getManualFilesCount = () => 1;
        manualIndexer.getManualLocations = (kw) => kw === requestedKeyword
            ? [{
                file: pdfFile,
                page: 87,
                requestedKeyword,
                matchedKeyword: '*SOME',
                matchKind: 'approximate',
            }]
            : [];

        try {
            const provider = new LsdynaFieldHoverProvider();
            const hover = await provider.provideHover(
                fakeDoc(`${requestedKeyword}\n`),
                { line: 0, character: 3 }
            );
            assert.ok(hover);
            const value = hover.contents[0].value;
            const readerArgs = encodeURIComponent(JSON.stringify([
                requestedKeyword, manualId, 'some', 'reader',
            ]));

            assert.ok(value.includes(i18n.get('manualApproximateMatch', '*SOME')));
            assert.ok(value.includes(`command:extension.manual.openPackChapter?${readerArgs}`));
            assert.ok(value.includes('[$(file-pdf) PDF · Vol II · P90](command:extension.manual.openPackChapter?'));
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('does not warn for a schema-backed manual section match', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        const requestedKeyword = '*MAT_024_LOG_INTERPOLATION';

        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? 'd:/manuals' : undefined
        });
        manualIndexer.getManualFilesCount = () => 1;
        manualIndexer.getManualLocations = (kw) => kw === requestedKeyword
            ? [{
                file: 'd:/manuals/LS-DYNA Keyword Manual Vol II.pdf',
                page: 87,
                requestedKeyword,
                matchedKeyword: '*MAT_024',
                matchKind: 'section',
            }]
            : [];

        try {
            const provider = new LsdynaFieldHoverProvider();
            const hover = await provider.provideHover(
                fakeDoc(`${requestedKeyword}\n`),
                { line: 0, character: 3 }
            );
            assert.ok(hover);
            const value = hover.contents[0].value;
            assert.ok(!value.includes(i18n.get('manualApproximateMatch', '*MAT_024')));
            assert.ok(value.includes('[$(file-pdf) PDF · P87](command:extension.openManual?'));
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });

    it('collapses multiple PDF matches into one picker action', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;

        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? 'd:/manuals' : undefined
        });
        manualIndexer.getManualFilesCount = () => 2;
        manualIndexer.getManualLocations = (kw) => kw === '*DEFINE_TRANSFORMATION'
            ? [
                { file: 'd:/manuals/LS-DYNA Keyword Manual Vol I.pdf', page: 2601 },
                { file: 'd:/manuals/LS-DYNA Keyword Manual Vol II.pdf', page: 184 },
            ]
            : [];

        try {
            const provider = new LsdynaFieldHoverProvider();
            const hover = await provider.provideHover(fakeDoc('*DEFINE_TRANSFORMATION\n'), { line: 0, character: 3 });
            const value = hover.contents[0].value;

            assert.ok(value.includes(`[$(file-pdf) ${i18n.get('pdfChooseBookmark')}](command:extension.manual.pickPdfLocation?`));
            assert.ok(!value.includes('command:extension.openManual?'));
            assert.ok(!value.includes('PDF ×'));
            assert.ok(!value.includes('LS-DYNA Keyword Manual Vol I'));
            assert.ok(!value.includes('LS-DYNA Keyword Manual Vol II'));
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });

    it('displays fallback hover with manual links for keywords missing in field_data.json but present in PDF bookmarks', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        
        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? 'd:/manuals' : undefined
        });
        manualIndexer.getManualFilesCount = () => 1;
        // Mock a keyword that is NOT in field_data.json but is in the manuals
        manualIndexer.getManualLocations = (kw) => {
            if (kw === '*SOME_UNUSUAL_KEYWORD') {
                return [{ file: 'd:/manuals/Vol III.pdf', page: 99 }];
            }
            return [];
        };

        try {
            const provider = new LsdynaFieldHoverProvider();
            
            // Hovering over keyword line *SOME_UNUSUAL_KEYWORD.
            // Keyword title is omitted on purpose: diagnosis already shows
            // "未知*… ⓘ" / "Unknown *… ⓘ"; hover only adds manuals + actions.
            const doc = fakeDoc('*SOME_UNUSUAL_KEYWORD\n');
            const hover = await provider.provideHover(doc, { line: 0, character: 3 });
            assert.ok(hover);
            assert.strictEqual(hover.contents[0].supportThemeIcons, true);
            assert.ok(!hover.contents[0].value.includes('**\\*SOME_UNUSUAL_KEYWORD**'), hover.contents[0].value);
            assert.ok(hover.contents[0].value.includes('command:extension.openManual'));
            assert.ok(hover.contents[0].value.includes('Vol III (' + i18n.get('page', 99) + ')'));
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });

    it('displays configure prompt hover on unrecognized keyword when manualsDir is not configured', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        
        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? '' : undefined
        });
        manualIndexer.getManualFilesCount = () => 0;

        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*UNRECOGNIZED_KEYWORD\n');
            const hover = await provider.provideHover(doc, { line: 0, character: 3 });
            assert.ok(hover);
            assert.ok(hover.contents[0].value.includes(i18n.get('manualDirNotConfigured')));
            assert.ok(hover.contents[0].value.includes('command:extension.configureManualsDir'));
            const expectedGuide = hover.contents[0].value.includes('未设置手册路径')
                ? 'README_zh.md#手册集成设置'
                : 'README.md#manual-integration-setup';
            assert.ok(hover.contents[0].value.includes(expectedGuide), hover.contents[0].value);
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
        }
    });

    it('offers add-to-custom-list hover on unrecognized keyword even when manuals are missing', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        const originalGetManualLocations = manualIndexer.getManualLocations;

        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? 'some/dir' : undefined
        });
        manualIndexer.getManualFilesCount = () => 1;
        manualIndexer.getManualLocations = () => [];

        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*UNRECOGNIZED_KEYWORD\n');
            const hover = await provider.provideHover(doc, { line: 0, character: 3 });
            assert.ok(hover);
            const value = hover.contents[0].value;
            assert.ok(!value.includes('**\\*UNRECOGNIZED_KEYWORD**'));
            assert.ok(!value.includes('>ⓘ</span>'));
            assert.ok(value.includes('command:extension.addCustomValidKeyword'));
            assert.ok(!value.includes('command:extension.manageCustomValidKeywords'));
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });

    it('embeds closest-keyword help for CONTACT option-order typo without treating typed name as known', async () => {
        // CONTACT_..._ID_OFFSET is not in schema; closest legal form is ..._OFFSET_ID (option permutation).
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc('*CONTACT_TIED_SHELL_EDGE_TO_SURFACE_ID_OFFSET\n');
        const hover = await provider.provideHover(doc, { line: 0, character: 3 });
        assert.ok(hover);
        const value = hover.contents[0].value;
        assert.ok(value.includes('command:extension.addCustomValidKeyword'), value);
        assert.ok(!value.includes('**\\*CONTACT_TIED_SHELL_EDGE_TO_SURFACE_ID_OFFSET**'), value);
        // High-confidence option permutation → embed help for OFFSET_ID (not the typed name as known).
        assert.ok(value.includes('CONTACT_TIED_SHELL_EDGE_TO_SURFACE_OFFSET_ID'), value);
        assert.ok(value.includes('| Card |'), value);
        assert.ok(!value.includes('>ⓘ</span>'), value);
    });

    it('embeds closest-keyword help on high-confidence typo hover', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc('*LOAD_BODY_Z1\n');
        const hover = await provider.provideHover(doc, { line: 0, character: 3 });
        assert.ok(hover);
        const value = hover.contents[0].value;
        assert.ok(value.includes('LOAD_BODY_Z'), value);
        assert.ok(value.includes('| Card |'), 'expected embedded help table for LOAD_BODY_Z');
        assert.ok(value.includes('command:extension.addCustomValidKeyword'), value);
        assert.ok(!value.includes('**\\*LOAD_BODY_Z1**'), value);
        assert.ok(!value.includes('>ⓘ</span>'), value);
    });

    it('embeds user-picked similar keyword help after medium picker choice', async () => {
        const { rememberSimilarKeywordChoice } = extensionModule._internals;
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc('*ZZZ_NOISE_KEYWORD_QQQ\n');
        // Force a remembered pick even when auto-suggest is empty.
        rememberSimilarKeywordChoice(doc, 0, 'ZZZ_NOISE_KEYWORD_QQQ', 'LOAD_BODY_Z');
        const hover = await provider.provideHover(doc, { line: 0, character: 3 });
        assert.ok(hover);
        const value = hover.contents[0].value;
        assert.ok(value.includes('LOAD_BODY_Z'), value);
        assert.ok(value.includes('| Card |'), value);
        assert.ok(!value.includes('**\\*ZZZ_NOISE_KEYWORD_QQQ**'), value);
    });

    it('resolves field hover from high-confidence similar keyword under a typo block', async () => {
        const provider = new LsdynaFieldHoverProvider();
        // LOAD_BODY_Z1 is unknown; first data card fields match LOAD_BODY_Z (LCID, SF, ...)
        const doc = fakeDoc([
            '*LOAD_BODY_Z1',
            '$#    lcid        sf    lciddr        xc        yc        zc       cid',
            '   1000001 9806.0000',
        ].join('\n'));

        // character ~3 is in LCID (cols 0-9)
        const hover = await provider.provideHover(doc, { line: 2, character: 3 });
        assert.ok(hover, 'expected field hover via similar keyword');
        const value = hover.contents[0].value;
        assert.ok(value.includes('**LCID**') || value.includes('LCID'), value);
        assert.ok(
            value.includes(i18n.get('unknownKeywordFieldHelpFromSimilar', 'LOAD_BODY_Z', 'LOAD_BODY_Z1')),
            value
        );
        assert.ok(value.includes(i18n.get('unknownKeywordSuggestStillUnknown')), value);
        const infoEnd = value.indexOf('>ⓘ</span>');
        assert.ok(infoEnd > 0, value);
        assert.ok(value.indexOf(i18n.get('unknownKeywordHoverHint')) < infoEnd, value);
        assert.ok(value.indexOf(i18n.get('unknownKeywordFieldHelpFromSimilar', 'LOAD_BODY_Z', 'LOAD_BODY_Z1')) < infoEnd, value);
        assert.ok(value.indexOf(i18n.get('unknownKeywordSuggestStillUnknown')) < infoEnd, value);
        assert.ok(!value.includes('$(lightbulb)'), value);
        assert.ok(
            value.includes('<span style="color:var(--vscode-badge-foreground);background-color:var(--vscode-badge-background);">**&nbsp;LCID&nbsp;**</span>'),
            value
        );
    });

    it('resolves field hover from user-picked similar keyword under an unknown block', async () => {
        const { rememberSimilarKeywordChoice } = extensionModule._internals;
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc([
            '*ZZZ_NOISE_KEYWORD_QQQ',
            '$#    lcid        sf    lciddr        xc        yc        zc       cid',
            '   1000001 9806.0000',
        ].join('\n'));
        rememberSimilarKeywordChoice(doc, 0, 'ZZZ_NOISE_KEYWORD_QQQ', 'LOAD_BODY_Z');

        const hover = await provider.provideHover(doc, { line: 2, character: 3 });
        assert.ok(hover);
        const value = hover.contents[0].value;
        assert.ok(value.includes('LCID'), value);
        assert.ok(value.includes('LOAD_BODY_Z'), value);
        assert.ok(
            value.includes(i18n.get('unknownKeywordFieldHelpFromSimilar', 'LOAD_BODY_Z', 'ZZZ_NOISE_KEYWORD_QQQ')),
            value
        );
        const infoEnd = value.indexOf('>ⓘ</span>');
        assert.ok(infoEnd > 0, value);
        assert.ok(value.indexOf(i18n.get('unknownKeywordFieldHelpFromSimilar', 'LOAD_BODY_Z', 'ZZZ_NOISE_KEYWORD_QQQ')) < infoEnd, value);
        assert.ok(!value.includes('$(lightbulb)'), value);
    });

    it('hides bottom manual section when manualsDir is configured but no manuals found for recognized keyword', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        const originalGetManualLocations = manualIndexer.getManualLocations;

        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? 'some/dir' : undefined
        });
        manualIndexer.getManualFilesCount = () => 1;
        manualIndexer.getManualLocations = () => [];

        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*CONTROL_TERMINATION\n');
            const hover = await provider.provideHover(doc, { line: 0, character: 3 });
            assert.ok(hover);
            assert.ok(!hover.contents[0].value.includes('command:extension.openManual'));
            assert.ok(!hover.contents[0].value.includes('command:extension.configureManualsDir'));
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });
});

describe('structured manual chapter actions', () => {
    let originalGetConfiguration;
    let originalGetManualLocations;
    let originalGetManualFilesCount;
    const manualIndexer = require('../src/core/manualIndexer');

    beforeEach(() => {
        originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        originalGetManualLocations = manualIndexer.getManualLocations;
        originalGetManualFilesCount = manualIndexer.getManualFilesCount;
    });

    afterEach(() => {
        vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        manualIndexer.getManualLocations = originalGetManualLocations;
        manualIndexer.getManualFilesCount = originalGetManualFilesCount;
    });

    it('uses authoritative pack pages and exposes only real chapter collisions', () => {
        const manualId = 'keyword-vol-ii-material-models';
        const location = (sectionId, pdfPage) => ({
            manualId,
            sectionId,
            anchorId: sectionId,
            pdfPage,
        });
        const section = (sectionId, titleEn, titleZh, pdfPage) => ({
            manualId,
            sectionId,
            level: 2,
            titleEn,
            titleZh,
            anchors: [sectionId],
            pathEn: `documents/en/vol-ii/${sectionId}.md`,
            pathZh: `documents/zh/vol-ii/${sectionId}.md`,
            pdfPage,
        });
        const root = createRuntimeManualPack({
            sections: [
                section('control-termination', '*CONTROL_TERMINATION', '终止控制', 1881),
                section('contact', '*CONTACT', '接触总览', 1117),
                section('mat-024', 'MAT_024/MAT_PIECEWISE_LINEAR_PLASTICITY', '材料 024', 356),
                section('mat-160', 'MAT_160/MAT_ALE_INCOMPRESSIBLE', '不可压缩 ALE 材料 160', 1198),
                section('mat-ale-05', 'MAT_ALE_05/MAT_ALE_INCOMPRESSIBLE', '不可压缩 ALE 材料 05', 2147),
            ],
            keywords: {
                '*CONTROL_TERMINATION': location('control-termination', 1881),
                '*CONTACT': location('contact', 1117),
                '*MAT_024': location('mat-024', 356),
                '*MAT_ALE_INCOMPRESSIBLE': {
                    ...location('mat-160', 1198),
                    alternateLocations: [location('mat-ale-05', 2147)],
                },
            },
        });
        const readFiles = [];
        const originalReadFileSync = fs.readFileSync;

        vscodeMock.workspace.getConfiguration = () => ({
            get: key => key === 'manualsDir' ? root : undefined,
        });
        manualIndexer.getManualLocations = () => {
            throw new Error('structured hover must not consult live PDF bookmarks');
        };
        manualIndexer.getManualFilesCount = () => {
            throw new Error('structured hover must not count live PDF files');
        };
        fs.readFileSync = function (...args) {
            readFiles.push(String(args[0]));
            return originalReadFileSync.apply(this, args);
        };

        try {
            const render = keyword => {
                const md = new vscodeMock.MarkdownString();
                appendManualLinks(md, keyword);
                return md.value;
            };

            const termination = render('*CONTROL_TERMINATION');
            assert.ok(termination.includes('PDF · Vol II · P1881'));
            assert.ok(!termination.includes('P3998'));

            const contact = render('*CONTACT');
            assert.ok(contact.includes('PDF · Vol II · P1117'));
            assert.ok(!contact.includes(i18n.get('pdfChooseChapter')));

            const mat024 = render('*MAT_024');
            assert.ok(mat024.includes('PDF · Vol II · P356'));

            const commonAlias = render('*MAT_ALE_INCOMPRESSIBLE');
            assert.ok(commonAlias.includes(i18n.get('manualReaderChooseChapter')));
            assert.ok(commonAlias.includes(i18n.get('pdfChooseChapter')));
            assert.ok(commonAlias.includes('command:extension.manual.pickPackChapter?'));
            assert.ok(!commonAlias.includes('P1198'));
            assert.ok(!commonAlias.includes('P2147'));

            const mat160 = render('*MAT_160');
            assert.ok(mat160.includes('PDF · Vol II · P1198'));
            assert.ok(!mat160.includes(i18n.get('pdfChooseChapter')));

            const matAle05 = render('*MAT_ALE_05');
            assert.ok(matAle05.includes('PDF · Vol II · P2147'));
            assert.ok(!matAle05.includes(i18n.get('pdfChooseChapter')));

            for (const value of [termination, contact, mat024, commonAlias, mat160, matAle05]) {
                assert.ok(!value.includes('PDF ×'));
            }
            assert.ok(!readFiles.some(file => /sentence-map|search-(?:en|zh)/i.test(file)));
        } finally {
            fs.readFileSync = originalReadFileSync;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not scan PDF bookmarks when a runtime pack lacks the keyword', () => {
        const root = createRuntimeManualPack();

        vscodeMock.workspace.getConfiguration = () => ({
            get: key => key === 'manualsDir' ? root : undefined,
        });
        manualIndexer.getManualLocations = () => {
            throw new Error('a runtime pack must not fall back to sibling PDF bookmarks');
        };
        manualIndexer.getManualFilesCount = () => {
            throw new Error('a runtime pack must not enumerate sibling PDF files');
        };

        try {
            const md = new vscodeMock.MarkdownString();
            appendManualLinks(md, '*NOT_IN_RUNTIME_INDEX');

            assert.ok(!md.value.includes('command:extension.openManual'));
            assert.ok(!md.value.includes('command:extension.manual.pickPdfLocation'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('shows complete official chapter, manual, page, and Chinese detail in the picker', () => {
        const manualId = 'keyword-vol-ii-material-models';
        const root = createRuntimeManualPack({
            sections: [
                {
                    manualId,
                    sectionId: 'mat-160',
                    level: 2,
                    titleEn: 'MAT_160/MAT_ALE_INCOMPRESSIBLE',
                    titleZh: '不可压缩 ALE 材料 160',
                    anchors: ['mat-160'],
                    pathEn: 'documents/en/vol-ii/mat-160.md',
                    pathZh: 'documents/zh/vol-ii/mat-160.md',
                    pdfPage: 1198,
                },
                {
                    manualId,
                    sectionId: 'mat-ale-05',
                    level: 2,
                    titleEn: 'MAT_ALE_05/MAT_ALE_INCOMPRESSIBLE',
                    titleZh: '不可压缩 ALE 材料 05',
                    anchors: ['mat-ale-05'],
                    pathEn: 'documents/en/vol-ii/mat-ale-05.md',
                    pathZh: 'documents/zh/vol-ii/mat-ale-05.md',
                    pdfPage: 2147,
                },
            ],
            keywords: {
                '*MAT_ALE_INCOMPRESSIBLE': {
                    manualId,
                    sectionId: 'mat-160',
                    anchorId: 'mat-160',
                    pdfPage: 1198,
                    alternateLocations: [{
                        manualId,
                        sectionId: 'mat-ale-05',
                        anchorId: 'mat-ale-05',
                        pdfPage: 2147,
                    }],
                },
            },
        });

        try {
            const { ManualIndexRepository } = require('../src/manual/ManualIndexRepository');
            const repository = new ManualIndexRepository(root);
            const locations = repository.resolveKeywordLocations('*MAT_ALE_INCOMPRESSIBLE');
            const items = buildManualChapterPickItems(repository, locations);
            const first = getManualChapterPresentation(repository, locations[0]);

            assert.deepStrictEqual(items.map(item => [
                item.label,
                item.description,
                item.detail,
            ]), [
                [
                    '$(book) MAT_160/MAT_ALE_INCOMPRESSIBLE',
                    'LS-DYNA dev Keyword Manual Vol II - Material Models · P1198',
                    '不可压缩 ALE 材料 160',
                ],
                [
                    '$(book) MAT_ALE_05/MAT_ALE_INCOMPRESSIBLE',
                    'LS-DYNA dev Keyword Manual Vol II - Material Models · P2147',
                    '不可压缩 ALE 材料 05',
                ],
            ]);
            assert.strictEqual(first.manualLabel, 'Vol II');
            assert.strictEqual(first.pdfPage, 1198);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('pickManualLocation', () => {
    let originalGetManualLocations;
    let originalShowQuickPick;
    let originalShowInformationMessage;
    let originalExecuteCommand;
    const manualIndexer = require('../src/core/manualIndexer');

    beforeEach(() => {
        originalGetManualLocations = manualIndexer.getManualLocations;
        originalShowQuickPick = vscodeMock.window.showQuickPick;
        originalShowInformationMessage = vscodeMock.window.showInformationMessage;
        originalExecuteCommand = vscodeMock.commands.executeCommand;
    });

    afterEach(() => {
        manualIndexer.getManualLocations = originalGetManualLocations;
        vscodeMock.window.showQuickPick = originalShowQuickPick;
        vscodeMock.window.showInformationMessage = originalShowInformationMessage;
        vscodeMock.commands.executeCommand = originalExecuteCommand;
    });

    it('shows full PDF names and opens the selected location', async () => {
        const locations = [
            { file: 'd:/manuals/LS-DYNA Keyword Manual Vol I.pdf', page: 2601 },
            { file: 'd:/manuals/LS-DYNA Keyword Manual Vol II.pdf', page: 184 },
        ];
        let picker;
        let executed;
        manualIndexer.getManualLocations = () => locations;
        vscodeMock.window.showQuickPick = (items, options) => {
            picker = { items, options };
            return Promise.resolve(items[1]);
        };
        vscodeMock.commands.executeCommand = (...args) => {
            executed = args;
            return Promise.resolve();
        };

        await pickManualLocation('*DEFINE_TRANSFORMATION');

        assert.deepEqual(picker.items.map(item => [item.label, item.description]), [
            ['$(file-pdf) LS-DYNA Keyword Manual Vol I', i18n.get('page', 2601)],
            ['$(file-pdf) LS-DYNA Keyword Manual Vol II', i18n.get('page', 184)],
        ]);
        assert.equal(picker.options.placeHolder, i18n.get('selectPdfManualLocation'));
        assert.deepEqual(executed, ['extension.openManual', locations[1].file, locations[1].page]);
    });

    it('opens a sole refreshed location without showing a picker', async () => {
        const location = { file: 'd:/manuals/Vol I.pdf', page: 20 };
        let pickerShown = false;
        let executed;
        manualIndexer.getManualLocations = () => [location];
        vscodeMock.window.showQuickPick = () => {
            pickerShown = true;
            return Promise.resolve(undefined);
        };
        vscodeMock.commands.executeCommand = (...args) => {
            executed = args;
            return Promise.resolve();
        };

        await pickManualLocation('*CONTROL_TERMINATION');

        assert.equal(pickerShown, false);
        assert.deepEqual(executed, ['extension.openManual', location.file, location.page]);
    });

    it('reports when refreshed locations are no longer available', async () => {
        let message;
        manualIndexer.getManualLocations = () => [];
        vscodeMock.window.showInformationMessage = value => { message = value; };

        await pickManualLocation('*DEFINE_TRANSFORMATION');

        assert.equal(message, i18n.get('pdfManualLocationNotFound', '*DEFINE_TRANSFORMATION'));
    });

    it('does nothing when the picker is cancelled', async () => {
        let executed = false;
        manualIndexer.getManualLocations = () => [
            { file: 'd:/manuals/Vol I.pdf', page: 20 },
            { file: 'd:/manuals/Vol II.pdf', page: 30 },
        ];
        vscodeMock.window.showQuickPick = () => Promise.resolve(undefined);
        vscodeMock.commands.executeCommand = () => { executed = true; };

        await pickManualLocation('*CONTROL_TERMINATION');

        assert.equal(executed, false);
    });

    it('shows full paths only when PDF base names collide', async () => {
        let items;
        manualIndexer.getManualLocations = () => [
            { file: 'd:/manuals-a/Vol I.pdf', page: 20 },
            { file: 'd:/manuals-b/Vol I.pdf', page: 30 },
            { file: 'd:/manuals/Vol II.pdf', page: 40 },
        ];
        vscodeMock.window.showQuickPick = values => {
            items = values;
            return Promise.resolve(undefined);
        };

        await pickManualLocation('*CONTROL_TERMINATION');

        assert.deepEqual(items.map(item => item.detail), [
            'd:/manuals-a/Vol I.pdf',
            'd:/manuals-b/Vol I.pdf',
            undefined,
        ]);
    });
});

// ---------------------------------------------------------------------------
// Keyword option interactions
// ---------------------------------------------------------------------------

describe('LS-DYNA keyword option interactions', () => {
    let originalShowQuickPick;
    let originalShowInformationMessage;
    let originalShowWarningMessage;

    beforeEach(() => {
        originalShowQuickPick = vscodeMock.window.showQuickPick;
        originalShowInformationMessage = vscodeMock.window.showInformationMessage;
        originalShowWarningMessage = vscodeMock.window.showWarningMessage;
    });

    afterEach(() => {
        vscodeMock.window.showQuickPick = originalShowQuickPick;
        vscodeMock.window.showInformationMessage = originalShowInformationMessage;
        vscodeMock.window.showWarningMessage = originalShowWarningMessage;
        i18n.updateLanguage();
    });

    it('hides keyword action CodeLens by default', () => {
        const provider = new LsdynaKeywordOptionsCodeLensProvider();
        const doc = fakeDoc('*NODE\n*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE\n');

        const lenses = provider.provideCodeLenses(doc);

        assert.deepEqual(lenses, []);
    });

    it('shows keyword action CodeLens for all keywords only when configured', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'codeLens.showOnAllKeywords' ? true : defaultValue,
        });

        try {
            const provider = new LsdynaKeywordOptionsCodeLensProvider();
            const doc = fakeDoc('*NODE\n*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE\n');
            const lenses = provider.provideCodeLenses(doc);
            const nodeLenses = lenses.filter(lens => lens.range.start.line === 0);
            const optionLenses = lenses.filter(lens => lens.range.start.line === 1);

            assert.equal(nodeLenses.length, 2);
            assert.ok(nodeLenses.some(lens => lens.command.command === 'extension.selectKeyword'));
            assert.ok(nodeLenses.some(lens => lens.command.command === 'extension.lsdynaFormatSelection'));
            assert.equal(optionLenses.length, 3);
            const optionsLens = optionLenses.find(lens => lens.command.command === 'extension.lsdynaChooseKeywordOptions');
            assert.ok(optionsLens);
            assert.ok(optionsLens.command.title.includes('Options'));
            assert.ok(optionsLens.command.title.includes('ID, MPP, A-G'));
            assert.ok(optionLenses.some(lens => lens.command.command === 'extension.selectKeyword'));
            assert.ok(optionLenses.some(lens => lens.command.command === 'extension.lsdynaFormatSelection'));
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('shows an information message when the current keyword has no options', async () => {
        const editor = makeEditableEditor(['*NODE'], 0);
        let message = '';
        vscodeMock.window.showInformationMessage = (value) => {
            message = value;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.ok(message.includes('No LS-DYNA keyword options'));
    });

    it('adds TITLE to MAT_001 and inserts a managed title comment with skeleton line', async () => {
        const editor = makeEditableEditor(['*MAT_001', '        1'], 0);
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) {
                return items.filter(item => item.label === 'TITLE');
            }
            return undefined;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.deepEqual(editor.lines, [
            '*MAT_001_TITLE',
            '$# title                                                                        ',
            '',
            '        1'
        ]);
    });

    it('does not apply keyword options after the document changes while the picker is open', async () => {
        const editor = makeEditableEditor(['*MAT_001', '        1'], 0);
        editor.document.version = 1;
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) {
                editor.lines.unshift('$ concurrent engineer edit');
                editor.document.version = 2;
                return items.filter(item => item.label === 'TITLE');
            }
            return undefined;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.deepEqual(editor.lines, [
            '$ concurrent engineer edit',
            '*MAT_001',
            '        1',
        ]);
    });

    it('removes a strict managed TITLE comment with its empty skeleton line', async () => {
        const editor = makeEditableEditor([
            '*MAT_001_TITLE',
            '$# title                                                                        ',
            '',
            '        1'
        ], 0);
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return undefined;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.deepEqual(editor.lines, ['*MAT_001', '        1']);
    });

    it('removes orphan strict option comments that are not selected', async () => {
        const editor = makeEditableEditor([
            '*MAT_024',
            '$# title                                                                        ',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '                                                                 1e+21          '
        ], 0);
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return undefined;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.deepEqual(editor.lines, [
            '*MAT_024',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '                                                                 1e+21          '
        ]);
    });

    it('removes orphan strict option comments with adjacent empty skeleton lines', async () => {
        const editor = makeEditableEditor([
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE',
            '$#  ignore      bckt    lcbckt    ns2trk   inititr    parmax    unused    cparm8',
            '$#     cidheading                                                               ',
            '',
            '$#    ssid      msid     sstyp     mstyp    sboxid    mboxid       spr       mpr',
            ''
        ], 0);
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return items.find(item => item.label === 'None');
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.deepEqual(editor.lines, [
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE',
            '$#    ssid      msid     sstyp     mstyp    sboxid    mboxid       spr       mpr',
            ''
        ]);
    });

    it('does not remove a non-empty TITLE line without confirmation', async () => {
        const editor = makeEditableEditor(['*MAT_001_TITLE', 'Steel', '        1'], 0);
        let warning = '';
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return undefined;
        };
        vscodeMock.window.showWarningMessage = async (value) => {
            warning = value;
            return undefined;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.match(warning, /non-?empty/i);
        assert.deepEqual(editor.lines, ['*MAT_001_TITLE', 'Steel', '        1']);
    });

    it('adds CONTACT optional cards A-F from the range picker', async () => {
        const editor = makeEditableEditor([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base 1',
            'base 2',
            'base 3',
        ], 0);
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return items.find(item => item.label === 'A-F');
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.equal(editor.lines.length, 16);
        assert.equal(editor.lines[0], '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE');
        assert.equal(editor.lines[4], '$#    soft    sofscl    lcidab    maxpar     sbopt     depth     bsort    frcfrq');
        assert.equal(editor.lines[14], '$#  pstiff   ignroff               fstol    2dbinr    ssftyp     swtpr    tetfac');
        assert.equal(editor.lines[15].trim(), '');
    });

    it('removes strict CONTACT optional card comments when shrinking options', async () => {
        const editor = makeEditableEditor([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base 1',
            'base 2',
            'base 3',
            '$#    soft    sofscl    lcidab    maxpar     sbopt     depth     bsort    frcfrq',
            '',
            '$#  penmax    thkopt    shlthk     snlog      isym     i2d3d    sldthk    sldstf',
            '',
            '$#    igap    ignore    dprfac    dtstif     edgek              flangl   cid_rcf',
            '',
            '$#   q2tri    dtpchk     sfnbr    fnlscl    dnlscl      tcso    tiedid    shledg',
            '',
            '$#  sharec    cparm8    ipback     srnde    fricsf      icor     ftorq    region',
            '',
            '$#  pstiff   ignroff               fstol    2dbinr    ssftyp     swtpr    tetfac',
            ''
        ], 0);
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return items.find(item => item.label === 'A-C');
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.deepEqual(editor.lines, [
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base 1',
            'base 2',
            'base 3',
            '$#    soft    sofscl    lcidab    maxpar     sbopt     depth     bsort    frcfrq',
            '',
            '$#  penmax    thkopt    shlthk     snlog      isym     i2d3d    sldthk    sldstf',
            '',
            '$#    igap    ignore    dprfac    dtstif     edgek              flangl   cid_rcf',
            ''
        ]);
    });

    it('does not shrink CONTACT F to C when removed option cards contain user data', async () => {
        const editor = makeEditableEditor([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base 1',
            'base 2',
            'base 3',
            '',
            '',
            '',
            'user data in optional D',
            '',
            '',
        ], 0);
        let warning = '';
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return items.find(item => item.label === 'A-C');
        };
        vscodeMock.window.showWarningMessage = async (value) => {
            warning = value;
            return undefined;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.match(warning, /non-?empty/i);
        assert.equal(editor.lines.length, 10);
        assert.equal(editor.lines[7], 'user data in optional D');
    });

    it('shrinks CONTACT F to C only after explicit confirmation', async () => {
        const editor = makeEditableEditor([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base 1',
            'base 2',
            'base 3',
            'optional A',
            'optional B',
            'optional C',
            'user data in optional D',
            'user data in optional E',
            'user data in optional F',
        ], 0);
        let warningArgs;
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return items.find(item => item.label === 'A-C');
        };
        vscodeMock.window.showWarningMessage = async (...args) => {
            warningArgs = args;
            return i18n.get('removeLines');
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.match(warningArgs[0], /non-?empty/i);
        assert.deepEqual(warningArgs[1], { modal: true });
        assert.equal(warningArgs[2], i18n.get('removeLines'));
        assert.deepEqual(editor.lines, [
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base 1',
            'base 2',
            'base 3',
            'optional A',
            'optional B',
            'optional C',
        ]);
    });

    it('does not shrink CONTACT after the active editor changes during confirmation', async () => {
        const editor = makeEditableEditor([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base 1',
            'base 2',
            'base 3',
            'optional A',
            'optional B',
            'optional C',
            'user data in optional D',
            'user data in optional E',
            'user data in optional F',
        ], 0);
        const original = editor.lines.slice();
        const otherEditor = makeEditableEditor(['*NODE', '       2'], 0);
        const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
        vscodeMock.window.activeTextEditor = editor;
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return items.find(item => item.label === 'A-C');
        };
        vscodeMock.window.showWarningMessage = async () => {
            vscodeMock.window.activeTextEditor = otherEditor;
            return i18n.get('removeLines');
        };

        try {
            await chooseKeywordOptionsForEditor(editor);
        } finally {
            vscodeMock.window.activeTextEditor = originalActiveTextEditor;
        }

        assert.deepEqual(editor.lines, original);
        assert.deepEqual(otherEditor.lines, ['*NODE', '       2']);
    });

    it('localizes keyword option CodeLens and picker messages', async () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => {
                if (key === 'language') return 'zh-cn';
                if (key === 'codeLens.showOnAllKeywords') return true;
                return defaultValue;
            },
        });
        i18n.updateLanguage();

        try {
            const provider = new LsdynaKeywordOptionsCodeLensProvider();
            const lenses = provider.provideCodeLenses(fakeDoc('*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE\n'));
            const optionsLens = lenses.find(lens => lens.command.command === 'extension.lsdynaChooseKeywordOptions');
            assert.ok(optionsLens.command.title.includes('选项'));

            const editor = makeEditableEditor(['*NODE'], 0);
            let message = '';
            vscodeMock.window.showInformationMessage = (value) => {
                message = value;
            };
            await chooseKeywordOptionsForEditor(editor);

            assert.ok(message.includes('没有可用的 LS-DYNA 关键字选项'));
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });

    it('supports auto language mode by following VS Code language', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        const originalEnv = vscodeMock.env;
        vscodeMock.env = { ...(vscodeMock.env || {}), language: 'en' };
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key) => key === 'language' ? 'auto' : undefined
        });

        try {
            i18n.updateLanguage();
            assert.equal(i18n.getLanguage(), 'en');

            vscodeMock.env.language = 'zh-cn';
            i18n.updateLanguage();
            assert.equal(i18n.getLanguage(), 'zh-cn');
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            vscodeMock.env = originalEnv;
            i18n.updateLanguage();
        }
    });

    it('refreshes auto language UI when VS Code display language changes at runtime', async () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        const originalEnv = vscodeMock.env;
        const originalOnDidChangeConfiguration = vscodeMock.workspace.onDidChangeConfiguration;
        const originalCreateTreeView = vscodeMock.window.createTreeView;
        const configCallbacks = [];
        const treeViews = new Map();

        vscodeMock.env = { ...(vscodeMock.env || {}), language: 'en' };
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'language' ? 'auto' : defaultValue
        });
        vscodeMock.workspace.onDidChangeConfiguration = (callback) => {
            configCallbacks.push(callback);
            return { dispose() {} };
        };
        vscodeMock.window.createTreeView = (id) => {
            const view = { title: '', dispose() {} };
            treeViews.set(id, view);
            return view;
        };

        try {
            i18n.updateLanguage();
            await extensionModule.activate({
                subscriptions: [],
                globalState: {
                    get: () => undefined,
                    update: () => Promise.resolve(),
                },
            });

            assert.equal(i18n.getLanguage(), 'en');
            assert.equal(treeViews.get('lsdynaIncludeTree').title, 'Include Tree');

            vscodeMock.env.language = 'zh-cn';
            for (const callback of configCallbacks) {
                callback({ affectsConfiguration: key => key === 'locale' });
            }

            assert.equal(i18n.getLanguage(), 'zh-cn');
            assert.equal(treeViews.get('lsdynaIncludeTree').title, '引用文件树');
            assert.equal(treeViews.get('lsdynaKeywordIndex').title, '关键字索引');
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            vscodeMock.env = originalEnv;
            vscodeMock.workspace.onDidChangeConfiguration = originalOnDidChangeConfiguration;
            vscodeMock.window.createTreeView = originalCreateTreeView;
            i18n.updateLanguage();
        }
    });

    it('declares auto as the default extension language option', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        const languageConfig = pkg.contributes.configuration.properties['lsdyna.language'];

        assert.equal(languageConfig.default, 'auto');
        assert.deepEqual(languageConfig.enum, ['auto', 'zh-cn', 'en']);
    });

    it('keeps runtime i18n keys complete for both supported languages', () => {
        function collectSourceFiles(dir, result = []) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const entryPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    collectSourceFiles(entryPath, result);
                } else if (entry.name.endsWith('.ts')) {
                    result.push(entryPath);
                }
            }
            return result;
        }

        function collectUsedI18nKeys(srcDir) {
            const keys = new Set();
            for (const filePath of collectSourceFiles(srcDir)) {
                const source = fs.readFileSync(filePath, 'utf8');
                for (const match of source.matchAll(/i18n\.get\('([^']+)'/g)) {
                    keys.add(match[1]);
                }
            }
            return keys;
        }

        function collectLocaleKeys(source, locale, nextLocale) {
            const blockPattern = new RegExp(`'${locale}':\\s*{([\\s\\S]*?)\\n\\s*}${nextLocale ? `,\\s*\\n\\s*'${nextLocale}':` : '\\s*\\n};'}`);
            const match = source.match(blockPattern);
            assert.ok(match, `${locale} locale block should exist`);
            return new Set([...match[1].matchAll(/\n\s*([A-Za-z0-9_]+):/g)].map(item => item[1]));
        }

        const repoRoot = path.join(__dirname, '..');
        const i18nSource = fs.readFileSync(path.join(repoRoot, 'src', 'core', 'i18n.ts'), 'utf8');
        const usedKeys = collectUsedI18nKeys(path.join(repoRoot, 'src'));
        const zhKeys = collectLocaleKeys(i18nSource, 'zh-cn', 'en');
        const enKeys = collectLocaleKeys(i18nSource, 'en');

        for (const key of usedKeys) {
            assert.ok(zhKeys.has(key), `${key} should exist in zh-cn runtime locale`);
            assert.ok(enKeys.has(key), `${key} should exist in en runtime locale`);
        }
    });

    it('keeps runtime Chinese copy natural and free of mixed-language setup terms', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'language' ? 'zh-cn' : defaultValue
        });
        i18n.updateLanguage();

        try {
            assert.equal(
                i18n.get('openFileFirst', 'activeEditor=false'),
                '请先打开一个 LS-DYNA 文件。（诊断信息：activeEditor=false）'
            );
            assert.equal(i18n.get('configureFolder'), '设置手册目录');
            assert.equal(i18n.get('howToConfigureManual'), '查看 PDF 手册配置说明');
            assert.equal(i18n.get('manualDirSetTo', 'D:\\manuals'), 'LS-DYNA 手册目录已设置为：D:\\manuals');
            assert.equal(i18n.get('loadingFieldData'), '正在加载关键字字段定义…');
            assert.equal(i18n.get('fieldCompletionLabel', 'LCSS', 21, 30), 'LCSS（第 21-30 列）');
            assert.equal(i18n.get('chooseConsecutiveOptionalCards'), '选择连续出现的可选卡片');
            assert.equal(i18n.get('removeNonEmptyOptionLinesWarning'), '更改 LS-DYNA 关键字选项会删除非空的可选卡片行。');
            assert.equal(i18n.get('moreDefinitionsOmitted', 2), '悬停提示中已省略 2 个定义。');
            assert.equal(i18n.get('circularIncludeDependency', 'main.k -> child.k -> main.k'), '检测到循环引用依赖：main.k -> child.k -> main.k');
            assert.equal(i18n.get('keywordOptionsCodeLensWithSummary', 'A-C'), '$(gear) 选项：A-C');
            assert.equal(i18n.get('parameterReferencesPlural', 2), '2 处引用');
            assert.equal(i18n.get('manualSidebarSearchModeKeyword'), '关键字');
            assert.equal(i18n.get('statusDashboardShowHealthLabel'), '$(checklist) 环境与手册状态');
            assert.equal(i18n.get('statusDashboardHealthIssuesDescription', 2), '待配置：2');
            assert.equal(i18n.get('healthNoticeMessage', 2), 'DynaSense 待配置项：2。');
            assert.equal(i18n.get('health_manualsDir_warning_description'), '需要配置手册目录');
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });

    it('keeps runtime English copy concise and idiomatic', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'language' ? 'en' : defaultValue
        });
        i18n.updateLanguage();

        try {
            assert.equal(i18n.get('filesFound', 3), 'Files found: 3');
            assert.equal(i18n.get('rowTemplateLabel', 4), 'Insert full row template for data card 4');
            assert.equal(i18n.get('rowTemplateDetail'), 'LS-DYNA aligned card template');
            assert.equal(i18n.get('loadingFieldData'), 'Loading keyword field definitions…');
            assert.equal(i18n.get('chooseConsecutiveOptionalCards'), 'Choose consecutive optional cards');
            assert.equal(i18n.get('btnDownloadPack'), 'Download ready-to-use pack');
            assert.equal(i18n.get('notOnAnyKeyword'), 'The cursor is not inside a keyword block.');
            assert.equal(i18n.get('noFileToJumpTo'), 'No include file is available at the current cursor.');
            assert.equal(i18n.get('noMoreKeywordsFound'), 'No next keyword found.');
            assert.equal(i18n.get('noPreviousKeywordsFound'), 'No previous keyword found.');
            assert.equal(i18n.get('parameterReferenceSingular'), '1 reference');
            assert.equal(i18n.get('parameterReferencesPlural', 2), '2 references');
            assert.equal(i18n.get('manualSidebarSearchModeFulltext'), 'Full text');
            assert.equal(i18n.get('statusDashboardShowHealthLabel'), '$(checklist) Environment and manuals');
            assert.equal(i18n.get('statusDashboardHealthIssuesDescription', 2), 'Setup required: 2');
            assert.equal(i18n.get('healthNoticeMessage', 2), 'DynaSense found 2 items that need setup.');
            assert.equal(i18n.get('health_manualsDir_warning_description'), 'Manual folder needs setup');
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });

    it('localizes line length diagnostics in Chinese', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'language' ? 'zh-cn' : defaultValue
        });
        i18n.updateLanguage();

        try {
            const doc = fakeDoc('*NODE\n' + '1'.repeat(81) + '\n', '/project/main.k');
            doc.languageId = 'lsdyna';
            const diagnostics = collectLineLengthDiagnostics(doc);

            assert.equal(diagnostics.length, 1);
            assert.equal(diagnostics[0].message, i18n.get('lineExceeds80Characters', 81));
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });

    it('registers the first-run health status command', async () => {
        const context = {
            subscriptions: [],
            globalState: {
                get: () => undefined,
                update: () => Promise.resolve(),
            },
        };
        const disposable = { dispose() {} };
        const registeredCommands = [];
        const originalRegisterCommand = vscodeMock.commands.registerCommand;
        const originalRegisterTreeDataProvider = vscodeMock.window.registerTreeDataProvider;
        const originalOnDidChangeActiveTextEditor = vscodeMock.window.onDidChangeActiveTextEditor;
        const originalOnDidChangeTextEditorSelection = vscodeMock.window.onDidChangeTextEditorSelection;
        const originalCreateTextEditorDecorationType = vscodeMock.window.createTextEditorDecorationType;
        const originalRegisterHoverProvider = vscodeMock.languages.registerHoverProvider;
        const originalRegisterCodeLensProvider = vscodeMock.languages.registerCodeLensProvider;

        vscodeMock.commands.registerCommand = (id, callback) => {
            registeredCommands.push(id);
            return disposable;
        };
        vscodeMock.window.registerTreeDataProvider = () => disposable;
        vscodeMock.window.onDidChangeActiveTextEditor = () => disposable;
        vscodeMock.window.onDidChangeTextEditorSelection = () => disposable;
        vscodeMock.window.createTextEditorDecorationType = () => disposable;
        vscodeMock.languages.registerHoverProvider = () => disposable;
        vscodeMock.languages.registerCodeLensProvider = () => disposable;

        try {
            await extensionModule.activate(context);

            assert.ok(registeredCommands.includes('extension.showHealthStatus'));
            assert.ok(registeredCommands.includes('extension.lsdynaStatusDashboard'));
        } finally {
            vscodeMock.commands.registerCommand = originalRegisterCommand;
            vscodeMock.window.registerTreeDataProvider = originalRegisterTreeDataProvider;
            vscodeMock.window.onDidChangeActiveTextEditor = originalOnDidChangeActiveTextEditor;
            vscodeMock.window.onDidChangeTextEditorSelection = originalOnDidChangeTextEditorSelection;
            vscodeMock.window.createTextEditorDecorationType = originalCreateTextEditorDecorationType;
            vscodeMock.languages.registerHoverProvider = originalRegisterHoverProvider;
            vscodeMock.languages.registerCodeLensProvider = originalRegisterCodeLensProvider;
        }
    });
});

// ---------------------------------------------------------------------------
// isLsdynaUri
// ---------------------------------------------------------------------------

describe('isLsdynaUri', () => {
    it('checks standard and custom file extensions correctly', () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;

        // 1. Mock default extensions
        workspace.getConfiguration = () => ({
            get: (key) => key === 'additionalExtensions' ? ['.k', '.key', '.dyna', '.asc'] : undefined
        });

        assert.strictEqual(isLsdynaUri({ fsPath: 'model.k' }), true);
        assert.strictEqual(isLsdynaUri({ fsPath: 'model.key' }), true);
        assert.strictEqual(isLsdynaUri({ fsPath: 'model.dyna' }), true);
        assert.strictEqual(isLsdynaUri({ fsPath: 'model.asc' }), true);
        assert.strictEqual(isLsdynaUri({ fsPath: 'model.txt' }), false);

        // 2. Mock custom extensions (some without leading dots)
        workspace.getConfiguration = () => ({
            get: (key) => key === 'additionalExtensions' ? ['dat', '.incl'] : undefined
        });

        assert.strictEqual(isLsdynaUri({ fsPath: 'model.dat' }), true);
        assert.strictEqual(isLsdynaUri({ fsPath: 'model.incl' }), true);
        assert.strictEqual(isLsdynaUri({ fsPath: 'model.k' }), false);

        workspace.getConfiguration = originalGetConfiguration;
    });
});

// ---------------------------------------------------------------------------
// readFileSnippet
// ---------------------------------------------------------------------------

describe('readFileSnippet', () => {
    it('reads a specific range of lines from a file efficiently', async () => {
        const tempFile = path.join(os.tmpdir(), `lsdyna-snippet-test-${Date.now()}.k`);
        fs.writeFileSync(tempFile, 'line0\nline1\nline2\nline3\nline4\nline5\n', 'utf8');
        try {
            const { readFileSnippet } = require('../src/client/providers/keywordIndexProvider');
            const snippet = await readFileSnippet(tempFile, 2, 3);
            assert.strictEqual(snippet, 'line2\nline3\nline4');
        } finally {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        }
    });
});

// ---------------------------------------------------------------------------
// formatBytes & formatShortBytes
// ---------------------------------------------------------------------------

describe('formatBytes', () => {
    it('converts byte counts to readable file size strings with appropriate units', () => {
        const { formatBytes, formatShortBytes, formatVividBytes, applyVividDescription } = require('../src/client/providers/includeTreeProvider');
        assert.strictEqual(formatBytes(0), '0 B');
        assert.strictEqual(formatBytes(512), '512.0 B');
        assert.strictEqual(formatBytes(1024), '1.0 KB');
        assert.strictEqual(formatBytes(1536), '1.5 KB');
        assert.strictEqual(formatBytes(1024 * 1024), '1.0 MB');
        assert.strictEqual(formatBytes(1024 * 1024 * 1024 * 2.5), '2.5 GB');

        assert.strictEqual(formatShortBytes(0), '0');
        assert.strictEqual(formatShortBytes(512), '1k');
        assert.strictEqual(formatShortBytes(1024), '1k');
        assert.strictEqual(formatShortBytes(1536), '2k');
        assert.strictEqual(formatShortBytes(1024 * 45), 'K');
        assert.strictEqual(formatShortBytes(1024 * 1024 * 1.2), '1M');
        assert.strictEqual(formatShortBytes(1024 * 1024 * 1024 * 125), 'G');

        // Test formatVividBytes
        assert.strictEqual(formatVividBytes(0), '▏ 0 B');
        assert.strictEqual(formatVividBytes(512), '▏ 512.0 B');
        assert.strictEqual(formatVividBytes(1024 * 5), '▏ 5.0 KB');
        assert.strictEqual(formatVividBytes(1024 * 45), '▌ 45.0 KB');
        assert.strictEqual(formatVividBytes(1024 * 1024 * 1.2), '█ 1.2 MB');

        // Test applyVividDescription
        const mockItem1 = { contextValue: 'file', description: '', fileSizeVal: 1024 * 5 };
        applyVividDescription(mockItem1, 'sub');
        assert.strictEqual(mockItem1.description, '▏ 5.0 KB');
        assert.strictEqual(mockItem1.relDir, 'sub');

        const mockItem2 = { contextValue: 'file-missing', description: 'not found' };
        applyVividDescription(mockItem2, 'sub');
        assert.strictEqual(mockItem2.description, 'not found');
        assert.strictEqual(mockItem2.relDir, 'sub');
    });
});

// ---------------------------------------------------------------------------
// LsdynaFileDecorationProvider
// ---------------------------------------------------------------------------

describe('LsdynaFileDecorationProvider', () => {
    it('decorates only missing files and leaves resolved files to normal link styling', () => {
        const { LsdynaFileDecorationProvider, normalizePathKey } = extensionModule._internals;
        const includeTreeProvider = {
            resolvedPaths: new Map([
                [normalizePathKey('some/file.k'), '']
            ]),
            missingPaths: new Set([
                normalizePathKey('some/missing.k')
            ])
        };
        const provider = new LsdynaFileDecorationProvider(includeTreeProvider);

        // Test resolved
        const resolvedUri = { scheme: 'file', fsPath: 'some/file.k' };
        const resolvedDec = provider.provideFileDecoration(resolvedUri);
        assert.strictEqual(resolvedDec, undefined);

        // Test missing
        const missingUri = { scheme: 'file', fsPath: 'some/missing.k' };
        const missingDec = provider.provideFileDecoration(missingUri);
        assert.ok(missingDec);
        assert.strictEqual(missingDec.badge, '!');
        assert.strictEqual(missingDec.tooltip, i18n.get('includeDecorationMissing'));
        assert.strictEqual(missingDec.color.id, 'list.warningForeground');

        // Test untracked
        const untrackedUri = { scheme: 'file', fsPath: 'some/other.k' };
        const untrackedDec = provider.provideFileDecoration(untrackedUri);
        assert.strictEqual(untrackedDec, undefined);
    });
});

// ---------------------------------------------------------------------------
// LsdynaIncludeCompletionProvider (browse-by-level + bare-name search)
// ---------------------------------------------------------------------------

describe('LsdynaIncludeCompletionProvider', () => {
    it('browses one level on / and inserts full relative paths', () => {
        const { LsdynaIncludeCompletionProvider } = extensionModule._internals;
        const provider = new LsdynaIncludeCompletionProvider();

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-completion-test-'));
        const subDir = path.join(tempDir, 'submodels');
        fs.mkdirSync(subDir);
        for (const name of ['1', '2', '10', '100', 'materials', 'mats_common', 'unrelated']) {
            fs.mkdirSync(path.join(tempDir, name));
        }
        const invalidDir = path.join(os.tmpdir(), 'non_existent_folder_xyz_12345');
        fs.writeFileSync(path.join(tempDir, 'file1.k'), '');
        fs.writeFileSync(path.join(tempDir, 'file2.k'), '');
        fs.writeFileSync(path.join(tempDir, 'file10.k'), '');
        fs.writeFileSync(path.join(tempDir, 'mass.k'), '');
        fs.writeFileSync(path.join(subDir, 'file2.k'), '');
        fs.writeFileSync(path.join(tempDir, 'unrelated', 'material_deep.k'), '');

        const mainFileContent = `*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE_PATH\n${invalidDir}\n*INCLUDE\n`;
        const mainFile = path.join(tempDir, 'main.k');
        fs.writeFileSync(mainFile, mainFileContent);
        const doc = fakeDoc(mainFileContent, mainFile);

        try {
            // Empty card: Mode A empty query → no dump of entire tree
            const emptyList = provider.provideCompletionItems(doc, { line: 5, character: 0 });
            assert.ok(emptyList);
            assert.strictEqual(emptyList.isIncomplete, true);
            assert.strictEqual(emptyList.items.length, 0);

            // Browse root via /
            const slashDoc = fakeDoc(`*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\n/`, mainFile);
            const slashList = provider.provideCompletionItems(slashDoc, { line: 3, character: 1 });
            assert.ok(slashList);
            const labels = slashList.items.map(item => item.label);
            // Search roots include deck dir + submodels → root-level entries from both
            assert.ok(labels.includes('file1.k') || labels.includes('file2.k'));
            // Must not flatten nested paths at root browse of deck when only / typed:
            // file2 is inside submodels search root as bare file2.k
            assert.ok(labels.includes('file2.k'), 'submodels root lists file2.k');
            assert.ok(!labels.includes('submodels/file2.k'), 'browse is one level, not flat walk');
            assert.deepStrictEqual(
                labels.filter(label => /^\d+\/$/.test(label)),
                ['1/', '2/', '10/', '100/'],
            );
            assert.deepStrictEqual(
                labels.filter(label => /^file\d+\.k$/.test(label)),
                ['file1.k', 'file2.k', 'file10.k'],
            );
            const firstFileIndex = slashList.items.findIndex(item => item.kind === vscodeMock.CompletionItemKind.File);
            const lastFolderIndex = slashList.items.map(item => item.kind).lastIndexOf(vscodeMock.CompletionItemKind.Folder);
            assert.ok(firstFileIndex > lastFolderIndex, 'folders must stay before files');

            const file1 = slashList.items.find(item => item.label === 'file1.k');
            if (file1) {
                assert.strictEqual(file1.insertText, 'file1.k');
                assert.ok(file1.range);
            }

            // Backslash same as slash (insert still uses /)
            const backslashDoc = fakeDoc(`*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\n\\`, mainFile);
            const backslashList = provider.provideCompletionItems(backslashDoc, { line: 3, character: 1 });
            assert.ok(backslashList);
            assert.ok(backslashList.items.some(i => i.label === 'file2.k' || i.label === 'file1.k'));

            // Explicit root browse remains browse while typing a name. It filters only
            // the current level and never returns the matching file in unrelated/.
            for (const prefix of ['/ma', '\\ma', './ma', '.\\ma']) {
                const filteredDoc = fakeDoc(`*INCLUDE\n${prefix}`, mainFile);
                const filteredList = provider.provideCompletionItems(
                    filteredDoc,
                    { line: 1, character: prefix.length },
                );
                assert.deepStrictEqual(
                    filteredList.items.map(item => item.label),
                    ['materials/', 'mats_common/', 'main.k', 'mass.k'],
                    prefix,
                );
                assert.ok(
                    filteredList.items.every(item => item.filterText === prefix),
                    `browse filterText must match typed prefix: ${prefix}`,
                );
                assert.ok(
                    !filteredList.items.some(item => item.label === 'unrelated/material_deep.k'),
                    prefix,
                );
                assert.deepStrictEqual(
                    filteredList.items.map(item => item.sortText),
                    ['0_00000000', '0_00000001', '0_00000002', '0_00000003'],
                    prefix,
                );
            }

            // Browse into submodels/ via deck-relative path from deck search root
            // Put layout under tempDir only (deck dir is a search root)
            const nestedDoc = fakeDoc(`*INCLUDE\nsubmodels/`, mainFile);
            const nestedList = provider.provideCompletionItems(nestedDoc, { line: 1, character: 10 });
            assert.ok(nestedList);
            const nestedLabels = nestedList.items.map(i => i.label);
            assert.ok(nestedLabels.includes('submodels/file2.k'));
            assert.ok(nestedList.items.every(i => String(i.insertText || i.label).includes('/')));

            // Partial segment filter
            const partialDoc = fakeDoc(`*INCLUDE\nsubmodels/fi`, mainFile);
            const partialList = provider.provideCompletionItems(partialDoc, { line: 1, character: 12 });
            assert.ok(partialList.items.some(i => i.label === 'submodels/file2.k'));

            // Range with leading spaces
            const prefixDoc = fakeDoc(`*INCLUDE\n  submodels/fi`, mainFile);
            const prefixList = provider.provideCompletionItems(prefixDoc, { line: 1, character: 14 });
            assert.ok(prefixList);
            for (const item of prefixList.items) {
                assert.strictEqual(item.range.start.line, 1);
                assert.strictEqual(item.range.start.character, 2);
                assert.strictEqual(item.range.end.character, 14);
            }

            // Bare name search (Mode A) — full relPath
            const searchDoc = fakeDoc(`*INCLUDE\nfile2`, mainFile);
            const searchList = provider.provideCompletionItems(searchDoc, { line: 1, character: 5 });
            assert.ok(searchList.items.some(i => i.label === 'file2.k' || i.label === 'submodels/file2.k'));

            // Keyword line / INCLUDE_PATH card / comment → empty
            assert.strictEqual(
                (provider.provideCompletionItems(doc, { line: 4, character: 0 }).items || []).length,
                0
            );
            assert.strictEqual(
                (provider.provideCompletionItems(doc, { line: 1, character: 0 }).length
                    || provider.provideCompletionItems(doc, { line: 1, character: 0 }).items?.length
                    || 0),
                0
            );
            const docWithComment = fakeDoc(`*INCLUDE\n$ this is a comment\n`, mainFile);
            assert.strictEqual(
                (provider.provideCompletionItems(docWithComment, { line: 1, character: 0 }).items || []).length,
                0
            );
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('provides browse items from continued *INCLUDE_PATH directories', () => {
        const { LsdynaIncludeCompletionProvider } = extensionModule._internals;
        const provider = new LsdynaIncludeCompletionProvider();

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-completion-continued-'));
        const includeDir = path.join(tempDir, 'shared', 'includes');
        const mainFile = path.join(tempDir, 'main.k');
        fs.mkdirSync(includeDir, { recursive: true });
        fs.writeFileSync(path.join(includeDir, 'continued.k'), '');

        const part1 = includeDir.slice(0, 78);
        const part2 = includeDir.slice(78);
        const mainFileContent = `*INCLUDE_PATH\n${part1} +\n${part2}\n*INCLUDE\n/`;
        fs.writeFileSync(mainFile, mainFileContent);
        const doc = fakeDoc(mainFileContent, mainFile);

        try {
            const list = provider.provideCompletionItems(doc, { line: 4, character: 1 });
            assert.ok(list);
            const labels = list.items.map(item => item.label);
            assert.ok(labels.includes('continued.k'));
            const item = list.items.find(i => i.label === 'continued.k');
            assert.strictEqual(item.insertText, 'continued.k');
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('does not truncate large browse levels while retaining the search top-N limit', () => {
        const { LsdynaIncludeCompletionProvider } = extensionModule._internals;
        const provider = new LsdynaIncludeCompletionProvider();
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-completion-count-'));
        const mainFile = path.join(tempDir, 'main.k');

        try {
            for (let i = 0; i < 75; i++) {
                fs.mkdirSync(path.join(tempDir, `dir_${String(i).padStart(2, '0')}`));
            }
            for (let i = 0; i < 50; i++) {
                fs.writeFileSync(path.join(tempDir, `mat_${String(i).padStart(2, '0')}.k`), '');
            }
            fs.writeFileSync(mainFile, '*INCLUDE\n/');

            const browseDoc = fakeDoc('*INCLUDE\n/', mainFile);
            const browseList = provider.provideCompletionItems(browseDoc, { line: 1, character: 1 });
            assert.strictEqual(
                browseList.items.filter(item => item.kind === vscodeMock.CompletionItemKind.Folder).length,
                75,
            );

            const searchDoc = fakeDoc('*INCLUDE\nmat', mainFile);
            const searchList = provider.provideCompletionItems(searchDoc, { line: 1, character: 3 });
            assert.strictEqual(searchList.items.length, 40);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('fails closed across all completion providers when the active document has multiple selections', () => {
        const {
            LsdynaIncludeCompletionProvider,
            LsdynaFieldCompletionProvider,
            LsdynaKeywordCompletionProvider,
        } = extensionModule._internals;
        const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-completion-multicursor-'));
        const mainFile = path.join(tempDir, 'main.k');
        fs.writeFileSync(path.join(tempDir, 'part.k'), '');

        const cases = [
            {
                provider: new LsdynaIncludeCompletionProvider(),
                document: fakeDoc('*INCLUDE\n/', mainFile),
                position: { line: 1, character: 1 },
            },
            {
                provider: new LsdynaFieldCompletionProvider(),
                document: fakeDoc('*NODE\n\n', mainFile),
                position: { line: 1, character: 0 },
            },
            {
                provider: new LsdynaKeywordCompletionProvider(),
                document: fakeDoc('*N', mainFile),
                position: { line: 0, character: 2 },
            },
        ];

        try {
            for (const { provider, document, position } of cases) {
                vscodeMock.window.activeTextEditor = {
                    document,
                    selections: [{}],
                };
                const single = provider.provideCompletionItems(document, position);
                const singleItems = Array.isArray(single) ? single : single.items;
                assert.ok(singleItems.length > 0);

                vscodeMock.window.activeTextEditor.selections = [{}, {}];
                const multiple = provider.provideCompletionItems(document, position);
                const multipleItems = Array.isArray(multiple) ? multiple : multiple.items;
                assert.strictEqual(multipleItems.length, 0);
            }
        } finally {
            vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});

describe('file reveal commands', () => {
    it('send hostile paths only through the VS Code reveal API', async () => {
        const originalPlatform = process.platform;
        const originalRegisterCommand = vscodeMock.commands.registerCommand;
        const originalExecuteCommand = vscodeMock.commands.executeCommand;
        const originalExec = require('child_process').exec;
        const commands = new Map();
        const executions = [];
        let execCount = 0;
        vscodeMock.commands.registerCommand = (id, callback) => {
            commands.set(id, callback);
            return { dispose() {} };
        };
        vscodeMock.commands.executeCommand = (id, ...args) => {
            executions.push([id, ...args]);
            return Promise.resolve();
        };
        require('child_process').exec = () => { execCount++; };
        Object.defineProperty(process, 'platform', { value: 'win32' });

        try {
            await extensionModule.activate({ subscriptions: [], asAbsolutePath: value => value });
            const filePath = 'C:\\模型 (2026) & data\\part.key';
            commands.get('extension.openIncludeFolder')(filePath);
            commands.get('extension.revealInExplorer')({ filePath });

            const revealCalls = executions.filter(([id]) => id === 'revealFileInOS');
            assert.deepStrictEqual(revealCalls.map(call => call[1].fsPath), [filePath, filePath]);
            assert.equal(execCount, 0);
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
            vscodeMock.commands.registerCommand = originalRegisterCommand;
            vscodeMock.commands.executeCommand = originalExecuteCommand;
            require('child_process').exec = originalExec;
        }
    });
});

describe('extension.openManual command', () => {
    let originalPlatform;
    let originalExec;
    let originalSpawn;
    let originalExistsSync;
    let originalOpenExternal;
    let originalGetConfiguration;
    let originalRegisterCommand;
    let originalPathEnv;
    let originalLocalAppdataEnv;
    let originalAppdataEnv;

    let execCalls = [];
    let spawnCalls = [];
    let openExternalCalls = [];
    let registeredCommands = new Map();
    let mockExistsMap = {};
    let mockRegistryData = {};
    let mockConfig = {};
    let mockSpawnError = false;

    before(() => {
        originalPlatform = process.platform;
        originalExec = require('child_process').exec;
        originalSpawn = require('child_process').spawn;
        originalExistsSync = require('fs').existsSync;
        originalOpenExternal = vscodeMock.env ? vscodeMock.env.openExternal : undefined;
        originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        originalRegisterCommand = vscodeMock.commands.registerCommand;
        originalPathEnv = process.env.PATH;
        originalLocalAppdataEnv = process.env.LOCALAPPDATA;
        originalAppdataEnv = process.env.APPDATA;

        vscodeMock.commands.registerCommand = (id, callback) => {
            registeredCommands.set(id, callback);
            return { dispose() {} };
        };

        if (!vscodeMock.env) {
            vscodeMock.env = {};
        }
        vscodeMock.env.openExternal = (uri) => {
            openExternalCalls.push(uri);
            return Promise.resolve(true);
        };
    });

    after(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        require('child_process').exec = originalExec;
        require('child_process').spawn = originalSpawn;
        require('fs').existsSync = originalExistsSync;
        if (originalOpenExternal) {
            vscodeMock.env.openExternal = originalOpenExternal;
        } else {
            delete vscodeMock.env.openExternal;
        }
        vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        vscodeMock.commands.registerCommand = originalRegisterCommand;
        process.env.PATH = originalPathEnv;
        process.env.LOCALAPPDATA = originalLocalAppdataEnv;
        process.env.APPDATA = originalAppdataEnv;
    });

    beforeEach(async () => {
        execCalls = [];
        spawnCalls = [];
        openExternalCalls = [];
        registeredCommands.clear();
        mockExistsMap = {};
        mockRegistryData = {};
        mockConfig = {};
        mockSpawnError = false;
        process.env.PATH = originalPathEnv;
        process.env.LOCALAPPDATA = originalLocalAppdataEnv;
        process.env.APPDATA = originalAppdataEnv;

        require('fs').existsSync = (p) => {
            if (p in mockExistsMap) {
                return mockExistsMap[p];
            }
            if (typeof p === 'string' && p.toLowerCase().includes('sumatrapdf.exe')) {
                return false;
            }
            return originalExistsSync(p);
        };

        require('child_process').exec = (cmd, options, cb) => {
            if (typeof options === 'function') {
                cb = options;
                options = undefined;
            }
            execCalls.push(cmd);
            if (cmd in mockRegistryData) {
                const res = mockRegistryData[cmd];
                if (res.error) {
                    cb(new Error(res.error));
                } else {
                    cb(null, res.stdout || '');
                }
            } else {
                cb(null, '');
            }
        };

        require('child_process').spawn = (exe, args, options) => {
            spawnCalls.push({ exe, args, options });
            const mockChild = {
                on: (event, cb) => {
                    if (event === 'error' && mockSpawnError) {
                        cb(new Error('Spawn error'));
                    }
                },
                unref: () => {}
            };
            return mockChild;
        };

        vscodeMock.workspace.getConfiguration = (section) => {
            return {
                get: (key) => {
                    if (section === 'lsdyna' && key === 'manualsDir') {
                        return mockConfig.manualsDir;
                    }
                    return undefined;
                }
            };
        };

        vscodeMock.workspace.workspaceFolders = undefined;

        // Sumatra path is session-cached; reset after config/workspace mocks are ready.
        if (extensionModule._internals && typeof extensionModule._internals.clearSumatraPathCache === 'function') {
            extensionModule._internals.clearSumatraPathCache();
        }

        // Activate extension to trigger registrations
        const context = {
            subscriptions: [],
            asAbsolutePath: (relPath) => `C:\\mock-extension-path\\${relPath}`
        };
        await extensionModule.activate(context);
    });

    it('uses absolute manualsDir path to resolve SumatraPDF.exe when present', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'C:\\custom\\manuals';
        mockExistsMap['C:\\custom\\manuals\\SumatraPDF.exe'] = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path\\to\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.deepStrictEqual(spawnCalls, [{
            exe: 'C:\\custom\\manuals\\SumatraPDF.exe',
            args: ['-reuse-instance', '-page', '12', pdfPath],
            options: { shell: false, detached: true, stdio: 'ignore', windowsHide: false },
        }]);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 0);
    });

    it('uses SumatraPDF.exe from a packaged pdf subdirectory', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'C:\\manual-pack';
        mockExistsMap['C:\\manual-pack\\pdf\\SumatraPDF.exe'] = true;

        const openManual = registeredCommands.get('extension.openManual');
        await openManual('C:\\manual-pack\\pdf\\Volume I.pdf', 8);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].exe, 'C:\\manual-pack\\pdf\\SumatraPDF.exe');
        assert.deepStrictEqual(spawnCalls[0].args, ['-reuse-instance', '-page', '8', 'C:\\manual-pack\\pdf\\Volume I.pdf']);
        assert.strictEqual(openExternalCalls.length, 0);
    });

    it('uses relative manualsDir next to Code.exe before workspaceFolders', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'relative/manuals';
        vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: 'C:\\workspace' } }];
        // Only workspace has Sumatra — still works as fallback when install root misses it.
        mockExistsMap['C:\\workspace\\relative\\manuals\\SumatraPDF.exe'] = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path\\to\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].exe, 'C:\\workspace\\relative\\manuals\\SumatraPDF.exe');
        assert.deepStrictEqual(spawnCalls[0].args, ['-reuse-instance', '-page', '12', pdfPath]);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 0);
    });

    it('prefers Code.exe-relative manualsDir over workspace when both have Sumatra', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'relative/manuals';
        vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: 'C:\\workspace' } }];
        const exeDir = path.dirname(process.execPath);
        const exeSumatra = path.join(exeDir, 'relative', 'manuals', 'SumatraPDF.exe');
        mockExistsMap[exeSumatra] = true;
        mockExistsMap['C:\\workspace\\relative\\manuals\\SumatraPDF.exe'] = true;

        const openManual = registeredCommands.get('extension.openManual');
        await openManual('C:\\path\\to\\manual.pdf', 12);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].exe, exeSumatra);
    });

    it('uses relative manualsDir path resolved against process.cwd() when install root and workspace miss', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'relative/manuals';
        vscodeMock.workspace.workspaceFolders = undefined;
        const resolvedPath = path.resolve(process.cwd(), 'relative/manuals', 'SumatraPDF.exe');
        mockExistsMap[resolvedPath] = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path\\to\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].exe, resolvedPath);
        assert.deepStrictEqual(spawnCalls[0].args, ['-reuse-instance', '-page', '12', pdfPath]);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 0);
    });

    it('returns null and falls back to fallback command when manualsDir is not configured', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = undefined;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path\\to\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 0);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 1);
    });

    it('returns null and falls back when SumatraPDF.exe does not exist in manualsDir', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'C:\\custom\\manuals';
        mockExistsMap['C:\\custom\\manuals\\SumatraPDF.exe'] = false;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path\\to\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 0);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 1);
    });

    it('falls back to the system PDF handler when Sumatra launch fails', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'C:\\custom\\manuals';
        mockExistsMap['C:\\custom\\manuals\\SumatraPDF.exe'] = true;

        mockSpawnError = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path\\to\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 1);
    });

    it('passes shell metacharacters in PDF paths as opaque arguments', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'C:\\custom\\manuals';
        mockExistsMap['C:\\custom\\manuals\\SumatraPDF.exe'] = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path & 100%!\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].args.at(-1), pdfPath);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 0);
    });

    it('directly uses vscode.env.openExternal on non-Windows platforms', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = '/path/to/manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 0);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 1);
        assert.strictEqual(openExternalCalls[0].fsPath, '/path/to/manual.pdf');
    });

    it('re-resolves a stable chapter identity against the currently configured pack', async () => {
        const manualId = 'keyword-vol-ii-material-models';
        const createPack = (pdfFile, page) => createRuntimeManualPack({
            documents: [{
                slug: manualId,
                title: 'LS-DYNA dev Keyword Manual Vol II - Material Models',
                order: 2,
                pdfFile,
            }],
            sections: [{
                manualId,
                sectionId: 'mat-024',
                level: 2,
                titleEn: 'MAT_024/MAT_PIECEWISE_LINEAR_PLASTICITY',
                titleZh: '材料 024',
                anchors: ['mat-024'],
                pathEn: 'documents/en/vol-ii/mat-024.md',
                pathZh: 'documents/zh/vol-ii/mat-024.md',
                pdfPage: page,
            }],
            keywords: {
                '*MAT_024': {
                    manualId,
                    sectionId: 'mat-024',
                    anchorId: 'mat-024',
                    pdfPage: page,
                },
            },
        });
        const firstRoot = createPack('pdf/old-version.pdf', 338);
        const currentRoot = createPack('pdf/current-version.pdf', 356);
        const originalExecuteCommand = vscodeMock.commands.executeCommand;
        const executed = [];

        try {
            // The hover link may have been created for the first pack, but it
            // carries only chapter identity. The click must use current config.
            mockConfig.manualsDir = firstRoot;
            mockConfig.manualsDir = currentRoot;
            vscodeMock.commands.executeCommand = (...args) => {
                executed.push(args);
                return Promise.resolve();
            };

            const openPackChapter = registeredCommands.get('extension.manual.openPackChapter');
            await openPackChapter('*MAT_024', manualId, 'mat-024', 'pdf');

            assert.deepStrictEqual(executed, [[
                'extension.openManual',
                path.join(currentRoot, 'pdf', 'current-version.pdf'),
                356,
            ]]);
        } finally {
            vscodeMock.commands.executeCommand = originalExecuteCommand;
            fs.rmSync(firstRoot, { recursive: true, force: true });
            fs.rmSync(currentRoot, { recursive: true, force: true });
        }
    });

    it('does not guess a PDF or page when the structured chapter is incomplete', async () => {
        const manualId = 'keyword-vol-ii-material-models';
        const createIncompletePack = (pdfPage, createPdfs) => createRuntimeManualPack({
            sections: [{
                manualId,
                sectionId: 'mat-024',
                level: 2,
                titleEn: 'MAT_024/MAT_PIECEWISE_LINEAR_PLASTICITY',
                titleZh: '材料 024',
                anchors: ['mat-024'],
                pathEn: 'documents/en/vol-ii/mat-024.md',
                pathZh: 'documents/zh/vol-ii/mat-024.md',
                pdfPage,
            }],
            keywords: {
                '*MAT_024': {
                    manualId,
                    sectionId: 'mat-024',
                    anchorId: 'mat-024',
                    pdfPage,
                },
            },
            createPdfs,
        });
        const missingPageRoot = createIncompletePack(null, true);
        const missingPdfRoot = createIncompletePack(356, false);
        const originalExecuteCommand = vscodeMock.commands.executeCommand;
        const originalShowInformationMessage = vscodeMock.window.showInformationMessage;
        const originalGetManualLocations = require('../src/core/manualIndexer').getManualLocations;
        const messages = [];
        let opened = false;

        try {
            vscodeMock.commands.executeCommand = () => {
                opened = true;
                return Promise.resolve();
            };
            vscodeMock.window.showInformationMessage = message => {
                messages.push(message);
            };
            require('../src/core/manualIndexer').getManualLocations = () => {
                throw new Error('structured PDF open must not scan sibling PDFs');
            };
            const openPackChapter = registeredCommands.get('extension.manual.openPackChapter');

            mockConfig.manualsDir = missingPageRoot;
            await openPackChapter('*MAT_024', manualId, 'mat-024', 'pdf');
            mockConfig.manualsDir = missingPdfRoot;
            await openPackChapter('*MAT_024', manualId, 'mat-024', 'pdf');

            assert.strictEqual(opened, false);
            assert.deepStrictEqual(messages, [
                i18n.get('manualChapterPdfPageMissing', 'MAT_024/MAT_PIECEWISE_LINEAR_PLASTICITY'),
                i18n.get('manualReaderPdfNotFound'),
            ]);
        } finally {
            vscodeMock.commands.executeCommand = originalExecuteCommand;
            vscodeMock.window.showInformationMessage = originalShowInformationMessage;
            require('../src/core/manualIndexer').getManualLocations = originalGetManualLocations;
            fs.rmSync(missingPageRoot, { recursive: true, force: true });
            fs.rmSync(missingPdfRoot, { recursive: true, force: true });
        }
    });

    it('picks a real official chapter before opening the requested target', async () => {
        const manualId = 'keyword-vol-ii-material-models';
        const root = createRuntimeManualPack({
            sections: [
                {
                    manualId,
                    sectionId: 'mat-160',
                    level: 2,
                    titleEn: 'MAT_160/MAT_ALE_INCOMPRESSIBLE',
                    titleZh: '不可压缩 ALE 材料 160',
                    anchors: ['mat-160'],
                    pathEn: 'documents/en/vol-ii/mat-160.md',
                    pathZh: 'documents/zh/vol-ii/mat-160.md',
                    pdfPage: 1198,
                },
                {
                    manualId,
                    sectionId: 'mat-ale-05',
                    level: 2,
                    titleEn: 'MAT_ALE_05/MAT_ALE_INCOMPRESSIBLE',
                    titleZh: '不可压缩 ALE 材料 05',
                    anchors: ['mat-ale-05'],
                    pathEn: 'documents/en/vol-ii/mat-ale-05.md',
                    pathZh: 'documents/zh/vol-ii/mat-ale-05.md',
                    pdfPage: 2147,
                },
            ],
            keywords: {
                '*MAT_ALE_INCOMPRESSIBLE': {
                    manualId,
                    sectionId: 'mat-160',
                    anchorId: 'mat-160',
                    pdfPage: 1198,
                    alternateLocations: [{
                        manualId,
                        sectionId: 'mat-ale-05',
                        anchorId: 'mat-ale-05',
                        pdfPage: 2147,
                    }],
                },
            },
        });
        const originalShowQuickPick = vscodeMock.window.showQuickPick;
        const originalExecuteCommand = vscodeMock.commands.executeCommand;
        let picker;
        let executed;

        try {
            mockConfig.manualsDir = root;
            vscodeMock.window.showQuickPick = (items, options) => {
                picker = { items, options };
                return Promise.resolve(items[1]);
            };
            vscodeMock.commands.executeCommand = (...args) => {
                executed = args;
                return Promise.resolve();
            };

            const pickPackChapter = registeredCommands.get('extension.manual.pickPackChapter');
            await pickPackChapter('*MAT_ALE_INCOMPRESSIBLE', 'pdf');

            assert.strictEqual(picker.options.placeHolder, i18n.get('selectManualChapter'));
            assert.strictEqual(
                picker.items[1].label,
                '$(book) MAT_ALE_05/MAT_ALE_INCOMPRESSIBLE',
            );
            assert.deepStrictEqual(executed, [
                'extension.openManual',
                path.join(root, 'pdf', 'keyword-vol-ii.pdf'),
                2147,
            ]);
        } finally {
            vscodeMock.window.showQuickPick = originalShowQuickPick;
            vscodeMock.commands.executeCommand = originalExecuteCommand;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('shows the reader warning only for approximate keyword matches', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-reader-match-command-'));
        const indexes = path.join(root, 'indexes');
        fs.mkdirSync(indexes);
        fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
            schemaVersion: 1,
            generatedAt: '2026-07-27T00:00:00Z',
            documents: [{ slug: 'vol-i', title: 'Volume I', order: 1 }],
        }));
        fs.writeFileSync(path.join(indexes, 'keywords.json'), JSON.stringify({
            schemaVersion: 1,
            keywords: {},
        }));
        fs.writeFileSync(path.join(indexes, 'sections.json'), JSON.stringify({
            schemaVersion: 1,
            sections: [],
        }));
        fs.writeFileSync(path.join(indexes, 'anchors.json'), JSON.stringify({
            schemaVersion: 1,
            anchors: {},
        }));

        const { ManualIndexRepository } = require('../src/manual/ManualIndexRepository');
        const { ManualReaderPanel } = require('../src/manual/ManualReaderPanel');
        const originalResolveKeywordLocations = ManualIndexRepository.prototype.resolveKeywordLocations;
        const originalShowPanel = ManualReaderPanel.show;
        const originalShowInformationMessage = vscodeMock.window.showInformationMessage;
        const messages = [];
        let opened = 0;

        mockConfig.manualsDir = root;
        ManualIndexRepository.prototype.resolveKeywordLocations = function (keyword) {
            return [{
                manualId: 'vol-i',
                sectionId: 'material',
                anchorId: null,
                requestedKeyword: keyword,
                matchedKeyword: '*MAT_024',
                matchKind: keyword.includes('APPROXIMATE') ? 'approximate' : 'section',
            }];
        };
        ManualReaderPanel.show = () => { opened++; };
        vscodeMock.window.showInformationMessage = message => {
            messages.push(message);
        };

        try {
            const openCurrentKeyword = registeredCommands.get('extension.manual.openCurrentKeyword');
            assert.ok(openCurrentKeyword);
            await openCurrentKeyword('*MAT_APPROXIMATE_CASE');
            await openCurrentKeyword('*MAT_024_LOG_INTERPOLATION');

            assert.strictEqual(opened, 2);
            assert.deepStrictEqual(messages, [
                i18n.get(
                    'manualReaderApproximateMatch',
                    '*MAT_APPROXIMATE_CASE',
                    '*MAT_024'
                ),
            ]);
        } finally {
            ManualIndexRepository.prototype.resolveKeywordLocations = originalResolveKeywordLocations;
            ManualReaderPanel.show = originalShowPanel;
            vscodeMock.window.showInformationMessage = originalShowInformationMessage;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
