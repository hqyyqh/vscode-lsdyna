'use strict';
const assert = require('node:assert/strict');
const schema = require('../../../out/core/keywordSchema');
const { getActionableFieldReferenceInfo, resolveReferenceValueSemantics } =
    require('../../../out/core/references/fieldReferenceClassifier');

function infoFor(keyword, name) {
    const lookup = schema.lookupKeywordSchema(keyword, schema.loadKeywordSchema(() => 'en'));
    for (const [offset, card] of schema.getRenderedCardsForLookup(lookup).entries()) {
        const field = card.find(item => item.n === name);
        if (field) return getActionableFieldReferenceInfo({ keyword, cardIndex: offset + 1, field });
    }
    throw new Error(`Missing field ${keyword}.${name}`);
}

describe('manual conditional reference role completion', () => {
    it('loads the complete runtime through the shared definition registry', () => {
        const status = require('../../../out/core/references/definitionRegistry').getDefinitionRegistryCatalog().status();
        assert.equal(status.ready, true, status.failureReason);
    });
    it('loads every reviewed non-reference branch without changing its reference targets', () => {
        const source = require('../../../keywords/sources/reference-roles/import-v1.json');
        const catalog = require('../../../out/core/semantics/manualSemanticCatalog').getManualSemanticCatalog();
        for (const record of source.records) {
            const rule = catalog.rulesForKeyword(record.keyword).find(rule => rule.ruleId === record.ruleId);
            assert.ok(rule, record.ruleId);
            const value = record.nonReferenceWhen.value + (record.nonReferenceWhen.op === 'gt' ? 1 : 0);
            assert.equal(resolveReferenceValueSemantics(rule.relation, value).state, 'non-reference', `${record.keyword}.${record.field}`);
            assert.equal(resolveReferenceValueSemantics(rule.relation, '&UNKNOWN').state, 'indeterminate', record.ruleId);
            assert.equal(resolveReferenceValueSemantics(rule.relation, -73).state, 'reference', record.ruleId);
            assert.equal(rule.relation.otherwise, 'unknown');
        }
        assert.equal(source.records.length, 97);
    });
    it('recognizes documented scalar values across material and control families', function () {
        this.timeout(10000);
        for (const [keyword, field, value] of [
            ['MAT_LOW_DENSITY_FOAM', 'DAMP', 0],
            ['MAT_BARLAT_YLD2000_TITLE', 'E', 7e10],
            ['MAT_BARLAT_YLD2000_TITLE', 'PR', 0.3],
            ['MAT_BARLAT_YLD2004', 'E', 7e10],
            ['MAT_HILL_3R_3D', 'EX', 7e10],
            ['CONTROL_IMPLICIT_AUTO', 'DTMAX', 0.01],
            ['CONTROL_IMPLICIT_SOLUTION', 'ISTIF', 2],
            ['CONTROL_IMPLICIT_SOLUTION', 'ISTIF', 10],
        ]) {
            const info = infoFor(keyword, field);
            assert.ok(info, `${keyword}.${field}`);
            assert.equal(resolveReferenceValueSemantics(info, value).state, 'non-reference', `${keyword}.${field}=${value}`);
            assert.equal(resolveReferenceValueSemantics(info, -73).state, 'reference', `${keyword}.${field}=-73`);
            assert.equal(resolveReferenceValueSemantics(info, '&UNKNOWN').state, 'indeterminate', `${keyword}.${field} unresolved`);
        }
    });

    it('retains the native layout gate when a supplemented field already has native coverage', () => {
        const keyword = 'MAT_LOW_DENSITY_VISCOUS_FOAM';
        const lookup = schema.lookupKeywordSchema(keyword, schema.loadKeywordSchema(() => 'en'));
        const field = schema.getRenderedCardsForLookup(lookup)[0].find(item => item.n === 'DAMP');
        const scanner = require('../../../out/core/references/registryReferenceScanner');
        const options = { keyword, cardIndex: 1, field };
        const native = scanner.lsppReferenceRecordsForKeyword(keyword).find(item => item.fieldName === 'DAMP');
        assert.equal(native.nativeLayout.kind, 'conditional-sequence');
        assert.equal(scanner.nativeReferenceCoversField(options), true);
        assert.equal(getActionableFieldReferenceInfo(options), null,
            'A schema field without the selected native descriptor cannot bypass the native read gate');
        assert.equal(resolveReferenceValueSemantics(native.relation, 0.1).state, 'non-reference');
        assert.equal(resolveReferenceValueSemantics(native.relation, -73).state, 'reference');
        assert.equal(resolveReferenceValueSemantics(native.relation, '&UNKNOWN').state, 'indeterminate');
    });

    it('retains zero when the documented reference branch includes zero', () => {
        const info = infoFor('MAT_BARLAT_YLD2000', 'E');
        assert.equal(resolveReferenceValueSemantics(info, 0).state, 'indeterminate');
        assert.equal(resolveReferenceValueSemantics(info, 0).reason, 'reference-id-transform-unsafe');
        assert.equal(resolveReferenceValueSemantics(infoFor('CONTROL_IMPLICIT_SOLUTION', 'ISTIF'), 0).state, 'indeterminate');
    });
});

describe('conditional roles through file scanning and entity queries', function () {
    this.timeout(60000);
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const directory = require('../../support/tempDirectories').trackTempDirectories();
    const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
    const { queryIndexedEntityId } = require('../../../out/core/references/indexedEntityQuery');
    for (const mode of ['standard', 'long', 'i10', 'comma']) {
        it(`keeps scalar, reference and unresolved roles distinct in ${mode} format`, async () => {
            const root = directory(path.join(os.tmpdir(), 'dynasense-reference-roles-'));
            const filePath = path.join(root, 'main.key');
            const row = values => mode === 'comma' ? values.join(',') :
                values.map(value => String(value).padStart(mode === 'long' ? 20 : 10)).join('');
            const header = mode === 'long' ? '*KEYWORD LONG=Y' : mode === 'i10' ? '*KEYWORD I10=Y' : '*KEYWORD';
            for (const [damp, count, partial] of [['0.0', 1, false], ['0.25', 1, false], ['-73', 2, false], ['&UNKNOWN', 1, true]]) {
                fs.writeFileSync(filePath, [header, '*DEFINE_CURVE', row([73, 0, 1, 1, 0, 0]), row([0, 0]), row([1, 1]),
                    '*MAT_LOW_DENSITY_FOAM', row([1, 1, 21, 73, 1, 1, 0, damp]), row([1, 0, 0, 0, 0, 20000, 0]), '*END'].join('\n'));
                const fileIndex = await buildFileIndex(filePath);
                const snapshot = { rootFile: filePath, scope: 'single-file', files: [filePath],
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true }, fileIndexes: new Map([[filePath, fileIndex]]) };
                const result = await queryIndexedEntityId({ snapshot, id: 73, targetKind: 'curve' });
                assert.equal(result.locations.filter(item => item.role === 'reference').length, count, `${mode} ${damp}`);
                assert.equal(result.state === 'partial', partial, `${mode} ${damp}: ${JSON.stringify(result.reasons)}`);
                const unrelated = await queryIndexedEntityId({ snapshot, id: 73, targetKind: 'material' });
                assert.notEqual(unrelated.state, 'partial', `${mode} ${damp}: unrelated material query`);
            }
        });
    }
});
