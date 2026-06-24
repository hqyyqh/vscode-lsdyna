'use strict';

const MAX_SVG_POINTS = 200;
const MAX_TABLE_ROWS = 8;

function xmlEscape(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function markdownCode(value) {
    return `\`${String(value ?? '').replace(/`/g, '\\`')}\``;
}

function numericPoints(points) {
    return (points || []).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function samplePoints(points, maxPoints) {
    if (points.length <= maxPoints) {
        return points;
    }
    const sampled = [];
    const step = (points.length - 1) / (maxPoints - 1);
    for (let index = 0; index < maxPoints; index++) {
        sampled.push(points[Math.round(index * step)]);
    }
    return sampled;
}

function renderCurveSvgDataUri(definition, options = {}) {
    const renderOptions: any = options || {};
    const maxPoints = typeof renderOptions.maxPoints === 'number' ? renderOptions.maxPoints : MAX_SVG_POINTS;
    const points = samplePoints(numericPoints(definition && definition.points), maxPoints);
    if (points.length < 2) {
        return null;
    }

    const width = 360;
    const height = 180;
    const padding = 24;
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = maxX === minX ? 1 : maxX - minX;
    const spanY = maxY === minY ? 1 : maxY - minY;
    const innerWidth = width - padding * 2;
    const innerHeight = height - padding * 2;

    const polyline = points.map(point => {
        const x = padding + ((point.x - minX) / spanX) * innerWidth;
        const y = height - padding - ((point.y - minY) / spanY) * innerHeight;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    const title = xmlEscape(definition.title || definition.keyword || 'curve');
    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">`,
        '<rect width="100%" height="100%" fill="#1f1f1f"/>',
        `<text x="${padding}" y="16" fill="#d4d4d4" font-size="11" font-family="sans-serif">${title}</text>`,
        `<line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#777"/>`,
        `<line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#777"/>`,
        `<polyline points="${polyline}" fill="none" stroke="#4fc3f7" stroke-width="2"/>`,
        '</svg>',
    ].join('');
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function renderCurveMarkdownFallback(definition, maxRows = MAX_TABLE_ROWS) {
    const rows = (definition && definition.points || []).slice(0, maxRows);
    if (rows.length === 0) {
        return '';
    }
    const lines = [
        '| x | y |',
        '| ---: | ---: |',
        ...rows.map(point => `| ${markdownCode(point.xRaw)} | ${markdownCode(point.yRaw)} |`),
    ];
    const omitted = (definition.points || []).length - rows.length;
    if (omitted > 0) {
        lines.push(`| ... | ${omitted} more rows |`);
    }
    return lines.join('\n');
}

module.exports = {
    renderCurveSvgDataUri,
    renderCurveMarkdownFallback,
    xmlEscape,
    markdownCode,
};

export {};
