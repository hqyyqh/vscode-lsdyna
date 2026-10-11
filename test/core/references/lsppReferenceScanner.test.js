'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const referenceIndex = require("../../../keywords/runtime/references/field_reference_index.json");
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
const { indexedEntityKinds, queryIndexedEntityId } =
    require('../../../out/core/references/indexedEntityQuery');
const { scanRegistryReferenceOccurrencesFromFileIndex } =
    require('../../../out/core/references/registryReferenceScanner');

async function scan(keyword, text) {
    const block = { filePath: '/fixture/relations.key', keyword: `*${keyword}`,
        rawKeyword: text.split('\n')[0], startLine: 0, endLine: text.split('\n').length - 1 };
    return scanRegistryReferenceOccurrencesFromFileIndex(
        { keywordBlocks: [block], referenceDefinitions: {} }, async () => text);
}

describe("keyword catalog reference scanner", () => {
    it('follows the SOIL HLC gate independently for successive body instances', async () => {
        for (const suffix of ['', '_SET', '_CONSTANTS', '_CONSTANTS_SET'])
            for (const mode of ['standard', 'comma', 'long', 'i10']) {
                const keyword = 'CONSTRAINED_SOIL_PILE' + suffix;
                const row = values => mode === 'comma' ? values.join(',') :
                    values.map(value => String(value).padStart(mode === 'long' ? 20 : 10)).join('');
                const lines = ['*' + keyword + (mode === 'long' ? '+' : mode === 'i10' ? '%' : ''),
                    row([0, 1, 0, 0, 0, 0, 0, 0])];
                if (suffix.includes('CONSTANTS')) lines.push(row([0, 0, 0, 0, 0, 0, 0, 0]));
                const expected = [];
                for (const [index, hlc] of [0, 1, -1].entries()) {
                    expected.push([73 + index, lines.length]);
                    lines.push(row([73 + index, 0, 0, 0, 0, 0, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, 0]),
                        row([0, 0, 0, 0, 0, 0, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, hlc]));
                    if (hlc !== 0) lines.push(row([0, 0, 0, 0, 0, 0]));
                }
                const result = await scan(keyword, lines.join('\n'));
                assert.deepEqual(result.referenceOccurrences.filter(item => item.fieldName === 'PID')
                    .map(item => [item.referenceValue.id, item.lineIndex]), expected, `${keyword}/${mode}`);
                assert.ok(!result.reasons.includes('registry-reference-native-layout-unavailable'), `${keyword}/${mode}`);
            }
    });

    it('reads every IGA XYZ instance as a head and body pair', async () => {
        for (const transform of [false, true]) for (const mode of ['standard', 'comma', 'long', 'i10']) {
            const keyword = 'IGA_VOLUME_XYZ' + (transform ? '_BASIS_TRANSFORM' : '');
            const row = values => mode === 'comma' ? values.join(',') :
                values.map(value => String(value).padStart(mode === 'long' ? 20 : 10)).join('');
            const result = await scan(keyword, ['*' + keyword + (mode === 'long' ? '+' : mode === 'i10' ? '%' : ''),
                row([0, 73, 0, 0, 0]), row([transform ? 0 : 83, 0, 0, 0, 0, 0, 0, 0]),
                row([0, 93, 0, 0, 0]), row([transform ? 0 : 103, 0, 0, 0, 0, 0, 0, 0])].join('\n'));
            assert.deepEqual(result.referenceOccurrences.filter(item => item.fieldName === 'PATCHID')
                .map(item => [item.referenceValue.id, item.targetKinds, item.lineIndex]),
                [[73, [transform ? 'iga-3d-basis-transform-xyz' : 'iga-3d-nurbs-xyz'], 1],
                    [93, [transform ? 'iga-3d-basis-transform-xyz' : 'iga-3d-nurbs-xyz'], 3]], `${keyword}/${mode}`);
            if (!transform) assert.deepEqual(result.referenceOccurrences.filter(item => item.fieldName === 'BRID1')
                .map(item => [item.referenceValue.id, item.lineIndex]), [[83, 2], [103, 4]], mode);
        }
    });
    it('keeps the SOIL PILE CURVES header separate from every four-card body instance', async () => {
        for (const set of [false, true]) for (const mode of ['standard', 'comma', 'long', 'i10']) {
            const keyword = 'CONSTRAINED_SOIL_PILE_CURVES' + (set ? '_SET' : '');
            const row = values => mode === 'comma' ? values.join(',') :
                values.map(value => String(value).padStart(mode === 'long' ? 20 : 10)).join('');
            const result = await scan(keyword, ['*' + keyword + (mode === 'long' ? '+' : mode === 'i10' ? '%' : ''),
                row([0, 1, 0, 0, 0, 0, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, 0]),
                row([73, 0]), row([0, 83, 0, 0]), row([0, 0, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, 0]),
                row([93, 0]), row([0, 103, 0, 0]), row([0, 0, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, 0])].join('\n'));
            assert.deepEqual(result.referenceOccurrences.filter(item => [set ? 'PSID' : 'PID', 'BLC'].includes(item.fieldName))
                .map(item => [item.fieldName, item.referenceValue.id, item.targetKinds, item.lineIndex]),
                [[set ? 'PSID' : 'PID', 73, [set ? 'part-set' : 'part'], 3], ['BLC', 83, ['curve'], 4],
                    [set ? 'PSID' : 'PID', 93, [set ? 'part-set' : 'part'], 7], ['BLC', 103, ['curve'], 8]],
                `${keyword}/${mode}: ${JSON.stringify(result.reasons)}`);
        }
    });

    it('selects SSI targets per body instance after a single optional ID prefix', async () => {
        const interfaceDefinitions = ['NODE', 'SEGMENT', 'SPH'].flatMap(kind =>
            ['ID', 'TITLE'].map(suffix => 'INTERFACE_COMPONENT_' + kind + '_' + suffix));
        for (const family of ['DECONV', 'NODE', 'POINT', 'SET']) for (const named of [false, true])
            for (const mode of ['standard', 'comma', 'long', 'i10']) {
                const keyword = 'LOAD_SEISMIC_SSI_' + family + (named ? '_ID' : '');
                const point = family === 'DECONV' || family === 'POINT';
                const row = (values, widths = values.map(() => 10)) => mode === 'comma' ? values.join(',') :
                    values.map((value, index) => String(value).padStart(mode === 'long' ? 20 : widths[index])).join('');
                const body = () => point ? row([-73, 0, 0, 0, -83, 0, 0], [8, 16, 16, 16, 8, 8, 8])
                    : row([-73, 0, -83, 0, 0]);
                const control = value => row([1, 0, 0, 0, value, value, ...(family === 'DECONV' ? [0, 3] : [])]);
                const result = await scan(keyword, ['*' + keyword + (mode === 'long' ? '+' : mode === 'i10' ? '%' : ''),
                    ...(named ? [row([980001]) + 'SSI original synthetic title'] : []),
                    body(), control(0), body(), control(1)].join('\n'));
                const references = result.referenceOccurrences.filter(item => ['SSID', 'GMX'].includes(item.fieldName));
                assert.deepEqual(references.map(item => [item.fieldName, item.referenceValue.id, item.targetKinds,
                    Boolean(item.targetDefinitionUnavailable), item.lineIndex]), [
                    ['SSID', 73, ['interface-id'], false, 1 + Number(named)],
                    ['GMX', 83, ['curve'], false, 1 + Number(named)],
                    ['SSID', 73, ['segment-set'], false, 3 + Number(named)],
                    ['GMX', 83, ['ground-motion'], false, 3 + Number(named)],
                ], `${keyword}/${mode}: ${JSON.stringify(result.reasons)}`);
                assert.deepEqual(references[0].targetDefinitions, interfaceDefinitions, `${keyword}/${mode}`);
            }
    });

    it('reads the interpolation controller once and applies it to every native tail record', async () => {
        for (const local of [false, true]) for (const mode of ['standard', 'comma', 'long', 'i10']) {
            const keyword = 'CONSTRAINED_INTERPOLATION' + (local ? '_LOCAL' : '');
            const row = values => mode === 'comma' ? values.join(',') :
                values.map(value => String(value).padStart(mode === 'long' ? 20 : 10)).join('');
            const result = await scan(keyword, ['*' + keyword + (mode === 'long' ? '+' : mode === 'i10' ? '%' : ''),
                row([980001, 0, 0, 0, 1, 0, 0]), row([73]), ...(local ? [row([0])] : []),
                row([83]), ...(local ? [row([0])] : []), row([93]), ...(local ? [row([0])] : [])].join('\n'));
            assert.deepEqual(result.referenceOccurrences.filter(item => item.fieldName === 'INID')
                .map(item => [item.referenceValue.id, item.targetKinds, item.lineIndex]),
                [73, 83, 93].map((id, index) => [id, ['node-set'], 2 + index * (local ? 2 : 1)]), `${keyword}/${mode}`);
        }
    });

    it('uses the EFV tail segment target and leaves records beyond the native two-card instance unconsumed', async () => {
        for (const suffix of ['', '_EROSION', '_RIGID']) for (const mode of ['standard', 'comma', 'long', 'i10']) {
            const keyword = 'EFV_COUPLING' + suffix;
            const row = values => mode === 'comma' ? values.join(',') :
                values.map(value => String(value).padStart(mode === 'long' ? 20 : 10)).join('');
            const result = await scan(keyword, ['*' + keyword + (mode === 'long' ? '+' : mode === 'i10' ? '%' : ''),
                row([0, 73, 1, .5]), row([0, 74]), row([0, 75, 2, .5]), row([0, 76])].join('\n'));
            assert.deepEqual(result.referenceOccurrences.filter(item => item.fieldName === 'SETSTR')
                .map(item => [item.referenceValue.id, item.targetKinds, item.lineIndex]),
                [[73, ['part-set'], 1], [74, ['segment-set'], 2]], `${keyword}/${mode}`);
        }
    });

    it('reads every SOLID node through the actual registered descriptor in all formats', async () => {
        for (const mode of ['standard', 'comma', 'long', 'i10']) {
            const width = mode === 'long' ? 20 : mode === 'i10' ? 10 : 8;
            const row = values => mode === 'comma' ? values.join(',') : values.map(value => String(value).padStart(width)).join('');
            const result = await scan('ELEMENT_SOLID', ['*ELEMENT_SOLID' + (mode === 'long' ? '+' : mode === 'i10' ? '%' : ''),
                row([980001, 73, 1, 2, 3, 4, 5, 6, 7, 8]), row([980002, 73, 11, 12, 13, 14, 15, 16, 17, 73])].join('\n'));
            assert.deepEqual(result.referenceOccurrences.filter(item => item.referenceValue.id === 73)
                .map(item => [item.fieldName, item.targetKinds, item.lineIndex]),
                [['PID', ['part'], 1], ['PID', ['part'], 2], ['N8', ['node'], 2]], mode);
            assert.equal(result.referenceCoverage.complete, true, JSON.stringify(result.reasons));
        }
    });
    it('reads DATABASE_MAX records through the actual first native card without mixing the following SET pool', async () => {
        for (const [family, link] of [['BEAM', 3], ['SHELL', 4], ['SOLID', 5], ['TSHELL', 6]])
            for (const named of [false, true]) for (const mode of ['standard', 'comma', 'long', 'i10']) {
                const keyword = 'DATABASE_MAX_' + family + (named ? '_ID' : '');
                const row = id => mode === 'comma' ? `${id},${named ? 'Result label' : 0}` :
                    String(id).padStart(mode === 'long' ? 20 : 10) + (named ? 'Result label' : '');
                const result = await scan(keyword, ['*' + keyword + (mode === 'long' ? '+' : mode === 'i10' ? '%' : ''),
                    row(73), row(83), row(93)].join('\n'));
                assert.deepEqual(result.referenceOccurrences.map(item => [item.fieldName, item.referenceValue.id, item.lineIndex]),
                    [['ID1', 73, 1], ['ID1', 83, 2], ['ID1', 93, 3]], keyword + ':' + mode);
                assert.ok(result.referenceOccurrences.every(item => item.sourceRuleId.startsWith('lspp:' + link + ':')));
                assert.equal(result.referenceCoverage.complete, true, JSON.stringify(result.reasons));
            }
    });
    it('uses only the actual IGA file cards and scans every repeated row in all formats', async () => {
        for (const [keyword, kind, field] of [
            ['SET_IGA_EDGE_UVW', 'iga-edge-uvw', 'EID1'],
            ['SET_IGA_FACE_XYZ', 'iga-face-xyz', 'EID1'],
            ['SET_IGA_FACE_UVW_COLLECT', 'iga-face-xyz', 'EID1'],
            ['SET_IGA_POINT_UVW_LIST_GENERATE', 'iga-point', 'B1BEG'],
        ]) for (const title of [false, true]) for (const mode of ['standard', 'long', 'i10', 'comma']) {
            const row = values => mode === 'comma' ? values.join(',') :
                values.map(value => String(value).padStart(mode === 'long' ? 20 : 10)).join('');
            const name = keyword + (title ? '_TITLE' : '');
            const result = await scan(name, ['*' + name + (mode === 'long' ? '+' : mode === 'i10' ? '%' : ''),
                ...(title ? ['IGA repeated references'] : []), row([970001]),
                row([73, 75, 1]), row([83, 85, 1]), row([93, 95, 1])].join('\n'));
            assert.deepEqual(result.referenceOccurrences.filter(item => item.fieldName === field)
                .map(item => [item.targetKinds[0], item.referenceValue.id, item.lineIndex]),
                [[kind, 73, 2 + Number(title)], [kind, 83, 3 + Number(title)], [kind, 93, 4 + Number(title)]], name + ':' + mode);
            assert.equal(result.reasons.includes('registry-reference-native-layout-unavailable'), false);
        }
    });
    it('scans repeated fixed native registrations beyond the schema card count', async () => {
        const result = await scan('AIRBAG_REFERENCE_GEOMETRY', '*AIRBAG_REFERENCE_GEOMETRY\n      73\n      83\n      93');
        assert.deepEqual(result.referenceOccurrences.filter(item => item.fieldName === 'NID')
            .map(item => [item.referenceValue.id, item.lineIndex]), [[73, 1], [83, 2], [93, 3]]);
    });
    it('selects GENERAL tail namespaces per native OPTION record, including TITLE and native comma behavior', async () => {
        for (const collect of [false, true]) for (const title of [false, true]) for (const mode of ['standard', 'long', 'i10', 'comma']) {
            const width = mode === 'long' ? 20 : 10;
            const row = (option, id) => mode === 'comma' ? `${option},${id}` : option.padEnd(width) + String(id).padStart(width);
            const keyword = 'SET_NODE_GENERAL' + (collect ? '_COLLECT' : '') + (title ? '_TITLE' : '');
            const text = ['*' + keyword + (mode === 'long' ? '+' : mode === 'i10' ? '%' : ''),
                ...(title ? ['General reference verification'] : []), String(970001).padStart(width),
                row('NODE', 73), row('PART', 73), row('BOX', 73), row('SET_SHELL', 73), row('NODE', 74)].join('\n');
            const result = await scan(keyword, text);
            assert.deepEqual(result.referenceOccurrences.map(item => [item.targetKinds[0], item.referenceValue.id, item.lineIndex]),
                mode === 'comma' ? [] : [['node', 73, 2 + Number(title)], ['part', 73, 3 + Number(title)],
                    ['box', 73, 4 + Number(title)], ['shell-set', 73, 5 + Number(title)], ['node', 74, 6 + Number(title)]],
                JSON.stringify({ keyword, mode, reasons: result.reasons }));
        }
        const unresolved = await scan('SET_NODE_GENERAL', '*SET_NODE_GENERAL\n    970001\n&OPTION           73');
        assert.ok(unresolved.reasons.includes('registry-reference-native-layout-unavailable'));
    });
    it('reads every node and part list row through the native registration, including TITLE and all formats', async () => {
        for (const keyword of ['SET_NODE_LIST', 'SET_PART_LIST']) for (const title of [false, true])
            for (const mode of ['standard', 'comma', 'long', 'i10']) {
                const row = values => mode === 'comma' ? values.join(',') :
                    values.map(value => String(value).padStart(mode === 'long' ? 20 : 10)).join('');
                const name = keyword + (title ? '_TITLE' : '');
                const text = ['*' + name + (mode === 'long' ? '+' : mode === 'i10' ? '%' : ''),
                    ...(title ? ['73'] : []), row([970001]), row([1, 2]), '$ between rows', row([3, 73]), row([73, 4])].join('\n');
                const result = await scan(name, text);
                assert.deepEqual(result.referenceOccurrences.filter(item => item.referenceValue.id === 73)
                    .map(item => [item.fieldName, item.lineIndex, item.targetKinds]),
                [[keyword === 'SET_NODE_LIST' ? 'NID2' : 'PID2', 4 + Number(title), [keyword === 'SET_NODE_LIST' ? 'node' : 'part']],
                    [keyword === 'SET_NODE_LIST' ? 'NID1' : 'PID1', 5 + Number(title), [keyword === 'SET_NODE_LIST' ? 'node' : 'part']]],
                `${name}/${mode}`);
            }
    });
    it('reads a native spelling without a rendered schema through its verified file reader', async () => {
        const { lookupKeywordSchema, loadKeywordSchema } = require('../../../out/core/keywordSchema');
        assert.equal(lookupKeywordSchema('BOUNDARY_NON_REFLECTING_ID', loadKeywordSchema()), null);
        for (const format of ['standard', 'comma', 'long', 'i10']) {
            const marker = format === 'long' ? '+' : format === 'i10' ? '%' : '';
            const row = format === 'comma' ? '73001,0,0' : [73001, 0, 0]
                .map(value => String(value).padStart(format === 'long' ? 20 : 10)).join('');
            const result = await scan('BOUNDARY_NON_REFLECTING_ID', '*BOUNDARY_NON_REFLECTING_ID' + marker + '\n' + row);
            assert.deepEqual(result.referenceOccurrences.map(occurrence => [occurrence.fieldName,
                occurrence.referenceValue.id, occurrence.targetKinds, occurrence.lineIndex]),
                [['SSID', 73001, ['segment-set'], 1]], JSON.stringify({ format, reasons: result.reasons }));
        }
    });
    it('uses native curve/function priority for both signs without mixing same-ID targets', async () => {
        const { queryIndexedEntityId } = require('../../../src/core/references/indexedEntityQuery');
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-native-priority-'));
        try {
        for (const format of ['standard', 'comma', 'long']) {
            const row = values => format === 'comma' ? values.join(',') : values.map(value => String(value).padStart(format === 'long' ? 20 : 10)).join('');
            for (const primary of [true, false]) for (const id of [73, -73]) {
                const filePath = path.join(tempRoot, 'native-priority-' + format + '.k');
                const deck = ['*KEYWORD', ...(primary ? ['*DEFINE_CURVE' + (format === 'long' ? '+' : ''),
                    row([73]), row([0, 0])] : []), '*DEFINE_FUNCTION' + (format === 'long' ? '+' : ''), row([73]), 'f(t)=1',
                    '*ALE_INJECTION' + (format === 'long' ? '+' : ''), row([0, 0, 0, id]), '*END'].join('\n');
                fs.writeFileSync(filePath, deck);
                const fileIndex = await buildFileIndex(filePath);
                const snapshot = { rootFile: filePath, files: [filePath], scope: 'single-file',
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true }, fileIndexes: new Map([[filePath, fileIndex]]) };
                for (const kind of ['curve', 'function']) {
                    const result = await queryIndexedEntityId({ snapshot, id: 73, targetKind: kind,
                        scanBlockLines: async (block, onLine) => { const lines = deck.split('\n');
                            for (let line = block.startLine + 1; line <= block.endLine; line++) onLine(lines[line], line);
                            return { complete: true, keywordLineText: lines[block.startLine] }; } });
                    assert.equal(result.locations.filter(location => location.role === 'reference' && location.fieldName === 'LCE').length,
                        kind === (primary ? 'curve' : 'function') ? 1 : 0,
                        JSON.stringify({ format, primary, id, kind, reasons: result.reasons }));
                }
            }
        }
        } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
    });
    it('binds native cursor fields only to one matching source and never falls back from a foreign identity', () => {
        const { getCatalogFieldReferenceInfo } = require('../../../out/core/references/registryReferenceScanner');
        const form = require("../../../out/core/semantics/catalogInputFormCatalogV4").getCatalogInputFormCatalogV4().formForKeyword('ELEMENT_BEAM');
        const rule = form.rules[form.reference.formRuleIds[0]], native = rule.cards[0].fields[3];
        const field = { n: native.name, t: 'integer', p: 24, w: 8,
            nativeIdentity: { source: form.source.datasetSha256, cardIndex: 1, fieldRecordId: native.fieldRecordId } };
        assert.deepEqual(getCatalogFieldReferenceInfo({ keyword: 'ELEMENT_BEAM', cardIndex: 99, field }).targetKinds, ['node']);
        for (const nativeIdentity of [{ ...field.nativeIdentity, source: 'foreign' },
            { ...field.nativeIdentity, fieldRecordId: '0x0' }, { ...field.nativeIdentity, cardIndex: 2 }]) {
            assert.equal(getCatalogFieldReferenceInfo({ keyword: 'ELEMENT_BEAM', cardIndex: 1,
                field: { ...field, nativeIdentity } }), null);
        }
    });
    it('reads source-bound fields through native fixed and conditional file layouts, excluding inactive descriptor cards', async () => {
        const row = values => values.map(value => String(value).padStart(10)).join('');
        const fixed = await scan('BOUNDARY_CYCLIC', '*BOUNDARY_CYCLIC\n' + row([0, 0, 0, 0, 0, 0, 0, 73]));
        assert.ok(fixed.referenceOccurrences.some(item => item.fieldName === 'CID' && item.referenceValue.id === 73));
        for (const control of [1, -1]) {
            const lines = ['*MAT_036', row([1, 1, 1, 0.3, 0, 0, 0, 0]), row([control, 0, 0, 0, 0, 0, 0, 0])];
            if (control < 0) lines.push(row([0, 0, 0, 0, 0, 0, 0, 0]));
            lines.push(row([0, 0, 0, 0, 0, 0, 73, 0]), row([0, 0, 0, 0, 0, 0, 0, 0]), row([0, 0, 0, 0, 0, 0, 0, 0]));
            const conditional = await scan('MAT_036', lines.join('\n'));
            assert.deepEqual(conditional.referenceOccurrences.filter(item => item.fieldName === 'HTA')
                .map(item => [item.referenceValue.id, item.lineIndex]), [[73, control < 0 ? 4 : 3]]);
        }
        const trimmed = await scan('DATABASE_ACEOUT', '*DATABASE_ACEOUT\n' + row([0]) + '\n' + row([0, 0, 73, 0]));
        assert.equal(trimmed.referenceOccurrences.some(item => item.fieldName === 'LCUR'), false);
    });

    it('applies native packed references on signed real fields without converting positive scalars into IDs', async () => {
        const row = values => values.map(value => String(value).padStart(10)).join('');
        for (const value of ['-73.0', '73.0', '0.0', '-0.3']) {
            const result = await scan('EM_PERMANENT_MAGNET', '*EM_PERMANENT_MAGNET\n' + row([1, 0, 3, 0, 0, value]));
            const references = result.referenceOccurrences.filter(item => item.fieldName === 'HC');
            assert.equal(references.length, value === '-73.0' ? 1 : 0, value);
        }
    });
    it('selects CONTACT targets by SURFATYP, including defaults and explicit non-reference values', async () => {
        for (const mode of ['standard', 'comma', 'long']) {
            const width = mode === 'long' ? 20 : 10;
            const keyword = 'CONTACT_AUTOMATIC_SINGLE_SURFACE';
            for (const [type, expected] of [['0', 'segment-set'], ['1', 'shell-set'],
                ['2', 'part-set'], ['3', 'part'], ['4', 'node-set'], ['6', 'part-set'], ['', 'segment-set'],
                ['5', null], ['7', ['part-tree-set', 'part']], ['&TYPE', 'unknown']]) {
                const values = [73, 0, type, 5, 0, 0, 0, 0];
                const row = mode === 'comma' ? values.join(',') :
                    values.map(value => String(value).padStart(width)).join('');
                const result = await scan(keyword, '*' + keyword + (mode === 'long' ? '+' : '') + '\n' + row);
                const references = result.referenceOccurrences.filter(item => item.fieldName === 'SURFA');
                if (expected === 'unknown') {
                    assert.equal(references.length, 0);
                    assert.equal(result.referenceCoverage.complete, false);
                } else if (expected) {
                    assert.equal(references.length, 1, `${mode}:${type}`);
                    assert.deepEqual(references[0].targetKinds, Array.isArray(expected) ? expected : [expected]);
                    assert.equal(references[0].referenceValue.id, 73);
                } else assert.equal(references.length, 0, `${mode}:${type}`);
                assert.equal(result.referenceOccurrences.some(item => item.fieldName === 'SURFATYP'), false);
            }
        }
    });

    it('keeps packed negative values and signed PART/SET_PART IDs separate on the product scanner', async () => {
        for (const value of [-73, 73, 0, '-&CURVE']) {
            const row = [1, 0, 0, 0, 0, 0, value, 0].map(x => String(x).padStart(10)).join('');
            const result = await scan('PART', '*PART\nPart\n' + row);
            const references = result.referenceOccurrences.filter(item => item.fieldName === 'ADPOPT');
            assert.equal(references.length, value === -73 || value === '-&CURVE' ? 1 : 0);
            if (references.length) {
                assert.deepEqual(references[0].targetKinds, ['curve']);
                assert.ok(references[0].sourceRuleId.startsWith('lspp:-4864:'));
                assert.ok(references[0].referenceValue.semanticRelation);
                if (value === -73) assert.equal(references[0].referenceValue.id, 73);
                else assert.equal(references[0].referenceValue.kind, 'parameter');
            }
        }
        const keyword = 'CONTROL_MPP_DECOMPOSITION_PARTS_DISTRIBUTE';
        const result = await scan(keyword, '*' + keyword + '\n' +
            [73, -73, 0, 0, 0, 0, 0, 0].map(x => String(x).padStart(10)).join(''));
        const ids = result.referenceOccurrences.filter(item => ['ID1', 'ID2'].includes(item.fieldName));
        assert.deepEqual(ids.map(item => [item.fieldName, item.referenceValue.id, item.targetKinds]),
            [['ID1', 73, ['part']], ['ID2', 73, ['part-set']]]);
    });

    it('connects existing node-set, EOS and thermal definition scanners without mixing identical IDs', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lspp-scanner-bridge-'));
        const filePath = path.join(directory, 'main.key');
        const row = values => values.map(value => String(value).padStart(10)).join('');
        fs.writeFileSync(filePath, ['*KEYWORD', '*SET_NODE_LIST', row([73, 0, 0, 0, 0, 0, 1]),
            row([1, 2, 3]), '*EOS_LINEAR_POLYNOMIAL', row([73, 0, 0, 0, 0, 0, 0, 0]),
            row([0, 1]), '*MAT_THERMAL_ISOTROPIC', row([73, 1, 1, 1]),
            '*PART', 'Same numeric ID in separate namespaces', row([73, 0, 0, 73, 0, 0, 0, 73]),
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE', row([73, 0, 4, 5, 0, 0, 0, 0]), '*END'].join('\n'));
        try {
            const fileIndex = await buildFileIndex(filePath);
            const snapshot = { scope: 'single-file', rootFile: filePath, files: [filePath],
                graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                fileIndexes: new Map([[filePath, fileIndex]]) };
            for (const [targetKind, definition, referenceField] of [
                ['node-set', '*SET_NODE_LIST', 'SURFA'],
                ['equation-of-state', '*EOS_LINEAR_POLYNOMIAL', 'EOSID'],
                ['thermal-material', '*MAT_THERMAL_ISOTROPIC', 'TMID'],
            ]) {
                const result = await queryIndexedEntityId({ id: 73, targetKind, snapshot });
                assert.ok(result.locations.some(item => item.role === 'definition' && item.keyword === definition), targetKind);
                const references = result.locations.filter(item => item.role === 'reference');
                assert.equal(references.length, 1, JSON.stringify(references));
                assert.equal(references[0].fieldName, referenceField, targetKind);
            }
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });

    it('reads every verified repeated beam record and bounds overflow with one coverage gap', async () => {
        const row = values => values.map(value => String(value).padStart(8)).join('');
        const text = ['*ELEMENT_BEAM', row([1, 8, 73, 1, 0]), row([2, 9, 1, 73, 0])].join('\n');
        const result = await scan('ELEMENT_BEAM', text);
        const matches = result.referenceOccurrences.filter(item => item.referenceValue.id === 73);
        assert.deepEqual(matches.map(item => [item.fieldName, item.lineIndex]), [['N1', 1], ['N2', 2]]);
        const block = { filePath: '/fixture/repeated.key', keyword: '*ELEMENT_BEAM', rawKeyword: '*ELEMENT_BEAM', startLine: 0 };
        const limited = await scanRegistryReferenceOccurrencesFromFileIndex({ keywordBlocks: [block] }, async () => text,
            { maxReferenceOccurrences: 3 });
        assert.equal(limited.referenceCoverage.complete, false);
        assert.equal(limited.referenceCoverage.gaps.filter(gap => gap.reason === 'registry-reference-capacity-exceeded').length, 1);
    });

    it('queries TITLE definition aliases at the ID row in standard, comma and long formats', async () => {
        for (const mode of ['standard', 'comma', 'long']) {
            const row = values => mode === 'comma' ? values.join(',') :
                values.map(value => String(value).padStart(mode === 'long' ? 20 : 10)).join('');
            const suffix = mode === 'long' ? '+' : '';
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lspp-title-definition-'));
            const filePath = path.join(directory, 'main.key');
            fs.writeFileSync(filePath, ['*KEYWORD', '*MAT_THERMAL_ISOTROPIC_TITLE' + suffix,
                '73001', row([73001, 1, 0, 0]), row([1, 1]), '*PART' + suffix,
                'Part', row([1, 0, 0, 0, 0, 0, 0, 73001]), '*END'].join('\n'));
            try {
                const fileIndex = await buildFileIndex(filePath);
                const result = await queryIndexedEntityId({ id: 73001, targetKind: 'thermal-material',
                    snapshot: { scope: 'single-file', rootFile: filePath, files: [filePath],
                        graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                        fileIndexes: new Map([[filePath, fileIndex]]) } });
                assert.deepEqual(result.locations.map(item => [item.role, item.fieldName, item.line]),
                    [['definition', 'TMID', 3], ['reference', 'TMID', 7]], mode);
            } finally { fs.rmSync(directory, { recursive: true, force: true }); }
        }
    });

    it('finds section references through native forms without importing ICFD namespaces', async () => {
        for (const mode of ['standard', 'comma', 'long']) {
            const width = mode === 'long' ? 20 : 10;
            const suffix = mode === 'long' ? '+' : '';
            const row = values => mode === 'comma' ? values.join(',') :
                values.map(value => String(value).padStart(width)).join('');
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lspp-section-reference-'));
            const filePath = path.join(directory, 'main.key');
            const text = ['*KEYWORD', '*SECTION_SHELL_TITLE' + suffix, 'Section definition',
                row([73001, 2, 1]), '*HOURGLASS' + suffix, row([73001, 1, 0.1]),
                '*PART' + suffix, 'Part with section and hourglass', row([1, 73001, 0, 0, 73001, 0, 0, 0]),
                '*ICFD_PART' + suffix, row([2, 73001, 73001]), '*END'].join('\n');
            fs.writeFileSync(filePath, text);
            try {
                const fileIndex = await buildFileIndex(filePath);
                const nativeSection = fileIndex.registryReferences.referenceOccurrences.filter(item =>
                    item.sourceRuleId.startsWith('lspp:15:') && item.fieldName === 'SECID');
                assert.equal(nativeSection.length, 1, mode);
                assert.deepEqual(nativeSection[0].targetKinds, ['section']);
                assert.equal(fileIndex.registryReferences.referenceOccurrences.some(item =>
                    item.keyword === '*PART' && item.targetKinds.includes('icfd-section')), false);
                const query = await queryIndexedEntityId({ id: 73001, targetKind: 'section',
                    snapshot: { scope: 'single-file', rootFile: filePath, files: [filePath],
                        graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                        fileIndexes: new Map([[filePath, fileIndex]]) } });
                assert.deepEqual(query.locations.map(item => [item.role, item.fieldName, item.line]),
                    [['definition', 'SECID', 3], ['reference', 'SECID', 8]], mode);
            } finally { fs.rmSync(directory, { recursive: true, force: true }); }
        }
    }).timeout(30000);

    it('publishes the complete Transformation relation family from link code 40', async function () {
        this.timeout(10000);
        assert.ok(indexedEntityKinds().includes('transformation'));
        for (const keyword of [
            'DEFINE_TRANSFORM', 'DEFINE_TRANSFORMATION',
            'DEFINE_TRANSFORM_TITLE', 'DEFINE_TRANSFORMATION_TITLE',
        ]) {
            assert.equal(referenceIndex.definitionKeywords.generic[keyword].targetKind,
                'transformation', keyword);
        }
        assert.deepEqual(Object.keys(referenceIndex.references)
            .filter(keyword => referenceIndex.references[keyword].some(item => item.linkCode === 40))
            .sort(), [
            'INCLUDE_TRANSFORM', 'INCLUDE_TRANSFORM_BINARY', 'NODE_TRANSFORM', 'PART_DUPLICATE',
        ]);

        const node = await scan('NODE_TRANSFORM', '*NODE_TRANSFORM\n   1000001');
        const part = await scan('PART_DUPLICATE', [
            '*PART_DUPLICATE',
            [1, 2, 3, 4, 5, 1000001].map(value => String(value).padStart(10)).join(''),
        ].join('\n'));
        for (const [result, fieldName] of [[node, 'TRSID'], [part, 'TRANID']]) {
            const occurrence = result.referenceOccurrences.find(item => item.fieldName === fieldName);
            assert.equal(occurrence.referenceValue.id, 1000001);
            assert.deepEqual(occurrence.targetKinds, ['transformation']);
            assert.equal(occurrence.sourceRuleId.startsWith('lspp:40:'), true);
        }
    });

    it('finds INCLUDE_TRANSFORM/TRANID across its intentionally blank card', async () => {
        const result = await scan('INCLUDE_TRANSFORM', [
            '*INCLUDE_TRANSFORM',
            'test2/wall2.key',
            '  10000000  10000000  10000000  10000000  10000000  10000000  10000000',
            '  10000000',
            '',
            '$#  tranid',
            '   1000001',
        ].join('\n'));
        const occurrence = result.referenceOccurrences.find(item => item.fieldName === 'TRANID');
        assert.equal(result.complete, true, JSON.stringify(result.reasons));
        assert.equal(occurrence.cardIndex, 5);
        assert.equal(occurrence.lineIndex, 6);
        assert.equal(occurrence.referenceValue.id, 1000001);
    });

    it('resolves the definition and reference through the indexed object query', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lspp-transform-reference-'));
        const filePath = path.join(directory, 'main.key');
        fs.writeFileSync(filePath, [
            '*KEYWORD',
            '*DEFINE_TRANSFORMATION',
            '   1000001',
            '*INCLUDE_TRANSFORM',
            'test2/wall2.key',
            '  10000000  10000000  10000000  10000000  10000000  10000000  10000000',
            '  10000000',
            '',
            '$#  tranid',
            '   1000001',
            '*END',
        ].join('\n'));
        try {
            const fileIndex = await buildFileIndex(filePath);
            const result = await queryIndexedEntityId({
                snapshot: { scope: 'single-file', rootFile: filePath, files: [filePath],
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                    fileIndexes: new Map([[filePath, fileIndex]]) },
                id: 1000001,
                targetKind: 'transformation',
            });
            assert.equal(result.state, 'complete', JSON.stringify(result.reasons));
            assert.deepEqual(result.locations.map(item => [item.role, item.keyword, item.fieldName,
                item.line]), [
                ['definition', '*DEFINE_TRANSFORMATION', 'TRANID', 2],
                ['reference', '*INCLUDE_TRANSFORM', 'TRANID', 9],
            ]);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
