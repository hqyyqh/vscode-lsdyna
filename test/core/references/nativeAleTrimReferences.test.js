'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { trackTempDirectories } = require('../../support/tempDirectories');
const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
const { queryIndexedEntityId } = require('../../../src/core/references/indexedEntityQuery');

describe('native ALE trim option-specific references', function () {
    this.timeout(30000);
    const tempDirectory = trackTempDirectories();
    const options = ['PARTSET', 'SEGSET', 'PLANE', 'CYLINDER', 'BOXCOR', 'BOXCPT', 'SPHERE'];
    async function fixture(format, maxReferenceBlockBytes, selectedOptions = options) {
        const root = tempDirectory(path.join(os.tmpdir(), 'dynasense-ale-trim-'));
        const file = path.join(root, 'main.k');
        const row = values => format === 'comma' ? values.join(',') :
            values.map(value => String(value).padStart(format === 'long' ? 20 : 10)).join('');
        const lines = ['*KEYWORD', '*PART', 'same-ID part', '        73', '*SET_PART_LIST', '        73', '         1',
            '*SET_SEGMENT', '        73', '         1         2         3         4',
            '*NODE', '      73' + [0, 0, 0].map(value => String(value).padStart(16)).join(''),
            '*DEFINE_BOX', '        73         0         1         0         1         0         1',
            '*ALE_STRUCTURED_MESH_TRIM' + (format === 'long' ? ' +' : format === 'i10' ? ' %' : '')];
        const start = lines.length;
        for (const option of selectedOptions) for (let repeat = 0; repeat < 2; repeat++)
            lines.push(row([991, option, 0, 0, 73, 74, 0, 0]));
        lines.push('*END'); fs.writeFileSync(file, lines.join('\n'));
        const fileIndex = await buildFileIndex(file, { maxReferenceBlockBytes });
        return { start, snapshot: { rootFile: file, files: [file], fileIndexes: new Map([[file, fileIndex]]),
            graph: { includeOccurrences: [], includeOccurrencesComplete: true } } };
    }
    it('selects each repeated native pool and recovers it beyond the preview without same-ID cross-type matches', async () => {
        // The actual pre-read selector and field reads were observed for two
        // records per option, in standard/comma/I10 (ale-trim-options-native-2).
        for (const format of ['standard', 'comma', 'i10']) for (const maxReferenceBlockBytes of [4096, 1]) {
            const value = await fixture(format, maxReferenceBlockBytes);
            for (const [kind, expected] of [['part-set', [['PSID', 0], ['PSID', 1]]],
                ['segment-set', [['SEGSID', 2], ['SEGSID', 3]]],
                ['node', [['NID1', 4], ['NID1', 5], ['NID1', 6], ['NID1', 7], ['NID', 12], ['NID', 13]]],
                ['box', [['BOXID', 8], ['BOXID', 9], ['BOXID', 10], ['BOXID', 11]]]]) {
                const result = await queryIndexedEntityId({ snapshot: value.snapshot, id: 73, targetKind: kind });
                assert.deepEqual(result.locations.filter(item => item.role === 'reference' &&
                    item.keyword === '*ALE_STRUCTURED_MESH_TRIM').map(item => [item.fieldName, item.line - value.start]),
                    expected, JSON.stringify({format, maxReferenceBlockBytes, kind, reasons:result.reasons}));
            }
        }
    });
    it('keeps unrecognized native pre-read options incomplete instead of applying the PARTSET pool', async () => {
        for (const [format, selectedOptions] of [['standard', ['SLDSET']], ['long', ['SEGSET']]]) {
            const value = await fixture(format, 1, selectedOptions);
            const result = await queryIndexedEntityId({ snapshot: value.snapshot, id: 73, targetKind: 'part-set' });
            assert.equal(result.state, 'partial', JSON.stringify(result.reasons));
            assert.equal(result.locations.filter(item => item.role === 'reference' &&
                item.keyword === '*ALE_STRUCTURED_MESH_TRIM').length, 0);
            assert.ok(result.reasons.some(reason => /native-layout|scan-incomplete/.test(reason)), JSON.stringify(result.reasons));
        }
    });
});
