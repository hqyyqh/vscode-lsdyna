import { matchObservedRecord } from './recordMatcher';
import type {
    ExpectedRecord,
    GrammarPath,
    ObservedRecord,
    RecordMapping,
    RecordMatch,
    StructureBudgets,
    StructureEdit,
} from './types';

export type AlignmentScore = {
    edits: number;
    displacement: number;
};

export type StructureAlignment = {
    score: AlignmentScore;
    edits: StructureEdit[];
    mappings: RecordMapping[];
    matches: Array<{ observedIndex: number; expectedIndex: number; match: RecordMatch }>;
    unsupported: boolean;
};

type Move = {
    kind: 'pair' | 'insert' | 'delete';
    previousI: number;
    previousJ: number;
    match?: RecordMatch;
};

type Cell = { score: AlignmentScore; moves: Move[] };

function compareScore(left: AlignmentScore, right: AlignmentScore): number {
    return left.edits - right.edits || left.displacement - right.displacement;
}

function addScore(score: AlignmentScore, edits: number, displacement = 0): AlignmentScore {
    return { edits: score.edits + edits, displacement: score.displacement + displacement };
}

function editForInsert(expected: ExpectedRecord, expectedIndex: number): StructureEdit {
    return {
        kind: 'insert',
        expectedIndex,
        cardNodeId: expected.cardNodeId,
        cardLabel: expected.cardLabel,
        nodeId: expected.nodeId,
        reason: 'expected-record-not-observed',
    };
}

function editForDelete(observed: ObservedRecord, observedIndex: number): StructureEdit {
    return {
        kind: 'delete',
        observedIndex,
        observedLine: observed.line,
        reason: 'observed-record-not-in-grammar',
    };
}

function editForSubstitute(
    expected: ExpectedRecord,
    observed: ObservedRecord,
    expectedIndex: number,
    observedIndex: number,
    match: RecordMatch,
): StructureEdit {
    return {
        kind: 'substitute',
        expectedIndex,
        observedIndex,
        observedLine: observed.line,
        cardNodeId: expected.cardNodeId,
        cardLabel: expected.cardLabel,
        nodeId: expected.nodeId,
        reason: match.reason || 'record-does-not-match-official-geometry',
    };
}

function appendMove(alignment: StructureAlignment, move: Move, expected: ExpectedRecord[], observed: ObservedRecord[]): StructureAlignment {
    const edits = [...alignment.edits];
    const mappings = [...alignment.mappings];
    const matches = [...alignment.matches];
    let unsupported = alignment.unsupported;
    if (move.kind === 'pair') {
        const observedIndex = move.previousI;
        const expectedIndex = move.previousJ;
        const match = move.match;
        const expectedRecord = expected[expectedIndex];
        const observedRecord = observed[observedIndex];
        matches.push({ observedIndex, expectedIndex, match });
        if (match.quality === 'mismatch' || match.quality === 'unsupported') {
            edits.push(editForSubstitute(expectedRecord, observedRecord, expectedIndex, observedIndex, match));
        }
        unsupported ||= match.quality === 'unsupported';
        mappings.push({
            observedOrdinal: observedRecord.ordinal,
            observedLine: observedRecord.line,
            expectedIndex,
            cardNodeId: expectedRecord.cardNodeId,
            cardLabel: expectedRecord.cardLabel,
            nodeId: expectedRecord.nodeId,
            status: match.quality === 'mismatch' || match.quality === 'unsupported' ? 'mismatch' : 'matched',
        });
    } else if (move.kind === 'insert') {
        edits.push(editForInsert(expected[move.previousJ], move.previousJ));
    } else {
        const observedRecord = observed[move.previousI];
        edits.push(editForDelete(observedRecord, move.previousI));
        mappings.push({
            observedOrdinal: observedRecord.ordinal,
            observedLine: observedRecord.line,
            status: 'extra',
        });
    }
    return { ...alignment, edits, mappings, matches, unsupported };
}

export function alignRecords(
    path: GrammarPath,
    observed: ObservedRecord[],
    budgets: StructureBudgets,
): StructureAlignment[] {
    const expected = path.records;
    const cells = (observed.length + 1) * (expected.length + 1);
    if (cells > budgets.maximumDynamicProgrammingCells) {
        throw new Error('alignment-cell-budget-exceeded');
    }
    const matrix: Cell[][] = Array.from({ length: observed.length + 1 }, () =>
        Array<Cell>(expected.length + 1));
    matrix[0][0] = { score: { edits: 0, displacement: 0 }, moves: [] };

    for (let i = 0; i <= observed.length; i++) {
        for (let j = 0; j <= expected.length; j++) {
            if (i === 0 && j === 0) continue;
            const candidates: Array<{ score: AlignmentScore; move: Move }> = [];
            if (i > 0 && j > 0) {
                const match = matchObservedRecord(expected[j - 1], observed[i - 1]);
                const penalty = match.quality === 'exact' || match.quality === 'unknown' ? 0 : 1;
                candidates.push({
                    score: addScore(matrix[i - 1][j - 1].score, penalty, Math.abs((i - 1) - (j - 1))),
                    move: { kind: 'pair', previousI: i - 1, previousJ: j - 1, match },
                });
            }
            if (j > 0) {
                candidates.push({
                    score: addScore(matrix[i][j - 1].score, 1),
                    move: { kind: 'insert', previousI: i, previousJ: j - 1 },
                });
            }
            if (i > 0) {
                candidates.push({
                    score: addScore(matrix[i - 1][j].score, 1),
                    move: { kind: 'delete', previousI: i - 1, previousJ: j },
                });
            }
            candidates.sort((left, right) => compareScore(left.score, right.score));
            const best = candidates[0].score;
            matrix[i][j] = {
                score: best,
                moves: candidates.filter(candidate => compareScore(candidate.score, best) === 0)
                    .map(candidate => candidate.move),
            };
        }
    }

    const memo = new Map<string, StructureAlignment[]>();
    const visit = (i: number, j: number): StructureAlignment[] => {
        const key = `${i}:${j}`;
        const cached = memo.get(key);
        if (cached) return cached;
        if (i === 0 && j === 0) {
            const base = [{
                score: matrix[observed.length][expected.length].score,
                edits: [],
                mappings: [],
                matches: [],
                unsupported: false,
            }];
            memo.set(key, base);
            return base;
        }
        const results: StructureAlignment[] = [];
        for (const move of matrix[i][j].moves) {
            for (const previous of visit(move.previousI, move.previousJ)) {
                if (results.length >= budgets.maximumAlignments) {
                    throw new Error('alignment-count-budget-exceeded');
                }
                results.push(appendMove(previous, move, expected, observed));
            }
        }
        memo.set(key, results);
        return results;
    };
    return visit(observed.length, expected.length).map(alignment => ({
        ...alignment,
        edits: alignment.edits.sort((left, right) =>
            Number(left.expectedIndex ?? Number.MAX_SAFE_INTEGER) -
            Number(right.expectedIndex ?? Number.MAX_SAFE_INTEGER) ||
            Number(left.observedIndex ?? Number.MAX_SAFE_INTEGER) -
            Number(right.observedIndex ?? Number.MAX_SAFE_INTEGER)),
        mappings: alignment.mappings.sort((left, right) => left.observedOrdinal - right.observedOrdinal),
        matches: alignment.matches.sort((left, right) => left.observedIndex - right.observedIndex),
    }));
}

export function editSignature(edits: StructureEdit[]): string {
    return JSON.stringify(edits.map(edit => ({
        kind: edit.kind,
        observedIndex: edit.observedIndex,
        expectedIndex: edit.expectedIndex,
        cardNodeId: edit.cardNodeId,
        nodeId: edit.nodeId,
        reason: edit.reason,
    })));
}

export const alignmentInternals = { compareScore };
