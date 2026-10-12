/** Yield between the existing CommonJS dependency groups before registering the extension. */
let extension: any;

export async function activate(context) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const path = require('node:path');
    const entryRequire = require('node:module').createRequire(path.join(__dirname, '../extension.js'));
    const clientRoot = path.dirname(require.resolve('vscode-languageclient/node'));
    // ponytail: the locked CommonJS client cannot yield while evaluating one module.
    // Prepare its existing dependency groups separately; revisit when it offers async initialization.
    const dependencies = [
        () => require('vscode-jsonrpc/node'),
        () => require('vscode-languageserver-types'),
        () => require('vscode-languageserver-protocol/node'),
        () => require(path.join(clientRoot, '../common/codeConverter')),
        () => require(path.join(clientRoot, '../common/protocolConverter')),
        () => require(path.join(clientRoot, '../common/diagnostic')),
        () => require(path.join(clientRoot, '../common/notebook')),
        () => require(path.join(clientRoot, '../common/fileOperations')),
        () => require(path.join(clientRoot, '../common/configuration')),
        () => require(path.join(clientRoot, '../common/textSynchronization')),
        () => require(path.join(clientRoot, '../common/completion')),
        () => require(path.join(clientRoot, '../common/semanticTokens')),
        () => require(path.join(clientRoot, '../common/fileSystemWatcher')),
        () => require(path.join(clientRoot, '../common/codeAction')),
        () => require(path.join(clientRoot, '../common/workspaceSymbol')),
        () => require(path.join(clientRoot, '../common/callHierarchy')),
        () => require(path.join(clientRoot, '../common/typeHierarchy')),
        ...['hover', 'definition', 'signatureHelp', 'documentHighlight', 'documentSymbol', 'reference',
            'typeDefinition', 'implementation', 'colorProvider', 'codeLens', 'formatting', 'rename',
            'documentLink', 'executeCommand', 'foldingRange', 'declaration', 'selectionRange',
            'linkedEditingRange', 'inlineValue', 'inlayHint', 'workspaceFolder', 'inlineCompletion',
            'textDocumentContent', 'progress'].map(name => () => require(path.join(clientRoot, '../common', name))),
        () => require(path.join(clientRoot, '../common/client')),
        () => require('vscode-languageclient/node'),
        // Use the entry's resolution cache too, so it does not repeat synchronous path lookups.
        ...[
            "./core/semantics/nativeConditionalLayout", "./core/semantics/catalogNativeFileLayout",
            "./core/semantics/semanticRuntimeV2",
            "./core/references/onDemandDefinitionScanner", "./core/references/indexedEntityQuery",
            "./core/keywordSchema",
            "./client/EntityReferencesWebviewProvider", "./client/providers/keywordIndexProvider",
            "./manual/ManualReaderPanel", "./client/services/keywordManager",
            "./core/references/registryReferenceScanner", "./core/structure",
            "./client/KeywordOptionsWebviewProvider", "./client/services/lsdynaFormatting",
            "./core/manualIndexer", "./core/semantics/officialFieldChoicePlanner",
            "./core/semantics/manualSemanticAdvisor", "./core/edit/cardCellModel",
            "./client/changeMarks/changeMarksController", "./client/providers/includeTreeProvider",
            "./client/services/customValidKeywordsUi", "./client/services/healthService",
            "./client/statusBar/dashboard", "./core/semantics/semanticEvidencePresentation",
            "./core/completion/includePathCompletion", "./client/services/indexClient",
            "./client/LargeFileViewerProvider", "./client/services/treeSearchQuickPick",
            "./core/references/fieldReferenceHover", "./manual/ManualPackManager",
            "./client/services/keywordManagerApply", "./client/services/officialFieldChoicePicker",
            "./client/services/keywordStructureDiagnostics", "./core/semantics/semanticDocumentContext",
            "./core/semantics/conditionalPresentation", "./client/services/documentEditGuard",
            "./manual/manualsDirResolve", "./manual/ManualIndexRepository",
            "./manual/ManualSidebarProvider", "./client/providers/entityReferenceProvider",
            "./client/services/workspaceWatcherManager", "./client/services/projectDiagnosticStore",
            "./client/services/includePathSuggestTrigger", "./client/services/cardCellEditGuard",
            "./client/services/jumpPulse", "./core/theme/extensionTheme",
            "./client/services/customValidKeywords", "./core/keywordSuggest",
            "./platform/externalProcess",
            "./core/incremental/fileInvalidation", "./core/parser/includeScanner",
            "./core/parser/keywordScanner", "./core/parser/keywordValidator",
            "./core/parser/keywordLine", "./core/parser/parameterScanner",
            "./core/parser/parameterSyntax", "./core/fs/pathCaseFidelity",
            "./worker/workerPool", "./worker/projectIndexLoader",
            "./core/i18n", "./core/references/fieldReferenceClassifier",
            "./core/references/projectReferenceIndex", "./core/project/mainDeckContextSelection",
            "./core/references/curveTableDefinitionScanner", "./core/hover/fieldHelpPresentation",
            "./core/hover/fieldHelpEnglishStore", "./core/project/effectiveSearchPathLookup",
            "./core/completion/fieldComment", "./core/parser/inputFormat",
            "./core/parser/opaqueCommentRange", "./core/scanner/largeFileWindowReader",
            "./core/scanner/scannerContracts", "./core/parser/blockScanner", "./core/references/definitionRegistry",
            "./core/references/familyDefinitionScannerCatalog", "./core/references/registryReferenceNetwork",
            "./core/references/referenceNavigation", "./core/references/workspaceReferenceSearch",
            "./core/references/entityReferenceQueryService", "./core/references/curvePlotRenderer",
            "./core/references/parameterDefinitionScanner", "./core/semantics/manualSemanticCatalog",
            "./core/semantics/relaxedModelEvidenceV1", "./core/semantics/provisionalFieldHelp",
            "./core/semantics/semanticEvidenceResolver", "./client/services/activeFieldChoiceController",
            "./core/edit/lineCommentToggle", "./core/semantics/cardEditPlanner",
            "./core/keywordCategory", "./core/semantics/catalogInputFormCatalogV4",
            "./core/options/keywordOptionGrammarCatalog", "./core/options/optionSwitchPlanner",
            "./core/options/optionGrammarEvaluator", "./core/semantics/predicateEvaluator",
            "./core/semantics/catalogPriorRules", "./core/edit/keywordRecordSerializer",
            "./core/cache/entityIndexBudget",
            "./core/references/entityQueryCache",
        ].map(name => () => entryRequire(name)),
    ];
    let started = performance.now();
    for (const prepare of dependencies) {
        prepare();
        // A timer turn also lets already-due UI timers run between CommonJS groups.
        if (performance.now() - started >= 8) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            started = performance.now();
        }
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    extension = require('../extension');
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    return extension.activate(context);
}

export function deactivate() { return extension?.deactivate?.(); }
