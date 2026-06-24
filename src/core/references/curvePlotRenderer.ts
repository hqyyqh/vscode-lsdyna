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

function formatValue(val) {
    if (val === 0) return '0';
    const abs = Math.abs(val);
    if (abs < 0.0001 || abs >= 100000) {
        return val.toExponential(2);
    }
    return parseFloat(val.toFixed(4)).toString();
}

function renderCurveSvgDataUri(definition, options = {}) {
    const renderOptions: any = options || {};
    const maxPoints = typeof renderOptions.maxPoints === 'number' ? renderOptions.maxPoints : MAX_SVG_POINTS;
    const isDark = renderOptions.isDark !== false;
    
    const points = samplePoints(numericPoints(definition && definition.points), maxPoints);
    if (points.length < 2) {
        return null;
    }

    const width = 360;
    const height = 180;
    
    const paddingTop = 25;
    const paddingBottom = 30;
    const paddingLeft = 55;
    const paddingRight = 20;

    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = maxX === minX ? 1 : maxX - minX;
    const spanY = maxY === minY ? 1 : maxY - minY;
    
    const innerWidth = width - paddingLeft - paddingRight;
    const innerHeight = height - paddingTop - paddingBottom;

    const polyline = points.map(point => {
        const x = paddingLeft + ((point.x - minX) / spanX) * innerWidth;
        const y = height - paddingBottom - ((point.y - minY) / spanY) * innerHeight;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    const title = xmlEscape(definition.title || definition.keyword || 'curve');

    const axisColor = isDark ? '#888888' : '#777777';
    const curveColor = isDark ? '#5cceff' : '#007acc';
    const textColor = isDark ? '#cccccc' : '#333333';

    const midX = minX + spanX / 2;
    const midY = minY + spanY / 2;
    const midXPos = paddingLeft + innerWidth / 2;
    const midYPos = paddingTop + innerHeight / 2;

    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">`,
        `<text x="${paddingLeft}" y="16" fill="${textColor}" font-size="11" font-family="sans-serif" font-weight="bold">${title}</text>`,
        `<line x1="${paddingLeft}" y1="${height - paddingBottom}" x2="${width - paddingRight}" y2="${height - paddingBottom}" stroke="${axisColor}" stroke-width="1.5"/>`,
        `<line x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft}" y2="${height - paddingBottom}" stroke="${axisColor}" stroke-width="1.5"/>`,
        `<line x1="${paddingLeft}" y1="${height - paddingBottom}" x2="${paddingLeft}" y2="${height - paddingBottom + 4}" stroke="${axisColor}" stroke-width="1.5"/>`,
        `<line x1="${midXPos}" y1="${height - paddingBottom}" x2="${midXPos}" y2="${height - paddingBottom + 4}" stroke="${axisColor}" stroke-width="1.5"/>`,
        `<line x1="${width - paddingRight}" y1="${height - paddingBottom}" x2="${width - paddingRight}" y2="${height - paddingBottom + 4}" stroke="${axisColor}" stroke-width="1.5"/>`,
        `<line x1="${paddingLeft - 4}" y1="${height - paddingBottom}" x2="${paddingLeft}" y2="${height - paddingBottom}" stroke="${axisColor}" stroke-width="1.5"/>`,
        `<line x1="${paddingLeft - 4}" y1="${midYPos}" x2="${paddingLeft}" y2="${midYPos}" stroke="${axisColor}" stroke-width="1.5"/>`,
        `<line x1="${paddingLeft - 4}" y1="${paddingTop}" x2="${paddingLeft}" y2="${paddingTop}" stroke-width="1.5"/>`,
        `<text x="${paddingLeft}" y="${height - paddingBottom + 15}" fill="${textColor}" font-size="9" font-family="sans-serif" text-anchor="middle">${formatValue(minX)}</text>`,
        `<text x="${midXPos}" y="${height - paddingBottom + 15}" fill="${textColor}" font-size="9" font-family="sans-serif" text-anchor="middle">${formatValue(midX)}</text>`,
        `<text x="${width - paddingRight}" y="${height - paddingBottom + 15}" fill="${textColor}" font-size="9" font-family="sans-serif" text-anchor="middle">${formatValue(maxX)}</text>`,
        `<text x="${paddingLeft - 8}" y="${height - paddingBottom}" fill="${textColor}" font-size="9" font-family="sans-serif" text-anchor="end" dominant-baseline="middle">${formatValue(minY)}</text>`,
        `<text x="${paddingLeft - 8}" y="${midYPos}" fill="${textColor}" font-size="9" font-family="sans-serif" text-anchor="end" dominant-baseline="middle">${formatValue(midY)}</text>`,
        `<text x="${paddingLeft - 8}" y="${paddingTop}" fill="${textColor}" font-size="9" font-family="sans-serif" text-anchor="end" dominant-baseline="middle">${formatValue(maxY)}</text>`,
        `<polyline points="${polyline}" fill="none" stroke="${curveColor}" stroke-width="2"/>`,
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
