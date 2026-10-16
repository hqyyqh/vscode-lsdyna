'use strict';

const assert = require('assert');

const fieldData = require("../../../keywords/runtime/schema/field_data.json");
const { NATIVE_FILE_SOURCE } = require("../../../out/core/semantics/catalogNativeFileLayout");
const {
    planOfficialFieldChoices,
} = require('../../../out/core/semantics/officialFieldChoicePlanner');

function fakeDoc(lines, options = {}) {
    let reads = 0;
    return {
        version: options.version ?? 1,
        lineCount: lines.length,
        lineAt(index) {
            reads++;
            if (index < 0 || index >= lines.length) throw new RangeError(String(index));
            return { text: lines[index] };
        },
        get reads() { return reads; },
    };
}

function plan(lines, position, options = {}, documentOptions = {}) {
    const document = fakeDoc(lines, documentOptions);
    return {
        document,
        result: planOfficialFieldChoices(document, position, fieldData, options),
    };
}

describe('official field choice planner', () => {
    it('uses native base and selector enums across unrelated keyword families', () => {
        for (const [keyword, line, character, field, values, fieldIdentity] of [
            ['CONTACT_AUTOMATIC_SINGLE_SURFACE', 1, 21, 'SURFATYP', ['0','1','2','3','4','5','6','7'], "record:3c11134d2da44eeb1b070a21:8d697c51d4b44532f820f122"],
            ['CONTACT_AUTOMATIC_SINGLE_SURFACE', 4, 1, 'SOFT', ['0','1','2','4','6'], "record:3c11134d2da44eeb1b070a21:8d7413b3e1feea59854cb661"],
            ['CONTROL_TERMINATION', 1, 51, 'NOSOL', ['0','1'], "record:918a1b8665d14093fb26fd77:f5e8dd32ea940162e4cfaf14"],
        ]) {
            const { result } = plan(['*' + keyword, ...Array(5).fill('         0'.repeat(8))],
                { line, character }, { keywordLine: 0,
                    rulesForField: () => { throw Error('manual rules must not be read'); } });
            assert.equal(result.status, 'ready', keyword + ':' + field);
            assert.equal(result.fieldName, field);
            assert.deepEqual(result.choices.map(c => c.valueText), values);
            assert.deepEqual(result.evidence, []);
            assert.equal(result.ruleId, `${NATIVE_FILE_SOURCE}:${fieldIdentity}`, 'source descriptor identity');
        }
    });

    it('binds selector choices by the complete card and owning keyword, never a field name alone', () => {
        const { resolveCardForDocumentLine } = require('../../../out/core/keywordSchema');
        const { nativeFieldDefinitions } = require('../../../out/core/semantics/nativeFieldDefinitions');
        const doc = fakeDoc(['*CONTACT_AUTOMATIC_SINGLE_SURFACE', ...Array(4).fill(' '.repeat(80))]);
        const card = resolveCardForDocumentLine(doc, 4, fieldData, { keywordLine: 0 }).cardInfo.card;
        const bound = nativeFieldDefinitions('CONTACT_AUTOMATIC_SINGLE_SURFACE', fieldData, card, 4);
        assert.equal(bound[0].definitionSource.fieldRecordId, "record:3c11134d2da44eeb1b070a21:8d7413b3e1feea59854cb661");
        assert.deepEqual(bound[0].e, ['0','1','2','4','6']);
        const wrongOwner = nativeFieldDefinitions('CONTROL_TERMINATION', fieldData, card, 4);
        assert.equal(wrongOwner[0].definitionSource, undefined);
        const wrongGeometry = card.map((f, i) => i === 7 ? { ...f, w: 9 } : f);
        assert.equal(nativeFieldDefinitions('CONTACT_AUTOMATIC_SINGLE_SURFACE', fieldData, wrongGeometry, 4)[0].definitionSource, undefined);
    });

    it('does not promote imported enums without a native descriptor binding', () => {
        const schema = { UNVERIFIED_ENUM: { c: [[{ n: 'FLAG', p: 0, w: 10, t: 'integer', e: ['0','1'] }]] } };
        const result = planOfficialFieldChoices(fakeDoc(['*UNVERIFIED_ENUM', '         0']),
            { line: 1, character: 1 }, schema, { keywordLine: 0 });
        assert.equal(result.status, 'no-choice');
        assert.equal(result.reason, 'no-native-field-choice');
    });

    it('uses only the native MAT_DAMAGE_1 FLAG choices in source order', () => {
        const { document, result } = plan([
            '*MAT_DAMAGE_1',
            ' '.repeat(80),
            `${'7'.repeat(70)}         0`,
        ], { line: 2, character: 75 }, { keywordLine: 0 });

        assert.equal(result.status, 'ready');
        assert.equal(result.keyword, '*MAT_DAMAGE_1');
        assert.equal(result.catalogKeyword, result.keyword);
        assert.equal(result.physicalCardIndex, 2);
        assert.equal(result.fieldIndex, 7);
        assert.equal(result.fieldName, 'FLAG');
        assert.equal(result.domainKind, 'closed');
        assert.equal(result.domainComplete, true);
        assert.equal(result.currentRawValue, '0');
        assert.equal(result.currentValueKind, 'numeric');
        assert.deepEqual(result.fieldRange, {
            line: 2,
            startCharacter: 70,
            endCharacter: 80,
        });
        assert.deepEqual(result.choices.map(choice => choice.valueText), ['0', '-1', '1']);
        assert.equal(result.choices.find(choice => choice.valueText === '1').replacementText, '         1');
        assert.deepEqual(result.evidence, []);
        assert.equal(result.lineReads, document.reads);
    });

    it('maps TITLE only through the shifted physical card identity', () => {
        const { result } = plan([
            '*MAT_DAMAGE_1_TITLE',
            'Engineer material title'.padEnd(80),
            ' '.repeat(80),
            ' '.repeat(80),
        ], { line: 3, character: 75 }, { keywordLine: 0 });

        assert.equal(result.status, 'ready');
        assert.equal(result.keyword, '*MAT_DAMAGE_1_TITLE');
        assert.equal(result.catalogKeyword, result.keyword);
        assert.equal(result.physicalCardIndex, 3);
        assert.equal(result.fieldName, 'FLAG');
        assert.deepEqual(result.choices.map(choice => choice.valueText), ['0', '-1', '1']);
    });

    it('uses native TITLE prefixes without inventing field value choices', () => {
        for (const keyword of ['*DEFINE_FUNCTION_TITLE', '*DEFINE_FUNCTION_TABULATED_TITLE']) {
            const { result } = plan([
                keyword,
                'Function title'.padEnd(80),
                '         1',
                'x+y',
            ], { line: 2, character: 5 }, { keywordLine: 0 });

            assert.equal(result.status, 'no-choice');
            assert.equal(result.reason, 'no-native-field-choice');
            assert.deepEqual(result.choices, []);
        }
    });

    it('uses TITLE physical order despite stale field-header comments', () => {
        const { result } = plan([
            '*MAT_DAMAGE_1_TITLE',
            '$#     mid        ro         e        pr      sigy      lcss      lcds',
            ' '.repeat(80),
            '$#      q1        c1        q2        c2      epsd    espr/s        dc      flag',
            `${' '.repeat(70)}        -1`,
        ], { line: 4, character: 75 }, { keywordLine: 0 });

        assert.equal(result.status, 'no-choice');
        assert.notEqual(result.reason, 'comment-header-card-position-conflict');
        assert.equal(result.keyword, '*MAT_DAMAGE_1_TITLE');
        assert.equal(result.physicalCardIndex, null);
        assert.deepEqual(result.choices, []);
        assert.ok(result.lineReads <= 5);
    });

    it('keeps TITLE physical mapping independent of field-header comments when the records are complete', () => {
        const { result } = plan([
            '*MAT_DAMAGE_1_TITLE',
            'Engineer material title'.padEnd(80),
            '$#     mid        ro         e        pr      sigy      lcss      lcds',
            ' '.repeat(80),
            '$#      q1        c1        q2        c2      epsd    espr/s        dc      flag',
            `${' '.repeat(70)}        -1`,
        ], { line: 5, character: 75 }, { keywordLine: 0 });

        assert.equal(result.status, 'ready');
        assert.equal(result.physicalCardIndex, 3);
        assert.equal(result.fieldName, 'FLAG');
        assert.deepEqual(result.choices.map(choice => choice.valueText), ['0', '-1', '1']);
        assert.ok(result.lineReads <= 6);
    });

    it('retains field choices despite mismatched comment labels', () => {
        const { result } = plan([
            '*MAT_DAMAGE_1',
            ' '.repeat(80),
            '$#      q1        c1        q2        c2      epsd    espr/s     olddc   oldflag',
            `${' '.repeat(70)}        -1`,
        ], { line: 3, character: 75 }, { keywordLine: 0 });

        assert.equal(result.status, 'ready');
        assert.notEqual(result.reason, 'comment-field-version-unconfirmed');
        assert.equal(result.fieldName, 'FLAG');
        assert.deepEqual(result.choices.map(choice => choice.valueText), ['0', '-1', '1']);
        assert.ok(result.lineReads <= 5);
    });

    it('bounds TITLE physical-card counting instead of scanning a long block', () => {
        const lines = [
            '*MAT_DAMAGE_1_TITLE',
            ...Array.from({ length: 32 }, () => '$ bounded comment'),
            ' '.repeat(80),
        ];
        const { result } = plan(lines, { line: 33, character: 75 }, { keywordLine: 0 });

        assert.equal(result.status, 'truncated');
        assert.equal(result.reason, 'physical-card-position-lookback-limit');
        assert.ok(result.lineReads <= 34);
        assert.deepEqual(result.choices, []);
    });

    it('restores manual special cases when native field geometry has no enumeration', () => {
        const { result } = plan(['*DAMPING_GLOBAL', ' '.repeat(80)],
            { line: 1, character: 5 }, { keywordLine: 0 });
        assert.equal(result.status, 'ready');
        assert.equal(result.domainKind, 'mixed');
        assert.equal(result.domainComplete, false);
        assert.equal(result.ruleId, 'rule:288afcb133bc8d74c310fde6');
        assert.deepEqual(result.choices.map(choice => [choice.valueText, choice.role]), [['0', 'sentinel']]);
    });

    it('rejects official value editing for display-only CONTROL_THERMAL_TIMESTEP', () => {
        const { result } = plan(['*CONTROL_THERMAL_TIMESTEP', ' '.repeat(80)],
            { line: 1, character: 45 }, { keywordLine: 0 });
        assert.equal(result.status, 'schema-mismatch');
        assert.equal(result.reason, 'native-field-edit-binding-unverified');
        assert.deepEqual(result.choices, []);
    });

    it('fails open for parameters and expressions without projecting writable choices', () => {
        for (const [rawValue, expected] of [
            ['&FLAG', 'parameter-controlled'],
            ['-&FLAG', 'parameter-controlled'],
            ['<FLAG+1>', 'expression-controlled'],
            ['(1+2)', 'expression-controlled'],
            ['1+2', 'expression-controlled'],
            ['1-2', 'expression-controlled'],
        ]) {
            const cell = rawValue.padStart(10);
            const { result } = plan([
                '*MAT_DAMAGE_1',
                ' '.repeat(80),
                `${' '.repeat(70)}${cell}`,
            ], { line: 2, character: 75 }, { keywordLine: 0 });
            assert.equal(result.status, expected, rawValue);
            assert.deepEqual(result.choices, [], rawValue);
        }
    });

    it('rejects comma/free, keyword long, global long, and I10 input geometry', () => {
        const cases = [
            {
                lines: ['*MAT_DAMAGE_1', '0,0', '0,0,0,0,0,0,0,0'],
                position: { line: 2, character: 7 },
                options: { keywordLine: 0 },
            },
            {
                lines: ['*MAT_DAMAGE_1+', ' '.repeat(160), ' '.repeat(160)],
                position: { line: 2, character: 75 },
                options: { keywordLine: 0 },
            },
            {
                lines: ['*MAT_DAMAGE_1', ' '.repeat(80), ' '.repeat(80)],
                position: { line: 2, character: 75 },
                options: { keywordLine: 0, globalInputFormat: 'long' },
            },
            {
                lines: ['*MAT_DAMAGE_1%', ' '.repeat(100), ' '.repeat(100)],
                position: { line: 2, character: 75 },
                options: { keywordLine: 0 },
            },
        ];
        for (const item of cases) {
            const { result } = plan(item.lines, item.position, item.options);
            assert.equal(result.status, 'unsupported-format');
        }

        const localStandard = plan([
            '*MAT_DAMAGE_1-', ' '.repeat(80), ' '.repeat(80),
        ], { line: 2, character: 75 }, {
            keywordLine: 0,
            globalInputFormat: 'long',
        }).result;
        assert.equal(localStandard.status, 'ready');
    });

    it('requires a complete fixed-width cell', () => {
        const short = plan([
            '*MAT_DAMAGE_1',
            ' '.repeat(80),
            ' '.repeat(75),
        ], { line: 2, character: 72 }, { keywordLine: 0 }).result;
        assert.equal(short.status, 'schema-mismatch');
        assert.equal(short.reason, 'complete-fixed-cell-unavailable');

    });

    it('fails closed before projecting choices when the resolved card geometry overlaps', () => {
        const unsafeSchema = {
            MAT_UNSAFE: {
                c: [[
                    { n: 'A', p: 0, w: 10, t: 'integer' },
                    { n: 'B', p: 5, w: 10, t: 'integer' },
                ]],
            },
        };
        const result = planOfficialFieldChoices(
            fakeDoc([
                '*MAT_UNSAFE',
                ' '.repeat(80),
            ]),
            { line: 1, character: 6 },
            unsafeSchema,
            { keywordLine: 0 },
        );

        assert.equal(result.status, 'schema-mismatch');
        assert.equal(result.reason, 'safe-fixed-card-unavailable');
        assert.deepEqual(result.choices, []);
    });

    it('does not scan backward by default and bounds an explicit compatibility lookback', () => {
        const lines = [
            '*MAT_DAMAGE_1',
            ' '.repeat(80),
            ' '.repeat(80),
        ];
        const hidden = plan(lines, { line: 2, character: 75 }).result;
        assert.equal(hidden.status, 'document-unindexed');
        assert.equal(hidden.lineReads, 1);

        const explicit = plan(lines, { line: 2, character: 75 }, {
            maximumKeywordLookback: 8,
        }).result;
        assert.equal(explicit.status, 'ready');

        const truncatedLines = [
            '*MAT_DAMAGE_1',
            ...Array.from({ length: 300 }, () => ' '.repeat(80)),
        ];
        const truncated = plan(truncatedLines, { line: 300, character: 75 }, {
            maximumKeywordLookback: 32,
        }).result;
        assert.equal(truncated.status, 'truncated');
        assert.ok(truncated.lineReads <= 33);
    });

    it('uses an existing BlockIndex and keeps million-line tail planning constant', () => {
        const lineCount = 1_000_000;
        const keywordLine = lineCount - 3;
        let reads = 0;
        const document = {
            version: 7,
            lineCount,
            lineAt(line) {
                reads++;
                return {
                    text: line === keywordLine ? '*MAT_DAMAGE_1' : ' '.repeat(80),
                };
            },
        };
        const blockIndex = {
            lineCount,
            findBlockAtLine(line) {
                assert.equal(line, lineCount - 1);
                return { startLine: keywordLine, endLine: lineCount - 1 };
            },
        };

        const result = planOfficialFieldChoices(
            document,
            { line: lineCount - 1, character: 75 },
            fieldData,
            { blockIndex, expectedDocumentVersion: 7 },
        );
        assert.equal(result.status, 'ready');
        assert.equal(result.usedBlockIndex, true);
        assert.ok(reads <= 5, `expected constant line reads, got ${reads}`);

        const stale = planOfficialFieldChoices(
            document,
            { line: lineCount - 1, character: 75 },
            fieldData,
            { blockIndex, expectedDocumentVersion: 6 },
        );
        assert.equal(stale.status, 'stale');
        assert.equal(stale.lineReads, 0);
    });
});
