'use strict';

const assert = require('assert');
const {
    DEFAULT_STRUCTURE_BUDGETS,
    evaluatePredicate,
    expandGrammar,
    mergeDecodedFields,
    StructureExpansionError,
} = require('../../../src/core/structure');

const profile = 'a'.repeat(64);
let counter = 0;
function node(type, values = {}) {
    return {
        type,
        nodeId: `structure-node:test-${++counter}`,
        sourceProfileId: profile,
        verificationStatus: 'verified-full',
        evidenceIds: [],
        locations: [],
        ...values,
    };
}
function record(label) {
    return node('record', {
        cardNodeId: label,
        cardLabel: label,
        blankAllowed: true,
        formatChoice: ['standard-fixed', 'free-comma'],
        geometryRef: { kind: 'wildcard' },
    });
}
function grammar(root) {
    return {
        grammarId: 'structure-grammar:test',
        keyword: '*TEST',
        sourceProfileId: profile,
        verificationStatus: 'verified-full',
        root,
    };
}

describe('three-state predicates and generic grammar expansion', () => {
    it('evaluates numeric, set, blank, boolean, option and context predicates in three states', () => {
        const fields = mergeDecodedFields([{ decodedFields: [
            { name: 'RATE', raw: '8', value: 8, state: 'known', typeCode: 'F' },
            { name: 'EMPTY', raw: '', state: 'blank', typeCode: 'F' },
            { name: 'PARAM', raw: '&P', state: 'parameter', typeCode: 'F' },
        ] }]);
        assert.equal(evaluatePredicate({ op: 'eq', field: 'rate', value: 8 }, fields), 'true');
        assert.equal(evaluatePredicate({ op: 'gt', field: 'RATE', value: 7 }, fields), 'true');
        assert.equal(evaluatePredicate({ op: 'in', field: 'RATE', values: [7, 8] }, fields), 'true');
        assert.equal(evaluatePredicate({ op: 'not-in', field: 'RATE', values: [8] }, fields), 'false');
        assert.equal(evaluatePredicate({ op: 'blank', field: 'EMPTY' }, fields), 'true');
        assert.equal(evaluatePredicate({ op: 'eq', field: 'EMPTY', value: 9 }, fields, {
            fields: { EMPTY: 9 },
        }), 'unknown', 'external context must not overwrite an observed blank field');
        assert.equal(evaluatePredicate({ op: 'nonblank', field: 'PARAM' }, fields), 'unknown');
        assert.equal(evaluatePredicate({ op: 'eq', field: 'PARAM', value: 1 }, fields), 'unknown');
        assert.equal(evaluatePredicate({
            op: 'all', predicates: [
                { op: 'eq', field: 'RATE', value: 8 },
                { op: 'blank', field: 'EMPTY' },
            ],
        }, fields), 'true');
        assert.equal(evaluatePredicate({ op: 'not', predicate: { op: 'eq', field: 'RATE', value: 8 } }, fields),
            'false');
        assert.equal(evaluatePredicate({ op: 'keyword-option', value: 'TITLE' }, fields, {
            keywordOptions: ['title'],
        }), 'true');
        assert.equal(evaluatePredicate({ op: 'solver-mode', value: 'MPP' }, fields, { solverMode: 'MPP' }), 'true');
    });

    it('keeps unsupported decoded integers unknown even with stale context or another occurrence', () => {
        const unsupported = { name: 'COUNT', raw: '9007199254740993', state: 'unsupported', typeCode: 'I' };
        for (const extra of [[], [{ name: 'COUNT', raw: '2', value: 2, state: 'known', typeCode: 'I' }]]) {
            const fields = mergeDecodedFields([{ decodedFields: [unsupported, ...extra] }]);
            for (const op of ['eq', 'ne', 'in', 'not-in', 'gt', 'present', 'blank', 'nonblank']) {
                assert.equal(evaluatePredicate({ op, field: 'COUNT', value: 2, values: [2] }, fields,
                    { fields: { COUNT: 2 } }), 'unknown', op);
            }
        }
    });

    it('expands sequence, empty, exact/optional choices, conditionals and optional nodes', () => {
        const root = node('sequence', { nodes: [
            record('A'),
            node('empty'),
            node('choice', { cardinality: 'exactly-one', branches: [record('B1'), record('B2')] }),
            node('choice', { cardinality: 'at-most-one', branches: [record('C')] }),
            node('optional', { node: record('D'), omission: 'explicit' }),
            node('conditional', {
                predicate: { op: 'eq', field: 'FLAG', value: 1 },
                thenNode: record('E1'),
                elseNode: record('E0'),
            }),
        ] });
        const paths = expandGrammar(grammar(root), 5, DEFAULT_STRUCTURE_BUDGETS, {});
        assert.equal(paths.length, 16);
        assert.ok(paths.every(path => path.records[0].cardLabel === 'A'));
        assert.ok(paths.every(path => path.assumptions.length === 1));
        assert.deepEqual(new Set(paths.map(path => path.assumptions[0].expected)), new Set([true, false]));
    });

    it('expands repeats, repeat groups, text bodies, markers, wrappers, and preprocessor guards', () => {
        const root = node('sequence', { nodes: [
            node('repeat', { node: record('R'), min: 1, max: 2 }),
            node('repeatGroup', { nodes: [record('G1'), record('G2')], min: 1, max: 1 }),
            node('marker', { value: { kind: 'column-one', value: '&' }, node: record('M') }),
            node('continuation', { marker: { kind: 'suffix', value: '+' }, node: record('N') }),
            node('formatChoice', { node: record('F') }),
            node('prefix', { option: 'TITLE', node: record('P') }),
            node('suffix', { option: 'TAIL', node: record('S') }),
            node('preprocessorGuard', { contextRequirement: 'FEATURE', node: record('Q') }),
            node('textBody', { mode: 'raw', minLines: 1, maxLines: 2, terminator: 'END' }),
        ] });
        const paths = expandGrammar(grammar(root), 12, DEFAULT_STRUCTURE_BUDGETS, {
            keywordOptions: ['TITLE'],
            preprocessor: { FEATURE: true },
        });
        assert.equal(paths.length, 4);
        assert.ok(paths.every(path => path.records.some(value => value.cardLabel === 'P')));
        assert.ok(paths.every(path => !path.records.some(value => value.cardLabel === 'S')));
        assert.ok(paths.every(path => path.records.find(value => value.cardLabel === 'M').marker.value === '&'));
        assert.ok(paths.every(path => path.records.find(value => value.cardLabel === 'N').wrappers.includes('continuation')));
        assert.ok(paths.every(path => path.dependencies.some(value => value.startsWith('text-terminator:'))),
            'text terminators remain unresolved until an exact matcher can discharge them');
    });

    it('keeps decoded-field count branches available until record matching resolves them', () => {
        const root = node('repeat', {
            node: record('R'),
            min: 0,
            max: 3,
            countFrom: 'COUNT',
        });
        const paths = expandGrammar(grammar(root), 3, DEFAULT_STRUCTURE_BUDGETS, {
            fields: { COUNT: 1 },
        });
        assert.deepEqual(paths.map(path => path.records.length), [0, 1, 2, 3]);
        assert.deepEqual(paths.map(path => path.assumptions[0].predicate.value), [0, 1, 2, 3]);
    });

    it('keeps grammar-level prefix bindings tri-state when option context is absent', () => {
        const value = grammar(record('A'));
        value.prefixes = [{ option: 'TITLE', node: record('TITLE') }];
        const unknown = expandGrammar(value, 2, DEFAULT_STRUCTURE_BUDGETS, {});
        assert.deepEqual(unknown.map(path => path.records.length), [1, 2]);
        assert.ok(unknown.every(path => path.dependencies.includes('keyword-option:TITLE')));
        assert.deepEqual(
            expandGrammar(value, 1, DEFAULT_STRUCTURE_BUDGETS, { keywordOptions: [] })
                .map(path => path.records.length),
            [1],
        );
        assert.deepEqual(
            expandGrammar(value, 2, DEFAULT_STRUCTURE_BUDGETS, { keywordOptions: 'title' })
                .map(path => path.records.length),
            [2],
        );
    });

    it('uses a one-shot option iterable consistently in prefixes, nested nodes and suffixes', () => {
        const value = grammar(node('sequence', { nodes: [
            node('prefix', { option: 'TITLE', node: record('NESTED') }),
            record('BODY'),
        ] }));
        value.prefixes = [{ option: 'TITLE', node: record('TITLE') }];
        value.suffixes = [{ option: 'TAIL', node: record('TAIL') }];
        const expected = expandGrammar(value, 4, DEFAULT_STRUCTURE_BUDGETS, { keywordOptions: ['title', 'tail'] });
        function* options() { yield 'title'; yield 'tail'; }
        assert.deepEqual(expandGrammar(value, 4, DEFAULT_STRUCTURE_BUDGETS, { keywordOptions: options() }), expected);
        assert.deepEqual(expected[0].records.map(record => record.cardLabel), ['TITLE', 'NESTED', 'BODY', 'TAIL']);
    });

    it('fails closed for unknown nodes, epsilon repeats, and expansion budgets', () => {
        assert.throws(
            () => expandGrammar(grammar(node('madeUp')), 1, DEFAULT_STRUCTURE_BUDGETS),
            error => error instanceof StructureExpansionError && /unsupported-grammar-node/.test(error.reason),
        );
        assert.throws(
            () => expandGrammar(grammar(node('repeat', { node: node('empty'), min: 1, max: 2 })),
                1, DEFAULT_STRUCTURE_BUDGETS),
            /repeat-node-can-consume-zero-records/,
        );
        assert.throws(
            () => expandGrammar(grammar(node('repeat', { node: record('R'), min: 2, max: 1 })),
                1, DEFAULT_STRUCTURE_BUDGETS),
            /repeat-maximum-invalid/,
        );
        assert.throws(
            () => expandGrammar(grammar(node('choice', {
                cardinality: 'maybe-one', branches: [record('B')],
            })), 1, DEFAULT_STRUCTURE_BUDGETS),
            /choice-cardinality-unsupported/,
        );
        assert.throws(
            () => expandGrammar(grammar(node('choice', {
                cardinality: 'one-or-more',
                branches: Array.from({ length: 9 }, (_, index) => record(`B${index}`)),
            })), 1, { ...DEFAULT_STRUCTURE_BUDGETS, maximumPaths: 8 }),
            /grammar-path-budget-exceeded|grammar-expansion-budget-exceeded/,
        );
    });
});
