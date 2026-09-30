'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { fakeDoc } = require('./helpers');
const { getCardInfoForDocumentLineWithSuggest: resolve } = require('../out/extension')._internals;

describe('Category DEFORMABLE and CHANGE Native Reader Closure', () => {
    describe('Keyword: *DEFORMABLE_TO_RIGID_AUTOMATIC', () => {
        const standard = [
            '*DEFORMABLE_TO_RIGID_AUTOMATIC',
            '         1         1       0.0       0.0       0.0       0.0         0         0',
            '         0         0       0.0       0.0         0         0       0.0',
            '         1         0         0',
            '         1         0'
        ];

        const comma = [
            '*DEFORMABLE_TO_RIGID_AUTOMATIC',
            '1,1,0.0,0.0,0.0,0.0,0,0',
            '0,0,0.0,0.0,0,0,0.0',
            '1,0,0',
            '1,0'
        ];

        const long = [
            '*DEFORMABLE_TO_RIGID_AUTOMATIC+',
            '                   1                   1                 0.0                 0.0                 0.0                 0.0                   0                   0',
            '                   0                   0                 0.0                 0.0                   0                   0                 0.0',
            '                   1                   0                   0',
            '                   1                   0'
        ];

        const i10 = [
            '*DEFORMABLE_TO_RIGID_AUTOMATIC%',
            '         1         1       0.0       0.0       0.0       0.0         0         0',
            '         0         0       0.0       0.0         0         0       0.0',
            '         1         0         0',
            '         1         0'
        ];

        const expectedCards = [
            ['SWSET', 'CODE', 'TIME1', 'TIME2', 'TIME3', 'ENTNO', 'RELSW', 'PAIRED'],
            ['NRBF', 'NCSF', 'RWF', 'DTMAX', 'D2R', 'R2D', 'OFFSET'],
            ['PID', 'LRB', 'PTYPE'],
            ['PID', 'PTYPE']
        ];

        it('resolves all 4 cards in standard format with exact field schemas', () => {
            const doc = fakeDoc(standard.join('\n'));
            for (let cardIdx = 1; cardIdx <= 4; cardIdx++) {
                const res = resolve(doc, cardIdx);
                assert.ok(res?.cardInfo, `Expected cardInfo for Card ${cardIdx}`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.nativeCardIndex, cardIdx);
                assert.deepEqual(res.cardInfo.card.map(f => f.n), expectedCards[cardIdx - 1]);
                assert.equal(res.cardInfo.approvedStaticRecord, undefined);
            }
        });

        it('resolves all 4 cards in comma format', () => {
            const doc = fakeDoc(comma.join('\n'));
            for (let cardIdx = 1; cardIdx <= 4; cardIdx++) {
                const res = resolve(doc, cardIdx);
                assert.ok(res?.cardInfo, `Expected comma cardInfo for Card ${cardIdx}`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.inputFormat, 'comma');
                assert.deepEqual(res.cardInfo.card.map(f => f.n), expectedCards[cardIdx - 1]);
            }
        });

        it('resolves all 4 cards in long format (+)', () => {
            const doc = fakeDoc(long.join('\n'));
            for (let cardIdx = 1; cardIdx <= 4; cardIdx++) {
                const res = resolve(doc, cardIdx);
                assert.ok(res?.cardInfo, `Expected long cardInfo for Card ${cardIdx}`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.inputFormat, 'long');
                assert.deepEqual(res.cardInfo.card.map(f => f.n), expectedCards[cardIdx - 1]);
            }
        });

        it('resolves all 4 cards in i10 format (%)', () => {
            const doc = fakeDoc(i10.join('\n'));
            for (let cardIdx = 1; cardIdx <= 4; cardIdx++) {
                const res = resolve(doc, cardIdx);
                assert.ok(res?.cardInfo, `Expected i10 cardInfo for Card ${cardIdx}`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.inputFormat, 'i10');
                assert.deepEqual(res.cardInfo.card.map(f => f.n), expectedCards[cardIdx - 1]);
            }
        });
    });

    it('achieves 100.0% native closure across all 3 Category DEFORMABLE registrations', function() {
        const data = { registrations: require('./fixtures/public-behavior/category-registration-keywords.json') };
        const regs = data.registrations.filter(r => r.category === 'DEFORMABLE');
        assert.equal(regs.length, 3, 'Category DEFORMABLE should have strictly 3 registrations');

        let resolved = 0;
        const failures = [];
        for (const reg of regs) {
            const kw = reg.name.startsWith('DEFORMABLE') ? reg.name : 'DEFORMABLE_' + reg.name;
            const doc = fakeDoc(['*' + kw, '         1         2         3         4'].join('\n'));
            const res = resolve(doc, 1);
            if (res?.cardInfo?.resolutionSource === 'native-file-reader') {
                resolved++;
            } else {
                failures.push({ kw, source: res?.cardInfo?.resolutionSource });
            }
        }
        assert.equal(failures.length, 0, `Category DEFORMABLE had unresolved keywords: ${JSON.stringify(failures)}`);
        assert.equal(resolved, 3, 'Category DEFORMABLE closure is not 100%');
    });

    it('achieves 100.0% native closure across all 18 Category CHANGE registrations', function() {
        const data = { registrations: require('./fixtures/public-behavior/category-registration-keywords.json') };
        const regs = data.registrations.filter(r => r.category === 'CHANGE');
        assert.equal(regs.length, 18, 'Category CHANGE should have strictly 18 registrations');

        let resolved = 0;
        const failures = [];
        for (const reg of regs) {
            const kw = reg.name.startsWith('CHANGE') ? reg.name : 'CHANGE_' + reg.name;
            const doc = fakeDoc(['*' + kw, '         1         2         3         4'].join('\n'));
            const res = resolve(doc, 1);
            if (res?.cardInfo?.resolutionSource === 'native-file-reader' || res?.reason === 'native-reader-has-no-data-fields') {
                resolved++;
            } else {
                failures.push({ kw, source: res?.cardInfo?.resolutionSource, reason: res?.reason });
            }
        }
        assert.equal(failures.length, 0, `Category CHANGE had unresolved keywords: ${JSON.stringify(failures)}`);
        assert.equal(resolved, 18, 'Category CHANGE closure is not 100%');
    });

    it('achieves 100.0% native closure across all 3 Category STRESS registrations', function() {
        const data = { registrations: require('./fixtures/public-behavior/category-registration-keywords.json') };
        const regs = data.registrations.filter(r => r.category === 'STRESS');
        assert.equal(regs.length, 3, 'Category STRESS should have strictly 3 registrations');

        let resolved = 0;
        const failures = [];
        for (const reg of regs) {
            const kw = reg.name.startsWith('STRESS') ? reg.name : 'STRESS_' + reg.name;
            const doc = fakeDoc(['*' + kw, '         1         2         3         4'].join('\n'));
            const res = resolve(doc, 1);
            if (res?.cardInfo?.resolutionSource === 'native-file-reader' || res?.reason === 'native-reader-has-no-data-fields') {
                resolved++;
            } else {
                failures.push({ kw, source: res?.cardInfo?.resolutionSource, reason: res?.reason });
            }
        }
        assert.equal(failures.length, 0, `Category STRESS had unresolved keywords: ${JSON.stringify(failures)}`);
        assert.equal(resolved, 3, 'Category STRESS closure is not 100%');
    });
});
