'use strict';

const {
    resolveExtensionThemePalette,
    themeKindFromRenderOptions,
} = require('../theme/extensionTheme');

const MAX_SVG_POINTS = 200;
const MAX_TABLE_CURVES = 16;
const MAX_TABLE_POINTS_PER_CURVE = 32;
const TABLE_3D_VIEWS = Object.freeze([
    'isometric',
    'reverse-isometric',
    'front',
    'side',
]);
const TABLE_3D_VIEW_PRESETS = Object.freeze({
    isometric: {
        x: [160, 20],
        y: [90, -45],
        z: [0, -100],
        gridPlanes: ['xy', 'yz'],
        reverseCurves: false,
        visibleAxes: ['x', 'y', 'z'],
    },
    'reverse-isometric': {
        x: [-160, 20],
        y: [-90, -45],
        z: [0, -100],
        gridPlanes: ['xy', 'yz'],
        reverseCurves: true,
        visibleAxes: ['x', 'y', 'z'],
    },
    front: {
        x: [180, 0],
        y: [0, 0],
        z: [0, -120],
        gridPlanes: ['xz'],
        reverseCurves: false,
        visibleAxes: ['x', 'z'],
    },
    side: {
        x: [0, 0],
        y: [180, 0],
        z: [0, -120],
        gridPlanes: ['yz'],
        reverseCurves: false,
        visibleAxes: ['y', 'z'],
    },
});

function normalizeTable3dView(view) {
    const value = String(view || '');
    return TABLE_3D_VIEWS.includes(value) ? value : 'isometric';
}

function xmlEscape(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function markdownCode(value) {
    const text = String(value ?? '').replace(/\r?\n/g, ' ');
    if (!text) return '';
    const longest = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${text}${pad}${fence}`;
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

function curvePaletteFromOptions(options = {}) {
    return resolveExtensionThemePalette(themeKindFromRenderOptions(options)).curve;
}

function renderCurveSvgDataUri(definition, options = {}) {
    const renderOptions: any = options || {};
    const maxPoints = Number.isFinite(renderOptions.maxPoints)
        ? Math.max(2, Math.floor(renderOptions.maxPoints)) : MAX_SVG_POINTS;
    const curvePalette = curvePaletteFromOptions(renderOptions);
    
    const points = samplePoints(numericPoints(definition && definition.points), maxPoints);
    if (points.length < 2) {
        return null;
    }

    const width = 360;
    const height = 165;
    
    const paddingTop = 10;
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
    if (!Number.isFinite(spanX) || !Number.isFinite(spanY)) return null;
    
    const innerWidth = width - paddingLeft - paddingRight;
    const innerHeight = height - paddingTop - paddingBottom;

    const polyline = points.map(point => {
        const x = paddingLeft + ((point.x - minX) / spanX) * innerWidth;
        const y = height - paddingBottom - ((point.y - minY) / spanY) * innerHeight;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    const title = xmlEscape(definition.title || definition.keyword || 'curve');

    const axisColor = curvePalette.axis;
    const curveColor = curvePalette.accent;
    const textColor = curvePalette.text;

    const midX = minX + spanX / 2;
    const midY = minY + spanY / 2;
    const midXPos = paddingLeft + innerWidth / 2;
    const midYPos = paddingTop + innerHeight / 2;

    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">`,
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
        `<text x="${width - paddingRight}" y="${height - paddingBottom + 15}" fill="${textColor}" font-size="9" font-family="sans-serif" text-anchor="middle">${formatValue(maxX === minX ? minX + spanX : maxX)}</text>`,
        `<text x="${paddingLeft - 8}" y="${height - paddingBottom}" fill="${textColor}" font-size="9" font-family="sans-serif" text-anchor="end" dominant-baseline="middle">${formatValue(minY)}</text>`,
        `<text x="${paddingLeft - 8}" y="${midYPos}" fill="${textColor}" font-size="9" font-family="sans-serif" text-anchor="end" dominant-baseline="middle">${formatValue(midY)}</text>`,
        `<text x="${paddingLeft - 8}" y="${paddingTop}" fill="${textColor}" font-size="9" font-family="sans-serif" text-anchor="end" dominant-baseline="middle">${formatValue(maxY === minY ? minY + spanY : maxY)}</text>`,
        `<polyline points="${polyline}" fill="none" stroke="${curveColor}" stroke-width="2"/>`,
        '</svg>',
    ].join('');
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function renderTable3dSvgDataUri(definition, options = {}) {
    const renderOptions: any = options || {};
    const themeKind = themeKindFromRenderOptions(renderOptions);
    const isDark = themeKind === 'dark' || themeKind === 'highContrast';
    const curvePalette = resolveExtensionThemePalette(themeKind).curve;
    const view = normalizeTable3dView(renderOptions.view);
    const viewPreset = TABLE_3D_VIEW_PRESETS[view];
    const maxCurves = Number.isFinite(renderOptions.maxCurves)
        ? Math.max(1, Math.floor(renderOptions.maxCurves))
        : MAX_TABLE_CURVES;
    const maxPointsPerCurve = Number.isFinite(renderOptions.maxPointsPerCurve)
        ? Math.max(2, Math.floor(renderOptions.maxPointsPerCurve))
        : MAX_TABLE_POINTS_PER_CURVE;
    const width = 380;
    const height = 220;
    const reverseHorizontalMargins = view === 'reverse-isometric';
    const plotBounds = {
        left: reverseHorizontalMargins ? 18 : 66,
        right: width - (reverseHorizontalMargins ? 66 : 18),
        top: 26,
        bottom: height - 48,
    };

    const curves = [];
    const ys = [];
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    const sampledRows = sampleItems(definition.rows || [], maxCurves);
    for (const row of sampledRows) {
        if (!Number.isFinite(row.value)) continue;
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
    if (![spanX, spanY, spanZ].every(Number.isFinite)) return null;

    function projectRaw(xn, yn, zn) {
        return {
            u: xn * viewPreset.x[0] + yn * viewPreset.y[0] + zn * viewPreset.z[0],
            v: xn * viewPreset.x[1] + yn * viewPreset.y[1] + zn * viewPreset.z[1],
        };
    }

    const projectedCorners = [];
    for (const xn of [0, 1]) {
        for (const yn of [0, 1]) {
            for (const zn of [0, 1]) {
                projectedCorners.push(projectRaw(xn, yn, zn));
            }
        }
    }
    const minProjectedU = Math.min(...projectedCorners.map(point => point.u));
    const maxProjectedU = Math.max(...projectedCorners.map(point => point.u));
    const minProjectedV = Math.min(...projectedCorners.map(point => point.v));
    const maxProjectedV = Math.max(...projectedCorners.map(point => point.v));
    const projectedSpanU = Math.max(1, maxProjectedU - minProjectedU);
    const projectedSpanV = Math.max(1, maxProjectedV - minProjectedV);
    const innerWidth = plotBounds.right - plotBounds.left;
    const innerHeight = plotBounds.bottom - plotBounds.top;
    const projectionScale = Math.min(innerWidth / projectedSpanU, innerHeight / projectedSpanV);
    const projectedWidth = projectedSpanU * projectionScale;
    const projectedHeight = projectedSpanV * projectionScale;
    const offsetU = plotBounds.left + (innerWidth - projectedWidth) / 2 - minProjectedU * projectionScale;
    const offsetV = plotBounds.top + (innerHeight - projectedHeight) / 2 - minProjectedV * projectionScale;

    function project(x, y, z) {
        const xn = maxX === minX ? 0.5 : (x - minX) / (maxX - minX);
        const yn = maxY === minY ? 0.5 : (y - minY) / (maxY - minY);
        const zn = maxZ === minZ ? 0.5 : (z - minZ) / (maxZ - minZ);
        const raw = projectRaw(xn, yn, zn);
        return {
            u: offsetU + raw.u * projectionScale,
            v: offsetV + raw.v * projectionScale,
        };
    }

    function getCurveColor(t, darkTheme) {
        const hue = darkTheme ? 180 - t * 140 : 240 - t * 240;
        return `hsl(${hue}, ${curvePalette.seriesSaturation}%, ${curvePalette.seriesLightness}%)`;
    }

    const axisColor = curvePalette.axis;
    const gridColor = curvePalette.grid;
    const textColor = curvePalette.text;
    const labelColor = curvePalette.label;

    const svgElements = [];
    const title = xmlEscape(definition.title || definition.keyword || 'table');
    svgElements.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}" data-table-view="${view}">`);

    function gridLine(start, end) {
        const p1 = project(start[0], start[1], start[2]);
        const p2 = project(end[0], end[1], end[2]);
        svgElements.push(`<line x1="${p1.u.toFixed(1)}" y1="${p1.v.toFixed(1)}" x2="${p2.u.toFixed(1)}" y2="${p2.v.toFixed(1)}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="2,2"/>`);
    }

    // Draw only the useful reference planes for the selected camera preset.
    const gridDivs = 4;
    for (let i = 0; i <= gridDivs; i++) {
        const t = i / gridDivs;
        const x = minX + t * spanX;
        const y = minY + t * spanY;
        const z = minZ + t * spanZ;
        if (viewPreset.gridPlanes.includes('xy')) {
            gridLine([x, minY, minZ], [x, maxY, minZ]);
            gridLine([minX, y, minZ], [maxX, y, minZ]);
        }
        if (viewPreset.gridPlanes.includes('xz')) {
            gridLine([x, minY, minZ], [x, minY, maxZ]);
            gridLine([minX, minY, z], [maxX, minY, z]);
        }
        if (viewPreset.gridPlanes.includes('yz')) {
            gridLine([minX, y, minZ], [minX, y, maxZ]);
            gridLine([minX, minY, z], [minX, maxY, z]);
        }
    }

    // Draw Curves & connecting wireframe lines
    const numCurves = curves.length;
    const orderedCurves = curves.map((curve, seriesIndex) => ({ ...curve, seriesIndex }));
    if (viewPreset.reverseCurves) orderedCurves.reverse();
    for (let j = 0; j < orderedCurves.length; j++) {
        const curve = orderedCurves[j];
        const color = getCurveColor(numCurves > 1 ? curve.seriesIndex / (numCurves - 1) : 0.5, isDark);
        const polyPoints = curve.points.map(pt => {
            const p = project(pt.x, curve.y, pt.y);
            return `${p.u.toFixed(1)},${p.v.toFixed(1)}`;
        }).join(' ');
        svgElements.push(`<polyline points="${polyPoints}" fill="none" stroke="${color}" stroke-width="2"/>`);

        if (j < orderedCurves.length - 1 && orderedCurves[j + 1].points.length === curve.points.length) {
            const nextCurve = orderedCurves[j + 1];
            for (let k = 0; k < curve.points.length; k++) {
                const pCurr = project(curve.points[k].x, curve.y, curve.points[k].y);
                const pNext = project(nextCurve.points[k].x, nextCurve.y, nextCurve.points[k].y);
                svgElements.push(`<line x1="${pCurr.u.toFixed(1)}" y1="${pCurr.v.toFixed(1)}" x2="${pNext.u.toFixed(1)}" y2="${pNext.v.toFixed(1)}" stroke="${color}" stroke-width="0.5" opacity="0.6"/>`);
            }
        }
    }

    const plotCenter = {
        u: (plotBounds.left + plotBounds.right) / 2,
        v: (plotBounds.top + plotBounds.bottom) / 2,
    };
    const axes = [
        {
            id: 'x',
            min: minX,
            max: maxX,
            title: 'X (curve var)',
            point: t => project(minX + t * (maxX - minX), minY, minZ),
        },
        {
            id: 'y',
            min: minY,
            max: maxY,
            title: 'Y (table var)',
            point: t => project(minX, minY + t * (maxY - minY), minZ),
        },
        {
            id: 'z',
            min: minZ,
            max: maxZ,
            title: 'Z (value)',
            point: t => project(minX, minY, minZ + t * (maxZ - minZ)),
        },
    ];

    for (const axis of axes) {
        if (!viewPreset.visibleAxes.includes(axis.id)) continue;
        const start = axis.point(0);
        const end = axis.point(1);
        const du = end.u - start.u;
        const dv = end.v - start.v;
        const length = Math.hypot(du, dv);
        if (length < 0.5) continue;
        svgElements.push(`<line x1="${start.u.toFixed(1)}" y1="${start.v.toFixed(1)}" x2="${end.u.toFixed(1)}" y2="${end.v.toFixed(1)}" stroke="${axisColor}" stroke-width="1.5"/>`);

        let normalU = dv / length;
        let normalV = -du / length;
        const middle = axis.point(0.5);
        const pointsTowardCenter = normalU * (plotCenter.u - middle.u) +
            normalV * (plotCenter.v - middle.v) > 0;
        if (pointsTowardCenter) {
            normalU *= -1;
            normalV *= -1;
        }
        const textAnchor = normalU > 0.25 ? 'start' : normalU < -0.25 ? 'end' : 'middle';
        const tickValues = axis.max === axis.min
            ? [{ t: 0.5, value: axis.min }]
            : Array.from({ length: 5 }, (_, index) => ({
                t: index / 4,
                value: axis.min + index / 4 * (axis.max - axis.min),
            }));
        for (const tick of tickValues) {
            const point = axis.point(tick.t);
            const tickU = point.u + normalU * 4;
            const tickV = point.v + normalV * 4;
            const labelU = point.u + normalU * 10;
            const labelV = point.v + normalV * 10;
            svgElements.push(`<line x1="${point.u.toFixed(1)}" y1="${point.v.toFixed(1)}" x2="${tickU.toFixed(1)}" y2="${tickV.toFixed(1)}" stroke="${axisColor}" stroke-width="1"/>`);
            svgElements.push(`<text x="${labelU.toFixed(1)}" y="${labelV.toFixed(1)}" fill="${labelColor}" font-size="8" font-family="sans-serif" text-anchor="${textAnchor}" dominant-baseline="middle">${formatValue(tick.value)}</text>`);
        }
        const titleU = middle.u + normalU * 30;
        const titleV = middle.v + normalV * 30;
        const titleRotation = Math.abs(dv) > Math.abs(du) * 1.5
            ? ` transform="rotate(-90 ${titleU.toFixed(1)} ${titleV.toFixed(1)})"`
            : '';
        const titleAnchor = titleRotation ? 'middle' : textAnchor;
        svgElements.push(`<text x="${titleU.toFixed(1)}" y="${titleV.toFixed(1)}" fill="${textColor}" font-size="9" font-family="sans-serif" font-weight="bold" text-anchor="${titleAnchor}" dominant-baseline="middle"${titleRotation}>${axis.title}</text>`);
    }

    svgElements.push('</svg>');
    return `data:image/svg+xml;base64,${Buffer.from(svgElements.join(''), 'utf8').toString('base64')}`;
}

module.exports = {
    renderCurveSvgDataUri,
    renderTable3dSvgDataUri,
    TABLE_3D_VIEWS,
    normalizeTable3dView,
    curvePaletteFromOptions,
    xmlEscape,
    markdownCode,
};

export {};
