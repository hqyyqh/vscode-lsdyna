'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { fakeDoc } = require("../../support/helpers");
const { getCardInfoForDocumentLineWithSuggest: resolve } = require("../../../out/extension")._internals;

describe('Category EFV Native Reader 100% Full Closure', () => {
    describe('Keyword: *EFV_BOUNDARY_FLOW_OUT (input-form-2267, 1 card)', () => {
        const standard = [
            '*EFV_BOUNDARY_FLOW_OUT',
            '         1         1         2         1         2         1         2'
        ];

        const comma = [
            '*EFV_BOUNDARY_FLOW_OUT',
            '1,1,2,1,2,1,2'
        ];

        const long = [
            '*EFV_BOUNDARY_FLOW_OUT+',
            '                   1                   1                   2                   1                   2                   1                   2'
        ];

        const i10 = [
            '*EFV_BOUNDARY_FLOW_OUT%',
            '         1         1         2         1         2         1         2'
        ];

        const expectedFields = ['ID', 'IMN', 'IMX', 'JMN', 'JMX', 'KMN', 'KMX'];

        it('resolves card 1 in standard format with strict read-only safety', () => {
            const doc = fakeDoc(standard.join('\n'));
            const res = resolve(doc, 1);
            assert.ok(res?.cardInfo);
            assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
            assert.equal(res.cardInfo.nativeCardIndex, 1);
            assert.deepEqual(res.cardInfo.card.map(f => f.n), expectedFields);
            assert.equal(res.cardInfo.approvedStaticRecord, undefined);
        });

        it('resolves card 1 in comma format', () => {
            const doc = fakeDoc(comma.join('\n'));
            const res = resolve(doc, 1);
            assert.ok(res?.cardInfo);
            assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
            assert.equal(res.cardInfo.inputFormat, 'comma');
            assert.deepEqual(res.cardInfo.card.map(f => f.n), expectedFields);
        });

        it('resolves card 1 in long format (+)', () => {
            const doc = fakeDoc(long.join('\n'));
            const res = resolve(doc, 1);
            assert.ok(res?.cardInfo);
            assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
            assert.equal(res.cardInfo.inputFormat, 'long');
            assert.deepEqual(res.cardInfo.card.map(f => f.n), expectedFields);
        });

        it('resolves card 1 in i10 format (%)', () => {
            const doc = fakeDoc(i10.join('\n'));
            const res = resolve(doc, 1);
            assert.ok(res?.cardInfo);
            assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
            assert.equal(res.cardInfo.inputFormat, 'i10');
            assert.deepEqual(res.cardInfo.card.map(f => f.n), expectedFields);
        });
    });

    describe('Keyword: *EFV_DETONATION (input-form-2278, 7 cards)', () => {
        const lines = [
            '*EFV_DETONATION',
            '         1       0.0       0.0       0.0         0         0         0         0',
            '       0.0       0.0       0.0       0.0       0.0       0.0       0.0       0.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0       0.0       0.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0       0.0       0.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0       0.0       0.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0       0.0       0.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0       0.0       0.0'
        ];

        it('resolves all 7 cards in standard format', () => {
            const doc = fakeDoc(lines.join('\n'));
            for (let c = 1; c <= 7; c++) {
                const res = resolve(doc, c);
                assert.ok(res?.cardInfo, `Card ${c} info missing`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.nativeCardIndex, c);
                assert.equal(res.cardInfo.approvedStaticRecord, undefined);
            }
        });
    });

    describe('Keyword: *EFV_EOS_COMPACTION (input-form-2321, 13 cards)', () => {
        const dummyCards = Array.from({ length: 13 }, () => '       0.0       0.0       0.0       0.0       0.0       0.0       0.0       0.0');
        const lines = ['*EFV_EOS_COMPACTION', ...dummyCards];

        it('resolves all 13 cards in standard format', () => {
            const doc = fakeDoc(lines.join('\n'));
            for (let c = 1; c <= 13; c++) {
                const res = resolve(doc, c);
                assert.ok(res?.cardInfo, `Card ${c} info missing`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.nativeCardIndex, c);
            }
        });
    });

    it('achieves 100.0% native closure across all 114 Category EFV registrations', function() {
        this.timeout(10000);
        const data = { registrations: require("../../fixtures/public-behavior/category-registration-keywords.json") };
        const regs = data.registrations.filter(r => r.category === 'EFV');
        assert.equal(regs.length, 114, 'Category EFV should have strictly 114 registrations');

        let resolved = 0;
        const failures = [];
        for (const reg of regs) {
            const kw = reg.name.startsWith('EFV') ? reg.name : `EFV_${reg.name}`;
            const doc = fakeDoc(['*' + kw, '         1         2         3         4'].join('\n'));
            const res = resolve(doc, 1);
            if (res?.cardInfo?.resolutionSource === 'native-file-reader' || res?.reason === 'native-reader-has-no-data-fields') {
                resolved++;
            } else {
                failures.push({ kw, source: res?.cardInfo?.resolutionSource, reason: res?.reason });
            }
        }
        assert.equal(failures.length, 0, `Category EFV had unresolved keywords: ${JSON.stringify(failures)}`);
        assert.equal(resolved, 114, 'Category EFV closure is not 100%');
    });
});
