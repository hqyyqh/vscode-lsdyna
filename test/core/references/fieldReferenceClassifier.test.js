const assert = require('assert');
// Numbered aliases added after the original inventory expectations: keep exact coordinates and dispositions.
const numberedAliasContract = require('../../fixtures/public-behavior/reference-numbered-alias-contract.json');
const aliasKeywords = new Set(numberedAliasContract.numberedAliases);
let frozenReferenceRecords;
function sourceReferenceRecords() {
    if (!frozenReferenceRecords) {
        const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
        const root = path.resolve(__dirname, '../../..');
        const manifest = require(path.join(root, 'keywords/sources/manifest.json'));
        const source = manifest.bundles.find(bundle => bundle.bundle === 'semantic-v2');
        frozenReferenceRecords = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, source.path)))).references;
    }
    return frozenReferenceRecords;
}
const keywordSchema = require('../../../out/core/keywordSchema');
const componentJointDidOverlay = require(
    "../../../keywords/authoring/compatibility/component_joint_did_official_float.json"
);
const runtimeTableLayoutCorrections = require(
    "../../../keywords/authoring/engineering/runtimeTableLayoutCorrections.json"
);
const runtimeSemanticRelationCorrections = require(
    "../../../keywords/authoring/engineering/runtimeSemanticRelationCorrections.json"
);
const {
    applyRuntimeSemanticRelationCorrection,
    buildRuntimeTableLayoutIndex,
    getActionableFieldReferenceInfo,
    getFieldReferenceInfo,
    getRegistryApprovedFieldReferenceInfo,
    isCoherentReferenceTargetNamespace,
    manualRulesForField,
    parseFieldReferenceValue,
    referenceTargets,
    selectorMapsToRequestedCard,
} = require('../../../out/core/references/fieldReferenceClassifier');

describe('fieldReferenceClassifier', () => {
    it('corrects only the source-locked MAT_262 EB negative reference branch', function () {
        this.timeout(10_000);
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema(
            '*MAT_LAMINATED_FRACTURE_DAIMLER_CAMANHO', schema,
        );
        const field = keywordSchema.getRenderedCardsForLookup(lookup)[0][3];
        const info = getActionableFieldReferenceInfo({
            keyword: '*MAT_LAMINATED_FRACTURE_DAIMLER_CAMANHO',
            cardIndex: 1,
            field,
        });
        assert.ok(info);
        assert.equal(info.definitionRegistry.approved, true);
        assert.match(info.definitionRegistry.authoringRelationId,
            /^authoring-relation:/);
        assert.equal(info.relation.branches[0].when.op, 'lt');
        assert.equal(info.relation.branches[0].idTransform, 'negate');
        assert.deepEqual(info.targetKinds, ['curve', 'table']);
        assert.deepEqual(parseFieldReferenceValue('-73', info), {
            kind: 'numeric', id: 73, raw: '-73', isSignedSwitch: true,
            idTransform: 'negate',
            input: { kind: 'numeric', raw: '-73', value: -73 },
            semanticRelation: info.relation,
            targetKinds: ['curve', 'table'], targetDefinitions: [],
        });
        assert.equal(parseFieldReferenceValue('73', info), null);

        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const original = runtime.referenceRecordsForKeyword(
            '*MAT_LAMINATED_FRACTURE_DAIMLER_CAMANHO',
        ).find(record => record.authoringRelationId ===
            'authoring-relation:c60dfe2e1ef06c6df299528a');
        const corrected = applyRuntimeSemanticRelationCorrection(original);
        assert.equal(corrected.runtimeSemanticCorrection.correctionId,
            'runtime-semantic-relation-correction-group:mat262-eb-sign');
        assert.equal(corrected.relation.branches[0].when.op, 'lt');
        assert.equal(original.relation.branches[0].when.op, 'gt');

        const mutations = [
            registry => { registry.documents[0].pages[3].textSha256 = '0'.repeat(64); },
            registry => { registry.correctionGroups[0].field.width = 20; },
            registry => { registry.correctionGroups[0].records[1].sourceRuleId = 'rule:drift'; },
            registry => { registry.correctionGroups[0].replacePredicate.from.op = 'lt'; },
            registry => { registry.permissions.automaticPredicateMutation = true; },
        ];
        for (const mutate of mutations) {
            const registry = structuredClone(runtimeSemanticRelationCorrections);
            mutate(registry);
            assert.equal(applyRuntimeSemanticRelationCorrection(original, registry), original);
        }
        const drifted = structuredClone(original);
        drifted.evidence[0].quoteSha256 = '0'.repeat(64);
        assert.equal(applyRuntimeSemanticRelationCorrection(drifted).runtimeSemanticCorrection,
            undefined);
    });

    it('separates producer relation defects from contextual keyword branches', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const cases = [
            ['MAT_SHAPE_MEMORY', 2, 'SIG_ASS', '-41', 41, ['curve', 'table']],
            ['MAT_SHAPE_MEMORY', 2, 'SIG_ASF', '-42', 42, ['curve', 'table']],
            ['MAT_SHAPE_MEMORY', 2, 'SIG_SAS', '-43', 43, ['curve', 'table']],
            ['MAT_SHAPE_MEMORY', 2, 'SIG_SAF', '-44', 44, ['curve', 'table']],
            ['CONSTRAINED_LAGRANGE_IN_SOLID', 4, 'LCIDPOR', '45', 45, ['curve']],
            ['CONSTRAINED_LAGRANGE_IN_SOLID', 6, 'A1', '-46', 46, ['curve']],
        ];
        for (const [keyword, cardIndex, fieldName, raw, id, targetKinds] of cases) {
            const lookup = keywordSchema.lookupKeywordSchema(keyword, schema);
            const field = keywordSchema.getRenderedCards(
                lookup.entry, lookup.activeOptions,
            )[cardIndex - 1].find(candidate => candidate.n === fieldName);
            const info = getActionableFieldReferenceInfo({ keyword, cardIndex, field });
            assert.ok(info, `${keyword}/${fieldName}`);
            const parsed = parseFieldReferenceValue(raw, info);
            assert.equal(parsed.id, id, `${keyword}/${fieldName}`);
            assert.deepEqual(parsed.targetKinds, targetKinds, `${keyword}/${fieldName}`);
            assert.equal(info.relation.branches.filter(branch =>
                branch.role === 'reference').length, 1, `${keyword}/${fieldName}`);
        }
        const clis = keywordSchema.lookupKeywordSchema(
            'CONSTRAINED_LAGRANGE_IN_SOLID', schema,
        );
        const cards = keywordSchema.getRenderedCards(clis.entry, clis.activeOptions);
        const lcidpor = getActionableFieldReferenceInfo({
            keyword: 'CONSTRAINED_LAGRANGE_IN_SOLID', cardIndex: 4,
            field: cards[3].find(field => field.n === 'LCIDPOR'),
        });
        const a1 = getActionableFieldReferenceInfo({
            keyword: 'CONSTRAINED_LAGRANGE_IN_SOLID', cardIndex: 6,
            field: cards[5].find(field => field.n === 'A1'),
        });
        assert.equal(parseFieldReferenceValue('-45', lcidpor), null,
            'negative LCIDPOR needs CTYPE/POREINI context');
        assert.equal(parseFieldReferenceValue('46', a1), null,
            'positive A1 is a coefficient, not a curve ID');

        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const original = runtime.referenceRecordsForKeyword('*MAT_SHAPE_MEMORY')
            .find(record => record.authoringRelationId ===
                'authoring-relation:ac9a1aceaf78ceaee7694ee7');
        assert.equal(original.relation.branches.length, 2);
        assert.equal(applyRuntimeSemanticRelationCorrection(original).relation.branches.length, 1);
        const mutations = [
            registry => { registry.correctionGroups[1].records[0]
                .originalRelationSha256 = '0'.repeat(64); },
            registry => { registry.correctionGroups[1].source.physicalPages = [391]; },
            registry => { registry.correctionGroups[5].retainedBranches[0]
                .targetKinds = ['table']; },
            registry => { registry.correctionGroups[5].contextualReferenceBranch.all[0]
                .formats.standard.position = 40; },
            registry => { registry.correctionGroups[5].contextualReferenceBranch.all[1]
                .predicate.any[1].op = 'ge'; },
            registry => { registry.permissions.contextFreeNegativeLcidporApproval = true; },
        ];
        for (const mutate of mutations) {
            const registry = structuredClone(runtimeSemanticRelationCorrections);
            mutate(registry);
            assert.equal(applyRuntimeSemanticRelationCorrection(original, registry), original);
        }
    });

    it('suppresses scalar prose contamination without changing PART_MOVE layout', function () {
        this.timeout(60_000); // Includes every reference keyword and its source-locked scalar exclusions.
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const partMove = keywordSchema.lookupKeywordSchema('*PART_MOVE', schema);
        assert.deepEqual(partMove.activeOptions, []);
        const partMoveCard = keywordSchema.getRenderedCardsForLookup(partMove)[0];
        assert.deepEqual(partMoveCard.map(field =>
            [field.n, field.t, field.p, field.w]), [
            ['PID', 'integer', 0, 8],
            ['XMOV', 'real', 8, 16],
            ['YMOV', 'real', 24, 16],
            ['ZMOV', 'real', 40, 16],
            ['CID', 'integer', 56, 8],
            ['IFSET', 'integer', 64, 8],
        ]);
        for (const name of ['XMOV', 'YMOV', 'ZMOV']) {
            const field = partMoveCard.find(candidate => candidate.n === name);
            assert.equal(getFieldReferenceInfo({
                keyword: '*PART_MOVE', cardIndex: 1, field,
            }), null, name);
            assert.equal(getActionableFieldReferenceInfo({
                keyword: '*PART_MOVE', cardIndex: 1, field,
            }), null, name);
        }
        assert.ok(getActionableFieldReferenceInfo({
            keyword: '*PART_MOVE', cardIndex: 1,
            field: partMoveCard.find(field => field.n === 'CID'),
        }));

        const massPart = keywordSchema.lookupKeywordSchema('*ELEMENT_MASS_PART', schema);
        const massPartCard = keywordSchema.getRenderedCardsForLookup(massPart)[0];
        const finmass = massPartCard.find(field => field.n === 'FINMASS');
        assert.deepEqual([finmass.t, finmass.p, finmass.w], ['real', 24, 16]);
        assert.equal(getFieldReferenceInfo({
            keyword: '*ELEMENT_MASS_PART', cardIndex: 1, field: finmass,
        }), null);
        assert.ok(getActionableFieldReferenceInfo({
            keyword: '*ELEMENT_MASS_PART', cardIndex: 1,
            field: massPartCard.find(field => field.n === 'LCID'),
        }));

        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const original = runtime.referenceRecordsForKeyword('*PART_MOVE')
            .find(record => record.authoringRelationId ===
                'authoring-relation:92dd670efe562ea356f42dd0');
        const corrected = applyRuntimeSemanticRelationCorrection(original);
        assert.deepEqual(corrected.relation, { kind: 'non-reference' });
        assert.equal(corrected.runtimeSemanticCorrection.operation,
            'suppress-non-reference-extraction');
        for (const mutate of [
            registry => { registry.documents[1].pages[7].textSha256 = '0'.repeat(64); },
            registry => { registry.correctionGroups[7].field.width = 20; },
            registry => { registry.correctionGroups[7].records[0]
                .originalRelationSha256 = '0'.repeat(64); },
            registry => { registry.permissions.sourceLockedReferenceSuppression = false; },
        ]) {
            const registry = structuredClone(runtimeSemanticRelationCorrections);
            mutate(registry);
            assert.equal(applyRuntimeSemanticRelationCorrection(original, registry), original);
        }

        const retainedHighRisk = [];
        const visited = new Set();
        for (const keyword of new Set(runtime.allReferenceRecords().map(record => record.field.keyword))) {
            const lookup = keywordSchema.lookupKeywordSchema(keyword, schema);
            if (!lookup) continue;
            const cards = keywordSchema.getRenderedCardsForLookup(lookup);
            for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
                for (const field of cards[cardIndex]) {
                    const key = [keyword, cardIndex, field.n, field.t, field.p, field.w].join('|');
                    if (visited.has(key)) continue;
                    visited.add(key);
                    if (field.t !== 'real' && field.t !== 'float') continue;
                    const info = getActionableFieldReferenceInfo({
                        keyword, cardIndex: cardIndex + 1, field,
                    });
                    if (info?.definitionRegistry?.selectorSource !== 'manual-semantic' ||
                        info.relation?.kind !== 'entity-reference') continue;
                    retainedHighRisk.push(`${keyword}/${field.n}`);
                }
            }
        }
        assert.deepEqual(retainedHighRisk.sort(), [
            '*CONTROL_FORMING_SHELL_TO_TSHELL/IDSEGB',
            '*CONTROL_FORMING_SHELL_TO_TSHELL/IDSEGT',
            '*DUALCESE_POROUS_SPECIFY_JUMP/EQID',
            '*ELEMENT_MASS_MATRIX/CID',
            '*EM_EP_ECG/PSID',
            '*LOAD_EDGE_UVW/LCID',
            '*MAT_ADD_INELASTICITY/P1',
            '*MAT_GENERALIZED_PHASE_CHANGE/CTE',
            '*MAT_SHAPE_MEMORY/LCSS',
            '*MAT_TABULATED_JOHNSON_COOK_ORTHO_PLASTICITY/LCC00R',
            '*MAT_TABULATED_JOHNSON_COOK_ORTHO_PLASTICITY/LCC00T',
            '*MAT_TABULATED_JOHNSON_COOK_ORTHO_PLASTICITY/LCS45R',
            '*MAT_TABULATED_JOHNSON_COOK_ORTHO_PLASTICITY/LCS45T',
            '*MAT_THERMAL_CHEMICAL_REACTION_ORTHOTROPIC/LCK2F',
            '*MAT_THERMAL_CHEMICAL_REACTION_ORTHOTROPIC/LCK3F',
        ]);
        assert.equal(retainedHighRisk.length + 4, 19);
    });

    it('corrects only the nine source-locked nodal-set namespaces and ignores options', function () {
        this.timeout(20_000);
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const cases = [
            ['*BOUNDARY_SLIDING_PLANE', 'NSID', 811, 1, 0, 0, 10,
                'runtime-semantic-relation-correction-group:set-node-namespace-boundary-sliding-plane'],
            ['*CONSTRAINED_SHELL_TO_SOLID', 'NSID', 1074, 1, 1, 10, 10,
                'runtime-semantic-relation-correction-group:set-node-namespace-constrained-shell-to-solid'],
            ['*CONTACT_1D', 'NSIDR', 1306, 1, 0, 0, 10,
                'runtime-semantic-relation-correction-group:set-node-namespace-contact-1d'],
            ['*CONTACT_1D', 'NSIDC', 1306, 1, 1, 10, 10,
                'runtime-semantic-relation-correction-group:set-node-namespace-contact-1d-concrete'],
            ['*DATABASE_NODAL_FORCE_GROUP', 'NSID', 2098, 1, 0, 0, 10,
                'runtime-semantic-relation-correction-group:set-node-namespace-database-nodal-force-group'],
            ['*INITIAL_VELOCITY', 'NSID', 3187, 1, 0, 0, 10,
                'runtime-semantic-relation-correction-group:set-node-namespace-initial-velocity'],
            ['*INITIAL_VELOCITY', 'NSIDEX', 3188, 1, 1, 10, 10,
                'runtime-semantic-relation-correction-group:set-node-namespace-initial-velocity-exempt'],
            ['*RIGIDWALL_PLANAR', 'NSID', 3688, 1, 0, 0, 10,
                'runtime-semantic-relation-correction-group:set-node-namespace-rigidwall-planar'],
            ['*RIGIDWALL_PLANAR', 'NSIDEX', 3688, 1, 1, 10, 10,
                'runtime-semantic-relation-correction-group:set-node-namespace-rigidwall-planar-exempt'],
        ];
        for (const [keyword, fieldName, page, cardIndex, fieldIndex, position, width,
            correctionId] of cases) {
            const record = sourceReferenceRecords().find(candidate =>
                candidate.field.keyword === keyword &&
                candidate.field.fieldName === fieldName &&
                candidate.field.cardIndex === cardIndex &&
                candidate.field.fieldIndex === fieldIndex &&
                candidate.evidence?.some(evidence => evidence.page === page));
            assert.ok(record, `${keyword}/${fieldName}`);
            assert.deepEqual(record.relation, {
                kind: 'entity-reference', targetKeywords: ['*SET_NODE'], targetKinds: ['set'],
            });
            const lookup = keywordSchema.lookupKeywordSchema(keyword, schema);
            assert.deepEqual(lookup.activeOptions, [], `${keyword}/${fieldName} option state`);
            const field = keywordSchema.getRenderedCardsForLookup(lookup)[cardIndex - 1][fieldIndex];
            assert.deepEqual([field.n, field.t, field.p, field.w],
                [fieldName, 'integer', position, width]);
            const corrected = applyRuntimeSemanticRelationCorrection(record);
            assert.deepEqual(corrected.relation, {
                kind: 'entity-reference', targetKeywords: ['*SET_NODE'],
                targetKinds: ['node-set'],
            });
            assert.equal(corrected.runtimeSemanticCorrection.correctionId, correctionId);
            const info = getActionableFieldReferenceInfo({ keyword, cardIndex, field });
            assert.ok(info, `${keyword}/${fieldName} should be actionable after correction`);
            assert.deepEqual(info.targetKinds, ['node-set']);
            assert.deepEqual(info.targetDefinitions, ['SET_NODE']);
        }

        const unrelated = sourceReferenceRecords().find(record =>
            record.field.keyword === '*CHANGE_VELOCITY_ZERO' &&
            record.field.fieldName === 'NSID' &&
            record.relation?.targetKinds?.length === 1 &&
            record.relation.targetKinds[0] === 'set');
        assert.ok(unrelated);
        assert.equal(applyRuntimeSemanticRelationCorrection(unrelated), unrelated,
            'set namespace must not be rewritten globally');

        const targetCase = cases[0];
        const original = sourceReferenceRecords().find(record =>
            record.field.keyword === targetCase[0] && record.field.fieldName === targetCase[1] &&
            record.evidence?.some(evidence => evidence.page === targetCase[2]));
        for (const mutate of [
            registry => { registry.permissions.sourceLockedTargetNamespaceCorrection = false; },
            registry => { registry.documents[1].pages.at(-1).textSha256 = '0'.repeat(64); },
            registry => { registry.correctionGroups.find(group => group.id === targetCase[7])
                .field.position = 10; },
            registry => { registry.correctionGroups.find(group => group.id === targetCase[7])
                .targetKindReplacement.to = ['set']; },
            registry => { registry.correctionGroups.find(group => group.id === targetCase[7])
                .records[0].originalRelationSha256 = '0'.repeat(64); },
        ]) {
            const registry = structuredClone(runtimeSemanticRelationCorrections);
            mutate(registry);
            assert.equal(applyRuntimeSemanticRelationCorrection(original, registry), original);
        }
    });

    it('corrects the generalized-weld nodal-set batch only with direct p918 evidence', function () {
        this.timeout(10_000);
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const groups = runtimeSemanticRelationCorrections.correctionGroups.filter(group =>
            group.id.startsWith('runtime-semantic-relation-correction-group:set-node-namespace-generalized-weld-'));
        assert.equal(groups.length, 10);
        assert.equal(groups.reduce((count, group) => count + group.records.length, 0), 20);
        for (const group of groups) {
            assert.deepEqual(group.source.physicalPages, [918]);
            assert.deepEqual(group.field, {
                cardIndex: 1, fieldIndex: 0, fieldName: 'NSID',
                fieldType: 'integer', position: 0, width: 10,
            });
            assert.equal(group.physicalTableId,
                'global-manual-card-grid:911d208105543714b6d0dd10');
            assert.equal(group.physicalFieldId,
                'global-manual-physical-field:5b857d9947befefa82299ad1');
            const records = sourceReferenceRecords().filter(record =>
                group.records.some(item => item.authoringRelationId === record.authoringRelationId));
            assert.equal(records.length, 2, group.keyword);
            for (const record of records) {
                assert.equal(record.field.keyword, group.keyword);
                assert.equal(record.field.cardIndex, 1);
                assert.equal(record.field.fieldIndex, 0);
                assert.equal(record.field.fieldName, 'NSID');
                assert.equal(record.field.fieldType, 'integer');
                assert.equal(record.field.position, 0);
                assert.equal(record.field.width, 10);
                assert.deepEqual(record.relation, {
                    kind: 'entity-reference', targetKeywords: ['*SET_NODE'], targetKinds: ['set'],
                });
                assert.equal(record.evidence[0].page, 918);
                const corrected = applyRuntimeSemanticRelationCorrection(record);
                assert.deepEqual(corrected.relation, {
                    kind: 'entity-reference', targetKeywords: ['*SET_NODE'],
                    targetKinds: ['node-set'],
                });
                assert.equal(corrected.runtimeSemanticCorrection.correctionId, group.id);
            }
            const lookup = keywordSchema.lookupKeywordSchema(group.keyword, schema);
            if (lookup) {
                assert.deepEqual(lookup.activeOptions, [], `${group.keyword} option state`);
                const field = keywordSchema.getRenderedCardsForLookup(lookup)[1][0];
                assert.deepEqual([field.n, field.t, field.p, field.w],
                    ['NSID', 'integer', 0, 10]);
            }
        }
    });

    it('overlays only exact Definition Registry approvals without changing legacy manual lookup', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const part = keywordSchema.lookupKeywordSchema('PART', schema);
        const adpopt = part.entry.c[1].find(item => item.n === 'ADPOPT');
        const approved = getRegistryApprovedFieldReferenceInfo({
            keyword: 'PART',
            cardIndex: 2,
            field: adpopt,
        });
        const mat = keywordSchema.lookupKeywordSchema('MAT_PIECEWISE_LINEAR_PLASTICITY', schema);
        const lcss = mat.entry.c[1].find(item => item.n === 'LCSS');

        assert.equal(approved.definitionRegistry.approved, true);
        assert.equal(approved.definitionRegistry.f12Authorized, true);
        assert.match(approved.definitionRegistry.authoringRelationId, /^authoring-relation:[0-9a-f]{24}$/);
        assert.equal(approved.definitionRegistry.retainedReviewState, 'coverage-gap');
        assert.equal(approved.definitionRegistry.operationalProjection.ambiguous, false);
        const operational = getRegistryApprovedFieldReferenceInfo({
            keyword: 'MAT_PIECEWISE_LINEAR_PLASTICITY',
            cardIndex: 2,
            field: lcss,
        });
        assert.equal(operational.definitionRegistry.approved, true);
        assert.equal(operational.definitionRegistry.retainedReviewState, 'operational-default');
        assert.ok(getFieldReferenceInfo({
            keyword: 'MAT_PIECEWISE_LINEAR_PLASTICITY',
            cardIndex: 2,
            field: lcss,
        }));
    });

    it('rejects each ambiguous coordinate unless one exact unambiguous relation supersedes it', function () {
        this.timeout(5_000);
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const catalog = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        let matchingAmbiguousCoordinates = 0;
        const visited = new Set();
        for (const record of catalog.allReferenceRecords()) {
            if (record.operationalProjection?.ambiguous !== true) continue;
            const coordinate = [
                record.field.keyword,
                record.field.cardIndex,
                record.field.fieldIndex,
                record.field.fieldName,
                record.field.fieldType,
                record.field.position,
                record.field.width,
            ].join('|');
            if (visited.has(coordinate)) continue;
            visited.add(coordinate);
            const lookup = keywordSchema.lookupKeywordSchema(record.field.keyword, schema);
            if (!lookup) continue;
            const card = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions)
                [record.field.cardIndex - 1];
            const field = card?.[record.field.fieldIndex];
            if (!field || field.n !== record.field.fieldName || field.t !== record.field.fieldType ||
                field.p !== record.field.position || field.w !== record.field.width) continue;
            const actionable = getActionableFieldReferenceInfo({
                keyword: record.field.keyword,
                cardIndex: record.field.cardIndex,
                field,
            });
            if (actionable) {
                assert.equal(actionable.definitionRegistry?.operationalProjection?.ambiguous, false,
                    record.authoringRelationId);
                continue;
            }
            matchingAmbiguousCoordinates += 1;
        }
        assert.ok(matchingAmbiguousCoordinates > 0,
            'fixture must cover schema-matching ambiguous projections');
    });

    it('prefers one exact unambiguous coordinate over retained ambiguous candidates', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('INTERFACE_SPRINGBACK_LSDYNA', schema);
        const field = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions)[0][0];
        const info = getRegistryApprovedFieldReferenceInfo({
            keyword: 'INTERFACE_SPRINGBACK_LSDYNA', cardIndex: 1, field,
        });

        assert.equal(field.n, 'PSID');
        assert.deepEqual(info.targetKinds, ['part-set']);
        assert.equal(info.definitionRegistry.operationalProjection.ambiguous, false);
        assert.equal(info.definitionRegistry.f12Authorized, true);
        assert.equal(info.definitionRegistry.authoringRelationId,
            'authoring-relation:d95699c6a4cffce28011c3e5');
    });

    it('does not revive a corrected definition through an unapproved legacy reference fallback', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('SET_PART', schema);
        const sid = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions)[0][0];
        const retained = getFieldReferenceInfo({ keyword: 'SET_PART', cardIndex: 1, field: sid });

        assert.equal(sid.n, 'SID');
        assert.equal(retained.relation.kind, 'entity-reference');
        assert.equal(retained.definitionRegistry, undefined);
        assert.equal(getActionableFieldReferenceInfo({
            keyword: 'SET_PART', cardIndex: 1, field: sid,
        }), null);
        assert.equal(getRegistryApprovedFieldReferenceInfo({
            keyword: 'SET_PART', cardIndex: 1, field: sid,
        }), null);
    });

    it('gives exact definition scanners priority over stale reference projections', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        for (const [keyword, fieldName] of [
            ['SET_NODE', 'SID'],
            ['DUALCESE_MESH_PART', 'PID'],
            ['HOURGLASS', 'HGID'],
        ]) {
            const lookup = keywordSchema.lookupKeywordSchema(keyword, schema);
            const field = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions)[0][0];
            const retained = getFieldReferenceInfo({ keyword, cardIndex: 1, field });
            assert.equal(field.n, fieldName);
            assert.equal(retained.relation.kind, 'entity-reference');
            assert.equal(retained.definitionRegistry.approved, true);
            assert.equal(getActionableFieldReferenceInfo({ keyword, cardIndex: 1, field }), null);
        }
    });

    it('keeps cross-type definition coordinates ahead of stale reference projections', function () {
        const aliasRows = [];

        this.timeout(10_000);
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        let crossTypeConflicts = 0;
        for (const scanner of runtime.allDefinitionScanners()) {
            const lookup = keywordSchema.lookupKeywordSchema(scanner.keyword, schema);
            if (!lookup || lookup.activeOptions.length > 0) continue;
            const standard = (scanner.formatContracts || []).find(contract =>
                contract.format === 'standard' && contract.mode === 'fixed');
            if (!standard) continue;
            const cardIndex = scanner.physicalSelector?.dataRecordOrdinal + 1;
            const field = keywordSchema.getRenderedCardsForLookup(lookup)
                [cardIndex - 1]?.find(candidate =>
                    candidate.n === scanner.definitionField &&
                    candidate.p === standard.position && candidate.w === standard.width);
            if (!field || (field.t === 'real' ? 'float' : field.t) === scanner.fieldType) continue;
            const retained = getFieldReferenceInfo({ keyword: scanner.keyword, cardIndex, field });
            if (!retained) continue;
            if (/^EOS_(?:02[2-9]|030|042)$/.test(scanner.keyword)) aliasRows.push([scanner.keyword, scanner.definitionField, scanner.fieldType, cardIndex, field.n, field.t, field.p, field.w].join('|'));
            crossTypeConflicts++;
            assert.equal(retained.relation.kind, 'entity-reference', scanner.keyword);
            assert.equal(getActionableFieldReferenceInfo({
                keyword: scanner.keyword, cardIndex, field,
            }), null, scanner.keyword);
        }
        assert.equal(crossTypeConflicts, 32);
        assert.deepEqual(aliasRows, numberedAliasContract.definitions);
    });

    it('partitions every cross-type projection without treating type drift as an option', function () {
        const aliasRows = [];

        this.timeout(10_000);
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const visited = new Set();
        const pairs = new Map();
        const dispositions = new Map();
        const dispositionPairs = new Map();
        const retainedNonactionable = [];
        const retainedReasons = new Map();
        const noProductInfo = [];
        let actionable = 0;
        for (const record of runtime.allReferenceRecords()) {
            const source = record.field;
            const lookup = keywordSchema.lookupKeywordSchema(source.keyword, schema);
            if (!lookup) continue;
            const field = keywordSchema.getRenderedCardsForLookup(lookup)
                [source.cardIndex - 1]?.[source.fieldIndex];
            const runtimeType = source.fieldType === 'real' ? 'float' : source.fieldType;
            const schemaType = field?.t === 'real' ? 'float' : field?.t;
            if (!field || field.n !== source.fieldName || runtimeType === schemaType) continue;
            const coordinate = [source.keyword, source.cardIndex, source.fieldIndex,
                source.fieldName, source.fieldType, schemaType,
                source.position, source.width].join('|');
            if (visited.has(coordinate)) continue;
            visited.add(coordinate);
            assert.deepEqual(lookup.activeOptions, [], coordinate);
            const info = getActionableFieldReferenceInfo({
                keyword: source.keyword, cardIndex: source.cardIndex, field,
            });
            const pair = `${runtimeType}->${schemaType}`;
            pairs.set(pair, (pairs.get(pair) || 0) + 1);
            const standardDefinition = runtime.definitionScannersForKeyword(source.keyword)
                .some(scanner => {
                    const standard = (scanner.formatContracts || []).find(contract =>
                        contract.format === 'standard' && contract.mode === 'fixed');
                    return scanner.permissions?.scan === true &&
                        scanner.physicalSelector?.dataRecordOrdinal === source.cardIndex - 1 &&
                        scanner.definitionField === field.n &&
                        standard?.position === field.p && standard?.width === field.w;
                });
            const retained = getFieldReferenceInfo({
                keyword: source.keyword, cardIndex: source.cardIndex, field,
            });
            const disposition = info ? 'actionable-manual-semantic'
                : standardDefinition ? 'definition-priority'
                    : retained ? 'retained-nonactionable' : 'no-product-info';
            if (aliasKeywords.has(source.keyword)) aliasRows.push({ coordinate, disposition, pair });
            dispositions.set(disposition, (dispositions.get(disposition) || 0) + 1);
            const dispositionPair = `${disposition}|${pair}`;
            dispositionPairs.set(dispositionPair,
                (dispositionPairs.get(dispositionPair) || 0) + 1);
            if (!info) {
                if (disposition === 'retained-nonactionable') {
                    retainedNonactionable.push(source.keyword);
                    const reason = field.di === 'self' ? 'self-identity'
                        : retained.definitionRegistry?.approved !== true
                            ? 'unapproved' : 'other';
                    retainedReasons.set(reason, (retainedReasons.get(reason) || 0) + 1);
                }
                if (disposition === 'no-product-info') noProductInfo.push(source.keyword);
                continue;
            }
            actionable++;
            assert.equal(info.definitionRegistry.selectorSource, 'manual-semantic', coordinate);
            assert.ok(manualRulesForField(source.keyword, source.cardIndex, field).some(rule =>
                rule.ruleId === info.ruleId && rule.selector.fieldName === field.n &&
                (rule.selector.fieldType === 'real' ? 'float' : rule.selector.fieldType) === schemaType &&
                rule.selector.position === field.p && rule.selector.width === field.w
            ), coordinate);
        }
        assert.equal(visited.size, 385);
        assert.equal(actionable, 50);
        assert.deepEqual(Object.fromEntries(pairs), {
            "string->integer": 339,
            "float->integer": 38,
            "integer->float": 8
        });
        assert.deepEqual(Object.fromEntries(dispositions), {
            "definition-priority": 323,
            "actionable-manual-semantic": 50,
            "retained-nonactionable": 10,
            "no-product-info": 2
        });
        assert.deepEqual(Object.fromEntries(dispositionPairs), {
            "definition-priority|string->integer": 323,
            "actionable-manual-semantic|float->integer": 36,
            "retained-nonactionable|string->integer": 10,
            "actionable-manual-semantic|string->integer": 6,
            "no-product-info|float->integer": 2,
            "actionable-manual-semantic|integer->float": 8
        });
        assert.deepEqual(retainedNonactionable.sort(), [
            '*MAT_ADD_AIRBAG_POROSITY_LEAKAGE',
            '*MAT_ADD_BASIC_INCREMENTAL_FAILURE',
            '*MAT_ADD_DAMAGE_DIEM',
            '*MAT_ADD_DAMAGE_GISSMO',
            '*MAT_ADD_EROSION',
            '*MAT_ADD_FATIGUE',
            '*MAT_ADD_INELASTICITY',
            '*MAT_ADD_PERMEABILITY',
            '*MAT_ADD_PORE_AIR',
            '*MAT_ADD_PROPERTY_DEPENDENCE',
        ]);
        assert.deepEqual(Object.fromEntries(retainedReasons), {
            'self-identity': 9,
            unapproved: 1,
        });
        assert.deepEqual(noProductInfo, [
            "*MAT_BILKHU",
            "*MAT_BILKHU"
        ]);
        assert.deepEqual(aliasRows, numberedAliasContract.typeDrift);
    });

    it('separates corrected COMPONENT joint schemas from manual option-only spellings', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        for (const keyword of componentJointDidOverlay.requiredSchemaKeywords) {
            const lookup = keywordSchema.lookupKeywordSchema(keyword, schema);
            assert.ok(lookup, keyword);
            assert.deepEqual(lookup.activeOptions, [], keyword);
            const field = keywordSchema.getRenderedCardsForLookup(lookup)[0][0];
            assert.deepEqual({ n: field.n, p: field.p, w: field.w, t: field.t }, {
                n: 'DID', p: 0, w: 10, t: 'real',
            }, keyword);
            assert.equal(getFieldReferenceInfo({ keyword, cardIndex: 1, field }), null, keyword);
            assert.equal(getActionableFieldReferenceInfo({
                keyword, cardIndex: 1, field,
            }), null, keyword);
        }
        for (const keyword of componentJointDidOverlay.manualOptionKeywordsWithoutUpstreamSchema) {
            assert.equal(keywordSchema.lookupKeywordSchema(keyword, schema), null, keyword);
        }
        for (const contract of componentJointDidOverlay
            .lsprepostOnlySchemaKeywordsWithoutManualOptionEvidence) {
            const lookup = keywordSchema.lookupKeywordSchema(contract.keyword, schema);
            assert.ok(lookup, contract.keyword);
            const cards = keywordSchema.getRenderedCardsForLookup(lookup);
            assert.equal(cards.length, contract.cards);
            assert.equal(cards.flat().length, contract.fields);
            assert.deepEqual({
                n: cards[0][0].n, p: cards[0][0].p,
                w: cards[0][0].w, t: cards[0][0].t,
            }, { n: 'DID', p: 0, w: 10, t: 'integer' });
            assert.equal(getFieldReferenceInfo({
                keyword: contract.keyword, cardIndex: 1, field: cards[0][0],
            }), null);
        }
    });

    it('keeps direct self-identity prose conflicts out of the reference product path', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        for (const [keyword, fieldName] of [
            ['DEFINE_CURVE_BOX_ADAPTIVITY', 'ID'],
            ['SET_NODE_ADD', 'SID'],
            ['SET_SOLID_ADD', 'SID'],
        ]) {
            const lookup = keywordSchema.lookupKeywordSchema(keyword, schema);
            const field = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions)[0][0];
            const retained = getFieldReferenceInfo({ keyword, cardIndex: 1, field });
            assert.equal(field.n, fieldName);
            assert.equal(field.di, 'self');
            assert.equal(retained.definitionRegistry.approved, true);
            assert.equal(getActionableFieldReferenceInfo({ keyword, cardIndex: 1, field }), null);
        }
    });

    it('locks each spelling alias to one exact runtime relation and manual evidence identity', () => {
        const aliases = require("../../../keywords/authoring/engineering/keywordSpellingAliases.json").aliases;
        const catalog = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();

        for (const item of aliases) {
            const records = catalog.referenceRecordsForKeyword(item.manualKeyword);
            const record = records.find(candidate =>
                candidate.authoringRelationId === item.authoringRelationId);
            assert.ok(record, item.manualKeyword);
            assert.equal(record.operationalProjection.ambiguous, false);
            assert.equal(record.operationalProjection.candidateCount, 1);
            assert.equal(record.operationalProjection.physicalTableId, item.physicalTableId);
            assert.equal(record.field.cardIndex, item.cardIndex);
            assert.equal(record.field.cardFieldCount, item.card.length);
            assert.deepEqual(
                [record.field.fieldName, record.field.fieldType,
                    record.field.position, record.field.width],
                [item.card[record.field.fieldIndex].name,
                    item.card[record.field.fieldIndex].type,
                    item.card[record.field.fieldIndex].position,
                    item.card[record.field.fieldIndex].width],
            );
            assert.ok(record.evidence.some(evidence =>
                evidence.evidenceId === item.evidenceId &&
                evidence.page === item.manualPage &&
                evidence.quoteSha256 === item.quoteSha256), item.manualKeyword);
        }
    });

    it('locks the corrected IGA card to its exact runtime and rendered PDF evidence', () => {
        const correction = require("../../../keywords/authoring/engineering/keywordLayoutCorrections.json").corrections[0];
        const catalog = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const record = catalog.referenceRecordsForKeyword(correction.keyword).find(candidate =>
            candidate.authoringRelationId === correction.runtimeRelation.authoringRelationId);

        assert.ok(record);
        assert.equal(record.operationalProjection.physicalTableId,
            correction.runtimeRelation.physicalTableId);
        assert.ok(record.evidence.some(evidence =>
            evidence.evidenceId === correction.runtimeRelation.evidenceId &&
            evidence.quoteSha256 === correction.runtimeRelation.quoteSha256));
        assert.equal(correction.pdfEvidence.physicalPage, 2967);
        assert.equal(correction.pdfEvidence.toolVersion, '24.03.0');
        assert.match(correction.pdfEvidence.pdfSha256, /^[0-9a-f]{64}$/);
        assert.match(correction.pdfEvidence.textSha256, /^[0-9a-f]{64}$/);
        assert.match(correction.pdfEvidence.renderSha256, /^[0-9a-f]{64}$/);
    });

    it('has no remaining approved projection without a realizable numeric reference value', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const cases = [
            ['MAT_SHAPE_MEMORY', 2, 'SIG_ASS'],
            ['MAT_SHAPE_MEMORY', 2, 'SIG_ASF'],
            ['MAT_SHAPE_MEMORY', 2, 'SIG_SAS'],
            ['MAT_SHAPE_MEMORY', 2, 'SIG_SAF'],
            ['CONSTRAINED_LAGRANGE_IN_SOLID', 4, 'LCIDPOR'],
            ['CONSTRAINED_LAGRANGE_IN_SOLID', 6, 'A1'],
        ];
        for (const [keyword, cardIndex, fieldName] of cases) {
            const lookup = keywordSchema.lookupKeywordSchema(keyword, schema);
            const field = keywordSchema.getRenderedCards(
                lookup.entry, lookup.activeOptions,
            )[cardIndex - 1].find(candidate => candidate.n === fieldName);
            const retained = getActionableFieldReferenceInfo({ keyword, cardIndex, field });
            assert.equal(retained.definitionRegistry.approved, true, `${keyword}/${fieldName}`);
            assert.ok([-100, -1, 1, 100].some(value =>
                parseFieldReferenceValue(String(value), retained) !== null), `${keyword}/${fieldName}`);
        }
    });

    it('closes every unique runtime coordinate through geometry and approval gates', function () {
        this.timeout(10_000);
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const catalog = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const visited = new Set();
        let matchingGeometry = 0;
        let actionable = 0;
        for (const record of catalog.allReferenceRecords()) {
            const coordinate = [record.field.keyword, record.field.cardIndex,
                record.field.fieldIndex, record.field.fieldName, record.field.fieldType,
                record.field.position, record.field.width].join('|');
            if (visited.has(coordinate)) continue;
            visited.add(coordinate);
            const lookup = keywordSchema.lookupKeywordSchema(record.field.keyword, schema);
            const field = lookup && keywordSchema.getRenderedCardsForLookup(lookup)
                [record.field.cardIndex - 1]?.[record.field.fieldIndex];
            if (!field || field.n !== record.field.fieldName ||
                field.t !== record.field.fieldType || field.p !== record.field.position ||
                field.w !== record.field.width) continue;
            matchingGeometry++;
            const info = getActionableFieldReferenceInfo({
                keyword: record.field.keyword,
                cardIndex: record.field.cardIndex,
                field,
            });
            if (!info) continue;
            actionable++;
            assert.equal(info.definitionRegistry.approved, true, coordinate);
            assert.equal(info.definitionRegistry.operationalProjection.ambiguous, false, coordinate);
            assert.equal(isCoherentReferenceTargetNamespace(info), true, coordinate);
            assert.deepEqual(getRegistryApprovedFieldReferenceInfo({
                keyword: record.field.keyword,
                cardIndex: record.field.cardIndex,
                field,
            }), info, coordinate);
        }
        assert.equal(visited.size, 8879);
        assert.equal(matchingGeometry, 1781);
        assert.equal(actionable, 1160);
    });

    it('classifies every source projection with a deterministic blocker reason', function () {
        const aliasRows = [];

        this.timeout(20_000);
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const registry = require('../../../out/core/references/definitionRegistry')
            .getDefinitionRegistryCatalog();
        const normalizeType = type => type === 'real' ? 'float' : type;
        const visited = new Set();
        const missingKeywords = new Set();
        const reasons = new Map();
        let namespaceIncoherent = 0;
        let namespaceAmbiguousFirst = 0;
        const namespaceGroups = new Map();
        for (const record of runtime.allReferenceRecords()) {
            const source = record.field;
            const coordinate = [source.keyword, source.cardIndex, source.fieldIndex,
                source.fieldName, source.fieldType, source.position, source.width].join('|');
            if (visited.has(coordinate)) continue;
            visited.add(coordinate);
            const lookup = keywordSchema.lookupKeywordSchema(source.keyword, schema);
            let reason;
            if (!lookup) {
                reason = 'keyword-missing';
                missingKeywords.add(source.keyword);
            } else {
                const card = keywordSchema.getRenderedCardsForLookup(lookup)
                    [source.cardIndex - 1];
                const field = card?.[source.fieldIndex];
                if (!card) reason = 'card-missing';
                else if (!field) reason = 'slot-missing';
                else if (field.n !== source.fieldName) reason = 'field-name-mismatch';
                else if (normalizeType(field.t) !== normalizeType(source.fieldType)) {
                    reason = 'field-type-mismatch';
                    assert.deepEqual(lookup.activeOptions, [], coordinate);
                } else if (field.p !== source.position || field.w !== source.width) {
                    reason = 'field-geometry-mismatch';
                    assert.deepEqual(lookup.activeOptions, [], coordinate);
                } else {
                    const options = {
                        keyword: source.keyword, cardIndex: source.cardIndex, field,
                    };
                    const info = getFieldReferenceInfo(options);
                    if (info && !isCoherentReferenceTargetNamespace(info)) {
                        namespaceIncoherent++;
                        assert.deepEqual(lookup.activeOptions, [], coordinate);
                        if (info.definitionRegistry.operationalProjection?.ambiguous === true) {
                            namespaceAmbiguousFirst++;
                        } else {
                            const signature = JSON.stringify([
                                info.relation.kind,
                                info.relation.branches?.length || 0,
                                info.targetKinds,
                                info.targetDefinitions.map(keyword => [
                                    keyword,
                                    registry.definitionDescriptorForKeyword(keyword)?.targetKind || null,
                                ]),
                            ]);
                            namespaceGroups.set(signature, (namespaceGroups.get(signature) || 0) + 1);
                        }
                    }
                    if (getActionableFieldReferenceInfo(options)) reason = 'actionable-exact';
                    else if (!info) reason = 'no-reference-info';
                    else if (info.definitionRegistry?.approved !== true) reason = 'unapproved';
                    else if (info.definitionRegistry.operationalProjection?.ambiguous === true) {
                        reason = 'ambiguous';
                    } else if (!isCoherentReferenceTargetNamespace(info)) {
                        reason = 'namespace-incoherent';
                    } else if (field.di === 'self') reason = 'self-identity';
                    else {
                        const exactDefinition = registry.fieldRelations(
                            source.keyword, source.cardIndex, field,
                        ).some(item => item.kind === 'entity-definition');
                        const scannerDefinition = runtime.definitionScannersForKeyword(source.keyword)
                            .filter(item => item.permissions?.scan === true)
                            .some(item => {
                                const standard = (item.formatContracts || []).find(contract =>
                                    contract.format === 'standard' && contract.mode === 'fixed');
                                return item.physicalSelector?.dataRecordOrdinal === source.cardIndex - 1 &&
                                    item.definitionField === field.n && standard?.position === field.p &&
                                    standard?.width === field.w;
                            });
                        reason = exactDefinition || scannerDefinition
                            ? 'definition-collision' : 'predicate-or-manual-gate';
                    }
                }
            }
            if (aliasKeywords.has(source.keyword)) aliasRows.push({ coordinate, reason });
            reasons.set(reason, (reasons.get(reason) || 0) + 1);
        }
        assert.equal(visited.size, 8879);
        assert.equal(missingKeywords.size, 597);
        assert.deepEqual(Object.fromEntries(reasons), {
            "actionable-exact": 1277,
            "field-name-mismatch": 2691,
            "slot-missing": 815,
            "namespace-incoherent": 56,
            "keyword-missing": 2781,
            "card-missing": 189,
            "no-reference-info": 203,
            "ambiguous": 376,
            "field-type-mismatch": 385,
            "self-identity": 50,
            "field-geometry-mismatch": 53,
            "definition-collision": 2,
            "unapproved": 1
        });
        // Exact native definition selectors close 39 formerly incoherent ambiguous projections.
        assert.equal(namespaceIncoherent, 57);
        assert.equal(namespaceAmbiguousFirst, 1);
        assert.deepEqual(Object.fromEntries(namespaceGroups), {
            '["entity-reference",0,["set"],[["PART","part"],["SET_NODE_OPTION",null],["SET_PART","part-set"]]]': 20,
            '["entity-reference",0,["node","part","segment-set"],[["IGA_EDGE_UVW",null],["IGA_FACE_UVW",null],["IGA_FACE_XYZ",null],["IGA_POINT_UVW",null],["NODE",null],["PART","part"],["SET_IGA_EDGE_UVW","set"],["SET_IGA_FACE_UVW","set"],["SET_IGA_FACE_XYZ","set"],["SET_IGA_POINT_UVW","set"],["SET_NODE",null],["SET_SEGMENT",null]]]': 10,
            '["entity-reference",0,["multi-set"],[["SET_MULTI",null]]]': 8,
            '["entity-reference",0,["element-set"],[["SET_BEAM","set"],["SET_SHELL",null],["SET_SOLID",null],["SET_TSHELL",null]]]': 4,
            '["entity-reference",0,["part"],[["PART","part"],["SECTION_SOLID","section"]]]': 2,
            '["entity-reference",0,["part-set"],[["PART","part"],["SET_PART","part-set"]]]': 2,
            '["entity-reference",0,["element-set","node-set","part-set","segment-set"],[["PART","part"],["SET_NODE_OPTION",null],["SET_PART","part-set"],["SET_SEGMENT",null]]]': 2,
            '["entity-reference",0,["node","set"],[["NODE",null],["SET_NODE",null]]]': 2,
            '["value-branch",2,["set"],[["SET_MULTI",null]]]': 1,
            '["entity-reference",0,["set"],[["SET_NODE",null],["SET_SEGMENT",null]]]': 1,
            '["entity-reference",0,["element-set"],[["SECTION_ALE1D","section"],["SET_BEAM","set"]]]': 1,
            '["entity-reference",0,["part"],[["PART","part"],["SET_PART","part-set"]]]': 1,
            '["entity-reference",0,["part"],[["MAT_020",null],["PART","part"]]]': 1,
            '["entity-reference",0,["part"],[["MAT_020",null],["MAT_RIGID","material"],["PART","part"]]]': 1,
        });
        assert.deepEqual(aliasRows, numberedAliasContract.blockers);
    });

    it('separates option-card shifts from independent field-name drift without stale identity merges', function () {
        const aliasRows = [];

        this.timeout(20_000);
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const records = runtime.allReferenceRecords();
        const byCoordinate = new Map();
        const coordinateFor = source => [source.keyword, source.cardIndex, source.fieldIndex,
            source.fieldName, source.fieldType, source.position, source.width].join('|');
        for (const record of records) {
            const coordinate = coordinateFor(record.field);
            if (!byCoordinate.has(coordinate)) byCoordinate.set(coordinate, []);
            byCoordinate.get(coordinate).push(record);
        }

        const normalizeType = type => type === 'real' ? 'float' : type;
        const sourceMatches = (field, source) => field?.n === source.fieldName &&
            normalizeType(field.t) === normalizeType(source.fieldType) &&
            field.p === source.position && field.w === source.width;
        const visited = new Set();
        const categories = new Map();
        const mappedCategories = new Map();
        const optionSignatures = new Map();
        const unmappedOptionCaused = [];
        const mappedByKeyword = new Map();
        const sameRelationActionable = [];
        for (const record of records) {
            const source = record.field;
            const coordinate = coordinateFor(source);
            if (visited.has(coordinate)) continue;
            visited.add(coordinate);
            const lookup = keywordSchema.lookupKeywordSchema(source.keyword, schema);
            if (!lookup) continue;
            const product = keywordSchema.getRenderedCardsForLookup(lookup)
                [source.cardIndex - 1]?.[source.fieldIndex];
            if (!product || product.n === source.fieldName) continue;
            const selected = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions)
                [source.cardIndex - 1]?.[source.fieldIndex];
            const base = keywordSchema.getRenderedCards(lookup.entry, [])
                [source.cardIndex - 1]?.[source.fieldIndex];
            const category = lookup.activeOptions.length === 0
                ? selected?.n === product.n ? 'no-active-option' : 'verified-prefix-layout'
                : sourceMatches(base, source) && !sourceMatches(selected, source)
                    ? 'active-option-caused'
                    : selected?.n !== product.n ? 'verified-prefix-layout-with-option'
                        : 'mismatch-independent-of-option';
            if (aliasKeywords.has(source.keyword)) aliasRows.push({ coordinate, category });
            categories.set(category, (categories.get(category) || 0) + 1);
            const optionSignature = JSON.stringify(lookup.activeOptions);
            optionSignatures.set(optionSignature,
                (optionSignatures.get(optionSignature) || 0) + 1);
            const actionableAtRenderedCoordinate = getActionableFieldReferenceInfo({
                keyword: source.keyword,
                cardIndex: source.cardIndex,
                field: product,
            });
            if (actionableAtRenderedCoordinate) {
                const sourceRelationIds = new Set(byCoordinate.get(coordinate).map(candidate =>
                    candidate.authoringRelationId));
                if (sourceRelationIds.has(
                    actionableAtRenderedCoordinate.definitionRegistry.authoringRelationId,
                )) {
                    const selectorSource = actionableAtRenderedCoordinate
                        .definitionRegistry.selectorSource;
                    assert.equal(selectorSource, 'manual-semantic', coordinate);
                    sameRelationActionable.push(coordinate);
                }
            }

            if (!mappedByKeyword.has(source.keyword)) {
                mappedByKeyword.set(source.keyword,
                    buildRuntimeTableLayoutIndex(source.keyword, runtime));
            }
            const mappedRelationIds = new Set(
                [...mappedByKeyword.get(source.keyword).values()].flat()
                    .map(candidate => candidate.authoringRelationId),
            );
            const mapped = byCoordinate.get(coordinate).some(candidate =>
                mappedRelationIds.has(candidate.authoringRelationId));
            if (mapped) {
                mappedCategories.set(category, (mappedCategories.get(category) || 0) + 1);
            } else if (category === 'active-option-caused') {
                unmappedOptionCaused.push(coordinate);
                assert.ok(byCoordinate.get(coordinate).every(candidate =>
                    candidate.operationalProjection?.ambiguous === true), coordinate);
            }
        }
        assert.deepEqual(Object.fromEntries(categories), {
            "no-active-option": 2604,
            "mismatch-independent-of-option": 27,
            "active-option-caused": 28,
            "verified-prefix-layout-with-option": 32
        });
        assert.deepEqual(Object.fromEntries(optionSignatures), {
            "[]": 2604,
            "[\"ID\"]": 69,
            "[\"TITLE\"]": 18
        });
        assert.deepEqual(Object.fromEntries(mappedCategories), {
            "no-active-option": 1111,
            "active-option-caused": 26,
            "verified-prefix-layout-with-option": 7,
            "mismatch-independent-of-option": 6
        });
        assert.deepEqual(unmappedOptionCaused.sort(), [
            '*DATABASE_CROSS_SECTION_PLANE_ID|1|0|PSID|integer|0|10',
            '*DATABASE_CROSS_SECTION_SET_ID|1|0|NSID|integer|0|10',
        ]);
        assert.deepEqual(sameRelationActionable.sort(), [
            '*DEFINE_STAGED_CONSTRUCTION_PART|1|0|PID/PSID|integer|0|10',
            '*INITIAL_PWP_DEPTH|1|0|PID/PSID|integer|0|10',
            '*LOAD_REMOVE_PART|1|0|PID/PSID|integer|0|10',
            '*LOAD_STIFFEN_PART|1|0|PID/PSID|integer|0|10',
        ]);

        const physicalStatuses = new Map();
        for (const record of records) {
            const source = record.field;
            const physicalFieldId = record.operationalProjection?.physicalFieldId;
            if (!physicalFieldId) continue;
            const lookup = keywordSchema.lookupKeywordSchema(source.keyword, schema);
            const field = lookup && keywordSchema.getRenderedCardsForLookup(lookup)
                [source.cardIndex - 1]?.[source.fieldIndex];
            if (!field) continue;
            const status = field.n === source.fieldName ? 'exact' : 'field-name-mismatch';
            const key = JSON.stringify([source.keyword, physicalFieldId]);
            if (!physicalStatuses.has(key)) physicalStatuses.set(key, new Set());
            physicalStatuses.get(key).add(status);
        }
        assert.equal(physicalStatuses.size, 9078);
        assert.equal([...physicalStatuses.values()].filter(statuses =>
            statuses.has('exact') && statuses.has('field-name-mismatch')).length, 0);
        assert.deepEqual(aliasRows, numberedAliasContract.nameDrift);
    });

    it('separates option-caused card and slot shifts from independent table drift', function () {
        const aliasRows = [];

        this.timeout(20_000);
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const normalizeType = type => type === 'real' ? 'float' : type;
        const sourceMatches = (field, source) => field?.n === source.fieldName &&
            normalizeType(field.t) === normalizeType(source.fieldType) &&
            field.p === source.position && field.w === source.width;
        const coordinateFor = source => [source.keyword, source.cardIndex, source.fieldIndex,
            source.fieldName, source.fieldType, source.position, source.width].join('|');
        const records = runtime.allReferenceRecords();
        const byCoordinate = new Map();
        for (const record of records) {
            const coordinate = coordinateFor(record.field);
            if (!byCoordinate.has(coordinate)) byCoordinate.set(coordinate, []);
            byCoordinate.get(coordinate).push(record);
        }

        const visited = new Set();
        const categories = new Map();
        const optionSignatures = new Map();
        const mappedCategories = new Map();
        const uniqueSignatureCategories = new Map();
        const inactiveOptionCoordinates = [];
        const unmappedOptionCaused = [];
        const uniqueUnmapped = [];
        const directSourceExcluded = [];
        const mappedByKeyword = new Map();
        for (const record of records) {
            const source = record.field;
            const coordinate = coordinateFor(source);
            if (visited.has(coordinate)) continue;
            visited.add(coordinate);
            const lookup = keywordSchema.lookupKeywordSchema(source.keyword, schema);
            if (!lookup) continue;
            const productCards = keywordSchema.getRenderedCardsForLookup(lookup);
            const productCard = productCards[source.cardIndex - 1];
            if (productCard?.[source.fieldIndex]) continue;
            const baseCards = keywordSchema.getRenderedCards(lookup.entry, []);
            const selectedCards = keywordSchema.getRenderedCards(
                lookup.entry, lookup.activeOptions,
            );
            const base = baseCards[source.cardIndex - 1]?.[source.fieldIndex];
            const selected = selectedCards[source.cardIndex - 1]?.[source.fieldIndex];
            const reason = productCard ? 'slot-missing' : 'card-missing';
            const selectedState = !selectedCards[source.cardIndex - 1]
                ? 'card-missing' : !selected ? 'slot-missing' : 'present';
            const category = lookup.activeOptions.length === 0
                ? 'no-active-option'
                : sourceMatches(base, source) && !sourceMatches(selected, source)
                    ? 'active-option-caused'
                    : selectedState !== reason ? 'verified-prefix-layout-with-option'
                        : 'missing-independent-of-option';
            const bucket = `${reason}:${category}`;
            if (aliasKeywords.has(source.keyword)) aliasRows.push({ coordinate, bucket });
            categories.set(bucket, (categories.get(bucket) || 0) + 1);
            const optionSignature = JSON.stringify(lookup.activeOptions);
            optionSignatures.set(optionSignature,
                (optionSignatures.get(optionSignature) || 0) + 1);

            const matches = [];
            for (let cardOffset = 0; cardOffset < productCards.length; cardOffset++) {
                for (let fieldIndex = 0;
                    fieldIndex < productCards[cardOffset].length; fieldIndex++) {
                    if (sourceMatches(productCards[cardOffset][fieldIndex], source)) {
                        matches.push([cardOffset + 1, fieldIndex]);
                    }
                }
            }
            if (matches.length === 1) {
                uniqueSignatureCategories.set(bucket,
                    (uniqueSignatureCategories.get(bucket) || 0) + 1);
            }
            const inactive = (lookup.entry.o || []).filter(option =>
                !lookup.activeOptions.includes(String(option.n).toUpperCase()) &&
                (option.c || []).flat().some(field => sourceMatches(field, source)));
            if (inactive.length > 0) inactiveOptionCoordinates.push(coordinate);

            if (!mappedByKeyword.has(source.keyword)) {
                mappedByKeyword.set(source.keyword,
                    buildRuntimeTableLayoutIndex(source.keyword, runtime));
            }
            const mappedIds = new Set([...mappedByKeyword.get(source.keyword).values()].flat()
                .flatMap(candidate => [candidate.authoringRelationId,
                    ...(candidate.operationalProjection?.representationAuthoringRelationIds || []),
                    candidate.operationalProjection?.selectedAuthoringRelationId]));
            const excludedIds = new Set([...mappedByKeyword.get(source.keyword).values()].flat()
                .flatMap(candidate =>
                    candidate.operationalProjection?.excludedAuthoringRelationIds || []));
            const mapped = byCoordinate.get(coordinate).some(candidate =>
                mappedIds.has(candidate.authoringRelationId));
            if (mapped) {
                mappedCategories.set(bucket, (mappedCategories.get(bucket) || 0) + 1);
            } else if (byCoordinate.get(coordinate).every(candidate =>
                excludedIds.has(candidate.authoringRelationId))) {
                directSourceExcluded.push({
                    coordinate, records: byCoordinate.get(coordinate),
                });
            } else {
                if (category === 'active-option-caused') unmappedOptionCaused.push(coordinate);
                if (matches.length === 1) uniqueUnmapped.push({
                    coordinate, records: byCoordinate.get(coordinate),
                });
            }
        }

        assert.deepEqual(Object.fromEntries(categories), {
            "slot-missing:no-active-option": 725,
            "slot-missing:active-option-caused": 17,
            "card-missing:no-active-option": 189,
            "slot-missing:missing-independent-of-option": 73
        });
        assert.deepEqual(Object.fromEntries(optionSignatures), {
            "[]": 914,
            "[\"ID\"]": 34,
            "[\"TITLE\"]": 56
        });
        assert.deepEqual(Object.fromEntries(mappedCategories), {
            "slot-missing:no-active-option": 266,
            "slot-missing:active-option-caused": 17,
            "slot-missing:missing-independent-of-option": 32,
            "card-missing:no-active-option": 12
        });
        assert.deepEqual(Object.fromEntries(uniqueSignatureCategories), {
            "slot-missing:no-active-option": 259,
            "slot-missing:active-option-caused": 17,
            "slot-missing:missing-independent-of-option": 32,
            "card-missing:no-active-option": 20
        });
        assert.deepEqual(inactiveOptionCoordinates, []);
        assert.deepEqual(unmappedOptionCaused, []);

        assert.deepEqual(uniqueUnmapped, []);
        assert.equal(directSourceExcluded.length, 25);
        assert.deepEqual(Object.fromEntries([...directSourceExcluded.reduce((counts, item) => {
            const keyword = item.coordinate.split('|')[0];
            counts.set(keyword, (counts.get(keyword) || 0) + 1);
            return counts;
        }, new Map()).entries()].sort()), {
            '*CHANGE_VELOCITY': 4,
            '*DEFORMABLE_TO_RIGID': 10,
            '*FATIGUE': 11,
        });
        const previouslyUnresolved = new Set(directSourceExcluded.map(item => item.coordinate));
        for (const coordinate of [
            '*DEFORMABLE_TO_RIGID|16|0|PID|integer|0|10',
            '*DEFORMABLE_TO_RIGID|5|0|PID|integer|0|10',
            '*DEFORMABLE_TO_RIGID|8|0|PID|integer|0|10',
            '*DEFORMABLE_TO_RIGID|9|0|PID|integer|0|10',
            '*FATIGUE|16|0|PID|integer|0|10',
            '*FATIGUE|5|0|PID|integer|0|10',
            '*FATIGUE|8|0|PID|integer|0|10',
            '*FATIGUE|9|0|PID|integer|0|10',
        ]) assert.ok(previouslyUnresolved.has(coordinate), coordinate);
        for (const item of directSourceExcluded) {
            assert.ok(item.records.length > 0, item.coordinate);
            for (const record of item.records) {
                assert.equal(record.operationalProjection.ambiguous, true, item.coordinate);
                assert.equal(record.operationalProjection.strategy, 'global-field-name',
                    item.coordinate);
                if (item.coordinate.startsWith('*DEFORMABLE_TO_RIGID')) {
                    assert.equal(record.operationalProjection.candidateCount, 193);
                    assert.deepEqual(record.relation, {
                        kind: 'entity-reference',
                        targetKeywords: ['*PART'],
                        targetKinds: ['part'],
                    });
                    assert.equal(record.evidence[0].page, 2620);
                } else if (item.coordinate.startsWith('*FATIGUE')) {
                    assert.equal(record.operationalProjection.candidateCount, 193);
                    assert.deepEqual(record.relation, {
                        kind: 'entity-reference',
                        targetKinds: ['part-set'],
                    });
                    assert.equal(record.evidence[0].page, 2778);
                } else {
                    assert.equal(record.operationalProjection.candidateCount, 45);
                    assert.deepEqual(record.relation, {
                        kind: 'entity-reference',
                        targetKinds: ['set'],
                    });
                    assert.equal(record.evidence[0].page, 4032);
                }
            }
        }
        const deformable = keywordSchema.lookupKeywordSchema(
            '*DEFORMABLE_TO_RIGID', schema,
        );
        assert.deepEqual(deformable.entry.c[0].find(field => field.n === 'PTYPE').e,
            ['PART', 'PSET']);
        const fatigue = keywordSchema.lookupKeywordSchema('*FATIGUE', schema);
        assert.deepEqual(fatigue.entry.c[0].find(field => field.n === 'PTYPE').e,
            ['0', '1', '2', '3', '4', '5']);
        assert.deepEqual(aliasRows, numberedAliasContract.missingSlots);
    });

    it('keeps the only same-rule exact/name mixed coordinates grouped and ambiguous', function () {
        this.timeout(10_000);
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const groups = new Map();
        for (const record of runtime.allReferenceRecords()) {
            const source = record.field;
            const key = JSON.stringify([
                source.keyword, source.cardIndex, source.fieldIndex,
                source.position, source.width, record.sourceRuleId,
            ]);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(record);
        }
        const mixed = [];
        for (const [key, records] of groups) {
            const statuses = new Set(records.map(record => {
                const source = record.field;
                const lookup = keywordSchema.lookupKeywordSchema(source.keyword, schema);
                const field = lookup && keywordSchema.getRenderedCardsForLookup(lookup)
                    [source.cardIndex - 1]?.[source.fieldIndex];
                if (!field) return 'missing';
                return field.n === source.fieldName ? 'exact' : 'field-name-mismatch';
            }));
            if (statuses.has('exact') && statuses.has('field-name-mismatch')) {
                mixed.push({ key: JSON.parse(key), records });
            }
        }
        assert.deepEqual(mixed.map(item => item.key), [
            ['*RAIL_TRACK', 1, 3, 30, 10, 'rule:5c633032331507c3dac686d4'],
            ['*RAIL_TRACK', 1, 1, 10, 10, 'rule:eb296f92cb77142d99a36d47'],
        ]);
        assert.deepEqual(mixed.map(item => item.records.map(record =>
            record.field.fieldName)), [
            ['LCUR2', 'LCUR1'],
            ['BSETID1', 'BSETID2'],
        ]);
        for (const { records } of mixed) {
            assert.equal(new Set(records.map(record => record.manualRelationId)).size, 1);
            assert.equal(new Set(records.map(record => record.summary)).size, 1);
            assert.equal(new Set(records.map(record =>
                record.evidence[0]?.quoteSha256)).size, 1);
            assert.equal(new Set(records.map(record =>
                record.operationalProjection.physicalFieldId)).size, 2);
            assert.equal(new Set(records.map(record =>
                record.operationalProjection.physicalTableId)).size, 2);
            assert.ok(records.every(record =>
                record.operationalProjection.ambiguous === true &&
                record.operationalProjection.candidateCount === 2));
        }

        const lookup = keywordSchema.lookupKeywordSchema('*RAIL_TRACK', schema);
        const cards = keywordSchema.getRenderedCardsForLookup(lookup);
        assert.deepEqual(cards.map(card => card.map(field => field.n)), [
            ['ID', 'BSETID1', 'NORGN1', 'LCUR1', 'OSET1', 'SF1', 'GA1', 'IDIR'],
            ['UNUSED', 'BSETID2', 'NORGN2', 'LCUR2', 'OSET2', 'SF2', 'GA2'],
        ]);
        assert.deepEqual([...buildRuntimeTableLayoutIndex('*RAIL_TRACK', runtime).keys()]
            .map(key => JSON.parse(key)), [
            [2, 'LCUR2', 'integer', 30, 10],
            [2, 'BSETID2', 'integer', 10, 10],
        ]);
        for (const [cardOffset, fieldName] of [
            [0, 'BSETID1'], [0, 'LCUR1'], [1, 'BSETID2'], [1, 'LCUR2'],
        ]) {
            const field = cards[cardOffset].find(candidate => candidate.n === fieldName);
            const options = { keyword: '*RAIL_TRACK', cardIndex: cardOffset + 1, field };
            assert.equal(getFieldReferenceInfo(options)
                .definitionRegistry.operationalProjection.ambiguous, true, fieldName);
            assert.equal(getActionableFieldReferenceInfo(options), null, fieldName);
        }
    });

    it('classifies every remaining pure geometry mismatch as an option-free I8 schema card', function () {
        this.timeout(10_000); // Checks the complete reference catalog, rather than one interactive query.
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const catalog = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const visited = new Set();
        let mismatches = 0;
        let manualSemantic = 0;
        let representationMismatches = 0;
        const crossTypeRepresentation = [];
        for (const record of catalog.allReferenceRecords()) {
            const source = record.field;
            const coordinate = [source.keyword, source.cardIndex, source.fieldIndex,
                source.fieldName, source.fieldType, source.position, source.width].join('|');
            if (visited.has(coordinate)) continue;
            visited.add(coordinate);
            const lookup = keywordSchema.lookupKeywordSchema(source.keyword, schema);
            const field = lookup && keywordSchema.getRenderedCardsForLookup(lookup)
                [source.cardIndex - 1]?.[source.fieldIndex];
            const normalizedFieldType = field?.t === 'real' ? 'float' : field?.t;
            if (field && field.n === source.fieldName &&
                normalizedFieldType === source.fieldType &&
                (field.p !== source.position || field.w !== source.width)) {
                representationMismatches++;
                assert.deepEqual(lookup.activeOptions, [], coordinate);
                if (field.t !== source.fieldType) crossTypeRepresentation.push(coordinate);
            }
            if (!field || field.n !== source.fieldName || field.t !== source.fieldType ||
                field.p === source.position && field.w === source.width) continue;
            mismatches++;
            assert.deepEqual(lookup.activeOptions, [], coordinate);
            assert.equal(source.width, 10, coordinate);
            assert.equal(field.w, 8, coordinate);
            const info = getActionableFieldReferenceInfo({
                keyword: source.keyword, cardIndex: source.cardIndex, field,
            });
            if (info) {
                manualSemantic++;
                assert.equal(info.definitionRegistry.selectorSource, 'manual-semantic', coordinate);
            }
        }
        assert.equal(mismatches, 50);
        assert.equal(manualSemantic, 21);
        assert.equal(representationMismatches, 53);
        assert.deepEqual(crossTypeRepresentation.sort(), [
            '*PART_MOVE|1|1|XMOV|float|10|10',
            '*PART_MOVE|1|2|YMOV|float|20|10',
            '*PART_MOVE|1|3|ZMOV|float|30|10',
        ]);
    });

    it('maps only complete source-locked physical tables across card ordinal drift', () => {
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const keyword = '*DUALCESE_BOUNDARY_PRESCRIBED_HYBRID_SEGMENT_SET';
        const records = runtime.referenceRecordsForKeyword(keyword);
        const mapped = buildRuntimeTableLayoutIndex(keyword, runtime);
        assert.equal(mapped.size, 10);
        assert.deepEqual([...mapped.keys()].map(key => JSON.parse(key))
            .sort((left, right) => left[0] - right[0] || left[3] - right[3]), [
            [2, 'LC_Z1', 'integer', 0, 10],
            [2, 'LC_RA', 'integer', 10, 10],
            [2, 'LC_U', 'integer', 20, 10],
            [2, 'LC_V', 'integer', 30, 10],
            [2, 'LC_W', 'integer', 40, 10],
            [2, 'LC_D1', 'integer', 50, 10],
            [2, 'LC_DA', 'integer', 60, 10],
            [2, 'LC_DB', 'integer', 70, 10],
            [3, 'LC_P', 'integer', 0, 10],
            [3, 'LC_T', 'integer', 10, 10],
        ]);
        assert.ok([...mapped.values()].flat().every(record => record.field.cardIndex === 1));

        const drifted = structuredClone(records);
        drifted.find(record => record.operationalProjection?.physicalTableId ===
            'global-manual-card-grid:71077a9cf097072caa044a9c').field.width += 1;
        assert.equal(buildRuntimeTableLayoutIndex(keyword, {
            referenceRecordsForKeyword: () => drifted,
        }).size, 8);

        const competing = [...structuredClone(records), ...structuredClone(records).map(record => ({
            ...record,
            operationalProjection: record.operationalProjection?.physicalTableId ===
                'global-manual-card-grid:71077a9cf097072caa044a9c'
                ? { ...record.operationalProjection,
                    physicalTableId: 'global-manual-card-grid:000000000000000000000000' }
                : record.operationalProjection,
        }))];
        assert.equal(buildRuntimeTableLayoutIndex(keyword, {
            referenceRecordsForKeyword: () => competing,
        }).size, 8);
    });

    it('maps an incomplete table only through one noncompeting physical field identity', () => {
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const keyword = '*ALE_STRUCTURED_FSI';
        const records = runtime.referenceRecordsForKeyword(keyword);
        const targetKey = JSON.stringify([2, 'LSTRSID', 'integer', 0, 10]);
        const mapped = buildRuntimeTableLayoutIndex(keyword, runtime);
        assert.equal(mapped.get(targetKey).length, 1);
        assert.equal(mapped.get(targetKey)[0].operationalProjection.physicalFieldId,
            'global-manual-physical-field:d5e849b035e6010feffeb650');

        const drifted = structuredClone(records);
        drifted.find(record => record.operationalProjection?.physicalFieldId ===
            'global-manual-physical-field:d5e849b035e6010feffeb650').field.width += 1;
        assert.equal(buildRuntimeTableLayoutIndex(keyword, {
            referenceRecordsForKeyword: () => drifted,
        }).has(targetKey), false);

        const competing = structuredClone(records);
        const duplicate = structuredClone(competing.find(record =>
            record.operationalProjection?.physicalFieldId ===
                'global-manual-physical-field:d5e849b035e6010feffeb650'));
        duplicate.operationalProjection.physicalFieldId =
            'global-manual-physical-field:000000000000000000000000';
        competing.push(duplicate);
        assert.equal(buildRuntimeTableLayoutIndex(keyword, {
            referenceRecordsForKeyword: () => competing,
        }).has(targetKey), false);
    });

    it('collapses only the three source-locked duplicate manual table representations', () => {
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const groups = runtimeTableLayoutCorrections.duplicateTableRepresentations;
        assert.equal(groups.length, 3);

        for (const group of groups) {
            const targetKey = JSON.stringify([group.target.cardIndex,
                group.target.fieldName, group.target.fieldType,
                group.target.position, group.target.width]);
            const mapped = buildRuntimeTableLayoutIndex(group.keyword, runtime);
            const records = mapped.get(targetKey);
            assert.equal(records.length, 1, group.id);
            assert.equal(records[0].authoringRelationId, group.id);
            assert.equal(records[0].operationalProjection.ambiguous, false);
            assert.equal(records[0].operationalProjection.candidateCount, 1);
            assert.deepEqual(records[0].operationalProjection
                .representationAuthoringRelationIds,
            group.representations.map(item => item.authoringRelationId));

            const lookup = keywordSchema.lookupKeywordSchema(group.keyword, schema);
            const field = keywordSchema.getRenderedCardsForLookup(lookup)
                [group.target.cardIndex - 1][group.target.fieldIndex];
            assert.deepEqual({ n: field.n, t: field.t, p: field.p, w: field.w }, {
                n: group.target.fieldName,
                t: group.target.fieldType,
                p: group.target.position,
                w: group.target.width,
            });
            const info = getFieldReferenceInfo({
                keyword: group.keyword,
                cardIndex: group.target.cardIndex,
                field,
            });
            assert.equal(info.definitionRegistry.authoringRelationId, group.id);
            assert.equal(info.definitionRegistry.selectorSource, 'operational-projection');

            const sourceRecords = runtime.referenceRecordsForKeyword(group.keyword);
            const hasTarget = candidates => buildRuntimeTableLayoutIndex(group.keyword, {
                referenceRecordsForKeyword: () => candidates,
            }).has(targetKey);
            assert.equal(hasTarget(sourceRecords.filter(record =>
                record.authoringRelationId !== group.representations[0].authoringRelationId)),
            false, `${group.id}:missing`);
            const duplicate = structuredClone(sourceRecords.find(record =>
                record.authoringRelationId === group.representations[0].authoringRelationId));
            assert.equal(hasTarget([...sourceRecords, duplicate]), false, `${group.id}:third`);

            const mutations = [
                record => { record.sourceRuleId = 'rule:drift'; },
                record => { record.field.width += 1; },
                record => { record.relation.targetKinds = ['drift']; },
                record => { record.operationalProjection.physicalTableId =
                    'global-manual-card-grid:000000000000000000000000'; },
                record => { record.operationalProjection.physicalFieldId =
                    'global-manual-physical-field:000000000000000000000000'; },
                record => { record.operationalProjection.sectionId = 'drift'; },
                record => { record.operationalProjection.sourceSelectorKeyword = '*DRIFT'; },
                record => { record.operationalProjection.projectedSourceKeyword = '*DRIFT'; },
                record => { record.operationalProjection.sourceKeywordStrategy = 'drift'; },
                record => { record.operationalProjection.strategy = 'drift'; },
                record => { record.operationalProjection.ambiguous = false; },
                record => { record.operationalProjection.candidateCount += 1; },
            ];
            for (const [index, mutate] of mutations.entries()) {
                const drifted = structuredClone(sourceRecords);
                const record = drifted.find(candidate => candidate.authoringRelationId ===
                    group.representations[0].authoringRelationId);
                mutate(record);
                assert.equal(hasTarget(drifted), false, `${group.id}:mutation-${index}`);
            }
        }

        const registryDrift = structuredClone(runtimeTableLayoutCorrections);
        registryDrift.duplicateTableRepresentations[0].representations[0]
            .rawTableSha256 = '0'.repeat(64);
        for (const group of groups) {
            const targetKey = JSON.stringify([group.target.cardIndex,
                group.target.fieldName, group.target.fieldType,
                group.target.position, group.target.width]);
            assert.equal(buildRuntimeTableLayoutIndex(group.keyword, runtime, registryDrift)
                .has(targetKey), false, `${group.id}:registry-drift`);
        }
    });

    it('selects PART_COMPOSITE Card 3a HGID only for the exact base option state', () => {
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const selection = runtimeTableLayoutCorrections.optionTableSelections[0];
        assert.equal(runtimeTableLayoutCorrections.optionTableSelections.length, 1);
        assert.deepEqual(selection.activeOptions, []);
        assert.equal(selection.selected.cardLabel, 'Card 3a');
        assert.equal(selection.excluded[0].cardLabel, 'Card 3b');

        const targetKey = JSON.stringify([selection.target.cardIndex,
            selection.target.fieldName, selection.target.fieldType,
            selection.target.position, selection.target.width]);
        const pidKey = JSON.stringify([2, 'PID', 'integer', 0, 10]);
        const mapped = buildRuntimeTableLayoutIndex(selection.keyword, runtime);
        assert.equal(mapped.get(targetKey).length, 1);
        assert.equal(mapped.get(targetKey)[0].authoringRelationId, selection.id);
        assert.equal(mapped.has(pidKey), false,
            'selecting HGID must not make Card 3c PID the only remaining candidate');

        const lookup = keywordSchema.lookupKeywordSchema(selection.keyword, schema);
        assert.deepEqual(lookup.activeOptions, []);
        const field = keywordSchema.getRenderedCardsForLookup(lookup)
            [selection.target.cardIndex - 1][selection.target.fieldIndex];
        assert.deepEqual({ n: field.n, t: field.t, p: field.p, w: field.w }, {
            n: 'HGID', t: 'integer', p: 50, w: 10,
        });
        const info = getActionableFieldReferenceInfo({
            keyword: selection.keyword,
            cardIndex: selection.target.cardIndex,
            field,
        });
        assert.equal(info.definitionRegistry.authoringRelationId, selection.id);
        assert.equal(info.definitionRegistry.operationalProjection.selectedPhysicalTableId,
            selection.selected.physicalTableId);
        assert.deepEqual(info.definitionRegistry.operationalProjection.excludedPhysicalTableIds,
            selection.excluded.map(item => item.physicalTableId));
        assert.deepEqual(info.targetDefinitions, ['HOURGLASS']);

        const sourceRecords = runtime.referenceRecordsForKeyword(selection.keyword);
        const hasTarget = candidates => buildRuntimeTableLayoutIndex(selection.keyword, {
            referenceRecordsForKeyword: () => candidates,
        }).has(targetKey);
        assert.equal(hasTarget(sourceRecords.filter(record =>
            record.authoringRelationId !== selection.selected.authoringRelationId)), false);
        const duplicate = structuredClone(sourceRecords.find(record =>
            record.authoringRelationId === selection.selected.authoringRelationId));
        assert.equal(hasTarget([...sourceRecords, duplicate]), false);

        const mutations = [
            record => { record.sourceRuleId = 'rule:drift'; },
            record => { record.field.width += 1; },
            record => { record.relation.targetKeywords = ['*DRIFT']; },
            record => { record.operationalProjection.physicalTableId =
                'global-manual-card-grid:000000000000000000000000'; },
            record => { record.operationalProjection.physicalFieldId =
                'global-manual-physical-field:000000000000000000000000'; },
            record => { record.operationalProjection.sectionId = 'drift'; },
            record => { record.operationalProjection.sourceSelectorKeyword = '*DRIFT'; },
            record => { record.operationalProjection.projectedSourceKeyword = '*DRIFT'; },
            record => { record.operationalProjection.sourceKeywordStrategy = 'drift'; },
            record => { record.operationalProjection.strategy = 'drift'; },
            record => { record.operationalProjection.ambiguous = false; },
            record => { record.operationalProjection.candidateCount += 1; },
        ];
        for (const [index, mutate] of mutations.entries()) {
            const drifted = structuredClone(sourceRecords);
            const record = drifted.find(candidate => candidate.authoringRelationId ===
                selection.selected.authoringRelationId);
            mutate(record);
            assert.equal(hasTarget(drifted), false, `selection-mutation-${index}`);
            assert.equal(buildRuntimeTableLayoutIndex(selection.keyword, {
                referenceRecordsForKeyword: () => drifted,
            }).has(pidKey), false, `pid-leak-${index}`);
        }

        const registryDrift = structuredClone(runtimeTableLayoutCorrections);
        registryDrift.optionTableSelections[0].activeOptions = ['TSHELL'];
        assert.equal(buildRuntimeTableLayoutIndex(selection.keyword, runtime, registryDrift)
            .has(targetKey), false);
    });

    it('selects exact direct source fields and closes every enumerated target binding', function () {
        this.timeout(10_000);
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const selections = runtimeTableLayoutCorrections.directSourceFieldSelections;
        assert.equal(selections.length, 3);
        assert.deepEqual(selections.map(item => item.keyword), [
            '*DEFORMABLE_TO_RIGID', '*FATIGUE', '*CHANGE_VELOCITY',
        ]);
        for (const selection of selections) {
            const key = JSON.stringify([selection.target.cardIndex,
                selection.target.fieldName, selection.target.fieldType,
                selection.target.position, selection.target.width]);
            const mapped = buildRuntimeTableLayoutIndex(selection.keyword, runtime);
            assert.equal(mapped.size, 1, selection.id);
            assert.equal(mapped.get(key).length, 1, selection.id);
            const record = mapped.get(key)[0];
            assert.equal(record.authoringRelationId, selection.id);
            assert.equal(record.operationalProjection.selectedAuthoringRelationId,
                selection.selectedAuthoringRelationId);
            assert.equal(record.operationalProjection.selectedPhysicalTableId,
                selection.physicalTableId);
            assert.equal(record.operationalProjection.selectedPhysicalFieldId,
                selection.physicalFieldId);
            assert.equal(record.operationalProjection.excludedAuthoringRelationIds.length,
                selection.candidateCount - 1);
            const bindingApproved = ['exact-target-keyword-approved',
                'sibling-discriminator-approved'].includes(selection.targetBindingStatus);
            assert.equal(record.operationalProjection.targetBindingComplete, bindingApproved);
            assert.equal(record.operationalProjection.targetBindingStatus,
                selection.targetBindingStatus);

            const lookup = keywordSchema.lookupKeywordSchema(selection.keyword, schema);
            const field = keywordSchema.getRenderedCardsForLookup(lookup)
                [selection.target.cardIndex - 1][selection.target.fieldIndex];
            assert.deepEqual({ n: field.n, t: field.t, p: field.p, w: field.w }, {
                n: selection.target.fieldName,
                t: selection.target.fieldType,
                p: selection.target.position,
                w: selection.target.width,
            });
            const info = getActionableFieldReferenceInfo({
                keyword: selection.keyword,
                cardIndex: selection.target.cardIndex,
                field,
            });
            if (bindingApproved) {
                assert.equal(info.definitionRegistry.authoringRelationId, selection.id);
                if (selection.targetBindingStatus === 'sibling-discriminator-approved') {
                    assert.deepEqual(info.targetKinds,
                        selection.keyword === '*DEFORMABLE_TO_RIGID'
                            ? ['part', 'part-set'] : ['part', 'part-set', 'set']);
                    assert.deepEqual(info.targetDefinitions, selection.targetBinding.branches
                        .map(branch => branch.relation.targetKeywords[0].slice(1)));
                    assert.deepEqual(
                        info.definitionRegistry.operationalProjection.siblingTargetBinding,
                        selection.targetBinding,
                    );
                } else {
                    assert.deepEqual(info.targetKinds, ['node-set']);
                    assert.deepEqual(info.targetDefinitions, ['SET_NODE']);
                }
            } else {
                assert.equal(info, null, `${selection.id}:target binding must remain fail-closed`);
            }

            const sourceRecords = runtime.referenceRecordsForKeyword(selection.keyword);
            const hasTarget = candidates => buildRuntimeTableLayoutIndex(selection.keyword, {
                referenceRecordsForKeyword: () => candidates,
            }).has(key);
            assert.equal(hasTarget(sourceRecords.filter(candidate =>
                candidate.authoringRelationId !== selection.selectedAuthoringRelationId)), false);
            const duplicate = structuredClone(sourceRecords.find(candidate =>
                candidate.authoringRelationId === selection.selectedAuthoringRelationId));
            assert.equal(hasTarget([...sourceRecords, duplicate]), false);
            const selectedMutations = [
                candidate => { candidate.sourceRuleId = 'rule:drift'; },
                candidate => { candidate.manualRelationId = 'manual-relation:drift'; },
                candidate => { candidate.field.width += 1; },
                candidate => { candidate.relation.targetKinds = ['drift']; },
                candidate => { candidate.operationalProjection.physicalTableId = 'drift'; },
                candidate => { candidate.operationalProjection.physicalFieldId = 'drift'; },
                candidate => { candidate.operationalProjection.sectionId = 'drift'; },
                candidate => { candidate.operationalProjection.sourceSelectorKeyword = '*DRIFT'; },
                candidate => { candidate.operationalProjection.projectedSourceKeyword = '*DRIFT'; },
                candidate => { candidate.operationalProjection.sourceKeywordStrategy = 'drift'; },
                candidate => { candidate.operationalProjection.strategy = 'drift'; },
                candidate => { candidate.operationalProjection.ambiguous = false; },
                candidate => { candidate.operationalProjection.candidateCount += 1; },
            ];
            for (const [index, mutate] of selectedMutations.entries()) {
                const drifted = structuredClone(sourceRecords);
                mutate(drifted.find(candidate => candidate.authoringRelationId ===
                    selection.selectedAuthoringRelationId));
                assert.equal(hasTarget(drifted), false, `${selection.id}:mutation-${index}`);
            }
            const peerDrift = structuredClone(sourceRecords);
            peerDrift.find(candidate => candidate.sourceRuleId === selection.sourceRuleId &&
                candidate.authoringRelationId !== selection.selectedAuthoringRelationId)
                .relation = { kind: 'entity-reference' };
            assert.equal(hasTarget(peerDrift), false, `${selection.id}:peer-drift`);
        }
        assert.deepEqual(selections.filter(selection =>
            selection.targetBindingStatus.endsWith('-required')), []);

        const registryDrift = structuredClone(runtimeTableLayoutCorrections);
        registryDrift.directSourceFieldSelections[0].rawTableSha256 = '0'.repeat(64);
        for (const selection of selections) {
            const key = JSON.stringify([selection.target.cardIndex,
                selection.target.fieldName, selection.target.fieldType,
                selection.target.position, selection.target.width]);
            assert.equal(buildRuntimeTableLayoutIndex(selection.keyword, runtime, registryDrift)
                .has(key), false, `${selection.id}:registry-drift`);
        }
    });

    it('keeps every inactive ID-option-only projection out of the base keyword', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const visited = new Set();
        let optionOnly = 0;
        for (const record of runtime.allReferenceRecords()) {
            const source = record.field;
            const coordinate = [source.keyword, source.cardIndex, source.fieldIndex,
                source.fieldName, source.fieldType, source.position, source.width].join('|');
            if (visited.has(coordinate)) continue;
            visited.add(coordinate);
            const lookup = keywordSchema.lookupKeywordSchema(source.keyword, schema);
            if (!lookup) continue;
            const sourceSignature = [source.fieldName, source.fieldType,
                source.position, source.width].join('|').toUpperCase();
            const inactive = (lookup.entry.o || []).filter(option =>
                !lookup.activeOptions.includes(String(option.n).toUpperCase()) &&
                (option.c || []).flat().some(field =>
                    [field.n, field.t === 'real' ? 'float' : field.t,
                        field.p, field.w].join('|').toUpperCase() === sourceSignature
                ));
            if (inactive.length === 0) continue;
            optionOnly++;
            assert.deepEqual(inactive.map(option => option.n), ['ID'], coordinate);
            const rendered = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions);
            const field = rendered[source.cardIndex - 1]?.[source.fieldIndex];
            assert.equal(getActionableFieldReferenceInfo({
                keyword: source.keyword,
                cardIndex: source.cardIndex,
                field,
            }), null, coordinate);
        }
        assert.equal(optionOnly, 14);
    });

    it('audits the source-locked physical layout remap inventory', function () {
        const aliasRows = [];

        this.timeout(10_000);
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const keywords = new Set(runtime.allReferenceRecords().map(record => record.field.keyword));
        let mappedKeywords = 0;
        let mappedFields = 0;
        for (const keyword of keywords) {
            const mapped = buildRuntimeTableLayoutIndex(keyword, runtime);
            if (mapped.size === 0) continue;
            if (aliasKeywords.has(keyword)) aliasRows.push({ keyword, keys: [...mapped.keys()] });
            mappedKeywords++;
            mappedFields += mapped.size;
            for (const [key, records] of mapped) {
                const [cardIndex, fieldName, fieldType, position, width] = JSON.parse(key);
                assert.ok(records.length > 0, key);
                assert.equal(new Set(records.map(record =>
                    record.operationalProjection.physicalTableId)).size, 1, key);
                assert.ok(records.every(record => {
                    const equivalence = runtimeTableLayoutCorrections
                        .duplicateTableRepresentations.find(item =>
                            item.id === record.authoringRelationId);
                    if (equivalence) {
                        assert.equal(record.operationalProjection.physicalTableId,
                            equivalence.id);
                        assert.equal(record.operationalProjection.physicalFieldId,
                            equivalence.id);
                        assert.deepEqual(record.operationalProjection
                            .representationAuthoringRelationIds,
                        equivalence.representations.map(item => item.authoringRelationId));
                        assert.deepEqual(record.operationalProjection
                            .representationPhysicalTableIds,
                        equivalence.representations.map(item => item.physicalTableId));
                        assert.deepEqual(record.operationalProjection
                            .representationPhysicalFieldIds,
                        equivalence.representations.map(item => item.physicalFieldId));
                        return record.field.cardIndex === cardIndex &&
                            record.field.fieldName === fieldName &&
                            record.field.fieldType === fieldType &&
                            record.field.position === position && record.field.width === width;
                    }
                    const optionSelection = runtimeTableLayoutCorrections
                        .optionTableSelections.find(item =>
                            item.id === record.authoringRelationId);
                    if (optionSelection) {
                        assert.equal(record.operationalProjection.physicalTableId,
                            optionSelection.id);
                        assert.equal(record.operationalProjection.physicalFieldId,
                            optionSelection.id);
                        assert.equal(record.operationalProjection.selectedAuthoringRelationId,
                            optionSelection.selected.authoringRelationId);
                        assert.equal(record.operationalProjection.selectedPhysicalTableId,
                            optionSelection.selected.physicalTableId);
                        assert.deepEqual(record.operationalProjection.excludedAuthoringRelationIds,
                            optionSelection.excluded.map(item => item.authoringRelationId));
                        return record.field.cardIndex === cardIndex &&
                            record.field.fieldName === fieldName &&
                            record.field.fieldType === fieldType &&
                            record.field.position === position && record.field.width === width;
                    }
                    const directSelection = runtimeTableLayoutCorrections
                        .directSourceFieldSelections.find(item =>
                            item.id === record.authoringRelationId);
                    if (directSelection) {
                        assert.equal(record.operationalProjection.physicalTableId,
                            directSelection.id);
                        assert.equal(record.operationalProjection.physicalFieldId,
                            directSelection.id);
                        assert.equal(record.operationalProjection.selectedAuthoringRelationId,
                            directSelection.selectedAuthoringRelationId);
                        assert.equal(record.operationalProjection.targetBindingComplete,
                            ['exact-target-keyword-approved',
                                'sibling-discriminator-approved']
                                .includes(directSelection.targetBindingStatus));
                        assert.equal(record.operationalProjection.targetBindingStatus,
                            directSelection.targetBindingStatus);
                        return record.field.cardIndex === cardIndex &&
                            record.field.fieldName === fieldName &&
                            record.field.fieldType === fieldType &&
                            record.field.position === position && record.field.width === width;
                    }
                    const correction = runtimeTableLayoutCorrections.corrections.find(item =>
                        item.authoringRelationId === record.authoringRelationId);
                    if (correction) {
                        assert.deepEqual({
                            cardIndex: record.field.cardIndex,
                            cardFieldCount: record.field.cardFieldCount,
                            fieldIndex: record.field.fieldIndex,
                            fieldName: record.field.fieldName,
                            fieldType: record.field.fieldType,
                            position: record.field.position,
                            width: record.field.width,
                        }, correction.from, record.authoringRelationId);
                        assert.equal(record.sourceRuleId, correction.sourceRuleId);
                        assert.equal(record.operationalProjection.physicalTableId,
                            correction.physicalTableId);
                        assert.equal(record.operationalProjection.physicalFieldId,
                            correction.physicalFieldId);
                    }
                    const selector = correction ? { ...record.field, ...correction.to } : record.field;
                    return selector.cardIndex !== cardIndex && selector.fieldName === fieldName &&
                        (selector.fieldType === fieldType ||
                            selector.fieldType === 'float' && fieldType === 'real') &&
                        selector.position === position && selector.width === width;
                }), key);
            }
        }
        assert.equal(mappedKeywords, 472);
        assert.equal(mappedFields, 1479);
        assert.deepEqual(aliasRows, numberedAliasContract.remapped);
    });

    it('applies only the source-locked complete-table corrections and concrete family scope', () => {
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        assert.equal(runtimeTableLayoutCorrections.corrections.length, 8);
        assert.deepEqual(runtimeTableLayoutCorrections.permissions, {
            completeTableLayoutCorrection: true,
            concreteFamilyTableScope: true,
            duplicateTableRepresentationEquivalence: true,
            optionTableSelection: true,
            directSourceFieldSelection: true,
            exactTargetBindingApproval: true,
            siblingTargetBindingApproval: true,
            singleFieldFallback: false,
            newRelationApproval: false,
            targetNamespaceMutation: false,
            predicateMutation: false,
            optionMutation: false,
            automaticValueMutation: false,
        });
        assert.deepEqual(runtimeTableLayoutCorrections.layoutUniverseSource, {
            manifestFileSha256: '920c869a762d37d3babdc4d519f55b4e2f7b5dfed5631491cbe88f11ea4822dd',
            manifestContentSha256: '01addcc609d932948df8ae1f21130babec6e0f3ccc9ae521680e22f27e160998',
            manifestSize: 14456,
        });
        assert.deepEqual(runtimeTableLayoutCorrections.sources.map(source => ({
            manualId: source.manualId,
            pages: source.pages.map(page => page.physicalPage),
        })), [{
            manualId: 'ls-dyna-dev-keyword-manual-vol-i',
            pages: [2019, 2020, 2022, 2023, 3298, 3619, 3621, 3622, 3623, 3624,
                2620, 2778, 4032],
        }, {
            manualId: 'ls-dyna-dev-keyword-manual-vol-iii-multiphysics-solvers',
            pages: [193, 194, 358, 359, 360],
        }]);
        assert.deepEqual(runtimeTableLayoutCorrections.tableScopes.map(scope => ({
            keyword: scope.keyword,
            physicalTableId: scope.physicalTableId,
            sourceSelectorKeyword: scope.sourceSelectorKeyword,
            relations: scope.records.map(record => record.authoringRelationId),
        })), [{
            keyword: '*DUALCESE_POINT_SOURCE',
            physicalTableId: 'global-manual-card-grid:71d6c0132babff2c36b9efc2',
            sourceSelectorKeyword: '*DUALCESE_POINT_SOURCE',
            relations: [
                'authoring-relation:6882b2732c37646e8e8807d9',
                'authoring-relation:0c11510c3b04747265c6232f',
                'authoring-relation:45c54e1ae0110d4343f2962c',
                'authoring-relation:a6d58f9a4dd011c9a37796db',
                'authoring-relation:407d71003249cd09ee267b8e',
            ],
        }]);
        assert.deepEqual(runtimeTableLayoutCorrections.duplicateTableRepresentations.map(item => ({
            id: item.id,
            keyword: item.keyword,
            sourceRuleId: item.sourceRuleId,
            source: item.source,
            target: item.target,
            relations: item.representations.map(record => record.authoringRelationId),
            tableIds: item.representations.map(record => record.physicalTableId),
            fieldIds: item.representations.map(record => record.physicalFieldId),
        })), [
            {
                id: 'duplicate-table-representation-equivalence:database-cross-section-set-id-card-1b-bsid',
                keyword: '*DATABASE_CROSS_SECTION_SET_ID',
                sourceRuleId: 'rule:4c2f052634fd1f40fca7e0f1',
                source: { cardIndex: 1, cardFieldCount: 8, fieldIndex: 2,
                    fieldName: 'BSID', fieldType: 'integer', position: 20, width: 10 },
                target: { cardIndex: 2, cardFieldCount: 8, fieldIndex: 2,
                    fieldName: 'BSID', fieldType: 'integer', position: 20, width: 10 },
                relations: ['authoring-relation:59a9c422d90733181a95d839',
                    'authoring-relation:0ff2f87fa4a93937fc9b68d2'],
                tableIds: ['global-manual-card-grid:224ae6ae7817799b7b846079',
                    'global-manual-card-grid:faccdc015225f34545e80d00'],
                fieldIds: ['global-manual-physical-field:99659890f02fb53ef3abd5f2',
                    'global-manual-physical-field:d2ed141f8f0fcdc79fafcfe9'],
            },
            {
                id: 'duplicate-table-representation-equivalence:database-cross-section-set-id-card-1b-id',
                keyword: '*DATABASE_CROSS_SECTION_SET_ID',
                sourceRuleId: 'rule:b2d27b1c1d60fd22ddacd361',
                source: { cardIndex: 1, cardFieldCount: 8, fieldIndex: 6,
                    fieldName: 'ID', fieldType: 'integer', position: 60, width: 10 },
                target: { cardIndex: 2, cardFieldCount: 8, fieldIndex: 6,
                    fieldName: 'ID', fieldType: 'integer', position: 60, width: 10 },
                relations: ['authoring-relation:a4dd1c1a6c3e39a20b27ca9e',
                    'authoring-relation:ca1735f03075de470b3d2734'],
                tableIds: ['global-manual-card-grid:224ae6ae7817799b7b846079',
                    'global-manual-card-grid:faccdc015225f34545e80d00'],
                fieldIds: ['global-manual-physical-field:b07fea683de2533d5cfcd212',
                    'global-manual-physical-field:436748eb182773b35aef5bf3'],
            },
            {
                id: 'duplicate-table-representation-equivalence:database-cross-section-plane-id-card-1a-2-id',
                keyword: '*DATABASE_CROSS_SECTION_PLANE_ID',
                sourceRuleId: 'rule:b2d27b1c1d60fd22ddacd361',
                source: { cardIndex: 1, cardFieldCount: 7, fieldIndex: 5,
                    fieldName: 'ID', fieldType: 'integer', position: 50, width: 10 },
                target: { cardIndex: 3, cardFieldCount: 7, fieldIndex: 5,
                    fieldName: 'ID', fieldType: 'integer', position: 50, width: 10 },
                relations: ['authoring-relation:ee354c046abb61c5abbb49c9',
                    'authoring-relation:d86c75e349bb7b43d911cc65'],
                tableIds: ['global-manual-card-grid:1a8719ff6d046e8e8962d440',
                    'global-manual-card-grid:384b256b87b1ed059ccd46b6'],
                fieldIds: ['global-manual-physical-field:b16f10fa00160c6814cf4f18',
                    'global-manual-physical-field:3dbe8e03ecab1da3b89def52'],
            },
        ]);
        assert.deepEqual(runtimeTableLayoutCorrections.optionTableSelections.map(item => ({
            id: item.id,
            keyword: item.keyword,
            activeOptions: item.activeOptions,
            sourceRuleId: item.sourceRuleId,
            source: item.source,
            target: item.target,
            selected: item.selected.authoringRelationId,
            excluded: item.excluded.map(record => record.authoringRelationId),
        })), [{
            id: 'option-table-selection:part-composite-base-card-3a-hgid',
            keyword: '*PART_COMPOSITE',
            activeOptions: [],
            sourceRuleId: 'rule:e90204eb24ffcfb0df182736',
            source: { cardIndex: 1, cardFieldCount: 8, fieldIndex: 5,
                fieldName: 'HGID', fieldType: 'integer', position: 50, width: 10 },
            target: { cardIndex: 2, cardFieldCount: 8, fieldIndex: 5,
                fieldName: 'HGID', fieldType: 'integer', position: 50, width: 10 },
            selected: 'authoring-relation:ea4c9b8e1f2f568f610ddbcd',
            excluded: ['authoring-relation:5adf48bef0056fae987a32a8'],
        }]);
        assert.deepEqual(runtimeTableLayoutCorrections.directSourceFieldSelections.map(item => ({
            id: item.id,
            keyword: item.keyword,
            sourceRuleId: item.sourceRuleId,
            selected: item.selectedAuthoringRelationId,
            table: item.physicalTableId,
            field: item.physicalFieldId,
            targetBindingStatus: item.targetBindingStatus,
        })), [
            {
                id: 'direct-source-field-selection:deformable-to-rigid-pid',
                keyword: '*DEFORMABLE_TO_RIGID',
                sourceRuleId: 'rule:1f0fd7c236235e65efb4e6f2',
                selected: 'authoring-relation:d8a399690b1420ec461bead9',
                table: 'full-chunk-manual-card-grid:1b808da5792c811ea4b7e847',
                field: 'full-chunk-manual-physical-field:605dc898f82ff52d15c0b9a1',
                targetBindingStatus: 'sibling-discriminator-approved',
            },
            {
                id: 'direct-source-field-selection:fatigue-pid',
                keyword: '*FATIGUE',
                sourceRuleId: 'rule:62bc6472677e7d781fe51774',
                selected: 'authoring-relation:bd5dd78ce73650a6164dd155',
                table: 'full-chunk-manual-card-grid:2bd06583dfab8d9d26dcd2d2',
                field: 'full-chunk-manual-physical-field:da79e3ff306a9083fbcddc4d',
                targetBindingStatus: 'sibling-discriminator-approved',
            },
            {
                id: 'direct-source-field-selection:change-velocity-nsid',
                keyword: '*CHANGE_VELOCITY',
                sourceRuleId: 'rule:c998919759cb239492114fc0',
                selected: 'authoring-relation:d10b3cbb3e992b968160c018',
                table: 'full-chunk-manual-card-grid:15a2e1a656642bb53d17639b',
                field: 'full-chunk-manual-physical-field:e0a4c94a108149540b42c622',
                targetBindingStatus: 'exact-target-keyword-approved',
            },
        ]);

        const keywords = [...new Set(runtimeTableLayoutCorrections.corrections
            .map(item => item.keyword))];
        const targetKeys = keyword => {
            const lookup = keywordSchema.lookupKeywordSchema(keyword, schema);
            return keywordSchema.getRenderedCardsForLookup(lookup)[1].map(field => JSON.stringify([
                2, field.n, field.t === 'real' ? 'float' : field.t, field.p, field.w,
            ]));
        };
        for (const keyword of keywords) {
            const mapped = buildRuntimeTableLayoutIndex(keyword, runtime);
            const expectedKeys = targetKeys(keyword);
            assert.ok(expectedKeys.every(key => mapped.has(key)), keyword);
            const tableId = runtimeTableLayoutCorrections.corrections.find(item =>
                item.keyword === keyword).physicalTableId;
            assert.equal(expectedKeys.flatMap(key => mapped.get(key)).filter(record =>
                record.operationalProjection.physicalTableId === tableId).length,
            keyword.includes('HYBRID') ? 8 : keyword === '*DUALCESE_POINT_SOURCE' ? 5 : 3,
            keyword);
        }

        const sourceDrift = structuredClone(runtimeTableLayoutCorrections);
        sourceDrift.sources[0].pages[0].textSha256 = '0'.repeat(64);
        for (const keyword of keywords) {
            const mapped = buildRuntimeTableLayoutIndex(keyword, runtime, sourceDrift);
            assert.ok(targetKeys(keyword).every(key => !mapped.has(key)), keyword);
        }

        for (const correction of runtimeTableLayoutCorrections.corrections) {
            const records = runtime.referenceRecordsForKeyword(correction.keyword);
            const drifted = records.map(record => record.authoringRelationId ===
                correction.authoringRelationId ? {
                    ...record, field: { ...record.field, width: record.field.width + 1 },
                } : record);
            const mapped = buildRuntimeTableLayoutIndex(correction.keyword, {
                referenceRecordsForKeyword: () => drifted,
            });
            assert.ok(targetKeys(correction.keyword).every(key => !mapped.has(key)),
                correction.authoringRelationId);
        }

        const scopeDrift = structuredClone(runtimeTableLayoutCorrections);
        scopeDrift.tableScopes[0].records[1].sourceRuleId = 'rule:drift';
        assert.equal(buildRuntimeTableLayoutIndex('*DUALCESE_POINT_SOURCE', runtime, scopeDrift)
            .size, 0);
        const runtimeScopeDrift = runtime.referenceRecordsForKeyword('*DUALCESE_POINT_SOURCE')
            .map(record => record.authoringRelationId ===
                'authoring-relation:0c11510c3b04747265c6232f' ? {
                    ...record,
                    operationalProjection: {
                        ...record.operationalProjection,
                        sourceSelectorKeyword: '*DUALCESE_POINT_SOURCE_TWO-PHASE',
                    },
                } : record);
        assert.equal(buildRuntimeTableLayoutIndex('*DUALCESE_POINT_SOURCE', {
            referenceRecordsForKeyword: () => runtimeScopeDrift,
        }).size, 0);
        const duplicateScopedRecord = [...runtime.referenceRecordsForKeyword(
            '*DUALCESE_POINT_SOURCE',
        ), runtime.referenceRecordsForKeyword('*DUALCESE_POINT_SOURCE').find(record =>
            record.authoringRelationId === 'authoring-relation:0c11510c3b04747265c6232f')];
        assert.equal(buildRuntimeTableLayoutIndex('*DUALCESE_POINT_SOURCE', {
            referenceRecordsForKeyword: () => duplicateScopedRecord,
        }).size, 0);

        for (const keyword of keywords.filter(item => item.startsWith('*INTERFACE_'))) {
            const lookup = keywordSchema.lookupKeywordSchema(keyword, schema);
            const firstField = keywordSchema.getRenderedCardsForLookup(lookup)[1][0];
            assert.ok(getFieldReferenceInfo({ keyword, cardIndex: 2, field: firstField }));
            assert.equal(getActionableFieldReferenceInfo({
                keyword, cardIndex: 2, field: firstField,
            }), null, keyword);
        }
    });

    it('inventories every actionable rendered product field, including option and I8 layouts', function () {
        this.timeout(60_000); // Offline full-catalog audit; interaction budgets are measured separately.
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const catalog = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const keywords = new Set(catalog.allReferenceRecords().map(record => record.field.keyword));
        const physical = new Set();
        const coordinateIds = new Set();
        const selectorSources = new Map();
        for (const keyword of keywords) {
            const lookup = keywordSchema.lookupKeywordSchema(keyword, schema);
            if (!lookup) continue;
            const cards = keywordSchema.getRenderedCardsForLookup(lookup);
            for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
                for (let fieldIndex = 0; fieldIndex < cards[cardIndex].length; fieldIndex++) {
                    const field = cards[cardIndex][fieldIndex];
                    const info = getActionableFieldReferenceInfo({
                        keyword, cardIndex: cardIndex + 1, field,
                    });
                    if (!info) continue;
                    physical.add([keyword, cardIndex + 1, fieldIndex,
                        field.n, field.t, field.p, field.w].join('|'));
                    coordinateIds.add(info.definitionRegistry.coordinateId);
                    const source = info.definitionRegistry.selectorSource;
                    selectorSources.set(source, (selectorSources.get(source) || 0) + 1);
                }
            }
        }
        assert.equal(keywords.size, 2245);
        // CHEMID now binds to the existing CHEMISTRY_CONTROL_FULL definition namespace.
        assert.equal(physical.size, 2732);
        assert.equal(coordinateIds.size, 2731);
        assert.deepEqual(Object.fromEntries(selectorSources), {
            "operational-projection": 2526,
            "manual-semantic": 206
        });

        assert.deepEqual([...physical].filter(coordinate => aliasKeywords.has(coordinate.split('|')[0])).sort(), [...numberedAliasContract.actionable].sort());
    });

    it('rejects cross-namespace target keyword unions without branch-level bindings', function () {
        this.timeout(20000); // Loads an independent full registry to exercise corruption rejection.
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2')
            .getSemanticRuntimeCatalogV2();
        const visited = new Set();
        let rejectedCoordinates = 0;
        for (const record of runtime.allReferenceRecords()) {
            if (record.operationalProjection?.ambiguous === true) continue;
            if (isCoherentReferenceTargetNamespace({ relation: record.relation })) continue;
            const lookup = keywordSchema.lookupKeywordSchema(record.field.keyword, schema);
            if (!lookup) continue;
            const field = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions)
                [record.field.cardIndex - 1]?.[record.field.fieldIndex];
            if (!field || field.n !== record.field.fieldName || field.t !== record.field.fieldType ||
                field.p !== record.field.position || field.w !== record.field.width) continue;
            const key = [record.field.keyword, record.field.cardIndex, record.field.fieldIndex].join('|');
            if (visited.has(key)) continue;
            visited.add(key);
            const options = {
                keyword: record.field.keyword,
                cardIndex: record.field.cardIndex,
                field,
            };
            const retained = getFieldReferenceInfo(options);
            if (!retained || isCoherentReferenceTargetNamespace(retained)) continue;
            rejectedCoordinates += 1;
            assert.equal(getActionableFieldReferenceInfo(options), null, key);
        }
        assert.ok(rejectedCoordinates > 0,
            'fixture must cover cross-namespace target keyword unions');

        const forming = keywordSchema.lookupKeywordSchema('DEFINE_FORMING_CLAMP', schema);
        const clp1 = keywordSchema.getRenderedCards(forming.entry, forming.activeOptions)[0][0];
        assert.equal(getActionableFieldReferenceInfo({
            keyword: 'DEFINE_FORMING_CLAMP', cardIndex: 1, field: clp1,
        }), null);

        const sliding = keywordSchema.lookupKeywordSchema('BOUNDARY_SLIDING_PLANE', schema);
        const nsid = keywordSchema.getRenderedCards(sliding.entry, sliding.activeOptions)[0][0];
        assert.equal(nsid.n, 'NSID');
        const slidingInfo = getActionableFieldReferenceInfo({
            keyword: 'BOUNDARY_SLIDING_PLANE', cardIndex: 1, field: nsid,
        });
        assert.ok(slidingInfo);
        assert.deepEqual(slidingInfo.targetKinds, ['node-set'],
            'source-locked nodal-set correction must use the node-set namespace');
    });

    it('retains the reviewed DEFINE_FUNCTION compatibility in the curve namespace', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema(
            'BOUNDARY_PRESCRIBED_MOTION_SET_BOX', schema,
        );
        const lcid = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions)[0][3];
        const info = getActionableFieldReferenceInfo({
            keyword: 'BOUNDARY_PRESCRIBED_MOTION_SET_BOX', cardIndex: 1, field: lcid,
        });

        assert.equal(lcid.n, 'LCID');
        assert.ok(info.targetKinds.includes('curve'));
        assert.ok(info.targetDefinitions.includes('DEFINE_FUNCTION'));
    });

    it('classifies a concrete LOAD_BODY family field directly from Registry provenance', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('LOAD_BODY_Z', schema);
        const lcid = lookup.entry.c[0].find(item => item.n === 'LCID');
        const info = getRegistryApprovedFieldReferenceInfo({
            keyword: 'LOAD_BODY_Z', cardIndex: 1, field: lcid,
        });

        assert.equal(info.source, 'official-manual-definition-registry');
        assert.deepEqual(info.targetKinds, ['curve']);
        assert.deepEqual(info.targetDefinitions, ['DEFINE_CURVE']);
        assert.equal(info.definitionRegistry.familyKeyword, '*LOAD_BODY');
        assert.equal(info.definitionRegistry.familyOption, 'Z');
        assert.match(info.definitionRegistry.familyProjectionId, /^(family|operational)-projection:/);
        assert.equal(parseFieldReferenceValue('1000001', info).id, 1000001);
    });

    it('accepts exact official MAT/SECTION labels only on direct identity relations', () => {
        const records = require("../../../keywords/runtime/definitions/definition_registry.json").byKeyword.PART;
        for (const fieldName of ['MID', 'SECID', 'TMID']) {
            const record = records.find(item =>
                item.kind === 'entity-reference' && item.field.fieldName === fieldName
            );
            const info = getRegistryApprovedFieldReferenceInfo({
                keyword: 'PART',
                cardIndex: record.field.cardIndex,
                field: {
                    n: record.field.fieldName,
                    t: record.field.fieldType,
                    p: record.field.position,
                    w: record.field.width,
                },
            });
            const parsed = parseFieldReferenceValue('HS Steel', info);
            assert.equal(parsed.kind, 'label');
            assert.equal(parsed.id, 'HS Steel');
            assert.equal(parsed.idTransform, 'identity');
        }
        const load = keywordSchema.lookupKeywordSchema('LOAD_BODY_Z',
            keywordSchema.loadKeywordSchema(() => 'en'));
        const curveInfo = getRegistryApprovedFieldReferenceInfo({
            keyword: 'LOAD_BODY_Z', cardIndex: 1,
            field: load.entry.c[0].find(item => item.n === 'LCID'),
        });
        assert.equal(parseFieldReferenceValue('CURVE A', curveInfo), null);
    });

    it('rejects recognized invalid numeric references instead of treating them as material labels', () => {
        const info = {
            relation: { kind: 'entity-reference', targetKeywords: ['*MAT'], targetKinds: ['material'] },
        };
        for (const raw of ['0', '0.0', '+0', '-0.0', '1.5', '.5', '1e3', '1e309']) {
            assert.equal(parseFieldReferenceValue(raw, info), null, raw);
        }
        assert.equal(parseFieldReferenceValue('HS Steel', info).kind, 'label');
        assert.equal(parseFieldReferenceValue('1.0', info).id, 1);
        assert.equal(parseFieldReferenceValue('&MID', info).kind, 'parameter');
        assert.equal(parseFieldReferenceValue('<1+2>', info).kind, 'expression');
    });

    it('classifies MAT_024 LCSS from an official-manual rule', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('MAT_PIECEWISE_LINEAR_PLASTICITY', schema);
        const field = lookup.entry.c[1].find(item => item.n === 'LCSS');

        const info = getFieldReferenceInfo({
            keyword: 'MAT_PIECEWISE_LINEAR_PLASTICITY',
            cardIndex: 2,
            field,
        });

        assert.deepEqual(info.targetKinds, ['curve', 'table']);
        assert.equal(info.confidence, 'manual-explicit');
        assert.equal(info.source, 'official-manual');
        assert.match(info.ruleId, /^rule:/);
        assert.equal(info.evidence[0].page, 361);
    });

    it('classifies MAT_024_TITLE LCSS as curve or table at cardIndex 3', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('MAT_PIECEWISE_LINEAR_PLASTICITY_TITLE', schema);
        const field = lookup.entry.c[1].find(item => item.n === 'LCSS');

        const info = getFieldReferenceInfo({
            keyword: 'MAT_PIECEWISE_LINEAR_PLASTICITY_TITLE',
            cardIndex: 3,
            field,
        });

        assert.deepEqual(info.targetKinds, ['curve', 'table']);
        assert.equal(info.confidence, 'manual-explicit');
        assert.equal(info.source, 'official-manual');
    });

    it('activates MAT_ADD_EROSION curve references only on the manual-defined negative branch', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('MAT_ADD_EROSION', schema);
        const failureCard = lookup.entry.c[1];
        const sigp1 = failureCard.find(item => item.n === 'SIGP1');
        const sigvm = failureCard.find(item => item.n === 'SIGVM');

        const sigp1Info = getFieldReferenceInfo({
            keyword: 'MAT_ADD_EROSION',
            cardIndex: 2,
            field: sigp1,
        });
        const sigvmInfo = getFieldReferenceInfo({
            keyword: 'MAT_ADD_EROSION',
            cardIndex: 2,
            field: sigvm,
        });

        assert.deepEqual(sigp1Info.targetKinds, ['curve']);
        assert.equal(sigp1Info.fieldType, 'real');
        assert.equal(sigp1Info.conditional, true);
        assert.deepEqual(sigvmInfo.targetKinds, ['curve']);
        assert.equal(sigvmInfo.fieldType, 'real');
        assert.equal(parseFieldReferenceValue('31001008.0', sigp1Info), null);
        assert.equal(parseFieldReferenceValue('-31001008.0', sigp1Info).id, 31001008);
        assert.equal(parseFieldReferenceValue('2.5', sigvmInfo), null);
    });

    it('does not classify non-curve/table integer fields', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('MAT_PIECEWISE_LINEAR_PLASTICITY', schema);
        const field = lookup.entry.c[0].find(item => item.n === 'MID');

        const info = getFieldReferenceInfo({
            keyword: 'MAT_PIECEWISE_LINEAR_PLASTICITY',
            cardIndex: 1,
            field,
        });

        assert.equal(info, null);
    });

    it('classifies explicit DEFINE targets with the recovered native definition namespace', () => {
        const info = getFieldReferenceInfo({
            keyword: 'AIRBAG_PARTICLE',
            cardIndex: 6,
            field: { n: 'CHM' },
        });

        assert.deepEqual(info.targetKinds, ['cpm-chamber-define']);
        assert.deepEqual(info.targetDefinitions, ['DEFINE_CPM_CHAMBER']);
        assert.equal(info.source, 'official-manual');
    });

    it('maps repeated TABLE_4D TBID fields across a TITLE card shift by selector signature', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('DEFINE_TABLE_4D_TITLE', schema);
        const cards = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions);
        const definitionField = cards[1][0];
        const childTableField = cards[2][1];

        assert.equal(getFieldReferenceInfo({
            keyword: 'DEFINE_TABLE_4D_TITLE',
            cardIndex: 2,
            field: definitionField,
        }), null);

        const info = getFieldReferenceInfo({
            keyword: 'DEFINE_TABLE_4D_TITLE',
            cardIndex: 3,
            field: childTableField,
        });
        assert.deepEqual(info.targetKinds, ['table']);
        assert.equal(info.source, 'official-manual');
        assert.equal(info.evidence[0].page, 2585);
        assert.equal(parseFieldReferenceValue('3001', info).id, 3001);
    });

    it('maps aliases only through one complete physical card signature', () => {
        const source = [
            { n: 'ID', t: 'integer', p: 0, w: 10 },
            { n: 'MODE', t: 'integer', p: 10, w: 10 },
        ];
        const title = [{ n: 'TITLE', t: 'string', p: 0, w: 80 }];
        const selector = {
            cardIndex: 1,
            fieldIndex: 1,
            fieldName: 'MODE',
            fieldType: 'integer',
            position: 10,
            width: 10,
        };

        assert.equal(selectorMapsToRequestedCard(
            selector,
            [source],
            [title, source],
            2,
        ), true);
        assert.equal(selectorMapsToRequestedCard(
            selector,
            [source],
            [title, source, source.map(field => ({ ...field }))],
            2,
        ), false);
    });

    it('does not infer official field semantics for unverified extra data rows', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const interaction = keywordSchema.lookupKeywordSchema('AIRBAG_INTERACTION', schema);
        const rivet = keywordSchema.lookupKeywordSchema('CONSTRAINED_RIVET', schema);

        assert.ok(manualRulesForField(
            'AIRBAG_INTERACTION',
            1,
            interaction.entry.c[0][0],
        ).some(rule => rule.kind === 'entity-reference'));
        assert.deepEqual(manualRulesForField(
            'AIRBAG_INTERACTION',
            2,
            interaction.entry.c[0][0],
        ), []);
        assert.deepEqual(manualRulesForField(
            'CONSTRAINED_RIVET',
            2,
            rivet.entry.c[0][0],
        ), []);
    });

    it('does not turn ID arithmetic fields into references', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('INCLUDE_TRANSFORM', schema);
        const cards = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions);
        const match = cards.flatMap((card, cardOffset) =>
            card.map(field => ({ field, cardIndex: cardOffset + 1 }))
        ).find(item => item.field.n === 'IDFOFF');
        assert.ok(match);
        assert.equal(getFieldReferenceInfo({
            keyword: 'INCLUDE_TRANSFORM',
            cardIndex: match.cardIndex,
            field: match.field,
        }), null);
    });

    it('selects different namespaces and transforms for DEFINE_BOX_ADAPTIVE sign branches', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('DEFINE_BOX_ADAPTIVE', schema);
        const field = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions)[1]
            .find(item => item.n === 'LIDX/NDID');
        const info = getFieldReferenceInfo({
            keyword: 'DEFINE_BOX_ADAPTIVE',
            cardIndex: 2,
            field,
        });

        const positive = parseFieldReferenceValue('17', info);
        assert.equal(positive.id, 17);
        assert.deepEqual(positive.targetKinds, ['curve']);
        const negative = parseFieldReferenceValue('-17', info);
        assert.equal(negative.id, 17);
        assert.deepEqual(negative.targetKinds, ['node']);
        assert.equal(negative.idTransform, 'abs');
        assert.equal(parseFieldReferenceValue('0', info), null);
    });

    it('parses integer reference values and strips negative switch signs by default', () => {
        const positive = parseFieldReferenceValue('      1001', { allowSignedSwitch: true });
        assert.equal(positive.kind, 'numeric');
        assert.equal(positive.id, 1001);
        assert.equal(positive.raw, '1001');
        assert.equal(positive.isSignedSwitch, false);
        assert.deepEqual(positive.input, { kind: 'numeric', raw: '1001', value: 1001 });

        const negative = parseFieldReferenceValue('        -7', { allowSignedSwitch: true });
        assert.equal(negative.kind, 'numeric');
        assert.equal(negative.id, 7);
        assert.equal(negative.raw, '-7');
        assert.equal(negative.isSignedSwitch, true);
        assert.deepEqual(negative.input, { kind: 'numeric', raw: '-7', value: -7 });

        assert.equal(parseFieldReferenceValue('         0', { allowSignedSwitch: true }), null);
        assert.equal(parseFieldReferenceValue('        -7', { allowSignedSwitch: false }), null);
    });

    it('preserves parameter-controlled reference values and signed-switch form', () => {
        const parameter = parseFieldReferenceValue('     &LCSS', { allowSignedSwitch: true });
        assert.equal(parameter.kind, 'parameter');
        assert.equal(parameter.parameterName, 'LCSS');
        assert.equal(parameter.raw, '&LCSS');
        assert.equal(parameter.isSignedSwitch, false);
        assert.deepEqual(parameter.input, {
            kind: 'parameter',
            raw: '&LCSS',
            name: 'LCSS',
            negated: false,
        });

        const signedParameter = parseFieldReferenceValue('    -&LCSS', { allowSignedSwitch: true });
        assert.equal(signedParameter.kind, 'parameter');
        assert.equal(signedParameter.parameterName, 'LCSS');
        assert.equal(signedParameter.isSignedSwitch, true);
        assert.equal(parseFieldReferenceValue('-&LCSS', { allowSignedSwitch: false }), null);
    });

    it('keeps the legacy parser path isolated from product semantic rules', () => {
        const signedRealInfo = {
            allowSignedSwitch: true,
            requiresSignedSwitch: true,
            fieldType: 'real',
        };

        const parsed = parseFieldReferenceValue(' -31001008.0', signedRealInfo);
        assert.equal(parsed.kind, 'numeric');
        assert.equal(parsed.id, 31001008);
        assert.equal(parsed.raw, '-31001008.0');
        assert.equal(parsed.isSignedSwitch, true);
        assert.deepEqual(parsed.input, {
            kind: 'numeric',
            raw: '-31001008.0',
            value: -31001008,
        });
        assert.equal(parseFieldReferenceValue('  31001008.0', signedRealInfo), null);
        assert.equal(parseFieldReferenceValue('        -0.5', signedRealInfo), null);
        assert.equal(parseFieldReferenceValue('       &CID', signedRealInfo), null);
        assert.equal(parseFieldReferenceValue('      -&CID', signedRealInfo).kind, 'parameter');
    });

    it('preserves every official target keyword without prefix inference', () => {
        assert.deepEqual(referenceTargets({
            targetKinds: ['curve'],
            targetKeywords: ['*DEFINE_CURVE_FUNCTION', '*DEFINE_FUNCTION'],
        }), {
            targetKinds: ['curve'],
            targetDefinitions: ['DEFINE_CURVE_FUNCTION', 'DEFINE_FUNCTION'],
        });
    });
});
