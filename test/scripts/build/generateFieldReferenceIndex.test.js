'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildIndex, writeBlockedRuntime } = require("../../../scripts/build/generate-field-reference-index.cjs");

function definitionRule(keyword, field, relation = { targetKeywords: [keyword] }, selector = undefined) {
    return {
        ruleId: `rule:${keyword}:${field}`,
        keyword,
        field,
        kind: 'entity-definition',
        relation: { kind: 'entity-definition', ...relation },
        evidence: [{ evidenceId: `evidence:${keyword}:${field}` }],
        ...(selector ? { selector } : {}),
    };
}

describe('generate field reference index', () => {
    it('retains a native namespace and file selector when an older semantic descriptor omits its kind', () => {
        const schema = { TARGET: { c: [[{ n: 'ID', t: 'integer', p: 0, w: 10 }]] } };
        const native = { cardIndex: 1, fieldIndex: 0, fieldName: 'ID', fieldType: 'integer', position: 0, width: 10,
            target: 'TARGET', targetKind: 'contact', source: "keyword-catalog", nativeFieldAddress: "record:3c11134d2da44eeb1b070a21:3155a0bf34cca793adb2c3f8",
            recordMode: 'exact-data-record-ordinal', dataRecordOrdinal: 0 };
        const semantic = definitionRule('*TARGET', 'ID');
        const descriptor = buildIndex(schema, [semantic], {},
            { definitions: { TARGET: native }, references: {}, blocked: [] }).definitionKeywords.generic.TARGET;
        assert.equal(descriptor.targetKind, 'contact');
        assert.equal(descriptor.recordMode, native.recordMode);
        assert.equal(descriptor.nativeFieldAddress, native.nativeFieldAddress);
        assert.equal(descriptor.ruleId, semantic.ruleId);
        assert.deepEqual(descriptor.evidenceIds, semantic.evidence.map(item => item.evidenceId));
    });
    it('retains a source-bound native spelling absent from the editor schema, with all four format contracts', () => {
        const descriptor = { source: "keyword-catalog", fieldType: 'integer', fieldName: 'NPID', targetKind: 'nurbs-patch-2d-elem',
            fieldIndex: 0, cardIndex: 2, dataRecordOrdinal: 1, recordMode: 'exact-data-record-ordinal',
            position: 0, width: 10, nativeMapAddress: "record:833ab7287ce50c4404e8d545:07e24354ef44e1e6fdc94d70", nativeCardArrayAddress: "record:1786cdc8dc093e114e364515:9ab1ea87ddf26f632235bc25",
            nativeFieldAddress: "record:1786cdc8dc093e114e364515:38c92ddff601490d040525aa", selectorRuleId: 'native-store-selector', selectorEvidenceIds: ['native-store:146'],
            formatContracts: [{ format: 'standard', mode: 'fixed', position: 0, width: 10 },
                { format: 'long', mode: 'fixed', position: 0, width: 20 },
                { format: 'i10', mode: 'fixed', position: 0, width: 10 },
                { format: 'comma', mode: 'comma', fieldIndex: 0 }] };
        const source = { datasetSha256: "fc75cfb733be68b314152dc5a77e0a9a3c469444c917fc0f6adb004117d930f0" };
        const read = value => buildIndex({}, [], {}, { source, definitions: { NATIVE_TITLE: value }, references: {}, blocked: [] })
            .definitionKeywords.generic.NATIVE_TITLE;
        assert.deepEqual(read(descriptor), descriptor);
        for (const key of ['nativeMapAddress', 'nativeCardArrayAddress', 'nativeFieldAddress']) {
            assert.equal(read({ ...descriptor, [key]: 'invalid-identity' }), undefined);
        }
        assert.equal(read({ ...descriptor, nativeFieldAddress: undefined }), undefined);
        assert.equal(read({ ...descriptor, formatContracts: descriptor.formatContracts.slice(1) }), undefined);
        assert.equal(read({ ...descriptor, dataRecordOrdinal: 0 }), undefined);
    });
    it('does not relocate an LS-PrePost definition to another card or same-name field', () => {
        const schema = { TARGET: { c: [[{ n: 'ID', t: 'integer', p: 0, w: 10 }],
            [{ n: 'ID', t: 'integer', p: 20, w: 10 }]] } };
        const descriptor = { cardIndex: 2, fieldIndex: 0, fieldName: 'ID', fieldType: 'integer',
            position: 20, width: 10, targetKind: 'fixture', source: "keyword-catalog" };
        const handoff = { definitions: { TARGET: descriptor }, references: {}, blocked: [] };
        assert.equal(buildIndex(schema, [], {}, handoff).definitionKeywords.generic.TARGET.position, 20);
        descriptor.cardIndex = 1;
        assert.equal(buildIndex(schema, [], {}, handoff).definitionKeywords.generic.TARGET, undefined);
    });

    it('records the published blocker path when staging outside the repository', () => {
        const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lspp-blockers-')), 'runtime.gz');
        try {
            assert.equal(writeBlockedRuntime({}, output).file,
                "keywords/runtime/references/lspp_reference_blockers.runtime.json.gz");
        } finally {
            fs.rmSync(path.dirname(output), { recursive: true, force: true });
        }
    });

    it('builds definition layouts only from official semantic rules and expands TITLE aliases', () => {
        const index = buildIndex({
            DEFINE_CPG_GAS_PROPERTIES: {
                c: [[{ n: 'ID', p: 0, w: 10, t: 'integer' }]],
                o: [{
                    n: 'TITLE',
                    co: 'pre/1',
                    to: 1,
                    c: [[{ n: 'TITLE', p: 0, w: 80, t: 'string' }]],
                }],
            },
            DEFINE_CPG_GAS_PROPERTIES_TITLE: {
                x: 'DEFINE_CPG_GAS_PROPERTIES',
                active: ['TITLE'],
                c: [[{ n: 'ID', p: 0, w: 10, t: 'integer' }]],
            },
            AIRBAG: {
                c: [[{ n: 'GASID', p: 0, w: 10, t: 'integer', h: 'ID reference to *DEFINE_CPG_GAS_PROPERTIES.' }]],
            },
        }, [definitionRule('*DEFINE_CPG_GAS_PROPERTIES', 'ID')], {
            runtimeId: 'runtime:test',
            manifestSha256: 'a'.repeat(64),
        });

        assert.deepEqual(index.references, {});
        assert.equal(index.generatedFrom.manualSemanticRuntimeId, 'runtime:test');
        assert.deepEqual(index.definitionKeywords.generic.DEFINE_CPG_GAS_PROPERTIES, {
            target: 'DEFINE_CPG_GAS_PROPERTIES',
            cardIndex: 1,
            fieldIndex: 0,
            fieldName: 'ID',
            fieldType: 'integer',
            position: 0,
            width: 10,
            ruleId: 'rule:*DEFINE_CPG_GAS_PROPERTIES:ID',
            evidenceIds: ['evidence:*DEFINE_CPG_GAS_PROPERTIES:ID'],
        });
        assert.equal(index.definitionKeywords.generic.DEFINE_CPG_GAS_PROPERTIES_TITLE.cardIndex, 2);
        assert.equal(index.definitionKeywords.generic.AIRBAG, undefined);
    });

    it('keeps NODE/ELEMENT definitions on demand and blocks ambiguous layouts', () => {
        const index = buildIndex({
            NODE: { c: [[{ n: 'NID', p: 0, w: 10, t: 'integer' }]] },
            AMBIGUOUS: {
                c: [
                    [{ n: 'ID', p: 0, w: 10, t: 'integer' }],
                    [{ n: 'ID', p: 0, w: 10, t: 'integer' }],
                ],
            },
        }, [
            definitionRule('*NODE', 'NID', { targetKind: 'node' }),
            definitionRule('*AMBIGUOUS', 'ID'),
        ]);

        assert.equal(index.definitionKeywords.generic.NODE, undefined);
        assert.equal(index.definitionKeywords.onDemand.NODE.targetKind, 'node');
        assert.equal(index.definitionKeywords.generic.AMBIGUOUS, undefined);
        assert.equal(index.definitionKeywords.blocked[0].reason, 'field-layout-ambiguous');
    });

    it('keeps drawable curve/table support intersected with verified definitions', () => {
        const schema = {
            DEFINE_CURVE: { c: [[{ n: 'LCID', p: 0, w: 10, t: 'integer' }]] },
            DEFINE_CURVE_FEEDBACK: { c: [[{ n: 'LCID', p: 0, w: 10, t: 'integer' }]] },
        };
        const index = buildIndex(schema, [
            definitionRule('*DEFINE_CURVE', 'LCID', { targetKind: 'curve' }),
        ]);

        assert.deepEqual(index.definitionKeywords.scanned, ['DEFINE_CURVE']);
        assert.deepEqual(index.definitionKeywords.drawable, ['DEFINE_CURVE']);
        assert.ok(!index.definitionKeywords.scanned.includes('DEFINE_CURVE_FEEDBACK'));
    });

    it('uses the verified selector signature when schema field names repeat and TITLE shifts cards', () => {
        const tableCards = [
            [
                { n: 'TBID', p: 0, w: 10, t: 'integer' },
                { n: 'SFA', p: 10, w: 10, t: 'real' },
            ],
            [
                { n: 'VALUE', p: 0, w: 20, t: 'real' },
                { n: 'TBID', p: 20, w: 20, t: 'integer' },
            ],
        ];
        const selector = {
            cardIndex: 1,
            fieldIndex: 0,
            fieldName: 'TBID',
            fieldType: 'integer',
            position: 0,
            width: 10,
        };
        const index = buildIndex({
            DEFINE_TABLE_4D: {
                c: tableCards,
                o: [{
                    n: 'TITLE',
                    co: 'pre/1',
                    to: 1,
                    c: [[{ n: 'TITLE', p: 0, w: 80, t: 'string' }]],
                }],
            },
            DEFINE_TABLE_4D_TITLE: {
                x: 'DEFINE_TABLE_4D',
                active: ['TITLE'],
                c: tableCards,
            },
        }, [definitionRule(
            '*DEFINE_TABLE_4D',
            'TBID',
            { targetKind: 'table' },
            selector,
        )]);

        assert.equal(index.definitionKeywords.drawable.includes('DEFINE_TABLE_4D'), true);
        assert.equal(index.definitionKeywords.drawable.includes('DEFINE_TABLE_4D_TITLE'), true);
        assert.equal(index.definitionKeywords.blocked.length, 0);
        assert.equal(index.definitionKeywords.scanned.length, 2);
    });

    it('keeps verified 5D through 9D tables index-only', () => {
        const index = buildIndex({
            DEFINE_TABLE_5D: { c: [[{ n: 'TBID', p: 0, w: 10, t: 'integer' }]] },
        }, [definitionRule('*DEFINE_TABLE_5D', 'TBID', { targetKind: 'table' })]);

        assert.deepEqual(index.definitionKeywords.scanned, ['DEFINE_TABLE_5D']);
        assert.deepEqual(index.definitionKeywords.drawable, []);
        assert.deepEqual(index.definitionKeywords.indexOnly, ['DEFINE_TABLE_5D']);
    });

    it('normalizes manual alias definitions to the schema canonical target', () => {
        const materialCard = [[{ n: 'MID', p: 0, w: 10, t: 'integer' }]];
        const index = buildIndex({
            MAT_023: {
                c: materialCard,
                a: ['MAT_TEMPERATURE_DEPENDENT_ORTHOTROPIC'],
            },
            MAT_TEMPERATURE_DEPENDENT_ORTHOTROPIC: {
                c: materialCard,
                x: 'MAT_023',
            },
        }, [definitionRule(
            '*MAT_TEMPERATURE_DEPENDENT_ORTHOTROPIC',
            'MID',
            { targetKind: 'material' },
        )]);

        assert.equal(index.definitionKeywords.generic.MAT_023.target, 'MAT_023');
        assert.equal(
            index.definitionKeywords.generic.MAT_TEMPERATURE_DEPENDENT_ORTHOTROPIC.target,
            'MAT_023',
        );
    });
});
