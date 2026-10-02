'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { fakeDoc } = require("../../support/helpers");
const { getCardInfoForDocumentLineWithSuggest: resolve } = require("../../../out/extension")._internals;

describe('Category CASE, COSIM and FATIGUE Native Reader Closure', () => {
    describe('Keyword: *CASE (input-form-2357, 3 cards)', () => {
        const standard = [
            '*CASE',
            '      1001      1002',
            'SOLVER_RUN_COMMAND_OPTIONS',
            '         1         2         3         4         5         6         7         8'
        ];

        const comma = [
            '*CASE',
            '1001,1002',
            'SOLVER_RUN_COMMAND_OPTIONS',
            '1,2,3,4,5,6,7,8'
        ];

        const long = [
            '*CASE+',
            '                1001                1002',
            'SOLVER_RUN_COMMAND_OPTIONS',
            '                   1                   2                   3                   4                   5                   6                   7                   8'
        ];

        const i10 = [
            '*CASE%',
            '      1001      1002',
            'SOLVER_RUN_COMMAND_OPTIONS',
            '         1         2         3         4         5         6         7         8'
        ];

        const expectedFields = [
            ['CASEID', 'JOBID'],
            ['COMMANDS'],
            ['SCID1', 'SCID2', 'SCID3', 'SCID4', 'SCID5', 'SCID6', 'SCID7', 'SCID8']
        ];

        it('resolves all 3 cards in standard format with strict read-only safety', () => {
            const doc = fakeDoc(standard.join('\n'));
            for (let cardIdx = 1; cardIdx <= 3; cardIdx++) {
                const res = resolve(doc, cardIdx);
                assert.ok(res?.cardInfo, `Expected cardInfo for Card ${cardIdx}`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.nativeCardIndex, cardIdx);
                assert.deepEqual(res.cardInfo.card.map(f => f.n), expectedFields[cardIdx - 1]);
                assert.equal(res.cardInfo.approvedStaticRecord, undefined);
            }
        });

        it('resolves all 3 cards in comma format', () => {
            const doc = fakeDoc(comma.join('\n'));
            for (let cardIdx = 1; cardIdx <= 3; cardIdx++) {
                const res = resolve(doc, cardIdx);
                assert.ok(res?.cardInfo, `Expected comma cardInfo for Card ${cardIdx}`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                const expectedFormat = cardIdx === 2 ? 'standard' : 'comma';
                assert.equal(res.cardInfo.inputFormat, expectedFormat);
                assert.deepEqual(res.cardInfo.card.map(f => f.n), expectedFields[cardIdx - 1]);
            }
        });

        it('resolves all 3 cards in long format (+)', () => {
            const doc = fakeDoc(long.join('\n'));
            for (let cardIdx = 1; cardIdx <= 3; cardIdx++) {
                const res = resolve(doc, cardIdx);
                assert.ok(res?.cardInfo, `Expected long cardInfo for Card ${cardIdx}`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.inputFormat, 'long');
                assert.deepEqual(res.cardInfo.card.map(f => f.n), expectedFields[cardIdx - 1]);
            }
        });

        it('resolves all 3 cards in i10 format (%)', () => {
            const doc = fakeDoc(i10.join('\n'));
            for (let cardIdx = 1; cardIdx <= 3; cardIdx++) {
                const res = resolve(doc, cardIdx);
                assert.ok(res?.cardInfo, `Expected i10 cardInfo for Card ${cardIdx}`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.inputFormat, 'i10');
                assert.deepEqual(res.cardInfo.card.map(f => f.n), expectedFields[cardIdx - 1]);
            }
        });
    });

    describe('Keyword: *COSIM_FMI_CONTROL (input-form-2705, 2 cards)', () => {
        const text = [
            '*COSIM_FMI_CONTROL',
            '         1         0         0         1',
            'PARAM_SETTING_STRING'
        ];

        it('resolves 2 cards in standard format', () => {
            const doc = fakeDoc(text.join('\n'));
            const c1 = resolve(doc, 1);
            assert.equal(c1?.cardInfo?.resolutionSource, 'native-file-reader');
            assert.deepEqual(c1.cardInfo.card.map(f => f.n), ['APPID', 'OPT', 'MODE', 'FMI']);

            const c2 = resolve(doc, 2);
            assert.equal(c2?.cardInfo?.resolutionSource, 'native-file-reader');
            assert.deepEqual(c2.cardInfo.card.map(f => f.n), ['SETTING']);
        });
    });

    describe('Keyword: *FATIGUE (input-form-2645, 4 cards)', () => {
        const text = [
            '*FATIGUE',
            '         1         0',
            '       0.1',
            '         1         0         0       0.0       0.0',
            'results_fatigue.dat'
        ];

        it('resolves all 4 cards in standard format', () => {
            const doc = fakeDoc(text.join('\n'));
            const c1 = resolve(doc, 1);
            assert.equal(c1?.cardInfo?.resolutionSource, 'native-file-reader');
            assert.deepEqual(c1.cardInfo.card.map(f => f.n), ['PID', 'PTYPE']);

            const c2 = resolve(doc, 2);
            assert.equal(c2?.cardInfo?.resolutionSource, 'native-file-reader');
            assert.deepEqual(c2.cardInfo.card.map(f => f.n), ['DT']);

            const c3 = resolve(doc, 3);
            assert.equal(c3?.cardInfo?.resolutionSource, 'native-file-reader');
            assert.deepEqual(c3.cardInfo.card.map(f => f.n), ['STRSN', 'INDEX', 'RESTRT', 'TEXPOS', 'DMGMIN']);

            const c4 = resolve(doc, 4);
            assert.equal(c4?.cardInfo?.resolutionSource, 'native-file-reader');
            assert.deepEqual(c4.cardInfo.card.map(f => f.n), ['FILENAME']);
        });
    });

    describe('Keyword: *FATIGUE_LOADSTEP (input-form-2643, 1 card)', () => {
        const text = [
            '*FATIGUE_LOADSTEP',
            '       0.0       1.0       0.0'
        ];

        it('resolves card 1 in standard format', () => {
            const doc = fakeDoc(text.join('\n'));
            const c1 = resolve(doc, 1);
            assert.equal(c1?.cardInfo?.resolutionSource, 'native-file-reader');
            assert.deepEqual(c1.cardInfo.card.map(f => f.n), ['TSTART', 'TEND', 'TEXPOS']);
        });
    });

    it('achieves 100.0% native closure across all 3 Category CASE registrations', function() {
        this.timeout(10000);
        const data = { registrations: require("../../fixtures/public-behavior/category-registration-keywords.json") };
        const regs = data.registrations.filter(r => r.category === 'CASE');
        assert.equal(regs.length, 3, 'Category CASE should have strictly 3 registrations');

        let resolved = 0;
        const failures = [];
        for (const reg of regs) {
            const kw = reg.name === 'CASE' ? 'CASE' : `CASE_${reg.name}`;
            const doc = fakeDoc(['*' + kw, '         1         2         3         4'].join('\n'));
            const res = resolve(doc, 1);
            if (res?.cardInfo?.resolutionSource === 'native-file-reader' || res?.reason === 'native-reader-has-no-data-fields') {
                resolved++;
            } else {
                failures.push({ kw, source: res?.cardInfo?.resolutionSource, reason: res?.reason });
            }
        }
        assert.equal(failures.length, 0, `Category CASE unresolved: ${JSON.stringify(failures)}`);
        assert.equal(resolved, 3, 'Category CASE closure is not 100%');
    });

    it('achieves 100.0% native closure across all 4 Category COSIM registrations', function() {
        this.timeout(10000);
        const data = { registrations: require("../../fixtures/public-behavior/category-registration-keywords.json") };
        const regs = data.registrations.filter(r => r.category === 'COSIM');
        assert.equal(regs.length, 4, 'Category COSIM should have strictly 4 registrations');

        let resolved = 0;
        const failures = [];
        for (const reg of regs) {
            const kw = reg.name.startsWith('COSIM') ? reg.name : `COSIM_${reg.name}`;
            const doc = fakeDoc(['*' + kw, '         1         2         3         4'].join('\n'));
            const res = resolve(doc, 1);
            if (res?.cardInfo?.resolutionSource === 'native-file-reader') {
                resolved++;
            } else {
                failures.push({ kw, source: res?.cardInfo?.resolutionSource, reason: res?.reason });
            }
        }
        assert.equal(failures.length, 0, `Category COSIM unresolved: ${JSON.stringify(failures)}`);
        assert.equal(resolved, 4, 'Category COSIM closure is not 100%');
    });

    it('achieves 100.0% native closure across all 10 Category FATIGUE registrations', function() {
        this.timeout(10000);
        const data = { registrations: require("../../fixtures/public-behavior/category-registration-keywords.json") };
        const regs = data.registrations.filter(r => r.category === 'FATIGUE');
        assert.equal(regs.length, 10, 'Category FATIGUE should have strictly 10 registrations');

        let resolved = 0;
        const failures = [];
        for (const reg of regs) {
            const kw = reg.name === 'FATIGUE' ? 'FATIGUE' : (reg.name.startsWith('FATIGUE') ? reg.name : `FATIGUE_${reg.name}`);
            const doc = fakeDoc(['*' + kw, '         1         2         3         4'].join('\n'));
            const res = resolve(doc, 1);
            if (res?.cardInfo?.resolutionSource === 'native-file-reader' || res?.reason === 'native-reader-has-no-data-fields') {
                resolved++;
            } else {
                failures.push({ kw, source: res?.cardInfo?.resolutionSource, reason: res?.reason });
            }
        }
        assert.equal(failures.length, 0, `Category FATIGUE unresolved: ${JSON.stringify(failures)}`);
        assert.equal(resolved, 10, 'Category FATIGUE closure is not 100%');
    });
});
