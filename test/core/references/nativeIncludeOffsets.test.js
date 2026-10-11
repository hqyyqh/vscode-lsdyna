'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { trackTempDirectories } = require('../../support/tempDirectories');
const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
const { buildProjectReferenceIndex, analyzeReference } = require('../../../src/core/references/projectReferenceIndex');
const { queryIndexedEntityId } = require('../../../src/core/references/indexedEntityQuery');

describe('native INCLUDE_TRANSFORM namespace offsets', function () {
    this.timeout(20000);
    const tempDirectory = trackTempDirectories();
    const row = (values, width = 10) => values.map(value => String(value).padStart(width)).join('');
    async function model(offsets) {
        const root = tempDirectory(path.join(os.tmpdir(), 'dynasense-typed-offset-'));
        const main = path.join(root, 'main.k'), child = path.join(root, 'child.k');
        fs.writeFileSync(main, '*KEYWORD\n*END\n');
        fs.writeFileSync(child, ['*KEYWORD', '*NODE', '      73' + row([0, 0, 0], 16),
            '*ELEMENT_BEAM', row([73, 73, 73, 73, 0, 0], 8), '*PART', 'offset-part', row([73, 73, 73, 0, 73]),
            '*SECTION_SHELL', row([73, 2]), row([1, 1, 1, 1]), '*HOURGLASS', row([73, 1]),
            '*CONTACT_AUTO_MOVE', row([73]), '*DEFINE_CONTACT_VOLUME', row([73]),
            '*MAT_ELASTIC', row([73, 1, 100, .3]), '*DEFINE_COORDINATE_SYSTEM', row([73, 0, 0, 0]), row([1, 0, 0, 0]),
            '*MAT_USER_DEFINED_MATERIAL_MODELS', row([970001, 1, 41, 0, 0, 1, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, 0]),
            row([-73, 0, 0, 0, 0, 0, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, 0]),
            '*SET_NODE_LIST', row([73]), row([73]), '*END'].join('\n'));
        const fileIndexes = new Map([[main, await buildFileIndex(main)], [child, await buildFileIndex(child)]]);
        const snapshot = { rootFile: main, files: [main, child], fileIndexes,
            graph: { includeOccurrencesComplete: true, includeOccurrences: [{ occurrenceId: 'root:1',
                fromFile: main, filePath: child, fileName: 'child.k', lineIndex: 1,
                transform: { offsets: Object.fromEntries(Object.entries(offsets).map(([key, value]) =>
                    [key, typeof value === 'number' ? { kind: 'numeric', value, raw: String(value) } : value])) } }] } };
        return { child, snapshot, referenceIndex: buildProjectReferenceIndex(snapshot) };
    }
    it('matches native read/save IDs for definitions, references and negative coordinate switches', async () => {
        // Oracle: pinned native read/save, typed-offset-native-corrected and
        // typed-offset-idroff-native. AOPT -73 becomes -773; SECID becomes 873.
        const value = await model({ idnoff: 100, ideoff: 200, idpoff: 300, idmoff: 400,
            idsoff: 500, idfoff: 600, iddoff: 700, idroff: 800 });
        for (const [kind, id, expectedReference] of [['node', 173, 'N1'], ['part', 373, 'PID'],
            ['material', 473, 'MID'], ['coordinate-system', 773, 'AOPT'], ['node-set', 573, null],
            ['section', 873, 'SECID'], ['hourglass', 873, 'HGID']]) {
            const query = await queryIndexedEntityId({ snapshot: value.snapshot, id, targetKind: kind });
            assert.ok(query.locations.some(item => item.role === 'definition'), kind + ':' + JSON.stringify(query.reasons));
            if (expectedReference) assert.ok(query.locations.some(item => item.role === 'reference' &&
                item.fieldName === expectedReference), kind + ':' + JSON.stringify({locations:query.locations, reasons:query.reasons,
                    references:value.referenceIndex.registryReferenceOccurrences.filter(item=>item.keyword==='*PART').map(item=>
                        ({field:item.fieldName,raw:item.referenceValue?.raw,kinds:item.targetKinds}))}));
            assert.ok(!query.reasons.includes('signed-switch-transform-unverified'));
        }
    });
    it('uses the exact definition keyword when one plugin kind combines distinct native namespaces', async () => {
        const value = await model({ iddoff: 700, idroff: 800 });
        for (const [keyword, id] of [['CONTACT_AUTO_MOVE', 873], ['DEFINE_CONTACT_VOLUME', 773]]) {
            const query = await queryIndexedEntityId({ snapshot: value.snapshot, id, targetKind: 'contact' });
            assert.deepEqual(query.locations.filter(item => item.role === 'definition').map(item => item.keyword),
                ['*' + keyword], JSON.stringify(query.reasons));
            const analysis = analyzeReference(value.referenceIndex, { kind: 'numeric', id: 73, raw: '73' },
                ['contact'], { documentPath: value.child, projectScoped: true, targetDefinitions: [keyword] });
            assert.equal(analysis.id, id);
            assert.equal(analysis.transformResolution.resolved, true, JSON.stringify(analysis.reasons));
        }
        const mixed = analyzeReference(value.referenceIndex, { kind: 'numeric', id: 73, raw: '73' },
            ['contact'], { documentPath: value.child, projectScoped: true });
        assert.equal(mixed.transformResolution.resolved, false);
        assert.ok(mixed.reasons.includes('transform-offset-unresolved'));
    });
    it('offsets the confirmed FRICTION ID and FD together without admitting SCALING', async () => {
        for (const cap of [undefined, 1]) {
            const directory = tempDirectory(path.join(os.tmpdir(), 'dynasense-friction-offset-'));
            const main = path.join(directory, 'main.k'), child = path.join(directory, 'friction.k');
            fs.writeFileSync(main, '*KEYWORD\n*INCLUDE_TRANSFORM\nfriction.k\n*END\n');
            fs.writeFileSync(child, ['*KEYWORD', '*DEFINE_FRICTION', '73,0,0,0,0,0', '0,0,0,0,0,0,0,0',
                '*DEFINE_FRICTION_TITLE', 'confirmed friction', '73,0,0,0,0,0', '0,0,0,0,0,0,0,0',
                '*DEFINE_FRICTION_SCALING', '73,0,0,0,0', '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
                '0,0,0,0,0,0,0,0', '-2,73,0,0,0,0,0,0', '0,0,0,0,0,0,0,0', '*END'].join('\n'));
            const snapshot = { rootFile: main, files: [main, child], fileIndexes: new Map(), graph: {
                includeOccurrencesComplete: true, includeOccurrences: [{ occurrenceId: 'friction:1', fromFile: main,
                    filePath: child, fileName: 'friction.k', keywordLine: 1, lineIndex: 2,
                    transform: { offsets: Object.fromEntries([['iddoff', 700], ['idfoff', 600], ['idroff', 800]]
                        .map(([key, value]) => [key, { kind: 'numeric', value, raw: String(value) }])) } }] } };
            for (const file of snapshot.files) snapshot.fileIndexes.set(file, await buildFileIndex(file,
                { maxReferenceBlockBytes: cap, maxDefinitionBlockBytes: cap }));
            const result = await queryIndexedEntityId({ snapshot, id: 773, targetKind: 'friction' });
            assert.equal(result.state, 'complete', JSON.stringify({ cap, reasons: result.reasons }));
            assert.deepEqual(result.locations.filter(row => row.role === 'definition').map(row => row.keyword),
                ['*DEFINE_FRICTION', '*DEFINE_FRICTION_TITLE']);
            assert.deepEqual(result.locations.filter(row => row.role === 'reference').map(row => [row.keyword, row.fieldName]),
                [['*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE', 'FD']]);
            const unshifted = await queryIndexedEntityId({ snapshot, id: 73, targetKind: 'friction' });
            assert.equal(unshifted.locations.length, 0);
        }
    });
    it('uses original EM namespaces for IDROFF while preserving signed curve offsets', async () => {
        for (const maxReferenceBlockBytes of [undefined, 1]) {
            const directory = tempDirectory(path.join(os.tmpdir(), 'dynasense-em-offset-'));
            const main = path.join(directory, 'main.k'), child = path.join(directory, 'em.k');
            fs.writeFileSync(main, '*KEYWORD\n*INCLUDE_TRANSFORM\nem.k\n*END\n');
            fs.writeFileSync(child, ['*KEYWORD', '*EM_ISOPOTENTIAL', '73,1,0,0', '*EM_RANDLES_MESHLESS',
                '73,0', ...Array(4).fill('0,0,0,0,0,0,0,0'), '*DEFINE_CURVE', '73', '0,0', '1,1',
                '*DEFINE_FUNCTION', '73', 'f(t)=1', '*EM_ISOPOTENTIAL_CONNECT', '1,5,73,73,0,73,0,0',
                '*EM_ISOPOTENTIAL_CONNECT', '2,2,73,73,0,-73,0,0', '*END'].join('\n'));
            const snapshot = { rootFile: main, files: [main, child], fileIndexes: new Map(), graph: {
                includeOccurrencesComplete: true, includeOccurrences: [{ occurrenceId: 'em:1', fromFile: main,
                    filePath: child, fileName: 'em.k', keywordLine: 1, lineIndex: 2,
                    transform: { offsets: { idroff: { kind: 'numeric', value: 800, raw: '800' },
                        idfoff: { kind: 'numeric', value: 600, raw: '600' } } } }] } };
            for (const file of snapshot.files) snapshot.fileIndexes.set(file, await buildFileIndex(file, { maxReferenceBlockBytes }));
            for (const [kind, id, fields] of [['em-isopot', 873, ['ISOID1', 'ISOID1', 'ISOID2', 'ISOID2']],
                ['em-randles-meshless', 873, ['LCID_RDLID']], ['function', 673, ['LCID_RDLID']], ['curve', 673, []]]) {
                const result = await queryIndexedEntityId({ snapshot, id, targetKind: kind });
                assert.ok(result.locations.some(row => row.role === 'definition'), kind + ':' + JSON.stringify(result.reasons));
                assert.deepEqual(result.locations.filter(row => row.role === 'reference' && row.keyword === '*EM_ISOPOTENTIAL_CONNECT')
                    .map(row => row.fieldName).sort(), fields.sort(), JSON.stringify({ kind, maxReferenceBlockBytes, reasons: result.reasons }));
            }
        }
    });
    it('does not apply a curve offset to coordinates or let an unrelated unknown offset hide a node', async () => {
        const value = await model({ idfoff: 100, idmoff: { kind: 'parameter', name: 'UNKNOWN', raw: '&UNKNOWN' } });
        const coordinate = analyzeReference(value.referenceIndex,
            { kind: 'numeric', id: 73, raw: '-73', isSignedSwitch: true }, ['coordinate-system'],
            { documentPath: value.child, projectScoped: true });
        assert.equal(coordinate.state, 'exact', JSON.stringify({reasons:coordinate.reasons,
            transform:coordinate.transformResolution, definitions:coordinate.definitions.map(item=>
                ({id:item.id,kind:item.targetKind,reasons:item.uncertaintyReasons}))}));
        assert.equal(coordinate.id, 73);
        const node = analyzeReference(value.referenceIndex, { kind: 'numeric', id: 73, raw: '73' }, ['node'],
            { documentPath: value.child, projectScoped: true });
        assert.equal(node.transformResolution.resolved, true);
        assert.equal(node.id, 73);
        assert.ok(!node.reasons?.includes('transform-offset-unresolved'));
        const material = analyzeReference(value.referenceIndex, { kind: 'numeric', id: 73, raw: '73' }, ['material'],
            { documentPath: value.child, projectScoped: true });
        assert.equal(material.state, 'uncertain');
        assert.ok(material.reasons.includes('transform-offset-unresolved'));
    });
});
