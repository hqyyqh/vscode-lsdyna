'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { trackTempDirectories } = require('../../support/tempDirectories');
const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
const { queryIndexedEntityId } = require('../../../src/core/references/indexedEntityQuery');

describe('user-adjudicated V4.14 EM_CONTROL_SOLUTION DIST non-reference', function () {
    this.timeout(30000);
    const tempDirectory = trackTempDirectories();
    it('removes only DIST references in every format and capped disk replay while retaining ANG and NID1', async () => {
        for (const format of ['standard', 'comma', 'long', 'i10']) for (const cap of [undefined, 1]) {
            const directory = tempDirectory(path.join(os.tmpdir(), 'dynasense-dist-decision-')), file = path.join(directory, 'main.k');
            const marker = format === 'long' ? ' +' : format === 'i10' ? ' %' : '';
            const row = values => format === 'comma' ? values.join(',') : values.map(value => String(value).padStart(format === 'long' ? 20 : 10)).join('');
            const lines = ['*KEYWORD'];
            const expected = [];
            for (const dist of [73, -73, 0, 1.5, '&DIST']) {
                lines.push('*EM_CONTROL_SOLUTION' + marker, row([5000, 5000, 0, 1, 0, 0, 0, 0]));
                expected.push(lines.length); lines.push(row([73, 0, 0, 0, 0, 0, -73, dist]));
            }
            lines.push('*END'); fs.writeFileSync(file, lines.join('\n'));
            const snapshot = { rootFile: file, files: [file], fileIndexes: new Map([[file, await buildFileIndex(file, { maxReferenceBlockBytes: cap })]]),
                graph: { includeOccurrencesComplete: true, includeOccurrences: [] } };
            for (const [targetKind, fieldName] of [['node', 'NID1'], ['curve', 'ANG']]) {
                const result = await queryIndexedEntityId({ snapshot, id: 73, targetKind });
                assert.equal(result.state, 'complete', JSON.stringify({ format, cap, targetKind, reasons: result.reasons }));
                assert.deepEqual(result.locations.filter(item => item.role === 'reference').map(item => [item.fieldName, item.line]),
                    expected.map(line => [fieldName, line]));
            }
        }
    });
});
