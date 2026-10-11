'use strict';

const assert = require('assert');
const {
    LSDYNA_FORMATTING_LIMITS,
    planLsdynaFormatting,
    mapPositionThroughFormattingEdits,
} = require('../../../src/client/services/lsdynaFormatting');
const { classifyKeywordLine } = require('../../../src/core/parser/keywordLine');

function documentFromLines(lines, options = {}) {
    return {
        lineCount: lines.length,
        version: options.version ?? 1,
        isDirty: options.isDirty ?? false,
        lineAt(line) {
            if (options.onRead) options.onRead(line);
            return { text: lines[line] };
        },
    };
}

function selection(startLine, startCharacter, endLine = startLine, endCharacter = startCharacter) {
    return {
        start: { line: startLine, character: startCharacter },
        end: { line: endLine, character: endCharacter },
    };
}

function indexFor(document, blocks, documentVersion = document.version) {
    return { documentVersion, keywordBlocks: blocks };
}

function defaultDependencies(overrides = {}) {
    return {
        classifyKeywordLine,
        resolveCard: ({ keywordText }) => {
            const keyword = classifyKeywordLine(keywordText).normalizedKeyword;
            if (keyword === '*COMMENT' || keyword === '*DEFINE_FUNCTION' || keyword === '*PART') {
                return { card: [{ p: 0, w: 80, t: 'string' }], isTextCard: true };
            }
            return { card: [{ p: 0, w: 10, t: 'number' }] };
        },
        alignLine: (text, _card, isHeader) => {
            if (text === 'unsafe') return { status: 'unsafe', text };
            const aligned = isHeader ? `$#${text.trimStart().slice(2).padStart(8)}` : text.padStart(10);
            return { status: aligned === text ? 'unchanged' : 'aligned', text: aligned };
        },
        splitIncludePathEntry: fullPath => {
            if (fullPath.length > 236) return { status: 'tooLong' };
            if (fullPath.length <= 80) return { status: 'unchanged', lines: [fullPath] };
            if (fullPath.length <= 156) {
                return { status: 'formatted', lines: [fullPath.slice(0, 78) + ' +', fullPath.slice(78)] };
            }
            return {
                status: 'formatted',
                lines: [fullPath.slice(0, 78) + ' +', fullPath.slice(78, 156) + ' +', fullPath.slice(156)],
            };
        },
        isLongFormatKeyword: text => /(?:\+|\bLONG\s*=\s*[YK])/i.test(text),
        ...overrides,
    };
}

describe('bounded LS-DYNA formatting planner', () => {
    it('rejects COMMENT control/body targets atomically through the opaque-state gate', async () => {
        const document = documentFromLines(['*COMMENT', '1', '*END']);
        const result = await planLsdynaFormatting({
            document,
            selections: [selection(1, 0)],
            fileIndex: indexFor(document, [
                {
                    keyword: '*COMMENT',
                    startLine: 0,
                    endLine: 1,
                    opaqueKind: 'comment',
                    opaqueStartCharacter: 8,
                },
                { keyword: '*END', startLine: 2, endLine: 2 },
            ]),
        }, defaultDependencies({
            resolveOpaqueState: position => position.line <= 1 ? 'opaque' : 'active',
        }));

        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'opaque-line');
        assert.deepEqual(result.metrics.replacementChars, 0);
    });

    it('expands an empty selection to the enclosing keyword', async () => {
        const document = documentFromLines(['*NODE', '1', '*END']);
        const result = await planLsdynaFormatting({
            document,
            selections: [selection(1, 0)],
            fileIndex: indexFor(document, [
                { keyword: '*NODE', startLine: 0, endLine: 1 },
                { keyword: '*END', startLine: 2, endLine: 2 },
            ]),
        }, defaultDependencies());

        assert.equal(result.status, 'ok');
        assert.deepEqual(result.targets, [{ start: 0, end: 1 }]);
        assert.deepEqual(result.edits.map(edit => edit.startLine), [1]);
    });

    it('keeps a non-empty selection scoped to selected physical lines', async () => {
        const document = documentFromLines(['*NODE', '1', '2', '*END']);
        const result = await planLsdynaFormatting({
            document,
            selections: [selection(1, 0, 2, 0)],
            fileIndex: indexFor(document, [
                { keyword: '*NODE', startLine: 0, endLine: 2 },
                { keyword: '*END', startLine: 3, endLine: 3 },
            ]),
        }, defaultDependencies());

        assert.equal(result.status, 'ok');
        assert.deepEqual(result.targets, [{ start: 1, end: 1 }]);
        assert.deepEqual(result.edits.map(edit => edit.startLine), [1]);
    });

    it('resolves a CodeLens line argument to its whole keyword block', async () => {
        const document = documentFromLines(['*NODE', '1', '2', '*END']);
        const result = await planLsdynaFormatting({
            document,
            lineArgument: 2,
            fileIndex: indexFor(document, [
                { keyword: '*NODE', startLine: 0, endLine: 2 },
                { keyword: '*END', startLine: 3, endLine: 3 },
            ]),
        }, defaultDependencies());

        assert.equal(result.status, 'ok');
        assert.deepEqual(result.targets, [{ start: 0, end: 2 }]);
        assert.deepEqual(result.edits.map(edit => edit.startLine), [1, 2]);
    });

    it('merges and deduplicates mixed empty and non-empty multicursor targets', async () => {
        const document = documentFromLines(['*NODE', '1', '2', '*END']);
        const result = await planLsdynaFormatting({
            document,
            selections: [selection(1, 0), selection(2, 0, 2, 1)],
            fileIndex: indexFor(document, [
                { keyword: '*NODE', startLine: 0, endLine: 2 },
                { keyword: '*END', startLine: 3, endLine: 3 },
            ]),
        }, defaultDependencies());

        assert.equal(result.status, 'ok');
        assert.deepEqual(result.targets, [{ start: 0, end: 2 }]);
        assert.deepEqual(result.edits.map(edit => edit.startLine), [1, 2]);
    });

    it('rejects the entire operation when one selected line is unsafe', async () => {
        const document = documentFromLines(['*NODE', '1', 'unsafe']);
        const result = await planLsdynaFormatting({
            document,
            selections: [selection(0, 0, 2, 6)],
        }, defaultDependencies());

        assert.deepEqual(result.status, 'rejected');
        assert.equal(result.reason, 'unsafe-line');
    });

    it('rejects an indexed oversized block without reading its body', async () => {
        const reads = [];
        const document = {
            lineCount: 5_001,
            version: 1,
            isDirty: false,
            lineAt(line) {
                reads.push(line);
                if (line !== 0) throw new Error('body must not be read');
                return { text: '*NODE' };
            },
        };
        const result = await planLsdynaFormatting({
            document,
            selections: [selection(0, 0)],
            fileIndex: indexFor(document, [{ keyword: '*NODE', startLine: 0, endLine: 5_000 }]),
        }, defaultDependencies());

        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'target-line-limit');
        assert.deepEqual(reads, [0]);
    });

    it('bounds unindexed keyword lookback', async () => {
        const document = {
            lineCount: 6_002,
            version: 1,
            isDirty: false,
            lineAt(line) { return { text: line === 0 ? '*NODE' : '1' }; },
        };
        const result = await planLsdynaFormatting({
            document,
            selections: [selection(6_001, 0)],
        }, defaultDependencies());

        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'keyword-lookback-limit');
        assert.equal(result.metrics.lineReads, 5_000);
    });

    it('accepts 5000 target lines and rejects 5001', async () => {
        const noCard = defaultDependencies({ resolveCard: () => null });
        for (const [lineCount, expected] of [[5_000, 'ok'], [5_001, 'rejected']]) {
            const lines = ['*NODE', ...Array(lineCount - 1).fill('1')];
            const document = documentFromLines(lines);
            const result = await planLsdynaFormatting({
                document,
                selections: [selection(0, 0)],
                fileIndex: indexFor(document, [{ keyword: '*NODE', startLine: 0, endLine: lineCount - 1 }]),
            }, noCard);
            assert.equal(result.status, expected, `${lineCount} lines`);
        }
    });

    it('accepts 2000 edits and rejects 2001 atomically', async () => {
        for (const [editCount, expected] of [[2_000, 'ok'], [2_001, 'rejected']]) {
            const lines = ['*NODE', ...Array(editCount).fill('1')];
            const document = documentFromLines(lines);
            const result = await planLsdynaFormatting({
                document,
                selections: [selection(0, 0)],
                fileIndex: indexFor(document, [{ keyword: '*NODE', startLine: 0, endLine: editCount }]),
            }, defaultDependencies());
            assert.equal(result.status, expected, `${editCount} edits`);
            if (result.status === 'rejected') assert.equal(result.reason, 'edit-limit');
        }
    });

    it('applies target-line limits across multicursor selections', async () => {
        const lines = ['*NODE', ...Array(6_000).fill('1')];
        const document = documentFromLines(lines);
        const blocks = [{ keyword: '*NODE', startLine: 0, endLine: 6_000 }];
        const accepted = await planLsdynaFormatting({
            document,
            selections: [selection(1, 0, 2_501, 0), selection(3_001, 0, 5_501, 0)],
            fileIndex: indexFor(document, blocks),
        }, defaultDependencies({ resolveCard: () => null }));
        const rejected = await planLsdynaFormatting({
            document,
            selections: [selection(1, 0, 2_502, 0), selection(3_001, 0, 5_501, 0)],
            fileIndex: indexFor(document, blocks),
        }, defaultDependencies({ resolveCard: () => null }));

        assert.equal(accepted.status, 'ok');
        assert.equal(rejected.status, 'rejected');
        assert.equal(rejected.reason, 'target-line-limit');
    });

    it('enforces the 64 KiB single-line limit at the exact boundary', async () => {
        for (const [length, expected] of [[64 * 1024, 'ok'], [64 * 1024 + 1, 'rejected']]) {
            const document = documentFromLines(['*NODE', 'x'.repeat(length)]);
            const result = await planLsdynaFormatting({
                document,
                selections: [selection(1, 0, 1, 1)],
                fileIndex: indexFor(document, [{ keyword: '*NODE', startLine: 0, endLine: 1 }]),
            }, defaultDependencies({ resolveCard: () => null }));
            assert.equal(result.status, expected, `${length} characters`);
            if (result.status === 'rejected') assert.equal(result.reason, 'single-line-limit');
        }
    });

    it('enforces the 8 MiB aggregate input limit at the exact boundary', async () => {
        const limit = LSDYNA_FORMATTING_LIMITS.maxTotalInputChars;
        for (const [extra, expected] of [[0, 'ok'], [1, 'rejected']]) {
            const lines = ['*N'];
            let remaining = limit - 2 + extra;
            while (remaining > 0) {
                const size = Math.min(64 * 1024, remaining);
                lines.push('x'.repeat(size));
                remaining -= size;
            }
            const document = documentFromLines(lines);
            const result = await planLsdynaFormatting({
                document,
                selections: [selection(0, 0)],
                fileIndex: indexFor(document, [{ keyword: '*N', startLine: 0, endLine: lines.length - 1 }]),
            }, defaultDependencies({ resolveCard: () => null }));
            assert.equal(result.status, expected, `8 MiB + ${extra}`);
            if (result.status === 'rejected') assert.equal(result.reason, 'input-size-limit');
        }
    });

    it('enforces the 8 MiB replacement limit at the exact boundary', async () => {
        const limit = LSDYNA_FORMATTING_LIMITS.maxReplacementChars;
        for (const [extra, expected] of [[0, 'ok'], [1, 'rejected']]) {
            let editIndex = 0;
            const document = documentFromLines(['*NODE', ...Array(2_000).fill('1')]);
            const dependencies = defaultDependencies({
                alignLine: text => {
                    if (text === '*NODE') return { status: 'unchanged', text };
                    editIndex++;
                    const length = editIndex === 2_000 ? 4_802 + extra : 4_194;
                    return { status: 'aligned', text: 'x'.repeat(length) };
                },
            });
            const result = await planLsdynaFormatting({
                document,
                selections: [selection(0, 0)],
                fileIndex: indexFor(document, [{ keyword: '*NODE', startLine: 0, endLine: 2_000 }]),
            }, dependencies);
            assert.equal(result.status, expected, `8 MiB + ${extra}`);
            if (result.status === 'rejected') assert.equal(result.reason, 'replacement-size-limit');
            if (result.status === 'ok') assert.equal(result.metrics.replacementChars, limit);
        }
    });

    it('formats repeated field headers with one card resolution and linear overlap checks', async () => {
        const document = documentFromLines(['*NODE', '$# id', '$ comment', '$# id', '1']);
        const result = await planLsdynaFormatting({
            document,
            selections: [selection(0, 0)],
            fileIndex: indexFor(document, [{ keyword: '*NODE', startLine: 0, endLine: 4 }]),
        }, defaultDependencies());

        assert.equal(result.status, 'ok');
        assert.equal(result.metrics.cardResolutions, 1);
        assert.equal(result.edits.length, 3);
        assert.equal(result.metrics.overlapComparisons, result.edits.length - 1);
    });

    it('formats a complete include continuation but not a partial selection', async () => {
        const path = 'D:\\models\\' + 'segment\\'.repeat(14) + 'part.k';
        const lines = ['*INCLUDE_PATH', path];
        const document = documentFromLines(lines);
        const fileIndex = indexFor(document, [{ keyword: '*INCLUDE_PATH', startLine: 0, endLine: 1 }]);
        const complete = await planLsdynaFormatting({
            document,
            lineArgument: 0,
            fileIndex,
        }, defaultDependencies());
        const partialDocument = documentFromLines([
            '*INCLUDE_PATH',
            path.slice(0, 78) + ' +',
            path.slice(78),
        ]);
        const partial = await planLsdynaFormatting({
            document: partialDocument,
            selections: [selection(1, 0, 1, 10)],
            fileIndex: indexFor(partialDocument, [{ keyword: '*INCLUDE_PATH', startLine: 0, endLine: 2 }]),
        }, defaultDependencies());

        assert.equal(complete.status, 'ok');
        assert.equal(complete.edits.length, 1);
        assert.equal(complete.edits[0].newText, path.slice(0, 78) + ' +\n' + path.slice(78));
        assert.equal(partial.status, 'ok');
        assert.deepEqual(partial.edits, []);
    });

    it('rejects stale and structurally partial indexes', async () => {
        const document = documentFromLines(['*NODE', '1'], { version: 4, isDirty: true });
        const stale = await planLsdynaFormatting({
            document,
            selections: [selection(1, 0)],
            fileIndex: indexFor(document, [{ keyword: '*NODE', startLine: 0, endLine: 1 }], 3),
        }, defaultDependencies());
        const partial = await planLsdynaFormatting({
            document: documentFromLines(['*NODE', '1', '*END']),
            selections: [selection(1, 0)],
            fileIndex: { documentVersion: 1, keywordBlocks: [{ keyword: '*NODE', startLine: 0, endLine: 1 }] },
        }, defaultDependencies());

        assert.equal(stale.status, 'rejected');
        assert.equal(stale.reason, 'stale-index');
        assert.equal(partial.status, 'rejected');
        assert.equal(partial.reason, 'partial-index');
    });

    it('rejects an index whose next keyword boundary is stale', async () => {
        const document = documentFromLines(['*NODE', '1', '*PART']);
        const result = await planLsdynaFormatting({
            document,
            selections: [selection(1, 0)],
            fileIndex: indexFor(document, [
                { keyword: '*NODE', startLine: 0, endLine: 1 },
                { keyword: '*END', startLine: 2, endLine: 2 },
            ]),
        }, defaultDependencies());

        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'stale-index');
    });

    it('cancels atomically after a cooperative yield', async () => {
        const document = documentFromLines(['*NODE', '1', '2']);
        let valid = true;
        const result = await planLsdynaFormatting({
            document,
            selections: [selection(0, 0)],
            limits: { yieldIntervalLines: 1 },
        }, defaultDependencies({
            isStillValid: () => valid,
            yieldControl: async () => { valid = false; },
        }));

        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'cancelled');
    });

    it('keeps read, classification, card, and overlap work linear', async () => {
        const dataLines = 1_000;
        const document = documentFromLines(['*NODE', ...Array(dataLines).fill('1')]);
        const result = await planLsdynaFormatting({
            document,
            selections: [selection(0, 0)],
            fileIndex: indexFor(document, [{ keyword: '*NODE', startLine: 0, endLine: dataLines }]),
        }, defaultDependencies());

        assert.equal(result.status, 'ok');
        assert.equal(result.metrics.lineReads, dataLines + 1);
        assert.equal(result.metrics.classifications, dataLines + 1);
        assert.equal(result.metrics.cardResolutions, dataLines);
        assert.equal(result.metrics.overlapComparisons, dataLines - 1);
    });

    it('maps selections through include wrapping edits', () => {
        const edits = [{
            startLine: 1,
            startCharacter: 0,
            endLine: 1,
            endCharacter: 100,
            newText: 'x'.repeat(78) + ' +\nrest',
        }];
        assert.deepEqual(
            mapPositionThroughFormattingEdits({ line: 1, character: 100 }, edits),
            { line: 2, character: 4 },
        );
        assert.deepEqual(
            mapPositionThroughFormattingEdits({ line: 3, character: 2 }, edits),
            { line: 4, character: 2 },
        );
    });
});


describe('data-only batch formatting', () => {
    it('preserves tab and nonbreaking-space prefixes as data records', async () => {
        const document = documentFromLines(['*TEST', '\t$ data', '\u00a0$ data', '1']);
        const seen = [];
        const result = await planLsdynaFormatting({ document, selections: [selection(0, 0)] }, defaultDependencies({
            resolveCard: ({ lineNum, dataLineOrdinal, observedDataLines }) => {
                seen.push({ lineNum, dataLineOrdinal, records: [...observedDataLines] });
                return null;
            },
        }));
        assert.equal(result.status, 'ok');
        assert.deepStrictEqual(result.edits, []);
        assert.deepStrictEqual(seen, [
            { lineNum: 1, dataLineOrdinal: 1, records: ['\t$ data'] },
            { lineNum: 2, dataLineOrdinal: 2, records: ['\t$ data', '\u00a0$ data'] },
            { lineNum: 3, dataLineOrdinal: 3, records: ['\t$ data', '\u00a0$ data', '1'] },
        ]);
    });

    it('rejects a later unknown opaque state before resolving or exposing any partial edits', async () => {
        const document = documentFromLines(['*NODE', '1', '2']);
        const result = await planLsdynaFormatting({ document, selections: [selection(1, 0, 2, 1)] }, defaultDependencies({
            resolveOpaqueState: position => position.line === 2 ? 'unknown' : 'active',
            resolveCard: () => { throw new Error('Must reject before resolving cards'); },
        }));
        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'opaque-state-unknown');
        assert.equal(result.metrics.cardResolutions, 0);
        assert.equal(result.metrics.replacementChars, 0);
        assert.equal(Object.prototype.hasOwnProperty.call(result, 'edits'), false);
    });

    it('keeps native ASCII-space comments out of supplied card ordinals and record prefixes', async () => {
        const { getCardInfoForDocumentLine } = require('../../../src/core/keywordSchema');
        const schema = { TEST: { c: [[{ n: 'FIRST', p: 0, w: 10 }], [{ n: 'SECOND', p: 0, w: 20 }]] } };
        for (const comment of ['$ note', ' $ note', '  $# SECOND']) {
            const lines = ['*TEST', comment, '1', '$ between cards', '2'];
            const document = documentFromLines(lines);
            const seen = [];
            const result = await planLsdynaFormatting({ document, selections: [selection(0, 0)] }, defaultDependencies({
                resolveCard: ({ lineNum, dataLineOrdinal, observedDataLines, ...options }) => {
                    seen.push({ lineNum, dataLineOrdinal, records: [...observedDataLines] });
                    return getCardInfoForDocumentLine(document, lineNum, schema, {
                        ...options, dataLineOrdinal, observedDataLines,
                    });
                },
                alignLine: (text, card) => ({ status: 'aligned', text: text.padStart(card[0].w) }),
            }));
            assert.equal(result.status, 'ok', comment);
            assert.deepStrictEqual(seen, [
                { lineNum: 2, dataLineOrdinal: 1, records: ['1'] },
                { lineNum: 4, dataLineOrdinal: 2, records: ['1', '2'] },
            ], comment);
            assert.deepStrictEqual(result.edits.map(edit => [edit.startLine, edit.newText]), [
                [2, '         1'], [4, '                   2'],
            ], comment);
            assert.equal(document.lineAt(1).text, comment);
            assert.equal(document.lineAt(3).text, '$ between cards');
        }
    });

    it('shares the same prefix when selected headers precede one data record', async () => {
        const document = documentFromLines(['*TEST', '1', '$# first', '$ note', '$# second', '2']);
        const observed = [];
        const result = await planLsdynaFormatting({ document,
            selections: [selection(2, 0, 2, 2), selection(4, 0, 4, 2)],
        }, defaultDependencies({ resolveCard: ({ observedDataLines, dataLineOrdinal }) => {
            observed.push({ records: [...observedDataLines], ordinal: dataLineOrdinal });
            return { card: [{ p: 0, w: 10 }] };
        } }));
        assert.equal(result.status, 'ok');
        assert.deepStrictEqual(observed, [
            { records: ['1', '2'], ordinal: 2 },
        ]);
        assert.deepStrictEqual(result.edits.map(edit => edit.startLine), [2, 4]);
    });

    it('keeps logical traversal linear across many selected headers before a single data row', async () => {
        const document = documentFromLines(['*TEST', ...Array(1000).fill('$# id'), '1']);
        const selections = Array.from({ length: 100 }, (_, i) => selection(i * 10 + 1, 0, i * 10 + 1, 2));
        const result = await planLsdynaFormatting({ document, selections }, defaultDependencies());
        assert.equal(result.status, 'ok');
        assert.equal(result.edits.length, 100);
        assert.equal(result.metrics.cardResolutions, 1);
        assert.ok(result.metrics.processedLines <= 1100, result.metrics.processedLines);
        assert.ok(result.metrics.lineReads <= 1002, result.metrics.lineReads);
    });

    it('uses the index to skip unrelated records between selected blocks', async () => {
        let reads = 0;
        const document = { version: 1, lineCount: 1000002, lineAt(line) {
            reads++;
            return { text: line === 0 ? '*NODE' : line === 1000000 ? '*TEST' : '1' };
        } };
        const result = await planLsdynaFormatting({ document,
            selections: [selection(1, 0, 1, 1), selection(1000001, 0, 1000001, 1)],
            fileIndex: indexFor(document, [
                { keyword: '*NODE', startLine: 0, endLine: 999999 },
                { keyword: '*TEST', startLine: 1000000, endLine: 1000001 },
            ]),
        }, defaultDependencies());
        assert.equal(result.status, 'ok');
        assert.equal(result.edits.length, 2);
        assert.ok(reads <= 4, reads);
        assert.ok(result.metrics.processedLines <= 12, result.metrics.processedLines);
    });

    it('keeps data geometry unchanged when a comment names a differently sized card', async () => {
        const { getCardInfoForDocumentLine } = require('../../../src/core/keywordSchema');
        const schema = { TEST: { c: [[{ n: 'FIRST', p: 0, w: 10 }], [{ n: 'SECOND', p: 0, w: 20 }]] } };
        for (const comment of ['$ note', '$#              SECOND']) {
            const document = documentFromLines(['*TEST', comment, '1']);
            const result = await planLsdynaFormatting({ document, selections: [selection(2, 0, 2, 1)] }, defaultDependencies({
                resolveCard: ({ lineNum, ...options }) => getCardInfoForDocumentLine(document, lineNum, schema, options),
                alignLine: (text, card) => ({ status: 'aligned', text: text.padStart(card[0].w) }),
            }));
            assert.equal(result.status, 'ok');
            assert.deepStrictEqual(result.edits.map(edit => edit.newText), ['         1']);
        }
    });

    for (const indexed of [true, false]) it('visits a block once across separated selections, indexed=' + indexed, async () => {
        const document = documentFromLines(['*TEST', ...Array(1000).fill('1')]);
        const selections = Array.from({ length: 100 }, (_, i) => selection(i * 10 + 1, 0, i * 10 + 1, 1));
        const ordinals = [];
        const result = await planLsdynaFormatting({ document, selections,
            fileIndex: indexed ? indexFor(document, [{ keyword: '*TEST', startLine: 0, endLine: 1000 }]) : null,
        }, defaultDependencies({ resolveCard: ({ dataLineOrdinal }) => {
            ordinals.push(dataLineOrdinal); return { card: [{ p: 0, w: 10 }] };
        } }));
        assert.equal(result.status, 'ok');
        assert.deepStrictEqual(ordinals, selections.map(s => s.start.line));
        assert.ok(result.metrics.lineReads <= 1001, result.metrics.lineReads);
        assert.ok(result.metrics.processedLines <= 1300, result.metrics.processedLines);
    });

    it('preserves an unsafe comment while formatting safe data', async () => {
        const document = documentFromLines(['*TEST', '$# stale', '1']);
        const result = await planLsdynaFormatting({ document, selections: [selection(1, 0, 2, 1)] }, defaultDependencies({
            alignLine: (text, _card, header) => header ? { status: 'unsafe', text }
                : { status: 'aligned', text: text.padStart(10) },
        }));
        assert.equal(result.status, 'ok');
        assert.deepStrictEqual(result.edits.map(edit => [edit.startLine, edit.newText]), [[2, '         1']]);
    });
});
