'use strict';

const {
    SemanticRuntimeCatalogV2,
    getSemanticRuntimeCatalogV2,
    resetSemanticRuntimeCatalogV2ForTesting,
    semanticRuntimeV2Root,
} = require('../semantics/semanticRuntimeV2');

export type {
    KeywordOptionGrammarV2 as KeywordOptionGrammar,
    KeywordOptionGrammarV2,
    OptionTargetV2,
    OptionLayoutProfileV2,
    FieldMigrationBindingV2,
} from '../semantics/semanticRuntimeV2';

export type KeywordOptionGrammarRuntime = {
    schemaVersion: 2;
    kind: 'dynasense-keyword-option-runtime-v2';
    datasetReleaseId: string;
    source: Record<string, unknown>;
    permissions: Record<string, boolean>;
    summary: Record<string, number>;
    grammars: any[];
    contentSha256: string;
};

let cachedFacade: KeywordOptionGrammarRuntime | null | undefined;

export function keywordOptionGrammarRuntimePath(): string {
    return semanticRuntimeV2Root();
}

export function loadKeywordOptionGrammarRuntime(
    runtimeRoot = keywordOptionGrammarRuntimePath(),
): KeywordOptionGrammarRuntime | null {
    if (cachedFacade !== undefined && runtimeRoot === keywordOptionGrammarRuntimePath()) return cachedFacade;
    try {
        const catalog = runtimeRoot === keywordOptionGrammarRuntimePath()
            ? getSemanticRuntimeCatalogV2()
            : new SemanticRuntimeCatalogV2(runtimeRoot);
        const manifest = catalog.manifest();
        const facade: KeywordOptionGrammarRuntime = {
            schemaVersion: 2,
            kind: 'dynasense-keyword-option-runtime-v2',
            datasetReleaseId: manifest.datasetReleaseId,
            source: manifest.source,
            permissions: manifest.permissions,
            summary: manifest.summary,
            grammars: catalog.allOptionGrammars(),
            contentSha256: manifest.contentSha256,
        };
        if (runtimeRoot === keywordOptionGrammarRuntimePath()) cachedFacade = facade;
        return facade;
    } catch (_error) {
        if (runtimeRoot === keywordOptionGrammarRuntimePath()) cachedFacade = null;
        return null;
    }
}

export function lookupKeywordOptionGrammar(spelling: string, runtime: KeywordOptionGrammarRuntime | null = null) {
    if (runtime) {
        const normalized = String(spelling || '').trim().toUpperCase().replace(/^\*/, '');
        const withStar = `*${normalized.replace(/[+%\-]$/, '')}`;
        const matches = (runtime.grammars || []).filter(grammar =>
            (grammar.targets || []).some(target => String(target.spelling).toUpperCase() === withStar));
        return matches.length === 1 ? matches[0] : null;
    }
    try { return getSemanticRuntimeCatalogV2().optionGrammarForSpelling(spelling); }
    catch (_error) { return null; }
}

export function clearKeywordOptionGrammarRuntimeCacheForTesting(): void {
    cachedFacade = undefined;
    resetSemanticRuntimeCatalogV2ForTesting();
}

module.exports = {
    keywordOptionGrammarRuntimePath,
    loadKeywordOptionGrammarRuntime,
    lookupKeywordOptionGrammar,
    clearKeywordOptionGrammarRuntimeCacheForTesting,
};
