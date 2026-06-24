const assert = require('assert');
const { buildReferenceHoverSection } = require('../../../out/core/references/fieldReferenceHover');

describe('fieldReferenceHover', () => {
    it('renders curve preview, signed switch note and definition link', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 1001,
            raw: '-1001',
            isSignedSwitch: true,
            definitions: [{
                kind: 'curve',
                id: 1001,
                keyword: '*DEFINE_CURVE',
                filePath: 'C:/model/main.k',
                startLine: 10,
                endLine: 13,
                points: [
                    { x: 0, y: 400, xRaw: '0', yRaw: '400', lineIndex: 12 },
                    { x: 0.1, y: 450, xRaw: '0.1', yRaw: '450', lineIndex: 13 },
                ],
            }],
        });

        assert.ok(section.includes('LCSS reference'));
        assert.ok(section.includes('negative switch stripped'));
        assert.ok(section.includes('*DEFINE_CURVE'));
        assert.ok(section.includes('data:image/svg+xml;base64,'));
        assert.ok(section.includes('command:extension.openLsdynaReferenceDefinition'));
    });

    it('renders scan prompt when no project definitions are cached', () => {
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 1001,
            definitions: [],
            needsProjectScan: true,
        });

        assert.ok(section.includes('No matching curve/table definition'));
        assert.ok(section.includes('Scan Include Tree'));
    });

    it('renders resolved child curve links for table rows when available', () => {
        const childCurve = {
            kind: 'curve',
            id: 1001,
            keyword: '*DEFINE_CURVE',
            filePath: 'C:/model/main.k',
            startLine: 30,
            endLine: 35,
            points: [],
        };
        const section = buildReferenceHoverSection({
            fieldName: 'LCSS',
            id: 2001,
            definitions: [{
                kind: 'table',
                tableType: '2d',
                id: 2001,
                keyword: '*DEFINE_TABLE_2D',
                filePath: 'C:/model/main.k',
                startLine: 20,
                endLine: 25,
                rows: [{ valueRaw: '0.01', value: 0.01, childIdRaw: '1001', childId: 1001, childKind: 'curve', lineIndex: 23 }],
                resolvedChildren: new Map([[1001, [childCurve]]]),
            }],
        });

        assert.ok(section.includes('| value | curve ID |'));
        assert.ok(section.includes('1001'));
        assert.ok(section.includes('Open child curve'));
        assert.ok(section.includes('lineIndex'));
    });
});
