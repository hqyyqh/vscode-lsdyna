import { evaluatePredicate } from './predicate';
import type {
    ExpectedRecord,
    GrammarPath,
    StructureBudgets,
    StructureContext,
    StructureGrammar,
    StructureNode,
} from './types';

export class StructureExpansionError extends Error {
    constructor(public readonly reason: string) {
        super(reason);
    }
}

type ExpansionState = {
    observedCount: number;
    budgets: StructureBudgets;
    context: StructureContext;
};

function emptyPath(): GrammarPath {
    return { records: [], assumptions: [], dependencies: [], branchTrace: [] };
}

function merge(left: GrammarPath, right: GrammarPath): GrammarPath {
    return {
        records: [...left.records, ...right.records],
        assumptions: [...left.assumptions, ...right.assumptions],
        dependencies: [...new Set([...left.dependencies, ...right.dependencies])],
        branchTrace: [...left.branchTrace, ...right.branchTrace],
    };
}

function ensureBudget(paths: GrammarPath[], state: ExpansionState): GrammarPath[] {
    if (paths.length > state.budgets.maximumPaths ||
        paths.some(path => path.records.length > state.budgets.maximumExpandedRecords)) {
        throw new StructureExpansionError('grammar-expansion-budget-exceeded');
    }
    return paths;
}

function product(left: GrammarPath[], right: GrammarPath[], state: ExpansionState): GrammarPath[] {
    const result: GrammarPath[] = [];
    for (const first of left) {
        for (const second of right) {
            result.push(merge(first, second));
            if (result.length > state.budgets.maximumPaths) {
                throw new StructureExpansionError('grammar-path-budget-exceeded');
            }
        }
    }
    return ensureBudget(result, state);
}

function sequence(nodes: StructureNode[], state: ExpansionState): GrammarPath[] {
    let result = [emptyPath()];
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (node.type === 'optional' && node.omission === 'trailing-only' && index !== nodes.length - 1) {
            throw new StructureExpansionError('trailing-only-optional-is-not-terminal');
        }
        result = product(result, expandNode(node, state), state);
    }
    return result;
}

function withWrapper(paths: GrammarPath[], wrapper: string): GrammarPath[] {
    return paths.map(path => ({
        ...path,
        records: path.records.map(record => ({
            ...record,
            wrappers: [...record.wrappers, wrapper],
        })),
    }));
}

function withMarker(paths: GrammarPath[], marker: unknown): GrammarPath[] {
    return paths.map(path => {
        if (path.records.length === 0) return path;
        const records = [...path.records];
        records[0] = { ...records[0], marker };
        return { ...path, records };
    });
}

function repeatCounts(node: StructureNode, state: ExpansionState): {
    counts: number[];
    dependencies: string[];
    countField?: string;
} {
    if (node.min !== undefined && (!Number.isInteger(node.min) || Number(node.min) < 0)) {
        throw new StructureExpansionError('repeat-minimum-invalid');
    }
    const minimum = Number.isInteger(node.min) ? Math.max(0, Number(node.min)) : 0;
    if (node.max !== undefined && (!Number.isInteger(node.max) || Number(node.max) < minimum)) {
        throw new StructureExpansionError('repeat-maximum-invalid');
    }
    let maximum = Number.isInteger(node.max)
        ? Math.max(minimum, Number(node.max))
        : Math.max(minimum, state.observedCount + 1);
    if (minimum > state.budgets.maximumExpandedRecords) {
        throw new StructureExpansionError('grammar-expansion-budget-exceeded');
    }
    const dependencies: string[] = [];
    if (node.countFrom !== undefined) {
        if (typeof node.countFrom === 'number') {
            const count = Number(node.countFrom);
            if (Number.isInteger(count) && count >= minimum && count <= maximum) {
                return { counts: [count], dependencies };
            }
            throw new StructureExpansionError('repeat-count-out-of-range');
        }
        if (typeof node.countFrom === 'string') {
            return {
                counts: Array.from(
                    { length: Math.min(maximum, state.budgets.maximumExpandedRecords) - minimum + 1 },
                    (_, index) => minimum + index,
                ),
                countField: node.countFrom,
                dependencies: node.until === undefined ? [] : [`terminator:${node.nodeId}`],
            };
        }
        dependencies.push(`count:${node.nodeId}`);
    }
    if (node.until !== undefined) dependencies.push(`terminator:${node.nodeId}`);
    maximum = Math.min(maximum, state.budgets.maximumExpandedRecords);
    const counts = [];
    for (let count = minimum; count <= maximum; count++) counts.push(count);
    return { counts, dependencies };
}

function repeatNode(node: StructureNode, state: ExpansionState, group: boolean): GrammarPath[] {
    const child = group
        ? { ...node, type: 'sequence', nodes: node.nodes || [] }
        : node.node;
    if (!child) throw new StructureExpansionError('repeat-node-missing-child');
    const unit = expandNode(child as StructureNode, state);
    if (unit.some(path => path.records.length === 0)) {
        throw new StructureExpansionError('repeat-node-can-consume-zero-records');
    }
    const { counts, dependencies, countField } = repeatCounts(node, state);
    const results: GrammarPath[] = [];
    for (const count of counts) {
        let paths = [emptyPath()];
        for (let index = 0; index < count; index++) paths = product(paths, unit, state);
        for (const path of paths) {
            results.push({
                ...path,
                assumptions: countField
                    ? [...path.assumptions, {
                        predicate: { op: 'eq', field: countField, value: count },
                        expected: true,
                        nodeId: `${node.nodeId}:count`,
                    }]
                    : path.assumptions,
                dependencies: [...new Set([...path.dependencies, ...dependencies])],
                branchTrace: [...path.branchTrace, `${node.nodeId}:repeat=${count}`],
            });
        }
    }
    return ensureBudget(results, state);
}

function choicePaths(node: StructureNode, state: ExpansionState): GrammarPath[] {
    const cardinality = node.cardinality || 'exactly-one';
    if (!['exactly-one', 'at-most-one', 'one-or-more'].includes(cardinality)) {
        throw new StructureExpansionError('choice-cardinality-unsupported');
    }
    const branches = node.branches || [];
    const expanded = branches.map((branch, index) =>
        expandNode(branch, state).map(path => ({
            ...path,
            branchTrace: [...path.branchTrace, `${node.nodeId}:choice=${index}`],
        })),
    );
    if (cardinality === 'at-most-one') return ensureBudget([emptyPath(), ...expanded.flat()], state);
    if (cardinality === 'one-or-more') {
        if (expanded.length > 20 || (2 ** expanded.length) - 1 > state.budgets.maximumPaths) {
            throw new StructureExpansionError('grammar-path-budget-exceeded');
        }
        let combinations: GrammarPath[] = [];
        for (let mask = 1; mask < 2 ** expanded.length; mask++) {
            let paths = [emptyPath()];
            for (let index = 0; index < expanded.length; index++) {
                if ((mask & (1 << index)) !== 0) paths = product(paths, expanded[index], state);
            }
            combinations = combinations.concat(paths);
            ensureBudget(combinations, state);
        }
        return combinations;
    }
    return ensureBudget(expanded.flat(), state);
}

function contextRequirementState(requirement: any, state: ExpansionState): 'true' | 'false' | 'unknown' {
    if (requirement?.op) return evaluatePredicate(requirement, new Map(), state.context);
    if (typeof requirement === 'string') {
        if (!state.context.preprocessor || !(requirement in state.context.preprocessor)) return 'unknown';
        return state.context.preprocessor[requirement] ? 'true' : 'false';
    }
    return 'unknown';
}

function keywordOptionSet(context: StructureContext): Set<string> | null {
    if (context.keywordOptions === undefined) return null;
    let values: unknown[];
    try {
        values = typeof context.keywordOptions === 'string'
            ? [context.keywordOptions]
            : [...context.keywordOptions];
    } catch (_error) {
        throw new StructureExpansionError('keyword-options-context-invalid');
    }
    return new Set(values.map(value => String(value).trim().toUpperCase()));
}

function predicateUsesDecodedField(predicate: any): boolean {
    if (!predicate || typeof predicate !== 'object') return false;
    if (typeof predicate.field === 'string' && predicate.field.trim() !== '') return true;
    if (predicateUsesDecodedField(predicate.predicate)) return true;
    return Array.isArray(predicate.predicates) && predicate.predicates.some(predicateUsesDecodedField);
}

export function expandNode(node: StructureNode, state: ExpansionState): GrammarPath[] {
    if (!node || typeof node !== 'object') throw new StructureExpansionError('grammar-node-invalid');
    switch (node.type) {
        case 'empty':
            return [emptyPath()];
        case 'record':
        case 'opaqueRecord': {
            const expected: ExpectedRecord = {
                node,
                nodeId: node.nodeId,
                cardNodeId: node.cardNodeId,
                cardLabel: String(node.cardLabel || node.cardNodeId || 'record'),
                wrappers: [],
            };
            return [{ ...emptyPath(), records: [expected] }];
        }
        case 'sequence':
            return sequence(node.nodes || [], state);
        case 'choice':
            return choicePaths(node, state);
        case 'conditional': {
            if (!node.predicate || !node.thenNode) {
                throw new StructureExpansionError('conditional-node-incomplete');
            }
            // A contextual field is only a fallback for an absent/parameterized decoded field.
            // Until alignment has decoded the record, pruning a field-controlled branch could
            // discard the authoritative path. Candidate validation below resolves it safely.
            const evaluated = predicateUsesDecodedField(node.predicate)
                ? 'unknown'
                : evaluatePredicate(node.predicate, new Map(), state.context);
            const thenPaths = expandNode(node.thenNode, state).map(path => ({
                ...path,
                assumptions: [...path.assumptions, {
                    predicate: node.predicate,
                    expected: true,
                    nodeId: node.nodeId,
                }],
                branchTrace: [...path.branchTrace, `${node.nodeId}:then`],
            }));
            const elsePaths = (node.elseNode ? expandNode(node.elseNode, state) : [emptyPath()]).map(path => ({
                ...path,
                assumptions: [...path.assumptions, {
                    predicate: node.predicate,
                    expected: false,
                    nodeId: node.nodeId,
                }],
                branchTrace: [...path.branchTrace, `${node.nodeId}:else`],
            }));
            if (evaluated === 'true') return thenPaths;
            if (evaluated === 'false') return elsePaths;
            return ensureBudget([...thenPaths, ...elsePaths], state);
        }
        case 'optional': {
            if (!node.node) throw new StructureExpansionError('optional-node-missing-child');
            if (node.omission !== undefined &&
                node.omission !== 'explicit' && node.omission !== 'trailing-only') {
                throw new StructureExpansionError('optional-omission-unsupported');
            }
            return ensureBudget([emptyPath(), ...expandNode(node.node, state)], state);
        }
        case 'repeat':
            return repeatNode(node, state, false);
        case 'repeatGroup':
            return repeatNode(node, state, true);
        case 'textBody': {
            if (node.minLines !== undefined &&
                (!Number.isInteger(node.minLines) || Number(node.minLines) < 0)) {
                throw new StructureExpansionError('text-body-minimum-invalid');
            }
            const minimum = Number.isInteger(node.minLines) ? Math.max(0, Number(node.minLines)) : 0;
            if (node.maxLines !== undefined &&
                (!Number.isInteger(node.maxLines) || Number(node.maxLines) < minimum)) {
                throw new StructureExpansionError('text-body-maximum-invalid');
            }
            const maximum = Number.isInteger(node.maxLines)
                ? Math.max(minimum, Number(node.maxLines))
                : Math.max(minimum, state.observedCount);
            const synthetic: StructureNode = {
                ...node,
                type: 'opaqueRecord',
                cardNodeId: String(node.cardNodeId || `${node.nodeId}:text`),
                cardLabel: String(node.cardLabel || 'text body'),
                blankAllowed: true,
                geometryRef: { kind: 'text-body', mode: node.mode, terminator: node.terminator },
            };
            const paths: GrammarPath[] = [];
            for (let count = minimum; count <= Math.min(maximum, state.budgets.maximumExpandedRecords); count++) {
                paths.push({
                    ...emptyPath(),
                    records: Array.from({ length: count }, () => ({
                        node: synthetic,
                        nodeId: synthetic.nodeId,
                        cardNodeId: synthetic.cardNodeId,
                        cardLabel: String(synthetic.cardLabel),
                        wrappers: ['textBody'],
                    })),
                    // Raw text termination is deliberately not inferred from record count.
                    // A future matcher may discharge this dependency after checking the exact
                    // terminator; until then every such body stays fail-closed.
                    dependencies: [`text-terminator:${node.nodeId}`],
                });
            }
            return ensureBudget(paths, state);
        }
        case 'marker':
            if (!node.node) throw new StructureExpansionError('marker-node-missing-child');
            return withMarker(expandNode(node.node, state), node.value ?? node.marker);
        case 'continuation':
            if (!node.node) throw new StructureExpansionError('continuation-node-missing-child');
            return withMarker(
                withWrapper(expandNode(node.node, state), 'continuation'),
                node.marker ?? node.value,
            );
        case 'prefix':
        case 'suffix': {
            if (!node.node) throw new StructureExpansionError(`${node.type}-node-missing-child`);
            const option = String(node.option || '').trim().toUpperCase();
            const options = keywordOptionSet(state.context);
            if (option && options && !options.has(option)) return [emptyPath()];
            const paths = withWrapper(expandNode(node.node, state), `${node.type}:${option}`);
            if (!option || options) return paths;
            return ensureBudget([
                { ...emptyPath(), dependencies: [`keyword-option:${option}`] },
                ...paths.map(path => ({
                    ...path,
                    dependencies: [...new Set([...path.dependencies, `keyword-option:${option}`])],
                })),
            ], state);
        }
        case 'formatChoice':
            if (!node.node) throw new StructureExpansionError('format-choice-node-missing-child');
            return withWrapper(expandNode(node.node, state).map(path => ({
                ...path,
                records: path.records.map(record => {
                    const declared = Array.isArray(node.formats)
                        ? node.formats
                        : Array.isArray(node.choices)
                            ? node.choices
                            : null;
                    return declared
                        ? { ...record, node: { ...record.node, formatChoice: declared } }
                        : record;
                }),
            })), 'formatChoice');
        case 'preprocessorGuard': {
            if (!node.node) throw new StructureExpansionError('preprocessor-guard-node-missing-child');
            const evaluated = contextRequirementState(node.contextRequirement, state);
            if (evaluated === 'true') return expandNode(node.node, state);
            if (evaluated === 'false') return [emptyPath()];
            return ensureBudget([
                { ...emptyPath(), dependencies: [`preprocessor:${node.nodeId}`] },
                ...expandNode(node.node, state).map(path => ({
                    ...path,
                    dependencies: [...new Set([...path.dependencies, `preprocessor:${node.nodeId}`])],
                })),
            ], state);
        }
        default:
            throw new StructureExpansionError(`unsupported-grammar-node:${node.type}`);
    }
}

function optionNode(
    grammar: StructureGrammar,
    context: StructureContext,
    kind: 'prefixes' | 'suffixes',
): StructureNode[] {
    const options = keywordOptionSet(context);
    return (grammar[kind] || []).flatMap(item => {
        const option = String(item.option || '').trim().toUpperCase();
        if (options) return options.has(option) ? [item.node] : [];
        return [{
            type: kind === 'prefixes' ? 'prefix' : 'suffix',
            nodeId: `${item.node.nodeId}:${kind}:${option}`,
            sourceProfileId: item.node.sourceProfileId,
            verificationStatus: item.node.verificationStatus,
            evidenceIds: item.node.evidenceIds,
            locations: item.node.locations,
            option,
            node: item.node,
        }];
    });
}

export function expandGrammar(
    grammar: StructureGrammar,
    observedCount: number,
    budgets: StructureBudgets,
    context: StructureContext = {},
): GrammarPath[] {
    const state = { observedCount, budgets, context };
    const nodes = [
        ...optionNode(grammar, context, 'prefixes'),
        grammar.root,
        ...optionNode(grammar, context, 'suffixes'),
    ];
    const paths = sequence(nodes, state);
    const unique = new Map<string, GrammarPath>();
    for (const path of paths) {
        const key = JSON.stringify({
            records: path.records.map(record => [
                record.nodeId,
                record.marker,
                record.wrappers,
                record.node.formatChoice,
            ]),
            assumptions: path.assumptions.map(value => [
                value.nodeId,
                value.expected,
                value.predicate,
            ]),
            dependencies: [...path.dependencies].sort(),
            branchTrace: path.branchTrace,
        });
        if (!unique.has(key)) unique.set(key, path);
    }
    return ensureBudget([...unique.values()], state);
}
