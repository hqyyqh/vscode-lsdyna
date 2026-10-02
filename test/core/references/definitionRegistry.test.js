'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
    DefinitionRegistryCatalog,
    getDefinitionRegistryCatalog,
} = require('../../../out/core/references/definitionRegistry');
const { SemanticRuntimeCatalogV2, getSemanticRuntimeCatalogV2 } = require('../../../out/core/semantics/semanticRuntimeV2');
const { getManualSemanticCatalog } = require('../../../out/core/semantics/manualSemanticCatalog');

const registry = require(path.resolve(__dirname, "../../../keywords/runtime/definitions/definition_registry.json"));
const proofReport = require(path.resolve(__dirname, "../../../keywords/provenance/definition-registry/definition_registry.proof-report.json"));
const fieldReferenceIndex = require(path.resolve(__dirname, "../../../keywords/runtime/references/field_reference_index.json"));

describe('Definition Registry runtime', () => {
    it('shares asynchronous preparation and retains all validated relations and permissions', async function () {
        this.timeout(10000);
        const asynchronous = new DefinitionRegistryCatalog();
        const pending = asynchronous.prepare();
        assert.equal(asynchronous.prepare(), pending);
        assert.equal(await pending, true);
        const synchronous = getDefinitionRegistryCatalog();
        assert.deepEqual(asynchronous.definitionRecords(), synchronous.definitionRecords());
        for (const keyword of Object.keys(getSemanticRuntimeCatalogV2().manifest().referenceKeywordIndex)) {
            assert.deepEqual(asynchronous.rulesForKeyword(keyword), synchronous.rulesForKeyword(keyword));
        }
        for (const permission of ['f12Permission', 'referenceProviderPermission', 'automaticMutationPermission'])
            assert.equal(asynchronous.permission(permission), synchronous.permission(permission));
        const corrupted = new DefinitionRegistryCatalog({ ...registry, contentSha256: '0'.repeat(64) });
        assert.equal(await corrupted.prepare(), false);
        assert.deepEqual(corrupted.rulesForKeyword('PART'), []);
    });
    it('retries a failed asynchronous read without exposing an unvalidated directory', async function () {
        this.timeout(10000);
        const runtime = getSemanticRuntimeCatalogV2(), original = runtime.prepareReferences;
        const catalog = new DefinitionRegistryCatalog();
        runtime.prepareReferences = async () => { throw Error('temporary read failure'); };
        try {
            assert.equal(await catalog.prepare(), false);
            assert.deepEqual(catalog.rulesForKeyword('PART'), []);
        } finally { runtime.prepareReferences = original; }
        assert.equal(await catalog.prepare(), true);
        assert.ok(catalog.rulesForKeyword('PART').length);
    });
    it('validates the source-locked compact registry and its staged permissions', function () {
        this.timeout(5000);
        const catalog = getDefinitionRegistryCatalog();
        const summary = getSemanticRuntimeCatalogV2().manifest().summary;
        assert.ok(summary.referenceRelations >= 4021);
        assert.equal(summary.sourceManualRelations, 4021);
        assert.equal(summary.distinctManualRelations, 4021);
        assert.ok(summary.referenceCoordinates >= 4021);
        assert.ok(summary.referenceKeywords > 1000);
        const runtimeRelationIds = new Set(getSemanticRuntimeCatalogV2().allReferenceRecords()
            .map(record => record.authoringRelationId));
        assert.ok(Object.values(registry.byKeyword).flat()
            .every(record => runtimeRelationIds.has(record.authoringRelationId)));
        assert.equal(catalog.permission('definitionRegistryRuntimePermission'), true);
        assert.equal(catalog.permission('fieldClassifierOverlayPermission'), true);
        assert.equal(catalog.permission('definitionIndexOverlayPermission'), true);
        assert.equal(catalog.permission('f12Permission'), true);
        assert.equal(catalog.permission('referenceProviderPermission'), true);
    });

    it('accounts for every relation in the source-locked scanner/navigation proof report', () => {
        const relations = Object.values(registry.byKeyword).flat();
        const relationIds = relations.map(record => record.authoringRelationId).sort();
        assert.deepEqual(proofReport.scannerProofs.map(item => item.authoringRelationId).sort(), relationIds);
        assert.deepEqual(proofReport.navigationProofs.map(item => item.authoringRelationId).sort(), relationIds);
        assert.equal(proofReport.summary.scannerPassed, 91);
        assert.equal(proofReport.summary.scannerMissing, 0);
        assert.equal(proofReport.summary.navigationPassed, 21);
        assert.equal(proofReport.summary.navigationBlocked, 70);
        assert.equal(proofReport.summary.bidirectionalProofGroups, 11);
        assert.ok(proofReport.scannerProofs.every(item => item.status === 'passed'));
        assert.ok(proofReport.navigationProofs.filter(item => item.status === 'passed')
            .every(item => item.proofGroupId && (
                item.counterpartAuthoringRelationIds.length > 0 ||
                item.counterpartRuntimeDescriptorPopulation > 0
            )));
    });

    it('preserves co-located signed value-domain records independently', () => {
        const catalog = getDefinitionRegistryCatalog();
        const records = catalog.fieldRelations('PART', 2, {
            n: 'ADPOPT', t: 'integer', p: 60, w: 10,
        });
        assert.equal(records.length, 2);
        assert.deepEqual(records.map(record => record.kind).sort(), ['entity-reference', 'value-branch']);
        const reference = records.find(record => record.kind === 'entity-reference');
        assert.deepEqual(reference.relation.branches, [{
            idTransform: 'abs',
            role: 'reference',
            targetKinds: ['curve'],
            when: { op: 'lt', value: 0 },
        }]);
    });

    it('projects one source family relation across concrete LOAD_BODY spellings', () => {
        const catalog = getDefinitionRegistryCatalog();
        const record = catalog.fieldRelations('LOAD_BODY_Z', 1, {
            n: 'LCID', t: 'integer', p: 0, w: 10,
        }).find(item => item.kind === 'entity-reference');

        assert.equal(record.operationalProjection.sourceSelectorKeyword, '*LOAD_BODY');
        assert.equal(record.operationalProjection.projectedSourceKeyword, '*LOAD_BODY_Z');
        assert.deepEqual(record.relation.targetKeywords, ['*DEFINE_CURVE']);
        assert.ok(catalog.rulesForSourceRuleId(record.sourceRuleId).length >= 7);
        assert.equal(catalog.ruleForSourceRuleId(record.sourceRuleId), null);
    });

    it('loads the complete operational definition scanner catalog beside projected definitions', () => {
        const definitions = getDefinitionRegistryCatalog().definitionRecords();
        const scanners = getSemanticRuntimeCatalogV2().allDefinitionScanners();
        assert.ok(definitions.length > 400);
        assert.equal(scanners.length, 1678);
        const scannerKinds = new Set(scanners.map(scanner => scanner.targetKind));
        assert.ok(scannerKinds.has('coordinate-system'));
        assert.ok(scannerKinds.has('material'));
        assert.ok(scannerKinds.has('part'));
    });

    it('preserves the official SET_PART semantic correction as an exact definition overlay', () => {
        const catalog = getDefinitionRegistryCatalog();
        const definition = catalog.fieldRelations('SET_PART', 1, {
            n: 'SID', t: 'integer', p: 0, w: 10,
        }).find(record => record.kind === 'entity-definition');
        assert.ok(definition);
        assert.equal(definition.relation.targetKind, 'part-set');
        assert.equal(definition.semanticCorrection.correctionId,
            'manual-relation-semantic-correction:fa2aadd655f524a4c1c4fc3a');
        assert.equal(definition.semanticCorrection.originalKind, 'entity-reference');
        assert.deepEqual(definition.semanticCorrection.originalRelation,
            { kind: 'entity-reference', targetKinds: ['set'] });

        const reference = catalog.fieldRelations('LOAD_BODY_PARTS', 1, {
            n: 'PSID', t: 'integer', p: 0, w: 10,
        }).find(record => record.kind === 'entity-reference');
        assert.ok(reference);
        assert.deepEqual(reference.relation.targetKinds, ['part-set']);
        assert.deepEqual(reference.relation.targetKeywords, ['*SET_PART']);
    });

    it('matches exact operational manual rules and retains multi-candidate source projections', () => {
        const catalog = getDefinitionRegistryCatalog();
        const manualCatalog = getManualSemanticCatalog();
        const approved = manualCatalog.rulesForKeyword('PART').find(rule =>
            rule.ruleId === 'rule:3226dd555553b9a96e3fea29'
        );
        const formerlyUnapproved = manualCatalog.rulesForKeyword('DEFINE_BOX').find(rule =>
            rule.kind === 'entity-definition'
        );

        const record = catalog.approvedRecordForManualRule(approved);
        assert.equal(record.sourceRuleId, approved.ruleId);
        assert.equal(record.manualRelationId.startsWith('manual-relation:'), true);
        assert.equal(record.operationalProjection.strategy.length > 0, true);
        assert.equal(catalog.approvedRecordForManualRule({ ...approved, relation: { kind: 'entity-reference' } }), null);
        const projections = catalog.rulesForSourceRuleId(formerlyUnapproved.ruleId);
        assert.ok(projections.length > 0);
        assert.ok(projections.every(item => item.operationalProjection));
    });

    it('fails closed without exposing partial relations when integrity validation fails', () => {
        const source = path.resolve(__dirname, "../../../keywords/runtime/semantic-v2");
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-runtime-v2-'));
        fs.cpSync(source, root, { recursive: true });
        const shard = path.join(root, 'references', '0.json.gz');
        fs.appendFileSync(shard, Buffer.from([0]));
        const catalog = new SemanticRuntimeCatalogV2(root);
        assert.equal(catalog.status().ready, true);
        const manifest = catalog.manifest();
        const [corruptedKeyword] = Object.entries(manifest.referenceKeywordIndex)
            .find(([, prefix]) => prefix === '0');
        assert.deepEqual(catalog.referenceRecordsForKeyword(corruptedKeyword), []);
        assert.equal(catalog.status().ready, false);
        assert.match(catalog.status().failureReason, /compressed drift/);
        assert.deepEqual(catalog.referenceRecordsForKeyword('PART'), []);
        fs.rmSync(root, { recursive: true, force: true });
    });
});
