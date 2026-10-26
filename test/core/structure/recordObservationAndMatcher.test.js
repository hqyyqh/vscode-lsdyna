'use strict';

const assert = require('assert');
const {
    blankRecordForExpected,
    matchObservedRecord,
    observeKeywordBlock,
} = require('../../../src/core/structure');

function expected(overrides = {}) {
    return {
        nodeId: 'structure-node:test',
        cardNodeId: 'card-1',
        cardLabel: 'Card 1',
        wrappers: [],
        node: {
            nodeId: 'structure-node:test',
            type: 'record',
            cardNodeId: 'card-1',
            cardLabel: 'Card 1',
            blankAllowed: false,
            formatChoice: ['standard-fixed', 'free-comma'],
            geometryRef: {
                kind: 'official-field-signature',
                fieldWidth: 10,
                fields: [
                    { index: 0, name: 'ID', typeCode: 'I' },
                    { index: 1, name: 'VALUE', typeCode: 'F' },
                    { index: 2, name: null, typeCode: null },
                ],
            },
            ...overrides,
        },
    };
}

function observed(text, format = text.includes(',') ? 'free' : 'fixed') {
    return { ordinal: 1, line: 10, text, format, comments: [] };
}

describe('keyword structure record observation and geometry matching', () => {
    it('skips ASCII-space comments while retaining blank, tab and non-ASCII-space records', () => {
        const result = observeKeywordBlock('*TEST', [
            '$ ordinary comment',
            '$#       ID     VALUE',
            '   $ indented ordinary comment',
            '         1       2.5',
            '',
            '\t$this-is-data',
            '\u00a0$this-is-data',
            '  $# indented field header',
            '*END',
            'unreachable',
        ], { keywordLine: 20 });
        assert.equal(result.status, 'observed');
        assert.equal(result.block.records.length, 4);
        assert.deepEqual(result.block.records.map(record => record.line), [24, 25, 26, 27]);
        assert.equal(result.block.records[0].comments.length, 3);
        assert.equal(result.block.records[0].comments[1].kind, 'field-header');
        assert.equal(result.block.records[0].comments[2].text, '   $ indented ordinary comment');
        assert.equal(result.block.records[1].text, '');
        assert.equal(result.block.records[2].text, '\t$this-is-data');
        assert.equal(result.block.records[3].text, '\u00a0$this-is-data');
        assert.deepEqual(result.block.trailingComments, [
            { line: 28, text: '  $# indented field header', kind: 'field-header' },
        ]);
        assert.equal(result.block.boundary, 'next-keyword');
    });

    it('keeps BEAM records adjacent across an indented comment', () => {
        const rows = ['         1         2', '   $ indented ordinary comment', '         3         4'];
        const result = observeKeywordBlock('*SECTION_BEAM', [...rows, '*END'], { keywordLine: 42 });
        assert.deepEqual(result.block.records.map(row => [row.line, row.text]), [[43, rows[0]], [45, rows[2]]]);
        assert.equal(result.block.records[1].comments[0].text, rows[1]);
    });

    it('separates preprocessor metadata and enforces physical-line and record budgets', () => {
        const observedBlock = observeKeywordBlock('*TEST', [
            '  #if FEATURE',
            '1',
            '#endif',
        ]);
        assert.equal(observedBlock.block.records.length, 1);
        assert.equal(observedBlock.block.preprocessorMetadata.length, 2);
        assert.equal(
            observeKeywordBlock('*TEST', ['1', '2'], { maximumPhysicalLines: 1 }).reason,
            'physical-line-budget-exceeded',
        );
        assert.equal(
            observeKeywordBlock('*TEST', ['1', '2'], { maximumRecords: 1 }).reason,
            'record-budget-exceeded',
        );
    });

    it('decodes fixed and comma-free cards independently, including D and implicit exponents', () => {
        const fixed = matchObservedRecord(expected(), observed(
            '         7' + '    1.5D+2' + ' '.repeat(10),
        ));
        assert.equal(fixed.quality, 'exact');
        assert.deepEqual(fixed.decodedFields.map(field => field.value), [7, 150]);

        const free = matchObservedRecord(expected(), observed('7,1.5-2,'));
        assert.equal(free.quality, 'exact');
        assert.equal(free.decodedFields[1].value, 0.015);

        const unsignedExponent = matchObservedRecord(expected(), observed('7,1.5D2,'));
        assert.equal(unsignedExponent.quality, 'exact');
        assert.equal(unsignedExponent.decodedFields[1].value, 150);

        const parameter = matchObservedRecord(expected(), observed('7,&VALUE,'));
        assert.equal(parameter.quality, 'unknown');
        assert.equal(parameter.decodedFields[1].state, 'parameter');
    });

    it('rejects invalid types, nonblank reserved slots, unauthorized formats, and marker drift', () => {
        assert.equal(matchObservedRecord(expected(), observed('       abc       1.0')).quality, 'mismatch');
        assert.equal(matchObservedRecord(expected(), observed('1,2,forbidden')).reason, 'reserved-field-is-nonblank');
        assert.equal(matchObservedRecord(expected({ formatChoice: ['standard-fixed'] }), observed('1,2,')).quality,
            'unsupported');
        assert.equal(matchObservedRecord(expected({ formatChoice: ['long'] }), observed('         1       2.0')).quality,
            'unsupported');
        assert.equal(matchObservedRecord({ ...expected(), marker: { kind: 'column-one', value: '&' } },
            observed('         1       2.0')).reason, 'record-marker-mismatch');
        assert.equal(matchObservedRecord({ ...expected(), marker: { kind: 'column-one', value: '&' } },
            observed('&        1       2.0')).quality, 'mismatch',
        'the marker matches, but the integer field still correctly rejects the ampersand payload');
    });

    it('withholds numeric values for unsupported integers without calling them invalid', () => {
        for (const typeCode of ['I', 'INTEGER']) {
            const card = expected({ geometryRef: { kind: 'official-field-signature', fieldWidth: 20,
                fields: [{ index: 0, name: 'ID', typeCode }] } });
            for (const raw of ['9007199254740992', '9007199254740993', '-9007199254740993', '9'.repeat(400)]) {
                for (const text of [raw + ',', raw.padStart(20)]) {
                    if (!text.includes(',') && text.length > 20) continue;
                    const result = matchObservedRecord(card, observed(text));
                    assert.equal(result.quality, 'unsupported', raw);
                    assert.equal(result.reason, 'field-integer-unrepresentable:ID');
                    assert.equal(result.decodedFields[0].state, 'unsupported');
                    assert.equal(result.decodedFields[0].raw, raw);
                    assert.equal(result.decodedFields[0].value, undefined);
                }
            }
            for (const raw of ['9007199254740991', '-9007199254740991', '+000007', '-0']) {
                const result = matchObservedRecord(card, observed(raw + ','));
                assert.equal(result.quality, 'exact');
                assert.ok(Object.is(result.decodedFields[0].value, Number(raw)));
            }
        }
    });

    it('creates blanks only from bounded official geometry', () => {
        assert.equal(blankRecordForExpected(expected()).length, 30);
        assert.equal(blankRecordForExpected(expected({ geometryRef: { kind: 'none' } })), null);
    });

    it('keeps annotation-only changes out of record text and ordinals', () => {
        const first = observeKeywordBlock('*TEST', ['$# A B', '1', '$ prose', '2']).block;
        const second = observeKeywordBlock('*TEST', ['$# entirely different', '1', '$ changed', '2']).block;
        assert.deepEqual(first.records.map(record => record.text), second.records.map(record => record.text));
        assert.deepEqual(first.records.map(record => record.ordinal), [1, 2]);
    });
});
