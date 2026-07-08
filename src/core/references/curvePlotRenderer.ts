'use strict';

const i18n = require('../i18n');

const MAX_SVG_POINTS = 200;
const MAX_TABLE_ROWS = 8;
const MAX_TABLE_CURVES = 16;
const MAX_TABLE_POINTS_PER_CURVE = 32;

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

function sampleItems(items, maxItems) {
    if (!Array.isArray(items) || items.length <= maxItems) {
        return items || [];
    }
    if (maxItems <= 1) {
        return [items[0]];
    }

    const sampled = [];
    const step = (items.length - 1) / (maxItems - 1);
    for (let index = 0; index < maxItems; index++) {
        sampled.push(items[Math.round(index * step)]);
    }
    return sampled;
}

function samplePoints(points, maxPoints) {
    return sampleItems(points, maxPoints);
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
        lines.push(`| ... | ${i18n.get('moreRows', omitted)} |`);
    }
    return lines.join('\n');
}

function renderTable3dSvgDataUri(definition, options = {}) {
    const renderOptions: any = options || {};
    const isDark = renderOptions.isDark !== false;
    const maxCurves = Number.isFinite(renderOptions.maxCurves)
        ? Math.max(1, Math.floor(renderOptions.maxCurves))
        : MAX_TABLE_CURVES;
    const maxPointsPerCurve = Number.isFinite(renderOptions.maxPointsPerCurve)
        ? Math.max(2, Math.floor(renderOptions.maxPointsPerCurve))
        : MAX_TABLE_POINTS_PER_CURVE;
    const width = 380;
    const height = 220;
    
    const u0 = 70;
    const v0 = 165;
    
    const dxX = 160;
    const dyX = 20;
    
    const dxY = 90;
    const dyY = -45;
    
    const dxZ = 0;
    const dyZ = -100;

    const curves = [];
    const ys = [];
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    const sampledRows = sampleItems(definition.rows || [], maxCurves);
    for (const row of sampledRows) {
        const pts = samplePoints(numericPoints(row.points), maxPointsPerCurve);
        if (pts.length < 2) continue;
        ys.push(row.value);
        curves.push({
            y: row.value,
            points: pts
        });
        for (const pt of pts) {
            if (pt.x < minX) minX = pt.x;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minZ) minZ = pt.y;
            if (pt.y > maxZ) maxZ = pt.y;
        }
    }

    if (curves.length === 0) return null;

    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const spanX = maxX === minX ? 1 : maxX - minX;
    const spanY = maxY === minY ? 1 : maxY - minY;
    const spanZ = maxZ === minZ ? 1 : maxZ - minZ;

    function project(x, y, z) {
        const xn = maxX === minX ? 0.5 : (x - minX) / (maxX - minX);
        const yn = maxY === minY ? 0.5 : (y - minY) / (maxY - minY);
        const zn = maxZ === minZ ? 0.5 : (z - minZ) / (maxZ - minZ);
        const u = u0 + xn * dxX + yn * dxY;
        const v = v0 + xn * dyX + yn * dyY + zn * dyZ;
        return { u, v };
    }

    function getCurveColor(t, isDark) {
        if (isDark) {
            const hue = 180 - t * 140;
            return `hsl(${hue}, 100%, 65%)`;
        } else {
            const hue = 240 - t * 240;
            return `hsl(${hue}, 80%, 45%)`;
        }
    }

    const axisColor = isDark ? '#888888' : '#777777';
    const gridColor = isDark ? '#444444' : '#dddddd';
    const textColor = isDark ? '#cccccc' : '#333333';
    const labelColor = isDark ? '#aaaaaa' : '#555555';

    const svgElements = [];
    const title = xmlEscape(definition.title || definition.keyword || 'table');
    svgElements.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">`);
    svgElements.push(`<text x="${width / 2}" y="16" fill="${textColor}" font-size="11" font-family="sans-serif" font-weight="bold" text-anchor="middle">${title}</text>`);

    // Floor & Wall Grid lines (Z = minZ, X = minX)
    const gridDivs = 4;
    for (let i = 0; i <= gridDivs; i++) {
        const t = i / gridDivs;
        const p1 = project(minX + t * spanX, minY, minZ);
        const p2 = project(minX + t * spanX, maxY, minZ);
        svgElements.push(`<line x1="${p1.u.toFixed(1)}" y1="${p1.v.toFixed(1)}" x2="${p2.u.toFixed(1)}" y2="${p2.v.toFixed(1)}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="2,2"/>`);
        const p3 = project(minX, minY + t * spanY, minZ);
        const p4 = project(maxX, minY + t * spanY, minZ);
        svgElements.push(`<line x1="${p3.u.toFixed(1)}" y1="${p3.v.toFixed(1)}" x2="${p4.u.toFixed(1)}" y2="${p4.v.toFixed(1)}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="2,2"/>`);
        const w1 = project(minX, minY + t * spanY, minZ);
        const w2 = project(minX, minY + t * spanY, maxZ);
        svgElements.push(`<line x1="${w1.u.toFixed(1)}" y1="${w1.v.toFixed(1)}" x2="${w2.u.toFixed(1)}" y2="${w2.v.toFixed(1)}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="2,2"/>`);
        const w3 = project(minX, minY, minZ + t * spanZ);
        const w4 = project(minX, maxY, minZ + t * spanZ);
        svgElements.push(`<line x1="${w3.u.toFixed(1)}" y1="${w3.v.toFixed(1)}" x2="${w4.u.toFixed(1)}" y2="${w4.v.toFixed(1)}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="2,2"/>`);
    }

    // Draw Axes
    const zOrigin = project(minX, minY, minZ);
    const zMax = project(minX, minY, maxZ);
    svgElements.push(`<line x1="${zOrigin.u.toFixed(1)}" y1="${zOrigin.v.toFixed(1)}" x2="${zMax.u.toFixed(1)}" y2="${zMax.v.toFixed(1)}" stroke="${axisColor}" stroke-width="1.5"/>`);
    const xMax = project(maxX, minY, minZ);
    svgElements.push(`<line x1="${zOrigin.u.toFixed(1)}" y1="${zOrigin.v.toFixed(1)}" x2="${xMax.u.toFixed(1)}" y2="${xMax.v.toFixed(1)}" stroke="${axisColor}" stroke-width="1.5"/>`);
    const yMax = project(minX, maxY, minZ);
    svgElements.push(`<line x1="${zOrigin.u.toFixed(1)}" y1="${zOrigin.v.toFixed(1)}" x2="${yMax.u.toFixed(1)}" y2="${yMax.v.toFixed(1)}" stroke="${axisColor}" stroke-width="1.5"/>`);

    // Draw Curves & connecting wireframe lines
    const numCurves = curves.length;
    for (let j = 0; j < numCurves; j++) {
        const curve = curves[j];
        const color = getCurveColor(numCurves > 1 ? j / (numCurves - 1) : 0.5, isDark);
        const polyPoints = curve.points.map(pt => {
            const p = project(pt.x, curve.y, pt.y);
            return `${p.u.toFixed(1)},${p.v.toFixed(1)}`;
        }).join(' ');
        svgElements.push(`<polyline points="${polyPoints}" fill="none" stroke="${color}" stroke-width="2"/>`);

        if (j < numCurves - 1 && curves[j+1].points.length === curve.points.length) {
            const nextCurve = curves[j+1];
            for (let k = 0; k < curve.points.length; k++) {
                const pCurr = project(curve.points[k].x, curve.y, curve.points[k].y);
                const pNext = project(nextCurve.points[k].x, nextCurve.y, nextCurve.points[k].y);
                svgElements.push(`<line x1="${pCurr.u.toFixed(1)}" y1="${pCurr.v.toFixed(1)}" x2="${pNext.u.toFixed(1)}" y2="${pNext.v.toFixed(1)}" stroke="${color}" stroke-width="0.5" opacity="0.6"/>`);
            }
        }
    }

    // Draw 5 ticks/labels along Z-axis
    for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        const zVal = minZ + t * (maxZ - minZ);
        const p = project(minX, minY, zVal);
        const tickX = p.u - 4;
        const tickY = p.v;
        svgElements.push(`<line x1="${p.u.toFixed(1)}" y1="${p.v.toFixed(1)}" x2="${tickX.toFixed(1)}" y2="${tickY.toFixed(1)}" stroke="${axisColor}" stroke-width="1"/>`);
        svgElements.push(`<text x="${(tickX - 4).toFixed(1)}" y="${tickY.toFixed(1)}" fill="${labelColor}" font-size="8" font-family="sans-serif" text-anchor="end" dominant-baseline="middle">${formatValue(zVal)}</text>`);
    }
    // Add Z-axis title
    svgElements.push(`<text x="${zMax.u.toFixed(1)}" y="${(zMax.v - 15).toFixed(1)}" fill="${textColor}" font-size="9" font-family="sans-serif" font-weight="bold" text-anchor="middle">Z (value)</text>`);

    // Draw 5 ticks/labels along X-axis
    for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        const xVal = minX + t * (maxX - minX);
        const p = project(xVal, minY, minZ);
        const tickX = p.u;
        const tickY = p.v + 4;
        svgElements.push(`<line x1="${p.u.toFixed(1)}" y1="${p.v.toFixed(1)}" x2="${tickX.toFixed(1)}" y2="${tickY.toFixed(1)}" stroke="${axisColor}" stroke-width="1"/>`);
        svgElements.push(`<text x="${tickX.toFixed(1)}" y="${(tickY + 8).toFixed(1)}" fill="${labelColor}" font-size="8" font-family="sans-serif" text-anchor="middle">${formatValue(xVal)}</text>`);
    }
    // Add X-axis title
    const xMid = project(minX + spanX / 2, minY, minZ);
    svgElements.push(`<text x="${(xMid.u + 15).toFixed(1)}" y="${(xMid.v + 28).toFixed(1)}" fill="${textColor}" font-size="9" font-family="sans-serif" font-weight="bold" text-anchor="middle">X (curve var)</text>`);

    // Draw 5 ticks/labels along Y-axis
    for (let i = 0; i <= 4; i++) {
        const t = i / 4;
        const yVal = minY + t * (maxY - minY);
        const p = project(minX, yVal, minZ);
        const tickX = p.u - 4;
        const tickY = p.v + 2;
        svgElements.push(`<line x1="${p.u.toFixed(1)}" y1="${p.v.toFixed(1)}" x2="${tickX.toFixed(1)}" y2="${tickY.toFixed(1)}" stroke="${axisColor}" stroke-width="1"/>`);
        svgElements.push(`<text x="${(tickX - 4).toFixed(1)}" y="${(tickY + 2).toFixed(1)}" fill="${labelColor}" font-size="8" font-family="sans-serif" text-anchor="end" dominant-baseline="middle">${formatValue(yVal)}</text>`);
    }
    // Add Y-axis title
    svgElements.push(`<text x="${(yMax.u - 15).toFixed(1)}" y="${(yMax.v - 15).toFixed(1)}" fill="${textColor}" font-size="9" font-family="sans-serif" font-weight="bold" text-anchor="end">Y (table var)</text>`);

    svgElements.push('</svg>');
    return `data:image/svg+xml;base64,${Buffer.from(svgElements.join(''), 'utf8').toString('base64')}`;
}

module.exports = {
    renderCurveSvgDataUri,
    renderCurveMarkdownFallback,
    renderTable3dSvgDataUri,
    xmlEscape,
    markdownCode,
};

export {};

