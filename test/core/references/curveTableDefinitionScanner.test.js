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
            assert.deepEqual(result.curves, []);
            assert.deepEqual(result.tables, []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
