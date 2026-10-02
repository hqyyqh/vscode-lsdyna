const assert = require('assert');
const {
    renderCurveSvgDataUri,
    renderCurveMarkdownFallback,
    renderTable3dSvgDataUri,
    TABLE_3D_VIEWS,
    normalizeTable3dView,
} = require('../../../out/core/references/curvePlotRenderer');

describe('curvePlotRenderer', () => {
    function decodeSvg(dataUri) {
        return Buffer.from(dataUri.split(',')[1], 'base64').toString('utf8');
    }

    it('renders a safe svg data uri for numeric curve points', () => {
        const dataUri = renderCurveSvgDataUri({
            title: 'A < B',
            points: [
                { x: 0, y: 10, xRaw: '0', yRaw: '10' },
                { x: 1, y: 20, xRaw: '1', yRaw: '20' },
                { x: 2, y: 15, xRaw: '2', yRaw: '15' },
            ],
        });

        assert.ok(dataUri.startsWith('data:image/svg+xml;base64,'));
        const svg = Buffer.from(dataUri.split(',')[1], 'base64').toString('utf8');
        assert.ok(svg.includes('&lt;'));
        assert.ok(!svg.includes('<script'));
        assert.ok(svg.includes('<polyline'));
    });

    it('falls back to markdown table rows', () => {
        const markdown = renderCurveMarkdownFallback({
            points: [
                { xRaw: '0', yRaw: '10' },
                { xRaw: '&a', yRaw: '&b' },
            ],
        });

        assert.ok(markdown.includes('| x | y |'));
        assert.ok(markdown.includes('`&a`'));
    });

    it('renders distinct curve colors for all four VS Code theme kinds', () => {
        const definition = {
            points: [
                { x: 0, y: 0 },
                { x: 1, y: 1 },
            ],
        };
        const expectedAccent = new Map([
            [1, '#0066b8'],
            [2, '#4fc3f7'],
            [3, '#00ffff'],
            [4, '#005fb8'],
        ]);
        for (const [themeKind, accent] of expectedAccent) {
            const svg = decodeSvg(renderCurveSvgDataUri(definition, { themeKind }));
            assert.ok(svg.includes(`stroke="${accent}"`), `theme ${themeKind}`);
        }
    });

    it('renders a 3D table SVG data URI correctly', () => {
        const dataUri = renderTable3dSvgDataUri({
            title: 'Table 3D Test',
            keyword: '*DEFINE_TABLE_TITLE',
            rows: [
                {
                    value: 0,
                    points: [
                        { x: 0, y: 10 },
                        { x: 1, y: 20 }
                    ]
                },
                {
                    value: 1,
                    points: [
                        { x: 0, y: 15 },
                        { x: 1, y: 25 }
                    ]
                }
            ]
        }, { isDark: true });

        assert.ok(dataUri.startsWith('data:image/svg+xml;base64,'));
        const svg = Buffer.from(dataUri.split(',')[1], 'base64').toString('utf8');
        assert.ok(svg.includes('Table 3D Test'));
        assert.ok(svg.includes('<polyline'));
        assert.ok(svg.includes('<line'));
        // Verify ticks and HSL interpolation
        assert.ok(svg.includes('hsl('));
    });

    it('renders four distinct auto-fitted 3D table viewpoints', () => {
        const definition = {
            title: 'View Test',
            rows: [
                { value: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 1 }] },
                { value: 1, points: [{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 2 }] },
            ],
        };
        const rendered = new Map(TABLE_3D_VIEWS.map(view => [
            view,
            decodeSvg(renderTable3dSvgDataUri(definition, { view, themeKind: 2 })),
        ]));

        assert.equal(rendered.size, 4);
        assert.equal(new Set(rendered.values()).size, 4);
        for (const view of TABLE_3D_VIEWS) {
            const svg = rendered.get(view);
            assert.ok(svg.includes(`data-table-view="${view}"`));
            assert.ok(svg.includes('<polyline'));
        }
        assert.ok(rendered.get('front').includes('X (curve var)'));
        assert.ok(rendered.get('front').includes('Z (value)'));
        assert.ok(!rendered.get('front').includes('Y (table var)'));
        assert.ok(rendered.get('side').includes('Y (table var)'));
        assert.ok(rendered.get('side').includes('Z (value)'));
        assert.ok(!rendered.get('side').includes('X (curve var)'));

        assert.equal(normalizeTable3dView('side'), 'side');
        assert.equal(normalizeTable3dView('unknown'), 'isometric');
    });

    it('samples large 3D table previews to a hover-safe SVG size', () => {
        const rows = [];
        for (let rowIndex = 0; rowIndex < 200; rowIndex++) {
            const points = [];
            for (let pointIndex = 0; pointIndex < 200; pointIndex++) {
                points.push({
                    x: pointIndex,
                    y: Math.sin(pointIndex / 12) + rowIndex / 20,
                });
            }
            rows.push({
                value: -1 + rowIndex / 100,
                points,
            });
        }

        const dataUri = renderTable3dSvgDataUri({
            title: 'LCSDG',
            keyword: '*DEFINE_TABLE_TITLE',
            rows,
        }, { isDark: false });

        assert.ok(dataUri.startsWith('data:image/svg+xml;base64,'));
        assert.ok(dataUri.length < 100000, `expected sampled SVG under 100 KB, got ${dataUri.length}`);

        const svg = Buffer.from(dataUri.split(',')[1], 'base64').toString('utf8');
        const polylineCount = (svg.match(/<polyline/g) || []).length;
        const lineCount = (svg.match(/<line/g) || []).length;

        assert.ok(polylineCount <= 16, `expected at most 16 sampled curves, got ${polylineCount}`);
        assert.ok(lineCount <= 600, `expected bounded wireframe lines, got ${lineCount}`);
    });
});

