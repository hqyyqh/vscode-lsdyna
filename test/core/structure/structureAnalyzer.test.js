'use strict';

const assert = require('assert');
const {
    DEFAULT_STRUCTURE_SOURCE_PROFILE_BILINGUAL,
    DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
    KeywordStructureCatalog,
    analyzeGrammarStructure,
    analyzeKeywordStructureLines,
    observeKeywordBlock,
} = require('../../../src/core/structure');

const repositoryRoot = require('path').resolve(__dirname, '..', '..', '..');
const catalog = new KeywordStructureCatalog({
    runtimeRoot: require('path').join(repositoryRoot, 'keywords', 'keyword-structure-v2'),
});

function fixed(values = []) {
    return Array.from({ length: 8 }, (_, index) => String(values[index] ?? '').padStart(10)).join('');
}

function winfrith(rate, count, free = false) {
    const values = [
        [1, 2, 3, 4, 5, 6, 7, 8],
        [1, 2, 3, 4, rate, 6, 7, 8],
        [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8],
        [2.1, 2, 3, 4, '', '', 7, 8],
        [3.1, 3.2, 3.3, 3.4, 5, 3.6, 3.7, 8],
        [7, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 8],
    ];
    return values.slice(0, count).map(row => free ? row.join(',') : fixed(row));
}

function analyze(lines, options = {}) {
    return analyzeKeywordStructureLines('*MAT_WINFRITH_CONCRETE', lines, {
        catalog,
        sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
        ...options,
    });
}

describe('generic keyword structure analyzer', () => {
    it('accepts both complete WINFRITH branches in fixed and per-card free format', () => {
        for (const [rate, count] of [[1, 4], [8, 7]]) {
            const fixedResult = analyze(winfrith(rate, count));
            assert.equal(fixedResult.status, 'valid');
            assert.equal(fixedResult.reason, 'complete');
            assert.equal(fixedResult.expectedDataRecords, count);
            const freeResult = analyze(winfrith(rate, count, true));
            assert.equal(freeResult.status, 'valid');
        }
        const mixed = winfrith(8, 7);
        mixed[2] = winfrith(8, 7, true)[2];
        assert.equal(analyze(mixed).status, 'valid', 'each physical record selects its format independently');
    });

    it('reports known missing and extra conditional suffixes, with repair authority only for unique blanks', () => {
        const missing = analyze(winfrith(8, 4));
        assert.equal(missing.status, 'definite-error');
        assert.equal(missing.reason, 'missing-required-records');
        assert.deepEqual(missing.diagnostics.map(edit => edit.cardLabel), ['Card 5', 'Card 6', 'Card 7']);
        assert.deepEqual(missing.repairCandidates.map(edit => edit.cardLabel), ['Card 5', 'Card 6', 'Card 7']);
        assert.ok(missing.repairCandidates.every(edit => edit.text.length === 80));

        const extra = analyze(winfrith(1, 7));
        assert.equal(extra.status, 'definite-error');
        assert.equal(extra.reason, 'extra-records');
        assert.equal(extra.repairCandidates.length, 0);

        const malformed = winfrith(8, 7);
        malformed[0] = `${malformed[0].slice(0, 10)}${'abc'.padStart(10)}${malformed[0].slice(20)}`;
        const geometry = analyze(malformed);
        assert.equal(geometry.status, 'definite-error');
        assert.equal(geometry.reason, 'record-geometry-mismatch');
        assert.equal(geometry.diagnostics.length, 1);
        assert.match(geometry.diagnostics[0].reason, /field-type-mismatch/);
    });

    it('never turns blank or parameterized controlling fields into a false definite error', () => {
        for (const rate of ['', '&RATE']) {
            for (const count of [4, 7]) {
                const result = analyze(winfrith(rate, count));
                assert.equal(result.status, 'context-dependent');
                assert.match(result.reason, /unresolved-context/);
                assert.equal(result.diagnostics.length, 0);
                assert.equal(result.repairCandidates.length, 0);
            }
        }
        assert.equal(analyze(winfrith(8, 7), {
            context: { fields: { RATE: 1 } },
        }).status, 'valid', 'a decoded controlling field must override stale external context');
    });

    it('resolves countFrom from decoded cards, with parameter context as a fallback only', () => {
        const profile = 'a'.repeat(64);
        const structureNode = (type, id, values = {}) => ({
            type,
            nodeId: `structure-node:${id}`,
            sourceProfileId: profile,
            verificationStatus: 'verified-full',
            evidenceIds: [],
            locations: [],
            ...values,
        });
        const integerRecord = (id, field) => structureNode('record', id, {
            cardNodeId: id,
            cardLabel: id,
            blankAllowed: false,
            formatChoice: ['standard-fixed', 'free-comma'],
            geometryRef: {
                kind: 'official-field-signature',
                fieldWidth: 10,
                fields: [{ index: 0, name: field, typeCode: 'I' }],
            },
        });
        const grammar = {
            grammarId: 'structure-grammar:counted',
            keyword: '*COUNTED',
            sourceProfileId: profile,
            verificationStatus: 'verified-full',
            root: structureNode('sequence', 'root', { nodes: [
                integerRecord('control', 'COUNT'),
                structureNode('repeat', 'repeat', {
                    node: integerRecord('item', 'ITEM'),
                    min: 0,
                    max: 3,
                    countFrom: 'COUNT',
                }),
            ] }),
        };
        const run = (count, context = {}) => analyzeGrammarStructure(
            grammar,
            observeKeywordBlock('*COUNTED', [String(count).padStart(10), '         7', '         8']).block,
            { context },
        );
        assert.equal(run(2).status, 'valid');
        assert.equal(run(2, { fields: { COUNT: 1 } }).status, 'valid',
            'decoded data is authoritative over external context');
        assert.equal(run('&N').status, 'context-dependent');
        assert.equal(run('&N', { fields: { count: 2 } }).status, 'valid',
            'case-insensitive external context may resolve a parameterized count');
    });

    it('does not use comments as solver structure evidence', () => {
        const raw = winfrith(8, 4);
        const first = [];
        const second = [];
        raw.forEach((line, index) => {
            first.push(`$# Card ${index + 1}`, line);
            second.push(`$ deliberately wrong Card ${7 - index}`, line);
        });
        const firstResult = analyze(first);
        const secondResult = analyze(second);
        assert.equal(firstResult.status, secondResult.status);
        assert.equal(firstResult.reason, secondResult.reason);
        assert.deepEqual(firstResult.diagnostics, secondResult.diagnostics);
    });

    it('distinguishes a valid ambiguous mapping from ambiguous missing-card locations', () => {
        const profile = 'a'.repeat(64);
        const record = id => ({
            type: 'record',
            nodeId: `structure-node:${id}`,
            sourceProfileId: profile,
            verificationStatus: 'verified-full',
            evidenceIds: [],
            locations: [],
            cardNodeId: id,
            cardLabel: id,
            blankAllowed: true,
            geometryRef: { kind: 'wildcard' },
        });
        const choice = branches => ({
            type: 'choice',
            nodeId: 'structure-node:choice',
            sourceProfileId: profile,
            verificationStatus: 'verified-full',
            evidenceIds: [],
            locations: [],
            cardinality: 'exactly-one',
            branches,
        });
        const grammar = root => ({
            grammarId: 'structure-grammar:ambiguous',
            keyword: '*AMBIGUOUS',
            sourceProfileId: profile,
            verificationStatus: 'verified-full',
            root,
        });
        const one = observeKeywordBlock('*AMBIGUOUS', ['1']).block;
        const mapped = analyzeGrammarStructure(grammar(choice([record('B'), record('C')])), one);
        assert.equal(mapped.status, 'valid');
        assert.equal(mapped.mappingAmbiguous, true);
        assert.equal(mapped.records[0].status, 'mapping-ambiguous');

        const sequence = tail => ({
            type: 'sequence',
            nodeId: `structure-node:sequence-${tail.cardNodeId}`,
            sourceProfileId: profile,
            verificationStatus: 'verified-full',
            evidenceIds: [],
            locations: [],
            nodes: [record('A'), tail],
        });
        const missing = analyzeGrammarStructure(
            grammar(choice([sequence(record('B')), sequence(record('C'))])),
            one,
        );
        assert.equal(missing.status, 'ambiguous');
        assert.equal(missing.reason, 'multiple-minimal-structure-edits');
        assert.equal(missing.repairCandidates.length, 0);
    });

    it('downgrades boundary-only, variant, missing-profile, and bilingual-prefix boundaries honestly', () => {
        const boundary = analyzeKeywordStructureLines('*MAT_DAMAGE_1', Array(6).fill(fixed()), {
            catalog,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
        });
        assert.equal(boundary.status, 'ambiguous');
        assert.equal(boundary.reason, 'verified-boundary-only-no-record-signatures');
        assert.equal(boundary.repairCandidates.length, 0);
        assert.equal(analyzeKeywordStructureLines('*MAT_DAMAGE_1', ['#if FEATURE', fixed(), '#endif'], {
            catalog,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
        }).reason, 'preprocessor-context-unmodeled');

        const title = analyzeKeywordStructureLines('*MAT_DAMAGE_1_TITLE', Array(6).fill(fixed()), {
            catalog,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
        });
        assert.equal(title.status, 'profile-unverified');
        assert.equal(title.reason, 'variant-requires-reviewed-option-expansion');
        assert.equal(title.repairCandidates.length, 0);

        assert.equal(analyzeKeywordStructureLines('*MAT_WINFRITH_CONCRETE', winfrith(8, 7), {
            catalog,
        }).reason, 'active-source-profile-unavailable');

        const bilingualTitle = analyzeKeywordStructureLines('*MAT_WINFRITH_CONCRETE_TITLE', winfrith(8, 7), {
            catalog,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_BILINGUAL,
        });
        assert.equal(bilingualTitle.status, 'profile-unverified');
    });

    it('fails closed for preprocessor input and hard parser budgets', () => {
        assert.equal(analyze(['#if FEATURE', ...winfrith(1, 4), '#endif']).reason,
            'preprocessor-context-unmodeled');
        assert.equal(analyze(winfrith(8, 7), {
            budgets: { maximumDynamicProgrammingCells: 10 },
        }).reason, 'alignment-cell-budget-exceeded');
        assert.equal(analyzeKeywordStructureLines('*MAT_WINFRITH_CONCRETE', winfrith(8, 7), {
            catalog,
            sourceProfileId: DEFAULT_STRUCTURE_SOURCE_PROFILE_EN,
            maximumPhysicalLines: 2,
        }).reason, 'physical-line-budget-exceeded');
    });

    it('fails closed for unreviewed options, text terminators, and dependency-bound repairs', () => {
        const profile = 'a'.repeat(64);
        const record = {
            type: 'record',
            nodeId: 'structure-node:record',
            sourceProfileId: profile,
            verificationStatus: 'verified-full',
            evidenceIds: [],
            locations: [],
            cardNodeId: 'record',
            cardLabel: 'Record',
            blankAllowed: true,
            formatChoice: ['standard-fixed'],
            geometryRef: {
                kind: 'official-field-signature',
                fieldWidth: 10,
                fields: [{ index: 0, name: 'VALUE', typeCode: 'I' }],
            },
        };
        const base = {
            grammarId: 'structure-grammar:guarded',
            keyword: '*GUARDED',
            sourceProfileId: profile,
            verificationStatus: 'verified-full',
            root: record,
            unsupportedOptions: [{ option: 'TITLE', reason: 'not-reviewed' }],
        };
        const block = observeKeywordBlock('*GUARDED', ['         1']).block;
        const option = analyzeGrammarStructure(base, block, {
            context: { keywordOptions: ['title'] },
        });
        assert.equal(option.status, 'profile-unverified');
        assert.equal(option.reason, 'active-keyword-option-unverified');
        assert.deepEqual(option.details.keywordOptions, ['TITLE']);

        const textGrammar = {
            ...base,
            unsupportedOptions: [],
            root: {
                ...record,
                type: 'textBody',
                nodeId: 'structure-node:text',
                minLines: 1,
                maxLines: 2,
                terminator: 'END',
            },
        };
        const textResult = analyzeGrammarStructure(
            textGrammar,
            observeKeywordBlock('*GUARDED', ['raw text']).block,
        );
        assert.equal(textResult.status, 'context-dependent');
        assert.ok(textResult.dependencies.some(value => value.startsWith('text-terminator:')));

        const repeatGrammar = {
            ...base,
            unsupportedOptions: [],
            root: {
                type: 'repeat',
                nodeId: 'structure-node:repeat',
                sourceProfileId: profile,
                verificationStatus: 'verified-full',
                evidenceIds: [],
                locations: [],
                node: record,
                min: 1,
                max: 1,
                until: { kind: 'exact-line', value: 'END' },
            },
            repairPolicy: {
                automatic: false,
                uniqueRepairEligible: true,
                mode: 'append-contiguous-blank-suffix',
                insertableCardOrdinals: [1],
                minimumExistingPhysicalCard: 0,
                targetPhysicalCard: 1,
            },
        };
        const dependencyRepair = analyzeGrammarStructure(
            repeatGrammar,
            observeKeywordBlock('*GUARDED', []).block,
        );
        assert.equal(dependencyRepair.status, 'definite-error');
        assert.ok(dependencyRepair.dependencies.some(value => value.startsWith('terminator:')));
        assert.deepEqual(dependencyRepair.repairCandidates, []);
    });

    it('systematically rejects every deletion and duplicate in the verified full branch', () => {
        const valid = winfrith(8, 7);
        for (let index = 0; index < valid.length; index++) {
            const removed = [...valid.slice(0, index), ...valid.slice(index + 1)];
            assert.notEqual(analyze(removed).status, 'valid', `deleting physical record ${index + 1}`);
            const duplicated = [...valid.slice(0, index), valid[index], ...valid.slice(index)];
            assert.notEqual(analyze(duplicated).status, 'valid', `duplicating physical record ${index + 1}`);
        }
    });

    it('marks unsupported node kinds and record formats as unsupported instead of definite errors', () => {
        const profile = 'a'.repeat(64);
        const grammar = {
            grammarId: 'structure-grammar:synthetic',
            keyword: '*TEST',
            sourceProfileId: profile,
            verificationStatus: 'verified-full',
            root: {
                nodeId: 'structure-node:root',
                sourceProfileId: profile,
                verificationStatus: 'verified-full',
                type: 'madeUp',
            },
        };
        const block = observeKeywordBlock('*TEST', ['1']).block;
        assert.equal(analyzeGrammarStructure(grammar, block).status, 'unsupported-input');
        assert.match(analyzeGrammarStructure(grammar, block).reason, /unsupported-grammar-node/);
    });
});
