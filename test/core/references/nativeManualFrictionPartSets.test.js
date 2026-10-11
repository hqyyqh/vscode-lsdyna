'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { trackTempDirectories } = require('../../support/tempDirectories');
const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
const { queryIndexedEntityId } = require('../../../src/core/references/indexedEntityQuery');

describe('help-confirmed friction PART/PSET selectors', function () {
    this.timeout(30000);
    const tempDirectory = trackTempDirectories();
    it('selects each side independently for plain/TITLE, all formats and capped disk replay', async () => {
        for (const title of [false, true]) for (const format of ['standard', 'comma', 'long', 'i10']) for (const cap of [undefined, 1]) {
            const file = path.join(tempDirectory(path.join(os.tmpdir(), 'dynasense-friction-pset-')), 'main.k');
            const marker = format === 'long' ? ' +' : format === 'i10' ? ' %' : '';
            const row = values => format === 'comma' ? values.join(',') : values.map(value => String(value).padStart(format === 'long' ? 20 : 10)).join('');
            const lines = ['*KEYWORD'];
            const expected = { part: [], 'part-set': [] };
            for (const [left, right] of [['PSET', 'PART'], ['', 'PSET']]) {
                lines.push('*DEFINE_FRICTION' + (title ? '_TITLE' : '') + marker);
                if (title) lines.push('friction title');
                lines.push(row([1, 0, 0, 0, 0, 0])); const line = lines.length;
                lines.push(row([73, 73, 0, 0, 0, 0, left, right]));
                expected[left === 'PSET' ? 'part-set' : 'part'].push(['PID_I', line]);
                expected[right === 'PSET' ? 'part-set' : 'part'].push(['PID_J', line]);
            }
            lines.push('*END'); fs.writeFileSync(file, lines.join('\n'));
            const snapshot = { rootFile: file, files: [file], fileIndexes: new Map([[file, await buildFileIndex(file, { maxReferenceBlockBytes: cap })]]),
                graph: { includeOccurrencesComplete: true, includeOccurrences: [] } };
            for (const targetKind of ['part', 'part-set']) {
                const result = await queryIndexedEntityId({ snapshot, id: 73, targetKind });
                assert.equal(result.state, 'complete', JSON.stringify({ title, format, cap, targetKind, reasons: result.reasons }));
                assert.deepEqual(result.locations.filter(item => item.role === 'reference').map(item => [item.fieldName, item.line]), expected[targetKind]);
            }
        }
    });
});
