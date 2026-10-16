const assert = require('node:assert/strict');
const { fakeDoc, vscodeMock: vscode } = require('../support/helpers');
const api = require('../../out/extension')._internals;
function document(lines) {
    return Object.assign(fakeDoc(lines.join('\n')), { version: 1, languageId: 'lsdyna', uri: vscode.Uri.file('D:/temp/native-authority.k') });
}

describe('native authority in editor entry points', () => {
    it('matches native descriptor addresses after the reader renumbers file cards', () => {
        const schema = require('../../out/core/keywordSchema');
        const { getCatalogFieldReferenceInfo } = require('../../out/core/references/registryReferenceScanner');
        for (const [keyword, line, names] of [
            ['AIRBAG_FLUID_AND_GAS', 1, ['LCXW', 'LCP']],
            ...['NODE', 'SEGMENT', 'SPH'].map(suffix => ['INTERFACE_COMPONENT_' + suffix, 2, ['CID', 'NID']]),
        ]) {
            const doc = document(['*' + keyword, ...Array(8).fill('        17'.repeat(8)), '*END']);
            const card = schema.getCardInfoForDocumentLine(doc, line);
            for (const name of names) {
                const field = card.card.find(field => field.n === name);
                const request = { keyword, cardIndex: card.cardIndex, field };
                assert.ok(getCatalogFieldReferenceInfo(request), keyword + '/' + name);
                assert.ok(api.fieldReferenceAtPosition(doc, new vscode.Position(line, field.p + 1)));
                for (const invalid of [{ source: 'invalid' }, { fieldRecordId: 'invalid' }, { cardIndex: 999 }])
                    assert.equal(getCatalogFieldReferenceInfo({ ...request, field: { ...field,
                        nativeIdentity: { ...field.nativeIdentity, ...invalid } } }), null);
            }
        }
    });

    it('keeps native reference navigation when a manual composition uses another form pool', () => {
        for (const keyword of ['CONTACT_SURFACE_TO_SURFACE_THERMAL_FRICTION',
            'CONTACT_SURFACE_TO_SURFACE_THERMAL_FRICTION_ID_MPP']) {
            const prefix = keyword.endsWith('_MPP') ? ['7         title', '0'] : [];
            const doc = document(['*' + keyword, ...prefix,
                '        11         0         3'.padEnd(80), ...Array(6).fill('         0'.repeat(8)), '*END']);
            for (const semanticScope of ['prefer-registry', 'registry-approved', "keyword-catalog"]) {
                const source = api.fieldReferenceAtPosition(doc, new vscode.Position(prefix.length + 1, 5), { semanticScope });
                assert.ok(source, keyword + ': ' + semanticScope);
                assert.equal(source.referenceInfo.source, "keyword-catalog");
                assert.deepEqual(source.referenceValue.targetKinds, ['part']);
                assert.equal(source.referenceValue.id, 11);
            }
        }
    });

    it('keeps native reference scope and resolves the native sibling selector', () => {
        const doc = document(['*CONTACT_AUTOMATIC_SINGLE_SURFACE',
            '        11         0         3         0'.padEnd(80), ' '.repeat(80), ' '.repeat(80)]);
        for (const semanticScope of ['prefer-registry', 'registry-approved', "keyword-catalog"]) {
            const source = api.fieldReferenceAtPosition(doc, new vscode.Position(1, 5), { semanticScope });
            assert.ok(source, semanticScope);
            assert.equal(source.authorityScope, "keyword-catalog");
            assert.equal(source.referenceInfo.source, "keyword-catalog");
            assert.deepEqual(source.referenceValue.targetKinds, ['part']);
        }
    });

    it('does not gate native structure analysis on the configured manual profile', () => {
        const doc = document(['*MAT_ELASTIC', '         1'.repeat(8), '*END']);
        const fail = () => { throw Error('manual profile must not gate the native reader'); };
        const result = api.analyzeKeywordStructureForDocument(doc, 0, {
            sourceProfileId: 'unavailable-manual', catalog: { lookupBinding: fail, grammarForKeyword: fail },
        });
        assert.equal(result.status, 'valid');
        assert.equal(result.sourceProfileOrigin, "keyword-catalog");
        assert.ok(result.sourceProfileId.startsWith('lspp:'));
        assert.match(api.keywordStructureCheckMessage(result), /LSPP/);
    });
});
