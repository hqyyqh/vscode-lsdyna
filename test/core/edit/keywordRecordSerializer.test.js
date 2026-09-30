'use strict';

const assert = require('assert');
const {
    blankRecord,
    detectRecordFormat,
    formattedFields,
    readRecordField,
    writeRecordField,
} = require('../../../out/core/edit/keywordRecordSerializer');

describe('Keyword Input Form record serializer', () => {
    const fields = [
        { name: 'ID', type: 1, position: 0, width: 10 },
        { name: 'VALUE', type: 2, position: 10, width: 10 },
    ];

    it('writes standard, long and I10 records without touching neighboring bytes', () => {
        const standard = '         1       2.5$tail';
        const changed = writeRecordField(standard, fields, 1, '3.5', 'standard');
        assert.equal(readRecordField(changed, fields, 0, 'standard'), '1');
        assert.equal(readRecordField(changed, fields, 1, 'standard'), '3.5');
        assert.equal(changed.slice(20), '$tail');

        const longFields = formattedFields(fields, '', 'long');
        assert.deepEqual(longFields.map(field => [field.position, field.width]), [[0, 20], [20, 20]]);
        const long = writeRecordField('1'.padStart(20) + '2.5'.padStart(20), fields, 1, '4.5', 'long');
        assert.equal(readRecordField(long, fields, 1, 'long'), '4.5');
        assert.equal(readRecordField('         1       2.5', fields, 0, 'i10'), '1');
    });

    it('preserves comma and whitespace separators while allowing token growth', () => {
        const comma = writeRecordField(' 1 ,  2.5 ,keep', fields, 1, '123.5', 'comma');
        assert.equal(comma, ' 1 ,  123.5 ,keep');
        assert.equal(readRecordField(comma, fields, 1, 'comma'), '123.5');
        const free = writeRecordField('1   2.5   keep', fields, 1, '9.25', 'free');
        assert.equal(free, '1   9.25   keep');
        assert.equal(detectRecordFormat('1,2', 'standard', fields), 'comma');
    });

    it('keeps sparse fixed records fixed instead of appending edits beyond the native fields', () => {
        const eight = Array.from({ length: 8 }, (_, i) => ({ name: `F${i}`, type: 1, position: 10 * i, width: 10 }));
        for (const text of ['       101         1', '       101         1'.padEnd(80)]) {
            assert.equal(detectRecordFormat(text, 'standard', eight), 'standard');
            const next = writeRecordField(text, eight, 2, '2', detectRecordFormat(text, 'standard', eight));
            assert.equal(next.slice(20,30).trim(), '2');
            assert.equal(next.slice(10,20).trim(), '1');
        }
        assert.equal(detectRecordFormat('101 1', 'standard', eight), 'free');
    });

    it('round-trips raw text records exactly', () => {
        const raw = [{ name: 'DATA', type: 'raw-text', position: 0, width: 1 }];
        assert.equal(detectRecordFormat(' arbitrary data ', 'standard', raw), 'raw');
        assert.equal(readRecordField(' arbitrary data ', raw, 0, 'raw'), ' arbitrary data ');
        assert.equal(writeRecordField('old', raw, 0, '  new value  ', 'raw'), '  new value  ');
        assert.equal(blankRecord(raw, 'raw'), '');
    });

    it('keeps spaces and commas inside title fields out of free-format detection', () => {
        const title = [{ name: 'TITLE', type: 0, position: 0, width: 80 }];
        for (const value of ['format curve', 'steel, global contact']) {
            assert.equal(detectRecordFormat(value, 'standard', title), 'standard');
            assert.equal(readRecordField(value, title, 0, 'standard'), value);
        }
        const idTitle = [fields[0], { name: 'TITLE', type: 0, position: 10, width: 70 }];
        const source = '10001'.padStart(10) + 'Global Contact';
        assert.equal(detectRecordFormat(source, 'standard', idTitle), 'standard');
        assert.equal(readRecordField(source, idTitle, 0, 'standard'), '10001');
        assert.equal(readRecordField(source, idTitle, 1, 'standard'), 'Global Contact');
        assert.equal(detectRecordFormat('1 2.5', 'standard', fields), 'free');
        assert.equal(detectRecordFormat('1,&VALUE', 'standard', fields), 'comma');
    });

    it('rejects delimiter injection and free-field deletion that shifts neighboring values', () => {
        const three = [...fields, { name: 'NEXT', type: 1, position: 20, width: 10 }];
        for (const format of ['standard', 'long', 'i10']) {
            const fixed = writeRecordField(blankRecord(three, format), three, 0, '1', format);
            assert.equal(writeRecordField(fixed, three, 1, '1,2', format), fixed);
        }
        for (const value of ['', ' ', '7 8', '7,8', '\t']) {
            assert.equal(writeRecordField('1   2   3', three, 1, value, 'free'), '1   2   3');
        }
        assert.equal(writeRecordField('1', three, 2, '9', 'free'), '1');
        assert.equal(writeRecordField('1,2,3', three, 1, '7,8', 'comma'), '1,2,3');
        const clearedComma = writeRecordField('1,2,3', three, 1, '', 'comma');
        assert.equal(clearedComma, '1,,3');
        assert.equal(readRecordField(clearedComma, three, 2, 'comma'), '3');
        const appended = writeRecordField('1   ', three, 1, '9', 'free');
        assert.equal(appended, '1   9');
        assert.equal(readRecordField(appended, three, 0, 'free'), '1');
        assert.equal(readRecordField(appended, three, 1, 'free'), '9');
        assert.equal(writeRecordField('1   9', three, 1, '', 'free'), '1   ');
    });
});
