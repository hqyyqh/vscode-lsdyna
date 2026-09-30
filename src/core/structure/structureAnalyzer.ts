import { alignRecords, editSignature, type StructureAlignment } from './alignment';
import { expandGrammar, StructureExpansionError } from './grammarExpander';
import { mergeDecodedFields, evaluatePredicate } from './predicate';
import { planUniqueBlankRecordRepairs } from './repairPlanner';
import type { ObserveBlockResult } from './recordObservation';
import { observeKeywordBlock, type SourceLine } from './recordObservation';
import { KeywordStructureCatalog } from './structureCatalog';
import type {
    GrammarPath,
    ObservedKeywordBlock,
    RecordMapping,
    StructureAnalysis,
    StructureBudgets,
    StructureContext,
    StructureEdit,
    StructureGrammar,
    StructureNode,
} from './types';

export const DEFAULT_STRUCTURE_BUDGETS: StructureBudgets = {
    maximumRecords: 128,
    maximumPaths: 256,
    maximumExpandedRecords: 144,
    maximumAlignments: 32,
    maximumDynamicProgrammingCells: 100_000,
};

type Candidate = {
    path: GrammarPath;
    alignment: StructureAlignment;
    unresolved: string[];
};

export type AnalyzeGrammarOptions = {
    context?: StructureContext;
    budgets?: Partial<StructureBudgets>;
};

export type AnalyzeCatalogOptions = AnalyzeGrammarOptions & {
    catalog?: KeywordStructureCatalog;
    sourceProfileId?: string | null;
};

function budgets(options?: Partial<StructureBudgets>): StructureBudgets {
    return { ...DEFAULT_STRUCTURE_BUDGETS, ...(options || {}) };
}

function emptyResult(
    block: ObservedKeywordBlock,
    status: StructureAnalysis['status'],
    reason: string,
    details: Partial<StructureAnalysis> = {},
): StructureAnalysis {
    return {
        status,
        reason,
        keyword: block.keyword,
        observedDataRecords: block.records.length,
        records: [],
        diagnostics: [],
        dependencies: [],
        repairCandidates: [],
        block,
        ...details,
    };
}

function candidateFor(path: GrammarPath, alignment: StructureAlignment, context: StructureContext): Candidate | null {
    const environment = mergeDecodedFields(alignment.matches.map(value => value.match));
    const unresolved = [...path.dependencies];
    for (const assumption of path.assumptions) {
        const value = evaluatePredicate(assumption.predicate, environment, context);
        if ((value === 'true') !== assumption.expected && value !== 'unknown') return null;
        if (value === 'unknown') unresolved.push(`predicate:${assumption.nodeId}`);
    }
    return { path, alignment, unresolved: [...new Set(unresolved)] };
}

function mergedMappings(candidates: Candidate[], block: ObservedKeywordBlock): RecordMapping[] {
    const result: RecordMapping[] = [];
    for (const record of block.records) {
        const mappings = candidates
            .map(candidate => candidate.alignment.mappings.find(value =>
                value.observedOrdinal === record.ordinal))
            .filter(Boolean) as RecordMapping[];
        if (mappings.length === 0) {
            result.push({ observedOrdinal: record.ordinal, observedLine: record.line, status: 'extra' });
            continue;
        }
        const identities = new Set(mappings.map(mapping => JSON.stringify([
            mapping.status,
            mapping.expectedIndex,
            mapping.nodeId,
        ])));
        result.push(identities.size === 1
            ? mappings[0]
            : {
                observedOrdinal: record.ordinal,
                observedLine: record.line,
                status: 'mapping-ambiguous',
            });
    }
    return result;
}

function commonExpectedCount(candidates: Candidate[]): number | undefined {
    const lengths = new Set(candidates.map(candidate => candidate.path.records.length));
    return lengths.size === 1 ? [...lengths][0] : undefined;
}

function reasonForEdits(edits: StructureEdit[]): string {
    const kinds = new Set(edits.map(edit => edit.kind));
    if (kinds.size === 1 && kinds.has('insert')) return 'missing-required-records';
    if (kinds.size === 1 && kinds.has('delete')) return 'extra-records';
    if (kinds.size === 1 && kinds.has('substitute')) return 'record-geometry-mismatch';
    return 'structural-sequence-mismatch';
}

function pathBestCandidates(candidates: Candidate[]): Candidate[] {
    const byPath = new Map<GrammarPath, Candidate[]>();
    for (const candidate of candidates) {
        const values = byPath.get(candidate.path) || [];
        values.push(candidate);
        byPath.set(candidate.path, values);
    }
    const best: Candidate[] = [];
    for (const values of byPath.values()) {
        const minimum = Math.min(...values.map(value => value.alignment.score.edits));
        best.push(...values.filter(value => value.alignment.score.edits === minimum));
    }
    return best;
}

function nodeChildren(node: StructureNode | undefined): StructureNode[] {
    if (!node) return [];
    if (node.type === 'sequence' || node.type === 'repeatGroup') return node.nodes || [];
    if (node.type === 'choice') return node.branches || [];
    if (node.type === 'conditional') return [node.thenNode, node.elseNode].filter(Boolean) as StructureNode[];
    if (['optional', 'repeat', 'prefix', 'suffix', 'marker', 'continuation',
        'formatChoice', 'preprocessorGuard'].includes(node.type)) {
        return node.node ? [node.node] : [];
    }
    return [];
}

function grammarContainsNodeType(grammar: StructureGrammar, type: string): boolean {
    const pending: StructureNode[] = [
        grammar.root,
        ...(grammar.prefixes || []).map(item => item.node),
        ...(grammar.suffixes || []).map(item => item.node),
    ].filter(Boolean);
    const seen = new Set<StructureNode>();
    while (pending.length > 0) {
        const node = pending.pop();
        if (!node || seen.has(node)) continue;
        if (node.type === type) return true;
        seen.add(node);
        pending.push(...nodeChildren(node));
    }
    return false;
}

export function analyzeGrammarStructure(
    grammar: StructureGrammar,
    block: ObservedKeywordBlock,
    options: AnalyzeGrammarOptions = {},
): StructureAnalysis {
    const currentBudgets = budgets(options.budgets);
    const base = {
        sourceProfileId: grammar.sourceProfileId,
        bindingStatus: grammar.verificationStatus,
        grammarId: grammar.grammarId,
        verificationStatus: grammar.verificationStatus,
    };
    if (block.records.length > currentBudgets.maximumRecords) {
        return emptyResult(block, 'unsupported-input', 'record-budget-exceeded', base);
    }
    if (grammar.keyword !== block.keyword || grammar.sourceProfileId !== grammar.root?.sourceProfileId ||
        grammar.verificationStatus !== grammar.root?.verificationStatus ||
        !['verified-full', 'verified-boundary-only'].includes(grammar.verificationStatus)) {
        return emptyResult(block, 'unsupported-input', 'grammar-block-identity-mismatch', base);
    }
    let context = options.context || {};
    let keywordOptions: string[] = [];
    try {
        keywordOptions = context.keywordOptions === undefined
            ? []
            : typeof context.keywordOptions === 'string'
                ? [context.keywordOptions]
                : [...context.keywordOptions].map(value => String(value));
    } catch (_error) {
        return emptyResult(block, 'unsupported-input', 'keyword-options-context-invalid', base);
    }
    if (context.keywordOptions !== undefined) context = { ...context, keywordOptions };
    const activeOptions = new Set(keywordOptions
        .map(value => String(value).trim().toUpperCase()));
    const unverifiedOptions = (grammar.unsupportedOptions || [])
        .map(item => String(item.option || '').trim().toUpperCase())
        .filter(option => option && activeOptions.has(option));
    if (unverifiedOptions.length > 0) {
        return emptyResult(block, 'profile-unverified', 'active-keyword-option-unverified', {
            ...base,
            details: { keywordOptions: [...new Set(unverifiedOptions)].sort() },
        });
    }
    if (block.preprocessorMetadata.length > 0 &&
        !grammarContainsNodeType(grammar, 'preprocessorGuard')) {
        return emptyResult(block, 'unsupported-input', 'preprocessor-context-unmodeled', base);
    }
    if (grammar.verificationStatus === 'verified-boundary-only') {
        return emptyResult(
            block,
            'ambiguous',
            'verified-boundary-only-no-record-signatures',
            base,
        );
    }

    let paths: GrammarPath[];
    try {
        paths = expandGrammar(grammar, block.records.length, currentBudgets, context);
    } catch (error) {
        const reason = error instanceof StructureExpansionError
            ? error.reason
            : String(error?.message || error);
        return emptyResult(block, 'unsupported-input', reason, base);
    }
    if (paths.length === 0) return emptyResult(block, 'unsupported-input', 'grammar-has-no-legal-path', base);

    const candidates: Candidate[] = [];
    try {
        let dynamicProgrammingCells = 0;
        for (const path of paths) {
            dynamicProgrammingCells += (path.records.length + 1) * (block.records.length + 1);
            if (dynamicProgrammingCells > currentBudgets.maximumDynamicProgrammingCells) {
                throw new Error('alignment-cell-budget-exceeded');
            }
            for (const alignment of alignRecords(path, block.records, currentBudgets)) {
                const candidate = candidateFor(path, alignment, context);
                if (candidate) candidates.push(candidate);
            }
        }
    } catch (error) {
        return emptyResult(block, 'unsupported-input', String(error?.message || error), base);
    }
    if (candidates.length === 0) {
        return emptyResult(block, 'context-dependent', 'all-grammar-paths-depend-on-unresolved-context', {
            ...base,
            dependencies: ['predicate-resolution'],
        });
    }

    const bestByPath = pathBestCandidates(candidates);
    const zero = bestByPath.filter(candidate => candidate.alignment.score.edits === 0);
    if (zero.length > 0) {
        const unresolvedPaths = bestByPath.filter(candidate => candidate.unresolved.length > 0);
        const guaranteedCompletePath = zero.some(candidate => candidate.unresolved.length === 0);
        const contextCanChangeValidity = !guaranteedCompletePath &&
            unresolvedPaths.some(candidate => candidate.alignment.score.edits > 0);
        const records = mergedMappings(zero, block);
        const mappingAmbiguous = records.some(record => record.status === 'mapping-ambiguous') ||
            new Set(zero.map(candidate => candidate.path.branchTrace.join('|'))).size > 1;
        if (contextCanChangeValidity) {
            return emptyResult(block, 'context-dependent', 'unresolved-context-changes-structure-verdict', {
                ...base,
                expectedDataRecords: commonExpectedCount(zero),
                mappingAmbiguous,
                records,
                dependencies: [...new Set(unresolvedPaths.flatMap(candidate => candidate.unresolved))],
                details: { candidatePathCount: bestByPath.length, completePathCount: zero.length },
            });
        }
        return emptyResult(block, 'valid', mappingAmbiguous ? 'complete-with-ambiguous-mapping' : 'complete', {
            ...base,
            expectedDataRecords: commonExpectedCount(zero),
            mappingAmbiguous,
            records,
            dependencies: [...new Set(zero.flatMap(candidate => candidate.unresolved))],
            details: { candidatePathCount: bestByPath.length, completePathCount: zero.length },
        });
    }

    const minimum = Math.min(...bestByPath.map(candidate => candidate.alignment.score.edits));
    const minimumCandidates = bestByPath.filter(candidate => candidate.alignment.score.edits === minimum);
    if (minimumCandidates.some(candidate => candidate.alignment.unsupported)) {
        return emptyResult(block, 'unsupported-input', 'record-format-or-geometry-unsupported', {
            ...base,
            dependencies: [...new Set(minimumCandidates.flatMap(candidate => candidate.unresolved))],
        });
    }
    const allUnresolvedCandidates = bestByPath.filter(candidate => candidate.unresolved.length > 0);
    const potentiallyActiveSignatures = new Set(bestByPath.map(candidate =>
        editSignature(candidate.alignment.edits)));
    if (allUnresolvedCandidates.length > 0 && potentiallyActiveSignatures.size > 1) {
        return emptyResult(block, 'context-dependent', 'unresolved-context-changes-minimal-diagnostic', {
            ...base,
            expectedDataRecords: commonExpectedCount(minimumCandidates),
            records: mergedMappings(minimumCandidates, block),
            diagnostics: minimumCandidates[0].alignment.edits,
            alternativeDiagnostics: minimumCandidates.slice(1).map(value => value.alignment.edits),
            dependencies: [...new Set(allUnresolvedCandidates.flatMap(candidate => candidate.unresolved))],
        });
    }

    const signatures = new Set(minimumCandidates.map(candidate => editSignature(candidate.alignment.edits)));
    if (signatures.size !== 1) {
        return emptyResult(block, 'ambiguous', 'multiple-minimal-structure-edits', {
            ...base,
            expectedDataRecords: commonExpectedCount(minimumCandidates),
            records: mergedMappings(minimumCandidates, block),
            diagnostics: minimumCandidates[0].alignment.edits,
            alternativeDiagnostics: minimumCandidates.slice(1).map(value => value.alignment.edits),
            dependencies: [...new Set(minimumCandidates.flatMap(candidate => candidate.unresolved))],
        });
    }

    const selected = minimumCandidates[0];
    const repairCandidates = minimumCandidates.length === 1 && selected.unresolved.length === 0
        ? planUniqueBlankRecordRepairs(grammar, block, selected.path, selected.alignment.edits)
        : [];
    return emptyResult(block, 'definite-error', reasonForEdits(selected.alignment.edits), {
        ...base,
        expectedDataRecords: selected.path.records.length,
        records: selected.alignment.mappings,
        diagnostics: selected.alignment.edits,
        dependencies: [...new Set(selected.unresolved)],
        repairCandidates,
        details: { minimumEditCount: minimum, minimumAlignmentCount: minimumCandidates.length },
    });
}

export function analyzeObservedStructure(
    block: ObservedKeywordBlock,
    options: AnalyzeCatalogOptions = {},
): StructureAnalysis {
    const catalog = options.catalog || new KeywordStructureCatalog();
    const lookup = catalog.grammarForKeyword(options.sourceProfileId, block.keyword);
    if (lookup.status !== 'verified' || !lookup.grammar) {
        return emptyResult(
            block,
            lookup.status === 'unsupported-input' ? 'unsupported-input' : 'profile-unverified',
            lookup.reason,
            {
                sourceProfileId: lookup.sourceProfileId,
                bindingStatus: lookup.binding?.status,
                details: lookup.binding?.details,
            },
        );
    }
    return analyzeGrammarStructure(lookup.grammar, block, {
        ...options,
        // Catalog lookup is by the exact canonical keyword identity. If the
        // caller did not supply option context, the base identity therefore has
        // no active grammar-level prefix/suffix options; reviewed variants have
        // their own binding and cannot silently borrow this base grammar.
        context: options.context?.keywordOptions === undefined
            ? { ...(options.context || {}), keywordOptions: [] }
            : options.context,
    });
}

export function analyzeKeywordStructureLines(
    keywordLineText: string,
    bodyLines: SourceLine[],
    options: AnalyzeCatalogOptions & { keywordLine?: number; maximumPhysicalLines?: number } = {},
): StructureAnalysis {
    const observation: ObserveBlockResult = observeKeywordBlock(keywordLineText, bodyLines, {
        keywordLine: options.keywordLine,
        maximumPhysicalLines: options.maximumPhysicalLines,
        maximumRecords: budgets(options.budgets).maximumRecords,
    });
    if (!observation.block) {
        const keyword = String(keywordLineText || '').trim().split(/[\s,]+/, 1)[0].toUpperCase();
        return {
            status: 'unsupported-input',
            reason: observation.reason,
            keyword,
            sourceProfileId: options.sourceProfileId || undefined,
            observedDataRecords: 0,
            records: [],
            diagnostics: [],
            dependencies: [],
            repairCandidates: [],
        };
    }
    return analyzeObservedStructure(observation.block, options);
}
