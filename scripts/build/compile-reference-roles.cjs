'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function intersection(a, b) {
    const minimum = Math.max(a.minimum, b.minimum), maximum = Math.min(a.maximum, b.maximum);
    return { minimum, maximum,
        includeMinimum: (minimum !== a.minimum || a.includeMinimum) && (minimum !== b.minimum || b.includeMinimum),
        includeMaximum: (maximum !== a.maximum || a.includeMaximum) && (maximum !== b.maximum || b.includeMaximum) };
}
const nonempty = range => range.minimum < range.maximum ||
    (range.minimum === range.maximum && range.includeMinimum && range.includeMaximum);

// A source supplement must prove a numeric interval, never an open-ended default role.
function interval(predicate) {
    assert.ok(predicate && typeof predicate === 'object', 'Missing non-reference predicate');
    assert.deepEqual(Object.keys(predicate).sort(), ['op', 'value']);
    assert.ok(Number.isFinite(predicate.value), 'Predicate requires a finite number');
    const { op, value } = predicate;
    assert.ok(['lt', 'le', 'gt', 'ge', 'eq'].includes(op), 'Unsupported numeric predicate');
    return { minimum: ['gt', 'ge', 'eq'].includes(op) ? value : -Infinity,
        maximum: ['lt', 'le', 'eq'].includes(op) ? value : Infinity,
        includeMinimum: ['ge', 'eq'].includes(op), includeMaximum: ['le', 'eq'].includes(op) };
}

/** Project a separately reviewed manual import; preserve the original snapshots and permissions. */
function compileReferenceRoles(source, manual, semantic, identity) {
    assert.equal(source.schemaVersion, 1);
    assert.equal(source.kind, 'manual-reference-role-supplement');
    assert.equal(source.source.authority, 'reviewed-manual-supplement');
    assert.equal(source.source.nativeReadWriteApproval, false);
    for (const key of ['manualSemanticsSha256', 'semanticV2Sha256']) {
        assert.match(identity[key], /^[a-f0-9]{64}$/);
        assert.equal(source.source[key], identity[key], `Reference role checkpoint changed: ${key}`);
    }
    assert.match(identity.importSha256, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(source.records) && source.records.length > 0);
    const originals = new Map();
    for (const rule of manual.payloads.flatMap(payload => payload.value.rules)) {
        assert.ok(!originals.has(rule.ruleId), `Duplicate original rule: ${rule.ruleId}`);
        originals.set(rule.ruleId, rule);
    }
    const replacements = new Map();
    const projectedReferences = new Map();
    for (const record of source.records) {
        assert.deepEqual(Object.keys(record).sort(), ['basis', 'evidence', 'field', 'keyword', 'nonReferenceWhen',
            'ruleId', 'selector', 'sourceRelationSha256'].sort());
        assert.ok(!replacements.has(record.ruleId), `Duplicate reference role supplement: ${record.ruleId}`);
        const original = originals.get(record.ruleId);
        assert.ok(original, `Missing original rule: ${record.ruleId}`);
        assert.equal(original.kind, 'value-branch');
        assert.equal(original.keyword, record.keyword);
        assert.equal(original.field, record.field);
        assert.deepEqual(original.selector, record.selector);
        assert.deepEqual(original.evidence, record.evidence);
        assert.equal(digest(original.relation), record.sourceRelationSha256, `Reference relation changed: ${record.ruleId}`);
        assert.equal(original.relation.kind, 'value-branch');
        assert.equal(original.relation.otherwise, 'unknown');
        assert.ok(original.relation.branches?.some(branch => branch.role === 'reference'));
        assert.ok(typeof record.basis === 'string' && record.basis.trim());
        const nonReference = interval(record.nonReferenceWhen);
        for (const branch of original.relation.branches) {
            const predicate = branch.when, text = typeof predicate?.value === 'string' ? predicate.value.trim() : '';
            // Match predicateEvaluator's comparable values: plain text cannot equal a numeric value.
            if (predicate?.op === 'eq' && text && !Number.isFinite(Number(text)) && !/[&{}()[\]+*/^]/.test(text)) {
                assert.deepEqual(Object.keys(predicate).sort(), ['op', 'value']);
                continue;
            }
            assert.ok(!nonempty(intersection(nonReference, interval(branch.when))),
                `Non-reference branch overlaps an existing branch: ${record.ruleId}`);
        }
        // Literal is the existing manual role for a value that is not an entity reference.
        const relation = { ...original.relation, branches: [...original.relation.branches,
            { role: 'literal', when: structuredClone(record.nonReferenceWhen) }] };
        const provenance = { kind: source.kind, importSha256: identity.importSha256,
            sourceRuleId: record.ruleId, sourceRelationSha256: record.sourceRelationSha256, basis: record.basis };
        replacements.set(record.ruleId, { ...original, relation,
            provenance: { ...original.provenance, runtimeNonReferenceSupplement: provenance } });
        const matches = semantic.references.filter(reference => reference.sourceRuleId === record.ruleId);
        assert.ok(matches.length > 0, `Missing semantic-v2 projection: ${record.ruleId}`);
        for (const reference of matches) {
            assert.equal(reference.kind, 'value-branch');
            assert.deepEqual(reference.relation, original.relation);
            assert.equal(reference.field.keyword, record.keyword);
            // Both checkpoint geometries are hash-bound; historical card indices need not agree.
            assert.equal(reference.field.fieldName, record.field);
            assert.ok(reference.evidence?.length > 0);
            for (const evidence of reference.evidence) {
                assert.ok(record.evidence.some(item => item.evidenceId === evidence.evidenceId &&
                    item.quoteSha256 === evidence.quoteSha256 && item.locations.some(location =>
                        location.manualId === evidence.manualId && location.page === evidence.page)),
                    `Semantic evidence changed: ${record.ruleId}`);
            }
            projectedReferences.set(reference, { ...reference, relation,
                provenance: { ...reference.provenance, runtimeNonReferenceSupplement: provenance } });
        }
    }
    return { recordCount: replacements.size,
        manual: { ...manual, payloads: manual.payloads.map(payload => ({ ...payload,
            value: { ...payload.value, rules: payload.value.rules.map(rule => replacements.get(rule.ruleId) || rule) } })) },
        semantic: { ...semantic, references: semantic.references.map(reference => projectedReferences.get(reference) || reference) } };
}

module.exports = { compileReferenceRoles };
