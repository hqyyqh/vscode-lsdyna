'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
const { queryIndexedEntityId } = require('../../../out/core/references/indexedEntityQuery');
const { trackTempDirectories } = require('../../support/tempDirectories');

describe('native NURBS contact reference branches', () => {
    const tempDirectory = trackTempDirectories();
    const keywords = ['CONTACT_NURBS_TIED_EDGE_TO_EDGE', 'CONTACT_NURBS_TIED_EDGE_TO_SURFACE',
        'CONTACT_NURBS_TIED_NODES_TO_SURFACE'];
    function render(values, format) {
        return format === 'comma' ? values.join(',') : values.map(value =>
            String(value).padStart(format === 'long' ? 20 : 10)).join('');
    }
    async function query(lines, targetKind, label, maxReferenceBlockBytes) {
        const root = tempDirectory(path.join(os.tmpdir(), 'lsdyna-native-nurbs-'));
        const file = path.join(root, `${label}.k`);
        fs.writeFileSync(file, lines.join('\n'));
        const fileIndex = await buildFileIndex(file, { maxReferenceBlockBytes });
        const snapshot = { scope: 'single-file', rootFile: file, files: [file],
            graph: { includeOccurrences: [], includeOccurrencesComplete: true },
            fileIndexes: new Map([[file, fileIndex]]) };
        return queryIndexedEntityId({ snapshot, id: 73, targetKind });
    }
    function definitions() {
        return ['*KEYWORD', '*PART', 'same ID part', render([73], 'standard'),
            '*SET_PART_LIST', render([73], 'standard'), render([73], 'standard'),
            '*SET_NODE_LIST', render([73], 'standard'), render([1], 'standard')];
    }

    it('resolves repeated SSID/MSID by the native controller while isolating same-ID namespaces in four formats', async function () {
        this.timeout(40000);
        for (const maxReferenceBlockBytes of [undefined, 1]) {
        for (const format of ['standard', 'comma', 'long', 'i10']) {
            const lines = definitions();
            const expectedLines = new Map([['part-set', []], ['part', []], ['node-set', []]]);
            for (const keyword of keywords) {
                expectedLines.get('part-set').push(lines.length + 1);
                expectedLines.get('part').push(lines.length + 2);
                lines.push('*' + keyword + (format === 'long' ? ' +' : format === 'i10' ? ' %' : ''),
                    render([73, 73, 2, 2, 1], format), render([73, 73, 3, 3, 1], format));
            }
            expectedLines.get('node-set').push(lines.length + 1);
            lines.push('*CONTACT_NURBS_TIED_NODES_TO_SURFACE' +
                (format === 'long' ? ' +' : format === 'i10' ? ' %' : ''), render([73, 73, 4, 4, 1], format), '*END');
            for (const [kind, count] of [['part-set', 6], ['part', 6], ['node-set', 2]]) {
                const result = await query(lines, kind, `${format}-${kind}`, maxReferenceBlockBytes);
                const references = result.locations.filter(location => location.role === 'reference' &&
                    location.keyword.startsWith('*CONTACT_NURBS_TIED_'));
                assert.equal(references.length, count, JSON.stringify({ format, kind,
                    state: result.state, reasons: result.reasons, references }));
                assert.deepEqual(references.map(location => location.line).sort((a, b) => a - b),
                    expectedLines.get(kind).flatMap(line => [line, line]));
                assert.ok(references.every(location => ['SSID', 'MSID'].includes(location.fieldName)));
                assert.ok(result.locations.filter(location => location.role === 'definition')
                    .every(location => location.entityKind === kind));
            }
        }
        }
    });

    it('resolves type0 through the original NPID definition namespace in four formats and disk fallback', async function () {
        this.timeout(30000);
        for (const maxReferenceBlockBytes of [undefined, 1]) for (const format of ['standard', 'comma', 'long', 'i10']) {
            const lines = [...definitions(), '*ELEMENT_SHELL_NURBS_PATCH', render([73, 1, 0, 0, 0, 0, 0, 0], 'standard')];
            const expected = [];
            for (const keyword of keywords) {
                expected.push(lines.length + 1);
                lines.push('*' + keyword + (format === 'long' ? ' +' : format === 'i10' ? ' %' : ''),
                    render([73, 73, 0, 0, 1], format));
            }
            lines.push('*END');
            const result = await query(lines, 'nurbs-patch-2d-elem', `${format}-patch`, maxReferenceBlockBytes);
            const references = result.locations.filter(location => location.role === 'reference' &&
                location.keyword.startsWith('*CONTACT_NURBS_TIED_'));
            assert.deepEqual(references.map(location => location.line).sort((a,b) => a-b),
                expected.flatMap(line => [line,line]), JSON.stringify({format,reasons:result.reasons,references}));
            assert.ok(result.locations.some(location => location.role === 'definition' &&
                location.keyword === '*ELEMENT_SHELL_NURBS_PATCH'));
            for (const kind of ['part','part-set','node-set']) {
                const other = await query(lines,kind,`${format}-patch-${kind}`,maxReferenceBlockBytes);
                assert.equal(other.locations.filter(location => location.role === 'reference' &&
                    location.keyword.startsWith('*CONTACT_NURBS_TIED_')).length,0);
            }
        }
    });

    it('retains unsupported EDGE type4 and parameter controllers without misclassifying the same ID', async function () {
        this.timeout(10000);
        for (const [keyword, controller] of [[keywords[1], 4], [keywords[2], '&TYPE']]) {
            const lines = [...definitions(), '*' + keyword, [73, 73, controller, controller, 1].join(','), '*END'];
            const result = await query(lines, 'part', `${keyword}-${controller === '&TYPE' ? 'parameter' : controller}`);
            assert.equal(result.state, 'partial');
            assert.equal(result.locations.filter(location => location.role === 'reference' &&
                location.keyword.startsWith('*CONTACT_NURBS_TIED_')).length, 0);
            assert.ok(result.reasons.some(reason => /conditional|indeterminate|parameter|native-help/.test(reason)),
                JSON.stringify(result.reasons));
        }
    });
});
