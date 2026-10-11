const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanKeywordSkeletonFromFile } = require('../../../out/core/scanner/keywordSkeletonScanner');
const { readBlockText } = require('../../../out/core/scanner/blockReader');
const { scanCurveTableDefinitionsFromFileIndex } = require('../../../out/core/references/curveTableDefinitionScanner');

async function buildFileIndex(filePath) {
    return {
        filePath,
        keywordBlocks: await scanKeywordSkeletonFromFile(filePath, { highWaterMark: 64 }),
    };
}

describe('scanCurveTableDefinitionsFromFileIndex', () => {
    it('uses verified specialized parsers before generic lookup and keeps unverified-prefix fallback', async () => {
        const keywords = ['DEFINE_CURVE', 'DEFINE_TABLE_2D', 'DEFINE_CURVE_UNREVIEWED', 'SET_CUSTOM',
            'DEFINE_CUSTOM', 'KEYWORD+', 'END'];
        const descriptor = {
            target: 'CUSTOM', cardIndex: 1, fieldIndex: 0,
            fieldName: 'ID', fieldType: 'integer', position: 0, width: 10,
        };
        const lookups = [];
        const reads = [];
        const result = await scanCurveTableDefinitionsFromFileIndex(
            { keywordBlocks: keywords.map((keyword, index) => ({
                keyword, filePath: '/model/definitions.k', startLine: index * 3, endLine: index * 3 + 2,
            })) },
            async block => {
                reads.push(block.keyword);
                return `*${block.keyword}\n${block.startLine + 1}\n0,1`;
            },
            {
                scanned: ['DEFINE_CURVE', 'DEFINE_TABLE_2D'],
                generic: { DEFINE_CUSTOM: descriptor },
            },
            { registryCatalog: { definitionDescriptorForKeyword(keyword) {
                lookups.push(keyword);
                return { ...descriptor, target: keyword };
            } } },
        );
        assert.deepEqual(lookups, ['DEFINE_CURVE_UNREVIEWED', 'SET_CUSTOM']);
        assert.deepEqual(reads, keywords.slice(0, 5));
        assert.deepEqual(result.curves.map(value => [value.keyword, value.id]), [['*DEFINE_CURVE', 1]]);
        assert.deepEqual(result.tables.map(value => [value.keyword, value.id]), [['*DEFINE_TABLE_2D', 4]]);
        assert.deepEqual(result.genericDefinitions.map(value => [value.keyword, value.targetKeyword, value.id]), [
            ['*DEFINE_CURVE_UNREVIEWED', 'DEFINE_CURVE_UNREVIEWED', 7],
            ['*SET_CUSTOM', 'SET_CUSTOM', 10],
            ['*DEFINE_CUSTOM', 'CUSTOM', 13],
        ]);
    });

    it('retains short curve and multidimensional table records as incomplete observations', () => {
        const { parseCurveBlock, parseTableBlock } = require('../../../out/core/references/curveTableDefinitionScanner');
        for (const keyword of ['DEFINE_CURVE', 'DEFINE_TABLE_2D', 'DEFINE_TABLE_4D']) {
            for (const prefix of ['', '0 1\n']) {
                const parse = keyword === 'DEFINE_CURVE' ? parseCurveBlock : parseTableBlock;
                const result = parse({ keyword, startLine: 7 }, `*${keyword}\n17\n${prefix}2\n*END`);
                const records = result.points || result.rows;
                assert.equal(records.length, prefix ? 2 : 1);
                const last = records.at(-1);
                assert.equal(last.lineIndex, prefix ? 10 : 9);
                assert.equal(keyword === 'DEFINE_CURVE' ? last.yRaw : last.childIdRaw, '');
                assert.equal(keyword === 'DEFINE_CURVE' ? last.y : last.childId, null);
                assert.equal(result.dataCompleteness.state, 'incomplete');
                assert.ok(result.dataCompleteness.reasons.includes('reference-data-unresolved'));
            }
        }
        const oneDimensional = parseTableBlock({ keyword: 'DEFINE_TABLE', startLine: 0 }, '*DEFINE_TABLE\n17\n2\n*END');
        assert.equal(oneDimensional.rows.length, 1);
        assert.equal(oneDimensional.dataCompleteness.state, 'complete');
    });

    it('preserves curve points and scaling in all four native format fixtures', () => {
        const { parseCurveBlock } = require('../../../out/core/references/curveTableDefinitionScanner');
        for (const mode of ['standard', 'long', 'i10', 'free']) {
            const text = fs.readFileSync(path.join(__dirname, `../../fixtures/public-behavior/native-formats/native-${mode}.k`), 'ascii');
            const blockText = text.slice(text.indexOf('*DEFINE_CURVE_TITLE'), text.indexOf('*ELEMENT_SHELL'));
            const result = parseCurveBlock({ keyword: 'DEFINE_CURVE_TITLE', startLine: 0 }, blockText);
            assert.equal(result.points.length, 2, mode);
            assert.deepEqual([result.points[0].x, result.points[0].y], [0, -0.125], mode);
            assert.equal(result.scale.sfa, 1, mode);
            assert.equal(result.scale.sfo, 1, mode);
            assert.equal(result.dataCompleteness.state, 'complete', mode);
            if (mode === 'free') assert.equal(result.points[0].xRaw, '');
        }
    });

    it('keeps comma slots and defaults only explicit empty curve coordinates', () => {
        const { parseCurveBlock } = require('../../../out/core/references/curveTableDefinitionScanner');
        const result = parseCurveBlock({ keyword: 'DEFINE_CURVE', startLine: 0 },
            '*DEFINE_CURVE\n901,,2,3,4,5\n,1\n2,\n&X,bad\n*END');
        assert.deepEqual(result.scale, { sfa: 2, sfo: 3, offa: 4, offo: 5 });
        assert.deepEqual(result.points.map(p => [p.x, p.y]), [[0, 1], [2, 0], [null, null]]);
        assert.equal(result.points[0].xInput.raw, '');
        assert.equal(result.points[1].yInput.raw, '');
        assert.equal(result.points[2].xInput.kind, 'parameter');
        assert.equal(result.points[2].yInput.kind, 'invalid');
        assert.equal(result.dataCompleteness.state, 'incomplete');
        assert.equal(parseCurveBlock({ keyword: 'DEFINE_CURVE', startLine: 0 },
            '*DEFINE_CURVE\n,901,2,3\n0,1\n*END'), null);
    });

    it('indexes generic definitions through TITLE schema aliases', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-set-part-'));
        const filePath = path.join(dir, 'sets.k');
        fs.writeFileSync(filePath, [
            '*SET_PART_LIST_TITLE',
            'SET_Dummy',
            '   8100001',
            '91200001,91200401,91200601',
            '*END',
        ].join('\n'));

        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block),
            );
            assert.equal(result.genericDefinitions.length, 1);
            assert.equal(result.genericDefinitions[0].id, 8100001);
            assert.equal(result.genericDefinitions[0].targetKind, 'part-set');
            assert.equal(result.genericDefinitions[0].idLine, 2);
            assert.equal(result.genericDefinitions[0].idStartChar, 3);
            assert.equal(result.genericDefinitions[0].idEndChar, 10);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('parses DEFINE_CURVE_TITLE id, title, scale and numeric points', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-curve-'));
        const filePath = path.join(dir, 'curves.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_CURVE_TITLE',
            'Steel hardening',
            '$#    lcid      sidr       sfa       sfo      offa      offo',
            '      1001         0       2.0       3.0       1.0      -1.0',
            '$#                a1                  o1',
            '                 0.0               100.0',
            '                 1.0               200.0',
            '                 &x                &y',
            '*END',
        ].join('\n'));

        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block)
            );

            assert.equal(result.curves.length, 1);
            assert.equal(result.curves[0].id, 1001);
            assert.equal(result.curves[0].idLine, 3);
            assert.equal(result.curves[0].idStartChar, 6);
            assert.equal(result.curves[0].idEndChar, 10);
            assert.equal(result.curves[0].title, 'Steel hardening');
            assert.equal(result.curves[0].scale.sfa, 2);
            assert.equal(result.curves[0].scale.sfo, 3);
            assert.deepEqual(result.curves[0].points.map(point => [point.x, point.y]), [[0, 100], [1, 200], [null, null]]);
            assert.equal(result.curves[0].points[2].xRaw, '&x');
            assert.equal(result.curves[0].points[2].xInput.kind, 'parameter');
            assert.deepEqual(result.curves[0].dataCompleteness, {
                state: 'incomplete',
                reasons: ['parameter-unresolved'],
            });
            assert.equal(result.curves[0].points[0].lineIndex, 5);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('preserves parameterized definition and table child IDs as symbolic records', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-symbolic-'));
        const filePath = path.join(dir, 'symbolic.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_CURVE',
            '      &CID',
            '       0.0       1.0',
            '*DEFINE_TABLE_2D',
            '      &TID',
            '       0.0      &CID',
            '*END',
        ].join('\n'));

        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block)
            );

            assert.equal(result.curves.length, 1);
            assert.equal(result.curves[0].id, null);
            assert.equal(result.curves[0].idRaw, '&CID');
            assert.equal(result.curves[0].idInput.kind, 'parameter');

            assert.equal(result.tables.length, 1);
            assert.equal(result.tables[0].id, null);
            assert.equal(result.tables[0].idRaw, '&TID');
            assert.equal(result.tables[0].idInput.kind, 'parameter');
            assert.equal(result.tables[0].rows[0].childId, null);
            assert.equal(result.tables[0].rows[0].childIdRaw, '&CID');
            assert.equal(result.tables[0].rows[0].childIdInput.kind, 'parameter');
            assert.equal(result.tables[0].dataCompleteness.state, 'incomplete');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('parses DEFINE_TABLE_2D rows as value to curve id', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-table-'));
        const filePath = path.join(dir, 'table.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_TABLE_2D_TITLE',
            'rate table',
            '$#    tbid       sfa      offa',
            '      2001       1.0       0.0',
            '$#             value             curveId',
            '               0.01                1001',
            '                1.0                1002',
            '*END',
        ].join('\n'));

        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block)
            );

            assert.equal(result.tables.length, 1);
            assert.equal(result.tables[0].id, 2001);
            assert.equal(result.tables[0].idLine, 3);
            assert.equal(result.tables[0].idStartChar, 6);
            assert.equal(result.tables[0].idEndChar, 10);
            assert.equal(result.tables[0].title, 'rate table');
            assert.equal(result.tables[0].tableType, '2d');
            assert.deepEqual(result.tables[0].rows.map(row => [row.value, row.childId, row.childKind]), [
                [0.01, 1001, 'curve'],
                [1.0, 1002, 'curve'],
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('indexes DEFINE_CURVE_FUNCTION as function curve text', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-function-'));
        const filePath = path.join(dir, 'function.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_CURVE_FUNCTION_TITLE',
            'function curve',
            '      3001',
            'sin(t)',
            '*END',
        ].join('\n'));

        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block)
            );

            assert.equal(result.curves.length, 1);
            assert.equal(result.curves[0].kind, 'functionCurve');
            assert.equal(result.curves[0].id, 3001);
            assert.equal(result.curves[0].functionText, 'sin(t)');
            assert.deepEqual(result.curves[0].points, []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('parses standard 1D table and maps to subsequent child curves', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-table1d-'));
        const filePath = path.join(dir, 'table1d.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_TABLE_TITLE',
            'LCSDG',
            '       100         1         0',
            '$              Value',
            '                  -1',
            '                 0.5',
            '*DEFINE_CURVE_TITLE',
            'curve 1',
            '       101',
            '                  -1         1.5',
            '*DEFINE_CURVE_TITLE',
            'curve 2',
            '       102',
            '                  -1         0.8',
            '*END'
        ].join('\n'));

        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block)
            );
            assert.equal(result.tables.length, 1);
            assert.equal(result.tables[0].id, 100);
            assert.equal(result.tables[0].tableType, '1d');
            assert.equal(result.tables[0].rows.length, 2);
            assert.equal(result.tables[0].rows[0].value, -1);
            assert.equal(result.tables[0].rows[0].childId, 101);
            assert.equal(result.tables[0].rows[1].value, 0.5);
            assert.equal(result.tables[0].rows[1].childId, 102);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('parses DEFINE_TABLE_4D rows as value to child table id', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-table4d-'));
        const filePath = path.join(dir, 'table4d.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_TABLE_4D_TITLE',
            'strain rate table',
            '$#    tbid       sfa      offa',
            '      4001       1.0       0.0',
            '$#             value             tableId',
            '                0.0                3001',
            '              100.0                3002',
            '*END',
        ].join('\n'));

        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block)
            );

            assert.equal(result.tables.length, 1);
            assert.equal(result.tables[0].id, 4001);
            assert.equal(result.tables[0].title, 'strain rate table');
            assert.equal(result.tables[0].tableType, '4d');
            assert.deepEqual(result.tables[0].rows.map(row => [row.value, row.childId, row.childKind]), [
                [0.0, 3001, 'table'],
                [100.0, 3002, 'table'],
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('parses verified high-dimensional table rows as child table ids', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-table9d-'));
        const filePath = path.join(dir, 'table9d.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_TABLE_9D',
            '      9001       1.0       0.0',
            '                0.0                8001',
            '*END',
        ].join('\n'));

        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block),
            );

            assert.equal(result.tables.length, 1);
            assert.equal(result.tables[0].tableType, '9d');
            assert.equal(result.tables[0].rows[0].childId, 8001);
            assert.equal(result.tables[0].rows[0].childKind, 'table');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('indexes generic DEFINE keywords separately by their exact keyword and numeric ID', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-generic-'));
        const filePath = path.join(dir, 'generic.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_CPG_GAS_PROPERTIES',
            '      7001',
            '*DEFINE_CPM_GAS_PROPERTIES',
            '      7001',
            '*DEFINE_CPG_GAS_PROPERTIES_TITLE',
            'gas title',
            '      7002',
            '*DEFINE_CABLE',
            '      9001      9002',
            '*END',
        ].join('\n'));

        try {
            const definitionKeywords = {
                generic: {
                    DEFINE_CPG_GAS_PROPERTIES: {
                        target: 'DEFINE_CPG_GAS_PROPERTIES', cardIndex: 1, fieldIndex: 0,
                        fieldName: 'ID', fieldType: 'integer', position: 0, width: 10,
                    },
                    DEFINE_CPG_GAS_PROPERTIES_TITLE: {
                        target: 'DEFINE_CPG_GAS_PROPERTIES', cardIndex: 2, fieldIndex: 0,
                        fieldName: 'ID', fieldType: 'integer', position: 0, width: 10,
                    },
                    DEFINE_CPM_GAS_PROPERTIES: {
                        target: 'DEFINE_CPM_GAS_PROPERTIES', cardIndex: 1, fieldIndex: 0,
                        fieldName: 'ID', fieldType: 'integer', position: 0, width: 10,
                    },
                },
            };
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block),
                definitionKeywords,
            );

            assert.deepEqual(result.genericDefinitions.map(definition => [definition.keyword, definition.targetKeyword, definition.id]), [
                ['*DEFINE_CPG_GAS_PROPERTIES', 'DEFINE_CPG_GAS_PROPERTIES', 7001],
                ['*DEFINE_CPM_GAS_PROPERTIES', 'DEFINE_CPM_GAS_PROPERTIES', 7001],
                ['*DEFINE_CPG_GAS_PROPERTIES_TITLE', 'DEFINE_CPG_GAS_PROPERTIES', 7002],
            ]);
            assert.deepEqual(result.genericDefinitions.map(definition => [
                definition.idLine,
                definition.idStartChar,
                definition.idEndChar,
            ]), [
                [1, 6, 10],
                [3, 6, 10],
                [6, 6, 10],
            ]);
            assert.deepEqual(result.curves, []);
            assert.deepEqual(result.tables, []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('scans the four newly approved definition coordinates from their exact official layouts', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-registry-definitions-'));
        const filePath = path.join(dir, 'definitions.k');
        fs.writeFileSync(filePath, [
            '*BOUNDARY_PRESCRIBED_FINAL_GEOMETRY',
            String(101).padStart(10),
            '*DEFINE_CONTACT_VOLUME',
            String(102).padStart(10),
            '*SET_BEAM',
            String(103).padStart(10),
            '*SET_IGA_POINT_UVW',
            String(104).padStart(10),
            '*END',
        ].join('\n'));
        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block),
            );
            assert.deepEqual(result.genericDefinitions.map(definition => ({
                keyword: definition.keyword,
                field: definition.idFieldName,
                id: definition.id,
                ruleId: definition.ruleId,
            })), [
                { keyword: '*BOUNDARY_PRESCRIBED_FINAL_GEOMETRY', field: 'BPFGID', id: 101,
                    ruleId: 'rule:6bd70d5d2745fbcbfb977b6c' },
                { keyword: '*DEFINE_CONTACT_VOLUME', field: 'CVID', id: 102,
                    ruleId: 'rule:c773decc16b937240d8cc334' },
                { keyword: '*SET_BEAM', field: 'SID', id: 103,
                    ruleId: 'rule:f1ff04a27038b5cc08dcac00' },
                { keyword: '*SET_IGA_POINT_UVW', field: 'SID', id: 104,
                    ruleId: 'rule:b5258b5c999b2d4fbc3972fb' },
            ]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('scans corrected SET_PART SID only through the Registry exact-selector overlay', async function () {
        this.timeout(10000);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-registry-set-part-'));
        const filePath = path.join(dir, 'set-part.k');
        fs.writeFileSync(filePath, [
            '*SET_PART',
            String(1000001).padStart(10),
            '*END',
        ].join('\n'));
        try {
            const result = await scanCurveTableDefinitionsFromFileIndex(
                await buildFileIndex(filePath),
                block => readBlockText(block),
            );
            assert.deepEqual(result.genericDefinitions.map(definition => ({
                keyword: definition.keyword,
                targetKeyword: definition.targetKeyword,
                targetKind: definition.targetKind,
                field: definition.idFieldName,
                id: definition.id,
                ruleId: definition.ruleId,
                range: [definition.idLine, definition.idStartChar, definition.idEndChar],
            })), [{
                keyword: '*SET_PART',
                targetKeyword: 'SET_PART',
                targetKind: 'part-set',
                field: 'SID',
                id: 1000001,
                ruleId: 'rule:94d1738d89bdf682dd5fc3bb',
                range: [1, 3, 10],
            }]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('stops before reading a definition block when navigation is cancelled', async () => {
        let reads = 0;
        const result = await scanCurveTableDefinitionsFromFileIndex(
            {
                filePath: '/model/cancelled.k',
                keywordBlocks: [{
                    keyword: '*DEFINE_CURVE',
                    filePath: '/model/cancelled.k',
                    startLine: 0,
                    endLine: 2,
                }],
            },
            async () => {
                reads += 1;
                return '*DEFINE_CURVE\n         1\n       0.0       1.0';
            },
            undefined,
            { cancellationToken: { isCancellationRequested: true } },
        );

        assert.equal(result.cancelled, true);
        assert.equal(reads, 0);
        assert.deepEqual(result.curves, []);
    });

    it('records the selected comma field when the same numeric text appears earlier', async () => {
        const result = await scanCurveTableDefinitionsFromFileIndex(
            {
                filePath: '/model/comma-definition.k',
                keywordBlocks: [{
                    keyword: '*DEFINE_TEST',
                    filePath: '/model/comma-definition.k',
                    startLine: 0,
                    endLine: 1,
                }],
            },
            async () => '*DEFINE_TEST\n7, 7, 9',
            {
                generic: {
                    DEFINE_TEST: {
                        target: 'DEFINE_TEST',
                        cardIndex: 1,
                        fieldIndex: 1,
                        fieldName: 'ID',
                        fieldType: 'integer',
                        position: 10,
                        width: 10,
                    },
                },
            },
        );

        assert.equal(result.genericDefinitions.length, 1);
        assert.equal(result.genericDefinitions[0].id, 7);
        assert.equal(result.genericDefinitions[0].idLine, 1);
        assert.equal(result.genericDefinitions[0].idStartChar, 3);
        assert.equal(result.genericDefinitions[0].idEndChar, 4);
    });
});
