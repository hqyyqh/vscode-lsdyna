'use strict';
const assert = require('node:assert/strict');
const { planUniqueBlankRecordRepairs } = require('../../../src/core/structure');

describe('blank suffix repair planner', () => {
    const grammar = { verificationStatus: 'verified-full', repairPolicy: {
        uniqueRepairEligible: true, automatic: false, mode: 'append-contiguous-blank-suffix',
        minimumExistingPhysicalCard: 1, targetPhysicalCard: 3, insertableCardOrdinals: [2, 3],
    } };
    const block = { records: [{}] };
    const path = { records: Array.from({ length: 3 }, (_, index) => ({
        nodeId: `card-${index}`, cardNodeId: `card-${index}`, cardLabel: `Card ${index + 1}`,
        node: { blankAllowed: true, geometryRef: { kind: 'official-field-signature',
            fieldWidth: 10, fields: [{ index: 0, name: 'ID', typeCode: 'I' }] } },
    })) };
    const run = edits => planUniqueBlankRecordRepairs(grammar, block, path, edits);

    it('requires explicit full-profile authority and a completely blank authorized suffix', () => {
        const edits = [{ kind: 'insert', expectedIndex: 1 }, { kind: 'insert', expectedIndex: 2 }];
        for (const policy of [undefined, { uniqueRepairEligible: false }, { automatic: true },
            { mode: 'other' }, { minimumExistingPhysicalCard: 2 },
            { targetPhysicalCard: 4 }, { insertableCardOrdinals: [2] }]) {
            const candidate = { ...grammar, repairPolicy: policy === undefined ? undefined :
                { ...grammar.repairPolicy, ...policy } };
            assert.deepEqual(planUniqueBlankRecordRepairs(candidate, block, path, edits), []);
        }
        assert.deepEqual(planUniqueBlankRecordRepairs({ ...grammar, verificationStatus: 'verified-boundary-only' },
            block, path, edits), []);
        const nonblank = { records: path.records.map((record, index) => index === 2
            ? { ...record, node: { ...record.node, blankAllowed: false } } : record) };
        assert.deepEqual(planUniqueBlankRecordRepairs(grammar, block, nonblank, edits), []);
    });

    it('returns the complete authorized suffix or no candidates', () => {
        const edits = [{ kind: 'insert', expectedIndex: 1 }, { kind: 'insert', expectedIndex: 2 }];
        const candidates = run(edits);
        assert.deepEqual(candidates.map(candidate => candidate.insertionRecordIndex), [1, 2]);
        assert.ok(candidates.every(candidate => candidate.text === ' '.repeat(10)));
        for (const expectedIndex of [undefined, null, NaN, Infinity, 1.5, '2', -1, 9]) {
            for (const position of [0, 1, 2]) {
                const malformed = edits.slice();
                malformed.splice(position, 0, { kind: 'insert', expectedIndex });
                assert.deepEqual(run(malformed), [], `invalid index ${String(expectedIndex)} at ${position}`);
            }
        }
        assert.deepEqual(run([...edits, { kind: 'delete', observedIndex: 0 }]), []);
        assert.deepEqual(run([{ kind: 'insert', expectedIndex: 1 }]), []);
        assert.deepEqual(run([edits[0], edits[0], edits[1]]), []);
        assert.deepEqual(edits, [{ kind: 'insert', expectedIndex: 1 }, { kind: 'insert', expectedIndex: 2 }]);
    });
});
