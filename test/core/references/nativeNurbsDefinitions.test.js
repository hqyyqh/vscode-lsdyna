'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { trackTempDirectories } = require('../../support/tempDirectories');
const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
const { queryIndexedEntityId } = require('../../../src/core/references/indexedEntityQuery');

describe('source-bound native NURBS patch definitions', function () {
    this.timeout(30000);
    const tempDirectory = trackTempDirectories();
    it('retains all six exact selectors through runtime generation and query in four formats', async () => {
        // Native stores use namespace146 and the first integer of the patch
        // header. TITLE consumes a separate physical record before that header.
        for (const format of ['standard', 'comma', 'long', 'i10']) {
            const root = tempDirectory(path.join(os.tmpdir(), 'dynasense-nurbs-definitions-'));
            const file = path.join(root, 'main.k');
            const lines = ['*KEYWORD'], expected = [];
            for (const base of ['ELEMENT_NURBS_PATCH_2D_TRIMMED', 'ELEMENT_SHELL_NURBS_PATCH',
                'ELEMENT_SHELL_NURBS_PATCH_TRIMMED']) for (const title of [false, true]) {
                const keyword = base + (title ? '_TITLE' : '');
                lines.push('*' + keyword + (format === 'long' ? ' +' : format === 'i10' ? ' %' : ''));
                if (title) lines.push('native patch title');
                expected.push([keyword, lines.length]);
                const values = [73, 1, 0, 0, 0, 0, 0, 0];
                lines.push(format === 'comma' ? values.join(',') :
                    values.map(value => String(value).padStart(format === 'long' ? 20 : 10)).join(''));
            }
            lines.push('*END'); fs.writeFileSync(file, lines.join('\n'));
            const fileIndex = await buildFileIndex(file);
            const snapshot = { rootFile: file, files: [file], fileIndexes: new Map([[file, fileIndex]]),
                graph: { includeOccurrences: [], includeOccurrencesComplete: true } };
            const result = await queryIndexedEntityId({ snapshot, id: 73, targetKind: 'nurbs-patch-2d-elem' });
            assert.deepEqual(result.locations.filter(item => item.role === 'definition')
                .map(item => [item.keyword.replace(/^\*/, ''), item.line]), expected,
                JSON.stringify({format, reasons:result.reasons}));
        }
    });
});
