'use strict';
const makeTemp = require('../support/tempDirectories').trackTempDirectories();

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeDoc, vscodeMock } = require("../support/helpers");
const i18n = require("../../src/core/i18n");
const { DEFAULT_STRUCTURE_SOURCE_PROFILE_EN } = require("../../src/core/structure");
const extensionModule = require("../../src/extension");
const { planVerifiedConditionalCardsForDocument, handleAddVerifiedConditionalCardsCommand, handleRebuildCardCommentsCommand, planCardCommentRewriteForDocument, handleInsertVerifiedMissingRecordsCommand, buildKeywordStructureIssueMarkdown, keywordStructureRepairRequest, documentUriIdentity, LsdynaFieldCompletionProvider } = extensionModule._internals;
const { semanticEvidencePageLinks } = extensionModule._internals;
const { getKeywordSemanticAdviceForDocument, buildKeywordSemanticAdviceMarkdown, cardCommentRewriteRequest, handleCheckKeywordStructureCommand, analyzeKeywordStructureForDocument, keywordStructureAnalysisCacheStatsForTesting, handleOpenSemanticEvidenceCommand } = extensionModule._internals;
const { fieldReferenceAtPosition, resolveFieldReferenceNavigation, resolveRegistryReferenceNetwork, resolveWorkspaceReferenceSearch, handleWorkspaceReferenceSearchCommand, workspaceReferenceSearchPosition, inferIndexedEntityQueryTarget, resolveEntityReferenceCursorEditor, activeUnsynchronizedLargeFileUri, activeLargeFileViewerUri, presentIndexedEntityQueryResult, handleIndexedEntityIdQueryCommand, refreshCurrentEntityReferenceQuery, refreshStoredEntityReferenceQuery, prepareIndexedEntityQuerySnapshot, refreshCurrentEntityQueryAfterProjectScan, buildTablePreviewReferenceKey, getTablePreviewViewForReference, setTablePreviewViewForReference, clearTablePreviewViewsForTesting, handleSetTablePreviewViewCommand, clientProjectCacheStats, getFileIndexForDocument, clearClientProjectSemanticCaches, cacheRemovalTotals, handleClearProjectIndexCachesCommand, cacheLimitBytes, cacheLimitMilliseconds, getCardFieldsForLine } = extensionModule._internals;
const { LsdynaIncludeTreeProvider } = require("../../src/client/providers/includeTreeProvider");
const { LsdynaKeywordIndexProvider } = require("../../src/client/providers/keywordIndexProvider");
const { buildProjectIndex } = require("../../src/core/project/projectIndexer");
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
    // Exercise the retained QuickPick fallback directly; activated entry routing
    // is covered by the manager lifecycle and protocol tests.
    chooseKeywordOptionsQuickPickLegacy: chooseKeywordOptionsForEditor,
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
    const root = makeTemp(path.join(os.tmpdir(), 'lsdyna-runtime-pack-'));
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
        const root = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-case-action-'));
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
        }
    });

    it('preserves continued include layout while fixing path casing', async () => {
        const root = makeTemp(path.join(os.tmpdir(), 'lsdyna-continued-case-action-'));
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
        }
    });

    it('does not offer a stale include casing fix after the target is removed', async () => {
        const root = makeTemp(path.join(os.tmpdir(), 'lsdyna-stale-include-action-'));
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
        }
    });

    it('does not resolve an include casing edit after the target is removed while the action is open', async () => {
        const root = makeTemp(path.join(os.tmpdir(), 'lsdyna-open-include-action-'));
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
        }
    });

    it('does not offer a stale include casing fix over newly edited path text', async () => {
        const root = makeTemp(path.join(os.tmpdir(), 'lsdyna-edited-include-action-'));
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

const FIXTURE_DIR = path.join(__dirname, "../Bolt_A_Explicit");

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

        assert.ok(defs.has('tEnd'));
        assert.ok(defs.has('dtPlot'));
        assert.equal(findParameterReferences(doc).filter(ref => ref.name === 'tEnd').length, 1);
    });

    it('finds basic *PARAMETER definitions', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\nI  count  10\n');
        const defs = findParameterDefinitions(doc);
        assert.equal(defs.size, 2);
        assert.ok(defs.has('tEnd'));
        assert.equal(defs.get('tEnd')[0].value, '5.0');
        assert.equal(defs.get('count')[0].value, '10');
    });

    it('finds *PARAMETER_EXPRESSION definitions', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*PARAMETER_EXPRESSION\nR  dtPlot  tEnd/100.0\n');
        const defs = findParameterDefinitions(doc);
        assert.ok(defs.has('dtPlot'));
        assert.equal(defs.get('dtPlot')[0].value, 'tEnd/100.0');
    });

    it('preserves exact spelling on key lookup', () => {
        const doc = fakeDoc('*PARAMETER\nR  MyParam  42.0\n');
        const defs = findParameterDefinitions(doc);
        assert.ok(defs.has('MyParam'));
        assert.equal(defs.has('MYPARAM'), false);
        assert.equal(defs.get('MyParam')[0].name, 'MyParam');
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
        const def = defs.get('tEnd')[0];
        assert.equal(def.lineIndex, 1);
        assert.equal(doc.lineAt(def.lineIndex).text.slice(def.startChar, def.startChar + def.length), 'tEnd');
    });

    it('parses the real fixture file', () => {
        const fs = require('fs');
        const text = fs.readFileSync(path.join(FIXTURE_DIR, 'mainboltaexpl.k'), 'utf8');
        const doc = fakeDoc(text, path.join(FIXTURE_DIR, 'mainboltaexpl.k'));
        const defs = findParameterDefinitions(doc);
        assert.ok(defs.has('tEnd'));
        assert.ok(defs.has('dtPlot'));
        assert.ok(defs.has('bltForce'));
    });
});

// ---------------------------------------------------------------------------
// findParameterReferences
// ---------------------------------------------------------------------------

describe('findParameterReferences', () => {
    it('finds &name references', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*CONTROL_TERMINATION\n     &tEnd\n');
        const refs = findParameterReferences(doc);
        const r = refs.filter(r => r.name === 'tEnd');
        assert.equal(r.length, 1);
        assert.equal(r[0].lineIndex, 3);
    });

    it('finds multiple references to same parameter', () => {
        const doc = fakeDoc('*PARAMETER\nR  t  5.0\n*KEYWORD\n&t  &t\n');
        const refs = findParameterReferences(doc).filter(r => r.name === 't');
        assert.equal(refs.length, 2);
    });

    it('finds bare name references in *PARAMETER_EXPRESSION values', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*PARAMETER_EXPRESSION\nR  dtPlot  tEnd/100.0\n');
        const refs = findParameterReferences(doc).filter(r => r.name === 'tEnd');
        assert.equal(refs.length, 1);
        assert.equal(refs[0].lineIndex, 3);
    });

    it('does not treat expression definition name as a reference', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*PARAMETER_EXPRESSION\nR  dtPlot  tEnd/100.0\n');
        const refs = findParameterReferences(doc).filter(r => r.name === 'dtPlot');
        assert.equal(refs.length, 0);
    });

    it('skips comment lines', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n$ &tEnd this is a comment\n');
        const refs = findParameterReferences(doc).filter(r => r.name === 'tEnd');
        assert.equal(refs.length, 0);
    });
});

function useScopedParameterDocument(document) {
    extensionModule._internals.setReferenceQueryClientForTesting(
        require('../support/parameter-project.cjs').parameterDocumentQueryClient(document));
}

describe('parameter completion edit boundaries', () => {
    const Provider = extensionModule._internals.LsdynaParameterCompletionProvider;
    let previousEditor, previousRelativePath;
    beforeEach(() => {
        previousEditor = vscodeMock.window.activeTextEditor;
        previousRelativePath = vscodeMock.workspace.asRelativePath;
        vscodeMock.workspace.asRelativePath = file => file;
    });
    afterEach(() => {
        extensionModule._internals.setReferenceQueryClientForTesting(null);
        vscodeMock.window.activeTextEditor = previousEditor;
        vscodeMock.workspace.asRelativePath = previousRelativePath;
    });
    it('fits a full-width name, rejects negated overflow and preserves neighbouring fields', async () => {
        for (const [width, negative] of [[10, false], [10, true], [20, true]]) {
            const record = 'Ruse'.padStart(width) + `${negative ? '-' : ''}&lo`.padStart(width) +
                'Rother'.padStart(width) + '3'.padStart(width);
            const doc = fakeDoc(['*PARAMETER', 'Rlong,2,RlongName9,4',
                width === 20 ? '*PARAMETER+' : '*PARAMETER', record].join('\n'));
            useScopedParameterDocument(doc);
            const result = await new Provider().provideCompletionItems(doc, new vscodeMock.Position(3, width * 2));
            assert.ok(result.items.some(item => item.label === 'long'));
            const item = result.items.find(item => item.label === 'longName9');
            if (width === 10 && negative) { assert.equal(item, undefined); continue; }
            assert.ok(item);
            assert.equal(item.range.start.character, width);
            assert.equal(item.range.end.character, width * 2);
            const edited = record.slice(0, item.range.start.character) + item.insertText + record.slice(item.range.end.character);
            assert.equal(edited, record.slice(0, width) + `${negative ? '-' : ''}&longName9`.padStart(width) + record.slice(width * 2));
            assert.equal(doc.lineAt(3).text, record);
        }
    });
    it('does not use conversion-template columns to edit an ordinary comma record', async () => {
        const doc = fakeDoc('*PARAMETER\nRbase,2\n*NODE\n1,0,0,0,' + '&ba'.padStart(16) + ',0');
        extensionModule._internals.setReferenceQueryClientForTesting({ sourceAnalysis: () => assert.fail('Unverified write range') });
        assert.equal(await new Provider().provideCompletionItems(doc, new vscodeMock.Position(3, 24)), null);
    });
    it('keeps comma parameter expression completion token-based', async () => {
        const doc = fakeDoc('*PARAMETER\nRlongName9,4\n*PARAMETER_EXPRESSION\nRuse,lo+1');
        useScopedParameterDocument(doc);
        const result = await new Provider().provideCompletionItems(doc, new vscodeMock.Position(3, 7));
        const item = result.items.find(item => item.label === 'longName9');
        assert.ok(item);
        assert.equal(item.range.start.character, 5);
        assert.equal(item.range.end.character, 7);
        assert.equal(item.insertText, 'longName9');
    });
    it('rejects multiple cursors before and during a completion query', async () => {
        const doc = fakeDoc('*PARAMETER\nRbase,2\n*PARAMETER\nRuse,&ba');
        const editor = { document: doc, selections: [{}] };
        vscodeMock.window.activeTextEditor = editor;
        useScopedParameterDocument(doc);
        const provider = new Provider(), position = new vscodeMock.Position(3, 8);
        assert.ok((await provider.provideCompletionItems(doc, position)).items.some(item => item.label === 'base'));
        const client = require('../support/parameter-project.cjs').parameterDocumentQueryClient(doc);
        extensionModule._internals.setReferenceQueryClientForTesting({ sourceAnalysis: async request => {
            editor.selections = [{}, {}];
            return client.sourceAnalysis(request);
        } });
        assert.equal(await provider.provideCompletionItems(doc, position), null);
        extensionModule._internals.setReferenceQueryClientForTesting({ sourceAnalysis: () => assert.fail('Multiple cursors') });
        assert.equal(await provider.provideCompletionItems(doc, position), null);
    });
});

describe('parameter navigation and rename providers', () => {
    afterEach(() => extensionModule._internals.setReferenceQueryClientForTesting(null));
    it('discards parameter locations after the source version changes during a query', async () => {
        const doc = fakeDoc('*PARAMETER\nRbase,2\n*NODE\n1,&base,0,0');
        const before = doc.getText();
        extensionModule._internals.setReferenceQueryClientForTesting({ sourceAnalysis: async request => {
            assert.equal(request.mode, 'parameter-navigation'); assert.equal(request.name, 'base');
            doc.version++;
            return { status: 'ready', items: [{ filePath: doc.uri.fsPath, line: 1, startCharacter: 1, endCharacter: 5 }] };
        } });
        assert.equal(await new LsdynaDefinitionProvider().provideDefinition(doc, new vscodeMock.Position(3, 4)), null);
        assert.equal(doc.getText(), before);
    });
    it('keeps untitled parameter queries out of the disk worker and leaves text intact', async () => {
        const doc = fakeDoc('*PARAMETER\nRbase,2\n*NODE\n1,&base,0,0', 'Untitled-1');
        doc.uri.scheme = 'untitled';
        const original = doc.getText();
        extensionModule._internals.setReferenceQueryClientForTesting({ sourceAnalysis: () => assert.fail('No local source') });
        assert.equal(await new LsdynaDefinitionProvider().provideDefinition(doc, new vscodeMock.Position(3, 4)), null);
        assert.equal(doc.getText(), original);
    });
    it('navigates parameter records without changing source bytes or offering format conversion', async () => {
        const originalExecute = vscodeMock.commands.executeCommand;
        const calls = [];
        vscodeMock.commands.executeCommand = async (...args) => calls.push(args);
        try {
            for (const rows of [
                ['*PARAMETER', 'Rfoo,1'],
                ['*PARAMETER', 'Rfoo      1.0'],
                ['*PARAMETER_TYPE', 'Ipartid,1,PID'],
                ['*PARAMETER_EXPRESSION', 'Rfoo      min(1,2)'],
                ['*PARAMETER_EXPRESSION', 'Rfoo      1+', '          2'],
                ['*KEYWORD LONG=Y', '*PARAMETER_EXPRESSION', 'Rfoo'.padEnd(20) + 'min(1,2)'],
            ]) {
                const editor = makeEditableEditor(rows, rows.length - 1);
                const original = rows.join('\n');
                await extensionModule._internals.handleTabAlignment(editor, 1);
                assert.ok(editor.selection.active.character > 0);
                for (const direction of [1, 1, -1, -1]) {
                    await extensionModule._internals.handleTabAlignment(editor, direction);
                    assert.equal(editor.lines.join('\n'), original);
                    assert.deepEqual(editor.selection.anchor, editor.selection.active);
                }
            }
            assert.ok(!calls.some(args => ['tab', 'outdent', 'editor.action.triggerSuggest'].includes(args[0])));
        } finally { vscodeMock.commands.executeCommand = originalExecute; }
    });

    it('never converts inline parameter expressions into fixed columns', () => {
        const card = [{ n: 'A', p: 0, w: 10 }, { n: 'B', p: 10, w: 10 }];
        for (const source of ['<base+1>,2', '<min(1,2)>,3']) {
            const result = extensionModule._internals.planAlignedLine(source, card, false,
                { allowAmbiguousTrailing: true, forceValueOrder: true });
            assert.equal(result.status, 'unsafe');
            assert.equal(result.text, source);
        }
    });
    it('uses current manual parameter help in the actual field hover provider', async () => {
        const doc = fakeDoc('*PARAMETER\nRfoo      1.0');
        const hover = await new LsdynaFieldHoverProvider().provideHover(doc, { line: 1, character: 0 });
        const text = hover.contents.map(item => item.value || item).join('\n');
        assert.ok(text.includes('1-9'));
        assert.ok(text.includes('C (character)'));
        assert.ok(!text.includes('7 characters'));
    });
    it('renames numeric references without changing literal character expressions or continuations', () => {
        const doc = fakeDoc('*PARAMETER\nRbase,2\n*PARAMETER_EXPRESSION\nClabel,base\n          base\nRresult,base+1');
        const edit = new LsdynaRenameProvider().provideRenameEdits(doc, { line: 1, character: 2 }, 'other');
        assert.deepEqual(edit.edits.map(change => change.range.start.line), [1, 5]);
    });
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
        for (const replacement of edit.edits.slice(0, 2)) {
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
            '   &finish\n'
        );
    });

    it('keeps standard CONTROL_TIMESTEP and native long PART columns fixed when names change', () => {
        for (const width of [10, 20]) {
            const row = ['0.0', '&tssfac', '0', '0.0', '', '&lctmcrv', '1', '0']
                .map(value => value.padStart(width)).join('');
            const source = ['*KEYWORD' + (width === 20 ? ' LONG=Y' : ''), '*PARAMETER_EXPRESSION',
                'I lctmcrv'.padEnd(width) + 'mxcrvid+8', width === 20 ? '*PART\ntitle' : '*CONTROL_TIMESTEP',
                '$   DTINIT    TSSFAC      ISDO    TSLIMT     DT2MS      LCTM     ERODE     MS1ST', row, '*END'].join('\n');
            for (const name of ['lctmcrv1', 'lc']) {
                const doc = fakeDoc(source);
                const edit = new LsdynaRenameProvider().provideRenameEdits(doc, new vscodeMock.Position(2, 3), name);
                const result = applyWorkspaceEdits(doc, edit).split('\n');
                const data = result[width === 20 ? 6 : 5];
                assert.equal(result[2].slice(width), 'mxcrvid+8');
                assert.equal(result[2].slice(0, width).trim(), 'I ' + name);
                assert.equal(data.length, row.length);
                assert.equal(data.slice(0, width * 5), row.slice(0, width * 5));
                assert.equal(data.slice(width * 5, width * 6), ('&' + name).padStart(width));
                assert.equal(data.slice(width * 6), row.slice(width * 6));
            }
        }
    });

    it('keeps comma fields, formulas and text cards as token replacements', () => {
        for (const [keyword, row] of [
            ['*CONTROL_TIMESTEP', '0.0,&tssfac,0,0.0,,&lctmcrv,1,0'],
            ['*PARAMETER_EXPRESSION', 'R other   &lctmcrv+8'],
            ['*TITLE', 'Title &lctmcrv text'],
        ]) {
            const doc = fakeDoc('*PARAMETER\nI lctmcrv  1\n' + keyword + '\n' + row);
            const edit = new LsdynaRenameProvider().provideRenameEdits(doc, new vscodeMock.Position(1, 3), 'lctmcrv1');
            assert.equal(applyWorkspaceEdits(doc, edit).split('\n')[3], row.replace('&lctmcrv', '&lctmcrv1'));
        }
    });

    it('uses native NODE field widths and keeps multiple references in one row independent', () => {
        const row = ['&nodeid'.padStart(8), '&nodeid'.padStart(16), '2'.padStart(16),
            '3'.padStart(16), '0'.padStart(8), '0'.padStart(8)].join('');
        const doc = fakeDoc('*PARAMETER\n' + 'I nodeid'.padEnd(10) + '1'.padStart(10) + '\n*NODE\n' + row);
        const provider = new LsdynaRenameProvider();
        const edit = provider.provideRenameEdits(doc, new vscodeMock.Position(1, 3), 'nodeidx');
        const result = applyWorkspaceEdits(doc, edit).split('\n')[3];
        assert.equal(result.length, row.length);
        assert.equal(result.slice(0, 8), '&nodeidx');
        assert.equal(result.slice(8, 24), '&nodeidx'.padStart(16));
        assert.equal(result.slice(24), row.slice(24));
        assert.throws(() => provider.provideRenameEdits(doc, new vscodeMock.Position(1, 3), 'nodeidx1'), /field width/);
    });

    it('keeps every fixed declaration slot and value when the name fills its descriptor', () => {
        const row = Array.from({ length: 4 }, (_, i) => 'I short'.padEnd(10) + String(i + 1).padStart(10)).join('');
        const doc = fakeDoc('*PARAMETER\n' + row);
        const edit = new LsdynaRenameProvider().provideRenameEdits(doc, new vscodeMock.Position(1, 3), 'longname9');
        const result = applyWorkspaceEdits(doc, edit).split('\n')[1];
        assert.equal(result.length, 80);
        for (let i = 0; i < 4; i++) {
            assert.equal(result.slice(i * 20, i * 20 + 10), 'Ilongname9');
            assert.equal(result.slice(i * 20 + 10, i * 20 + 20), row.slice(i * 20 + 10, i * 20 + 20));
        }
        assert.equal(findParameterDefinitions(fakeDoc('*PARAMETER\n' + result)).get('longname9').length, 4);
    });

    it('preserves negative references and rejects overflow without returning partial edits', () => {
        const row = ['0.0', '0.9', '0', '0.0', '', '-&lctmcrv', '1', '0']
            .map(value => value.padStart(10)).join('');
        const doc = fakeDoc('*PARAMETER\nI lctmcrv  1\n*CONTROL_TIMESTEP\n' + row);
        const provider = new LsdynaRenameProvider();
        const edit = provider.provideRenameEdits(doc, new vscodeMock.Position(1, 3), 'lctmcrv1');
        assert.equal(applyWorkspaceEdits(doc, edit).split('\n')[3].slice(50, 60), '-&lctmcrv1'.padStart(10));
        assert.throws(() => provider.provideRenameEdits(doc, new vscodeMock.Position(1, 3), 'lctmcrv12'), /field width/);
        assert.equal(doc.lineAt(3).text, row);
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

    it('navigates to every definition on a multi-parameter line', async () => {
        const dataLine = 'R p1 1.0 I p2 2 R p3 3.0 C p4 text';
        const doc = fakeDoc(
            '*PARAMETER\n' +
            dataLine + '\n' +
            '*KEYWORD\n' +
            '&p1 &p2 &p3 &p4\n'
        );
        useScopedParameterDocument(doc);
        const definitionProvider = new LsdynaDefinitionProvider();
        const codeLensProvider = new LsdynaParameterCodeLensProvider();
        const renameProvider = new LsdynaRenameProvider();

        for (const name of ['p1', 'p2', 'p3', 'p4']) {
            const referenceColumn = doc.lineAt(3).text.indexOf(`&${name}`) + 1;
            const location = await definitionProvider.provideDefinition(
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

    it('supports prepare rename, references, and definition lookup for compact syntax', async () => {
        const doc = fakeDoc(
            '*PARAMETER\n' +
            'Rrho     7850.\n' +
            '*KEYWORD\n' +
            '&rho\n'
        );
        const renameProvider = new LsdynaRenameProvider();
        useScopedParameterDocument(doc);
        const definitionProvider = new LsdynaDefinitionProvider();
        const referenceProvider = new LsdynaReferenceProvider();
        const definitionPosition = new vscodeMock.Position(1, 2);

        const renameRange = renameProvider.prepareRename(doc, definitionPosition);
        assert.equal(doc.getText(renameRange), 'rho');

        const definition = await definitionProvider.provideDefinition(
            doc,
            new vscodeMock.Position(3, 2)
        );
        assert.equal(definition.range.start.line, 1);
        assert.equal(definition.range.start.character, 1);

        const references = await referenceProvider.provideReferences(
            doc,
            definitionPosition,
            { includeDeclaration: true }
        );
        assert.equal(references.length, 1);
        assert.equal(references[0].range.start.line, 3);
    });

    it('finds same-name references while preserving mutable definition and rename behavior', async () => {
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
        useScopedParameterDocument(doc);
        const definitionProvider = new LsdynaDefinitionProvider();
        const referenceProvider = new LsdynaReferenceProvider();
        const renameProvider = new LsdynaRenameProvider();

        const definitions = await definitionProvider.provideDefinition(
            doc,
            new vscodeMock.Position(7, 2),
        );
        assert.equal(definitions.range.start.line, 3);

        const references = await referenceProvider.provideReferences(
            doc,
            new vscodeMock.Position(1, 2),
            { includeDeclaration: true },
        );
        assert.deepEqual(references.map(location => location.range.start.line), [5, 7]);

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
    it('localizes the on-demand parameter reference action in Chinese', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'language' ? 'zh-cn' : defaultValue
        });
        i18n.updateLanguage();

        try {
            const provider = new LsdynaParameterCodeLensProvider();
            const lenses = provider.provideCodeLenses(fakeDoc('*PARAMETER\nR  t  1.0\n*KEYWORD\n&t  &t\n'));

            assert.equal(lenses.length, 1);
            assert.equal(lenses[0].command.title, '查找引用');
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
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-tree-'));
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
        }
    });

    it('builds include tree items from a project snapshot', () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-tree-'));
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

        {
            const root = provider._buildRootFromSnapshot(snapshot, mainFile);
            assert.equal(root.filePath, mainFile);
            assert.deepEqual(root.children.map(child => child.filePath), [aFile]);
            assert.deepEqual(root.children[0].children.map(child => child.filePath), [bFile]);
        }
    });

    it('preserves missing include nodes when building tree items from a project snapshot', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-tree-'));
        const mainFile = path.join(tempRoot, 'main.k');
        const childFile = path.join(tempRoot, 'child.key');
        const missingFile = path.join(tempRoot, 'missing.key');
        const provider = new LsdynaIncludeTreeProvider({ searchFileFromPaths });

        fs.writeFileSync(mainFile, '*INCLUDE\nchild.key\nmissing.key\n', 'utf8');
        fs.writeFileSync(childFile, '*KEYWORD\n', 'utf8');

        {
            const snapshot = await buildProjectIndex(mainFile);
            const root = provider._buildRootFromSnapshot(snapshot, mainFile);

            assert.deepEqual(root.children.map(child => child.filePath), [childFile, missingFile]);
            assert.equal(root.children[1].description, 'missing');
            assert.equal(root.children[1].command, undefined);
            assert.equal(root.children[1].collapsibleState, vscodeMock.TreeItemCollapsibleState.None);
        }
    });

    it('preserves duplicate missing include nodes when building tree items from a project snapshot', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-tree-'));
        const mainFile = path.join(tempRoot, 'main.k');
        const childFile = path.join(tempRoot, 'child.key');
        const missingFile = path.join(tempRoot, 'missing.key');
        const provider = new LsdynaIncludeTreeProvider({ searchFileFromPaths });

        fs.writeFileSync(mainFile, '*INCLUDE\nmissing.key\nmissing.key\nchild.key\n', 'utf8');
        fs.writeFileSync(childFile, '*KEYWORD\n', 'utf8');

        {
            const snapshot = await buildProjectIndex(mainFile);
            const root = provider._buildRootFromSnapshot(snapshot, mainFile);

            assert.deepEqual(root.children.map(child => child.filePath), [missingFile, missingFile, childFile]);
            assert.equal(root.children[0].description, 'missing');
            assert.equal(root.children[1].description, 'missing');
            assert.equal(root.children[0].command, undefined);
            assert.equal(root.children[1].command, undefined);
        }
    });

    it('uses the shared project snapshot loader during scans when available', async () => {
        const rootFile = path.join('project', 'snapshot-root', 'main.k');
        const aFile = path.join('project', 'snapshot-root', 'a.key');
        const cancellationToken = { isCancellationRequested: false };
        let progressOptions = null;
        const provider = new LsdynaIncludeTreeProvider({
            searchFileFromPaths() {
                throw new Error('searchFileFromPaths should not be used when loadProjectSnapshot is available');
            },
            loadProjectSnapshot: async (filePath, _options, _onProgress, token) => {
                assert.equal(filePath, rootFile);
                assert.equal(token.isCancellationRequested, cancellationToken.isCancellationRequested);
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
        vscodeMock.window.withProgress = async (options, task) => {
            progressOptions = options;
            return task({ report() {} }, cancellationToken);
        };
        vscodeMock.ProgressLocation = { Notification: 15 };

        try {
            const scanResult = await provider.scan();

            assert.ok(provider.root);
            assert.equal(provider.root.filePath, rootFile);
            assert.equal(scanResult.rootFile, rootFile);
            assert.ok(scanResult.snapshot.graph);
            assert.deepEqual(provider.root.children.map(child => child.filePath), [aFile]);
            assert.deepEqual(progressOptions.location, { viewId: 'lsdynaIncludeTree' });
            assert.equal(progressOptions.cancellable, undefined);
        } finally {
            vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            vscodeMock.window.withProgress = originalWithProgress;
            vscodeMock.ProgressLocation = originalProgressLocation;
        }
    });

    it('keeps final include decorations consistent after a file disappears between scan stages', async () => {
        const directory = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-stages-'));
        const rootFile = path.join(directory, 'main.k');
        const childFile = path.join(directory, 'child.k');
        fs.writeFileSync(rootFile, '*INCLUDE\nchild.k\n');
        fs.writeFileSync(childFile, '*KEYWORD\n');
        const { normalizePathKey, LsdynaFileDecorationProvider } = extensionModule._internals;
        const childKey = normalizePathKey(childFile);
        const provider = new LsdynaIncludeTreeProvider({
            loadProjectSnapshot: async (_root, _options, onProgress) => {
                const snapshot = await buildProjectIndex(rootFile);
                onProgress({ type: 'structureReady', snapshot });
                assert.equal(provider.root.children[0].contextValue, 'file');
                fs.unlinkSync(childFile);
                return snapshot;
            },
        });
        const originalEditor = vscodeMock.window.activeTextEditor;
        const originalProgress = vscodeMock.window.withProgress;
        const originalLocation = vscodeMock.ProgressLocation;
        vscodeMock.ProgressLocation = { Window: 10 };
        vscodeMock.window.activeTextEditor = { document: fakeDoc('*INCLUDE\nchild.k\n', rootFile) };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} }, {});
        try {
            const result = await provider.scan();
            assert.equal(Boolean(result.snapshot.graph.toTree(rootFile).children[0].missing), false);
            assert.equal(provider.scanPhase, 'complete');
            assert.equal(provider.root.children[0].contextValue, 'file-missing');
            assert.equal(provider.root.children[0].command, undefined);
            assert.equal(provider.listSearchEntries().find(entry => entry.filePath === childFile).missing, true);
            assert.equal(provider.missingPaths.has(childKey), true);
            assert.equal(provider.resolvedPaths.has(childKey), false);
            const decoration = new LsdynaFileDecorationProvider(provider).provideFileDecoration({ scheme: 'file', fsPath: childFile });
            assert.equal(decoration.badge, '!');
        } finally {
            vscodeMock.window.activeTextEditor = originalEditor;
            vscodeMock.window.withProgress = originalProgress;
            vscodeMock.ProgressLocation = originalLocation;
        }
    });

    it('does not publish a completed include scan when current file metadata is inaccessible', async () => {
        const directory = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-access-'));
        const rootFile = path.join(directory, 'main.k');
        const childFile = path.join(directory, 'child.k');
        fs.writeFileSync(rootFile, '*INCLUDE\nchild.k\n');
        fs.writeFileSync(childFile, '*KEYWORD\n');
        const originalStat = fs.statSync;
        const failure = Object.assign(new Error('fixture metadata access denied'), { code: 'EACCES' });
        const provider = new LsdynaIncludeTreeProvider({
            loadProjectSnapshot: async (_root, _options, onProgress) => {
                const snapshot = await buildProjectIndex(rootFile);
                onProgress({ type: 'structureReady', snapshot });
                fs.statSync = function (file) {
                    if (file === childFile) throw failure;
                    return originalStat.apply(this, arguments);
                };
                return snapshot;
            },
        });
        const originalEditor = vscodeMock.window.activeTextEditor;
        const originalProgress = vscodeMock.window.withProgress;
        const originalLocation = vscodeMock.ProgressLocation;
        vscodeMock.ProgressLocation = { Window: 10 };
        vscodeMock.window.activeTextEditor = { document: fakeDoc('*INCLUDE\nchild.k\n', rootFile) };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} }, {});
        try {
            await assert.rejects(provider.scan(), error => error === failure);
            assert.equal(provider.scanPhase, 'incomplete');
            assert.strictEqual(provider.root, provider.structureRoot);
            assert.equal(provider.missingPaths.size, 0);
        } finally {
            fs.statSync = originalStat;
            vscodeMock.window.activeTextEditor = originalEditor;
            vscodeMock.window.withProgress = originalProgress;
            vscodeMock.ProgressLocation = originalLocation;
        }
    });

    it('keeps the previous include tree when a cancellable project scan stops', async () => {
        const rootFile = path.join('project', 'cancelled-include', 'main.k');
        const cancellationToken = { isCancellationRequested: false };
        const previousRoot = { filePath: 'previous.k', children: [] };
        const provider = new LsdynaIncludeTreeProvider({
            loadProjectSnapshot: async (_filePath, _options, onProgress) => {
                onProgress({ files: [rootFile] });
                cancellationToken.isCancellationRequested = true;
                const error = new Error('cancelled fixture');
                error.name = 'CancellationError';
                throw error;
            },
        });
        provider.root = previousRoot;
        provider.resolvedPaths.set('previous', '1 KB');
        const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
        const originalWithProgress = vscodeMock.window.withProgress;
        const originalProgressLocation = vscodeMock.ProgressLocation;
        vscodeMock.window.activeTextEditor = {
            document: { languageId: 'lsdyna', uri: { fsPath: rootFile } },
        };
        vscodeMock.window.withProgress = async (_options, task) =>
            task({ report() {} }, cancellationToken);
        vscodeMock.ProgressLocation = { Notification: 15 };

        try {
            await provider.scan();
            assert.strictEqual(provider.root, previousRoot);
            assert.equal(provider.resolvedPaths.get('previous'), '1 KB');
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
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-keyword-index-'));
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
        }
    });
});

describe('activate', () => {
    it('registers delayed refresh disposal with the extension context', async () => {
        const context = { subscriptions: [] };
        try {
            await extensionModule.activate(context);
            const delayed = context.subscriptions.filter(item => typeof item === 'function' && typeof item.dispose === 'function');
            assert.equal(delayed.length, 3);
            assert.ok(delayed.some(item => item.name === 'enqueueProjectSnapshotRefresh'));
            assert.ok(delayed.some(item => item.name === 'queueChangedFile'));
        } finally { for (const resource of context.subscriptions) resource?.dispose?.(); }
    });

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
            assert.deepEqual(watcherGlobs, ['**/*.dyna', '**/*.k', '**/*.key']);
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
    it('returns asynchronous invalidation failures to its caller', async () => {
        const failure = Error('invalidation failed');
        const invalidator = createManifestDrivenInvalidator({
            indexClient: { getManifestEntries: () => [], invalidate: async () => { throw failure; } },
            findAffectedRoots: () => ['/project/main.k'],
        });
        await assert.rejects(invalidator('/project/child.k'), error => error === failure);
    });

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
    for (const phase of ['manifest', 'timer', 'invalidation']) it(`stops new work when disposed during ${phase}`, async () => {
        let finishManifest, finishInvalidation, scheduled;
        const completed = [], invalidated = [], cancelled = [];
        const invalidator = createBatchedManifestInvalidator({
            indexClient: {
                getManifestEntries: () => new Promise(resolve => { finishManifest = resolve; }),
                invalidate: root => { invalidated.push(root); return new Promise(resolve => { finishInvalidation = resolve; }); },
            },
            findAffectedRoots: () => ['/project/main.k'],
            schedule: callback => { scheduled = callback; return callback; },
            cancel: timer => cancelled.push(timer),
            onInvalidatedRoots: roots => completed.push(roots),
        });
        const lookup = invalidator('/project/child.k');
        if (phase !== 'manifest') { finishManifest([]); await lookup; }
        if (phase === 'invalidation') scheduled();
        invalidator.dispose();
        invalidator.dispose();
        invalidator('/project/later.k');
        if (phase === 'manifest') { finishManifest([]); await lookup; assert.equal(scheduled, undefined); }
        if (phase === 'timer') { assert.ok(cancelled.includes(scheduled)); scheduled(); }
        if (phase === 'invalidation') finishInvalidation();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(invalidated, phase === 'invalidation' ? ['/project/main.k'] : []);
        assert.deepEqual(completed, []);
    });

    it('observes an in-flight invalidation rejection after disposal', async () => {
        let scheduled, rejectInvalidation;
        const errors = [], failure = Error('invalidation failed during shutdown');
        const invalidator = createBatchedManifestInvalidator({
            indexClient: { getManifestEntries: () => [], invalidate: () => new Promise((_, reject) => { rejectInvalidation = reject; }) },
            findAffectedRoots: () => ['/project/main.k'], schedule: callback => { scheduled = callback; },
            onError: error => errors.push(error),
        });
        invalidator('/project/child.k');
        scheduled();
        invalidator.dispose();
        rejectInvalidation(failure);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(errors, [failure]);
    });

    it('observes earlier rejected invalidations even when a later root throws synchronously', async () => {
        let scheduled;
        const failure = Error('earlier invalidation failed'), errors = [], attempted = [];
        const roots = ['/project/main.k', '/project/other.k'];
        const invalidator = createBatchedManifestInvalidator({
            indexClient: { getManifestEntries: () => [], invalidate: root => {
                attempted.push(root);
                if (root === roots[0]) return Promise.reject(failure);
                throw Error('later invalidation failed');
            } },
            findAffectedRoots: () => roots, schedule: callback => { scheduled = callback; },
            onError: error => errors.push(error),
        });
        invalidator('/project/child.k');
        scheduled();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(attempted, roots);
        assert.equal(errors.length, 1);
        assert.ok(errors[0] === failure || errors[0].message === 'later invalidation failed');
    });

    it('publishes completion only after every asynchronous invalidation finishes', async () => {
        let scheduled;
        const completed = [], finishes = [];
        const roots = ['/project/main.k', '/project/other.k'];
        const invalidator = createBatchedManifestInvalidator({
            indexClient: { getManifestEntries: () => [], invalidate: () => new Promise(resolve => { finishes.push(resolve); }) },
            findAffectedRoots: () => roots, schedule: callback => { scheduled = callback; },
            onInvalidatedRoots: values => completed.push(values),
        });
        invalidator('/project/child.k');
        scheduled();
        assert.deepEqual(completed, []);
        finishes[0]();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(completed, []);
        finishes[1]();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(completed, [roots]);
    });

    for (const asynchronous of [false, true]) it(`reports ${asynchronous ? 'async' : 'sync'} invalidation failure without publishing success`, async () => {
        let scheduled;
        const failure = Error('invalidation failed'), errors = [], completed = [];
        const invalidator = createBatchedManifestInvalidator({
            indexClient: { getManifestEntries: () => [], invalidate: () => {
                if (asynchronous) return Promise.reject(failure);
                throw failure;
            } },
            findAffectedRoots: () => ['/project/main.k'], schedule: callback => { scheduled = callback; },
            onInvalidatedRoots: roots => completed.push(roots), onError: (error, file) => errors.push([error, file]),
        });
        invalidator('/project/child.k');
        scheduled();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(errors, [[failure, '/project/child.k']]);
        assert.deepEqual(completed, []);
    });

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
    for (const failed of [false, true]) it(`keeps one same-root refresh after an active load ${failed ? 'fails' : 'finishes'}`, async () => {
        const root = path.resolve('/project/main.k'), started = [], finishes = [], errors = [];
        const failure = Error('old generation cancelled');
        const enqueue = createProjectSnapshotRefreshQueue({
            loadProjectSnapshot: file => { started.push(file); return new Promise((resolve, reject) => { finishes.push(() => failed && started.length === 1 ? reject(failure) : resolve()); }); },
            onError: error => errors.push(error),
        });
        try {
            enqueue(root);
            await new Promise(resolve => setImmediate(resolve));
            enqueue(root); enqueue(root);
            finishes.shift()();
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(started, [root, root]);
            assert.deepEqual(errors, failed ? [failure] : []);
            finishes.shift()();
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(started, [root, root]);
        } finally { enqueue.dispose(); }
    });

    it('cancels the native immediate and ignores later refresh requests after disposal', async () => {
        const started = [];
        const enqueue = createProjectSnapshotRefreshQueue({ loadProjectSnapshot: async root => { started.push(root); } });
        enqueue('/project/main.k');
        enqueue.dispose();
        enqueue.dispose();
        enqueue('/project/later.k');
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(started, []);
    });

    for (const failed of [false, true]) it(`finishes the current refresh ${failed ? 'failure' : 'success'} without starting queued roots after disposal`, async () => {
        let scheduled, finish;
        const started = [], errors = [], failure = Error('refresh failed during shutdown');
        const root = path.resolve('/project/main.k');
        const enqueue = createProjectSnapshotRefreshQueue({
            loadProjectSnapshot: file => { started.push(file); return new Promise((resolve, reject) => { finish = () => failed ? reject(failure) : resolve(); }); },
            schedule: callback => { scheduled = callback; }, onError: error => errors.push(error),
        });
        enqueue(root);
        enqueue('/project/queued.k');
        scheduled();
        enqueue.dispose();
        enqueue('/project/later.k');
        finish();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(started, [root]);
        assert.deepEqual(errors, failed ? [failure] : []);
    });

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

    it('recycles the worker before clearing the bounded per-file cache', async () => {
        const createdPools = [];
        const cacheOptionsSeen = [];
        let poolDisposeCalls = 0;
        const loader = createProjectIndexLoader({
            createPool(options) {
                createdPools.push(options);
                return {
                    async buildProjectIndex(rootFile) { return { rootFile }; },
                    async dispose() { poolDisposeCalls += 1; },
                };
            },
            createFileScanCache(options) {
                cacheOptionsSeen.push(options);
                return {
                    async invalidateAll() {
                        return { entryCount: 3, totalBytes: 4096 };
                    },
                };
            },
            fileScanCacheDirectory: path.resolve('cache', 'file-scans'),
            fileScanCacheOptions: { maxCacheBytes: 1024, maxEntryAgeMs: 2000 },
        });

        await loader.buildProjectIndex(path.resolve('project', 'main.k'));
        const removed = await loader.clearPersistentCache();
        assert.deepEqual(removed, { entryCount: 3, totalBytes: 4096 });
        assert.equal(poolDisposeCalls, 1);
        assert.deepEqual(cacheOptionsSeen, [{
            cacheDirectory: path.resolve('cache', 'file-scans'),
            maxCacheBytes: 1024,
            maxEntryAgeMs: 2000,
        }]);

        await loader.buildProjectIndex(path.resolve('project', 'again.k'));
        assert.equal(createdPools.length, 2);
        assert.deepEqual(createdPools[1].fileScanCacheOptions, {
            maxCacheBytes: 1024,
            maxEntryAgeMs: 2000,
        });
        await loader.dispose();
    });
});

// ---------------------------------------------------------------------------
// Debounce helpers
// ---------------------------------------------------------------------------

describe('createActiveDocumentDebouncer', () => {
    it('cancels the native timeout and ignores later changes after disposal', async () => {
        const document = { uri: { fsPath: '/project/main.k' } }, refreshed = [];
        const debounce = createActiveDocumentDebouncer(() => document, value => refreshed.push(value), 10);
        debounce(document);
        debounce.dispose();
        debounce.dispose();
        debounce(document);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.deepEqual(refreshed, []);
    });

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

    it('reports include access faults as an unchecked path and recovers without a missing-file claim', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-include-warning-'));
        const child = path.join(directory, 'child.k');
        fs.writeFileSync(child, '*NODE\n1,0,0,0\n');
        const doc = fakeDoc('*INCLUDE\nchild.k\n', path.join(directory, 'main.k'));doc.languageId = 'lsdyna';
        fs.writeFileSync(doc.uri.fsPath, doc.getText());
        const access = fs.promises.access, accessSync = fs.accessSync;
        const fault = Object.assign(new Error('controlled access failure'), { code: 'EACCES' });
        fs.promises.access = async function (file, ...args) {
            if (path.resolve(String(file)) === child) throw fault;
            return access.call(this, file, ...args);
        };
        fs.accessSync = function (file, ...args) {
            if (path.resolve(String(file)) === child) throw fault;
            return accessSync.call(this, file, ...args);
        };
        try {
            for (const mode of ['off', 'crossPlatform', 'strict']) {
                const result = await collectIncludeDecorationSets(doc, { mode });
                assert.equal(result.resolved.length, 0);
                assert.equal(result.missingIndicators.length, 1);
                assert.equal(result.missingIndicators[0].hoverMessage, i18n.get('includeDecorationCheckFailed', 'child.k'));
                assert.notEqual(result.missingIndicators[0].hoverMessage, i18n.get('includeDecorationMissingLocal', 'child.k'));
                assert.deepEqual(await collectIncludeDocumentLinks(doc, { mode }), []);
            }
            await assert.rejects(collectIncludeFiles(doc.uri.fsPath), error => error === fault);
            const provider = new LsdynaIncludeTreeProvider({ searchFileFromPaths });
            await assert.rejects(provider._buildItem(doc.uri.fsPath, new Set(), { report() {} }), error => error === fault);
            fs.promises.access = access;
            fs.accessSync = accessSync;
            assert.deepEqual(await collectIncludeFiles(doc.uri.fsPath), [doc.uri.fsPath, child]);
            assert.equal((await provider._buildItem(doc.uri.fsPath, new Set(), { report() {} })).children[0].filePath, child);
            assert.equal((await collectIncludeDecorationSets(doc)).resolved.length, 1);
            assert.equal((await collectIncludeDecorationSets(doc)).missingIndicators.length, 0);
            assert.equal((await collectIncludeDocumentLinks(doc)).length, 1);
        } finally {
            fs.promises.access = access;
            fs.accessSync = accessSync;
            fs.rmSync(directory, { recursive: true, force: true });
        }
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
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-affordance-'));
        const mainFile = path.join(tempRoot, 'main.k');
        const childFile = path.join(tempRoot, 'child.k');
        fs.writeFileSync(childFile, '*KEYWORD\n');

        {
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
        }
    });

    it('shares strict decoration lookups per request and observes file creation and deletion', async () => {
        const root = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-refresh-'));
        const file = path.join(root, 'child.k');
        const doc = fakeDoc('*INCLUDE\nchild.k\n*INCLUDE\nchild.k\n', path.join(root, 'main.k'));
        doc.languageId = 'lsdyna'; doc.version = 1;
        let checks = 0;
        const options = { mode: 'strict', resolveIncludeWithCaseCheck: async () => {
            checks++; return { status: 'exact', resolvedPath: file };
        } };
        {
            assert.equal((await collectIncludeDecorationSets(doc, options)).missing.length, 2);
            fs.writeFileSync(file, '*KEYWORD\n');
            assert.equal((await collectIncludeDecorationSets(doc, options)).resolved.length, 2);
            assert.equal(checks, 1);
            fs.unlinkSync(file);
            assert.equal((await collectIncludeDecorationSets(doc, options)).missing.length, 2);
        }
    });

    it('skips automatic include document links for very large documents', async () => {
        assert.deepEqual(await collectIncludeDocumentLinks(createHugeDoc()), []);
    });

    it('splits continued include document links around skipped comment lines', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-links-'));
        const includeFile = path.join(tempRoot, 'part_apart_b.key');
        const mainFile = path.join(tempRoot, 'main.k');

        fs.writeFileSync(includeFile, '*KEYWORD\n');
        fs.writeFileSync(mainFile, '*INCLUDE\npart_a +\n$ skip me\npart_b.key\n');

        {
            const doc = fakeDoc(fs.readFileSync(mainFile, 'utf8'), mainFile);
            const links = await collectIncludeDocumentLinks(doc);

            assert.equal(links.length, 2);
            assert.deepEqual(
                links.map(link => [link.range.start.line, link.range.end.line]),
                [[1, 1], [3, 3]]
            );
        }
    });

    it('creates document links for valid *INCLUDE_PATH directories', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-path-link-'));
        const includeDir = path.join(tempRoot, 'includes');
        const mainFile = path.join(tempRoot, 'main.k');
        fs.mkdirSync(includeDir);
        const mainFileContent = `*INCLUDE_PATH\n${includeDir}\n`;
        fs.writeFileSync(mainFile, mainFileContent);

        {
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
        }
    });

    it('creates document links for continued *INCLUDE_PATH directories', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-continued-path-link-'));
        const includeDir = path.join(tempRoot, 'long-' + 'a'.repeat(50), 'includes');
        const mainFile = path.join(tempRoot, 'main.k');
        fs.mkdirSync(includeDir, { recursive: true });

        const part1 = includeDir.slice(0, 78);
        const part2 = includeDir.slice(78);
        const mainFileContent = `*INCLUDE_PATH\n${part1} +\n${part2}\n`;
        fs.writeFileSync(mainFile, mainFileContent);

        {
            const doc = fakeDoc(mainFileContent, mainFile);
            const links = await collectIncludeDocumentLinks(doc);

            assert.equal(links.length, 1);
            const targetText = links[0].target.toString();
            assert.ok(targetText.startsWith('command:extension.revealInExplorer?'));
            assert.equal(path.normalize(decodeCommandUriArgs(links[0].target)[0].resourceUri.fsPath), path.normalize(includeDir));
            assert.equal(links[0].range.start.line, 1);
            assert.equal(links[0].range.end.line, 2);
        }
    });

    it('resolves include document links through continued *INCLUDE_PATH directories', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-path-links-'));
        const includeDir = path.join(tempRoot, 'shared', 'includes');
        const includeFile = path.join(includeDir, 'continued.k');
        const mainFile = path.join(tempRoot, 'main.k');
        fs.mkdirSync(includeDir, { recursive: true });
        fs.writeFileSync(includeFile, '*KEYWORD\n');

        const part1 = includeDir.slice(0, 78);
        const part2 = includeDir.slice(78);
        const mainFileContent = `*INCLUDE_PATH\n${part1} +\n${part2}\n*INCLUDE\ncontinued.k\n`;
        fs.writeFileSync(mainFile, mainFileContent);

        {
            const doc = fakeDoc(mainFileContent, mainFile);
            const links = await collectIncludeDocumentLinks(doc);
            const includeLink = links.find(link => path.normalize(link.target.fsPath) === path.normalize(includeFile));

            assert.ok(includeLink);
            assert.equal(path.normalize(includeLink.target.fsPath), path.normalize(includeFile));
            assert.equal(includeLink.range.start.line, 4);
            assert.equal(includeLink.range.end.line, 4);
        }
    });

    it('blocks include document links for casing mismatches in strict mode', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-strict-case-'));
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
            const deckPath = path.join(tempRoot, 'part.k');
            const hostResolvesDeckPath = fs.existsSync(deckPath);
            if (hostResolvesDeckPath) {
                assert.ok(openLinks.some(l => l.target && path.normalize(l.target.fsPath) === deckPath));
            } else {
                assert.equal(openLinks.length, 0, 'case-sensitive filesystems cannot open the mismatched path');
            }

            const strictDeco = await collectIncludeDecorationSets(doc, { mode: 'strict' });
            assert.equal(strictDeco.resolved.length, 0);
            assert.ok(strictDeco.missing.length >= 1);
            assert.equal(strictDeco.missingIndicators.length, 1);
            assert.equal(strictDeco.missingIndicators[0].hoverMessage,
                hostResolvesDeckPath
                    ? i18n.get('includePathCaseMismatch', 'part.k', 'Part.k')
                    : i18n.get('includeDecorationMissingLocal', 'part.k'));
        } finally {
            setResolveIncludeWithCaseCheckForTesting(null);
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
        const hover = await provider.provideDetailedHover(createHugeDoc(), { line: 0, character: 0 });
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
    const { Position } = require("../support/vscode-mock");

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
        assert.equal(result.name, 'tEnd');
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

describe('LsdynaFieldHoverProvider expanded details', () => {
    beforeEach(() => require('../../out/extension')._internals.setReferenceQueryClientForTesting(null));
    it('discards a hover when its document changes during cold schema preparation', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc('*NODE\n       1             0.0\n');
        doc.version = 1;
        const pending = provider.provideDetailedHover(doc, { line: 1, character: 12 });
        doc.version = 2;
        assert.equal(await pending, null);
    });

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
        const hover = await provider.provideDetailedHover(doc, { line: 1, character: 8 });
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
            const hover = await provider.provideDetailedHover(doc, item.position);
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

        const hover = await new LsdynaFieldHoverProvider().provideDetailedHover(
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
        const hover = await provider.provideDetailedHover(doc, { line: 1, character: 8 });
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
        const hover = await provider.provideDetailedHover(doc, { line: 3, character: 8 });
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
        const hover = await provider.provideDetailedHover(doc, { line: 3, character: 8 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('Current-file source definition'));
        assert.ok(value.includes('`3003`'));
        assert.ok(value.includes('Choose main deck'));
        assert.ok(!value.includes('Effective value in the current main-deck context'));
        assert.ok(!value.includes('`1001`'));
        assert.ok(!value.includes('`2002`'));
    });

    it('appends quiet-switch links on field hover when enabled', async () => {
        const manualIndexer = require("../../src/core/manualIndexer");
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        manualIndexer.getManualLocations = () => [];
        manualIndexer.getManualFilesCount = () => 1;
        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*CONTROL_TERMINATION\n                                                            \n');
            const hover = await provider.provideDetailedHover(doc, { line: 1, character: 45 });
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
        const manualIndexer = require("../../src/core/manualIndexer");
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        manualIndexer.getManualLocations = () => [];
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => (key === 'enableFieldHover' ? false : defaultValue),
        });
        try {
            const provider = new LsdynaFieldHoverProvider();
            const fieldDoc = fakeDoc('*CONTROL_TERMINATION\n                                                            \n');
            const fieldHover = await provider.provideDetailedHover(fieldDoc, { line: 1, character: 45 });
            assert.strictEqual(fieldHover, null);

            const kwDoc = fakeDoc('*NODE\n');
            const kwHover = await provider.provideDetailedHover(kwDoc, { line: 0, character: 2 });
            assert.ok(kwHover, 'Known *NODE keyword hover must remain available');
            const value = kwHover.contents[0].value;
            assert.ok(!value.includes('command:extension.muteFieldHoverSession'));
        } finally {
            manualIndexer.getManualLocations = originalGetManualLocations;
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('suppresses field hover when session-muted', async () => {
        const manualIndexer = require("../../src/core/manualIndexer");
        const originalGetManualLocations = manualIndexer.getManualLocations;
        manualIndexer.getManualLocations = () => [];
        setSessionFieldHoverMutedForTesting(true);
        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*CONTROL_TERMINATION\n                                                            \n');
            const hover = await provider.provideDetailedHover(doc, { line: 1, character: 45 });
            assert.strictEqual(hover, null);
        } finally {
            manualIndexer.getManualLocations = originalGetManualLocations;
            resetFieldHoverQuietStateForTesting();
        }
    });

    it('preserves embedded help newlines as markdown hard breaks', async () => {
        const manualIndexer = require("../../src/core/manualIndexer");
        const originalGetManualLocations = manualIndexer.getManualLocations;
        manualIndexer.getManualLocations = () => [];

        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*CONTROL_TERMINATION\n                                                            \n');

            const hover = await provider.provideDetailedHover(doc, { line: 1, character: 45 });

            assert.ok(hover);
            const value = hover.contents[0].value;
            assert.ok(value.startsWith('### $(symbol-field) <span style="color:var(--vscode-textLink-foreground);">**ENDMAS**</span> *(real)*'));
            assert.match(value, /DT2MS\. {2,}\nLT\.0\.0:/);
            assert.ok(!value.includes('$(table) Card Columns'));
            assert.ok(value.includes('<span style="color:var(--vscode-textLink-foreground);">**ENDMAS**</span>'));
            assert.ok(value.includes('<sub>41&#8209;50</sub>'));
        } finally {
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });

    it('shows Chinese-primary field help with muted English under zh-cn UI', async () => {
        const manualIndexer = require("../../src/core/manualIndexer");
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

            const hover = await provider.provideDetailedHover(doc, { line: 1, character: 5 });
            assert.ok(hover);
            const value = hover.contents[0].value;

            const zhAt = value.indexOf('节点集');
            const originalAt = value.indexOf('[原文](');
            assert.ok(zhAt >= 0, 'expected Chinese help as primary');
            assert.ok(originalAt >= 0, 'expected original English action link');
            assert.ok(originalAt < zhAt, 'original action link should appear before Chinese primary');
            assert.ok(value.includes('command:extension.showFieldHelpEnglish'), 'expected command link to English original');
            assert.ok(!value.includes('Node set ID.\n节点集'), 'should not leave raw stacked bilingual block as primary-only');
        } finally {
            manualIndexer.getManualLocations = originalGetManualLocations;
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });

    it('keeps English-only field help without muted secondary under en UI', async () => {
        const manualIndexer = require("../../src/core/manualIndexer");
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

            const hover = await provider.provideDetailedHover(doc, { line: 1, character: 5 });
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
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-hover-curve-'));
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
            const hover = await provider.provideDetailedHover(doc, { line: 4, character: 24 });
            const value = hover.contents[0].value;

            assert.ok(value.includes('**LCSS**'));
            assert.ok(!value.includes('LCSS reference'));
            assert.ok(!value.includes('*DEFINE\\_CURVE'));
            assert.ok(value.includes('Current-file preview'));
            assert.ok(value.includes('command:extension.openLsdynaReferenceDefinition'));
            assert.ok(value.includes('data:image/svg+xml;base64,'));
            assert.ok(value.includes('Scan Include Tree'));
            assert.ok(!value.includes('Current-file candidate'));
            assert.ok(!value.includes('insufficient to resolve'));
            assert.ok(!value.includes('No matching curve/table definition'));
        } finally {
            setFileIndexForTesting(filePath, null);
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
        const hover = await provider.provideDetailedHover(doc, { line: 4, character: 24 });
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
        const hover = await provider.provideDetailedHover(doc, { line: 4, character: 24 });
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
        const hover = await provider.provideDetailedHover(doc, { line: 4, character: 24 });
        const value = hover.contents[0].value;

        const navigation = value.match(/command:extension\.openLsdynaReferenceDefinition\?[^ ]+/g) || [];
        assert.deepEqual(navigation.flatMap(decodeCommandUriArgs), [{ filePath: childFile, lineIndex: 2, character: 0 }]);
        assert.ok(!value.includes('*DEFINE\\_CURVE'));
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
        const hover = await provider.provideDetailedHover(doc, { line: 4, character: 24 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('evaluates this to ID `1001`'));
        const navigation = value.match(/command:extension\.openLsdynaReferenceDefinition\?[^ ]+/g) || [];
        assert.deepEqual(navigation.flatMap(decodeCommandUriArgs), [{ filePath: curveFile, lineIndex: 1, character: 0 }]);
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
        const hover = await provider.provideDetailedHover(doc, { line: 4, character: 24 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('multiple main decks'));
        assert.ok(value.includes('Choose main deck'));
        assert.ok(!value.includes(curveA));
        assert.ok(!value.includes(curveB));
        assert.ok(!value.includes('No matching curve/table definition'));

        assert.equal(setMainDeckContextForDocument(sharedFile, rootA), true);
        const selectedA = getMainDeckContextForDocumentPath(sharedFile);
        assert.equal(selectedA.state, 'selected');
        assert.equal(selectedA.rootFile, rootA);
        const hoverA = await provider.provideDetailedHover(doc, { line: 4, character: 24 });
        const valueA = hoverA.contents[0].value;
        assert.ok(valueA.includes('Current main deck'));
        assert.ok(valueA.includes(path.basename(rootA)));
        const navigationA = valueA.match(/command:extension\.openLsdynaReferenceDefinition\?[^ ]+/g) || [];
        assert.deepEqual(navigationA.flatMap(decodeCommandUriArgs).map(target => target.filePath), [curveA]);

        assert.equal(setMainDeckContextForDocument(sharedFile, rootB), true);
        const docB = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0      2002         0       0.0',
        ].join('\n'), sharedFile);
        docB.languageId = 'lsdyna';
        const hoverB = await provider.provideDetailedHover(docB, { line: 4, character: 24 });
        const valueB = hoverB.contents[0].value;
        assert.ok(valueB.includes(path.basename(rootB)));
        const navigationB = valueB.match(/command:extension\.openLsdynaReferenceDefinition\?[^ ]+/g) || [];
        assert.deepEqual(navigationB.flatMap(decodeCommandUriArgs).map(target => target.filePath), [curveB]);

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

        const titleHover = await provider.provideDetailedHover(doc, { line: 1, character: 2 });
        assert.ok(titleHover);
        assert.ok(titleHover.contents[0].value.includes('**TITLE**'));
        assert.ok(titleHover.contents[0].value.includes('Enter title for the datacard.'));

        // Hovering on comment line (line 2) should return null
        const commentHover = await provider.provideDetailedHover(doc, { line: 2, character: 2 });
        assert.strictEqual(commentHover, null);

        // Hovering on data line (line 3) for character 5 (MID field, width 10)
        const dataHover = await provider.provideDetailedHover(doc, { line: 3, character: 5 });
        assert.ok(dataHover);
        assert.ok(dataHover.contents[0].value.includes('<span style="color:var(--vscode-textLink-foreground);">**MID**</span>'));
        assert.ok(dataHover.contents[0].value.includes('<sub>1&#8209;10</sub>'));
    });

    it('previews TITLE-variant local LCSS candidates before the project is scanned', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-hover-title-curve-'));
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
            const hover = await provider.provideDetailedHover(doc, { line: 5, character: 24 });
            const value = hover.contents[0].value;

            assert.ok(value.includes('**LCSS**'));
            assert.ok(!value.includes('LCSS reference'));
            assert.ok(!value.includes('*DEFINE\\_CURVE'));
            assert.ok(value.includes('Current-file preview'));
            assert.ok(value.includes('command:extension.openLsdynaReferenceDefinition'));
            assert.ok(value.includes('Scan Include Tree'));
            assert.ok(value.includes('data:image/svg+xml;base64,'));
            assert.ok(!value.includes('Current-file candidate'));
        } finally {
            setFileIndexForTesting(filePath, null);
        }
    });

    it('prepends curve definition preview when hovering on *DEFINE_CURVE definition keyword line', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-hover-def-curve-'));
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
            const hover = await provider.provideDetailedHover(doc, { line: 0, character: 5 });
            assert.ok(hover);
            const value = hover.contents[0].value;

            // Assert it contains both the graph preview and the keyword documentation
            assert.ok(value.includes('### $(graph-line) **\\*DEFINE\\_CURVE\\_TITLE (ID: 1001)** - _My Curve Title_'));
            assert.ok(value.includes('data:image/svg+xml;base64,'));
            assert.ok(value.includes('**\\*DEFINE\\_CURVE')); // Manual/help text
        } finally {
            setFileIndexForTesting(filePath, null);
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

        const hover = await provider.provideDetailedHover(doc, { line: 9, character: 2 });
        assert.ok(hover);
        assert.ok(hover.contents[0].value.includes('**PSTIFF**'));
    });

    it('adds keyword actions to keyword hovers with their explicit line target', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc([
            '*NODE',
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
        ].join('\n'));
        doc.version = 7;

        const ordinaryHover = await provider.provideDetailedHover(doc, { line: 0, character: 3 });
        const optionHover = await provider.provideDetailedHover(doc, { line: 1, character: 3 });

        assert.ok(ordinaryHover);
        assert.ok(optionHover);
        const ordinaryValue = ordinaryHover.contents[0].value;
        const optionValue = optionHover.contents[0].value;
        assert.ok(ordinaryValue.includes('command:extension.selectKeyword?%5B0%5D'));
        assert.ok(ordinaryValue.includes('command:extension.lsdynaFormatSelection?%5B0%5D'));
        const ordinaryTarget = JSON.parse(decodeURIComponent(ordinaryValue.match(/command:extension\.lsdynaChooseKeywordOptions\?([^ ]+)/)[1]));
        assert.deepEqual(ordinaryTarget, [{ uri: extensionModule._internals.documentUriIdentity(doc),
            documentVersion: doc.version, keywordLine: 0 }]);
        assert.ok(optionValue.includes('command:extension.selectKeyword?%5B1%5D'));
        assert.ok(optionValue.includes('command:extension.lsdynaFormatSelection?%5B1%5D'));
        assert.ok(optionValue.includes('command:extension.lsdynaChooseKeywordOptions?'));
        const target = JSON.parse(decodeURIComponent(optionValue.match(/command:extension\.lsdynaChooseKeywordOptions\?([^ ]+)/)[1]));
        assert.equal(target[0].keywordLine, 1);
        assert.equal(target[0].uri, extensionModule._internals.documentUriIdentity(doc));
    });

    it('localizes incomplete include previews outside the unchanged source code block', async () => {
        const root = makeTemp(path.join(os.tmpdir(), 'lsdyna-include-copy-'));
        const file = path.join(root, 'child.k'), main = path.join(root, 'main.k');
        const original = vscodeMock.workspace.getConfiguration;
        let language = 'en', maxLines = 2;
        vscodeMock.workspace.getConfiguration = () => ({ get: (key, fallback) => key === 'language' ? language : key === 'hover.previewMaxLines' ? maxLines : fallback });
        try {
            const doc = fakeDoc('*INCLUDE\nchild.k\n', main); doc.languageId = 'lsdyna';
            for (language of ['en', 'zh-cn']) for (const data of ['*KEYWORD\n$ 原始内容 &X\n*NODE\n*END', 'x'.repeat(4100)]) {
                i18n.updateLanguage();fs.writeFileSync(file, data);
                const hover = await new LsdynaFieldHoverProvider().provideDetailedHover(doc, { line: 1, character: 3 });
                const markdown = hover.contents[0].value;
                const notice = language === 'zh-cn' ? '仅显示部分内容' : 'Partial file preview';
                assert.ok(markdown.includes(notice));
                assert.ok(!markdown.includes('File is truncated for preview'));
                const blocks = [...markdown.matchAll(/```lsdyna\n([\s\S]*?)\n```/g)];
                if (data.startsWith('*KEYWORD')) assert.deepEqual(blocks.map(match => match[1]), ['*KEYWORD\n$ 原始内容 &X']);
                else assert.equal(blocks.length, 0, 'An incomplete byte-capped line must not be shown');
                assert.ok(blocks.every(match => !match[1].includes(notice)), 'Product copy belongs outside source text');
                assert.equal(fs.readFileSync(file, 'utf8'), data);
            }
            maxLines = 20;fs.writeFileSync(file, '*KEYWORD\n*END');
            const complete = await new LsdynaFieldHoverProvider().provideDetailedHover(doc, { line: 1, character: 3 });
            assert.ok(!complete.contents[0].value.includes('仅显示部分内容'));
        } finally { vscodeMock.workspace.getConfiguration = original; i18n.updateLanguage();  }
    });

    it('returns custom hover actions for existing include files', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-hover-test-'));
        const includeFile = path.join(tempRoot, 'sub.key');
        const mainFile = path.join(tempRoot, 'main.k');

        fs.writeFileSync(includeFile, '*KEYWORD\n');
        fs.writeFileSync(mainFile, '*INCLUDE\nsub.key\n');

        {
            const doc = fakeDoc(fs.readFileSync(mainFile, 'utf8'), mainFile);
            doc.languageId = 'lsdyna';
            const provider = new LsdynaFieldHoverProvider();

            // Hovering over 'sub.key' on line 1, character 3
            const hover = await provider.provideDetailedHover(doc, { line: 1, character: 3 });

            assert.ok(hover);
            assert.strictEqual(hover.contents[0].supportThemeIcons, true);
            assert.ok(hover.contents[0].value.includes('extension.openIncludeNewTab'));
            assert.ok(hover.contents[0].value.includes('extension.openIncludeSplit'));
            assert.ok(hover.contents[0].value.includes('extension.openIncludeFolder'));
            assert.ok(hover.contents[0].value.includes('"' + i18n.get('openNewTab') + '"'));
            assert.ok(hover.contents[0].value.includes('"' + i18n.get('openSplit') + '"'));
            assert.ok(hover.contents[0].value.includes('"' + i18n.get('openFolder') + '"'));
        }
    });

    it('falls back to default field hover for non-existent include files', async () => {
        const doc = fakeDoc('*INCLUDE\nmissing_file.key\n', '/project/main.k');
        doc.languageId = 'lsdyna';
        const provider = new LsdynaFieldHoverProvider();

        const hover = await provider.provideDetailedHover(doc, { line: 1, character: 3 });
        assert.ok(hover);
        assert.ok(hover.contents[0].value.includes('<span style="color:var(--vscode-textLink-foreground);">**FILENAME**</span>'));
        assert.ok(hover.contents[0].value.includes('<sub>1&#8209;80</sub>'));
    });

    it('prefers the structured chapter over live PDF bookmarks on keyword and field hovers', async () => {
        const workspace = require("../support/vscode-mock").workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require("../../src/core/manualIndexer");
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
            const kwHover = await provider.provideDetailedHover(doc, { line: 0, character: 3 });
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
            const fieldHover = await provider.provideDetailedHover(docField, { line: 1, character: 35 });
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
        }
    });

    it('labels approximate manual fallbacks and keeps the original keyword in reader links', async () => {
        const workspace = require("../support/vscode-mock").workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require("../../src/core/manualIndexer");
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
            const hover = await provider.provideDetailedHover(
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
        }
    });

    it('does not warn for a schema-backed manual section match', async () => {
        const workspace = require("../support/vscode-mock").workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require("../../src/core/manualIndexer");
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
            const hover = await provider.provideDetailedHover(
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
        const workspace = require("../support/vscode-mock").workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require("../../src/core/manualIndexer");
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
            const hover = await provider.provideDetailedHover(fakeDoc('*DEFINE_TRANSFORMATION\n'), { line: 0, character: 3 });
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
        const workspace = require("../support/vscode-mock").workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require("../../src/core/manualIndexer");
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
            const hover = await provider.provideDetailedHover(doc, { line: 0, character: 3 });
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
        const workspace = require("../support/vscode-mock").workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require("../../src/core/manualIndexer");
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;

        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? '' : undefined
        });
        manualIndexer.getManualFilesCount = () => 0;

        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*UNRECOGNIZED_KEYWORD\n');
            const hover = await provider.provideDetailedHover(doc, { line: 0, character: 3 });
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
        const workspace = require("../support/vscode-mock").workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require("../../src/core/manualIndexer");
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
            const hover = await provider.provideDetailedHover(doc, { line: 0, character: 3 });
            assert.ok(hover);
            const value = hover.contents[0].value;
            assert.ok(!value.includes('**\\*UNRECOGNIZED_KEYWORD**'));
            assert.ok(!value.includes('>$(info)</span>'));
            assert.ok(value.includes('command:extension.addCustomValidKeyword'));
            assert.ok(!value.includes('command:extension.manageCustomValidKeywords'));
            assert.ok(!value.includes('command:extension.lsdynaChooseKeywordOptions'));
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });

    it('shows the actual CONTACT header and cards for a supported option order', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc('*CONTACT_TIED_SHELL_EDGE_TO_SURFACE_ID_OFFSET\n');
        const hover = await provider.provideDetailedHover(doc, { line: 0, character: 3 });
        assert.ok(hover);
        const value = hover.contents[0].value;
        assert.ok(!value.includes('command:extension.addCustomValidKeyword'), value);
        assert.ok(value.includes('CONTACT_TIED_SHELL_EDGE_TO_SURFACE_ID_OFFSET'), value);
        assert.ok(value.includes('| Card |') && value.includes('`CID`') && value.includes('`SURFA`'), value);
        assert.ok(!value.includes('CONTACT_TIED_SHELL_EDGE_TO_SURFACE_OFFSET_ID'), value);
    });

    it('embeds closest-keyword help on high-confidence typo hover', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc('*LOAD_BODY_Z1\n');
        const hover = await provider.provideDetailedHover(doc, { line: 0, character: 3 });
        assert.ok(hover);
        const value = hover.contents[0].value;
        assert.ok(value.includes('LOAD_BODY_Z'), value);
        assert.ok(value.includes('| Card |'), 'expected embedded help table for LOAD_BODY_Z');
        assert.ok(value.includes('command:extension.addCustomValidKeyword'), value);
        assert.ok(!value.includes('**\\*LOAD_BODY_Z1**'), value);
        assert.ok(!value.includes('>$(info)</span>'), value);
    });

    it('embeds user-picked similar keyword help after medium picker choice', async () => {
        const { rememberSimilarKeywordChoice } = extensionModule._internals;
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc('*ZZZ_NOISE_KEYWORD_QQQ\n');
        // Force a remembered pick even when auto-suggest is empty.
        rememberSimilarKeywordChoice(doc, 0, 'ZZZ_NOISE_KEYWORD_QQQ', 'LOAD_BODY_Z');
        const hover = await provider.provideDetailedHover(doc, { line: 0, character: 3 });
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
        const hover = await provider.provideDetailedHover(doc, { line: 2, character: 3 });
        assert.ok(hover, 'expected field hover via similar keyword');
        const value = hover.contents[0].value;
        assert.ok(value.includes('**LCID**') || value.includes('LCID'), value);
        assert.ok(
            value.includes(i18n.get('unknownKeywordFieldHelpFromSimilar', 'LOAD_BODY_Z', 'LOAD_BODY_Z1')),
            value
        );
        assert.ok(value.includes(i18n.get('unknownKeywordSuggestStillUnknown')), value);
        const infoEnd = value.indexOf('>$(info)</span>');
        assert.ok(infoEnd > 0, value);
        assert.ok(value.indexOf(i18n.get('unknownKeywordHoverHint')) < infoEnd, value);
        assert.ok(value.indexOf(i18n.get('unknownKeywordFieldHelpFromSimilar', 'LOAD_BODY_Z', 'LOAD_BODY_Z1')) < infoEnd, value);
        assert.ok(value.indexOf(i18n.get('unknownKeywordSuggestStillUnknown')) < infoEnd, value);
        assert.ok(!value.includes('$(lightbulb)'), value);
        assert.ok(
            value.includes('<span style="color:var(--vscode-textLink-foreground);">**LCID**</span>') && value.includes('<sub>1&#8209;10</sub>'),
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

        const hover = await provider.provideDetailedHover(doc, { line: 2, character: 3 });
        assert.ok(hover);
        const value = hover.contents[0].value;
        assert.ok(value.includes('LCID'), value);
        assert.ok(value.includes('LOAD_BODY_Z'), value);
        assert.ok(
            value.includes(i18n.get('unknownKeywordFieldHelpFromSimilar', 'LOAD_BODY_Z', 'ZZZ_NOISE_KEYWORD_QQQ')),
            value
        );
        const infoEnd = value.indexOf('>$(info)</span>');
        assert.ok(infoEnd > 0, value);
        assert.ok(value.indexOf(i18n.get('unknownKeywordFieldHelpFromSimilar', 'LOAD_BODY_Z', 'ZZZ_NOISE_KEYWORD_QQQ')) < infoEnd, value);
        assert.ok(!value.includes('$(lightbulb)'), value);
    });

    it('keeps a compact book setup action when no manual is configured', async () => {
        const indexer = require('../../src/core/manualIndexer');
        const originalCount = indexer.getManualFilesCount, originalLocations = indexer.getManualLocations;
        const originalGet = vscodeMock.workspace.getConfiguration;
        try {
            indexer.getManualFilesCount = () => 0; indexer.getManualLocations = () => [];
            vscodeMock.workspace.getConfiguration = () => ({ get: () => undefined });
            const provider = new LsdynaFieldHoverProvider();
            const hover = await provider.provideHover(fakeDoc('*CONTROL_TIMESTEP\n'), { line: 0, character: 2 });
            const text = hover.contents.map(item => item.value).join('');
            assert.ok(text.includes('[$(book)](command:extension.configureManualsDir'));
            assert.ok(!text.includes(i18n.get('manualDirNotConfigured')));
            assert.ok(hover.contents.some(item => item.isTrusted.enabledCommands.includes('extension.configureManualsDir')));
        } finally {
            indexer.getManualFilesCount = originalCount; indexer.getManualLocations = originalLocations;
            vscodeMock.workspace.getConfiguration = originalGet;
        }
    });

    it('keeps manual discovery when the configured PDFs have no keyword match', async () => {
        const workspace = require("../support/vscode-mock").workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require("../../src/core/manualIndexer");
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
            const hover = await provider.provideDetailedHover(doc, { line: 0, character: 3 });
            assert.ok(hover);
            assert.ok(hover.contents[0].value.includes('command:extension.manual.openCurrentKeyword'));
            assert.ok(!hover.contents[0].value.includes('command:extension.configureManualsDir'));
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });

    it('keeps field queries out of structural grammar analysis', async () => {
        const { KeywordStructureCatalog } = require("../../src/core/structure/structureCatalog");
        const original = KeywordStructureCatalog.prototype.lookupBinding;
        let lookups = 0;
        KeywordStructureCatalog.prototype.lookupBinding = function (...args) {
            lookups++;
            return original.apply(this, args);
        };
        try {
            const document = fakeDoc('*DATABASE_EXTENT_BINARY\n' + '         1'.repeat(8));
            document.languageId = 'lsdyna';
            document.version = 1;
            const hover = await new LsdynaFieldHoverProvider().provideDetailedHover(document, { line: 1, character: 5 });
            assert.ok(hover);
            assert.ok(getCardFieldsForLine(document, 1));
            assert.equal(lookups, 0, 'field interaction must not expand or align structural grammar paths');
        } finally { KeywordStructureCatalog.prototype.lookupBinding = original; }
    });

    it('keeps TITLE physical order ahead of stale headers without reviving an unverified structure repair', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc([
            '*MAT_DAMAGE_1_TITLE',
            '$#     mid        ro         e        pr      sigy      lcss      lcds',
            ' '.repeat(80),
            '$#      q1        c1        q2        c2      epsd    espr/s        dc      flag',
            `${' '.repeat(70)}        -1`,
            '$#      vk        vm     r00/f     r45/g     r90/h         l         m         n',
            `${' '.repeat(50)}       1.5       1.5       1.5`,
            '$#    aopt    unused    unused      macf',
            `${' '.repeat(30)}         1`,
            '$#      xp        yp        zp        a1        a2        a3',
            ' '.repeat(80),
            '$#      v1        v2        v3        d1        d2        d3      beta',
            ' '.repeat(80),
            '*END',
        ].join('\n'), path.resolve('title-position-hover', 'damage.k'));
        doc.languageId = 'lsdyna';
        doc.version = 1;

        const keywordHover = await provider.provideDetailedHover(doc, { line: 0, character: 5 });
        assert.ok(keywordHover);
        assert.ok(keywordHover.contents[0].value.includes(i18n.get('keywordHoverOptions')));
        assert.ok(keywordHover.contents[0].value.includes(i18n.get('keywordHoverOptionActive')));
        assert.ok(keywordHover.contents[0].value.includes('| **1** | `TITLE`'));
        assert.ok(keywordHover.contents[0].value.includes('| **2** | `MID`'));
        assert.ok(!keywordHover.contents[0].value.includes('command:extension.insertVerifiedMissingRecords'));

        const titleHover = await provider.provideDetailedHover(doc, { line: 2, character: 5 });
        assert.ok(titleHover);
        const titleValue = titleHover.contents[0].value;
        assert.ok(titleValue.includes('**TITLE**'));
        assert.ok(!titleValue.includes('command:extension.insertVerifiedMissingRecords'));
        assert.ok(!titleValue.includes('command:extension.pickOfficialFieldValue'));

        const shiftedHover = await provider.provideDetailedHover(doc, { line: 4, character: 5 });
        assert.ok(shiftedHover);
        const shiftedValue = shiftedHover.contents[0].value;
        assert.ok(shiftedValue.includes('**MID**'));
        assert.ok(!shiftedValue.includes('**FLAG**'));
        assert.ok(!shiftedValue.includes('command:extension.insertVerifiedMissingRecords'));
    });

    it('accepts pipe-delimited preprocessor field headers without spending hover space', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const header = '$    NEIPH|    NEIPS|   MAXINT|   STRFLG|   SIGFLG|   EPSFLG|   RLTFLG|   ENGFLG';
        const doc = fakeDoc([
            '*DATABASE_EXTENT_BINARY',
            header,
            '         0        16         3         1         1         1         1         1',
        ].join('\n'), path.resolve('card-comments', 'pipe-current.k'));
        doc.languageId = 'lsdyna';
        doc.version = 1;

        const hover = await provider.provideDetailedHover(doc, { line: 2, character: 65 });
        assert.ok(hover);
        const value = hover.contents[0].value;
        assert.ok(value.includes('**RLTFLG**'));
        assert.ok(!value.includes(i18n.get('cardCommentVersionHint')));
        assert.ok(!value.includes(i18n.get('cardCommentShiftHint')));
        assert.ok(!value.includes('command:extension.rebuildCardComments'));
        assert.ok(!value.includes(`$(table) ${i18n.get('cardColumns')}`));
        const guide = value.slice(value.indexOf('| <sub>'));
        const rows = guide.split('\n').filter(line => line.startsWith('|'));
        assert.equal(rows.length, 3, 'card guide has one horizontal field row and one range row');
        assert.ok(rows[2].includes('<sub>NEIPH</sub>'));
        assert.ok(rows[2].includes('<span style="color:var(--vscode-textLink-foreground);">RLTFLG</span>'));
        assert.ok(rows[0].includes('<sub>1&#8209;10</sub>'));
        assert.ok(rows[0].includes('<sub>71&#8209;80</sub>'));
    });

    it('adds a comment mismatch reminder without suppressing field help', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const header = '$    NEIPH|    NEIPS|   MAXINT|   STRFLG|   SIGFLG|   EPSFLG|      OLD|     OLD2';
        const doc = fakeDoc([
            '*DATABASE_EXTENT_BINARY',
            header,
            '         0        16         3         1         1         1         1         1',
        ].join('\n'), path.resolve('card-comments', 'pipe-legacy.k'));
        doc.languageId = 'lsdyna';
        doc.version = 7;

        const unchangedHover = await provider.provideDetailedHover(doc, { line: 2, character: 5 });
        assert.ok(unchangedHover);
        assert.ok(unchangedHover.contents[0].value.includes('**NEIPH**'));
        assert.ok(!unchangedHover.contents[0].value.includes(i18n.get('cardCommentVersionHint')));

        const changedHover = await provider.provideDetailedHover(doc, { line: 2, character: 65 });
        assert.ok(changedHover);
        const value = changedHover.contents[0].value;
        assert.ok(value.includes(i18n.get('cardCommentVersionHint')));
        assert.ok(value.includes('command:extension.rebuildCardComments'));
        assert.ok(value.includes('**RLTFLG**'));
        assert.ok(!value.includes(`$(table) ${i18n.get('cardColumns')}`));

        const request = cardCommentRewriteRequest(doc, 0, 2);
        assert.deepEqual(Object.keys(request).sort(), [
            'documentVersion', 'keywordLine', 'line', 'uri',
        ]);
        const plan = planCardCommentRewriteForDocument(doc, 0, { blockIndex: null });
        assert.equal(plan.status, 'ready');
        assert.equal(plan.edits.length, 1);
        assert.equal(plan.edits[0].kind, 'replace-line');
        assert.equal(plan.edits[0].line, 1);
        assert.ok(plan.edits[0].replacementText.includes('RLTFLG'));
        assert.ok(plan.edits[0].replacementText.includes('ENGFLG'));
        assert.ok(!plan.edits[0].replacementText.includes('OLD'));
        assert.equal(plan.edits[0].replacementText[10], '|');

        let appliedEdit;
        const statuses = [];
        const result = await handleRebuildCardCommentsCommand(request, {
            editor: { document: doc },
            blockIndex: null,
            applyEdit: async edit => { appliedEdit = edit; return true; },
            showStatus: (key, ...args) => statuses.push([key, ...args]),
        });
        assert.ok(result);
        assert.equal(result.notice.kind, 'definition-mismatch');
        assert.equal(appliedEdit.edits.length, 1);
        assert.equal(appliedEdit.edits[0].range.start.line, 1);
        assert.equal(appliedEdit.edits[0].range.end.line, 1);
        assert.ok(appliedEdit.edits[0].text.includes('RLTFLG'));
        assert.deepEqual(statuses.at(-1), ['cardCommentRewriteApplied', 1]);

        let staleEditApplied = false;
        const staleStatuses = [];
        const stale = await handleRebuildCardCommentsCommand({ ...request, documentVersion: 6 }, {
            editor: { document: doc },
            blockIndex: null,
            applyEdit: async () => { staleEditApplied = true; return true; },
            showStatus: (key, ...args) => staleStatuses.push([key, ...args]),
        });
        assert.equal(stale, null);
        assert.equal(staleEditApplied, false);
        assert.deepEqual(staleStatuses, [['cardCommentRewriteStale']]);

        let rejectedEditCount = 0;
        const rejectedStatuses = [];
        const rejected = await handleRebuildCardCommentsCommand(request, {
            editor: { document: doc },
            blockIndex: null,
            applyEdit: async () => { rejectedEditCount++; return false; },
            showStatus: (key, ...args) => rejectedStatuses.push([key, ...args]),
        });
        assert.equal(rejected, null);
        assert.equal(rejectedEditCount, 1);
        assert.deepEqual(rejectedStatuses, [['cardCommentRewriteApplyFailed']]);
    });

    it('bounds per-document structure results by both entries and estimated bytes', () => {
        const doc = fakeDoc([
            '*MAT_DAMAGE_1',
            ...Array(6).fill(' '.repeat(80)),
            '*END',
        ].join('\n'), path.resolve('card-comments', 'bounded-cache.k'));
        doc.languageId = 'lsdyna';
        for (let version = 1; version <= 100; version++) {
            doc.version = version;
            assert.equal(analyzeKeywordStructureForDocument(doc, 0, {
                blockIndex: null,
                sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            }).status, 'ambiguous');
        }
        const stats = keywordStructureAnalysisCacheStatsForTesting(doc);
        assert.ok(stats.entries > 0 && stats.entries <= stats.maximumEntries);
        assert.ok(stats.bytes > 0 && stats.bytes <= stats.maximumBytes);
        assert.equal(stats.maximumEntries, 64);
        assert.equal(stats.maximumBytes, 2 * 1024 * 1024);
    });

    it('returns unverified inventory status before reading an oversized keyword body', () => {
        const reads = [];
        const doc = {
            languageId: 'lsdyna',
            version: 1,
            lineCount: 1_000_000,
            uri: { fsPath: path.resolve('card-comments', 'unverified-large.k') },
            lineAt(line) {
                reads.push(line);
                if (line === 0) return { text: '*MAT_DAMAGE_1_TITLE' };
                throw new Error('unverified bindings must not scan their keyword body');
            },
        };
        const result = analyzeKeywordStructureForDocument(doc, 0, {
            blockIndex: null,
            globalInputFormat: 'standard',
        });
        assert.equal(result.status, 'profile-unverified');
        assert.equal(result.reason, 'variant-requires-reviewed-option-expansion');
        assert.equal(result.sourceProfileId, DEFAULT_STRUCTURE_SOURCE_PROFILE_EN);
        assert.equal(result.sourceProfileOrigin, 'builtin-default');
        assert.deepEqual(reads, [0]);
    });

    it('uses a ready block index for command-palette checks near a million-line tail', async () => {
        const keywordLine = 999_990;
        const reads = [];
        const doc = {
            languageId: 'lsdyna',
            version: 3,
            lineCount: 1_000_000,
            uri: { fsPath: path.resolve('card-comments', 'palette-large.k') },
            lineAt(line) {
                reads.push(line);
                if (line === keywordLine) return { text: '*MAT_DAMAGE_1_TITLE' };
                throw new Error(`unexpected line read: ${line}`);
            },
        };
        const messages = [];
        const result = await handleCheckKeywordStructureCommand(null, {
            editor: {
                document: doc,
                selection: { active: { line: 999_999 } },
            },
            blockIndex: {
                lineCount: doc.lineCount,
                findBlockAtLine: () => ({ startLine: keywordLine, endLine: 999_999 }),
            },
            globalInputFormat: 'standard',
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            showInformationMessage: message => messages.push(message),
        });
        assert.equal(result.status, 'profile-unverified');
        assert.ok(messages.length === 1);
        assert.ok(reads.length <= 3, `ready-index command performed ${reads.length} line reads`);
        assert.ok(reads.every(line => line === keywordLine));
    });

    it('keeps structure checks bounded near a million-line tail with a ready block index', () => {
        const keywordLine = 999_900;
        const blockLines = [
            '*MAT_DAMAGE_1',
            '$#     mid        ro         e        pr      sigy      lcss      lcds',
            ' '.repeat(80),
            '$#      q1        c1        q2        c2      epsd    espr/s        dc      flag',
            `${' '.repeat(70)}        -1`,
            '$#      vk        vm     r00/f     r45/g     r90/h         l         m         n',
            `${' '.repeat(50)}       1.5       1.5       1.5`,
            '$#    aopt    unused    unused      macf',
            `${' '.repeat(30)}         1`,
            '$#      xp        yp        zp        a1        a2        a3',
            ' '.repeat(80),
            '$#      v1        v2        v3        d1        d2        d3      beta',
            ' '.repeat(80),
        ];
        let lineReads = 0;
        const readLines = [];
        const document = {
            version: 1,
            lineCount: 1_000_000,
            lineAt(line) {
                lineReads++;
                readLines.push(line);
                const offset = line - keywordLine;
                return { text: blockLines[offset] ?? '$ untouched' };
            },
        };
        const blockIndex = {
            lineCount: document.lineCount,
            findBlockAtLine: () => ({
                startLine: keywordLine,
                endLine: keywordLine + blockLines.length - 1,
            }),
        };

        const structure = analyzeKeywordStructureForDocument(document, keywordLine, {
            blockIndex,
            globalInputFormat: 'standard',
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
        });

        assert.equal(structure.status, 'ambiguous');
        assert.equal(structure.reason, 'verified-boundary-only-no-record-signatures');
        assert.ok(lineReads <= 16, `expected bounded structure reads, got ${lineReads}`);
        assert.ok(readLines.every(line => line >= keywordLine && line < keywordLine + blockLines.length));

        lineReads = 0;
        const overBudget = analyzeKeywordStructureForDocument(document, keywordLine, {
            globalInputFormat: 'standard',
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            blockIndex: {
                lineCount: document.lineCount,
                findBlockAtLine: () => ({ startLine: keywordLine, endLine: keywordLine + 33 }),
            },
        });
        assert.equal(overBudget.status, 'unsupported-input');
        assert.equal(overBudget.reason, 'block-line-limit');
        assert.ok(lineReads <= 2, `expected over-budget check to stop immediately, got ${lineReads}`);
    });

    it('moves conditional-card details out of keyword hover while keeping manager access', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const flagMinusOne = `${' '.repeat(70)}        -1`;
        const doc = fakeDoc([
            '*MAT_DAMAGE_1',
            ' '.repeat(80),
            flagMinusOne,
        ].join('\n'));

        const hover = await provider.provideDetailedHover(doc, { line: 0, character: 4 });
        assert.ok(hover);
        const value = hover.contents[0].value;
        assert.ok(!value.includes(i18n.get('officialConditionalCards')));
        assert.ok(!value.includes('`Anisotropic Damage Card`'));
        assert.ok(value.includes('command:extension.lsdynaChooseKeywordOptions'));
        assert.ok(!value.includes('#### $(book)'));
        assert.ok(!value.includes('diagnostic'));
    });

    it('does not repeat unresolved conditional-card details on keyword hover', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const parameterFlag = `${' '.repeat(70)}     &FLAG`;
        const doc = fakeDoc([
            '*MAT_DAMAGE_1',
            ' '.repeat(80),
            parameterFlag,
        ].join('\n'));

        const hover = await provider.provideDetailedHover(doc, { line: 0, character: 4 });
        assert.ok(hover);
        const value = hover.contents[0].value;
        assert.ok(!value.includes(i18n.get('semanticIndeterminateHint')));
        assert.ok(value.includes('command:extension.lsdynaChooseKeywordOptions'));
    });

    it('limits field hover conditions to the selected controller', () => {
        const doc = fakeDoc('*MAT_DAMAGE_1\n' + ' '.repeat(80) + '\n' + ' '.repeat(70) + '        -1');
        const build = extensionModule._internals.buildControlConditionMarkdown;
        assert.ok(build(doc, 0, ['FLAG']).includes('Anisotropic Damage Card'));
        assert.equal(build(doc, 0, ['MID']), '');
    });

    it('renders CONTACT slot evidence without claiming concrete option values', () => {
        const advice = getKeywordSemanticAdviceForDocument(
            fakeDoc('*CONTACT\n'),
            0,
            { canonicalName: 'CONTACT', activeOptions: [], entry: { c: [], o: [] } },
        );
        const markdown = buildKeywordSemanticAdviceMarkdown(advice);

        assert.ok(markdown.includes('`OPTION1`'));
        assert.ok(markdown.includes(i18n.get('semanticRequired')));
        assert.ok(markdown.includes('`OPTION6`'));
        assert.ok(!markdown.includes('AUTOMATIC_SURFACE_TO_SURFACE'));
    });

    it('opens a semantic evidence PDF only after the resolver verifies it', async () => {
        const opened = [];
        const request = { keyword: '*TEST', ruleId: 'rule:one', evidenceId: 'evidence:one' };
        const result = await handleOpenSemanticEvidenceCommand({}, request, {
            resolver: {
                resolve: async (actualRequest, catalog, packRoot) => {
                    assert.deepEqual(actualRequest, request);
                    assert.equal(packRoot, '/verified-pack');
                    assert.deepEqual(catalog, { id: 'catalog' });
                    return {
                        status: 'resolved',
                        pdfPath: '/verified-pack/pdf/vol-i.pdf',
                        page: 42,
                    };
                },
            },
            catalog: { id: 'catalog' },
            manualPackRoot: '/verified-pack',
            openPdf: (context, pdfPath, page) => opened.push({ context, pdfPath, page }),
        });

        assert.equal(result.status, 'resolved');
        assert.deepEqual(opened, [{
            context: {},
            pdfPath: '/verified-pack/pdf/vol-i.pdf',
            page: 42,
        }]);
    });

    it('uses only the generic unavailable message for a stale legacy evidence identity', async () => {
        const originalShowWarningMessage = vscodeMock.window.showWarningMessage;
        let warning = '';
        let opened = false;
        vscodeMock.window.showWarningMessage = message => { warning = message; };
        try {
            const result = await handleOpenSemanticEvidenceCommand({}, {}, {
                resolver: { resolve: async () => ({ status: 'manual-pack-evidence-unavailable' }) },
                catalog: {},
                manualPackRoot: '/different-pack',
                openPdf: () => { opened = true; },
            });
            assert.equal(result.status, 'manual-pack-evidence-unavailable');
            assert.equal(opened, false);
            assert.equal(warning, i18n.get('semanticEvidenceUnavailable'));
        } finally {
            vscodeMock.window.showWarningMessage = originalShowWarningMessage;
        }
    });

    it('silently hides a locked evidence page for an unapproved current profile', () => {
        const lockedProfile = 'a'.repeat(64);
        const lockedIndex = 'b'.repeat(64);
        const links = semanticEvidencePageLinks('*TEST', [{
            ruleId: 'rule:one',
            evidence: [{
                evidenceId: 'evidence:one',
                manualId: 'manual-vol-ii',
                page: 832,
                sourceProfileId: lockedProfile,
            }],
        }], {
            catalogSummary: {
                evidenceAuthority: {
                    sourceProfileId: lockedProfile,
                    indexSha256: lockedIndex,
                    documents: [],
                },
            },
            currentAuthority: {
                sourceProfileId: 'c'.repeat(64),
                indexSha256: 'd'.repeat(64),
                documents: [],
            },
        });
        assert.deepEqual(links, []);
    });

    it('renders the native evidence page selected by the current manual profile', () => {
        const englishProfile = 'a'.repeat(64);
        const englishIndex = 'b'.repeat(64);
        const bilingualProfile = 'c'.repeat(64);
        const bilingualIndex = 'd'.repeat(64);
        const items = [{
            ruleId: 'rule:one',
            evidence: [
                {
                    evidenceId: 'evidence:one',
                    manualId: 'manual-vol-ii',
                    page: 832,
                    sourceProfileId: englishProfile,
                },
                {
                    evidenceId: 'evidence:one',
                    manualId: 'manual-vol-ii',
                    page: 814,
                    sourceProfileId: bilingualProfile,
                },
            ],
        }];
        const catalogSummary = {
            evidenceAuthority: {
                schemaVersion: 2,
                defaultSourceProfileId: englishProfile,
                profiles: [
                    {
                        sourceProfileId: englishProfile,
                        indexSha256: englishIndex,
                        documents: [{ manualId: 'manual-vol-ii', title: 'Vol II' }],
                    },
                    {
                        sourceProfileId: bilingualProfile,
                        indexSha256: bilingualIndex,
                        documents: [{ manualId: 'manual-vol-ii', title: 'Vol II' }],
                    },
                ],
            },
        };
        const bilingualLinks = semanticEvidencePageLinks('*TEST', items, {
            catalogSummary,
            currentAuthority: {
                sourceProfileId: bilingualProfile,
                indexSha256: bilingualIndex,
                documents: [],
            },
        });
        assert.equal(bilingualLinks.length, 1);
        assert.ok(bilingualLinks[0].includes('Vol II · P814'));
        assert.ok(!bilingualLinks[0].includes('P832'));

        const englishLinks = semanticEvidencePageLinks('*TEST', items, {
            catalogSummary,
            currentAuthority: {
                sourceProfileId: englishProfile,
                indexSha256: englishIndex,
                documents: [],
            },
        });
        assert.equal(englishLinks.length, 1);
        assert.ok(englishLinks[0].includes('Vol II · P832'));
    });

it('keeps the official FLAG hover action for a complete TITLE layout with field headers', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc([
            '*MAT_DAMAGE_1_TITLE',
            'Engineer material title'.padEnd(80),
            '$#     mid        ro         e        pr      sigy      lcss      lcds',
            ' '.repeat(80),
            '$#      q1        c1        q2        c2      epsd    espr/s        dc      flag',
            `${' '.repeat(70)}        -1`,
            '$#      vk        vm     r00/f     r45/g     r90/h         l         m         n',
            `${' '.repeat(50)}       1.5       1.5       1.5`,
            '$#    aopt    unused    unused      macf',
            `${' '.repeat(30)}         1`,
            '$#      xp        yp        zp        a1        a2        a3',
            ' '.repeat(80),
            '$#      v1        v2        v3        d1        d2        d3      beta',
            ' '.repeat(80),
            '*END',
        ].join('\n'), path.resolve('title-position-hover', 'complete.k'));
        doc.languageId = 'lsdyna';
        doc.version = 1;

        const hover = await provider.provideDetailedHover(doc, { line: 5, character: 75 });
        assert.ok(hover);
        const value = hover.contents[0].value;
        assert.ok(value.includes('**FLAG**'));
        assert.ok(value.includes('command:extension.pickOfficialFieldValue'));
        assert.ok(!value.includes(i18n.get('cardCommentShiftHint')));
    });

it('blocks comment rewrites and applies one generic verified-full blank-suffix edit', async () => {
        const fixed = values => Array.from(
            { length: 8 },
            (_, index) => String(values[index] ?? '').padStart(10),
        ).join('');
        const doc = fakeDoc([
            '*MAT_WINFRITH_CONCRETE',
            fixed([1, 2, 3, 4, 5, 6, 7, 8]),
            fixed([1, 2, 3, 4, 8, 6, 7, 8]),
            fixed([.1, .2, .3, .4, .5, .6, .7, .8]),
            fixed([1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8]),
            '*END',
        ].join('\n'), path.resolve('card-comments', 'winfrith-missing-suffix.k'));
        doc.languageId = 'lsdyna';
        doc.version = 2;

        const structureOptions = {
            blockIndex: null,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
        };
        const structure = analyzeKeywordStructureForDocument(doc, 0, structureOptions);
        const plan = planCardCommentRewriteForDocument(doc, 0, structureOptions);

        assert.equal(structure.status, 'definite-error');
        assert.equal(structure.reason, 'missing-required-records');
        assert.equal(structure.observedDataRecords, 4);
        assert.equal(structure.expectedDataRecords, 7);
        assert.deepEqual(structure.repairCandidates.map(item => item.cardLabel), [
            'Card 5', 'Card 6', 'Card 7',
        ]);
        assert.equal(plan.status, 'structure-error');
        assert.deepEqual(plan.edits, []);

        const markdown = buildKeywordStructureIssueMarkdown(structure, doc, 0, 2);
        assert.ok(markdown.includes(i18n.get('keywordStructureMissingNamed', 'Card 5, Card 6, Card 7')));
        assert.ok(markdown.includes('command:extension.checkKeywordStructure'));
        assert.ok(markdown.includes('command:extension.insertVerifiedMissingRecords'));
        assert.ok(!markdown.includes('TITLE'));

        const request = keywordStructureRepairRequest(doc, 0, 2, structure);
        assert.deepEqual(Object.keys(request).sort(), [
            'diagnosticIdentity', 'documentVersion', 'grammarId', 'keywordLine', 'line',
            'sourceProfileId', 'uri',
        ]);
        let appliedEdit;
        const statuses = [];
        const result = await handleInsertVerifiedMissingRecordsCommand(request, {
            editor: { document: doc },
            blockIndex: null,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            applyEdit: async edit => { appliedEdit = edit; return true; },
            showStatus: (key, ...args) => statuses.push([key, ...args]),
        });
        assert.ok(result);
        assert.equal(appliedEdit.edits.length, 1, 'all blanks must be one WorkspaceEdit/Undo unit');
        const insertion = appliedEdit.edits[0];
        assert.equal(insertion.range.start.line, 5);
        assert.equal(insertion.range.end.line, 5);
        const insertedLines = insertion.text.split('\n');
        assert.deepEqual(insertedLines.slice(0, 3), Array(3).fill(' '.repeat(80)));
        assert.equal(insertedLines[3], '');
        assert.deepEqual(statuses.at(-1), ['keywordStructureRecordsInserted', 3]);

        for (const [mutation, expectedStatus] of [
            [{ documentVersion: 1 }, 'keywordStructureRepairStale'],
            [{ uri: 'file:///forged-structure-repair.k' }, 'keywordStructureRepairStale'],
            [{ sourceProfileId: 'f'.repeat(64) }, 'keywordStructureRepairStale'],
            [{ diagnosticIdentity: 'forged' }, 'keywordStructureRepairUnavailable'],
            [{ line: doc.lineCount - 1 }, 'keywordStructureRepairUnavailable'],
        ]) {
            let didApply = false;
            const rejectedStatuses = [];
            const rejected = await handleInsertVerifiedMissingRecordsCommand({ ...request, ...mutation }, {
                editor: { document: doc },
                blockIndex: null,
                sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
                applyEdit: async () => { didApply = true; return true; },
                showStatus: (key, ...args) => rejectedStatuses.push([key, ...args]),
            });
            assert.equal(rejected, null);
            assert.equal(didApply, false);
            assert.deepEqual(rejectedStatuses, [[expectedStatus]]);
        }

        let rejectedEditCount = 0;
        const rejectedStatuses = [];
        const rejected = await handleInsertVerifiedMissingRecordsCommand(request, {
            editor: { document: doc },
            blockIndex: null,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            applyEdit: async () => { rejectedEditCount++; return false; },
            showStatus: (key, ...args) => rejectedStatuses.push([key, ...args]),
        });
        assert.equal(rejected, null);
        assert.equal(rejectedEditCount, 1);
        assert.deepEqual(rejectedStatuses, [['keywordStructureRepairApplyFailed']]);

        const warnings = [];
        const checked = await handleCheckKeywordStructureCommand({
            uri: documentUriIdentity(doc), documentVersion: doc.version, keywordLine: 0,
        }, {
            editor: { document: doc },
            blockIndex: null,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            showWarningMessage: message => warnings.push(message),
            showInformationMessage: message => warnings.push(message),
        });
        assert.equal(checked.status, 'definite-error');
        assert.ok(warnings[0].includes('Card 5'));
    });

it('reports unsupported integers without a definite error, repair link or document edit', async () => {
        const lines = ['*MAT_WINFRITH_CONCRETE', '1,2,3,4,5,6,7,8', '1,2,3,4,8,6,7,8',
            '.1,.2,.3,.4,.5,.6,.7,.8', '1.1,1.2,1.3,1.4,1.5,1.6,1.7,1.8',
            '2.1,2,3,4,,,7,8', '3.1,3.2,3.3,3.4,5,3.6,3.7,8',
            '9007199254740993,4.2,4.3,4.4,4.5,4.6,4.7,8', '*END'];
        const doc = fakeDoc(lines.join('\n'), path.resolve('card-comments', 'integer-unrepresentable.k'));
        doc.languageId = 'lsdyna'; doc.version = 1;
        const before = doc.getText(), messages = [];
        const result = await handleCheckKeywordStructureCommand(null, {
            editor: { document: doc, selection: { active: { line: 0 } } }, blockIndex: null,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            showInformationMessage: message => messages.push(message),
            showWarningMessage: () => assert.fail('unsupported input must not be reported as a definite error'),
        });
        assert.equal(result.status, 'unsupported-input');
        assert.equal(result.reason, 'integer-value-unrepresentable');
        assert.equal(messages[0], i18n.get('keywordStructureCheckIntegerUnsupported'));
        assert.equal(buildKeywordStructureIssueMarkdown(result, doc, 0, 1), '');
        assert.equal(keywordStructureRepairRequest(doc, 0, 1, result), null);
        assert.equal(doc.getText(), before);
    });

it('bypasses cached hover results before every explicit check and repair', async () => {
        const fixed = values => Array.from(
            { length: 8 },
            (_, index) => String(values[index] ?? '').padStart(10),
        ).join('');
        const mutableLines = [
            '*MAT_WINFRITH_CONCRETE',
            fixed([1, 2, 3, 4, 5, 6, 7, 8]),
            fixed([1, 2, 3, 4, 8, 6, 7, 8]),
            fixed([.1, .2, .3, .4, .5, .6, .7, .8]),
            fixed([1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8]),
            '$ initially a comment',
            '$ initially a comment',
            '$ initially a comment',
            '*END',
        ];
        const doc = fakeDoc(mutableLines.join('\n'), path.resolve('card-comments', 'cache-revalidation.k'));
        doc.languageId = 'lsdyna';
        doc.version = 9;
        doc.lineAt = line => ({
            text: mutableLines[line],
            range: new vscodeMock.Range(line, 0, line, mutableLines[line].length),
        });
        const options = {
            blockIndex: null,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
        };
        const cachedMissing = analyzeKeywordStructureForDocument(doc, 0, options);
        assert.equal(cachedMissing.status, 'definite-error');
        const request = keywordStructureRepairRequest(doc, 0, 2, cachedMissing);

        mutableLines.splice(5, 3,
            fixed([2.1, 2, 3, 4, '', '', 7, 8]),
            fixed([3.1, 3.2, 3.3, 3.4, 5, 3.6, 3.7, 8]),
            fixed([7, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 8]));
        assert.equal(
            analyzeKeywordStructureForDocument(doc, 0, options).status,
            'definite-error',
            'the passive same-version path intentionally remains cached',
        );

        const messages = [];
        const checked = await handleCheckKeywordStructureCommand({
            uri: documentUriIdentity(doc), documentVersion: doc.version, keywordLine: 0,
        }, {
            editor: { document: doc },
            ...options,
            showInformationMessage: message => messages.push(message),
            showWarningMessage: message => messages.push(message),
        });
        assert.equal(checked.status, 'valid');

        let applied = false;
        const statuses = [];
        const repaired = await handleInsertVerifiedMissingRecordsCommand(request, {
            editor: { document: doc },
            ...options,
            applyEdit: async () => { applied = true; return true; },
            showStatus: key => statuses.push(key),
        });
        assert.equal(repaired, null);
        assert.equal(applied, false);
        assert.deepEqual(statuses, ['keywordStructureRepairUnavailable']);
    });

it('withholds all repairs at boundary-only and unverified variant boundaries', () => {
        const titleDoc = fakeDoc([
            '*MAT_DAMAGE_1_TITLE',
            ...Array(6).fill(' '.repeat(80)),
            '*END',
        ].join('\n'), path.resolve('card-comments', 'damage-title-unverified.k'));
        titleDoc.languageId = 'lsdyna';
        titleDoc.version = 1;
        const title = analyzeKeywordStructureForDocument(titleDoc, 0, {
            blockIndex: null,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
        });
        assert.equal(title.status, 'profile-unverified');
        assert.equal(title.reason, 'variant-requires-reviewed-option-expansion');
        assert.equal(title.repairCandidates.length, 0);
        assert.equal(buildKeywordStructureIssueMarkdown(title, titleDoc, 0, 2), '');

        const boundaryDoc = fakeDoc([
            '*MAT_DAMAGE_1',
            ...Array(6).fill(' '.repeat(80)),
            '*END',
        ].join('\n'), path.resolve('card-comments', 'damage-boundary.k'));
        boundaryDoc.languageId = 'lsdyna';
        boundaryDoc.version = 1;
        const boundary = analyzeKeywordStructureForDocument(boundaryDoc, 0, {
            blockIndex: null,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
        });
        const markdown = buildKeywordStructureIssueMarkdown(boundary, boundaryDoc, 0, 2);
        assert.equal(boundary.status, 'ambiguous');
        assert.equal(boundary.reason, 'verified-boundary-only-no-record-signatures');
        assert.equal(boundary.repairCandidates.length, 0);
        assert.ok(markdown.includes(i18n.get('keywordStructureAmbiguous')));
        assert.ok(markdown.includes('command:extension.checkKeywordStructure'));
        assert.ok(!markdown.includes('command:extension.insertVerifiedMissingRecords'));
    });

it('removes only a surplus recognized header before the same data record', () => {
        const legacyHeader = '$    NEIPH|    NEIPS|   MAXINT|   STRFLG|   SIGFLG|   EPSFLG|      OLD|     OLD2';
        const currentHeader = '$    NEIPH|    NEIPS|   MAXINT|   STRFLG|   SIGFLG|   EPSFLG|   RLTFLG|   ENGFLG';
        const doc = fakeDoc([
            '*DATABASE_EXTENT_BINARY',
            legacyHeader,
            currentHeader,
            '         0        16         3         1         1         1         1         1',
            '*END',
        ].join('\n'), path.resolve('card-comments', 'surplus-header.k'));
        doc.languageId = 'lsdyna';
        doc.version = 1;

        const plan = planCardCommentRewriteForDocument(doc, 0, { blockIndex: null });

        assert.equal(plan.status, 'ready');
        assert.deepEqual(plan.edits.map(edit => [edit.kind, edit.line]), [
            ['delete-line', 1],
        ]);
        assert.equal(plan.edits[0].sourceText, legacyHeader);
        assert.ok(plan.edits.every(edit => edit.line !== 2 && edit.line !== 3));
    });

it('inserts a missing finite-card header while preserving preprocessor metadata', () => {
        const legacyHeader = '$    NEIPH|    NEIPS|   MAXINT|   STRFLG|   SIGFLG|   EPSFLG|      OLD|     OLD2';
        const doc = fakeDoc([
            '*DATABASE_EXTENT_BINARY',
            legacyHeader,
            '         0        16         3         1         1         1         1         1',
            '$HMNAME DATABASE 1',
            ' '.repeat(80),
            '*END',
        ].join('\n'), path.resolve('card-comments', 'metadata.k'));
        doc.languageId = 'lsdyna';
        doc.version = 3;

        const plan = planCardCommentRewriteForDocument(doc, 0, { blockIndex: null });

        assert.equal(plan.status, 'ready');
        assert.deepEqual(plan.edits.map(edit => [edit.kind, edit.line]), [
            ['replace-line', 1],
            ['insert-before-line', 4],
        ]);
        assert.ok(plan.edits[1].replacementText.startsWith('$'));
        assert.ok(plan.edits.every(edit => edit.line !== 2 && edit.line !== 3));
    });

it('refuses repeated and over-budget blocks instead of synthesizing bulk comments', () => {
        const repeated = fakeDoc([
            '*NODE',
            '$#     nid               x               y               z      tc      rc',
            '       1             0.0             0.0             0.0',
            '       2             1.0             0.0             0.0',
            '*END',
        ].join('\n'));
        repeated.version = 1;
        assert.equal(
            planCardCommentRewriteForDocument(repeated, 0, { blockIndex: null }).reason,
            'repeat-or-extra-data',
        );

        let lineReads = 0;
        const millionLineDocument = {
            version: 1,
            lineCount: 1_000_000,
            lineAt(line) {
                lineReads++;
                if (line === 999_000) return { text: '*DATABASE_EXTENT_BINARY' };
                return { text: '$ metadata' };
            },
        };
        const overBudget = planCardCommentRewriteForDocument(
            millionLineDocument,
            999_000,
            {
                globalInputFormat: 'standard',
                blockIndex: {
                    lineCount: 1_000_000,
                    findBlockAtLine: () => ({ startLine: 999_000, endLine: 999_500 }),
                },
            },
        );
        assert.equal(overBudget.reason, 'block-line-limit');
        assert.ok(lineReads <= 2, `expected bounded planning, got ${lineReads} reads`);
    });

it('shows native TITLE and base-field help without treating read support as a value-edit permission', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc(['*DEFINE_FUNCTION_TITLE', 'Function description'.padEnd(80), '         1', 'x+y'].join('\n'));
        const keywordHover = await provider.provideDetailedHover(doc, { line: 0, character: 5 });
        assert.ok(keywordHover);
        assert.ok(!keywordHover.contents[0].value.includes(i18n.get('keywordPrefixOptionUnsupported', 'TITLE')));
        for (const [line, name] of [[1, 'TITLE'], [2, 'FID']]) {
            const hover = await provider.provideDetailedHover(doc, { line, character: 5 });
            assert.ok(hover?.contents[0].value.includes('**' + name + '**'));
            assert.ok(!hover.contents[0].value.includes('command:extension.pickOfficialFieldValue'));
        }
    });

it('adds an identity-only official-value action to a ready fixed-width field hover', async () => {
        const { ManualPackManager } = require("../../src/manual/ManualPackManager");
        const priorAuthority = ManualPackManager.prototype.peekCurrentAuthority;
        const authority = extensionModule._internals.getManualSemanticCatalog().summary().evidenceAuthority;
        const profile = authority.profiles?.find(p => p.sourceProfileId === authority.defaultSourceProfileId) || authority;
        ManualPackManager.prototype.peekCurrentAuthority = () => profile;
        try {

        const doc = fakeDoc([
            '*MAT_DAMAGE_1',
            ' '.repeat(80),
            ' '.repeat(80),
            ' '.repeat(80),
            ' '.repeat(80),
            ' '.repeat(80),
            ' '.repeat(80),
        ].join('\n'), path.resolve('official-choice-hover', 'damage.k'));
        doc.languageId = 'lsdyna';
        doc.version = 1;

        const hover = await new LsdynaFieldHoverProvider().provideDetailedHover(
            doc,
            { line: 2, character: 75 },
        );
        const value = hover.contents[0].value;
        assert.ok(value.includes('command:extension.pickOfficialFieldValue'));
        assert.ok(value.includes(i18n.get('officialFieldChoiceHoverClosedAction')));
        const actionLine = value.split('\n')
            .find(line => line.includes('command:extension.pickOfficialFieldValue'));
        assert.ok(actionLine);
        assert.ok(!actionLine.includes('command:extension.openSemanticEvidence'));
        assert.ok(!actionLine.includes(`${i18n.get('semanticEvidencePages')}:`));
        assert.ok(!actionLine.includes('---'));
        const actionLabel = /\[\$\(list-selection\) ([^\]]+)\]\(command:extension\.pickOfficialFieldValue/.exec(actionLine);
        assert.ok(actionLabel);
        assert.equal(actionLabel[1], i18n.get('officialFieldChoiceHoverClosedAction'));
        const match = /command:extension\.pickOfficialFieldValue\?([^\s"\)]+)/.exec(value);
        assert.ok(match);
        const payload = JSON.parse(decodeURIComponent(match[1]))[0];
        assert.deepEqual(Object.keys(payload).sort(), [
            'character', 'documentVersion', 'line', 'uri',
        ]);
        assert.equal(payload.line, 2);
        assert.equal(payload.character, 70);
        assert.equal(payload.documentVersion, doc.version);
        assert.equal(payload.keyword, undefined);
        assert.equal(payload.choices, undefined);

        } finally { ManualPackManager.prototype.peekCurrentAuthority = priorAuthority; }
});

it('offers a reviewed special value where native enum coverage is absent', async () => {
    const doc = fakeDoc('*DAMPING_GLOBAL\n' + ' '.repeat(80));
    doc.languageId = 'lsdyna'; doc.version = 1;
    const hover = await new LsdynaFieldHoverProvider().provideDetailedHover(doc, { line: 1, character: 5 });
    assert.ok(hover.contents[0].value.includes('command:extension.pickOfficialFieldValue'));
    const plan = extensionModule._internals.planOfficialFieldChoicesForDocument(doc, { line: 1, character: 5 }, { keywordLine: 0 });
    assert.equal(plan.status, 'ready');
    assert.deepEqual(plan.choices.map(choice => [choice.valueText, choice.role]), [['0', 'sentinel']]);
    assert.notEqual(plan.domainKind, 'closed');
});

it('keeps display-only CONTROL_THERMAL_TIMESTEP hover free of writable value actions', async () => {
        const doc = fakeDoc(['*CONTROL_THERMAL_TIMESTEP', ' '.repeat(80)].join('\n'));
        doc.languageId = 'lsdyna'; doc.version = 1;
        const hover = await new LsdynaFieldHoverProvider().provideDetailedHover(doc, { line: 1, character: 45 });
        assert.ok(hover, 'display-only field remains viewable');
        assert.ok(hover.contents.every(content => !String(content.value || content).includes('command:extension.pickOfficialFieldValue')));
    });

it('uses compact engineer-facing field-choice wording in Chinese and English', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        try {
            const cases = [
                {
                    language: 'zh-cn',
                    closed: '选择取值…',
                    mixed: '查看特殊情况…',
                    incomplete: '非完整列表',
                    optionSlots: '关键字选项',
                    applicable: '适用',
                    closedStatus: 'FLAG · 5 个取值',
                    mixedStatus: 'TMAX · 1 个特殊情况',
                },
                {
                    language: 'en',
                    closed: 'Select value…',
                    mixed: 'View special cases…',
                    incomplete: 'Not exhaustive',
                    optionSlots: 'Keyword options',
                    applicable: 'applies',
                    closedStatus: 'FLAG · values (5)',
                    mixedStatus: 'TMAX · special cases (1)',
                },
            ];
            for (const expected of cases) {
                vscodeMock.workspace.getConfiguration = () => ({
                    get: (key, defaultValue) => key === 'language' ? expected.language : defaultValue,
                });
                i18n.updateLanguage();
                assert.equal(i18n.get('officialFieldChoiceHoverClosedAction'), expected.closed);
                assert.equal(i18n.get('officialFieldChoiceHoverMixedAction'), expected.mixed);
                assert.equal(i18n.get('officialFieldChoiceHoverMixedIncomplete'), expected.incomplete);
                assert.equal(i18n.get('officialKeywordOptionSlots'), expected.optionSlots);
                assert.equal(i18n.get('semanticApplicable'), expected.applicable);
                assert.equal(i18n.get('officialFieldChoiceStatusClosedLabel', 'FLAG', 5), expected.closedStatus);
                assert.equal(i18n.get('officialFieldChoiceStatusMixedLabel', 'TMAX', 1), expected.mixedStatus);
                assert.ok(!i18n.get('officialFieldChoiceHoverClosedAction').includes('official'));
                assert.ok(!i18n.get('officialFieldChoiceHoverMixedAction').includes('branch'));
            }
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });

it('does not add a writable official-value hover action for expressions or free format', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const expressionDoc = fakeDoc([
            '*MAT_DAMAGE_1',
            ' '.repeat(80),
            `${' '.repeat(70)}  <FLAG+1>`,
        ].join('\n'), path.resolve('official-choice-hover', 'expression.k'));
        expressionDoc.languageId = 'lsdyna';
        expressionDoc.version = 1;
        const expressionHover = await provider.provideDetailedHover(
            expressionDoc,
            { line: 2, character: 75 },
        );
        assert.ok(expressionHover);
        assert.ok(!expressionHover.contents[0].value.includes('command:extension.pickOfficialFieldValue'));

        const freeDoc = fakeDoc([
            '*MAT_DAMAGE_1',
            '0,0,0,0,0,0,0',
            '0,0,0,0,0,0,0,0',
        ].join('\n'), path.resolve('official-choice-hover', 'free.k'));
        freeDoc.languageId = 'lsdyna';
        freeDoc.version = 1;
        const freeHover = await provider.provideDetailedHover(freeDoc, { line: 2, character: 7 });
        assert.ok(!freeHover || !freeHover.contents[0].value.includes('command:extension.pickOfficialFieldValue'));
    });
});

describe('structured manual chapter actions', () => {
    let originalGetConfiguration;
    let originalGetManualLocations;
    let originalGetManualFilesCount;
    const manualIndexer = require("../../src/core/manualIndexer");

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

        {
            const md = new vscodeMock.MarkdownString();
            appendManualLinks(md, '*NOT_IN_RUNTIME_INDEX');

            assert.ok(!md.value.includes('command:extension.openManual'));
            assert.ok(!md.value.includes('command:extension.manual.pickPdfLocation'));
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

        {
            const { ManualIndexRepository } = require("../../src/manual/ManualIndexRepository");
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
        }
    });
});

describe('pickManualLocation', () => {
    let originalGetManualLocations;
    let originalShowQuickPick;
    let originalShowInformationMessage;
    let originalExecuteCommand;
    const manualIndexer = require("../../src/core/manualIndexer");

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
            const doc = fakeDoc('*NODE\n*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE\n*NOT_A_VERIFIED_KEYWORD\n');
            const lenses = provider.provideCodeLenses(doc);
            const nodeLenses = lenses.filter(lens => lens.range.start.line === 0);
            const optionLenses = lenses.filter(lens => lens.range.start.line === 1);

            assert.equal(nodeLenses.length, 3);
            const nodeManagerLens = nodeLenses.find(lens => lens.command.command === 'extension.lsdynaChooseKeywordOptions');
            assert.ok(nodeManagerLens);
            assert.deepEqual(nodeManagerLens.command.arguments, [0]);
            assert.equal(lenses.some(lens => lens.range.start.line === 2), false);
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

    it('preserves orphan option comments without assigning them to data', async () => {
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
            '$# title                                                                        ',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '                                                                 1e+21          '
        ]);
    });

    it('preserves blank data records following orphan option comments', async () => {
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
            '$#  ignore      bckt    lcbckt    ns2trk   inititr    parmax    unused    cparm8',
            '$#     cidheading                                                               ',
            '',
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
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), 'utf8'));
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

        const repoRoot = path.join(__dirname, "../..");
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
            assert.equal(i18n.get('parameterCompletionValue', 2), '有效值：2');
            assert.equal(i18n.get('manualSidebarSearchModeKeyword'), '关键字与标题');
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
            assert.equal(i18n.get('parameterFindReferences'), 'Find references');
            assert.equal(i18n.get('parameterCompletionValue', 2), 'Effective value: 2');
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
        const workspace = require("../support/vscode-mock").workspace;
        const originalGetConfiguration = workspace.getConfiguration;

        try {
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

        } finally { workspace.getConfiguration = originalGetConfiguration; }
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
            const { readFileSnippet } = require("../../src/client/providers/keywordIndexProvider");
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
        const { formatBytes, formatShortBytes, formatVividBytes, applyVividDescription } = require("../../src/client/providers/includeTreeProvider");
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
        assert.strictEqual(formatVividBytes(0), '0 B');
        assert.strictEqual(formatVividBytes(512), '512.0 B');
        assert.strictEqual(formatVividBytes(1024 * 5), '5.0 KB');
        assert.strictEqual(formatVividBytes(1024 * 45), '45.0 KB');
        assert.strictEqual(formatVividBytes(1024 * 1024 * 1.2), '1.2 MB');

        // Test applyVividDescription
        const mockItem1 = { contextValue: 'file', description: '', fileSizeVal: 1024 * 5 };
        applyVividDescription(mockItem1, 'sub');
        assert.strictEqual(mockItem1.description, '• 5.0 KB');
        assert.strictEqual(mockItem1.relDir, 'sub');
        applyVividDescription(mockItem1, 'sub', false);
        assert.strictEqual(mockItem1.description, '');

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
    it('browses one level on / and inserts full relative paths', async () => {
        const { LsdynaIncludeCompletionProvider } = extensionModule._internals;
        const provider = new LsdynaIncludeCompletionProvider();

        const tempDir = makeTemp(path.join(os.tmpdir(), 'lsdyna-completion-test-'));
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

        {
            // Empty card: Mode A empty query → no dump of entire tree
            const emptyList = await provider.provideCompletionItems(doc, { line: 5, character: 0 });
            assert.ok(emptyList);
            assert.strictEqual(emptyList.isIncomplete, true);
            assert.strictEqual(emptyList.items.length, 0);

            // Browse root via /
            const slashDoc = fakeDoc(`*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\n/`, mainFile);
            const slashList = await provider.provideCompletionItems(slashDoc, { line: 3, character: 1 });
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
            const backslashList = await provider.provideCompletionItems(backslashDoc, { line: 3, character: 1 });
            assert.ok(backslashList);
            assert.ok(backslashList.items.some(i => i.label === 'file2.k' || i.label === 'file1.k'));

            // Explicit root browse remains browse while typing a name. It filters only
            // the current level and never returns the matching file in unrelated/.
            for (const prefix of ['/ma', '\\ma', './ma', '.\\ma']) {
                const filteredDoc = fakeDoc(`*INCLUDE\n${prefix}`, mainFile);
                const filteredList = await provider.provideCompletionItems(
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
            const nestedList = await provider.provideCompletionItems(nestedDoc, { line: 1, character: 10 });
            assert.ok(nestedList);
            const nestedLabels = nestedList.items.map(i => i.label);
            assert.ok(nestedLabels.includes('submodels/file2.k'));
            assert.ok(nestedList.items.every(i => String(i.insertText || i.label).includes('/')));

            // Partial segment filter
            const partialDoc = fakeDoc(`*INCLUDE\nsubmodels/fi`, mainFile);
            const partialList = await provider.provideCompletionItems(partialDoc, { line: 1, character: 12 });
            assert.ok(partialList.items.some(i => i.label === 'submodels/file2.k'));

            // Range with leading spaces
            const prefixDoc = fakeDoc(`*INCLUDE\n  submodels/fi`, mainFile);
            const prefixList = await provider.provideCompletionItems(prefixDoc, { line: 1, character: 14 });
            assert.ok(prefixList);
            for (const item of prefixList.items) {
                assert.strictEqual(item.range.start.line, 1);
                assert.strictEqual(item.range.start.character, 2);
                assert.strictEqual(item.range.end.character, 14);
            }

            // Bare name search (Mode A) — full relPath
            const searchDoc = fakeDoc(`*INCLUDE\nfile2`, mainFile);
            const searchList = await provider.provideCompletionItems(searchDoc, { line: 1, character: 5 });
            assert.ok(searchList.items.some(i => i.label === 'file2.k' || i.label === 'submodels/file2.k'));

            // Keyword line / INCLUDE_PATH card / comment → empty
            assert.strictEqual(
                ((await provider.provideCompletionItems(doc, { line: 4, character: 0 })).items || []).length,
                0
            );
            assert.strictEqual(
                ((await provider.provideCompletionItems(doc, { line: 1, character: 0 })).length
                    || (await provider.provideCompletionItems(doc, { line: 1, character: 0 })).items?.length
                    || 0),
                0
            );
            const docWithComment = fakeDoc(`*INCLUDE\n$ this is a comment\n`, mainFile);
            assert.strictEqual(
                ((await provider.provideCompletionItems(docWithComment, { line: 1, character: 0 })).items || []).length,
                0
            );
        }
    });

    it('provides browse items from continued *INCLUDE_PATH directories', async () => {
        const { LsdynaIncludeCompletionProvider } = extensionModule._internals;
        const provider = new LsdynaIncludeCompletionProvider();

        const tempDir = makeTemp(path.join(os.tmpdir(), 'lsdyna-completion-continued-'));
        const includeDir = path.join(tempDir, 'shared', 'includes');
        const mainFile = path.join(tempDir, 'main.k');
        fs.mkdirSync(includeDir, { recursive: true });
        fs.writeFileSync(path.join(includeDir, 'continued.k'), '');

        const part1 = includeDir.slice(0, 78);
        const part2 = includeDir.slice(78);
        const mainFileContent = `*INCLUDE_PATH\n${part1} +\n${part2}\n*INCLUDE\n/`;
        fs.writeFileSync(mainFile, mainFileContent);
        const doc = fakeDoc(mainFileContent, mainFile);

        {
            const list = await provider.provideCompletionItems(doc, { line: 4, character: 1 });
            assert.ok(list);
            const labels = list.items.map(item => item.label);
            assert.ok(labels.includes('continued.k'));
            const item = list.items.find(i => i.label === 'continued.k');
            assert.strictEqual(item.insertText, 'continued.k');
        }
    });

    it('does not truncate large browse levels while retaining the search top-N limit', async () => {
        const { LsdynaIncludeCompletionProvider } = extensionModule._internals;
        const provider = new LsdynaIncludeCompletionProvider();
        const tempDir = makeTemp(path.join(os.tmpdir(), 'lsdyna-completion-count-'));
        const mainFile = path.join(tempDir, 'main.k');

        {
            for (let i = 0; i < 75; i++) {
                fs.mkdirSync(path.join(tempDir, `dir_${String(i).padStart(2, '0')}`));
            }
            for (let i = 0; i < 50; i++) {
                fs.writeFileSync(path.join(tempDir, `mat_${String(i).padStart(2, '0')}.k`), '');
            }
            fs.writeFileSync(mainFile, '*INCLUDE\n/');

            const browseDoc = fakeDoc('*INCLUDE\n/', mainFile);
            const browseList = await provider.provideCompletionItems(browseDoc, { line: 1, character: 1 });
            assert.strictEqual(
                browseList.items.filter(item => item.kind === vscodeMock.CompletionItemKind.Folder).length,
                75,
            );

            const searchDoc = fakeDoc('*INCLUDE\nmat', mainFile);
            const searchList = await provider.provideCompletionItems(searchDoc, { line: 1, character: 3 });
            assert.strictEqual(searchList.items.length, 40);
        }
    });

    it('fails closed across all completion providers when the active document has multiple selections', async () => {
        const {
            LsdynaIncludeCompletionProvider,
            LsdynaFieldCompletionProvider,
            LsdynaKeywordCompletionProvider,
        } = extensionModule._internals;
        const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
        const tempDir = makeTemp(path.join(os.tmpdir(), 'lsdyna-completion-multicursor-'));
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
                const single = await provider.provideCompletionItems(document, position);
                const singleItems = Array.isArray(single) ? single : single.items;
                assert.ok(singleItems.length > 0);

                vscodeMock.window.activeTextEditor.selections = [{}, {}];
                const multiple = await provider.provideCompletionItems(document, position);
                const multipleItems = Array.isArray(multiple) ? multiple : multiple.items;
                assert.strictEqual(multipleItems.length, 0);
            }
        } finally {
            vscodeMock.window.activeTextEditor = originalActiveTextEditor;
        }
    });
});

describe('file reveal commands', () => {
    it('observes rejected include commands and retains their existing localized errors', async () => {
        const originalRegisterCommand = vscodeMock.commands.registerCommand;
        const originalExecuteCommand = vscodeMock.commands.executeCommand;
        const originalShowError = vscodeMock.window.showErrorMessage;
        const commands = new Map(), errors = [], failure = Error('fixture open failed');
        vscodeMock.commands.registerCommand = (id, callback) => {
            commands.set(id, callback);
            return { dispose() {} };
        };
        vscodeMock.commands.executeCommand = id => ['vscode.open', 'revealFileInOS'].includes(id)
            ? Promise.reject(failure) : Promise.resolve();
        vscodeMock.window.showErrorMessage = async message => { errors.push(message); };
        try {
            await extensionModule.activate({ subscriptions: [], asAbsolutePath: value => value });
            for (const [command, key] of [['extension.openIncludeNewTab', 'failedToOpenFile'],
                ['extension.openIncludeSplit', 'failedToSplitOpenFile'], ['extension.openIncludeFolder', 'failedToRevealFolder']]) {
                await commands.get(command)('/project/main.k');
                assert.equal(errors.at(-1), require('../../src/core/i18n').get(key, failure.message));
            }
            assert.equal(await commands.get('extension.openToSide')({ filePath: '/project/main.k' }), false);
            for (const command of ['extension.revealInExplorer']) {
                await assert.rejects(commands.get(command)({ filePath: '/project/main.k' }), error => error === failure);
            }
        } finally {
            vscodeMock.commands.registerCommand = originalRegisterCommand;
            vscodeMock.commands.executeCommand = originalExecuteCommand;
            vscodeMock.window.showErrorMessage = originalShowError;
        }
    });

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
    const hostPath = value => path.resolve(value.replace(/\\/g, '/'));
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
    let originalWorkspaceFolders;
    const restoreEnvironment = () => {
        for (const [key, value] of [['PATH', originalPathEnv], ['LOCALAPPDATA', originalLocalAppdataEnv], ['APPDATA', originalAppdataEnv]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };

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
        originalWorkspaceFolders = vscodeMock.workspace.workspaceFolders;

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
        vscodeMock.workspace.workspaceFolders = originalWorkspaceFolders;
        restoreEnvironment();
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
        restoreEnvironment();

        require('fs').existsSync = (p) => {
            if (p in mockExistsMap) {
                return mockExistsMap[p];
            }
            if (typeof p === 'string' && p.toLowerCase().includes('sumatrapdf.exe')) {
                return false;
            }
            if (Object.entries(mockExistsMap).some(([file, exists]) => exists
                && file.startsWith(String(p) + path.sep))) return true;
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
        mockConfig.manualsDir = hostPath('C:\\custom\\manuals');
        mockExistsMap[hostPath('C:\\custom\\manuals\\SumatraPDF.exe')] = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = hostPath('C:\\path\\to\\manual.pdf');
        await openManual(pdfPath, 12);

        assert.deepStrictEqual(spawnCalls, [{
            exe: hostPath('C:\\custom\\manuals\\SumatraPDF.exe'),
            args: ['-reuse-instance', '-page', '12', pdfPath],
            options: { shell: false, detached: true, stdio: 'ignore', windowsHide: false },
        }]);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 0);
    });

    it('uses SumatraPDF.exe from a packaged pdf subdirectory', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = hostPath('C:\\manual-pack');
        mockExistsMap[hostPath('C:\\manual-pack\\pdf\\SumatraPDF.exe')] = true;

        const openManual = registeredCommands.get('extension.openManual');
        await openManual(hostPath('C:\\manual-pack\\pdf\\Volume I.pdf'), 8);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].exe, hostPath('C:\\manual-pack\\pdf\\SumatraPDF.exe'));
        assert.deepStrictEqual(spawnCalls[0].args, ['-reuse-instance', '-page', '8', hostPath('C:\\manual-pack\\pdf\\Volume I.pdf')]);
        assert.strictEqual(openExternalCalls.length, 0);
    });

    it('uses relative manualsDir next to Code.exe before workspaceFolders', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'relative/manuals';
        vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: hostPath('C:\\workspace') } }];
        // Only workspace has Sumatra — still works as fallback when install root misses it.
        mockExistsMap[hostPath('C:\\workspace\\relative\\manuals\\SumatraPDF.exe')] = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = hostPath('C:\\path\\to\\manual.pdf');
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].exe, hostPath('C:\\workspace\\relative\\manuals\\SumatraPDF.exe'));
        assert.deepStrictEqual(spawnCalls[0].args, ['-reuse-instance', '-page', '12', pdfPath]);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 0);
    });

    it('prefers Code.exe-relative manualsDir over workspace when both have Sumatra', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'relative/manuals';
        vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: hostPath('C:\\workspace') } }];
        const exeDir = path.dirname(process.execPath);
        const exeSumatra = path.join(exeDir, 'relative', 'manuals', 'SumatraPDF.exe');
        mockExistsMap[exeSumatra] = true;
        mockExistsMap[hostPath('C:\\workspace\\relative\\manuals\\SumatraPDF.exe')] = true;

        const openManual = registeredCommands.get('extension.openManual');
        await openManual(hostPath('C:\\path\\to\\manual.pdf'), 12);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].exe, exeSumatra);
    });

    it('uses the viewer from the reader-selected workspace pack over an earlier empty candidate', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'relative/manuals';
        vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: hostPath('C:\\workspace') } }];
        const exeRoot = path.join(path.dirname(process.execPath), 'relative', 'manuals');
        const selected = path.join(hostPath('C:\\workspace'), 'relative', 'manuals');
        mockExistsMap[path.join(exeRoot, 'SumatraPDF.exe')] = true;
        mockExistsMap[path.join(selected, 'indexes')] = true;
        mockExistsMap[path.join(selected, 'pdf', 'SumatraPDF.exe')] = true;
        await registeredCommands.get('extension.openManual')(hostPath('C:\\model\\manual.pdf'), 1);
        assert.equal(spawnCalls[0].exe, path.join(selected, 'pdf', 'SumatraPDF.exe'));
    });
    it('uses the system viewer when the selected pack has no Sumatra even if another candidate does', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'relative/manuals';
        vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: hostPath('C:\\workspace') } }];
        mockExistsMap[path.join(path.dirname(process.execPath), 'relative', 'manuals', 'indexes')] = true;
        mockExistsMap[path.join(hostPath('C:\\workspace'), 'relative', 'manuals', 'SumatraPDF.exe')] = true;
        await registeredCommands.get('extension.openManual')(hostPath('C:\\model\\manual.pdf'), 1);
        assert.equal(spawnCalls.length, 0);
        assert.equal(openExternalCalls.length, 1);
    });

    it('uses relative manualsDir path resolved against process.cwd() when install root and workspace miss', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'relative/manuals';
        vscodeMock.workspace.workspaceFolders = undefined;
        const resolvedPath = path.resolve(process.cwd(), 'relative/manuals', 'SumatraPDF.exe');
        mockExistsMap[resolvedPath] = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = hostPath('C:\\path\\to\\manual.pdf');
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

        const pdfPath = hostPath('C:\\path\\to\\manual.pdf');
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 0);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 1);
    });

    it('returns null and falls back when SumatraPDF.exe does not exist in manualsDir', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = hostPath('C:\\custom\\manuals');
        mockExistsMap[hostPath('C:\\custom\\manuals\\SumatraPDF.exe')] = false;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = hostPath('C:\\path\\to\\manual.pdf');
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 0);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 1);
    });

    it('falls back to the system PDF handler when Sumatra launch fails', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = hostPath('C:\\custom\\manuals');
        mockExistsMap[hostPath('C:\\custom\\manuals\\SumatraPDF.exe')] = true;

        mockSpawnError = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = hostPath('C:\\path\\to\\manual.pdf');
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 1);
    });

    it('passes shell metacharacters in PDF paths as opaque arguments', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = hostPath('C:\\custom\\manuals');
        mockExistsMap[hostPath('C:\\custom\\manuals\\SumatraPDF.exe')] = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = hostPath('C:\\path & 100%!\\manual.pdf');
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

    for (const failure of ['true', 'false', 'rejected', 'thrown']) {
        it(`observes a ${failure} system PDF open result without blocking the command`, async () => {
            Object.defineProperty(process, 'platform', { value: failure === 'rejected' || failure === 'thrown' ? 'win32' : 'darwin' });
            if (failure === 'thrown') {
                mockConfig.manualsDir = hostPath('C:\\custom\\manuals');
                mockExistsMap[hostPath('C:\\custom\\manuals\\SumatraPDF.exe')] = true;
                mockSpawnError = true;
            }
            extensionModule._internals.clearSumatraPathCache();
            const originalOpen = vscodeMock.env.openExternal;
            const originalWarning = vscodeMock.window.showWarningMessage;
            const messages = [];
            let settle;
            vscodeMock.window.showWarningMessage = async message => { messages.push(message); };
            vscodeMock.env.openExternal = uri => {
                openExternalCalls.push(uri);
                if (failure === 'thrown') throw new Error('System opener rejected the file');
                return new Promise((resolve, reject) => {
                    settle = () => ['true', 'false'].includes(failure) ? resolve(failure === 'true') : reject(new Error('System opener rejected the file'));
                });
            };
            try {
                assert.strictEqual(registeredCommands.get('extension.openManual')('/path/to/manual.pdf', 12), undefined);
                assert.equal(openExternalCalls.length, 1);
                assert.equal(spawnCalls.length, failure === 'thrown' ? 1 : 0);
                if (settle) {
                    assert.deepEqual(messages, []);
                    settle();
                }
                await new Promise(resolve => setImmediate(resolve));
                assert.deepEqual(messages, failure === 'true' ? [] : [i18n.get('manualPdfNotOpened')]);
            } finally {
                vscodeMock.env.openExternal = originalOpen;
                vscodeMock.window.showWarningMessage = originalWarning;
            }
        });
    }

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
        const originalGetManualLocations = require("../../src/core/manualIndexer").getManualLocations;
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
            require("../../src/core/manualIndexer").getManualLocations = () => {
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
            require("../../src/core/manualIndexer").getManualLocations = originalGetManualLocations;
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
        }
    });

    it('shows the reader warning only for approximate keyword matches', async () => {
        const root = makeTemp(path.join(os.tmpdir(), 'lsdyna-reader-match-command-'));
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

        const { ManualIndexRepository } = require("../../src/manual/ManualIndexRepository");
        const { ManualReaderPanel } = require("../../src/manual/ManualReaderPanel");
        const originalResolveKeywordLocations = ManualIndexRepository.prototype.resolveKeywordLocations;
        const originalShowPanel = ManualReaderPanel.show;
        const originalSetStatusBarMessage = vscodeMock.window.setStatusBarMessage;
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
        vscodeMock.window.setStatusBarMessage = message => {
            messages.push(message);
        };

        try {
            const openCurrentKeyword = registeredCommands.get('extension.manual.openCurrentKeyword');
            assert.ok(openCurrentKeyword);
            await openCurrentKeyword('*MAT_APPROXIMATE_CASE');
            await openCurrentKeyword('*MAT_024_LOG_INTERPOLATION');

            assert.strictEqual(opened, 2);
            assert.deepStrictEqual(messages, []);
        } finally {
            ManualIndexRepository.prototype.resolveKeywordLocations = originalResolveKeywordLocations;
            ManualReaderPanel.show = originalShowPanel;
            vscodeMock.window.setStatusBarMessage = originalSetStatusBarMessage;
        }
    });
});

describe('3D table preview viewpoints', () => {
    afterEach(() => {
        clearTablePreviewViewsForTesting();
        vscodeMock.window.activeTextEditor = null;
        vscodeMock.window.visibleTextEditors = [];
    });

    it('stores a normalized session view independently for each source field', () => {
        const firstKey = buildTablePreviewReferenceKey('C:/model/main.k', 4, 'LCSS');
        const secondKey = buildTablePreviewReferenceKey('C:/model/main.k', 9, 'LCSS');

        assert.ok(firstKey);
        assert.notEqual(firstKey, secondKey);
        assert.equal(getTablePreviewViewForReference(firstKey), 'isometric');
        assert.equal(setTablePreviewViewForReference(firstKey, 'side'), true);
        assert.equal(getTablePreviewViewForReference(firstKey), 'side');
        assert.equal(getTablePreviewViewForReference(secondKey), 'isometric');
        assert.equal(setTablePreviewViewForReference(firstKey, 'top'), false);
        assert.equal(getTablePreviewViewForReference(firstKey), 'side');
    });

    it('refreshes the matching editor hover after a viewpoint change', async () => {
        const originalExecuteCommand = vscodeMock.commands.executeCommand;
        const calls = [];
        const originalSelection = new vscodeMock.Selection(
            new vscodeMock.Position(4, 15),
            new vscodeMock.Position(4, 15),
        );
        const editor = {
            document: { uri: { fsPath: 'C:/model/main.k' } },
            selections: [originalSelection],
            get selection() { return this.selections[0]; },
            set selection(value) { this.selections = [value]; },
        };
        vscodeMock.window.activeTextEditor = editor;
        vscodeMock.commands.executeCommand = command => {
            calls.push(command);
            return Promise.resolve();
        };
        const key = buildTablePreviewReferenceKey('C:/model/main.k', 4, 'LCSS');

        try {
            const changed = await handleSetTablePreviewViewCommand({
                key,
                view: 'reverse-isometric',
                filePath: 'C:/model/main.k',
                lineIndex: 4,
                character: 12,
                endCharacter: 20,
            });

            assert.equal(changed, true);
            assert.equal(getTablePreviewViewForReference(key), 'reverse-isometric');
            assert.deepEqual(calls, ['editor.action.hideHover', 'editor.action.showHover']);
            assert.strictEqual(editor.selection, originalSelection);
        } finally {
            vscodeMock.commands.executeCommand = originalExecuteCommand;
        }
    });

    it('refreshes at the mouse source and restores all selections when the caret is elsewhere', async () => {
        const originalExecuteCommand = vscodeMock.commands.executeCommand;
        const originalSetStatusBarMessage = vscodeMock.window.setStatusBarMessage;
        const calls = [];
        const hints = [];
        const originalSelection = new vscodeMock.Selection(
            new vscodeMock.Position(8, 3),
            new vscodeMock.Position(8, 3),
        );
        const editor = {
            document: { uri: { fsPath: 'C:/model/main.k' } },
            selections: [originalSelection, new vscodeMock.Selection(new vscodeMock.Position(9, 1), new vscodeMock.Position(9, 3))],
            get selection() { return this.selections[0]; },
            set selection(value) { this.selections = [value]; },
        };
        const originalSelections = editor.selections;
        vscodeMock.window.activeTextEditor = editor;
        vscodeMock.commands.executeCommand = (command, args) => {
            calls.push(command);
            assert.equal(editor.selection.active.line, 4);
            assert.equal(editor.selection.active.character, 12);
            if (command === 'editor.action.showHover') assert.deepEqual(args, { focus: 'autoFocusImmediately' });
            return Promise.resolve();
        };
        vscodeMock.window.setStatusBarMessage = message => {
            hints.push(message);
        };

        try {
            const changed = await handleSetTablePreviewViewCommand({
                key: buildTablePreviewReferenceKey('C:/model/main.k', 4, 'LCSS'),
                view: 'front',
                filePath: 'C:/model/main.k',
                lineIndex: 4,
                character: 12,
                endCharacter: 20,
            });

            assert.equal(changed, true);
            assert.deepEqual(calls, ['editor.action.hideHover', 'editor.action.showHover']);
            assert.deepEqual(hints, []);
            assert.strictEqual(editor.selection, originalSelection);
            assert.strictEqual(editor.selections, originalSelections);
        } finally {
            vscodeMock.commands.executeCommand = originalExecuteCommand;
            vscodeMock.window.setStatusBarMessage = originalSetStatusBarMessage;
        }
    });
    for (const outcome of ['failed-command', 'user-selection-changed', 'another-document']) {
        it(`preserves editing state on ${outcome}`, async () => {
            const execute = vscodeMock.commands.executeCommand;
            const original = [new vscodeMock.Selection(new vscodeMock.Position(8, 3), new vscodeMock.Position(8, 4))];
            const editor = {
                document: { uri: { fsPath: outcome === 'another-document' ? 'C:/other.k' : 'C:/model/main.k' } },
                selections: original,
                get selection() { return this.selections[0]; },
                set selection(value) { this.selections = [value]; },
            };
            vscodeMock.window.activeTextEditor = editor;
            let calls = 0, changedSelections;
            vscodeMock.commands.executeCommand = async command => {
                calls++;
                if (command !== 'editor.action.showHover') return;
                if (outcome === 'failed-command') throw Error('Hover unavailable');
                // A new secondary cursor must not be overwritten by restoration.
                changedSelections = [editor.selection, ...original];
                editor.selections = changedSelections;
            };
            try {
                const result = handleSetTablePreviewViewCommand({key: 'preview', view: 'side',
                    filePath: 'C:/model/main.k', lineIndex: 4, character: 12, endCharacter: 20});
                if (outcome === 'failed-command') await assert.rejects(result, /Hover unavailable/);
                else assert.equal(await result, true);
                assert.equal(calls, outcome === 'another-document' ? 0 : 2);
                assert.strictEqual(editor.selections, changedSelections || original);
            } finally { vscodeMock.commands.executeCommand = execute; }
        });
    }
});

describe('LsdynaDefinitionProvider field references', () => {
    beforeEach(() => require('../../out/extension')._internals.setReferenceQueryClientForTesting(null));
    const touchedFileIndexes = new Set();

    function materialReferenceDocument(filePath, value = '1001') {
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '         1       7.8     210.0       0.3     400.0       0.0',
            [0, 0, value, 0, 0].map(item => String(item).padStart(10)).join(''),
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';
        return doc;
    }

    function adaptiveBoxDocument(filePath, value) {
        const doc = fakeDoc([
            '*DEFINE_BOX_ADAPTIVE',
            [1, 0, 0, 0, 0, 0, 0].map(item => String(item).padStart(10)).join(''),
            [0, 1, value, 0, 0, 0, 0].map(item => String(item).padStart(10)).join(''),
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';
        return doc;
    }

    function constrainedPartReferenceDocument(filePath, value = 42) {
        const doc = fakeDoc([
            '*CONSTRAINED_NODAL_RIGID_BODY',
            [value, 0, 0, 0, 0, 0, 0].map(item => String(item).padStart(10)).join(''),
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';
        return doc;
    }

    function loadBodyCurveReferenceDocument(filePath, value = 1000001) {
        const doc = fakeDoc([
            '*LOAD_BODY_Z',
            [value, 9806, 0, 0, 0, 0, 0].map(item => String(item).padStart(10)).join(''),
            '*DEFINE_CURVE',
            [value, 0, 1, 1, 0, 0, 0].map(item => String(item).padStart(10)).join(''),
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';
        return doc;
    }

    function loadBodyPartsSetPartDocument(filePath, value = 1000001) {
        const doc = fakeDoc([
            '*LOAD_BODY_PARTS',
            [value, 1, 0].map(item => String(item).padStart(10)).join(''),
            '*SET_PART',
            String(value).padStart(10),
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';
        return doc;
    }

    function partAdpoptReferenceDocument(filePath, value = -17) {
        const doc = fakeDoc([
            '*PART',
            'Registry signed reference fixture',
            [1, 0, 0, 0, 0, 0, value, 0].map(item => String(item).padStart(10)).join(''),
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';
        return doc;
    }

    function partDefinition(filePath, id = 42, line = 2) {
        const raw = String(id);
        return {
            kind: 'generic',
            id,
            idRaw: raw,
            keyword: '*PART',
            targetKeyword: 'PART',
            targetKind: 'part',
            ruleId: 'rule:da4aa6b06d895cb13ae9120b',
            evidenceIds: ['evidence:c05c75b0b88afcbdc9057f5d'],
            filePath,
            startLine: Math.max(0, line - 2),
            endLine: line,
            idLine: line,
            idStartChar: 10 - raw.length,
            idEndChar: 10,
        };
    }

    function emptyDefinitions() {
        return { curves: [], tables: [], genericDefinitions: [] };
    }

    function curveDefinition(filePath, id = 1001, line = 2) {
        const raw = String(id);
        return {
            kind: 'curve',
            id,
            idRaw: raw,
            keyword: '*DEFINE_CURVE',
            filePath,
            startLine: Math.max(0, line - 1),
            endLine: line + 2,
            idLine: line,
            idStartChar: 10 - raw.length,
            idEndChar: 10,
            points: [],
        };
    }

    function setPartDefinition(filePath, id = 1000001, line = 3) {
        const raw = String(id);
        return {
            kind: 'generic',
            id,
            idRaw: raw,
            keyword: '*SET_PART',
            targetKeyword: 'SET_PART',
            targetKind: 'part-set',
            ruleId: 'rule:94d1738d89bdf682dd5fc3bb',
            evidenceIds: ['evidence:a347e4e065b89b286fac2b17'],
            filePath,
            startLine: line - 1,
            endLine: line,
            idLine: line,
            idStartChar: 10 - raw.length,
            idEndChar: 10,
        };
    }

    function rememberFileIndex(filePath, fileIndex) {
        touchedFileIndexes.add(filePath);
        setFileIndexForTesting(filePath, fileIndex);
    }

    afterEach(() => {
        clearReferenceIndexCacheForTesting();
        for (const filePath of touchedFileIndexes) setFileIndexForTesting(filePath, null);
        touchedFileIndexes.clear();
    });

    it('uses the Registry-authorized relation as the primary native F12 scope', async () => {
        const rootFile = path.resolve('definition-navigation', 'registry-main.k');
        const partFile = path.resolve('definition-navigation', 'registry-parts.k');
        const doc = constrainedPartReferenceDocument(rootFile);
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, partFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:parts',
                    fromFile: rootFile,
                    filePath: partFile,
                    fileName: path.basename(partFile),
                    lineIndex: 2,
                    keyword: '*INCLUDE',
                }],
            },
            fileIndexes: new Map([
                [rootFile, { parameterEvents: [], referenceDefinitions: emptyDefinitions() }],
                [partFile, {
                    parameterEvents: [],
                    referenceDefinitions: {
                        curves: [], tables: [], genericDefinitions: [partDefinition(partFile)],
                    },
                }],
            ]),
        });

        const navigation = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(1, 2),
            null,
            { semanticScope: 'registry-approved' },
        );
        const definition = await new LsdynaDefinitionProvider().provideDefinition(
            doc,
            new vscodeMock.Position(1, 2),
        );

        assert.equal(navigation.authorityScope, 'definition-registry');
        assert.equal(navigation.source.referenceInfo.definitionRegistry.f12Authorized, true);
        assert.equal(
            navigation.source.referenceInfo.definitionRegistry.authoringRelationId,
            'authoring-relation:4634a76c9a6a04205a6ff1e7',
        );
        assert.equal(navigation.state, 'resolved');
        assert.equal(definition.uri.fsPath, partFile);
        assert.equal(definition.range.start.line, 2);
    });

    it('uses a verified native node target despite an ambiguous manual projection without inventing a definition', async () => {
        const filePath = path.resolve('definition-navigation', 'ambiguous-change-boundary.k');
        const doc = fakeDoc([
            '*CHANGE_BOUNDARY_CONDITION',
            [42, 0, 0, 0, 0, 0, 0, 0].map(value => String(value).padStart(10)).join(''),
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';

        const source = fieldReferenceAtPosition(
            doc,
            new vscodeMock.Position(1, 5),
            { semanticScope: 'registry-approved' },
        );
        assert.equal(source.authorityScope, "keyword-catalog");
        assert.equal(source.referenceValue.id, 42);
        assert.deepEqual(source.referenceValue.targetKinds, ['node']);
        assert.deepEqual(source.referenceValue.targetDefinitions, ['NODE']);
        const navigation = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(1, 5),
            null,
            { semanticScope: 'registry-approved' },
        );
        assert.equal(navigation.state, 'unindexed');
        assert.deepEqual(navigation.candidates, []);
        assert.equal(await new LsdynaDefinitionProvider().provideDefinition(
            doc,
            new vscodeMock.Position(1, 5),
        ), null);
    });

    it('navigates LOAD_BODY_Z/LCID to DEFINE_CURVE and back through family provenance', async () => {
        const filePath = path.resolve('definition-navigation', 'registry-load-body-curve.k');
        const doc = loadBodyCurveReferenceDocument(filePath);
        const source = fieldReferenceAtPosition(
            doc,
            new vscodeMock.Position(1, 5),
            { semanticScope: 'registry-approved' },
        );
        const referenceOccurrence = {
            filePath,
            keyword: '*LOAD_BODY_Z',
            cardIndex: 1,
            fieldName: 'LCID',
            lineIndex: 1,
            startCharacter: 3,
            endCharacter: 10,
            rawValue: '1000001',
            authoringRelationId: source.referenceInfo.definitionRegistry.authoringRelationId,
            coordinateId: source.referenceInfo.definitionRegistry.coordinateId,
            sourceRuleId: source.referenceInfo.ruleId,
            referenceValue: source.referenceValue,
            targetKinds: source.referenceValue.targetKinds,
            targetDefinitions: source.referenceValue.targetDefinitions,
        };
        cacheReferenceIndexFromSnapshot({
            rootFile: filePath,
            files: [filePath],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[filePath, {
                parameterEvents: [],
                referenceDefinitions: {
                    curves: [curveDefinition(filePath, 1000001, 3)],
                    tables: [],
                    genericDefinitions: [],
                },
                registryReferences: {
                    complete: true,
                    reasons: [],
                    referenceOccurrences: [referenceOccurrence],
                    valueDomainOccurrences: [],
                },
            }]]),
        });

        const navigation = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(1, 5),
            null,
            { semanticScope: 'registry-approved' },
        );
        const definition = await new LsdynaDefinitionProvider().provideDefinition(
            doc,
            new vscodeMock.Position(1, 5),
        );
        const references = await new LsdynaReferenceProvider().provideReferences(
            doc,
            new vscodeMock.Position(3, 5),
            { includeDeclaration: true },
        );

        assert.equal(navigation.authorityScope, "keyword-catalog");
        assert.equal(navigation.source.referenceValue.id, 1000001);
        assert.equal(navigation.source.referenceInfo.source, "keyword-catalog");
        assert.deepEqual(navigation.source.referenceValue.targetKinds, ['curve']);
        assert.ok(navigation.source.referenceValue.targetDefinitions.includes('DEFINE_CURVE'));
        assert.ok(navigation.source.referenceValue.targetDefinitions.every(name => /^DEFINE_CURVE(?:_|$)/.test(name)));
        assert.equal(definition.range.start.line, 3);
        assert.deepEqual(references.map(location => location.range.start.line).sort((a, b) => a - b), [1, 3]);
    });

    it('finds LOAD_BODY_Z references from DEFINE_CURVE in an unscanned single document', async () => {
        const filePath = path.resolve('definition-navigation', 'registry-load-body-local.k');
        const doc = loadBodyCurveReferenceDocument(filePath);
        const originalDocuments = vscodeMock.workspace.textDocuments;
        vscodeMock.workspace.textDocuments = [doc];
        try {
            const network = await resolveRegistryReferenceNetwork(
                doc,
                new vscodeMock.Position(3, 5),
                { includeDeclaration: false },
            );
            const references = await new LsdynaReferenceProvider().provideReferences(
                doc,
                new vscodeMock.Position(3, 5),
                { includeDeclaration: false },
            );

            assert.equal(network.state, 'complete', JSON.stringify(network.reasons));
            assert.equal(network.referenceIndexState.projectScoped, false);
            assert.equal(network.referenceIndexState.singleDocumentScoped, true);
            assert.deepEqual(network.locations.map(location => location.line), [1]);
            assert.deepEqual(references.map(location => location.range.start.line), [1]);
        } finally {
            vscodeMock.workspace.textDocuments = originalDocuments;
        }
    });

    it('uses current-document references without scanning when an unscanned document has Include cards', async () => {
        const filePath = path.resolve('definition-navigation', 'registry-load-body-local-include.k');
        const doc = fakeDoc([
            loadBodyCurveReferenceDocument(filePath).getText(),
            '*INCLUDE',
            'other-curves.k',
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';
        doc.isDirty = false;
        let loads = 0;
        const network = await resolveRegistryReferenceNetwork(
            doc,
            new vscodeMock.Position(3, 5),
            { includeDeclaration: false },
            null,
            { loadProjectSnapshot: async () => { loads += 1; } },
        );

        assert.equal(loads, 0);
        assert.equal(network.state, 'complete', JSON.stringify(network.reasons));
        assert.equal(network.referenceIndexState.projectScoped, false);
        assert.equal(network.referenceIndexState.singleDocumentScoped, true);
        assert.deepEqual(network.locations.map(location => location.line), [1]);
    });

    it('uses every reference in an already-scanned Include closure', async () => {
        const filePath = path.resolve('definition-navigation', 'registry-load-body-root.k');
        const includePath = path.resolve('definition-navigation', 'other-loads.k');
        const doc = fakeDoc([
            loadBodyCurveReferenceDocument(filePath).getText(),
            '*INCLUDE',
            'other-curves.k',
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';
        doc.isDirty = false;
        const source = fieldReferenceAtPosition(
            doc,
            new vscodeMock.Position(1, 5),
            { semanticScope: 'registry-approved' },
        );
        const occurrence = {
            filePath,
            keyword: '*LOAD_BODY_Z',
            cardIndex: 1,
            fieldName: 'LCID',
            lineIndex: 1,
            startCharacter: 3,
            endCharacter: 10,
            rawValue: '1000001',
            authoringRelationId: source.referenceInfo.definitionRegistry.authoringRelationId,
            coordinateId: source.referenceInfo.definitionRegistry.coordinateId,
            sourceRuleId: source.referenceInfo.ruleId,
            referenceValue: source.referenceValue,
            targetKinds: source.referenceValue.targetKinds,
            targetDefinitions: source.referenceValue.targetDefinitions,
        };
        cacheReferenceIndexFromSnapshot({
            rootFile: filePath,
            files: [filePath, includePath],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:other-loads',
                    fromFile: filePath,
                    filePath: includePath,
                    fileName: path.basename(includePath),
                    lineIndex: 6,
                    keyword: '*INCLUDE',
                }],
                includeOccurrencesComplete: true,
            },
            fileIndexes: new Map([
                [filePath, {
                    parameterEvents: [],
                    referenceDefinitions: {
                        curves: [curveDefinition(filePath, 1000001, 3)],
                        tables: [],
                        genericDefinitions: [],
                    },
                    registryReferences: {
                        complete: true,
                        reasons: [],
                        referenceOccurrences: [occurrence],
                        valueDomainOccurrences: [],
                    },
                }],
                [includePath, {
                    parameterEvents: [],
                    referenceDefinitions: emptyDefinitions(),
                    registryReferences: {
                        complete: true,
                        reasons: [],
                        referenceOccurrences: [{ ...occurrence, filePath: includePath, lineIndex: 8 }],
                        valueDomainOccurrences: [],
                    },
                }],
            ]),
        });
        const network = await resolveRegistryReferenceNetwork(
            doc,
            new vscodeMock.Position(3, 5),
            { includeDeclaration: false },
        );

        assert.equal(network.state, 'complete', JSON.stringify(network.reasons));
        assert.equal(network.referenceIndexState.projectScoped, true);
        assert.deepEqual(
            network.locations.map(location => [location.filePath, location.line]),
            [[includePath, 8], [filePath, 1]],
        );
    });

    it('navigates LOAD_BODY_PARTS/PSID to corrected SET_PART/SID and back', async () => {
        const filePath = path.resolve('definition-navigation', 'registry-load-body-parts-set-part.k');
        const doc = loadBodyPartsSetPartDocument(filePath);
        const source = fieldReferenceAtPosition(
            doc,
            new vscodeMock.Position(1, 5),
            { semanticScope: 'registry-approved' },
        );
        assert.ok(source);
        const referenceOccurrence = {
            filePath,
            keyword: '*LOAD_BODY_PARTS',
            cardIndex: 1,
            fieldName: 'PSID',
            lineIndex: 1,
            startCharacter: 3,
            endCharacter: 10,
            rawValue: '1000001',
            authoringRelationId: source.referenceInfo.definitionRegistry.authoringRelationId,
            coordinateId: source.referenceInfo.definitionRegistry.coordinateId,
            sourceRuleId: source.referenceInfo.ruleId,
            referenceValue: source.referenceValue,
            targetKinds: source.referenceValue.targetKinds,
            targetDefinitions: source.referenceValue.targetDefinitions,
        };
        cacheReferenceIndexFromSnapshot({
            rootFile: filePath,
            files: [filePath],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[filePath, {
                parameterEvents: [],
                referenceDefinitions: {
                    curves: [], tables: [],
                    genericDefinitions: [setPartDefinition(filePath)],
                },
                registryReferences: {
                    complete: true,
                    reasons: [],
                    referenceOccurrences: [referenceOccurrence],
                    valueDomainOccurrences: [],
                },
            }]]),
        });

        const navigation = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(1, 5),
            null,
            { semanticScope: 'registry-approved' },
        );
        const definition = await new LsdynaDefinitionProvider().provideDefinition(
            doc,
            new vscodeMock.Position(1, 5),
        );
        const references = await new LsdynaReferenceProvider().provideReferences(
            doc,
            new vscodeMock.Position(3, 5),
            { includeDeclaration: true },
        );

        assert.equal(navigation.authorityScope, "keyword-catalog");
        assert.equal(navigation.source.referenceValue.id, 1000001);
        assert.deepEqual(navigation.source.referenceValue.targetKinds, ['part-set']);
        assert.ok(navigation.source.referenceValue.targetDefinitions.includes('SET_PART'));
        assert.ok(navigation.source.referenceValue.targetDefinitions.includes('SET_PART_LIST'));
        assert.ok(navigation.source.referenceValue.targetDefinitions.every(name => /^SET_PART(?:_|$)/.test(name)));
        assert.equal(definition.range.start.line, 3);
        assert.deepEqual(references.map(location => location.range.start.line).sort((a, b) => a - b),
            [1, 3]);
    });

    it('uses the native target for a covered field while preserving incomplete-index state', async () => {
        const filePath = path.resolve('definition-navigation', 'manual-runtime-scope.k');
        const doc = materialReferenceDocument(filePath);
        rememberFileIndex(filePath, {
            referenceDefinitions: {
                curves: [curveDefinition(filePath, 1001, 9)],
                tables: [],
                genericDefinitions: [],
            },
        });

        const source = fieldReferenceAtPosition(
            doc,
            new vscodeMock.Position(2, 24),
            { semanticScope: 'registry-approved' },
        );
        assert.equal(source.authorityScope, "keyword-catalog");
        assert.equal(source.referenceValue.id, 1001);
        const navigation = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(2, 24),
        );
        assert.equal(navigation.authorityScope, "keyword-catalog");
        assert.equal(navigation.state, 'unindexed');
        assert.equal(navigation.candidates.length, 1);
    });

    it('preserves the native signed predicate and abs transform for F12', async () => {
        const filePath = path.resolve('definition-navigation', 'registry-signed-part.k');
        const doc = partAdpoptReferenceDocument(filePath);
        rememberFileIndex(filePath, {
            referenceDefinitions: {
                curves: [curveDefinition(filePath, 17, 9)],
                tables: [],
                genericDefinitions: [],
            },
        });

        const navigation = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(2, 65),
            null,
            { semanticScope: 'registry-approved' },
        );
        assert.equal(navigation.authorityScope, "keyword-catalog");
        assert.equal(navigation.source.referenceValue.id, 17);
        assert.equal(navigation.source.referenceValue.idTransform, 'abs');
        assert.equal(navigation.source.referenceValue.isSignedSwitch, true);
        assert.deepEqual(navigation.source.referenceValue.targetKinds, ['curve']);
        assert.equal(navigation.candidates[0].line, 9);

        const nonReference = partAdpoptReferenceDocument(filePath, 2);
        assert.equal(fieldReferenceAtPosition(
            nonReference,
            new vscodeMock.Position(2, 65),
            { semanticScope: 'registry-approved' },
        ), null);
    });

    it('rejects blank, $/$# comments, and COMMENT opaque bodies before Registry lookup', async () => {
        const filePath = path.resolve('definition-navigation', 'registry-comment-boundaries.k');
        const comments = fakeDoc([
            '*CONSTRAINED_NODAL_RIGID_BODY',
            '',
            '$        42',
            '   $     42',
            '$#      PID       CID      NSID     PNODE      IPRT    DRFLAG    RRFLAG',
            '*COMMENT *CONSTRAINED_NODAL_RIGID_BODY',
            [42, 0, 0, 0, 0, 0, 0].map(item => String(item).padStart(10)).join(''),
            '*END',
        ].join('\n'), filePath);
        comments.languageId = 'lsdyna';

        for (const line of [1, 2, 3, 4, 6]) {
            const position = new vscodeMock.Position(line, Math.min(2, comments.lineAt(line).text.length));
            assert.equal(fieldReferenceAtPosition(
                comments,
                position,
                { semanticScope: 'registry-approved' },
            ), null);
            assert.equal(await resolveFieldReferenceNavigation(
                comments,
                position,
                null,
                { semanticScope: 'registry-approved' },
            ), null);
            assert.deepEqual(await new LsdynaReferenceProvider().provideReferences(
                comments,
                position,
                { includeDeclaration: true },
            ), []);
        }
        assert.equal(await new LsdynaDefinitionProvider().provideDefinition(
            comments,
            new vscodeMock.Position(6, 2),
        ), null);
    });

    it('keeps a current-file candidate navigable while reporting project coverage as unindexed', async () => {
        const filePath = path.resolve('definition-navigation', 'local.k');
        const doc = materialReferenceDocument(filePath);
        rememberFileIndex(filePath, {
            filePath,
            referenceDefinitions: {
                curves: [curveDefinition(filePath, 1001, 9)],
                tables: [],
                genericDefinitions: [],
            },
        });

        const navigation = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(2, 24),
        );
        const definition = await new LsdynaDefinitionProvider().provideDefinition(
            doc,
            new vscodeMock.Position(2, 24),
        );

        assert.equal(navigation.state, 'unindexed');
        assert.equal(navigation.candidateCertainty, 'known-candidate');
        assert.equal(navigation.candidates.length, 1);
        assert.equal(definition.uri.fsPath, filePath);
        assert.equal(definition.range.start.line, 9);
        assert.equal(definition.range.start.character, 6);
        assert.equal(definition.range.end.character, 10);
    });

    it('resolves an exact field reference across the selected Include closure', async () => {
        const rootFile = path.resolve('definition-navigation', 'main.k');
        const childFile = path.resolve('definition-navigation', 'curves.k');
        const doc = materialReferenceDocument(rootFile);
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, childFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:curves',
                    fromFile: rootFile,
                    filePath: childFile,
                    fileName: 'curves.k',
                    lineIndex: 4,
                    keyword: '*INCLUDE',
                }],
            },
            fileIndexes: new Map([
                [rootFile, { parameterEvents: [], referenceDefinitions: emptyDefinitions() }],
                [childFile, {
                    parameterEvents: [],
                    referenceDefinitions: {
                        curves: [curveDefinition(childFile, 1001, 12)],
                        tables: [],
                        genericDefinitions: [],
                    },
                }],
            ]),
        });

        const navigation = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(2, 24),
        );
        const definition = await new LsdynaDefinitionProvider().provideDefinition(
            doc,
            new vscodeMock.Position(2, 24),
        );

        assert.equal(navigation.state, 'resolved');
        assert.equal(navigation.referenceIndexState.projectScoped, true);
        assert.equal(definition.uri.fsPath, childFile);
        assert.equal(definition.range.start.line, 12);
    });

    it('opens the ranked provisional primary while hover retains physical alternatives', async () => {
        const rootFile = path.resolve('definition-navigation', 'peek-main.k');
        const firstFile = path.resolve('definition-navigation', 'first-curves.k');
        const secondFile = path.resolve('definition-navigation', 'second-curves.k');
        const doc = materialReferenceDocument(rootFile);
        const sharedDefinition = curveDefinition(firstFile, 1001, 5);
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, firstFile, secondFile],
            graph: {
                includeOccurrences: [
                    {
                        occurrenceId: 'root:first-a',
                        fromFile: rootFile,
                        filePath: firstFile,
                        fileName: path.basename(firstFile),
                        lineIndex: 1,
                        keyword: '*INCLUDE',
                    },
                    {
                        occurrenceId: 'root:first-b',
                        fromFile: rootFile,
                        filePath: firstFile,
                        fileName: path.basename(firstFile),
                        lineIndex: 2,
                        keyword: '*INCLUDE',
                    },
                    {
                        occurrenceId: 'root:second',
                        fromFile: rootFile,
                        filePath: secondFile,
                        fileName: path.basename(secondFile),
                        lineIndex: 3,
                        keyword: '*INCLUDE',
                    },
                ],
            },
            fileIndexes: new Map([
                [rootFile, { parameterEvents: [], referenceDefinitions: emptyDefinitions() }],
                [firstFile, {
                    parameterEvents: [],
                    referenceDefinitions: {
                        curves: [sharedDefinition], tables: [], genericDefinitions: [],
                    },
                }],
                [secondFile, {
                    parameterEvents: [],
                    referenceDefinitions: {
                        curves: [curveDefinition(secondFile, 1001, 8)],
                        tables: [],
                        genericDefinitions: [],
                    },
                }],
            ]),
        });

        const navigation = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(2, 24),
        );
        const definitions = await new LsdynaDefinitionProvider().provideDefinition(
            doc,
            new vscodeMock.Position(2, 24),
        );

        assert.equal(navigation.state, 'ambiguous');
        assert.equal(navigation.analysis.definitions.length, 3);
        assert.equal(navigation.candidates.length, 2);
        assert.equal(navigation.provisional, true);
        assert.equal(navigation.provisionalPrimary.filePath, firstFile);
        assert.equal(navigation.provisionalAlternatives.length, 1);
        assert.equal(definitions.uri.fsPath, firstFile);
    });

    it('reports missing only for a complete closure and otherwise remains unindexed', async () => {
        const rootFile = path.resolve('definition-navigation', 'missing-main.k');
        const doc = materialReferenceDocument(rootFile, '9999');
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[
                rootFile,
                { parameterEvents: [], referenceDefinitions: emptyDefinitions() },
            ]]),
        });

        const complete = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(2, 24),
        );
        assert.equal(complete.state, 'missing');
        assert.equal(complete.candidates.length, 0);

        clearReferenceIndexCacheForTesting();
        const localOnly = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(2, 24),
        );
        assert.equal(localOnly.state, 'unindexed');
        assert.ok(localOnly.reasons.includes('project-scan-unavailable'));

        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:missing-curves',
                    fromFile: rootFile,
                    filePath: path.resolve('definition-navigation', 'outside-index.k'),
                    fileName: 'outside-index.k',
                    lineIndex: 3,
                    keyword: '*INCLUDE',
                    missing: true,
                }],
            },
            fileIndexes: new Map([[
                rootFile,
                { parameterEvents: [], referenceDefinitions: emptyDefinitions() },
            ]]),
        });
        const outsideClosure = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(2, 24),
        );
        assert.equal(outsideClosure.state, 'out-of-closure');
        assert.ok(outsideClosure.reasons.includes('missing-include'));
    });

    it('does not borrow either project when a shared file has ambiguous main-deck context', async () => {
        const rootA = path.resolve('definition-navigation', 'root-a.k');
        const rootB = path.resolve('definition-navigation', 'root-b.k');
        const sharedFile = path.resolve('definition-navigation', 'shared-material.k');
        const curveA = path.resolve('definition-navigation', 'curve-a.k');
        const curveB = path.resolve('definition-navigation', 'curve-b.k');
        const doc = materialReferenceDocument(sharedFile);

        for (const [rootFile, curveFile] of [[rootA, curveA], [rootB, curveB]]) {
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
                            lineIndex: 1,
                            keyword: '*INCLUDE',
                        },
                        {
                            occurrenceId: `${rootFile}:curve`,
                            fromFile: rootFile,
                            filePath: curveFile,
                            fileName: path.basename(curveFile),
                            lineIndex: 2,
                            keyword: '*INCLUDE',
                        },
                    ],
                },
                fileIndexes: new Map([
                    [rootFile, { parameterEvents: [], referenceDefinitions: emptyDefinitions() }],
                    [sharedFile, { parameterEvents: [], referenceDefinitions: emptyDefinitions() }],
                    [curveFile, {
                        parameterEvents: [],
                        referenceDefinitions: {
                            curves: [curveDefinition(curveFile)],
                            tables: [],
                            genericDefinitions: [],
                        },
                    }],
                ]),
            });
        }

        const navigation = await resolveFieldReferenceNavigation(
            doc,
            new vscodeMock.Position(2, 24),
        );
        const definition = await new LsdynaDefinitionProvider().provideDefinition(
            doc,
            new vscodeMock.Position(2, 24),
        );

        assert.equal(navigation.state, 'ambiguous');
        assert.ok(navigation.reasons.includes('project-root-ambiguous'));
        assert.equal(navigation.candidates.length, 0);
        assert.equal(definition, null);
    });

    it('uses the verified sign branch and never falls through to a wrong namespace', async () => {
        const rootFile = path.resolve('definition-navigation', 'adaptive-main.k');
        const curveFile = path.resolve('definition-navigation', 'adaptive-curves.k');
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, curveFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:curves',
                    fromFile: rootFile,
                    filePath: curveFile,
                    fileName: path.basename(curveFile),
                    lineIndex: 1,
                    keyword: '*INCLUDE',
                }],
            },
            fileIndexes: new Map([
                [rootFile, { parameterEvents: [], referenceDefinitions: emptyDefinitions() }],
                [curveFile, {
                    parameterEvents: [],
                    referenceDefinitions: {
                        curves: [curveDefinition(curveFile, 17, 6)],
                        tables: [],
                        genericDefinitions: [],
                    },
                }],
            ]),
        });

        const positive = await resolveFieldReferenceNavigation(
            adaptiveBoxDocument(rootFile, 17),
            new vscodeMock.Position(2, 24),
        );
        const negative = await resolveFieldReferenceNavigation(
            adaptiveBoxDocument(rootFile, -17),
            new vscodeMock.Position(2, 24),
        );

        assert.equal(positive.state, 'resolved');
        assert.equal(positive.candidates[0].filePath, curveFile);
        assert.deepEqual(positive.source.referenceValue.targetKinds, ['curve']);
        assert.equal(negative.state, 'unindexed');
        assert.deepEqual(negative.source.referenceValue.targetKinds, ['node']);
        assert.equal(negative.candidates.length, 0);
        assert.ok(negative.reasons.includes('target-kind-on-demand'));
    });

    it('streams an official NODE block on explicit F12 and reuses only the bounded query result', async () => {
        const rootFile = path.resolve('definition-navigation', 'node-main.k');
        const nodeFile = path.resolve('definition-navigation', 'nodes.k');
        const sourceDocument = adaptiveBoxDocument(rootFile, -17);
        const nodeDocument = fakeDoc([
            '*NODE',
            '      17             0.0             0.0             0.0',
        ].join('\n'), nodeFile);
        nodeDocument.languageId = 'lsdyna';
        let nodeReads = 0;
        const originalNodeLineAt = nodeDocument.lineAt;
        nodeDocument.lineAt = line => {
            nodeReads += 1;
            return originalNodeLineAt(line);
        };
        const originalTextDocuments = vscodeMock.workspace.textDocuments;
        vscodeMock.workspace.textDocuments = [nodeDocument];
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, nodeFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:nodes',
                    fromFile: rootFile,
                    filePath: nodeFile,
                    fileName: path.basename(nodeFile),
                    lineIndex: 1,
                    keyword: '*INCLUDE',
                }],
            },
            fileIndexes: new Map([
                [rootFile, {
                    keywordBlocks: [],
                    parameterEvents: [],
                    referenceDefinitions: emptyDefinitions(),
                }],
                [nodeFile, {
                    keywordBlocks: [{
                        filePath: nodeFile,
                        keyword: '*NODE',
                        rawKeyword: '*NODE',
                        startLine: 0,
                        endLine: 1,
                    }],
                    parameterEvents: [],
                    referenceDefinitions: emptyDefinitions(),
                }],
            ]),
        });

        try {
            const navigation = await resolveFieldReferenceNavigation(
                sourceDocument,
                new vscodeMock.Position(2, 24),
            );
            assert.equal(navigation.state, 'resolved');
            assert.equal(navigation.candidates.length, 1);
            assert.equal(navigation.candidates[0].filePath, nodeFile);
            assert.equal(navigation.candidates[0].line, 1);
            assert.equal(navigation.candidates[0].startCharacter, 6);
            assert.ok(nodeReads > 0);

            nodeReads = 0;
            const definition = await new LsdynaDefinitionProvider().provideDefinition(
                sourceDocument,
                new vscodeMock.Position(2, 24),
            );
            assert.equal(definition.uri.fsPath, nodeFile);
            assert.equal(definition.range.start.line, 1);
            assert.equal(nodeReads, 0, 'warm F12 should reuse the target-only query result');
        } finally {
            vscodeMock.workspace.textDocuments = originalTextDocuments;
        }
    });

    it('cancels an active live NODE scan without caching a partial lookup', async () => {
        const rootFile = path.resolve('definition-navigation', 'cancel-live-main.k');
        const nodeFile = path.resolve('definition-navigation', 'cancel-live-nodes.k');
        const sourceDocument = adaptiveBoxDocument(rootFile, -17);
        const nodeLineCount = 8_193;
        const token = { isCancellationRequested: false };
        let cancelOnRead = true;
        let nodeReads = 0;
        const nodeDocument = {
            languageId: 'lsdyna',
            version: 1,
            isDirty: false,
            lineCount: nodeLineCount,
            uri: { fsPath: nodeFile },
            lineAt(line) {
                nodeReads += 1;
                if (cancelOnRead && line >= 1_024) token.isCancellationRequested = true;
                const text = line === 0
                    ? '*NODE'
                    : line === nodeLineCount - 1
                        ? '      17             0.0             0.0             0.0'
                        : '       1             0.0             0.0             0.0';
                return { text, range: new vscodeMock.Range(line, 0, line, text.length) };
            },
        };
        const originalTextDocuments = vscodeMock.workspace.textDocuments;
        vscodeMock.workspace.textDocuments = [nodeDocument];
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, nodeFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:cancel-live-nodes',
                    fromFile: rootFile,
                    filePath: nodeFile,
                    fileName: path.basename(nodeFile),
                    lineIndex: 1,
                    keyword: '*INCLUDE',
                }],
            },
            fileIndexes: new Map([
                [rootFile, {
                    keywordBlocks: [], parameterEvents: [], referenceDefinitions: emptyDefinitions(),
                }],
                [nodeFile, {
                    keywordBlocks: [{
                        filePath: nodeFile,
                        keyword: '*NODE',
                        startLine: 0,
                        endLine: nodeLineCount - 1,
                    }],
                    parameterEvents: [],
                    referenceDefinitions: emptyDefinitions(),
                }],
            ]),
        });

        try {
            const cancelled = await resolveFieldReferenceNavigation(
                sourceDocument,
                new vscodeMock.Position(2, 24),
                token,
            );
            assert.equal(cancelled, null);
            assert.ok(nodeReads < 1_500, `expected prompt live cancellation, got ${nodeReads} reads`);

            cancelOnRead = false;
            token.isCancellationRequested = false;
            nodeReads = 0;
            const resumed = await resolveFieldReferenceNavigation(
                sourceDocument,
                new vscodeMock.Position(2, 24),
            );
            assert.equal(resumed.state, 'resolved');
            assert.equal(resumed.candidates[0].line, nodeLineCount - 1);
            assert.ok(
                nodeReads >= nodeLineCount,
                'a cancelled partial lookup must not be reused as a cache result',
            );
        } finally {
            vscodeMock.workspace.textDocuments = originalTextDocuments;
        }
    });

    it('does not borrow stale snapshot blocks or cache scans for a dirty NODE document', async () => {
        const rootFile = path.resolve('definition-navigation', 'dirty-node-main.k');
        const nodeFile = path.resolve('definition-navigation', 'dirty-nodes.k');
        const sourceDocument = adaptiveBoxDocument(rootFile, -17);
        const nodeLines = [
            '$ inserted before the old snapshot block',
            '      17             9.0             9.0             9.0',
            '*NODE',
            '      17             0.0             0.0             0.0',
        ];
        let nodeReads = 0;
        const nodeDocument = {
            languageId: 'lsdyna',
            version: 2,
            isDirty: true,
            lineCount: nodeLines.length,
            uri: { fsPath: nodeFile },
            lineAt(line) {
                nodeReads += 1;
                const text = nodeLines[line];
                return { text, range: new vscodeMock.Range(line, 0, line, text.length) };
            },
        };
        const originalTextDocuments = vscodeMock.workspace.textDocuments;
        vscodeMock.workspace.textDocuments = [nodeDocument];
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, nodeFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:dirty-nodes',
                    fromFile: rootFile,
                    filePath: nodeFile,
                    fileName: path.basename(nodeFile),
                    lineIndex: 1,
                    keyword: '*INCLUDE',
                }],
            },
            fileIndexes: new Map([
                [rootFile, {
                    keywordBlocks: [], parameterEvents: [], referenceDefinitions: emptyDefinitions(),
                }],
                [nodeFile, {
                    keywordBlocks: [{
                        filePath: nodeFile,
                        keyword: '*NODE',
                        startLine: 0,
                        endLine: 1,
                    }],
                    parameterEvents: [],
                    referenceDefinitions: emptyDefinitions(),
                }],
            ]),
        });

        try {
            const stale = await resolveFieldReferenceNavigation(
                sourceDocument,
                new vscodeMock.Position(2, 24),
            );
            assert.equal(stale.state, 'unindexed');
            assert.equal(stale.candidates.length, 0);
            assert.ok(stale.reasons.includes('on-demand-live-structure-unavailable'));
            assert.ok(nodeReads <= nodeLines.length * 2,
                'fresh dirty-document inspection must remain bounded and must not return the stale candidate');

            rememberFileIndex(nodeFile, {
                filePath: nodeFile,
                documentVersion: 2,
                keywordBlocks: [{
                    filePath: nodeFile,
                    keyword: '*NODE',
                    rawKeyword: '*NODE',
                    startLine: 2,
                    endLine: 3,
                }],
            });
            const firstLive = await resolveFieldReferenceNavigation(
                sourceDocument,
                new vscodeMock.Position(2, 24),
            );
            assert.equal(firstLive.state, 'resolved');
            assert.equal(firstLive.candidates[0].line, 3);
            const firstReads = nodeReads;
            assert.ok(firstReads > 0);

            const secondLive = await resolveFieldReferenceNavigation(
                sourceDocument,
                new vscodeMock.Position(2, 24),
            );
            assert.equal(secondLive.state, 'resolved');
            assert.ok(nodeReads > firstReads, 'dirty live lookups must not enter the result cache');
        } finally {
            vscodeMock.workspace.textDocuments = originalTextDocuments;
        }
    });

    it('keeps signed node namespace offsets and unresolved Include transforms distinct', async () => {
        const rootFile = path.resolve('definition-navigation', 'node-offset-main.k');
        const nodeFile = path.resolve('definition-navigation', 'offset-nodes.k');
        const sourceDocument = adaptiveBoxDocument(rootFile, -117);
        const nodeDocument = fakeDoc('*NODE\n      17', nodeFile);
        nodeDocument.languageId = 'lsdyna';
        const originalTextDocuments = vscodeMock.workspace.textDocuments;
        vscodeMock.workspace.textDocuments = [nodeDocument];
        const snapshot = {
            rootFile,
            files: [rootFile, nodeFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:offset-nodes',
                    fromFile: rootFile,
                    filePath: nodeFile,
                    fileName: path.basename(nodeFile),
                    lineIndex: 1,
                    keyword: '*INCLUDE_TRANSFORM',
                    transform: {
                        offsets: {
                            idfoff: { kind: 'numeric', raw: '100', value: 100 },
                        },
                    },
                }],
            },
            fileIndexes: new Map([
                [rootFile, {
                    keywordBlocks: [], parameterEvents: [], referenceDefinitions: emptyDefinitions(),
                }],
                [nodeFile, {
                    keywordBlocks: [{
                        filePath: nodeFile,
                        keyword: '*NODE',
                        startLine: 0,
                        endLine: 1,
                    }],
                    parameterEvents: [],
                    referenceDefinitions: emptyDefinitions(),
                }],
            ]),
        };

        try {
            for (const [key, offset, expected] of [
                ['idfoff', { kind: 'numeric', raw: '100', value: 100 }, 'missing'],
                ['idnoff', { kind: 'numeric', raw: '100', value: 100 }, 'dynamic'],
                ['idnoff', { kind: 'parameter', raw: '&OFFSET', name: 'OFFSET' }, 'dynamic'],
            ]) {
                cacheReferenceIndexFromSnapshot({
                    ...snapshot,
                    graph: { includeOccurrences: [{ ...snapshot.graph.includeOccurrences[0],
                        transform: { offsets: { [key]: offset } } }] },
                });
                const navigation = await resolveFieldReferenceNavigation(
                    sourceDocument,
                    new vscodeMock.Position(2, 24),
                );
                assert.equal(navigation.state, expected, JSON.stringify({ key, offset, navigation }));
                if (expected === 'missing') {
                    assert.equal(navigation.candidates.length, 0);
                } else if (offset.kind === 'numeric') {
                    assert.equal(navigation.candidateCertainty, 'known-candidate');
                    assert.equal(navigation.candidates.length, 1);
                    assert.ok(navigation.reasons.includes('signed-switch-transform-unverified'));
                } else {
                    assert.equal(navigation.candidates.length, 0);
                    assert.ok(navigation.reasons.includes('transform-offset-unresolved'));
                }
            }
        } finally {
            vscodeMock.workspace.textDocuments = originalTextDocuments;
        }
    });

    it('fails open for comma, long-format, and expression field sources', () => {
        const filePath = path.resolve('definition-navigation', 'unsafe.k');
        const comma = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '1,7.8,210.0,0.3,400.0,0.0',
            '0.0,0.0,1001,0,0.0',
        ].join('\n'), filePath);
        const long = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY+',
            '                   1',
            '                                       1001',
        ].join('\n'), filePath);
        const expression = materialReferenceDocument(filePath, '&CID+1');

        assert.equal(fieldReferenceAtPosition(comma, new vscodeMock.Position(2, 12)), null);
        assert.equal(fieldReferenceAtPosition(long, new vscodeMock.Position(2, 24)), null);
        assert.equal(fieldReferenceAtPosition(expression, new vscodeMock.Position(2, 28)), null);
    });

    it('keeps reference semantics invariant under mismatched comment labels', () => {
        const filePath = path.resolve('definition-navigation', 'comment-version.k');
        const labels = ['MID', 'RO', 'E', 'PR', 'SIGY', 'OLDREF', 'OLDDS'];
        const header = '$#' + labels.map((label, index) => label.padStart(index === 0 ? 8 : 10)).join('');
        const data = ['1', '7.8', '210', '0.3', '400', '1001', '1002']
            .map(value => value.padStart(10)).join('');
        const current = fakeDoc(['*MAT_DAMAGE_1', data].join('\n'), filePath);
        const possibleLegacy = fakeDoc(['*MAT_DAMAGE_1', header, data].join('\n'), filePath);
        current.languageId = 'lsdyna';
        possibleLegacy.languageId = 'lsdyna';

        assert.ok(fieldReferenceAtPosition(current, new vscodeMock.Position(1, 55)));
        const annotated = fieldReferenceAtPosition(possibleLegacy, new vscodeMock.Position(2, 55));
        const original = fieldReferenceAtPosition(current, new vscodeMock.Position(1, 55));
        assert.deepStrictEqual(annotated.referenceInfo, original.referenceInfo);
        assert.deepStrictEqual(annotated.referenceValue, original.referenceValue);
    });

    it('honors LONG=K/S and a keyword-level standard override for field geometry', () => {
        const filePath = path.resolve('definition-navigation', 'input-format-modes.k');
        const cardOne = [1, 0, 0, 0, 0, 0, 0].map(item => String(item).padStart(10)).join('');
        const cardTwo = [0, 1, -17, 0, 0, 0, 0].map(item => String(item).padStart(10)).join('');
        const makeDocument = (header, keyword) => {
            const doc = fakeDoc([header, keyword, cardOne, cardTwo].join('\n'), filePath);
            doc.languageId = 'lsdyna';
            return doc;
        };
        const longDeck = makeDocument('*KEYWORD LONG=K', '*DEFINE_BOX_ADAPTIVE');
        const standardOverride = makeDocument('*KEYWORD LONG=K', '*DEFINE_BOX_ADAPTIVE-');
        const standardDeck = makeDocument('*KEYWORD LONG=S', '*DEFINE_BOX_ADAPTIVE');
        const i10Deck = makeDocument('*KEYWORD I10=Y', '*DEFINE_BOX_ADAPTIVE');
        const position = new vscodeMock.Position(3, 24);

        assert.equal(fieldReferenceAtPosition(longDeck, position), null);
        assert.equal(fieldReferenceAtPosition(i10Deck, position), null);
        assert.deepEqual(
            fieldReferenceAtPosition(standardOverride, position).referenceValue.targetKinds,
            ['node'],
        );
        assert.deepEqual(
            fieldReferenceAtPosition(standardDeck, position).referenceValue.targetKinds,
            ['node'],
        );
        assert.ok(getCardFieldsForLine(standardOverride, 3));
        assert.ok(getCardFieldsForLine(standardDeck, 3));
    });

    it('honors cancellation before any field-navigation scan', async () => {
        const filePath = path.resolve('definition-navigation', 'cancelled.k');
        const doc = materialReferenceDocument(filePath);
        let reads = 0;
        const originalLineAt = doc.lineAt;
        doc.lineAt = line => {
            reads += 1;
            return originalLineAt(line);
        };
        const result = await new LsdynaDefinitionProvider().provideDefinition(
            doc,
            new vscodeMock.Position(2, 24),
            { isCancellationRequested: true },
        );

        assert.equal(result, null);
        assert.equal(reads, 0);
    });

    it('keeps warm F12 lookup near a million-line tail bounded by the structural index', async () => {
        const rootFile = path.resolve('definition-navigation', 'million-line-main.k');
        const lineCount = 1_000_000;
        const keywordLine = lineCount - 3;
        const cardOne = '         1       7.8     210.0       0.3     400.0       0.0';
        const cardTwo = [0, 0, 1001, 0, 0].map(item => String(item).padStart(10)).join('');
        let reads = 0;
        const document = {
            languageId: 'lsdyna',
            version: 1,
            lineCount,
            uri: { fsPath: rootFile },
            lineAt(line) {
                reads += 1;
                let text = '';
                if (line === 0) text = '*KEYWORD';
                else if (line === keywordLine) text = '*MAT_PIECEWISE_LINEAR_PLASTICITY';
                else if (line === keywordLine + 1) text = cardOne;
                else if (line === keywordLine + 2) text = cardTwo;
                return { text, range: new vscodeMock.Range(line, 0, line, text.length) };
            },
        };
        rememberFileIndex(rootFile, {
            filePath: rootFile,
            documentVersion: 1,
            keywordBlocks: [{
                filePath: rootFile,
                keyword: '*MAT_PIECEWISE_LINEAR_PLASTICITY',
                startLine: keywordLine,
                endLine: lineCount - 1,
            }],
        });
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[
                rootFile,
                {
                    parameterEvents: [],
                    referenceDefinitions: {
                        curves: [curveDefinition(rootFile, 1001, 100)],
                        tables: [],
                        genericDefinitions: [],
                    },
                },
            ]]),
        });

        const provider = new LsdynaDefinitionProvider();
        const position = new vscodeMock.Position(lineCount - 1, 24);
        for (let index = 0; index < 10; index++) {
            await provider.provideDefinition(document, position);
        }

        reads = 0;
        const samples = [];
        for (let index = 0; index < 200; index++) {
            const started = performance.now();
            const definition = await provider.provideDefinition(document, position);
            samples.push(performance.now() - started);
            assert.ok(definition);
            assert.equal(definition.range.start.line, 100);
        }
        samples.sort((left, right) => left - right);
        const p95 = samples[Math.floor(samples.length * 0.95)];
        if (process.env.LSDYNA_BENCHMARK_LOG === '1') {
            const p50 = samples[Math.floor(samples.length * 0.50)];
            const p99 = samples[Math.floor(samples.length * 0.99)];
            console.log(
                `    warm F12: P50 ${p50.toFixed(3)} ms, ` +
                `P95 ${p95.toFixed(3)} ms, P99 ${p99.toFixed(3)} ms, ` +
                `${(reads / samples.length).toFixed(1)} lineAt/call`,
            );
        }

        assert.ok(reads < 8_000, `expected bounded line reads, got ${reads}`);
        // Release budget: retain the independent line-read bound above, and measure
        // wall time against the agreed 100 ms interaction limit on the host machine.
        if (process.env.LSDYNA_CI_FUNCTIONAL_ONLY !== '1') assert.ok(p95 <= 100, `expected warm F12 P95 <=100 ms, got ${p95.toFixed(3)} ms`);
    });

    it('streams a million-row NODE block once, yields, and keeps warm queries O(1)', async function () {
        this.timeout(20000); // Million-row correctness fixture; explicit warm-query and yielding assertions remain below.
        const rootFile = path.resolve('definition-navigation', 'million-node-main.k');
        const nodeFile = path.resolve('definition-navigation', 'million-nodes.k');
        const sourceDocument = adaptiveBoxDocument(rootFile, -17);
        const nodeLineCount = 1_000_001;
        let nodeReads = 0;
        const nodeDocument = {
            languageId: 'lsdyna',
            version: 1,
            isDirty: false,
            lineCount: nodeLineCount,
            uri: { fsPath: nodeFile },
            lineAt(line) {
                nodeReads += 1;
                const text = line === 0
                    ? '*NODE'
                    : line === nodeLineCount - 1
                        ? '      17             0.0             0.0             0.0'
                        : '       1             0.0             0.0             0.0';
                return { text, range: new vscodeMock.Range(line, 0, line, text.length) };
            },
        };
        const originalTextDocuments = vscodeMock.workspace.textDocuments;
        vscodeMock.workspace.textDocuments = [nodeDocument];
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, nodeFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:million-nodes',
                    fromFile: rootFile,
                    filePath: nodeFile,
                    fileName: path.basename(nodeFile),
                    lineIndex: 1,
                    keyword: '*INCLUDE',
                }],
            },
            fileIndexes: new Map([
                [rootFile, {
                    keywordBlocks: [], parameterEvents: [], referenceDefinitions: emptyDefinitions(),
                }],
                [nodeFile, {
                    keywordBlocks: [{
                        filePath: nodeFile,
                        keyword: '*NODE',
                        startLine: 0,
                        endLine: nodeLineCount - 1,
                    }],
                    parameterEvents: [],
                    referenceDefinitions: emptyDefinitions(),
                }],
            ]),
        });

        let yieldProbe;
        try {
            let eventLoopYielded = false;
            yieldProbe = new Promise(resolve => setImmediate(() => {
                eventLoopYielded = true;
                resolve();
            }));
            const coldStarted = performance.now();
            const navigation = await resolveFieldReferenceNavigation(
                sourceDocument,
                new vscodeMock.Position(2, 24),
            );
            const coldDuration = performance.now() - coldStarted;
            assert.equal(navigation.state, 'resolved');
            assert.equal(navigation.candidates[0].line, nodeLineCount - 1);
            assert.equal(eventLoopYielded, true, 'Cold NODE scan must yield before it completes');
            assert.ok(nodeReads >= nodeLineCount, `expected one streaming pass, got ${nodeReads} reads`);

            nodeReads = 0;
            const samples = [];
            for (let index = 0; index < 100; index++) {
                const started = performance.now();
                const warm = await resolveFieldReferenceNavigation(
                    sourceDocument,
                    new vscodeMock.Position(2, 24),
                );
                samples.push(performance.now() - started);
                assert.equal(warm.state, 'resolved');
            }
            samples.sort((left, right) => left - right);
            const p95 = samples[Math.floor(samples.length * 0.95)];
            if (process.env.LSDYNA_BENCHMARK_LOG === '1') {
                console.log(
                    `    million NODE F12: cold ${coldDuration.toFixed(1)} ms, ` +
                    `warm P95 ${p95.toFixed(3)} ms`,
                );
            }
            assert.equal(nodeReads, 0, 'warm target-only cache must not rescan NODE rows');
            if (process.env.LSDYNA_CI_FUNCTIONAL_ONLY !== '1') assert.ok(p95 <= 100, `expected warm node F12 P95 <=100 ms, got ${p95.toFixed(3)} ms`);
        } finally {
            vscodeMock.workspace.textDocuments = originalTextDocuments;
            await yieldProbe;
        }
    });

    it('does not implicitly scan an unindexed million-line document on F12', async () => {
        const filePath = path.resolve('definition-navigation', 'unindexed-million-line.k');
        const lineCount = 1_000_000;
        const keywordLine = lineCount - 3;
        const cardOne = '         1       7.8     210.0       0.3     400.0       0.0';
        const cardTwo = [0, 0, 1001, 0, 0].map(item => String(item).padStart(10)).join('');
        let reads = 0;
        const document = {
            languageId: 'lsdyna',
            version: 1,
            lineCount,
            uri: { fsPath: filePath },
            lineAt(line) {
                reads += 1;
                let text = '';
                if (line === 0) text = '*KEYWORD';
                else if (line === keywordLine) text = '*MAT_PIECEWISE_LINEAR_PLASTICITY';
                else if (line === keywordLine + 1) text = cardOne;
                else if (line === keywordLine + 2) text = cardTwo;
                return { text, range: new vscodeMock.Range(line, 0, line, text.length) };
            },
        };

        const navigation = await resolveFieldReferenceNavigation(
            document,
            new vscodeMock.Position(lineCount - 1, 24),
        );

        assert.equal(navigation.state, 'unindexed');
        assert.equal(navigation.candidates.length, 0);
        assert.ok(reads < 40, `expected no implicit whole-file scan, got ${reads} reads`);
    });

    it('builds a complete native reverse-reference result from a Registry source', async () => {
        const rootFile = path.resolve('definition-navigation', 'references-main.k');
        const partFile = path.resolve('definition-navigation', 'references-parts.k');
        const sourceDocument = constrainedPartReferenceDocument(rootFile);
        const targetDocument = fakeDoc([
            '*PART',
            'Registry reverse-reference target',
            [42, 0, 0, 0, 0, 0, 0, 0].map(value => String(value).padStart(10)).join(''),
        ].join('\n'), partFile);
        targetDocument.languageId = 'lsdyna';
        const source = fieldReferenceAtPosition(
            sourceDocument,
            new vscodeMock.Position(1, 2),
            { semanticScope: 'registry-approved' },
        );
        const referenceOccurrence = {
            filePath: rootFile,
            keyword: '*CONSTRAINED_NODAL_RIGID_BODY',
            cardIndex: 1,
            fieldName: 'PID',
            lineIndex: 1,
            startCharacter: 8,
            endCharacter: 10,
            rawValue: '42',
            authoringRelationId: source.referenceInfo.definitionRegistry.authoringRelationId,
            coordinateId: source.referenceInfo.definitionRegistry.coordinateId,
            sourceRuleId: source.referenceInfo.ruleId,
            referenceValue: source.referenceValue,
            targetKinds: source.referenceValue.targetKinds,
            targetDefinitions: source.referenceValue.targetDefinitions,
        };
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, partFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:parts', fromFile: rootFile, filePath: partFile,
                    fileName: path.basename(partFile), lineIndex: 2, keyword: '*INCLUDE',
                }],
            },
            fileIndexes: new Map([
                [rootFile, {
                    parameterEvents: [], referenceDefinitions: emptyDefinitions(),
                    registryReferences: {
                        complete: true, reasons: [], referenceOccurrences: [referenceOccurrence],
                        valueDomainOccurrences: [],
                    },
                }],
                [partFile, {
                    parameterEvents: [],
                    referenceDefinitions: {
                        curves: [], tables: [], genericDefinitions: [partDefinition(partFile)],
                    },
                    registryReferences: {
                        complete: true, reasons: [], referenceOccurrences: [], valueDomainOccurrences: [],
                    },
                }],
            ]),
        });

        const fromReference = await resolveRegistryReferenceNetwork(
            sourceDocument,
            new vscodeMock.Position(1, 2),
            { includeDeclaration: true },
            null,
            { allowWhenPermissionDisabled: true },
        );
        const fromDefinition = await resolveRegistryReferenceNetwork(
            targetDocument,
            new vscodeMock.Position(2, 9),
            { includeDeclaration: false },
            null,
            { allowWhenPermissionDisabled: true },
        );

        assert.equal(fromReference.state, 'complete');
        assert.deepEqual(
            fromReference.locations.map(location => [location.filePath, location.line, location.declaration === true]),
            [[rootFile, 1, false], [partFile, 2, true]],
        );
        assert.equal(fromDefinition.state, 'complete');
        assert.deepEqual(fromDefinition.locations.map(location => [location.filePath, location.line]), [[rootFile, 1]]);
        const nativeLocations = await new LsdynaReferenceProvider().provideReferences(
            sourceDocument,
            new vscodeMock.Position(1, 2),
            { includeDeclaration: true },
        );
        assert.deepEqual(
            nativeLocations.map(location => [location.uri.fsPath, location.range.start.line]),
            [[rootFile, 1], [partFile, 2]],
        );
        const nativeFromDefinition = await new LsdynaReferenceProvider().provideReferences(
            targetDocument,
            new vscodeMock.Position(2, 9),
            { includeDeclaration: false },
        );
        assert.deepEqual(
            nativeFromDefinition.map(location => [location.uri.fsPath, location.range.start.line]),
            [[rootFile, 1]],
        );
    });

    it('provides approved F12 and Shift+F12 for a proved family definition', async () => {
        const rootFile = path.resolve('definition-navigation', 'family-material.k');
        const partRow = [1, 0, 1000001, 0, 0, 0, 0, 0]
            .map(value => String(value).padStart(10)).join('');
        const materialRow = [1000001, 0, 0, 0, 0, 0, 0, 0]
            .map(value => String(value).padStart(10)).join('');
        const document = fakeDoc([
            '*PART',
            'family reference',
            partRow,
            '*MAT_024',
            materialRow,
        ].join('\n'), rootFile);
        document.languageId = 'lsdyna';
        const source = fieldReferenceAtPosition(
            document,
            new vscodeMock.Position(2, 25),
            { semanticScope: 'registry-approved' },
        );
        assert.equal(source?.referenceInfo?.source, "keyword-catalog");
        assert.deepEqual(source.referenceValue.targetKinds, ['material', 'ispg']);
        const referenceOccurrence = {
            filePath: rootFile,
            keyword: '*PART',
            cardIndex: 1,
            fieldName: 'MID',
            lineIndex: 2,
            startCharacter: 23,
            endCharacter: 30,
            rawValue: '1000001',
            authoringRelationId: source.referenceInfo.definitionRegistry.authoringRelationId,
            coordinateId: source.referenceInfo.definitionRegistry.coordinateId,
            sourceRuleId: source.referenceInfo.ruleId,
            referenceValue: source.referenceValue,
            targetKinds: source.referenceValue.targetKinds,
            targetDefinitions: source.referenceValue.targetDefinitions,
        };
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[rootFile, {
                keywordBlocks: [
                    { filePath: rootFile, keyword: '*PART', rawKeyword: '*PART', startLine: 0, endLine: 2 },
                    { filePath: rootFile, keyword: '*MAT_024', rawKeyword: '*MAT_024', startLine: 3, endLine: 4 },
                ],
                parameterEvents: [],
                referenceDefinitions: {
                    ...emptyDefinitions(),
                    genericDefinitions: [{
                        kind: 'generic', id: 1000001, idRaw: '1000001',
                        keyword: '*MAT_024', targetKeyword: 'MAT_024', targetKind: 'material',
                        filePath: rootFile, startLine: 3, endLine: 4,
                        idLine: 4, idStartChar: 3, idEndChar: 10,
                    }],
                },
                registryReferences: {
                    complete: true,
                    reasons: [],
                    referenceOccurrences: [referenceOccurrence],
                    valueDomainOccurrences: [],
                },
            }]]),
        });
        const originalDocuments = vscodeMock.workspace.textDocuments;
        vscodeMock.workspace.textDocuments = [document];
        try {
            const forward = await resolveFieldReferenceNavigation(
                document,
                new vscodeMock.Position(2, 25),
                null,
                { semanticScope: 'registry-approved', allowFamilyCandidate: true },
            );
            assert.equal(forward.state, 'resolved', JSON.stringify(forward.reasons));
            assert.deepEqual(
                forward.candidates.map(candidate => [candidate.line, candidate.startCharacter]),
                [[4, 3]],
            );

            const reverse = await resolveRegistryReferenceNetwork(
                document,
                new vscodeMock.Position(4, 5),
                { includeDeclaration: true },
                null,
                { allowWhenPermissionDisabled: true },
            );
            assert.equal(reverse.state, 'complete', JSON.stringify(reverse.reasons));
            assert.deepEqual(
                reverse.locations.map(location => [location.line, location.declaration === true]),
                [[2, false], [4, true]],
            );

            const nativeDefinition = await new LsdynaDefinitionProvider().provideDefinition(
                document,
                new vscodeMock.Position(2, 25),
            );
            assert.deepEqual(
                [nativeDefinition.uri.fsPath, nativeDefinition.range.start.line,
                    nativeDefinition.range.start.character],
                [rootFile, 4, 3],
            );
        } finally {
            vscodeMock.workspace.textDocuments = originalDocuments;
        }
    });

    it('overlays dirty reference data but fails closed for incomplete or dirty-Include snapshots', async () => {
        const rootFile = path.resolve('definition-navigation', 'references-dirty.k');
        const sourceDocument = constrainedPartReferenceDocument(rootFile);
        const source = fieldReferenceAtPosition(
            sourceDocument,
            new vscodeMock.Position(1, 2),
            { semanticScope: 'registry-approved' },
        );
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[rootFile, {
                parameterEvents: [], referenceDefinitions: emptyDefinitions(),
                registryReferences: {
                    complete: false,
                    reasons: ['registry-reference-preview-byte-limit'],
                    referenceOccurrences: [], valueDomainOccurrences: [],
                },
            }]]),
        });

        const incomplete = await resolveRegistryReferenceNetwork(
            sourceDocument,
            new vscodeMock.Position(1, 2),
            {},
            null,
            { allowWhenPermissionDisabled: true },
        );
        assert.equal(incomplete.state, 'incomplete');
        assert.ok(incomplete.reasons.some(reason => reason.includes('registry-reference-preview-byte-limit')));

        clearReferenceIndexCacheForTesting();
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[rootFile, {
                parameterEvents: [], referenceDefinitions: emptyDefinitions(),
                registryReferences: {
                    complete: true, reasons: [],
                    referenceOccurrences: [{
                        filePath: rootFile, lineIndex: 1, startCharacter: 8, endCharacter: 10,
                        referenceValue: { ...source.referenceValue, id: 99 },
                        targetKinds: source.referenceValue.targetKinds,
                        targetDefinitions: source.referenceValue.targetDefinitions,
                    }],
                    valueDomainOccurrences: [],
                },
            }]]),
        });
        const originalDocuments = vscodeMock.workspace.textDocuments;
        sourceDocument.isDirty = true;
        vscodeMock.workspace.textDocuments = [sourceDocument];
        try {
            sourceDocument.isDirty = false;
            const cached = await resolveRegistryReferenceNetwork(
                sourceDocument, new vscodeMock.Position(1, 2), {}, null, { allowWhenPermissionDisabled: true },
            );
            assert.equal(cached.state, 'complete', JSON.stringify(cached.reasons));
            assert.deepEqual(cached.locations, []);
            sourceDocument.isDirty = true;
            const dirty = await resolveRegistryReferenceNetwork(
                sourceDocument,
                new vscodeMock.Position(1, 2),
                {},
                null,
                { allowWhenPermissionDisabled: true },
            );
            assert.equal(dirty.state, 'complete', JSON.stringify(dirty.reasons));
            assert.equal(dirty.referenceIndexState.liveReferenceOverlay, true);
            assert.deepEqual(dirty.locations, [{
                filePath: rootFile, line: 1, startCharacter: 8, endCharacter: 10, id: 42,
                authoringRelationId: source.referenceInfo.definitionRegistry.authoringRelationId,
                coordinateId: source.referenceInfo.definitionRegistry.coordinateId,
                sourceRuleId: source.referenceInfo.ruleId,
            }]);
        } finally {
            vscodeMock.workspace.textDocuments = originalDocuments;
        }

        clearReferenceIndexCacheForTesting();
        const dirtyInclude = fakeDoc([
            '*CONSTRAINED_NODAL_RIGID_BODY',
            [42, 0, 0, 0, 0, 0, 0].map(item => String(item).padStart(10)).join(''),
            '*INCLUDE',
            'parts.k',
        ].join('\n'), rootFile);
        dirtyInclude.languageId = 'lsdyna';
        dirtyInclude.isDirty = true;
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[rootFile, {
                keywordBlocks: [], parameterEvents: [], referenceDefinitions: emptyDefinitions(),
                registryReferences: {
                    complete: true, reasons: [], referenceOccurrences: [], valueDomainOccurrences: [],
                },
            }]]),
        });
        const originalDocumentsForInclude = vscodeMock.workspace.textDocuments;
        vscodeMock.workspace.textDocuments = [dirtyInclude];
        try {
            const changedGraph = await resolveRegistryReferenceNetwork(
                dirtyInclude,
                new vscodeMock.Position(1, 2),
                {},
                null,
                { allowWhenPermissionDisabled: true },
            );
            assert.equal(changedGraph.state, 'incomplete');
            assert.ok(changedGraph.reasons.some(reason => reason.includes('dirty-include-graph-unverified')));
            assert.deepEqual(changedGraph.locations, []);
        } finally {
            vscodeMock.workspace.textDocuments = originalDocumentsForInclude;
        }
    });

    it('returns signed Registry field references natively and excludes enum branches', async () => {
        const rootFile = path.resolve('definition-navigation', 'references-signed.k');
        const sourceDocument = partAdpoptReferenceDocument(rootFile, -17);
        const source = fieldReferenceAtPosition(
            sourceDocument,
            new vscodeMock.Position(2, 65),
            { semanticScope: 'registry-approved' },
        );
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[rootFile, {
                parameterEvents: [],
                referenceDefinitions: {
                    curves: [curveDefinition(rootFile, 17, 9)], tables: [], genericDefinitions: [],
                },
                registryReferences: {
                    complete: true,
                    reasons: [],
                    referenceOccurrences: [{
                        filePath: rootFile,
                        keyword: '*PART',
                        cardIndex: 2,
                        fieldName: 'ADPOPT',
                        lineIndex: 2,
                        startCharacter: 67,
                        endCharacter: 70,
                        rawValue: '-17',
                        authoringRelationId: source.referenceInfo.definitionRegistry.authoringRelationId,
                        coordinateId: source.referenceInfo.definitionRegistry.coordinateId,
                        sourceRuleId: source.referenceInfo.ruleId,
                        referenceValue: source.referenceValue,
                        targetKinds: source.referenceValue.targetKinds,
                        targetDefinitions: source.referenceValue.targetDefinitions,
                    }],
                    valueDomainOccurrences: [],
                },
            }]]),
        });

        const provider = new LsdynaReferenceProvider();
        const references = await provider.provideReferences(
            sourceDocument,
            new vscodeMock.Position(2, 65),
            { includeDeclaration: false },
        );
        const withDeclaration = await provider.provideReferences(
            sourceDocument,
            new vscodeMock.Position(2, 65),
            { includeDeclaration: true },
        );
        assert.deepEqual(references.map(location => location.range.start.line), [2]);
        assert.deepEqual(withDeclaration.map(location => location.range.start.line), [2, 9]);

        const enumDocument = partAdpoptReferenceDocument(rootFile, 2);
        assert.deepEqual(await provider.provideReferences(
            enumDocument,
            new vscodeMock.Position(2, 65),
            { includeDeclaration: true },
        ), []);
    });
});

describe('manual workspace reference text search', () => {
    function materialReferenceDocument(filePath, value = '1001') {
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '         1       7.8     210.0       0.3     400.0       0.0',
            [0, 0, value, 0, 0].map(item => String(item).padStart(10)).join(''),
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';
        doc.version = 7;
        return doc;
    }

    const emptyFileIndex = () => ({
        keywordBlocks: [],
        parameterEvents: [],
        referenceDefinitions: { curves: [], tables: [], genericDefinitions: [] },
    });

    let originalExecuteCommand;
    let originalGetConfiguration;
    let originalStatusMessage;

    beforeEach(() => {
        originalExecuteCommand = vscodeMock.commands.executeCommand;
        originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        originalStatusMessage = vscodeMock.window.setStatusBarMessage;
    });

    afterEach(() => {
        vscodeMock.commands.executeCommand = originalExecuteCommand;
        vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        vscodeMock.window.setStatusBarMessage = originalStatusMessage;
        vscodeMock.window.activeTextEditor = null;
        clearReferenceIndexCacheForTesting();
    });

    it('re-parses the active field and ignores a forged command ID', async () => {
        const filePath = path.resolve('workspace-search', 'main.k');
        const document = materialReferenceDocument(filePath);
        vscodeMock.window.activeTextEditor = {
            document,
            selection: { active: new vscodeMock.Position(2, 24) },
        };
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'additionalExtensions'
                ? ['dat', '.incl', '.K', '*.unsafe']
                : defaultValue,
        });
        const calls = [];
        const statuses = [];
        vscodeMock.commands.executeCommand = async (command, args) => {
            calls.push({ command, args });
        };
        vscodeMock.window.setStatusBarMessage = (message, timeout) => {
            statuses.push({ message, timeout });
            return { dispose() {} };
        };

        const result = await handleWorkspaceReferenceSearchCommand({
            filePath,
            lineIndex: 2,
            character: 20,
            documentVersion: 7,
            id: 9999,
            targetKinds: ['material'],
        });

        assert.equal(result.id, 1001);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].command, 'workbench.action.findInFiles');
        assert.deepEqual(calls[0].args, {
            query: '1001',
            triggerSearch: true,
            isRegex: false,
            isCaseSensitive: false,
            matchWholeWord: true,
            filesToInclude: '**/*.dat,**/*.incl,**/*.k',
        });
        assert.equal(Object.hasOwn(calls[0].args, 'filesToExclude'), false);
        assert.equal(Object.hasOwn(calls[0].args, 'useExcludeSettingsAndIgnoreFiles'), false);
        assert.ok(statuses[0].message.includes('text'));
    });

    it('uses the cached Include occurrence to search the effective ID after IDFOFF', async () => {
        const rootFile = path.resolve('workspace-search', 'root.k');
        const sourceFile = path.resolve('workspace-search', 'included-material.k');
        const document = materialReferenceDocument(sourceFile, '1001');
        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, sourceFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:source',
                    fromFile: rootFile,
                    filePath: sourceFile,
                    fileName: path.basename(sourceFile),
                    lineIndex: 1,
                    keyword: '*INCLUDE_TRANSFORM',
                    transform: {
                        offsets: {
                            idfoff: { kind: 'numeric', raw: '100', value: 100 },
                        },
                    },
                }],
            },
            fileIndexes: new Map([
                [rootFile, emptyFileIndex()],
                [sourceFile, emptyFileIndex()],
            ]),
        });
        vscodeMock.window.activeTextEditor = {
            document,
            selection: { active: new vscodeMock.Position(2, 24) },
        };
        const calls = [];
        vscodeMock.commands.executeCommand = async (command, args) => calls.push({ command, args });

        const resolved = resolveWorkspaceReferenceSearch(
            document,
            new vscodeMock.Position(2, 24)
        );
        const result = await handleWorkspaceReferenceSearchCommand({
            filePath: sourceFile,
            lineIndex: 2,
            character: 20,
            documentVersion: 7,
            projectRootFile: rootFile,
        });

        assert.equal(resolved.id, 1101);
        assert.equal(resolved.analysis.transformResolution.offset, 100);
        assert.equal(result.id, 1101);
        assert.equal(calls[0].args.query, '1101');

        const staleContext = await handleWorkspaceReferenceSearchCommand({
            filePath: sourceFile,
            lineIndex: 2,
            character: 20,
            documentVersion: 7,
            projectRootFile: path.resolve('workspace-search', 'other-root.k'),
        });
        assert.equal(staleContext, null);
        assert.equal(calls.length, 1);
    });

    it('fails open when the hover source is stale or the parameter remains dynamic', async () => {
        const filePath = path.resolve('workspace-search', 'stale.k');
        const document = materialReferenceDocument(filePath);
        vscodeMock.window.activeTextEditor = {
            document,
            selection: { active: new vscodeMock.Position(2, 24) },
        };
        let executeCount = 0;
        const statuses = [];
        vscodeMock.commands.executeCommand = async () => { executeCount += 1; };
        vscodeMock.window.setStatusBarMessage = message => {
            statuses.push(message);
            return { dispose() {} };
        };

        assert.equal(workspaceReferenceSearchPosition(vscodeMock.window.activeTextEditor, {
            filePath,
            lineIndex: 2,
            character: 20,
            documentVersion: 6,
        }), null);
        assert.equal(await handleWorkspaceReferenceSearchCommand({
            filePath,
            lineIndex: 2,
            character: 20,
            documentVersion: 6,
        }), null);

        const parameterDocument = materialReferenceDocument(filePath, '&CID');
        vscodeMock.window.activeTextEditor = {
            document: parameterDocument,
            selection: { active: new vscodeMock.Position(2, 24) },
        };
        assert.equal(await handleWorkspaceReferenceSearchCommand(), null);
        assert.equal(executeCount, 0);
        assert.equal(statuses.length, 2);
    });

    it('uses the current file value when main-deck context is ambiguous', async () => {
        const rootA = path.resolve('workspace-search', 'root-a.k');
        const rootB = path.resolve('workspace-search', 'root-b.k');
        const sourceFile = path.resolve('workspace-search', 'shared.k');
        const document = materialReferenceDocument(sourceFile);
        for (const [rootFile, offset] of [[rootA, 100], [rootB, 200]]) {
            cacheReferenceIndexFromSnapshot({
                rootFile,
                files: [rootFile, sourceFile],
                graph: {
                    includeOccurrences: [{
                        occurrenceId: `${rootFile}:source`,
                        fromFile: rootFile,
                        filePath: sourceFile,
                        fileName: path.basename(sourceFile),
                        lineIndex: 1,
                        keyword: '*INCLUDE_TRANSFORM',
                        transform: {
                            offsets: {
                                idfoff: { kind: 'numeric', raw: String(offset), value: offset },
                            },
                        },
                    }],
                },
                fileIndexes: new Map([
                    [rootFile, emptyFileIndex()],
                    [sourceFile, emptyFileIndex()],
                ]),
            });
        }
        vscodeMock.window.activeTextEditor = {
            document,
            selection: { active: new vscodeMock.Position(2, 24) },
        };
        let executeCount = 0;
        vscodeMock.commands.executeCommand = async () => { executeCount += 1; };

        const resolved = resolveWorkspaceReferenceSearch(
            document,
            new vscodeMock.Position(2, 24)
        );
        const result = await handleWorkspaceReferenceSearchCommand();

        assert.notEqual(resolved?.unavailableReason, 'project-root-ambiguous');
        assert.equal(result.id, 1001);
        assert.equal(executeCount, 1);
    });

    it('keeps search planning bounded near the tail of an unindexed million-line deck', async () => {
        const filePath = path.resolve('workspace-search', 'million-line.k');
        const lineCount = 1_000_000;
        const keywordLine = lineCount - 3;
        const cardOne = '         1       7.8     210.0       0.3     400.0       0.0';
        const cardTwo = [0, 0, 1001, 0, 0].map(item => String(item).padStart(10)).join('');
        let reads = 0;
        const document = {
            languageId: 'lsdyna',
            version: 1,
            isDirty: false,
            lineCount,
            uri: { fsPath: filePath },
            lineAt(line) {
                reads += 1;
                let text = '';
                if (line === 0) text = '*KEYWORD';
                else if (line === keywordLine) text = '*MAT_PIECEWISE_LINEAR_PLASTICITY';
                else if (line === keywordLine + 1) text = cardOne;
                else if (line === keywordLine + 2) text = cardTwo;
                return { text, range: new vscodeMock.Range(line, 0, line, text.length) };
            },
        };
        vscodeMock.window.activeTextEditor = {
            document,
            selection: { active: new vscodeMock.Position(lineCount - 1, 24) },
        };
        let searchCount = 0;
        vscodeMock.commands.executeCommand = async (command, args) => {
            assert.equal(command, 'workbench.action.findInFiles');
            assert.equal(args.query, '1001');
            searchCount += 1;
        };

        const samples = [];
        for (let index = 0; index < 100; index++) {
            const started = performance.now();
            const result = await handleWorkspaceReferenceSearchCommand();
            samples.push(performance.now() - started);
            assert.equal(result.id, 1001);
        }
        samples.sort((left, right) => left - right);
        const p95 = samples[Math.floor(samples.length * 0.95)];
        if (process.env.LSDYNA_BENCHMARK_LOG === '1') {
            const p50 = samples[Math.floor(samples.length * 0.50)];
            const p99 = samples[Math.floor(samples.length * 0.99)];
            console.log(
                `    workspace text search planning: P50 ${p50.toFixed(3)} ms, ` +
                `P95 ${p95.toFixed(3)} ms, P99 ${p99.toFixed(3)} ms, ` +
                `${(reads / samples.length).toFixed(1)} lineAt/call`,
            );
        }

        assert.equal(searchCount, 100);
        assert.ok(reads < 4_000, `expected bounded source reads, got ${reads}`);
        if (process.env.LSDYNA_CI_FUNCTIONAL_ONLY !== '1') assert.ok(p95 < 5, `expected workspace search planning P95 <5 ms, got ${p95.toFixed(3)} ms`);
    });
});

describe('indexed entity ID query command', () => {
    it('keeps the query command and replaces its menu with the large-file entry', () => {
        const manifest = require('../../package.json');
        assert.ok(manifest.contributes.commands.some(item => item.command === 'extension.queryLsdynaEntityId'));
        assert.ok(!manifest.contributes.menus['editor/context'].some(item => item.command === 'extension.queryLsdynaEntityId'));
        for (const menu of ['editor/context', 'explorer/context']) {
            const item = manifest.contributes.menus[menu].find(item => item.command === 'extension.openLsdynaLargeFileViewer');
            assert.ok(item);
            for (const ext of ['.k', '.key', '.dyna']) assert.ok(item.when.includes('resourceExtname == ' + ext));
        }
    });

    it('contributes the object-reference webview and preserves its command IDs', () => {
        const manifest = require("../../package.json");
        const views = manifest.contributes.views['lsdyna-includes'];
        assert.equal(views.find(view => view.id === 'lsdynaEntityReferences').type, 'webview');
        const commands = new Set(manifest.contributes.commands.map(command => command.command));
        for (const command of [
            'extension.entityReferences.refresh', 'extension.entityReferences.pin',
            'extension.entityReferences.unpin', 'extension.entityReferences.remove',
            'extension.entityReferences.clear', 'extension.entityReferences.next',
            'extension.entityReferences.previous', 'extension.entityReferences.openSide',
            'extension.entityReferences.openCurrent',
        ]) {
            assert.ok(commands.has(command), `missing ${command}`);
        }
        const keybindings = manifest.contributes.keybindings || [];
        assert.equal(keybindings.some(binding => binding.command.startsWith('extension.entityReferences.')), false);
        const editorContext = manifest.contributes.menus['editor/context'] || [];
        assert.ok(!editorContext.some(item => item.command === 'extension.entityReferences.refresh'));
        const viewTitle = manifest.contributes.menus['view/title'] || [];
        assert.ok(viewTitle.some(item =>
            item.command === 'extension.entityReferences.refresh' &&
            item.when === 'view == lsdynaEntityReferences',
        ));
        const itemContext = manifest.contributes.menus['view/item/context'] || [];
        assert.equal(itemContext.some(item => item.command.startsWith('extension.entityReferences.')), false);
    });



    it('refreshes from the current cursor and clears the current query when no entity is under it', async () => {
        const refreshState = { revision: 0 };
        const calls = [];
        let current = { key: 'old', identity: { targetKind: 'curve', id: 1 } };
        const provider = {
            getCurrentSession: () => current,
            markLoading: session => calls.push({ type: 'loading', session }),
            clearCurrent: () => { calls.push({ type: 'clear' }); current = null; return true; },
        };
        const target = { targetKind: 'curve', id: 1000001, filePath: 'deck.key', line: 2, character: 5 };
        const refreshed = await refreshCurrentEntityReferenceQuery(
            {}, provider, refreshState,
            {
                inferTarget: () => target,
                runQuery: async (_indexClient, actualTarget, options) => {
                    calls.push({ type: 'query', actualTarget, current: options.isCurrentRequest() });
                    return { state: 'complete', locations: [], querySession: { key: 'new' } };
                },
            },
        );
        assert.equal(refreshed.state, 'complete');
        assert.deepEqual(calls.map(call => call.type), ['loading', 'query']);
        assert.deepEqual(calls[1].actualTarget, target);
        assert.equal(calls[1].current, true);

        const cleared = await refreshCurrentEntityReferenceQuery(
            {}, provider, refreshState,
            { inferTarget: () => null, runQuery: async () => { throw new Error('must not query'); } },
        );
        assert.equal(cleared, null);
        assert.equal(calls.at(-1).type, 'clear');
    });

    it('does not publish a superseded current refresh and leaves failures retryable', async () => {
        const refreshState = { revision: 0 };
        const published = [];
        const loading = [];
        let clearCount = 0;
        const provider = {
            current: { key: 'old' },
            getCurrentSession() { return this.current; },
            markLoading(session) { loading.push(session); },
            clearCurrent() { clearCount += 1; this.current = null; return true; },
        };
        let releaseFirst;
        const firstGate = new Promise(resolve => { releaseFirst = resolve; });
        const runQuery = async (_indexClient, target, options) => {
            if (target.id === 1) {
                await firstGate;
                if (!options.isCurrentRequest()) return null;
            }
            published.push(target.id);
            return { state: 'complete', locations: [], querySession: { key: String(target.id) } };
        };
        const first = refreshCurrentEntityReferenceQuery({}, provider, refreshState, {
            inferTarget: () => ({ targetKind: 'curve', id: 1 }), runQuery,
        });
        const second = refreshCurrentEntityReferenceQuery({}, provider, refreshState, {
            inferTarget: () => ({ targetKind: 'curve', id: 2 }), runQuery,
        });
        await second;
        releaseFirst();
        await first;
        assert.deepEqual(published, [2]);
        assert.equal(loading.length, 2);

        const failed = await refreshCurrentEntityReferenceQuery({}, provider, refreshState, {
            inferTarget: () => ({ targetKind: 'curve', id: 3 }),
            runQuery: async () => { throw new Error('query failed'); },
            logError: () => {},
        });
        assert.equal(failed, null);
        assert.equal(clearCount, 1);
    });

    it('refreshes a stale stored query using its saved identity and scope', async () => {
        const refreshState = { revision: 0 };
        const session = {
            key: 'curve:1000001',
            identity: {
                targetKind: 'curve', id: 1000001,
                scope: { kind: 'single-file', filePath: path.resolve('stale.key') },
            },
            state: 'stale',
        };
        const calls = [];
        const provider = {
            getSession: target => target === session ? session : null,
            markLoading: value => calls.push({ type: 'loading', value }),
            markNeedsRefresh: (value, reasons) => calls.push({ type: 'needs-refresh', value, reasons }),
        };
        const result = await refreshStoredEntityReferenceQuery({}, provider, refreshState, session, {
            runQuery: async (_indexClient, target, options) => {
                calls.push({ type: 'query', target, scope: options.scopeIdentity });
                return { state: 'complete', locations: [{ role: 'definition' }], querySession: session };
            },
        });
        assert.equal(result.state, 'complete');
        assert.deepEqual(calls.map(call => call.type), ['loading', 'query']);
        assert.deepEqual(calls[1].target, { targetKind: 'curve', id: 1000001 });
        assert.deepEqual(calls[1].scope, session.identity.scope);
    });

    it('promotes the current single-file query after its root Include tree finishes scanning', async () => {
        const rootFile = path.resolve('entity-query-scan', 'root.k');
        const snapshot = { scope: 'project', rootFile, files: [rootFile] };
        const session = {
            pinned: false,
            identity: {
                targetKind: 'material', id: 2000102,
                scope: { kind: 'single-file', filePath: rootFile },
            },
        };
        const calls = [];
        const result = await refreshCurrentEntityQueryAfterProjectScan(
            { rootFile, snapshot },
            { getActiveSession: () => session },
            async (active, scanResult) => {
                calls.push({ active, scanResult });
                return { state: 'partial', locations: [{ role: 'definition' }] };
            },
        );

        assert.equal(result.state, 'partial');
        assert.equal(calls.length, 1);
        assert.strictEqual(calls[0].active, session);
        assert.strictEqual(calls[0].scanResult.snapshot, snapshot);

        session.pinned = true;
        assert.equal(await refreshCurrentEntityQueryAfterProjectScan(
            { rootFile, snapshot },
            { getActiveSession: () => session },
            async () => { throw new Error('pinned query must not be promoted'); },
        ), null);
    });

    it('routes saved sidebar queries to worker pages without loading host snapshots', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-entity-worker-command-'));
        const filePath = path.join(tempRoot, 'main.key');
        fs.writeFileSync(filePath, '*MAT_ELASTIC\n1\n');
        const documents = vscodeMock.workspace.textDocuments;
        vscodeMock.workspace.textDocuments = [];
        try {
            const requests = [];
            const result = await handleIndexedEntityIdQueryCommand({
                loadProjectSnapshot: () => { throw new Error('Host snapshot must not load'); },
                queryEntity: async request => {
                    requests.push(request);
                    return { status: 'ready', revision: 'r1', result: { state: 'complete', locations: [],
                        page: { counts: { definition: 0, reference: 0 }, next: {} } } };
                },
            }, { targetKind: 'material', id: 1 }, {
                scopeIdentity: { kind: 'single-file', filePath }, presentResult: false,
                entityReferenceProvider: { publish: (_identity, value) => ({ ...value }), getSession: () => null },
                runWithProgress: operation => operation(),
            });
            assert.equal(result.state, 'complete');
            assert.equal(requests.length, 1);
            assert.equal(requests[0].rootFile, filePath);
            assert.equal(requests[0].scope, 'single-file');
            vscodeMock.workspace.textDocuments = [{ isDirty: true }];
            assert.deepEqual(await result.loadPage({ offset: 200 }), { status: 'stale' });
            assert.equal(requests.length, 1);
        } finally { vscodeMock.workspace.textDocuments = documents; }
    });

    it('queries the active disk file without requiring an active TextDocument', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-entity-command-'));
        const filePath = path.join(tempRoot, 'large.key');
        fs.writeFileSync(filePath, '*MAT_ELASTIC\n   2000101\n', 'utf8');
        const snapshot = {
            scope: 'single-file',
            rootFile: filePath,
            files: [filePath],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map(),
        };
        const calls = [];
        const originalTabGroups = vscodeMock.window.tabGroups;
        try {
            vscodeMock.window.activeTextEditor = null;
            vscodeMock.window.tabGroups = {
                ...originalTabGroups,
                activeTabGroup: { activeTab: { input: { uri: { fsPath: filePath } } } },
            };
            const result = await handleIndexedEntityIdQueryCommand(
                { loadProjectSnapshot: async () => { throw new Error('unexpected default load'); } },
                { targetKind: 'material', id: '2000101' },
                {
                    prepareSnapshot: async value => ({ state: 'ready', snapshot: value, reasons: [] }),
                    loadSnapshot: async (requestedPath, token) => {
                        calls.push({ type: 'load', requestedPath, token });
                        return snapshot;
                    },
                    query: async request => {
                        calls.push({ type: 'query', request });
                        return {
                            state: 'complete',
                            id: 2000101,
                            targetKind: 'material',
                            locations: [
                                {
                                    role: 'definition', keyword: '*MAT_ELASTIC', fieldName: 'MID',
                                    filePath, line: 1, startCharacter: 3, endCharacter: 10,
                                },
                                {
                                    role: 'reference', keyword: '*PART', fieldName: 'MID',
                                    filePath, line: 8, startCharacter: 23, endCharacter: 30,
                                },
                            ],
                            reasons: [],
                        };
                    },
                    entityReferenceProvider: {
                        publish: (identity, queryResult) => {
                            calls.push({ type: 'publish', identity, queryResult });
                            return { key: 'material:2000101', identity };
                        },
                        revealSession: async session => calls.push({ type: 'reveal', session }),
                    },
                    presentResult: async queryResult => calls.push({ type: 'present', queryResult }),
                    runWithProgress: operation => operation(null, null),
                },
            );

            assert.equal(result.state, 'complete');
            assert.equal(result.id, 2000101);
            assert.equal(calls[0].type, 'load');
            assert.equal(calls[0].requestedPath, filePath);
            assert.equal(calls[1].type, 'publish');
            assert.equal(calls[1].queryResult.state, 'loading');
            assert.equal(calls[2].type, 'query');
            assert.strictEqual(calls[2].request.snapshot, snapshot);
            assert.equal(calls[2].request.targetKind, 'material');
            assert.equal(calls[2].request.id, 2000101);
            assert.equal(calls[3].type, 'publish');
            assert.deepEqual(calls[3].identity, {
                targetKind: 'material',
                id: 2000101,
                scope: { kind: 'single-file', filePath },
            });
            assert.equal(calls[4].type, 'present');
        } finally {
            vscodeMock.window.tabGroups = originalTabGroups;
        }
    });

    it('uses cursor inference and delegates missing input to the webview form', async () => {
        const snapshot = { scope: 'single-file', fileIndexes: new Map() };
        const run = async options => handleIndexedEntityIdQueryCommand(
            { loadProjectSnapshot: async () => snapshot },
            null,
            {
                scope: { kind: 'single-file', filePath: path.resolve('query.key'), snapshot },
                prepareSnapshot: async value => ({ state: 'ready', snapshot: value }),
                query: async request => ({
                    state: 'complete', locations: [], reasons: [],
                    id: request.id, targetKind: request.targetKind,
                }),
                presentResult: false,
                runWithProgress: operation => operation(null, null),
                ...options,
            },
        );
        const inferred = await run({
            inferTarget: () => ({ targetKind: 'curve', id: 101 }),
        });
        assert.equal(inferred.id, 101);

        let inputRequired = 0;
        const entered = await run({
            inferTarget: () => null,
            onInputRequired: () => { inputRequired += 1; },
        });
        assert.equal(entered, null);
        assert.equal(inputRequired, 1);
    });

    it('keeps the last LS-DYNA editor as the cursor source while the webview has focus', () => {
        const originalActiveEditor = vscodeMock.window.activeTextEditor;
        const originalDocuments = vscodeMock.workspace.textDocuments;
        const originalVisibleEditors = vscodeMock.window.visibleTextEditors;
        const originalTabGroups = vscodeMock.window.tabGroups;
        const document = fakeDoc('*PART\n         1', path.resolve('cursor-source.key'));
        document.languageId = 'lsdyna';
        const editor = { document, selection: { active: new vscodeMock.Position(1, 9) } };
        try {
            vscodeMock.workspace.textDocuments = [document];
            vscodeMock.window.activeTextEditor = undefined;
            assert.strictEqual(resolveEntityReferenceCursorEditor(editor), editor);

            vscodeMock.window.visibleTextEditors = [editor];
            vscodeMock.window.tabGroups = {
                ...originalTabGroups,
                activeTabGroup: { activeTab: { input: { uri: document.uri } } },
            };
            assert.strictEqual(resolveEntityReferenceCursorEditor(null), editor);

            vscodeMock.workspace.textDocuments = [];
            vscodeMock.window.visibleTextEditors = [];
            assert.equal(resolveEntityReferenceCursorEditor(editor), null);
        } finally {
            vscodeMock.window.activeTextEditor = originalActiveEditor;
            vscodeMock.workspace.textDocuments = originalDocuments;
            vscodeMock.window.visibleTextEditors = originalVisibleEditors;
            vscodeMock.window.tabGroups = originalTabGroups;
        }
    });

    it('distinguishes an unsynchronized large-file tab from the custom large-file viewer', () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-large-tab-'));
        const filePath = path.join(tempRoot, 'large.key');
        const uri = { ...vscodeMock.Uri.file(filePath), scheme: 'file' };
        const originalActiveEditor = vscodeMock.window.activeTextEditor;
        const originalTabGroups = vscodeMock.window.tabGroups;
        try {
            fs.writeFileSync(filePath, '*KEYWORD\n', 'utf8');
            fs.truncateSync(filePath, 50 * 1024 * 1024);
            vscodeMock.window.activeTextEditor = undefined;
            vscodeMock.window.tabGroups = {
                ...originalTabGroups,
                activeTabGroup: { activeTab: { input: { uri } } },
            };
            assert.equal(activeUnsynchronizedLargeFileUri().fsPath, filePath);
            assert.equal(activeLargeFileViewerUri(), null);

            vscodeMock.window.tabGroups.activeTabGroup.activeTab.input.viewType =
                'lsdyna.largeFileViewer';
            assert.equal(activeUnsynchronizedLargeFileUri(), null);
            assert.equal(activeLargeFileViewerUri().fsPath, filePath);
        } finally {
            vscodeMock.window.activeTextEditor = originalActiveEditor;
            vscodeMock.window.tabGroups = originalTabGroups;
        }
    });

    it('infers a definition query from the current definition ID and follows cursor changes', () => {
        const document = fakeDoc([
            '*KEYWORD',
            '*SET_NODE_GENERAL',
            '$#     sid       da1       da2       da3       da4',
            '   1000003',
            '*SET_NODE_GENERAL',
            '$#     sid       da1       da2       da3       da4',
            '   1000004',
            '*END',
        ].join('\n'), path.resolve('definition-refresh.key'));
        document.languageId = 'lsdyna';
        document.version = 1;

        assert.deepEqual(
            inferIndexedEntityQueryTarget({
                document,
                selection: { active: { line: 3, character: 5 } },
            }),
            {
                targetKind: 'node-set',
                id: 1000003,
                filePath: document.uri.fsPath,
                line: 3,
                character: 5,
            },
        );
        assert.equal(
            inferIndexedEntityQueryTarget({
                document,
                selection: { active: { line: 6, character: 5 } },
            }).id,
            1000004,
        );
        assert.equal(
            inferIndexedEntityQueryTarget({
                document,
                selection: { active: { line: 3, character: 10 } },
            }).id,
            1000003,
        );
    });

    it('infers LS-PrePost transformation definitions and references at the cursor', () => {
        const document = fakeDoc([
            '*KEYWORD',
            '*DEFINE_TRANSFORMATION',
            '   1000001',
            '*INCLUDE_TRANSFORM',
            'test2/wall2.key',
            '  10000000  10000000  10000000  10000000  10000000  10000000  10000000',
            '  10000000',
            '',
            '$#  tranid',
            '   1000001',
            '*END',
        ].join('\n'), path.resolve('transformation-cursor.key'));
        document.languageId = 'lsdyna';
        document.version = 1;

        for (const line of [2, 9]) {
            assert.deepEqual(
                inferIndexedEntityQueryTarget({
                    document,
                    selection: { active: new vscodeMock.Position(line, 5) },
                }),
                {
                    targetKind: 'transformation',
                    id: 1000001,
                    filePath: document.uri.fsPath,
                    line,
                    character: 5,
                },
            );
        }
    });

    it('omits mesh query targets and selects one CONTACT namespace from its controller', () => {
        const beam = fakeDoc(['*KEYWORD', '*ELEMENT_BEAM',
            [1, 8, 1, 1, 0].map(value => String(value).padStart(8)).join(''),
            [2, 8, 1, 73, 0].map(value => String(value).padStart(8)).join(''), '*END'].join('\n'), path.resolve('native-cursor-beam.key'));
        beam.languageId = 'lsdyna'; beam.version = 1;
        const selected = inferIndexedEntityQueryTarget({ document: beam, selection: { active: new vscodeMock.Position(3, 30) } });
        assert.equal(selected, null);
        for (const [type, expected] of [[3, ['part']], [4, ['node-set']], [5, null], [7, ['part-tree-set', 'part']]]) {
            const contact = fakeDoc(['*KEYWORD', '*CONTACT_AUTOMATIC_SINGLE_SURFACE',
                [73, 0, type, 5, 0, 0, 0, 0].map(value => String(value).padStart(10)).join(''), '*END'].join('\n'), path.resolve('native-cursor-contact-' + type + '.key'));
            contact.languageId = 'lsdyna'; contact.version = 1;
            const target = fieldReferenceAtPosition(contact, new vscodeMock.Position(2, 8), { semanticScope: "keyword-catalog" });
            assert.deepEqual(target?.referenceValue.targetKinds || null, expected, String(type));
            if (type === 7) {
                assert.deepEqual(target.referenceValue.semanticRelation.targetSearch.map(branch => branch.targetKinds),
                    [['part-tree-set'], ['part']]);
                assert.equal(inferIndexedEntityQueryTarget({ document: contact,
                    selection: { active: new vscodeMock.Position(2, 8) } }, { requireUnambiguous: true }), null);
            }
        }
    });

    it('queries the complete LS-PrePost transformation deck through the webview command path', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-transform-webview-'));
        const filePath = path.join(tempRoot, 'main.key');
        fs.writeFileSync(filePath, [
            '*KEYWORD',
            '*DEFINE_TRANSFORMATION',
            '   1000001',
            '$   ROTATE       0.0       0.0       1.0       0.0       0.0       0.0      -25.',
            'TRANSL       -4450.0        2.       0.0',
            '*INCLUDE_TRANSFORM',
            'test2/wall2.key',
            '  10000000  10000000  10000000  10000000  10000000  10000000  10000000',
            '  10000000',
            '$#  fctmas    fcttim    fctlen    fcttem    incout',
            '',
            '$#  tranid',
            '   1000001',
            '*END',
        ].join('\n'), 'utf8');
        {
            const snapshot = await buildProjectIndex(filePath, { singleFileOnly: true });
            const query = await handleIndexedEntityIdQueryCommand(
                { loadProjectSnapshot: async () => snapshot },
                { targetKind: 'transformation', id: 1000001, filePath },
                {
                    scope: { kind: 'single-file', filePath, snapshot },
                    runWithProgress: operation => operation(null, null),
                },
            );
            assert.equal(query.state, 'exact', JSON.stringify(query.reasons));
            assert.deepEqual(query.locations.map(location => [
                location.role, location.keyword, location.fieldName, location.line,
            ]), [
                ['definition', '*DEFINE_TRANSFORMATION', 'TRANID', 2],
                ['reference', '*INCLUDE_TRANSFORM', 'TRANID', 12],
            ]);
        }
    });

    it('keeps a reference value under the cursor at its fixed-width exclusive end', () => {
        const document = fakeDoc([
            '*NODE_TRANSFORM',
            '   2000101',
            '*END',
        ].join('\n'), path.resolve('transformation-boundary.key'));
        document.languageId = 'lsdyna';
        document.version = 1;

        assert.deepEqual(
            inferIndexedEntityQueryTarget({
                document,
                selection: { active: new vscodeMock.Position(1, 10) },
            }),
            {
                targetKind: 'transformation',
                id: 2000101,
                filePath: document.uri.fsPath,
                line: 1,
                character: 10,
            },
        );
    });

    it('infers part-set definitions through TITLE schema aliases', () => {
        const document = fakeDoc([
            '*SET_PART_LIST_TITLE',
            'SET_Dummy',
            '   8100001',
            '91200001,91200401,91200601',
            '*END',
        ].join('\n'), path.resolve('definition-refresh-set-part-title.key'));
        document.languageId = 'lsdyna';
        document.version = 1;

        assert.deepEqual(
            inferIndexedEntityQueryTarget({
                document,
                selection: { active: new vscodeMock.Position(2, 5) },
            }),
            {
                targetKind: 'part-set',
                id: 8100001,
                filePath: document.uri.fsPath,
                line: 2,
                character: 5,
            },
        );
        assert.equal(
            inferIndexedEntityQueryTarget({
                document,
                selection: { active: new vscodeMock.Position(3, 2) },
            }),
            null,
        );
    });

    it('does not offer node and element records as entity query targets', () => {
        for (const [keyword, targetKind, records] of [
            ['NODE', 'node', [1, 2].map(id => String(id).padStart(8) + '               0               0               0')],
            ['ELEMENT_BEAM', 'element', [1, 2].map(id => [id, 8, 1, 73, 0].map(value => String(value).padStart(8)).join(''))],
        ]) {
            const document = fakeDoc(['*KEYWORD', '*' + keyword, ...records, '*END'].join('\n'),
                path.resolve('repeated-owning-' + keyword + '.key'));
            document.languageId = 'lsdyna'; document.version = 1;
            for (const [line, id] of [[2, 1], [3, 2]]) assert.deepEqual(inferIndexedEntityQueryTarget({ document,
                selection: { active: new vscodeMock.Position(line, 4) } }), null);
        }
    });

    it('opens one result in the current editor and multiple results in native Peek', async () => {
        const originalExecute = vscodeMock.commands.executeCommand;
        const calls = [];
        vscodeMock.commands.executeCommand = async (...args) => calls.push(args);
        try {
            const location = {
                role: 'definition', filePath: path.resolve('definition.key'),
                line: 2, startCharacter: 0, endCharacter: 10,
            };
            await presentIndexedEntityQueryResult({ locations: [location] });
            assert.equal(calls[0][0], 'vscode.open');
            assert.equal(calls[0][2].viewColumn, vscodeMock.ViewColumn.Active);

            await presentIndexedEntityQueryResult({ locations: [location, { ...location, line: 3 }] });
            assert.equal(calls[1][0], 'editor.action.peekLocations');
            assert.equal(calls[1][3].length, 2);
        } finally {
            vscodeMock.commands.executeCommand = originalExecute;
        }
    });

    it('reuses an already-scanned project snapshot instead of loading a single file', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-entity-project-'));
        const rootFile = path.join(tempRoot, 'root.k');
        fs.writeFileSync(rootFile, '*KEYWORD\n*END\n', 'utf8');
        cacheReferenceIndexFromSnapshot({
            scope: 'project',
            rootFile,
            files: [rootFile],
            graph: { includeOccurrences: [], includeOccurrencesComplete: true },
            fileIndexes: new Map([[rootFile, {
                parameterEvents: [],
                referenceDefinitions: { curves: [], tables: [], genericDefinitions: [] },
                registryReferences: {
                    complete: true, reasons: [], referenceOccurrences: [], valueDomainOccurrences: [],
                },
            }]]),
        });
        let loadCount = 0;
        const originalTabGroups = vscodeMock.window.tabGroups;
        try {
            vscodeMock.window.activeTextEditor = null;
            vscodeMock.window.tabGroups = {
                ...originalTabGroups,
                activeTabGroup: { activeTab: { input: { uri: { fsPath: rootFile } } } },
            };
            const result = await handleIndexedEntityIdQueryCommand(
                { loadProjectSnapshot: async () => { loadCount += 1; } },
                { targetKind: 'material', id: 2000101 },
                {
                    loadSnapshot: async () => { loadCount += 1; },
                    query: async request => ({
                        state: 'complete',
                        id: request.id,
                        targetKind: request.targetKind,
                        locations: [],
                        reasons: [],
                    }),
                    runWithProgress: operation => operation(null, null),
                },
            );

            assert.equal(loadCount, 0);
            assert.equal(result.state, 'complete');
        } finally {
            vscodeMock.window.tabGroups = originalTabGroups;
            clearReferenceIndexCacheForTesting();
        }
    });

    it('reloads an oversized scanned project scope instead of falling back to the active root file', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-entity-oversized-scope-'));
        const rootFile = path.join(tempRoot, 'root.k');
        const childFile = path.join(tempRoot, 'child.k');
        fs.writeFileSync(rootFile, '*INCLUDE\nchild.k\n', 'utf8');
        fs.writeFileSync(childFile, '*MAT_ELASTIC\n   2000102\n', 'utf8');
        const snapshot = {
            scope: 'project', rootFile, files: [rootFile, childFile],
            graph: { includeOccurrences: [], includeOccurrencesComplete: true },
            fileIndexes: new Map(),
        };
        const loads = [];
        const originalTabGroups = vscodeMock.window.tabGroups;
        try {
            clearReferenceIndexCacheForTesting();
            assert.equal(cacheReferenceIndexFromSnapshot(snapshot, { maxBytes: 1 }), false);
            vscodeMock.window.activeTextEditor = null;
            vscodeMock.window.tabGroups = {
                ...originalTabGroups,
                activeTabGroup: { activeTab: { input: { uri: { fsPath: rootFile } } } },
            };
            const result = await handleIndexedEntityIdQueryCommand(
                {
                    loadProjectSnapshot: async (requestedRoot, options) => {
                        loads.push({ requestedRoot, options });
                        return snapshot;
                    },
                },
                { targetKind: 'material', id: 2000102 },
                {
                    prepareSnapshot: async value => ({ state: 'ready', snapshot: value, reasons: [] }),
                    query: async request => ({
                        state: 'complete', id: request.id, targetKind: request.targetKind,
                        locations: [], reasons: [],
                    }),
                    runWithProgress: operation => operation(null, null),
                },
            );

            assert.equal(result.state, 'complete');
            assert.equal(loads.length, 1);
            assert.equal(loads[0].requestedRoot, rootFile);
            assert.equal(loads[0].options.singleFileOnly, undefined);
        } finally {
            vscodeMock.window.tabGroups = originalTabGroups;
            clearReferenceIndexCacheForTesting();
        }
    });

    it('uses a dirty ordinary document as a live overlay for references and definitions', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-entity-live-'));
        const filePath = path.join(tempRoot, 'live.key');
        fs.writeFileSync(filePath, '*MAT_ELASTIC\n         1\n', 'utf8');
        const originalDocuments = vscodeMock.workspace.textDocuments;
        try {
            const snapshot = await buildProjectIndex(filePath, { singleFileOnly: true });
            const document = fakeDoc('*MAT_ELASTIC\n   2000101\n', filePath);
            document.isDirty = true;
            document.version = 7;
            document.languageId = 'lsdyna';
            vscodeMock.workspace.textDocuments = [document];

            const prepared = await prepareIndexedEntityQuerySnapshot(snapshot);
            assert.equal(prepared.state, 'ready');
            assert.equal(prepared.snapshot.fileIndexes.get(filePath).documentVersion, 7);

            const query = await handleIndexedEntityIdQueryCommand(
                { loadProjectSnapshot: async () => { throw new Error('unexpected load'); } },
                { targetKind: 'material', id: 2000101 },
                {
                    scope: { kind: 'single-file', filePath, snapshot },
                    runWithProgress: operation => operation(null, null),
                },
            );
            assert.equal(query.state, 'exact', JSON.stringify(query.reasons));
            assert.ok(query.locations.some(location =>
                location.role === 'definition' && location.line === 1
            ));
        } finally {
            vscodeMock.workspace.textDocuments = originalDocuments;
        }
    });

    it('fails closed when a dirty document can change the Include graph', async () => {
        const tempRoot = makeTemp(path.join(os.tmpdir(), 'lsdyna-entity-dirty-include-'));
        const filePath = path.join(tempRoot, 'root.key');
        fs.writeFileSync(filePath, '*KEYWORD\n*END\n', 'utf8');
        const originalDocuments = vscodeMock.workspace.textDocuments;
        try {
            const snapshot = await buildProjectIndex(filePath, { singleFileOnly: true });
            const document = fakeDoc('*KEYWORD\n*INCLUDE\nchild.key\n*END\n', filePath);
            document.isDirty = true;
            document.version = 2;
            document.languageId = 'lsdyna';
            vscodeMock.workspace.textDocuments = [document];

            const prepared = await prepareIndexedEntityQuerySnapshot(snapshot);
            assert.equal(prepared.state, 'incomplete');
            assert.equal(prepared.snapshot, null);
            assert.ok(prepared.reasons.some(reason => reason.includes('dirty-include-graph-unverified')));
        } finally {
            vscodeMock.workspace.textDocuments = originalDocuments;
        }
    });
});

describe('project index cache controls', () => {
    function compactSnapshot(rootFile, padding = '') {
        return {
            rootFile,
            files: [rootFile],
            fileIndexes: new Map([[rootFile, {
                keywordBlocks: [],
                parameterEvents: [],
                referenceDefinitions: { curves: [], tables: [], genericDefinitions: [] },
                padding,
            }]]),
        };
    }

    it('clamps configured limits to the documented hard ceilings', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get(key, fallback) {
                return {
                    'cache.memoryMaxMiB': 999,
                    'cache.projectSnapshotDiskMaxMiB': 1,
                    'cache.maxAgeDays': 0,
                }[key] ?? fallback;
            },
        });
        try {
            assert.equal(cacheLimitBytes('cache.memoryMaxMiB', 48, 16, 64), 64 * 1024 * 1024);
            assert.equal(cacheLimitBytes('cache.projectSnapshotDiskMaxMiB', 256, 32, 256), 32 * 1024 * 1024);
            assert.equal(cacheLimitMilliseconds('cache.maxAgeDays', 30, 1, 30), 24 * 60 * 60 * 1000);
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('clears the LSP layers with progress and reports aggregate removed bytes', async () => {
        const originalWithProgress = vscodeMock.window.withProgress;
        const originalProgressLocation = vscodeMock.ProgressLocation;
        const originalSetStatusBarMessage = vscodeMock.window.setStatusBarMessage;
        const progressOptions = [];
        const statusMessages = [];
        const expected = {
            memory: { cachedSnapshotCount: 2, totalSnapshotBytes: 1024 },
            projectSnapshotDisk: { entryCount: 3, totalBytes: 2048 },
            fileScanDisk: { entryCount: 4, totalBytes: 4096 },
            entityIndex: { cleared: { removed: 2, reclaimedBytes: 4096, bytes: 65536 } },
        };
        let clearCalls = 0;
        let diagnosticClearCalls = 0;
        let includeClearCalls = 0;
        let keywordLocalCalls = 0;
        vscodeMock.ProgressLocation = { Notification: 15 };
        vscodeMock.window.withProgress = async (options, task) => {
            progressOptions.push(options);
            return task({ report() {} });
        };
        vscodeMock.window.setStatusBarMessage = (message, timeout) => {
            statusMessages.push({ message, timeout });
            return { dispose() {} };
        };

        try {
            const result = await handleClearProjectIndexCachesCommand({
                async clearCaches() {
                    clearCalls += 1;
                    return expected;
                },
            }, {
                projectDiagnosticStore: { clearAll() { diagnosticClearCalls++; } },
                includeTreeProvider: { clearProjectSnapshot() { includeClearCalls++; } },
                keywordIndexProvider: { async setLocal() { keywordLocalCalls++; } },
            });
            assert.strictEqual(result, expected);
            assert.equal(clearCalls, 1);
            assert.equal(diagnosticClearCalls, 1);
            assert.equal(includeClearCalls, 1);
            assert.equal(keywordLocalCalls, 1);
            assert.equal(progressOptions.length, 1);
            assert.equal(progressOptions[0].cancellable, false);
            assert.deepEqual(cacheRemovalTotals(expected), { entryCount: 11, totalBytes: 11264 });
            assert.equal(statusMessages.length, 1);
            assert.match(statusMessages[0].message, /11/);
            assert.match(statusMessages[0].message, /11\.0 KB/);
            assert.equal(statusMessages[0].timeout, 8000);
        } finally {
            clearClientProjectSemanticCaches();
            vscodeMock.window.withProgress = originalWithProgress;
            vscodeMock.ProgressLocation = originalProgressLocation;
            vscodeMock.window.setStatusBarMessage = originalSetStatusBarMessage;
        }
    });

    it('reports cache-clear failure in an error notification without claiming success', async () => {
        const originalError = vscodeMock.window.showErrorMessage;
        const originalStatus = vscodeMock.window.setStatusBarMessage;
        const originalLog = console.error;
        const messages = [], statuses = [], logs = [];
        vscodeMock.window.showErrorMessage = message => { messages.push(message); return Promise.resolve(); };
        vscodeMock.window.setStatusBarMessage = message => { statuses.push(message); };
        console.error = (...args) => logs.push(args);
        try {
            assert.equal(await handleClearProjectIndexCachesCommand({ async clearCaches() { throw new Error('stop failed'); } }), null);
            const cleared = { memory: {}, projectSnapshotDisk: {}, fileScanDisk: {} };
            assert.strictEqual(await handleClearProjectIndexCachesCommand({ async clearCaches() { return cleared; } }, {
                projectDiagnosticStore: { clearAll() { throw new Error('view cleanup failed'); } },
            }), cleared);
            assert.deepEqual(messages, [i18n.get('projectCacheClearFailed'), i18n.get('projectCacheClearFailed')]);
            assert.deepEqual(statuses, []);
            assert.equal(logs.length, 2);
        } finally {
            vscodeMock.window.showErrorMessage = originalError;
            vscodeMock.window.setStatusBarMessage = originalStatus;
            console.error = originalLog;
        }
    });

    it('evicts least-recently-used client project skeletons by estimated bytes', () => {
        const rootA = path.resolve('client-cache', 'a.k');
        const rootB = path.resolve('client-cache', 'b.k');
        const rootC = path.resolve('client-cache', 'c.k');
        clearReferenceIndexCacheForTesting();
        try {
            assert.equal(cacheReferenceIndexFromSnapshot(compactSnapshot(rootA, 'a'.repeat(1024))), true);
            assert.equal(cacheReferenceIndexFromSnapshot(compactSnapshot(rootB, 'b'.repeat(1024))), true);
            const twoProjectBudget = clientProjectCacheStats().totalBytes;
            assert.equal(clientProjectCacheStats().entryCount, 2);

            // Resolve A to make it the MRU project, then admit C under the exact
            // two-project budget. B must be the only eviction candidate.
            assert.equal(getMainDeckContextForDocumentPath(rootA).rootFile, rootA);
            assert.equal(cacheReferenceIndexFromSnapshot(
                compactSnapshot(rootC, 'c'.repeat(1024)),
                { maxBytes: twoProjectBudget },
            ), true);

            assert.equal(clientProjectCacheStats(twoProjectBudget).entryCount, 2);
            assert.equal(getMainDeckContextForDocumentPath(rootA).rootFile, rootA);
            assert.equal(getMainDeckContextForDocumentPath(rootB).rootFile, rootB);
            assert.equal(getMainDeckContextForDocumentPath(rootB).project.snapshot, undefined);
            assert.equal(getMainDeckContextForDocumentPath(rootC).rootFile, rootC);
            assert.ok(clientProjectCacheStats(twoProjectBudget).totalBytes <= twoProjectBudget);
        } finally {
            clearReferenceIndexCacheForTesting();
        }
    });

    it('rejects an oversized client project and preserves live open-document indexes on clear', () => {
        const rootFile = path.resolve('client-cache', 'oversize.k');
        const liveFile = path.resolve('client-cache', 'open.k');
        clearReferenceIndexCacheForTesting();
        setFileIndexForTesting(liveFile, {
            filePath: liveFile,
            documentVersion: 7,
            keywordBlocks: [],
        });
        try {
            assert.equal(cacheReferenceIndexFromSnapshot(
                compactSnapshot(rootFile, 'large'),
                { maxBytes: 1 },
            ), false);
            assert.equal(clientProjectCacheStats().entryCount, 0);
            assert.equal(getMainDeckContextForDocumentPath(rootFile).rootFile, rootFile);
            assert.equal(getMainDeckContextForDocumentPath(rootFile).project.snapshot, undefined);
            clearClientProjectSemanticCaches();
            assert.equal(getMainDeckContextForDocumentPath(rootFile).rootFile, null);
            assert.equal(getFileIndexForDocument({ uri: { fsPath: liveFile } }).documentVersion, 7);
        } finally {
            setFileIndexForTesting(liveFile, null);
            clearReferenceIndexCacheForTesting();
        }
    });

    it('bounds cache admission work without serializing an entire project', () => {
        const rootFile = path.resolve('client-cache', 'bounded.k');
        const snapshot = compactSnapshot(rootFile, 'small');
        let visited = 0;
        const occurrence = { filePath: rootFile };
        const occurrences = Array(100000).fill(occurrence);
        Object.defineProperty(occurrences, 99999, {
            get() { visited++; throw new Error('cache admission traversed the entire project'); },
        });
        // Search-path metadata is walked by cache sizing, without an earlier
        // snapshot copy. A rejected admission must retain project membership.
        snapshot.effectiveSearchPathsByFile = new Map([[rootFile, occurrences]]);
        clearReferenceIndexCacheForTesting();
        try {
            assert.equal(cacheReferenceIndexFromSnapshot(snapshot), false);
            assert.equal(visited, 0);
            assert.equal(clientProjectCacheStats().entryCount, 0);
            assert.equal(getMainDeckContextForDocumentPath(rootFile).rootFile, rootFile);
        } finally {
            clearReferenceIndexCacheForTesting();
        }
    });

    it('accounts for retained slots when project metadata shares objects', () => {
        const rootFile = path.resolve('client-cache', 'shared.k');
        const snapshot = compactSnapshot(rootFile, 'small');
        const shared = { path: rootFile };
        snapshot.effectiveSearchPathsByFile = new Map([[rootFile, [shared]]]);
        clearReferenceIndexCacheForTesting();
        try {
            assert.equal(cacheReferenceIndexFromSnapshot(snapshot), true);
            const small = clientProjectCacheStats().totalBytes;
            snapshot.effectiveSearchPathsByFile = new Map([[rootFile, Array(1001).fill(shared)]]);
            assert.equal(cacheReferenceIndexFromSnapshot(snapshot), true);
            assert.ok(clientProjectCacheStats().totalBytes >= small + 8000);
        } finally {
            clearReferenceIndexCacheForTesting();
        }
    });
});

describe('verified conditional-card hover and command', () => {
    const schema = require("../../keywords/runtime/schema/field_data.json");
    const entry = schema.MAT_WINFRITH_CONCRETE;
    const layoutId = 'card-edit-layout:4834299f92dfa36f81b31fbf';
    const ruleId = 'rule:390df6397d5041459cbd486f';

    function fixedCard(card, values = {}) {
        const width = Math.max(...card.map(field => field.p + field.w));
        const characters = Array(width).fill(' ');
        for (const field of card) {
            if (!Object.hasOwn(values, field.n)) continue;
            const value = String(values[field.n]);
            const start = field.p + field.w - value.length;
            for (let index = 0; index < value.length; index++) characters[start + index] = value[index];
        }
        return characters.join('');
    }

    function winfrithDocument({
        rate = 8,
        cards = 2,
        version = 7,
        filePath = path.resolve('card-edit', 'winfrith.k'),
        keyword = '*MAT_WINFRITH_CONCRETE',
        globalHeader = null,
    } = {}) {
        const cardLines = entry.c.slice(0, cards).map((card, index) => fixedCard(
            card,
            index === 0 ? { MID: 1 } : index === 1 ? { RATE: rate } : {},
        ));
        const lines = [keyword, ...cardLines, '*END'];
        if (globalHeader) lines.unshift(globalHeader);
        const document = fakeDoc(lines.join('\n'), filePath);
        document.languageId = 'lsdyna';
        document.version = version;
        document.eol = 1;
        const uriIdentity = `file:///${filePath.replace(/\\/g, '/')}`;
        document.uri = { fsPath: filePath, toString: () => uriIdentity };
        return { document, keywordLine: globalHeader ? 1 : 0, uriIdentity };
    }

    function requestFor(document, keywordLine) {
        return {
            uri: document.uri.toString(),
            keywordLine,
            documentVersion: document.version,
            layoutId,
            ruleId,
        };
    }

    let originalStatusMessage;

    beforeEach(() => {
        originalStatusMessage = vscodeMock.window.setStatusBarMessage;
        vscodeMock.window.setStatusBarMessage = () => ({ dispose() {} });
    });

    afterEach(() => {
        vscodeMock.window.setStatusBarMessage = originalStatusMessage;
        vscodeMock.window.activeTextEditor = null;
    });

    it('shows one explicit ready-only hover action with identity-only command arguments', async () => {
        const { document, keywordLine } = winfrithDocument();
        const hover = await new LsdynaFieldHoverProvider().provideDetailedHover(
            document,
            { line: keywordLine, character: 4 },
        );
        assert.ok(hover);
        const value = hover.contents[0].value;
        assert.ok(value.includes(i18n.get('verifiedCardEditSection')));
        assert.ok(value.includes('Cards 3–7'));
        assert.ok(value.includes('Cards 3–4'));
        assert.ok(value.includes('Cards 5–7'));
        assert.ok(value.includes('RATE = 8'));
        assert.ok(value.includes('LCCMP'));
        assert.ok(value.includes(i18n.get('verifiedCardEditBlankOnly')));
        assert.ok(value.includes(i18n.get('verifiedCardEditAction')));

        const match = value.match(/command:extension\.addVerifiedConditionalCards\?([^\s"]+)/);
        assert.ok(match, value);
        const args = JSON.parse(decodeURIComponent(match[1]));
        assert.equal(args.length, 1);
        assert.deepEqual(Object.keys(args[0]).sort(), [
            'documentVersion',
            'keywordLine',
            'layoutId',
            'ruleId',
            'uri',
        ]);
        assert.deepEqual(args[0], requestFor(document, keywordLine));
        for (const forbidden of ['RATE', 'predicateState', 'existingPhysicalCards', 'cardsToAppend', 'insertion']) {
            assert.equal(Object.hasOwn(args[0], forbidden), false);
        }
    });

    it('does not offer two competing repair commands for the same verified suffix', async () => {
        const { document, keywordLine } = winfrithDocument({ cards: 4 });
        const hover = await new LsdynaFieldHoverProvider().provideDetailedHover(
            document,
            { line: keywordLine, character: 4 },
        );
        const value = hover.contents[0].value;
        assert.ok(value.includes('command:extension.addVerifiedConditionalCards'));
        assert.ok(value.includes(i18n.get('keywordStructureMissingNamed', 'Card 5, Card 6, Card 7')));
        assert.ok(!value.includes('command:extension.insertVerifiedMissingRecords'));
    });

    it('does not add hover editing noise for false predicates or alternative layouts', async () => {
        const falseDocument = winfrithDocument({ rate: 2 }).document;
        const falseHover = await new LsdynaFieldHoverProvider().provideDetailedHover(
            falseDocument,
            { line: 0, character: 4 },
        );
        assert.ok(falseHover);
        assert.ok(!falseHover.contents[0].value.includes('extension.addVerifiedConditionalCards'));

        const alternative = fakeDoc('*MAT_DAMAGE_1\n' + ' '.repeat(80) + '\n' + ' '.repeat(70) + '        -1');
        alternative.languageId = 'lsdyna';
        alternative.version = 1;
        const alternativeHover = await new LsdynaFieldHoverProvider().provideDetailedHover(
            alternative,
            { line: 0, character: 4 },
        );
        assert.ok(alternativeHover);
        assert.ok(!alternativeHover.contents[0].value.includes('extension.addVerifiedConditionalCards'));
    });

    it('re-plans from the live document and applies exactly one zero-length edit', async () => {
        const { document, keywordLine } = winfrithDocument();
        const editor = {
            document,
            selection: { active: new vscodeMock.Position(keywordLine, 4) },
        };
        const expected = planVerifiedConditionalCardsForDocument(document, keywordLine, {
            schema,
            blockIndex: null,
        });
        let appliedEdit = null;
        const forged = {
            ...requestFor(document, keywordLine),
            RATE: 2,
            existingPhysicalCards: 99,
            cardsToAppend: [],
            insertion: { line: 0, character: 0, text: '*DELETE' },
        };

        const result = await handleAddVerifiedConditionalCardsCommand(forged, {
            editor,
            schema,
            blockIndex: null,
            applyEdit: async edit => {
                appliedEdit = edit;
                return true;
            },
        });

        assert.ok(result);
        assert.equal(result.plan.status, 'ready');
        assert.strictEqual(result.edit, appliedEdit);
        assert.equal(appliedEdit.edits.length, 1);
        const actual = appliedEdit.edits[0];
        assert.strictEqual(actual.uri, document.uri);
        assert.deepEqual(actual.range.start, actual.range.end);
        assert.deepEqual(actual.range.start, new vscodeMock.Position(
            expected.insertion.line,
            expected.insertion.character,
        ));
        assert.equal(actual.text, expected.insertion.text);
        assert.ok(!actual.text.includes('*DELETE'));
        assert.ok(actual.text.includes('$#'));
        assert.ok(expected.cardsToAppend.every(card => actual.text.includes(card.blankText)));
    });

    it('fails open for stale source identities, forged layout identities, and changed live semantics', async () => {
        const original = winfrithDocument();
        let applyCount = 0;
        const applyEdit = async () => {
            applyCount++;
            return true;
        };
        const editorFor = document => ({
            document,
            selection: { active: new vscodeMock.Position(original.keywordLine, 4) },
        });

        assert.equal(await handleAddVerifiedConditionalCardsCommand({
            ...requestFor(original.document, original.keywordLine),
            documentVersion: 6,
        }, { editor: editorFor(original.document), schema, blockIndex: null, applyEdit }), null);
        assert.equal(await handleAddVerifiedConditionalCardsCommand({
            ...requestFor(original.document, original.keywordLine),
            uri: 'file:///different.k',
        }, { editor: editorFor(original.document), schema, blockIndex: null, applyEdit }), null);
        assert.equal(await handleAddVerifiedConditionalCardsCommand({
            ...requestFor(original.document, original.keywordLine),
            layoutId: 'card-edit-layout:forged',
        }, { editor: editorFor(original.document), schema, blockIndex: null, applyEdit }), null);
        assert.equal(await handleAddVerifiedConditionalCardsCommand({
            ...requestFor(original.document, original.keywordLine),
            ruleId: 'rule:forged',
        }, { editor: editorFor(original.document), schema, blockIndex: null, applyEdit }), null);

        const changedRate = winfrithDocument({ rate: 2 });
        assert.equal(await handleAddVerifiedConditionalCardsCommand(
            requestFor(changedRate.document, changedRate.keywordLine),
            { editor: editorFor(changedRate.document), schema, blockIndex: null, applyEdit },
        ), null);
        const complete = winfrithDocument({ cards: 7 });
        assert.equal(await handleAddVerifiedConditionalCardsCommand(
            requestFor(complete.document, complete.keywordLine),
            { editor: editorFor(complete.document), schema, blockIndex: null, applyEdit },
        ), null);
        const longDeck = winfrithDocument({ globalHeader: '*KEYWORD LONG=Y' });
        assert.equal(await handleAddVerifiedConditionalCardsCommand(
            requestFor(longDeck.document, longDeck.keywordLine),
            { editor: editorFor(longDeck.document), schema, blockIndex: null, applyEdit },
        ), null);
        const changedKeyword = winfrithDocument({ keyword: '*MAT_DAMAGE_1' });
        assert.equal(await handleAddVerifiedConditionalCardsCommand(
            requestFor(changedKeyword.document, changedKeyword.keywordLine),
            { editor: editorFor(changedKeyword.document), schema, blockIndex: null, applyEdit },
        ), null);
        const localLong = winfrithDocument({ keyword: '*MAT_WINFRITH_CONCRETE+' });
        assert.equal(await handleAddVerifiedConditionalCardsCommand(
            requestFor(localLong.document, localLong.keywordLine),
            { editor: editorFor(localLong.document), schema, blockIndex: null, applyEdit },
        ), null);
        assert.equal(applyCount, 0);
    });

    it('keeps applyEdit=false non-destructive and supports command-palette use only on the keyword line', async () => {
        const { document, keywordLine } = winfrithDocument();
        let applyCount = 0;
        const failed = await handleAddVerifiedConditionalCardsCommand(
            requestFor(document, keywordLine),
            {
                editor: { document, selection: { active: new vscodeMock.Position(keywordLine, 2) } },
                schema,
                blockIndex: null,
                applyEdit: async edit => {
                    applyCount++;
                    assert.equal(edit.edits.length, 1);
                    return false;
                },
            },
        );
        assert.equal(failed, null);
        assert.equal(applyCount, 1);

        const dataLine = await handleAddVerifiedConditionalCardsCommand(undefined, {
            editor: { document, selection: { active: new vscodeMock.Position(1, 2) } },
            schema,
            blockIndex: null,
            applyEdit: async () => {
                throw new Error('must not apply from a data line');
            },
        });
        assert.equal(dataLine, null);

        const palette = await handleAddVerifiedConditionalCardsCommand(undefined, {
            editor: { document, selection: { active: new vscodeMock.Position(keywordLine, 2) } },
            schema,
            blockIndex: null,
            applyEdit: async () => true,
        });
        assert.ok(palette);
        assert.equal(palette.plan.status, 'ready');
    });

    it('uses only an already-ready index hint and never asks the provider to build one', () => {
        const { document, keywordLine } = winfrithDocument();
        let reads = 0;
        const provider = {
            getDocumentBlockIndexIfReady(actualDocument) {
                reads++;
                assert.strictEqual(actualDocument, document);
                return null;
            },
            _documentIndex() {
                throw new Error('semantic planning must not build an index');
            },
        };
        const plan = planVerifiedConditionalCardsForDocument(document, keywordLine, {
            schema,
            keywordIndexProvider: provider,
        });
        assert.equal(plan.status, 'ready');
        assert.equal(reads, 1);
    });
});

describe('official field value completions', () => {
    const { LsdynaFieldCompletionProvider } = extensionModule._internals;

    function officialChoices(result) {
        const items = Array.isArray(result) ? result : (result?.items || []);
        return items.filter(item => item.kind === vscodeMock.CompletionItemKind.EnumMember);
    }

    it('uses the LSPP MAT_DAMAGE_1 FLAG domain when manual values disagree', async () => {
        const { ManualPackManager } = require("../../src/manual/ManualPackManager");
        const priorAuthority = ManualPackManager.prototype.peekCurrentAuthority;
        const authority = extensionModule._internals.getManualSemanticCatalog().summary().evidenceAuthority;
        const profile = authority.profiles?.find(p => p.sourceProfileId === authority.defaultSourceProfileId) || authority;
        ManualPackManager.prototype.peekCurrentAuthority = () => profile;
        try {

        const provider = new LsdynaFieldCompletionProvider();
        const line = `${' '.repeat(70)}         0`;
        const doc = fakeDoc([
            '*MAT_DAMAGE_1',
            ' '.repeat(80),
            line,
        ].join('\n'));

        const choices = officialChoices(await provider.provideCompletionItems(
            doc,
            { line: 2, character: 75 },
            undefined,
            { triggerKind: vscodeMock.CompletionTriggerKind.Invoke },
        ));
        assert.deepEqual(choices.map(item => item.label), ['0', '-1', '1']);

        const lsPrePostValues = require("../../keywords/runtime/schema/field_data.json")
            .MAT_DAMAGE_1.c[1].find(field => field.n === 'FLAG').e;
        assert.ok(!lsPrePostValues.includes('10'));
        assert.ok(!lsPrePostValues.includes('11'));

        const ten = choices.find(item => item.label === '1');
        assert.equal(ten.insertText, '         1');
        assert.equal(ten.insertText.length, 10);
        assert.equal(ten.range.start.character, 70);
        assert.equal(ten.range.end.character, 80);
        assert.ok(!ten.documentation.value.includes('command:extension.openSemanticEvidence'));
        assert.ok(ten.documentation.value.includes(i18n.get('officialDocumentedValue')));
        assert.ok(ten.documentation.value.includes('Anisotropic damage'));

        } finally { ManualPackManager.prototype.peekCurrentAuthority = priorAuthority; }
});

    it('maps the same official choices to a TITLE alias only through its shifted physical card', async () => {
        const provider = new LsdynaFieldCompletionProvider();
        const doc = fakeDoc([
            '*MAT_DAMAGE_1_TITLE',
            'Engineer material title',
            ' '.repeat(80),
            ' '.repeat(80),
        ].join('\n'));

        const choices = officialChoices(await provider.provideCompletionItems(
            doc,
            { line: 3, character: 75 },
            undefined,
            { triggerKind: vscodeMock.CompletionTriggerKind.Invoke },
        ));
        assert.deepEqual(choices.map(item => item.label), ['0', '-1', '1']);
    });

    it('does not offer official choices when TITLE order conflicts with stale field headers', async () => {
        const provider = new LsdynaFieldCompletionProvider();
        const doc = fakeDoc([
            '*MAT_DAMAGE_1_TITLE',
            '$#     mid        ro         e        pr      sigy      lcss      lcds',
            ' '.repeat(80),
            '$#      q1        c1        q2        c2      epsd    espr/s        dc      flag',
            `${' '.repeat(70)}        -1`,
        ].join('\n'));

        const choices = officialChoices(await provider.provideCompletionItems(
            doc,
            { line: 4, character: 75 },
            undefined,
            { triggerKind: vscodeMock.CompletionTriggerKind.Invoke },
        ));
        assert.deepEqual(choices, []);
    });

    it('does not offer value replacements for parameterized, free-format, or long-format cards', async () => {
        const provider = new LsdynaFieldCompletionProvider();
        const invoke = { triggerKind: vscodeMock.CompletionTriggerKind.Invoke };
        const parameterDoc = fakeDoc([
            '*MAT_DAMAGE_1',
            ' '.repeat(80),
            `${' '.repeat(70)}     &FLAG`,
        ].join('\n'));
        const signedParameterDoc = fakeDoc([
            '*MAT_DAMAGE_1',
            ' '.repeat(80),
            `${' '.repeat(70)}    -&FLAG`,
        ].join('\n'));
        const freeFormatDoc = fakeDoc([
            '*MAT_DAMAGE_1',
            '0,0,0,0,0,0,0',
            '0,0,0,0,0,0,0,0',
        ].join('\n'));
        const longFormatDoc = fakeDoc([
            '*MAT_DAMAGE_1+',
            ' '.repeat(160),
            ' '.repeat(160),
        ].join('\n'));

        assert.equal(officialChoices(await provider.provideCompletionItems(
            parameterDoc, { line: 2, character: 78 }, undefined, invoke,
        )).length, 0);
        assert.equal(officialChoices(await provider.provideCompletionItems(
            signedParameterDoc, { line: 2, character: 78 }, undefined, invoke,
        )).length, 0);
        assert.equal(officialChoices(await provider.provideCompletionItems(
            freeFormatDoc, { line: 2, character: 7 }, undefined, invoke,
        )).length, 0);
        assert.equal(officialChoices(await provider.provideCompletionItems(
            longFormatDoc, { line: 2, character: 75 }, undefined, invoke,
        )).length, 0);
    });

    it('offers reviewed special values only on explicit invocation when native enums are absent', async () => {
        const provider = new LsdynaFieldCompletionProvider();
        const doc = fakeDoc([
            '*DAMPING_GLOBAL',
            ' '.repeat(80),
        ].join('\n'));

        const automatic = officialChoices(await provider.provideCompletionItems(
            doc,
            { line: 1, character: 5 },
            undefined,
            { triggerKind: vscodeMock.CompletionTriggerKind.TriggerCharacter },
        ));
        const explicit = officialChoices(await provider.provideCompletionItems(
            doc,
            { line: 1, character: 5 },
            undefined,
            { triggerKind: vscodeMock.CompletionTriggerKind.Invoke },
        ));

        assert.deepEqual(automatic, []);
        assert.deepEqual(explicit.map(item => item.label), ['0']);
        assert.equal(explicit[0].insertText, '         0');
        assert.equal(explicit[0].range.start.character, 0);
        assert.equal(explicit[0].range.end.character, 10);
    });

    it('rejects explicit official value completion for display-only CONTROL_THERMAL_TIMESTEP', async () => {
        const doc = fakeDoc(['*CONTROL_THERMAL_TIMESTEP', ' '.repeat(80)].join('\n'));
        const choices = officialChoices(await new LsdynaFieldCompletionProvider().provideCompletionItems(
            doc, { line: 1, character: 45 }, undefined,
            { triggerKind: vscodeMock.CompletionTriggerKind.Invoke }));
        assert.deepEqual(choices, []);
    });

    it('keeps mixed domains hidden when automatic quick suggestions make Invoke ambiguous', async () => {
        const provider = new LsdynaFieldCompletionProvider();
        const doc = fakeDoc([
            '*CONTROL_THERMAL_TIMESTEP',
            ' '.repeat(80),
        ].join('\n'));
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = (section) => ({
            get: (key, defaultValue) => section === 'editor' && key === 'quickSuggestions'
                ? { other: true, comments: false, strings: false }
                : defaultValue,
        });

        try {
            const choices = officialChoices(await provider.provideCompletionItems(
                doc,
                { line: 1, character: 45 },
                undefined,
                { triggerKind: vscodeMock.CompletionTriggerKind.Invoke },
            ));
            assert.deepEqual(choices, []);
            const closedEnumDoc = fakeDoc([
                '*MAT_DAMAGE_1',
                ' '.repeat(80),
                ' '.repeat(80),
            ].join('\n'));
            assert.deepEqual(officialChoices(await provider.provideCompletionItems(
                closedEnumDoc,
                { line: 2, character: 75 },
                undefined,
                { triggerKind: vscodeMock.CompletionTriggerKind.Invoke },
            )).map(item => item.label), ['0', '-1', '1']);
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        }
    });

    it('replaces only the selected fixed-width cell and preserves adjacent fields', async () => {
        const provider = new LsdynaFieldCompletionProvider();
        const original = `${'1'.repeat(20)}         9${'Z'.repeat(50)}`;
        const doc = fakeDoc([
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE',
            original,
        ].join('\n'));
        const choices = officialChoices(await provider.provideCompletionItems(
            doc,
            { line: 1, character: 25 },
            undefined,
            { triggerKind: vscodeMock.CompletionTriggerKind.Invoke },
        ));
        const axisTwo = choices.find(item => item.label === '2');
        const applied = original.slice(0, axisTwo.range.start.character) +
            axisTwo.insertText + original.slice(axisTwo.range.end.character);

        assert.equal(applied.length, original.length);
        assert.equal(applied.slice(0, 20), original.slice(0, 20));
        assert.equal(applied.slice(30), original.slice(30));
        assert.equal(applied.slice(20, 30), '         2');
    });

    it('keeps warm official value completion bounded near the end of a million-line indexed deck', async () => {
        const provider = new LsdynaFieldCompletionProvider();
        const filePath = '/project/million-line-field-choice.k';
        const lineCount = 1_000_000;
        const keywordLine = lineCount - 3;
        let lineAtCalls = 0;
        const document = {
            languageId: 'lsdyna',
            lineCount,
            version: 1,
            uri: { fsPath: filePath },
            lineAt(line) {
                lineAtCalls += 1;
                return {
                    text: line === 0 ? '*KEYWORD' : line === keywordLine ? '*MAT_DAMAGE_1' : ' '.repeat(80),
                };
            },
        };
        setFileIndexForTesting(filePath, {
            documentVersion: document.version,
            keywordBlocks: [{
                keyword: '*MAT_DAMAGE_1',
                startLine: keywordLine,
                endLine: lineCount - 1,
            }],
        });

        try {
            const position = { line: lineCount - 1, character: 75 };
            const context = { triggerKind: vscodeMock.CompletionTriggerKind.Invoke };
            for (let index = 0; index < 10; index++) {
                await provider.provideCompletionItems(document, position, undefined, context);
            }

            lineAtCalls = 0;
            const samples = [];
            for (let index = 0; index < 200; index++) {
                const started = performance.now();
                const choices = officialChoices(await provider.provideCompletionItems(
                    document, position, undefined, context,
                ));
                samples.push(performance.now() - started);
                assert.equal(choices.length, 3);
            }
            samples.sort((left, right) => left - right);
            const p95 = samples[Math.floor(samples.length * 0.95)];

            assert.ok(lineAtCalls < 4_000, `expected bounded line reads, got ${lineAtCalls}`);
            if (process.env.LSDYNA_CI_FUNCTIONAL_ONLY !== '1') assert.ok(p95 < 2, `expected warm completion P95 <2 ms, got ${p95.toFixed(3)} ms`);
        } finally {
            setFileIndexForTesting(filePath, null);
        }
    });
});

it('contributes the optional readonly LS-DYNA large-file editor', async () => {
        const manifest = require("../../package.json");
        const editor = manifest.contributes.customEditors.find(item =>
            item.viewType === 'lsdyna.largeFileViewer');
        assert.ok(editor);
        assert.equal(editor.priority, 'option');
        assert.deepEqual(editor.selector.map(item => item.filenamePattern), ['*.key', '*.k', '*.dyna']);
        assert.ok(manifest.activationEvents.includes('onCustomEditor:lsdyna.largeFileViewer'));
        assert.ok(manifest.contributes.commands.some(command =>
            command.command === 'extension.openLsdynaLargeFileViewer'));
    });


describe('staged Include tree publication', () => {
    it('shows the structure before the loader finishes and discards it after a document version change', async () => {
        const rootFile=path.resolve('stage-main.k');let finish;
        const snapshot={rootFile,graph:{toTree:()=>({filePath:rootFile,children:[]})}};
        const provider=new LsdynaIncludeTreeProvider({loadProjectSnapshot:async(_root,_options,progress)=>{
            progress({type:'structureReady',rootFile,snapshot});
            return new Promise(resolve=>finish=()=>resolve(snapshot));
        }});
        const originalEditor=vscodeMock.window.activeTextEditor,originalProgress=vscodeMock.window.withProgress;
        const originalLocation=vscodeMock.ProgressLocation;
        vscodeMock.ProgressLocation={Window:10,Notification:15};
        const document={version:1,isClosed:false,languageId:'lsdyna',uri:{fsPath:rootFile}};
        vscodeMock.window.activeTextEditor={document};
        vscodeMock.window.withProgress=async(_options,task)=>task({report(){}},{isCancellationRequested:false});
        try {
            const pending=provider.scan();
            assert.equal(provider.root.filePath,rootFile);assert.equal(provider.scanPhase,'references');
            document.version++;finish();
            assert.equal(await pending,null);assert.equal(provider.root,null);
        } finally {vscodeMock.window.activeTextEditor=originalEditor;vscodeMock.window.withProgress=originalProgress;vscodeMock.ProgressLocation=originalLocation;}
    });
});
