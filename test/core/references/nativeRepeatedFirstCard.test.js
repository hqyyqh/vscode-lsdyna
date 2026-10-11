'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { trackTempDirectories } = require('../../support/tempDirectories');
const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
const { queryIndexedEntityId } = require('../../../src/core/references/indexedEntityQuery');

describe('native repeated first-card file registrations', function () {
    this.timeout(60000);
    const tempDirectory = trackTempDirectories();
    it('reads conditional header IDs without reusing them for history or constant payload values', async () => {
        for (const mode of ['standard', 'comma', 'long', 'i10']) {
            const row = values => mode === 'comma' ? values.join(',') :
                values.map(value => String(value).padStart(mode === 'long' ? 20 : 10)).join('');
            for (const maxReferenceBlockBytes of [1024, 1]) {
                const root = tempDirectory(path.join(os.tmpdir(), 'dynasense-header-links-'));
                const file = path.join(root, 'main.k');
                const marker = mode === 'long' ? ' +' : mode === 'i10' ? ' %' : '';
                const lines = ['*KEYWORD', '*PART', 'same-ID part', '        73', '*SET_PART_LIST', '        73', '         1',
                    '*USER_GET_HISTORY' + marker, row([73, 0, 73, 1, 0]), row([73, 73, 73, 73, 73, 73, 73, 73]),
                    row([73, 73, 73, 73, 73, 73, 73, 73]), '*USER_NONLOCAL_SEARCH' + marker,
                    row([73, 73, 0, 1, 0, 0, 0, 0]), row([73, 73, 73, 73, 73]),
                    row([73, 73, 73, 73, 73, 73, 73, 73]), '*END'];
                fs.writeFileSync(file, lines.join('\n'));
                const fileIndex = await buildFileIndex(file, { maxReferenceBlockBytes });
                const snapshot = { rootFile: file, files: [file], fileIndexes: new Map([[file, fileIndex]]),
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true } };
                for (const [kind, expected] of [['part', [['SID', 8], ['ASID', 12]]],
                    ['part-set', [['TID', 8], ['SSID', 12]]]]) {
                    const query = await queryIndexedEntityId({ snapshot, id: 73, targetKind: kind });
                    assert.deepEqual(query.locations.filter(item => item.role === 'reference' &&
                        item.keyword.startsWith('*USER_')).map(item => [item.fieldName, item.line]), expected,
                        JSON.stringify({mode, maxReferenceBlockBytes, reasons:query.reasons}));
                }
            }
        }
    });
    it('reads the second physical record in all four formats and recovers it beyond the index preview', async () => {
        // Actual file dispatch repeats these pools; subsequent GUI registrations
        // for other keywords are not additional physical cards in this deck.
        for (const [keyword, kind, field, records] of [
            ['DATABASE_FREQUENCY_ASCII_ELOUT_SSD_SUBCASE', 'curve', 'LCFREQ', [[0, 0, 0, 0, 1], [0, 0, 0, 0, 73]]],
            ['DATABASE_FREQUENCY_ASCII_NODFOR_SSD_SUBCASE', 'curve', 'LCFREQ', [[0, 0, 0, 0, 1], [0, 0, 0, 0, 73]]],
            ['DATABASE_FREQUENCY_ASCII_NODOUT_SSD_SUBCASE', 'curve', 'LCFREQ', [[0, 0, 0, 0, 1], [0, 0, 0, 0, 73]]],
            ['USER_LOADING_SET', 'node-set', 'SID', [[1, 'FORCEN', 0, 0, 0, 0, 0, 0], [73, 'FORCEN', 0, 0, 0, 0, 0, 0]]],
        ]) for (const mode of ['standard', 'comma', 'long', 'i10']) {
            const row = values => mode === 'comma' ? values.join(',') :
                values.map(value => String(value).padStart(mode === 'long' ? 20 : 10)).join('');
            for (const maxReferenceBlockBytes of [1024, 1]) {
                const root = tempDirectory(path.join(os.tmpdir(), 'dynasense-native-repeat-'));
                const file = path.join(root, 'main.k');
                const lines = ['*KEYWORD', '*DEFINE_CURVE', '        73', '                   0                   0',
                    '*SET_NODE_LIST', '        73', '         1', '*SET_PART_LIST', '        73', '         1',
                    '*' + keyword + (mode === 'long' ? ' +' : mode === 'i10' ? ' %' : ''),
                    ...records.map(row), '*END'];
                fs.writeFileSync(file, lines.join('\n'));
                const fileIndex = await buildFileIndex(file, { maxReferenceBlockBytes });
                const snapshot = { rootFile: file, files: [file], fileIndexes: new Map([[file, fileIndex]]),
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true } };
                const query = await queryIndexedEntityId({ snapshot, id: 73, targetKind: kind });
                assert.deepEqual(query.locations.filter(item => item.role === 'reference' && item.keyword === '*' + keyword)
                    .map(item => [item.fieldName, item.line]), [[field, 12]],
                    JSON.stringify({keyword, mode, maxReferenceBlockBytes, reasons:query.reasons}));
            }
        }
    });
});
