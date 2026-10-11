'use strict';

const assert = require('node:assert/strict');
const { selectReferenceTargetSearch } = require('../../../out/core/references/projectReferenceIndex');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildProjectIndex } = require('../../../out/core/project/projectIndexer');
const { buildProjectReferenceIndex } = require('../../../out/core/references/projectReferenceIndex');
const { scanOnDemandDefinitions } = require('../../../out/core/references/onDemandDefinitionScanner');
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
const { queryIndexedEntityId } = require('../../../out/core/references/indexedEntityQuery');
const { trackTempDirectories } = require('../../support/tempDirectories');

describe('native ordered target namespaces', () => {
    const tempDirectory = trackTempDirectories();
    const primary = { targetKinds: ['material'], targetKeywords: ['*MAT_ELASTIC'] };
    const alternate = { targetKinds: ['material'], targetKeywords: ['*MAT_ISPG_01'] };
    const definition = keyword => ({ id: 73, keyword: '*' + keyword, targetKeyword: keyword, targetKind: 'material' });

    function index(definitions) {
        return {
            completenessReasons: [],
            entityDefinitionsByKind: new Map([['material', new Map([[73, definitions]])]]),
            genericDefinitionsByKeyword: new Map(['MAT_ELASTIC', 'MAT_ISPG_01', 'MAT_OTHER'].map(keyword =>
                [keyword, new Map([[73, definitions.filter(value => value.targetKeyword === keyword)]])])),
            indexedTargetKinds: new Set(['material']),
            indexedTargetDefinitions: new Set(['MAT_ELASTIC', 'MAT_ISPG_01', 'MAT_OTHER']),
        };
    }

    it('searches exact keyword families before selecting a shared-kind fallback', () => {
        const elastic = definition('MAT_ELASTIC'), ispg = definition('MAT_ISPG_01'), other = definition('MAT_OTHER');
        for (const [definitions, expected] of [
            [[elastic, ispg, other], elastic], [[ispg, other], ispg], [[other], null],
        ]) {
            const result = selectReferenceTargetSearch(index(definitions), 73, [primary, alternate]);
            assert.equal(result.ready, true);
            assert.deepEqual(result.definitions, expected ? [expected] : []);
            assert.equal(result.target, expected === elastic ? primary : expected === ispg ? alternate : null);
        }
    });

    it('keeps incomplete earlier namespaces unresolved instead of selecting the fallback', () => {
        const referenceIndex = index([definition('MAT_ISPG_01')]);
        referenceIndex.indexedTargetDefinitions.delete('MAT_ELASTIC');
        const result = selectReferenceTargetSearch(referenceIndex, 73, [primary, alternate]);
        assert.equal(result.ready, false);
        assert.equal(result.target, null);
        assert.ok(result.reasons.includes('lspp-target-priority-unresolved'));
    });

    it('does not let unrelated uncertainty in a shared kind block a fully searched keyword family', () => {
        const ispg = definition('MAT_ISPG_01'), referenceIndex = index([ispg]);
        referenceIndex.unresolvedEntityDefinitionsByKind = new Map([['material', [{
            keyword: '*MAT_OTHER', uncertaintyReasons: ['unrelated-material-expression'],
        }]]]);
        const result = selectReferenceTargetSearch(referenceIndex, 73, [primary, alternate]);
        assert.equal(result.ready, true);
        assert.deepEqual(result.definitions, [ispg]);
    });

    it('retains missing native definition authority even when a fallback exists', () => {
        const result = selectReferenceTargetSearch(index([definition('MAT_ISPG_01')]), 73,
            [{ ...primary, targetKeywords: [], targetDefinitionUnavailable: true }, alternate]);
        assert.equal(result.ready, false);
        assert.deepEqual(result.definitions, []);
    });

    it('resolves attached LONG definitions before assigning a same-ID curve/function fallback', async function () {
        this.timeout(10000);
        const root = tempDirectory(path.join(os.tmpdir(), 'lsdyna-native-long-priority-'));
        const filePath = path.join(root, 'priority.k');
        const row = values => values.map(value => String(value).padStart(20)).join('');
        for (const hasCurve of [true, false]) {
            fs.writeFileSync(filePath, ['*KEYWORD',
                ...(hasCurve ? ['*DEFINE_CURVE+', row([73]), row([0, 0])] : []),
                '*DEFINE_FUNCTION+', row([73]), 'f(t)=1', '*ALE_INJECTION+', row([0, 0, 0, 73]), '*END'].join('\n'));
            const fileIndex = await buildFileIndex(filePath);
            const snapshot = { scope: 'single-file', rootFile: filePath, files: [filePath],
                graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                fileIndexes: new Map([[filePath, fileIndex]]) };
            for (const kind of ['curve', 'function']) {
                const query = await queryIndexedEntityId({ snapshot, id: 73, targetKind: kind });
                const references = query.locations.filter(location => location.role === 'reference');
                assert.equal(references.length, kind === (hasCurve ? 'curve' : 'function') ? 1 : 0,
                    JSON.stringify({ hasCurve, kind, state: query.state, reasons: query.reasons, locations: query.locations }));
                assert.ok(query.locations.filter(location => location.role === 'definition')
                    .every(location => location.entityKind === kind));
            }
        }
    });

    it('streams repeated DUALCESE definitions using the actual native 8-column % contract', async function () {
        this.timeout(10000);
        const root = tempDirectory(path.join(os.tmpdir(), 'lsdyna-native-multi-'));
        for (const keyword of ['DUALCESE_ELE2D', 'DUALCESE_ELE3D']) {
            const descriptor = { target: keyword, targetKind: keyword.toLowerCase().replaceAll('_', '-'),
                fieldName: 'EID', fieldType: 'integer', fieldIndex: 0, position: 0, width: 8,
                recordMode: 'repeat-all-data-records', formatContracts: ['standard', 'i10', 'long'].map(format =>
                    ({ format, mode: 'fixed', position: 0, width: format === 'long' ? 20 : 8 })) };
            for (const format of ['standard', 'comma', 'long', 'i10']) {
                const file = path.join(root, `${keyword}-${format}.k`);
                const row = id => format === 'comma' ? `${id},1001,1,2,3,4` :
                    [id, 1001, 1, 2, 3, 4].map(value => String(value).padStart(format === 'long' ? 20 : 8)).join('');
                fs.writeFileSync(file, `*KEYWORD\n*${keyword}${format === 'long' ? ' +' : format === 'i10' ? ' %' : ''}\n${row(77)}\n${row(980012)}\n*END\n`);
                const snapshot = await buildProjectIndex(file);
                const result = await scanOnDemandDefinitions({ referenceIndex: buildProjectReferenceIndex(snapshot),
                    fileIndexes: snapshot.fileIndexes, effectiveId: 980012, targetKinds: [descriptor.targetKind],
                    definitionKeywords: { onDemand: { [keyword]: descriptor } } });
                assert.equal(result.state, 'complete', `${keyword}/${format}: ${result.reasons}`);
                assert.equal(result.definitions.length, 1);
                assert.equal(result.definitions[0].idLine, 3);
            }
        }
    });
});
