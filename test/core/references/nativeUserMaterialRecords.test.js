'use strict';
const assert = require('node:assert/strict');
const { selectNativeUserMaterialRecords } = require("../../../out/core/semantics/catalogNativeFileLayout");
const { nativeFordEnabled } = require('../../../out/core/semantics/nativeFeatureContext');

describe('native user material record boundaries', () => {
    it('matches the native environment parser without trimming or accepting prefixes', () => {
        for (const value of ['on', 'ON', 'oN', 'yes', 'YES', 'yEs']) assert.equal(nativeFordEnabled(value), true);
        for (const value of [undefined, '', '1', 'true', ' on', 'on ', 'yes\n', 'only', 'yesplease'])
            assert.equal(nativeFordEnabled(value), false, String(value));
    });
    function select({ mt = 41, ortho = 0, lmc = 9, lmca = 9, ford, length = 13 }) {
        const heads = [[73, 1, mt, lmc, 0, ortho, 0, 0], [0, 0, 0, 0, 0, lmca, 0, 0]];
        return selectNativeUserMaterialRecords(Array(length).fill('record'),
            (row, _card, field) => String(heads[row]?.[field] ?? 0), undefined, ford);
    }
    const cards = result => result.current.map(record => record.cardIndex);

    it('uses axes only for IORTHO 1 or 3 and repeats each actual constants card', () => {
        for (const ortho of [0, 1, 2, 3]) {
            const axes = [1, 3].includes(ortho) ? [3, 4] : [];
            const expected = [1, 2, ...axes, 5, 5, 6, 6];
            assert.deepEqual(cards(select({ ortho, length: expected.length })), expected);
            assert.deepEqual(select({ ortho }).unknownCardIndexes, []);
        }
    });

    it('keeps MT48 feature branches separate and never guesses from extra rows', () => {
        assert.deepEqual(cards(select({ mt: 48, ortho: 1, ford: true, length: 9 })),
            [1, 2, 3, 4, 7, 8, 9, 10, 11]);
        assert.deepEqual(cards(select({ mt: 48, ortho: 1, ford: false, length: 9 })),
            [1, 2, 3, 4, 5, 5, 6, 6, 0]);
        const unresolved = select({ mt: 48, ortho: 1, length: 9 });
        assert.deepEqual(cards(unresolved), [1, 2, 3, 4, 0, 0, 0, 0, 0]);
        assert.deepEqual(unresolved.unknownCardIndexes, [7, 8, 9, 10, 11]);
        assert.equal(unresolved.uncertainty, 'native-lspp-ford-feature-context-unavailable');
    });

    it('retains determined axes before unknown or truncated constant counts', () => {
        for (const value of ['&UNRESOLVED', 2147483648, 2147483647]) {
            const selected = select({ ortho: 3, lmc: value, length: 4 });
            assert.deepEqual(cards(selected), [1, 2, 3, 4]);
            assert.deepEqual(selected.unknownCardIndexes, []);
        }
        const short = select({ ortho: 1, length: 3 });
        assert.deepEqual(cards(short), [1, 2, 3]);
        assert.deepEqual(short.unknownCardIndexes, [4]);
        const unresolved = select({ ortho: '&ORTHO', length: 8 });
        assert.deepEqual(cards(unresolved), [1, 2, 0, 0, 0, 0, 0, 0]);
        assert.ok(unresolved.unknownCardIndexes.includes(3));
    });

    it('uses the actual native header geometry for both spellings in all requested formats', async () => {
        const { scanRegistryReferenceOccurrencesFromFileIndex } = require('../../../out/core/references/registryReferenceScanner');
        const { nativeFordFeatureEnabled } = require('../../../out/core/semantics/nativeFeatureContext');
        for (const keyword of ['MAT_USER_DEFINED_MATERIAL_MODELS', 'MAT_041_050'])
            for (const mode of ['standard', 'comma', 'long', 'i10']) for (const mt of [41, 48]) {
                const row = values => mode === 'comma' ? values.join(',') : values.map(value =>
                    String(value).padStart(mode === 'long' ? 20 : 10)).join('');
                const lines = ['*' + keyword + (mode === 'long' ? '+' : mode === 'i10' ? '%' : ''),
                    row([970001, 1, mt, 0, 0, 1, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, 0]),
                    row([-73, 0, 0, 0, 0, 0, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, 0]),
                    row([0, 0, 0, 0, 0, 0, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, 0]),
                    row([83, 0, 0, 0, 0, 0, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, 0])];
                const block = { keyword: '*' + keyword, rawKeyword: lines[0], startLine: 0,
                    endLine: lines.length - 1, filePath: '/fixture/user-material.k' };
                const result = await scanRegistryReferenceOccurrencesFromFileIndex({ keywordBlocks: [block] }, async () => lines.join('\n'));
                const references = result.referenceOccurrences.map(item => [item.fieldName, item.referenceValue.id, item.lineIndex]);
                assert.deepEqual(references, [['AOPT', 73, 3],
                    ...(mt === 48 && nativeFordFeatureEnabled ? [['PL_HARDE', 83, 7]] : [])], `${keyword}/${mode}/${mt}`);
                assert.equal(result.complete, true, JSON.stringify(result.reasons));
            }
    });
});
