/**
 * @fileoverview Main entry point for the LS-DYNA VS Code extension.
 * @module extension
 * 
 * This file coordinates client-side VS Code features: registering document providers
 * (definition, reference, rename, hover, codelens, folding, document symbols, completions,
 * file decorations), launching the LSP background server, watching the workspace for file changes,
 * managing diagnostics reporting, and providing commands to navigate keywords and open manuals.
 * 
 * Role in System: Main extension process controller.
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const manualIndexer = require('./core/manualIndexer');
const keywordSchema = require('./core/keywordSchema');
const { ManualIndexRepository } = require('./manual/ManualIndexRepository');
const { ManualReaderPanel } = require('./manual/ManualReaderPanel');
const { ManualPackManager } = require('./manual/ManualPackManager');
const { ManualSidebarProvider } = require('./manual/ManualSidebarProvider');
const { LsdynaIncludeTreeProvider, normalizePathKey } = require('./client/providers/includeTreeProvider');
const { LsdynaKeywordIndexProvider } = require('./client/providers/keywordIndexProvider');
const { createIndexClient } = require('./client/services/indexClient');
const { createWorkspaceWatcherManager } = require('./client/services/workspaceWatcherManager');
const { createProjectDiagnosticStore } = require('./client/services/projectDiagnosticStore');
const { createHealthService, shouldShowHealthNotice } = require('./client/services/healthService');
const { showIncludeSearchPick, showKeywordSearchPick } = require('./client/services/treeSearchQuickPick');
const { createIncludePathSuggestTrigger } = require('./client/services/includePathSuggestTrigger');
const { createCardCellEditGuard } = require('./client/services/cardCellEditGuard');
const cardCellModel = require('./core/edit/cardCellModel');
const { createJumpPulseController } = require('./client/services/jumpPulse');
const { createChangeMarksController } = require('./client/changeMarks/changeMarksController');
const {
    normalizeCustomKeywordEntry,
    addCustomValidKeyword,
    addManyCustomValidKeywords,
    removeCustomValidKeyword,
    isCoveredByCustomList,
    suggestPrefixWildcard,
} = require('./client/services/customValidKeywords');
const { showManageCustomValidKeywordsPick } = require('./client/services/customValidKeywordsUi');
const { suggestSimilarKeywords } = require('./core/keywordSuggest');
const { LsdynaStatusBarDashboard } = require('./client/statusBar/dashboard');
const { openPdfWithSumatra } = require('./platform/externalProcess');
const { createDiskSnapshotStore } = require('./core/cache/diskSnapshotStore');
const { findAffectedProjectRoots } = require('./core/incremental/fileInvalidation');
const includeScanner = require('./core/parser/includeScanner');
const keywordScanner = require('./core/parser/keywordScanner');
const keywordValidator = require('./core/parser/keywordValidator');
const { classifyKeywordLine } = require('./core/parser/keywordLine');
const { scanParameterSymbols } = require('./core/parser/parameterScanner');
const { isValidParameterName } = require('./core/parser/parameterSyntax');
const pathCaseFidelity = require('./core/fs/pathCaseFidelity');
const includePathCompletion = require('./core/completion/includePathCompletion');
const { createWorkerPool } = require('./worker/workerPool');
const { createProjectIndexLoader } = require('./worker/projectIndexLoader');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const i18n = require('./core/i18n');
const {
    getFieldReferenceInfo,
    parseFieldReferenceValue,
} = require('./core/references/fieldReferenceClassifier');
const {
    buildProjectReferenceIndex,
    analyzeReference,
    analyzeParameterReferenceAtLocation,
    attachResolvedTableChildren,
} = require('./core/references/projectReferenceIndex');
const {
    createMainDeckContextSelector,
} = require('./core/project/mainDeckContextSelection');
const {
    buildReferenceHoverSection,
    buildDefinitionHoverSection,
    uncertaintyReasonLabel,
} = require('./core/references/fieldReferenceHover');
const { scanCurveTableDefinitionsFromFileIndex } = require('./core/references/curveTableDefinitionScanner');
const {
    selectFieldHelp,
    formatFieldHelpMarkdown,
    isShortEnglish,
} = require('./core/hover/fieldHelpPresentation');
const {
    stashFieldHelpEnglish,
    getFieldHelpEnglish,
} = require('./core/hover/fieldHelpEnglishStore');

/**
 * Starts a language client and registers one idempotent asynchronous disposer.
 *
 * @param {import('vscode-languageclient/node').LanguageClient} client - Client to start.
 * @param {import('vscode').ExtensionContext} context - Extension lifecycle owner.
 * @returns {Promise<import('vscode-languageclient/node').LanguageClient>} Started client.
 */
async function startLanguageClient(client, context) {
    let disposalPromise = null;
    const disposeOnce = () => {
        if (!disposalPromise) {
            disposalPromise = Promise.resolve()
                .then(() => client.dispose())
                .catch(error => {
                    console.error(
                        '[lsdyna] Failed to dispose the language client:',
                        error
                    );
                });
        }
        return disposalPromise;
    };

    context.subscriptions.push({
        dispose() {
            void disposeOnce();
        },
    });

    try {
        await client.start();
        return client;
    } catch (error) {
        await disposeOnce();
        throw error;
    }
}

/**
 * Launches the background language server as a separate node process via VS Code LanguageClient.
 *
 * @param {import('vscode').ExtensionContext} context - The extension context.
 * @returns {Promise<import('vscode-languageclient/node').LanguageClient>} Active LanguageClient instance.
 */
async function startLanguageServer(context) {
    const serverModule = path.join(__dirname, 'server', 'server.js');
    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

    const serverOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions },
    };

    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'lsdyna' }],
        initializationOptions: {
            globalStoragePath: context.globalStorageUri ? path.join(context.globalStorageUri.fsPath, 'project-snapshots') : null,
            maxCacheBytes: PROJECT_SNAPSHOT_DISK_CACHE_BYTES,
        },
    };

    const client = new LanguageClient(
        'lsdynaLanguageServer',
        'LS-DYNA Language Server',
        serverOptions,
        clientOptions
    );

    return startLanguageClient(client, context);
}

const LARGE_DOCUMENT_LINE_THRESHOLD = 100000;
const PROJECT_SNAPSHOT_DISK_CACHE_BYTES = 256 * 1024 * 1024;
const STREAM_SCAN_YIELD_INTERVAL = 50000;
const includeDirectiveCache = new WeakMap();
const activeFileIndexCache = new Map();
const activeProjectReferenceIndexCache = new Map();
const {
    createEffectiveSearchPathCache,
} = require('./core/project/effectiveSearchPathLookup');
/** Client-side cache of ancestor-aware search paths filled when a project snapshot loads. */
const activeEffectiveSearchPathCache = createEffectiveSearchPathCache();
/** Session-only, per-document main-deck choices for shared include files. */
const activeMainDeckContextSelector = createMainDeckContextSelector();
/** Active manual-pack lifecycle owner, shared with hover command construction. */
let manualPackManagerRef = null;

function getLsdynaConfigurationValue(key, defaultValue, resource = undefined) {
    const config = vscode.workspace.getConfiguration('lsdyna', resource);
    if (!config || typeof config.get !== 'function') {
        return defaultValue;
    }
    return config.get(key, defaultValue);
}

function getExtensionPath(context) {
    if (!context) return __dirname;
    if (context.extensionPath) return context.extensionPath;
    if (context.extensionUri && context.extensionUri.fsPath) return context.extensionUri.fsPath;
    if (typeof context.asAbsolutePath === 'function') {
        return path.resolve(context.asAbsolutePath('.'));
    }
    return __dirname;
}

function logDebug(message) {
    console.log(`[lsdyna] ${message}`);
}

function normalizeFileIndexKey(filePath) {
    const resolvedPath = path.resolve(filePath);
    return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function getFileIndexForDocument(document) {
    if (!document || !document.uri || !document.uri.fsPath) return null;
    return activeFileIndexCache.get(normalizeFileIndexKey(document.uri.fsPath)) || null;
}

function setFileIndexForTesting(filePath, fileIndex) {
    const key = normalizeFileIndexKey(filePath);
    if (!fileIndex) {
        activeFileIndexCache.delete(key);
        return;
    }
    activeFileIndexCache.set(key, fileIndex);
}

function cacheFileIndexesFromSnapshot(snapshot) {
    if (!snapshot || !snapshot.fileIndexes) return;
    const entries = snapshot.fileIndexes instanceof Map
        ? snapshot.fileIndexes.entries()
        : Object.entries(snapshot.fileIndexes);
    for (const [filePath, fileIndex] of entries) {
        if (!filePath || !fileIndex) continue;
        activeFileIndexCache.set(normalizeFileIndexKey(filePath), fileIndex);
    }
    // Also cache ancestor-aware *INCLUDE* search paths for editor resolve/completion.
    cacheEffectiveSearchPathsFromSnapshot(snapshot);
}

function cacheEffectiveSearchPathsFromSnapshot(snapshot) {
    activeEffectiveSearchPathCache.cacheFromSnapshot(snapshot);
}

function clearEffectiveSearchPathCacheForTesting() {
    activeEffectiveSearchPathCache.clearAll();
}

function clearEffectiveSearchPathsForRoot(rootFile) {
    if (!rootFile) return;
    activeEffectiveSearchPathCache.clearRoot(rootFile);
}

function normalizeSnapshotRootKey(rootFile) {
    return normalizeFileIndexKey(rootFile);
}

function cacheReferenceIndexFromSnapshot(snapshot) {
    if (!snapshot || !snapshot.rootFile) return;
    activeProjectReferenceIndexCache.set(normalizeSnapshotRootKey(snapshot.rootFile), {
        snapshot,
        referenceIndex: buildProjectReferenceIndex(snapshot),
    });
}

function clearReferenceIndexCacheForTesting() {
    activeProjectReferenceIndexCache.clear();
    activeMainDeckContextSelector.clearAll();
}

function clearReferenceIndexForRoot(rootFile) {
    if (!rootFile) return false;
    activeMainDeckContextSelector.clearRoot(rootFile);
    return activeProjectReferenceIndexCache.delete(normalizeSnapshotRootKey(rootFile));
}

function snapshotContainsDocument(snapshot, documentPath) {
    const documentKey = normalizeFileIndexKey(documentPath);
    return (snapshot.files || []).some(filePath => normalizeFileIndexKey(filePath) === documentKey);
}

function getContainingReferenceProjects(documentPath) {
    if (!documentPath) return [];
    return [...activeProjectReferenceIndexCache.values()]
        .filter(cached => snapshotContainsDocument(cached.snapshot, documentPath));
}

function getMainDeckContextForDocumentPath(documentPath) {
    if (!documentPath) {
        return activeMainDeckContextSelector.resolve('');
    }
    const documentKey = normalizeFileIndexKey(documentPath);
    return activeMainDeckContextSelector.resolve(documentPath, {
        exactProject: activeProjectReferenceIndexCache.get(documentKey) || null,
        containingProjects: getContainingReferenceProjects(documentPath),
    });
}

function setMainDeckContextForDocument(documentPath, rootFile) {
    return activeMainDeckContextSelector.select(
        documentPath,
        rootFile,
        getContainingReferenceProjects(documentPath)
    );
}

function clearMainDeckContextForDocument(documentPath) {
    return activeMainDeckContextSelector.clearDocument(documentPath);
}

function refreshMainDeckContextUi(documentPath = null) {
    if (statusDashboardRef && typeof statusDashboardRef.scheduleRefresh === 'function') {
        statusDashboardRef.scheduleRefresh();
    }
    if (documentPath &&
        projectDiagnosticStoreRef &&
        typeof projectDiagnosticStoreRef.refresh === 'function') {
        projectDiagnosticStoreRef.refresh(documentPath);
    }
}

async function handleSelectMainDeckContextCommand(
    arg: string | { documentPath?: string } = {}
) {
    const editor = vscode.window.activeTextEditor;
    const documentPath = typeof arg === 'string'
        ? arg
        : arg && arg.documentPath ||
            editor && editor.document && editor.document.uri && editor.document.uri.fsPath;
    if (!documentPath) return false;

    const context = getMainDeckContextForDocumentPath(documentPath);
    if (context.candidates.length < 2) {
        if (context.state === 'unavailable') {
            vscode.window.showInformationMessage(i18n.get('mainDeckContextUnavailable'));
            return false;
        }
        const rootName = context.rootFile ? path.basename(context.rootFile) : path.basename(documentPath);
        vscode.window.showInformationMessage(i18n.get('mainDeckContextNotAmbiguous', rootName));
        return false;
    }

    const clearItem = {
        action: 'clear',
        label: i18n.get('mainDeckContextClearLabel'),
        description: context.state === 'ambiguous'
            ? i18n.get('mainDeckContextClearAlreadyDescription')
            : i18n.get('mainDeckContextClearDescription'),
        detail: i18n.get('mainDeckContextClearDetail'),
    };
    const rootItems = context.candidates.map(candidate => {
        const rootFile = candidate.snapshot.rootFile;
        const selected = context.state === 'selected' &&
            normalizeSnapshotRootKey(rootFile) === normalizeSnapshotRootKey(context.rootFile);
        return {
            action: 'select',
            rootFile,
            label: `$(root-folder) ${path.basename(rootFile)}`,
            description: selected
                ? i18n.get('mainDeckContextCurrentDescription')
                : path.dirname(rootFile),
            detail: rootFile,
        };
    });
    const picked = await vscode.window.showQuickPick(
        [...rootItems, clearItem],
        {
            placeHolder: i18n.get('mainDeckContextPickPlaceHolder', path.basename(documentPath)),
            matchOnDescription: true,
            matchOnDetail: true,
        }
    );
    if (!picked) return false;

    if (picked.action === 'clear') {
        clearMainDeckContextForDocument(documentPath);
        refreshMainDeckContextUi(documentPath);
        vscode.window.showInformationMessage(i18n.get('mainDeckContextCleared'));
        return true;
    }
    if (!setMainDeckContextForDocument(documentPath, picked.rootFile)) {
        vscode.window.showWarningMessage(i18n.get('mainDeckContextSelectionExpired'));
        return false;
    }

    refreshMainDeckContextUi(documentPath);
    vscode.window.showInformationMessage(
        i18n.get('mainDeckContextSelected', path.basename(picked.rootFile))
    );
    return true;
}

function buildMainDeckContextHoverMarkdown(referenceIndexState, documentPath) {
    if (!referenceIndexState || !documentPath) return '';
    const isAmbiguous = referenceIndexState.projectContextAmbiguous === true;
    const isSelected = referenceIndexState.projectContextSelected === true;
    if (!isAmbiguous && !isSelected) return '';

    const args = encodeURIComponent(JSON.stringify([{ documentPath }]));
    const actionLabel = i18n.get(
        isSelected ? 'mainDeckContextChangeAction' : 'mainDeckContextChooseAction'
    );
    const action = `[$(root-folder) ${actionLabel}]` +
        `(command:extension.selectMainDeckContext?${args} "${actionLabel}")`;
    if (!isSelected) return action;

    const rootName = path.basename(referenceIndexState.rootFile || '');
    return `${i18n.get('mainDeckContextHoverSelected', rootName)} &nbsp;|&nbsp; ${action}`;
}

function buildParameterReferenceHoverMarkdown({
    parameterName,
    sourceDefinitions = [],
    effectiveAnalysis = null,
    mainDeckContextMarkdown = '',
}) {
    const lines = [`### $(symbol-variable) **&${parameterName}**`];
    for (const sourceDefinition of sourceDefinitions) {
        lines.push('', i18n.get(
            'parameterCurrentFileSourceDefinition',
            sourceDefinition.lineIndex + 1,
            sourceDefinition.value
        ));
    }
    if (sourceDefinitions.length > 0) {
        lines.push('', i18n.get('parameterSourceDefinitionOnly'));
    }
    if (effectiveAnalysis) {
        if (effectiveAnalysis.resolved) {
            lines.push('', i18n.get('parameterEffectiveValue', effectiveAnalysis.value));
        } else {
            lines.push('', i18n.get('parameterEffectiveValueUncertain'));
            for (const reason of [...new Set(effectiveAnalysis.reasons || [])]) {
                lines.push(`- ${uncertaintyReasonLabel(reason)}`);
            }
        }
    }
    if (mainDeckContextMarkdown) {
        lines.push('', mainDeckContextMarkdown);
    }
    return lines.join('\n');
}

function parseKeywordBlocksFromDocument(document) {
    const blocks = [];
    let currentBlock = null;
    const lineCount = document.lineCount;
    for (let i = 0; i < lineCount; i++) {
        const text = document.lineAt(i).text;
        const trimmed = text.trimStart();
        if (isKeywordLineText(text)) {
            if (currentBlock) {
                currentBlock.endLine = i - 1;
            }
            const cleanKw = trimmed.trim();
            const keyword = cleanKw.slice(1).toUpperCase().split(/[\s,$]/)[0];
            currentBlock = {
                filePath: document.uri.fsPath,
                keyword: '*' + keyword,
                rawKeyword: cleanKw,
                startOffset: 0,
                endOffset: 0,
                startLine: i,
                endLine: lineCount - 1,
            };
            blocks.push(currentBlock);
        }
    }
    return blocks;
}

async function getReferenceIndexForDocument(document) {
    if (!document || !document.uri || !document.uri.fsPath) {
        return null;
    }

    const mainDeckContext = getMainDeckContextForDocumentPath(document.uri.fsPath);
    if (mainDeckContext.project) {
        return {
            referenceIndex: mainDeckContext.project.referenceIndex,
            projectScoped: true,
            rootFile: mainDeckContext.rootFile,
            mainDeckContextState: mainDeckContext.state,
            projectContextSelected: mainDeckContext.state === 'selected',
            candidateRootFiles: mainDeckContext.candidates.map(candidate => candidate.snapshot.rootFile),
        };
    }

    let fileIndex = getFileIndexForDocument(document);
    if (!fileIndex || !fileIndex.referenceDefinitions) {
        try {
            const blocks = parseKeywordBlocksFromDocument(document);
            const referenceDefinitions = await scanCurveTableDefinitionsFromFileIndex(
                { filePath: document.uri.fsPath, keywordBlocks: blocks },
                (block) => {
                    const lines = [];
                    for (let i = block.startLine; i <= block.endLine; i++) {
                        lines.push(document.lineAt(i).text);
                    }
                    return Promise.resolve(lines.join('\n'));
                }
            );
            fileIndex = {
                filePath: document.uri.fsPath,
                keywordBlocks: blocks,
                referenceDefinitions,
            };
            activeFileIndexCache.set(normalizeFileIndexKey(document.uri.fsPath), fileIndex);
        } catch (e) {
            console.error('[lsdyna] Failed to dynamically build file index:', e);
            return null;
        }
    }
    const referenceIndex = buildProjectReferenceIndex({
            rootFile: document.uri.fsPath,
            files: [document.uri.fsPath],
            fileIndexes: new Map([[document.uri.fsPath, fileIndex]]),
        });
    if (mainDeckContext.state === 'ambiguous') {
        referenceIndex.completenessReasons.push('project-root-ambiguous');
    }
    return {
        referenceIndex,
        projectScoped: false,
        rootFile: document.uri.fsPath,
        mainDeckContextState: mainDeckContext.state,
        projectContextAmbiguous: mainDeckContext.state === 'ambiguous',
        candidateRootFiles: mainDeckContext.candidates.map(candidate => candidate.snapshot.rootFile),
    };
}

function resolveHoverAnalysis(
    referenceIndexState,
    referenceValue,
    referenceInfo,
    location: { documentPath?: string, lineIndex?: number } = {}
) {
    const referenceIndex = referenceIndexState && referenceIndexState.referenceIndex;
    const analysis = analyzeReference(
        referenceIndex,
        referenceValue,
        referenceInfo.targetKinds,
        {
            projectScoped: !!(referenceIndexState && referenceIndexState.projectScoped),
            documentPath: location.documentPath,
            lineIndex: location.lineIndex,
            targetDefinitions: referenceInfo.targetDefinitions,
        }
    );
    return {
        ...analysis,
        definitions: (analysis.definitions || []).map(definition =>
            definition.kind === 'table' && referenceIndex
                ? attachResolvedTableChildren(definition, referenceIndex, {
                    projectScoped: !!(referenceIndexState && referenceIndexState.projectScoped),
                })
                : definition
        ),
    };
}

// --- Folding ---

/**
 * Folding range provider to collapse individual keyword blocks (*KEYWORD) in LS-DYNA decks.
 * @implements {vscode.FoldingRangeProvider}
 */
class LsDynaFoldingProvider {
    /**
     * Resolves folding ranges for *KEYWORD blocks.
     * 
     * @param {import('vscode').TextDocument} document - Target document.
     * @returns {import('vscode').FoldingRange[]} Folding ranges.
     */
    provideFoldingRanges(document) {
        const fileIndex = getFileIndexForDocument(document);
        if (fileIndex && Array.isArray(fileIndex.keywordBlocks)) {
            return fileIndex.keywordBlocks
                .filter(block => block.endLine > block.startLine)
                .map(block => new vscode.FoldingRange(block.startLine, block.endLine));
        }

        if (shouldSkipAutomaticDocumentScan(document)) return [];

        const ranges = [];
        let foldStart = -1;

        for (let i = 0; i < document.lineCount; i++) {
            if (isKeywordLineText(document.lineAt(i).text)) {
                if (foldStart !== -1 && i - 1 > foldStart) {
                    ranges.push(new vscode.FoldingRange(foldStart, i - 1));
                }
                foldStart = i;
            }
        }

        if (foldStart !== -1 && document.lineCount - 1 > foldStart) {
            ranges.push(new vscode.FoldingRange(foldStart, document.lineCount - 1));
        }

        return ranges;
    }
}

// --- Symbol Provider ---

/**
 * Document symbol provider to list all *KEYWORD blocks in the outline views.
 * @implements {vscode.DocumentSymbolProvider}
 */
class LsdynaKeywordSymbolProvider {
    /**
     * Collects *KEYWORD occurrences as DocumentSymbol objects.
     * 
     * @param {import('vscode').TextDocument} document - Target document.
     * @returns {import('vscode').DocumentSymbol[]} Document symbols.
     */
    provideDocumentSymbols(document) {
        const fileIndex = getFileIndexForDocument(document);
        if (fileIndex && Array.isArray(fileIndex.keywordBlocks)) {
            return fileIndex.keywordBlocks.map(block => {
                const startChar = block.keywordStartChar || 0;
                const keyword = block.keyword || block.rawKeyword || '';
                const range = new vscode.Range(
                    block.startLine,
                    startChar,
                    block.startLine,
                    startChar + keyword.length
                );
                return new vscode.DocumentSymbol(
                    keyword,
                    '',
                    vscode.SymbolKind.Property,
                    range,
                    range
                );
            });
        }

        if (shouldSkipAutomaticDocumentScan(document)) return [];

        const symbols = [];
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            if (isKeywordLineText(line.text)) {
                symbols.push(new vscode.DocumentSymbol(
                    line.text.trim(),
                    '',
                    vscode.SymbolKind.Property,
                    line.range,
                    line.range
                ));
            }
        }
        return symbols;
    }
}

// --- Document Link Provider ---

/**
 * Document link provider for jumping to included files.
 * @implements {vscode.DocumentLinkProvider}
 */
class LsdynaDocumentLinkProvider {
    /**
     * Collects DocumentLinks for include files.
     * 
     * @param {import('vscode').TextDocument} document - Target document.
     * @returns {Promise<import('vscode').DocumentLink[]>} Document links.
     */
    provideDocumentLinks(document) {
        return collectIncludeDocumentLinks(document);
    }
}

// --- Helpers ---

/**
 * Scans includes in the document, caching the result by document version.
 * 
 * @param {import('vscode').TextDocument} document - Target document.
 * @returns {import('./core/parser/includeScanner').IncludeResult} include directive results.
 */
function getIncludeDirectiveData(document) {
    const version = document.version ?? null;
    const cached = includeDirectiveCache.get(document);
    if (cached && cached.version === version) {
        return cached.value;
    }

    const value = includeScanner.collectIncludeDirectivesFromLineReader(
        document.lineCount,
        i => document.lineAt(i).text,
        path.dirname(document.uri.fsPath)
    );

    includeDirectiveCache.set(document, { version, value });
    return value;
}

/**
 * Guard check to skip automatic parsing/diagnostics for very large files.
 * 
 * @param {import('vscode').TextDocument} document - Document to inspect.
 * @returns {boolean} True if size exceeds line threshold.
 */
function shouldSkipAutomaticDocumentScan(document) {
    if (!document) return false;
    if (getLsdynaConfigurationValue('largeFile.enableRendering', true, document.uri)) {
        return false;
    }
    return document.lineCount > LARGE_DOCUMENT_LINE_THRESHOLD;
}

/**
 * Resolves the URI of the currently active text editor or tab resource.
 * 
 * @returns {import('vscode').Uri|null} Active file URI.
 */
function getActiveUri() {
    const editor = vscode.window.activeTextEditor;
    if (editor) return editor.document.uri;
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (activeTab && activeTab.input) {
        const input = activeTab.input;
        if (input.uri) return input.uri;
        if (input.resource) return input.resource;
        if (input.modified) return input.modified;
        if (input.original) return input.original;
    }
    return null;
}

/**
 * Checks if a file URI represents an LS-DYNA file extension.
 * 
 * @param {import('vscode').Uri|null} uri - URI to inspect.
 * @returns {boolean} True if lsdyna extension.
 */
function isLsdynaUri(uri) {
    if (!uri) return false;
    const ext = path.extname(uri.fsPath).toLowerCase();
    const configExtensions = getLsdynaConfigurationValue('additionalExtensions', ['.k', '.key', '.dyna', '.asc']) || ['.k', '.key', '.dyna', '.asc'];
    const normalizedExtensions = configExtensions.map(e => {
        const trimmed = e.trim().toLowerCase();
        return trimmed.startsWith('.') ? trimmed : '.' + trimmed;
    });
    return normalizedExtensions.includes(ext);
}

/**
 * Checks if a TextDocument represents an LS-DYNA file.
 * 
 * @param {import('vscode').TextDocument|null} document - Document.
 * @returns {boolean} True if lsdyna file.
 */
function isLsdynaFile(document) {
    if (!document || !document.uri) return false;
    return isLsdynaUri(document.uri) || document.languageId === 'lsdyna';
}

function associateLsdynaLanguages() {
    vscode.workspace.textDocuments.forEach(doc => {
        if (isLsdynaUri(doc.uri) && doc.languageId !== 'lsdyna') {
            vscode.languages.setTextDocumentLanguage(doc, 'lsdyna').then(undefined, err => {
                console.error('[lsdyna] Failed to set text document language:', err);
            });
        }
    });
}

/**
 * Current pathCaseCheck mode for a document (or default).
 * @param {import('vscode').TextDocument|null} [document]
 * @returns {import('./core/fs/pathCaseFidelity').PathCaseCheckMode}
 */
function getIncludePathCaseCheckMode(document) {
    const resource = document && document.uri ? document.uri : undefined;
    return pathCaseFidelity.normalizePathCaseCheckMode(
        getLsdynaConfigurationValue('include.pathCaseCheck', 'crossPlatform', resource)
    );
}

/**
 * Scans document to construct clickable DocumentLinks targeting resolved includes.
 * In `strict` pathCaseCheck mode, casing mismatches do not produce file links.
 *
 * @param {import('vscode').TextDocument} document - Target document.
 * @param {{ mode?: string, resolveIncludeWithCaseCheck?: Function }} [options]
 * @returns {Promise<import('vscode').DocumentLink[]>} Link objects.
 */
async function collectIncludeDocumentLinks(document, options: any = {}) {
    if (!document || shouldSkipAutomaticDocumentScan(document)) return [];

    const mode = pathCaseFidelity.normalizePathCaseCheckMode(
        options.mode !== undefined ? options.mode : getIncludePathCaseCheckMode(document)
    );
    const resolveFn = options.resolveIncludeWithCaseCheck || resolveIncludeWithCaseCheckImpl;
    const searchPaths = getSearchPath(document);
    const includeFileLinks = [];

    for (const entry of findIncludeFileLines(document)) {
        try {
            const fullPath = searchFileFromPaths(entry.fileName, searchPaths);
            if (mode === 'strict') {
                const caseResult = await resolveFn(entry.fileName, searchPaths);
                if (!pathCaseFidelity.isIncludeResolveAccepted(caseResult, mode)) {
                    continue;
                }
            }
            for (const { lineIndex, startChar, endLineIndex, endChar } of includeScanner.getIncludeEntryRanges(entry)) {
                includeFileLinks.push(new vscode.DocumentLink(
                    new vscode.Range(lineIndex, startChar, endLineIndex, endChar),
                    vscode.Uri.file(fullPath)
                ));
            }
        } catch (e) {
            // missing on host FS
        }
    }

    const includePathLinks = [];
    for (const entry of (getIncludeDirectiveData(document).pathEntries || [])) {
        let targetPath = entry.searchPath || entry.pathName;
        if (!path.isAbsolute(targetPath)) {
            targetPath = path.resolve(path.dirname(document.uri.fsPath), targetPath);
        }
        try {
            if (!fs.existsSync(targetPath)) continue;
            if (mode === 'strict') {
                const baseDir = path.dirname(document.uri.fsPath);
                const caseResult = await resolveFn(entry.pathName, [baseDir]);
                if (!pathCaseFidelity.isIncludeResolveAccepted(caseResult, mode)) {
                    continue;
                }
            }
            const targetUri = vscode.Uri.parse(
                'command:extension.revealInExplorer?' +
                encodeURIComponent(JSON.stringify([{ resourceUri: vscode.Uri.file(targetPath) }]))
            );
            for (const { lineIndex, startChar, endLineIndex, endChar } of includeScanner.getIncludeEntryRanges(entry)) {
                const link = new vscode.DocumentLink(
                    new vscode.Range(lineIndex, startChar, endLineIndex, endChar),
                    targetUri
                );
                link.tooltip = i18n.get('revealInExplorer');
                includePathLinks.push(link);
            }
        } catch (e) {
            // ignore
        }
    }

    return [...includeFileLinks, ...includePathLinks];
}

/**
 * Scans lines exceeding 80 characters (excluding comments) to flag them as warnings.
 * 
 * @param {import('vscode').TextDocument} document - Target document.
 * @returns {import('vscode').Diagnostic[]} Diagnostics list.
 */
function collectLineLengthDiagnostics(document) {
    if (!document || !isLsdynaFile(document) || shouldSkipAutomaticDocumentScan(document)) return [];

    const issues = [];
    // LS-DYNA ignores everything after *END; do not flag long lines past it.
    const scanUpperBound = Math.min(document.lineCount, keywordValidator.findEndDirectiveLine(document) + 1);
    for (let i = 0; i < scanUpperBound; i++) {
        const line = document.lineAt(i);
        if (line.text.startsWith('$') || line.text.length <= 80) {
            continue;
        }
        const cardInfo = keywordSchema.getCardInfoForDocumentLine(document, i, getFieldData());
        if (!cardInfo?.isTextCard) {
            issues.push(new vscode.Diagnostic(
                new vscode.Range(i, 80, i, line.text.length),
                i18n.get('lineExceeds80Characters', line.text.length),
                vscode.DiagnosticSeverity.Warning
            ));
        }
    }
    return issues;
}

/**
 * Constructs path-style ranges plus one trailing indicator for each missing include.
 * Resolved ranges are retained for callers that need resolution metadata, but
 * their visible affordance is supplied solely by the DocumentLink provider.
 * In `strict` pathCaseCheck mode, casing mismatches decorate as missing.
 *
 * @param {import('vscode').TextDocument} document - Target document.
 * @param {{ mode?: string, resolveIncludeWithCaseCheck?: Function }} [options]
 * @returns {Promise<{
 *   resolved: import('vscode').DecorationOptions[],
 *   missing: import('vscode').DecorationOptions[],
 *   missingIndicators: import('vscode').DecorationOptions[]
 * }>}
 */
async function collectIncludeDecorationSets(document, options: any = {}) {
    if (!document || !isLsdynaFile(document) || shouldSkipAutomaticDocumentScan(document)) {
        return { resolved: [], missing: [], missingIndicators: [] };
    }

    const mode = pathCaseFidelity.normalizePathCaseCheckMode(
        options.mode !== undefined ? options.mode : getIncludePathCaseCheckMode(document)
    );
    const resolveFn = options.resolveIncludeWithCaseCheck || resolveIncludeWithCaseCheckImpl;
    const searchPaths = getSearchPath(document);
    const resolved = [];
    const missing = [];
    const missingIndicators = [];

    for (const entry of findIncludeFileLines(document)) {
        const entryRanges = includeScanner.getIncludeEntryRanges(entry);
        const ranges = entryRanges
            .map(({ lineIndex, startChar, endLineIndex, endChar }) => ({
                range: new vscode.Range(lineIndex, startChar, endLineIndex, endChar),
            }));
        const markMissing = () => {
            const hoverMessage = i18n.get('includeDecorationMissingLocal', entry.fileName);
            missing.push(...ranges.map(item => ({ ...item, hoverMessage })));
            const last = entryRanges[entryRanges.length - 1];
            if (!last) return;
            missingIndicators.push({
                range: new vscode.Range(
                    last.endLineIndex,
                    last.endChar,
                    last.endLineIndex,
                    last.endChar
                ),
                hoverMessage,
            });
        };
        try {
            searchFileFromPaths(entry.fileName, searchPaths);
            if (mode === 'strict') {
                const caseResult = await resolveFn(entry.fileName, searchPaths);
                if (!pathCaseFidelity.isIncludeResolveAccepted(caseResult, mode)) {
                    markMissing();
                    continue;
                }
            }
            resolved.push(...ranges);
        } catch (e) {
            markMissing();
        }
    }

    return { resolved, missing, missingIndicators };
}

/**
 * Creates include-specific editor decorations without using the glyph margin.
 * The warning attachment is spatially independent from session change marks.
 */
function createIncludeDecorationTypes(vscodeApi) {
    const warningColor = new vscodeApi.ThemeColor('editorWarning.foreground');
    return {
        missingPathDecoration: vscodeApi.window.createTextEditorDecorationType({
            color: warningColor,
            fontStyle: 'italic',
        }),
        missingIndicatorDecoration: vscodeApi.window.createTextEditorDecorationType({
            after: {
                contentText: ' !',
                color: warningColor,
                fontWeight: 'bold',
                margin: '0 0 0 0.35em',
            },
        }),
        keywordDecoration: vscodeApi.window.createTextEditorDecorationType({
            fontWeight: 'bold',
        }),
    };
}

function createLatestDocumentRequestGuard() {
    const requests = new WeakMap();
    return {
        begin(document) {
            const requestId = (requests.get(document) || 0) + 1;
            requests.set(document, requestId);
            return requestId;
        },
        isLatest(document, requestId) {
            return requests.get(document) === requestId;
        },
    };
}

function collectKeywordDecorationRanges(document) {
    if (!document || !isLsdynaFile(document) || shouldSkipAutomaticDocumentScan(document)) {
        return [];
    }

    const ranges = [];
    for (let i = 0; i < document.lineCount; i++) {
        const text = document.lineAt(i).text;
        const match = text.match(/^(\s*)(\*[^\s,$]+)/);
        if (match) {
            const startChar = match[1].length;
            const keywordLength = match[2].length;
            ranges.push(new vscode.Range(i, startChar, i, startChar + keywordLength));
        }
    }
    return ranges;
}

/**
 * Checks if the specified line index falls within any include file card definition.
 * 
 * @param {import('vscode').TextDocument} document - Document.
 * @param {number} currentLine - Line number to check.
 * @returns {boolean} True if is on include declaration line.
 */
function isIncludeLine(document, currentLine) {
    if (!document || !isLsdynaFile(document) || shouldSkipAutomaticDocumentScan(document)) {
        return false;
    }

    return findIncludeFileLines(document)
        .some(entry => includeScanner.includeEntryContainsLine(entry, currentLine));
}

/**
 * Returns raw include scan entries for the document.
 * 
 * @param {import('vscode').TextDocument} document - Document.
 * @returns {import('./core/parser/includeScanner').IncludeEntry[]} include entry lists.
 */
function findIncludeFileLines(document) {
    return getIncludeDirectiveData(document).includeEntries;
}

// --- Parameter helpers ---

/**
 * Scans parameters (*PARAMETER...) defined in a document, cataloging their details.
 * 
 * @param {import('vscode').TextDocument} document - Document to scan.
 * @returns {Map<string, Array<{ lineIndex: number, startChar: number, length: number, name: string, value: string }>>} Parameter definitions grouped by name.
 */
function findParameterDefinitions(document) {
    if (shouldSkipAutomaticDocumentScan(document)) return new Map();
    return scanParameterSymbols(
        document.lineCount,
        lineIndex => document.lineAt(lineIndex).text,
    ).definitions;
}

/**
 * Scans parameters referenced via '&name' or bare names inside expressions.
 * 
 * @param {import('vscode').TextDocument} document - Document to scan.
 * @returns {Array<{
 *   name: string,
 *   lineIndex: number,
 *   startChar: number,
 *   length: number,
 *   nameStartChar: number,
 *   nameLength: number,
 *   syntax: 'ampersand'|'bare'
 * }>} Reference locations list.
 */
function findParameterReferences(document) {
    if (shouldSkipAutomaticDocumentScan(document)) return [];
    return scanParameterSymbols(
        document.lineCount,
        lineIndex => document.lineAt(lineIndex).text,
    ).references;
}

/**
 * Finds the parameter name and token range under the cursor position.
 * 
 * @param {import('vscode').TextDocument} document - Target document.
 * @param {import('vscode').Position} position - Editor position.
 * @returns {{ name: string, range: import('vscode').Range }|null} Active parameter token, or null.
 */
function getParameterAtCursor(document, position) {
    if (shouldSkipAutomaticDocumentScan(document)) return null;
    const symbols = scanParameterSymbols(
        document.lineCount,
        lineIndex => document.lineAt(lineIndex).text,
    );
    for (const definition of symbols.definitionList) {
        if (definition.lineIndex !== position.line) continue;
        const endChar = definition.startChar + definition.length;
        if (position.character >= definition.startChar && position.character < endChar) {
            const range = new vscode.Range(
                position.line,
                definition.startChar,
                position.line,
                endChar,
            );
            return {
                name: definition.name,
                range,
                fullRange: range,
                kind: 'definition',
            };
        }
    }
    for (const reference of symbols.references) {
        if (reference.lineIndex !== position.line) continue;
        const fullEndChar = reference.startChar + reference.length;
        if (position.character < reference.startChar || position.character >= fullEndChar) continue;
        const nameRange = new vscode.Range(
            position.line,
            reference.nameStartChar,
            position.line,
            reference.nameStartChar + reference.nameLength,
        );
        return {
            name: document.lineAt(position.line).text.slice(
                reference.nameStartChar,
                reference.nameStartChar + reference.nameLength,
            ),
            range: nameRange,
            fullRange: new vscode.Range(
                position.line,
                reference.startChar,
                position.line,
                fullEndChar,
            ),
            kind: 'reference',
            syntax: reference.syntax,
        };
    }
    return null;
}

// --- Parameter providers ---

/**
 * Provider to support 'Go to Definition' command for parameter names.
 * @implements {vscode.DefinitionProvider}
 */
class LsdynaDefinitionProvider {
    /**
     * Resolves parameter definition target location.
     * 
     * @param {import('vscode').TextDocument} document - Document.
     * @param {import('vscode').Position} position - Position.
     * @returns {import('vscode').Location|null} definition destination.
     */
    provideDefinition(document, position) {
        const param = getParameterAtCursor(document, position);
        if (!param) return null;
        const definitions = findParameterDefinitions(document).get(param.name.toUpperCase()) || [];
        const locations = definitions.map(definition =>
            new vscode.Location(
                document.uri,
                new vscode.Range(
                    definition.lineIndex,
                    definition.startChar,
                    definition.lineIndex,
                    definition.startChar + definition.length,
                ),
            )
        );
        if (locations.length === 0) return null;
        return locations.length === 1 ? locations[0] : locations;
    }
}

/**
 * Provider to support 'Find All References' command for parameter names.
 * @implements {vscode.ReferenceProvider}
 */
class LsdynaReferenceProvider {
    /**
     * Gathers all parameter usage references.
     * 
     * @param {import('vscode').TextDocument} document - Document.
     * @param {import('vscode').Position} position - Position.
     * @param {import('vscode').ReferenceContext} context - Reference options.
     * @returns {import('vscode').Location[]} References.
     */
    provideReferences(document, position, context) {
        const param = getParameterAtCursor(document, position);
        if (!param) return [];
        const nameUpper = param.name.toUpperCase();
        const locations = [];

        if (context.includeDeclaration) {
            const definitions = findParameterDefinitions(document).get(nameUpper) || [];
            for (const def of definitions) {
                locations.push(new vscode.Location(document.uri,
                    new vscode.Range(def.lineIndex, def.startChar, def.lineIndex, def.startChar + def.length)));
            }
        }

        for (const ref of findParameterReferences(document)) {
            if (ref.name === nameUpper) {
                locations.push(new vscode.Location(document.uri,
                    new vscode.Range(ref.lineIndex, ref.startChar, ref.lineIndex, ref.startChar + ref.length)));
            }
        }
        return locations;
    }
}

/**
 * Rename provider enabling parameter renaming (F2) throughout a document.
 * @implements {vscode.RenameProvider}
 */
class LsdynaRenameProvider {
    /**
     * Validates if renaming can occur under cursor.
     * 
     * @param {import('vscode').TextDocument} document - Document.
     * @param {import('vscode').Position} position - Position.
     * @returns {import('vscode').Range} Renamable token range.
     */
    prepareRename(document, position) {
        const param = getParameterAtCursor(document, position);
        if (!param) throw new Error(i18n.get('cannotRenameSymbol'));
        return param.range;
    }

    /**
     * Resolves WorkspaceEdits replacing parameter definitions and references.
     * 
     * @param {import('vscode').TextDocument} document - Document.
     * @param {import('vscode').Position} position - Position.
     * @param {string} newName - Target name.
     * @returns {import('vscode').WorkspaceEdit|null} Renamed workspace edits.
     */
    provideRenameEdits(document, position, newName) {
        const param = getParameterAtCursor(document, position);
        if (!param) return null;
        const replacementName = typeof newName === 'string' ? newName : '';
        if (
            !isValidParameterName(replacementName)
        ) {
            throw new Error(i18n.get('invalidParameterName'));
        }
        const nameUpper = param.name.toUpperCase();
        const edit = new vscode.WorkspaceEdit();

        const definitions = findParameterDefinitions(document).get(nameUpper) || [];
        for (const def of definitions) {
            edit.replace(document.uri,
                new vscode.Range(def.lineIndex, def.startChar, def.lineIndex, def.startChar + def.length),
                replacementName);
        }

        for (const ref of findParameterReferences(document)) {
            if (ref.name === nameUpper) {
                edit.replace(document.uri,
                    new vscode.Range(
                        ref.lineIndex,
                        ref.nameStartChar,
                        ref.lineIndex,
                        ref.nameStartChar + ref.nameLength,
                    ),
                    replacementName);
            }
        }
        return edit;
    }
}

// ---------------------------------------------------------------------------
// Keyword field hover
// ---------------------------------------------------------------------------

let _fieldData = null;
let _fieldDataLanguage = null;

/**
 * Loads keyword card field descriptors dictionary (field_data.json) from folder lazily.
 * Reloads when UI language changes so zh-cn merge vs English schema stay in sync.
 *
 * @returns {Object} Keyword fields schema data.
 */
function getFieldData() {
    const language = i18n.getLanguage();
    if (!_fieldData || _fieldDataLanguage !== language) {
        _fieldData = keywordSchema.loadKeywordSchema(() => language);
        if (!_fieldData) _fieldData = {};
        _fieldDataLanguage = language;
    }
    return _fieldData;
}

/**
 * Builds field help markdown for hover/completion, with zh-primary layout when UI is Chinese.
 *
 * @param {{ h?: string, n?: string, p?: number }} field
 * @returns {string} Markdown fragment (no leading blank lines); empty if no help.
 */
function buildFieldHelpMarkdown(field) {
    if (!field || !field.h) return '';
    const language = i18n.getLanguage();
    const localizedHelp = language === 'zh-cn'
        ? keywordSchema.getLocalizedFieldHelp(field)
        : null;
    const parts = selectFieldHelp(field.h, localizedHelp, language);
    const summaryLabel = i18n.get('fieldHelpEnglishOriginal');
    if (parts.secondary && !isShortEnglish(parts.secondary)) {
        const id = stashFieldHelpEnglish(parts.secondary);
        return formatFieldHelpMarkdown(parts, {
            summaryLabel,
            englishCommandHref:
                `command:extension.showFieldHelpEnglish?${encodeURIComponent(JSON.stringify([id]))}`,
        });
    }
    return formatFieldHelpMarkdown(parts, { summaryLabel });
}

/**
 * Searches the schema dictionary for a keyword definition, supporting aliases and variants.
 * 
 * @param {string} name - Keyword string.
 * @returns {Object|null} Schema lookup descriptor, or null.
 */
function lookupKeywordInfo(name) {
    return keywordSchema.lookupKeywordSchema(name, getFieldData());
}

function lookupKeyword(name) {
    const lookup = lookupKeywordInfo(name);
    return lookup ? lookup.entry : null;
}

/**
 * Assembles Markdown text summarizing card structure for a keyword hover card.
 * 
 * @param {string} kwName - Keyword name.
 * @param {Object} entry - Schema definition entry.
 * @returns {string} Markdown text.
 */
function keywordHoverMarkdown(kwName, entry, activeOptions = []) {
    const cards = keywordSchema.getRenderedCards(entry, activeOptions);
    const lines = [`### $(symbol-keyword) **\\*${kwName}**\n\n---\n`];
    let cardNum = 1;
    
    const tableHeader = `| Card | 1-10 | 11-20 | 21-30 | 31-40 | 41-50 | 51-60 | 61-70 | 71-80 |`;
    const tableSeparator = `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |`;
    const tableRows = [];

    for (const card of cards) {
        if (!card.length) continue;
        const isWide = card.length === 1 && card[0].w >= 40;
        if (isWide) {
            tableRows.push(`| **${cardNum}** | \`${card[0].n}\` | *(Title)* | | | | | | |`);
        } else {
            const rowCells = Array(8).fill('');
            for (const f of card) {
                const bin = Math.floor(f.p / 10);
                if (bin >= 0 && bin < 8) {
                    rowCells[bin] = `\`${f.n}\``;
                    if (f.w > 10) {
                        const spanBins = Math.round(f.w / 10);
                        for (let i = 1; i < spanBins; i++) {
                            if (bin + i < 8) rowCells[bin + i] = `→`;
                        }
                    }
                }
            }
            tableRows.push(`| **${cardNum}** | ${rowCells.join(' | ')} |`);
        }
        cardNum++;
    }

    if (tableRows.length > 0) {
        lines.push(tableHeader);
        lines.push(tableSeparator);
        lines.push(...tableRows);
        lines.push('');
    }

    if (entry.r) lines.push('*(✨ Last card repeats for each data row)*\n');
    if (entry.o && entry.o.length) {
        const options = entry.o.map(option => `\`${option.n}\``);
        lines.push(`**$(gear) Available Options:**\n${options.join(' • ')}`);
    }
    return lines.join('\n');
}

function normalizeOptionName(name) {
    return String(name || '').trim().toUpperCase();
}

function parseKeywordOptionOrder(option) {
    const [position, rawIndex] = String(option && option.co || '').split('/');
    const index = Number.parseInt(rawIndex, 10);
    return {
        position,
        index: Number.isFinite(index) ? index : 0,
    };
}

function titleKeywordOptions(entry) {
    return (entry.o || [])
        .filter(option => (option.to || 0) > 0)
        .sort((a, b) => (a.to || 0) - (b.to || 0));
}

function postKeywordOptions(entry) {
    return (entry.o || [])
        .filter(option => parseKeywordOptionOrder(option).position === 'post')
        .sort((a, b) => parseKeywordOptionOrder(a).index - parseKeywordOptionOrder(b).index);
}

function keywordOptionCardCount(options) {
    return options.reduce((count, option) => count + (option.c || []).length, 0);
}

function keywordOptionCardSkeleton(card) {
    if (!card || card.length === 0) return '';
    const lastField = card[card.length - 1];
    const width = (lastField.p || 0) + (lastField.w || 0);
    if (card.length === 1 && width >= 40) return '';
    return ' '.repeat(Math.max(0, width));
}

function keywordOptionCards(options) {
    const cards = [];
    for (const option of options) {
        for (const card of option.c || []) {
            cards.push(card);
        }
    }
    return cards;
}

function managedCommentLineForCard(card) {
    return generateCommentLine(card).toLowerCase();
}

function strictCommentKey(text) {
    return String(text || '').trimEnd().toLowerCase();
}

function strictCommentTextForCard(card) {
    return strictCommentKey(managedCommentLineForCard(card));
}

function isStrictManagedCommentForCard(text, card) {
    return strictCommentKey(text) === strictCommentTextForCard(card);
}

function keywordOptionManagedLines(options, startCardIndex = 0) {
    const lines = [];
    for (const card of keywordOptionCards(options).slice(startCardIndex)) {
        lines.push(managedCommentLineForCard(card));
        lines.push(keywordOptionCardSkeleton(card));
    }
    return lines;
}

function keywordOptionRangeLabel(options, count) {
    if (count <= 0) return i18n.get('keywordOptionNone');
    const names = options.slice(0, count).map(option => normalizeOptionName(option.n));
    const singleLetters = names.every(name => /^[A-Z]$/.test(name));
    if (singleLetters && names.length > 1) {
        return `${names[0]}-${names[names.length - 1]}`;
    }
    return names.join(', ');
}

function keywordOptionSummary(entry) {
    const titleNames = titleKeywordOptions(entry).map(option => normalizeOptionName(option.n));
    const postOptions = postKeywordOptions(entry);
    const parts = [];
    if (titleNames.length) parts.push(titleNames.join(', '));
    if (postOptions.length) parts.push(keywordOptionRangeLabel(postOptions, postOptions.length));
    return parts.join(', ');
}

function keywordLineNameFromText(text) {
    const classification = classifyKeywordLine(String(text || ''));
    return classification.isKeyword ? classification.normalizedKeyword.slice(1) : '';
}

function collectIncludePathLengthDiagnostics(document) {
    if (!document || !isLsdynaFile(document) || shouldSkipAutomaticDocumentScan(document)) return [];

    const data = getIncludeDirectiveData(document);
    const endLine = keywordValidator.findEndDirectiveLine(document);
    const entries = [
        ...(data.includeEntries || []).map(entry => ({ ...entry, value: entry.fileName })),
        ...(data.pathEntries || []).map(entry => ({ ...entry, value: entry.pathName })),
    ];
    return entries
        // LS-DYNA stops reading at *END; includes parked after it are not live.
        .filter(entry => entry.lineIndex < endLine)
        .filter(entry => entry.value.length > 236)
        .map(entry => {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(entry.lineIndex, entry.startChar, entry.endLineIndex, entry.endChar),
                i18n.get('includePathTooLong', entry.value.length, 236),
                vscode.DiagnosticSeverity.Error
            );
            diagnostic.code = 'include-path-too-long';
            diagnostic.source = 'lsdyna';
            return diagnostic;
        });
}

/** @type {typeof pathCaseFidelity.resolveIncludeWithCaseCheck} */
let resolveIncludeWithCaseCheckImpl = pathCaseFidelity.resolveIncludeWithCaseCheck;

/**
 * Test seam for include path case checks.
 * @param {typeof pathCaseFidelity.resolveIncludeWithCaseCheck|null} fn
 */
function setResolveIncludeWithCaseCheckForTesting(fn) {
    resolveIncludeWithCaseCheckImpl = fn || pathCaseFidelity.resolveIncludeWithCaseCheck;
}

function buildIncludePathCaseEdits(document, entry, correctedPath) {
    const segments = Array.isArray(entry && entry.segments) && entry.segments.length
        ? entry.segments
        : [{
            lineIndex: entry.lineIndex,
            startChar: entry.startChar,
            endChar: entry.endChar,
        }];
    const sourceParts = [];
    const editParts = [];

    for (const segment of segments) {
        const range = new vscode.Range(
            segment.lineIndex,
            segment.startChar,
            segment.lineIndex,
            segment.endChar,
        );
        const sourceText = document.getText(range);
        const continued = sourceText.endsWith(' +');
        const logicalText = continued ? sourceText.slice(0, -2) : sourceText;
        sourceParts.push(logicalText);
        editParts.push({ range, sourceText, logicalText, continued });
    }

    const originalLogical = sourceParts.join('');
    const expectedLogical = String(entry.fileName || entry.pathName || '');
    const replacementLogical = String(correctedPath || '');
    if (
        originalLogical !== expectedLogical ||
        originalLogical.length !== replacementLogical.length
    ) {
        return [];
    }

    let offset = 0;
    return editParts.map(part => {
        const replacementPart = replacementLogical.slice(
            offset,
            offset + part.logicalText.length,
        );
        offset += part.logicalText.length;
        return {
            range: part.range,
            sourceText: part.sourceText,
            replacementText: replacementPart + (part.continued ? ' +' : ''),
        };
    });
}

/**
 * Diagnostics when deck path casing differs from disk (Win→Linux risk).
 *
 * @param {import('vscode').TextDocument} document
 * @param {{ mode?: string, resolveIncludeWithCaseCheck?: Function }} [options]
 * @returns {Promise<import('vscode').Diagnostic[]>}
 */
async function collectIncludePathCaseDiagnostics(document, options: any = {}) {
    if (!document || !isLsdynaFile(document) || shouldSkipAutomaticDocumentScan(document)) return [];

    const mode = pathCaseFidelity.normalizePathCaseCheckMode(
        options.mode !== undefined
            ? options.mode
            : getLsdynaConfigurationValue('include.pathCaseCheck', 'crossPlatform', document.uri)
    );
    if (mode === 'off') return [];

    const resolveFn = options.resolveIncludeWithCaseCheck || resolveIncludeWithCaseCheckImpl;
    const data = getIncludeDirectiveData(document);
    const searchPaths = data.searchPaths || [path.dirname(document.uri.fsPath)];
    const baseDir = path.dirname(document.uri.fsPath);
    const severity = mode === 'strict'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;

    const work = [];

    for (const entry of data.includeEntries || []) {
        work.push({
            entry,
            value: entry.fileName,
            paths: searchPaths,
        });
    }
    for (const entry of data.pathEntries || []) {
        // Relative path cards resolve against the deck directory; absolute uses dirname walk root.
        work.push({
            entry,
            value: entry.pathName,
            paths: [baseDir],
        });
    }

    const diagnostics = [];
    for (const item of work) {
        if (!item.value) continue;
        let result;
        try {
            result = await resolveFn(item.value, item.paths);
        } catch (_error) {
            continue;
        }
        if (!result || result.status !== 'case-mismatch') continue;

        const deckLabel = result.deckRelative || item.value;
        const diskLabel = result.diskRelative || result.realPath;
        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(item.entry.lineIndex, item.entry.startChar, item.entry.endLineIndex, item.entry.endChar),
            i18n.get('includePathCaseMismatch', deckLabel, diskLabel),
            severity
        );
        diagnostic.code = 'include-path-case-mismatch';
        diagnostic.source = 'lsdyna';
        diagnostic.includePathCase = {
            deckRelative: deckLabel,
            diskRelative: diskLabel,
            resolvedPath: result.resolvedPath,
            realPath: result.realPath,
            edits: buildIncludePathCaseEdits(document, item.entry, diskLabel),
        };
        diagnostics.push(diagnostic);
    }
    return diagnostics;
}

/**
 * Updates document-local diagnostics (line length, path limits, case fidelity, keywords).
 *
 * @param {import('vscode').TextDocument} document
 * @param {import('vscode').DiagnosticCollection} diagnostics
 * @param {{ mode?: string, resolveIncludeWithCaseCheck?: Function }} [options]
 * @returns {Promise<void>}
 */
async function updateDocumentDiagnostics(document, diagnostics, options: any = {}) {
    if (!isLsdynaFile(document)) {
        diagnostics.delete(document.uri);
        return;
    }
    const lineLengthDiagnostics = collectLineLengthDiagnostics(document);
    const includePathLengthDiagnostics = collectIncludePathLengthDiagnostics(document);
    const keywordValidationDiagnostics = keywordValidator.collectKeywordValidationDiagnostics(
        document,
        shouldSkipAutomaticDocumentScan
    );
    const includePathCaseDiagnostics = await collectIncludePathCaseDiagnostics(document, options);
    diagnostics.set(document.uri, [
        ...lineLengthDiagnostics,
        ...includePathLengthDiagnostics,
        ...includePathCaseDiagnostics,
        ...keywordValidationDiagnostics,
    ]);
}

function isKeywordLineText(text) {
    return classifyKeywordLine(String(text || '')).isKeyword;
}

function findKeywordLineForLine(document, lineNum) {
    for (let index = Math.min(lineNum, document.lineCount - 1); index >= 0; index--) {
        if (isKeywordLineText(document.lineAt(index).text)) return index;
    }
    return null;
}

function findKeywordBlockEnd(document, keywordLine) {
    for (let index = keywordLine + 1; index < document.lineCount; index++) {
        if (isKeywordLineText(document.lineAt(index).text)) return index;
    }
    return document.lineCount;
}

function collectKeywordDataLines(document, keywordLine, blockEnd) {
    const lines = [];
    for (let index = keywordLine + 1; index < blockEnd; index++) {
        const text = document.lineAt(index).text;
        if (text.trimStart().startsWith('$')) continue;
        lines.push({ line: index, text });
    }
    return lines;
}

function buildKeywordLineWithTitleOptions(originalLine, canonicalName, selectedTitleNames) {
    const match = String(originalLine || '').match(/^(\s*)\*([A-Za-z0-9_+\-]+)(.*)$/);
    const suffix = selectedTitleNames.length ? `_${selectedTitleNames.join('_')}` : '';
    if (!match) return `*${canonicalName}${suffix}`;
    return `${match[1]}*${canonicalName}${suffix}${match[3] || ''}`;
}

function lineWholeRange(document, lineNum) {
    const lineText = document.lineAt(lineNum).text;
    return new vscode.Range(lineNum, 0, lineNum, lineText.length);
}

function insertLinesAt(editBuilder, document, lineNum, lines) {
    if (!lines || lines.length === 0) return;
    if (lineNum >= document.lineCount) {
        const lastLine = Math.max(0, document.lineCount - 1);
        const lastText = document.lineAt(lastLine).text;
        editBuilder.insert(new vscode.Position(lastLine, lastText.length), '\n' + lines.join('\n'));
        return;
    }
    editBuilder.insert(new vscode.Position(lineNum, 0), lines.join('\n') + '\n');
}

function removeLineRange(editBuilder, document, startLine, count) {
    if (count <= 0) return;
    const endLine = Math.min(document.lineCount, startLine + count);
    if (endLine < document.lineCount) {
        editBuilder.replace(new vscode.Range(startLine, 0, endLine, 0), '');
    } else if (startLine > 0) {
        const previousText = document.lineAt(startLine - 1).text;
        const lastText = document.lineAt(endLine - 1).text;
        editBuilder.replace(new vscode.Range(startLine - 1, previousText.length, endLine - 1, lastText.length), '');
    } else {
        const lastLine = document.lineAt(endLine - 1).text;
        editBuilder.replace(new vscode.Range(startLine, 0, endLine - 1, lastLine.length), '');
    }
}

function addLineDeletionRange(ranges, startLine, count) {
    if (count <= 0) return;
    ranges.push({
        startLine,
        endLine: startLine + count,
    });
}

function mergeLineDeletionRanges(ranges) {
    if (!ranges.length) return [];
    const sorted = ranges
        .map(range => ({ startLine: range.startLine, endLine: range.endLine }))
        .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
    const merged = [sorted[0]];
    for (const range of sorted.slice(1)) {
        const last = merged[merged.length - 1];
        if (range.startLine <= last.endLine) {
            last.endLine = Math.max(last.endLine, range.endLine);
        } else {
            merged.push(range);
        }
    }
    return merged;
}

function removeLineDeletionRanges(editBuilder, document, ranges) {
    for (const range of mergeLineDeletionRanges(ranges)) {
        removeLineRange(editBuilder, document, range.startLine, range.endLine - range.startLine);
    }
}

function addManagedDataLineDeletionRange(ranges, document, keywordLine, dataLine, card) {
    if (!dataLine) return;
    let startLine = dataLine.line;
    if (card && startLine - 1 > keywordLine && isStrictManagedCommentForCard(document.lineAt(startLine - 1).text, card)) {
        startLine -= 1;
    }
    addLineDeletionRange(ranges, startLine, dataLine.line - startLine + 1);
}

function addOrphanManagedCommentDeletionRanges(ranges, document, keywordLine, blockEnd, allOptionCards, selectedOptionCards) {
    const selectedComments = new Set(selectedOptionCards.map(strictCommentTextForCard));
    const allComments = new Set(allOptionCards.map(strictCommentTextForCard));

    for (let lineNum = keywordLine + 1; lineNum < blockEnd; lineNum++) {
        const text = document.lineAt(lineNum).text;
        const comment = strictCommentKey(text);
        if (!text.trimStart().startsWith('$#')) continue;
        if (allComments.has(comment) && !selectedComments.has(comment)) {
            const nextLine = lineNum + 1;
            const nextText = nextLine < blockEnd ? document.lineAt(nextLine).text : '';
            const hasEmptySkeleton = nextLine < blockEnd
                && !nextText.trimStart().startsWith('$')
                && !isKeywordLineText(nextText)
                && nextText.trim().length === 0;
            addLineDeletionRange(ranges, lineNum, hasEmptySkeleton ? 2 : 1);
        }
    }
}

function insertionLineForDataIndex(document, keywordLine, dataLines, dataIndex, fallbackLine) {
    const dataLine = dataLines[dataIndex];
    if (!dataLine) return fallbackLine;
    const previousLine = dataLine.line - 1;
    if (previousLine > keywordLine && document.lineAt(previousLine).text.trimStart().startsWith('$#')) {
        return previousLine;
    }
    return dataLine.line;
}

async function confirmRemoveNonEmptyOptionLines(lines) {
    const hasNonEmpty = lines.some(line => String(line.text || '').trim().length > 0);
    if (!hasNonEmpty) return true;
    const choice = await vscode.window.showWarningMessage(
        i18n.get('removeNonEmptyOptionLinesWarning'),
        { modal: true },
        i18n.get('removeLines')
    );
    return choice === i18n.get('removeLines');
}

function inferCurrentPostOptionCount(entry, activeTitleNames, dataLineCount) {
    const activeTitleOptions = titleKeywordOptions(entry)
        .filter(option => activeTitleNames.includes(normalizeOptionName(option.n)));
    const requiredLineCount = keywordOptionCardCount(activeTitleOptions) + (entry.c || []).length;
    let remaining = Math.max(0, dataLineCount - requiredLineCount);
    let count = 0;
    for (const option of postKeywordOptions(entry)) {
        const optionLineCount = (option.c || []).length;
        if (remaining < optionLineCount) break;
        remaining -= optionLineCount;
        count++;
    }
    return count;
}

async function chooseKeywordOptionsForEditor(editor = vscode.window.activeTextEditor, requestedLine = null) {
    if (!editor || !editor.document) return;
    const document = editor.document;
    const requireSameActiveEditor = vscode.window.activeTextEditor === editor;
    const activeLine = Number.isInteger(requestedLine)
        ? requestedLine
        : (editor.selection && editor.selection.active ? editor.selection.active.line : 0);
    const keywordLine = findKeywordLineForLine(document, activeLine);
    if (keywordLine === null) {
        vscode.window.showInformationMessage(i18n.get('noKeywordAtCursor'));
        return;
    }

    const keywordText = document.lineAt(keywordLine).text;
    const initialDocumentVersion = Number.isInteger(document.version) ? document.version : null;
    const sessionIsCurrent = () => {
        if (editor.document !== document) return false;
        if (requireSameActiveEditor && vscode.window.activeTextEditor !== editor) return false;
        if (initialDocumentVersion !== null && document.version !== initialDocumentVersion) return false;
        if (keywordLine < 0 || keywordLine >= document.lineCount) return false;
        return document.lineAt(keywordLine).text === keywordText;
    };
    const lookup = lookupKeywordInfo(keywordLineNameFromText(keywordText));
    if (!lookup || !lookup.entry.o || lookup.entry.o.length === 0) {
        vscode.window.showInformationMessage(i18n.get('noKeywordOptionsAvailable'));
        return;
    }

    const entry = lookup.entry;
    const titleOptions = titleKeywordOptions(entry);
    const postOptions = postKeywordOptions(entry);
    const currentTitleNames = lookup.activeOptions
        .filter(name => titleOptions.some(option => normalizeOptionName(option.n) === name));

    let selectedTitleNames = currentTitleNames;
    if (titleOptions.length) {
        const currentSet = new Set(currentTitleNames);
        const titleItems = titleOptions.map(option => {
            const name = normalizeOptionName(option.n);
            return {
                label: name,
                picked: currentSet.has(name),
                optionName: name,
            };
        });
        const picked = await vscode.window.showQuickPick(titleItems, {
            canPickMany: true,
            placeHolder: i18n.get('chooseKeywordTitleOptions'),
        });
        if (!picked) return;
        if (!sessionIsCurrent()) return;
        selectedTitleNames = picked.map(item => item.optionName || normalizeOptionName(item.label));
    }

    const blockEnd = findKeywordBlockEnd(document, keywordLine);
    const dataLines = collectKeywordDataLines(document, keywordLine, blockEnd);
    const currentPostCount = inferCurrentPostOptionCount(entry, currentTitleNames, dataLines.length);
    let selectedPostCount = currentPostCount;
    if (postOptions.length) {
        const postItems = [{ label: keywordOptionRangeLabel(postOptions, 0), postCount: 0, picked: currentPostCount === 0 }];
        for (let index = 0; index < postOptions.length; index++) {
            postItems.push({
                label: keywordOptionRangeLabel(postOptions, index + 1),
                postCount: index + 1,
                picked: currentPostCount === index + 1,
            });
        }
        const picked = await vscode.window.showQuickPick(postItems, {
            placeHolder: i18n.get('chooseConsecutiveOptionalCards'),
        });
        if (!picked) return;
        if (!sessionIsCurrent()) return;
        selectedPostCount = picked.postCount || 0;
    }

    const currentTitleOptions = titleOptions.filter(option => currentTitleNames.includes(normalizeOptionName(option.n)));
    const selectedTitleOptions = titleOptions.filter(option => selectedTitleNames.includes(normalizeOptionName(option.n)));
    const currentPreLineCount = keywordOptionCardCount(currentTitleOptions);
    const selectedPreLineCount = keywordOptionCardCount(selectedTitleOptions);
    const currentPostLineCount = keywordOptionCardCount(postOptions.slice(0, currentPostCount));
    const selectedPostLineCount = keywordOptionCardCount(postOptions.slice(0, selectedPostCount));
    const currentPreCards = keywordOptionCards(currentTitleOptions);
    const currentPostCards = keywordOptionCards(postOptions.slice(0, currentPostCount));

    const removedLines = [];
    if (selectedPreLineCount < currentPreLineCount) {
        removedLines.push(...dataLines.slice(selectedPreLineCount, currentPreLineCount));
    }
    if (selectedPostLineCount < currentPostLineCount) {
        removedLines.push(...dataLines.slice(dataLines.length - (currentPostLineCount - selectedPostLineCount)));
    }
    if (!(await confirmRemoveNonEmptyOptionLines(removedLines))) return;
    if (!sessionIsCurrent()) return;

    const selectedTitleNamesInOrder = titleOptions
        .map(option => normalizeOptionName(option.n))
        .filter(name => selectedTitleNames.includes(name));
    const nextKeywordLine = buildKeywordLineWithTitleOptions(keywordText, lookup.canonicalName, selectedTitleNamesInOrder);
    const preLinesToInsert = keywordOptionManagedLines(selectedTitleOptions, currentPreLineCount);
    const postLinesToInsert = keywordOptionManagedLines(postOptions.slice(0, selectedPostCount), currentPostLineCount);
    const deletionRanges = [];

    if (selectedPreLineCount < currentPreLineCount) {
        const removedDataLines = dataLines.slice(selectedPreLineCount, currentPreLineCount);
        const removedCards = currentPreCards.slice(selectedPreLineCount, currentPreLineCount);
        removedDataLines.forEach((line, index) => {
            addManagedDataLineDeletionRange(deletionRanges, document, keywordLine, line, removedCards[index]);
        });
    }
    if (selectedPostLineCount < currentPostLineCount) {
        const count = currentPostLineCount - selectedPostLineCount;
        const removedDataLines = dataLines.slice(dataLines.length - count);
        const removedCards = currentPostCards.slice(selectedPostLineCount);
        removedDataLines.forEach((line, index) => {
            addManagedDataLineDeletionRange(deletionRanges, document, keywordLine, line, removedCards[index]);
        });
    }
    addOrphanManagedCommentDeletionRanges(
        deletionRanges,
        document,
        keywordLine,
        blockEnd,
        keywordOptionCards([...titleOptions, ...postOptions]),
        keywordOptionCards([...selectedTitleOptions, ...postOptions.slice(0, selectedPostCount)])
    );

    if (!sessionIsCurrent()) return;
    await editor.edit(editBuilder => {
        if (nextKeywordLine !== keywordText) {
            editBuilder.replace(lineWholeRange(document, keywordLine), nextKeywordLine);
        }
        removeLineDeletionRanges(editBuilder, document, deletionRanges);
        if (postLinesToInsert.length) {
            insertLinesAt(editBuilder, document, blockEnd, postLinesToInsert);
        }
        if (preLinesToInsert.length) {
            const insertAt = insertionLineForDataIndex(document, keywordLine, dataLines, currentPreLineCount, keywordLine + 1);
            insertLinesAt(editBuilder, document, insertAt, preLinesToInsert);
        }
    });
}

class LsdynaKeywordOptionsCodeLensProvider {
    provideCodeLenses(document) {
        if (!document || shouldSkipAutomaticDocumentScan(document)) return [];
        const showOnAll = getLsdynaConfigurationValue('codeLens.showOnAllKeywords', false, document.uri);
        if (!showOnAll) return [];

        const lenses = [];
        for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
            const text = document.lineAt(lineNum).text;
            const classification = classifyKeywordLine(text);
            if (!classification.isKeyword || classification.rawKeyword.startsWith('**')) continue;
            const lookup = lookupKeywordInfo(keywordLineNameFromText(text));
            if (!lookup) continue;
            
            const hasOptions = lookup.entry.o && lookup.entry.o.length > 0;

            const range = new vscode.Range(lineNum, 0, lineNum, 0);

            if (hasOptions) {
                const summary = keywordOptionSummary(lookup.entry);
                lenses.push(new vscode.CodeLens(range, {
                    title: summary ? i18n.get('keywordOptionsCodeLensWithSummary', summary) : i18n.get('keywordOptionsCodeLens'),
                    command: 'extension.lsdynaChooseKeywordOptions',
                    arguments: [lineNum],
                }));
            }

            lenses.push(new vscode.CodeLens(range, {
                title: i18n.get('selectKeywordCodeLens'),
                command: 'extension.selectKeyword',
                arguments: [lineNum],
            }));
            lenses.push(new vscode.CodeLens(range, {
                title: i18n.get('formatKeywordCodeLens'),
                command: 'extension.lsdynaFormatSelection',
                arguments: [lineNum],
            }));
        }
        return lenses;
    }
}

function appendKeywordHoverActions(md, entry, lineNum) {
    const args = encodeURIComponent(JSON.stringify([lineNum]));
    const actions = [];
    if (entry.o && entry.o.length > 0) {
        actions.push(
            `[${i18n.get('keywordHoverConfigureOptions')}](command:extension.lsdynaChooseKeywordOptions?${args} "${i18n.get('keywordHoverConfigureOptionsTooltip')}")`,
        );
    }
    actions.push(
        `[${i18n.get('keywordHoverSelectCards')}](command:extension.selectKeyword?${args} "${i18n.get('keywordHoverSelectCardsTooltip')}")`,
        `[${i18n.get('keywordHoverFormatCards')}](command:extension.lsdynaFormatSelection?${args} "${i18n.get('keywordHoverFormatCardsTooltip')}")`,
    );
    md.appendMarkdown(`\n\n---\n\n${actions.join(' &nbsp;|&nbsp; ')}`);
}

/**
 * Replaces newlines in help descriptors with markdown hard breaks.
 * Kept for non-field monolineage help paths; field help uses formatFieldHelpMarkdown.
 *
 * @param {string} helpText - Input help string.
 * @returns {string} Formatted output.
 */
function formatHoverHelpText(helpText) {
    return helpText.replace(/\r?\n/g, '  \n');
}

/**
 * Resolves the manual pack root directory from configuration.
 * Relative `lsdyna.manualsDir` prefers the VS Code install root (Code.exe
 * directory) so portable distributions with `lsdyna_manual_pack` next to the
 * binary win over a same-named folder in the workspace.
 *
 * @param {import('vscode').ExtensionContext} [context] - Optional extension context for last-resort path.
 * @returns {string} Absolute (or best-effort) pack root path.
 */
function resolveManualPackRoot(context?: import('vscode').ExtensionContext) {
    const { resolveManualsRoot } = require('./manual/manualsDirResolve');
    const manualsDir = getLsdynaConfigurationValue('manualsDir', 'lsdyna_manual_pack') || 'lsdyna_manual_pack';
    return resolveManualsRoot({
        manualsDir,
        workspaceFolders: vscode.workspace.workspaceFolders || [],
        cwd: process.cwd(),
        execPath: process.execPath,
        appRoot: vscode.env && vscode.env.appRoot ? vscode.env.appRoot : null,
        extensionPath: context ? getExtensionPath(context) : null,
        pathModule: path,
        fs,
    });
}

/**
 * Whether a bilingual manual pack (runtime schema) is available at the pack root.
 * Cheap existence check only — never loads the (large) index files.
 *
 * @returns {boolean}
 */
function hasManualReaderPack() {
    try {
        return fs.existsSync(path.join(resolveManualPackRoot(), 'indexes'));
    } catch {
        return false;
    }
}

/**
 * Resolve authoritative keyword chapters from the runtime manual pack.
 * Returns null when no usable structured mapping exists so legacy PDF-only
 * directories can continue through the bookmark indexer.
 */
function getStructuredManualContext(kwName) {
    const keyword = manualIndexer.cleanKeyword(typeof kwName === 'string' ? kwName : '');
    if (!keyword || !hasManualReaderPack()) return null;
    try {
        const packRoot = resolveManualPackRoot();
        const repository = manualPackManagerRef
            ? manualPackManagerRef.getRepository(packRoot)
            : new ManualIndexRepository(packRoot);
        const locations = repository.resolveKeywordLocations(keyword);
        return locations.length > 0 ? { keyword, repository, locations } : null;
    } catch {
        return null;
    }
}

/**
 * Complete chapter metadata for hover labels and Quick Pick items.
 */
function getManualChapterPresentation(repository, location) {
    const section = repository.getSection(location.manualId, location.sectionId);
    const document = repository.listDocuments()
        .find(item => item.manualId === location.manualId);
    const manualTitle = document?.title || location.manualId;
    const compactMatch = manualTitle.match(/\bVol(?:ume)?\s+([IVXLCDM]+|\d+)\b/i);
    const manualLabel = compactMatch ? `Vol ${compactMatch[1].toUpperCase()}` : manualTitle;
    const rawPage = location.pdfPage ?? section?.pdfPage;
    const pdfPage = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : null;
    return {
        titleEn: section?.titleEn || location.title || location.sectionId,
        titleZh: section?.titleZh || '',
        manualTitle,
        manualLabel,
        pdfPage,
    };
}

function buildManualChapterPickItems(repository, locations) {
    return locations.map(location => {
        const chapter = getManualChapterPresentation(repository, location);
        const description = chapter.pdfPage
            ? `${chapter.manualTitle} · P${chapter.pdfPage}`
            : chapter.manualTitle;
        return {
            label: `$(book) ${chapter.titleEn}`,
            description,
            detail: chapter.titleZh || undefined,
            location,
        };
    });
}

async function pickManualChapter(repository, locations) {
    if (locations.length === 0) return undefined;
    if (locations.length === 1) return locations[0];
    const picked = await vscode.window.showQuickPick(
        buildManualChapterPickItems(repository, locations),
        {
            placeHolder: i18n.get('selectManualChapter'),
            matchOnDescription: true,
            matchOnDetail: true,
        },
    );
    return picked?.location;
}

/**
 * Escape text for use inside markdown link title="…".
 * @param {string} text
 * @returns {string}
 */
function escapeMarkdownLinkTitle(text) {
    return String(text || '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, ' ');
}

/**
 * Compact field-help quiet controls (icon + short label; full hint in title).
 * @returns {string}
 */
function buildFieldHoverQuietLinksMarkdown() {
    const sessionLabel = i18n.get('fieldHoverQuietSessionLink');
    const globalLabel = i18n.get('fieldHoverDisableGlobalLink');
    const sessionTip = escapeMarkdownLinkTitle(i18n.get('fieldHoverQuietSessionTooltip'));
    const globalTip = escapeMarkdownLinkTitle(i18n.get('fieldHoverDisableGlobalTooltip'));
    return (
        `[$(bell-slash) ${sessionLabel}](command:extension.muteFieldHoverSession "${sessionTip}")` +
        ` &nbsp;|&nbsp; ` +
        `[$(lock) ${globalLabel}](command:extension.disableFieldHover "${globalTip}")`
    );
}

/**
 * Resolves local manuals mapping and appends SumatraPDF/PDF links to hover Markdown card.
 * When opts.fieldHoverQuiet is true, appends compact quiet controls on the action row
 * (same line as PDF when manuals exist; light row when they do not).
 *
 * @param {import('vscode').MarkdownString} md - Markdown card.
 * @param {string} kwName - Cleaned keyword name.
 * @param {{ fieldHoverQuiet?: boolean }} [opts]
 */
function appendManualLinks(md, kwName, opts: { fieldHoverQuiet?: boolean } = {}) {
    const fieldHoverQuiet = !!opts.fieldHoverQuiet;
    const quietLinks = fieldHoverQuiet ? buildFieldHoverQuietLinksMarkdown() : '';
    const cleanKw = manualIndexer.cleanKeyword(kwName);
    const structuredPackAvailable = hasManualReaderPack();
    const structured = structuredPackAvailable ? getStructuredManualContext(cleanKw) : null;
    // A runtime pack is authoritative even when a keyword is absent or an
    // index is malformed. Only a pure PDF directory may use bookmark fallback;
    // otherwise sibling/older PDFs could silently override the configured pack.
    const manuals = structuredPackAvailable ? [] : manualIndexer.getManualLocations(cleanKw);
    const fileCount = structuredPackAvailable ? 0 : manualIndexer.getManualFilesCount();
    const notConfigured = !structuredPackAvailable && fileCount === 0;

    if (notConfigured) {
        md.appendMarkdown('\n\n---');
        md.appendMarkdown(`\n\n${i18n.get('manualDirNotConfigured')}`);
        const setupGuideUrl = i18n.getLanguage() === 'zh-cn'
            ? 'https://github.com/hqyyqh/vscode-lsdyna/blob/master/README_zh.md#手册集成设置'
            : 'https://github.com/hqyyqh/vscode-lsdyna/blob/master/README.md#manual-integration-setup';
        md.appendMarkdown(`\n\n[${i18n.get('configureFolder')}](command:extension.configureManualsDir) &nbsp;|&nbsp; [${i18n.get('howToConfigureManual')}](${setupGuideUrl})`);
        if (quietLinks) {
            md.appendMarkdown(`\n\n${quietLinks}`);
        }
    } else if (structured || manuals.length > 0) {
        md.appendMarkdown('\n\n---');
        const settingsLink = `[$(settings-gear)](command:extension.configureManualsDir "${i18n.get('modifyManualPath')}")`;
        let readerLink = '';
        let pdfLink;
        let matchedKw = cleanKw;
        let isApproximate = false;

        if (structured) {
            const { repository, locations } = structured;
            matchedKw = locations[0].matchedKeyword || cleanKw;
            isApproximate = locations[0].matchKind === 'approximate';
            if (locations.length === 1) {
                const location = locations[0];
                const chapter = getManualChapterPresentation(repository, location);
                const readerArgs = encodeURIComponent(JSON.stringify([
                    cleanKw, location.manualId, location.sectionId, 'reader',
                ]));
                const pdfArgs = encodeURIComponent(JSON.stringify([
                    cleanKw, location.manualId, location.sectionId, 'pdf',
                ]));
                readerLink = `[$(book) ${i18n.get('manualReaderBilingual')}](command:extension.manual.openPackChapter?${readerArgs} "${i18n.get('openManualReader')}")`;
                const pdfLabel = chapter.pdfPage
                    ? `PDF · ${chapter.manualLabel} · P${chapter.pdfPage}`
                    : `PDF · ${chapter.manualLabel}`;
                const title = escapeMarkdownLinkTitle(
                    i18n.get(
                        'openPdfManualLocation',
                        chapter.manualTitle,
                        chapter.pdfPage ? i18n.get('page', chapter.pdfPage) : chapter.titleEn,
                    ),
                );
                pdfLink = `[$(file-pdf) ${pdfLabel}](command:extension.manual.openPackChapter?${pdfArgs} "${title}")`;
            } else {
                const readerArgs = encodeURIComponent(JSON.stringify([cleanKw, 'reader']));
                const pdfArgs = encodeURIComponent(JSON.stringify([cleanKw, 'pdf']));
                readerLink = `[$(book) ${i18n.get('manualReaderChooseChapter')}](command:extension.manual.pickPackChapter?${readerArgs} "${i18n.get('selectManualChapter')}")`;
                pdfLink = `[$(file-pdf) ${i18n.get('pdfChooseChapter')}](command:extension.manual.pickPackChapter?${pdfArgs} "${i18n.get('selectManualChapter')}")`;
            }
        } else if (manuals.length === 1) {
            const man = manuals[0];
            matchedKw = man.matchedKeyword || cleanKw;
            isApproximate = man.matchKind === 'approximate';
            const volName = path.basename(man.file, '.pdf');
            const openArgs = encodeURIComponent(JSON.stringify([man.file, man.page]));
            const title = escapeMarkdownLinkTitle(
                i18n.get('openPdfManualLocation', volName, i18n.get('page', man.page)),
            );
            pdfLink = `[$(file-pdf) PDF · P${man.page}](command:extension.openManual?${openArgs} "${title}")`;
        } else {
            matchedKw = manuals[0].matchedKeyword || cleanKw;
            isApproximate = manuals[0].matchKind === 'approximate';
            const pickerArgs = encodeURIComponent(JSON.stringify([cleanKw]));
            pdfLink = `[$(file-pdf) ${i18n.get('pdfChooseBookmark')}](command:extension.manual.pickPdfLocation?${pickerArgs} "${i18n.get('selectPdfManualLocation')}")`;
        }

        const documentLinks = readerLink
            ? `${readerLink} &nbsp;|&nbsp; ${pdfLink}`
            : pdfLink;
        const matchNotice = isApproximate
            ? `${i18n.get('manualApproximateMatch', matchedKw)} &nbsp;·&nbsp; `
            : '';
        const quietGroup = quietLinks ? ` &nbsp;·&nbsp; ${quietLinks}` : '';
        md.appendMarkdown(`\n\n${settingsLink} &nbsp;&nbsp; ${matchNotice}${documentLinks}${quietGroup}`);
    } else if (quietLinks) {
        // No manual matches: still offer quiet controls on a light action row.
        md.appendMarkdown('\n\n---');
        md.appendMarkdown(`\n\n${quietLinks}`);
    }
}

/**
 * Re-resolves PDF locations for a keyword and opens either the sole match or
 * a Quick Pick when several manual positions are available.
 *
 * @param {string} kwName - Keyword whose PDF locations should be shown.
 * @returns {Promise<void>}
 */
async function pickManualLocation(kwName) {
    const cleanKw = manualIndexer.cleanKeyword(typeof kwName === 'string' ? kwName : '');
    const manuals = cleanKw ? manualIndexer.getManualLocations(cleanKw) : [];

    if (manuals.length === 0) {
        vscode.window.showInformationMessage(i18n.get('pdfManualLocationNotFound', cleanKw || kwName || ''));
        return;
    }

    if (manuals.length === 1) {
        const man = manuals[0];
        await vscode.commands.executeCommand('extension.openManual', man.file, man.page);
        return;
    }

    const baseNameCounts = new Map();
    for (const man of manuals) {
        const key = path.basename(man.file, '.pdf').toLowerCase();
        baseNameCounts.set(key, (baseNameCounts.get(key) || 0) + 1);
    }

    const items = manuals.map(man => {
        const baseName = path.basename(man.file, '.pdf');
        return {
            label: `$(file-pdf) ${baseName}`,
            description: i18n.get('page', man.page),
            detail: baseNameCounts.get(baseName.toLowerCase()) > 1 ? man.file : undefined,
            location: man,
        };
    });
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: i18n.get('selectPdfManualLocation'),
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!picked) return;

    await vscode.commands.executeCommand('extension.openManual', picked.location.file, picked.location.page);
}

/**
 * Safely reads the first chunk of a file to generate a preview.
 * Returns empty string if the file doesn't exist or an error occurs.
 * 
 * @param {string} filePath 
 * @param {number} maxBytes 
 * @param {number} maxLines 
 * @returns {Promise<string>}
 */
async function getIncludeFilePreview(filePath) {
    const maxLines = getLsdynaConfigurationValue('hover.previewMaxLines', 20);
    const maxBytes = Math.max(4096, maxLines * 120);

    return new Promise((resolve) => {
        fs.open(filePath, 'r', (err, fd) => {
            if (err) return resolve('');
            const buffer = Buffer.alloc(maxBytes);
            fs.read(fd, buffer, 0, maxBytes, 0, (err, bytesRead) => {
                fs.close(fd, () => {
                    if (err || bytesRead === 0) return resolve('');
                    let text = buffer.toString('utf8', 0, bytesRead);
                    let lines = text.split(/\r?\n/);
                    let isTruncated = false;
                    
                    if (lines.length > maxLines) {
                        lines = lines.slice(0, maxLines);
                        isTruncated = true;
                    } else if (bytesRead === maxBytes) {
                        lines.pop(); // Drop the last incomplete line
                        isTruncated = true;
                    }
                    
                    let preview = lines.join('\n');
                    if (isTruncated) {
                        preview += '\n... (File is truncated for preview)';
                    }
                    resolve(preview);
                });
            });
        });
    });
}

/**
 * Session cache: after medium-confidence "pick similar keyword", re-hover embeds that help.
 * Keyed by document URI + line + unknown keyword name.
 * @type {Map<string, string>}
 */
const similarKeywordHoverChoices = new Map();

/** Session mute for card-field hover help (restart clears). */
let sessionFieldHoverMuted = false;
/** Throttle re-enable hints: at most once per kind per session. */
const fieldHoverQuietHintShown = { session: false, global: false };
/** Set from activate so quiet commands can refresh the status bar menu. */
let statusDashboardRef = null;
/** Set from activate so a main-deck choice can republish shared-file diagnostics. */
let projectDiagnosticStoreRef = null;

function isFieldHoverConfigEnabled(resource = undefined) {
    return getLsdynaConfigurationValue('enableFieldHover', true, resource) !== false;
}

function isFieldHoverEffective(resource = undefined) {
    return isFieldHoverConfigEnabled(resource) && !sessionFieldHoverMuted;
}

/**
 * @returns {'on'|'offSession'|'off'}
 */
function getFieldHoverMenuState(resource = undefined) {
    if (!isFieldHoverConfigEnabled(resource)) return 'off';
    if (sessionFieldHoverMuted) return 'offSession';
    return 'on';
}

function setSessionFieldHoverMutedForTesting(muted) {
    sessionFieldHoverMuted = !!muted;
}

function resetFieldHoverQuietStateForTesting() {
    sessionFieldHoverMuted = false;
    fieldHoverQuietHintShown.session = false;
    fieldHoverQuietHintShown.global = false;
}

function refreshFieldHoverQuietUi() {
    try {
        if (statusDashboardRef && typeof statusDashboardRef.scheduleRefresh === 'function') {
            statusDashboardRef.scheduleRefresh();
        }
    } catch (_) { /* ignore */ }
}

async function enableFieldHoverFromQuiet() {
    sessionFieldHoverMuted = false;
    const editor = vscode.window.activeTextEditor;
    const resource = editor && editor.document ? editor.document.uri : undefined;
    if (!isFieldHoverConfigEnabled(resource)) {
        const config = vscode.workspace.getConfiguration('lsdyna', resource);
        await config.update('enableFieldHover', true, vscode.ConfigurationTarget.Global);
    }
    refreshFieldHoverQuietUi();
}

async function maybeShowFieldHoverQuietHint(kind) {
    if (kind !== 'session' && kind !== 'global') return;
    if (fieldHoverQuietHintShown[kind]) return;
    fieldHoverQuietHintShown[kind] = true;
    const message = kind === 'session'
        ? i18n.get('fieldHoverMutedSessionMessage')
        : i18n.get('fieldHoverDisabledGlobalMessage');
    const reenable = i18n.get('fieldHoverReenableAction');
    const dismiss = i18n.get('fieldHoverDismissAction');
    const picked = await vscode.window.showInformationMessage(message, reenable, dismiss);
    if (picked === reenable) {
        await enableFieldHoverFromQuiet();
        vscode.window.showInformationMessage(i18n.get('fieldHoverEnabledToast'));
    }
}

async function handleMuteFieldHoverSession() {
    sessionFieldHoverMuted = true;
    refreshFieldHoverQuietUi();
    await maybeShowFieldHoverQuietHint('session');
}

async function handleDisableFieldHover() {
    sessionFieldHoverMuted = true;
    const editor = vscode.window.activeTextEditor;
    const resource = editor && editor.document ? editor.document.uri : undefined;
    const config = vscode.workspace.getConfiguration('lsdyna', resource);
    await config.update('enableFieldHover', false, vscode.ConfigurationTarget.Global);
    refreshFieldHoverQuietUi();
    await maybeShowFieldHoverQuietHint('global');
}

async function handleToggleFieldHover() {
    const editor = vscode.window.activeTextEditor;
    const resource = editor && editor.document ? editor.document.uri : undefined;
    if (isFieldHoverEffective(resource)) {
        // Menu: session mute only (do not write permanent off)
        sessionFieldHoverMuted = true;
        refreshFieldHoverQuietUi();
        await maybeShowFieldHoverQuietHint('session');
        return;
    }
    await enableFieldHoverFromQuiet();
    vscode.window.showInformationMessage(i18n.get('fieldHoverEnabledToast'));
}

function similarKeywordChoiceKey(document, line, unknownKeyword) {
    const uri = document && document.uri && document.uri.toString
        ? document.uri.toString()
        : String(document && document.fileName || '');
    return `${uri}::${line}::${String(unknownKeyword || '').toUpperCase()}`;
}

function rememberSimilarKeywordChoice(document, line, unknownKeyword, chosenKeyword) {
    const key = similarKeywordChoiceKey(document, line, unknownKeyword);
    if (!chosenKeyword) {
        similarKeywordHoverChoices.delete(key);
        return;
    }
    similarKeywordHoverChoices.set(key, String(chosenKeyword).toUpperCase().replace(/^\*/, ''));
}

function getRememberedSimilarKeywordChoice(document, line, unknownKeyword) {
    return similarKeywordHoverChoices.get(similarKeywordChoiceKey(document, line, unknownKeyword)) || null;
}

/**
 * Resolve schema lookup for a typed keyword, falling back to high-confidence /
 * user-picked similar keywords when the typed name is unknown.
 *
 * @param {any} document
 * @param {number} keywordLine
 * @param {string} [typedKwName]
 * @returns {{ typedName: string, lookup: any, suggestedName: string|null, viaSuggest: boolean }}
 */
function resolveKeywordLookupWithSuggest(document, keywordLine, typedKwName?: string) {
    let typedName = typedKwName;
    if (!typedName && document && typeof keywordLine === 'number' && keywordLine >= 0) {
        const text = document.lineAt(keywordLine).text.trim();
        typedName = text.startsWith('*') ? text.slice(1).toUpperCase().split(/[\s,]/)[0] : '';
    }
    typedName = String(typedName || '').toUpperCase().replace(/^\*/, '');

    const direct = typedName ? lookupKeywordInfo(typedName) : null;
    if (direct) {
        return { typedName, lookup: direct, suggestedName: null, viaSuggest: false };
    }

    const preferred = document
        ? getRememberedSimilarKeywordChoice(document, keywordLine, typedName)
        : null;
    const suggest = suggestSimilarKeywords(typedName, preferred ? { preferredKeyword: preferred } : {});

    let suggestedName = null;
    if (preferred) {
        suggestedName = preferred;
    } else if (suggest.tier === 'high' && suggest.items[0]) {
        suggestedName = suggest.items[0].keyword;
    }

    if (!suggestedName) {
        return { typedName, lookup: null, suggestedName: null, viaSuggest: false };
    }

    const lookup = lookupKeywordInfo(suggestedName);
    if (!lookup) {
        return { typedName, lookup: null, suggestedName: null, viaSuggest: false };
    }
    return { typedName, lookup, suggestedName, viaSuggest: true };
}

/**
 * Card info for a data line, using similar-keyword override when the block keyword is unknown.
 * @param {any} document
 * @param {number} lineNum
 * @param {object} [schema]
 */
function getCardInfoForDocumentLineWithSuggest(document, lineNum, schema) {
    const fieldSchema = schema || getFieldData();
    const direct = keywordSchema.getCardInfoForDocumentLine(document, lineNum, fieldSchema);
    if (direct) {
        return { cardInfo: direct, viaSuggest: false, suggestedName: null, typedName: direct.keywordName };
    }

    let keywordLine = null;
    for (let i = lineNum - 1; i >= 0; i--) {
        if (isKeywordLineText(document.lineAt(i).text)) {
            keywordLine = i;
            break;
        }
    }
    if (keywordLine === null) {
        return { cardInfo: null, viaSuggest: false, suggestedName: null, typedName: null };
    }

    const resolved = resolveKeywordLookupWithSuggest(document, keywordLine);
    if (!resolved.viaSuggest || !resolved.suggestedName) {
        return {
            cardInfo: null,
            viaSuggest: false,
            suggestedName: null,
            typedName: resolved.typedName,
        };
    }

    const cardInfo = keywordSchema.getCardInfoForDocumentLine(document, lineNum, fieldSchema, {
        keywordOverride: resolved.suggestedName,
    });
    return {
        cardInfo,
        viaSuggest: !!cardInfo,
        suggestedName: resolved.suggestedName,
        typedName: resolved.typedName,
    };
}

/**
 * Build markdown for an unknown keyword hover, optionally embedding closest-keyword help.
 * @param {string} kwName
 * @param {object} [ctx]
 * @param {string} [ctx.previewMd]
 * @param {string|null} [ctx.storageEntry]
 * @param {boolean} [ctx.inCustomList]
 * @param {any} [ctx.document]
 * @param {number} [ctx.line]
 * @returns {{ markdown: string, suggestHelpKeyword: string|null }}
 */
function buildHoverInfoIcon(messages) {
    const title = (Array.isArray(messages) ? messages : [messages])
        .filter(Boolean)
        .map(text => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;'))
        .join('&#10;');
    return `<span title="${title}">ⓘ</span>`;
}

function buildUnknownKeywordHoverMarkdown(kwName, ctx: any = {}) {
    const previewMd = ctx.previewMd || '';
    const storageEntry = ctx.storageEntry;
    const inCustomList = !!ctx.inCustomList;
    const document = ctx.document;
    const line = typeof ctx.line === 'number' ? ctx.line : 0;

    let detailMarkdown = '';
    const preferred = document
        ? getRememberedSimilarKeywordChoice(document, line, kwName)
        : null;
    const suggest = suggestSimilarKeywords(kwName, preferred ? { preferredKeyword: preferred } : {});
    let suggestHelpKeyword = null;

    if (preferred) {
        // User picked from medium list — always embed that help when resolvable.
        const pickLookup = lookupKeywordInfo(preferred);
        if (pickLookup) {
            suggestHelpKeyword = preferred;
            detailMarkdown = keywordHoverMarkdown(preferred, pickLookup.entry, pickLookup.activeOptions);
        }
    } else if (suggest.tier === 'high' && suggest.items[0]) {
        const best = suggest.items[0].keyword;
        const bestLookup = lookupKeywordInfo(best);
        if (bestLookup) {
            suggestHelpKeyword = best;
            detailMarkdown = keywordHoverMarkdown(best, bestLookup.entry, bestLookup.activeOptions);
        }
    } else if (suggest.tier === 'medium' && suggest.items.length > 0) {
        const pickArgs = encodeURIComponent(JSON.stringify([{
            keyword: kwName,
            line,
            suggestions: suggest.items.map(item => item.keyword),
        }]));
        detailMarkdown = `[$(search) ${i18n.get('unknownKeywordPickSimilarHelp')}](command:extension.pickSimilarKeywordHelp?${pickArgs} "${i18n.get('unknownKeywordPickSimilarHelp')}")`;
        const previewNames = suggest.items.slice(0, 3).map(item => `\\*${item.keyword}`).join(', ');
        if (previewNames) {
            detailMarkdown += `\n\n${previewNames}`;
        }
    }

    let header = detailMarkdown;
    if (previewMd) {
        header = header ? `${previewMd}\n\n---\n\n${header}` : previewMd;
    }

    if (inCustomList) {
        header += `${header ? '\n\n' : ''}$(check) ${i18n.get('customValidKeywordInList')}`;
    } else if (storageEntry) {
        const addArgs = encodeURIComponent(JSON.stringify([{
            keyword: storageEntry,
            mode: 'exact',
            target: 'global',
        }]));
        header += `${header ? '\n\n' : ''}[$(add) ${i18n.get('addCustomValidKeywordAction')}](command:extension.addCustomValidKeyword?${addArgs} "${i18n.get('addCustomValidKeywordAction')}")`;
    }
    return { markdown: header, suggestHelpKeyword };
}

/**
 * QuickPick similar keywords for medium-confidence unknown hover, then re-show hover.
 * @param {{ keyword?: string, line?: number, suggestions?: string[], uri?: string }} arg
 */
async function handlePickSimilarKeywordHelpCommand(arg) {
    const payload = arg && typeof arg === 'object' ? arg : {};
    const unknownKeyword = String(payload.keyword || '').replace(/^\*/, '');
    let suggestions = Array.isArray(payload.suggestions) ? payload.suggestions.map(s => String(s).replace(/^\*/, '')) : [];
    if (suggestions.length === 0 && unknownKeyword) {
        suggestions = suggestSimilarKeywords(unknownKeyword).items.map(item => item.keyword);
    }
    if (suggestions.length === 0) {
        return;
    }

    const items = suggestions.map(name => ({
        label: `*${name}`,
        description: name,
        keyword: name,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title: i18n.get('unknownKeywordPickSimilarTitle'),
        placeHolder: i18n.get('unknownKeywordPickSimilarPlaceholder'),
        matchOnDescription: true,
    });
    if (!picked || !picked.keyword) {
        return;
    }

    const editor = vscode.window.activeTextEditor;
    const document = editor && editor.document;
    const line = typeof payload.line === 'number'
        ? payload.line
        : (editor ? editor.selection.active.line : 0);
    if (document) {
        rememberSimilarKeywordChoice(document, line, unknownKeyword || picked.keyword, picked.keyword);
        if (editor) {
            const pos = new vscode.Position(line, Math.min(1, document.lineAt(line).text.length));
            editor.selection = new vscode.Selection(pos, pos);
            try {
                await vscode.commands.executeCommand('editor.action.showHover');
            } catch {
                // Hover may be unavailable in tests / non-editor hosts.
            }
        }
    }
}

/**
 * Hover provider delivering detailed keyword and card field documentation on mouse hover.
 * @implements {vscode.HoverProvider}
 */
class LsdynaFieldHoverProvider {
    /**
     * Generates Hover cards for includes, parameter references, keywords, or card fields.
     * 
     * @param {import('vscode').TextDocument} document - Active document.
     * @param {import('vscode').Position} position - Cursor position.
     * @returns {import('vscode').Hover|null} Hover card or null.
     */
    async provideHover(document, position) {
        if (shouldSkipAutomaticDocumentScan(document)) return null;

        // Hover on include file paths
        const includeEntries = findIncludeFileLines(document);
        const includeEntry = includeEntries.find(entry => includeScanner.includeEntryContainsLine(entry, position.line));
        if (includeEntry) {
            const ranges = includeScanner.getIncludeEntryRanges(includeEntry);
            const rangeOnLine = ranges.find(r => r.lineIndex === position.line && position.character >= r.startChar && position.character <= r.endChar);
            if (rangeOnLine) {
                try {
                    const searchPaths = getSearchPath(document);
                    const fullPath = searchFileFromPaths(includeEntry.fileName, searchPaths);
                    const uri = vscode.Uri.file(fullPath);
                    const hoverRange = new vscode.Range(rangeOnLine.lineIndex, rangeOnLine.startChar, rangeOnLine.lineIndex, rangeOnLine.endChar);
                    
                    const openNewTabArgs = encodeURIComponent(JSON.stringify([fullPath]));
                    const openSplitArgs = encodeURIComponent(JSON.stringify([fullPath]));
                    const openFolderArgs = encodeURIComponent(JSON.stringify([fullPath]));
                    
                    const md = new vscode.MarkdownString(
                        `[$(go-to-file)](command:extension.openIncludeNewTab?${openNewTabArgs} "${i18n.get('openNewTab')}") &nbsp;&nbsp;&nbsp;&nbsp; ` +
                        `[$(split-horizontal)](command:extension.openIncludeSplit?${openSplitArgs} "${i18n.get('openSplit')}") &nbsp;&nbsp;&nbsp;&nbsp; ` +
                        `[$(folder-opened)](command:extension.openIncludeFolder?${openFolderArgs} "${i18n.get('openFolder')}")`
                    );
                    md.isTrusted = true;
                    md.supportThemeIcons = true;
                    
                    const previewText = await getIncludeFilePreview(fullPath);
                    if (previewText) {
                        md.appendMarkdown('\n\n---\n\n');
                        md.appendCodeblock(previewText, 'lsdyna');
                    }

                    return new vscode.Hover(md, hoverRange);
                } catch (e) {
                    // File does not exist, fall through to default keyword/field hover
                }
            }
        }

        const line = document.lineAt(position.line);
        const text = line.text;
        const trimmed = text.trimStart();

        // Parameter hover is document-local first. Project evaluation is an optional
        // second layer and is not required to show a definition already in this file.
        const parameterAtCursor = getParameterAtCursor(document, position);
        if (parameterAtCursor) {
            const parameterName = parameterAtCursor.name;
            const sourceDefinitions = findParameterDefinitions(document)
                .get(parameterName.toUpperCase()) || [];
            const mainDeckContext = getMainDeckContextForDocumentPath(document.uri.fsPath);
            const referenceIndexState = mainDeckContext.project
                ? {
                    referenceIndex: mainDeckContext.project.referenceIndex,
                    projectScoped: true,
                    rootFile: mainDeckContext.rootFile,
                    projectContextSelected: mainDeckContext.state === 'selected',
                }
                : mainDeckContext.state === 'ambiguous'
                    ? {
                        projectScoped: false,
                        rootFile: null,
                        projectContextAmbiguous: true,
                    }
                    : null;
            const effectiveAnalysis = referenceIndexState && referenceIndexState.projectScoped
                ? analyzeParameterReferenceAtLocation(
                    referenceIndexState.referenceIndex,
                    parameterName,
                    {
                        documentPath: document.uri.fsPath,
                        lineIndex: position.line,
                    }
                )
                : sourceDefinitions.length === 0
                    ? { resolved: false, reasons: ['project-scan-unavailable'] }
                    : null;
            const mainDeckContextMarkdown = buildMainDeckContextHoverMarkdown(
                referenceIndexState,
                document.uri.fsPath
            );
            const md = new vscode.MarkdownString(buildParameterReferenceHoverMarkdown({
                parameterName,
                sourceDefinitions,
                effectiveAnalysis,
                mainDeckContextMarkdown,
            }));
            md.isTrusted = true;
            md.supportThemeIcons = true;
            return new vscode.Hover(md, parameterAtCursor.fullRange);
        }

        // Hover on keyword lines
        const currentClassification = classifyKeywordLine(text);
        if (currentClassification.isKeyword) {
            const kwName = currentClassification.normalizedKeyword.slice(1);
            if (!kwName) return null;

            let previewMd = '';
            const normalizedKw = kwName.toUpperCase();
            if (normalizedKw.startsWith('DEFINE_CURVE') || normalizedKw.startsWith('DEFINE_TABLE')) {
                const referenceIndexState = await getReferenceIndexForDocument(document);
                const fileIndex = getFileIndexForDocument(document);
                if (fileIndex && fileIndex.referenceDefinitions) {
                    const { curves, tables } = fileIndex.referenceDefinitions;
                    const match = (curves || []).find(c => c.startLine === position.line) ||
                                  (tables || []).find(t => t.startLine === position.line);
                    if (match) {
                        const themeKind = vscode.window?.activeColorTheme?.kind;
                        const resolvedMatch = match.kind === 'table' && referenceIndexState
                            ? attachResolvedTableChildren(
                                match,
                                referenceIndexState.referenceIndex,
                                { projectScoped: referenceIndexState.projectScoped }
                            )
                            : match;
                        previewMd = buildDefinitionHoverSection(resolvedMatch, themeKind);
                    }
                }
            }

            const lookup = lookupKeywordInfo(kwName);
            if (!lookup) {
                const cleanKw = manualIndexer.cleanKeyword(kwName);
                const manuals = manualIndexer.getManualLocations(cleanKw);
                const fileCount = manualIndexer.getManualFilesCount();
                const hasManuals = manuals.length > 0;
                const notConfigured = fileCount === 0;
                const storageEntry = normalizeCustomKeywordEntry(kwName);
                const inCustomList = storageEntry ? isCoveredByCustomList(storageEntry) : false;

                // Always offer hover for unknown keywords so users can add to custom list
                // and, when confident, embed closest-keyword help in the same hover.
                const built = buildUnknownKeywordHoverMarkdown(kwName, {
                    previewMd,
                    storageEntry,
                    inCustomList,
                    document,
                    line: position.line,
                });
                if (hasManuals || notConfigured || previewMd || storageEntry || built.suggestHelpKeyword || built.markdown.includes('command:extension.pickSimilarKeywordHelp')) {
                    const md = new vscode.MarkdownString(built.markdown);
                    md.isTrusted = true;
                    md.supportThemeIcons = true;
                    md.supportHtml = true;
                    // Manual links for the suggested keyword when we embedded its help; else the typed name.
                    appendManualLinks(md, built.suggestHelpKeyword || kwName);
                    return new vscode.Hover(md);
                }
                return null;
            }
            let hoverContent = keywordHoverMarkdown(kwName, lookup.entry, lookup.activeOptions);
            if (previewMd) {
                hoverContent = `${previewMd}\n\n---\n\n${hoverContent}`;
            }
            const md = new vscode.MarkdownString(hoverContent);
            md.isTrusted = true;
            md.supportThemeIcons = true;
            md.supportHtml = true;
            appendKeywordHoverActions(md, lookup.entry, position.line);
            appendManualLinks(md, kwName);
            return new vscode.Hover(md);
        }

        // Skip comment lines
        if (trimmed.startsWith('$')) return null;

        // Find the enclosing keyword line
        let kwLine = null;
        for (let i = position.line - 1; i >= 0; i--) {
            if (isKeywordLineText(document.lineAt(i).text)) { kwLine = i; break; }
        }
        if (kwLine === null) return null;

        const kwText = document.lineAt(kwLine).text.trim();
        const kwName = kwText.slice(1).toUpperCase().split(/[\s,]/)[0];
        const resolvedCard = getCardInfoForDocumentLineWithSuggest(document, position.line, getFieldData());
        const cardInfo = resolvedCard.cardInfo;
        const card = cardInfo ? cardInfo.card : null;
        if (!card || card.length === 0) return null;

        const col = position.character;
        const field = card.find(f => col >= f.p && col < f.p + f.w);
        if (!field) return null;
        // Field-help quiet switch: only suppress card-field hovers (not include/param/keyword).
        if (!isFieldHoverEffective(document.uri)) return null;

        const typeLabel = field.t ? ` *(${field.t})*` : '';
        const formattedHelp = buildFieldHelpMarkdown(field);
        const helpText = formattedHelp ? `\n\n${formattedHelp}` : '';
        const suggestInfoIcon = resolvedCard.viaSuggest && resolvedCard.suggestedName
            ? ` ${buildHoverInfoIcon([
                i18n.get('unknownKeywordHoverHint'),
                i18n.get('unknownKeywordFieldHelpFromSimilar', resolvedCard.suggestedName, resolvedCard.typedName || kwName),
                i18n.get('unknownKeywordSuggestStillUnknown'),
            ])}`
            : '';

        const columnsHeader = card.map(f => `${f.p + 1}-${f.p + f.w}`);
        const separators = card.map(() => ':---:'); // Center align all columns
        const fieldNamesBody = card.map((f) => {
            if (f.n === field.n) {
                return `<span style="color:var(--vscode-badge-foreground);background-color:var(--vscode-badge-background);">**&nbsp;${f.n}&nbsp;**</span>`;
            }
            return `\`${f.n}\``; // Use inline code for inactive fields to look like input cells
        });

        const gridTable = [
            `| ${columnsHeader.join(' | ')} |`,
            `| ${separators.join(' | ')} |`,
            `| ${fieldNamesBody.join(' | ')} |`
        ].join('\n');
        const rawFieldValue = text.slice(field.p, field.p + field.w);
        const helpKeywordName = cardInfo.keywordName || resolvedCard.suggestedName || kwName;
        const referenceInfo = getFieldReferenceInfo({
            keyword: helpKeywordName,
            cardIndex: cardInfo.cardIndex,
            field,
        });
        const referenceValue = referenceInfo ? parseFieldReferenceValue(rawFieldValue, referenceInfo) : null;
        const manualKw = resolvedCard.suggestedName || kwName;

        let md;
        if (referenceInfo && referenceValue) {
            md = new vscode.MarkdownString(`### $(symbol-field) <span style="color:var(--vscode-textLink-foreground);">**${field.n}**</span>${suggestInfoIcon}${typeLabel}`);
            md.isTrusted = true;
            md.supportHtml = true;
            md.supportThemeIcons = true;

            const referenceIndexState = await getReferenceIndexForDocument(document);
            const analysis = resolveHoverAnalysis(
                referenceIndexState,
                referenceValue,
                referenceInfo,
                {
                    documentPath: document.uri.fsPath,
                    lineIndex: position.line,
                }
            );
            const themeKind = vscode.window?.activeColorTheme?.kind;

            md.appendMarkdown(buildReferenceHoverSection({
                fieldName: field.n,
                referenceValue,
                isSignedSwitch: referenceValue.isSignedSwitch,
                analysis,
                themeKind,
                documentPath: document.uri.fsPath,
            }));
            const mainDeckContextMarkdown = buildMainDeckContextHoverMarkdown(
                referenceIndexState,
                document.uri.fsPath
            );
            if (mainDeckContextMarkdown) {
                md.appendMarkdown(`\n\n${mainDeckContextMarkdown}`);
            }

            // Manual & columns at the bottom
            md.appendMarkdown(`\n\n---\n\n${helpText}\n\n---\n\n**$(table) ${i18n.get('cardColumns')}:**\n\n${gridTable}`);
            appendManualLinks(md, manualKw, { fieldHoverQuiet: true });
        } else {
            md = new vscode.MarkdownString(`### $(symbol-field) <span style="color:var(--vscode-textLink-foreground);">**${field.n}**</span>${suggestInfoIcon}${typeLabel}${helpText}\n\n---\n\n**$(table) ${i18n.get('cardColumns')}:**\n\n${gridTable}`);
            md.isTrusted = true;
            md.supportHtml = true;
            md.supportThemeIcons = true;
            appendManualLinks(md, manualKw, { fieldHoverQuiet: true });
        }

        const range = new vscode.Range(position.line, field.p, position.line, field.p + field.w);
        return new vscode.Hover(md, range);
    }
}

/**
 * CodeLens provider putting parameter usage reference counts above definition cards.
 * @implements {vscode.CodeLensProvider}
 */
class LsdynaParameterCodeLensProvider {
    /**
     * Spawns CodeLenses for parameter definitions.
     * 
     * @param {import('vscode').TextDocument} document - Document.
     * @returns {import('vscode').CodeLens[]} CodeLenses.
     */
    provideCodeLenses(document) {
        const defs = findParameterDefinitions(document);
        const refs = findParameterReferences(document);
        const lenses = [];
        for (const [key, definitions] of defs) {
            const count = refs.filter(r => r.name === key).length;
            for (const def of definitions) {
                const pos = new vscode.Position(def.lineIndex, def.startChar);
                const range = new vscode.Range(pos, pos);
                lenses.push(new vscode.CodeLens(range, {
                    title: count === 1 ? i18n.get('parameterReferenceSingular') : i18n.get('parameterReferencesPlural', count),
                    command: 'editor.action.findReferences',
                    arguments: [document.uri, pos],
                }));
            }
        }
        return lenses;
    }
}


/**
 * Fetches search path directories for resolving *INCLUDE* names in this document.
 *
 * When a project snapshot was loaded from a main job and this file is in that tree,
 * returns the ancestor-aware effective paths (local dir + local PATH + inherited PATH).
 * Otherwise returns file-local paths only (document directory + PATH cards in this file).
 *
 * @param {import('vscode').TextDocument} document - Active document.
 * @returns {string[]} Search paths list.
 */
function getSearchPath(document) {
    return getEffectiveSearchPaths(document);
}

/**
 * Ancestor-aware search roots when a project snapshot is cached; else file-local.
 *
 * @param {import('vscode').TextDocument} document
 * @returns {string[]}
 */
function getEffectiveSearchPaths(document) {
    const localPaths = getIncludeDirectiveData(document).searchPaths || [];
    if (!document || !document.uri || !document.uri.fsPath) {
        return localPaths;
    }
    const mainDeckContext = getMainDeckContextForDocumentPath(document.uri.fsPath);
    if (mainDeckContext.rootFile) {
        const fromSelectedRoot = activeEffectiveSearchPathCache.lookupForRoot(
            document.uri.fsPath,
            mainDeckContext.rootFile
        );
        return Array.isArray(fromSelectedRoot) && fromSelectedRoot.length > 0
            ? fromSelectedRoot
            : localPaths;
    }
    const fromSnapshot = activeEffectiveSearchPathCache.lookup(document.uri.fsPath);
    if (Array.isArray(fromSnapshot) && fromSnapshot.length > 0) {
        return fromSnapshot;
    }
    return localPaths;
}

/**
 * Synchronously searches backward to locate the starting line of the enclosing keyword block.
 * 
 * @param {number} lineCount - Document lines.
 * @param {function(number): string} getLine - Line retrieval callback.
 * @param {number} lineindex - Starting line index.
 * @returns {number} 0-indexed line index of keyword statement.
 */
function startLineOfCurrentKeywordFromLineReader(lineCount, getLine, lineindex) {
    for (let i = lineindex; i >= 0; i--) {
        if (isKeywordLineText(getLine(i))) return i;
    }
    throw new Error(i18n.get('notOnAnyKeyword'));
}

/**
 * Synchronously searches forward to locate the ending line of the enclosing keyword block.
 * 
 * @param {number} lineCount - Document lines.
 * @param {function(number): string} getLine - Line retrieval callback.
 * @param {number} lineindex - Starting line index.
 * @returns {number} 0-indexed line index of keyword block end.
 */
function endLineOfCurrentKeywordFromLineReader(lineCount, getLine, lineindex) {
    for (let i = lineindex + 1; i < lineCount; i++) {
        if (isKeywordLineText(getLine(i))) return i - 1;
    }
    return lineCount - 1;
}

/**
 * Resolves the filename corresponding to an include keyword line.
 * 
 * @param {number} lineCount - Total lines.
 * @param {function(number): string} getLine - Line reader callback.
 * @param {number} lineindex - Line index inside include block.
 * @param {string} basePath - Base directory path.
 * @returns {string} include filename.
 */
function getFilenameFromKeywordFromLineReader(lineCount, getLine, lineindex, basePath) {
    const linestart = startLineOfCurrentKeywordFromLineReader(lineCount, getLine, lineindex);
    const keyword = classifyKeywordLine(getLine(linestart)).normalizedKeyword;
    if (keyword.startsWith('*INCLUDE_PATH')) {
        throw new Error(i18n.get('keywordHasNoFilenameCard'));
    }
    if (!keyword.startsWith('*INCLUDE')) {
        throw new Error(i18n.get('keywordNotSupported'));
    }

    const lineend = endLineOfCurrentKeywordFromLineReader(lineCount, getLine, linestart);
    const blockLen = lineend - linestart + 1;
    const { includeEntries: entries } = includeScanner.collectIncludeDirectivesFromLineReader(
        blockLen,
        i => getLine(linestart + i),
        basePath
    );
    const relIdx = lineindex - linestart;
    const currentEntry = entries.find(entry => includeScanner.includeEntryContainsLine(entry, relIdx));

    if (currentEntry) return currentEntry.fileName;
    if (entries.length > 0) return entries[0].fileName;
    throw new Error(i18n.get('noFileToJumpTo'));
}

function startLineOfCurrentKeyword(lines, lineindex) {
    return startLineOfCurrentKeywordFromLineReader(lines.length, i => lines[i], lineindex);
}

function endLineOfCurrentKeyword(lines, lineindex) {
    return endLineOfCurrentKeywordFromLineReader(lines.length, i => lines[i], lineindex);
}

function getFilenameFromKeyword(lines, lineindex) {
    return getFilenameFromKeywordFromLineReader(lines.length, i => lines[i], lineindex, '.');
}

function getFilenameFromDocument(document, lineindex) {
    return getFilenameFromKeywordFromLineReader(
        document.lineCount,
        i => document.lineAt(i).text,
        lineindex,
        path.dirname(document.uri.fsPath)
    );
}

/**
 * Iterates folders in path list to find where target file exists on disk.
 * 
 * @param {string} filePath - Target file.
 * @param {string[]} paths - Ordered list of folders.
 * @returns {string} Absolute path.
 */
function searchFileFromPaths(filePath, paths) {
    for (const searchPath of paths) {
        const fullPath = path.resolve(searchPath, filePath);
        if (fs.existsSync(fullPath)) return fullPath;
    }
    throw new Error(i18n.get('fileNotFound', filePath));
}

/**
 * Locates the next line starting with '*' (excluding currentLine).
 * 
 * @param {number} lineCount - Total lines.
 * @param {function(number): string} getLine - Line reader.
 * @param {number} currentLine - Current line.
 * @returns {number} Next line index.
 */
function findNextKeywordFromLineReader(lineCount, getLine, currentLine) {
    for (let i = currentLine + 1; i < lineCount; i++) {
        if (isKeywordLineText(getLine(i))) return i;
    }
    throw new Error(i18n.get('noMoreKeywordsFound'));
}

function findNextKeyword(lines, currentLine) {
    return findNextKeywordFromLineReader(lines.length, i => lines[i], currentLine);
}

function findNextKeywordInDocument(document, currentLine) {
    return findNextKeywordFromLineReader(document.lineCount, i => document.lineAt(i).text, currentLine);
}

/**
 * Locates the previous line starting with '*' (excluding currentLine).
 * 
 * @param {number} lineCount - Total lines.
 * @param {function(number): string} getLine - Line reader.
 * @param {number} currentLine - Current line.
 * @returns {number} Previous line index.
 */
function findPreviousKeywordFromLineReader(lineCount, getLine, currentLine) {
    for (let i = currentLine - 1; i >= 0; i--) {
        if (isKeywordLineText(getLine(i))) return i;
    }
    throw new Error(i18n.get('noPreviousKeywordsFound'));
}

function findPreviousKeyword(lines, currentLine) {
    return findPreviousKeywordFromLineReader(lines.length, i => lines[i], currentLine);
}

function findPreviousKeywordInDocument(document, currentLine) {
    return findPreviousKeywordFromLineReader(document.lineCount, i => document.lineAt(i).text, currentLine);
}

/**
 * Creates a debounced callback function for updating document views on typing.
 * 
 * @param {function(): import('vscode').TextDocument|null} getActiveDocument - Gets current document.
 * @param {function(any): void} refreshDocument - Callback to trigger update.
 * @param {number} [delayMs=500] - Timer delay.
 * @param {function} [schedule=setTimeout] - Scheduling handle.
 * @param {function} [cancel=clearTimeout] - Cancellation handle.
 * @returns {function(any): void} Debounced caller.
 */
function createActiveDocumentDebouncer(getActiveDocument, refreshDocument, delayMs = 500, schedule = setTimeout, cancel = clearTimeout) {
    let timer;
    return (changedDocument) => {
        cancel(timer);
        timer = schedule(() => {
            if (getActiveDocument() === changedDocument) {
                refreshDocument(changedDocument);
            }
        }, delayMs);
    };
}

// --- Shared include traversal ---

/**
 * Recursively scans files in project inclusion tree starting from a root.
 * 
 * @param {string} rootPath - Main file path.
 * @param {function(number): void} [onProgress] - Progress listener callback.
 * @returns {Promise<string[]>} List of all dependency files found.
 */
async function collectIncludeFiles(rootPath, onProgress) {
    const visited = new Set();
    const queue = [rootPath];
    const files = [];
    while (queue.length > 0) {
        const filePath = queue.shift();
        if (visited.has(filePath) || !fs.existsSync(filePath)) continue;
        visited.add(filePath);
        files.push(filePath);
        if (onProgress) onProgress(files.length);
    const { includeEntries, searchPaths } = await includeScanner.collectIncludeDirectivesFromFile(filePath);
        for (const { fileName } of includeEntries) {
            try { queue.push(searchFileFromPaths(fileName, searchPaths)); } catch (e) {}
        }
        await new Promise(r => setImmediate(r));
    }
    return files;
}

/**
 * File decorations provider for Include Tree views, overlaying warnings or success icons.
 * @implements {vscode.FileDecorationProvider}
 */
class LsdynaFileDecorationProvider {
    includeTreeProvider: any;
    _onDidChangeFileDecorations: any;
    onDidChangeFileDecorations: any;

    constructor(includeTreeProvider) {
        this.includeTreeProvider = includeTreeProvider;
        this._onDidChangeFileDecorations = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
    }

    refresh() {
        this._onDidChangeFileDecorations.fire(undefined);
    }

    provideFileDecoration(uri) {
        if (uri.scheme !== 'file') return undefined;
        const key = normalizePathKey(uri.fsPath);

        if (this.includeTreeProvider.missingPaths.has(key)) {
            return {
                badge: '!',
                tooltip: i18n.get('includeDecorationMissing'),
                color: new vscode.ThemeColor('list.warningForeground')
            };
        }

        return undefined;
    }
}

/**
 * Quick fix: rewrite *INCLUDE path segments to match on-disk casing.
 * @implements {vscode.CodeActionProvider}
 */
function isCurrentIncludePathCaseDiagnostic(document, diagnostic) {
    const metadata = diagnostic && diagnostic.includePathCase;
    const diagnosticRange = diagnostic && diagnostic.range;
    if (
        !document ||
        !diagnosticRange ||
        !metadata ||
        !metadata.deckRelative ||
        !metadata.diskRelative ||
        !metadata.realPath ||
        !Array.isArray(metadata.edits) ||
        metadata.edits.length === 0
    ) {
        return false;
    }

    // Diagnostics are refreshed asynchronously. Never let an old range replace
    // text that the engineer has already changed.
    if (metadata.edits.some(edit =>
        !edit.range ||
        typeof edit.sourceText !== 'string' ||
        typeof edit.replacementText !== 'string' ||
        document.getText(edit.range) !== edit.sourceText
    )) {
        return false;
    }

    let actualRealPath;
    try {
        actualRealPath = fs.realpathSync.native(metadata.realPath);
        if (!fs.statSync(actualRealPath).isFile()) return false;
    } catch (_error) {
        // The include target may have been moved or removed after diagnostics ran.
        return false;
    }

    const normalizedExpected = path.normalize(metadata.diskRelative);
    const expectedIsAbsolute = path.isAbsolute(normalizedExpected);
    const expectedWithoutRoot = expectedIsAbsolute
        ? normalizedExpected.slice(path.parse(normalizedExpected).root.length)
        : normalizedExpected;
    const actualWithoutRoot = path.normalize(actualRealPath)
        .slice(path.parse(path.normalize(actualRealPath)).root.length);
    const splitSegments = value => String(value)
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean);
    const expectedSegments = splitSegments(expectedWithoutRoot);
    const actualSegments = splitSegments(actualWithoutRoot);
    if (!expectedSegments.length || expectedSegments.length > actualSegments.length) {
        return false;
    }
    const actualTail = actualSegments.slice(-expectedSegments.length);
    if (!expectedSegments.every((segment, index) => segment === actualTail[index])) {
        return false;
    }
    return !expectedIsAbsolute || expectedSegments.length === actualSegments.length;
}

class LsdynaIncludePathCaseCodeActionProvider {
    /** @type {WeakMap<object, { document: object, diagnostic: object }>} */
    pendingResolutions = new WeakMap();

    provideCodeActions(document, range, context) {
        if (!document || !isLsdynaFile(document)) return [];
        const diagnostics = (context && context.diagnostics) || [];
        const actions = [];
        for (const diagnostic of diagnostics) {
            if (!diagnostic || diagnostic.code !== 'include-path-case-mismatch') continue;
            if (!diagnostic.range) continue;
            if (!isCurrentIncludePathCaseDiagnostic(document, diagnostic)) continue;
            const action = new vscode.CodeAction(
                i18n.get('includePathCaseFix'),
                vscode.CodeActionKind.QuickFix
            );
            action.diagnostics = [diagnostic];
            action.isPreferred = true;
            // Keep the action unresolved while it is displayed. VS Code calls
            // resolveCodeAction immediately before apply/preview, which gives us
            // a final chance to reject document or disk changes made while the
            // action widget was open.
            this.pendingResolutions.set(action, { document, diagnostic });
            actions.push(action);
        }
        return actions;
    }

    resolveCodeAction(action) {
        const pending = this.pendingResolutions.get(action);
        this.pendingResolutions.delete(action);
        if (!pending) return action;
        const { document, diagnostic } = pending;
        if (document.isClosed || !isCurrentIncludePathCaseDiagnostic(document, diagnostic)) {
            return action;
        }
        const edit = new vscode.WorkspaceEdit();
        for (const replacement of diagnostic.includePathCase.edits) {
            edit.replace(document.uri, replacement.range, replacement.replacementText);
        }
        action.edit = edit;
        return action;
    }
}

/**
 * Resolve a keyword argument from command invocations (hover/code action/editor).
 *
 * @param {any} arg
 * @returns {string|null} Normalized storage form like *FOO, or null.
 */
function resolveCustomValidKeywordArg(arg) {
    if (typeof arg === 'string' && arg.trim()) {
        return normalizeCustomKeywordEntry(arg);
    }
    if (arg && typeof arg === 'object') {
        if (typeof arg.keyword === 'string' && arg.keyword.trim()) {
            return normalizeCustomKeywordEntry(arg.keyword);
        }
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document) {
        return null;
    }
    const lineText = editor.document.lineAt(editor.selection.active.line).text;
    const classification = classifyKeywordLine(lineText);
    if (!classification.isKeyword) {
        return null;
    }
    const name = classification.normalizedKeyword
        ? classification.normalizedKeyword.replace(/^\*/, '')
        : '';
    return normalizeCustomKeywordEntry(name);
}

/**
 * Run add-custom-valid-keyword with toast / undo / optional mode & target.
 *
 * @param {any} arg
 * @returns {Promise<void>}
 */
async function handleAddCustomValidKeywordCommand(arg) {
    let keyword = null;
    let target = vscode.ConfigurationTarget.Global;
    let mode = 'exact';
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
        keyword = resolveCustomValidKeywordArg(arg);
        if (arg.target === 'workspace' || arg.target === vscode.ConfigurationTarget.Workspace) {
            target = vscode.ConfigurationTarget.Workspace;
        }
        if (arg.mode === 'prefix' || arg.mode === 'custom' || arg.mode === 'exact') {
            mode = arg.mode;
        }
    } else {
        keyword = resolveCustomValidKeywordArg(arg);
    }
    if (!keyword) {
        vscode.window.showWarningMessage(i18n.get('customValidKeywordNeedKeyword'));
        return;
    }

    let entryToAdd = keyword;
    if (mode === 'prefix') {
        const suggested = suggestPrefixWildcard(keyword);
        if (suggested) {
            entryToAdd = suggested;
        } else {
            mode = 'custom';
        }
    }
    if (mode === 'custom') {
        const defaultValue = suggestPrefixWildcard(keyword) || `${keyword.endsWith('*') ? keyword : `${keyword}_*`}`.replace(/^\*?/, '*');
        const value = await vscode.window.showInputBox({
            title: i18n.get('addCustomValidKeywordPrefixAction'),
            prompt: i18n.get('customValidKeywordInputPrompt'),
            value: defaultValue,
            ignoreFocusOut: true,
            validateInput: (text) => normalizeCustomKeywordEntry(text)
                ? null
                : i18n.get('customValidKeywordInvalid'),
        });
        if (value == null) {
            return;
        }
        entryToAdd = normalizeCustomKeywordEntry(value);
        if (!entryToAdd) {
            vscode.window.showWarningMessage(i18n.get('customValidKeywordInvalid'));
            return;
        }
    }

    try {
        const result = await addCustomValidKeyword({ keyword: entryToAdd, target });
        if (result.status === 'invalid') {
            vscode.window.showWarningMessage(i18n.get('customValidKeywordInvalid'));
            return;
        }
        if (result.status === 'exists') {
            const manage = i18n.get('customValidKeywordManage');
            const choice = await vscode.window.showInformationMessage(
                i18n.get('customValidKeywordAlready', result.entry),
                manage
            );
            if (choice === manage) {
                await vscode.commands.executeCommand('extension.manageCustomValidKeywords');
            }
            return;
        }
        const undo = i18n.get('customValidKeywordUndo');
        const manage = i18n.get('customValidKeywordManage');
        const choice = await vscode.window.showInformationMessage(
            i18n.get('customValidKeywordAdded', result.entry),
            undo,
            manage
        );
        if (choice === undo) {
            const removed = await removeCustomValidKeyword({ keyword: result.entry, target });
            if (removed.ok) {
                vscode.window.showInformationMessage(i18n.get('customValidKeywordUndone', result.entry));
            }
        } else if (choice === manage) {
            await vscode.commands.executeCommand('extension.manageCustomValidKeywords');
        }
    } catch (error) {
        vscode.window.showErrorMessage(
            i18n.get('customValidKeywordAddFailed', error && error.message ? error.message : String(error))
        );
    }
}

/**
 * Collect unique unknown keyword storage entries from a document.
 * Prefers published diagnostics; falls back to the validator collector.
 *
 * @param {import('vscode').TextDocument} document
 * @returns {string[]}
 */
function collectUnknownKeywordsFromDocument(document) {
    if (!document) return [];
    /** @type {Set<string>} */
    const found: Set<string> = new Set();

    const pushRaw = (raw) => {
        const entry = normalizeCustomKeywordEntry(raw || '');
        if (entry) found.add(entry);
    };

    try {
        const published = typeof vscode.languages.getDiagnostics === 'function'
            ? vscode.languages.getDiagnostics(document.uri)
            : [];
        for (const diagnostic of published || []) {
            if (!diagnostic || diagnostic.code !== 'unknown-keyword') continue;
            if (diagnostic.source && diagnostic.source !== 'lsdyna') continue;
            const raw = diagnostic.unknownKeyword
                || (typeof diagnostic.message === 'string'
                    ? (diagnostic.message.match(/\*([A-Za-z0-9_+\-]+)/) || [])[1]
                    : null);
            pushRaw(raw);
        }
    } catch (_) {
        // ignore getDiagnostics failures in tests/mocks
    }

    if (found.size === 0) {
        const collected = keywordValidator.collectKeywordValidationDiagnostics(
            document,
            shouldSkipAutomaticDocumentScan
        );
        for (const diagnostic of collected || []) {
            if (!diagnostic || diagnostic.code !== 'unknown-keyword') continue;
            pushRaw(diagnostic.unknownKeyword);
        }
    }

    return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * Add every unknown keyword in the active (or given) document to the custom list.
 *
 * @param {any} arg
 * @returns {Promise<void>}
 */
async function handleAddAllUnknownKeywordsInFileCommand(arg) {
    let target = vscode.ConfigurationTarget.Global;
    if (arg && typeof arg === 'object') {
        if (arg.target === 'workspace' || arg.target === vscode.ConfigurationTarget.Workspace) {
            target = vscode.ConfigurationTarget.Workspace;
        }
    }

    const editor = vscode.window.activeTextEditor;
    const document = (arg && arg.document) || (editor && editor.document);
    if (!document || !isLsdynaFile(document)) {
        vscode.window.showWarningMessage(i18n.get('customValidKeywordNeedKeyword'));
        return;
    }

    const keywords = collectUnknownKeywordsFromDocument(document);
    if (keywords.length === 0) {
        vscode.window.showInformationMessage(i18n.get('customValidKeywordBatchEmpty'));
        return;
    }

    if (keywords.length >= 10) {
        const yes = i18n.get('customValidKeywordBatchConfirmYes');
        const choice = await vscode.window.showWarningMessage(
            i18n.get('customValidKeywordBatchConfirm', keywords.length),
            { modal: true },
            yes
        );
        if (choice !== yes) {
            return;
        }
    }

    try {
        const result = await addManyCustomValidKeywords({ keywords, target });
        if (result.status === 'none') {
            const manage = i18n.get('customValidKeywordManage');
            const choice = await vscode.window.showInformationMessage(
                i18n.get('customValidKeywordBatchNoneNew'),
                manage
            );
            if (choice === manage) {
                await vscode.commands.executeCommand('extension.manageCustomValidKeywords');
            }
            return;
        }
        const manage = i18n.get('customValidKeywordManage');
        const choice = await vscode.window.showInformationMessage(
            i18n.get('customValidKeywordBatchAdded', result.added.length, result.skipped.length),
            manage
        );
        if (choice === manage) {
            await vscode.commands.executeCommand('extension.manageCustomValidKeywords');
        }
    } catch (error) {
        vscode.window.showErrorMessage(
            i18n.get('customValidKeywordAddFailed', error && error.message ? error.message : String(error))
        );
    }
}

/**
 * Quick fixes for unknown-keyword diagnostics.
 * @implements {vscode.CodeActionProvider}
 */
class LsdynaUnknownKeywordCodeActionProvider {
    provideCodeActions(document, range, context) {
        if (!document || !isLsdynaFile(document)) return [];
        const diagnostics = (context && context.diagnostics) || [];
        const actions = [];
        const seen = new Set();
        for (const diagnostic of diagnostics) {
            if (!diagnostic || diagnostic.code !== 'unknown-keyword') continue;
            const raw = diagnostic.unknownKeyword
                || (typeof diagnostic.message === 'string'
                    ? (diagnostic.message.match(/\*([A-Za-z0-9_+\-]+)/) || [])[1]
                    : null);
            const entry = normalizeCustomKeywordEntry(raw || '');
            if (!entry || seen.has(entry)) continue;
            seen.add(entry);

            const addExact = new vscode.CodeAction(
                i18n.get('addCustomValidKeywordAction') + `: ${entry}`,
                vscode.CodeActionKind.QuickFix
            );
            addExact.diagnostics = [diagnostic];
            addExact.isPreferred = true;
            addExact.command = {
                command: 'extension.addCustomValidKeyword',
                title: i18n.get('addCustomValidKeywordAction'),
                arguments: [{ keyword: entry, mode: 'exact', target: 'global' }],
            };
            actions.push(addExact);

            const addWorkspace = new vscode.CodeAction(
                i18n.get('addCustomValidKeywordWorkspaceAction') + `: ${entry}`,
                vscode.CodeActionKind.QuickFix
            );
            addWorkspace.diagnostics = [diagnostic];
            addWorkspace.command = {
                command: 'extension.addCustomValidKeyword',
                title: i18n.get('addCustomValidKeywordWorkspaceAction'),
                arguments: [{ keyword: entry, mode: 'exact', target: 'workspace' }],
            };
            actions.push(addWorkspace);

            if (suggestPrefixWildcard(entry)) {
                const addPrefix = new vscode.CodeAction(
                    i18n.get('addCustomValidKeywordPrefixAction') + `: ${entry}`,
                    vscode.CodeActionKind.QuickFix
                );
                addPrefix.diagnostics = [diagnostic];
                addPrefix.command = {
                    command: 'extension.addCustomValidKeyword',
                    title: i18n.get('addCustomValidKeywordPrefixAction'),
                    arguments: [{ keyword: entry, mode: 'prefix', target: 'global' }],
                };
                actions.push(addPrefix);
            }
        }
        if (actions.length > 0) {
            const batch = new vscode.CodeAction(
                i18n.get('addAllUnknownKeywordsInFileAction'),
                vscode.CodeActionKind.QuickFix
            );
            batch.command = {
                command: 'extension.addAllUnknownKeywordsInFile',
                title: i18n.get('addAllUnknownKeywordsInFileAction'),
                arguments: [{ target: 'global' }],
            };
            actions.push(batch);

            const batchWorkspace = new vscode.CodeAction(
                i18n.get('addAllUnknownKeywordsInFileWorkspaceAction'),
                vscode.CodeActionKind.QuickFix
            );
            batchWorkspace.command = {
                command: 'extension.addAllUnknownKeywordsInFile',
                title: i18n.get('addAllUnknownKeywordsInFileWorkspaceAction'),
                arguments: [{ target: 'workspace' }],
            };
            actions.push(batchWorkspace);

            const manage = new vscode.CodeAction(
                i18n.get('customValidKeywordManage'),
                vscode.CodeActionKind.QuickFix
            );
            manage.command = {
                command: 'extension.manageCustomValidKeywords',
                title: i18n.get('customValidKeywordManage'),
            };
            actions.push(manage);
        }
        return actions;
    }
}

/**
 * Whether cursor is on an *INCLUDE filename card (not *INCLUDE_PATH, not comments).
 * Shared by the completion provider and (P1) on-type triggerSuggest.
 *
 * @param {import('vscode').TextDocument} document
 * @param {import('vscode').Position} position
 * @returns {boolean}
 */
function isIncludeFilenameCompletionContext(document, position) {
    if (!document || !position) return false;
    const lineText = document.lineAt(position.line).text;
    const linesBeforeAndCurrent = [];
    for (let i = 0; i <= position.line; i++) {
        linesBeforeAndCurrent.push(document.lineAt(i).text);
    }
    return includePathCompletion.isIncludeFilenameLineContext({
        lineText,
        positionCharacter: position.character,
        linesBeforeAndCurrent,
        isKeywordLineText,
        classifyKeywordLine,
    });
}

function activeDocumentHasMultipleSelections(document) {
    const editor = vscode.window.activeTextEditor;
    return !!(
        editor &&
        editor.document === document &&
        Array.isArray(editor.selections) &&
        editor.selections.length !== 1
    );
}

/**
 * Autocomplete for *INCLUDE paths: browse-by-level (/ \) + bare-name search.
 * Inserts full relative paths with `/`. Does not rely on Ctrl+Space.
 * @implements {vscode.CompletionItemProvider}
 */
class LsdynaIncludeCompletionProvider {
    provideCompletionItems(document, position, token, context) {
        if (!document || !document.uri || !document.uri.fsPath) return [];
        if (activeDocumentHasMultipleSelections(document)) return [];
        if (shouldSkipAutomaticDocumentScan(document)) return [];
        if (!isIncludeFilenameCompletionContext(document, position)) return [];

        const lineText = document.lineAt(position.line).text;
        const trimmedStart = lineText.length - lineText.trimStart().length;
        if (position.character < trimmedStart) return [];

        const range = new vscode.Range(position.line, trimmedStart, position.line, position.character);
        const currentPrefix = lineText.slice(trimmedStart, position.character);

        const documentDir = path.dirname(document.uri.fsPath);
        const validPaths = includePathCompletion.resolveValidSearchDirs(
            getSearchPath(document),
            documentDir
        );
        if (validPaths.length === 0) {
            return new vscode.CompletionList([], true);
        }

        const { mode, entries } = includePathCompletion.collectIncludePathEntries(
            validPaths,
            currentPrefix
        );

        const items = [];
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            const kind = entry.kind === 'directory'
                ? vscode.CompletionItemKind.Folder
                : vscode.CompletionItemKind.File;
            const item = new vscode.CompletionItem(entry.relPath, kind);
            item.insertText = entry.relPath;
            // Browse candidates are already filtered by the current path segment. Give
            // them the same exact filter text so VS Code preserves the core natural order
            // and does not reject `/ma`, `\ma`, `./ma`, or mixed path prefixes.
            item.filterText = mode === 'browse'
                ? currentPrefix
                : entry.kind === 'file'
                    ? `${entry.relPath} ${path.posix.basename(entry.relPath)}`
                    : entry.relPath;
            item.detail = entry.searchRoot
                ? `${i18n.get('includeFile')} · ${entry.searchRoot}`
                : i18n.get('includeFile');
            item.range = range;
            if (entry.kind === 'directory') {
                item.commitCharacters = ['/'];
            }
            if (mode === 'search' && typeof entry.score === 'number') {
                // Higher score → lower sortText for VS Code ordering
                item.sortText = String(1000 - Math.min(999, Math.round(entry.score))).padStart(4, '0')
                    + entry.relPath;
            } else {
                // Preserve directory-first natural ordering from listBrowseLevel.
                item.sortText = `0_${String(index).padStart(8, '0')}`;
            }
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }
}

function getCardFieldsForLine(document, lineNum) {
    let kwLine = null;
    for (let i = lineNum - 1; i >= 0; i--) {
        if (isKeywordLineText(document.lineAt(i).text)) { kwLine = i; break; }
    }
    if (kwLine === null) return null;

    const kwText = document.lineAt(kwLine).text.trim();

    const ignoreKeywords = getLsdynaConfigurationValue('ignoreFormattingKeywords', [], document.uri) || [];
    const kwTextUpper = kwText.toUpperCase();
    for (const prefix of ignoreKeywords) {
        if (kwTextUpper.startsWith(prefix.toUpperCase())) {
            return null;
        }
    }

    // Long format (LS-DYNA `*KEYWORD+` or `LONG=Y/S`) uses 20-char fields, not the
    // 10/8-char columns the schema encodes. Rather than re-aligning to the wrong
    // columns and corrupting the line, bow out so cell protect / format fall back
    // to plain editing. Notify once per document so the user knows why.
    // Two forms: per-keyword `*NODE+` on this block's keyword line, or a deck-wide
    // `*KEYWORD LONG=Y` header that applies to every block.
    if (keywordSchema.isLongFormatKeyword(kwText)) {
        notifyLongFormatOnce(document, kwText);
        return null;
    }
    if (documentUsesGlobalLongFormat(document)) {
        notifyLongFormatOnce(document, '*KEYWORD LONG=Y');
        return null;
    }

    return keywordSchema.getCardForDocumentLine(document, lineNum, getFieldData());
}

const globalLongFormatCache = new WeakMap();

/**
 * Whether the deck's `*KEYWORD` header enables deck-wide long format (`LONG=Y/S`).
 * `*KEYWORD` is the first keyword in a valid deck, so we only scan from the top to
 * the first keyword line. Cached per document version to avoid rescanning per line.
 *
 * @param {import('vscode').TextDocument} document
 * @returns {boolean}
 */
function documentUsesGlobalLongFormat(document) {
    if (!document) return false;
    const cached = globalLongFormatCache.get(document);
    if (cached && cached.version === document.version) return cached.value;

    let value = false;
    const maxScan = Math.min(document.lineCount, 200);
    for (let i = 0; i < maxScan; i++) {
        const text = document.lineAt(i).text;
        if (!isKeywordLineText(text)) continue;
        const kw = classifyKeywordLine(text).normalizedKeyword;
        if (kw === '*KEYWORD') {
            value = keywordSchema.isLongFormatKeyword(text);
        }
        // First keyword line decides: if it is *KEYWORD we read its LONG option;
        // otherwise there is no deck-wide long header to honor.
        break;
    }

    globalLongFormatCache.set(document, { version: document.version, value });
    return value;
}

const longFormatNoticeShown = new Set();
const unsafeFormatNoticeShown = new Set();

function notifyLongFormatOnce(document, kwText) {
    try {
        const key = document?.uri?.toString?.() || '';
        if (longFormatNoticeShown.has(key)) return;
        longFormatNoticeShown.add(key);
        const shortKw = String(kwText || '').split(/\s+/)[0];
        vscode.window.setStatusBarMessage(i18n.get('longFormatCellEditPaused', shortKw), 6000);
    } catch (_) {
        // status message is best-effort; never block card resolution
    }
}

function notifyUnsafeFormatOnce(document) {
    try {
        const key = document?.uri?.toString?.() || document?.uri?.fsPath || '';
        if (unsafeFormatNoticeShown.has(key)) return;
        unsafeFormatNoticeShown.add(key);
        vscode.window.setStatusBarMessage(i18n.get('unsafeFormatSkipped'), 6000);
    } catch (_) {
        // status message is best-effort; preserving the line is the safety boundary
    }
}

function isFieldHeaderCommentLine(text) {
    return String(text || '').trimStart().startsWith('$#');
}

function findNextDataLineInKeywordBlock(document, startLine) {
    for (let i = Math.max(0, startLine); i < document.lineCount; i++) {
        const text = document.lineAt(i).text;
        if (isKeywordLineText(text)) return null;
        if (!String(text || '').trimStart().startsWith('$')) return i;
    }
    return null;
}

function getDataCardDisplayIndexForLine(document, lineNum) {
    let kwLine = null;
    for (let i = lineNum - 1; i >= 0; i--) {
        if (isKeywordLineText(document.lineAt(i).text)) { kwLine = i; break; }
    }
    if (kwLine === null) return 0;

    let dataIndex = 0;
    for (let i = kwLine + 1; i <= lineNum && i < document.lineCount; i++) {
        const t = document.lineAt(i).text.trimStart();
        if (!t.startsWith('$')) dataIndex++;
    }

    return Math.max(0, dataIndex - 1);
}

class LsdynaFieldCompletionProvider {
    provideCompletionItems(document, position, token, context) {
        if (activeDocumentHasMultipleSelections(document)) return [];
        if (!document || shouldSkipAutomaticDocumentScan(document)) return [];

        const line = document.lineAt(position.line);
        const text = line.text;
        const trimmed = text.trimStart();
        const textBeforeCursor = text.slice(0, position.character).trim();
        const isCommentTrigger = textBeforeCursor === '$' || textBeforeCursor === '$#';
        const textCardInfo = keywordSchema.getCardInfoForDocumentLine(
            document,
            position.line,
            getFieldData()
        );

        // Guard: Skip keywords and non-trigger comments
        if (textCardInfo?.isTextCard || isKeywordLineText(text) || (trimmed.startsWith('$') && !isCommentTrigger)) return [];

        if (isCommentTrigger) {
            const targetLineNum = findNextDataLineInKeywordBlock(document, position.line + 1);
            if (targetLineNum === null) return [];

            const card = getCardFieldsForLine(document, targetLineNum);
            if (!card || card.length === 0) return [];

            const commentText = generateCommentLine(card);
            if (!commentText) return [];

            const item = new vscode.CompletionItem(commentText.trimEnd(), vscode.CompletionItemKind.Snippet);
            item.detail = i18n.get('fieldCommentCompletionDetail');
            item.documentation = new vscode.MarkdownString(`**${i18n.get('fieldCommentCompletionTitle')}**\n\n${i18n.get('fieldCommentCompletionInsertHint')}\n\`\`\`lsdyna\n${commentText}\n\`\`\``);
            item.insertText = commentText;
            item.range = new vscode.Range(position.line, 0, position.line, line.text.length);

            return [item];
        }

        const card = getCardFieldsForLine(document, position.line);
        if (!card || card.length === 0) return [];

        // Skip completions for title/filename fields (single wide field)
        if (card.length === 1 && card[0].w >= 40) return [];

        const displayIndex = getDataCardDisplayIndexForLine(document, position.line);

        const items = [];

        // 1. Row Card Template (Only when line is empty or near the beginning)
        if (text.trim().length === 0 || position.character <= 1) {
            const templateItem = new vscode.CompletionItem(
                i18n.get('rowTemplateLabel', displayIndex + 1),
                vscode.CompletionItemKind.Snippet
            );
            templateItem.detail = i18n.get('rowTemplateDetail');
            templateItem.documentation = new vscode.MarkdownString(i18n.get('rowTemplateDocumentation'));

            let snippetText = '';
            let prevEnd = 0;
            for (let j = 0; j < card.length; j++) {
                const f = card[j];
                const gap = f.p - prevEnd;
                if (gap > 0) snippetText += ' '.repeat(gap);

                const isFloat = f.h && (f.h.toLowerCase().includes('float') || f.h.toLowerCase().includes('real') || f.n.toUpperCase().startsWith('X') || f.n.toUpperCase().startsWith('Y') || f.n.toUpperCase().startsWith('Z'));
                const defVal = isFloat ? '0.0' : '0';
                const padLen = Math.max(0, f.w - defVal.length);
                const placeholder = f.w >= 40 ? defVal + ' '.repeat(padLen) : ' '.repeat(padLen) + defVal;

                snippetText += `\${${j + 1}:${placeholder}}`;
                prevEnd = f.p + f.w;
            }
            templateItem.insertText = new vscode.SnippetString(snippetText);
            // Ensure template is sorted at top
            templateItem.sortText = '0_' + displayIndex;
            items.push(templateItem);
        }

        // 2. Individual Aligned Fields
        const col = position.character;
        for (let j = 0; j < card.length; j++) {
            const f = card[j];
            if (col <= f.p) {
                const padding = f.p - col;
                const label = i18n.get('fieldCompletionLabel', f.n, f.p + 1, f.p + f.w);
                const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Field);
                item.detail = i18n.get('fieldDetail', f.t || 'I', f.n);
                if (f.h) {
                    const helpMd = buildFieldHelpMarkdown(f);
                    const doc = new vscode.MarkdownString(helpMd || f.h);
                    doc.supportHtml = true;
                    doc.isTrusted = true;
                    item.documentation = doc;
                }

                const isFloat = f.h && (f.h.toLowerCase().includes('float') || f.h.toLowerCase().includes('real') || f.n.toUpperCase().startsWith('X') || f.n.toUpperCase().startsWith('Y') || f.n.toUpperCase().startsWith('Z'));
                const defVal = isFloat ? '0.0' : '0';
                const padLen = Math.max(0, f.w - defVal.length);
                const placeholder = ' '.repeat(padLen) + defVal;

                // Insert spaces to align, then insert aligned placeholder
                const insertText = ' '.repeat(padding) + `\${1:${placeholder}}`;
                item.insertText = new vscode.SnippetString(insertText);
                item.range = new vscode.Range(position.line, col, position.line, col);
                // Sort individual fields in order of column position
                item.sortText = '1_' + String(f.p).padStart(3, '0');
                items.push(item);
            }
        }

        return items;
    }
}

const snippetFile = path.join(__dirname, '..', 'snippets', 'lsdyna.json');
let keywordSnippets = null;

class LsdynaKeywordCompletionProvider {
    provideCompletionItems(document, position, token, context) {
        if (activeDocumentHasMultipleSelections(document)) return [];
        if (!document || shouldSkipAutomaticDocumentScan(document)) return [];

        const line = document.lineAt(position.line);
        const textBeforeCursor = line.text.slice(0, position.character);

        if (!isKeywordLineText(textBeforeCursor)) {
            return [];
        }

        if (!keywordSnippets) {
            try {
                const fs = require('fs');
                const data = fs.readFileSync(snippetFile, 'utf8');
                const parsed = JSON.parse(data);
                keywordSnippets = [];
                for (const key in parsed) {
                    const snippet = parsed[key];
                    if (!snippet.prefix || snippet.prefix.length === 0) continue;
                    const item = new vscode.CompletionItem(snippet.prefix[0], vscode.CompletionItemKind.Snippet);
                    let bodyStr = snippet.body.join('\n');
                    // Remove the extra newline before $0 at the end of the snippet
                    bodyStr = bodyStr.replace(/\n\$0$/, '$0');
                    
                    // Remove leading '*' from the snippet body to prevent double '**'
                    if (bodyStr.startsWith('*')) {
                        bodyStr = bodyStr.substring(1);
                    }
                    
                    // Replace non-numeric placeholders with spaces
                    bodyStr = bodyStr.replace(/\$\{\d+:([^}]+)\}/g, (match, p1) => {
                        const trimmed = p1.trim();
                        const isNum = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/i.test(trimmed);
                        if (!isNum && trimmed.length > 0) {
                            return match.replace(p1, ' '.repeat(p1.length));
                        }
                        return match;
                    });

                    item.insertText = new vscode.SnippetString(bodyStr);
                    if (snippet.description) {
                        item.documentation = new vscode.MarkdownString(snippet.description);
                        item.detail = snippet.description;
                    }
                    keywordSnippets.push(item);
                }
            } catch (e) {
                logDebug('Failed to load LS-DYNA snippets: ' + e.message);
                keywordSnippets = [];
            }
        }

        return keywordSnippets;
    }
}


function generateCommentLine(card) {
    if (!card || card.length === 0) return '';
    let line = '$#';
    let written = 2;
    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        const available = f.p + f.w - written;
        if (available <= 0) continue;
        
        const name = (f.n || '').toLowerCase().substring(0, available);
        if (card.length === 1 && f.w > 80) {
            line = '$# ' + name;
            written = line.length;
            continue;
        }
        
        if (f.w >= 40) {
            if (i === 0) {
                line = ('$# ' + name).padEnd(f.p + f.w, ' ');
            } else {
                line += name.padEnd(available, ' ');
            }
        } else {
            line += name.padStart(available, ' ');
        }
        
        written = f.p + f.w;
    }
    return line;
}

async function handleEnterIndentationRemoval(event) {
    if (event.document.languageId !== 'lsdyna') return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) return;

    const changes = Array.isArray(event.contentChanges) ? event.contentChanges : [];
    if (changes.length === 0) return;

    const sorted = [...changes].sort((left, right) => {
        const lineDelta = left.range.start.line - right.range.start.line;
        return lineDelta || left.range.start.character - right.range.start.character;
    });
    const candidates = [];
    let cumulativeLineDelta = 0;

    for (const change of sorted) {
        const match = change.rangeLength === 0 && String(change.text || '').match(/^\r?\n([ \t]+)$/);
        if (!match) {
            if (changes.length > 1) return;
            continue;
        }

        const indentation = match[1];
        const nextLineNum = change.range.start.line + cumulativeLineDelta + 1;
        const replacedLineCount = change.range.end.line - change.range.start.line;
        const insertedLineCount = (String(change.text).match(/\n/g) || []).length;
        cumulativeLineDelta += insertedLineCount - replacedLineCount;

        try {
            if (event.document.lineAt(nextLineNum).text !== indentation) {
                if (changes.length > 1) return;
                continue;
            }
        } catch (_) {
            return;
        }
        candidates.push({ line: nextLineNum, length: indentation.length });
    }

    if (candidates.length === 0 || (changes.length > 1 && candidates.length !== changes.length)) return;

    try {
        await editor.edit(editBuilder => {
            for (const candidate of candidates) {
                editBuilder.delete(new vscode.Range(
                    candidate.line, 0,
                    candidate.line, candidate.length,
                ));
            }
        }, { undoStopBefore: false, undoStopAfter: false });
    } catch (err) {
        console.error('[lsdyna] Failed to clear auto indent spaces:', err);
    }
}


function extractSmartTokens(text) {
    const trimmed = text.trimStart();
    const rawTokens = trimmed.split(/\s+/).filter(t => t.length > 0);
    const tokens = [];
    const numPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/i;
    for (const t of rawTokens) {
        if (numPattern.test(t)) {
            tokens.push(t);
            continue;
        }
        const matchAlphaSignedNum = t.match(/^([A-Za-z0-9_]+)([+-](?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/i);
        if (matchAlphaSignedNum) {
            tokens.push(matchAlphaSignedNum[1], matchAlphaSignedNum[2]);
            continue;
        }
        const matchNumNum = t.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([+-](?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/i);
        if (matchNumNum) {
            tokens.push(matchNumNum[1], matchNumNum[2]);
            continue;
        }
        tokens.push(t);
    }
    return tokens;
}

function planAlignedLine(text, card, isFieldHeaderLine = false) {
    const originalText = String(text || '');
    const unchanged = () => ({ status: 'unchanged', text: originalText });
    const unsafe = reason => ({ status: 'unsafe', text: originalText, reason });
    const completed = alignedText => ({
        status: alignedText === originalText ? 'unchanged' : 'aligned',
        text: alignedText,
    });

    if (!card || card.length === 0) return unchanged();

    let processText = originalText;
    let commentPrefix = '';

    if (isFieldHeaderLine) {
        processText = originalText.trimStart();
        const match = processText.match(/^(\$#?)\s*/);
        if (match) {
            commentPrefix = match[1];
            processText = processText.substring(commentPrefix.length).trimStart();
        } else if (processText.startsWith('$')) {
            commentPrefix = '$';
            processText = processText.substring(1).trimStart();
        }
    }

    if (!processText.trim()) {
        let emptyLine = '';
        let prevEnd = 0;
        for (const f of card) {
            const gap = f.p - prevEnd;
            if (gap > 0) emptyLine += ' '.repeat(gap);
            emptyLine += ' '.repeat(f.w);
            prevEnd = f.p + f.w;
        }
        if (isFieldHeaderLine && commentPrefix) {
            if (emptyLine.startsWith(' '.repeat(commentPrefix.length))) {
                return completed(commentPrefix + emptyLine.substring(commentPrefix.length));
            }
            return completed(commentPrefix + emptyLine.substring(1));
        }
        return completed(emptyLine);
    }

    const hasComma = processText.includes(',');
    let useTokens = false;
    let tokens = [];

    if (hasComma) {
        tokens = processText.split(',').map(t => t.trim());
        useTokens = true;
    } else {
        tokens = extractSmartTokens(processText);
        
        let hasInvalidInternalSpace = false;
        const totalCardWidth = card[card.length - 1].p + card[card.length - 1].w;
        const isOverflowing = processText.trimEnd().length > totalCardWidth;

        for (let i = 0; i < card.length; i++) {
            const f = card[i];
            if (f.p >= processText.length) break;
            const rawVal = processText.slice(f.p, Math.min(processText.length, f.p + f.w));
            const val = rawVal.trim();
            if (val.length > 0 && /\s/.test(val)) {
                if (f.t !== 'string' && f.t !== 'character') {
                    hasInvalidInternalSpace = true;
                }
            }
        }
        
        const validPhysValsCount = card.map(f => processText.slice(f.p, f.p + f.w).trim()).filter(v => v.length > 0).length;

        if (isFieldHeaderLine || ((hasInvalidInternalSpace || isOverflowing) && tokens.length >= validPhysValsCount)) {
            useTokens = true;
        }
    }

    const physVals = [];
    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        if (f.p >= processText.length) {
            physVals.push('');
            continue;
        }
        const rawVal = processText.slice(f.p, Math.min(processText.length, f.p + f.w));
        physVals.push(rawVal.trim());
    }

    const totalCardWidth = card[card.length - 1].p + card[card.length - 1].w;
    if (!useTokens && processText.slice(totalCardWidth).trim().length > 0) {
        return unsafe('content-after-card');
    }

    const values = card.map((_, i) => {
        if (!useTokens) return physVals[i];
        if (i >= tokens.length) return '';
        if (i === card.length - 1 && tokens.length > card.length) {
            return tokens.slice(i).join(hasComma ? ',' : ' ');
        }
        return tokens[i];
    });

    const paddedValues = [];
    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        const val = values[i];
        let displayVal = val;

        if (f.n && f.n.startsWith('PRMR')) {
            const match = val.match(/^([a-zA-Z])\s*(.*)$/);
            if (match) {
                const prefix = match[1];
                const name = match[2];
                displayVal = name.length > 0 ? `${prefix} ${name}` : prefix;
            }
        }

        if (isFieldHeaderLine && i === 0 && commentPrefix) {
            const headerValue = f.w >= 40
                ? `${commentPrefix} ${displayVal}`
                : `${commentPrefix}${displayVal}`;
            if (headerValue.length > f.w) return unsafe('field-overflow');

            if (f.w >= 40) {
                paddedValues.push(headerValue.padEnd(f.w, ' '));
            } else {
                const spacesLeft = f.w - commentPrefix.length - displayVal.length;
                paddedValues.push(commentPrefix + ' '.repeat(spacesLeft) + displayVal);
            }
            continue;
        }

        if (displayVal.length > f.w) return unsafe('field-overflow');
        paddedValues.push(
            (f.n && f.n.startsWith('PRMR')) || f.w >= 40
                ? displayVal.padEnd(f.w, ' ')
                : displayVal.padStart(f.w, ' ')
        );
    }

    let alignedText = '';
    let prevEnd = 0;

    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        const gap = f.p - prevEnd;
        if (gap > 0) alignedText += ' '.repeat(gap);
        alignedText += paddedValues[i];
        prevEnd = f.p + f.w;
    }

    return completed(alignedText.trimEnd());
}

function alignLineText(text, card, isFieldHeaderLine = false) {
    return planAlignedLine(text, card, isFieldHeaderLine).text;
}

function getPathEntryRange(document, lineNum, kwLine) {
    let start = lineNum;
    while (start > kwLine + 1) {
        const prevText = document.lineAt(start - 1).text.trim();
        if (isKeywordLineText(prevText) || prevText.startsWith('$')) {
            break;
        }
        if (prevText.endsWith(' +')) {
            start--;
        } else {
            break;
        }
    }

    let end = lineNum;
    while (end < document.lineCount - 1) {
        const curText = document.lineAt(end).text.trim();
        if (curText.endsWith(' +')) {
            const nextText = document.lineAt(end + 1).text.trim();
            if (isKeywordLineText(nextText) || nextText.startsWith('$')) {
                break;
            }
            end++;
        } else {
            break;
        }
    }

    return { start, end };
}

function splitIncludePathEntry(fullPath) {
    if (fullPath.length > 236) {
        return { status: 'tooLong', maxLength: 236, actualLength: fullPath.length };
    }
    if (fullPath.length <= 80) return { status: 'unchanged', lines: [fullPath] };
    if (fullPath.length <= 156) {
        return { status: 'formatted', lines: [
            fullPath.slice(0, 78) + ' +',
            fullPath.slice(78)
        ] };
    }
    return { status: 'formatted', lines: [
        fullPath.slice(0, 78) + ' +',
        fullPath.slice(78, 156) + ' +',
        fullPath.slice(156)
    ] };
}

function isIncludeFileKeyword(kwText) {
    const upper = String(kwText || '').trim().toUpperCase();
    return upper.startsWith('*INCLUDE') && !upper.startsWith('*INCLUDE_PATH');
}

function isSingleEightyColumnCard(cardFields) {
    return Array.isArray(cardFields) &&
        cardFields.length === 1 &&
        Number(cardFields[0]?.w) === 80;
}

async function formatPathEntryIfNeeded(document, lineNum, kwLine) {
    const edit = createPathEntryFormatEdit(document, lineNum, kwLine);
    const result = edit.result;
    if (result.status === 'tooLong' || !edit.range) return result;

    isFormattingLine = true;
    try {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document) {
            await editor.edit(editBuilder => {
                editBuilder.replace(edit.range, edit.newText);
            }, { undoStopBefore: false, undoStopAfter: false });
        } else {
            const workspaceEdit = new vscode.WorkspaceEdit();
            workspaceEdit.replace(document.uri, edit.range, edit.newText);
            await vscode.workspace.applyEdit(workspaceEdit);
        }
    } catch (err) {
        console.error('Error formatting path entry:', err);
    } finally {
        isFormattingLine = false;
    }
    return result;
}

function createPathEntryFormatEdit(document, lineNum, kwLine) {
    const range = getPathEntryRange(document, lineNum, kwLine);
    const lines = [];
    for (let i = range.start; i <= range.end; i++) {
        lines.push(document.lineAt(i).text);
    }

    const parts = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.endsWith(' +')) {
            parts.push(trimmed.slice(0, -2));
        } else {
            parts.push(trimmed);
        }
    }

    const fullPath = parts.join('');
    const result = splitIncludePathEntry(fullPath);
    if (result.status === 'tooLong') return { result };
    const newLines = result.lines;

    const newText = newLines.join('\n');
    const oldText = lines.join('\n');

    if (newText === oldText) return { result };

    const endLineText = document.lineAt(range.end).text;
    return {
        result,
        range: new vscode.Range(
            new vscode.Position(range.start, 0),
            new vscode.Position(range.end, endLineText.length)
        ),
        newText,
    };
}

let isFormattingLine = false;
let formatLineErrorObserverForTesting = null;

function setFormatLineErrorObserverForTesting(observer) {
    formatLineErrorObserverForTesting = typeof observer === 'function' ? observer : null;
}

function matchesConfiguredReadonlyPattern(document, settingName) {
    if (!document || !document.uri || !vscode.languages || typeof vscode.languages.match !== 'function') {
        return false;
    }
    const patterns = vscode.workspace
        .getConfiguration('files', document.uri)
        .get(settingName, {});
    if (!patterns || typeof patterns !== 'object' || Array.isArray(patterns)) return false;

    for (const [pattern, enabled] of Object.entries(patterns)) {
        if (!enabled || typeof pattern !== 'string' || pattern.length === 0) continue;
        try {
            const filter = { scheme: document.uri.scheme, pattern };
            if (vscode.languages.match(filter, document) > 0) return true;
        } catch (_) {
            // An invalid user glob must not crash selection or editor switching.
        }
    }
    return false;
}

async function isDocumentReadonlyForAutomaticEdit(document) {
    const included = matchesConfiguredReadonlyPattern(document, 'readonlyInclude');
    const excluded = included && matchesConfiguredReadonlyPattern(document, 'readonlyExclude');
    if (included && !excluded) return true;

    const filesConfiguration = vscode.workspace.getConfiguration('files', document?.uri);
    if (
        filesConfiguration.get('readonlyFromPermissions', false) === true &&
        document?.uri &&
        vscode.workspace.fs &&
        typeof vscode.workspace.fs.stat === 'function'
    ) {
        try {
            const stat = await vscode.workspace.fs.stat(document.uri);
            const readonlyFlag = vscode.FilePermission && vscode.FilePermission.Readonly;
            if (readonlyFlag && (Number(stat.permissions || 0) & readonlyFlag) !== 0) return true;
        } catch (_) {
            // A missing or concurrently removed file is not a safe automatic edit target.
            return true;
        }

        // VS Code 1.130's local file provider does not surface the Windows DOS
        // read-only attribute through FileStat.permissions. Probe a writable handle
        // as the final authority so an automatic WorkspaceEdit cannot dirty a deck
        // that the operating system itself refuses to open for writing.
        if (document.uri.scheme === 'file' && document.uri.fsPath) {
            let handle = null;
            try {
                handle = await fs.promises.open(document.uri.fsPath, 'r+');
                await handle.close();
                handle = null;
            } catch (_) {
                if (handle) {
                    try {
                        await handle.close();
                    } catch (_) {
                        // The permission probe already failed; keep the edit blocked.
                    }
                }
                return true;
            }
        }
    }
    return false;
}

async function formatLineIfNeeded(document, lineNum) {
    if (isFormattingLine) return;
    if (lineNum >= document.lineCount) return;
    if (await isDocumentReadonlyForAutomaticEdit(document)) return;
    if (isFormattingLine) return;
    if (document.isClosed || lineNum < 0 || lineNum >= document.lineCount) return;

    const line = document.lineAt(lineNum);
    const text = line.text;
    const trimmed = text.trimStart();

    // Skip keywords
    if (isKeywordLineText(text)) return;
    if (keywordSchema.getCardInfoForDocumentLine(document, lineNum, getFieldData())?.isTextCard) return;
    const isCommentLine = trimmed.startsWith('$');
    const isFieldHeaderLine = isFieldHeaderCommentLine(text);
    if (isCommentLine && !isFieldHeaderLine) return;

    // Find the enclosing keyword line
    let kwLine = null;
    for (let i = lineNum - 1; i >= 0; i--) {
        if (isKeywordLineText(document.lineAt(i).text)) { kwLine = i; break; }
    }
    
    if (kwLine !== null) {
        const kwText = classifyKeywordLine(document.lineAt(kwLine).text).normalizedKeyword;
        if (kwText.startsWith('*PARAMETER')) return;
        if (!isCommentLine && (kwText === '*INCLUDE_PATH' || kwText === '*INCLUDE_PATH_RELATIVE')) {
            await formatPathEntryIfNeeded(document, lineNum, kwLine);
            return;
        }
        if (!trimmed.startsWith('$') && isIncludeFileKeyword(kwText)) {
            const cardFields = getCardFieldsForLine(document, lineNum);
            if (isSingleEightyColumnCard(cardFields)) {
                await formatPathEntryIfNeeded(document, lineNum, kwLine);
                return;
            }
        }
    }

    let targetLineNum = lineNum;

    if (isFieldHeaderLine) {
        const nextDataLine = findNextDataLineInKeywordBlock(document, lineNum + 1);
        if (nextDataLine === null) return;
        targetLineNum = nextDataLine;
    }

    const cardFields = getCardFieldsForLine(document, targetLineNum);
    if (!cardFields || cardFields.length === 0) return;

    const alignment = planAlignedLine(text, cardFields, isFieldHeaderLine);
    if (alignment.status === 'unsafe') {
        notifyUnsafeFormatOnce(document);
        return;
    }
    const alignedText = alignment.text;
    if (text === alignedText) return;

    isFormattingLine = true;
    try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        if (editor.document === document) {
            // A TextEditor proxy can remain addressable while VS Code is closing
            // its view. Calling edit() on that stale proxy throws
            // "Illegal argument: TextEditor"; revalidate visibility immediately
            // before committing the automatic write.
            if (
                'viewColumn' in editor &&
                (
                    editor.viewColumn === undefined ||
                    !vscode.window.visibleTextEditors.includes(editor)
                )
            ) {
                return;
            }
            const range = new vscode.Range(
                new vscode.Position(lineNum, 0),
                new vscode.Position(lineNum, text.length)
            );
            await editor.edit(editBuilder => {
                editBuilder.replace(range, alignedText);
            }, { undoStopBefore: false, undoStopAfter: false });
        } else {
            const edit = new vscode.WorkspaceEdit();
            const range = new vscode.Range(
                new vscode.Position(lineNum, 0),
                new vscode.Position(lineNum, text.length)
            );
            edit.replace(document.uri, range, alignedText);
            await vscode.workspace.applyEdit(edit);
        }
    } catch (err) {
        if (formatLineErrorObserverForTesting) {
            formatLineErrorObserverForTesting(err);
        }
        console.error('Error formatting line:', err);
    } finally {
        isFormattingLine = false;
    }
}

/** @type {ReturnType<typeof createCardCellEditGuard>|null} */
let cardCellEditGuard = null;
/** @type {WeakMap<object, number>} */
const cardCellOwnedEditDepth = new WeakMap();
/** @type {WeakMap<object, { promise: Promise<void>, release: () => void }>} */
const cardCellPostEditBarriers = new WeakMap();
/** @type {WeakMap<object, {
 * editor: import('vscode').TextEditor,
 * lineNum: number,
 * fieldIndex: number,
 * mode: 'A'|'Ap',
 * keepSeparator: boolean,
 * originalLine: string,
 * expectedStart: number,
 * expectedEnd: number,
 * phase: 'starting'|'composing'|'finalizing',
 * lastLine: string,
 * lastInsertedText: string|null,
 * sawMetadataEvent: boolean,
 * sawUnattributedSelection: boolean
 * }>} */
const cardCellCompositions = new WeakMap();
let cardCellASelectionGrace = null;
const CARD_CELL_A_SELECTION_GRACE_MS = 1000;

function beginCardCellOwnedEdit(document) {
    cardCellOwnedEditDepth.set(document, (cardCellOwnedEditDepth.get(document) || 0) + 1);
}

function endCardCellOwnedEdit(document) {
    const next = (cardCellOwnedEditDepth.get(document) || 1) - 1;
    if (next > 0) {
        cardCellOwnedEditDepth.set(document, next);
    } else {
        cardCellOwnedEditDepth.delete(document);
    }
}

function isCardCellOwnedEdit(document) {
    return (cardCellOwnedEditDepth.get(document) || 0) > 0;
}

function beginCardCellPostEditBarrier(document) {
    let resolveBarrier = () => {};
    const record = {
        promise: new Promise<void>(resolve => {
            resolveBarrier = resolve;
        }),
        release: () => {},
    };
    record.release = () => {
        if (cardCellPostEditBarriers.get(document) === record) {
            cardCellPostEditBarriers.delete(document);
        }
        resolveBarrier();
    };
    cardCellPostEditBarriers.set(document, record);
    return record.release;
}

function waitForCardCellPostEdit(document) {
    const barrier = document && cardCellPostEditBarriers.get(document);
    return barrier ? barrier.promise : null;
}

async function waitForPendingCardCellPostEdit(document) {
    let barrier = waitForCardCellPostEdit(document);
    let waited = !!barrier;
    if (!barrier && document) {
        const nav = ensureCardCellEditGuard().getNav();
        const documentKey = document.uri && document.uri.toString();
        if (
            nav &&
            nav.uri === documentKey &&
            Number.isInteger(nav.version) &&
            Number.isInteger(document.version) &&
            nav.version !== document.version
        ) {
            // Native paste/cut can advance the model before its change listener
            // establishes the repair barrier. Let both document and selection
            // notifications settle so the next command cannot consume stale A.
            waited = true;
            await waitForCellSelectionQuietPeriod();
            barrier = waitForCardCellPostEdit(document);
        }
    }
    if (barrier) await barrier;
    return waited;
}

function ensureCardCellEditGuard() {
    if (cardCellEditGuard) return cardCellEditGuard;
    cardCellEditGuard = createCardCellEditGuard({
        getCardFieldsForLine,
        isLsdynaDocument: isLsdynaFile,
        isKeywordLineText,
        isTextCardLine: (document, lineNum) =>
            !!keywordSchema.getCardInfoForDocumentLine(document, lineNum, getFieldData())?.isTextCard,
        isProtectEnabled: (document) =>
            getLsdynaConfigurationValue('enableCellEditProtect', true, document?.uri) !== false,
    });
    return cardCellEditGuard;
}

function markCardCellA(guard, document, lineNum, fieldIndex, keepSeparator) {
    guard.markA(document, lineNum, fieldIndex, keepSeparator);
    const nav = guard.getNav();
    cardCellASelectionGrace = nav
        ? {
            uri: nav.uri,
            line: nav.line,
            fieldIndex: nav.fieldIndex,
            version: nav.version,
            until: Date.now() + CARD_CELL_A_SELECTION_GRACE_MS,
        }
        : null;
}

function cardCellASelectionGraceRemaining(nav) {
    if (
        !nav ||
        nav.mode !== 'A' ||
        !cardCellASelectionGrace ||
        nav.uri !== cardCellASelectionGrace.uri ||
        nav.line !== cardCellASelectionGrace.line ||
        nav.fieldIndex !== cardCellASelectionGrace.fieldIndex ||
        nav.version !== cardCellASelectionGrace.version
    ) {
        return 0;
    }
    return Math.max(0, cardCellASelectionGrace.until - Date.now());
}

async function handleTabAlignment(editor, direction = 1) {
    if (!editor) return;
    const wasActiveEditor = vscode.window.activeTextEditor === editor;
    let requestedDocumentVersion = editor.document?.version;
    const requestedSelection = editor.selection;
    if (editor.selections && editor.selections.length > 1) {
        return;
    }
    const waitedForPostEdit = await waitForPendingCardCellPostEdit(editor.document);
    if (waitedForPostEdit) {
        if (wasActiveEditor && vscode.window.activeTextEditor !== editor) return;
        if (editor.document?.isClosed) return;
        // The trusted post-edit repair may advance the document version before
        // this queued Tab gets its turn.
        requestedDocumentVersion = editor.document.version;
    }
    // A just-completed undo/edit can restore its older caret after this command
    // starts. Wait for a quiet selection window, then reinstate the selection
    // that actually invoked Tab before establishing the newer A navigation.
    await waitForCellSelectionQuietPeriod();
    if (wasActiveEditor && vscode.window.activeTextEditor !== editor) return;
    if (editor.document?.isClosed) return;
    if (editor.document.version !== requestedDocumentVersion) return;

    if (editor.selections && editor.selections.length > 1) {
        return;
    }
    if (
        requestedSelection &&
        (
            editor.selection.anchor.line !== requestedSelection.anchor.line ||
            editor.selection.anchor.character !== requestedSelection.anchor.character ||
            editor.selection.active.line !== requestedSelection.active.line ||
            editor.selection.active.character !== requestedSelection.active.character
        )
    ) {
        editor.selection = requestedSelection;
    }

    const document = editor.document;
    const selection = requestedSelection || editor.selection;
    const lineNum = selection.start.line;
    const col = selection.start.character;

    const line = document.lineAt(lineNum);
    const text = line.text;
    if (keywordSchema.getCardInfoForDocumentLine(document, lineNum, getFieldData())?.isTextCard) {
        if (direction === 1) await vscode.commands.executeCommand('tab');
        return;
    }

    const card = getCardFieldsForLine(document, lineNum);
    if (!card || card.length === 0) {
        if (direction === 1) await vscode.commands.executeCommand('tab');
        return;
    }

    // Skip alignment for title/filename fields (single wide field)
    if (card.length === 1 && card[0].w >= 40) {
        if (direction === 1) await vscode.commands.executeCommand('tab');
        return;
    }

    // 1. Current field: Tab/SelectCell use exclusive-end ownership so a full
    // previous value at next.p does not skip the next field; Shift+Tab stays geometric.
    let currentFieldIndex = direction === -1
        ? cardCellModel.fieldIndexAt(text, card, col)
        : cardCellModel.fieldIndexForTabNav(text, card, col);
    if (currentFieldIndex < 0) currentFieldIndex = 0;

    let targetIndex;
    if (direction === 1) {
        targetIndex = currentFieldIndex + 1;
    } else if (direction === -1) {
        targetIndex = currentFieldIndex - 1;
    } else {
        targetIndex = currentFieldIndex;
    }

    // Tab navigation is only safe on a complete fixed-column grid. Valid comma-delimited
    // cards and ambiguous/collapsed lines stay ordinary text until explicit formatting.
    const gridMode = cardCellModel.classifyGrid(text, card);
    if (gridMode !== 'intact') {
        try {
            ensureCardCellEditGuard().clearNav();
            vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);
        } catch (_) {
            /* ignore context failures in tests */
        }
        if (direction === 1) await vscode.commands.executeCommand('tab');
        return;
    }
    let alignedText = cardCellModel.alignLineInPlace(text, card);

    // Ensure padded to target field end
    let targetF_pad;
    if (targetIndex >= card.length) {
        targetF_pad = card[0];
    } else if (targetIndex < 0) {
        targetF_pad = card[card.length - 1];
    } else {
        targetF_pad = card[targetIndex];
    }
    const targetEnd = targetF_pad.p + targetF_pad.w;
    if (alignedText.length < targetEnd) {
        alignedText = alignedText.padEnd(targetEnd, ' ');
    }

    // 3. Edit current line when text changed
    if (alignedText !== text) {
        await editor.edit(editBuilder => {
            const range = new vscode.Range(
                new vscode.Position(lineNum, 0),
                new vscode.Position(lineNum, text.length)
            );
            editBuilder.replace(range, alignedText);
        }, { undoStopBefore: false, undoStopAfter: false });
    }

    // 4. Handle cursor movement
    let targetF;
    let isFirstField = false;
    let resolvedTargetIndex;
    if (targetIndex >= card.length) {
        targetF = card[0];
        isFirstField = true;
        resolvedTargetIndex = 0;
    } else if (targetIndex < 0) {
        targetF = card[card.length - 1];
        isFirstField = false;
        resolvedTargetIndex = card.length - 1;
    } else {
        targetF = card[targetIndex];
        isFirstField = targetIndex === 0;
        resolvedTargetIndex = targetIndex;
    }

    const targetCol = targetF.p;
    const targetW = targetF.w;
    const previousF = resolvedTargetIndex > 0 ? card[resolvedTargetIndex - 1] : null;
    const previousValue = previousF
        ? alignedText.slice(previousF.p, previousF.p + previousF.w).trim()
        : '';
    const shouldPreserveSeparator = !isFirstField && previousValue.length > 0;

    let selStart, selEnd;
    if (isFirstField) {
        selStart = new vscode.Position(lineNum, targetCol);
        selEnd = new vscode.Position(lineNum, targetCol + targetW);
    } else {
        // Preserve the first character as a space for field separation (visual keep-separator)
        selStart = new vscode.Position(lineNum, targetCol + (shouldPreserveSeparator ? 1 : 0));
        selEnd = new vscode.Position(lineNum, targetCol + targetW);
    }

    editor.selection = new vscode.Selection(selEnd, selStart);

    // Mark nav A for cell clear/type protect (design §5.7 / §7)
    try {
        const guard = ensureCardCellEditGuard();
        markCardCellA(guard, document, lineNum, resolvedTargetIndex, shouldPreserveSeparator);
        vscode.commands.executeCommand(
            'setContext',
            'lsdyna.cellEditActive',
            guard.shouldCellEditActive(editor),
        );
    } catch (_) {
        /* ignore context failures in tests */
    }
}

let lastActiveLineNum = null;
let lastActiveDoc = null;
let lastActiveDocumentVersion = null;
let activeEditorWasUndefined = false;
let cellSelectionSyncGeneration = 0;
let cellSelectionSyncTimer = null;
const CELL_SELECTION_QUIET_MS = 20;
const CARD_NATIVE_EDIT_SETTLE_MS = 10;
const CARD_IME_CANCEL_SETTLE_MS = 100;

async function waitForCellSelectionQuietPeriod() {
    let observedGeneration;
    do {
        observedGeneration = cellSelectionSyncGeneration;
        await new Promise(resolve => setTimeout(resolve, CELL_SELECTION_QUIET_MS));
    } while (observedGeneration !== cellSelectionSyncGeneration);
}

function handleSelectionChange(e) {
    const editor = e && e.textEditor ? e.textEditor : e;
    const composition = editor?.document
        ? cardCellCompositions.get(editor.document)
        : null;
    if (composition && e?.kind === undefined) {
        composition.sawUnattributedSelection = true;
    }
    // onDidChangeTextEditorSelection identifies the editor whose selection changed;
    // in a split view that editor need not be the active one. Never let an inactive
    // condition/version retarget the global onBlur or cell-navigation state.
    if (e && e.textEditor && vscode.window.activeTextEditor !== editor) return;
    if (!editor || !isLsdynaFile(editor.document)) {
        cellSelectionSyncGeneration++;
        if (cellSelectionSyncTimer) {
            clearTimeout(cellSelectionSyncTimer);
            cellSelectionSyncTimer = null;
        }
        lastActiveLineNum = null;
        lastActiveDoc = null;
        lastActiveDocumentVersion = null;
        vscode.commands.executeCommand('setContext', 'lsdyna.shouldAlignTab', false);
        vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);
        try {
            ensureCardCellEditGuard().clearNav();
        } catch (_) { /* ignore */ }
        return;
    }

    const currentLineNum = editor.selection.active.line;
    const currentDoc = editor.document;
    const currentDocumentVersion = Number.isInteger(currentDoc.version)
        ? currentDoc.version
        : null;
    const activeEditorTransitionPending = !!(
        e &&
        e.textEditor &&
        lastActiveDoc &&
        lastActiveDoc !== currentDoc
    );
    const unattributedVersionChange = !!(
        e &&
        e.textEditor &&
        e.kind === undefined &&
        lastActiveDoc === currentDoc &&
        lastActiveDocumentVersion !== null &&
        currentDocumentVersion !== null &&
        currentDocumentVersion !== lastActiveDocumentVersion
    );

    const line = currentDoc.lineAt(currentLineNum);
    const text = line.text;
    const trimmed = text.trimStart();
    const isCardLine = !isKeywordLineText(text) && !trimmed.startsWith('$');
    const cardFields = isCardLine ? getCardFieldsForLine(currentDoc, currentLineNum) : null;
    const isWideField = cardFields && cardFields.length === 1 && cardFields[0].w >= 40;
    const hasCard = !!(cardFields && cardFields.length > 0) &&
        !isWideField &&
        cardCellModel.classifyGrid(text, cardFields) === 'intact';

    vscode.commands.executeCommand('setContext', 'lsdyna.shouldAlignTab', hasCard);

    try {
        vscode.commands.executeCommand(
            'setContext',
            'lsdyna.cellEditActive',
            ensureCardCellEditGuard().shouldCellEditActive(editor),
        );
    } catch (_) {
        vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);
    }

    // VS Code can deliver queued programmatic selection events after Tab has already
    // established a newer A selection. Coalesce them so an older caret snapshot
    // cannot erase the fresh navigation mark during rapid input or automation.
    const selectionSyncGeneration = ++cellSelectionSyncGeneration;
    if (cellSelectionSyncTimer) clearTimeout(cellSelectionSyncTimer);
    const syncCellSelection = () => {
        if (selectionSyncGeneration !== cellSelectionSyncGeneration) return;
        cellSelectionSyncTimer = null;
        const latestEditor = vscode.window.activeTextEditor;
        if (!latestEditor || latestEditor.document !== currentDoc) return;
        try {
            const guard = ensureCardCellEditGuard();
            // VS Code labels both the queued old caret and this extension's new
            // selection as Command (3). Only direct keyboard/mouse gestures
            // should bypass the short command-selection grace immediately.
            const graceRemaining = e && e.textEditor && e.kind !== 1 && e.kind !== 2
                ? cardCellASelectionGraceRemaining(guard.getNav())
                : 0;
            if (graceRemaining > 0) {
                cellSelectionSyncTimer = setTimeout(syncCellSelection, graceRemaining);
                return;
            }
            guard.onSelectionChange(latestEditor);
            vscode.commands.executeCommand(
                'setContext',
                'lsdyna.cellEditActive',
                guard.shouldCellEditActive(latestEditor),
            );
        } catch (_) {
            vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);
        }
    };
    cellSelectionSyncTimer = setTimeout(syncCellSelection, 20);

    // Event ordering is not fixed across VS Code editor switches: the new
    // editor's selection event can arrive before onDidChangeActiveTextEditor.
    // Preserve the prior onBlur target until the active-editor listener has
    // captured and processed that transition.
    if (activeEditorTransitionPending) return;

    // External reloads and other unattributed model resets can move the selection
    // without an engineer action. Invalidate the pending onBlur target until a
    // keyboard, mouse, or command selection event explicitly re-arms it.
    if (unattributedVersionChange) {
        lastActiveLineNum = null;
        lastActiveDoc = currentDoc;
        lastActiveDocumentVersion = currentDocumentVersion;
        return;
    }

    if (getLsdynaConfigurationValue('autoFormat', 'disabled', currentDoc.uri) === 'onBlur') {
        if (lastActiveDoc === currentDoc && lastActiveLineNum !== null && lastActiveLineNum !== currentLineNum) {
            void formatLineIfNeeded(currentDoc, lastActiveLineNum);
        }
    }

    lastActiveLineNum = currentLineNum;
    lastActiveDoc = currentDoc;
    lastActiveDocumentVersion = currentDocumentVersion;
}

function isDocumentStillOpenInTextTab(document) {
    const groups = vscode.window.tabGroups && vscode.window.tabGroups.all;
    if (!Array.isArray(groups)) return true;
    const target = document && document.uri && document.uri.toString();
    if (!target) return false;

    return groups.some(group => (group.tabs || []).some(tab => {
        const input = tab && tab.input;
        const uri = input && (
            input.uri ||
            input.resource ||
            input.modified ||
            input.original
        );
        return uri && uri.toString() === target;
    }));
}

async function handleActiveEditorChangeForFormatting(editor) {
    const previousDoc = lastActiveDoc;
    const previousLineNum = lastActiveLineNum;
    const previousDocumentVersion = lastActiveDocumentVersion;

    if (!editor) {
        activeEditorWasUndefined = true;
        // Closing the last editor is a passive action. Formatting the document
        // after VS Code has removed its active editor can make a clean deck dirty
        // mid-close and cause the close operation to be refused. Keep the prior
        // target because VS Code can also emit a transient undefined event while
        // switching editor groups; the following real editor event revalidates the
        // old document against the authoritative open Tab set.
        return;
    }

    const resumedSameDocument = activeEditorWasUndefined && previousDoc === editor.document;
    activeEditorWasUndefined = false;
    lastActiveLineNum = editor.selection.active.line;
    lastActiveDoc = editor.document;
    lastActiveDocumentVersion = Number.isInteger(editor.document.version)
        ? editor.document.version
        : null;

    if (resumedSameDocument) return;

    if (
        previousDoc &&
        previousLineNum !== null &&
        isDocumentStillOpenInTextTab(previousDoc) &&
        (
            previousDocumentVersion === null ||
            previousDoc.version === previousDocumentVersion
        ) &&
        getLsdynaConfigurationValue('autoFormat', 'disabled', previousDoc.uri) === 'onBlur'
    ) {
        await formatLineIfNeeded(previousDoc, previousLineNum);
    }
}

/**
 * Apply a full-line cell rewrite and set selection.
 * @param {import('vscode').TextEditor} editor
 * @param {number} lineNum
 * @param {string} newText
 * @param {number} selStart
 * @param {number} selEnd
 * @param {{undoStopBefore?: boolean, undoStopAfter?: boolean}} [undoOpts]
 */
async function applyCardCellLineEdit(editor, lineNum, newText, selStart, selEnd, undoOpts) {
    const document = editor.document;
    const line = document.lineAt(lineNum);
    const oldText = line.text;
    if (newText !== oldText) {
        beginCardCellOwnedEdit(document);
        try {
            await editor.edit(editBuilder => {
                editBuilder.replace(
                    new vscode.Range(
                        new vscode.Position(lineNum, 0),
                        new vscode.Position(lineNum, oldText.length),
                    ),
                    newText,
                );
            }, {
                undoStopBefore: undoOpts?.undoStopBefore !== false,
                undoStopAfter: undoOpts?.undoStopAfter !== false,
            });
        } finally {
            endCardCellOwnedEdit(document);
        }
    }
    const start = new vscode.Position(lineNum, Math.max(0, selStart));
    const end = new vscode.Position(lineNum, Math.max(0, selEnd));
    editor.selection = new vscode.Selection(end, start);
}

/**
 * A+D empty-row delete: remove the line (including its line break) and place
 * the selection on the previous line (usually last field).
 */
async function applyCardCellLineDelete(editor, lineNum, targetLine, selStart, selEnd, undoOpts) {
    const document = editor.document;
    if (lineNum < 0 || lineNum >= document.lineCount) return;
    const line = document.lineAt(lineNum);
    // Prefer rangeIncludingLineBreak so the blank card row actually disappears.
    // On the last line there may be no trailing break — fall back to line.range.
    const range =
        line.rangeIncludingLineBreak && !line.rangeIncludingLineBreak.isEmpty
            ? line.rangeIncludingLineBreak
            : line.range;
    beginCardCellOwnedEdit(document);
    try {
        await editor.edit(editBuilder => {
            editBuilder.delete(range);
        }, {
            undoStopBefore: undoOpts?.undoStopBefore !== false,
            undoStopAfter: undoOpts?.undoStopAfter !== false,
        });
    } finally {
        endCardCellOwnedEdit(document);
    }
    const safeLine = Math.max(0, Math.min(targetLine, editor.document.lineCount - 1));
    const maxCol = editor.document.lineAt(safeLine).text.length;
    const a = Math.max(0, Math.min(selStart, maxCol));
    const b = Math.max(0, Math.min(selEnd, maxCol));
    editor.selection = new vscode.Selection(
        new vscode.Position(safeLine, b),
        new vscode.Position(safeLine, a),
    );
}

async function handleCardCellDelete(direction) {
    const editor = vscode.window.activeTextEditor;
    const waitedForPostEdit = editor?.document
        ? await waitForPendingCardCellPostEdit(editor.document)
        : false;
    if (waitedForPostEdit) {
        if (vscode.window.activeTextEditor !== editor || editor.document.isClosed) return;
    }
    if (!editor || !isLsdynaFile(editor.document)) {
        return vscode.commands.executeCommand(direction === 'left' ? 'deleteLeft' : 'deleteRight');
    }
    // Keybindings exclude multiple selections, but commands can also be invoked
    // directly. Never let a cell rewrite modify only the primary selection.
    if (!editor.selections || editor.selections.length !== 1) {
        return;
    }
    const guard = ensureCardCellEditGuard();
    const plan = guard.planDelete(editor.document, editor.selection, direction);
    if (!plan) {
        return vscode.commands.executeCommand(direction === 'left' ? 'deleteLeft' : 'deleteRight');
    }
    if (plan.deleteLine) {
        const targetLine = typeof plan.targetLine === 'number' ? plan.targetLine : Math.max(0, plan.lineNum - 1);
        await applyCardCellLineDelete(editor, plan.lineNum, targetLine, plan.selStart, plan.selEnd, {
            undoStopBefore: true,
            undoStopAfter: true,
        });
        if (plan.clearNav) {
            guard.clearNav();
        } else if (plan.markA) {
            markCardCellA(guard, editor.document, targetLine, plan.markA.fieldIndex, plan.markA.keepSeparator);
        }
        vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', guard.shouldCellEditActive(editor));
        return;
    }
    await applyCardCellLineEdit(editor, plan.lineNum, plan.newText, plan.selStart, plan.selEnd, {
        undoStopBefore: true,
        undoStopAfter: true,
    });
    if (plan.clearNav) {
        guard.clearNav();
    } else if (plan.markA) {
        markCardCellA(guard, editor.document, plan.lineNum, plan.markA.fieldIndex, plan.markA.keepSeparator);
    } else if (plan.markAp) {
        // Prefer plan.fieldIndex — caret may sit on exclusive cell end (next field start)
        const fi =
            typeof plan.fieldIndex === 'number' && plan.fieldIndex >= 0
                ? plan.fieldIndex
                : (guard.getNav()?.fieldIndex ?? 0);
        if (fi >= 0) guard.markAp(editor.document, plan.lineNum, fi, plan.selStart);
    }
    vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', guard.shouldCellEditActive(editor));
}

function readCardCellCompositionText(state, currentLine) {
    const prefix = state.originalLine.slice(0, state.expectedStart);
    const suffix = state.originalLine.slice(state.expectedEnd);
    if (!currentLine.startsWith(prefix) || !currentLine.endsWith(suffix)) {
        return null;
    }
    const end = currentLine.length - suffix.length;
    if (end < prefix.length) return null;
    return currentLine.slice(prefix.length, end);
}

function planCardCellComposition(document, state, insertedText) {
    const card = getCardFieldsForLine(document, state.lineNum);
    if (
        !card ||
        state.fieldIndex < 0 ||
        state.fieldIndex >= card.length ||
        cardCellModel.classifyGrid(state.originalLine, card) !== 'intact'
    ) {
        return null;
    }
    const field = card[state.fieldIndex];
    const containsUnsafeControl =
        /[\t\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(insertedText);
    let insertionBase = state.originalLine;
    let insertionCaret = state.expectedStart;
    if (state.mode === 'Ap' && state.expectedEnd > state.expectedStart) {
        const afterDelete = cardCellModel.applyInCellDelete(
            state.originalLine,
            card,
            state.fieldIndex,
            {
                startChar: state.expectedStart,
                endChar: state.expectedEnd,
                isEmpty: false,
            },
            'right',
        );
        if (!afterDelete) return null;
        insertionBase = afterDelete.line;
        insertionCaret = afterDelete.caretCol;
    }
    const existingValue = cardCellModel.readCellValue(
        insertionBase,
        card,
        state.fieldIndex,
    );
    const blocked =
        containsUnsafeControl ||
        (
            state.mode === 'A'
                ? insertedText.length > field.w
                : existingValue.length + insertedText.length > field.w
        );
    if (blocked) {
        return {
            blocked: true,
            newText: state.originalLine,
            caret: state.expectedStart,
        };
    }

    if (state.mode === 'A') {
        const newText = cardCellModel.writeCellR1(
            state.originalLine,
            card,
            state.fieldIndex,
            insertedText,
        );
        return {
            blocked: false,
            newText,
            caret: cardCellModel.caretAfterCellValue(
                newText,
                card,
                state.fieldIndex,
            ),
        };
    }

    if (!insertedText) {
        return {
            blocked: false,
            newText: insertionBase,
            caret: insertionCaret,
        };
    }
    const inserted = cardCellModel.applyInCellInsert(
        insertionBase,
        card,
        state.fieldIndex,
        insertionCaret,
        insertedText,
    );
    if (!inserted) return null;
    return {
        blocked: false,
        newText: inserted.line,
        caret: inserted.caretCol,
    };
}

async function finalizeCardCellComposition(document, state) {
    if (
        cardCellCompositions.get(document) !== state ||
        state.phase === 'finalizing'
    ) {
        return;
    }
    state.phase = 'finalizing';
    cardCellCompositions.delete(document);
    const guard = ensureCardCellEditGuard();
    guard.clearNav();
    vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);

    const releaseBarrier = beginCardCellPostEditBarrier(document);
    try {
        if (
            state.editor.document !== document ||
            document.isClosed ||
            state.lineNum < 0 ||
            state.lineNum >= document.lineCount
        ) {
            return;
        }
        const currentLine = document.lineAt(state.lineNum).text;
        const insertedFromLine = readCardCellCompositionText(state, currentLine);
        const insertedText = insertedFromLine !== null
            ? insertedFromLine
            : state.lastInsertedText;
        if (insertedText === null) return;
        const plan = planCardCellComposition(document, state, insertedText);
        if (!plan) return;

        beginCardCellOwnedEdit(document);
        try {
            await vscode.commands.executeCommand('undo');
        } finally {
            endCardCellOwnedEdit(document);
        }
        if (
            document.isClosed ||
            state.lineNum >= document.lineCount ||
            document.lineAt(state.lineNum).text !== state.originalLine
        ) {
            beginCardCellOwnedEdit(document);
            try {
                await vscode.commands.executeCommand('redo');
            } finally {
                endCardCellOwnedEdit(document);
            }
            return;
        }

        if (plan.blocked) {
            if (vscode.window.activeTextEditor === state.editor) {
                const start = new vscode.Position(state.lineNum, state.expectedStart);
                const end = new vscode.Position(state.lineNum, state.expectedEnd);
                state.editor.selection = new vscode.Selection(end, start);
                markCardCellA(
                    guard,
                    document,
                    state.lineNum,
                    state.fieldIndex,
                    state.keepSeparator,
                );
            }
            vscode.window.setStatusBarMessage(i18n.get('cellInputTooWide'), 3000);
            return;
        }

        await applyCardCellLineEdit(
            state.editor,
            state.lineNum,
            plan.newText,
            plan.caret,
            plan.caret,
            {
                undoStopBefore: true,
                undoStopAfter: true,
            },
        );
        const isActiveEditor = vscode.window.activeTextEditor === state.editor;
        if (isActiveEditor) {
            guard.markAp(document, state.lineNum, state.fieldIndex, plan.caret);
        }
        vscode.commands.executeCommand(
            'setContext',
            'lsdyna.cellEditActive',
            isActiveEditor && guard.shouldCellEditActive(state.editor),
        );
    } finally {
        releaseBarrier();
    }
}

async function cancelCardCellComposition(document, state) {
    if (
        cardCellCompositions.get(document) !== state ||
        state.phase === 'finalizing'
    ) {
        return;
    }
    state.phase = 'finalizing';
    cardCellCompositions.delete(document);
    const guard = ensureCardCellEditGuard();
    guard.clearNav();
    vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);

    const releaseBarrier = beginCardCellPostEditBarrier(document);
    try {
        if (
            state.editor.document !== document ||
            document.isClosed ||
            state.lineNum < 0 ||
            state.lineNum >= document.lineCount
        ) {
            return;
        }
        // A real Windows IME can publish the empty preedit change before TSF
        // has closed the native composition transaction. Let that transaction
        // settle before asking Monaco to undo it; commands for this document
        // remain behind the post-edit barrier during the wait.
        await new Promise(resolve => setTimeout(resolve, CARD_IME_CANCEL_SETTLE_MS));
        if (
            document.isClosed ||
            state.lineNum >= document.lineCount
        ) {
            return;
        }
        const settledLine = document.lineAt(state.lineNum).text;
        if (settledLine !== state.originalLine) {
            beginCardCellOwnedEdit(document);
            try {
                await vscode.commands.executeCommand('undo');
            } finally {
                endCardCellOwnedEdit(document);
            }
        }
        if (
            document.isClosed ||
            state.lineNum >= document.lineCount ||
            document.lineAt(state.lineNum).text !== state.originalLine
        ) {
            beginCardCellOwnedEdit(document);
            try {
                await vscode.commands.executeCommand('redo');
            } finally {
                endCardCellOwnedEdit(document);
            }
            return;
        }

        if (vscode.window.activeTextEditor === state.editor) {
            const start = new vscode.Position(state.lineNum, state.expectedStart);
            const end = new vscode.Position(state.lineNum, state.expectedEnd);
            state.editor.selection = new vscode.Selection(end, start);
            if (state.mode === 'A') {
                markCardCellA(
                    guard,
                    document,
                    state.lineNum,
                    state.fieldIndex,
                    state.keepSeparator,
                );
            } else {
                guard.markAp(
                    document,
                    state.lineNum,
                    state.fieldIndex,
                    state.expectedStart,
                );
            }
            vscode.commands.executeCommand(
                'setContext',
                'lsdyna.cellEditActive',
                guard.shouldCellEditActive(state.editor),
            );
        }
    } finally {
        releaseBarrier();
    }
}

/**
 * Type intercept only for Tab-established nav A/Ap (strict A-gate).
 * No nav / * / $ / free click-typing → default:type (never R1-pad keywords/comments).
 */
async function handleCardCellType(args) {
    const text = args && args.text != null ? String(args.text) : '';
    const editor = vscode.window.activeTextEditor;
    const composition = editor?.document
        ? cardCellCompositions.get(editor.document)
        : null;
    if (composition) {
        return vscode.commands.executeCommand('default:type', args);
    }
    const waitedForPostEdit = editor?.document
        ? await waitForPendingCardCellPostEdit(editor.document)
        : false;
    if (waitedForPostEdit) {
        if (vscode.window.activeTextEditor !== editor || editor.document.isClosed) return;
    }
    if (!editor || !isLsdynaFile(editor.document) || !text) {
        return vscode.commands.executeCommand('default:type', args);
    }
    if (text.includes('\n') || text.includes('\r')) {
        return vscode.commands.executeCommand('default:type', args);
    }
    const guard = ensureCardCellEditGuard();
    if (!editor.selections || editor.selections.length !== 1) {
        guard.clearNav();
        vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);
        return vscode.commands.executeCommand('default:type', args);
    }
    if (cardCellCompositions.has(editor.document)) {
        return vscode.commands.executeCommand('default:type', args);
    }
    // Fast path: without Tab/SelectCell nav, never rewrite cells
    const nav = guard.getNav();
    if (!nav) {
        return vscode.commands.executeCommand('default:type', args);
    }
    if (/^[A-Za-z]$/.test(text) || /[^\u0000-\u007f]/.test(text)) {
        const state = {
            editor,
            lineNum: nav.line,
            fieldIndex: nav.fieldIndex,
            mode: nav.mode,
            keepSeparator: nav.keepSeparator,
            originalLine: nav.originalLine,
            expectedStart: nav.expectedStart,
            expectedEnd: nav.expectedEnd,
            phase: 'starting',
            lastLine: nav.originalLine,
            lastInsertedText: '',
            sawMetadataEvent: false,
            sawUnattributedSelection: false,
        };
        cardCellCompositions.set(editor.document, state);
        try {
            await vscode.commands.executeCommand('default:type', args);
        } catch (error) {
            if (cardCellCompositions.get(editor.document) === state) {
                cardCellCompositions.delete(editor.document);
            }
            throw error;
        }
        if (cardCellCompositions.get(editor.document) !== state) return;
        if (
            state.lineNum < 0 ||
            state.lineNum >= editor.document.lineCount
        ) {
            cardCellCompositions.delete(editor.document);
            return;
        }
        state.lastLine = editor.document.lineAt(state.lineNum).text;
        state.phase = 'composing';
        if (!state.sawMetadataEvent || state.sawUnattributedSelection) {
            await finalizeCardCellComposition(editor.document, state);
        }
        return;
    }
    const plan = guard.planType(editor.document, editor.selection, text);
    if (!plan) {
        return vscode.commands.executeCommand('default:type', args);
    }
    if (plan.blocked) {
        vscode.window.setStatusBarMessage(i18n.get('cellInputTooWide'), 3000);
        return;
    }
    if (plan.escape) {
        guard.clearNav();
        return vscode.commands.executeCommand('default:type', args);
    }
    await applyCardCellLineEdit(editor, plan.lineNum, plan.newText, plan.caret, plan.caret, {
        undoStopBefore: true,
        undoStopAfter: false,
    });
    if (plan.markAp) {
        guard.markAp(editor.document, plan.lineNum, plan.fieldIndex, plan.caret);
    }
    vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', guard.shouldCellEditActive(editor));
}

/**
 * Native paste/cut does not route through the global `type` command. When it
 * exactly replaces a Tab-established fixed-width cell selection, repair the
 * resulting line from the captured pre-edit text. Ambiguous changes only clear
 * navigation state; they are never guessed or rewritten.
 */
async function handleCardCellPostEdit(event) {
    const document = event?.document;
    if (!document || isCardCellOwnedEdit(document)) return;
    const composition = cardCellCompositions.get(document);
    if (composition) {
        if (event.reason !== undefined && event.reason !== null) {
            cardCellCompositions.delete(document);
            return;
        }
        if (!Array.isArray(event.contentChanges) || event.contentChanges.length === 0) {
            composition.sawMetadataEvent = true;
            return;
        }
        if (
            document.isClosed ||
            composition.lineNum < 0 ||
            composition.lineNum >= document.lineCount
        ) {
            cardCellCompositions.delete(document);
            return;
        }
        const currentLine = document.lineAt(composition.lineNum).text;
        const insertedFromLine = readCardCellCompositionText(
            composition,
            currentLine,
        );
        const singleChange = event.contentChanges.length === 1
            ? event.contentChanges[0]
            : null;
        const insertedFromEvent = singleChange &&
            singleChange.range.start.line === composition.lineNum &&
            singleChange.range.end.line === composition.lineNum &&
            !singleChange.text.includes('\n') &&
            !singleChange.text.includes('\r')
            ? singleChange.text
            : null;
        const currentInsertedText = insertedFromLine !== null
            ? insertedFromLine
            : insertedFromEvent;
        const previousInsertedText = composition.lastInsertedText !== null
            ? composition.lastInsertedText
            : readCardCellCompositionText(
                composition,
                composition.lastLine,
            );
        const committedAfterAsciiPreedit = !!(
            composition.sawMetadataEvent &&
            currentInsertedText !== null &&
            /[^\u0000-\u007f]/.test(currentInsertedText) &&
            previousInsertedText !== null &&
            previousInsertedText.length > 0 &&
            !/[^\u0000-\u007f]/.test(previousInsertedText)
        );
        if (committedAfterAsciiPreedit) {
            await finalizeCardCellComposition(document, composition);
            return;
        }
        if (
            currentInsertedText === '' &&
            previousInsertedText !== null &&
            previousInsertedText.length > 0
        ) {
            await cancelCardCellComposition(document, composition);
            return;
        }
        if (currentLine === composition.originalLine) {
            cardCellCompositions.delete(document);
            ensureCardCellEditGuard().clearNav();
            vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);
            return;
        }
        const previousLine = composition.lastLine;
        composition.lastLine = currentLine;
        if (currentInsertedText !== null) {
            composition.lastInsertedText = currentInsertedText;
        }
        if (
            composition.phase === 'composing' &&
            currentLine === previousLine
        ) {
            await finalizeCardCellComposition(document, composition);
        }
        return;
    }
    if (!Array.isArray(event.contentChanges) || event.contentChanges.length === 0) return;

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document || !isLsdynaFile(document)) return;

    const guard = ensureCardCellEditGuard();
    if (!guard.getNav()) return;
    if (!editor.selections || editor.selections.length !== 1) {
        guard.clearNav();
        vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);
        return;
    }

    const plan = guard.planPostEditCorrection(
        document,
        event.contentChanges,
        event.reason,
    );
    if (!plan) {
        vscode.commands.executeCommand(
            'setContext',
            'lsdyna.cellEditActive',
            guard.shouldCellEditActive(editor),
        );
        return;
    }

    const releaseBarrier = beginCardCellPostEditBarrier(document);
    try {
        // A corrective edit after native paste forms a second undo unit even with
        // both undo-stop flags disabled. Remove the proven native operation first,
        // then apply the safe fixed-width result as the sole user-visible undo unit.
        await new Promise(resolve => setTimeout(resolve, CARD_NATIVE_EDIT_SETTLE_MS));
        if (
            vscode.window.activeTextEditor !== editor ||
            editor.document !== document ||
            document.version !== plan.postEditVersion
        ) {
            guard.clearNav();
            vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);
            return;
        }
        beginCardCellOwnedEdit(document);
        try {
            await vscode.commands.executeCommand('undo');
        } finally {
            endCardCellOwnedEdit(document);
        }
        if (
            plan.lineNum < 0 ||
            plan.lineNum >= document.lineCount ||
            document.lineAt(plan.lineNum).text !== plan.originalText
        ) {
            guard.clearNav();
            vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);
            return;
        }

        if (!plan.blocked) {
            await applyCardCellLineEdit(
                editor,
                plan.lineNum,
                plan.newText,
                plan.caret,
                plan.caret,
                {
                    undoStopBefore: true,
                    undoStopAfter: true,
                },
            );
        }

        if (plan.blocked && plan.restoreMode === 'A') {
            const start = new vscode.Position(plan.lineNum, plan.restoreStart);
            const end = new vscode.Position(plan.lineNum, plan.restoreEnd);
            editor.selection = new vscode.Selection(end, start);
            markCardCellA(
                guard,
                document,
                plan.lineNum,
                plan.fieldIndex,
                plan.keepSeparator,
            );
            vscode.window.setStatusBarMessage(i18n.get('cellPasteRejected'), 3000);
        } else {
            const caret = new vscode.Position(plan.lineNum, plan.caret);
            editor.selection = new vscode.Selection(caret, caret);
            guard.markAp(document, plan.lineNum, plan.fieldIndex, plan.caret);
            if (plan.blocked) {
                vscode.window.setStatusBarMessage(i18n.get('cellPasteRejected'), 3000);
            }
        }

        vscode.commands.executeCommand(
            'setContext',
            'lsdyna.cellEditActive',
            guard.shouldCellEditActive(editor),
        );
    } finally {
        releaseBarrier();
    }
}

function getStatusDashboardLabels() {
    return {
        dashboardTooltip: i18n.get('statusDashboardTooltip'),
        placeHolder: i18n.get('statusDashboardPlaceHolder'),
        showHealthLabel: i18n.get('statusDashboardShowHealthLabel'),
        healthReadyDescription: i18n.get('statusDashboardHealthReadyDescription'),
        healthIssuesDescription: i18n.get('statusDashboardHealthIssuesDescription'),
        showHealthDetail: i18n.get('statusDashboardShowHealthDetail'),
        scanIncludesLabel: i18n.get('statusDashboardScanIncludesLabel'),
        scanIncludesDescription: i18n.get('statusDashboardScanIncludesDescription'),
        scanIncludesDetail: i18n.get('statusDashboardScanIncludesDetail'),
        scanKeywordIndexLabel: i18n.get('statusDashboardScanKeywordIndexLabel'),
        scanKeywordIndexDescription: i18n.get('statusDashboardScanKeywordIndexDescription'),
        scanKeywordIndexDetail: i18n.get('statusDashboardScanKeywordIndexDetail'),
        configureManualsLabel: i18n.get('statusDashboardConfigureManualsLabel'),
        manualReadyDescription: i18n.get('statusDashboardManualReadyDescription'),
        manualSetupDescription: i18n.get('statusDashboardManualSetupDescription'),
        configureManualsDetail: i18n.get('statusDashboardConfigureManualsDetail'),
        showOutputLabel: i18n.get('statusDashboardShowOutputLabel'),
        showOutputDescription: i18n.get('statusDashboardShowOutputDescription'),
        showOutputDetail: i18n.get('statusDashboardShowOutputDetail'),
        showDiagnosticsLabel: i18n.get('statusDashboardShowDiagnosticsLabel'),
        diagnosticsNoneDescription: i18n.get('statusDashboardDiagnosticsNoneDescription'),
        diagnosticsErrorsDescription: i18n.get('statusDashboardDiagnosticsErrorsDescription'),
        diagnosticsWarningsDescription: i18n.get('statusDashboardDiagnosticsWarningsDescription'),
        diagnosticsMixedDescription: i18n.get('statusDashboardDiagnosticsMixedDescription'),
        showDiagnosticsDetail: i18n.get('statusDashboardShowDiagnosticsDetail'),
        toggleTabNavigationLabel: i18n.get('statusDashboardToggleTabNavigationLabel'),
        tabNavigationOnDescription: i18n.get('statusDashboardTabNavigationOnDescription'),
        tabNavigationOffDescription: i18n.get('statusDashboardTabNavigationOffDescription'),
        toggleTabNavigationDetail: i18n.get('statusDashboardToggleTabNavigationDetail'),
        toggleFieldHoverLabel: i18n.get('statusDashboardToggleFieldHoverLabel'),
        fieldHoverOnDescription: i18n.get('statusDashboardFieldHoverOnDescription'),
        fieldHoverOffSessionDescription: i18n.get('statusDashboardFieldHoverOffSessionDescription'),
        fieldHoverOffDescription: i18n.get('statusDashboardFieldHoverOffDescription'),
        toggleFieldHoverDetail: i18n.get('statusDashboardToggleFieldHoverDetail'),
        manageCustomValidKeywordsLabel: i18n.get('statusDashboardManageCustomValidKeywordsLabel'),
        manageCustomValidKeywordsDescription: i18n.get('statusDashboardManageCustomValidKeywordsDescription'),
        manageCustomValidKeywordsDetail: i18n.get('statusDashboardManageCustomValidKeywordsDetail'),
        mainDeckContextLabel: i18n.get('statusDashboardMainDeckContextLabel'),
        mainDeckContextSelectedDescription: i18n.get('statusDashboardMainDeckContextSelectedDescription'),
        mainDeckContextAmbiguousDescription: i18n.get('statusDashboardMainDeckContextAmbiguousDescription'),
        mainDeckContextDetail: i18n.get('statusDashboardMainDeckContextDetail'),
        barManualSetup: i18n.get('statusDashboardBarManualSetup'),
        tooltipCurrentFile: i18n.get('statusDashboardTooltipCurrentFile'),
        tooltipNoProblems: i18n.get('statusDashboardTooltipNoProblems'),
        tooltipErrors: i18n.get('statusDashboardTooltipErrors'),
        tooltipWarnings: i18n.get('statusDashboardTooltipWarnings'),
        tooltipKeyword: i18n.get('statusDashboardTooltipKeyword'),
        tooltipField: i18n.get('statusDashboardTooltipField'),
        tooltipScan: i18n.get('statusDashboardTooltipScan'),
        tooltipNotScanned: i18n.get('statusDashboardTooltipNotScanned'),
        tooltipMainDeck: i18n.get('statusDashboardTooltipMainDeck'),
        tooltipMainDeckAmbiguous: i18n.get('statusDashboardTooltipMainDeckAmbiguous'),
        tooltipClick: i18n.get('statusDashboardTooltipClick'),
    };
}

function countDiagnosticsBySeverity(diagnosticsList) {
    let errorCount = 0;
    let warningCount = 0;
    const ErrorSev = vscode.DiagnosticSeverity && vscode.DiagnosticSeverity.Error;
    const WarningSev = vscode.DiagnosticSeverity && vscode.DiagnosticSeverity.Warning;
    for (const d of diagnosticsList || []) {
        if (!d) continue;
        if (ErrorSev !== undefined && d.severity === ErrorSev) errorCount++;
        else if (WarningSev !== undefined && d.severity === WarningSev) warningCount++;
        else if (d.severity === 0) errorCount++; // VS Code Error = 0
        else if (d.severity === 1) warningCount++; // Warning = 1
    }
    return { errorCount, warningCount };
}

function healthStateIcon(state) {
    if (state === 'ready') return '$(check)';
    if (state === 'warning') return '$(warning)';
    return '$(info)';
}

function healthMetadataValue(item, key, fallback = '') {
    if (!item || !item.metadata) return fallback;
    const value = item.metadata[key];
    if (value === undefined || value === null || value === '') return fallback;
    return String(value);
}

function getHealthItemDescription(item) {
    if (!item) return '';
    switch (item.id) {
        case 'language':
            return item.state === 'ready'
                ? i18n.get('health_language_ready_description')
                : i18n.get('health_language_warning_description');
        case 'workspace':
            return item.state === 'ready'
                ? i18n.get('health_workspace_ready_description')
                : i18n.get('health_workspace_info_description');
        case 'manualsDir':
            return item.state === 'ready'
                ? i18n.get('health_manualsDir_ready_description')
                : i18n.get('health_manualsDir_warning_description');
        case 'pdfFiles':
            return item.state === 'ready'
                ? i18n.get('health_pdfFiles_ready_description', healthMetadataValue(item, 'pdfCount', '0'))
                : i18n.get('health_pdfFiles_warning_description');
        case 'manualIndex':
            return item.state === 'ready'
                ? i18n.get('health_manualIndex_ready_description', healthMetadataValue(item, 'indexedPdfCount', '0'))
                : i18n.get('health_manualIndex_warning_description');
        case 'sumatra':
            if (item.metadata && item.metadata.required === false) {
                return i18n.get('health_sumatra_info_description');
            }
            return item.state === 'ready'
                ? i18n.get('health_sumatra_ready_description')
                : i18n.get('health_sumatra_warning_description');
        case 'keywordDatabase':
            return item.state === 'ready'
                ? i18n.get('health_keywordDatabase_ready_description')
                : i18n.get('health_keywordDatabase_warning_description');
        case 'projectTools':
            return item.state === 'ready'
                ? i18n.get('health_projectTools_ready_description')
                : i18n.get('health_projectTools_warning_description');
        default:
            return item.state;
    }
}

function getHealthItemDetail(item) {
    if (!item) return '';
    switch (item.id) {
        case 'language':
            return item.state === 'ready'
                ? i18n.get('health_language_ready_detail')
                : i18n.get('health_language_warning_detail', healthMetadataValue(item, 'languageId', 'unknown'));
        case 'workspace':
            return item.state === 'ready'
                ? i18n.get('health_workspace_ready_detail', healthMetadataValue(item, 'workspaceRoot', ''))
                : i18n.get('health_workspace_info_detail');
        case 'manualsDir':
            return item.state === 'ready'
                ? i18n.get('health_manualsDir_ready_detail', healthMetadataValue(item, 'resolvedDir', ''))
                : i18n.get('health_manualsDir_warning_detail', healthMetadataValue(item, 'manualsDir', ''));
        case 'pdfFiles':
            return item.state === 'ready'
                ? i18n.get('health_pdfFiles_ready_detail', healthMetadataValue(item, 'resolvedDir', ''))
                : i18n.get('health_pdfFiles_warning_detail');
        case 'manualIndex':
            return item.state === 'ready'
                ? i18n.get('health_manualIndex_ready_detail')
                : i18n.get('health_manualIndex_warning_detail');
        case 'sumatra':
            if (item.metadata && item.metadata.required === false) {
                return i18n.get('health_sumatra_info_detail');
            }
            return item.state === 'ready'
                ? i18n.get('health_sumatra_ready_detail', healthMetadataValue(item, 'sumatraPath', ''))
                : i18n.get('health_sumatra_warning_detail');
        case 'keywordDatabase':
            return item.state === 'ready'
                ? i18n.get('health_keywordDatabase_ready_detail')
                : i18n.get('health_keywordDatabase_warning_detail');
        case 'projectTools':
            return item.state === 'ready'
                ? i18n.get('health_projectTools_ready_detail')
                : i18n.get('health_projectTools_warning_detail');
        default:
            return '';
    }
}

function buildHealthQuickPickItems(report) {
    if (!report || !Array.isArray(report.items)) return [];
    return report.items.map(item => ({
        id: item.id,
        actionId: item.actionId,
        label: `${healthStateIcon(item.state)} ${i18n.get(item.labelKey)}`,
        description: getHealthItemDescription(item),
        detail: getHealthItemDetail(item),
        healthItem: item,
    }));
}

function getDiagnosticSeverityName(severity) {
    if (severity === 0) return 'error';
    if (severity === 1) return 'warning';
    if (severity === 2) return 'information';
    if (severity === 3) return 'hint';
    return 'diagnostic';
}

function getDiagnosticSeverityIcon(severity) {
    if (severity === 0) return '$(error)';
    if (severity === 1) return '$(warning)';
    if (severity === 2) return '$(info)';
    if (severity === 3) return '$(lightbulb)';
    return '$(pulse)';
}

function getDiagnosticsForUri(uri) {
    if (!uri || !vscode.languages || typeof vscode.languages.getDiagnostics !== 'function') {
        return [];
    }
    return vscode.languages.getDiagnostics(uri) || [];
}

function getStatusDashboardCursorContext(editor) {
    if (!editor || !editor.document || !editor.selection || !editor.selection.active) {
        return { keyword: '', fieldIndex: null, fieldCount: 0 };
    }

    const document = editor.document;
    const lineNum = Math.max(0, Math.min(editor.selection.active.line, document.lineCount - 1));
    let keyword = '';
    for (let index = lineNum; index >= 0; index--) {
        const classification = classifyKeywordLine(document.lineAt(index).text);
        if (classification.isKeyword) {
            keyword = classification.normalizedKeyword || classification.rawKeyword || '';
            break;
        }
    }

    const text = document.lineAt(lineNum).text;
    const trimmed = text.trimStart();
    const isCardLine = !isKeywordLineText(text) && !trimmed.startsWith('$');
    if (!isCardLine) {
        return { keyword, fieldIndex: null, fieldCount: 0 };
    }

    const cardFields = getCardFieldsForLine(document, lineNum);
    const isWideField = cardFields && cardFields.length === 1 && cardFields[0].w >= 40;
    if (!cardFields || cardFields.length === 0 || isWideField) {
        return { keyword, fieldIndex: null, fieldCount: 0 };
    }

    const character = editor.selection.active.character;
    let fieldIndex = cardFields.findIndex(field => (
        character >= field.p && character < field.p + field.w
    ));
    if (fieldIndex < 0) {
        fieldIndex = Math.max(0, Math.min(cardFields.length - 1, Math.floor(character / 10)));
    }

    return {
        keyword,
        fieldIndex: fieldIndex + 1,
        fieldCount: cardFields.length,
    };
}

function formatStatusDashboardDiagnostics(editor, diagnosticsList, dashboardContext) {
    const filePath = editor && editor.document && editor.document.uri
        ? editor.document.uri.fsPath
        : 'No active LS-DYNA file';
    const lines = [
        'DynaSense diagnostics',
        `File: ${filePath}`,
        `Keyword: ${dashboardContext.keyword || 'none'}`,
        `Diagnostics: ${diagnosticsList.length}`,
    ];

    if (diagnosticsList.length === 0) {
        lines.push(i18n.get('statusDashboardNoDiagnostics'));
        return lines.join('\n');
    }

    diagnosticsList.forEach((diagnostic, index) => {
        const range = diagnostic.range;
        const line = range && range.start ? range.start.line + 1 : '?';
        const character = range && range.start ? range.start.character + 1 : '?';
        const severity = getDiagnosticSeverityName(diagnostic.severity);
        lines.push(`${index + 1}. [${severity}] ${line}:${character} ${diagnostic.message}`);
    });

    return lines.join('\n');
}

function buildStatusDashboardDiagnosticItems(editor, diagnosticsList, dashboardContext) {
    const diagnosticsDescription = diagnosticsList.length === 1
        ? i18n.get('statusDashboardDiagnosticsSingularDescription')
        : i18n.get('statusDashboardDiagnosticsPluralDescription', diagnosticsList.length);
    const items: any[] = [
        {
            id: 'openProblems',
            label: i18n.get('statusDashboardOpenProblemsLabel'),
            description: i18n.get('statusDashboardOpenProblemsDescription'),
            detail: i18n.get('statusDashboardOpenProblemsDetail'),
        },
        {
            id: 'copyDiagnostics',
            label: i18n.get('statusDashboardCopyFullDiagnosticsLabel'),
            description: diagnosticsDescription,
            detail: i18n.get('statusDashboardCopyFullDiagnosticsDetail'),
        },
    ];

    for (const diagnostic of diagnosticsList) {
        const range = diagnostic.range;
        const line = range && range.start ? range.start.line + 1 : '?';
        const character = range && range.start ? range.start.character + 1 : '?';
        const severity = getDiagnosticSeverityName(diagnostic.severity);
        const lineLabel = line === '?' ? i18n.get('lineLabel', '?') : i18n.get('lineLabel', line);
        items.push({
            id: 'diagnostic',
            label: `${getDiagnosticSeverityIcon(diagnostic.severity)} ${lineLabel}: ${diagnostic.message}`,
            description: `${severity} ${line}:${character}`,
            detail: i18n.get('statusDashboardDiagnosticJumpDetail'),
            diagnostic,
            dashboardContext,
            editor,
        });
    }

    return items;
}

class LsdynaDocumentFormattingEditProvider {
    provideDocumentFormattingEdits(document, options, token) {
        return this.provideDocumentRangeFormattingEdits(document, new vscode.Range(0, 0, document.lineCount, 0), options, token);
    }

    provideDocumentRangeFormattingEdits(document, range, options, token) {
        if (shouldSkipAutomaticDocumentScan(document)) return [];
        const edits = [];
        for (let lineNum = range.start.line; lineNum <= range.end.line; lineNum++) {
            if (lineNum >= document.lineCount) break;
            const line = document.lineAt(lineNum);
            const text = line.text;
            const trimmed = text.trimStart();
            
            if (isKeywordLineText(text)) continue;

            let currentKwText = null;
            let currentKwLine = null;
            for (let i = lineNum; i >= 0; i--) {
                const t = document.lineAt(i).text;
                const classification = classifyKeywordLine(t);
                if (classification.isKeyword) {
                    currentKwText = classification.normalizedKeyword;
                    currentKwLine = i;
                    break;
                }
            }
            if (!currentKwText || currentKwText.startsWith('*PARAMETER')) continue;

            const isCommentLine = trimmed.startsWith('$');
            const isFieldHeaderLine = isFieldHeaderCommentLine(text);
            if (isCommentLine && !isFieldHeaderLine) continue;

            if (!isCommentLine && (currentKwText === '*INCLUDE_PATH' || currentKwText === '*INCLUDE_PATH_RELATIVE')) {
                const pathEdit = createPathEntryFormatEdit(document, lineNum, currentKwLine);
                if (pathEdit.range) {
                    edits.push(vscode.TextEdit.replace(pathEdit.range, pathEdit.newText));
                    lineNum = pathEdit.range.end.line;
                }
                continue;
            }

            let targetLineNum = lineNum;

            if (isFieldHeaderLine) {
                const nextDataLine = findNextDataLineInKeywordBlock(document, lineNum + 1);
                if (nextDataLine === null) continue;
                targetLineNum = nextDataLine;
            }

            const cardFields = getCardFieldsForLine(document, targetLineNum);
            if (!cardFields || cardFields.length === 0) continue;

            if (!isCommentLine && isIncludeFileKeyword(currentKwText) && isSingleEightyColumnCard(cardFields)) {
                const pathEdit = createPathEntryFormatEdit(document, lineNum, currentKwLine);
                if (pathEdit.range) {
                    edits.push(vscode.TextEdit.replace(pathEdit.range, pathEdit.newText));
                    lineNum = pathEdit.range.end.line;
                }
                continue;
            }

            const alignment = planAlignedLine(text, cardFields, isFieldHeaderLine);
            if (alignment.status === 'unsafe') {
                notifyUnsafeFormatOnce(document);
                continue;
            }
            const alignedText = alignment.text;
            if (text !== alignedText) {
                const replaceRange = new vscode.Range(lineNum, 0, lineNum, text.length);
                edits.push(vscode.TextEdit.replace(replaceRange, alignedText));
            }
        }
        return edits;
    }
}

// --- LS-DYNA line comment toggle (column-0 $) ---
//
// VS Code's built-in editor.action.commentLine inserts the lineComment symbol
// before the first non-whitespace character. LS-DYNA requires the $ marker at
// the very first column of the line, so a dedicated command takes over Ctrl+/ in
// lsdyna editors and toggles a single $ at character index 0. The pure planner
// below is exported via _internals for unit testing.

/**
 * Plan a column-0 $ line-comment toggle for a set of lines.
 *
 * @param {Array<{line:number,text:string}>} lineEntries - Lines to consider.
 * @returns {{mode:'comment'|'uncomment'|'noop', edits:Array<{line:number,type:'insert'|'delete'}>}}
 *   comment  -> insert $ at column 0 of each uncommented line
 *   uncomment-> delete the single column-0 $ of each $-prefixed line
 *   noop     -> nothing eligible to toggle
 */
function planLineCommentToggle(lineEntries) {
    const toggleable = [];
    for (const entry of lineEntries || []) {
        if (!entry || typeof entry.line !== 'number' || typeof entry.text !== 'string') continue;
        if (isFieldHeaderCommentLine(entry.text)) continue;   // preserve $# field-header comments: uncommenting would strip the $ and leave an invalid '#' line
        toggleable.push(entry);
    }
    if (toggleable.length === 0) return { mode: 'noop', edits: [] };

    const isCommented = text => text.trimStart().startsWith('$');
    const allCommented = toggleable.every(entry => isCommented(entry.text));
    const mode = allCommented ? 'uncomment' : 'comment';

    // Deduplicate by line number (first occurrence wins) so overlapping selections
    // never produce a doubled $$ on the same line.
    const seen = new Set();
    const edits = [];
    for (const entry of toggleable) {
        if (seen.has(entry.line)) continue;
        seen.add(entry.line);
        if (mode === 'comment') {
            if (isCommented(entry.text)) continue;             // already commented: never add $$
            edits.push({ line: entry.line, type: 'insert' });
        } else if (entry.text[0] === '$') {
            edits.push({ line: entry.line, type: 'delete' });  // strict inverse of insert
            // Legacy indented $ (no column-0 $) is recognized as commented but not rewritten.
        }
    }
    return { mode, edits };
}

/**
 * Toggle a column-0 $ line comment in lsdyna documents. Multi-line, multi-cursor
 * and overlapping selections are planned into a single atomic editor.edit so one
 * Ctrl+Z fully restores the document. Non-lsdyna documents fall through to VS
 * Code's built-in editor.action.commentLine to preserve default behavior.
 */
async function handleLineCommentToggle(editor) {
    if (!editor) return;
    const document = editor.document;
    if (!document || document.isClosed) return;
    if (!isLsdynaFile(document)) {
        return vscode.commands.executeCommand('editor.action.commentLine');
    }
    // Snapshot selections before the edit to build the deduplicated line set. We
    // deliberately do NOT rewrite selections afterwards: VS Code's editor.edit
    // already advances a caret at an insert point and tracks a deletion, so the
    // caret stays on the same original character (mirroring built-in comment
    // line). A rejected edit (read-only / stale) applies nothing and advances
    // nothing, so failing closed needs no manual selection fix-up — which also
    // avoids the double-shift that re-reading selections after the edit caused.
    const selectionsBefore = editor.selections || [];
    const lineNumbers = [];
    const seen = new Set();
    for (const selection of selectionsBefore) {
        const excludesEndLine = (
            !selection.isEmpty &&
            selection.end.character === 0 &&
            selection.end.line > selection.start.line
        );
        const endLine = selection.end.line - (excludesEndLine ? 1 : 0);
        for (let lineNum = selection.start.line; lineNum <= endLine; lineNum++) {
            if (!seen.has(lineNum)) {
                seen.add(lineNum);
                lineNumbers.push(lineNum);
            }
        }
    }
    lineNumbers.sort((a, b) => a - b);
    const lineEntries = lineNumbers.map(line => ({ line, text: document.lineAt(line).text }));

    const plan = planLineCommentToggle(lineEntries);
    if (plan.mode === 'noop' || plan.edits.length === 0) return;

    try {
        const applied = await editor.edit(editBuilder => {
            for (const edit of plan.edits) {
                if (edit.type === 'insert') {
                    editBuilder.insert(new vscode.Position(edit.line, 0), '$');
                } else {
                    editBuilder.delete(new vscode.Range(edit.line, 0, edit.line, 1));
                }
            }
        });
        if (!applied) return false;
        return true;
    } catch (err) {
        // An edit failure rejects the promise; nothing was applied. Fail closed
        // with no partial write.
        return false;
    }
}

// --- Activate ---

/**
 * Standard VS Code extension activation hook. Configures commands, providers, and watchers.
 *
 * @param {import('vscode').ExtensionContext} context - The extension context.
 */
async function activate(context) {

    let includeTreeView;
    let keywordTreeView;
    let workspaceWatcherManager;
    let healthService = null;
    let statusDashboard = null;
    let includeTreeProvider = null;
    let keywordIndexProvider = null;
    let fileDecorationProvider = null;
    let jumpPulseController = null;
    let maybeShowHealthNoticeForEditor = (_editor = undefined) => {};
    let refreshActiveIncludeDecorations = () => {};

    jumpPulseController = createJumpPulseController(vscode);
    context.subscriptions.push({ dispose: () => {
        if (jumpPulseController) {
            jumpPulseController.dispose();
            jumpPulseController = null;
        }
    } });

    const changeMarksController = createChangeMarksController({
        vscode,
        isLsdynaDocument: isLsdynaFile,
        getConfig: (resource) => ({
            enabled: getLsdynaConfigurationValue('changeMarks.enabled', true, resource) !== false,
            maxLineCount: Number(getLsdynaConfigurationValue('changeMarks.maxLineCount', 100000, resource)) || 100000,
            debounceMs: Number(getLsdynaConfigurationValue('changeMarks.debounceMs', 250, resource)) || 250,
            showOverviewRuler: getLsdynaConfigurationValue('changeMarks.showOverviewRuler', true, resource) !== false,
            showLineBackground: getLsdynaConfigurationValue('changeMarks.showLineBackground', true, resource) !== false,
            showMinimap: getLsdynaConfigurationValue('changeMarks.showMinimap', true, resource) !== false,
        }),
        getMessage: (key, ...args) => i18n.get(key, ...args),
        showMessage: (message) => {
            if (message) vscode.window.showInformationMessage(String(message));
        },
    });
    changeMarksController.register(context);
    context.subscriptions.push({
        dispose: () => {
            try {
                changeMarksController.dispose();
            } catch { /* ignore */ }
        },
    });

    manualIndexer.initialize(context).then(() => {
        if (healthService) healthService.invalidate();
        if (statusDashboard) statusDashboard.scheduleRefresh();
        maybeShowHealthNoticeForEditor(vscode.window.activeTextEditor);
    }).catch(err => {
        console.error('Failed to initialize manual indexer:', err);
    });

    const debugChannel = vscode.window.createOutputChannel("LS-DYNA Debug");
    context.subscriptions.push(debugChannel);
    function logDebug(message) {
        debugChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
    logDebug("Extension activated.");

    const diagnostics = vscode.languages.createDiagnosticCollection('lsdyna');
    context.subscriptions.push(diagnostics);

    function updateDiagnostics(document) {
        return updateDocumentDiagnostics(document, diagnostics).catch(error => {
            logDebug(`updateDocumentDiagnostics failed: ${error && error.message ? error.message : error}`);
        });
    }

    // Manual packs are independent of project scans. Keep one runtime-schema
    // repository per configured pack and let the sidebar and main reader share
    // it; a changed manifest automatically invalidates the cache.
    const manualPackManager = new ManualPackManager(context);
    manualPackManagerRef = manualPackManager;
    context.subscriptions.push({
        dispose: () => {
            if (manualPackManagerRef === manualPackManager) {
                manualPackManagerRef = null;
            }
        },
    });
    let manualSidebarProvider;
    const refreshManualSidebar = (location = undefined) => {
        if (!manualSidebarProvider) return;
        try {
            manualSidebarProvider.refresh(manualPackManager.getRepository(resolveManualPackRoot()), location);
        } catch (_error) {
            manualSidebarProvider.refresh(undefined);
        }
    };
    const openManualReader = (requestedLocation = undefined, restoreWhenPossible = false) => {
        const packRoot = resolveManualPackRoot();
        const repository = manualPackManager.getRepository(packRoot);
        const restored = manualPackManager.restoreState(packRoot, repository);
        const location = requestedLocation
            || (restoreWhenPossible ? restored?.location : undefined)
            || manualPackManager.firstLocation(repository);
        if (!location) {
            vscode.window.showWarningMessage(i18n.get('manualReaderNoSections'));
            return;
        }
        const restore = restored && location.manualId === restored.location.manualId
            && location.sectionId === restored.location.sectionId ? restored : undefined;
        ManualReaderPanel.show(packRoot, repository, manualPackManager, location, restore, current => {
            refreshManualSidebar(current);
        });
        refreshManualSidebar(location);
    };
    if (vscode.window && typeof vscode.window.registerWebviewViewProvider === 'function') {
        manualSidebarProvider = new ManualSidebarProvider(location => openManualReader(location));
        context.subscriptions.push(vscode.window.registerWebviewViewProvider('lsdynaManuals', manualSidebarProvider));
        refreshManualSidebar();
    }

    function refreshRuntimeLanguageIfNeeded({ force = false } = {}) {
        const previousLanguage = i18n.getLanguage();
        i18n.updateLanguage();
        const languageChanged = previousLanguage !== i18n.getLanguage();
        if (!force && !languageChanged) return false;

        _fieldData = null;
        _fieldDataLanguage = null;
        if (includeTreeView) {
            includeTreeView.title = i18n.get('includeTreeTitle');
        }
        if (keywordTreeView) {
            keywordTreeView.title = i18n.get('keywordIndexTitle');
        }
        if (includeTreeProvider && typeof includeTreeProvider.refresh === 'function') {
            includeTreeProvider.refresh();
        }
        if (keywordIndexProvider && typeof keywordIndexProvider.refresh === 'function') {
            keywordIndexProvider.refresh();
        }
        if (fileDecorationProvider && typeof fileDecorationProvider.refresh === 'function') {
            fileDecorationProvider.refresh();
        }
        if (statusDashboard) {
            statusDashboard.scheduleRefresh();
        }
        if (manualSidebarProvider && typeof manualSidebarProvider.refreshUiLanguage === 'function') {
            manualSidebarProvider.refreshUiLanguage();
        }
        ManualReaderPanel.refreshUiLanguage();
        if (healthService) {
            healthService.invalidate();
        }
        return true;
    }

    healthService = createHealthService({
        fs,
        pathModule: path,
        platform: process.platform,
        cwd: process.cwd(),
        execPath: process.execPath,
        appRoot: vscode.env && vscode.env.appRoot ? vscode.env.appRoot : null,
        extensionPath: getExtensionPath(context),
        getManualsDir: () => getLsdynaConfigurationValue('manualsDir', 'lsdyna_manual_pack') || 'lsdyna_manual_pack',
        getManualFilesCount: () => manualIndexer.getManualFilesCount(),
        getKeywordDatabaseReady: () => {
            try {
                return Object.keys(getFieldData()).length > 0;
            } catch (_error) {
                return false;
            }
        },
        getProjectToolsReady: () => true,
    });

    const snippetsPath = typeof context.asAbsolutePath === 'function'
        ? context.asAbsolutePath(path.join('snippets', 'lsdyna.json'))
        : path.join(getExtensionPath(context), 'snippets', 'lsdyna.json');
    fs.readFile(snippetsPath, 'utf8', (err, data) => {
        if (!err) {
            try {
                const json = JSON.parse(data);
                const validSet = new Set();
                for (const key of Object.keys(json)) {
                    if (key.startsWith('*')) {
                        validSet.add(key.slice(1).toUpperCase());
                    }
                }
                keywordValidator.init(validSet);
                vscode.workspace.textDocuments.forEach(updateDiagnostics);
            } catch (e) {
                console.error("Failed to parse lsdyna.json for keyword validation", e);
            }
        }
    });

    associateLsdynaLanguages();

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            if (isLsdynaUri(doc.uri) && doc.languageId !== 'lsdyna') {
                vscode.languages.setTextDocumentLanguage(doc, 'lsdyna').then(undefined, err => {
                    console.error('[lsdyna] Failed to set text document language:', err);
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            const affects = key => e && typeof e.affectsConfiguration === 'function' && e.affectsConfiguration(key);
            const languageChanged = refreshRuntimeLanguageIfNeeded({ force: affects('lsdyna.language') });
            if (affects('lsdyna.additionalExtensions')) {
                associateLsdynaLanguages();
                workspaceWatcherManager?.rebuild(
                    getLsdynaConfigurationValue('additionalExtensions', ['.k', '.key', '.dyna', '.asc'])
                );
            }
            if (
                languageChanged
                || affects('lsdyna.additionalExtensions')
                || affects('lsdyna.customValidKeywords')
                || affects('lsdyna.unknownKeywordSeverity')
                || affects('lsdyna.largeFile.enableRendering')
            ) {
                vscode.workspace.textDocuments.forEach(updateDiagnostics);
            }
            if (affects('lsdyna.manualsDir')) {
                manualPackManager.invalidate();
                clearSumatraPathCache();
                refreshManualSidebar();
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(handleEnterIndentationRemoval)
    );

    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider({ language: 'lsdyna' }, new LsDynaFoldingProvider())
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider({ language: 'lsdyna' }, new LsdynaKeywordSymbolProvider())
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentLinkProvider({ language: 'lsdyna' }, new LsdynaDocumentLinkProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { language: 'lsdyna' },
            new LsdynaIncludePathCaseCodeActionProvider(),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        )
    );
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { language: 'lsdyna' },
            new LsdynaUnknownKeywordCodeActionProvider(),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.addCustomValidKeyword', async (arg) => {
            await handleAddCustomValidKeywordCommand(arg);
        })
    );
    const FIELD_HELP_ENGLISH_SCHEME = 'lsdyna-field-help';
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(FIELD_HELP_ENGLISH_SCHEME, {
            provideTextDocumentContent(uri) {
                // Prefer query (stash id); path is display-only basename.
                let id = uri.query ? String(uri.query) : '';
                if (!id) {
                    const base = String(uri.path || '').replace(/^\/+/, '').replace(/\.md$/i, '');
                    // path form: "{label}-{idPrefix}" — not reliable for full id
                    id = base;
                }
                try {
                    id = decodeURIComponent(id);
                } catch {
                    // keep raw
                }
                const text = id ? getFieldHelpEnglish(id) : undefined;
                if (text == null || text === '') {
                    return i18n.get('fieldHelpEnglishUnavailable');
                }
                // Virtual markdown content; scheme docs are always readonly.
                return text;
            },
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.showFieldHelpEnglish', async (arg) => {
            let id = arg;
            if (Array.isArray(arg)) {
                id = arg[0];
            } else if (arg && typeof arg === 'object' && arg.id != null) {
                id = arg.id;
            }
            if (typeof id !== 'string' || !id || getFieldHelpEnglish(id) == null) {
                vscode.window.showWarningMessage(i18n.get('fieldHelpEnglishUnavailable'));
                return;
            }
            try {
                // Virtual markdown URI → readonly; open beside (side group).
                // Path basename becomes tab title; full stash id lives in query.
                const title = i18n.get('fieldHelpEnglishOriginal').replace(/[\\/?:#]/g, '-');
                const uri = vscode.Uri.from({
                    scheme: FIELD_HELP_ENGLISH_SCHEME,
                    path: `/${title}.md`,
                    query: id,
                });
                const doc = await vscode.workspace.openTextDocument(uri);
                if (doc.languageId !== 'markdown' && vscode.languages?.setTextDocumentLanguage) {
                    try {
                        await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
                    } catch {
                        // ignore
                    }
                }
                await vscode.window.showTextDocument(doc, {
                    viewColumn: vscode.ViewColumn.Beside,
                    preview: true,
                    preserveFocus: false,
                });
            } catch (err) {
                vscode.window.showWarningMessage(
                    i18n.get('fieldHelpEnglishUnavailable')
                );
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.manageCustomValidKeywords', async () => {
            await showManageCustomValidKeywordsPick();
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.addAllUnknownKeywordsInFile', async (arg) => {
            await handleAddAllUnknownKeywordsInFileCommand(arg);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.pickSimilarKeywordHelp', async (arg) => {
            await handlePickSimilarKeywordHelpCommand(arg);
        })
    );

    context.subscriptions.push(
        vscode.languages.registerHoverProvider({ language: 'lsdyna' }, new LsdynaFieldHoverProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider({ language: 'lsdyna' }, new LsdynaDocumentFormattingEditProvider()),
        vscode.languages.registerDocumentRangeFormattingEditProvider({ language: 'lsdyna' }, new LsdynaDocumentFormattingEditProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ language: 'lsdyna' }, new LsdynaParameterCodeLensProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ language: 'lsdyna' }, new LsdynaKeywordOptionsCodeLensProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'lsdyna' },
            new LsdynaIncludeCompletionProvider(),
            '/', '\\'
        )
    );
    // P1: bare-filename search on *INCLUDE cards without Ctrl+Space / global quickSuggestions.
    const includePathSuggestTrigger = createIncludePathSuggestTrigger({
        isIncludeFilenameContext: isIncludeFilenameCompletionContext,
        isLsdynaDocument: isLsdynaFile,
        getActiveEditor: () => vscode.window.activeTextEditor,
        executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    });
    context.subscriptions.push(
        { dispose: () => includePathSuggestTrigger.dispose() },
        vscode.workspace.onDidChangeTextDocument(e => {
            includePathSuggestTrigger.onDidChangeTextDocument(e);
        })
    );
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'lsdyna' },
            new LsdynaFieldCompletionProvider(),
            '$', '#'
        )
    );
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'lsdyna' },
            new LsdynaKeywordCompletionProvider(),
            '*'
        )
    );


    const client = await startLanguageServer(context);
    const indexClient = createIndexClient({ languageClient: client });

    const projectDiagnostics = vscode.languages.createDiagnosticCollection('lsdyna-project');
    context.subscriptions.push(projectDiagnostics);
    const projectDiagnosticStore = createProjectDiagnosticStore(projectDiagnostics, {
        resolveRootForFile(filePath) {
            const mainDeckContext = getMainDeckContextForDocumentPath(filePath);
            if (mainDeckContext.state === 'ambiguous') return null;
            return mainDeckContext.rootFile || undefined;
        },
    });
    projectDiagnosticStoreRef = projectDiagnosticStore;
    context.subscriptions.push(projectDiagnosticStore);

    const originalLoadProjectSnapshot = indexClient.loadProjectSnapshot;
    indexClient.loadProjectSnapshot = async (rootFile, options = {}, onProgress = null) => {
        const snapshot = await originalLoadProjectSnapshot(rootFile, options, onProgress);
        cacheFileIndexesFromSnapshot(snapshot);
        cacheReferenceIndexFromSnapshot(snapshot);
        refreshMainDeckContextUi();
        projectDiagnosticStore.publish(snapshot.rootFile, collectProjectDiagnostics(snapshot));
        return snapshot;
    };
    const originalInvalidate = indexClient.invalidate.bind(indexClient);
    indexClient.invalidate = async (rootFile) => {
        clearEffectiveSearchPathsForRoot(rootFile);
        if (!fs.existsSync(rootFile)) {
            clearReferenceIndexForRoot(rootFile);
            projectDiagnosticStore.clear(rootFile);
            refreshMainDeckContextUi();
        }
        return originalInvalidate(rootFile);
    };

    const enqueueProjectSnapshotRefresh = createProjectSnapshotRefreshQueue({
        loadProjectSnapshot: indexClient.loadProjectSnapshot,
        onError(error, rootFile) {
            console.error(`[lsdyna] Failed to refresh project snapshot for ${rootFile}:`, error);
        },
    });
    const invalidateChangedProjectRoots = createBatchedManifestInvalidator({
        indexClient,
        onError(error, changedFilePath) {
            console.error(`[lsdyna] Failed to invalidate project caches for ${changedFilePath}:`, error);
        },
        onInvalidatedRoots(roots) {
            for (const rootFile of roots) {
                enqueueProjectSnapshotRefresh(rootFile);
            }
        },
    });
    workspaceWatcherManager = createWorkspaceWatcherManager({
        createWatcher: glob => vscode.workspace.createFileSystemWatcher(glob),
        onFileEvent: uri => {
            invalidateChangedProjectRoots(uri);
            refreshActiveIncludeDecorations();
        },
        logWarning: message => logDebug(message),
    });
    workspaceWatcherManager.rebuild(
        getLsdynaConfigurationValue('additionalExtensions', ['.k', '.key', '.dyna', '.asc'])
    );
    context.subscriptions.push(workspaceWatcherManager);
    includeTreeProvider = new LsdynaIncludeTreeProvider({
        searchFileFromPaths,
        loadProjectSnapshot: indexClient.loadProjectSnapshot,
        invalidateProjectSnapshot: indexClient.invalidate,
    });
    includeTreeView = vscode.window.createTreeView('lsdynaIncludeTree', {
        treeDataProvider: includeTreeProvider
    });
    includeTreeView.title = i18n.get('includeTreeTitle');
    context.subscriptions.push(includeTreeView);

    fileDecorationProvider = new LsdynaFileDecorationProvider(includeTreeProvider);
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(fileDecorationProvider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.scanIncludeTree', async () => {
            await includeTreeProvider.scan();
            fileDecorationProvider.refresh();
            if (statusDashboardRef && typeof statusDashboardRef.scheduleRefresh === 'function') {
                statusDashboardRef.scheduleRefresh();
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.searchIncludeTree', async () => {
            await showIncludeSearchPick({
                getEntries: () => includeTreeProvider.listSearchEntries(),
                onRequestScan: async () => {
                    await includeTreeProvider.scan();
                    fileDecorationProvider.refresh();
                    if (statusDashboardRef && typeof statusDashboardRef.scheduleRefresh === 'function') {
                        statusDashboardRef.scheduleRefresh();
                    }
                },
                onAccept: async (entry) => {
                    if (entry.missing) {
                        vscode.window.showWarningMessage(
                            i18n.get('treeSearchMissingFileWarning', entry.filePath)
                        );
                    } else {
                        try {
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.filePath));
                            await vscode.window.showTextDocument(doc, { preview: true });
                        } catch (e) {
                            vscode.window.showWarningMessage(
                                i18n.get('treeSearchMissingFileWarning', entry.filePath)
                            );
                        }
                    }
                    if (includeTreeView && entry.treeItem) {
                        try {
                            await includeTreeView.reveal(entry.treeItem, {
                                select: true,
                                focus: true,
                                expand: true,
                            });
                        } catch (_) {
                            // reveal can fail if the tree item is no longer mounted
                        }
                    }
                },
            });
        })
    );

    keywordIndexProvider = new LsdynaKeywordIndexProvider({
        shouldSkipAutomaticDocumentScan,
        searchFileFromPaths,
        loadProjectSnapshot: indexClient.loadProjectSnapshot,
        invalidateProjectSnapshot: indexClient.invalidate,
    });
    keywordTreeView = vscode.window.createTreeView('lsdynaKeywordIndex', {
        treeDataProvider: keywordIndexProvider
    });
    keywordTreeView.title = i18n.get('keywordIndexTitle');
    context.subscriptions.push(keywordTreeView);
    vscode.commands.executeCommand('setContext', 'lsdyna.keywordIndexMode', 'local');
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.scanKeywordIndex', () => keywordIndexProvider.scan())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.keywordIndexSetLocal', () => keywordIndexProvider.setLocal())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.searchKeywordIndex', async () => {
            await showKeywordSearchPick({
                getEntries: () => keywordIndexProvider.listSearchEntries(),
                onRequestScan: () => keywordIndexProvider.scan(),
                onAcceptKeyword: async (entry) => {
                    if (keywordTreeView && entry.treeItem) {
                        try {
                            await keywordTreeView.reveal(entry.treeItem, {
                                select: true,
                                focus: true,
                                expand: true,
                            });
                        } catch (_) {
                            // reveal can fail if the tree item is no longer mounted
                        }
                    }
                },
                onAcceptUsage: async (_entry, usage) => {
                    await vscode.commands.executeCommand(
                        'extension.goToKeywordUsage',
                        usage.filePath,
                        usage.lineIndex
                    );
                },
            });
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            logDebug(`onDidChangeActiveTextEditor: editor=${editor ? editor.document.uri.toString() : 'none'}, languageId=${editor ? editor.document.languageId : 'none'}`);
            if (editor) {
                keywordIndexProvider.refreshFromUriOrDocument(editor.document);
            } else {
                const uri = getActiveUri();
                logDebug(`onDidChangeActiveTextEditor callback fallback: getActiveUri=${uri ? uri.toString() : 'null'}`);
                if (uri) {
                    keywordIndexProvider.refreshFromUriOrDocument(uri);
                }
            }
        })
    );
    if (vscode.window.tabGroups && typeof vscode.window.tabGroups.onDidChangeTabs === 'function') {
        context.subscriptions.push(
            vscode.window.tabGroups.onDidChangeTabs(() => {
                const uri = getActiveUri();
                const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
                logDebug(`onDidChangeTabs: activeTab=${activeTab ? activeTab.label : 'none'}, inputType=${activeTab?.input?.constructor?.name || 'none'}, getActiveUri=${uri ? uri.toString() : 'null'}`);
                if (uri) {
                    keywordIndexProvider.refreshFromUriOrDocument(uri);
                }
            })
        );
    }
    const scheduleKeywordIndexRefresh = createActiveDocumentDebouncer(
        () => vscode.window.activeTextEditor?.document || getActiveUri(),
        uriOrDoc => {
            logDebug(`Debounced keyword index refresh triggered`);
            keywordIndexProvider.refreshFromUriOrDocument(uriOrDoc);
        }
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (vscode.window.activeTextEditor?.document === e.document) {
                keywordIndexProvider.updateDocumentIndex(e.document, e);
                scheduleKeywordIndexRefresh(e.document);
            }
        })
    );
    const initialUri = getActiveUri();
    logDebug(`initialUri: ${initialUri ? initialUri.toString() : 'null'}`);
    if (initialUri) {
        keywordIndexProvider.refreshFromUriOrDocument(initialUri);
    }
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.goToKeywordUsage', async (filePath, lineIndex) => {
            const uri = vscode.Uri.file(filePath);
            const line = Math.max(0, Number(lineIndex) || 0);
            const pos = new vscode.Position(line, 0);
            const range = new vscode.Range(pos, pos);
            try {
                await vscode.commands.executeCommand('vscode.open', uri, { selection: range });
            } catch {
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc, { selection: range });
                } catch (err) {
                    logDebug(`goToKeywordUsage open failed: ${err && err.message ? err.message : err}`);
                    return;
                }
            }

            if (getLsdynaConfigurationValue('navigation.pulseOnJump', true, uri) === false) {
                return;
            }
            if (!jumpPulseController) {
                return;
            }

            const targetKey = normalizePathKey(uri.fsPath);
            const matchEditor = (editor) => {
                if (!editor || !editor.document || !editor.document.uri) {
                    return false;
                }
                try {
                    return normalizePathKey(editor.document.uri.fsPath) === targetKey;
                } catch {
                    return false;
                }
            };
            let editor = vscode.window.activeTextEditor;
            if (!matchEditor(editor)) {
                editor = (vscode.window.visibleTextEditors || []).find(matchEditor);
            }
            if (editor) {
                jumpPulseController.pulseLine(editor, line);
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openLsdynaReferenceDefinition', async (target) => {
            if (!target || typeof target.filePath !== 'string') return;
            const lineIndex = Number.isFinite(target.lineIndex) ? target.lineIndex : 0;
            const character = Number.isFinite(target.character) ? target.character : 0;
            const uri = vscode.Uri.file(target.filePath);
            const pos = new vscode.Position(lineIndex, character);
            const range = new vscode.Range(pos, pos);
            await vscode.commands.executeCommand('vscode.open', uri, { selection: range, preview: false });
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openToSide', (node) => {
            const uri = node.resourceUri || (node.filePath ? vscode.Uri.file(node.filePath) : null);
            if (uri) {
                vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Beside });
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.revealInExplorer', (node) => {
            const uri = node.resourceUri || (node.filePath ? vscode.Uri.file(node.filePath) : null);
            if (uri) {
                vscode.commands.executeCommand('revealFileInOS', uri);
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.copyIncludeTreeItem', async (item) => {
            const {
                buildIncludeCopyChoices,
                truncateForToast,
            } = require('./client/services/includeTreeCopy');

            const filePath = item && (item.filePath
                || (item.resourceUri && item.resourceUri.fsPath)
                || (item.resourceUri && item.resourceUri.path));
            if (!filePath) {
                vscode.window.showWarningMessage(i18n.get('copyIncludeNoPath'));
                return;
            }

            const choices = buildIncludeCopyChoices(String(filePath), {
                asRelativePath: (fsPath) => {
                    try {
                        return vscode.workspace.asRelativePath(vscode.Uri.file(fsPath), false);
                    } catch {
                        return undefined;
                    }
                },
            });
            if (!choices.length) {
                vscode.window.showWarningMessage(i18n.get('copyIncludeNoChoices'));
                return;
            }

            const labelById = {
                basename: i18n.get('copyIncludeBasename'),
                workspaceRelative: i18n.get('copyIncludeWorkspaceRelative'),
                absolute: i18n.get('copyIncludeAbsolute'),
            };
            const pickItems = choices.map(choice => ({
                label: labelById[choice.id] || choice.id,
                description: truncateForToast(choice.value, 100),
                value: choice.value,
            }));
            const picked = await vscode.window.showQuickPick(pickItems, {
                title: i18n.get('copyIncludePickTitle'),
                placeHolder: i18n.get('copyIncludePickPlaceholder'),
                ignoreFocusOut: true,
            });
            if (!picked || picked.value == null) {
                return;
            }

            if (vscode.env && vscode.env.clipboard && typeof vscode.env.clipboard.writeText === 'function') {
                await vscode.env.clipboard.writeText(String(picked.value));
            }
            vscode.window.showInformationMessage(
                i18n.get('copyIncludeCopied', truncateForToast(String(picked.value)))
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openIncludeNewTab', (filePath) => {
            try {
                const uri = vscode.Uri.file(filePath);
                vscode.commands.executeCommand('vscode.open', uri, { preview: false });
            } catch (err) {
                vscode.window.showErrorMessage(i18n.get('failedToOpenFile', err.message));
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openIncludeSplit', (filePath) => {
            try {
                const uri = vscode.Uri.file(filePath);
                vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
            } catch (err) {
                vscode.window.showErrorMessage(i18n.get('failedToSplitOpenFile', err.message));
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openIncludeFolder', (filePath) => {
            try {
                const uri = vscode.Uri.file(filePath);
                vscode.commands.executeCommand('revealFileInOS', uri);
            } catch (err) {
                vscode.window.showErrorMessage(i18n.get('failedToRevealFolder', err.message));
            }
        })
    );

    context.subscriptions.push(
        // Fire-and-forget: same latency for hover cards and Manual Reader PDF button.
        // Do not await openExternal / path discovery on the command promise — spawn ASAP.
        vscode.commands.registerCommand('extension.openManual', (pdfPath, pageNum) => {
            if (!pdfPath || typeof pdfPath !== 'string') return;
            openManualPdf(context, pdfPath, pageNum);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.manual.pickPdfLocation', pickManualLocation)
    );

    const showApproximateManualMatch = (location, keyword) => {
        if (location.matchKind !== 'approximate') return;
        vscode.window.showInformationMessage(
            i18n.get(
                'manualReaderApproximateMatch',
                location.requestedKeyword || keyword,
                location.matchedKeyword || location.title || '',
            )
        );
    };

    const openPackChapter = async (kwArg, manualIdArg, sectionIdArg, targetArg = 'reader') => {
        try {
            const keyword = manualIndexer.cleanKeyword(typeof kwArg === 'string' ? kwArg : '');
            const repository = manualPackManager.getRepository(resolveManualPackRoot());
            const locations = keyword ? repository.resolveKeywordLocations(keyword) : [];
            const location = locations.find(candidate =>
                candidate.manualId === manualIdArg && candidate.sectionId === sectionIdArg
            );
            if (!location) {
                vscode.window.showInformationMessage(
                    i18n.get('manualChapterNotFound', keyword || kwArg || '')
                );
                return;
            }
            showApproximateManualMatch(location, keyword);
            if (targetArg !== 'pdf') {
                openManualReader(location);
                return;
            }

            const chapter = getManualChapterPresentation(repository, location);
            if (!chapter.pdfPage) {
                vscode.window.showInformationMessage(
                    i18n.get('manualChapterPdfPageMissing', chapter.titleEn)
                );
                return;
            }
            const pdfPath = repository.resolveDocumentPdfPath(location.manualId);
            if (!pdfPath) {
                vscode.window.showInformationMessage(i18n.get('manualReaderPdfNotFound'));
                return;
            }
            await vscode.commands.executeCommand(
                'extension.openManual',
                pdfPath,
                chapter.pdfPage,
            );
        } catch (e) {
            vscode.window.showErrorMessage(
                i18n.get('manualReaderOpenFailed', e && e.message ? e.message : e)
            );
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.manual.openPackChapter', openPackChapter)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.manual.pickPackChapter', async (kwArg, targetArg = 'reader') => {
            try {
                const keyword = manualIndexer.cleanKeyword(typeof kwArg === 'string' ? kwArg : '');
                const repository = manualPackManager.getRepository(resolveManualPackRoot());
                const locations = keyword ? repository.resolveKeywordLocations(keyword) : [];
                if (locations.length === 0) {
                    vscode.window.showInformationMessage(
                        i18n.get('manualChapterNotFound', keyword || kwArg || '')
                    );
                    return;
                }
                const location = await pickManualChapter(repository, locations);
                if (!location) return;
                await openPackChapter(
                    keyword,
                    location.manualId,
                    location.sectionId,
                    targetArg,
                );
            } catch (e) {
                vscode.window.showErrorMessage(
                    i18n.get('manualReaderOpenFailed', e && e.message ? e.message : e)
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.manual.openReader', () => {
            try {
                openManualReader(undefined, true);
            } catch (e) {
                vscode.window.showWarningMessage(i18n.get('manualReaderOpenFailed', e && e.message ? e.message : e));
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.manual.openCurrentKeyword', async (kwArg) => {
            try {
                let kw = typeof kwArg === 'string' ? kwArg : '';
                if (!kw) {
                    const ed = vscode.window.activeTextEditor;
                    if (ed) {
                        const range = ed.document.getWordRangeAtPosition(ed.selection.active, /[*][A-Za-z0-9_]+/);
                        if (range) kw = ed.document.getText(range);
                    }
                }
                if (!kw) {
                    vscode.window.showInformationMessage(i18n.get('manualReaderNoKeywordAtCursor'));
                    return;
                }
                const repo = manualPackManager.getRepository(resolveManualPackRoot());
                const locations = repo.resolveKeywordLocations(kw);
                if (locations.length === 0) {
                    vscode.window.showInformationMessage(i18n.get('manualReaderKeywordNotFound', kw));
                    return;
                }
                const loc = await pickManualChapter(repo, locations);
                if (!loc) return;
                showApproximateManualMatch(loc, kw);
                openManualReader(loc);
            } catch (e) {
                vscode.window.showErrorMessage(
                    i18n.get('manualReaderOpenFailed', e && e.message ? e.message : e)
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.configureManualsDir', async () => {
            const hasPack = i18n.get('hasManualPackReady');
            const btnYes = i18n.get('btnYesSelectFolder');
            const btnDownload = i18n.get('btnDownloadPack');
            const btnCancel = i18n.get('btnCancel');

            const choice = await vscode.window.showInformationMessage(hasPack, btnYes, btnDownload, btnCancel);
            
            if (choice === btnDownload) {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/hqyyqh/vscode-lsdyna/releases'));
                return;
            } else if (choice !== btnYes) {
                return;
            }

            const folders = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: i18n.get('selectFolder')
            });
            if (folders && folders[0]) {
                const selectedPath = folders[0].fsPath;
                const config = vscode.workspace.getConfiguration('lsdyna');
                try {
                    await config.update('manualsDir', selectedPath, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(i18n.get('manualDirSetTo', selectedPath));
                } catch (err) {
                    vscode.window.showErrorMessage(i18n.get('failedToSaveGlobalConfig', err.message));
                }
                
                if (process.platform === 'win32') {
                    const fs = require('fs');
                    const path = require('path');
                    const sumatraAtRoot = path.join(selectedPath, 'SumatraPDF.exe');
                    const sumatraInPack = path.join(selectedPath, 'pdf', 'SumatraPDF.exe');
                    if (!fs.existsSync(sumatraAtRoot) && !fs.existsSync(sumatraInPack)) {
                        vscode.window.showWarningMessage(i18n.get('sumatraNotFound'));
                    }
                }
                await manualIndexer.initialize(context);
                if (healthService) healthService.invalidate();
                if (statusDashboard) statusDashboard.scheduleRefresh();
                maybeShowHealthNoticeForEditor(vscode.window.activeTextEditor);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaChooseKeywordOptions', async (lineNum) => {
            return chooseKeywordOptionsForEditor(vscode.window.activeTextEditor, lineNum);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => { updateDiagnostics(doc); })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            activeFileIndexCache.delete(normalizeFileIndexKey(e.document.uri.fsPath));
            updateDiagnostics(e.document);
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => diagnostics.delete(doc.uri))
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e || typeof e.affectsConfiguration !== 'function') return;
            if (!e.affectsConfiguration('lsdyna.include.pathCaseCheck')) return;
            for (const doc of vscode.workspace.textDocuments) {
                updateDiagnostics(doc);
            }
        })
    );
    vscode.workspace.textDocuments.forEach(updateDiagnostics);

    const HEALTH_NOTICE_SIGNATURE_KEY = 'lsdyna.health.lastPromptedIssueSignature';

    function getHealthReportForEditor(editor = vscode.window.activeTextEditor) {
        const document = editor && editor.document ? editor.document : null;
        return healthService.getReport({
            isLsdyna: isLsdynaFile(document),
            document,
            workspaceFolders: vscode.workspace.workspaceFolders || [],
        });
    }

    async function executeHealthAction(actionId) {
        if (actionId === 'configureManuals') {
            await vscode.commands.executeCommand('extension.configureManualsDir');
        } else if (actionId === 'showOutput') {
            if (debugChannel && typeof debugChannel.show === 'function') {
                debugChannel.show(true);
            }
        } else if (actionId === 'scanIncludes') {
            await vscode.commands.executeCommand('extension.scanIncludeTree');
        } else if (actionId === 'scanKeywordIndex') {
            await vscode.commands.executeCommand('extension.scanKeywordIndex');
        }
    }

    async function showHealthStatus() {
        const report = getHealthReportForEditor();
        const items = buildHealthQuickPickItems(report);
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: report.issueCount > 0
                ? i18n.get('healthStatusNeedsSetup', report.issueCount)
                : i18n.get('healthStatusReady'),
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked || !picked.actionId) return;
        await executeHealthAction(picked.actionId);
    }

    async function showStatusDashboardDiagnostics() {
        const editor = vscode.window.activeTextEditor;
        const diagnosticsList = editor && editor.document
            ? getDiagnosticsForUri(editor.document.uri)
            : [];
        if (diagnosticsList.length === 0) {
            vscode.window.showInformationMessage(i18n.get('statusDashboardNoDiagnostics'));
            return;
        }

        const dashboardContext = getStatusDashboardContext();
        const items = buildStatusDashboardDiagnosticItems(editor, diagnosticsList, dashboardContext);
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: i18n.get('statusDashboardDiagnosticsPlaceHolder'),
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked) return;

        if (picked.id === 'openProblems') {
            await vscode.commands.executeCommand('workbench.actions.view.problems');
            return;
        }

        if (picked.id === 'copyDiagnostics') {
            const text = formatStatusDashboardDiagnostics(editor, diagnosticsList, dashboardContext);
            if (vscode.env && vscode.env.clipboard && typeof vscode.env.clipboard.writeText === 'function') {
                await vscode.env.clipboard.writeText(text);
            }
            vscode.window.showInformationMessage(i18n.get('statusDashboardDiagnosticsCopied', diagnosticsList.length));
            return;
        }

        if (picked.id === 'diagnostic' && editor && picked.diagnostic && picked.diagnostic.range) {
            const start = picked.diagnostic.range.start;
            editor.selection = new vscode.Selection(start, start);
            if (typeof editor.revealRange === 'function') {
                editor.revealRange(picked.diagnostic.range);
            }
        }
    }

    maybeShowHealthNoticeForEditor = function maybeShowHealthNotice(editor = vscode.window.activeTextEditor) {
        const document = editor && editor.document ? editor.document : null;
        if (!isLsdynaFile(document)) return;
        const resource = document && document.uri ? document.uri : undefined;
        const showFirstRunNotice = getLsdynaConfigurationValue('health.showFirstRunNotice', true, resource) !== false;
        const report = getHealthReportForEditor(editor);
        const lastPromptedIssueSignature = context.globalState && typeof context.globalState.get === 'function'
            ? context.globalState.get(HEALTH_NOTICE_SIGNATURE_KEY, '')
            : '';
        if (!shouldShowHealthNotice({
            showFirstRunNotice,
            isLsdyna: true,
            report,
            lastPromptedIssueSignature,
        })) {
            return;
        }

        if (context.globalState && typeof context.globalState.update === 'function') {
            Promise.resolve(context.globalState.update(HEALTH_NOTICE_SIGNATURE_KEY, report.issueSignature)).then(undefined, () => {});
        }

        const btnView = i18n.get('healthNoticeViewStatus');
        const btnLater = i18n.get('healthNoticeLater');
        Promise.resolve(vscode.window.showInformationMessage(
            i18n.get('healthNoticeMessage', report.issueCount),
            btnView,
            btnLater
        )).then(choice => {
            if (choice === btnView) {
                vscode.commands.executeCommand('extension.showHealthStatus');
            }
        }, () => {});
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.showHealthStatus', () => showHealthStatus())
    );

    function getStatusDashboardContext() {
        const editor = vscode.window.activeTextEditor;
        const document = editor && editor.document ? editor.document : null;
        const resource = document && document.uri ? document.uri : undefined;
        const mainDeckContext = document && document.uri && document.uri.fsPath
            ? getMainDeckContextForDocumentPath(document.uri.fsPath)
            : { state: 'unavailable', rootFile: null };
        const diagnosticsList = resource ? getDiagnosticsForUri(resource) : [];
        const { errorCount, warningCount } = countDiagnosticsBySeverity(diagnosticsList);
        const healthReport = getHealthReportForEditor(editor);
        const scanRootName = includeTreeProvider
            && typeof includeTreeProvider.getLastScanRootName === 'function'
            ? includeTreeProvider.getLastScanRootName()
            : null;
        return {
            isLsdyna: isLsdynaFile(document),
            level: getLsdynaConfigurationValue('statusBar.level', 'simple', resource),
            ...getStatusDashboardCursorContext(editor),
            manualReady: manualIndexer.getManualFilesCount() > 0,
            errorCount,
            warningCount,
            healthIssueCount: healthReport.issueCount,
            tabNavigationEnabled: getLsdynaConfigurationValue('enableTabNavigation', true, resource) !== false,
            fieldHoverMenuState: getFieldHoverMenuState(resource),
            fieldHoverEnabled: isFieldHoverEffective(resource),
            scanRootName,
            mainDeckRootName: mainDeckContext.rootFile
                ? path.basename(mainDeckContext.rootFile)
                : null,
            mainDeckContextState: mainDeckContext.state,
            labels: getStatusDashboardLabels(),
        };
    }

    const statusBarAlignment = vscode.StatusBarAlignment && vscode.StatusBarAlignment.Left !== undefined
        ? vscode.StatusBarAlignment.Left
        : undefined;
    const statusBarItem = vscode.window.createStatusBarItem(statusBarAlignment, 50);
    statusDashboard = new LsdynaStatusBarDashboard({
        statusBarItem,
        getContext: getStatusDashboardContext,
        actions: {
            showHealth: () => vscode.commands.executeCommand('extension.showHealthStatus'),
            scanIncludes: () => vscode.commands.executeCommand('extension.scanIncludeTree'),
            scanKeywordIndex: () => vscode.commands.executeCommand('extension.scanKeywordIndex'),
            configureManuals: () => vscode.commands.executeCommand('extension.configureManualsDir'),
            showOutput: () => {
                if (debugChannel && typeof debugChannel.show === 'function') {
                    debugChannel.show(true);
                }
            },
            showDiagnostics: () => showStatusDashboardDiagnostics(),
            toggleTabNavigation: async () => {
                const editor = vscode.window.activeTextEditor;
                const resource = editor && editor.document ? editor.document.uri : undefined;
                const config = vscode.workspace.getConfiguration('lsdyna', resource);
                const nextValue = !getLsdynaConfigurationValue('enableTabNavigation', true, resource);
                await config.update('enableTabNavigation', nextValue, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(
                    i18n.get(nextValue ? 'statusDashboardTabNavigationEnabled' : 'statusDashboardTabNavigationDisabled')
                );
                statusDashboard.scheduleRefresh();
            },
            toggleFieldHover: () => vscode.commands.executeCommand('extension.toggleFieldHover'),
            manageCustomValidKeywords: () => vscode.commands.executeCommand('extension.manageCustomValidKeywords'),
            selectMainDeckContext: () => vscode.commands.executeCommand('extension.selectMainDeckContext'),
        },
    });
    statusDashboardRef = statusDashboard;
    context.subscriptions.push(statusDashboard);
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaStatusDashboard', () => statusDashboard.showMenu())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'extension.selectMainDeckContext',
            arg => handleSelectMainDeckContextCommand(arg)
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.muteFieldHoverSession', () => handleMuteFieldHoverSession())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.disableFieldHover', () => handleDisableFieldHover())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.toggleFieldHover', () => handleToggleFieldHover())
    );
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            statusDashboard.scheduleRefresh();
            maybeShowHealthNoticeForEditor(editor);
        })
    );
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(() => statusDashboard.scheduleRefresh())
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (
                !e
                || typeof e.affectsConfiguration !== 'function'
                || e.affectsConfiguration('lsdyna.health.showFirstRunNotice')
                || e.affectsConfiguration('lsdyna.statusBar.level')
                || e.affectsConfiguration('lsdyna.enableTabNavigation')
                || e.affectsConfiguration('lsdyna.enableFieldHover')
                || e.affectsConfiguration('lsdyna.manualsDir')
                || e.affectsConfiguration('lsdyna.language')
            ) {
                healthService.invalidate();
                statusDashboard.scheduleRefresh();
                maybeShowHealthNoticeForEditor(vscode.window.activeTextEditor);
            }
        })
    );
    if (vscode.languages && typeof vscode.languages.onDidChangeDiagnostics === 'function') {
        context.subscriptions.push(
            vscode.languages.onDidChangeDiagnostics(() => statusDashboard.scheduleRefresh())
        );
    }
    statusDashboard.refresh();
    maybeShowHealthNoticeForEditor(vscode.window.activeTextEditor);

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider({ language: 'lsdyna' }, new LsdynaDefinitionProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerReferenceProvider({ language: 'lsdyna' }, new LsdynaReferenceProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerRenameProvider({ language: 'lsdyna' }, new LsdynaRenameProvider())
    );

    // Resolved includes use their native DocumentLink underline. Missing paths
    // keep a warning style and place one icon after the path, leaving the glyph
    // margin exclusively to session change marks.
    const {
        missingPathDecoration,
        missingIndicatorDecoration,
        keywordDecoration,
    } = createIncludeDecorationTypes(vscode);
    context.subscriptions.push(missingPathDecoration, missingIndicatorDecoration, keywordDecoration);
    const includeDecorationRequests = createLatestDocumentRequestGuard();

    function updateDecorations(editor) {
        if (!editor || !isLsdynaFile(editor.document)) return;
        const document = editor.document;
        const requestId = includeDecorationRequests.begin(document);
        collectIncludeDecorationSets(document).then(({ missing, missingIndicators }) => {
            if (
                includeDecorationRequests.isLatest(document, requestId)
                && vscode.window.activeTextEditor
                && vscode.window.activeTextEditor.document === document
            ) {
                editor.setDecorations(missingPathDecoration, missing);
                editor.setDecorations(missingIndicatorDecoration, missingIndicators);
            }
        }).catch(error => {
            logDebug(`collectIncludeDecorationSets failed: ${error && error.message ? error.message : error}`);
        });

        const keywordRanges = collectKeywordDecorationRanges(document);
        editor.setDecorations(keywordDecoration, keywordRanges);
    }

    refreshActiveIncludeDecorations = () => updateDecorations(vscode.window.activeTextEditor);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            void handleActiveEditorChangeForFormatting(editor);
            updateDecorations(editor);
            updateIncludeLineContext(editor);
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (vscode.window.activeTextEditor?.document === event.document) {
                updateDecorations(vscode.window.activeTextEditor);
            }
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (
                !event
                || typeof event.affectsConfiguration !== 'function'
                || event.affectsConfiguration('lsdyna.include.pathCaseCheck')
                || event.affectsConfiguration('lsdyna.additionalExtensions')
            ) {
                refreshActiveIncludeDecorations();
            }
        })
    );

    updateDecorations(vscode.window.activeTextEditor);

    function updateIncludeLineContext(editor) {
        if (!editor || !isLsdynaFile(editor.document)) {
            vscode.commands.executeCommand('setContext', 'lsdyna.onIncludeLine', false);
            return;
        }
        const currentLine = editor.selection.active.line;
        const onInclude = isIncludeLine(editor.document, currentLine);
        vscode.commands.executeCommand('setContext', 'lsdyna.onIncludeLine', onInclude);
    }

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
            handleSelectionChange(e);
            updateIncludeLineContext(e.textEditor);
        })
    );

    // Automatically format on save explicitly removed in favor of VS Code native formatOnSave.

    updateIncludeLineContext(vscode.window.activeTextEditor);
    if (vscode.window.activeTextEditor) {
        lastActiveLineNum = vscode.window.activeTextEditor.selection.active.line;
        lastActiveDoc = vscode.window.activeTextEditor.document;
        lastActiveDocumentVersion = Number.isInteger(lastActiveDoc.version)
            ? lastActiveDoc.version
            : null;
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaTab', () => {
            return handleTabAlignment(vscode.window.activeTextEditor, 1);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaShiftTab', () => {
            return handleTabAlignment(vscode.window.activeTextEditor, -1);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaSelectCell', () => {
            return handleTabAlignment(vscode.window.activeTextEditor, 0);
        })
    );

    // LS-DYNA line comment: Ctrl+/ inserts/removes a single $ at column 0 (not the
    // VS Code default of "first non-whitespace char"). Non-lsdyna documents fall
    // through to the built-in editor.action.commentLine inside the handler.
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaLineComment', () => {
            return handleLineCommentToggle(vscode.window.activeTextEditor);
        })
    );

    // Cell protect: Delete/Backspace clear cells; type-over only after Tab markA/Ap.
    ensureCardCellEditGuard();
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaCellDeleteRight', () => handleCardCellDelete('right')),
        vscode.commands.registerCommand('extension.lsdynaCellDeleteLeft', () => handleCardCellDelete('left')),
        vscode.commands.registerCommand('type', (args) => handleCardCellType(args)),
        vscode.workspace.onDidChangeTextDocument(event => {
            void handleCardCellPostEdit(event);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaFormatSelection', async (lineNumArg) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const document = editor.document;
            let selections = editor.selections;
            
            if (typeof lineNumArg === 'number') {
                try {
                    const startLine = startLineOfCurrentKeywordFromLineReader(
                        document.lineCount,
                        i => document.lineAt(i).text,
                        lineNumArg
                    );
                    const endLine = endLineOfCurrentKeywordFromLineReader(
                        document.lineCount,
                        i => document.lineAt(i).text,
                        lineNumArg
                    );
                    selections = [new vscode.Selection(
                        new vscode.Position(startLine, 0),
                        document.lineAt(endLine).range.end,
                    )];
                } catch (e) {
                    // Fallback
                }
            }

            const selectedLineRanges = selections
                .map(selection => {
                    const excludesEndLine = (
                        !selection.isEmpty &&
                        selection.end.character === 0 &&
                        selection.end.line > selection.start.line
                    );
                    return {
                        start: selection.start.line,
                        end: selection.end.line - (excludesEndLine ? 1 : 0),
                    };
                })
                .sort((a, b) => a.start - b.start || a.end - b.end);
            const mergedLineRanges = [];
            for (const range of selectedLineRanges) {
                const previous = mergedLineRanges[mergedLineRanges.length - 1];
                if (previous && range.start <= previous.end) {
                    previous.end = Math.max(previous.end, range.end);
                } else {
                    mergedLineRanges.push({ ...range });
                }
            }

            const plannedEdits = [];
            let hasConflictingEdits = false;
            const planEdit = (range, newText) => {
                for (const existing of plannedEdits) {
                    if (
                        range.start.isEqual(existing.range.start) &&
                        range.end.isEqual(existing.range.end)
                    ) {
                        if (newText !== existing.newText) {
                            hasConflictingEdits = true;
                        }
                        return;
                    }
                    if (
                        range.start.isBefore(existing.range.end) &&
                        existing.range.start.isBefore(range.end)
                    ) {
                        hasConflictingEdits = true;
                        return;
                    }
                }
                plannedEdits.push({ range, newText });
            };

            for (const selectedRange of mergedLineRanges) {
                for (
                    let lineNum = selectedRange.start;
                    lineNum <= selectedRange.end;
                    lineNum++
                ) {
                    const line = document.lineAt(lineNum);
                    const text = line.text;
                    const trimmed = text.trimStart();
                    let currentKwText = null;
                    let currentKwLine = null;
                    for (let i = lineNum; i >= 0; i--) {
                        const t = document.lineAt(i).text;
                        const classification = classifyKeywordLine(t);
                        if (classification.isKeyword) {
                            currentKwText = classification.normalizedKeyword;
                            currentKwLine = i;
                            break;
                        }
                    }
                    if (currentKwText && currentKwText.startsWith('*PARAMETER')) continue;

                    const isCardLine = !isKeywordLineText(text) && !trimmed.startsWith('$');
                    const isCommentLine = trimmed.startsWith('$');
                    const isFieldHeaderLine = isFieldHeaderCommentLine(text);
                    if (isCommentLine && !isFieldHeaderLine) continue;

                    if (
                        !isCommentLine &&
                        (
                            currentKwText === '*INCLUDE_PATH' ||
                            currentKwText === '*INCLUDE_PATH_RELATIVE'
                        )
                    ) {
                        const pathEdit = createPathEntryFormatEdit(
                            document,
                            lineNum,
                            currentKwLine,
                        );
                        if (pathEdit.range) {
                            planEdit(pathEdit.range, pathEdit.newText);
                            lineNum = pathEdit.range.end.line;
                        }
                        continue;
                    }

                    let targetLineNum = lineNum;
                    if (isFieldHeaderLine) {
                        const nextDataLine = findNextDataLineInKeywordBlock(
                            document,
                            lineNum + 1,
                        );
                        if (nextDataLine === null) continue;
                        targetLineNum = nextDataLine;
                    }

                    if (targetLineNum !== lineNum || isCardLine) {
                        const card = getCardFieldsForLine(document, targetLineNum);
                        if (card && card.length > 0) {
                            if (
                                !isCommentLine &&
                                isIncludeFileKeyword(currentKwText) &&
                                isSingleEightyColumnCard(card)
                            ) {
                                const pathEdit = createPathEntryFormatEdit(
                                    document,
                                    lineNum,
                                    currentKwLine,
                                );
                                if (pathEdit.range) {
                                    planEdit(pathEdit.range, pathEdit.newText);
                                    lineNum = pathEdit.range.end.line;
                                }
                                continue;
                            }
                            const alignment = planAlignedLine(
                                text,
                                card,
                                isFieldHeaderLine,
                            );
                            if (alignment.status === 'unsafe') {
                                notifyUnsafeFormatOnce(document);
                                continue;
                            }
                            const alignedText = alignment.text;
                            if (alignedText !== text) {
                                const range = new vscode.Range(
                                    new vscode.Position(lineNum, 0),
                                    new vscode.Position(lineNum, text.length),
                                );
                                planEdit(range, alignedText);
                            }
                        }
                    }
                }
            }

            if (hasConflictingEdits) return;
            await editor.edit(editBuilder => {
                for (const edit of plannedEdits) {
                    editBuilder.replace(edit.range, edit.newText);
                }
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openIncludeFile', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            try {
                const fullPath = searchFileFromPaths(
                    getFilenameFromDocument(editor.document, editor.selection.active.line),
                    getSearchPath(editor.document)
                );
                const uri = vscode.Uri.file(fullPath);
                vscode.commands.executeCommand('vscode.open', uri).then(undefined, () => {
                    vscode.workspace.openTextDocument(fullPath).then(doc => vscode.window.showTextDocument(doc));
                });
            } catch (error) {
                vscode.window.showErrorMessage(error.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.selectKeyword', (lineNumArg) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const currentLine = typeof lineNumArg === 'number' ? lineNumArg : editor.selection.active.line;
            try {
                const startLine = startLineOfCurrentKeywordFromLineReader(
                    editor.document.lineCount,
                    i => editor.document.lineAt(i).text,
                    currentLine
                );
                const endLine = endLineOfCurrentKeywordFromLineReader(
                    editor.document.lineCount,
                    i => editor.document.lineAt(i).text,
                    currentLine
                );
                editor.selection = new vscode.Selection(
                    new vscode.Position(startLine, 0),
                    new vscode.Position(endLine + 1, 0)
                );
            } catch (error) {
                vscode.window.showErrorMessage(error.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.jumpToNextKeyword', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            try {
                const nextLine = findNextKeywordInDocument(editor.document, editor.selection.active.line);
                const position = new vscode.Position(nextLine, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            } catch (error) {
                vscode.window.showErrorMessage(error.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.jumpToPreviousKeyword', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            try {
                const prevLine = findPreviousKeywordInDocument(editor.document, editor.selection.active.line);
                const position = new vscode.Position(prevLine, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            } catch (error) {
                vscode.window.showErrorMessage(error.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.changeMarks.next', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            if (!changeMarksController.jumpNext(editor)) {
                vscode.window.showInformationMessage(i18n.get('changeMarksNoMarks'));
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.changeMarks.previous', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            if (!changeMarksController.jumpPrevious(editor)) {
                vscode.window.showInformationMessage(i18n.get('changeMarksNoMarks'));
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.changeMarks.resetOrigin', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const ok = await changeMarksController.resetOrigin(editor);
            if (ok) {
                vscode.window.showInformationMessage(i18n.get('changeMarksOriginReset'));
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.changeMarks.diffSinceOpened', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            await changeMarksController.showDiffSinceOpened(editor);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.changeMarks.diffUnsaved', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            await changeMarksController.showDiffUnsaved(editor);
        })
    );

    if (process.env.LSDYNA_EDITOR_SAFETY_WORKSPACE) {
        return {
            _internals: {
                waitForCardCellPostEdit,
                ensureCardCellEditGuard,
            },
        };
    }
}

/**
 * Standard VS Code extension deactivation hook.
 */
function deactivate() {
}

/**
 * Creates an invalidation trigger that flushes caches mapping to modified files.
 * 
 * @param {Object} params - Options.
 * @param {Object} params.indexClient - Index client handle.
 * @param {function} [params.findAffectedRoots] - Roots mapping function.
 * @returns {function(string|import('vscode').Uri): void} Invalidation callback.
 */
type ManifestDrivenInvalidatorOptions = {
    indexClient?: any;
    findAffectedRoots?: (changedFilePath: string, manifestEntries: any[]) => string[];
};

function createManifestDrivenInvalidator({ indexClient, findAffectedRoots = findAffectedProjectRoots }: ManifestDrivenInvalidatorOptions = {}) {
    if (!indexClient || typeof indexClient.invalidate !== 'function' || typeof indexClient.getManifestEntries !== 'function') {
        throw new TypeError('createManifestDrivenInvalidator requires indexClient.invalidate and indexClient.getManifestEntries');
    }
    if (typeof findAffectedRoots !== 'function') {
        throw new TypeError('createManifestDrivenInvalidator requires a findAffectedRoots function');
    }

    return function invalidateChangedFile(fileUriOrPath) {
        const changedFilePath = typeof fileUriOrPath === 'string'
            ? fileUriOrPath
            : fileUriOrPath && fileUriOrPath.fsPath;
        if (!changedFilePath) return;

        const affectedRoots = findAffectedRoots(changedFilePath, indexClient.getManifestEntries());
        for (const rootFile of affectedRoots) {
            indexClient.invalidate(rootFile);
        }
    };
}

/**
 * Creates a debounced invalidation trigger that groups file modifications into batched updates.
 * 
 * @param {Object} params - Options.
 * @param {Object} params.indexClient - Index client.
 * @param {function} [params.findAffectedRoots] - Affected roots resolver.
 * @param {function(string[]): void} [params.onInvalidatedRoots] - Batched roots completion callback.
 * @param {function(Error, string): void} [params.onError] - Manifest lookup failure callback.
 * @param {number} [params.delayMs=100] - Debounce delay.
 * @param {function} [params.schedule=setTimeout] - Scheduler.
 * @param {function} [params.cancel=clearTimeout] - Canceler.
 * @returns {function(string|import('vscode').Uri): void|Promise<void>} Enqueuing callback.
 */
function createBatchedManifestInvalidator({
    indexClient,
    findAffectedRoots = findAffectedProjectRoots,
    onInvalidatedRoots = () => {},
    onError = () => {},
    delayMs = 100,
    schedule = setTimeout,
    cancel = clearTimeout,
}: {
    indexClient?: any;
    findAffectedRoots?: (changedFilePath: string, manifestEntries: any[]) => string[];
    onInvalidatedRoots?: (roots: string[]) => void;
    onError?: (error: Error, changedFilePath: string) => void;
    delayMs?: number;
    schedule?: (callback: () => void, delayMs: number) => any;
    cancel?: (timer: any) => void;
} = {}) {
    if (typeof onInvalidatedRoots !== 'function') {
        throw new TypeError('createBatchedManifestInvalidator requires onInvalidatedRoots to be a function');
    }
    let timer = null;
    const pendingRoots = new Map();

    function queueAffectedRoots(changedFilePath, manifestEntries) {
        const affectedRoots = findAffectedRoots(changedFilePath, manifestEntries);
        if (affectedRoots.length === 0) return;
        for (const rootFile of affectedRoots) {
            const resolvedRootFile = path.resolve(rootFile);
            const rootKey = process.platform === 'win32'
                ? resolvedRootFile.toLowerCase()
                : resolvedRootFile;
            pendingRoots.set(rootKey, rootFile);
        }

        if (timer) cancel(timer);
        timer = schedule(() => {
            timer = null;
            const roots = [...pendingRoots.values()];
            pendingRoots.clear();
            for (const rootFile of roots) {
                indexClient.invalidate(rootFile);
            }
            onInvalidatedRoots(roots);
        }, delayMs);
    }

    function reportManifestError(error, changedFilePath) {
        const manifestError = error instanceof Error ? error : new Error(String(error));
        onError(manifestError, changedFilePath);
    }

    return function queueChangedFile(fileUriOrPath) {
        const changedFilePath = typeof fileUriOrPath === 'string'
            ? fileUriOrPath
            : fileUriOrPath && fileUriOrPath.fsPath;
        if (!changedFilePath) return;

        let manifestEntries;
        try {
            manifestEntries = indexClient.getManifestEntries();
        } catch (error) {
            reportManifestError(error, changedFilePath);
            return;
        }

        if (manifestEntries && typeof manifestEntries.then === 'function') {
            return Promise.resolve(manifestEntries)
                .then(entries => queueAffectedRoots(changedFilePath, entries))
                .catch(error => reportManifestError(error, changedFilePath));
        }

        try {
            queueAffectedRoots(changedFilePath, manifestEntries);
        } catch (error) {
            reportManifestError(error, changedFilePath);
        }
    };
}

/**
 * Creates a sequential execution queue for rebuilding project snapshots, deduplicating rapid triggers.
 * 
 * @param {Object} params - Options.
 * @param {function(string): Promise<any>} params.loadProjectSnapshot - Loader function.
 * @param {function(Error, string): void} [params.onError] - Error callback.
 * @param {function} [params.schedule=setImmediate] - Queue execution handler.
 * @returns {function(string): void} Enqueue project callback.
 */
function createProjectSnapshotRefreshQueue({
    loadProjectSnapshot,
    onError = () => {},
    schedule = setImmediate,
}: {
    loadProjectSnapshot?: (rootFile: string) => Promise<any>;
    onError?: (error: any, rootFile: string | null) => void;
    schedule?: (callback: () => void) => any;
} = {}) {
    if (typeof loadProjectSnapshot !== 'function') {
        throw new TypeError('createProjectSnapshotRefreshQueue requires a loadProjectSnapshot function');
    }
    if (typeof onError !== 'function') {
        throw new TypeError('createProjectSnapshotRefreshQueue requires an onError function');
    }
    if (typeof schedule !== 'function') {
        throw new TypeError('createProjectSnapshotRefreshQueue requires a schedule function');
    }

    const pendingRoots = new Map();
    let activeRootKey = null;
    let flushScheduled = false;
    let processing = false;

    async function drainQueue() {
        if (processing) return;
        processing = true;
        flushScheduled = false;
        try {
            while (pendingRoots.size > 0) {
                const [rootKey, rootFile] = pendingRoots.entries().next().value;
                pendingRoots.delete(rootKey);
                activeRootKey = rootKey;
                try {
                    await loadProjectSnapshot(rootFile);
                } catch (error) {
                    onError(error, rootFile);
                } finally {
                    activeRootKey = null;
                }
            }
        } finally {
            processing = false;
        }
    }

    return function enqueueProjectSnapshotRefresh(rootFile) {
        const resolvedRootFile = path.resolve(rootFile);
        const rootKey = process.platform === 'win32'
            ? resolvedRootFile.toLowerCase()
            : resolvedRootFile;
        if (rootKey === activeRootKey || pendingRoots.has(rootKey)) return;

        pendingRoots.set(rootKey, resolvedRootFile);
        if (flushScheduled || processing) return;

        flushScheduled = true;
        schedule(() => {
            drainQueue().catch(error => onError(error, null));
        });
    };
}

// createProjectIndexLoader is now imported from src/worker/projectIndexLoader.js

/**
 * Factory helper to construct the persistent L2 cache in globalStorage.
 * 
 * @param {Object} params - Options.
 * @param {import('vscode').Uri|null} [params.storageUri] - VS Code global storage directory URI.
 * @param {function(Object): import('./core/cache/diskSnapshotStore').DiskSnapshotStore} [params.createStore] - Store factory.
 * @returns {import('./core/cache/diskSnapshotStore').DiskSnapshotStore|null} Store instance, or null.
 */
function createProjectSnapshotPersistentCache({
    storageUri = null,
    createStore = createDiskSnapshotStore,
}: {
    storageUri?: any;
    createStore?: (options: { cacheDirectory: string; maxCacheBytes: number }) => any;
} = {}) {
    if (!storageUri || typeof storageUri.fsPath !== 'string' || storageUri.fsPath.trim() === '') {
        return null;
    }

    return createStore({
        cacheDirectory: path.join(storageUri.fsPath, 'project-snapshots'),
        maxCacheBytes: PROJECT_SNAPSHOT_DISK_CACHE_BYTES,
    });
}

/**
 * Collects diagnostic warnings and errors (missing files, circular dependencies)
 * mapped to project snapshot results without mutating a collection.
 * 
 * @param {import('./core/project/projectIndexer').ProjectIndexResult} snapshot - snapshot to translate.
 * @returns {Map<string, import('vscode').Diagnostic[]>} Diagnostics grouped by source file.
 */
function collectProjectDiagnostics(snapshot) {
    const fileDiagnostics = new Map();
    if (!snapshot) return fileDiagnostics;

    const addDiag = (filePath, diag) => {
        if (!fileDiagnostics.has(filePath)) fileDiagnostics.set(filePath, []);
        fileDiagnostics.get(filePath).push(diag);
    };

    for (const record of snapshot.missingFiles || []) {
        if (!record.fromFile) continue;
        const lineIdx = record.lineIndex !== undefined ? record.lineIndex : 0;
        const start = record.startChar !== undefined ? record.startChar : 0;
        const end = record.endChar !== undefined ? record.endChar : 80;
        const range = new vscode.Range(
            new vscode.Position(lineIdx, start),
            new vscode.Position(lineIdx, end)
        );
        const diagnostic = new vscode.Diagnostic(
            range,
            i18n.get('includedFileNotFound', record.fileName),
            vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = 'lsdyna';
        diagnostic.code = 'missing-include';
        addDiag(record.fromFile, diagnostic);
    }

    for (const record of snapshot.cycles || []) {
        if (!record.fromFile) continue;
        const lineIdx = record.lineIndex !== undefined ? record.lineIndex : 0;
        const start = record.startChar !== undefined ? record.startChar : 0;
        const end = record.endChar !== undefined ? record.endChar : 80;
        const range = new vscode.Range(
            new vscode.Position(lineIdx, start),
            new vscode.Position(lineIdx, end)
        );
        const cyclePathStr = record.path ? record.path.map(p => path.basename(p)).join(' -> ') : '';
        const diagnostic = new vscode.Diagnostic(
            range,
            i18n.get('circularIncludeDependency', cyclePathStr),
            vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = 'lsdyna';
        diagnostic.code = 'circular-include';
        addDiag(record.fromFile, diagnostic);
    }

    return fileDiagnostics;
}

function publishProjectDiagnostics(snapshot, diagnosticsCollection) {
    if (!snapshot || !snapshot.files) return;
    const fileDiagnostics = collectProjectDiagnostics(snapshot);
    for (const filePath of snapshot.files) diagnosticsCollection.delete(vscode.Uri.file(filePath));
    for (const [filePath, diags] of fileDiagnostics) diagnosticsCollection.set(vscode.Uri.file(filePath), diags);
}


/** Session cache: manualsDir config string → Sumatra path (or null after miss). */
let sumatraPathCacheKey = '';
let sumatraPathCacheValue = undefined;

function clearSumatraPathCache() {
    sumatraPathCacheKey = '';
    sumatraPathCacheValue = undefined;
}

/**
 * Resolves SumatraPDF.exe from either a legacy manuals root or a packaged
 * `pdf/` subdirectory. Root remains first to preserve existing installations.
 * Uses the same exe-first manuals root as the reader/indexer (portable layout).
 * Result is cached per manualsDir for the session so hover/reader PDF open stays snappy.
 *
 * @param {import('vscode').ExtensionContext} context - Context.
 * @returns {string|null} Resolved path, or null.
 */
function resolveSumatraPath(context) {
    const fs = require('fs');
    const path = require('path');
    const { resolveManualDirectoryCandidates } = require('./manual/manualsDirResolve');
    const manualsDir = getLsdynaConfigurationValue('manualsDir', 'lsdyna_manual_pack') || 'lsdyna_manual_pack';
    const cacheKey = String(manualsDir);
    if (sumatraPathCacheKey === cacheKey && sumatraPathCacheValue !== undefined) {
        return sumatraPathCacheValue;
    }
    let resolved = null;
    if (manualsDir && typeof manualsDir === 'string') {
        const dirsToCheck = resolveManualDirectoryCandidates({
            manualsDir,
            workspaceFolders: vscode.workspace.workspaceFolders || [],
            cwd: process.cwd(),
            execPath: process.execPath,
            appRoot: vscode.env && vscode.env.appRoot ? vscode.env.appRoot : null,
            extensionPath: getExtensionPath(context),
            pathModule: path,
        });

        for (const dir of dirsToCheck) {
            for (const sumatraPath of [path.join(dir, 'SumatraPDF.exe'), path.join(dir, 'pdf', 'SumatraPDF.exe')]) {
                if (fs.existsSync(sumatraPath)) {
                    resolved = sumatraPath;
                    break;
                }
            }
            if (resolved) break;
        }
    }
    sumatraPathCacheKey = cacheKey;
    sumatraPathCacheValue = resolved;
    return resolved;
}

/**
 * Opens a PDF through the platform default application without invoking a command shell.
 *
 * @param {string} pdfPath - File path.
 * @param {number} [pageNum] - Page number.
 */
function openManualExternal(pdfPath, pageNum) {
    const uri = vscode.Uri.file(pdfPath);
    const target = pageNum && typeof uri.with === 'function'
        ? uri.with({ fragment: `page=${pageNum}` })
        : uri;
    // Do not return/await the promise from the command path — fire and forget like hover.
    void vscode.env.openExternal(target);
}

/**
 * Shared open path for hover cards and Manual Reader PDF button.
 * Spawns Sumatra immediately when available; never blocks the command on external apps.
 */
function openManualPdf(context, pdfPath, pageNum) {
    if (process.platform === 'win32') {
        try {
            const exePath = resolveSumatraPath(context);
            if (exePath) {
                openPdfWithSumatra(exePath, pdfPath, pageNum, () => openManualExternal(pdfPath, pageNum));
                return;
            }
        } catch (_e) {
            // fall through to default handler
        }
    }
    openManualExternal(pdfPath, pageNum);
}

module.exports = { activate, deactivate };

// Exported for unit testing
module.exports._internals = {
    planLineCommentToggle,
    handleLineCommentToggle,
    startLanguageClient,
    clearSumatraPathCache,
    publishProjectDiagnostics,
    collectProjectDiagnostics,
    collectIncludeDecorationSets,
    createIncludeDecorationTypes,
    createLatestDocumentRequestGuard,
    collectKeywordDecorationRanges,
    collectIncludeDocumentLinks,
    collectLineLengthDiagnostics,
    collectIncludePathLengthDiagnostics,
    collectIncludePathCaseDiagnostics,
    updateDocumentDiagnostics,
    setResolveIncludeWithCaseCheckForTesting,
    cacheFileIndexesFromSnapshot,
    cacheEffectiveSearchPathsFromSnapshot,
    cacheReferenceIndexFromSnapshot,
    clearReferenceIndexCacheForTesting,
    clearReferenceIndexForRoot,
    getMainDeckContextForDocumentPath,
    setMainDeckContextForDocument,
    clearMainDeckContextForDocument,
    handleSelectMainDeckContextCommand,
    buildMainDeckContextHoverMarkdown,
    clearEffectiveSearchPathCacheForTesting,
    getEffectiveSearchPaths,
    createActiveDocumentDebouncer,
    collectIncludeFiles,
    findParameterDefinitions,
    findParameterReferences,
    LsdynaDefinitionProvider,
    LsdynaReferenceProvider,
    LsdynaRenameProvider,
    findIncludeFileLines,
    LsdynaIncludeTreeProvider,
    LsdynaFieldHoverProvider,
    isFieldHoverEffective,
    getFieldHoverMenuState,
    setSessionFieldHoverMutedForTesting,
    resetFieldHoverQuietStateForTesting,
    handleMuteFieldHoverSession,
    handleDisableFieldHover,
    handleToggleFieldHover,
    LsdynaParameterCodeLensProvider,
    LsdynaKeywordOptionsCodeLensProvider,
    LsdynaKeywordIndexProvider,
    LsdynaKeywordSymbolProvider,
    LsDynaFoldingProvider,
    getFilenameFromDocument,
    getSearchPath,
    getParameterAtCursor,
    isIncludeLine,
    isLsdynaUri,
    findNextKeywordInDocument,
    findPreviousKeywordInDocument,
    shouldSkipAutomaticDocumentScan,
    setFileIndexForTesting,
    startLineOfCurrentKeyword,
    endLineOfCurrentKeyword,
    getStructuredManualContext,
    getManualChapterPresentation,
    buildManualChapterPickItems,
    pickManualChapter,
    appendManualLinks,
    pickManualLocation,
    getFilenameFromKeyword,
    searchFileFromPaths,
    findNextKeyword,
    findPreviousKeyword,
    createManifestDrivenInvalidator,
    createBatchedManifestInvalidator,
    createProjectSnapshotRefreshQueue,
    createProjectIndexLoader,
    createProjectSnapshotPersistentCache,
    chooseKeywordOptionsForEditor,
    LsdynaFileDecorationProvider,
    normalizePathKey,
    LsdynaIncludeCompletionProvider,
    isIncludeFilenameCompletionContext,
    createIncludePathSuggestTrigger,
    LsdynaIncludePathCaseCodeActionProvider,
    LsdynaUnknownKeywordCodeActionProvider,
    handleAddCustomValidKeywordCommand,
    handleAddAllUnknownKeywordsInFileCommand,
    handlePickSimilarKeywordHelpCommand,
    buildUnknownKeywordHoverMarkdown,
    rememberSimilarKeywordChoice,
    getCardInfoForDocumentLineWithSuggest,
    resolveKeywordLookupWithSuggest,
    collectUnknownKeywordsFromDocument,
    resolveCustomValidKeywordArg,
    LsdynaFieldCompletionProvider,
    getCardFieldsForLine,
    generateCommentLine,
    handleEnterIndentationRemoval,
    findNextDataLineInKeywordBlock,
    planAlignedLine,
    alignLineText,
    formatLineIfNeeded,
    setFormatLineErrorObserverForTesting,
    handleTabAlignment,
    handleSelectionChange,
    handleActiveEditorChangeForFormatting,
    handleCardCellDelete,
    handleCardCellType,
    waitForCardCellPostEdit,
    applyCardCellLineEdit,
    ensureCardCellEditGuard,
    cardCellModel,
    getPathEntryRange,
    splitIncludePathEntry,
    formatPathEntryIfNeeded,
    LsdynaKeywordCompletionProvider,
    LsdynaDocumentFormattingEditProvider,
    buildStatusDashboardDiagnosticItems,
};
