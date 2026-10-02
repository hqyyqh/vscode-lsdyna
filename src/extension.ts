const { KeywordOptionsWebviewProvider } = require('./client/KeywordOptionsWebviewProvider');
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
const { groupConditionalAdvice } = require('./core/semantics/conditionalPresentation');
const { createKeywordStructureDiagnostics } = require('./client/services/keywordStructureDiagnostics');
let keywordStructureDiagnosticsRef;
const documentEditGuard = require('./client/services/documentEditGuard');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const manualIndexer = require('./core/manualIndexer');
const { resolveManualsRoot } = require('./manual/manualsDirResolve');
const keywordSchema = require('./core/keywordSchema');
const HOVER_TRUST = { enabledCommands: [
    'extension.pickOfficialFieldValue',
    'extension.addVerifiedConditionalCards',
    'extension.rebuildCardComments',
    'extension.insertVerifiedMissingRecords',
    'extension.openSemanticEvidence',
    'extension.checkKeywordStructure',
    "extension.addCustomValidKeyword",
    "extension.configureManualsDir",
    "extension.disableFieldHover",
    "extension.lsdynaChooseKeywordOptions",
    "extension.lsdynaFormatSelection",
    "extension.manual.openPackChapter",
    "extension.manual.pickPackChapter",
    "extension.manual.pickPdfLocation",
    "extension.muteFieldHoverSession",
    "extension.openIncludeFolder",
    "extension.openIncludeNewTab",
    "extension.openIncludeSplit",
    "extension.openLsdynaReferenceDefinition",
    "extension.openManual",
    "extension.pickSimilarKeywordHelp",
    "extension.revealInExplorer",
    "extension.searchLsdynaReferenceInWorkspace",
    "extension.selectKeyword",
    "extension.selectMainDeckContext",
    "extension.setLsdynaTablePreviewView",
    "extension.showFieldHelpEnglish"
] };

const { ManualIndexRepository } = require('./manual/ManualIndexRepository');
const { ManualReaderPanel } = require('./manual/ManualReaderPanel');
const { ManualPackManager } = require('./manual/ManualPackManager');
const { ManualSidebarProvider } = require('./manual/ManualSidebarProvider');
const { LsdynaIncludeTreeProvider, normalizePathKey, formatBytes } = require('./client/providers/includeTreeProvider');
const { LsdynaEntityReferenceProvider } = require('./client/providers/entityReferenceProvider');
const { EntityReferencesWebviewProvider } = require('./client/EntityReferencesWebviewProvider');
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
const { DEFAULT_CHANGE_MARKS_CUSTOM_COLORS } = require('./core/theme/extensionTheme');
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
const { classifyKeywordLine, isKeywordCommentLine } = require('./core/parser/keywordLine');
const { scanParameterSymbols } = require('./core/parser/parameterScanner');
const { isValidParameterName, classifyParameterKeyword } = require('./core/parser/parameterSyntax');
const pathCaseFidelity = require('./core/fs/pathCaseFidelity');
const includePathCompletion = require('./core/completion/includePathCompletion');
const { createWorkerPool } = require('./worker/workerPool');
const { createProjectIndexLoader } = require('./worker/projectIndexLoader');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const i18n = require('./core/i18n');
const {
    getFieldReferenceInfo,
    getActionableFieldReferenceInfo,
    isUnambiguousOperationalProjection,
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
    projectRootFile,
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
    const debugOptions = { execArgv: ['--nolazy', '--inspect=0'] };

    const serverOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions },
    };

    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'lsdyna' }],
        initializationOptions: {
            globalStoragePath: context.globalStorageUri ? path.join(context.globalStorageUri.fsPath, 'project-snapshots') : null,
            maxMemoryCacheBytes: cacheLimitBytes('cache.memoryMaxMiB', 48, 16, 64),
            maxProjectSnapshotCacheBytes: cacheLimitBytes('cache.projectSnapshotDiskMaxMiB', 256, 32, 256),
            maxFileScanCacheBytes: cacheLimitBytes('cache.fileScanDiskMaxMiB', 256, 32, 256),
            maxFileScanMemoryCacheBytes: cacheLimitBytes('cache.fileScanMemoryMaxMiB', 16, 4, 16),
            maxCacheAgeMs: cacheLimitMilliseconds('cache.maxAgeDays', 30, 1, 30),
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
const documentPresentationCache = new WeakMap();
const activeFileIndexCache = new Map();
const activeProjectReferenceIndexCache = new Map();
let referenceSnapshotLoader = null;
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

function setReferenceSnapshotLoaderForTesting(loader) {
    referenceSnapshotLoader = loader;
}

function cacheFileIndexesFromSnapshot(snapshot) {
    if (!snapshot || !snapshot.fileIndexes) return;
    const entries = snapshot.fileIndexes instanceof Map
        ? snapshot.fileIndexes.entries()
        : Object.entries(snapshot.fileIndexes);
    for (const [filePath, fileIndex] of entries) {
        if (!filePath || !fileIndex) continue;
        const fileKey = normalizeFileIndexKey(filePath);
        const current = activeFileIndexCache.get(fileKey);
        if (Number.isInteger(current?.documentVersion)) continue;
        activeFileIndexCache.set(fileKey, fileIndex);
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

function cacheReferenceIndexFromSnapshot(snapshot, { maxBytes = CLIENT_PROJECT_SEMANTIC_CACHE_BYTES } = {}) {
    if (!snapshot || !snapshot.rootFile) return false;
    const effectiveMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.min(maxBytes, CLIENT_PROJECT_SEMANTIC_CACHE_BYTES)
        : CLIENT_PROJECT_SEMANTIC_CACHE_BYTES;
    const rootKey = normalizeSnapshotRootKey(snapshot.rootFile);
    activeProjectScopeCache.set(rootKey, {
        rootFile: snapshot.rootFile,
        files: Array.isArray(snapshot.files) ? [...snapshot.files] : [snapshot.rootFile],
        lastAccessedAt: ++activeProjectCacheAccessSequence,
    });
    const summary = compactClientProjectSnapshot(snapshot);
    const summaryBytes = estimateClientCacheBytes({
        summary,
        effectiveSearchPathsByFile: snapshot.effectiveSearchPathsByFile,
    }, effectiveMaxBytes);
    removeClientProjectRoot(rootKey, {
        preserveMainDeckSelection: true,
        preserveProjectScope: true,
    });
    if (summaryBytes > effectiveMaxBytes) return false;

    const referenceIndex = buildProjectReferenceIndex(snapshot);
    const byteSize = summaryBytes + estimateClientCacheBytes(referenceIndex, effectiveMaxBytes - summaryBytes);
    if (byteSize > effectiveMaxBytes) return false;

    const fileKeys = new Set();
    for (const [filePath] of summary.fileIndexes) {
        const fileKey = normalizeFileIndexKey(filePath);
        fileKeys.add(fileKey);
        if (!activeFileIndexOwners.has(fileKey)) activeFileIndexOwners.set(fileKey, new Set());
        activeFileIndexOwners.get(fileKey).add(rootKey);
    }
    cacheFileIndexesFromSnapshot(snapshot);
    activeProjectReferenceIndexCache.set(rootKey, { snapshot: summary, referenceIndex });
    activeProjectCacheMetadata.set(rootKey, {
        rootFile: snapshot.rootFile,
        fileKeys,
        byteSize,
        lastAccessedAt: ++activeProjectCacheAccessSequence,
    });
    evictClientProjectsIfNeeded(rootKey, effectiveMaxBytes);
    return activeProjectReferenceIndexCache.has(rootKey);
}

function clearReferenceIndexCacheForTesting() {
    for (const rootKey of [...new Set([
        ...activeProjectCacheMetadata.keys(),
        ...activeProjectScopeCache.keys(),
    ])]) removeClientProjectRoot(rootKey);
    activeProjectCacheMetadata.clear();
    activeFileIndexOwners.clear();
    activeProjectReferenceIndexCache.clear();
    activeProjectScopeCache.clear();
    activeMainDeckContextSelector.clearAll();
    activeOnDemandReferenceLookupCache = new WeakMap();
}

function clearReferenceIndexForRoot(rootFile) {
    if (!rootFile) return false;
    return removeClientProjectRoot(rootFile);
}

function snapshotContainsDocument(snapshot, documentPath) {
    const documentKey = normalizeFileIndexKey(documentPath);
    return (snapshot.files || []).some(filePath => normalizeFileIndexKey(filePath) === documentKey);
}

function getContainingReferenceProjects(documentPath) {
    if (!documentPath) return [];
    const projects = [...activeProjectScopeCache.entries()]
        .filter(([, scope]) => snapshotContainsDocument(scope, documentPath))
        .map(([rootKey, scope]) => [
            rootKey,
            activeProjectReferenceIndexCache.get(rootKey) || scope,
        ]);
    for (const [rootKey] of projects) {
        const metadata = activeProjectCacheMetadata.get(rootKey);
        if (metadata) metadata.lastAccessedAt = ++activeProjectCacheAccessSequence;
        const scope = activeProjectScopeCache.get(rootKey);
        if (scope) scope.lastAccessedAt = ++activeProjectCacheAccessSequence;
    }
    return projects.map(([, cached]) => cached);
}

function getMainDeckContextForDocumentPath(documentPath) {
    if (!documentPath) {
        return activeMainDeckContextSelector.resolve('');
    }
    const documentKey = normalizeFileIndexKey(documentPath);
    return activeMainDeckContextSelector.resolve(documentPath, {
        exactProject: activeProjectReferenceIndexCache.get(documentKey) ||
            activeProjectScopeCache.get(documentKey) || null,
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
        const rootFile = projectRootFile(candidate);
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
    return decorateDocumentKeywordBlocks(document, collectBlocksFromLineReader(
        document.lineCount,
        line => document.lineAt(line).text,
    ));
}

function createDocumentReadGuard(document, cancellationToken = null) {
    const version = document?.version;
    const uri = document?.uri;
    return () => !!document && !document.isClosed && document.uri === uri && document.version === version &&
        !cancellationToken?.isCancellationRequested;
}

function createReferenceReadGuard(document, cancellationToken = null) {
    const current = createDocumentReadGuard(document, cancellationToken);
    const epoch = activeProjectCacheEpoch;
    const context = getMainDeckContextForDocumentPath(document?.uri?.fsPath);
    return () => {
        if (!current() || activeProjectCacheEpoch !== epoch) return false;
        const next = getMainDeckContextForDocumentPath(document.uri?.fsPath);
        return next.rootFile === context.rootFile && next.state === context.state;
    };
}

async function getReferenceIndexForDocument(document, cancellationToken = null) {
    const isCurrent = createReferenceReadGuard(document, cancellationToken);
    if (!document || !document.uri || !document.uri.fsPath) {
        return null;
    }
    if (!isCurrent()) return null;

    const mainDeckContext = getMainDeckContextForDocumentPath(document.uri.fsPath);
    if (mainDeckContext.project) {
        let snapshot = mainDeckContext.project.snapshot;
        let referenceIndex = mainDeckContext.project.referenceIndex;
        if (!snapshot || !referenceIndex) {
            try {
                snapshot = await referenceSnapshotLoader?.(mainDeckContext.rootFile, {}, null, cancellationToken);
            } catch (error) {
                if (isCurrent()) console.error('[lsdyna] Failed to load reference snapshot:', error);
            }
            if (!isCurrent()) return null;
            if (!snapshot?.fileIndexes || !snapshot.rootFile || snapshot.scope === 'single-file' ||
                normalizeSnapshotRootKey(snapshot.rootFile) !== normalizeSnapshotRootKey(mainDeckContext.rootFile) ||
                !snapshotContainsDocument(snapshot, document.uri.fsPath)) {
                return { unavailable: true, rootFile: mainDeckContext.rootFile,
                    incompleteReasons: ['project-scan-unavailable'] };
            }
            referenceIndex = buildProjectReferenceIndex(snapshot);
        }
        const base = {
            referenceIndex,
            snapshot,
            projectScoped: true,
            rootFile: mainDeckContext.rootFile,
            mainDeckContextState: mainDeckContext.state,
            projectContextSelected: mainDeckContext.state === 'selected',
            candidateRootFiles: mainDeckContext.candidates.map(projectRootFile),
        };
        const overlay = await overlayDirtyRegistryReferenceFiles(base, cancellationToken);
        if (!isCurrent()) return null;
        return overlay.state === 'ready' ? overlay.referenceIndexState : {
            ...base, referenceIndex: null, unavailable: true, incompleteReasons: overlay.reasons,
        };
    }

    let fileIndex = getFileIndexForDocument(document);
    if (Number.isInteger(fileIndex?.documentVersion) && fileIndex.documentVersion !== document.version) fileIndex = null;
    if (!fileIndex || !fileIndex.referenceDefinitions) {
        try {
            const blocks = Array.isArray(fileIndex?.keywordBlocks)
                ? fileIndex.keywordBlocks
                : document.lineCount > LARGE_DOCUMENT_LINE_THRESHOLD
                    ? []
                    : await parseKeywordBlocksFromDocumentAsync(document, cancellationToken);
            if (!blocks || !isCurrent()) return null;
            const referenceDefinitions = await scanCurveTableDefinitionsFromFileIndex(
                { filePath: document.uri.fsPath, keywordBlocks: blocks },
                async (block) => {
                    const lines = [];
                    for (let i = block.startLine; i <= block.endLine; i++) {
                        if ((i & 255) === 0 && !isCurrent()) {
                            return null;
                        }
                        if (i > block.startLine && ((i - block.startLine) & 4095) === 0) {
                            await new Promise(resolve => setImmediate(resolve));
                            if (!isCurrent()) return null;
                        }
                        lines.push(document.lineAt(i).text);
                    }
                    return lines.join('\n');
                },
                undefined,
                { cancellationToken }
            );
            if (referenceDefinitions.cancelled || !isCurrent()) {
                return null;
            }
            fileIndex = {
                filePath: document.uri.fsPath,
                keywordBlocks: blocks,
                referenceDefinitions,
                documentVersion: Number.isInteger(document.version)
                    ? document.version
                    : undefined,
            };
            activeFileIndexCache.set(normalizeFileIndexKey(document.uri.fsPath), fileIndex);
        } catch (e) {
            console.error('[lsdyna] Failed to dynamically build file index:', e);
            return null;
        }
    }
    const localSnapshot = {
            rootFile: document.uri.fsPath,
            files: [document.uri.fsPath],
            fileIndexes: new Map([[document.uri.fsPath, fileIndex]]),
        };
    const referenceIndex = buildProjectReferenceIndex(localSnapshot);
    if (!isCurrent()) return null;
    if (mainDeckContext.state === 'ambiguous') {
        referenceIndex.completenessReasons.push('project-root-ambiguous');
    }
    return {
        referenceIndex,
        snapshot: localSnapshot,
        projectScoped: false,
        rootFile: document.uri.fsPath,
        mainDeckContextState: mainDeckContext.state,
        projectContextAmbiguous: mainDeckContext.state === 'ambiguous',
        candidateRootFiles: mainDeckContext.candidates.map(projectRootFile),
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
        referenceValue.targetKinds || referenceInfo.targetKinds,
        {
            projectScoped: !!(referenceIndexState && referenceIndexState.projectScoped),
            documentPath: location.documentPath,
            lineIndex: location.lineIndex,
            targetDefinitions: referenceValue.targetDefinitions || referenceInfo.targetDefinitions,
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
        const indexedBlocks = getReadyKeywordBlocksForDocument(document);
        if (indexedBlocks) {
            return indexedBlocks
                .filter(block => block.endLine > block.startLine)
                .map(block => new vscode.FoldingRange(block.startLine, block.endLine));
        }

        if (shouldSkipAutomaticDocumentScan(document)) return [];

        return parseKeywordBlocksFromDocument(document)
            .filter(block => block.endLine > block.startLine)
            .map(block => new vscode.FoldingRange(block.startLine, block.endLine));
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
        const indexedBlocks = getReadyKeywordBlocksForDocument(document);
        if (indexedBlocks) {
            return indexedBlocks.map(block => {
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

        return parseKeywordBlocksFromDocument(document).map(block => {
            const line = document.lineAt(block.startLine);
            return new vscode.DocumentSymbol(
                block.rawKeyword || block.keyword,
                '',
                vscode.SymbolKind.Property,
                line.range,
                line.range,
            );
        });
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

function presentationBlockAtLine(blocks, line) {
    let low = 0, high = blocks.length - 1;
    while (low <= high) {
        const mid = (low + high) >>> 1, block = blocks[mid];
        if (line < block.startLine) high = mid - 1;
        else if (line > block.endLine) low = mid + 1;
        else return block;
    }
    return null;
}

function updateDocumentPresentationAfterChange(event) {
    const document = event.document, cached = documentPresentationCache.get(document);
    const change = event.contentChanges?.length === 1 ? event.contentChanges[0] : null;
    const block = cached?.blocks && change ? presentationBlockAtLine(cached.blocks, change.range.start.line) : null;
    if (cached?.ready && cached.version === document.version - 1 && change &&
        cached.lineCount === document.lineCount && change.range.start.line === change.range.end.line &&
        !/[\r\n]/.test(change.text) && block &&
        change.range.start.line > block.startLine && !block.opaqueKind &&
        !String(block.keyword).replace(/^\*/, '').startsWith('INCLUDE') &&
        !classifyKeywordLine(document.lineAt(change.range.start.line).text).isKeyword) {
        cached.version = document.version;
        cached.skipDecorationsVersion = cached.painted ? document.version : null;
        const includes = includeDirectiveCache.get(document);
        if (includes?.version === document.version - 1) includes.version = document.version;
        return true;
    }
    documentPresentationCache.delete(document);
    includeDirectiveCache.delete(document);
    return false;
}

function prepareDocumentPresentation(document) {
    if (!document || document.isClosed || shouldSkipAutomaticDocumentScan(document)) return Promise.resolve(null);
    const previous = documentPresentationCache.get(document);
    if (previous && previous.version === document.version) return previous.pending;
    const state: any = { version: document.version, lineCount: document.lineCount, ready: false };
    documentPresentationCache.set(document, state);
    const current = () => !document.isClosed && document.version === state.version &&
        documentPresentationCache.get(document) === state;
    state.pending = (async () => {
        const readyIndex = readyCardEditBlockIndex(document);
        const blocks = readyIndex?.blocks ||
            await collectBlocksFromLineReaderAsync(document.lineCount, line => document.lineAt(line).text,
                { shouldCancel: () => !current() });
        if (!blocks || !current()) return null;
        const includes = await includeScanner.collectIncludeDirectivesFromDocumentBlocks(document, blocks, () => !current());
        if (!includes || !current()) return null;
        const ranges = [];
        let started = performance.now();
        for (const block of blocks) {
            const info = classifyKeywordLine(document.lineAt(block.startLine).text);
            ranges.push(new vscode.Range(block.startLine, info.indent || 0,
                block.startLine, (info.indent || 0) + (info.rawKeyword?.length || 0)));
            if (performance.now() - started >= 8) {
                await new Promise(resolve => setImmediate(resolve));
                if (!current()) return null;
                started = performance.now();
            }
        }
        if (!current()) return null;
        state.blocks = blocks;
        state.ranges = ranges;
        state.ready = true;
        includeDirectiveCache.set(document, { version: state.version, value: includes });
        return state;
    })().catch(error => {
        if (documentPresentationCache.get(document) === state) documentPresentationCache.delete(document);
        throw error;
    });
    return state.pending;
}

async function searchFileFromPathsAsync(filePath, paths) {
    for (const directory of paths) {
        const fullPath = path.resolve(directory, filePath);
        try { await fs.promises.access(fullPath); return fullPath; } catch (_) { /* next search root */ }
    }
    throw new Error(i18n.get('fileNotFound', filePath));
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
    const configExtensions = getLsdynaConfigurationValue('additionalExtensions', ['.k', '.key', '.dyna']) || ['.k', '.key', '.dyna'];
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

    const isCurrent = createDocumentReadGuard(document);
    if (!await prepareDocumentPresentation(document) || !isCurrent()) return [];
    const mode = pathCaseFidelity.normalizePathCaseCheckMode(
        options.mode !== undefined ? options.mode : getIncludePathCaseCheckMode(document)
    );
    const resolveFn = options.resolveIncludeWithCaseCheck || resolveIncludeWithCaseCheckImpl;
    const searchPaths = getSearchPath(document);
    const includeFileLinks = [];

    for (const entry of findIncludeFileLines(document)) {
        try {
            const fullPath = await searchFileFromPathsAsync(entry.fileName, searchPaths);
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
            await fs.promises.access(targetPath);
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

    return isCurrent() ? [...includeFileLinks, ...includePathLinks] : [];
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
    let opaqueActive = false;
    let keywordLine = null;
    let ordinal = 0;
    let records = [];
    let globalMode = 'standard';
    // LS-DYNA ignores everything after *END; do not flag long lines past it.
    const scanUpperBound = Math.min(document.lineCount, keywordValidator.findEndDirectiveLine(document) + 1);
    for (let i = 0; i < scanUpperBound; i++) {
        const line = document.lineAt(i);
        if (opaqueActive) {
            if (!isColumnZeroKeywordBoundary(line.text)) continue;
            opaqueActive = false;
        }
        if (classifyOpaqueCommentDirective(line.text)) {
            opaqueActive = true;
            continue;
        }
        if (classifyKeywordLine(line.text).isKeyword) {
            keywordLine = i; ordinal = 0; records = [];
            globalMode = globalInputFormatFromKeywordLine(line.text, globalMode);
            continue;
        }
        if (!isKeywordCommentLine(line.text)) {
            ordinal++;
            if (records.length < 32) records.push(line.text);
        }
        if (isKeywordCommentLine(line.text) || line.text.length <= 80) {
            continue;
        }
        const cardInfo = keywordSchema.getCardInfoForDocumentLine(document, i, getFieldData(), {
            keywordLine, dataLineOrdinal: ordinal, observedDataLines: records, globalInputFormat: globalMode,
        });
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

    const empty = { resolved: [], missing: [], missingIndicators: [] };
    const isCurrent = createDocumentReadGuard(document);
    if (!await prepareDocumentPresentation(document) || !isCurrent()) return empty;
    const lookups = new Map();
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
            if (!lookups.has(entry.fileName)) lookups.set(entry.fileName, (async () => {
                await searchFileFromPathsAsync(entry.fileName, searchPaths);
                return mode !== 'strict' || pathCaseFidelity.isIncludeResolveAccepted(
                    await resolveFn(entry.fileName, searchPaths), mode);
            })());
            const accepted = await lookups.get(entry.fileName);
            if (!isCurrent()) return empty;
            if (!accepted) {
                markMissing();
                continue;
            }
            resolved.push(...ranges);
        } catch (e) {
            markMissing();
        }
    }

    return isCurrent() ? { resolved, missing, missingIndicators } : empty;
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
                // U+FE0E keeps the warning sign as a monochrome text glyph so
                // editorWarning.foreground remains authoritative across themes.
                contentText: ' \u26A0\uFE0E',
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

    const cached = documentPresentationCache.get(document);
    if (cached?.ready && cached.version === document.version) return cached.ranges;
    return parseKeywordBlocksFromDocument(document).map(block => {
        const text = document.lineAt(block.startLine).text;
        const classification = classifyKeywordLine(text);
        const startChar = classification.indent || 0;
        const keywordLength = classification.rawKeyword?.length || 0;
        return new vscode.Range(
            block.startLine,
            startChar,
            block.startLine,
            startChar + keywordLength,
        );
    });
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
    return getDocumentParameterSymbols(document).definitions;
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
    return getDocumentParameterSymbols(document).references;
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
    if (!isActiveLsdynaSemanticLocation(document, position)) return null;
    const symbols = getDocumentParameterSymbols(document);
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
     * @param {import('vscode').CancellationToken} [token] - Cancellation token.
     * @returns {import('vscode').Definition|Promise<import('vscode').Definition|null>|null} definition destination.
     */
    provideDefinition(document, position, token) {
        if (token?.isCancellationRequested) return null;
        const param = shouldResolveParameterDefinitionAtPosition(document, position)
            ? getParameterAtCursor(document, position)
            : null;
        if (param) {
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
        return this.provideFieldDefinition(document, position, token);
    }

    async provideFieldDefinition(document, position, token) {
        const navigation = await resolveFieldReferenceNavigation(
            document,
            position,
            token,
            { semanticScope: 'prefer-registry' },
        );
        if (!navigation || token?.isCancellationRequested) return null;
        const candidates = navigation.provisional && navigation.provisionalPrimary
            ? [navigation.provisionalPrimary, ...(navigation.provisionalAlternatives || [])]
            : navigation.candidates;
        const locations = candidates.map(candidate => new vscode.Location(
            vscode.Uri.file(candidate.filePath),
            new vscode.Range(
                candidate.line,
                candidate.startCharacter,
                candidate.line,
                candidate.endCharacter,
            )
        ));
        if (locations.length === 0) return null;
        if (navigation.provisional && navigation.provisionalPrimary) return locations[0];
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
    provideReferences(document, position, context, token = null) {
        if (token?.isCancellationRequested ||
            !isActiveLsdynaSemanticLocation(document, position)) return [];
        const param = getParameterAtCursor(document, position);
        if (!param) return this.provideFieldReferences(document, position, context, token);
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

    async provideFieldReferences(document, position, context, token = null) {
        const network = await resolveRegistryReferenceNetwork(
            document,
            position,
            context,
            token,
        );
        if (!network || network.state !== 'complete' || token?.isCancellationRequested) return [];
        return network.locations.map(location => new vscode.Location(
            vscode.Uri.file(location.filePath),
            new vscode.Range(
                location.line,
                location.startCharacter,
                location.line,
                location.endCharacter,
            ),
        ));
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
function buildFieldHelpMarkdown(field, context: any = {}) {
    if (!field) return '';
    const language = i18n.getLanguage();
    const englishHelp = keywordSchema.getEnglishFieldHelp(field);
    let relaxedRecord = null;
    if (!englishHelp) {
        try {
            const catalog = getRelaxedModelEvidenceV1Catalog();
            const physicalId = context.finalPhysicalFieldId || field.finalPhysicalFieldId;
            if (physicalId) {
                relaxedRecord = catalog.recordForField(physicalId);
            } else if (!field.nativeIdentity) {
                const candidates = catalog.recordsForFieldName(field.n || context.fieldName);
                // Name-only lookup is safe only for a unique physical field.
                relaxedRecord = candidates.length === 1 ? candidates[0] : null;
            }
        } catch (_error) {
            relaxedRecord = null;
        }
    }
    const manualContext = context.manualContext !== undefined
        ? context.manualContext
        : field.nativeIdentity ? null : buildProvisionalManualContext(field, context);
    const resolved = resolveProvisionalFieldHelp({
        language,
        field,
        strictText: englishHelp,
        relaxedRecord,
        manualContext,
        schemaText: context.schemaText,
        fieldName: context.fieldName,
        keyword: context.keyword,
        cardIndex: context.cardIndex,
        fieldIndex: context.fieldIndex,
    });
    const provisional = resolved.source !== 'strict';
    const sourceKeys = {
        'relaxed-model': 'fieldHelpSourceRelaxed',
        'manual-context': 'fieldHelpSourceManual',
        'lspp-schema': 'fieldHelpSourceSchema',
        'field-name': 'fieldHelpSourceName',
    };
    const localizedHelp = language === 'zh-cn'
        ? provisional
            ? keywordSchema.getLocalizedHelpForText(resolved.text)
            : keywordSchema.getLocalizedFieldHelp(field)
        : null;
    const prefix = provisional
        ? `⚠ **${i18n.get('fieldHelpProvisional')}** · _${i18n.get(sourceKeys[resolved.source])}_\n\n`
            + (language === 'zh-cn' && !localizedHelp && !/[\u3400-\u9fff]/.test(resolved.text)
                ? `${i18n.get('fieldHelpUntranslated')}\n\n` : '')
        : '';
    const parts = selectFieldHelp(provisional ? resolved.text : englishHelp, localizedHelp, language);
    const summaryLabel = i18n.get('fieldHelpEnglishOriginal');
    if (parts.secondary) {
        const id = stashFieldHelpEnglish(parts.secondary);
        return prefix + formatFieldHelpMarkdown(parts, {
            summaryLabel,
            englishCommandHref:
                `command:extension.showFieldHelpEnglish?${encodeURIComponent(JSON.stringify([id]))}`,
        });
    }
    return prefix + formatFieldHelpMarkdown(parts, { summaryLabel });
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
function keywordHoverMarkdown(
    kwName,
    entry,
    activeOptions = [],
    canonicalName = kwName,
    observedDataLines = [],
    nativeCards = undefined,
) {
    const lookup = {
        inputName: kwName,
        canonicalName,
        entry,
        activeOptions,
    };
    const cards = nativeCards ?? keywordSchema.getRenderedCardsForLookup(lookup, observedDataLines);
    const lines = [`### $(symbol-keyword) **\\*${kwName}**\n\n---\n`];
    let cardNum = 1;

    const tableHeader = `| ${i18n.get('keywordHoverCard')} | 1-10 | 11-20 | 21-30 | 31-40 | 41-50 | 51-60 | 61-70 | 71-80 |`;
    const tableSeparator = `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |`;
    const tableRows = [];

    for (const card of cards) {
        if (!card.length) continue;
        if (nativeCards) {
            tableRows.push(`| **${cardNum++}** | ${card.map(field => inlineSemanticLabel(field.n)).join(' · ')} |`);
            continue;
        }
        const isWide = card.length === 1 && card[0].w >= 40;
        if (isWide) {
            tableRows.push(`| **${cardNum}** | \`${card[0].n}\` | *(${i18n.get('keywordHoverTitle')})* | | | | | | |`);
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
        lines.push(nativeCards ? `| ${i18n.get('keywordHoverCard')} | ${i18n.get('cardColumns')} |` : tableHeader);
        lines.push(nativeCards ? '| :--- | :--- |' : tableSeparator);
        lines.push(...tableRows);
        lines.push('');
    }

    if (nativeCards) lines.push(i18n.getLanguage() === 'zh-cn'
        ? '以上为当前数据前部已确定的记录。' : 'Resolved records from the beginning of the current data.');
    if (!nativeCards && entry.r) lines.push(`*(✨ ${i18n.get('keywordHoverLastCardRepeats')})*\n`);
    if (entry.o && entry.o.length) {
        const active = new Set((activeOptions || []).map(option => String(option || '').toUpperCase()));
        const options = supportedKeywordOptions(entry, canonicalName).map(option => {
            const name = String(option.n || '').toUpperCase();
            return active.has(name)
                ? `\`${option.n}\` *(${i18n.get('keywordHoverOptionActive')})*`
                : `\`${option.n}\``;
        });
        if (options.length) {
            lines.push(`$(gear) **${i18n.get('keywordHoverOptions')}:** ${options.join(' • ')}`);
        }
        const deniedActive = (entry.o || [])
            .filter(option => active.has(normalizeOptionName(option.n)))
            .filter(option => parseKeywordOptionOrder(option).position === 'pre')
            .filter(option => keywordSchema.keywordPrefixOptionDecision(
                canonicalName,
                normalizeOptionName(option.n),
            ) === 'deny')
            .map(option => normalizeOptionName(option.n));
        if (deniedActive.length) {
            lines.push(`$(warning) ${i18n.get('keywordPrefixOptionUnsupported', deniedActive.join(', '))}`);
        }
        const unverifiedActive = (entry.o || [])
            .filter(option => active.has(normalizeOptionName(option.n)))
            .filter(option => (option.to || 0) > 0 && (option.c || []).length > 0)
            .filter(option => keywordSchema.keywordPrefixOptionDecision(
                canonicalName,
                normalizeOptionName(option.n),
            ) === 'unverified');
        if (unverifiedActive.length) {
            lines.push(`$(warning) ${i18n.get('keywordPrefixLayoutUnavailable')}`);
        }
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

function titleKeywordOptions(entry, canonicalName = '') {
    return (entry.o || [])
        .filter(option => (option.to || 0) > 0)
        .filter(option => parseKeywordOptionOrder(option).position === 'pre')
        .filter(option => keywordOptionIsSupported(option, canonicalName))
        .filter(option => keywordSchema.keywordPrefixOptionDecision(
            canonicalName,
            normalizeOptionName(option.n),
        ) === 'allow')
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

function keywordOptionSummary(entry, canonicalName = '') {
    const titleNames = titleKeywordOptions(entry, canonicalName).map(option => normalizeOptionName(option.n));
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

    const current = createDocumentReadGuard(document);
    if (!await prepareDocumentPresentation(document) || !current()) return [];

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
    const current = createDocumentReadGuard(document);
    if (!shouldSkipAutomaticDocumentScan(document) && !await prepareDocumentPresentation(document)) return;
    if (!current()) return;
    const lineLengthDiagnostics = collectLineLengthDiagnostics(document);
    const includePathLengthDiagnostics = collectIncludePathLengthDiagnostics(document);
    const keywordValidationDiagnostics = keywordValidator.collectKeywordValidationDiagnostics(
        document,
        shouldSkipAutomaticDocumentScan
    );
    const includePathCaseDiagnostics = await collectIncludePathCaseDiagnostics(document, options);
    if (!current()) return;
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
    if (keywordOptionsViewControllerRef?.open) {
        return keywordOptionsViewControllerRef.open(editor, requestedLine);
    }
    return chooseKeywordOptionsQuickPickLegacy(editor, requestedLine);
}

class LsdynaKeywordOptionsCodeLensProvider {
    provideCodeLenses(document) {
        if (!document || shouldSkipAutomaticDocumentScan(document)) return [];
        const showOnAll = getLsdynaConfigurationValue('codeLens.showOnAllKeywords', false, document.uri);
        if (!showOnAll) return [];

        const lenses = [];
        for (const block of parseKeywordBlocksFromDocument(document)) {
            if (block.opaqueKind) continue;
            const lineNum = block.startLine;
            const text = document.lineAt(lineNum).text;
            const classification = classifyKeywordLine(text);
            if (!classification.isKeyword || classification.rawKeyword.startsWith('**')) continue;
            const lookup = lookupKeywordInfo(keywordLineNameFromText(text));
            if (!lookup) continue;

            const hasOptions = writableKeywordOptions(
                lookup.entry,
                lookup.canonicalName,
            ).length > 0;

            const range = new vscode.Range(lineNum, 0, lineNum, 0);

            if (hasOptions) {
                const summary = keywordOptionSummary(lookup.entry, lookup.canonicalName);
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

function appendKeywordHoverActions(md, lookup, lineNum, document, advice) {
    const args = encodeURIComponent(JSON.stringify([lineNum]));
    const actions = [];
    if (writableKeywordOptions(lookup.entry, lookup.canonicalName).length > 0 || groupConditionalAdvice(advice).length > 0) {
        const managerArgs = encodeURIComponent(JSON.stringify([{ uri: documentUriIdentity(document), documentVersion: document.version, keywordLine: lineNum }]));
        actions.push(
            `[${i18n.get('keywordHoverConfigureOptions')}](command:extension.lsdynaChooseKeywordOptions?${managerArgs} "${i18n.get('keywordHoverConfigureOptionsTooltip')}")`,
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
    typedName = stripKeywordInputFormatMarker(String(typedName || '').toUpperCase().replace(/^\*/, ''));

    const direct = typedName ? lookupKeywordInfo(typedName) : null;
    if (direct) {
        return { typedName, lookup: direct, suggestedName: null, viaSuggest: false };
    }

    // A catalogued identity without field geometry is not a spelling error.
    // Neither missing rules nor an unavailable catalog authorize another
    // keyword's field help, including a remembered suggestion.
    if (keywordStructureCatalog.hasKeywordIdentity(typedName) !== false) {
        return { typedName, lookup: null, suggestedName: null, viaSuggest: false };
    }
    try {
        if (getCatalogInputFormCatalogV4().formForKeyword(typedName))
            return { typedName, lookup: null, suggestedName: null, viaSuggest: false };
    } catch { return { typedName, lookup: null, suggestedName: null, viaSuggest: false }; }

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
function getCardInfoForDocumentLineWithSuggest(document, lineNum, schema, options: any = {}): any {
    if (!isActiveLsdynaSemanticLocation(document, { line: lineNum, character: 0 })) {
        return { cardInfo: null, viaSuggest: false, reason: 'inactive-semantic-location' };
    }
    const fieldSchema = schema || getFieldData();
    const context = fieldContextForLine(document, lineNum, fieldSchema, { ...options, includeCommentHeaders: true });
    if (context.status !== 'resolved') return { cardInfo: null, viaSuggest: false, reason: context.reason };
    const direct = keywordSchema.resolveCardFromContext(context.context, fieldSchema);
    let cardInfo = direct.cardInfo || null;
    let viaSuggest = false;
    let suggestedName = null;
    if (!cardInfo && direct.reason === 'keyword-schema-unavailable') {
        const suggestion = resolveKeywordLookupWithSuggest(document, context.context.keywordLine);
        if (suggestion.viaSuggest && suggestion.suggestedName) {
            suggestedName = suggestion.suggestedName;
            cardInfo = keywordSchema.resolveCardFromContext(context.context, fieldSchema, suggestedName).cardInfo || null;
            viaSuggest = !!cardInfo;
        }
    }
    if (cardInfo) cardInfo = { ...cardInfo, cardCommentNotice: keywordSchema.assessCardComment(cardInfo, context.commentHeaders || []) };
    return {
        cardInfo, viaSuggest, suggestedName, keywordLine: context.context.keywordLine,
        typedName: classifyKeywordLine(context.context.keywordText).normalizedKeyword.replace(/^\*/, ''), reason: direct.reason,
        unsupportedOptions: direct.unsupportedOptions || [],
        prefixLayoutStatus: direct.reason === 'prefix-layout-unverified' ? 'unverified'
            : direct.reason === 'unsupported-keyword-option' ? 'unsupported-option' : undefined,
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
            detailMarkdown = keywordHoverMarkdown(
                preferred,
                pickLookup.entry,
                pickLookup.activeOptions,
                pickLookup.canonicalName,
            );
        }
    } else if (suggest.tier === 'high' && suggest.items[0]) {
        const best = suggest.items[0].keyword;
        const bestLookup = lookupKeywordInfo(best);
        if (bestLookup) {
            suggestHelpKeyword = best;
            detailMarkdown = keywordHoverMarkdown(
                best,
                bestLookup.entry,
                bestLookup.activeOptions,
                bestLookup.canonicalName,
            );
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
    async provideHover(document, position, cancellationToken = undefined) {
        const documentVersion = document.version;
        const isCurrent = createReferenceReadGuard(document, cancellationToken);
        if (!isCurrent()) return null;
        if (cancellationToken?.isCancellationRequested) return null;
        if (shouldSkipAutomaticDocumentScan(document)) return null;
        if (!isActiveLsdynaSemanticLocation(document, position)) return null;

        // Hover on include file paths
        if (!shouldSkipAutomaticDocumentScan(document) && !await prepareDocumentPresentation(document)) return null;
        if (!isCurrent()) return null;
        const includeEntries = shouldSkipAutomaticDocumentScan(document) ? [] : findIncludeFileLines(document);
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
                    md.isTrusted = HOVER_TRUST;
                    md.supportThemeIcons = true;

                    const previewText = await getIncludeFilePreview(fullPath);
                    if (!isCurrent()) return null;
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

        if (!await prepareFieldInteraction(document, position, { cancellationToken }) || !isCurrent()) return null;
        await prepareReferenceDirectory();
        if (!isCurrent()) return null;
        const line = document.lineAt(position.line);
        const text = line.text;
        const trimmed = text.trimStart();

        // Parameter hover is document-local first. Project evaluation is an optional
        // second layer and is not required to show a definition already in this file.
        const parameterAtCursor = getParameterAtCursor(document, position);
        let nativeParameterMarkdown = '';
        if (parameterAtCursor) {
            const located = (await getCardInfoForDocumentLineWithSuggestAsync(document, position.line, getFieldData(), { cancellationToken })).cardInfo;
            if (!isCurrent()) return null;
            const isParameterKeyword = located?.keywordName ? Boolean(classifyParameterKeyword(located.keywordName)) : false;
            const isParameterOnly = isParameterKeyword || parameterAtCursor.kind === 'definition' || parameterAtCursor.syntax === 'bare';
            const nativeField = !isParameterOnly && located?.resolutionSource === 'native-file-reader' ? located.card.find(field =>
                field.nativeRange && position.character >= field.nativeRange.start && position.character < field.nativeRange.end) : null;
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
            const effectiveAnalysis = nativeField ? nativeParameterContextForDocument(document).resolve(nativeField.rawValue, position.line) : referenceIndexState && referenceIndexState.projectScoped
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
            md.isTrusted = HOVER_TRUST;
            md.supportThemeIcons = true;
            if (!nativeField) return new vscode.Hover(md, parameterAtCursor.fullRange);
            nativeParameterMarkdown = md.value;
        }

        // Hover on keyword lines
        const currentClassification = classifyKeywordLine(text);
        if (currentClassification.isKeyword) {
            const kwName = currentClassification.normalizedKeyword.slice(1);
            if (!kwName) return null;

            let previewMd = '';
            const normalizedKw = kwName.toUpperCase();
            if (normalizedKw.startsWith('DEFINE_CURVE') || normalizedKw.startsWith('DEFINE_TABLE')) {
                const referenceIndexState = await getReferenceIndexForDocument(document, cancellationToken);
            if (!isCurrent() || referenceIndexState?.unavailable) return null;
                const fileIndex = lookupNormalizedFileIndex(referenceIndexState?.snapshot?.fileIndexes, document.uri.fsPath) || getFileIndexForDocument(document);
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
                        const tablePreviewKey = buildTablePreviewReferenceKey(
                            document.uri.fsPath,
                            position.line,
                            `definition:${resolvedMatch.keyword}:${resolvedMatch.id ?? resolvedMatch.idRaw ?? ''}`
                        );
                        previewMd = buildDefinitionHoverSection(
                            resolvedMatch,
                            themeKind,
                            {
                                key: tablePreviewKey,
                                view: getTablePreviewViewForReference(tablePreviewKey),
                                filePath: document.uri.fsPath,
                                lineIndex: position.line,
                                character: 0,
                                endCharacter: document.lineAt(position.line).text.length,
                            }
                        );
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
                    md.isTrusted = HOVER_TRUST;
                    md.supportThemeIcons = true;
                    md.supportHtml = true;
                    // Manual links for the suggested keyword when we embedded its help; else the typed name.
                    appendManualLinks(md, built.suggestHelpKeyword || kwName);
                    return new vscode.Hover(md);
                }
                return null;
            }
            const prefixRecords = collectBoundedPrefixDataRecords(document, position.line);
            const prefixDataLines = prefixRecords.map(record => record.text);
            const parameterContext = prefixDataLines.some(text => text.includes('&')) ? nativeParameterContextForDocument(document) : undefined;
            const nativeCards = require('./core/semantics/nativeFieldResolution').hasNativeFileReader(lookup.inputName)
                ? prefixDataLines.flatMap((currentText, index) => {
                    const result = keywordSchema.resolveCardFromContext({
                        keywordLine: position.line, keywordText: text, currentText,
                        dataLineOrdinal: index + 1, observedDataLines: prefixDataLines,
                        recordLines: prefixRecords.map(record => record.line), parameterContext,
                        globalInputFormat: documentGlobalInputFormat(document),
                    }, getFieldData());
                    return result.cardInfo ? [result.cardInfo.card] : [];
                }) : undefined;
            let hoverContent = keywordHoverMarkdown(
                kwName,
                lookup.entry,
                lookup.activeOptions,
                lookup.canonicalName,
                prefixDataLines,
                nativeCards,
            );
            const semanticAdvice = getKeywordSemanticAdviceForDocument(document, position.line, lookup);
            const semanticMarkdown = buildKeywordSemanticAdviceMarkdown(semanticAdvice);
            if (semanticMarkdown) hoverContent += `\n\n${semanticMarkdown}`;
            const structureAnalysis = analyzeKeywordStructureForDocument(
                document,
                position.line,
                { maximumPhysicalLines: KEYWORD_STRUCTURE_HOVER_MAX_PHYSICAL_LINES },
            );
            const cardEditPlan = planVerifiedConditionalCardsForDocument(document, position.line);
            const cardEditMarkdown = buildVerifiedConditionalCardEditMarkdown(
                cardEditPlan,
                document,
                position.line,
            );
            const structureMarkdown = buildKeywordStructureIssueMarkdown(
                structureAnalysis,
                document,
                position.line,
                position.line,
                { allowRepair: cardEditPlan?.status !== 'ready' },
            );
            if (structureMarkdown) hoverContent += `\n\n${structureMarkdown}`;
            if (cardEditMarkdown) hoverContent += `\n\n${cardEditMarkdown}`;
            if (previewMd) {
                hoverContent = `${previewMd}\n\n---\n\n${hoverContent}`;
            }
            const md = new vscode.MarkdownString(hoverContent);
            md.isTrusted = HOVER_TRUST;
            md.supportThemeIcons = true;
            md.supportHtml = true;
            if (!classifyOpaqueCommentDirective(text)) {
                appendKeywordHoverActions(md, lookup, position.line, document, semanticAdvice);
            }
            appendManualLinks(md, kwName);
            return new vscode.Hover(md);
        }

        // Fixed field help requires fixed data; conversion is an explicit editor action.
        if (isKeywordCommentLine(text)) return null;

        const resolvedCard = await getCardInfoForDocumentLineWithSuggestAsync(document, position.line, getFieldData(), { cancellationToken });
        if (!isCurrent()) return null;
        const kwLine = resolvedCard.keywordLine;
        if (!Number.isInteger(kwLine)) return null;
        const kwText = document.lineAt(kwLine).text.trim();
        const kwName = kwText.slice(1).toUpperCase().split(/[\s,]/)[0];
        const cardInfo = resolvedCard.cardInfo;
        const card = cardInfo ? cardInfo.card : null;
        if (!card || card.length === 0) {
            const rejectionMessage = String(resolvedCard.reason || '').endsWith('spelling-rejected')
                ? (i18n.getLanguage() === 'zh-cn'
                    ? '当前字段规则不支持此关键字拼写，无法提供对应的字段说明。'
                    : 'This keyword spelling is not supported by the current field rules; no corresponding field help is available.') : '';
            const controlIssue = String(resolvedCard.reason || '').match(/^native-control-(.+)-(missing|blank|unresolved)$/);
            const controlMessage = controlIssue ? (i18n.getLanguage() === 'zh-cn'
                ? `无法确定此处字段：控制字段 ${controlIssue[1]} ${controlIssue[2] === 'missing' ? '所在记录缺失' : controlIssue[2] === 'blank' ? '为空，默认值尚未得到文件规则验证' : '的值无法解析'}。`
                : `Cannot determine this field: control ${controlIssue[1]} ${controlIssue[2] === 'missing' ? 'has no source record' : controlIssue[2] === 'blank' ? 'is blank and its file default is not verified' : 'has an unresolved value'}.`) : '';
            const parameterIssue = String(resolvedCard.reason || '').startsWith('native-parameter-')
                ? String(resolvedCard.reason).slice('native-'.length).split(',').map(uncertaintyReasonLabel).join('\n\n')
                : '';
            const issue = buildPrefixLayoutIssueMarkdown(
                resolvedCard.prefixLayoutStatus,
                resolvedCard.unsupportedOptions,
            ) || rejectionMessage || parameterIssue || controlMessage || (String(resolvedCard.reason || '').startsWith('native-')
                ? (i18n.getLanguage() === 'zh-cn'
                    ? '无法确定此处字段：控制值、记录结构或输入格式尚未得到确认。'
                    : 'Cannot determine this field: the control value, record layout, or input format is not resolved.')
                : '');
            if (!issue) return null;
            const issueMd = new vscode.MarkdownString(issue);
            issueMd.isTrusted = HOVER_TRUST;
            issueMd.supportHtml = true;
            issueMd.supportThemeIcons = true;
            return new vscode.Hover(
                issueMd,
                new vscode.Range(position.line, 0, position.line, text.length),
            );
        }

        // Field-help quiet switch: only suppress card-field hovers (not include/param/keyword).
        if (!isFieldHoverEffective(document.uri)) return null;

        const cardCommentNoticeMarkdown = buildCardCommentNoticeMarkdown(
            cardInfo,
            document,
            kwLine,
            position.line,
        );
        const col = position.character;
        const matchingFields = card.filter(f => col >= f.p && col < f.p + f.w);
        const field = matchingFields[0];
        if (!field) {
            if (!cardCommentNoticeMarkdown) return null;
            const conflictMd = new vscode.MarkdownString(cardCommentNoticeMarkdown);
            conflictMd.isTrusted = HOVER_TRUST;
            conflictMd.supportHtml = true;
            conflictMd.supportThemeIcons = true;
            return new vscode.Hover(
                conflictMd,
                new vscode.Range(position.line, 0, position.line, text.length),
            );
        }

        // Limit the hover to a region with the same set of native identities.
        // Otherwise a single-field hover can stay cached as the cursor enters
        // a partially overlapping field's window.
        const boundaries = card.flatMap(f => f.nativeRange ? [f.nativeRange.start, f.nativeRange.end] : []);
        const nativeStart = field.nativeRange ? Math.max(field.nativeRange.start, ...boundaries.filter(value => value <= col)) : Math.min(text.length, field.p);
        const nativeEnd = field.nativeRange ? Math.min(field.nativeRange.end, ...boundaries.filter(value => value > col)) : Math.min(text.length, field.p + field.w);
        if (matchingFields.length > 1 && matchingFields.every(f => f.nativeIdentity)) {
            const md = new vscode.MarkdownString(i18n.getLanguage() === 'zh-cn'
                ? '这些原生字段读取共享字节，各自保留字段身份和类型。'
                : 'These native fields read shared bytes and retain distinct identities and types.');
            md.isTrusted = HOVER_TRUST;
            md.supportHtml = true;
            md.supportThemeIcons = true;
            for (const candidate of matchingFields) {
                md.appendMarkdown(`\n\n### **${candidate.n}** *(${candidate.t})*\n\n`);
                md.appendCodeblock(candidate.rawValue ?? text.slice(candidate.p, candidate.p + candidate.w));
                const help = buildFieldHelpMarkdown(candidate, {
                    keyword: cardInfo.keywordName || kwName, cardIndex: cardInfo.cardIndex, fieldIndex: card.indexOf(candidate),
                });
                if (help) md.appendMarkdown(`\n\n${help}`);
            }
            const conditions = buildControlConditionMarkdown(document, kwLine, matchingFields.map(candidate => candidate.n));
            if (conditions) md.appendMarkdown(`\n\n${conditions}`);
            if (cardCommentNoticeMarkdown) md.appendMarkdown(`\n\n${cardCommentNoticeMarkdown}`);
            if (cardInfo.nativeConditions?.length) md.appendMarkdown(`\n\n${cardInfo.nativeConditions.join(' · ')}`);
            if (nativeParameterMarkdown) md.appendMarkdown(`\n\n${nativeParameterMarkdown}`);
            appendManualLinks(md, resolvedCard.suggestedName || kwName, { fieldHoverQuiet: true });
            return new vscode.Hover(md, new vscode.Range(position.line, nativeStart, position.line, nativeEnd));
        }

        const fieldCardCommentNoticeMarkdown = buildCardCommentNoticeMarkdown(
            cardInfo,
            document,
            kwLine,
            position.line,
            field,
        );
        const typeLabel = field.t ? ` *(${field.t})*` : '';
        const helpKeywordName = cardInfo.keywordName || resolvedCard.suggestedName || kwName;
        const formattedHelp = buildFieldHelpMarkdown(field, {
            keyword: helpKeywordName,
            cardIndex: cardInfo.cardIndex,
            fieldIndex: card.indexOf(field),
        });
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
        const rawFieldValue = field.rawValue ?? text.slice(field.p, field.p + field.w);
        const referenceInfo = field.nativeIdentity && !field.nativeStaticBinding ? null : getActionableFieldReferenceInfo({
            keyword: helpKeywordName,
            cardIndex: cardInfo.cardIndex,
            field,
        });
        const referenceValue = referenceInfo ? parseFieldReferenceValue(rawFieldValue, referenceInfo) : null;
        const manualKw = resolvedCard.suggestedName || kwName;
        const officialChoicePlan = resolvedCard.viaSuggest || (field.nativeIdentity && !field.nativeStaticBinding)
            ? null
            : planOfficialFieldChoicesForDocument(document, position, {
                keywordLine: kwLine,
                expectedDocumentVersion: document.version,
                maximumKeywordLookback: 0,
            });
        const officialChoiceMarkdown = buildOfficialFieldChoiceHoverMarkdown(
            officialChoicePlan,
            document,
        );

        let md;
        if (referenceInfo && referenceValue) {
            md = new vscode.MarkdownString(`### $(symbol-field) <span style="color:var(--vscode-textLink-foreground);">**${field.n}**</span>${suggestInfoIcon}${typeLabel}`);
            md.isTrusted = HOVER_TRUST;
            md.supportHtml = true;
            md.supportThemeIcons = true;

            const referenceIndexState = await getReferenceIndexForDocument(document, cancellationToken);
            if (!isCurrent() || referenceIndexState?.unavailable) return null;
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
            const tablePreviewKey = buildTablePreviewReferenceKey(
                document.uri.fsPath,
                position.line,
                field.n
            );

            md.appendMarkdown(buildReferenceHoverSection({
                fieldName: field.n,
                referenceValue,
                isSignedSwitch: referenceValue.isSignedSwitch,
                analysis,
                themeKind,
                documentPath: document.uri.fsPath,
                tablePreviewContext: {
                    key: tablePreviewKey,
                    view: getTablePreviewViewForReference(tablePreviewKey),
                    filePath: document.uri.fsPath,
                    lineIndex: position.line,
                    character: field.p,
                    endCharacter: field.p + field.w,
                },
                workspaceSearchContext: {
                    filePath: document.uri.fsPath,
                    lineIndex: position.line,
                    character: field.p,
                    documentVersion: document.version,
                    projectRootFile: referenceIndexState && referenceIndexState.projectScoped
                        ? referenceIndexState.rootFile
                        : undefined,
                },
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
            if (officialChoiceMarkdown) md.appendMarkdown(`\n\n${officialChoiceMarkdown}`);
            if (fieldCardCommentNoticeMarkdown) md.appendMarkdown(`\n\n${fieldCardCommentNoticeMarkdown}`);
            appendManualLinks(md, manualKw, { fieldHoverQuiet: true });
        } else {
            md = new vscode.MarkdownString(`### $(symbol-field) <span style="color:var(--vscode-textLink-foreground);">**${field.n}**</span>${suggestInfoIcon}${typeLabel}${helpText}\n\n---\n\n**$(table) ${i18n.get('cardColumns')}:**\n\n${gridTable}`);
            md.isTrusted = HOVER_TRUST;
            md.supportHtml = true;
            md.supportThemeIcons = true;
            if (officialChoiceMarkdown) md.appendMarkdown(`\n\n${officialChoiceMarkdown}`);
            if (fieldCardCommentNoticeMarkdown) md.appendMarkdown(`\n\n${fieldCardCommentNoticeMarkdown}`);
            appendManualLinks(md, manualKw, { fieldHoverQuiet: true });
        }

        const conditions = buildControlConditionMarkdown(document, kwLine, [field.n]);
        if (conditions) md.appendMarkdown(`\n\n${conditions}`);
        if (cardInfo.nativeConditions?.length) {
            md.appendMarkdown(`\n\n${cardInfo.nativeConditions.map(value => `\`${value}\``).join(' · ')}`);
        }
        if (nativeParameterMarkdown) md.appendMarkdown(`\n\n---\n\n${nativeParameterMarkdown}`);
        const range = new vscode.Range(position.line, nativeStart, position.line, nativeEnd);
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
    const cached = documentPresentationCache.get(document);
    const block = cached?.ready && cached.version === document.version
        ? presentationBlockAtLine(cached.blocks, position.line) : null;
    if (cached?.ready && (!block || block.opaqueKind || !String(block.keyword).replace(/^\*/, '').startsWith('INCLUDE'))) return false;
    const linesBeforeAndCurrent = [];
    for (let i = block?.startLine || 0; i <= position.line; i++) {
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
    async provideCompletionItems(document, position, token, context) {
        if (!document || !document.uri || !document.uri.fsPath) return [];
        if (activeDocumentHasMultipleSelections(document)) return [];
        if (shouldSkipAutomaticDocumentScan(document)) return [];
        const current = createDocumentReadGuard(document, token);
        if (!await prepareDocumentPresentation(document) || !current()) return [];
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
    const text = document?.lineAt(lineNum)?.text || '';
    if (!isActiveLsdynaSemanticLocation(document, { line: lineNum, character: text.length })) return null;
    const schema = getFieldData();
    const context = fieldContextForLine(document, lineNum, schema);
    if (context.status !== 'resolved') return null;
    const kwText = context.context.keywordText;

    const ignoreKeywords = getLsdynaConfigurationValue('ignoreFormattingKeywords', [], document.uri) || [];
    const kwTextUpper = kwText.toUpperCase();
    for (const prefix of ignoreKeywords) {
        if (kwTextUpper.startsWith(prefix.toUpperCase())) {
            return null;
        }
    }

    // The conversion picker needs template geometry for comma-delimited input;
    // semantic consumers use the strict resolver and never interpret these bytes as fixed cells.
    const info = keywordSchema.resolveCardFromContext(context.context, schema, null, true).cardInfo;
    return info ? info.card : null;
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
    async provideCompletionItems(document, position, token, context) {
        if (inlineEditChoiceSession) return [];
        if (activeDocumentHasMultipleSelections(document)) return [];
        if (!document || shouldSkipAutomaticDocumentScan(document)) return [];
        const current = createDocumentReadGuard(document, token);
        if (!await prepareFieldInteraction(document, position, { cancellationToken: token }) || !current()) return [];
        if (!isActiveLsdynaSemanticLocation(document, position)) return [];

        const line = document.lineAt(position.line);
        const text = line.text;
        const trimmed = text.trimStart();
        const textBeforeCursor = text.slice(0, position.character).trim();
        const isCommentTrigger = textBeforeCursor === '$' || textBeforeCursor === '$#';
        const fieldContext = fieldContextForLine(document, position.line, getFieldData());
        const keywordLine = fieldContext.status === 'resolved' ? fieldContext.context.keywordLine : null;
        const textCardInfo = fieldContext.status === 'resolved'
            ? keywordSchema.resolveCardFromContext(fieldContext.context, getFieldData()).cardInfo : null;

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

        const items = buildOfficialFieldChoiceCompletionItems(
            document,
            position,
            context,
            textCardInfo,
            keywordLine,
        );

        // 1. Row Card Template (Only when line is empty or near the beginning)
        if (position.character <= 1) {
            // Counting the ordinal may walk a long repeating block. It is only
            // presentation metadata for the row template, so never pay that cost
            // for ordinary in-cell value completion.
            const displayIndex = getDataCardDisplayIndexForLine(document, position.line);
            const templateItem = new vscode.CompletionItem(
                i18n.get('rowTemplateLabel', displayIndex + 1),
                vscode.CompletionItemKind.Snippet
            );
            templateItem.detail = i18n.get('rowTemplateDetail');
            templateItem.documentation = new vscode.MarkdownString(i18n.get('rowTemplateDocumentation'));

            const template = require('./core/completion/recordTemplate').recordTemplate(card.map(field => ({
                name: field.n, position: field.p, width: field.w, type: field.t, defaultValue: field.d,
            })));
            if (!template) return items;
            templateItem.insertText = new vscode.SnippetString(template.snippet);
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
                const completionKeyword = keywordLine !== null
                    ? keywordLineNameFromText(document.lineAt(keywordLine).text)
                    : '';
                const helpMd = buildFieldHelpMarkdown(f, {
                    keyword: completionKeyword,
                    cardIndex: textCardInfo?.cardIndex || 1,
                    fieldIndex: j,
                });
                if (helpMd) {
                    const doc = new vscode.MarkdownString(helpMd);
                    doc.supportHtml = true;
                    doc.isTrusted = HOVER_TRUST;
                    item.documentation = doc;
                }

                const template = require('./core/completion/recordTemplate').recordTemplate([{
                    name: f.n, position: 0, width: f.w, type: f.t, defaultValue: f.d,
                }]);
                if (!template) continue;
                const insertText = ' '.repeat(padding) + template.snippet;
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
        if (inlineEditChoiceSession) return [];
        if (activeDocumentHasMultipleSelections(document)) return [];
        if (!document || shouldSkipAutomaticDocumentScan(document)) return [];
        if (!isActiveLsdynaSemanticLocation(document, position)) return [];

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


const { generateCommentLine } = require('./core/completion/fieldComment');

const autoIndentEditBarriers = new WeakMap<object, Promise<void>>();

async function handleEnterIndentationRemoval(event) {
    if (event.document.languageId !== 'lsdyna') return;
    if (
        getLsdynaConfigurationValue(
            'clearAutoIndentOnEnter',
            false,
            event.document.uri,
        ) !== true
    ) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) return;

    const editIsCurrent = documentEditGuard.createDocumentEditGuard(event.document, editor);
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

    let release;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    autoIndentEditBarriers.set(event.document, barrier);
    try {
        if (!await canApplyDocumentEdit(event.document, editIsCurrent)) return;
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
    } finally {
        if (autoIndentEditBarriers.get(event.document) === barrier) autoIndentEditBarriers.delete(event.document);
        release();
    }
}


function extractSmartTokens(text) {
    const trimmed = text.trimStart();
    // Never split a non-whitespace token heuristically. LS-DYNA accepts compact
    // exponents such as `1.0-3` / `2.0+4`; interpreting the sign as an adjacent
    // field silently changes the engineering value. Genuinely concatenated
    // fixed-width values are resolved by their physical columns instead.
    return trimmed.split(/\s+/).filter(t => t.length > 0);
}

function planAlignedLine(
    text,
    card,
    isFieldHeaderLine = false,
    options = { allowAmbiguousTrailing: false, forceValueOrder: false },
) {
    const originalText = String(text || '');
    const unchanged = () => ({ status: 'unchanged', text: originalText, reason: null });
    const unsafe = reason => ({ status: 'unsafe', text: originalText, reason });
    const completed = alignedText => ({
        status: alignedText === originalText ? 'unchanged' : 'aligned',
        text: alignedText,
        reason: null,
    });

    if (!card || card.length === 0) return unchanged();
    // Conditional/alternative LS-DYNA schemas can describe fields that share
    // the same physical columns.  Reconstructing such a line by value order
    // would silently choose one schema interpretation and can duplicate or
    // move engineering values.  Formatting must therefore fail closed before
    // reading or rewriting any field slices.
    if (!cardCellModel.isSafeCardGeometry(card)) {
        return unsafe('unsafe-card-geometry');
    }

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

    // Blank physical lines are meaningful editing structure. Formatting them
    // into 72/80-column space walls makes the line look empty while preventing
    // ordinary newline deletion, so preserve the original bytes exactly.
    if (!processText.trim()) return unchanged();

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

        if (
            options.forceValueOrder === true ||
            isFieldHeaderLine ||
            ((hasInvalidInternalSpace || isOverflowing) && tokens.length >= validPhysValsCount)
        ) {
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

    if (useTokens) {
        if (tokens.length > card.length) return unsafe('field-count');
        if (
            !isFieldHeaderLine &&
            tokens.length < card.length &&
            options.allowAmbiguousTrailing !== true &&
            !canOmitTrailingFields(card, tokens.length)
        ) {
            return unsafe('ambiguous-field-count');
        }
    }

    const values = card.map((_, i) => {
        if (!useTokens) return physVals[i];
        if (i >= tokens.length) return '';
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
    const editIsCurrent = documentEditGuard.createDocumentEditGuard(document);
    if (!await canApplyDocumentEdit(document, editIsCurrent)) return;
    if (!isActiveLsdynaSemanticLocation(
        document,
        { line: lineNum, character: document.lineAt(lineNum).text.length },
        { requireLiveSnapshot: true },
    )) return;
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
    return documentEditGuard.matchesConfiguredReadonlyPattern(document, settingName, vscode);
}

async function isDocumentReadonlyForAutomaticEdit(document) {
    return documentEditGuard.isDocumentReadonlyForAutomaticEdit(document, vscode);
}

async function formatLineIfNeeded(document, lineNum) {
    if (isFormattingLine) return;
    if (lineNum >= document.lineCount) return;
    if (await isDocumentReadonlyForAutomaticEdit(document)) return;
    if (isFormattingLine) return;
    if (document.isClosed || lineNum < 0 || lineNum >= document.lineCount) return;
    if (!isActiveLsdynaSemanticLocation(
        document,
        { line: lineNum, character: document.lineAt(lineNum).text.length },
        { requireLiveSnapshot: true },
    )) return;

    const line = document.lineAt(lineNum);
    const text = line.text;
    const trimmed = text.trimStart();

    // Skip keywords
    if (isKeywordLineText(text)) return;
    if (shouldPreserveTextCardLine(document, lineNum)) return;
    const isCommentLine = trimmed.startsWith('$');
    const isFieldHeaderLine = isFieldHeaderCommentLine(text);
    if (isCommentLine && !isFieldHeaderLine) return;

    const fieldContext = fieldContextForLine(document, lineNum, getFieldData());
    const kwLine = fieldContext.status === 'resolved' ? fieldContext.context.keywordLine : null;

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
        const staleNavigationVersion = nav &&
            nav.uri === documentKey &&
            Number.isInteger(nav.version) &&
            Number.isInteger(document.version) &&
            nav.version !== document.version;
        if (staleNavigationVersion || hasRecentCardCellSelectionGrace(document)) {
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
        isTextCardLine: (document, lineNum) => !!getCardInfoForLine(document, lineNum)?.isTextCard,
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

async function handleTabAlignment(editor, direction = 1, resolvedAmbiguity = null) {
    if (!editor) return;
    const requestedDocument = editor.document;
    clearCardCellTypingSession(editor.document);
    const wasActiveEditor = vscode.window.activeTextEditor === editor;
    let requestedDocumentVersion = editor.document?.version;
    const requestedSelection = editor.selection;
    if (editor.selections && editor.selections.length > 1) {
        return;
    }
    if (!isTabSelectionEligible(editor, requestedSelection)) {
        return direction === 0 ? undefined : executeNativeTab(direction);
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
    if (editor.document !== requestedDocument) return;
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
    const editIsCurrent = documentEditGuard.createDocumentEditGuard(document, editor);
    const lineNum = selection.start.line;
    const col = selection.start.character;

    const line = document.lineAt(lineNum);
    const text = line.text;
    if (getCardInfoForLine(document, lineNum)?.isTextCard) {
        return executeNativeTab(direction);
    }

    const card = getCardFieldsForLine(document, lineNum);
    if (!card || card.length === 0) {
        return executeNativeTab(direction);
    }

    // Skip alignment for title/filename fields (single wide field)
    if (card.length === 1 && card[0].w >= 40) {
        return executeNativeTab(direction);
    }

    const interpretation = analyzeTabLineInterpretation(text, card);
    let chosenCandidate = null;

    if (interpretation.status !== 'intact') {
        if (interpretation.status === 'unsafe') {
            try {
                ensureCardCellEditGuard().clearNav();
                vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);
            } catch (_) {
                /* ignore context failures in tests */
            }
            // Once a line cannot be mapped losslessly, neither alignment nor a
            // native Tab/outdent is safe: both may shift fixed engineering
            // columns.  Consume the key and preserve every source byte.
            vscode.window.setStatusBarMessage(i18n.get('tabMeaningUnsafe'), 2500);
            return;
        }

        // Shift+Tab on a non-grid line remains ordinary outdent; prompting while
        // moving backwards is disproportionately disruptive.
        if (direction === -1) return executeNativeTab(direction);

        if (interpretation.status === 'ambiguous') {
            if (resolvedAmbiguity?.semantic === 'native') {
                return executeNativeTab(direction);
            }
            if (resolvedAmbiguity?.semantic === 'valueOrder') {
                chosenCandidate = resolvedAmbiguity.candidate || null;
            } else {
                const candidate = interpretation.candidates[0];
                return startInlineEditChoiceSession(editor, lineNum, text, [
                    {
                        id: 'keep-original',
                        label: i18n.get('tabMeaningKeepOriginal'),
                        preview: `→ ${fixedCellPreview(text, card, 0, card.length)}`,
                        detail: i18n.get('tabMeaningKeepOriginalDetail'),
                        preselect: true,
                        apply: () => undefined,
                    },
                    {
                        id: 'value-order',
                        label: i18n.get('tabMeaningValueOrder'),
                        preview: `→ ${fixedCellPreview(candidate.text, card, 0, card.length)}`,
                        detail: `${i18n.get('tabMeaningValueOrderDetail')} ${tabMeaningCandidateDetail(candidate, card)}`,
                        apply: () => handleTabAlignment(editor, direction, {
                            semantic: 'valueOrder',
                            candidate,
                        }),
                    },
                ]);
            }
        } else {
            chosenCandidate = interpretation.candidate || null;
        }
        if (!chosenCandidate) return executeNativeTab(direction);
    }

    // 1. Current field: repaired value-order rows follow the token under the
    // invoking caret; intact grids keep physical exclusive-end ownership.
    let currentFieldIndex = chosenCandidate
        ? valueOrderFieldIndexAtCaret(text, col, chosenCandidate.delimiter)
        : (direction === -1
            ? cardCellModel.fieldIndexAt(text, card, col)
            : cardCellModel.fieldIndexForTabNav(text, card, col));
    if (currentFieldIndex < 0) currentFieldIndex = 0;
    currentFieldIndex = Math.min(currentFieldIndex, card.length - 1);

    let targetIndex;
    if (direction === 1) {
        targetIndex = currentFieldIndex + 1;
    } else if (direction === -1) {
        targetIndex = currentFieldIndex - 1;
    } else {
        targetIndex = currentFieldIndex;
    }

    let alignedText = chosenCandidate
        ? chosenCandidate.text
        : cardCellModel.alignLineInPlace(text, card);

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
        if (!await canApplyDocumentEdit(document, editIsCurrent)) return;
        if (wasActiveEditor && vscode.window.activeTextEditor !== editor) return;
        const applied = await editor.edit(editBuilder => {
            const range = new vscode.Range(
                new vscode.Position(lineNum, 0),
                new vscode.Position(lineNum, text.length)
            );
            editBuilder.replace(range, alignedText);
        }, chosenCandidate
            ? { undoStopBefore: true, undoStopAfter: true }
            : { undoStopBefore: false, undoStopAfter: false });
        if (applied === false || document.isClosed || editor.document !== document) return;
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
    const typingDocument = editor?.document;
    const typingSession = typingDocument
        ? cardCellTypingSessions.get(typingDocument)
        : null;
    if (typingSession) {
        const selection = editor.selection;
        const anchor = selection?.anchor || selection?.start;
        const active = selection?.active || selection?.end;
        const exactProgrammaticCaret =
            typingSession.editor === editor &&
            anchor && active &&
            anchor.line === typingSession.lineNum &&
            active.line === typingSession.lineNum &&
            anchor.character === typingSession.caret &&
            active.character === typingSession.caret &&
            (
                !Number.isInteger(typingSession.version) ||
                !Number.isInteger(typingDocument.version) ||
                typingSession.version === typingDocument.version
            );
        if (!exactProgrammaticCaret) clearCardCellTypingSession(typingDocument);
    }
    if (
        inlineEditChoiceSession &&
        inlineEditChoiceSession.editor === editor &&
        !isInlineEditChoiceSessionValid(inlineEditChoiceSession)
    ) {
        clearInlineEditChoiceSession(inlineEditChoiceSession.id);
    }
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
    // Route every recognized fixed-card data line through the command. The
    // handler itself distinguishes intact, repairable, ambiguous, and unsafe
    // rows so it can either navigate, ask, or delegate to native Tab.
    const hasCard = !!(cardFields && cardFields.length > 0) && !isWideField;

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
    if (
        inlineEditChoiceSession &&
        (!editor || inlineEditChoiceSession.editor !== editor)
    ) {
        clearInlineEditChoiceSession(inlineEditChoiceSession.id);
    }
    const previousDoc = lastActiveDoc;
    if (previousDoc && (!editor || editor.document !== previousDoc)) {
        clearCardCellTypingSession(previousDoc);
    }
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
    const editIsCurrent = documentEditGuard.createDocumentEditGuard(document, editor);
    if (!await canApplyDocumentEdit(document, editIsCurrent)) return false;
    const line = document.lineAt(lineNum);
    const oldText = line.text;
    if (newText !== oldText) {
        beginCardCellOwnedEdit(document);
        try {
            const applied = await editor.edit(editBuilder => {
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
            if (!applied) return false;
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
    const editIsCurrent = documentEditGuard.createDocumentEditGuard(document, editor);
    if (!await canApplyDocumentEdit(document, editIsCurrent)) return false;
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
        const applied = await editor.edit(editBuilder => {
            editBuilder.delete(range);
        }, {
            undoStopBefore: undoOpts?.undoStopBefore !== false,
            undoStopAfter: undoOpts?.undoStopAfter !== false,
        });
        if (!applied) return false;
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
    if (editor?.document) clearCardCellTypingSession(editor.document);
    if (
        inlineEditChoiceSession &&
        editor &&
        inlineEditChoiceSession.editor === editor
    ) {
        cancelInlineEditChoiceSession(inlineEditChoiceSession.id);
        return;
    }
    const waitedForPostEdit = editor?.document
        ? await waitForPendingCardCellPostEdit(editor.document)
        : false;
    if (waitedForPostEdit) {
        if (vscode.window.activeTextEditor !== editor || editor.document.isClosed) return;
    }
    if (!editor || !isLsdynaFile(editor.document)) {
        return vscode.commands.executeCommand(direction === 'left' ? 'deleteLeft' : 'deleteRight');
    }
    if (!isActiveLsdynaSemanticLocation(
        editor.document,
        editor.selection.active,
        { requireLiveSnapshot: true },
    )) {
        ensureCardCellEditGuard().clearNav();
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
    if (plan.mergeLeft) {
        const sourceText = editor.document.lineAt(plan.lineNum).text;
        const merge = plan.mergeLeft;
        return startInlineEditChoiceSession(editor, plan.lineNum, sourceText, [
            {
                id: 'keep-separate',
                label: i18n.get('cellMergeKeepSeparate'),
                preview: `→ [${merge.leftValue}][${merge.rightValue}]`,
                detail: i18n.get('cellMergeKeepSeparateDetail'),
                preselect: true,
                apply: () => vscode.commands.executeCommand(
                    'setContext',
                    'lsdyna.cellEditActive',
                    guard.shouldCellEditActive(editor),
                ),
            },
            {
                id: 'merge-left',
                label: i18n.get('cellMergeLeft'),
                preview: `→ [${merge.mergedValue}][∅]`,
                detail: `${merge.leftValue} + ${merge.rightValue} → ${merge.mergedValue} · ${i18n.get('cellMergeLeftDetail')}`,
                apply: async () => {
                    if (
                        editor.document.isClosed ||
                        editor.document.lineAt(plan.lineNum).text !== sourceText
                    ) return;
                    await applyCardCellLineEdit(
                        editor,
                        plan.lineNum,
                        merge.line,
                        merge.caretCol,
                        merge.caretCol,
                        { undoStopBefore: true, undoStopAfter: true },
                    );
                    guard.markAp(
                        editor.document,
                        plan.lineNum,
                        merge.leftFieldIndex,
                        merge.caretCol,
                    );
                    vscode.commands.executeCommand(
                        'setContext',
                        'lsdyna.cellEditActive',
                        guard.shouldCellEditActive(editor),
                    );
                },
            },
        ]);
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
            rememberCardCellTypingSession(state.editor, state.lineNum, state.fieldIndex, plan.caret);
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
    const pendingIndent = editor?.document && autoIndentEditBarriers.get(editor.document);
    if (pendingIndent) {
        const document = editor.document;
        return pendingIndent.then(() => {
            if (vscode.window.activeTextEditor !== editor || editor.document !== document || document.isClosed) return;
            return handleCardCellType(args);
        });
    }
    const document = editor?.document;
    const waitedForPostEdit = document
        ? await waitForPendingCardCellPostEdit(document)
        : false;
    if (waitedForPostEdit && (
        vscode.window.activeTextEditor !== editor ||
        editor.document !== document || document.isClosed
    )) return;
    if (
        inlineEditChoiceSession &&
        editor &&
        inlineEditChoiceSession.editor === editor
    ) {
        if (
            typeof inlineEditChoiceSession.onType === 'function' &&
            text &&
            !text.includes('\n') &&
            !text.includes('\r')
        ) {
            const session = inlineEditChoiceSession;
            return session.onType(text, session);
        }
        cancelInlineEditChoiceSession(inlineEditChoiceSession.id);
    }
    const composition = editor?.document
        ? cardCellCompositions.get(editor.document)
        : null;
    if (editor?.document && (!text || text.includes('\n') || text.includes('\r'))) {
        clearCardCellTypingSession(editor.document);
    }
    if (
        composition ||
        !editor ||
        !isLsdynaFile(editor.document) ||
        !text ||
        text.includes('\n') ||
        text.includes('\r') ||
        getLsdynaConfigurationValue('enableCellEditProtect', true, editor.document.uri) === false
    ) {
        return vscode.commands.executeCommand('default:type', args);
    }
    const guard = ensureCardCellEditGuard();
    const nav = guard.getNav();
    const documentKey = editor.document.uri?.toString?.();
    const navMatchesDocument = !!nav && (!nav.uri || !documentKey || nav.uri === documentKey);
    const selection = editor.selection;
    const selectionStart = selection?.start || selection?.anchor;
    const selectionEnd = selection?.end || selection?.active;
    const navMatchesVersion = navMatchesDocument && (
        !Number.isInteger(nav.version) ||
        !Number.isInteger(editor.document.version) ||
        nav.version === editor.document.version
    );
    const navSelectionIsA = navMatchesVersion && nav.mode === 'A' &&
        selectionStart?.line === nav.line && selectionEnd?.line === nav.line &&
        selectionStart.character === nav.expectedStart &&
        selectionEnd.character === nav.expectedEnd;
    const navContinuesTyping = navMatchesVersion && nav.mode === 'Ap' &&
        selection?.isEmpty && selection.active?.line === nav.line &&
        canContinueCardCellTypingSession(
            editor,
            nav.line,
            nav.fieldIndex,
            selection.active.character,
        );
    if (!navSelectionIsA && !navContinuesTyping) {
        const canStartCellInput = text.trim().length > 0 &&
            !text.startsWith('*') && !text.startsWith('$') &&
            (!editor.selections || editor.selections.length === 1);
        const target = canStartCellInput ? guard.getEmptyCellTypeTarget(
            editor.document,
            editor.selection,
            text,
        ) : null;
        if (!target) {
            clearCardCellTypingSession(editor.document);
            guard.clearNav();
            return vscode.commands.executeCommand('default:type', args);
        }
        if (Number.isInteger(target.ambiguousPreviousFieldIndex)) {
            clearCardCellTypingSession(editor.document);
            guard.clearNav();
            return startEmptyCellBoundaryTypeChoice(editor, target, text, guard);
        }
        guard.markAp(
            editor.document,
            target.lineNum,
            target.fieldIndex,
            target.caretCol,
            editor.selection.isEmpty
                ? undefined
                : {
                    start: editor.selection.start.character,
                    end: editor.selection.end.character,
                },
        );
    }
    if (!isActiveLsdynaSemanticLocation(
        editor.document,
        editor.selection.active,
        { requireLiveSnapshot: true },
    )) {
        guard.clearNav();
        return vscode.commands.executeCommand('default:type', args);
    }
    return handleCardCellTypeWithNavigation(args, text, editor, guard);
}

/**
 * Native paste/cut does not route through the global `type` command. When it
 * exactly replaces a Tab-established fixed-width cell selection, repair the
 * resulting line from the captured pre-edit text. Ambiguous changes only clear
 * navigation state; they are never guessed or rewritten.
 */
async function handleCardCellPostEdit(event) {
    const document = event?.document;
    if (
        inlineEditChoiceSession &&
        inlineEditChoiceSession.document === document &&
        !isInlineEditChoiceSessionValid(inlineEditChoiceSession)
    ) {
        clearInlineEditChoiceSession(inlineEditChoiceSession.id);
    }
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
    if (!isActiveLsdynaSemanticLocation(
        document,
        editor.selection.active,
        { requireLiveSnapshot: true },
    )) {
        guard.clearNav();
        vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);
        return;
    }
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
            const applied = await applyCardCellLineEdit(
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
            if (applied === false) return;
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
            if (!plan.blocked) {
                rememberCardCellTypingSession(editor, plan.lineNum, plan.fieldIndex, plan.caret);
            }
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
    return planLineCommentTogglePure(lineEntries);
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
    const selectionsBefore: any[] = Array.from(editor.selections || []) as any[];
    const capturedVersion = Number.isInteger(document.version) ? document.version : null;
    const capturedUri = document.uri?.toString?.() || document.uri?.fsPath || '';
    const capturedSelections = selectionsBefore.map(selection => ({
        start: { line: selection.start.line, character: selection.start.character },
        end: { line: selection.end.line, character: selection.end.character },
        isEmpty: selection.isEmpty,
    }));
    const sameSelections = () => {
        const current = editor.selections || [];
        if (current.length !== capturedSelections.length) return false;
        return current.every((selection, index) => {
            const expected = capturedSelections[index];
            return selection.start.line === expected.start.line
                && selection.start.character === expected.start.character
                && selection.end.line === expected.end.line
                && selection.end.character === expected.end.character;
        });
    };
    const snapshotIsCurrent = () => {
        const currentUri = document.uri?.toString?.() || document.uri?.fsPath || '';
        return editor.document === document
            && !document.isClosed
            && (capturedVersion === null || document.version === capturedVersion)
            && currentUri === capturedUri
            && sameSelections();
    };
    if (await isDocumentReadonlyForAutomaticEdit(document)) return false;
    if (!snapshotIsCurrent()) return false;

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
                if (seen.size > LINE_COMMENT_TOGGLE_LIMITS.maxSelectedLines) {
                    vscode.window.setStatusBarMessage(i18n.get('commentToggleRejected'), 2200);
                    return false;
                }
            }
        }
    }
    lineNumbers.sort((a, b) => a - b);
    let fallbackReads = 0;
    const lineEntries = lineNumbers.map(line => {
        const text = document.lineAt(line).text;
        let kind;
        if (classifyInlineCommentedKeyword(text)) {
            kind = 'disabled-keyword';
        } else if (classifyOpaqueCommentDirective(text)) {
            kind = 'opaque-control';
        } else {
            const location = getOpaqueCommentLocation(
                document,
                { line, character: text.length },
                {
                    requireLiveSnapshot: true,
                    readLine: index => {
                        fallbackReads++;
                        if (fallbackReads > 4096) throw new Error('fallback-read-limit');
                        return document.lineAt(index).text;
                    },
                },
            );
            if (location.state === 'unknown') kind = 'unknown';
            else if (location.state === 'opaque') kind = 'opaque-body';
            else if (/^\*[A-Za-z0-9_]/.test(text)) kind = 'keyword';
            else if (/^[ \t]*\$#/.test(text)) kind = 'field-header';
            else if (/^[ \t]*$/.test(text)) kind = 'blank';
            else if (text.startsWith('$')) kind = 'line-comment';
            else kind = 'code';
        }
        return { line, text, kind };
    });

    const plan = planLineCommentToggle(lineEntries);
    if (plan.status === 'rejected') {
        vscode.window.setStatusBarMessage(
            plan.reason === 'opaque-state-unknown'
                ? i18n.get('commentToggleOpaqueUnknown')
                : i18n.get('commentToggleRejected'),
            2200,
        );
        return false;
    }
    if (plan.status === 'noop' || plan.edits.length === 0) return;

    if (!snapshotIsCurrent()) return false;

    try {
        const applied = await editor.edit(editBuilder => {
            for (const edit of plan.edits) {
                if (edit.type === 'insert') {
                    editBuilder.insert(new vscode.Position(edit.line, 0), '$');
                } else if (edit.type === 'delete') {
                    editBuilder.delete(new vscode.Range(edit.line, 0, edit.line, 1));
                } else if (edit.type === 'insert-keyword-comment') {
                    editBuilder.insert(new vscode.Position(edit.line, 0), '*COMMENT ');
                } else if (edit.type === 'delete-keyword-comment') {
                    editBuilder.delete(new vscode.Range(
                        edit.line,
                        0,
                        edit.line,
                        edit.endCharacter,
                    ));
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
let largeFileViewerProvider = null;

    let keywordOptionsWebviewProvider = null;
    let refreshKeywordOptionsProductView = () => {};

    await keywordSchema.prepareKeywordSchema();
    // Keep schema installation, provider registration and the native server spawn in separate turns.
    await new Promise(resolve => setTimeout(resolve, 0));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(updateDocumentPresentationAfterChange));


    let includeTreeView;
    let keywordTreeView;
    let entityReferenceProvider = null;
    let entityReferencesWebviewProvider = null;
    let lastEntityReferenceCursorEditor = resolveEntityReferenceCursorEditor();
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
            colorScheme: getLsdynaConfigurationValue('changeMarks.colorScheme', 'adaptive', resource),
            customUnsavedColor: getLsdynaConfigurationValue('changeMarks.customUnsavedColor', DEFAULT_CHANGE_MARKS_CUSTOM_COLORS.unsaved, resource),
            customSavedColor: getLsdynaConfigurationValue('changeMarks.customSavedColor', DEFAULT_CHANGE_MARKS_CUSTOM_COLORS.saved, resource),
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
    const structureCollection = vscode.languages.createDiagnosticCollection('lsdyna-structure');
    const structureDiagnostics = createKeywordStructureDiagnostics({ collection: structureCollection,
        analyze: analyzeKeywordStructureForDocument, describe: keywordStructureDefiniteLabel,
        isSupported: document => isLsdynaFile(document) && isDocumentStillOpenInTextTab(document) });
    keywordStructureDiagnosticsRef = structureDiagnostics;
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs?.(event => {
        const matches = (tabs, document) => (tabs || []).some(tab => {
            const input = tab.input;
            return [input?.uri, input?.resource, input?.modified, input?.original]
                .some(uri => uri?.toString() === document.uri.toString());
        });
        for (const document of vscode.workspace.textDocuments) {
            if (matches(event.closed, document) && !isDocumentStillOpenInTextTab(document)) structureDiagnostics.clear(document);
            if (matches(event.opened, document)) structureDiagnostics.schedule(document);
        }
    }) || { dispose() {} });
    context.subscriptions.push(structureDiagnostics, structureCollection, { dispose() { keywordStructureDiagnosticsRef = null; } });

    function updateDiagnostics(document) {
        structureDiagnostics.schedule(document);
        return updateDocumentDiagnostics(document, diagnostics).catch(error => {
            logDebug(`updateDocumentDiagnostics failed: ${error && error.message ? error.message : error}`);
        });
    }

    // Manual packs are independent of project scans. Keep one runtime-schema
    // repository per configured pack and let the sidebar and main reader share
    // it; a changed manifest automatically invalidates the cache.
    const manualPackManager = new ManualPackManager(context, () => {
        vscode.workspace.textDocuments.forEach(document => structureDiagnostics.schedule(document));
    });
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
        entityReferencesWebviewProvider?.refreshUiLanguage();
        refreshKeywordOptionsProductView();
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
            if (!isLsdynaFile(e.document) || shouldSkipAutomaticDocumentScan(e.document)) return;
            const current = createDocumentReadGuard(e.document);
            void prepareDocumentPresentation(e.document).then(prepared => {
                if (prepared && current()) includePathSuggestTrigger.onDidChangeTextDocument(e);
            }).catch(error => logDebug(`Include suggestion preparation failed: ${error?.message || error}`));
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


context.subscriptions.push(
        vscode.commands.registerCommand(
            'extension.setLsdynaTablePreviewView',
            handleSetTablePreviewViewCommand
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'extension.searchLsdynaReferenceInWorkspace',
            handleWorkspaceReferenceSearchCommand
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.checkKeywordStructure', async (request) => {
            await handleCheckKeywordStructureCommand(request);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'extension.openSemanticEvidence',
            request => handleOpenSemanticEvidenceCommand(context, request),
        )
    );
context.subscriptions.push(
        vscode.commands.registerCommand('extension.addVerifiedConditionalCards', async (request) => {
            await handleAddVerifiedConditionalCardsCommand(request);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.pickOfficialFieldValue', async (request) => {
            await handlePickOfficialFieldValueCommand(context, request);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.rebuildCardComments', async (request) => {
            await handleRebuildCardCommentsCommand(request);
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.insertVerifiedMissingRecords', async (request) => {
            await handleInsertVerifiedMissingRecordsCommand(request);
        })
    );
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'lsdyna' },
            new LsdynaEditChoiceCompletionProvider()
        )
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    const client = await startLanguageServer(context);
    await new Promise(resolve => setTimeout(resolve, 0));
    const indexClient = createIndexClient({ languageClient: client });

let keywordOptionsModel = null;
    const keywordOptionsPinned = true;
    let keywordManagerScope = 'file';
    let keywordManagerScopeStatus = 'ready';
    let keywordManagerScopeMessage = '';
    let keywordManagerProjectInstanceCache = [];
    let keywordManagerScopeGeneration = 0;
    let keywordOptionsRefreshGeneration = 0;
    let keywordManagerDirectoryTask = null;
    const completeKeywordManagerDirectory = (document, blockIndex) => {
        const version = document.version, epoch = activeProjectCacheEpoch;
        const previous = keywordManagerDirectoryTask;
        if (previous?.document === document && previous.version === version &&
            previous.blockIndex === blockIndex && previous.epoch === epoch) return;
        const task = { document, version, blockIndex, epoch };
        keywordManagerDirectoryTask = task;
        const current = () => keywordManagerDirectoryTask === task && !document.isClosed &&
            document.version === version && activeProjectCacheEpoch === epoch &&
            keywordOptionsWebviewProvider.isOpen() && keywordOptionsModel?.uri === documentUriIdentity(document);
        void (async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (!current()) return;
            try {
                if (await prepareKeywordManagerInstances(document, blockIndex, current) && current() &&
                    completeKeywordManagerInstances(keywordOptionsModel, document, blockIndex)) {
                    keywordOptionsWebviewProvider.publishInstances(keywordOptionsModel.managerInstances, 'ready');
                }
            } catch (error) {
                if (current()) {
                    keywordOptionsModel.directoryStatus = 'error';
                    keywordOptionsWebviewProvider.publishInstances(keywordOptionsModel.managerInstances, 'error');
                    console.warn(`[lsdyna] Keyword Manager directory failed: ${String(error)}`);
                }
            } finally {
                if (keywordManagerDirectoryTask === task) keywordManagerDirectoryTask = null;
            }
        })();
    };
    const refreshKeywordOptionsView = async (editor = vscode.window.activeTextEditor, line = null, staged: any = {}) => {
        const generation = ++keywordOptionsRefreshGeneration;
        if (!editor || !isLsdynaFile(editor.document)) {
            if (!keywordOptionsPinned) {
                keywordOptionsModel = null;
                keywordOptionsWebviewProvider?.publish(keywordOptionEmptyViewState(false));
            }
            return null;
        }
        const document = editor.document, version = document.version, epoch = activeProjectCacheEpoch;
        const requestedLine = Number.isInteger(line) ? line : editor.selection?.active?.line ?? 0;
        const blockIndex = staged.blockIndex !== undefined ? staged.blockIndex : readyCardEditBlockIndex(document);
        const isCurrent = () => generation === keywordOptionsRefreshGeneration && !document.isClosed &&
            document.version === version && editor.document === document && epoch === activeProjectCacheEpoch;
        const scope = staged.scope || keywordManagerScope;
        {
            if (scope === 'project') {
                if (!await prepareKeywordManagerInstances(document, blockIndex, isCurrent)) return null;
            } else {
                await require('./core/keywordSchema').prepareKeywordSchema();
                if (!isCurrent()) return null;
                const keywordLine = findKeywordLineForLine(document, requestedLine);
                if (Number.isInteger(keywordLine)) {
                    const keyword = keywordSpellingFromLine(document.lineAt(keywordLine).text);
                    try { await getCatalogInputFormCatalogV4({ allowUnaudited: isKeywordManagerUnauditedCatalogAllowed() })
                        .prepareKeyword(require("./core/semantics/catalogNativeFileLayout").nativeFileCatalogKeyword(keyword)); }
                    catch { /* Model construction reports the catalog error without authorizing writes. */ }
                }
            }
            if (!isCurrent()) return null;
        }
        const model = buildKeywordOptionViewModel(editor, requestedLine, {
            ...staged,
            blockIndex,
            scope,
            deferInstances: scope === 'file',
            scopeStatus: staged.scopeStatus || keywordManagerScopeStatus,
            scopeMessage: staged.scopeMessage ?? keywordManagerScopeMessage,
            managerInstances: staged.managerInstances || (keywordManagerScope === 'project'
                ? keywordManagerProjectInstanceCache : undefined),
            draftControlState: staged.draftControlState !== undefined
                ? staged.draftControlState : keywordOptionsModel?.draftControlState,
            provisional: staged.provisional !== false,
        });
        if (!model) return null;
        model.pinned = true;
        keywordOptionsModel = model;
        keywordOptionsWebviewProvider?.publish(buildKeywordOptionsViewState(model));
        if (model.directoryStatus === 'loading') completeKeywordManagerDirectory(document, blockIndex);
        return model;
    };
    const refreshSelectedKeywordOptions = async () => {
        const model = keywordOptionsModel;
        const editor = keywordOptionsEditorForModel(model);
        if (!model || !editor) return null;
        const line = keywordManagerRefreshLine(model, editor.document);
        if (line === null) {
            vscode.window.showInformationMessage(i18n.get('keywordManagerRelocateSource'));
            return null;
        }
        if (model.stale && keywordManagerScope === 'project') {
            keywordManagerScope = 'file';
            keywordManagerProjectInstanceCache = [];
            keywordManagerScopeStatus = 'ready';
            keywordManagerScopeMessage = '';
        }
        return await refreshKeywordOptionsView(editor, line, {
            fieldDrafts: {}, recordDrafts: {}, draftControlState: {},
            selectedFieldId: null, selectedFormRuleId: null, provisional: true,
        });
    };
    const keywordOptionsModelAdapter = {
        getModel: () => keywordOptionsModel,
        refreshModel: async (editor, model) => await refreshKeywordOptionsView(editor, model.keywordLine, {
            targetKeyword: model.targetKeyword,
            selection: model.selection,
            targetPostCount: model.targetPostCount,
            fieldDrafts: model.fieldDrafts,
            recordDrafts: model.recordDrafts,
            selectedFormRuleId: model.selectedFormRuleId,
            dynamicCardsSelected: model.dynamicCardsSelected,
            selectedFieldId: model.selectedFieldId,
            pinned: keywordOptionsPinned,
            provisional: true,
        }),
        markStale: (uri = null) => {
            if (!keywordOptionsModel || (uri && keywordOptionsModel.uri !== uri)) return false;
            keywordOptionsModel.stale = true;
            keywordOptionsWebviewProvider?.publish(buildKeywordOptionsViewState(keywordOptionsModel));
            return true;
        },
    };
    const validKeywordOptionsModel = async () => {
        const editor = keywordOptionsEditorForModel(keywordOptionsModel);
        if (!keywordOptionsModel || !editor) return null;
        if (keywordOptionsModel.stale || editor.document.version !== keywordOptionsModel.documentVersion) {
            keywordOptionsModelAdapter.markStale();
            return null;
        }
        return editor;
    };
    const restoreKeywordManagerFileScope = async (status = 'ready', message = '') => {
        keywordManagerScope = 'file';
        keywordManagerScopeStatus = status;
        keywordManagerScopeMessage = message;
        keywordManagerProjectInstanceCache = [];
        const model = keywordOptionsModel;
        const editor = keywordOptionsEditorForModel(model);
        if (!model || !editor) return false;
        return !!await refreshKeywordOptionsView(editor, model.keywordLine, {
            targetKeyword: model.targetKeyword,
            selection: model.selection,
            targetPostCount: model.targetPostCount,
            fieldDrafts: model.fieldDrafts,
            recordDrafts: model.recordDrafts,
            selectedFormRuleId: model.selectedFormRuleId,
            dynamicCardsSelected: model.dynamicCardsSelected,
            selectedFieldId: model.selectedFieldId,
            pinned: keywordOptionsPinned,
            scope: 'file',
            scopeStatus: status,
            scopeMessage: message,
            provisional: true,
        });
    };
    const confirmKeywordManagerTransition = async () => {
        const model = keywordOptionsModel;
        if (!keywordManagerHasStaging(model)) return 'proceed';
        const stagedCount = Math.max(1, Object.keys(model.fieldDrafts || {}).length +
            Object.keys(model.draftControlState || {}).length + (model.dynamicCardsSelected ? 1 : 0));
        const applyLabel = i18n.get('keywordOptionsApply');
        const discardLabel = i18n.get('keywordManagerDiscardDraftConfirm');
        const choice = await vscode.window.showWarningMessage(
            i18n.get('keywordManagerDiscardDraftWarning', stagedCount),
            { modal: true },
            applyLabel,
            discardLabel,
        );
        if (choice === discardLabel) return 'discard';
        if (choice !== applyLabel) return null;
        const editor = keywordOptionsEditorForModel(model);
        return editor && await applyKeywordOptionViewModel(keywordOptionsModelAdapter, editor)
            ? 'proceed' : null;
    };
    keywordOptionsWebviewProvider = new KeywordOptionsWebviewProvider(context.extensionPath, {
        selectDimension: async (dimensionId, values) => {
            const editor = await validKeywordOptionsModel();
            if (!editor) return false;
            return !!await refreshKeywordOptionsView(editor, keywordOptionsModel.keywordLine, {
                selection: { ...keywordOptionsModel.selection, [dimensionId]: values },
                targetPostCount: keywordOptionsModel.targetPostCount,
                fieldDrafts: keywordOptionsModel.fieldDrafts,
                recordDrafts: keywordOptionsModel.recordDrafts,
                selectedFormRuleId: keywordOptionsModel.selectedFormRuleId,
                dynamicCardsSelected: keywordOptionsModel.dynamicCardsSelected,
                selectedFieldId: keywordOptionsModel.selectedFieldId,
                pinned: keywordOptionsPinned,
                provisional: true,
            });
        },
        selectTarget: async targetKeyword => {
            const editor = await validKeywordOptionsModel();
            if (!editor) return false;
            return !!await refreshKeywordOptionsView(editor, keywordOptionsModel.keywordLine, {
                targetKeyword,
                targetPostCount: keywordOptionsModel.targetPostCount,
                fieldDrafts: keywordOptionsModel.fieldDrafts,
                recordDrafts: keywordOptionsModel.recordDrafts,
                selectedFormRuleId: keywordOptionsModel.selectedFormRuleId,
                dynamicCardsSelected: keywordOptionsModel.dynamicCardsSelected,
                selectedFieldId: keywordOptionsModel.selectedFieldId,
                pinned: keywordOptionsPinned,
                provisional: true,
            });
        },
        selectPostCount: async targetPostCount => {
            const editor = await validKeywordOptionsModel();
            const choice = keywordOptionsModel?.choices?.find(candidate =>
                candidate.kind === 'post-range' && candidate.targetPostCount === targetPostCount);
            if (!editor || !choice?.enabled) return false;
            return !!await refreshKeywordOptionsView(editor, keywordOptionsModel.keywordLine, {
                targetKeyword: keywordOptionsModel.targetKeyword,
                selection: keywordOptionsModel.selection,
                targetPostCount,
                fieldDrafts: keywordOptionsModel.fieldDrafts,
                recordDrafts: keywordOptionsModel.recordDrafts,
                selectedFormRuleId: keywordOptionsModel.selectedFormRuleId,
                dynamicCardsSelected: keywordOptionsModel.dynamicCardsSelected,
                selectedFieldId: keywordOptionsModel.selectedFieldId,
                pinned: keywordOptionsPinned,
                provisional: true,
            });
        },
        updateControl: async (controlId, value) => {
            const editor = await validKeywordOptionsModel();
            const control = keywordOptionsModel?.controls?.find(candidate => candidate.controlId === controlId);
            const validBoolean = control?.kind === 'boolean' && typeof value === 'boolean';
            const validChoice = control?.kind !== 'boolean' &&
                control?.kind !== 'field' && typeof value === 'string' && (value === '' ||
                control?.choices?.some(candidate => candidate.value === value && candidate.enabled));
            if (!editor || !control || !control.enabled || (!validBoolean && !validChoice)) {
                return false;
            }
            const draftControlState = { ...(keywordOptionsModel.draftControlState || {}) };
            if (String(value) === String(keywordOptionsModel.currentControlState?.[controlId] ?? '')) {
                delete draftControlState[controlId];
            } else {
                draftControlState[controlId] = value;
            }
            return !!await refreshKeywordOptionsView(editor, keywordOptionsModel.keywordLine, {
                targetKeyword: keywordOptionsModel.targetKeyword,
                selection: keywordOptionsModel.selection,
                targetPostCount: typeof value === 'string'
                    ? control.targetPostCountByValue?.[value] ?? keywordOptionsModel.targetPostCount
                    : keywordOptionsModel.targetPostCount,
                fieldDrafts: keywordOptionsModel.fieldDrafts,
                recordDrafts: keywordOptionsModel.recordDrafts,
                selectedFormRuleId: keywordOptionsModel.selectedFormRuleId,
                draftControlState,
                selectedFieldId: keywordOptionsModel.selectedFieldId,
                pinned: keywordOptionsPinned,
                provisional: true,
            });
        },
        selectForm: async ruleId => {
            const editor = await validKeywordOptionsModel();
            if (!editor) return false;
            return !!await refreshKeywordOptionsView(editor, keywordOptionsModel.keywordLine, {
                targetKeyword: keywordOptionsModel.targetKeyword,
                selection: keywordOptionsModel.selection,
                targetPostCount: keywordOptionsModel.targetPostCount,
                fieldDrafts: keywordOptionsModel.fieldDrafts,
                recordDrafts: keywordOptionsModel.recordDrafts,
                draftControlState: keywordOptionsModel.draftControlState,
                dynamicCardsSelected: keywordOptionsModel.dynamicCardsSelected,
                selectedFieldId: keywordOptionsModel.selectedFieldId,
                selectedFormRuleId: ruleId,
                pinned: keywordOptionsPinned,
                provisional: true,
            });
        },
        selectInstance: async instanceId => {
            let model = keywordOptionsModel;
            let editor = keywordOptionsEditorForModel(model);
            let instance = model?.managerInstances?.find(candidate => candidate.instanceId === instanceId);
            if (!model || !editor || !instance || model.stale) return false;
            if (model.managerScope === 'project' && model.managerScopeStatus !== 'ready') return false;
            const line = Number(instance.line);
            if (!Number.isInteger(line) || line < 0) return false;
            if (instance.instanceId !== model.selectedInstanceId) {
                const transition = await confirmKeywordManagerTransition();
                if (!transition) return false;
                model = keywordOptionsModel;
                editor = keywordOptionsEditorForModel(model);
                instance = model?.managerInstances?.find(candidate => candidate.instanceId === instanceId) || instance;
                if (!model || !editor) return false;
            }
            const targetEditor = await openKeywordManagerInstanceEditor(instance, editor);
            if (!targetEditor) return false;
            const refreshed = await refreshKeywordOptionsView(targetEditor, line, {
                fieldDrafts: {},
                dynamicCardsSelected: false,
                selectedFieldId: null,
                pinned: keywordOptionsPinned,
                scope: keywordManagerScope,
                managerInstances: keywordManagerScope === 'project' ? keywordManagerProjectInstanceCache : undefined,
                provisional: true,
            });
            if (refreshed && typeof targetEditor.revealRange === 'function') {
                const range = new vscode.Range(line, 0, line, 0);
                targetEditor.selection = new vscode.Selection(range.start, range.start);
                targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
            return !!refreshed;
        },
        selectField: request => keywordManagerReadFieldHelp(
            keywordOptionsModel, keywordOptionsEditorForModel(keywordOptionsModel), request),
        updateField: async (fieldId, value) => {
            const editor = await validKeywordOptionsModel();
            const field = keywordOptionsModel?.managerCards?.flatMap(card => card.fields)
                .find(candidate => candidate.fieldId === fieldId);
            if (!editor || !field?.editable || typeof value !== 'string') return false;
            if (keywordOptionsModel.helpContext?.branchEvidence === 'record-selection' ||
                keywordOptionsModel.targetLayout?.records?.some(record =>
                    record.sharedByteEditing === 'native-shared-bytes-v1' &&
                    record.fields?.some(candidate => candidate.fieldMigrationId === fieldId))) {
                const staged = keywordManagerEditField(keywordOptionsModel, fieldId, value);
                if (!staged) return false;
                return !!await refreshKeywordOptionsView(editor, keywordOptionsModel.keywordLine, {
                    targetKeyword: keywordOptionsModel.targetKeyword,
                    selection: keywordOptionsModel.selection,
                    targetPostCount: keywordOptionsModel.targetPostCount,
                    ...staged,
                    selectedFormRuleId: keywordOptionsModel.selectedFormRuleId,
                    selectedFieldId: fieldId,
                    pinned: keywordOptionsPinned,
                    provisional: true,
                });
            }
            const fieldDrafts = { ...keywordOptionsModel.fieldDrafts };
            if (value.trim() === String(field.value || '').trim()) delete fieldDrafts[fieldId];
            else fieldDrafts[fieldId] = value;
            return !!await refreshKeywordOptionsView(editor, keywordOptionsModel.keywordLine, {
                targetKeyword: keywordOptionsModel.targetKeyword,
                selection: keywordOptionsModel.selection,
                targetPostCount: keywordOptionsModel.targetPostCount,
                fieldDrafts,
                recordDrafts: keywordOptionsModel.recordDrafts,
                selectedFormRuleId: keywordOptionsModel.selectedFormRuleId,
                dynamicCardsSelected: keywordOptionsModel.dynamicCardsSelected,
                selectedFieldId: fieldId,
                pinned: keywordOptionsPinned,
                provisional: true,
            });
        },
        selectScope: async scope => {
            const editor = await validKeywordOptionsModel();
            if (!editor || (scope !== 'file' && scope !== 'project')) return false;
            const scopeGeneration = ++keywordManagerScopeGeneration;
            const scopeUri = keywordOptionsModel.uri;
            if (scope === 'file') return await restoreKeywordManagerFileScope();
            if (!keywordIndexProvider || typeof keywordIndexProvider.scan !== 'function') return false;
            keywordManagerScope = 'project';
            keywordManagerScopeStatus = 'loading';
            keywordManagerScopeMessage = i18n.get('keywordManagerScopeLoading');
            await refreshKeywordOptionsView(editor, keywordOptionsModel.keywordLine, {
                targetKeyword: keywordOptionsModel.targetKeyword,
                selection: keywordOptionsModel.selection,
                targetPostCount: keywordOptionsModel.targetPostCount,
                fieldDrafts: keywordOptionsModel.fieldDrafts,
                recordDrafts: keywordOptionsModel.recordDrafts,
                selectedFormRuleId: keywordOptionsModel.selectedFormRuleId,
                dynamicCardsSelected: keywordOptionsModel.dynamicCardsSelected,
                selectedFieldId: keywordOptionsModel.selectedFieldId,
                pinned: keywordOptionsPinned,
                scope: 'project',
                scopeStatus: 'loading',
                provisional: true,
            });
            try {
                const completed = await keywordIndexProvider.scan({
                    onPartial: async ({ filesScanned }) => {
                        if (scopeGeneration !== keywordManagerScopeGeneration || keywordManagerScope !== 'project' ||
                            keywordOptionsModel?.uri !== scopeUri) return;
                        const currentEditor = keywordOptionsEditorForModel(keywordOptionsModel);
                        if (!currentEditor) return;
                        keywordManagerScopeStatus = 'partial';
                        keywordManagerScopeMessage = i18n.get('scannedFilesProgress', filesScanned);
                        await refreshKeywordOptionsView(currentEditor, keywordOptionsModel.keywordLine, {
                            targetKeyword: keywordOptionsModel.targetKeyword,
                            selection: keywordOptionsModel.selection,
                            targetPostCount: keywordOptionsModel.targetPostCount,
                            fieldDrafts: keywordOptionsModel.fieldDrafts,
                            recordDrafts: keywordOptionsModel.recordDrafts,
                            selectedFormRuleId: keywordOptionsModel.selectedFormRuleId,
                            dynamicCardsSelected: keywordOptionsModel.dynamicCardsSelected,
                            selectedFieldId: keywordOptionsModel.selectedFieldId,
                            pinned: keywordOptionsPinned,
                            scope: 'project',
                            scopeStatus: 'partial',
                            scopeMessage: keywordManagerScopeMessage,
                            managerInstances: [],
                            provisional: true,
                        });
                    },
                });
                if (scopeGeneration !== keywordManagerScopeGeneration || keywordManagerScope !== 'project') return false;
                if (keywordOptionsModel?.uri !== scopeUri) {
                    await restoreKeywordManagerFileScope();
                    return false;
                }
                if (completed !== true) {
                    await restoreKeywordManagerFileScope();
                    return false;
                }
            } catch (_error) {
                if (scopeGeneration !== keywordManagerScopeGeneration || keywordManagerScope !== 'project') return false;
                await restoreKeywordManagerFileScope('unavailable', i18n.get('keywordManagerScopeUnavailable'));
                return false;
            }
            if (keywordIndexProvider.mode !== 'recursive') {
                await restoreKeywordManagerFileScope();
                return false;
            }
            const currentEditor = keywordOptionsEditorForModel(keywordOptionsModel);
            if (!currentEditor) return false;
            keywordManagerProjectInstanceCache = keywordManagerProjectInstances(
                keywordIndexProvider.listSearchEntries(),
                currentEditor.document,
                keywordOptionsModel.keywordLine,
            );
            keywordManagerScopeStatus = 'ready';
            keywordManagerScopeMessage = '';
            return !!await refreshKeywordOptionsView(currentEditor, keywordOptionsModel.keywordLine, {
                targetKeyword: keywordOptionsModel.targetKeyword,
                selection: keywordOptionsModel.selection,
                targetPostCount: keywordOptionsModel.targetPostCount,
                fieldDrafts: keywordOptionsModel.fieldDrafts,
                recordDrafts: keywordOptionsModel.recordDrafts,
                selectedFormRuleId: keywordOptionsModel.selectedFormRuleId,
                dynamicCardsSelected: keywordOptionsModel.dynamicCardsSelected,
                selectedFieldId: keywordOptionsModel.selectedFieldId,
                pinned: keywordOptionsPinned,
                scope: 'project',
                managerInstances: keywordManagerProjectInstanceCache,
                provisional: true,
            });
        },
        locateSource: async () => {
            const model = keywordOptionsModel;
            const editor = keywordOptionsEditorForModel(model);
            if (!model || !editor) return false;
            const line = keywordManagerRefreshLine(model, editor.document);
            if (line === null) {
                vscode.window.showInformationMessage(i18n.get('keywordManagerRelocateSource'));
                return false;
            }
            if (!model.stale) return locateKeywordManagerSource(model, editor);
            const source = await vscode.window.showTextDocument(editor.document, { preserveFocus: false });
            source.selection = new vscode.Selection(line, 0, line, 0);
            source.revealRange(new vscode.Range(line, 0, line, 0));
            return true;
        },
        openManual: async (conditionId, evidenceId) => {
            const editor = await validKeywordOptionsModel();
            if (!editor) return false;
            if (conditionId !== undefined || evidenceId !== undefined) {
                const group = keywordOptionsModel.manualConditions?.find(item => item.id === conditionId);
                const evidence = group?.evidence.find(item => item.evidenceId === evidenceId);
                if (!evidence) return false;
                const result = await handleOpenSemanticEvidenceCommand(context, {
                    keyword: keywordOptionsModel.manualConditionKeyword, ruleId: evidence.ruleId, evidenceId: evidence.evidenceId });
                return result?.status === 'resolved';
            }
            return openKeywordManagerManual(keywordOptionsModel);
        },
        apply: async () => {
            const editor = await validKeywordOptionsModel();
            if (!editor) return false;
            const keywordLine = keywordOptionsModel.keywordLine;
            if (!await applyKeywordOptionViewModel(keywordOptionsModelAdapter, editor)) return false;
            return !!await refreshKeywordOptionsView(editor, keywordLine, {
                fieldDrafts: {},
                draftControlState: {},
                dynamicCardsSelected: false,
                selectedFieldId: null,
                pinned: keywordOptionsPinned,
                provisional: true,
            });
        },
        reset: async () => !!await refreshSelectedKeywordOptions(),
        togglePin: () => {
            return true;
        },
        panelDisposed: () => { keywordOptionsRefreshGeneration++; keywordManagerDirectoryTask = null; },
    }, keywordOptionEmptyViewState(false));
    context.subscriptions.push(keywordOptionsWebviewProvider);
    refreshKeywordOptionsProductView = () => {
        if (keywordOptionsModel) keywordOptionsWebviewProvider.publish(buildKeywordOptionsViewState(keywordOptionsModel));
        else keywordOptionsWebviewProvider.publish(keywordOptionEmptyViewState(keywordOptionsPinned));
    };
    keywordOptionsViewControllerRef = {
        open: async (editor = vscode.window.activeTextEditor, requestedLine = null) => {
            const requested = Number.isInteger(requestedLine)
                ? requestedLine : editor?.selection?.active?.line ?? 0;
            const nextKeywordLine = editor && isKeywordLineText(editor.document.lineAt(requested).text)
                ? requested : editor ? findKeywordLineForLine(editor.document, requested) : null;
            const sameDraftBlock = keywordManagerHasStaging(keywordOptionsModel) && editor &&
                documentUriIdentity(editor.document) === keywordOptionsModel.uri &&
                nextKeywordLine === keywordOptionsModel.keywordLine &&
                keywordOptionsModel.session?.blockSha256 === keywordOptionBlockSha256(
                    editor.document, keywordOptionsModel.keywordLine, keywordOptionsModel.blockEnd,
                );
            if (sameDraftBlock) {
                const resumeDirectory = keywordOptionsModel.managerScope === 'file' && keywordOptionsModel.directoryStatus !== 'ready';
                if (resumeDirectory) keywordOptionsModel.directoryStatus = 'loading';
                keywordOptionsWebviewProvider.publish(buildKeywordOptionsViewState(keywordOptionsModel));
                keywordOptionsWebviewProvider.showPanel(i18n.get('keywordManagerTitle'));
                if (resumeDirectory) completeKeywordManagerDirectory(editor.document, readyCardEditBlockIndex(editor.document));
                return keywordOptionsModel;
            }
            if (keywordManagerHasStaging(keywordOptionsModel) && !await confirmKeywordManagerTransition()) return null;
            keywordOptionsWebviewProvider.publish({ ...keywordOptionEmptyViewState(keywordOptionsPinned), status: 'loading' });
            const openingGeneration = keywordOptionsRefreshGeneration + 1;
            try {
                keywordOptionsWebviewProvider.showPanel(i18n.get('keywordManagerTitle'));
                const model = await refreshKeywordOptionsView(editor, requestedLine, { pinned: keywordOptionsPinned });
                if (!model && openingGeneration === keywordOptionsRefreshGeneration) {
                    keywordOptionsWebviewProvider.publish(keywordOptionEmptyViewState(keywordOptionsPinned));
                    vscode.window.showInformationMessage(i18n.get('noKeywordAtCursor'));
                }
                return model;
            } catch (error) {
                console.warn(`[lsdyna] Keyword Manager panel unavailable: ${String(error)}`);
                if (openingGeneration === keywordOptionsRefreshGeneration) keywordOptionsWebviewProvider.publish({
                    ...keywordOptionEmptyViewState(keywordOptionsPinned), status: 'error',
                    message: `${i18n.get('keywordManagerTitle')}: ${String(error)}`,
                });
                return null;
            }
        },
    };
    context.subscriptions.push({ dispose: () => {
        keywordOptionsViewControllerRef = null;
    } });
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.keywordOptions.stage', async choiceId => {
            const model = keywordOptionsModel;
            const editor = vscode.window.activeTextEditor;
            if (!model || !editor || model.stale || documentUriIdentity(editor.document) !== model.uri ||
                editor.document.version !== model.documentVersion) {
                keywordOptionsModelAdapter.markStale();
                return null;
            }
            const choice = model.choices.find(candidate => candidate.id === choiceId);
            if (!choice?.enabled) return null;
            const staged = {
                targetKeyword: choice.kind === 'spelling' ? choice.targetKeyword : model.targetKeyword,
                targetPostCount: choice.kind === 'post-range' ? choice.targetPostCount : model.targetPostCount,
                selection: choice.kind === 'spelling' ? undefined : model.selection,
                fieldDrafts: model.fieldDrafts,
                dynamicCardsSelected: model.dynamicCardsSelected,
                selectedFieldId: model.selectedFieldId,
                pinned: keywordOptionsPinned,
                provisional: model.provisional === true,
            };
            return await refreshKeywordOptionsView(editor, model.keywordLine, staged);
        }),
        vscode.commands.registerCommand('extension.keywordOptions.apply', async () => {
            const editor = await validKeywordOptionsModel();
            return editor ? applyKeywordOptionViewModel(keywordOptionsModelAdapter, editor) : false;
        }),
        vscode.commands.registerCommand('extension.keywordOptions.reset', refreshSelectedKeywordOptions),
        vscode.commands.registerCommand('extension.keywordOptions.refresh', async () => {
            if (keywordManagerHasStaging(keywordOptionsModel) && !await confirmKeywordManagerTransition()) return null;
            return await refreshSelectedKeywordOptions();
        }),
        vscode.commands.registerCommand('extension.keywordOptions.togglePin', () => {
            return true;
        }),
        vscode.commands.registerCommand('extension.keywordOptions.openEvidence', () => {
            const model = keywordOptionsModel;
            return model ? vscode.commands.executeCommand('extension.manual.pickPackChapter', model.targetKeyword, 'reader') : null;
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            const model = keywordOptionsModel;
            if (!model || documentUriIdentity(event.document) !== model.uri || !event.contentChanges.length) return;
            keywordOptionsRefreshGeneration++;
            keywordManagerDirectoryTask = null;
            trackKeywordManagerSourceChange(model, event);
            if (!model.stale) keywordOptionsModelAdapter.markStale(model.uri);
        }),
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    entityReferenceProvider = new LsdynaEntityReferenceProvider({
        workspaceState: context.workspaceState,
    });
    context.subscriptions.push(entityReferenceProvider);
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
    // Read through the existing loader without retaining an oversized project or
    // publishing unrelated UI updates on every Hover request.
    referenceSnapshotLoader = originalLoadProjectSnapshot;
    context.subscriptions.push({ dispose() { referenceSnapshotLoader = null; } });
    indexClient.loadProjectSnapshot = async (rootFile, options: any = {}, onProgress = null, cancellationToken = null) => {
        const requestEpoch = activeProjectCacheEpoch;
        const snapshot = await originalLoadProjectSnapshot(rootFile, options, onProgress, cancellationToken);
        if (snapshot?.scope === 'single-file' || options?.singleFileOnly === true) return snapshot;
        if (requestEpoch !== activeProjectCacheEpoch) return snapshot;
        entityReferenceProvider.markStaleForRoot(snapshot.rootFile);
        cacheReferenceIndexFromSnapshot(snapshot);
        refreshMainDeckContextUi();
        projectDiagnosticStore.publish(snapshot.rootFile, collectProjectDiagnostics(snapshot));
        return snapshot;
    };
    const originalInvalidate = indexClient.invalidate.bind(indexClient);
    indexClient.invalidate = async (rootFile) => {
        clearEffectiveSearchPathsForRoot(rootFile);
        entityReferenceProvider.markStaleForRoot(rootFile);
        if (!fs.existsSync(rootFile)) {
            clearReferenceIndexForRoot(rootFile);
            projectDiagnosticStore.clear(rootFile);
            refreshMainDeckContextUi();
        }
        return originalInvalidate(rootFile);
    };
    const entityReferenceRefreshState = { revision: 0 };
    const refreshStoredObjectReference = (target, options: any = {}) =>
        refreshStoredEntityReferenceQuery(
            indexClient,
            entityReferenceProvider,
            entityReferenceRefreshState,
            target,
            options,
    );
    const refreshEntityReferenceScopeContext = () => {
        if (!entityReferencesWebviewProvider) return;
        const filePath = validEntityQueryFilePath(getActiveUri()?.fsPath);
        const contextState = filePath ? getMainDeckContextForDocumentPath(filePath) : null;
        entityReferencesWebviewProvider.setScopeContext({
            filePath: filePath || undefined,
            projectRoot: contextState?.state !== 'ambiguous' && contextState?.project
                ? contextState.rootFile
                : undefined,
        });
    };
    const scopeIdentityForPreference = preference => {
        const filePath = validEntityQueryFilePath(getActiveUri()?.fsPath);
        if (preference === 'file') {
            return filePath ? { kind: 'single-file', filePath } : null;
        }
        if (preference === 'project') {
            const contextState = filePath ? getMainDeckContextForDocumentPath(filePath) : null;
            return contextState?.state !== 'ambiguous' && contextState?.project
                ? { kind: 'project', rootFile: contextState.rootFile }
                : null;
        }
        return undefined;
    };
    let manualObjectReferenceQueries = 0;
    const runObjectReferenceQuery = async (target, scopePreference = 'auto', options: any = {}) => {
        if (scopePreference === 'auto') scopePreference = entityReferencesWebviewProvider?.getScopePreference() === 'project' ? 'project' : 'file';
        if (!options.automatic) {
            stopObjectReferenceFollow();
            lastObjectFollowKey = '';
            objectReferenceNavigation = null;
        }
        const normalized = target?.targetKind && normalizeIndexedEntityId(target?.id)
            ? { ...target, id: normalizeIndexedEntityId(target.id) }
            : null;
        if (!normalized) {
            entityReferencesWebviewProvider?.setMessage(i18n.get('entityReferencesCursorUnavailable'));
            entityReferencesWebviewProvider?.focusForm();
            return null;
        }
        const scopeIdentity = scopeIdentityForPreference(scopePreference);
        if ((scopePreference === 'file' || scopePreference === 'project') && !scopeIdentity) {
            entityReferencesWebviewProvider?.setMessage(i18n.get(
                scopePreference === 'project' ? 'entityIdQuerySourceInactive' : 'entityIdQuerySourceMissing',
            ));
            return null;
        }
        entityReferencesWebviewProvider?.setInput(
            normalized.targetKind,
            normalized.id,
            scopePreference,
        );
        refreshEntityReferenceScopeContext();
        const request = beginEntityReferenceRefresh(entityReferenceRefreshState);
        if (!options.automatic) manualObjectReferenceQueries++;
        return handleIndexedEntityIdQueryCommand(indexClient, normalized, {
            entityReferenceProvider,
            isCurrentRequest: () => request.isCurrent() && (options.isCurrent?.() ?? true),
            presentResult: false,
            silentStatus: true,
            preserveResultsWhileLoading: options.automatic === true,
            ...(options.automatic ? { runWithProgress: operation => operation(null, options.cancellationToken) } : {}),
            ...(scopeIdentity ? { scopeIdentity } : {}),
        }).finally(() => { if (!options.automatic) manualObjectReferenceQueries--; });
    };
    const offerActiveLargeFile = () => {
        const uri = activeUnsynchronizedLargeFileUri();
        if (!uri) {
            entityReferencesWebviewProvider?.setLargeFileOffer();
            return false;
        }
        entityReferencesWebviewProvider?.setMessage('');
        entityReferencesWebviewProvider?.setLargeFileOffer(
            uri,
            i18n.get('entityReferencesLargeFileReason'),
        );
        entityReferencesWebviewProvider?.focusForm();
        return true;
    };
    const inferAndQueryObjectReference = async () => {
        stopObjectReferenceFollow();
        manualObjectReferenceQueries++;
        try { await prepareReferenceDirectory(); }
        finally { manualObjectReferenceQueries--; }
        const largeFileUri = activeLargeFileViewerUri();
        const largeFileTarget = largeFileUri
            ? largeFileViewerProvider?.selectedQueryTarget(largeFileUri)
            : null;
        if (largeFileTarget) {
            return runObjectReferenceQuery(
                largeFileTarget,
                entityReferencesWebviewProvider?.getScopePreference?.() || 'auto',
            ).then(Boolean);
        }
        if (offerActiveLargeFile()) return Promise.resolve(false);
        const editor = resolveEntityReferenceCursorEditor(lastEntityReferenceCursorEditor);
        if (editor) lastEntityReferenceCursorEditor = editor;
        const target = inferIndexedEntityQueryTarget(editor);
        if (!target) {
            entityReferencesWebviewProvider?.setMessage(i18n.get('entityReferencesCursorUnavailable'));
            entityReferencesWebviewProvider?.focusForm();
            return Promise.resolve(false);
        }
        return runObjectReferenceQuery(
            target,
            entityReferencesWebviewProvider?.getScopePreference?.() || 'auto',
        ).then(Boolean);
    };
    let objectFollowTimer: ReturnType<typeof setTimeout> | undefined;
    let objectFollowGeneration = 0;
    let objectFollowCancellation: InstanceType<typeof vscode.CancellationTokenSource> | undefined;
    const stopObjectReferenceFollow = () => {
        clearTimeout(objectFollowTimer);
        objectFollowGeneration++;
        objectFollowCancellation?.cancel();
        objectFollowCancellation?.dispose();
        objectFollowCancellation = undefined;
    };
    let lastObjectFollowKey = '';
    let objectReferenceOpening = 0;
    let objectReferenceNavigation: any = null;
    const scheduleObjectReferenceFollow = () => {
        stopObjectReferenceFollow();
        const generation = objectFollowGeneration;
        if (objectReferenceOpening || manualObjectReferenceQueries || !entityReferencesWebviewProvider?.isFollowingCursor()) return;
        objectFollowTimer = setTimeout(async () => {
            const editor = vscode.window.activeTextEditor;
            if (manualObjectReferenceQueries || !editor || !isLsdynaFile(editor.document) || editor.document.isClosed ||
                shouldSkipAutomaticDocumentScan(editor.document) ||
                !entityReferencesWebviewProvider?.isFollowingCursor()) return;
            if (isEntityReferenceNavigationPosition(editor, objectReferenceNavigation)) return;
            objectReferenceNavigation = null;
            const version = editor.document.version;
            const position = editor.selection.active;
            const cancellation = new vscode.CancellationTokenSource();
            objectFollowCancellation = cancellation;
            const isCurrent = () => generation === objectFollowGeneration &&
                !cancellation.token.isCancellationRequested && editor === vscode.window.activeTextEditor &&
                !editor.document.isClosed && editor.document.version === version &&
                editor.selection.active.line === position.line && editor.selection.active.character === position.character &&
                entityReferencesWebviewProvider?.isFollowingCursor();
            try { await prepareReferenceDirectory(); } catch (error) { logDebug(`Object reference preparation failed: ${error}`); return; }
            if (!isCurrent()) return;
            const target = inferIndexedEntityQueryTarget(editor, { requireUnambiguous: true });
            if (!target) return; // Whitespace and unrelated fields keep the last useful result.
            const preference = entityReferencesWebviewProvider.getScopePreference();
            const scope = preference === 'auto' ? 'file' : preference;
            const scopeIdentity = scopeIdentityForPreference(scope);
            if (!scopeIdentity) return;
            const key = JSON.stringify([target.targetKind, target.id, scopeIdentity, editor.document.version]);
            const current = entityReferenceProvider.getActiveSession?.();
            if (key === lastObjectFollowKey && current?.identity.targetKind === target.targetKind &&
                String(current.identity.id) === String(target.id) && ['ready', 'partial'].includes(current.state)) return;

            try {
                const result = await runObjectReferenceQuery(target, scope, { automatic: true, isCurrent, cancellationToken: cancellation.token });
                if (result && isCurrent()) lastObjectFollowKey = key;
            } catch (error) {
                logDebug(`Object reference follow failed: ${error}`);
            }
        }, 250);
    };
    context.subscriptions.push({ dispose: stopObjectReferenceFollow });
    const refreshCurrentObjectReference = () => {
        stopObjectReferenceFollow();
        const session = entityReferenceProvider.getActiveSession?.();
        if (!session) return inferAndQueryObjectReference();
        manualObjectReferenceQueries++;
        return refreshStoredObjectReference(session, {
            queryOptions: { presentResult: false, silentStatus: true },
        }).finally(() => { manualObjectReferenceQueries--; });
    };
    const openLsdynaLocation = async (
        filePath,
        line = 0,
        side = false,
        startCharacter = 0,
        endCharacter = startCharacter,
    ) => {
        const uri = vscode.Uri.file(filePath);
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.size >= LARGE_FILE_THRESHOLD_BYTES) {
                return largeFileViewerProvider.openAt(
                    uri,
                    Math.max(0, Number(line) || 0),
                    side ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
                );
            }
        } catch {
            return false;
        }
        const lineNumber = Math.max(0, Number(line) || 0);
        const start = new vscode.Position(lineNumber, Math.max(0, Number(startCharacter) || 0));
        const end = new vscode.Position(lineNumber, Math.max(start.character, Number(endCharacter) || 0));
        await vscode.commands.executeCommand('vscode.open', uri, {
            selection: new vscode.Range(start, end),
            ...(side ? { viewColumn: vscode.ViewColumn.Beside } : {}),
        });
        return true;
    };
    const openEntityReferenceNode = async (node, side) => {
        let activeNode = node;
        if (['stale', 'needs-refresh'].includes(node?.session?.state)) {
            const roleIndex = (node.session.locations || [])
                .slice(0, node.index + 1)
                .filter(location => location.role === node.role)
                .length - 1;
            const refreshed = await refreshStoredObjectReference(node);
            if (!refreshed) return false;
            const locations = refreshed?.querySession?.locations || [];
            const sameRole = locations.filter(location => location.role === node.role);
            const location = roleIndex >= 0 ? sameRole[roleIndex] : null;
            if (location) {
                activeNode = {
                    ...node,
                    session: refreshed.querySession,
                    location,
                };
            } else {
                entityReferenceProvider.markNeedsRefresh(
                    refreshed?.querySession || node.session,
                    ['entity-reference-location-changed'],
                );
                return false;
            }
        }
        const args = LsdynaEntityReferenceProvider.openArguments(activeNode, side);
        if (!args) {
            vscode.window.showWarningMessage(i18n.get('entityReferencesRefreshBeforeOpen'));
            return false;
        }
        entityReferenceProvider.setActive(activeNode);
        stopObjectReferenceFollow();
        const navigation = activeNode.location;
        objectReferenceNavigation = navigation;
        objectReferenceOpening++;
        let opened = false;
        try {
            opened = await openLsdynaLocation(
                navigation.filePath, navigation.line, side,
                navigation.startCharacter, navigation.endCharacter,
            );
            return opened;
        } finally {
            objectReferenceOpening--;
            if (!opened && objectReferenceNavigation === navigation) objectReferenceNavigation = null;
        }
    };
    largeFileViewerProvider = new LargeFileViewerProvider(
        context.extensionPath,
        context.workspaceState,
        {
            loadFileIndex: async (filePath, cancellationToken) => {
                const snapshot = await indexClient.loadProjectSnapshot(
                    filePath,
                    { singleFileOnly: true },
                    null,
                    cancellationToken,
                );
                return lookupNormalizedFileIndex(
                    new Map(fileIndexScopeEntries(snapshot?.fileIndexes)),
                    filePath,
                );
            },
            queryObject: target => {
                void vscode.commands.executeCommand('lsdynaEntityReferences.focus');
                return runObjectReferenceQuery(
                    target,
                    entityReferencesWebviewProvider?.getScopePreference?.() || 'auto',
                ).then(Boolean);
            },
        },
    );
    context.subscriptions.push(
        largeFileViewerProvider,
        typeof vscode.window.registerCustomEditorProvider === 'function'
            ? vscode.window.registerCustomEditorProvider(
                LARGE_FILE_VIEW_TYPE,
                largeFileViewerProvider,
                { supportsMultipleEditorsPerDocument: false },
            )
            : { dispose() {} },
        vscode.commands.registerCommand('extension.openLsdynaLargeFileViewer', async target => {
            const uri = target instanceof vscode.Uri ? target
                : target?.uri instanceof vscode.Uri ? target.uri
                    : getActiveUri();
            if (!uri || uri.scheme !== 'file' || !isLsdynaUri(uri)) return false;
            return largeFileViewerProvider.openAt(
                uri,
                Math.max(0, Number(target?.line) || 0),
                target?.side ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
            );
        }),
    );
    entityReferencesWebviewProvider = new EntityReferencesWebviewProvider(
        context.extensionPath,
        entityReferenceProvider,
        () => indexedEntityKinds(),
        {
            stopFollow: stopObjectReferenceFollow,
            follow: () => { lastObjectFollowKey = ''; objectReferenceNavigation = null; scheduleObjectReferenceFollow(); },
            query: (targetKind, id, scopePreference) =>
                runObjectReferenceQuery({ targetKind, id }, scopePreference).then(Boolean),
            infer: inferAndQueryObjectReference,
            refresh: refreshCurrentObjectReference,
            togglePin: async sessionKey => {
                const session = entityReferenceProvider.getSession(sessionKey);
                if (!session) return false;
                if (session.pinned) {
                    const result = Boolean(await entityReferenceProvider.unpin(session));
                    lastObjectFollowKey = '';
                    scheduleObjectReferenceFollow();
                    return result;
                }
                const pinned = await entityReferenceProvider.pin(session);
                if (!pinned.ok && pinned.reason === 'limit') {
                    vscode.window.showWarningMessage(i18n.get('entityReferencesPinnedLimit', pinned.limit));
                }
                return pinned.ok;
            },
            selectSession: sessionKey => {
                const session = entityReferenceProvider.setActive(sessionKey);
                if (!session) return false;
                entityReferencesWebviewProvider.setInput(
                    session.identity.targetKind,
                    session.identity.id,
                    session.identity.scope.kind === 'project' ? 'project' : 'file',
                );
                return true;
            },
            removeSession: sessionKey => entityReferenceProvider.remove(sessionKey),
            clear: () => entityReferenceProvider.clear().then(() => true),
            open: (session, location, side) => {
                const index = (session.locations || []).indexOf(location);
                return openEntityReferenceNode({
                    type: 'location', session, location, index,
                    role: location.role,
                }, side);
            },
            openLargeFile: uri => largeFileViewerProvider.openAt(uri, 0),
        },
        prepareReferenceDirectory,
    );
    context.subscriptions.push(
        entityReferencesWebviewProvider,
        vscode.window.registerWebviewViewProvider(
            'lsdynaEntityReferences',
            entityReferencesWebviewProvider,
        ),
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && isLsdynaFile(editor.document)) lastEntityReferenceCursorEditor = editor;
            entityReferencesWebviewProvider.setLargeFileOffer();
            refreshEntityReferenceScopeContext();
            scheduleObjectReferenceFollow();
        }),
        vscode.window.onDidChangeTextEditorSelection(event => {
            if (event.textEditor === vscode.window.activeTextEditor &&
                isLsdynaFile(event.textEditor.document)) {
                lastEntityReferenceCursorEditor = event.textEditor;
                scheduleObjectReferenceFollow();
            }
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            keywordIndexProvider?.disposeDocument(document);
            keywordManagerInstanceDirectories.delete(document);
            if (lastEntityReferenceCursorEditor?.document === document) {
                lastEntityReferenceCursorEditor = null;
                stopObjectReferenceFollow();
            }
        }),
        vscode.window.tabGroups.onDidChangeTabs?.(() => {
            entityReferencesWebviewProvider.setLargeFileOffer();
            refreshEntityReferenceScopeContext();
        }) || { dispose() {} },
    );
    refreshEntityReferenceScopeContext();
    const markEntityReferenceQueriesStaleForFile = filePath => {
        if (!filePath) return;
        stopObjectReferenceFollow();
        entityReferenceProvider.markStaleForPath(filePath);
        const contextState = getMainDeckContextForDocumentPath(filePath);
        if (contextState?.state !== 'ambiguous' && contextState?.rootFile) {
            entityReferenceProvider.markStaleForRoot(contextState.rootFile);
        }
    };
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.queryLsdynaEntityId', target => {
            entityReferencesWebviewProvider.focusForm();
            if (!target?.targetKind) return inferAndQueryObjectReference();
            const normalized = normalizeIndexedEntityId(target?.id) ? target : null;
            if (normalized) return runObjectReferenceQuery(normalized, 'auto');
            entityReferencesWebviewProvider.setMessage(i18n.get('entityReferencesCursorUnavailable'));
            return null;
        }),
        vscode.commands.registerCommand(
            'extension.entityReferences.refresh',
            refreshCurrentObjectReference,
        ),
        vscode.commands.registerCommand('extension.entityReferences.pin', async target => {
            const pinned = await entityReferenceProvider.pin(target);
            if (!pinned.ok && pinned.reason === 'limit') {
                vscode.window.showWarningMessage(i18n.get('entityReferencesPinnedLimit', pinned.limit));
            }
            return pinned;
        }),
        vscode.commands.registerCommand('extension.entityReferences.unpin', target => entityReferenceProvider.unpin(target)),
        vscode.commands.registerCommand('extension.entityReferences.remove', target => entityReferenceProvider.remove(target)),
        vscode.commands.registerCommand('extension.entityReferences.clear', () => entityReferenceProvider.clear()),
        vscode.commands.registerCommand('extension.entityReferences.openSide', node => openEntityReferenceNode(node, true)),
        vscode.commands.registerCommand('extension.entityReferences.openCurrent', node => openEntityReferenceNode(node, false)),
        vscode.commands.registerCommand('extension.entityReferences.next', async () => {
            const next = entityReferenceProvider.nextReference();
            return next ? openEntityReferenceNode({ ...next, type: 'location', role: 'reference' }, false) : false;
        }),
        vscode.commands.registerCommand('extension.entityReferences.previous', async () => {
            const previous = entityReferenceProvider.previousReference();
            return previous ? openEntityReferenceNode({ ...previous, type: 'location', role: 'reference' }, false) : false;
        }),
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'extension.clearProjectIndexCaches',
            () => handleClearProjectIndexCachesCommand(indexClient, {
                projectDiagnosticStore,
                includeTreeProvider,
                keywordIndexProvider,
            }),
        )
    );
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
                entityReferenceProvider.markStaleForRoot(rootFile);
                enqueueProjectSnapshotRefresh(rootFile);
            }
        },
    });
    workspaceWatcherManager = createWorkspaceWatcherManager({
        createWatcher: glob => vscode.workspace.createFileSystemWatcher(glob),
        onFileEvent: uri => {
            if (uri?.fsPath) markEntityReferenceQueriesStaleForFile(uri.fsPath);
            invalidateChangedProjectRoots(uri);
            refreshActiveIncludeDecorations();
        },
        logWarning: message => logDebug(message),
    });
    workspaceWatcherManager.rebuild(
        getLsdynaConfigurationValue('additionalExtensions', ['.k', '.key', '.dyna'])
    );
    context.subscriptions.push(workspaceWatcherManager);
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event?.document?.uri?.fsPath && isLsdynaUri(event.document.uri)) {
                markEntityReferenceQueriesStaleForFile(event.document.uri.fsPath);
            }
        })
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    includeTreeProvider = new LsdynaIncludeTreeProvider({
        searchFileFromPaths,
        loadProjectSnapshot: indexClient.loadProjectSnapshot,
        invalidateProjectSnapshot: indexClient.invalidate,
    });
    includeTreeView = vscode.window.createTreeView('lsdynaIncludeTree', {
        treeDataProvider: includeTreeProvider
    });
    includeTreeView.title = i18n.get('includeTreeTitle');
    includeTreeProvider.attachTreeView(includeTreeView);
    context.subscriptions.push(includeTreeView);

    fileDecorationProvider = new LsdynaFileDecorationProvider(includeTreeProvider);
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(fileDecorationProvider)
    );

    const scanIncludeTreeAndRefreshEntityQuery = async () => {
        const scanResult = await includeTreeProvider.scan();
        fileDecorationProvider.refresh();
        if (statusDashboardRef && typeof statusDashboardRef.scheduleRefresh === 'function') {
            statusDashboardRef.scheduleRefresh();
        }
        refreshEntityReferenceScopeContext();
        if (entityReferencesWebviewProvider.getScopePreference() === 'auto') {
            await refreshCurrentEntityQueryAfterProjectScan(
                scanResult,
                entityReferenceProvider,
                (session, completedScan) => refreshStoredObjectReference(session, {
                    queryOptions: {
                        presentResult: false,
                        silentStatus: true,
                        scope: {
                            kind: 'project',
                            rootFile: completedScan.rootFile,
                            snapshot: completedScan.snapshot,
                            label: i18n.get(
                                'entityIdQueryProjectScopeSummary',
                                path.basename(completedScan.rootFile),
                                completedScan.snapshot.files?.length || 0,
                            ),
                        },
                    },
                }),
            );
        }
        return scanResult;
    };
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'extension.scanIncludeTree',
            scanIncludeTreeAndRefreshEntityQuery,
        )
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
        workspaceState: context.workspaceState,
    });
    cardEditKeywordIndexProviderRef = keywordIndexProvider;
    context.subscriptions.push({
        dispose: () => {
            if (cardEditKeywordIndexProviderRef === keywordIndexProvider) {
                cardEditKeywordIndexProviderRef = null;
            }
        },
    });
    if (typeof keywordIndexProvider.onDidChangeTreeData === 'function') {
        context.subscriptions.push(keywordIndexProvider.onDidChangeTreeData(() => {
            if (keywordManagerScope === 'project' && keywordManagerScopeStatus === 'ready' &&
                keywordOptionsModel && !keywordOptionsModel.stale) {
                keywordOptionsRefreshGeneration++;
                keywordManagerDirectoryTask = null;
                keywordOptionsModelAdapter.markStale();
            }
        }));
    }
    keywordTreeView = vscode.window.createTreeView('lsdynaKeywordIndex', {
        treeDataProvider: keywordIndexProvider,
        showCollapseAll: true,
    });
    keywordTreeView.title = i18n.get('keywordIndexTitle');
    context.subscriptions.push(keywordTreeView);
keywordIndexProvider.attachTreeView(keywordTreeView);
    context.subscriptions.push(keywordTreeView.onDidChangeVisibility?.(() => {
        keywordIndexProvider.stopAutomaticWork();
        if (keywordTreeView.visible) {
            const editor = vscode.window.activeTextEditor;
            void keywordIndexProvider.refreshAutomatically(editor?.document || getActiveUri())
                .then(() => keywordIndexProvider.scheduleReveal(editor));
        }
    }) || { dispose() {} }, { dispose: () => keywordIndexProvider.stopAutomaticWork() });
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.keywordIndexChooseScope', () => keywordIndexProvider.chooseScope()),
        vscode.commands.registerCommand('extension.keywordIndexRefresh', () => keywordIndexProvider.refreshScope())
    );
context.subscriptions.push(
        vscode.commands.registerCommand('extension.keywordIndexChooseLayout', () => keywordIndexProvider.chooseLayout())
    );
context.subscriptions.push(
        vscode.commands.registerCommand('extension.keywordIndexToggleFollow', () => keywordIndexProvider.toggleFollowCursor())
    );
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
            keywordIndexProvider.stopAutomaticWork();
            includeTreeProvider.refresh();
            logDebug(`onDidChangeActiveTextEditor: editor=${editor ? editor.document.uri.toString() : 'none'}, languageId=${editor ? editor.document.languageId : 'none'}`);
            if (editor) {
                Promise.resolve(keywordIndexProvider.refreshAutomatically(editor.document))
                    .finally(() => keywordIndexProvider.scheduleReveal(editor));
            } else {
                const uri = getActiveUri();
                logDebug(`onDidChangeActiveTextEditor callback fallback: getActiveUri=${uri ? uri.toString() : 'null'}`);
                if (uri) {
                    keywordIndexProvider.refreshAutomatically(uri);
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
                    keywordIndexProvider.refreshAutomatically(uri);
                }
            })
        );
    }
    const scheduleKeywordIndexRefresh = createActiveDocumentDebouncer(
        () => vscode.window.activeTextEditor?.document || getActiveUri(),
        uriOrDoc => {
            logDebug(`Debounced keyword index refresh triggered`);
            keywordIndexProvider.refreshAutomatically(uriOrDoc);
        }
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            keywordIndexProvider.updateDocumentAutomatically(e.document, e);
            if (vscode.window.activeTextEditor?.document === e.document) {
                scheduleKeywordIndexRefresh(e.document);
            }
        })
    );
    const initialUri = getActiveUri();
    logDebug(`initialUri: ${initialUri ? initialUri.toString() : 'null'}`);
    if (initialUri) {
        keywordIndexProvider.refreshAutomatically(initialUri);
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
            const editor = vscode.window.activeTextEditor;
            if (lineNum && typeof lineNum === 'object') {
                if (!editor || editor.document.isClosed || lineNum.uri !== documentUriIdentity(editor.document) ||
                    lineNum.documentVersion !== editor.document.version || !Number.isInteger(lineNum.keywordLine) ||
                    lineNum.keywordLine < 0 || lineNum.keywordLine >= editor.document.lineCount) return false;
                lineNum = lineNum.keywordLine;
            }
            return chooseKeywordOptionsForEditor(editor, lineNum);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => { updateDiagnostics(doc); })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            updateActiveFileIndexForDocumentChange(e);
            updateDiagnostics(e.document);
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => {
            documentPresentationCache.delete(doc);
            includeDirectiveCache.delete(doc);
            keywordManagerInstanceDirectories.delete(doc);
            if (inlineEditChoiceSession?.document === doc) {
                clearInlineEditChoiceSession(inlineEditChoiceSession.id);
            }
            clearCardCellTypingSession(doc);
            cardCellCompositions.delete(doc);
            structureDiagnostics.clear(doc);
            keywordStructureAnalysisCache.delete(doc);
            keywordSchema.clearFieldContextCache(doc);
            releaseLiveFileIndexForClosedDocument(doc);
            diagnostics.delete(doc.uri);
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e || typeof e.affectsConfiguration !== 'function') return;
            if (!e.affectsConfiguration('lsdyna')) return;
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

    await new Promise(resolve => setTimeout(resolve, 0));
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
    const officialChoiceStatusItem = vscode.window.createStatusBarItem(statusBarAlignment, 51);
    const activeFieldChoiceController = createActiveFieldChoiceController({
        statusBarItem: officialChoiceStatusItem,
        getActiveEditor: () => vscode.window.activeTextEditor,
        isLsdynaDocument: isLsdynaFile,
        documentIdentity: documentUriIdentity,
        getStatusBarLevel: document => getLsdynaConfigurationValue(
            'statusBar.level',
            'simple',
            document?.uri,
        ),
        plan: (document, position, planOptions) =>
            planPreparedOfficialFieldChoices(document, position, planOptions),
        translate: (key, ...args) => i18n.get(key, ...args),
        getLanguage: () => i18n.getLanguage(),
        presentEvidence: (evidence, plan) => {
            const target = semanticEvidenceLocationPresentation(evidence, plan?.ruleId);
            return target ? semanticEvidenceTargetLabel(target) : null;
        },
        setContext: (key, value) => vscode.commands.executeCommand('setContext', key, value),
        globalState: context.globalState,
        showInformationMessage: (...args) => vscode.window.showInformationMessage(...args),
        executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    });
    context.subscriptions.push(activeFieldChoiceController);
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event?.document === vscode.window.activeTextEditor?.document) {
                activeFieldChoiceController.scheduleRefresh();
            }
        })
    );
    if (keywordIndexProvider && typeof keywordIndexProvider.onDidChangeTreeData === 'function') {
        context.subscriptions.push(
            keywordIndexProvider.onDidChangeTreeData(() =>
                activeFieldChoiceController.scheduleRefresh()
            )
        );
    }
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
            activeFieldChoiceController.scheduleRefresh();
            maybeShowHealthNoticeForEditor(editor);
        })
    );
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(() => {
            statusDashboard.scheduleRefresh();
            activeFieldChoiceController.scheduleRefresh();
        })
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
                activeFieldChoiceController.scheduleRefresh();
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
    activeFieldChoiceController.refreshNow();
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

    function updateDecorations(editor, documentEdit = false) {
        if (!editor || !isLsdynaFile(editor.document)) return;
        const document = editor.document;
        const cached = documentPresentationCache.get(document);
        if (documentEdit && cached?.skipDecorationsVersion === document.version) return;
        const requestId = includeDecorationRequests.begin(document);
        const current = createDocumentReadGuard(document);
        const canPublish = () => current() && includeDecorationRequests.isLatest(document, requestId) &&
            vscode.window.activeTextEditor === editor;
        if (!cached?.ready || cached.version !== document.version) {
            editor.setDecorations(missingPathDecoration, []);
            editor.setDecorations(missingIndicatorDecoration, []);
            editor.setDecorations(keywordDecoration, []);
        }
        void (async () => {
            const prepared = await prepareDocumentPresentation(document);
            if (!canPublish() || !prepared) return;
            const { missing, missingIndicators } = await collectIncludeDecorationSets(document);
            if (!canPublish()) return;
            editor.setDecorations(missingPathDecoration, missing);
            editor.setDecorations(missingIndicatorDecoration, missingIndicators);
            editor.setDecorations(keywordDecoration, prepared.ranges);
            prepared.painted = true;
        })().catch(error => logDebug(`collectIncludeDecorationSets failed: ${error?.message || error}`));
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
                updateDecorations(vscode.window.activeTextEditor, true);
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

    async function updateIncludeLineContext(editor) {
        if (!editor || !isLsdynaFile(editor.document)) {
            vscode.commands.executeCommand('setContext', 'lsdyna.onIncludeLine', false);
            return;
        }
        const current = createDocumentReadGuard(editor.document);
        const position = editor.selection.active;
        try {
            if (!await prepareDocumentPresentation(editor.document) || !current() ||
                vscode.window.activeTextEditor !== editor || editor.selection.active.line !== position.line) return;
        } catch (_) { return; }
        const currentLine = editor.selection.active.line;
        const onInclude = isIncludeLine(editor.document, currentLine);
        vscode.commands.executeCommand('setContext', 'lsdyna.onIncludeLine', onInclude);
    }

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
            handleSelectionChange(e);
            updateIncludeLineContext(e.textEditor);
            if (keywordIndexProvider) {
                keywordIndexProvider.scheduleReveal(e.textEditor);
            }
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
        vscode.commands.registerCommand(
            'extension.lsdynaApplyInlineEditChoice',
            (sessionId, choiceId) => applyInlineEditChoice(sessionId, choiceId),
        ),
        vscode.commands.registerCommand(
            'extension.lsdynaCancelInlineEditChoice',
            (sessionId = null) => cancelInlineEditChoiceSession(sessionId),
        ),
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
            const capturedVersion = document.version;
            const capturedUri = document.uri?.toString?.() || document.uri?.fsPath || '';
            const capturedSelections = Array.from(editor.selections || []) as any[];
            const stillValid = () => {
                const active = vscode.window.activeTextEditor;
                const currentUri = document.uri?.toString?.() || document.uri?.fsPath || '';
                return active === editor &&
                    active?.document === document &&
                    document.version === capturedVersion &&
                    currentUri === capturedUri;
            };

            if (
                document.languageId !== 'lsdyna' ||
                document.isUntitled === true ||
                (document.uri?.scheme && document.uri.scheme !== 'file')
            ) return;
            if (await isDocumentReadonlyForAutomaticEdit(document)) return;
            if (!stillValid()) return;

            const ignoredKeywords = getLsdynaConfigurationValue(
                'ignoreFormattingKeywords',
                [],
                document.uri,
            ) || [];
            const shouldSkipKeyword = (keywordText, globalLongFormat) => {
                const upper = String(keywordText || '').trim().toUpperCase();
                if (ignoredKeywords.some(prefix => upper.startsWith(String(prefix).toUpperCase()))) {
                    return true;
                }
                const inputFormat = keywordInputFormat(
                    keywordText,
                    globalLongFormat ? 'long' : 'standard',
                );
                if (inputFormat !== 'standard') {
                    notifyLongFormatOnce(
                        document,
                        keywordText,
                    );
                    return true;
                }
                return false;
            };

            const plan = await planLsdynaFormatting({
                document,
                selections: capturedSelections,
                lineArgument: typeof lineNumArg === 'number' ? lineNumArg : undefined,
                fileIndex: getFileIndexForDocument(document),
            }, {
                classifyKeywordLine,
                resolveCard: ({
                    lineNum,
                    keywordLine,
                    dataLineOrdinal,
                    observedDataLines,
                    globalInputFormat,
                    readLine,
                }) => keywordSchema.getCardInfoForDocumentLine(
                    document,
                    lineNum,
                    getFieldData(),
                    {
                        keywordLine,
                        dataLineOrdinal,
                        observedDataLines,
                        globalInputFormat,
                        readLine,
                    },
                ),
                alignLine: planAlignedLine,
                splitIncludePathEntry,
                shouldSkipKeyword,
                isLongFormatKeyword: keywordSchema.isLongFormatKeyword,
                isStillValid: stillValid,
                resolveOpaqueState: position => getOpaqueCommentLocation(
                    document,
                    position,
                    { requireLiveSnapshot: true },
                ).state,
            });

            if (plan.status === 'rejected') {
                if (plan.reason === 'unsafe-line') notifyUnsafeFormatOnce(document);
                if (plan.reason !== 'cancelled') {
                    vscode.window.setStatusBarMessage(
                        i18n.get('formatSelectionRejected', plan.reason),
                        6000,
                    );
                }
                return;
            }
            if (!stillValid() || plan.edits.length === 0) return;

            const mappedSelections = capturedSelections.map(selection => {
                const anchor = mapPositionThroughFormattingEdits(
                    selection.anchor || selection.start,
                    plan.edits,
                );
                const active = mapPositionThroughFormattingEdits(
                    selection.active || selection.end,
                    plan.edits,
                );
                return new vscode.Selection(
                    new vscode.Position(anchor.line, anchor.character),
                    new vscode.Position(active.line, active.character),
                );
            });

            const applied = await editor.edit(editBuilder => {
                for (const edit of plan.edits) {
                    editBuilder.replace(
                        new vscode.Range(
                            edit.startLine,
                            edit.startCharacter,
                            edit.endLine,
                            edit.endCharacter,
                        ),
                        edit.newText,
                    );
                }
            });
            if (!applied) {
                vscode.window.setStatusBarMessage(i18n.get('formatSelectionApplyFailed'), 6000);
                return;
            }
            if (vscode.window.activeTextEditor === editor && editor.document === document) {
                editor.selections = mappedSelections;
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openIncludeFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            try {
                if (!await prepareDocumentPresentation(editor.document)) return;
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
                setFileIndexForTesting,
                planOfficialFieldChoicesForDocument,
                analyzeKeywordStructureForDocument,
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
    createStore?: (options: { cacheDirectory: string; maxCacheBytes: number; maxEntryAgeMs: number }) => any;
} = {}) {
    if (!storageUri || typeof storageUri.fsPath !== 'string' || storageUri.fsPath.trim() === '') {
        return null;
    }

    return createStore({
        cacheDirectory: path.join(storageUri.fsPath, 'project-snapshots'),
        maxCacheBytes: PROJECT_SNAPSHOT_DISK_CACHE_BYTES,
        maxEntryAgeMs: 30 * CACHE_DAY_MS,
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

const { LargeFileViewerProvider, LARGE_FILE_VIEW_TYPE } = require('./client/LargeFileViewerProvider');

const {
    globalInputFormatFromKeywordLine,
    keywordInputFormat,
    stripKeywordInputFormatMarker,
} = require('./core/parser/inputFormat');

const { classifyOpaqueCommentDirective } = require('./core/parser/opaqueCommentRange');

const { LARGE_FILE_THRESHOLD_BYTES } = require('./core/scanner/largeFileWindowReader');

const {
    collectBlocksFromLineReader,
    collectBlocksFromLineReaderAsync,
} = require('./core/parser/blockScanner');

const {
    isColumnZeroKeywordBoundary,
    classifyInlineCommentedKeyword,
    resolveOpaqueLocationFromBlocks,
    resolveOpaqueLocationBounded,
} = require('./core/parser/opaqueCommentRange');

const { getDefinitionRegistryCatalog } = require('./core/references/definitionRegistry');

const { familyDefinitionKeywords, prepareFamilyDefinitionScannerCatalog } = require('./core/references/familyDefinitionScannerCatalog');

async function prepareReferenceDirectory() {
    await Promise.all([getDefinitionRegistryCatalog().prepare(), prepareFamilyDefinitionScannerCatalog()]);
}

const {
    collectRegistryReferenceMatches,
    definitionAtPosition,
    definitionLocations,
    queryFromReferenceSource,
} = require('./core/references/registryReferenceNetwork');

const {
    buildReferenceNavigation,
} = require('./core/references/referenceNavigation');

const {
    buildWorkspaceSearchFilesToInclude,
    effectiveWorkspaceSearchId,
} = require('./core/references/workspaceReferenceSearch');

const {
    mergeOnDemandDefinitions,
    queryOnDemandDefinitionAtPosition,
    runtimeDefinitionKeywords,
    scanBlockLinesFromDisk,
    scanOnDemandDefinitions,
} = require('./core/references/onDemandDefinitionScanner');

const {
    indexedEntityKinds,
    normalizeIndexedEntityId,
    queryIndexedEntityId,
} = require('./core/references/indexedEntityQuery');

const { EntityReferenceQueryService } = require('./core/references/entityReferenceQueryService');

const {
    TABLE_3D_VIEWS,
    normalizeTable3dView,
} = require('./core/references/curvePlotRenderer');

const {
    getCatalogFieldReferenceInfo,
    scanRegistryReferenceOccurrencesFromFileIndex,
} = require('./core/references/registryReferenceScanner');

const { scanParameterEventsFromFileIndex } = require('./core/references/parameterDefinitionScanner');

const CACHE_MEBIBYTE = 1024 * 1024;

const CACHE_DAY_MS = 24 * 60 * 60 * 1000;

const CLIENT_PROJECT_SEMANTIC_CACHE_BYTES = 32 * CACHE_MEBIBYTE;

const activeProjectScopeCache = new Map();

const activeProjectCacheMetadata = new Map();

const activeFileIndexOwners = new Map();

let activeProjectCacheAccessSequence = 0;

let activeProjectCacheEpoch = 0;

let activeOnDemandReferenceLookupCache = new WeakMap();

const ON_DEMAND_LOOKUP_CACHE_MAX_BYTES = 8 * 1024 * 1024;

const MAX_TABLE_PREVIEW_VIEW_STATES = 256;

const tablePreviewViewByReference = new Map();

const entityReferenceQueryService = new EntityReferenceQueryService();

function buildTablePreviewReferenceKey(documentPath, lineIndex, fieldName) {
    if (typeof documentPath !== 'string' || !documentPath) return '';
    if (!Number.isInteger(lineIndex) || lineIndex < 0) return '';
    if (typeof fieldName !== 'string' || !fieldName) return '';
    return `${normalizeFileIndexKey(documentPath)}:${lineIndex}:${fieldName.toUpperCase()}`;
}

function getTablePreviewViewForReference(key) {
    return normalizeTable3dView(tablePreviewViewByReference.get(key));
}

function setTablePreviewViewForReference(key, view) {
    if (typeof key !== 'string' || !key || key.length > 4096) return false;
    if (!TABLE_3D_VIEWS.includes(view)) return false;

    // Refresh insertion order so the oldest inactive entries are evicted first.
    tablePreviewViewByReference.delete(key);
    tablePreviewViewByReference.set(key, view);
    while (tablePreviewViewByReference.size > MAX_TABLE_PREVIEW_VIEW_STATES) {
        const oldestKey = tablePreviewViewByReference.keys().next().value;
        tablePreviewViewByReference.delete(oldestKey);
    }
    return true;
}

function clearTablePreviewViewsForTesting() {
    tablePreviewViewByReference.clear();
}

async function handleSetTablePreviewViewCommand(arg) {
    const target = Array.isArray(arg) ? arg[0] : arg;
    if (!target || !setTablePreviewViewForReference(target.key, target.view)) return false;
    if (typeof target.filePath !== 'string' || !target.filePath) return true;

    const targetFileKey = normalizeFileIndexKey(target.filePath);
    const matchingEditor = vscode.window.activeTextEditor;
    const editorPath = matchingEditor?.document?.uri?.fsPath;
    if (typeof editorPath !== 'string' || normalizeFileIndexKey(editorPath) !== targetFileKey) {
        return true;
    }

    const lineIndex = Number.isInteger(target.lineIndex) ? Math.max(0, target.lineIndex) : 0;
    const character = Number.isInteger(target.character) ? Math.max(0, target.character) : 0;
    const selections = matchingEditor.selections;
    const position = new vscode.Position(lineIndex, character);
    const previewSelection = new vscode.Selection(position, position);
    try {
        // showHover anchors at the caret, even when invoked from a mouse hover.
        // Restore every selection after VS Code has captured the preview anchor.
        matchingEditor.selection = previewSelection;
        await Promise.resolve(vscode.commands.executeCommand('editor.action.hideHover'));
        await Promise.resolve(vscode.commands.executeCommand('editor.action.showHover', { focus: 'autoFocusImmediately' }));
    } finally {
        const current = matchingEditor.selection;
        if (matchingEditor.selections.length === 1 &&
            current.anchor.line === lineIndex && current.anchor.character === character &&
            current.active.line === lineIndex && current.active.character === character) {
            matchingEditor.selections = selections;
        }
    }
    return true;
}

function getReadyKeywordBlocksForDocument(document, { allowDiskSnapshot = true } = {}) {
    const fileIndex = getFileIndexForDocument(document);
    if (!fileIndex || !Array.isArray(fileIndex.keywordBlocks)) return null;
    if (Number.isInteger(fileIndex.documentVersion)) {
        return fileIndex.documentVersion === document.version ? fileIndex.keywordBlocks : null;
    }
    if (!allowDiskSnapshot || document.isDirty === true) return null;
    return fileIndex.keywordBlocks;
}

function getOpaqueCommentLocation(document, position, options: any = {}) {
    const line = Number(position?.line);
    const character = Number(position?.character);
    if (!document || !Number.isInteger(line) || line < 0 || line >= document.lineCount
        || !Number.isInteger(character) || character < 0) {
        return { state: 'unknown', reason: 'invalid-position' };
    }
    const blocks = getReadyKeywordBlocksForDocument(document, {
        allowDiskSnapshot: options.requireLiveSnapshot !== true,
    });
    if (blocks) return resolveOpaqueLocationFromBlocks(blocks, line, character);
    const readLine = typeof options.readLine === 'function'
        ? options.readLine
        : index => document.lineAt(index).text;
    return resolveOpaqueLocationBounded(
        readLine,
        line,
        character,
        options.budget,
    );
}

function isActiveLsdynaSemanticLocation(document, position, options: any = {}) {
    return getOpaqueCommentLocation(document, position, options).state === 'active';
}

function trackKeywordManagerSourceChange(model, event) {
    const header = model.liveKeywordLine ?? model.keywordLine;
    const selected = model.liveSelectionLine ?? model.managerSelectionLine ?? header;
    let headerDelta = 0, selectionDelta = 0;
    for (const change of event.contentChanges) {
        const { start, end } = change.range;
        const delta = countInsertedLineBreaks(change.text) - (end.line - start.line);
        const insertsLinesBefore = line => start.line === line && end.line === line &&
            start.character === 0 && end.character === 0 && /(?:\r\n|\r|\n)$/.test(change.text);
        if (end.line < header || insertsLinesBefore(header)) headerDelta += delta;
        else if (start.line <= header) model.sourceAnchorInvalid = true;
        if (end.line < selected || insertsLinesBefore(selected)) selectionDelta += delta;
        else if (start.line <= selected && (start.line !== end.line || delta !== 0)) model.sourceAnchorInvalid = true;
    }
    model.liveKeywordLine = header + headerDelta;
    model.liveSelectionLine = selected + selectionDelta;
}

function keywordManagerRefreshLine(model, document) {
    const header = model.liveKeywordLine ?? model.keywordLine;
    const line = model.liveSelectionLine ?? model.managerSelectionLine ?? header;
    if (model.sourceAnchorInvalid || !Number.isInteger(header) || header < 0 || header >= document.lineCount ||
        !Number.isInteger(line) || line < header || line >= document.lineCount ||
        keywordSpellingFromLine(document.lineAt(header).text) !== model.currentKeyword ||
        findKeywordLineForLine(document, line) !== header) return null;
    return line;
}

function countInsertedLineBreaks(text) {
    const matches = String(text || '').match(/\r\n|\r|\n/g);
    return matches ? matches.length : 0;
}

function updateKeywordBlocksAfterDocumentChange(document, keywordBlocks, contentChanges) {
    if (!document || !Array.isArray(keywordBlocks) || !Array.isArray(contentChanges)) return null;
    if (contentChanges.length === 0) return keywordBlocks;

    const changes = contentChanges.map(change => {
        const range = change && change.range;
        const startLine = range?.start?.line;
        const startCharacter = range?.start?.character;
        const endLine = range?.end?.line;
        const endCharacter = range?.end?.character;
        if (
            !Number.isInteger(startLine) || startLine < 0 ||
            !Number.isInteger(startCharacter) || startCharacter < 0 ||
            !Number.isInteger(endLine) || endLine < startLine ||
            !Number.isInteger(endCharacter) || endCharacter < 0
        ) return null;
        const insertedLineBreaks = countInsertedLineBreaks(change.text);
        return {
            startLine,
            startCharacter,
            endLine,
            endCharacter,
            text: String(change.text || ''),
            insertedLineBreaks,
            lineDelta: insertedLineBreaks - (endLine - startLine),
        };
    });
    if (changes.some(change => !change)) return null;
    changes.sort((left, right) =>
        left.startLine - right.startLine || left.startCharacter - right.startCharacter
    );

    const opaqueBlocks = keywordBlocks.filter(block => !!block?.opaqueKind);
    if (opaqueBlocks.length > 0) {
        for (const change of changes) {
            const touchesOpaqueControl = opaqueBlocks.some(block =>
                block.startLine >= change.startLine && block.startLine <= change.endLine
            );
            const canChangePhysicalBoundaries = change.startCharacter === 0
                || change.startLine !== change.endLine
                || /\r|\n/.test(String(change.text || ''));
            if (touchesOpaqueControl || canChangePhysicalBoundaries) return null;
        }
    }

    // This mapper intentionally carries only existing metadata.  A newly created COMMENT
    // control must be rebuilt by the comment-aware scanner rather than published briefly as
    // an ordinary keyword block.
    let precedingInspectionDelta = 0;
    for (const change of changes) {
        const finalStartLine = change.startLine + precedingInspectionDelta;
        const finalEndLine = finalStartLine + change.insertedLineBreaks;
        for (
            let line = Math.max(0, finalStartLine);
            line <= Math.min(document.lineCount - 1, finalEndLine);
            line++
        ) {
            if (classifyOpaqueCommentDirective(document.lineAt(line).text)) return null;
        }
        precedingInspectionDelta += change.lineDelta;
    }

    const retained = [];
    for (const block of keywordBlocks) {
        const oldStart = Number(block?.startLine);
        if (!Number.isInteger(oldStart) || oldStart < 0) continue;
        let mappedStart = oldStart;
        let touched = false;

        for (const change of changes) {
            if (oldStart < change.startLine) continue;

            // A multi-line range ending at column zero is end-exclusive: the
            // content of that physical line survives and only its line number
            // changes.  A zero-length insertion on the same line is different
            // and must be reclassified.
            const untouchedEndBoundary =
                change.startLine < change.endLine &&
                oldStart === change.endLine &&
                change.endCharacter === 0;
            if (oldStart > change.endLine || untouchedEndBoundary) {
                mappedStart += change.lineDelta;
                continue;
            }
            touched = true;
        }

        if (touched || mappedStart < 0 || mappedStart >= document.lineCount) continue;
        const classification = classifyKeywordLine(document.lineAt(mappedStart).text);
        if (!classification.isKeyword) continue;
        retained.push({ ...block, startLine: mappedStart });
    }

    // Content-change ranges are expressed in the pre-change document.  Map the
    // start of each changed span into the final document using deltas from
    // preceding edits, then inspect only the lines the replacement produced.
    let precedingLineDelta = 0;
    const rescanned = [];
    for (const change of changes) {
        const finalStartLine = change.startLine + precedingLineDelta;
        const finalEndLine = finalStartLine + change.insertedLineBreaks;
        for (
            let line = Math.max(0, finalStartLine);
            line <= Math.min(document.lineCount - 1, finalEndLine);
            line++
        ) {
            const text = document.lineAt(line).text;
            const classification = classifyKeywordLine(text);
            if (!classification.isKeyword) continue;
            rescanned.push({
                filePath: document.uri?.fsPath,
                keyword: classification.normalizedKeyword,
                rawKeyword: text.trim(),
                startLine: line,
                endLine: line,
                keywordStartChar: Math.max(0, text.search(/\S/)),
            });
        }
        precedingLineDelta += change.lineDelta;
    }

    const byStartLine = new Map();
    for (const block of retained) byStartLine.set(block.startLine, block);
    for (const block of rescanned) byStartLine.set(block.startLine, block);
    const blocks = [...byStartLine.values()].sort((left, right) => left.startLine - right.startLine);
    for (let index = 0; index < blocks.length; index++) {
        blocks[index].endLine = index + 1 < blocks.length
            ? blocks[index + 1].startLine - 1
            : document.lineCount - 1;
    }
    return blocks;
}

function updateActiveFileIndexForDocumentChange(event) {
    const document = event?.document;
    const filePath = document?.uri?.fsPath;
    if (!filePath) return false;
    const key = normalizeFileIndexKey(filePath);
    const cached = activeFileIndexCache.get(key);
    if (!cached || !Array.isArray(cached.keywordBlocks)) {
        activeFileIndexCache.delete(key);
        return false;
    }

    const keywordBlocks = updateKeywordBlocksAfterDocumentChange(
        document,
        cached.keywordBlocks,
        event.contentChanges || [],
    );
    if (!keywordBlocks) {
        activeFileIndexCache.delete(key);
        return false;
    }

    // Keep only the live structural index.  Reference/include/parameter data is
    // derived from document contents and must not survive an edit as stale data.
    activeFileIndexCache.set(key, {
        filePath,
        keywordBlocks,
        documentVersion: Number.isInteger(document.version) ? document.version : undefined,
    });
    return true;
}

function releaseLiveFileIndexForClosedDocument(document) {
    const filePath = document?.uri?.fsPath;
    if (!filePath) return false;
    const key = normalizeFileIndexKey(filePath);
    const cached = activeFileIndexCache.get(key);
    if (!cached || !Number.isInteger(cached.documentVersion)) return false;
    activeFileIndexCache.delete(key);
    return true;
}

function estimateClientCacheBytes(value, maxBytes = CLIENT_PROJECT_SEMANTIC_CACHE_BYTES) {
    // Cache admission must not serialize a whole vehicle model on the UI thread.
    // Conservatively reject entries whose size cannot be established within a
    // bounded walk; the worker remains the source for uncached project queries.
    const deadline = performance.now() + 25;
    const seen = new Set();
    let bytes = 0;
    let nodes = 0;
    const visit = (current, depth = 0) => {
        if (++nodes > 50000 || depth > 64 ||
            (nodes % 256 === 0 && performance.now() > deadline)) return false;
        if (typeof current === 'string') bytes += 24 + current.length * 6;
        else if (current === null || typeof current !== 'object') bytes += 16;
        else {
            if (seen.has(current)) {
                bytes += 8; // Retained container slots still occupy space for shared objects.
                return bytes <= maxBytes;
            }
            seen.add(current);
            bytes += 64;
            if (bytes > maxBytes) return false;
            if (Array.isArray(current) || current instanceof Set) {
                for (const item of current) if (!visit(item, depth + 1)) return false;
            } else if (current instanceof Map) {
                for (const [key, item] of current) {
                    if (!visit(key, depth + 1) || !visit(item, depth + 1)) return false;
                }
            } else {
                for (const key in current) {
                    if (Object.prototype.hasOwnProperty.call(current, key) &&
                        (!visit(key, depth + 1) || !visit(current[key], depth + 1))) return false;
                }
            }
        }
        return bytes <= maxBytes;
    };
    return visit(value) ? bytes : Number.POSITIVE_INFINITY;
}

function compactClientProjectSnapshot(snapshot) {
    const sourceGraph = snapshot.graph || {};
    return {
        rootFile: snapshot.rootFile,
        files: Array.isArray(snapshot.files) ? [...snapshot.files] : [],
        graph: {
            includeOccurrences: Array.isArray(sourceGraph.includeOccurrences)
                ? sourceGraph.includeOccurrences.map(occurrence => ({ ...occurrence }))
                : [],
            includeOccurrencesComplete: sourceGraph.includeOccurrencesComplete !== false,
        },
        fileIndexes: snapshot.fileIndexes instanceof Map
            ? snapshot.fileIndexes
            : new Map(Object.entries(snapshot.fileIndexes || {})),
    };
}

function removeClientProjectRoot(rootFileOrKey, {
    preserveMainDeckSelection = false,
    preserveProjectScope = false,
} = {}) {
    if (!rootFileOrKey) return false;
    const rootKey = activeProjectCacheMetadata.has(rootFileOrKey)
        ? rootFileOrKey
        : normalizeSnapshotRootKey(rootFileOrKey);
    const metadata = activeProjectCacheMetadata.get(rootKey);
    const cached = activeProjectReferenceIndexCache.get(rootKey);
    const scope = activeProjectScopeCache.get(rootKey);
    if (!metadata && !cached && !scope) return false;

    const rootFile = metadata?.rootFile || cached?.snapshot?.rootFile || scope?.rootFile;
    for (const fileKey of metadata?.fileKeys || []) {
        const owners = activeFileIndexOwners.get(fileKey);
        if (!owners) continue;
        owners.delete(rootKey);
        if (owners.size > 0) continue;
        activeFileIndexOwners.delete(fileKey);
        const fileIndex = activeFileIndexCache.get(fileKey);
        if (!Number.isInteger(fileIndex?.documentVersion)) {
            activeFileIndexCache.delete(fileKey);
        }
    }
    activeProjectCacheMetadata.delete(rootKey);
    activeProjectReferenceIndexCache.delete(rootKey);
    if (!preserveProjectScope) activeProjectScopeCache.delete(rootKey);
    if (rootFile) {
        activeEffectiveSearchPathCache.clearRoot(rootFile);
        if (!preserveMainDeckSelection) activeMainDeckContextSelector.clearRoot(rootFile);
    }
    return true;
}

function clientProjectCacheStats(maxBytes = CLIENT_PROJECT_SEMANTIC_CACHE_BYTES) {
    let totalBytes = 0;
    for (const metadata of activeProjectCacheMetadata.values()) totalBytes += metadata.byteSize;
    return {
        entryCount: activeProjectCacheMetadata.size,
        totalBytes,
        maxBytes,
    };
}

function evictClientProjectsIfNeeded(protectedRootKey = null, maxBytes = CLIENT_PROJECT_SEMANTIC_CACHE_BYTES) {
    let stats = clientProjectCacheStats(maxBytes);
    while (stats.totalBytes > maxBytes) {
        const candidates = [...activeProjectCacheMetadata.entries()]
            .filter(([rootKey]) => rootKey !== protectedRootKey)
            .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);
        const victimKey = candidates.length > 0 ? candidates[0][0] : protectedRootKey;
        if (!victimKey || !removeClientProjectRoot(victimKey, {
            preserveMainDeckSelection: true,
            preserveProjectScope: true,
        })) break;
        stats = clientProjectCacheStats(maxBytes);
    }
}

function clampedFiniteNumber(value, fallback, minimum, maximum) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(maximum, Math.max(minimum, numeric));
}

function cacheLimitBytes(key, fallbackMiB, minimumMiB, maximumMiB) {
    return Math.floor(clampedFiniteNumber(
        getLsdynaConfigurationValue(key, fallbackMiB),
        fallbackMiB,
        minimumMiB,
        maximumMiB,
    ) * CACHE_MEBIBYTE);
}

function cacheLimitMilliseconds(key, fallbackDays, minimumDays, maximumDays) {
    return Math.floor(clampedFiniteNumber(
        getLsdynaConfigurationValue(key, fallbackDays),
        fallbackDays,
        minimumDays,
        maximumDays,
    ) * CACHE_DAY_MS);
}

function clearClientProjectSemanticCaches() {
    activeProjectCacheEpoch += 1;
    const projectCount = activeProjectReferenceIndexCache.size;
    for (const rootKey of [...new Set([
        ...activeProjectCacheMetadata.keys(),
        ...activeProjectScopeCache.keys(),
    ])]) removeClientProjectRoot(rootKey);
    let fileIndexCount = 0;
    for (const [cacheKey, fileIndex] of [...activeFileIndexCache.entries()]) {
        if (Number.isInteger(fileIndex?.documentVersion)) continue;
        activeFileIndexCache.delete(cacheKey);
        fileIndexCount += 1;
    }
    activeProjectCacheMetadata.clear();
    activeFileIndexOwners.clear();
    activeProjectReferenceIndexCache.clear();
    activeProjectScopeCache.clear();
    activeEffectiveSearchPathCache.clearAll();
    activeMainDeckContextSelector.clearAll();
    activeOnDemandReferenceLookupCache = new WeakMap();
    refreshMainDeckContextUi();
    return { fileIndexCount, projectCount };
}

function cacheRemovalTotals(result) {
    const memory = result?.memory || {};
    const projectDisk = result?.projectSnapshotDisk || {};
    const fileDisk = result?.fileScanDisk || {};
    return {
        entryCount: Number(memory.cachedSnapshotCount || 0)
            + Number(projectDisk.entryCount || 0)
            + Number(fileDisk.entryCount || 0),
        totalBytes: Number(memory.totalSnapshotBytes || 0)
            + Number(projectDisk.totalBytes || 0)
            + Number(fileDisk.totalBytes || 0),
    };
}

async function handleClearProjectIndexCachesCommand(indexClient, {
    projectDiagnosticStore = null,
    includeTreeProvider = null,
    keywordIndexProvider = null,
} = {}) {
    if (!indexClient || typeof indexClient.clearCaches !== 'function') return null;

    // Increment the epoch before the LSP round trip so an older response cannot
    // repopulate client caches after the explicit clear has begun.
    clearClientProjectSemanticCaches();
    let localCleanupError = null;
    for (const cleanup of [
        () => projectDiagnosticStore?.clearAll?.(),
        () => includeTreeProvider?.clearProjectSnapshot?.(),
        () => keywordIndexProvider?.setLocal?.(),
    ]) {
        try {
            await Promise.resolve(cleanup());
        } catch (error) {
            localCleanupError ||= error;
            console.error('[lsdyna] Failed to clear one client project view:', error);
        }
    }
    try {
        const execute = () => indexClient.clearCaches();
        const result = typeof vscode.window.withProgress === 'function'
            ? await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: i18n.get('projectCacheClearProgress'),
                cancellable: false,
            }, execute)
            : await execute();
        const totals = cacheRemovalTotals(result);
        vscode.window.setStatusBarMessage(localCleanupError
            ? i18n.get('projectCacheClearFailed')
            : i18n.get('projectCacheCleared', totals.entryCount, formatBytes(totals.totalBytes)), 8000);
        return result;
    } catch (error) {
        vscode.window.setStatusBarMessage(i18n.get('projectCacheClearFailed'), 8000);
        console.error('[lsdyna] Failed to clear project index caches:', error);
        return null;
    }
}

function decorateDocumentKeywordBlocks(document, blocks) {
    return blocks.map(block => {
        const text = document.lineAt(block.startLine).text;
        const classification = classifyKeywordLine(text);
        return {
            ...block,
            filePath: document.uri.fsPath,
            keyword: `*${block.keyword}`,
            rawKeyword: classification.rawKeyword || text.trim(),
            keywordStartChar: classification.indent || 0,
            startOffset: 0,
            endOffset: 0,
        };
    });
}

async function parseKeywordBlocksFromDocumentAsync(document, cancellationToken = null) {
    const isCurrent = createDocumentReadGuard(document, cancellationToken);
    const blocks = await collectBlocksFromLineReaderAsync(
        document.lineCount,
        line => document.lineAt(line).text,
        {
            cancellationToken,
            shouldCancel: () => !isCurrent() === true,
        },
    );
    return blocks && isCurrent() ? decorateDocumentKeywordBlocks(document, blocks) : null;
}

const parameterSymbolCache = new WeakMap<object, { version: number; value: ReturnType<typeof scanParameterSymbols> }>();

function getDocumentParameterSymbols(document) {
    const cacheable = Number.isInteger(document.version);
    const cached = cacheable ? parameterSymbolCache.get(document) : undefined;
    if (cached && cached.version === document.version) return cached.value;
    const value = scanParameterSymbols(document.lineCount, line => document.lineAt(line).text);
    if (cacheable) parameterSymbolCache.set(document, { version: document.version, value });
    return value;
}

function workspaceReferenceSearchPosition(editor, target) {
    if (!editor || !editor.document) return null;
    const payload = target && typeof target === 'object' ? target : null;
    if (!payload) return editor.selection && editor.selection.active || null;

    const documentPath = editor.document.uri && editor.document.uri.fsPath;
    if (typeof payload.filePath !== 'string' || !documentPath ||
        normalizeFileIndexKey(payload.filePath) !== normalizeFileIndexKey(documentPath)) {
        return null;
    }
    if (Number.isInteger(payload.documentVersion) &&
        Number.isInteger(editor.document.version) &&
        payload.documentVersion !== editor.document.version) {
        return null;
    }
    if (!Number.isInteger(payload.lineIndex) || !Number.isInteger(payload.character) ||
        payload.lineIndex < 0 || payload.lineIndex >= editor.document.lineCount ||
        payload.character < 0) {
        return null;
    }
    return new vscode.Position(payload.lineIndex, payload.character);
}

function resolveWorkspaceReferenceSearch(document, position, options: any = {}) {
    const source = fieldReferenceAtPosition(document, position, options);
    if (!source) return null;

    const mainDeckContext = getMainDeckContextForDocumentPath(document.uri.fsPath);
    let analysis = null;
    if (mainDeckContext.state !== 'ambiguous' && mainDeckContext.project) {
        analysis = analyzeReference(
            mainDeckContext.project.referenceIndex,
            source.referenceValue,
            source.referenceValue.targetKinds || source.referenceInfo.targetKinds,
            {
                projectScoped: true,
                documentPath: document.uri.fsPath,
                lineIndex: position.line,
                targetDefinitions: source.referenceValue.targetDefinitions ||
                    source.referenceInfo.targetDefinitions,
            }
        );
    } else if (source.referenceValue.kind === 'parameter') {
        const fileIndex = getFileIndexForDocument(document);
        const liveIndexIsCurrent = !document.isDirty ||
            (fileIndex && Number.isInteger(fileIndex.documentVersion) &&
                fileIndex.documentVersion === document.version);
        if (fileIndex && liveIndexIsCurrent && Array.isArray(fileIndex.parameterEvents)) {
            const referenceIndex = buildProjectReferenceIndex({
                rootFile: document.uri.fsPath,
                files: [document.uri.fsPath],
                fileIndexes: new Map([[document.uri.fsPath, fileIndex]]),
            });
            analysis = analyzeReference(
                referenceIndex,
                source.referenceValue,
                source.referenceValue.targetKinds || source.referenceInfo.targetKinds,
                {
                    projectScoped: false,
                    documentPath: document.uri.fsPath,
                    lineIndex: position.line,
                    targetDefinitions: source.referenceValue.targetDefinitions ||
                        source.referenceInfo.targetDefinitions,
                }
            );
        }
    }
    let id = effectiveWorkspaceSearchId(source.referenceValue, analysis);
    // Provisional workspace search may still use the literal numeric cell when
    // project roots are ambiguous; no semantic target is claimed by this search.
    if (id === null && !analysis && source.referenceValue.kind === 'numeric') {
        const literal = Number.parseInt(String(source.rawValue || '').trim(), 10);
        if (Number.isSafeInteger(literal) && literal > 0) id = literal;
    }
    if (id === null) {
        return { source, analysis, unavailableReason: 'reference-id-unresolved' };
    }
    return { source, analysis, id };
}

async function handleWorkspaceReferenceSearchCommand(target = null) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isLsdynaFile(editor.document)) {
        vscode.window.setStatusBarMessage(i18n.get('workspaceReferenceSearchSourceInactive'), 6000);
        return null;
    }
    const position = workspaceReferenceSearchPosition(editor, target);
    if (!position) {
        vscode.window.setStatusBarMessage(i18n.get('workspaceReferenceSearchSourceInactive'), 6000);
        return null;
    }
    if (target && typeof target.projectRootFile === 'string' && target.projectRootFile) {
        const currentContext = getMainDeckContextForDocumentPath(editor.document.uri.fsPath);
        if (!currentContext.project ||
            normalizeFileIndexKey(currentContext.rootFile) !==
                normalizeFileIndexKey(target.projectRootFile)) {
            vscode.window.setStatusBarMessage(i18n.get('workspaceReferenceSearchUnavailable'), 6000);
            return null;
        }
    }

    const resolved = resolveWorkspaceReferenceSearch(editor.document, position);
    if (!resolved || !Number.isSafeInteger(resolved.id)) {
        const key = resolved && resolved.unavailableReason === 'project-root-ambiguous'
            ? 'workspaceReferenceSearchAmbiguousContext'
            : 'workspaceReferenceSearchUnavailable';
        vscode.window.setStatusBarMessage(i18n.get(key), 6000);
        return null;
    }

    const configuredExtensions = getLsdynaConfigurationValue(
        'additionalExtensions',
        ['.k', '.key', '.dyna'],
        editor.document.uri
    );
    const filesToInclude = buildWorkspaceSearchFilesToInclude(configuredExtensions);
    vscode.window.setStatusBarMessage(
        i18n.get('workspaceReferenceSearchStatus', resolved.id),
        8000
    );
    const searchArgs = {
        query: String(resolved.id),
        triggerSearch: true,
        isRegex: false,
        isCaseSensitive: false,
        matchWholeWord: true,
        filesToInclude,
    };
    try {
        await vscode.commands.executeCommand('workbench.action.findInFiles', searchArgs);
    } catch (error) {
        logDebug(`workspace reference search failed: ${error && error.message ? error.message : error}`);
        vscode.window.setStatusBarMessage(i18n.get('workspaceReferenceSearchFailed'), 6000);
        return null;
    }
    return { id: resolved.id, searchArgs };
}

function validEntityQueryFilePath(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) return null;
    const resolved = path.resolve(filePath);
    try {
        if (!fs.statSync(resolved).isFile() || !isLsdynaUri(vscode.Uri.file(resolved))) return null;
    } catch (_error) {
        return null;
    }
    return resolved;
}

async function resolveIndexedEntityQueryScope(target, indexClient, cancellationToken = null, options: any = {}) {
    if (options.scope?.snapshot) return options.scope;
    const requestedScope = options.scopeIdentity;
    if (requestedScope?.kind === 'project' && requestedScope.rootFile) {
        const rootFile = validEntityQueryFilePath(requestedScope.rootFile);
        if (!rootFile) {
            return { unavailableReason: 'entity-query-source-missing', identityScope: requestedScope };
        }
        const snapshot = await indexClient.loadProjectSnapshot(rootFile, {}, null, cancellationToken);
        return snapshot ? {
            kind: 'project',
            rootFile,
            snapshot,
            label: i18n.get('entityIdQueryProjectScopeSummary', path.basename(rootFile), snapshot.files?.length || 0),
        } : null;
    }
    if (requestedScope?.kind === 'single-file' && requestedScope.filePath) {
        const filePath = validEntityQueryFilePath(requestedScope.filePath);
        if (!filePath) {
            return { unavailableReason: 'entity-query-source-missing', identityScope: requestedScope };
        }
        const snapshot = await indexClient.loadProjectSnapshot(
            filePath,
            { singleFileOnly: true },
            null,
            cancellationToken,
        );
        return snapshot?.scope === 'single-file' ? {
            kind: 'single-file',
            filePath,
            snapshot,
            label: i18n.get('entityIdQueryCurrentFile', path.basename(filePath)),
        } : null;
    }
    if (typeof target?.rootFile === 'string') {
        const rootKey = normalizeSnapshotRootKey(target.rootFile);
        const project = activeProjectReferenceIndexCache.get(rootKey) ||
            activeProjectScopeCache.get(rootKey);
        if (project) {
            const snapshot = project.snapshot || await indexClient.loadProjectSnapshot(
                project.rootFile || target.rootFile,
                {},
                null,
                cancellationToken,
            );
            return {
                kind: 'project',
                rootFile: snapshot.rootFile,
                snapshot,
                label: i18n.get('entityIdQueryProject', path.basename(snapshot.rootFile)),
            };
        }
    }
    const requestedFile = validEntityQueryFilePath(target?.filePath);
    const activeFile = validEntityQueryFilePath(getActiveUri()?.fsPath);
    const filePath = requestedFile || activeFile;
    if (!filePath) {
        return { unavailableReason: 'entity-query-source-inactive' };
    }
    const mainDeckContext = getMainDeckContextForDocumentPath(filePath);
    if (mainDeckContext.state !== 'ambiguous' && mainDeckContext.project) {
        const snapshot = mainDeckContext.project.snapshot || await indexClient.loadProjectSnapshot(
            mainDeckContext.rootFile,
            {},
            null,
            cancellationToken,
        );
        return {
            kind: 'project',
            rootFile: mainDeckContext.rootFile,
            snapshot,
            label: i18n.get(
                'entityIdQueryProjectScopeSummary',
                path.basename(mainDeckContext.rootFile),
                snapshot.files?.length || 0,
            ),
        };
    }
    const loadSnapshot = options.loadSnapshot || ((filePath, token) =>
        indexClient.loadProjectSnapshot(
            filePath,
            { singleFileOnly: true },
            null,
            token,
        ));
    const snapshot = await loadSnapshot(filePath, cancellationToken);
    if (snapshot?.scope !== 'single-file') return null;
    return {
        kind: 'single-file',
        filePath,
        snapshot,
        label: i18n.get('entityIdQueryCurrentFile', path.basename(filePath)),
    };
}

async function prepareIndexedEntityQuerySnapshot(snapshot, cancellationToken = null) {
    const inputGuards = (vscode.workspace.textDocuments || []).map(doc => createDocumentReadGuard(doc, cancellationToken));
    if (!snapshot?.fileIndexes) {
        return { state: 'incomplete', snapshot: null, reasons: ['entity-query-snapshot-unavailable'] };
    }
    const fileIndexes = new Map(fileIndexScopeEntries(snapshot.fileIndexes));
    const indexedPaths = new Set([...fileIndexes.keys()].map(normalizeFileIndexKey));
    const dirtyDocuments = (vscode.workspace.textDocuments || []).filter(document =>
        document?.isDirty === true && document?.uri?.fsPath &&
        indexedPaths.has(normalizeFileIndexKey(document.uri.fsPath))
    );
    for (const document of dirtyDocuments) {
        if (cancellationToken?.isCancellationRequested) {
            return { state: 'cancelled', snapshot: null, reasons: ['cancelled'] };
        }
        const existing = lookupNormalizedFileIndex(fileIndexes, document.uri.fsPath);
        const live = await buildLiveRegistryReferenceFileIndex(
            document,
            existing,
            cancellationToken,
        );
        if (!live) return { state: 'cancelled', snapshot: null, reasons: ['cancelled'] };
        if (live.incompleteReason) {
            return {
                state: 'incomplete',
                snapshot: null,
                reasons: [`${document.uri.fsPath}:${live.incompleteReason}`],
            };
        }
        replaceNormalizedFileIndex(fileIndexes, document.uri.fsPath, live);
    }
    if (inputGuards.some(current => !current())) return { state: 'cancelled', snapshot: null, reasons: ['document-version-changed'] };
    return { state: 'ready', snapshot: { ...snapshot, fileIndexes }, reasons: [] };
}

function indexedEntityResultItems(result) {
    return (result?.locations || []).map(location => {
        const roleLabel = i18n.get(location.role === 'definition'
            ? 'entityIdQueryDefinition'
            : 'entityIdQueryReference');
        const identity = [location.keyword, location.fieldName].filter(Boolean).join('/') || roleLabel;
        return {
            label: `$(${location.role === 'definition' ? 'symbol-field' : 'references'}) ${roleLabel}: ${identity}`,
            description: `${path.basename(location.filePath)}:${location.line + 1}`,
            detail: location.filePath,
            location,
        };
    });
}

function isEntityReferenceNavigationPosition(editor, location) {
    const position = editor?.selection?.active;
    return !!location && !!position && !!editor.document?.uri?.fsPath &&
        normalizeFileIndexKey(editor.document.uri.fsPath) === normalizeFileIndexKey(location.filePath) &&
        position.line === location.line &&
        position.character >= (location.startCharacter || 0) &&
        position.character <= (location.endCharacter ?? location.startCharacter ?? 0);
}

function inferIndexedEntityQueryTarget(editor = vscode.window.activeTextEditor, options: { requireUnambiguous?: boolean } = {}) {
    if (!editor || !isLsdynaFile(editor.document)) return null;
    const position = editor.selection?.active;
    const kinds = indexedEntityKinds();
    if (!position) return null;

    // References are preferred when the cursor is on a reference field.
    const resolved = resolveWorkspaceReferenceSearch(editor.document, position, {
        semanticScope: "keyword-catalog",
    });
    if (resolved) {
        const targetKinds = [
            ...(resolved.source.referenceValue.targetKinds || []),
            ...(resolved.source.referenceInfo.targetKinds || []),
        ];
        const supportedKinds = [...new Set(targetKinds)]
            .map(value => kinds.find(kind => kind.toLowerCase() === String(value).toLowerCase()))
            .filter(Boolean);
        if (options.requireUnambiguous && new Set(supportedKinds).size !== 1) return null;
        const targetKind = supportedKinds[0];
        const id = normalizeIndexedEntityId(resolved.id);
        if (targetKind && id) return {
            targetKind,
            id,
            filePath: editor.document.uri.fsPath,
            line: position.line,
            character: position.character,
        };
    }

    // Definition IDs use the same scanner descriptors as the project index.
    const keywordLine = findEnclosingKeywordLine(editor.document, position.line);
    if (keywordLine === null) return null;
    const keyword = classifyKeywordLine(editor.document.lineAt(keywordLine).text);
    const descriptorKeyword = String(keyword.normalizedKeyword || '').replace(/^\*/, '');
    const definitionKeywords = runtimeDefinitionKeywords();
    const descriptor = definitionKeywords?.generic?.[descriptorKeyword] ||
        definitionKeywords?.onDemand?.[descriptorKeyword] ||
        getDefinitionRegistryCatalog().definitionDescriptorForKeyword(descriptorKeyword);
    if (!descriptor) return null;
    const cardInfo = getCardInfoForLine(editor.document, position.line);
    const lineText = String(editor.document.lineAt(position.line).text || '');
    const expectedFieldIndex = descriptor.physicalSelector?.fieldIndex ?? descriptor.fieldIndex;
    const geometricFieldIndex = Array.isArray(cardInfo?.card)
        ? cardCellModel.fieldIndexAt(lineText, cardInfo.card, position.character)
        : -1;
    const boundaryFieldIndex = Array.isArray(cardInfo?.card)
        ? cardCellModel.fieldIndexForTabNav(lineText, cardInfo.card, position.character)
        : -1;
    const fieldIndex = geometricFieldIndex === expectedFieldIndex
        ? geometricFieldIndex
        : boundaryFieldIndex;
    if (!Number.isInteger(fieldIndex) || fieldIndex !== expectedFieldIndex) return null;

    const recordMode = descriptor.physicalSelector?.recordMode || descriptor.recordMode;
    if (recordMode === 'exact-data-record-ordinal') {
        let dataLineOrdinal = -1;
        for (let line = keywordLine + 1; line <= position.line; line++) {
            const text = String(editor.document.lineAt(line).text || '').trim();
            if (!text || text.startsWith('$') || text.startsWith('*')) continue;
            dataLineOrdinal += 1;
        }
        const expectedOrdinal = (descriptor.titleCardCount || 0) +
            (descriptor.physicalSelector?.dataRecordOrdinal ?? descriptor.dataRecordOrdinal ?? 0);
        if (dataLineOrdinal !== expectedOrdinal) return null;
    }

    const field = cardInfo.card[fieldIndex];
    const rawValue = lineText.slice(field.p, field.p + field.w);
    const id = normalizeIndexedEntityId(rawValue);
    const targetKind = kinds.find(kind =>
        kind.toLowerCase() === String(descriptor.targetKind || '').toLowerCase()
    );
    return targetKind && id ? {
        targetKind,
        id,
        filePath: editor.document.uri.fsPath,
        line: position.line,
        character: position.character,
    } : null;
}

function resolveEntityReferenceCursorEditor(lastEditor = null) {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && isLsdynaFile(activeEditor.document)) return activeEditor;
    const activeUri = getActiveUri();
    const visibleEditor = activeUri && (vscode.window.visibleTextEditors || []).find(editor =>
        isLsdynaFile(editor.document) &&
        documentUriIdentity(editor.document) === documentUriIdentity({ uri: activeUri })
    );
    if (visibleEditor) return visibleEditor;
    if (!lastEditor || !isLsdynaFile(lastEditor.document)) return null;
    const openDocuments = vscode.workspace.textDocuments;
    return !Array.isArray(openDocuments) || openDocuments.includes(lastEditor.document)
        ? lastEditor
        : null;
}

async function presentIndexedEntityQueryResult(result, target = null) {
    const locations = (result?.locations || []).map(location => new vscode.Location(
        vscode.Uri.file(location.filePath),
        new vscode.Range(location.line, location.startCharacter, location.line, location.endCharacter),
    ));
    if (locations.length === 0) return false;
    if (locations.length === 1) {
        await vscode.commands.executeCommand('vscode.open', locations[0].uri, {
            viewColumn: vscode.ViewColumn.Active,
            preview: true,
            selection: locations[0].range,
        });
        return true;
    }
    const editor = vscode.window.activeTextEditor;
    const sourceUri = editor?.document?.uri || vscode.Uri.file(target?.filePath || result.locations[0].filePath);
    const sourcePosition = editor?.selection?.active || new vscode.Position(
        Number.isInteger(target?.line) ? target.line : 0,
        Number.isInteger(target?.character) ? target.character : 0,
    );
    await vscode.commands.executeCommand('editor.action.peekLocations', sourceUri, sourcePosition, locations, 'peek');
    return true;
}

async function handleIndexedEntityIdQueryCommand(indexClient, target: any = null, options: any = {}) {
    if (!indexClient || typeof indexClient.loadProjectSnapshot !== 'function') return null;
    const isCurrentRequest = typeof options.isCurrentRequest === 'function'
        ? options.isCurrentRequest
        : () => true;
    await prepareReferenceDirectory();
    if (!isCurrentRequest()) return null;
    const kinds = indexedEntityKinds();
    let normalizedTarget = kinds.includes(String(target?.targetKind || '').trim()) &&
        normalizeIndexedEntityId(target?.id)
        ? { ...target, targetKind: String(target.targetKind).trim(), id: normalizeIndexedEntityId(target.id) }
        : (options.inferTarget || inferIndexedEntityQueryTarget)();
    if (!normalizedTarget) {
        options.onInputRequired?.();
        return null;
    }
    if (!normalizedTarget) return null;
    target = { ...(target || {}), ...normalizedTarget };
    const targetKind = normalizedTarget.targetKind;
    const entityId = normalizedTarget.id;

    let loadingSession, loadingLocations;
    const operation = async (_progress = null, cancellationToken = null) => {
        if (!isCurrentRequest() || cancellationToken?.isCancellationRequested) return null;
        const scope = await resolveIndexedEntityQueryScope(
            target,
            indexClient,
            cancellationToken,
            options,
        );
        if (!isCurrentRequest() || cancellationToken?.isCancellationRequested) return null;
        if (scope?.unavailableReason || !scope?.snapshot || cancellationToken?.isCancellationRequested) {
            if (scope?.unavailableReason && !cancellationToken?.isCancellationRequested &&
                options.silentStatus !== true) {
                vscode.window.showWarningMessage(i18n.get(
                    scope.unavailableReason === 'project-root-ambiguous'
                        ? 'entityIdQueryAmbiguousContext'
                        : scope.unavailableReason === 'entity-query-source-missing'
                            ? 'entityIdQuerySourceMissing'
                            : 'entityIdQuerySourceInactive',
                ));
            }
            if (scope?.identityScope && options.entityReferenceProvider) {
                const session = options.entityReferenceProvider.publish(
                    { targetKind, id: entityId, scope: scope.identityScope },
                    { state: 'incomplete', locations: [], reasons: [scope.unavailableReason] },
                );
                return { state: 'incomplete', locations: [], reasons: [scope.unavailableReason], querySession: session };
            }
            return null;
        }
        const identityScope = scope.kind === 'project'
            ? { kind: 'project', rootFile: scope.rootFile }
            : { kind: 'single-file', filePath: scope.filePath };
        if (!options.preserveResultsWhileLoading) loadingSession = options.entityReferenceProvider?.publish(
            { targetKind, id: entityId, scope: identityScope },
            { state: 'loading', locations: [], reasons: [] },
        );
        loadingLocations = loadingSession?.locations;
        const prepared = await (options.prepareSnapshot || prepareIndexedEntityQuerySnapshot)(
            scope.snapshot,
            cancellationToken,
        );
        if (!isCurrentRequest() || cancellationToken?.isCancellationRequested) return null;
        if (prepared?.state !== 'ready') {
            const incomplete = {
                state: prepared?.state === 'cancelled' ? 'cancelled' : 'incomplete',
                id: entityId,
                targetKind,
                locations: [],
                reasons: prepared?.reasons || ['entity-query-snapshot-unavailable'],
            };
            const session = options.entityReferenceProvider?.publish(
                { targetKind, id: entityId, scope: identityScope },
                incomplete,
            );
            if (incomplete.state !== 'cancelled' && options.silentStatus !== true) {
                vscode.window.showWarningMessage(i18n.get(
                    'entityIdQueryIncomplete',
                    incomplete.reasons.map(uncertaintyReasonLabel).join(', '),
                ));
            }
            return { ...incomplete, querySession: session };
        }
        const queryArguments = {
            snapshot: prepared.snapshot,
            id: entityId,
            targetKind,
            cancellationToken,
            scanBlockLines: options.scanBlockLines || scanReferenceBlockLines,
        };
        const result = options.query
            ? await options.query(queryArguments)
            : await entityReferenceQueryService.queryById(
                prepared.snapshot,
                entityId,
                targetKind,
                queryArguments,
            );
        if (!result || cancellationToken?.isCancellationRequested || !isCurrentRequest()) return null;
        const querySession = options.entityReferenceProvider?.publish(
            { targetKind, id: entityId, scope: identityScope },
            result,
        );
        if (options.silentStatus !== true && result.state === 'partial') {
            vscode.window.showWarningMessage(i18n.get(
                'entityIdQueryPartial',
                (result.reasons?.length ? result.reasons : [result.state]).map(uncertaintyReasonLabel).join(', '),
            ));
        } else if (options.silentStatus !== true && !['complete', 'exact', 'ambiguous', 'missing'].includes(result.state)) {
            vscode.window.showWarningMessage(i18n.get(
                'entityIdQueryIncomplete',
                (result.reasons?.length ? result.reasons : [result.state]).map(uncertaintyReasonLabel).join(', '),
            ));
        } else if (options.silentStatus !== true && (result.state === 'missing' || result.locations.length === 0)) {
            vscode.window.showInformationMessage(i18n.get(
                'entityIdQueryNoResults',
                targetKind,
                entityId,
            ));
        }
        if (options.presentResult !== false && result.locations?.length > 0) {
            const present = options.presentResult || presentIndexedEntityQueryResult;
            await present(result, target);
        }
        return { ...result, querySession };
    };

    try {
        if (typeof options.runWithProgress === 'function') return await options.runWithProgress(operation);
        if (typeof vscode.window.withProgress === 'function') {
            return await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: i18n.get('entityIdQueryScanning'),
                cancellable: true,
            }, operation);
        }
        return await operation();
    } finally {
        // Only finish the loading state installed by this request, never a newer query's state.
        if (loadingSession?.state === 'loading' && loadingSession.locations === loadingLocations &&
            options.entityReferenceProvider?.getSession(loadingSession) === loadingSession) {
            options.entityReferenceProvider.markNeedsRefresh(loadingSession, ['entity-reference-query-interrupted']);
        }
    }
}

function beginEntityReferenceRefresh(state) {
    state.revision = Number.isInteger(state.revision) ? state.revision + 1 : 1;
    const revision = state.revision;
    return { revision, isCurrent: () => state.revision === revision };
}

async function refreshCurrentEntityReferenceQuery(
    indexClient,
    entityReferenceProvider,
    refreshState,
    options: any = {},
) {
    const request = beginEntityReferenceRefresh(refreshState);
    const inferTarget = options.inferTarget || inferIndexedEntityQueryTarget;
    const target = inferTarget();
    if (!target) {
        entityReferenceProvider?.clearCurrent?.();
        return null;
    }
    const current = entityReferenceProvider?.getCurrentSession?.();
    if (current) entityReferenceProvider.markLoading(current);
    const runQuery = options.runQuery || handleIndexedEntityIdQueryCommand;
    try {
        const result = await runQuery(indexClient, target, {
            ...(options.queryOptions || {}),
            entityReferenceProvider,
            presentResult: false,
            isCurrentRequest: request.isCurrent,
        });
        if (!request.isCurrent()) return null;
        if (!result) entityReferenceProvider?.clearCurrent?.();
        return result;
    } catch (error) {
        if (!request.isCurrent()) return null;
        entityReferenceProvider?.clearCurrent?.();
        (options.logError || console.error)(
            '[lsdyna] Failed to refresh the current object-reference query:', error,
        );
        return null;
    }
}

async function refreshStoredEntityReferenceQuery(
    indexClient,
    entityReferenceProvider,
    refreshState,
    target,
    options: any = {},
) {
    const session = entityReferenceProvider?.getSession?.(target);
    if (!session) return null;
    const request = beginEntityReferenceRefresh(refreshState);
    entityReferenceProvider.markLoading(session);
    const runQuery = options.runQuery || handleIndexedEntityIdQueryCommand;
    try {
        const result = await runQuery(
            indexClient,
            { targetKind: session.identity.targetKind, id: session.identity.id },
            {
                ...(options.queryOptions || {}),
                entityReferenceProvider,
                scopeIdentity: session.identity.scope,
                presentResult: false,
                isCurrentRequest: request.isCurrent,
            },
        );
        if (!request.isCurrent()) return null;
        if (!result) {
            entityReferenceProvider.markNeedsRefresh(
                session,
                ['entity-reference-refresh-cancelled'],
            );
        }
        return result;
    } catch (error) {
        if (!request.isCurrent()) return null;
        entityReferenceProvider.markNeedsRefresh(
            session,
            ['entity-reference-refresh-failed'],
        );
        (options.logError || console.error)(
            '[lsdyna] Failed to refresh the stored object-reference query:', error,
        );
        return null;
    }
}

async function refreshCurrentEntityQueryAfterProjectScan(
    scanResult,
    entityReferenceProvider,
    refreshQuery,
) {
    if (!scanResult?.rootFile || !scanResult?.snapshot ||
        !entityReferenceProvider || typeof refreshQuery !== 'function') return null;
    const session = entityReferenceProvider.getActiveSession?.();
    if (!session || session.pinned) return null;
    const scope = session.identity?.scope;
    const priorScopePath = scope?.kind === 'project' ? scope.rootFile : scope?.filePath;
    if (!priorScopePath ||
        normalizeFileIndexKey(priorScopePath) !== normalizeFileIndexKey(scanResult.rootFile)) return null;
    return refreshQuery(session, scanResult);
}

function shouldResolveParameterDefinitionAtPosition(document, position) {
    if (!document || !position || !Number.isInteger(position.line) ||
        position.line < 0 || position.line >= document.lineCount) return false;
    const text = String(document.lineAt(position.line).text || '');
    const ampersandPattern = /-?&[A-Za-z_][A-Za-z0-9_]{0,8}/g;
    let match;
    while ((match = ampersandPattern.exec(text)) !== null) {
        if (position.character >= match.index &&
            position.character < match.index + match[0].length) return true;
    }

    const bareNamePattern = /[A-Za-z_][A-Za-z0-9_]{0,8}/g;
    let bareMatch = null;
    while ((match = bareNamePattern.exec(text)) !== null) {
        if (position.character >= match.index &&
            position.character < match.index + match[0].length) {
            bareMatch = match;
            break;
        }
    }
    if (!bareMatch) return false;

    const keywordLine = findEnclosingKeywordLine(document, position.line);
    if (keywordLine === null) return false;
    const keyword = classifyKeywordLine(document.lineAt(keywordLine).text);
    return keyword.isKeyword && keyword.normalizedKeyword.startsWith('*PARAMETER');
}

function fieldReferenceAuthorityScope(referenceInfo, semanticScope = 'prefer-registry') {
    if (semanticScope === "keyword-catalog") {
        return referenceInfo?.source === "keyword-catalog" ? "keyword-catalog" : null;
    }
    const registryAvailable = !!referenceInfo?.definitionRegistry;
    if (semanticScope === 'registry-approved') return registryAvailable ? 'definition-registry' : null;
    if (semanticScope === 'manual-runtime') return 'manual-runtime';
    if (semanticScope !== 'prefer-registry') return null;
    return registryAvailable ? 'definition-registry' : 'manual-runtime';
}

function fieldReferenceAtPosition(document, position, options: any = {}) {
    if (!document || !position || !Number.isInteger(position.line) ||
        position.line < 0 || position.line >= document.lineCount) return null;
    if (!isActiveLsdynaSemanticLocation(document, position)) return null;
    const text = String(document.lineAt(position.line).text || '');
    const trimmed = text.trimStart();
    if (trimmed.startsWith('*') || trimmed.startsWith('$') || text.includes(',')) return null;

    const keywordLine = findEnclosingKeywordLine(document, position.line);
    if (keywordLine === null) return null;
    const keywordText = String(document.lineAt(keywordLine).text || '');
    if (keywordUsesNonStandardInputFormat(document, keywordText)) {
        return null;
    }

    const cardInfo = getCardInfoForLine(document, position.line);
    if (!cardInfo || cardInfo.isTextCard || !Array.isArray(cardInfo.card) ||
        !cardCellModel.isSafeCardGeometry(cardInfo.card)) return null;
    const fieldIndexes = [
        cardCellModel.fieldIndexAt(text, cardInfo.card, position.character),
        cardCellModel.fieldIndexForTabNav(text, cardInfo.card, position.character),
    ].filter((fieldIndex, index, values) => fieldIndex >= 0 && values.indexOf(fieldIndex) === index);
    for (const fieldIndex of fieldIndexes) {
        const field = cardInfo.card[fieldIndex];
        if (!field || (field.nativeIdentity && !field.nativeStaticBinding) || text.length < field.p) continue;

        let referenceInfo;
        try {
            const resolveReferenceInfo = options.semanticScope === "keyword-catalog"
                ? getCatalogFieldReferenceInfo
                : getActionableFieldReferenceInfo;
            referenceInfo = resolveReferenceInfo({
                keyword: cardInfo.keywordName,
                cardIndex: cardInfo.cardIndex,
                field,
            });
        } catch (_error) {
            continue;
        }
        if (!referenceInfo) continue;
        const authorityScope = fieldReferenceAuthorityScope(
            referenceInfo,
            options.semanticScope || 'prefer-registry',
        );
        if (!authorityScope) continue;
        const rawValue = text.slice(field.p, field.p + field.w);
        const referenceValue = parseFieldReferenceValue(rawValue, referenceInfo);
        if (!referenceValue) continue;
        return {
            cardInfo,
            field,
            rawValue,
            referenceInfo,
            referenceValue,
            authorityScope,
            sourceRange: {
                line: position.line,
                startCharacter: field.p,
                endCharacter: field.p + field.w,
            },
        };
    }
    return null;
}

function activeUnsynchronizedLargeFileUri() {
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (activeTab?.input?.viewType === LARGE_FILE_VIEW_TYPE) return null;
    const uri = getActiveUri();
    if (!uri || uri.scheme !== 'file' || !isLsdynaUri(uri)) return null;
    if (vscode.window.activeTextEditor &&
        documentUriIdentity(vscode.window.activeTextEditor.document) === documentUriIdentity({ uri })) {
        return null;
    }
    try {
        return fs.statSync(uri.fsPath).size >= LARGE_FILE_THRESHOLD_BYTES ? uri : null;
    } catch {
        return null;
    }
}

function activeLargeFileViewerUri() {
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (activeTab?.input?.viewType !== LARGE_FILE_VIEW_TYPE) return null;
    return activeTab.input.uri || activeTab.input.resource || null;
}

function fileIndexScopeEntries(fileIndexes) {
    if (!fileIndexes) return [];
    return fileIndexes instanceof Map
        ? [...fileIndexes.entries()]
        : Object.entries(fileIndexes);
}

function replaceNormalizedFileIndex(scope, filePath, fileIndex) {
    const key = normalizeFileIndexKey(filePath);
    for (const candidatePath of [...scope.keys()]) {
        if (normalizeFileIndexKey(candidatePath) === key) scope.delete(candidatePath);
    }
    scope.set(filePath, fileIndex);
}

function buildOnDemandFileIndexScope(referenceIndexState) {
    const scope = new Map(fileIndexScopeEntries(referenceIndexState?.snapshot?.fileIndexes));
    if (scope.size === 0) {
        for (const filePath of referenceIndexState?.referenceIndex?.files || []) {
            const cached = activeFileIndexCache.get(normalizeFileIndexKey(filePath));
            if (cached) scope.set(filePath, cached);
        }
    }

    const reasons = [];
    let cacheable = true;
    for (const document of vscode.workspace.textDocuments || []) {
        const filePath = document?.uri?.fsPath;
        if (!filePath) continue;
        const inScope = [...scope.keys()].some(candidatePath =>
            normalizeFileIndexKey(candidatePath) === normalizeFileIndexKey(filePath)
        );
        if (!inScope) continue;
        const liveIndex = getFileIndexForDocument(document);
        if (document.isDirty) {
            cacheable = false;
            if (!liveIndex || liveIndex.documentVersion !== document.version) {
                for (const candidatePath of [...scope.keys()]) {
                    if (normalizeFileIndexKey(candidatePath) === normalizeFileIndexKey(filePath)) {
                        scope.delete(candidatePath);
                    }
                }
                reasons.push('on-demand-live-structure-unavailable');
                continue;
            }
        }
        if (liveIndex && Number.isInteger(liveIndex.documentVersion)) {
            cacheable = false;
            replaceNormalizedFileIndex(scope, filePath, liveIndex);
        }
    }
    if ([...scope.values()].some(index => Number.isInteger(index?.documentVersion))) {
        cacheable = false;
    }
    return { fileIndexes: scope, cacheable, reasons: [...new Set(reasons)] };
}

function findOpenDocumentByPath(filePath) {
    const key = normalizeFileIndexKey(filePath);
    return (vscode.workspace.textDocuments || []).find(document =>
        document?.uri?.fsPath && normalizeFileIndexKey(document.uri.fsPath) === key
    ) || null;
}

async function scanReferenceBlockLines(block, visitLine, cancellationToken = null) {
    const document = findOpenDocumentByPath(block.filePath);
    if (!document || !Number.isInteger(block.startLine) || !Number.isInteger(block.endLine)) {
        return scanBlockLinesFromDisk(block, visitLine, cancellationToken);
    }
    const startLine = Math.max(0, block.startLine + 1);
    const endLine = Math.min(document.lineCount - 1, block.endLine);
    const keywordLineText = block.startLine >= 0 && block.startLine < document.lineCount
        ? String(document.lineAt(block.startLine).text || '')
        : String(block.rawKeyword || block.keyword || '');
    let lineCount = 0;
    for (let lineIndex = startLine; lineIndex <= endLine; lineIndex++) {
        if ((lineIndex & 255) === 0 && cancellationToken?.isCancellationRequested) {
            return { complete: false, cancelled: true, lineCount };
        }
        if (lineIndex > startLine && ((lineIndex - startLine) & 4095) === 0) {
            await new Promise(resolve => setImmediate(resolve));
            if (cancellationToken?.isCancellationRequested) {
                return { complete: false, cancelled: true, lineCount };
            }
        }
        const pending = visitLine(
            String(document.lineAt(lineIndex).text || ''),
            lineIndex,
            { keywordLineText }
        );
        if (pending && typeof pending.then === 'function') await pending;
        lineCount += 1;
    }
    return { complete: true, lineCount, keywordLineText };
}

function onDemandLookupCacheKey(analysis, targetKinds, targetDefinitions) {
    return JSON.stringify({
        id: analysis?.id,
        targetKinds: [...new Set(targetKinds || [])].sort(),
        targetDefinitions: [...new Set(targetDefinitions || [])]
            .map(value => String(value || '').toUpperCase())
            .sort(),
    });
}

function estimateOnDemandLookupBytes(lookup) {
    let bytes = 256 + (lookup?.reasons || []).join('\0').length * 2;
    for (const definition of lookup?.definitions || []) {
        bytes += 320 + String(definition.filePath || '').length * 2;
        bytes += (definition.occurrencePathLabels || []).join('\0').length * 2;
    }
    return bytes;
}

function getCachedOnDemandLookup(referenceIndex, key) {
    const bucket = referenceIndex && activeOnDemandReferenceLookupCache.get(referenceIndex);
    if (!bucket || !bucket.entries.has(key)) return null;
    const entry = bucket.entries.get(key);
    bucket.entries.delete(key);
    bucket.entries.set(key, entry);
    return entry.lookup;
}

function cacheOnDemandLookup(referenceIndex, key, lookup) {
    if (!referenceIndex || !key || lookup?.state !== 'complete') return;
    let bucket = activeOnDemandReferenceLookupCache.get(referenceIndex);
    if (!bucket) {
        bucket = { entries: new Map(), totalBytes: 0 };
        activeOnDemandReferenceLookupCache.set(referenceIndex, bucket);
    }
    const byteSize = estimateOnDemandLookupBytes(lookup);
    if (byteSize > ON_DEMAND_LOOKUP_CACHE_MAX_BYTES) return;
    const prior = bucket.entries.get(key);
    if (prior) {
        bucket.totalBytes -= prior.byteSize;
        bucket.entries.delete(key);
    }
    bucket.entries.set(key, { lookup, byteSize });
    bucket.totalBytes += byteSize;
    while (bucket.totalBytes > ON_DEMAND_LOOKUP_CACHE_MAX_BYTES && bucket.entries.size > 0) {
        const oldestKey = bucket.entries.keys().next().value;
        const oldest = bucket.entries.get(oldestKey);
        bucket.entries.delete(oldestKey);
        bucket.totalBytes -= oldest.byteSize;
    }
}

async function resolveOnDemandFieldDefinitions(
    document,
    source,
    analysis,
    referenceIndexState,
    cancellationToken = null,
    options: any = {},
) {
    const targetKinds = source.referenceValue.targetKinds || source.referenceInfo.targetKinds || [];
    const targetDefinitions = source.referenceValue.targetDefinitions ||
        source.referenceInfo.targetDefinitions || [];
    const scope = buildOnDemandFileIndexScope(referenceIndexState);
    const cacheKey = onDemandLookupCacheKey(analysis, targetKinds, targetDefinitions);
    if (scope.cacheable) {
        const cached = getCachedOnDemandLookup(referenceIndexState.referenceIndex, cacheKey);
        if (cached) return { ...cached, cacheHit: true };
    }
    const lookup = await scanOnDemandDefinitions({
        referenceIndex: referenceIndexState.referenceIndex,
        fileIndexes: scope.fileIndexes,
        effectiveId: analysis.id,
        targetKinds,
        targetDefinitions,
        projectScoped: !!referenceIndexState.projectScoped,
        cancellationToken,
        scanBlockLines: scanReferenceBlockLines,
        definitionKeywords: runtimeDefinitionKeywords({
            allowCandidate: options.allowFamilyCandidate === true,
        }),
    });
    if (scope.reasons.length > 0 && lookup.state !== 'cancelled') {
        lookup.state = 'partial';
        lookup.reasons = [...new Set([...(lookup.reasons || []), ...scope.reasons])];
        lookup.cacheable = false;
    }
    if (scope.cacheable && lookup.cacheable !== false) {
        cacheOnDemandLookup(referenceIndexState.referenceIndex, cacheKey, lookup);
    }
    return lookup;
}

async function resolveFieldReferenceNavigation(
    document,
    position,
    cancellationToken = null,
    options: any = {},
) {
    const isCurrent = createReferenceReadGuard(document, cancellationToken);
    if (!isCurrent()) return null;
    const source = fieldReferenceAtPosition(document, position, options);
    if (!source || !isCurrent()) return null;
    const referenceIndexState = await getReferenceIndexForDocument(document, cancellationToken);
    if (referenceIndexState?.unavailable) return null;
    if (!referenceIndexState || !isCurrent()) return null;
    let analysis = analyzeReference(
        referenceIndexState.referenceIndex,
        source.referenceValue,
        source.referenceValue.targetKinds || source.referenceInfo.targetKinds,
        {
            projectScoped: !!referenceIndexState.projectScoped,
            documentPath: document.uri.fsPath,
            lineIndex: position.line,
            targetDefinitions: source.referenceValue.targetDefinitions ||
                source.referenceInfo.targetDefinitions,
        }
    );
    const candidateDefinitionKeywords = runtimeDefinitionKeywords({
        allowCandidate: options.allowFamilyCandidate === true,
    });
    const hasOnDemandDescriptor = Object.values(candidateDefinitionKeywords.onDemand || {})
        .some((descriptor: any) => {
            const targetKinds = source.referenceValue.targetKinds || source.referenceInfo.targetKinds || [];
            const targetDefinitions = (source.referenceValue.targetDefinitions ||
                source.referenceInfo.targetDefinitions || []).map(normalizeReferenceTargetKeyword);
            return targetKinds.includes(descriptor.targetKind) ||
                targetDefinitions.includes(normalizeReferenceTargetKeyword(
                    descriptor.target || descriptor.targetToken || descriptor.keyword
                ));
        });
    if (hasOnDemandDescriptor && analysis.reasons && analysis.reasons.some(reason =>
        [
            'target-kind-on-demand',
            'target-definition-on-demand',
            'target-kind-unindexed',
            'target-definition-unindexed',
        ].includes(reason)
    )) {
        const lookup = await resolveOnDemandFieldDefinitions(
            document,
            source,
            analysis,
            referenceIndexState,
            cancellationToken,
            options,
        );
        if ((lookup && lookup.state === 'cancelled') || !isCurrent()) {
            return null;
        }
        if (lookup) {
            analysis = mergeOnDemandDefinitions(analysis, lookup);
            if (source.referenceValue.isSignedSwitch &&
                (lookup.definitions || []).some(definition =>
                    Number.isSafeInteger(definition.idfoffOffset) &&
                    definition.idfoffOffset !== 0
                )) {
                analysis = {
                    ...analysis,
                    state: 'uncertain',
                    reasons: [...new Set([
                        ...(analysis.reasons || []),
                        'signed-switch-transform-unverified',
                    ])],
                };
            }
        }
    }
    const unifiedQuery = entityReferenceQueryService.queryFromSource(
        referenceIndexState.referenceIndex,
        source,
        {
            rootFile: referenceIndexState.rootFile,
            documentPath: document.uri.fsPath,
            lineIndex: position.line,
            documentVersion: document.version,
        },
    );
    return {
        ...buildReferenceNavigation(analysis),
        analysis,
        referenceIndexState,
        source,
        authorityScope: source.authorityScope,
        queryIdentity: unifiedQuery.queryIdentity,
        unifiedQuery,
    };
}

function normalizeReferenceTargetKeyword(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0]
        .replace(/[+%\-]$/, '');
}

function dirtyReferenceNetworkDocuments(referenceIndexState) {
    const indexed = new Set((referenceIndexState?.referenceIndex?.files || []).map(normalizeFileIndexKey));
    return (vscode.workspace.textDocuments || [])
        .filter(document => document?.isDirty === true && document?.uri?.fsPath &&
            indexed.has(normalizeFileIndexKey(document.uri.fsPath)));
}

function hasIncludeControlBlock(fileIndex) {
    return (fileIndex?.keywordBlocks || []).some(block =>
        String(block.keyword || '').trim().replace(/^\*/, '').toUpperCase()
            .split(/[\s,$]/)[0].startsWith('INCLUDE')
    );
}

function lookupNormalizedFileIndex(fileIndexes, filePath) {
    const key = normalizeFileIndexKey(filePath);
    for (const [candidatePath, fileIndex] of fileIndexScopeEntries(fileIndexes)) {
        if (normalizeFileIndexKey(candidatePath) === key) return fileIndex;
    }
    return null;
}

async function readLiveReferenceBlock(document, block, cancellationToken = null) {
    const isCurrent = createDocumentReadGuard(document, cancellationToken);
    const lines = [];
    for (let line = block.startLine; line <= block.endLine; line++) {
        if ((line & 255) === 0 && !isCurrent()) return null;
        if (line > block.startLine && ((line - block.startLine) & 4095) === 0) {
            await new Promise(resolve => setImmediate(resolve));
            if (!isCurrent()) return null;
        }
        lines.push(document.lineAt(line).text);
    }
    return lines.join('\n');
}

async function buildLiveRegistryReferenceFileIndex(
    document,
    existingFileIndex,
    cancellationToken = null,
    options: any = {},
) {
    const isCurrent = createDocumentReadGuard(document, cancellationToken);
    const blocks = await parseKeywordBlocksFromDocumentAsync(document, cancellationToken);
    if (!blocks || !isCurrent()) return null;
    if (!options.allowIncludeControlBlocks &&
        (hasIncludeControlBlock(existingFileIndex) || hasIncludeControlBlock({ keywordBlocks: blocks }))) {
        return {
            incompleteReason: options.includeIncompleteReason || 'dirty-include-graph-unverified',
        };
    }
    const input = { filePath: document.uri.fsPath, keywordBlocks: blocks };
    const readBlock = block => readLiveReferenceBlock(document, block, cancellationToken);
    const referenceDefinitions = await scanCurveTableDefinitionsFromFileIndex(
        input,
        readBlock,
        undefined,
        { cancellationToken },
    );
    if (referenceDefinitions.cancelled || !isCurrent()) return null;
    const registryReferences = await scanRegistryReferenceOccurrencesFromFileIndex(
        { ...input, referenceDefinitions },
        readBlock,
        { cancellationToken },
    );
    if (registryReferences.cancelled || !isCurrent()) return null;
    const parameterEvents = await scanParameterEventsFromFileIndex(
        input,
        readBlock,
        { cancellationToken },
    );
    if (!isCurrent()) return null;
    return {
        ...existingFileIndex,
        filePath: document.uri.fsPath,
        keywordBlocks: blocks,
        referenceDefinitions,
        registryReferences,
        parameterEvents,
        documentVersion: document.version,
        liveReferenceOverlay: true,
    };
}

async function buildSingleDocumentRegistryReferenceIndexState(
    document,
    referenceIndexState,
    cancellationToken = null,
) {
    if (referenceIndexState?.mainDeckContextState === 'ambiguous') {
        return { state: 'incomplete', reasons: ['project-root-ambiguous'] };
    }
    const existing = lookupNormalizedFileIndex(
        referenceIndexState?.snapshot?.fileIndexes,
        document.uri.fsPath,
    );
    const live = await buildLiveRegistryReferenceFileIndex(
        document,
        existing,
        cancellationToken,
        { allowIncludeControlBlocks: true },
    );
    if (!live) return { state: 'cancelled', reasons: ['cancelled'] };
    if (live.incompleteReason) {
        return { state: 'incomplete', reasons: [live.incompleteReason] };
    }
    const snapshot = {
        rootFile: document.uri.fsPath,
        files: [document.uri.fsPath],
        graph: { includeOccurrences: [] },
        fileIndexes: new Map([[document.uri.fsPath, live]]),
    };
    return {
        state: 'ready',
        referenceIndexState: {
            ...referenceIndexState,
            snapshot,
            referenceIndex: buildProjectReferenceIndex(snapshot),
            rootFile: document.uri.fsPath,
            projectScoped: false,
            singleDocumentScoped: true,
            liveReferenceOverlay: true,
        },
    };
}

async function overlayDirtyRegistryReferenceFiles(referenceIndexState, cancellationToken = null) {
    const inputGuards = (vscode.workspace.textDocuments || []).map(doc => createDocumentReadGuard(doc, cancellationToken));
    const dirtyDocuments = dirtyReferenceNetworkDocuments(referenceIndexState);
    if (dirtyDocuments.length === 0) return { state: 'ready', referenceIndexState };
    const snapshot = referenceIndexState.snapshot;
    if (!snapshot?.fileIndexes) {
        return { state: 'incomplete', reasons: ['dirty-reference-snapshot-unavailable'] };
    }
    const fileIndexes = new Map(fileIndexScopeEntries(snapshot.fileIndexes));
    for (const document of dirtyDocuments) {
        if (cancellationToken?.isCancellationRequested) return { state: 'cancelled', reasons: ['cancelled'] };
        const existing = lookupNormalizedFileIndex(fileIndexes, document.uri.fsPath);
        if (existing?.liveReferenceOverlay && existing.documentVersion === document.version) continue;
        const live = await buildLiveRegistryReferenceFileIndex(document, existing, cancellationToken);
        if (!live) return { state: 'cancelled', reasons: ['cancelled'] };
        if (live.incompleteReason) {
            return {
                state: 'incomplete',
                reasons: [`${document.uri.fsPath}:${live.incompleteReason}`],
            };
        }
        replaceNormalizedFileIndex(fileIndexes, document.uri.fsPath, live);
    }
    if (inputGuards.some(current => !current())) return { state: 'cancelled', snapshot: null, reasons: ['document-version-changed'] };
    const liveSnapshot = { ...snapshot, fileIndexes };
    return {
        state: 'ready',
        referenceIndexState: {
            ...referenceIndexState,
            snapshot: liveSnapshot,
            referenceIndex: buildProjectReferenceIndex(liveSnapshot),
            liveReferenceOverlay: true,
        },
    };
}

function mergePhysicalReferenceLocations(...groups) {
    const seen = new Set();
    const result = [];
    for (const location of groups.flat()) {
        if (!location?.filePath || !Number.isInteger(location.line) ||
            !Number.isInteger(location.startCharacter) || !Number.isInteger(location.endCharacter)) continue;
        const key = [
            normalizeFileIndexKey(location.filePath),
            location.line,
            location.startCharacter,
            location.endCharacter,
        ].join(':');
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(location);
    }
    return result.sort((left, right) =>
        normalizeFileIndexKey(left.filePath).localeCompare(normalizeFileIndexKey(right.filePath)) ||
        left.line - right.line || left.startCharacter - right.startCharacter
    );
}

async function resolveRegistryReferenceNetwork(
    document,
    position,
    context: any = {},
    cancellationToken = null,
    options: any = {},
) {
    const isCurrent = createReferenceReadGuard(document, cancellationToken);
    if (!isCurrent() ||
        !isActiveLsdynaSemanticLocation(document, position)) return null;
    const keywordLine = findEnclosingKeywordLine(document, position.line);
    if (keywordLine !== null && require('./core/semantics/nativeFieldResolution').nativeFieldDisplayOnly(
        classifyKeywordLine(document.lineAt(keywordLine).text).normalizedKeyword.replace(/^\*/, ''),
    )) return { state: 'disabled', locations: [], reasons: ['native-reference-binding-unverified'] };
    const registry = getDefinitionRegistryCatalog();
    if (!options.allowWhenPermissionDisabled && !registry.permission('referenceProviderPermission')) {
        return { state: 'disabled', locations: [], reasons: ['reference-provider-not-authorized'] };
    }
    let referenceIndexState = await getReferenceIndexForDocument(document, cancellationToken);
    if (!referenceIndexState || !isCurrent()) return null;
    if (referenceIndexState.unavailable) return { state: 'incomplete', locations: [], reasons: referenceIndexState.incompleteReasons };
    if (!referenceIndexState.projectScoped) {
        const local = await buildSingleDocumentRegistryReferenceIndexState(
            document,
            referenceIndexState,
            cancellationToken,
        );
        if (local.state !== 'ready') {
            return {
                state: local.state,
                locations: [],
                reasons: local.reasons || [],
                referenceIndexState,
            };
        } else {
            referenceIndexState = local.referenceIndexState;
        }
    }
    const completenessReasons = referenceIndexState.referenceIndex?.completenessReasons || [];
    if (completenessReasons.length > 0) {
        return {
            state: 'incomplete',
            locations: [],
            reasons: [...new Set(completenessReasons)].sort(),
            referenceIndexState,
        };
    }
    const liveOverlay = (referenceIndexState as any).singleDocumentScoped
        ? { state: 'ready', referenceIndexState }
        : await overlayDirtyRegistryReferenceFiles(referenceIndexState, cancellationToken);
    if (liveOverlay.state !== 'ready') {
        return {
            state: liveOverlay.state,
            locations: [],
            reasons: liveOverlay.reasons || [],
            referenceIndexState,
        };
    }
    referenceIndexState = liveOverlay.referenceIndexState;

    const source = fieldReferenceAtPosition(
        document,
        position,
        { semanticScope: 'registry-approved' },
    );
    let queryState = source
        ? queryFromReferenceSource(referenceIndexState.referenceIndex, source, {
            documentPath: document.uri.fsPath,
            lineIndex: position.line,
        })
        : definitionAtPosition(
            referenceIndexState.referenceIndex,
            document.uri.fsPath,
            position,
        );
    if (!source && queryState?.state === 'none') {
        const fileIndex = lookupNormalizedFileIndex(
            referenceIndexState.snapshot?.fileIndexes,
            document.uri.fsPath,
        );
        if (fileIndex && (!Number.isInteger(fileIndex.documentVersion) ||
            fileIndex.documentVersion === document.version)) {
            queryState = queryOnDemandDefinitionAtPosition({
                referenceIndex: referenceIndexState.referenceIndex,
                fileIndex,
                filePath: document.uri.fsPath,
                position,
                projectScoped: true,
                lineAt: line => line >= 0 && line < document.lineCount
                    ? document.lineAt(line).text
                    : undefined,
                definitionKeywords: {
                    onDemand: familyDefinitionKeywords({
                        allowCandidate: options.allowWhenPermissionDisabled === true,
                        requiredPermission: 'referenceProviderPermission',
                    }).onDemand,
                },
            });
        } else if (fileIndex) {
            queryState = {
                state: 'incomplete',
                query: null,
                definitions: [],
                declarations: [],
                reasons: ['definition-origin-live-structure-stale'],
            };
        }
    }
    if (!queryState || queryState.state !== 'ready') {
        return {
            state: queryState?.state === 'none' ? 'none' : 'incomplete',
            locations: [],
            reasons: queryState?.reasons || [],
            queryState,
            referenceIndexState,
            source,
        };
    }
    const matches = collectRegistryReferenceMatches(
        referenceIndexState.referenceIndex,
        queryState.query,
        { cancellationToken },
    );
    if (matches.state !== 'complete' || !isCurrent()) {
        return {
            state: matches.state,
            locations: [],
            reasons: matches.reasons,
            matches,
            queryState,
            referenceIndexState,
            source,
        };
    }
    const declarations = context?.includeDeclaration
        ? mergePhysicalReferenceLocations(
            definitionLocations(referenceIndexState.referenceIndex, queryState.query),
            queryState.declarations || [],
        )
        : [];
    return {
        state: 'complete',
        locations: mergePhysicalReferenceLocations(declarations, matches.locations),
        references: matches.locations,
        declarations,
        reasons: [],
        matches,
        queryState,
        referenceIndexState,
        source,
    };
}

function documentUriIdentity(document) {
    const uri = document?.uri;
    if (!uri) return '';
    try {
        // Command URIs decode their JSON query before dispatch. Keep the nested
        // document URI unescaped so Windows drive separators, spaces, and other
        // path characters have one stable representation on both sides of that
        // boundary (for example file:///c:/..., not file:///c%3A/...). The full
        // JSON payload is still encoded by each command-link builder.
        const serialized = uri.toString?.(true);
        if (serialized && serialized !== '[object Object]') return String(serialized);
    } catch (_error) {
        // Fall back to fsPath for the small test/document shims that do not expose Uri#toString.
    }
    return typeof uri.fsPath === 'string' ? uri.fsPath : '';
}

const nativeParameterContexts = new WeakMap<object, { version: number; source: object; reason: string; context: any }>();

const nativeParameterDiskChecks = new WeakMap<object, { version: number; index: object; matches: boolean }>();

const nativeParameterSourceIdentities = new WeakMap<object, object>();

function nativeParameterSourceIdentity(source) {
    if (!source) return null;
    let identity = nativeParameterSourceIdentities.get(source);
    if (!identity) nativeParameterSourceIdentities.set(source, identity = {});
    return identity;
}

function nativeParameterContextForDocument(document) {
    const path = document?.uri?.fsPath;
    const main = getMainDeckContextForDocumentPath(path);
    const project = main.project;
    const local = project ? null : getFileIndexForDocument(document);
    const source = project?.referenceIndex || local;
    const sourceIdentity = nativeParameterSourceIdentity(source);
    let reason = main.state === 'ambiguous' ? 'parameter-main-file-ambiguous' : '';
    if (!Number.isInteger(document.version)) reason ||= 'parameter-document-version-unavailable';
    if (!source) reason ||= 'parameter-context-unavailable';
    const current = (open, index) => {
        if (!index) return false;
        if (Number.isInteger(index.documentVersion)) return index.documentVersion === open.version;
        if (open.isDirty !== false) return false;
        const checked = nativeParameterDiskChecks.get(open);
        const indexIdentity = nativeParameterSourceIdentity(index);
        if (checked?.version === open.version && checked.index === indexIdentity) return checked.matches;
        let matches = false;
        try {
            const stat = fs.statSync(open.uri.fsPath);
            matches = stat.size === index.size && stat.mtimeMs === index.mtimeMs;
        } catch { /* No current disk identity: keep the parameter unknown. */ }
        nativeParameterDiskChecks.set(open, { version: open.version, index: indexIdentity, matches });
        return matches;
    };
    if (project) {
        const files = new Set((project.snapshot?.files || []).map(normalizeFileIndexKey));
        const documents = new Set([document, ...(vscode.workspace.textDocuments || [])
            .filter(open => files.has(normalizeFileIndexKey(open.uri?.fsPath || '')))]);
        for (const open of documents) {
            if (!current(open, lookupNormalizedFileIndex(project.snapshot?.fileIndexes, open.uri?.fsPath))) reason ||= 'parameter-context-stale';
        }
        if (project.referenceIndex?.completenessReasons?.length) reason ||= 'parameter-project-context-incomplete';
    } else if (local && (!current(document, local) || !Array.isArray(local.parameterEvents))) {
        reason ||= 'parameter-context-stale';
    } else if (local && hasIncludeControlBlock(local)) {
        reason ||= 'parameter-project-context-unavailable';
    }
    const previous = nativeParameterContexts.get(document);
    if (previous && previous.version === document.version && previous.source === sourceIdentity && previous.reason === reason) return previous.context;
    const index = reason ? null : project?.referenceIndex || buildProjectReferenceIndex({
        rootFile: path, files: [path], graph: { includeOccurrences: [] }, fileIndexes: new Map([[path, local]]),
    });
    const context = require('./core/semantics/nativeParameterContext').createNativeParameterContext(index, path, document.version, reason || undefined);
    nativeParameterContexts.set(document, { version: document.version, source: sourceIdentity, reason, context });
    return context;
}

function fieldContextForLine(document, lineNum, schema, options: any = {}) {
    const block = findReadyFieldBlock(document, lineNum);
    const keywordLine = Number.isInteger(options.keywordLine) ? options.keywordLine : block?.startLine;
    const result = keywordSchema.readCardContext(document, lineNum, schema, {
        keywordLine, keywordBlockEnd: block && block.startLine === keywordLine ? block.endLine : undefined,
        includeCommentHeaders: options.includeCommentHeaders === true,
        cancellationToken: options.cancellationToken,
    });
    if (result.status === 'resolved' && (result.context.currentText.includes('&') || result.context.observedDataLines.some(text => text.includes('&')))) {
        result.context.parameterContext = nativeParameterContextForDocument(document);
    }
    return result;
}

async function getCardInfoForDocumentLineWithSuggestAsync(document, lineNum, schema, options: any = {}) {
    const version = document.version;
    for (;;) {
        if (options.cancellationToken?.isCancellationRequested) return { cardInfo: null, reason: 'field-context-cancelled' };
        if (document.version !== version) return { cardInfo: null, reason: 'field-context-version-changed' };
        const result = getCardInfoForDocumentLineWithSuggest(document, lineNum, schema, options);
        if (document.version !== version) return { cardInfo: null, reason: 'field-context-version-changed' };
        if (result.reason !== 'field-context-checkpoint-pending') return result;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

function findReadyFieldBlock(document, lineNum) {
    const blocks = getReadyKeywordBlocksForDocument(document, { allowDiskSnapshot: false });
    if (!blocks) return null;
    let low = 0, high = blocks.length - 1;
    let candidate = null;
    while (low <= high) {
        const middle = (low + high) >>> 1;
        if (blocks[middle].startLine < lineNum) { candidate = blocks[middle]; low = middle + 1; }
        else high = middle - 1;
    }
    return candidate && lineNum <= candidate.endLine ? candidate : null;
}

function findEnclosingKeywordLine(document, lineNum, options: any = {}) {
    if (!document || lineNum <= 0 || lineNum >= document.lineCount) return null;
    if (!isActiveLsdynaSemanticLocation(document, { line: lineNum, character: 0 })) return null;

    // Project scans already provide block starts. A live edit can only reuse the
    // indexed position when the keyword still exists there with the same name.
    const blocks = getReadyKeywordBlocksForDocument(document, { allowDiskSnapshot: false });
    if (Array.isArray(blocks) && blocks.length > 0) {
        let low = 0;
        let high = blocks.length - 1;
        let candidateBlock = null;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const start = blocks[middle]?.startLine;
            if (!Number.isInteger(start)) break;
            if (start < lineNum) {
                candidateBlock = blocks[middle];
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        const candidate = candidateBlock?.startLine;
        if (Number.isInteger(candidate) && candidate >= 0 && candidate < document.lineCount) {
            if (Number.isInteger(candidateBlock?.endLine) && lineNum <= candidateBlock.endLine) {
                const current = classifyKeywordLine(document.lineAt(candidate).text);
                const expected = classifyKeywordLine(String(candidateBlock?.keyword || ''));
                if (
                    current.isKeyword &&
                    (!expected.isKeyword || current.normalizedKeyword === expected.normalizedKeyword)
                ) return candidate;
            }
        }
    }

    if (options.indexedOnly) return null;
    const minimumLine = Math.max(0, lineNum - 256);
    let kwLine = null;
    for (let i = lineNum - 1; i >= minimumLine; i--) {
        if (isKeywordLineText(document.lineAt(i).text)) { kwLine = i; break; }
    }
    return typeof kwLine === 'number' ? kwLine : null;
}

function getCardInfoForKnownKeywordLine(document, lineNum, keywordLine, schema, keywordText = null) {
    const context = fieldContextForLine(document, lineNum, schema, { keywordLine });
    return context.status === 'resolved'
        ? keywordSchema.resolveCardFromContext(context.context, schema).cardInfo || null : null;
}

function getCardInfoForLine(document, lineNum) {
    const text = document?.lineAt(lineNum)?.text || '';
    if (!isActiveLsdynaSemanticLocation(document, { line: lineNum, character: text.length })) return null;
    return getCardInfoForKnownKeywordLine(document, lineNum, null, getFieldData());
}

const globalInputFormatCache = new WeakMap();

function documentGlobalInputFormat(document) {
    if (!document) return 'standard';
    const cached = globalInputFormatCache.get(document);
    if (cached && cached.version === document.version) return cached.mode;

    let mode = 'standard';
    const maxScan = Math.min(document.lineCount, 200);
    for (let i = 0; i < maxScan; i++) {
        const text = document.lineAt(i).text;
        if (!isKeywordLineText(text)) continue;
        const kw = classifyKeywordLine(text).normalizedKeyword;
        if (kw === '*KEYWORD') {
            mode = globalInputFormatFromKeywordLine(text, mode);
        }
        // First keyword line decides whether a deck header is present.
        break;
    }

    globalInputFormatCache.set(document, { version: document.version, mode });
    return mode;
}

function keywordUsesNonStandardInputFormat(document, keywordText) {
    return keywordInputFormat(keywordText, documentGlobalInputFormat(document)) !== 'standard';
}

const {
    getKeywordSemanticAdvice,
    predicateFieldsForCardAdvice,
} = require('./core/semantics/manualSemanticAdvisor');

const {
    buildSemanticDocumentContext,
} = require('./core/semantics/semanticDocumentContext');

const {
    getManualSemanticCatalog,
} = require('./core/semantics/manualSemanticCatalog');

const {
    getRelaxedModelEvidenceV1Catalog,
} = require('./core/semantics/relaxedModelEvidenceV1');

const {
    resolveProvisionalFieldHelp,
} = require('./core/semantics/provisionalFieldHelp');

const {
    SemanticEvidenceResolver,
} = require('./core/semantics/semanticEvidenceResolver');

const {
    semanticEvidenceTargets,
    semanticEvidenceTargetLabel,
} = require('./core/semantics/semanticEvidencePresentation');

const {
    DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
    KeywordStructureCatalog,
    analyzeKeywordStructureLines,
} = require('./core/structure');

const semanticEvidenceResolver = new SemanticEvidenceResolver();

const keywordStructureCatalog = new KeywordStructureCatalog();

const KEYWORD_STRUCTURE_DOCUMENT_CACHE_MAX_BYTES = 2 * 1024 * 1024;

const KEYWORD_STRUCTURE_DOCUMENT_CACHE_MAX_ENTRIES = 64;

let keywordStructureAnalysisCache = new WeakMap();

function estimateKeywordStructureAnalysisBytes(result) {
    const block = result?.block;
    let bytes = 512 + 2 * String(result?.keyword || '').length;
    for (const record of block?.records || []) {
        bytes += 192 + 2 * String(record?.text || '').length;
        for (const comment of record?.comments || []) {
            bytes += 96 + 2 * String(comment?.text || '').length;
        }
    }
    for (const comment of block?.trailingComments || []) {
        bytes += 96 + 2 * String(comment?.text || '').length;
    }
    for (const metadata of block?.preprocessorMetadata || []) {
        bytes += 64 + 2 * String(metadata?.text || '').length;
    }
    for (const collection of [
        result?.diagnostics,
        result?.alternativeDiagnostics,
        result?.dependencies,
        result?.repairCandidates,
        result?.details,
    ]) {
        if (!collection) continue;
        try {
            bytes += 2 * JSON.stringify(collection).length;
        } catch (_error) {
            return KEYWORD_STRUCTURE_DOCUMENT_CACHE_MAX_BYTES + 1;
        }
    }
    return Math.max(512, bytes);
}

function getCachedKeywordStructureAnalysis(document, key) {
    const cache = keywordStructureAnalysisCache.get(document);
    const entry = cache?.values?.get(key);
    if (!entry) return null;
    cache.values.delete(key);
    cache.values.set(key, entry);
    return entry.result;
}

function cacheKeywordStructureAnalysis(document, key, result) {
    const bytes = estimateKeywordStructureAnalysisBytes(result);
    if (bytes > KEYWORD_STRUCTURE_DOCUMENT_CACHE_MAX_BYTES) return;
    let cache = keywordStructureAnalysisCache.get(document);
    if (!cache) {
        cache = { bytes: 0, values: new Map() };
        keywordStructureAnalysisCache.set(document, cache);
    }
    const previous = cache.values.get(key);
    if (previous) {
        cache.bytes -= previous.bytes;
        cache.values.delete(key);
    }
    cache.values.set(key, { bytes, result });
    cache.bytes += bytes;
    while (cache.values.size > KEYWORD_STRUCTURE_DOCUMENT_CACHE_MAX_ENTRIES ||
        cache.bytes > KEYWORD_STRUCTURE_DOCUMENT_CACHE_MAX_BYTES) {
        const oldestKey = cache.values.keys().next().value;
        const oldest = cache.values.get(oldestKey);
        cache.values.delete(oldestKey);
        cache.bytes -= oldest?.bytes || 0;
    }
}

function buildProvisionalManualContext(field, context: any = {}) {
    const keyword = context.keyword || context.keywordName;
    if (!keyword) return null;
    try {
        const structured = getStructuredManualContext(keyword);
        if (!structured || !structured.locations?.length) return null;
        const location = structured.locations[0];
        const chapter = getManualChapterPresentation(structured.repository, location);
        return {
            manualLabel: chapter.manualLabel,
            manualId: location.manualId,
            sectionId: location.sectionId,
            sectionTitle: i18n.getLanguage() === 'zh-cn' ? chapter.titleZh || chapter.titleEn : chapter.titleEn,
            pdfPage: chapter.pdfPage,
            keyword,
            cardIndex: context.cardIndex,
            fieldName: field?.n,
            position: field?.p,
            width: field?.w,
        };
    } catch (_error) {
        return null;
    }
}

const keywordSemanticAdviceCache = new WeakMap();

let cardEditKeywordIndexProviderRef = null;

function getKeywordSemanticAdviceForDocument(document, keywordLine, lookup = null) {
    if (!lookup && document && Number.isInteger(keywordLine)) lookup = lookupKeywordInfo(document.lineAt(keywordLine).text.trim());
    if (!document || !lookup || !Number.isInteger(keywordLine)) return null;
    const version = Number.isInteger(document.version) ? document.version : null;
    const cached = version === null ? null : keywordSemanticAdviceCache.get(document);
    const parameterContext = nativeParameterContextForDocument(document);
    const cacheKey = `${keywordLine}:${lookup.canonicalName}:${(lookup.activeOptions || []).join(',')}`;
    if (cached && cached.version === version && cached.key === cacheKey && cached.parameterContext === parameterContext) return cached.advice;

    let advice;
    try {
        const catalogKeyword = `*${lookup.canonicalName}`;
        const optionContext = { keywordOptions: (lookup.activeOptions || []).slice() };
        const initial = getKeywordSemanticAdvice(catalogKeyword, optionContext);
        const predicateFields = predicateFieldsForCardAdvice(initial.cards);
        advice = { ...initial, contextReason: 'unsupported-format', unresolvedFields: predicateFields };

        // Fixed-width offsets are unsafe in effective long/I10 input. The current
        // keyword's `-` override can restore standard geometry under a long deck.
        const keywordText = String(document.lineAt(keywordLine).text || '');
        if (predicateFields.length > 0 &&
            !keywordUsesNonStandardInputFormat(document, keywordText)) {
            const built = buildSemanticDocumentContext(
                document,
                keywordLine,
                getFieldData(),
                predicateFields,
                { globalInputFormat: documentGlobalInputFormat(document), parameterContext },
            );
            if (built.catalogKeyword === catalogKeyword) {
                advice = { ...getKeywordSemanticAdvice(catalogKeyword, built.context),
                    contextReason: built.truncated ? 'scan-truncated' : built.unsupportedFormat ? 'unsupported-format' : 'field-unresolved',
                    unresolvedFields: built.unresolvedFields || [] };
            }
        }
    } catch (_error) {
        // Hover advice is auxiliary. A missing/corrupt optional catalog must not
        // interrupt ordinary field help or editing.
        return null;
    }

    if (version !== null) keywordSemanticAdviceCache.set(document, {
        version,
        key: cacheKey,
        parameterContext,
        advice,
    });
    return advice;
}

function inlineSemanticLabel(value) {
    return `\`${String(value || '').replace(/`/g, "'")}\``;
}

function semanticApplicabilityPresentation(applicability) {
    if (applicability === 'applicable') {
        return { icon: '$(pass-filled)', label: i18n.get('semanticApplicable') };
    }
    if (applicability === 'not-applicable') {
        return { icon: '$(circle-slash)', label: i18n.get('semanticNotApplicable') };
    }
    return { icon: '$(question)', label: i18n.get('semanticIndeterminate') };
}

function semanticEvidencePageLinks(keyword, items, options: any = {}) {
    let summary = options.catalogSummary;
    if (summary === undefined) {
        try { summary = getManualSemanticCatalog().summary(); } catch (_error) { summary = null; }
    }
    const currentAuthority = options.currentAuthority !== undefined
        ? options.currentAuthority
        : manualPackManagerRef
            ? manualPackManagerRef.peekCurrentAuthority()
            : undefined;
    const targets = semanticEvidenceTargets(
        items,
        currentAuthority,
        summary?.evidenceAuthority || null,
    );
    return targets.map(target => {
        const args = encodeURIComponent(JSON.stringify([{
            keyword,
            ruleId: target.ruleId,
            evidenceId: target.evidenceId,
        }]));
        return `[$(file-pdf) ${semanticEvidenceTargetLabel(target)}]` +
            `(command:extension.openSemanticEvidence?${args} "${i18n.get('openSemanticEvidence')}")`;
    });
}

function semanticEvidenceLocationPresentation(evidence, ruleId = 'presentation') {
    let summary;
    try { summary = getManualSemanticCatalog().summary(); } catch (_error) { return null; }
    const currentAuthority = manualPackManagerRef
        ? manualPackManagerRef.peekCurrentAuthority()
        : undefined;
    return semanticEvidenceTargets(
        [{ ruleId, evidence: [evidence] }],
        currentAuthority,
        summary?.evidenceAuthority || null,
    )[0] || null;
}

function buildControlConditionMarkdown(document, keywordLine, fieldNames) {
    const advice = getKeywordSemanticAdviceForDocument(document, keywordLine);
    const names = new Set(fieldNames.map(name => String(name).toUpperCase()));
    return groupConditionalAdvice(advice).filter(group => group.fields.some(name => names.has(name.toUpperCase())))
        .map(group => `${inlineSemanticLabel(group.condition || group.cards.join(', '))} → ${group.cards.map(inlineSemanticLabel).join(', ')} · ${semanticApplicabilityPresentation(group.applicability).label}`)
        .join('\n\n');
}

function buildKeywordSemanticAdviceMarkdown(advice) {
    if (!advice) return '';
    const optionSlots = Array.isArray(advice.optionSlots) ? advice.optionSlots : [];
    if (optionSlots.length === 0) return '';

    const lines = ['---'];
    if (optionSlots.length > 0) {
        lines.push(`**${i18n.get('officialKeywordOptionSlots')}:**`);
        const isZh = i18n.getLanguage() === 'zh-cn';
        for (const slot of optionSlots) {
            const requirement = slot.required
                ? i18n.get('semanticRequired')
                : i18n.get('semanticOptional');
            let summaryText = slot.summary;
            if (isZh) {
                const localized = keywordSchema.getLocalizedHelpForText(slot.summary);
                if (localized) {
                    const id = stashFieldHelpEnglish(slot.summary);
                    const originalLink = `[${i18n.get('fieldHelpEnglishOriginal')}](command:extension.showFieldHelpEnglish?${encodeURIComponent(JSON.stringify([id]))})`;
                    summaryText = `${localized} · ${originalLink}`;
                } else {
                    summaryText = `${slot.summary} *(${i18n.get('fieldHelpUntranslatedInline')})*`;
                }
            }
            lines.push(`- ${inlineSemanticLabel(slot.slot)} — **${requirement}** · ${summaryText}`);
        }
    }

    const evidencePages = semanticEvidencePageLinks(advice.keyword, optionSlots);
    if (evidencePages.length > 0) {
        lines.push('', evidencePages.join(' · '));
    }
    return lines.join('\n');
}

function readyCardEditBlockIndex(document, provider = cardEditKeywordIndexProviderRef) {
    if (!provider || typeof provider.getDocumentBlockIndexIfReady !== 'function') return null;
    try {
        return provider.getDocumentBlockIndexIfReady(document);
    } catch (_error) {
        return null;
    }
}

function semanticEvidenceFailureMessage(status) {
    if (status === 'pdf-integrity-mismatch') {
        return i18n.get('semanticEvidencePdfMismatch');
    }
    return i18n.get('semanticEvidenceUnavailable');
}

async function handleOpenSemanticEvidenceCommand(context, request, options: any = {}) {
    const resolver = options.resolver || semanticEvidenceResolver;
    const catalog = options.catalog || getManualSemanticCatalog();
    const packRoot = options.manualPackRoot || resolveManualPackRoot(context);
    const openPdf = options.openPdf || openManualPdf;
    const result = await resolver.resolve(request, catalog, packRoot);
    if (result.status === 'resolved') {
        openPdf(context, result.pdfPath, result.page);
        return result;
    }
    if (options.showMessage !== false) {
        vscode.window.showWarningMessage(semanticEvidenceFailureMessage(result.status));
    }
    return result;
}

function keywordOptionIsSupported(option, canonicalName) {
    if (parseKeywordOptionOrder(option).position !== 'pre') return true;
    return keywordSchema.keywordPrefixOptionDecision(
        canonicalName,
        normalizeOptionName(option.n),
    ) !== 'deny';
}

function supportedKeywordOptions(entry, canonicalName) {
    return (entry.o || []).filter(option => keywordOptionIsSupported(option, canonicalName));
}

const MAXIMUM_PREFIX_CARD_POSITION_LINES = 32;

function collectBoundedPrefixDataRecords(document, keywordLine) {
    const records = [];
    const end = Math.min(
        document.lineCount,
        keywordLine + MAXIMUM_PREFIX_CARD_POSITION_LINES + 1,
    );
    for (let line = keywordLine + 1; line < end && records.length < 8; line++) {
        const text = String(document.lineAt(line).text || '');
        if (classifyKeywordLine(text).isKeyword) break;
        if (isKeywordCommentLine(text)) continue;
        records.push({ text, line });
    }
    return records;
}

function cardCommentNoticeAppliesToField(notice, field) {
    if (!notice) return false;
    if (notice.kind !== 'definition-mismatch') return false;
    if (!field) return true;
    return notice.differences.some(difference =>
        difference.position === field.p && difference.width === field.w,
    );
}

const CARD_COMMENT_REWRITE_MAX_PHYSICAL_LINES = 256;

const CARD_COMMENT_REWRITE_MAX_DATA_LINES = 64;

const KEYWORD_STRUCTURE_HOVER_MAX_PHYSICAL_LINES = 32;

function cardCommentRewriteRequest(document, keywordLine, line) {
    const uri = documentUriIdentity(document);
    if (!uri || !Number.isInteger(keywordLine) || !Number.isInteger(line) ||
        !Number.isInteger(document?.version)) return null;
    return { uri, keywordLine, line, documentVersion: document.version };
}

function buildCardCommentNoticeMarkdown(cardInfo, document, keywordLine, line, field = null) {
    const notice = cardInfo?.cardCommentNotice;
    if (!cardCommentNoticeAppliesToField(notice, field)) return '';
    const request = cardCommentRewriteRequest(document, keywordLine, line);
    const label = i18n.get(
        notice.kind === 'definition-mismatch'
            ? 'cardCommentVersionHint'
            : 'cardCommentShiftHint',
    );
    if (!request) return `$(info) ${label}`;
    const args = encodeURIComponent(JSON.stringify([request]));
    const action = i18n.get(
        notice.kind === 'definition-mismatch'
            ? 'cardCommentUpdateCurrentAction'
            : 'cardCommentRebuildAction',
    );
    const tooltip = i18n.get(
        notice.kind === 'definition-mismatch'
            ? 'cardCommentUpdateCurrentTooltip'
            : 'cardCommentRebuildTooltip',
    );
    return `$(info) ${label} &nbsp;·&nbsp; ` +
        `[$(wrench) ${action}]` +
        `(command:extension.rebuildCardComments?${args} "${tooltip}")`;
}

function boundedCardCommentRewriteEnd(document, keywordLine, options: any = {}) {
    const maximumPhysicalLines = Number.isFinite(options.maximumPhysicalLines)
        ? Math.max(1, Math.floor(Number(options.maximumPhysicalLines)))
        : CARD_COMMENT_REWRITE_MAX_PHYSICAL_LINES;
    const blockIndex = options.blockIndex !== undefined
        ? options.blockIndex
        : readyCardEditBlockIndex(document, options.keywordIndexProvider);
    const indexed = blockIndex && blockIndex.lineCount === document.lineCount
        ? blockIndex.findBlockAtLine?.(keywordLine)
        : null;
    if (indexed && indexed.startLine === keywordLine && Number.isInteger(indexed.endLine)) {
        if (indexed.endLine - keywordLine > maximumPhysicalLines) return null;
        return Math.min(indexed.endLine, document.lineCount - 1);
    }

    const lastBudgetLine = Math.min(
        document.lineCount - 1,
        keywordLine + maximumPhysicalLines,
    );
    let endLine = keywordLine;
    for (let line = keywordLine + 1; line <= lastBudgetLine; line++) {
        const text = String(document.lineAt(line).text || '');
        if (classifyKeywordLine(text).isKeyword) return line - 1;
        endLine = line;
    }
    return endLine === document.lineCount - 1 ? endLine : null;
}

function analyzeKeywordStructureForDocument(document, keywordLine, options: any = {}): any {
    const currentAuthority = manualPackManagerRef?.peekCurrentAuthority?.();
    const profileSelection = options.sourceProfileId !== undefined
        ? { sourceProfileId: options.sourceProfileId, origin: 'explicit' }
        : currentAuthority?.sourceProfileId
            ? { sourceProfileId: currentAuthority.sourceProfileId, origin: 'manual-pack' }
            : {
                sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
                origin: 'builtin-default',
            };
    const { sourceProfileId } = profileSelection;
    const fail = (reason, keyword = '') => ({
        status: 'unsupported-input',
        reason,
        keyword,
        sourceProfileId: sourceProfileId || undefined,
        sourceProfileOrigin: profileSelection.origin,
        observedDataRecords: 0,
        records: [],
        diagnostics: [],
        dependencies: [],
        repairCandidates: [],
        keywordLine,
    });
    if (!document || !Number.isInteger(keywordLine) || keywordLine < 0 ||
        keywordLine >= document.lineCount) {
        return fail('invalid-keyword-line');
    }
    if (options.expectedDocumentVersion !== undefined &&
        document.version !== options.expectedDocumentVersion) {
        return fail('document-version-changed');
    }
    const keywordText = String(document.lineAt(keywordLine).text || '');
    const classification = classifyKeywordLine(keywordText);
    if (!classification.isKeyword || keywordInputFormat(
        keywordText,
        options.globalInputFormat || documentGlobalInputFormat(document),
    ) !== 'standard') {
        return fail('keyword-or-input-format-unavailable', classification.normalizedKeyword || '');
    }
    const catalog = options.catalog || keywordStructureCatalog;
    let verifiedBinding = null;
    if (typeof catalog?.lookupBinding === 'function') {
        const binding = catalog.lookupBinding(sourceProfileId, classification.normalizedKeyword);
        if (binding?.status !== 'verified') {
            return {
                ...fail(binding?.reason || 'binding-not-verified', classification.normalizedKeyword),
                status: binding?.status === 'unsupported-input'
                    ? 'unsupported-input'
                    : 'profile-unverified',
                bindingStatus: binding?.binding?.status,
                details: binding?.binding?.details,
            };
        }
        verifiedBinding = binding;
    }
    const maximumPhysicalLines = Number.isFinite(options.maximumPhysicalLines)
        ? Math.max(1, Math.floor(Number(options.maximumPhysicalLines)))
        : KEYWORD_STRUCTURE_HOVER_MAX_PHYSICAL_LINES;
    const endLine = boundedCardCommentRewriteEnd(document, keywordLine, {
        ...options,
        maximumPhysicalLines,
    });
    if (!Number.isInteger(endLine)) return fail('block-line-limit', classification.normalizedKeyword);
    const cacheKey = JSON.stringify([
        Number.isInteger(document.version) ? document.version : null,
        keywordLine,
        endLine,
        sourceProfileId,
        profileSelection.origin,
        verifiedBinding?.binding?.grammarId || null,
        maximumPhysicalLines,
    ]);
    const cacheEligible = !options.bypassCache && !options.catalog && !options.context &&
        !options.schema && !options.budgets && options.globalInputFormat === undefined &&
        Number.isInteger(document.version);
    if (cacheEligible) {
        const cached = getCachedKeywordStructureAnalysis(document, cacheKey);
        if (cached) return cached;
    }
    const bodyLines = [];
    for (let line = keywordLine + 1; line <= endLine; line++) {
        const text = String(document.lineAt(line).text || '');
        if (classifyKeywordLine(text).isKeyword) return fail('keyword-block-changed', classification.normalizedKeyword);
        bodyLines.push({ line, text });
    }
    const schema = options.schema || getFieldData();
    const lookup = keywordSchema.lookupKeywordSchema(classification.normalizedKeyword, schema);
    const context = {
        ...(options.context || {}),
        keywordOptions: options.context?.keywordOptions || lookup?.activeOptions || [],
    };
    const analysis = analyzeKeywordStructureLines(keywordText, bodyLines, {
        catalog,
        sourceProfileId,
        context,
        keywordLine,
        maximumPhysicalLines,
        budgets: {
            maximumRecords: CARD_COMMENT_REWRITE_MAX_DATA_LINES,
            ...(options.budgets || {}),
        },
    });
    const result = {
        ...analysis,
        lookup,
        endLine,
        sourceProfileOrigin: profileSelection.origin,
        records: analysis.block?.records || analysis.records,
        observedDataLines: analysis.block?.records?.map(record => record.text) || [],
    };
    if (cacheEligible) {
        cacheKeywordStructureAnalysis(document, cacheKey, result);
    }
    return result;
}

function keywordStructureDiagnosticIdentity(analysis) {
    if (!analysis?.grammarId || !Array.isArray(analysis.repairCandidates) ||
        analysis.repairCandidates.length === 0) return '';
    return JSON.stringify({
        grammarId: analysis.grammarId,
        diagnostics: (analysis.diagnostics || []).map(edit => [
            edit.kind,
            edit.observedIndex,
            edit.expectedIndex,
            edit.nodeId,
        ]),
        repairs: analysis.repairCandidates.map(candidate => [
            candidate.insertionRecordIndex,
            candidate.nodeId,
        ]),
    });
}

function keywordStructureRepairRequest(document, keywordLine, line, analysis) {
    const base = cardCommentRewriteRequest(document, keywordLine, line);
    const diagnosticIdentity = keywordStructureDiagnosticIdentity(analysis);
    if (!base || !analysis?.sourceProfileId || !analysis?.grammarId || !diagnosticIdentity) return null;
    return {
        ...base,
        sourceProfileId: analysis.sourceProfileId,
        grammarId: analysis.grammarId,
        diagnosticIdentity,
    };
}

function keywordStructureCheckRequest(document, keywordLine) {
    const uri = documentUriIdentity(document);
    if (!uri || !Number.isInteger(document?.version)) return null;
    return { uri, documentVersion: document.version, keywordLine };
}

function keywordStructureCheckLink(document, keywordLine) {
    const request = keywordStructureCheckRequest(document, keywordLine);
    if (!request) return '';
    const args = encodeURIComponent(JSON.stringify([request]));
    return `[$(inspect) ${i18n.get('keywordStructureCheckAction')}]` +
        `(command:extension.checkKeywordStructure?${args} "${i18n.get('keywordStructureCheckTooltip')}")`;
}

function keywordStructureDefiniteLabel(analysis) {
    const count = analysis?.diagnostics?.length || 0;
    if (analysis?.reason === 'missing-required-records') {
        const labels = [...new Set((analysis.diagnostics || []).map(edit => edit.cardLabel).filter(Boolean))];
        return labels.length > 0
            ? i18n.get('keywordStructureMissingNamed', labels.join(', '))
            : i18n.get('keywordStructureMissingCount', count);
    }
    if (analysis?.reason === 'extra-records') return i18n.get('keywordStructureExtraCount', count);
    return i18n.get('keywordStructureDefiniteMismatch');
}

function buildKeywordStructureIssueMarkdown(analysis, document, keywordLine, line, options: any = {}) {
    if (!analysis || analysis.status === 'valid' || analysis.status === 'profile-unverified' ||
        analysis.status === 'unsupported-input') return '';
    const checkLink = keywordStructureCheckLink(document, keywordLine);
    if (analysis.status === 'context-dependent') {
        return `$(question) ${i18n.get('keywordStructureContextDependent')}` +
            (checkLink ? ` &nbsp;·&nbsp; ${checkLink}` : '');
    }
    if (analysis.status === 'ambiguous') {
        return `$(info) ${i18n.get('keywordStructureAmbiguous')}` +
            (checkLink ? ` &nbsp;·&nbsp; ${checkLink}` : '');
    }
    if (analysis.status === 'definite-error') {
        const label = keywordStructureDefiniteLabel(analysis);
        const request = options.allowRepair === false
            ? null
            : keywordStructureRepairRequest(document, keywordLine, line, analysis);
        let markdown = `$(warning) ${label}`;
        if (checkLink) markdown += ` &nbsp;·&nbsp; ${checkLink}`;
        if (!request) return markdown;
        const args = encodeURIComponent(JSON.stringify([request]));
        const action = i18n.get('keywordStructureInsertBlankRecords', analysis.repairCandidates.length);
        const tooltip = i18n.get(
            'keywordStructureInsertBlankRecordsTooltip',
            analysis.repairCandidates.length,
            analysis.observedDataRecords,
            analysis.expectedDataRecords,
        );
        markdown += ` &nbsp;·&nbsp; [$(add) ${action}]` +
            `(command:extension.insertVerifiedMissingRecords?${args} "${tooltip}")`;
        return markdown;
    }
    return '';
}

function keywordStructureCheckMessage(analysis) {
    let message;
    if (analysis.status === 'valid') {
        message = i18n.get('keywordStructureCheckValid', analysis.observedDataRecords);
    } else if (analysis.status === 'definite-error') {
        message = keywordStructureDefiniteLabel(analysis);
    } else if (analysis.status === 'context-dependent') {
        message = i18n.get('keywordStructureContextDependent');
    } else if (analysis.status === 'ambiguous') {
        message = i18n.get('keywordStructureAmbiguous');
    } else if (analysis.status === 'profile-unverified') {
        message = i18n.get('keywordStructureCheckProfileUnverified', analysis.reason);
    } else {
        message = i18n.get('keywordStructureCheckUnsupported', analysis.reason);
    }
    return analysis.sourceProfileOrigin === 'builtin-default'
        ? `${message} · ${i18n.get('keywordStructureCheckBundledProfile')}`
        : message;
}

async function handleCheckKeywordStructureCommand(request = null, options: any = {}) {
    const editor = options.editor || vscode.window.activeTextEditor;
    const document = editor?.document;
    const positionLine = Number.isInteger(editor?.selection?.active?.line)
        ? editor.selection.active.line
        : 0;
    const blockIndex = document
        ? options.blockIndex !== undefined
            ? options.blockIndex
            : readyCardEditBlockIndex(document, options.keywordIndexProvider)
        : null;
    let keywordLine = Number.isInteger(request?.keywordLine) ? request.keywordLine : null;
    if (!Number.isInteger(keywordLine) && document) {
        const indexed = blockIndex?.lineCount === document.lineCount
            ? blockIndex.findBlockAtLine?.(positionLine)
            : null;
        if (Number.isInteger(indexed?.startLine)) {
            keywordLine = indexed.startLine;
        } else {
            const minimumLine = Math.max(
                0,
                positionLine - CARD_COMMENT_REWRITE_MAX_PHYSICAL_LINES,
            );
            for (let line = positionLine; line >= minimumLine; line--) {
                if (isKeywordLineText(document.lineAt(line).text)) {
                    keywordLine = line;
                    break;
                }
            }
        }
    }
    if (!document || !isLsdynaFile(document) || !Number.isInteger(keywordLine) || keywordLine < 0 ||
        keywordLine >= document.lineCount ||
        !isKeywordLineText(document.lineAt(keywordLine).text) ||
        (request && (
            Object.keys(request).sort().join(',') !== 'documentVersion,keywordLine,uri' ||
            request.uri !== documentUriIdentity(document) ||
            request.documentVersion !== document.version
        ))) {
        (options.showInformationMessage || vscode.window.showInformationMessage)(
            i18n.get('keywordStructureRepairStale'),
        );
        return null;
    }
    const analysis = analyzeKeywordStructureForDocument(document, keywordLine, {
        ...options,
        bypassCache: true,
        maximumPhysicalLines: CARD_COMMENT_REWRITE_MAX_PHYSICAL_LINES,
        blockIndex,
    });
    keywordStructureDiagnosticsRef?.publishManual(document, keywordLine, analysis, document.version);
    const message = keywordStructureCheckMessage(analysis);
    if (analysis.status === 'definite-error') {
        (options.showWarningMessage || vscode.window.showWarningMessage)(message);
    } else {
        (options.showInformationMessage || vscode.window.showInformationMessage)(message);
    }
    return analysis;
}

function buildPrefixLayoutIssueMarkdown(status, unsupportedOptions = []) {
    if (status === 'unsupported-option') {
        const options = unsupportedOptions.length
            ? unsupportedOptions.map(option => `\`${option}\``).join(', ')
            : i18n.get('keywordHoverOptions');
        return `$(warning) ${i18n.get('keywordPrefixOptionUnsupported', options)}`;
    }
    if (status === 'unverified') {
        return `$(warning) ${i18n.get('keywordPrefixLayoutUnavailable')}`;
    }
    return '';
}

const { createOfficialFieldChoicePicker } = require('./client/services/officialFieldChoicePicker');

const {
    createActiveFieldChoiceController,
    officialFieldChoiceCommandRequest,
} = require('./client/services/activeFieldChoiceController');

const {
    planLsdynaFormatting,
    mapPositionThroughFormattingEdits,
} = require('./client/services/lsdynaFormatting');

const {
    planLineCommentToggle: planLineCommentTogglePure,
    LINE_COMMENT_TOGGLE_LIMITS,
} = require('./core/edit/lineCommentToggle');

const {
    planOfficialFieldChoices,
} = require('./core/semantics/officialFieldChoicePlanner');

const {
    planVerifiedConditionalCards,
} = require('./core/semantics/cardEditPlanner');

function buildOfficialFieldChoiceHoverMarkdown(plan, document) {
    if (plan?.status !== 'ready' || !plan.fieldRange || !Array.isArray(plan.choices) ||
        plan.choices.length === 0) {
        return '';
    }
    const request = officialFieldChoiceCommandRequest(
        document,
        {
            line: plan.fieldRange.line,
            character: plan.fieldRange.startCharacter,
        },
        documentUriIdentity,
    );
    if (!request) return '';
    const args = encodeURIComponent(JSON.stringify([request]));
    const closed = plan.domainKind === 'closed';
    const action = i18n.get(
        closed ? 'officialFieldChoiceHoverClosedAction' : 'officialFieldChoiceHoverMixedAction',
    );
    const tooltip = i18n.get(
        closed ? 'officialFieldChoiceHoverClosedTooltip' : 'officialFieldChoiceHoverMixedTooltip',
    );
    const items = [
        `[$(list-selection) ${action}](command:extension.pickOfficialFieldValue?${args} "${tooltip}")`,
    ];
    if (!closed) {
        items.push(`$(info) ${i18n.get('officialFieldChoiceHoverMixedIncomplete')}`);
    }
    const evidenceLinks = semanticEvidencePageLinks(plan.catalogKeyword, [{
        ruleId: plan.ruleId,
        evidence: plan.evidence,
    }]);
    if (evidenceLinks.length > 0) {
        items.push(...evidenceLinks);
    }
    return items.join(' &nbsp;·&nbsp; ');
}

function cardNumbersLabel(cards, isZh = i18n.getLanguage() === 'zh-cn') {
    const numbers = (Array.isArray(cards) ? cards : [])
        .map(card => Number(card?.physicalCardIndex))
        .filter(Number.isInteger)
        .sort((left, right) => left - right);
    if (numbers.length === 0) return '';
    const prefix = isZh ? '卡片 ' : (numbers.length === 1 ? 'Card ' : 'Cards ');
    if (numbers.length === 1) return `${prefix}${numbers[0]}`;
    const contiguous = numbers.every((value, index) => index === 0 || value === numbers[index - 1] + 1);
    return contiguous
        ? `${prefix}${numbers[0]}–${numbers[numbers.length - 1]}`
        : `${prefix}${numbers.join(isZh ? '、' : ', ')}`;
}

function buildVerifiedConditionalCardEditMarkdown(plan, document, keywordLine) {
    if (plan?.status !== 'ready' || !plan.insertion || !Array.isArray(plan.cardsToAppend) ||
        plan.cardsToAppend.length === 0) {
        return '';
    }
    const uri = documentUriIdentity(document);
    if (!uri || !Number.isInteger(keywordLine) || !Number.isInteger(document?.version) ||
        !plan.layoutId || !plan.ruleId) {
        return '';
    }
    const requiredPredecessors = plan.cardsToAppend.filter(card => card.relation === 'required-predecessor');
    const conditionalCards = plan.cardsToAppend.filter(card => card.relation === 'conditional');
    const payload = {
        uri,
        keywordLine,
        documentVersion: document.version,
        layoutId: plan.layoutId,
        ruleId: plan.ruleId,
    };
    const args = encodeURIComponent(JSON.stringify([payload]));
    const lines = [
        '---',
        `#### $(add) ${i18n.get('verifiedCardEditSection')}`,
        '',
        `- ${i18n.get('verifiedCardEditWillAppend', inlineSemanticLabel(cardNumbersLabel(plan.cardsToAppend)))}`,
    ];
    if (requiredPredecessors.length > 0) {
        lines.push(`- ${i18n.get(
            'verifiedCardEditRequiredPredecessors',
            inlineSemanticLabel(cardNumbersLabel(requiredPredecessors)),
        )}`);
    }
    if (conditionalCards.length > 0) {
        lines.push(`- ${i18n.get(
            'verifiedCardEditConditionalCards',
            inlineSemanticLabel(cardNumbersLabel(conditionalCards)),
        )}`);
    }
    lines.push(
        `- ${i18n.get('verifiedCardEditBlankOnly')}`,
        `- ${i18n.get('verifiedCardEditLccmpAdvisory')}`,
        '',
        `[$(add) ${i18n.get('verifiedCardEditAction')}](command:extension.addVerifiedConditionalCards?${args} "${i18n.get('verifiedCardEditActionTooltip')}")`,
    );
    return lines.join('\n');
}

function planVerifiedConditionalCardsForDocument(document, keywordLine, options: any = {}) {
    try {
        return (options.plan || planVerifiedConditionalCards)(
            document,
            keywordLine,
            options.schema || getFieldData(),
            {
                globalInputFormat: options.globalInputFormat || documentGlobalInputFormat(document),
                blockIndex: options.blockIndex !== undefined
                    ? options.blockIndex
                    : readyCardEditBlockIndex(document, options.keywordIndexProvider),
                ...(options.expectedDocumentVersion !== undefined
                    ? { expectedDocumentVersion: options.expectedDocumentVersion }
                    : {}),
                ...(options.expectedLayoutId !== undefined
                    ? { expectedLayoutId: options.expectedLayoutId }
                    : {}),
                ...(options.expectedRuleId !== undefined
                    ? { expectedRuleId: options.expectedRuleId }
                    : {}),
            },
        );
    } catch (_error) {
        return null;
    }
}

function showVerifiedCardEditStatus(key, ...args) {
    try {
        vscode.window.setStatusBarMessage(i18n.get(key, ...args), 7000);
    } catch (_error) {
        // Status is best-effort; card editing must remain fail-open.
    }
}

async function handleAddVerifiedConditionalCardsCommand(request, options: any = {}) {
    const editor = options.editor || vscode.window.activeTextEditor;
    const document = editor?.document;
    const editIsCurrent = documentEditGuard.createDocumentEditGuard(document, editor);
    if (!document || !isLsdynaFile(document)) {
        showVerifiedCardEditStatus('verifiedCardEditSourceInactive');
        return null;
    }

    const fromHover = request !== undefined && request !== null;
    let keywordLine;
    let expectedDocumentVersion;
    let expectedLayoutId;
    let expectedRuleId;
    if (fromHover) {
        if (!request || typeof request !== 'object' || Array.isArray(request) ||
            request.uri !== documentUriIdentity(document) ||
            !Number.isInteger(request.keywordLine) ||
            !Number.isInteger(request.documentVersion) ||
            typeof request.layoutId !== 'string' || !request.layoutId ||
            typeof request.ruleId !== 'string' || !request.ruleId ||
            request.documentVersion !== document.version) {
            showVerifiedCardEditStatus('verifiedCardEditSourceInactive');
            return null;
        }
        keywordLine = request.keywordLine;
        expectedDocumentVersion = request.documentVersion;
        expectedLayoutId = request.layoutId;
        expectedRuleId = request.ruleId;
    } else {
        keywordLine = editor.selection?.active?.line;
        if (!Number.isInteger(keywordLine) || keywordLine < 0 || keywordLine >= document.lineCount ||
            !isKeywordLineText(document.lineAt(keywordLine).text)) {
            showVerifiedCardEditStatus('verifiedCardEditUnavailable');
            return null;
        }
    }

    const plan = planVerifiedConditionalCardsForDocument(document, keywordLine, {
        ...options,
        expectedDocumentVersion,
        expectedLayoutId,
        expectedRuleId,
    });
    if (plan?.status !== 'ready' || !plan.insertion ||
        plan.documentVersion !== (Number.isInteger(document.version) ? document.version : null)) {
        showVerifiedCardEditStatus('verifiedCardEditUnavailable');
        return null;
    }

    const insertion = plan.insertion;
    if (!Number.isInteger(insertion.line) || !Number.isInteger(insertion.character) ||
        insertion.line < 0 || insertion.line >= document.lineCount || insertion.character < 0 ||
        typeof insertion.text !== 'string' || insertion.text.length === 0) {
        showVerifiedCardEditStatus('verifiedCardEditUnavailable');
        return null;
    }
    if (!await canApplyDocumentEdit(document, editIsCurrent)) return null;
    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(
        insertion.line,
        insertion.character,
        insertion.line,
        insertion.character,
    );
    edit.replace(document.uri, range, insertion.text);
    try {
        const applyEdit = options.applyEdit || ((workspaceEdit) => vscode.workspace.applyEdit(workspaceEdit));
        const applied = await applyEdit(edit);
        if (!applied) {
            showVerifiedCardEditStatus('verifiedCardEditApplyFailed');
            return null;
        }
    } catch (_error) {
        showVerifiedCardEditStatus('verifiedCardEditApplyFailed');
        return null;
    }

    showVerifiedCardEditStatus('verifiedCardEditApplied', cardNumbersLabel(plan.cardsToAppend));
    return { plan, edit };
}

function showOfficialFieldChoiceStatus(key, ...args) {
    try {
        vscode.window.setStatusBarMessage(i18n.get(key, ...args), 7000);
    } catch (_error) {
        // Status is best-effort; official choices always remain optional.
    }
}

async function handlePickOfficialFieldValueCommand(context, request, options: any = {}) {
    const picker = options.picker || createOfficialFieldChoicePicker({
        vscode: options.vscode || vscode,
        getActiveEditor: options.getActiveEditor || (() => vscode.window.activeTextEditor),
        isLsdynaDocument: options.isLsdynaDocument || isLsdynaFile,
        documentIdentity: options.documentIdentity || documentUriIdentity,
        plan: options.plan || ((document, position, planOptions) =>
            planPreparedOfficialFieldChoices(document, position, planOptions)),
        translate: options.translate || ((key, ...args) => i18n.get(key, ...args)),
        openEnglish: options.openEnglish || (text => vscode.commands.executeCommand(
            'extension.showFieldHelpEnglish', stashFieldHelpEnglish(text))),
        getLanguage: options.getLanguage || (() => i18n.getLanguage()),
        presentEvidence: options.presentEvidence || ((evidence, plan) => {
            const target = semanticEvidenceLocationPresentation(evidence, plan?.ruleId);
            return target ? {
                label: semanticEvidenceTargetLabel(target),
                tooltip: i18n.get(
                    'officialFieldChoiceOpenEvidence',
                    target.manualLabel,
                    target.page,
                ),
            } : null;
        }),
        showStatus: options.showStatus || showOfficialFieldChoiceStatus,
        applyEdit: options.applyEdit,
        pickChoice: options.pickChoice,
        openEvidence: options.openEvidence || (evidenceRequest =>
            handleOpenSemanticEvidenceCommand(context, evidenceRequest)),
    });
    return picker.pick(request);
}

const CARD_COMMENT_REWRITE_MAX_EDITS = 64;

const CARD_COMMENT_REWRITE_MAX_TEXT_BYTES = 16 * 1024;

function cardCommentLabelCase(text) {
    const letters = String(text || '').match(/[A-Za-z]/g) || [];
    let upper = 0;
    let lower = 0;
    for (const letter of letters) {
        if (letter === letter.toUpperCase()) upper++;
        if (letter === letter.toLowerCase()) lower++;
    }
    return upper > lower ? 'upper' : 'lower';
}

function mostCommonCardCommentValue(values, fallback) {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    let best = fallback;
    let bestCount = 0;
    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value;
            bestCount = count;
        }
    }
    return best;
}

function planCardCommentRewriteForDocument(document, keywordLine, options: any = {}): any {
    const unsupported = reason => ({ status: 'unsupported', reason, edits: [] });
    if (!document || !Number.isInteger(keywordLine) || keywordLine < 0 ||
        keywordLine >= document.lineCount) return unsupported('invalid-keyword-line');
    if (options.expectedDocumentVersion !== undefined &&
        document.version !== options.expectedDocumentVersion) {
        return { status: 'stale', reason: 'document-version-changed', edits: [] };
    }

    const keywordText = String(document.lineAt(keywordLine).text || '');
    const classification = classifyKeywordLine(keywordText);
    if (!classification.isKeyword) return unsupported('keyword-line-changed');
    if (keywordInputFormat(
        keywordText,
        options.globalInputFormat || documentGlobalInputFormat(document),
    ) !== 'standard') return unsupported('non-standard-input');

    const schema = options.schema || getFieldData();
    const lookup = keywordSchema.lookupKeywordSchema(classification.normalizedKeyword, schema);
    if (!lookup) return unsupported('unknown-keyword');
    if (Array.isArray(lookup.entry.tc) && lookup.entry.tc.length > 0) {
        return unsupported('text-card-layout');
    }

    const initialPrefix = keywordSchema.getVerifiedPrefixLayout(lookup);
    if (initialPrefix.status !== 'none' && initialPrefix.status !== 'verified') {
        return unsupported('prefix-layout-unverified');
    }
    const endLine = boundedCardCommentRewriteEnd(document, keywordLine, options);
    if (!Number.isInteger(endLine)) return unsupported('block-line-limit');

    const records = [];
    let pendingComments = [];
    for (let line = keywordLine + 1; line <= endLine; line++) {
        const text = String(document.lineAt(line).text || '');
        if (classifyKeywordLine(text).isKeyword) return unsupported('keyword-block-changed');
        if (isKeywordCommentLine(text)) {
            pendingComments.push({ line, text });
            continue;
        }
        if (text.includes(',')) return unsupported('free-format-data');
        records.push({ line, text, comments: pendingComments });
        pendingComments = [];
        if (records.length > CARD_COMMENT_REWRITE_MAX_DATA_LINES) {
            return unsupported('data-line-limit');
        }
    }
    if (records.length === 0) return unsupported('no-data-records');

    const observedDataLines = records.map(record => record.text);
    const prefix = keywordSchema.getVerifiedPrefixLayout(lookup, observedDataLines);
    if (prefix.status !== 'none' && prefix.status !== 'verified') {
        return unsupported('prefix-layout-unverified');
    }
    const structure = analyzeKeywordStructureForDocument(document, keywordLine, {
        ...options,
        schema,
        maximumPhysicalLines: Number.isFinite(options.maximumPhysicalLines)
            ? options.maximumPhysicalLines
            : CARD_COMMENT_REWRITE_MAX_PHYSICAL_LINES,
    });
    if (structure.status === 'definite-error') {
        return {
            status: 'structure-error',
            reason: structure.reason,
            structure,
            edits: [],
        };
    }
    const finiteCards = keywordSchema.getFiniteRenderedCardsForLookup(
        lookup,
        observedDataLines,
    );
    if (finiteCards.length === 0 || records.length > finiteCards.length) {
        return unsupported('repeat-or-extra-data');
    }

    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        const info = keywordSchema.getCardInfoForDocumentLine(document, record.line, schema, {
            keywordLine,
            dataLineOrdinal: index + 1,

            observedDataLines,
        });
        if (!info || info.isTextCard || !Array.isArray(info.card) || info.card.length === 0 ||
            info.card.some(field => !Number.isInteger(field?.p) || !Number.isInteger(field?.w) ||
                field.w < 1)) return unsupported('card-layout-unresolved');
        record.card = info.card;
    }

    const recognized = [];
    for (const record of records) {
        record.recognizedComments = [];
        for (const comment of record.comments) {
            const analysis = keywordSchema.analyzeCardCommentHeader(comment.text, finiteCards);
            if (!analysis) continue;
            const item = {
                ...comment,
                analysis,
                labelCase: cardCommentLabelCase(comment.text),
            };
            record.recognizedComments.push(item);
            recognized.push(item);
        }
    }
    const dominantStyle = mostCommonCardCommentValue(
        recognized.map(item => item.analysis.style),
        'dollar-hash-fixed',
    );
    const dominantCase = mostCommonCardCommentValue(
        recognized.map(item => item.labelCase),
        'lower',
    );

    const edits = [];
    let generatedBytes = 0;
    for (const record of records) {
        const exact = record.recognizedComments.filter(comment => {
            const analysis = keywordSchema.analyzeCardCommentHeader(comment.text, [record.card]);
            return !!analysis?.exactMatch;
        });
        const keeper = exact[exact.length - 1]
            || record.recognizedComments[record.recognizedComments.length - 1]
            || null;
        if (keeper && exact.length === 0) {
            const replacementText = generateCommentLine(
                record.card,
                keeper.analysis.style,
                keeper.labelCase,
            );
            if (!replacementText) return unsupported('comment-generation-failed');
            if (replacementText !== keeper.text) {
                edits.push({
                    kind: 'replace-line',
                    line: keeper.line,
                    sourceText: keeper.text,
                    replacementText,
                });
                generatedBytes += Buffer.byteLength(replacementText, 'utf8');
            }
        }
        for (const comment of record.recognizedComments) {
            if (comment === keeper) continue;
            edits.push({
                kind: 'delete-line',
                line: comment.line,
                sourceText: comment.text,
                replacementText: '',
            });
        }
        if (!keeper) {
            const replacementText = generateCommentLine(
                record.card,
                dominantStyle,
                dominantCase,
            );
            if (!replacementText) return unsupported('comment-generation-failed');
            edits.push({
                kind: 'insert-before-line',
                line: record.line,
                replacementText,
            });
            generatedBytes += Buffer.byteLength(replacementText, 'utf8');
        }
        if (edits.length > CARD_COMMENT_REWRITE_MAX_EDITS ||
            generatedBytes > CARD_COMMENT_REWRITE_MAX_TEXT_BYTES) {
            return unsupported('edit-budget-exceeded');
        }
    }

    if (edits.length === 0) return { status: 'no-change', reason: 'comments-current', edits: [] };
    return {
        status: 'ready',
        documentVersion: Number.isInteger(document.version) ? document.version : null,
        keywordLine,
        endLine,
        keyword: classification.normalizedKeyword,
        dataLineCount: records.length,
        scannedPhysicalLines: endLine - keywordLine,
        generatedBytes,
        edits,
    };
}

function showCardCommentRewriteStatus(key, ...args) {
    try {
        vscode.window.setStatusBarMessage(i18n.get(key, ...args), 5000);
    } catch (_error) {
        // Explicit comment maintenance remains optional; status is best-effort.
    }
}

async function handleRebuildCardCommentsCommand(request, options: any = {}) {
    const editor = options.editor || vscode.window.activeTextEditor;
    const document = editor?.document;
    const editIsCurrent = documentEditGuard.createDocumentEditGuard(document, editor);
    const keys = request && typeof request === 'object' && !Array.isArray(request)
        ? Object.keys(request).sort()
        : [];
    if (!document || !isLsdynaFile(document) ||
        keys.join(',') !== 'documentVersion,keywordLine,line,uri' ||
        request.uri !== documentUriIdentity(document) ||
        request.documentVersion !== document.version ||
        !Number.isInteger(request.keywordLine) || !Number.isInteger(request.line) ||
        request.keywordLine < 0 || request.keywordLine >= request.line ||
        request.line >= document.lineCount ||
        !isKeywordLineText(document.lineAt(request.keywordLine).text)) {
        (options.showStatus || showCardCommentRewriteStatus)('cardCommentRewriteStale');
        return null;
    }

    const resolved = getCardInfoForDocumentLineWithSuggest(
        document,
        request.line,
        options.schema || getFieldData(),
        { keywordLine: request.keywordLine },
    );
    const notice = resolved.cardInfo?.cardCommentNotice;
    if (!notice) {
        (options.showStatus || showCardCommentRewriteStatus)('cardCommentRewriteStale');
        return null;
    }

    const plan = planCardCommentRewriteForDocument(document, request.keywordLine, {
        ...options,
        schema: options.schema || getFieldData(),
        expectedDocumentVersion: request.documentVersion,
        blockIndex: options.blockIndex !== undefined
            ? options.blockIndex
            : readyCardEditBlockIndex(document, options.keywordIndexProvider),
    });
    if (plan?.status !== 'ready' || plan.documentVersion !== document.version) {
        (options.showStatus || showCardCommentRewriteStatus)(
            plan?.status === 'stale' || plan?.status === 'no-change'
                ? 'cardCommentRewriteStale'
                : 'cardCommentRewriteUnavailable',
        );
        return null;
    }

    if (!await canApplyDocumentEdit(document, editIsCurrent)) return null;
    const edit = new vscode.WorkspaceEdit();
    const eol = options.eol || (document.eol === 2 ? '\r\n' : '\n');
    for (const operation of plan.edits) {
        if (operation.kind !== 'insert-before-line' &&
            document.lineAt(operation.line).text !== operation.sourceText) {
            (options.showStatus || showCardCommentRewriteStatus)('cardCommentRewriteStale');
            return null;
        }
        if (operation.kind === 'insert-before-line') {
            const position = new vscode.Position(operation.line, 0);
            edit.replace(document.uri, new vscode.Range(position, position), operation.replacementText + eol);
        } else if (operation.kind === 'delete-line') {
            if (operation.line + 1 >= document.lineCount) {
                (options.showStatus || showCardCommentRewriteStatus)('cardCommentRewriteUnavailable');
                return null;
            }
            edit.replace(
                document.uri,
                new vscode.Range(operation.line, 0, operation.line + 1, 0),
                '',
            );
        } else {
            edit.replace(
                document.uri,
                new vscode.Range(
                    operation.line,
                    0,
                    operation.line,
                    operation.sourceText.length,
                ),
                operation.replacementText,
            );
        }
    }
    try {
        const applyEdit = options.applyEdit || (workspaceEdit => vscode.workspace.applyEdit(workspaceEdit));
        if (!await applyEdit(edit)) {
            (options.showStatus || showCardCommentRewriteStatus)('cardCommentRewriteApplyFailed');
            return null;
        }
    } catch (_error) {
        (options.showStatus || showCardCommentRewriteStatus)('cardCommentRewriteApplyFailed');
        return null;
    }
    (options.showStatus || showCardCommentRewriteStatus)(
        'cardCommentRewriteApplied',
        plan.edits.length,
    );
    return { notice, plan, edit };
}

async function handleInsertVerifiedMissingRecordsCommand(request, options: any = {}) {
    const editor = options.editor || vscode.window.activeTextEditor;
    const document = editor?.document;
    const editIsCurrent = documentEditGuard.createDocumentEditGuard(document, editor);
    const showStatus = options.showStatus || showCardCommentRewriteStatus;
    const keys = request && typeof request === 'object' && !Array.isArray(request)
        ? Object.keys(request).sort()
        : [];
    if (!document || !isLsdynaFile(document) ||
        keys.join(',') !== 'diagnosticIdentity,documentVersion,grammarId,keywordLine,line,sourceProfileId,uri' ||
        request.uri !== documentUriIdentity(document) ||
        request.documentVersion !== document.version ||
        typeof request.sourceProfileId !== 'string' ||
        typeof request.grammarId !== 'string' ||
        typeof request.diagnosticIdentity !== 'string' ||
        !Number.isInteger(request.keywordLine) || !Number.isInteger(request.line) ||
        request.keywordLine < 0 || request.keywordLine > request.line ||
        request.line >= document.lineCount ||
        !isKeywordLineText(document.lineAt(request.keywordLine).text)) {
        showStatus('keywordStructureRepairStale');
        return null;
    }
    const activeSourceProfileId = options.sourceProfileId !== undefined
        ? options.sourceProfileId
        : manualPackManagerRef?.peekCurrentAuthority?.()?.sourceProfileId ||
            DEFAULT_STRUCTURE_SOURCE_PROFILE_EN;
    if (!activeSourceProfileId || activeSourceProfileId !== request.sourceProfileId) {
        showStatus('keywordStructureRepairStale');
        return null;
    }
    const analysis = analyzeKeywordStructureForDocument(document, request.keywordLine, {
        ...options,
        bypassCache: true,
        sourceProfileId: activeSourceProfileId,
        expectedDocumentVersion: request.documentVersion,
        maximumPhysicalLines: CARD_COMMENT_REWRITE_MAX_PHYSICAL_LINES,
        blockIndex: options.blockIndex !== undefined
            ? options.blockIndex
            : readyCardEditBlockIndex(document, options.keywordIndexProvider),
    });
    const repairs = analysis?.repairCandidates || [];
    const insertionIndexes = repairs.map(candidate => candidate.insertionRecordIndex);
    const expectedStart = analysis?.observedDataRecords;
    const contiguousSuffix = insertionIndexes.length > 0 && insertionIndexes.every((value, index) =>
        value === expectedStart + index);
    if (analysis?.status !== 'definite-error' ||
        analysis.reason !== 'missing-required-records' ||
        analysis.verificationStatus !== 'verified-full' ||
        analysis.grammarId !== request.grammarId ||
        analysis.sourceProfileId !== request.sourceProfileId ||
        keywordStructureDiagnosticIdentity(analysis) !== request.diagnosticIdentity ||
        analysis.dependencies?.length > 0 || !contiguousSuffix ||
        repairs.some(candidate => candidate.kind !== 'insert-blank-record' ||
            candidate.format !== 'fixed' || typeof candidate.text !== 'string' ||
            candidate.text.length < 1 || candidate.text.length > 1024 ||
            candidate.text.trim() !== '') ||
        !Number.isInteger(analysis.endLine) ||
        (request.line !== request.keywordLine && request.line > analysis.endLine)) {
        showStatus(
            analysis?.reason === 'document-version-changed'
                ? 'keywordStructureRepairStale'
                : 'keywordStructureRepairUnavailable',
        );
        return null;
    }
    const eol = options.eol || (document.eol === 2 ? '\r\n' : '\n');
    const beforeNextLine = analysis.endLine + 1 < document.lineCount;
    const position = beforeNextLine
        ? new vscode.Position(analysis.endLine + 1, 0)
        : new vscode.Position(
            analysis.endLine,
            String(document.lineAt(analysis.endLine).text || '').length,
        );
    const insertionText = beforeNextLine
        ? `${repairs.map(candidate => candidate.text).join(eol)}${eol}`
        : `${eol}${repairs.map(candidate => candidate.text).join(eol)}`;
    if (!await canApplyDocumentEdit(document, editIsCurrent)) return null;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
        document.uri,
        new vscode.Range(position, position),
        insertionText,
    );
    try {
        const applyEdit = options.applyEdit || (workspaceEdit => vscode.workspace.applyEdit(workspaceEdit));
        if (!await applyEdit(edit)) {
            showStatus('keywordStructureRepairApplyFailed');
            return null;
        }
    } catch (_error) {
        showStatus('keywordStructureRepairApplyFailed');
        return null;
    }
    showStatus('keywordStructureRecordsInserted', repairs.length);
    return { analysis, edit };
}

function shouldPreserveTextCardLine(document, lineNum) {
    const info = getCardInfoForLine(document, lineNum);
    if (!info) return false;
    if (info.isTextCard) return true;
    if (!Array.isArray(info.card) || info.card.length !== 1) return false;

    const field = info.card[0];
    const fieldType = String(field?.t || '').toLowerCase();
    const keywordName = String(info.keywordName || '').toUpperCase();
    return Number(field?.w) >= 40 &&
        (fieldType === 'string' || fieldType === 'character' || fieldType === 'char') &&
        !keywordName.startsWith('INCLUDE');
}

function officialChoiceRoleLabel(role) {
    if (role === 'sentinel') return i18n.get('officialChoiceRoleSentinel');
    if (role === 'reference') return i18n.get('officialChoiceRoleReference');
    if (role === 'literal') return i18n.get('officialChoiceRoleLiteral');
    return i18n.get('officialChoiceRoleEnum');
}

function editorQuickSuggestionsOtherEnabled(document) {
    try {
        const configured = vscode.workspace
            .getConfiguration('editor', document?.uri)
            .get('quickSuggestions', false);
        if (configured === true) return true;
        if (!configured || typeof configured !== 'object') return false;
        const other = configured.other;
        return other === true || other === 'on' || other === 'inline';
    } catch (_error) {
        return false;
    }
}

async function prepareFieldInteraction(document, position, options: any = {}) {
    const current = createDocumentReadGuard(document, options.cancellationToken);
    if (!current()) return false;
    try {
        await keywordSchema.prepareKeywordSchema();
        if (!current()) return false;
        let keywordLine = options.keywordLine;
        if (!Number.isInteger(keywordLine)) {
            const ready = readyCardEditBlockIndex(document);
            const presentation = documentPresentationCache.get(document);
            const block = ready?.findBlockAtLine(position.line) ||
                (presentation?.ready && presentation.version === document.version
                    ? presentationBlockAtLine(presentation.blocks, position.line) : null);
            keywordLine = block?.startLine;
            if (!Number.isInteger(keywordLine)) {
                const limit = options.maximumKeywordLookback ?? 256;
                for (let line = position.line; line >= Math.max(0, position.line - limit); line--) {
                    if (classifyKeywordLine(document.lineAt(line).text).isKeyword) { keywordLine = line; break; }
                }
            }
        }
        if (!Number.isInteger(keywordLine) || keywordLine < 0 || keywordLine >= document.lineCount) return false;
        const name = keywordLineNameFromText(document.lineAt(keywordLine).text);
        if (!name) return false;
        const canonical = keywordSchema.lookupKeywordSchema(name, getFieldData())?.canonicalName;
        for (const keyword of new Set([name, canonical].filter(Boolean))) {
            await getCatalogInputFormCatalogV4().prepareKeyword(
                require("./core/semantics/catalogNativeFileLayout").nativeFileCatalogKeyword(keyword));
            if (!current()) return false;
            await getManualSemanticCatalog().prepareKeyword(keyword);
            if (!current()) return false;
        }
        return true;
    } catch (error) {
        logDebug(`Field preparation failed: ${error?.message || error}`);
        return false;
    }
}

async function planPreparedOfficialFieldChoices(document, position, options: any = {}) {
    if (!await prepareFieldInteraction(document, position, options)) return null;
    return planOfficialFieldChoicesForDocument(document, position, options);
}

function planOfficialFieldChoicesForDocument(document, position, options: any = {}) {
    try {
        return (options.plan || planOfficialFieldChoices)(
            document,
            position,
            options.schema || getFieldData(),
            {
                blockIndex: options.blockIndex !== undefined
                    ? options.blockIndex
                    : readyCardEditBlockIndex(document, options.keywordIndexProvider),
                keywordLine: options.keywordLine,
                globalInputFormat: options.globalInputFormat || documentGlobalInputFormat(document),
                expectedDocumentVersion: options.expectedDocumentVersion,
                maximumKeywordLookback: options.maximumKeywordLookback,
                maximumHeaderLookback: options.maximumHeaderLookback,
                maximumChoices: options.maximumChoices,
                rulesForField: options.rulesForField,
            },
        );
    } catch (_error) {
        return null;
    }
}

function buildOfficialFieldChoiceCompletionItems(document, position, context, _cardInfo, resolvedKeywordLine = null) {
    const keywordLine = Number.isInteger(resolvedKeywordLine)
        ? resolvedKeywordLine
        : findEnclosingKeywordLine(document, position.line);
    if (keywordLine === null) return [];
    const plan = planOfficialFieldChoicesForDocument(document, position, { keywordLine });
    if (!plan || plan.status !== 'ready' || !plan.fieldRange) return [];
    const invokeKind = vscode.CompletionTriggerKind?.Invoke ?? 0;
    const invokedWithoutAutomaticQuickSuggestions = context?.triggerKind === invokeKind &&
        !editorQuickSuggestionsOtherEnabled(document);
    // VS Code reports both Ctrl+Space and quick-suggestion sessions as Invoke.
    // With the extension's default quickSuggestions=false, Invoke is explicit.
    // If a user enables automatic suggestions we cannot distinguish the two, so
    // open/mixed domains stay hidden while small closed enums remain available.
    const automatic = plan.domainKind === 'closed' && plan.choices.length <= 12;
    if (!automatic && !invokedWithoutAutomaticQuickSuggestions) return [];

    const range = new vscode.Range(
        plan.fieldRange.line,
        plan.fieldRange.startCharacter,
        plan.fieldRange.line,
        plan.fieldRange.endCharacter,
    );
    const evidenceLinks = semanticEvidencePageLinks(plan.catalogKeyword, [{
        ruleId: plan.ruleId,
        evidence: plan.evidence,
    }]);
    return plan.choices.map((choice, index) => {
        const item = new vscode.CompletionItem(
            choice.valueText,
            vscode.CompletionItemKind.EnumMember ||
                vscode.CompletionItemKind.Value ||
                vscode.CompletionItemKind.Field,
        );
        item.detail = i18n.get(
            'officialFieldChoiceDetail',
            plan.fieldName,
            officialChoiceRoleLabel(choice.role),
        );
        const isZh = i18n.getLanguage() === 'zh-cn';
        let summaryDoc = plan.summary;
        if (isZh) {
            const localized = plan.localizedSummary || (plan.summary ? keywordSchema.getLocalizedHelpForText(plan.summary) : null);
            if (localized) {
                summaryDoc = `${localized}\n\n> **${i18n.get('fieldHelpEnglishOriginal')}:** ${plan.summary}`;
            } else if (plan.summary) {
                summaryDoc = `${plan.summary} *(${i18n.get('fieldHelpUntranslatedInline')})*`;
            }
        }
        const documentation = [
            `**${i18n.get('officialDocumentedValue')}**`,
            summaryDoc,
            evidenceLinks.length > 0
                ? `${i18n.get('semanticEvidencePages')}: ${evidenceLinks.join(' · ')}`
                : '',
        ].filter(Boolean).join('\n\n');
        item.documentation = new vscode.MarkdownString(documentation);
        item.documentation.isTrusted = HOVER_TRUST;
        item.documentation.supportThemeIcons = true;
        item.filterText = choice.valueText;
        item.insertText = choice.replacementText;
        item.range = range;
        item.sortText = `0c_${String(index).padStart(3, '0')}`;
        return item;
    });
}

function hasDeclaredDefault(field) {
    return !!field && field.d !== undefined && field.d !== null &&
        (!field.definitionSource || field.definitionSource.alignmentMayOmit === true);
}

function canOmitTrailingFields(card, valueCount) {
    return valueCount >= 0 &&
        valueCount <= card.length &&
        card.slice(valueCount).every(hasDeclaredDefault);
}

function parseTabValueOrder(text) {
    const source = String(text || '');
    if (source.includes(',')) {
        return {
            delimiter: 'comma',
            values: source.split(',').map(value => value.trim()),
        };
    }
    return {
        delimiter: 'whitespace',
        values: extractSmartTokens(source),
    };
}

function analyzeTabLineInterpretation(text, card) {
    const originalText = String(text || '');
    if (!card || card.length === 0) {
        return { status: 'unsafe', reason: 'no-card', candidates: [] };
    }

    // A card with overlapping/invalid field geometry has no unique fixed-grid
    // meaning.  Do not let Tab bypass the cell guard by treating its tokens as
    // a repairable value-order line.
    if (!cardCellModel.isSafeCardGeometry(card)) {
        return { status: 'unsafe', reason: 'unsafe-card-geometry', candidates: [] };
    }

    if (cardCellModel.classifyGrid(originalText, card) === 'intact') {
        return { status: 'intact', candidates: [] };
    }

    const parsed = parseTabValueOrder(originalText);
    if (parsed.values.length === 0 || parsed.values.length > card.length) {
        return { status: 'unsafe', reason: 'field-count', candidates: [] };
    }

    const alignment = planAlignedLine(originalText, card, false, {
        allowAmbiguousTrailing: true,
        forceValueOrder: true,
    });
    if (alignment.status === 'unsafe') {
        return { status: 'unsafe', reason: alignment.reason, candidates: [] };
    }

    const candidate = {
        semantic: 'valueOrder',
        text: alignment.text,
        values: parsed.values,
        delimiter: parsed.delimiter,
    };
    const missingRequiredTrailing =
        parsed.values.length < card.length &&
        !canOmitTrailingFields(card, parsed.values.length);

    // Commas explicitly express a free-format style, while omitted required
    // fields could represent either trailing omissions or an internal blank.
    // Both require a human choice before conversion to fixed columns.
    if (parsed.delimiter === 'comma' || missingRequiredTrailing) {
        return {
            status: 'ambiguous',
            reason: parsed.delimiter === 'comma' ? 'free-format-comma' : 'missing-fields',
            candidates: [candidate],
        };
    }

    return { status: 'repairable', candidate, candidates: [candidate] };
}

function valueOrderFieldIndexAtCaret(text, caretColumn, delimiter) {
    const source = String(text || '');
    const col = Math.max(0, Math.min(source.length, Number(caretColumn) || 0));
    if (delimiter === 'comma') {
        return source.slice(0, col).split(',').length - 1;
    }

    const ranges = [];
    const matcher = /\S+/g;
    let match;
    while ((match = matcher.exec(source)) !== null) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
    }
    if (ranges.length === 0) return 0;
    for (let index = 0; index < ranges.length; index++) {
        if (col <= ranges[index].end) return index;
    }
    return ranges.length - 1;
}

function tabMeaningCandidateDetail(candidate, card) {
    return candidate.values
        .map((value, index) => `${card[index]?.n || index + 1}=${value || '∅'}`)
        .join(' · ');
}

let inlineEditChoiceSequence = 0;

let inlineEditChoiceSession = null;

function clearInlineEditChoiceSession(sessionId = null) {
    if (
        inlineEditChoiceSession &&
        (sessionId === null || inlineEditChoiceSession.id === sessionId)
    ) {
        inlineEditChoiceSession = null;
        void Promise.resolve(vscode.commands.executeCommand(
            'setContext',
            'lsdyna.inlineEditChoiceActive',
            false,
        ));
        return true;
    }
    return false;
}

function cancelInlineEditChoiceSession(sessionId = null) {
    const cleared = clearInlineEditChoiceSession(sessionId);
    if (cleared) {
        void Promise.resolve(vscode.commands.executeCommand('hideSuggestWidget'));
    }
    return cleared;
}

function isInlineEditChoiceSessionValid(session, document = session?.document, position = null) {
    if (!session || !document || session.document !== document) return false;
    if (document.isClosed) return false;
    if (
        Number.isInteger(session.version) &&
        Number.isInteger(document.version) &&
        document.version !== session.version
    ) return false;
    if (session.lineNum < 0 || session.lineNum >= document.lineCount) return false;
    if (document.lineAt(session.lineNum).text !== session.sourceText) return false;
    if (position && (
        position.line !== session.position.line ||
        position.character !== session.position.character
    )) return false;
    const editor = session.editor;
    if (!editor || editor.document !== document) return false;
    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor !== editor) return false;
    const active = editor.selection?.active;
    if (
        active &&
        (active.line !== session.position.line || active.character !== session.position.character)
    ) return false;
    return true;
}

function compactLinePreview(text, maxLength = 42) {
    const source = String(text || '').replace(/\t/g, '⇥');
    if (source.length <= maxLength) return source;
    const head = Math.max(8, Math.floor((maxLength - 1) / 2));
    const tail = Math.max(8, maxLength - head - 1);
    return `${source.slice(0, head)}…${source.slice(-tail)}`;
}

function fixedCellPreview(text, card, centerIndex, fieldCount = 2) {
    if (!card || card.length === 0) return compactLinePreview(text);
    const start = Math.max(0, Math.min(card.length - 1, centerIndex));
    const end = Math.min(card.length, start + Math.max(1, fieldCount));
    const padded = cardCellModel.padLineToCard(text, card);
    return card.slice(start, end)
        .map(field => `[${padded.slice(field.p, field.p + field.w)}]`)
        .join('');
}

function startInlineEditChoiceSession(
    editor,
    lineNum,
    sourceText,
    choices,
    options: { onType?: (...args: any[]) => any } = {},
) {
    if (!editor || !editor.document || !Array.isArray(choices) || choices.length === 0) {
        return Promise.resolve();
    }
    const position = editor.selection?.active || editor.selection?.start;
    if (!position || position.line !== lineNum) return Promise.resolve();

    const session = {
        id: `edit-choice-${++inlineEditChoiceSequence}`,
        editor,
        document: editor.document,
        version: editor.document.version,
        lineNum,
        sourceText,
        position: new vscode.Position(position.line, position.character),
        choices,
        onType: typeof options.onType === 'function' ? options.onType : null,
        presented: false,
    };
    inlineEditChoiceSession = session;
    void Promise.resolve(vscode.commands.executeCommand(
        'setContext',
        'lsdyna.inlineEditChoiceActive',
        true,
    ));
    try {
        return Promise.resolve(vscode.commands.executeCommand('editor.action.triggerSuggest'))
            .catch(error => {
                clearInlineEditChoiceSession(session.id);
                console.error('[lsdyna] Failed to open inline edit choices:', error);
            });
    } catch (error) {
        clearInlineEditChoiceSession(session.id);
        console.error('[lsdyna] Failed to open inline edit choices:', error);
        return Promise.resolve();
    }
}

class LsdynaEditChoiceCompletionProvider {
    provideCompletionItems(document, position) {
        const session = inlineEditChoiceSession;
        if (!session || session.presented) return [];
        if (!isInlineEditChoiceSessionValid(session, document, position)) {
            clearInlineEditChoiceSession(session.id);
            return [];
        }
        session.presented = true;
        const items = session.choices.map((choice, index) => {
            const label = {
                label: choice.label,
                description: choice.preview || '',
            };
            const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Field);
            item.detail = choice.detail || '';
            // The suggestion itself must not edit the document. Its command owns
            // the complete, version-checked, single-undo operation.
            item.insertText = '';
            item.range = new vscode.Range(position, position);
            item.sortText = `0000_${String(index).padStart(2, '0')}`;
            item.filterText = '';
            item.preselect = choice.preselect === true;
            item.command = {
                command: 'extension.lsdynaApplyInlineEditChoice',
                title: choice.label,
                arguments: [session.id, choice.id],
            };
            return item;
        });
        return new vscode.CompletionList(items, false);
    }
}

async function applyInlineEditChoice(sessionId, choiceId) {
    const session = inlineEditChoiceSession;
    if (!session || session.id !== sessionId) return;
    if (!isInlineEditChoiceSessionValid(session)) {
        clearInlineEditChoiceSession(sessionId);
        return;
    }
    const choice = session.choices.find(candidate => candidate.id === choiceId);
    clearInlineEditChoiceSession(sessionId);
    if (!choice || typeof choice.apply !== 'function') return;
    return choice.apply();
}

const cardCellTypingSessions = new WeakMap();

function clearCardCellTypingSession(document) {
    if (document) cardCellTypingSessions.delete(document);
}

function canContinueCardCellTypingSession(editor, lineNum, fieldIndex, caret) {
    const document = editor?.document;
    const session = document ? cardCellTypingSessions.get(document) : null;
    if (!session || session.editor !== editor) return false;
    if (session.lineNum !== lineNum || session.fieldIndex !== fieldIndex) return false;
    if (session.caret !== caret) return false;
    if (
        Number.isInteger(session.version) &&
        Number.isInteger(document.version) &&
        session.version !== document.version
    ) return false;
    return true;
}

function rememberCardCellTypingSession(editor, lineNum, fieldIndex, caret) {
    const document = editor?.document;
    if (!document) return;
    cardCellTypingSessions.set(document, {
        editor,
        lineNum,
        fieldIndex,
        caret,
        version: Number.isInteger(document.version) ? document.version : undefined,
    });
}

function hasRecentCardCellSelectionGrace(document) {
    if (!document || !cardCellASelectionGrace) return false;
    const documentKey = document.uri && document.uri.toString();
    return cardCellASelectionGrace.until > Date.now() &&
        cardCellASelectionGrace.uri === documentKey &&
        Number.isInteger(document.version) &&
        document.version >= cardCellASelectionGrace.version &&
        document.version <= cardCellASelectionGrace.version + 1;
}

async function executeNativeTab(direction) {
    if (direction === 1) return vscode.commands.executeCommand('tab');
    if (direction === -1) return vscode.commands.executeCommand('outdent');
}

function isTabSelectionEligible(editor, selection) {
    if (!editor || !selection) return false;
    const anchor = selection.anchor || selection.start;
    const active = selection.active || selection.end;
    if (!anchor || !active) return false;
    if (anchor.line !== active.line) return false;
    if (anchor.character === active.character) return true;

    // Tab itself selects a complete guarded cell.  That exact A selection may
    // continue navigating; arbitrary partial/cross-field selections belong to
    // normal VS Code indentation and must never be collapsed into one cell.
    const nav = ensureCardCellEditGuard().getNav();
    if (!nav || nav.mode !== 'A') return false;
    const documentKey = editor.document?.uri?.toString?.();
    if (nav.uri && documentKey && nav.uri !== documentKey) return false;
    if (nav.line !== anchor.line) return false;
    if (
        Number.isInteger(nav.version) &&
        Number.isInteger(editor.document?.version) &&
        nav.version !== editor.document.version
    ) return false;
    const start = Math.min(anchor.character, active.character);
    const end = Math.max(anchor.character, active.character);
    return start === nav.expectedStart && end === nav.expectedEnd;
}

function startEmptyCellBoundaryTypeChoice(editor, target, text, guard) {
    const document = editor.document;
    const lineNum = target.lineNum;
    const sourceText = document.lineAt(lineNum).text;
    const card = getCardFieldsForLine(document, lineNum);
    const previousIndex = target.ambiguousPreviousFieldIndex;
    const nextIndex = target.fieldIndex;
    if (
        !card ||
        !Number.isInteger(previousIndex) || previousIndex < 0 ||
        nextIndex !== previousIndex + 1 || nextIndex >= card.length
    ) return Promise.resolve();

    const previousValue = cardCellModel.readCellValue(sourceText, card, previousIndex);
    const previousText = cardCellModel.writeCellR1(
        sourceText,
        card,
        previousIndex,
        previousValue + text,
    );
    const nextValue = cardCellModel.readCellValue(sourceText, card, nextIndex);
    const nextInsertIndex = cardCellModel.valueIndexAtCaret(
        sourceText,
        card,
        nextIndex,
        target.caretCol,
    );
    const nextText = cardCellModel.writeCellR1(
        sourceText,
        card,
        nextIndex,
        nextValue.slice(0, nextInsertIndex) + text + nextValue.slice(nextInsertIndex),
    );

    const applyResult = async (fieldIndex, newText) => {
        const caret = cardCellModel.caretAfterCellValue(newText, card, fieldIndex);
        await applyCardCellLineEdit(
            editor,
            lineNum,
            newText,
            caret,
            caret,
            { undoStopBefore: true, undoStopAfter: false },
        );
        guard.markAp(document, lineNum, fieldIndex, caret);
        rememberCardCellTypingSession(editor, lineNum, fieldIndex, caret);
        vscode.commands.executeCommand(
            'setContext',
            'lsdyna.cellEditActive',
            guard.shouldCellEditActive(editor),
        );
    };

    return startInlineEditChoiceSession(editor, lineNum, sourceText, [
        {
            id: 'append-previous-field',
            label: i18n.get('cellTypeAppendPrevious'),
            preview: `→ ${fixedCellPreview(previousText, card, previousIndex, 2)}`,
            detail: i18n.get('cellTypeAppendPreviousDetail'),
            apply: () => applyResult(previousIndex, previousText),
        },
        {
            id: 'start-next-field',
            label: i18n.get('cellTypeStartNext'),
            preview: `→ ${fixedCellPreview(nextText, card, previousIndex, 2)}`,
            detail: i18n.get('cellTypeStartNextDetail'),
            apply: () => applyResult(nextIndex, nextText),
        },
    ], {
        onType: async (additionalText, session) => {
            if (!isInlineEditChoiceSessionValid(session)) {
                clearInlineEditChoiceSession(session?.id || null);
                return;
            }
            const combinedText = text + String(additionalText || '');
            clearInlineEditChoiceSession(session.id);
            await Promise.resolve(vscode.commands.executeCommand('hideSuggestWidget'));

            const refreshedTarget = guard.getEmptyCellTypeTarget(
                document,
                editor.selection,
                combinedText,
            );
            if (!refreshedTarget) {
                clearCardCellTypingSession(document);
                vscode.window.setStatusBarMessage(i18n.get('cellInputTooWide'), 3000);
                return;
            }
            if (Number.isInteger(refreshedTarget.ambiguousPreviousFieldIndex)) {
                return startEmptyCellBoundaryTypeChoice(
                    editor,
                    refreshedTarget,
                    combinedText,
                    guard,
                );
            }

            guard.markAp(
                document,
                refreshedTarget.lineNum,
                refreshedTarget.fieldIndex,
                refreshedTarget.caretCol,
            );
            return handleCardCellTypeWithNavigation(
                { text: combinedText },
                combinedText,
                editor,
                guard,
            );
        },
    });
}

async function handleCardCellTypeWithNavigation(args, text, editor, guard) {
    const waitedForPostEdit = editor?.document
        ? await waitForPendingCardCellPostEdit(editor.document)
        : false;
    if (waitedForPostEdit) {
        if (vscode.window.activeTextEditor !== editor || editor.document.isClosed) return;
    }
    if (!isActiveLsdynaSemanticLocation(
        editor.document,
        editor.selection.active,
        { requireLiveSnapshot: true },
    )) {
        guard.clearNav();
        return vscode.commands.executeCommand('default:type', args);
    }
    if (!editor.selections || editor.selections.length !== 1) {
        guard.clearNav();
        vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', false);
        return vscode.commands.executeCommand('default:type', args);
    }
    if (cardCellCompositions.has(editor.document)) {
        return vscode.commands.executeCommand('default:type', args);
    }
    // Navigation may have been cleared while awaiting a native paste repair.
    const nav = guard.getNav();
    if (!nav) {
        return vscode.commands.executeCommand('default:type', args);
    }
    if (/^[A-Za-z]$/.test(text) || /[^\u0000-\u007f]/.test(text)) {
        clearCardCellTypingSession(editor.document);
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
        clearCardCellTypingSession(editor.document);
        return vscode.commands.executeCommand('default:type', args);
    }
    if (plan.blocked) {
        clearCardCellTypingSession(editor.document);
        vscode.window.setStatusBarMessage(i18n.get('cellInputTooWide'), 3000);
        return;
    }
    if (plan.escape) {
        clearCardCellTypingSession(editor.document);
        guard.clearNav();
        return vscode.commands.executeCommand('default:type', args);
    }
    const invokingCaret = editor.selection?.active?.character ?? plan.caret;
    const continuesTyping = canContinueCardCellTypingSession(
        editor,
        plan.lineNum,
        plan.fieldIndex,
        invokingCaret,
    );
    await applyCardCellLineEdit(editor, plan.lineNum, plan.newText, plan.caret, plan.caret, {
        undoStopBefore: !continuesTyping,
        undoStopAfter: false,
    });
    if (plan.markAp) {
        guard.markAp(editor.document, plan.lineNum, plan.fieldIndex, plan.caret);
    }
    rememberCardCellTypingSession(editor, plan.lineNum, plan.fieldIndex, plan.caret);
    vscode.commands.executeCommand('setContext', 'lsdyna.cellEditActive', guard.shouldCellEditActive(editor));
}

const nodeCrypto = require('crypto');

const { resolveKeywordCategory } = require('./core/keywordCategory');

const {
    getCatalogInputFormCatalogV4,
} = require("./core/semantics/catalogInputFormCatalogV4");

const {
    loadKeywordOptionGrammarRuntime,
    lookupKeywordOptionGrammar,
} = require('./core/options/keywordOptionGrammarCatalog');

const {
    OPTION_SWITCH_MAX_BYTES,
    planOptionSwitch,
    planProvisionalOptionSwitch,
} = require('./core/options/optionSwitchPlanner');

const { evaluateOptionGrammar } = require('./core/options/optionGrammarEvaluator');

const { evaluatePredicate } = require('./core/semantics/predicateEvaluator');

const { getLegalSelectorValues, resolveSelectorPriorScore, resolveFormRulePriorScore } = require("./core/semantics/catalogPriorRules");

const keywordRecordSerializer = require('./core/edit/keywordRecordSerializer');

function legacyOptionRecord(card, recordMigrationId, generatedComment = false) {
    return {
        recordMigrationId,
        occurrence: { kind: 'exactly-once' },
        fields: (card || []).map((field, fieldIndex) => ({
            fieldMigrationId: `${recordMigrationId}:field:${fieldIndex}`,
            name: field.n,
            type: field.t,
            position: field.p,
            width: field.w,
        })),
        generatedComment: generatedComment ? generateCommentLine(card) : undefined,
    };
}

function lookupOperationalKeywordOptionGrammar(spelling) {
    const runtimeGrammar = lookupKeywordOptionGrammar(spelling);
    if (runtimeGrammar) return runtimeGrammar;
    const lookup = lookupKeywordInfo(String(spelling || '').replace(/^\*/, ''));
    const postOptions = lookup ? postKeywordOptions(lookup.entry) : [];
    if (!lookup || postOptions.length === 0) return null;
    const keyword = `*${lookup.canonicalName}`.toUpperCase();
    const prefix = keywordSchema.getVerifiedPrefixLayout(lookup);
    if (prefix.status !== 'verified' && prefix.status !== 'none') return null;
    const canonical = String(lookup.canonicalName || '').toUpperCase();
    const prefixOptions = titleKeywordOptions(lookup.entry, canonical);
    const variants = [{ spelling: canonical, active: [] }, ...Object.entries(lookup.entry.v || {}).map(([spelling, value]: any) => ({
        spelling: String(spelling).toUpperCase(),
        active: Array.isArray(value?.active) ? value.active.map(normalizeOptionName) : [],
    }))];
    const targets = variants.map(variant => {
        const activePrefix = prefixOptions.filter(option => variant.active.includes(normalizeOptionName(option.n)));
        const prefixRecords = activePrefix.slice().sort((left, right) =>
            parseKeywordOptionOrder(right).index - parseKeywordOptionOrder(left).index).flatMap(option =>
            (option.c || []).map((card, index) => legacyOptionRecord(
                card, `legacy-option:${canonical}:pre:${normalizeOptionName(option.n)}:${index}`)));
        const baseRecords = (lookup.entry.c || []).map((card, index) =>
            legacyOptionRecord(card, `legacy-option:${canonical}:base:${index}`));
        const layouts = [];
        for (let count = 0; count <= postOptions.length; count++) {
            const postRecords = postOptions.slice(0, count).flatMap(option =>
                (option.c || []).map((card, cardIndex) => legacyOptionRecord(
                    card,
                    `legacy-option:${canonical}:post:${normalizeOptionName(option.n)}:${cardIndex}`,
                    true,
                )));
            layouts.push({
                postCount: count,
                layout: {
                    profileId: `legacy-option-layout:${variant.spelling}:${count}`,
                    keyword: `*${variant.spelling}`,
                    inputFormat: 'standard-fixed',
                    sourceIdentity: { canonicalKeyword: canonical, fieldSchema: 'field-data-runtime' },
                    records: [...prefixRecords, ...baseRecords, ...postRecords],
                },
                bindings: [],
            });
        }
        return {
            spelling: `*${variant.spelling}`,
            selection: { slots: { 'official-prefix-options': variant.active } },
            writePermission: true,
            applicationMode: 'layout-migration',
            layouts,
        };
    });
    return {
        grammarId: `legacy-option-grammar:${canonical}`,
        manualId: 'field-data-runtime',
        canonicalSectionId: canonical,
        grammarKind: 'ordered-subset',
        status: 'editable',
        permissions: { evaluate: true, mutate: true },
        slots: [{
            slotId: 'continuous-optional-cards',
            label: i18n.get('chooseConsecutiveOptionalCards'),
            selectionMode: 'ordered',
        }],
        targets,
    };
}

function legacyPrefixOptionCards(options) {
    return options
        .filter(option => parseKeywordOptionOrder(option).position === 'pre')
        .slice()
        .sort((a, b) => parseKeywordOptionOrder(b).index - parseKeywordOptionOrder(a).index)
        .flatMap(option => option.c || []);
}

function keywordCardsManagedLines(cards, startCardIndex = 0) {
    const lines = [];
    for (const card of cards.slice(startCardIndex)) {
        lines.push(managedCommentLineForCard(card));
        lines.push(keywordOptionCardSkeleton(card));
    }
    return lines;
}

function lookupWithActiveTitleOptions(lookup, titleOptions, selectedTitleNames) {
    const titleNameSet = new Set(titleOptions.map(option => normalizeOptionName(option.n)));
    const retained = (lookup.activeOptions || [])
        .map(normalizeOptionName)
        .filter(name => !titleNameSet.has(name));
    return {
        ...lookup,
        activeOptions: [...retained, ...selectedTitleNames.map(normalizeOptionName)],
    };
}

function verifiedPrefixCardsForSelection(lookup, preserveConditionalMarker = false) {
    const required = keywordSchema.getVerifiedPrefixLayout(lookup);
    if (required.status !== 'verified' || !preserveConditionalMarker) return required;
    const syntheticRecords = Array(required.requiredCardCount + 1).fill('');
    syntheticRecords[required.requiredCardCount] = '&';
    return keywordSchema.getVerifiedPrefixLayout(lookup, syntheticRecords);
}

function managedPrefixCommentReplacements(
    document,
    keywordLine,
    dataLines,
    currentCards,
    selectedCards,
    legacyCurrentCards,
) {
    const replacements = [];
    const retained = Math.min(currentCards.length, selectedCards.length, dataLines.length);
    for (let index = 0; index < retained; index++) {
        const dataLine = dataLines[index];
        const commentLine = dataLine.line - 1;
        if (commentLine <= keywordLine) continue;
        const source = document.lineAt(commentLine).text;
        if (!source.trimStart().startsWith('$#')) continue;
        const acceptedCards = [currentCards[index], legacyCurrentCards[index]].filter(Boolean);
        if (!acceptedCards.some(card => isStrictManagedCommentForCard(source, card))) continue;
        const replacementText = managedCommentLineForCard(selectedCards[index]);
        if (strictCommentKey(source) === strictCommentKey(replacementText)) continue;
        replacements.push({ line: commentLine, replacementText });
    }
    return replacements;
}

async function chooseKeywordOptionsQuickPickLegacy(editor = vscode.window.activeTextEditor, requestedLine = null) {
    if (!editor || !editor.document) return;
    const document = editor.document;
    const editIsCurrent = documentEditGuard.createDocumentEditGuard(document, editor);
    const requireSameActiveEditor = vscode.window.activeTextEditor === editor;
    const activeLine = Number.isInteger(requestedLine)
        ? requestedLine
        : (editor.selection && editor.selection.active ? editor.selection.active.line : 0);
    if (!isActiveLsdynaSemanticLocation(
        document,
        { line: activeLine, character: 0 },
        { requireLiveSnapshot: true },
    )) return;
    const keywordLine = findKeywordLineForLine(document, activeLine);
    if (keywordLine === null) {
        vscode.window.showInformationMessage(i18n.get('noKeywordAtCursor'));
        return;
    }

    const keywordText = document.lineAt(keywordLine).text;
    if (classifyOpaqueCommentDirective(keywordText)) return;
    const initialDocumentVersion = Number.isInteger(document.version) ? document.version : null;
    const sessionIsCurrent = () => {
        if (!editIsCurrent()) return false;
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
    const activeOptionSet = new Set((lookup.activeOptions || []).map(normalizeOptionName));
    const deniedActiveOptions = (entry.o || [])
        .filter(option => activeOptionSet.has(normalizeOptionName(option.n)))
        .filter(option => parseKeywordOptionOrder(option).position === 'pre')
        .filter(option => keywordSchema.keywordPrefixOptionDecision(
            lookup.canonicalName,
            normalizeOptionName(option.n),
        ) === 'deny')
        .map(option => normalizeOptionName(option.n));
    if (deniedActiveOptions.length) {
        vscode.window.showInformationMessage(i18n.get(
            'keywordPrefixOptionUnsupported',
            deniedActiveOptions.join(', '),
        ));
        return;
    }

    const nonWritableActiveOptions = (entry.o || [])
        .filter(option => activeOptionSet.has(normalizeOptionName(option.n)))
        .filter(option => (option.to || 0) > 0 && (option.c || []).length > 0)
        .filter(option => !writableKeywordOptions(entry, lookup.canonicalName).includes(option));
    if (nonWritableActiveOptions.length) {
        vscode.window.showInformationMessage(i18n.get('keywordPrefixLayoutUnavailable'));
        return;
    }
    if (writableKeywordOptions(entry, lookup.canonicalName).length === 0) {
        vscode.window.showInformationMessage(i18n.get('noKeywordOptionsAvailable'));
        return;
    }

    const titleOptions = titleKeywordOptions(entry, lookup.canonicalName);
    const postOptions = postKeywordOptions(entry);
    const currentTitleNames = lookup.activeOptions
        .filter(name => titleOptions.some(option => normalizeOptionName(option.n) === name));

    const blockEnd = findKeywordBlockEnd(document, keywordLine);
    const dataLines = collectKeywordDataLines(document, keywordLine, blockEnd);
    const currentLookup = lookupWithActiveTitleOptions(lookup, titleOptions, currentTitleNames);
    const currentPrefixLayout = keywordSchema.getVerifiedPrefixLayout(
        currentLookup,
        dataLines.map(line => line.text),
    );
    if (currentPrefixLayout.status === 'unsupported-option') {
        vscode.window.showInformationMessage(i18n.get(
            'keywordPrefixOptionUnsupported',
            currentPrefixLayout.unsupportedOptions.join(', '),
        ));
        return;
    }
    if (currentPrefixLayout.status === 'unverified') {
        vscode.window.showInformationMessage(i18n.get('keywordPrefixLayoutUnavailable'));
        return;
    }
    const currentPreCards = currentPrefixLayout.status === 'verified'
        ? currentPrefixLayout.cards
        : [];
    const currentPreLineCount = currentPreCards.length;

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

    const selectedLookup = lookupWithActiveTitleOptions(lookup, titleOptions, selectedTitleNames);
    const keepConditionalMarker = currentPrefixLayout.status === 'verified'
        && currentPrefixLayout.conditionalMarkerPresent
        && currentPrefixLayout.activePreOptions.includes('MPP')
        && selectedLookup.activeOptions.includes('MPP');
    const selectedPrefixLayout = verifiedPrefixCardsForSelection(
        selectedLookup,
        keepConditionalMarker,
    );
    if (selectedPrefixLayout.status === 'unsupported-option') {
        vscode.window.showInformationMessage(i18n.get(
            'keywordPrefixOptionUnsupported',
            selectedPrefixLayout.unsupportedOptions.join(', '),
        ));
        return;
    }
    if (selectedPrefixLayout.status === 'unverified') {
        vscode.window.showInformationMessage(i18n.get('keywordPrefixLayoutUnavailable'));
        return;
    }
    const selectedPreCards = selectedPrefixLayout.status === 'verified'
        ? selectedPrefixLayout.cards
        : [];
    const selectedPreLineCount = selectedPreCards.length;

    const currentPostCount = inferCurrentPostOptionCount(
        entry,
        currentPreLineCount,
        dataLines.length,
    );
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
    const currentPostLineCount = keywordOptionCardCount(postOptions.slice(0, currentPostCount));
    const selectedPostLineCount = keywordOptionCardCount(postOptions.slice(0, selectedPostCount));
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
    const preLinesToInsert = keywordCardsManagedLines(selectedPreCards, currentPreLineCount);
    const postLinesToInsert = keywordOptionManagedLines(postOptions.slice(0, selectedPostCount), currentPostLineCount);
    const deletionRanges = [];
    const legacyCurrentPreCards = legacyPrefixOptionCards(currentTitleOptions);
    const prefixCommentReplacements = managedPrefixCommentReplacements(
        document,
        keywordLine,
        dataLines,
        currentPreCards,
        selectedPreCards,
        legacyCurrentPreCards,
    );

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

    if (!await canApplyDocumentEdit(document, sessionIsCurrent)) return;
    await editor.edit(editBuilder => {
        if (nextKeywordLine !== keywordText) {
            editBuilder.replace(lineWholeRange(document, keywordLine), nextKeywordLine);
        }
        for (const replacement of prefixCommentReplacements) {
            editBuilder.replace(
                lineWholeRange(document, replacement.line),
                replacement.replacementText,
            );
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

let keywordOptionsViewControllerRef = null;

const {
    blockedKeywordOptionSwitchPlan,
    OPTION_SWITCH_MAX_PHYSICAL_LINES,
    OPTION_SWITCH_MAX_DATA_RECORDS,
    collectOptionSwitchBlock,
    keywordOptionTarget,
    keywordOptionLayoutProfile,
    keywordOptionLayoutCandidate,
    optionSwitchCardFromRecord,
    optionSwitchCommentAnalysis,
    optionSwitchCommentLine,
    keywordSpellingFromLine,
    keywordOptionBlockSha256,
    keywordOptionsEditorForModel,
    locateKeywordManagerSource,
    openKeywordManagerManual,
    openKeywordManagerInstanceEditor,
    keywordManagerDisplayName,
    keywordManagerReadonlyUri,
    keywordManagerInstanceFileState,
    nativeFileLayoutKind,
    nativeFileLayoutCards,
    readNativeFileField,
    selectVerifiedSourceRecords,
    nativeBatchFixedBinding,
    keywordManagerNativeFileSelection,
    keywordManagerNativeInstanceCounts,
    keywordManagerExpandNativeInstances,
    keywordManagerInstanceDirectories,
    keywordManagerInstances,
    prepareKeywordManagerInstances,
    completeKeywordManagerInstances,
    keywordManagerProjectInstances,
    keywordManagerCatalogCatalogFailure,
    isKeywordManagerUnauditedCatalogAllowed,
    keywordManagerCatalogCatalogForm,
    keywordManagerCatalogRules,
    keywordManagerCatalogFormFingerprint,
    keywordManagerCatalogNativeFormRules,
    keywordManagerCatalogNativeFormRule,
    keywordManagerCatalogEffectiveFormRules,
    keywordManagerCatalogEquivalentSpellings,
    keywordManagerCatalogSelectorRule,
    keywordManagerCatalogSelectorSpelling,
    keywordManagerCatalogSourceRecordCompatible,
    keywordManagerCatalogHeaderEvidence,
    keywordManagerResolveCatalogSelectorState,
    keywordManagerInferCatalogSelectorSelections,
    keywordManagerCatalogExplicitSpellingSelections,
    keywordManagerPrepareCatalogSelectorLayout,
    keywordManagerPrepareCatalogInputFormLayout,
    keywordManagerPrepareCatalogInputFormLayoutForRule,
    keywordManagerFieldProjection,
    keywordManagerResolveSchemaField,
    managerHelpLookups,
    keywordManagerReadFieldHelp,
    keywordManagerHelpState,
    keywordManagerHasStaging,
    keywordManagerCapabilityProjection,
    keywordManagerEditField,
    keywordManagerStageFieldDrafts,
    buildKeywordOptionSwitchPlan,
    buildKeywordManagerCatalogPlan,
    buildKeywordOptionViewModel,
    keywordOptionProductLabels,
    keywordOptionEmptyViewState,
    keywordOptionPlanDetails,
    buildKeywordOptionsViewState,
    keywordLineWithTargetSpelling,
    optionSwitchReplacement,
    keywordManagerCatalogAllowsWrite,
} = require('./client/services/keywordManager').createKeywordManagerServices({
    getKeywordSemanticAdviceForDocument,
    readyCardEditBlockIndex,
    isKeywordLineText,
    cardCommentLabelCase,
    documentUriIdentity,
    nativeParameterContextForDocument,
    documentGlobalInputFormat,
    legacyOptionRecord,
    getFieldData,
    lookupOperationalKeywordOptionGrammar,
    isLsdynaFile,
    isActiveLsdynaSemanticLocation,
    findKeywordLineForLine,
});

const {
    applyKeywordOptionViewModel,
} = require('./client/services/keywordManagerApply').createKeywordManagerApply({
    keywordManagerCatalogAllowsWrite,
    keywordOptionsEditorForModel,
    documentUriIdentity,
    isDocumentReadonlyForAutomaticEdit,
    buildKeywordManagerCatalogPlan,
    keywordManagerPrepareCatalogInputFormLayout,
    keywordManagerPrepareCatalogSelectorLayout,
    keywordManagerStageFieldDrafts,
    keywordOptionBlockSha256,
    optionSwitchReplacement,
});

module.exports = { activate, deactivate };

// Exported for unit testing
module.exports._internals = {
    prepareKeywordManagerInstances,
    completeKeywordManagerInstances,
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
    buildStatusDashboardDiagnosticItems,
};


Object.assign(module.exports._internals, {
    startLanguageClient,
    publishProjectDiagnostics,
    collectProjectDiagnostics,
    collectIncludeDecorationSets,
    createIncludeDecorationTypes,
    createLatestDocumentRequestGuard,
    collectKeywordDecorationRanges,
    collectIncludeDocumentLinks,
    collectLineLengthDiagnostics,
    getOpaqueCommentLocation,
    isActiveLsdynaSemanticLocation,
    cacheFileIndexesFromSnapshot,
    cacheEffectiveSearchPathsFromSnapshot,
    cacheReferenceIndexFromSnapshot,
    clientProjectCacheStats,
    getFileIndexForDocument,
    clearClientProjectSemanticCaches,
    cacheRemovalTotals,
    handleClearProjectIndexCachesCommand,
    cacheLimitBytes,
    cacheLimitMilliseconds,
    clearReferenceIndexCacheForTesting,
    clearReferenceIndexForRoot,
    getMainDeckContextForDocumentPath,
    setMainDeckContextForDocument,
    clearMainDeckContextForDocument,
    handleSelectMainDeckContextCommand,
    buildMainDeckContextHoverMarkdown,
    clearEffectiveSearchPathCacheForTesting,
    getEffectiveSearchPaths,
    findParameterDefinitions,
    findParameterReferences,
    LsdynaDefinitionProvider,
    fieldReferenceAtPosition,
    resolveFieldReferenceNavigation,
    resolveRegistryReferenceNetwork,
    resolveWorkspaceReferenceSearch,
    handleWorkspaceReferenceSearchCommand,
    workspaceReferenceSearchPosition,
    resolveIndexedEntityQueryScope,
    indexedEntityResultItems,
    inferIndexedEntityQueryTarget,
    isEntityReferenceNavigationPosition,
    resolveEntityReferenceCursorEditor,
    activeUnsynchronizedLargeFileUri,
    activeLargeFileViewerUri,
    presentIndexedEntityQueryResult,
    handleIndexedEntityIdQueryCommand,
    refreshCurrentEntityReferenceQuery,
    refreshStoredEntityReferenceQuery,
    prepareIndexedEntityQuerySnapshot,
    refreshCurrentEntityQueryAfterProjectScan,
    shouldResolveParameterDefinitionAtPosition,
    LsdynaReferenceProvider,
    LsdynaRenameProvider,
    findIncludeFileLines,
    LsdynaIncludeTreeProvider,
    documentUriIdentity,
    buildTablePreviewReferenceKey,
    getTablePreviewViewForReference,
    setTablePreviewViewForReference,
    clearTablePreviewViewsForTesting,
    handleSetTablePreviewViewCommand,
    LsdynaKeywordSymbolProvider,
    LsDynaFoldingProvider,
    getSearchPath,
    getParameterAtCursor,
    isIncludeLine,
    isLsdynaUri,
    shouldSkipAutomaticDocumentScan,
    setFileIndexForTesting,
    updateKeywordBlocksAfterDocumentChange,
    updateActiveFileIndexForDocumentChange,
    releaseLiveFileIndexForClosedDocument,
    searchFileFromPaths,
    createManifestDrivenInvalidator,
    createBatchedManifestInvalidator,
    createProjectSnapshotRefreshQueue,
    createProjectSnapshotPersistentCache,
    normalizePathKey,
    getCardInfoForDocumentLineWithSuggest,
    resolveKeywordLookupWithSuggest,
    cardCellModel,
});

module.exports._internals.HOVER_TRUST = HOVER_TRUST;

Object.assign(module.exports._internals, { setReferenceSnapshotLoaderForTesting, getReferenceIndexForDocument, parseKeywordBlocksFromDocumentAsync, buildLiveRegistryReferenceFileIndex });

Object.assign(module.exports._internals, { buildControlConditionMarkdown, buildFieldHelpMarkdown, getRelaxedModelEvidenceV1Catalog, buildProvisionalManualContext, resolveProvisionalFieldHelp, getKeywordSemanticAdviceForDocument, keywordSemanticAdviceCache, getKeywordSemanticAdvice, predicateFieldsForCardAdvice, buildSemanticDocumentContext, inlineSemanticLabel, semanticApplicabilityPresentation, semanticEvidencePageLinks, getManualSemanticCatalog, semanticEvidenceTargets, semanticEvidenceTargetLabel, semanticEvidenceLocationPresentation, buildKeywordSemanticAdviceMarkdown, semanticEvidenceFailureMessage, handleOpenSemanticEvidenceCommand, semanticEvidenceResolver, SemanticEvidenceResolver, keywordHoverMarkdown, supportedKeywordOptions, keywordOptionIsSupported, getStructuredManualContext, getManualChapterPresentation, appendManualLinks, cardCommentNoticeAppliesToField, buildCardCommentNoticeMarkdown, cardCommentRewriteRequest, analyzeKeywordStructureForDocument, DEFAULT_STRUCTURE_SOURCE_PROFILE_EN, KeywordStructureCatalog, analyzeKeywordStructureLines, keywordStructureCatalog, KEYWORD_STRUCTURE_HOVER_MAX_PHYSICAL_LINES, boundedCardCommentRewriteEnd, CARD_COMMENT_REWRITE_MAX_PHYSICAL_LINES, readyCardEditBlockIndex, cardEditKeywordIndexProviderRef, getCachedKeywordStructureAnalysis, keywordStructureAnalysisCache, CARD_COMMENT_REWRITE_MAX_DATA_LINES, cacheKeywordStructureAnalysis, estimateKeywordStructureAnalysisBytes, KEYWORD_STRUCTURE_DOCUMENT_CACHE_MAX_BYTES, KEYWORD_STRUCTURE_DOCUMENT_CACHE_MAX_ENTRIES, buildKeywordStructureIssueMarkdown, keywordStructureCheckLink, keywordStructureCheckRequest, keywordStructureDefiniteLabel, keywordStructureRepairRequest, keywordStructureDiagnosticIdentity, keywordStructureCheckMessage, handleCheckKeywordStructureCommand, buildPrefixLayoutIssueMarkdown, buildUnknownKeywordHoverMarkdown, LsdynaFieldHoverProvider, collectBoundedPrefixDataRecords, MAXIMUM_PREFIX_CARD_POSITION_LINES });

function keywordStructureAnalysisCacheStatsForTesting(document) {
    const cache = keywordStructureAnalysisCache.get(document);
    return {
        entries: cache?.values?.size || 0,
        bytes: cache?.bytes || 0,
        maximumEntries: KEYWORD_STRUCTURE_DOCUMENT_CACHE_MAX_ENTRIES,
        maximumBytes: KEYWORD_STRUCTURE_DOCUMENT_CACHE_MAX_BYTES,
    };
}
module.exports._internals.keywordStructureAnalysisCacheStatsForTesting = keywordStructureAnalysisCacheStatsForTesting;

Object.assign(module.exports._internals, { createActiveFieldChoiceController, officialFieldChoiceCommandRequest, planLsdynaFormatting, mapPositionThroughFormattingEdits, buildOfficialFieldChoiceHoverMarkdown, buildVerifiedConditionalCardEditMarkdown, cardNumbersLabel, planVerifiedConditionalCardsForDocument, planVerifiedConditionalCards, showVerifiedCardEditStatus, handleAddVerifiedConditionalCardsCommand, showOfficialFieldChoiceStatus, handlePickOfficialFieldValueCommand, createOfficialFieldChoicePicker, planOfficialFieldChoicesForDocument, planOfficialFieldChoices, buildCardCommentNoticeMarkdown, planCardCommentRewriteForDocument, cardCommentLabelCase, mostCommonCardCommentValue, CARD_COMMENT_REWRITE_MAX_EDITS, CARD_COMMENT_REWRITE_MAX_TEXT_BYTES, showCardCommentRewriteStatus, handleRebuildCardCommentsCommand, handleInsertVerifiedMissingRecordsCommand, LsdynaFieldHoverProvider, getCardFieldsForLine, buildOfficialFieldChoiceCompletionItems, editorQuickSuggestionsOtherEnabled, officialChoiceRoleLabel, LsdynaFieldCompletionProvider, inlineEditChoiceSession, LsdynaKeywordCompletionProvider, generateCommentLine, handleEnterIndentationRemoval, extractSmartTokens, hasDeclaredDefault, canOmitTrailingFields, planAlignedLine, alignLineText, parseTabValueOrder, analyzeTabLineInterpretation, valueOrderFieldIndexAtCaret, tabMeaningCandidateDetail, inlineEditChoiceSequence, clearInlineEditChoiceSession, cancelInlineEditChoiceSession, isInlineEditChoiceSessionValid, compactLinePreview, fixedCellPreview, startInlineEditChoiceSession, LsdynaEditChoiceCompletionProvider, applyInlineEditChoice, getPathEntryRange, splitIncludePathEntry, isIncludeFileKeyword, isSingleEightyColumnCard, formatPathEntryIfNeeded, createPathEntryFormatEdit, isFormattingLine, formatLineErrorObserverForTesting, setFormatLineErrorObserverForTesting, matchesConfiguredReadonlyPattern, isDocumentReadonlyForAutomaticEdit, formatLineIfNeeded, shouldPreserveTextCardLine, cardCellEditGuard, cardCellOwnedEditDepth, cardCellPostEditBarriers, cardCellTypingSessions, cardCellCompositions, cardCellASelectionGrace, CARD_CELL_A_SELECTION_GRACE_MS, clearCardCellTypingSession, canContinueCardCellTypingSession, rememberCardCellTypingSession, beginCardCellOwnedEdit, endCardCellOwnedEdit, isCardCellOwnedEdit, beginCardCellPostEditBarrier, waitForCardCellPostEdit, hasRecentCardCellSelectionGrace, waitForPendingCardCellPostEdit, ensureCardCellEditGuard, markCardCellA, cardCellASelectionGraceRemaining, executeNativeTab, isTabSelectionEligible, handleTabAlignment, lastActiveLineNum, lastActiveDoc, lastActiveDocumentVersion, activeEditorWasUndefined, cellSelectionSyncGeneration, cellSelectionSyncTimer, CELL_SELECTION_QUIET_MS, CARD_NATIVE_EDIT_SETTLE_MS, CARD_IME_CANCEL_SETTLE_MS, waitForCellSelectionQuietPeriod, handleSelectionChange, isDocumentStillOpenInTextTab, handleActiveEditorChangeForFormatting, applyCardCellLineEdit, applyCardCellLineDelete, handleCardCellDelete, readCardCellCompositionText, planCardCellComposition, finalizeCardCellComposition, cancelCardCellComposition, startEmptyCellBoundaryTypeChoice, handleCardCellTypeWithNavigation, handleCardCellType, handleCardCellPostEdit, planLineCommentToggle, planLineCommentTogglePure, LINE_COMMENT_TOGGLE_LIMITS, handleLineCommentToggle });

Object.assign(module.exports._internals, { optionSwitchReplacement, keywordLineWithTargetSpelling });

function writableKeywordOptions(entry, canonicalName) {
    return supportedKeywordOptions(entry, canonicalName).filter(option => {
        const order = parseKeywordOptionOrder(option);
        if (order.position === 'post') return true;
        if (order.position !== 'pre') return false;
        return keywordSchema.keywordPrefixOptionDecision(
            canonicalName,
            normalizeOptionName(option.n),
        ) === 'allow';
    });
}

async function canApplyDocumentEdit(document, isCurrent) {
    if (!isCurrent()) return false;
    const readonly = await isDocumentReadonlyForAutomaticEdit(document);
    if (!isCurrent()) return false;
    if (readonly) {
        vscode.window.setStatusBarMessage(i18n.get('editReadonly'), 5000);
        return false;
    }
    return true;
}

Object.assign(module.exports._internals, { chooseKeywordOptionsQuickPickLegacy, lookupWithActiveTitleOptions, verifiedPrefixCardsForSelection, keywordCardsManagedLines, legacyPrefixOptionCards, managedPrefixCommentReplacements, LsdynaKeywordOptionsCodeLensProvider, keywordOptionsViewControllerRef, chooseKeywordOptionsForEditor, blockedKeywordOptionSwitchPlan, OPTION_SWITCH_MAX_PHYSICAL_LINES, OPTION_SWITCH_MAX_DATA_RECORDS, collectOptionSwitchBlock, OPTION_SWITCH_MAX_BYTES, planOptionSwitch, planProvisionalOptionSwitch, keywordOptionTarget, keywordOptionLayoutProfile, keywordOptionLayoutCandidate, optionSwitchCardFromRecord, optionSwitchCommentAnalysis, optionSwitchCommentLine, keywordSpellingFromLine, keywordLineWithTargetSpelling, keywordOptionBlockSha256, nodeCrypto, keywordOptionsEditorForModel, locateKeywordManagerSource, openKeywordManagerManual, openKeywordManagerInstanceEditor, keywordManagerDisplayName, keywordManagerReadonlyUri, keywordManagerInstanceFileState, nativeFileLayoutKind, nativeFileLayoutCards, readNativeFileField, selectVerifiedSourceRecords, nativeBatchFixedBinding, keywordManagerNativeFileSelection, keywordRecordSerializer, keywordManagerNativeInstanceCounts, keywordManagerExpandNativeInstances, keywordManagerCatalogNativeFormRules, keywordManagerCatalogRules, keywordManagerCatalogCatalogForm, isKeywordManagerUnauditedCatalogAllowed, getCatalogInputFormCatalogV4, keywordManagerCatalogCatalogFailure, keywordManagerInstanceDirectories, keywordManagerInstances, resolveKeywordCategory, keywordManagerProjectInstances, keywordManagerCatalogFormFingerprint, keywordManagerCatalogNativeFormRule, keywordManagerCatalogEffectiveFormRules, keywordManagerCatalogEquivalentSpellings, keywordManagerCatalogSelectorRule, keywordManagerCatalogSelectorSpelling, keywordManagerCatalogSourceRecordCompatible, keywordManagerResolveCatalogSelectorState, legacyOptionRecord, getLegalSelectorValues, resolveSelectorPriorScore, resolveFormRulePriorScore, keywordManagerInferCatalogSelectorSelections, keywordManagerCatalogExplicitSpellingSelections, keywordManagerPrepareCatalogSelectorLayout, keywordManagerPrepareCatalogInputFormLayout, keywordManagerPrepareCatalogInputFormLayoutForRule, evaluatePredicate, keywordManagerFieldProjection, keywordManagerResolveSchemaField, managerHelpLookups, keywordManagerReadFieldHelp, keywordManagerHelpState, keywordManagerHasStaging, keywordManagerCapabilityProjection, keywordManagerEditField, keywordManagerStageFieldDrafts, buildKeywordOptionSwitchPlan, loadKeywordOptionGrammarRuntime, lookupKeywordOptionGrammar, lookupOperationalKeywordOptionGrammar, buildKeywordManagerCatalogPlan, buildKeywordOptionViewModel, keywordOptionProductLabels, keywordOptionEmptyViewState, keywordOptionPlanDetails, buildKeywordOptionsViewState, evaluateOptionGrammar, optionSwitchReplacement, applyKeywordOptionViewModel });

Object.assign(module.exports._internals, { trackKeywordManagerSourceChange, keywordManagerRefreshLine });

Object.assign(module.exports._internals, { prepareDocumentPresentation, updateDocumentPresentationAfterChange });

Object.assign(module.exports._internals, { prepareFieldInteraction, planPreparedOfficialFieldChoices });
