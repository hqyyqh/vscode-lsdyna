'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { compileReferenceRoles } = require('../../../../scripts/build/compile-reference-roles.cjs');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function fixture() {
    const selector = { cardIndex: 1, fieldIndex: 2, fieldName: 'DAMP', fieldType: 'real', position: 20, width: 10 };
    const evidence = [{ evidenceId: 'retained-evidence', quoteSha256: 'a'.repeat(64),
        locations: [{ sourceProfileId: 'original-profile', manualId: 'original-manual', page: 23 }] }];
    const rule = { ruleId: 'original-rule', keyword: '*SYNTHETIC_MATERIAL', field: 'DAMP', kind: 'value-branch',
        selector, evidence, relation: { kind: 'value-branch', otherwise: 'unknown', branches: [
            { role: 'reference', when: { op: 'lt', value: 0 }, targetKinds: ['curve'], idTransform: 'abs' },
        ] }, summary: 'Retained source text' };
    const reference = { sourceRuleId: rule.ruleId, kind: rule.kind, relation: structuredClone(rule.relation),
        field: { ...selector, keyword: rule.keyword, fieldType: 'float' },
        evidence: [{ evidenceId: evidence[0].evidenceId, quoteSha256: evidence[0].quoteSha256,
            manualId: 'original-manual', page: 23 }],
        permissions: { classify: true, navigate: true, mutate: false, completenessClaim: false },
        provenance: { sourceConfidence: 'manual-explicit' }, coordinateId: 'original-coordinate' };
    const identity = { manualSemanticsSha256: 'b'.repeat(64), semanticV2Sha256: 'c'.repeat(64), importSha256: 'd'.repeat(64) };
    const source = { schemaVersion: 1, kind: 'manual-reference-role-supplement',
        source: { manualSemanticsSha256: identity.manualSemanticsSha256, semanticV2Sha256: identity.semanticV2Sha256,
            authority: 'reviewed-manual-supplement', nativeReadWriteApproval: false },
        records: [{ keyword: rule.keyword, field: rule.field, ruleId: rule.ruleId, selector, evidence,
            sourceRelationSha256: digest(rule.relation), nonReferenceWhen: { op: 'ge', value: 0 },
            basis: 'Nonnegative values are a damping coefficient.' }] };
    const manual = { payloads: [{ path: 'original.json.gz', value: { rules: [rule] } }] };
    const semantic = { references: [reference] };
    return { source, manual, semantic, identity, rule, reference };
}
const compile = f => compileReferenceRoles(f.source, f.manual, f.semantic, f.identity);

test('supplement adds only an explicit non-reference branch to both projections and retains unknown, evidence and permissions', () => {
    const f = fixture(), original = structuredClone(f), result = compile(f);
    assert.equal(result.recordCount, 1);
    const manual = result.manual.payloads[0].value.rules[0], semantic = result.semantic.references[0];
    const branch = { role: 'literal', when: { op: 'ge', value: 0 } };
    assert.deepEqual(manual.relation, { ...f.rule.relation, branches: [...f.rule.relation.branches, branch] });
    assert.deepEqual(semantic.relation, manual.relation);
    assert.deepEqual(manual.selector, f.rule.selector);
    assert.deepEqual(manual.evidence, f.rule.evidence);
    assert.deepEqual(semantic.permissions, f.reference.permissions);
    assert.deepEqual(semantic.evidence, f.reference.evidence);
    assert.equal(semantic.coordinateId, f.reference.coordinateId);
    assert.equal(semantic.provenance.sourceConfidence, 'manual-explicit');
    assert.equal(semantic.provenance.runtimeNonReferenceSupplement.importSha256, f.identity.importSha256);
    assert.deepEqual(f, original);
});

test('source changes, new reference targets, selector drift and missing projections fail closed', () => {
    for (const edit of [
        f => { f.source.source.manualSemanticsSha256 = 'e'.repeat(64); },
        f => { f.source.source.semanticV2Sha256 = 'e'.repeat(64); },
        f => { f.source.source.nativeReadWriteApproval = true; },
        f => { f.source.records[0].sourceRelationSha256 = 'e'.repeat(64); },
        f => { f.source.records[0].keyword = '*OTHER'; },
        f => { f.source.records[0].field = 'OTHER'; },
        f => { f.source.records[0].selector = { ...f.rule.selector, fieldIndex: 3 }; },
        f => { f.source.records[0].evidence = []; },
        f => { f.source.records[0].targetKinds = ['node']; },
        f => { f.semantic.references[0].relation.branches[0].targetKinds = ['node']; },
        f => { f.semantic.references[0].sourceRuleId = 'other-rule'; },
        f => { f.semantic.references[0].field.keyword = '*OTHER'; },
        f => { f.semantic.references[0].field.fieldName = 'OTHER'; },
        f => { f.semantic.references[0].evidence[0].quoteSha256 = 'e'.repeat(64); },
        f => { f.semantic.references = []; },
        f => { f.source.records.push(structuredClone(f.source.records[0])); },
        f => { f.manual.payloads[0].value.rules[0].kind = 'entity-reference'; },
    ]) {
        const f = fixture(); edit(f);
        assert.throws(() => compile(f));
    }
});

test('each frozen projection retains its own coordinates and unrelated native records', () => {
    const f = fixture();
    f.reference.field.cardIndex = 4;
    f.reference.field.position = 40;
    const native = { sourceRuleId: 'native-rule', kind: 'entity-reference', field: f.reference.field,
        relation: { kind: 'entity-reference', targetKinds: ['node'] }, permissions: { mutate: false } };
    f.semantic.references.push(native);
    const result = compile(f);
    assert.deepEqual(result.semantic.references[0].field, f.reference.field);
    assert.deepEqual(result.manual.payloads[0].value.rules[0].selector, f.rule.selector);
    assert.strictEqual(result.semantic.references[1], native);
});

test('non-reference predicates must have a proven, nonempty numeric interval disjoint from every retained branch', () => {
    for (const predicate of [
        { op: 'ge', value: -1 }, { op: 'eq', value: -1 }, { op: 'symbolic', reason: 'unverified' },
        { op: 'ge', value: 'zero' }, { op: 'ge', value: Infinity },
        { all: [] }, { all: [{ op: 'gt', value: 1 }, { op: 'le', value: 2 }] },
    ]) {
        const f = fixture(); f.source.records[0].nonReferenceWhen = predicate;
        assert.throws(() => compile(f));
    }
    const f = fixture();
    f.rule.relation.branches.push({ role: 'sentinel', when: { op: 'eq', value: 0 } });
    f.reference.relation = structuredClone(f.rule.relation);
    f.source.records[0].sourceRelationSha256 = digest(f.rule.relation);
    f.source.records[0].nonReferenceWhen = { op: 'gt', value: 0 };
    const projected = compile(f).semantic.references[0].relation;
    assert.equal(projected.otherwise, 'unknown');
    assert.deepEqual(projected.branches.slice(0, 2), f.rule.relation.branches);
    f.source.records[0].nonReferenceWhen.op = 'ge';
    assert.throws(() => compile(f), /overlap/);
    f.rule.relation.branches[1].when = { all: [{ op: 'ge', value: 0 }, { op: 'le', value: 0 }] };
    f.reference.relation = structuredClone(f.rule.relation);
    f.source.records[0].sourceRelationSha256 = digest(f.rule.relation);
    f.source.records[0].nonReferenceWhen.op = 'gt';
    assert.throws(() => compile(f));
});

test('existing literal equality is disjoint from numeric additions but numeric strings and unknown expressions are not skipped', () => {
    const withLiteral = value => {
        const f = fixture();
        f.rule.selector.fieldType = 'integer';
        f.reference.field.fieldType = 'integer';
        f.rule.relation.branches.push({ role: 'sentinel', when: { op: 'eq', value: 1 } },
            { role: 'enum', when: { op: 'eq', value } });
        f.reference.relation = structuredClone(f.rule.relation);
        f.source.records[0].sourceRelationSha256 = digest(f.rule.relation);
        f.source.records[0].nonReferenceWhen = { op: 'gt', value: 1 };
        return f;
    };
    for (const literal of ['N', ' n ', 'mode-name']) {
        const f = withLiteral(literal), result = compile(f);
        assert.deepEqual(result.semantic.references[0].relation.branches.slice(0, -1), f.rule.relation.branches);
        assert.equal(result.semantic.references[0].relation.otherwise, 'unknown');
    }
    for (const value of ['2', ' 2 ', '2.0', '2e0', '0x2', '0b10', '', ' ', '&N', '-&N', '{N}', 'N(1)', '2+3']) {
        assert.throws(() => compile(withLiteral(value)), undefined, value);
    }
    const contextual = withLiteral('N');
    contextual.rule.relation.branches.at(-1).when.field = 'CONTROLLER';
    contextual.reference.relation = structuredClone(contextual.rule.relation);
    contextual.source.records[0].sourceRelationSha256 = digest(contextual.rule.relation);
    assert.throws(() => compile(contextual));
});

test('the complete reviewed import projects deterministically without changing source snapshots, coordinates or permissions', () => {
    const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
    const root = path.resolve(__dirname, '../../../..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'keywords/sources/manifest.json')));
    const load = name => {
        const descriptor = manifest.bundles.find(bundle => bundle.bundle === name);
        const bytes = fs.readFileSync(path.join(root, descriptor.path));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
        return JSON.parse(zlib.gunzipSync(bytes));
    };
    const input = 'keywords/sources/reference-roles/import-v1.json';
    const bytes = fs.readFileSync(path.join(root, input));
    const source = JSON.parse(bytes), manual = load('manual-semantics'), semantic = load('semantic-v2');
    const before = [digest(manual), digest(semantic)];
    const identity = { manualSemanticsSha256: manifest.bundles.find(item => item.bundle === 'manual-semantics').sha256,
        semanticV2Sha256: manifest.bundles.find(item => item.bundle === 'semantic-v2').sha256,
        importSha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    assert.equal(identity.importSha256, manifest.compilerInputs.find(item => item.path === input).sha256);
    const first = compileReferenceRoles(source, manual, semantic, identity);
    const second = compileReferenceRoles(source, manual, semantic, identity);
    assert.equal(first.recordCount, source.records.length);
    assert.deepEqual(first, second);
    assert.deepEqual([digest(manual), digest(semantic)], before);
    const approved = new Set(source.records.map(record => record.ruleId));
    for (let i = 0; i < semantic.references.length; i++) {
        const old = semantic.references[i], current = first.semantic.references[i];
        if (!approved.has(old.sourceRuleId)) assert.strictEqual(current, old);
        else {
            assert.deepEqual(current.field, old.field);
            assert.deepEqual(current.permissions, old.permissions);
            assert.deepEqual(current.evidence, old.evidence);
            assert.deepEqual(current.relation.branches.slice(0, -1), old.relation.branches);
            assert.equal(current.relation.branches.at(-1).role, 'literal');
            assert.equal(current.relation.otherwise, 'unknown');
        }
    }
});
