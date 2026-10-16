'use strict';
const assert = require('node:assert/strict');
const index = require('../../keywords/runtime/references/field_reference_index.json');
const { getCatalogInputFormCatalogV4 } = require("../../out/core/semantics/catalogInputFormCatalogV4");
const { evaluatePredicate } = require('../../out/core/semantics/predicateEvaluator');
const { nativeStringChoice } = require('../../out/core/semantics/nativeStringChoice');
const { globalInputFormatFromKeywordLine, keywordInputFormat } = require('../../out/core/parser/inputFormat');
const datasetSha256 = "99091ea6216c85df477661324f422cc6674b2b655d4d19360767ed334c671168";

module.exports = function assertNativeReferenceAuthority(extension, document, position, field, card, keyword, format, message) {
    const actual = extension.fieldReferenceAtPosition(document, position);
    message += ':' + format;
    const keywordLines = Array.from({ length: document.lineCount }, (_, line) => [line, document.lineAt(line).text])
        .filter(([, text]) => text.trimStart().startsWith('*'));
    const globalFormat = globalInputFormatFromKeywordLine(keywordLines[0]?.[1] || '');
    const keywordText = keywordLines.filter(([line]) => line < position.line).at(-1)?.[1] || '';
    if (document.lineAt(position.line).text.includes(',') || keywordInputFormat(keywordText, globalFormat) !== 'standard') {
        assert.equal(actual, null, message); return;
    }
    const form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
    assert.equal(form.source.datasetSha256, datasetSha256, message);
    assert.equal(field.nativeIdentity.source, datasetSha256, message);
    const arrays = new Set(form.reference.formRuleIds.map(id => form.rules[id].cardSetId));
    const candidates = (index.references[keyword] || []).filter(row => row.fieldName === field.n &&
        row.nativeSources?.some(source => arrays.has(source.cardSetId) && source.fieldRecordId === field.nativeIdentity.fieldRecordId &&
            source.cardIndex + 1 === field.nativeIdentity.cardIndex && source.fieldIndex === card.indexOf(field)));
    const rows = [...new Map(candidates.map(row => [JSON.stringify([row.relation, row.siblingTargetBinding]), row])).values()];
    if (!rows.length) { assert.equal(actual, null, message); return; }
    assert.equal(rows.length, 1, message + ': ambiguous independent reference identity');
    const row = rows[0];
    const physical = row.nativeSources.filter(source => arrays.has(source.cardSetId) &&
        source.fieldRecordId === field.nativeIdentity.fieldRecordId && source.cardIndex + 1 === field.nativeIdentity.cardIndex &&
        source.fieldIndex === card.indexOf(field));
    assert.equal(new Set(physical.map(source => source.cardSetId)).size, 1, message + ': ambiguous native card array');
    assert.equal(row.fieldIndex, card.indexOf(field), message);
    assert.equal(row.position, field.p, message); assert.equal(row.width, field.w, message);
    const mixedType = row.fieldType !== field.t;
    if (mixedType) {
        assert.equal(row.nativeFieldType, -2, message); assert.equal(row.fieldType, 'real', message); assert.equal(field.t, 'string', message);
        assert.ok(["CONTROL_IMPLICIT_SSD_DIRECT/FSPACE/record:833ab7287ce50c4404e8d545:0ad1c1f73d1dab51644af463", "ICFD_BOUNDARY_NAVIERSLIP/LS/record:139e927c39643113eb53026e:ac60f9d133da65352e8dc2f3"]
            .includes(keyword + '/' + field.n + '/' + field.nativeIdentity.fieldRecordId), message + ': unknown type projection');
    }
    let relation = row.relation;
    const sibling = row.siblingTargetBinding;
    if (sibling) {
        const controller = card.find(item => item.nativeIdentity.fieldRecordId === sibling.nativeFieldAddress);
        if (!controller) { assert.equal(actual, null, message); return; }
        let value = document.lineAt(position.line).text.slice(controller.p, controller.p + controller.w).trim() || sibling.defaultValue;
        if (sibling.controllerValueMode === 'native-string-choice') value = nativeStringChoice(value, sibling.nativeChoiceSelection.choices);
        relation = sibling.branches.find(branch => branch.when ? evaluatePredicate(branch.when, { currentValue: Number(value) }) === 'true'
            : String(branch.value).toUpperCase() === String(value).toUpperCase())?.relation || sibling.otherwiseRelation;
    }
    const raw = document.lineAt(position.line).text.slice(field.p, field.p + field.w), value = Number(raw.trim());
    if (mixedType) assert.equal(value, 0, message + ': unobserved mixed-type reference value');
    const branch = relation?.branches?.find(item => evaluatePredicate(item.when, { currentValue: value }) === 'true');
    const reference = relation?.kind === 'entity-reference' ? relation : branch?.role === 'reference' ? branch : null;
    if (!reference || !Number.isSafeInteger(value) || !value) { assert.equal(actual, null, message); return; }
    assert.ok(actual, message + ': independently sourced reference missing');
    assert.equal(actual.authorityScope, "keyword-catalog", message); assert.equal(actual.referenceInfo.source, "keyword-catalog", message);
    assert.deepEqual(actual.field.nativeIdentity, field.nativeIdentity, message); assert.equal(actual.rawValue, raw, message);
    assert.deepEqual(actual.sourceRange, { line: position.line, startCharacter: field.p, endCharacter: field.p + field.w }, message);
    assert.deepEqual(actual.referenceInfo.relation, relation, message);
    assert.deepEqual(actual.referenceValue.targetKinds, reference.targetKinds, message);
    assert.deepEqual(actual.referenceValue.targetDefinitions, reference.targetKeywords.map(target => target.replace(/^\*/, '')), message);
    assert.equal(actual.referenceValue.idTransform, reference.idTransform || 'identity', message);
    assert.equal(actual.referenceInfo.definitionRegistry.selectorSource, "keyword-catalog", message);
    assert.equal(actual.referenceInfo.definitionRegistry.decisionId, null, message);
};
