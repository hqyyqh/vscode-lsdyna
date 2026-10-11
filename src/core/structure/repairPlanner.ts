import { blankRecordForExpected } from './recordMatcher';
import type {
    GrammarPath,
    ObservedKeywordBlock,
    StructureEdit,
    StructureGrammar,
    StructureRepairCandidate,
} from './types';

export function planUniqueBlankRecordRepairs(
    grammar: StructureGrammar,
    block: ObservedKeywordBlock,
    path: GrammarPath,
    edits: StructureEdit[],
): StructureRepairCandidate[] {
    const policy = grammar.repairPolicy;
    if (grammar.verificationStatus !== 'verified-full' ||
        policy?.uniqueRepairEligible !== true ||
        policy?.automatic !== false ||
        edits.length === 0 || edits.some(edit => edit.kind !== 'insert')) return [];
    if (policy.mode !== 'append-contiguous-blank-suffix') return [];
    const expectedIndexes = edits.map(edit => edit.expectedIndex).filter(Number.isInteger) as number[];
    if (expectedIndexes.length !== edits.length) return [];
    expectedIndexes.sort((left, right) => left - right);
    if (expectedIndexes.some((value, index) =>
        index > 0 && value !== expectedIndexes[index - 1] + 1)) return [];
    if (expectedIndexes[0] !== block.records.length) return [];
    if (Number.isInteger(policy.minimumExistingPhysicalCard) &&
        block.records.length < Number(policy.minimumExistingPhysicalCard)) return [];
    const insertable = new Set((policy.insertableCardOrdinals || []).map(Number));
    const candidates: StructureRepairCandidate[] = [];
    for (const expectedIndex of expectedIndexes) {
        const expected = path.records[expectedIndex];
        const ordinal = expectedIndex + 1;
        if (!expected || expected.node.blankAllowed !== true ||
            (insertable.size > 0 && !insertable.has(ordinal))) return [];
        const text = blankRecordForExpected(expected);
        if (text === null) return [];
        candidates.push({
            kind: 'insert-blank-record',
            insertionRecordIndex: expectedIndex,
            beforeLine: undefined,
            cardNodeId: String(expected.cardNodeId || expected.nodeId),
            cardLabel: expected.cardLabel,
            nodeId: expected.nodeId,
            text,
            format: 'fixed',
        });
    }
    if (Number.isInteger(policy.targetPhysicalCard) &&
        expectedIndexes.at(-1) + 1 !== Number(policy.targetPhysicalCard)) return [];
    return candidates;
}
