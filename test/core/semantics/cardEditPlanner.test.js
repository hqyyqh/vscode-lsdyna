'use strict';

const assert = require('assert');

const fieldData = require('../../../keywords/field_data.json');
const {
    cardEditSchemaSignature,
    fixedWidthCardHeader,
    planVerifiedConditionalCards,
} = require('../../../out/core/semantics/cardEditPlanner');

const keyword = '*MAT_WINFRITH_CONCRETE';
const titleKeyword = '*MAT_WINFRITH_CONCRETE_TITLE';
const entry = fieldData.MAT_WINFRITH_CONCRETE;
const layoutId = 'card-edit-layout:4834299f92dfa36f81b31fbf';
const ruleId = 'rule:390df6397d5041459cbd486f';

function fixedCard(card, values = {}) {
    const width = Math.max(...card.map(field => field.p + field.w));
    const characters = Array(width).fill(' ');
    for (const field of card) {
        if (!Object.prototype.hasOwnProperty.call(values, field.n)) continue;
        const rendered = String(values[field.n]);
        if (rendered.length > field.w) throw new Error(`${field.n} test value exceeds its field`);
        const start = field.p + field.w - rendered.length;
        for (let offset = 0; offset < rendered.length; offset++) {
            characters[start + offset] = rendered[offset];
        }
    }
    return characters.join('');
}

function coreCards(count, rate = 8) {
    return entry.c.slice(0, count).map((card, index) => fixedCard(
        card,
        index === 0 ? { MID: 1 } : index === 1 ? { RATE: rate } : {},
    ));
}

function fakeDoc(lines, options = {}) {
    let reads = 0;
    return {
        version: options.version ?? 1,
        eol: options.eol ?? 1,
        lineCount: lines.length,
        lineAt(index) {
            reads++;
            if (index < 0 || index >= lines.length) throw new RangeError(String(index));
            return { text: lines[index] };
        },
        get reads() { return reads; },
    };
}

function plan(lines, options = {}, documentOptions = {}) {
    const document = fakeDoc(lines, documentOptions);
    return {
        document,
        result: planVerifiedConditionalCards(document, 0, fieldData, options),
    };
}

describe('verified conditional-card planner', () => {
    it('plans only blank Cards 3-7 for RATE=8 with Cards 1-2 present', () => {
        const { result } = plan([keyword, ...coreCards(2), '*END']);

        assert.equal(result.status, 'ready');
        assert.equal(result.layoutId, layoutId);
        assert.equal(result.ruleId, ruleId);
        assert.equal(result.existingPhysicalCards, 2);
        assert.equal(result.targetPhysicalCard, 7);
        assert.equal(result.predicateState, 'true');
        assert.deepEqual(result.cardsToAppend.map(card => card.physicalCardIndex), [3, 4, 5, 6, 7]);
        assert.deepEqual(result.cardsToAppend.map(card => card.relation), [
            'required-predecessor',
            'required-predecessor',
            'conditional',
            'conditional',
            'conditional',
        ]);
        assert.ok(result.cardsToAppend.every(card => card.blankText === ' '.repeat(80)));
        assert.equal(result.cardsToAppend[0].headerText,
            '$#    eps1      eps2      eps3      eps4      eps5      eps6      eps7      eps8');
        assert.equal(result.cardsToAppend[2].headerText,
            '$#  maxshr     lcymt     lcftt     lcfct                         lctst     lccmp');
        assert.deepEqual(result.insertion && {
            line: result.insertion.line,
            character: result.insertion.character,
        }, { line: 3, character: 0 });
        assert.equal(result.insertion.text.split('\n').length, 11);
        assert.ok(result.insertion.text.endsWith('\n'));
        assert.ok(result.advisories.some(item => item.field === 'LCCMP' && item.page === 716));
    });

    it('appends only the contiguous missing suffix for existing Cards 3-6', () => {
        for (let existing = 3; existing <= 6; existing++) {
            const { result } = plan([keyword, ...coreCards(existing), '*END']);
            assert.equal(result.status, 'ready', `existing=${existing}`);
            assert.deepEqual(
                result.cardsToAppend.map(card => card.physicalCardIndex),
                Array.from({ length: 7 - existing }, (_, index) => existing + index + 1),
                `existing=${existing}`,
            );
            assert.equal(result.insertion.line, existing + 1);
        }
    });

    it('stops as already complete when Card 7 is observed', () => {
        const { result } = plan([keyword, ...coreCards(7), ...Array(1000).fill('$ trailing comment')]);
        assert.equal(result.status, 'already-complete');
        assert.equal(result.existingPhysicalCards, 7);
        assert.equal(result.insertion, null);
        assert.equal(result.scannedPhysicalLines, 7);
        assert.ok(result.lineReads <= 8);
    });

    it('does not offer an edit when RATE is false or parameter-controlled', () => {
        const falsePlan = plan([keyword, ...coreCards(2, 2), '*END']).result;
        assert.equal(falsePlan.status, 'predicate-false');
        assert.equal(falsePlan.predicateState, 'false');
        assert.equal(falsePlan.insertion, null);

        const parameterPlan = plan([keyword, ...coreCards(2, '&RATE'), '*END']).result;
        assert.equal(parameterPlan.status, 'predicate-indeterminate');
        assert.equal(parameterPlan.predicateState, 'indeterminate');
        assert.equal(parameterPlan.insertion, null);
    });

    it('maps a TITLE alias only through its one-card prefix', () => {
        const titled = plan([titleKeyword, 'Winfrith concrete', ...coreCards(2), '*END']).result;
        assert.equal(titled.status, 'ready');
        assert.equal(titled.catalogKeyword, keyword);
        assert.equal(titled.existingPhysicalCards, 2);
        assert.deepEqual(titled.cardsToAppend.map(card => card.physicalCardIndex), [3, 4, 5, 6, 7]);

        const missingTitleLine = plan([titleKeyword, ...coreCards(2), '*END']).result;
        assert.equal(missingTitleLine.status, 'missing-required-prefix');
        assert.equal(missingTitleLine.existingPhysicalCards, 1);
    });

    it('rejects comma, long and I10 input while allowing explicit standard overrides', () => {
        assert.equal(plan([keyword, '1,0,0,0', ...coreCards(1), '*END']).result.status, 'unsupported-format');
        assert.equal(plan([`${keyword}+`, ...coreCards(2), '*END']).result.status, 'unsupported-format');
        assert.equal(plan([`${keyword}%`, ...coreCards(2), '*END']).result.status, 'unsupported-format');
        assert.equal(plan([keyword, ...coreCards(2), '*END'], { globalInputFormat: 'long' }).result.status,
            'unsupported-format');
        assert.equal(plan([keyword, ...coreCards(2), '*END'], { globalInputFormat: 'i10' }).result.status,
            'unsupported-format');

        const localStandard = plan(
            [`${keyword}-`, ...coreCards(2), '*END'],
            { globalInputFormat: 'long' },
        ).result;
        assert.equal(localStandard.status, 'ready');
    });

    it('requires both existing prefix cards and rejects stale command identities', () => {
        assert.equal(plan([keyword, '*END']).result.status, 'missing-required-prefix');
        assert.equal(plan([keyword, ...coreCards(1), '*END']).result.status, 'missing-required-prefix');

        const staleVersion = plan([keyword, ...coreCards(2), '*END'], {
            expectedDocumentVersion: 2,
            expectedLayoutId: layoutId,
            expectedRuleId: ruleId,
        }).result;
        assert.equal(staleVersion.status, 'stale');
        assert.equal(staleVersion.reason, 'document-version-changed');

        const staleLayout = plan([keyword, ...coreCards(2), '*END'], {
            expectedDocumentVersion: 1,
            expectedLayoutId: 'card-edit-layout:forged',
            expectedRuleId: ruleId,
        }).result;
        assert.equal(staleLayout.status, 'stale');

        const changedKeyword = plan(['*MAT_DAMAGE_1', ...coreCards(2), '*END'], {
            expectedDocumentVersion: 1,
            expectedLayoutId: layoutId,
            expectedRuleId: ruleId,
        }).result;
        assert.equal(changedKeyword.status, 'stale');
    });

    it('skips native space-prefixed comments but preserves blank data records', () => {
        const comments = plan([
            keyword,
            '$ ordinary comment',
            '$#       mid',
            ...coreCards(2),
            '*END',
        ]).result;
        assert.equal(comments.status, 'ready');
        assert.equal(comments.existingPhysicalCards, 2);

        const blankData = plan([
            keyword,
            coreCards(1)[0],
            '',
            coreCards(2)[1],
            '*END',
        ]).result;
        assert.equal(blankData.status, 'predicate-indeterminate');
        assert.equal(blankData.existingPhysicalCards, 2);

        const indentedDollar = plan([
            keyword,
            '  $this is a native comment',
            ...coreCards(2),
            '*END',
        ]).result;
        assert.equal(indentedDollar.status, 'ready');
        assert.equal(indentedDollar.existingPhysicalCards, 2);
    });

    it('drops exactly one virtual EOF line and preserves a real blank data card', () => {
        const virtualOnly = plan([keyword, ...coreCards(2), '']).result;
        assert.equal(virtualOnly.status, 'ready');
        assert.equal(virtualOnly.existingPhysicalCards, 2);
        assert.deepEqual(virtualOnly.insertion && {
            line: virtualOnly.insertion.line,
            character: virtualOnly.insertion.character,
        }, { line: 3, character: 0 });

        const realAndVirtual = plan([keyword, ...coreCards(2), '', '']).result;
        assert.equal(realAndVirtual.status, 'ready');
        assert.equal(realAndVirtual.existingPhysicalCards, 3);
        assert.deepEqual(realAndVirtual.cardsToAppend.map(card => card.physicalCardIndex), [4, 5, 6, 7]);
    });

    it('has no edit capability for alternative MAT_DAMAGE_1 cards', () => {
        const damage = planVerifiedConditionalCards(
            fakeDoc(['*MAT_DAMAGE_1', '         1', '*END']),
            0,
            fieldData,
        );
        assert.equal(damage.status, 'unavailable');
        assert.equal(damage.reason, 'no-unique-reviewed-layout');
        assert.equal(damage.insertion, null);
    });

    it('rechecks the schema signature and fixed header geometry', () => {
        assert.equal(
            cardEditSchemaSignature(fieldData, keyword),
            '04bad4fa5ceefc3971b36da54c06a02922efa27ea9a8f5e1037157d91bd029e6',
        );
        assert.equal(fixedWidthCardHeader(entry.c[4]).length, 80);
        assert.ok(!fixedWidthCardHeader(entry.c[4]).includes('unused'));

        const changedEntry = JSON.parse(JSON.stringify(entry));
        changedEntry.c[6][7].w = 20;
        const changedSchema = { ...fieldData, MAT_WINFRITH_CONCRETE: changedEntry };
        const document = fakeDoc([keyword, ...coreCards(2), '*END']);
        const result = planVerifiedConditionalCards(document, 0, changedSchema);
        assert.equal(result.status, 'schema-mismatch');
        assert.equal(result.insertion, null);
    });

    it('uses an indexed block boundary with constant reads near a million-line tail', () => {
        const keywordLine = 999_990;
        const lineCount = 1_000_000;
        const lines = new Map([
            [keywordLine, keyword],
            [keywordLine + 1, coreCards(2)[0]],
            [keywordLine + 2, coreCards(2)[1]],
            [keywordLine + 3, '*END'],
        ]);
        let reads = 0;
        const document = {
            version: 7,
            eol: 1,
            lineCount,
            lineAt(index) {
                reads++;
                if (!lines.has(index)) throw new Error(`unexpected line read ${index}`);
                return { text: lines.get(index) };
            },
        };
        const blockIndex = {
            lineCount,
            findBlockAtLine(line) {
                assert.equal(line, keywordLine);
                return { startLine: keywordLine, endLine: keywordLine + 2 };
            },
        };

        const result = planVerifiedConditionalCards(document, keywordLine, fieldData, { blockIndex });
        assert.equal(result.status, 'ready');
        assert.equal(result.lineReads, 4);
        assert.equal(reads, 4);
        assert.equal(result.insertion.line, keywordLine + 3);
    });

    it('reads at most 256 physical lines without an index and returns truncated', () => {
        const lineCount = 1_000_000;
        const first = coreCards(2);
        let reads = 0;
        const document = {
            version: 1,
            eol: 1,
            lineCount,
            lineAt(index) {
                reads++;
                if (index === 0) return { text: keyword };
                if (index === 1) return { text: first[0] };
                if (index === 2) return { text: first[1] };
                return { text: '$ comment padding' };
            },
        };

        const result = planVerifiedConditionalCards(document, 0, fieldData, {
            maximumPhysicalLines: 10_000,
        });
        assert.equal(result.status, 'truncated');
        assert.equal(result.scannedPhysicalLines, 256);
        assert.equal(result.lineReads, 257);
        assert.equal(reads, 257);
        assert.equal(result.insertion, null);
    });

    it('generates a single CRLF edit without changing existing text', () => {
        const { result } = plan(
            [keyword, ...coreCards(6), '*END'],
            { eol: '\r\n' },
            { eol: 2 },
        );
        assert.equal(result.status, 'ready');
        assert.equal(result.cardsToAppend.length, 1);
        assert.equal(result.insertion.text, `${result.cardsToAppend[0].headerText}\r\n${' '.repeat(80)}\r\n`);
    });
});
