const assert = require('assert');
const {
    renderCurveSvgDataUri,
    renderCurveMarkdownFallback,
    renderTable3dSvgDataUri,
} = require('../../../out/core/references/curvePlotRenderer');

describe('curvePlotRenderer', () => {
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
});

