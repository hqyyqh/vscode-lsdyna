'use strict';

const assert = require('node:assert/strict');
const { resolveStaticDescriptorFormat } = require('../../out/core/semantics/staticDescriptorFormat');
const descriptorFixture = require('../fixtures/public-behavior/synthetic-descriptor-identities.json').static;

const SOURCE = 'a'.repeat(64);

function field(cardIndex, fieldIndex, name, type, help = `${name} help`) {
    return {
        choices: fieldIndex === 0 ? ['0', '1'] : [],
        defaultValue: fieldIndex === 1 ? null : String(fieldIndex),
        fieldRecordId: descriptorFixture.cards[cardIndex - 1].fields[fieldIndex].fieldRecordId,
        fieldId: `card-${cardIndex}-field-${fieldIndex}`,
        fieldIndex,
        name,
        position: fieldIndex * 10,
        serializationPosition: fieldIndex * 10,
        serializationSlotId: `card-${cardIndex}-slot-${fieldIndex + 1}`,
        serializationWidth: 10,
        type,
        width: 10,
        help,
    };
}

function card(cardIndex, fields) {
    return {
        cardRecordId: descriptorFixture.cards[cardIndex - 1].cardRecordId,
        cardIndex,
        fields,
        occurrence: { kind: 'source-bound' },
        recordKind: 'fields',
        serializationSlots: fields.map(item => ({
            fieldIndexes: [item.fieldIndex], position: item.position,
            slotId: item.serializationSlotId, width: item.width,
        })),
    };
}

function fixture() {
    const cards = [
        card(1, [field(1, 0, 'ID', 1), field(1, 1, 'VALUE', 2), field(1, 2, 'LABEL', 0)]),
        card(2, [field(2, 0, 'FLAG', 1), field(2, 1, 'RATE', 2)]),
    ];
    const rule = {
        cardSetId: descriptorFixture.cardSetId,
        cards,
        dataActions: [],
        initialSnapshot: { runtimeWidgetGroups: [] },
        serializationFormats: [
            { fieldCoordinates: 'native', format: 'standard-fixed' },
            { fieldCoordinates: 'native-times-two', format: 'long-fixed' },
            { fieldCoordinates: 'native', format: 'i10-fixed' },
            { fieldCoordinates: 'field-ordinal', format: 'comma-free' },
        ],
    };
    const form = {
        keyword: 'TEST_STATIC',
        reference: { formRuleIds: ['form'], fieldRuleIds: [] },
        rules: { form: rule },
        source: {
            schemaVersion: 4, datasetVersion: "catalog-v1", datasetSha256: SOURCE,
            conservationSatisfied: true, isUnauditedDiagnostic: false,
        },
    };
    const type = value => value === 1 ? 'integer' : value === 2 ? 'real' : 'string';
    const schemaCards = cards.map(item => item.fields.map(native => ({
        n: native.name, p: native.position, w: native.width, t: type(native.type),
    })));
    const lookup = {
        inputName: 'TEST_STATIC', canonicalName: 'TEST_STATIC',
        entry: { c: schemaCards }, activeOptions: [],
    };
    const catalog = { formForKeyword: () => form };
    return { cards, rule, form, schemaCards, lookup, catalog };
}

function request(overrides = {}) {
    const value = fixture();
    return { value, input: {
        keyword: '*TEST_STATIC', lookup: value.lookup, schemaCards: value.schemaCards,
        ordinal: 1, currentText: ' 12 ,  ,X', inputFormat: 'comma', catalog: value.catalog,
        ...overrides,
    } };
}

describe('static descriptor non-standard format resolver', () => {
    it('projects comma ranges and binds every value to a stable native descriptor identity', () => {
        const { input } = request();
        const result = resolveStaticDescriptorFormat(input);
        assert.equal(result.status, 'resolved');
        assert.equal(result.formRuleId, 'form');
        assert.equal(result.cardIndex, 1);
        assert.deepEqual(result.card.map(item => item.sourceRange), [
            { start: 1, end: 3 }, { start: 7, end: 7 }, { start: 8, end: 9 },
        ]);
        assert.deepEqual(result.card.map(item => item.rawValue), ['12', '', 'X']);
        assert.deepEqual(result.card.map(item => item.t), ['integer', 'real', 'string']);
        assert.deepEqual(result.card[0].e, ['0', '1']);
        assert.equal(result.card[1].d, undefined);
        assert.equal(result.card[0].definitionSource.fieldRecordId, descriptorFixture.cards[0].fields[0].fieldRecordId);
        assert.equal(result.card[0].fieldRecordId, descriptorFixture.cards[0].fields[0].fieldRecordId);
        assert.equal(result.card[0].staticDescriptorIdentity.stableIdentity,
            `${SOURCE}:form:1:${descriptorFixture.cards[0].cardRecordId}:0:${descriptorFixture.cards[0].fields[0].fieldRecordId}`);

        const missingTail = resolveStaticDescriptorFormat(request({ currentText: '1' }).input);
        assert.equal(missingTail.status, 'resolved');
        assert.deepEqual(missingTail.card.map(item => item.sourceRange), [
            { start: 0, end: 1 }, { start: 1, end: 1 }, { start: 1, end: 1 },
        ]);
    });

    it('uses the shared serializer geometry for LONG and I10 and clips ranges to actual text', () => {
        for (const [inputFormat, text, positions, ranges] of [
            ['long', '1'.padStart(20) + '2'.padStart(5), [0, 20, 40],
                [{ start: 0, end: 20 }, { start: 20, end: 25 }, { start: 25, end: 25 }]],
            ['i10', '1'.padStart(10) + '2'.padStart(5), [0, 10, 20],
                [{ start: 0, end: 10 }, { start: 10, end: 15 }, { start: 15, end: 15 }]],
        ]) {
            const { input } = request({ inputFormat, currentText: text });
            const result = resolveStaticDescriptorFormat(input);
            assert.equal(result.status, 'resolved');
            assert.deepEqual(result.card.map(item => item.p), positions);
            assert.deepEqual(result.card.map(item => item.sourceRange), ranges);
        }
    });

    it('keeps incomplete or contradictory input separate from implementation gaps', () => {
        assert.deepEqual(resolveStaticDescriptorFormat(request({ ordinal: 3 }).input),
            { status: 'input-uncertain', reason: 'record-layout-unavailable' });
        assert.deepEqual(resolveStaticDescriptorFormat(request({ ordinal: 0 }).input),
            { status: 'input-uncertain', reason: 'record-ordinal-unavailable' });
        assert.deepEqual(resolveStaticDescriptorFormat(request({ inputFormat: 'long', currentText: '1,2' }).input),
            { status: 'input-uncertain', reason: 'conflicting-input-format' });
        assert.deepEqual(resolveStaticDescriptorFormat(request({ currentText: '1,2,3,4' }).input),
            { status: 'input-uncertain', reason: 'extra-comma-fields' });
    });

    it('fails closed for excluded layout mechanisms without keyword cases', () => {
        const cases = [
            [({ value }) => { value.form.source.conservationSatisfied = false; }, 'input-form-source-unverified'],
            [({ value }) => { value.form.reference.formRuleIds.push('other'); }, 'single-form-required'],
            [({ value }) => { value.form.reference.fieldRuleIds.push('state'); }, 'field-rules-present'],
            [({ value }) => { value.rule.recordSelection = {}; }, 'dynamic-form-semantics'],
            [({ value }) => { value.rule.dataActions.push({ kind: 'button' }); }, 'dynamic-form-semantics'],
            [({ value }) => { value.rule.initialSnapshot.runtimeWidgetGroups.push({ id: 'widget' }); }, 'dynamic-form-semantics'],
            [({ value }) => { value.rule.occurrenceGrammar = { repeatResolution: 'source-compatible-native-card' }; }, 'native-occurrence-semantics'],
            [({ value }) => { value.rule.constructionOperations = [{ primitiveId: 'dynamic-record-controls' }]; }, 'native-occurrence-semantics'],
            [({ value }) => { value.lookup.entry.r = 1; }, 'repeating-schema-records'],
            [({ value }) => { value.lookup.entry.tc = [{ name: 'text', f: [] }]; }, 'text-card-schema'],
            [({ value }) => { value.lookup.activeOptions = ['TITLE']; }, 'title-layout'],
            [({ value }) => { value.cards[0].recordKind = 'raw-text'; }, 'descriptor-contract-mismatch'],
            [({ value }) => { value.cards[0].fields[1].position = 11; }, 'descriptor-contract-mismatch'],
            [({ value }) => { value.schemaCards[0][1].n = 'OTHER'; }, 'schema-descriptor-mismatch'],
        ];
        for (const [change, reason] of cases) {
            const item = request();
            change(item);
            assert.deepEqual(resolveStaticDescriptorFormat(item.input),
                { status: 'implementation-gap', reason });
        }
    });

    it('requires the requested spelling to match the lookup and audited catalog identity', () => {
        assert.deepEqual(resolveStaticDescriptorFormat(request({ keyword: '*OTHER' }).input),
            { status: 'implementation-gap', reason: 'input-identity-mismatch' });
        const item = request();
        item.value.form.keyword = 'OTHER';
        assert.deepEqual(resolveStaticDescriptorFormat(item.input),
            { status: 'implementation-gap', reason: 'catalog-identity-mismatch' });
    });

    it('treats native dash placeholders as the schema UNUSED identity', () => {
        const item = request();
        item.value.cards[0].fields[2].name = '-';
        item.value.schemaCards[0][2].n = 'UNUSED';
        const result = resolveStaticDescriptorFormat(item.input);
        assert.equal(result.status, 'resolved');
        assert.equal(result.card[2].n, 'UNUSED');
    });
});
