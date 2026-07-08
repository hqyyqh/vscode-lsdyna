const i18n = require('../i18n');

const {
    renderCurveSvgDataUri,
    renderCurveMarkdownFallback,
    renderTable3dSvgDataUri,
    markdownCode,
} = require('./curvePlotRenderer');

const MAX_HOVER_DEFINITIONS = 4;
const MAX_TABLE_ROWS = 8;
const MAX_FUNCTION_LINES = 8;

function encodeCommandArgs(args) {
    return encodeURIComponent(JSON.stringify([args]));
}

function definitionLink(definition, title = i18n.get('openDefinition')) {
    const args = encodeCommandArgs({
        filePath: definition.filePath,
        lineIndex: definition.startLine || 0,
        character: 0,
    });
    return `[$(go-to-file) ${title}](command:extension.openLsdynaReferenceDefinition?${args} "${title}")`;
}

function childDefinitionKindLabel(kind) {
    return kind === 'table' ? i18n.get('tableDefinitionKind') : i18n.get('curveDefinitionKind');
}

function appendCurvePreview(lines, definition, isDark = true) {
    const dataUri = renderCurveSvgDataUri(definition, { isDark });
    if (dataUri) {
        lines.push('', `![${i18n.get('curvePreviewAlt')}](${dataUri})`);
    }
    const fallback = renderCurveMarkdownFallback(definition);
    if (fallback) {
        lines.push('', fallback);
    }
}

function appendFunctionPreview(lines, definition) {
    const text = String(definition.functionText || '').split(/\r?\n/).slice(0, MAX_FUNCTION_LINES).join('\n');
    if (text) {
        lines.push('', '```lsdyna', text, '```');
    }
}

function childLink(row, definition) {
    const matches = definition.resolvedChildren && definition.resolvedChildren.get(row.childId);
    if (!matches || matches.length === 0) {
        return markdownCode(row.childIdRaw);
    }
    return `${markdownCode(row.childIdRaw)} ${definitionLink(matches[0], i18n.get('openChildDefinition', childDefinitionKindLabel(row.childKind)))}`;
}

function appendTablePreview(lines, definition, isDark = true) {
    // Hydrate child curve points into table rows
    const tableWithPoints = {
        ...definition,
        rows: (definition.rows || []).map(row => {
            const matches = definition.resolvedChildren && definition.resolvedChildren.get(row.childId);
            const points = (matches && matches[0] && matches[0].points) || [];
            return { ...row, points };
        })
    };

    // Try rendering 3D SVG
    const dataUri = renderTable3dSvgDataUri(tableWithPoints, { isDark });
    if (dataUri) {
        lines.push('', `![${i18n.get('table3dPreviewAlt')}](${dataUri})`);
    }

    // Fallback text table underneath
    const childLabel = definition.tableType === '3d' || definition.tableType === '4d'
        ? i18n.get('tableIdColumn')
        : i18n.get('curveIdColumn');
    const allRows = definition.rows || [];
    if (allRows.length === 0) {
        return;
    }
    const rows = allRows.slice(0, MAX_TABLE_ROWS);
    lines.push('', `| ${i18n.get('valueColumn')} | ${childLabel} |`, '| ---: | ---: |');
    for (const row of rows) {
        lines.push(`| ${markdownCode(row.valueRaw)} | ${childLink(row, definition)} |`);
    }
    const omitted = allRows.length - rows.length;
    if (omitted > 0) {
        lines.push(`| ... | ${i18n.get('moreRows', omitted)} |`);
    }
}

function appendDefinition(lines, definition, isDark = true) {
    lines.push('', i18n.get('definitionLocation', definition.keyword, definition.filePath), definitionLink(definition));
    if (definition.title) {
        lines.push(`_${definition.title}_`);
    }
    if (definition.kind === 'curve') {
        appendCurvePreview(lines, definition, isDark);
    } else if (definition.kind === 'functionCurve') {
        appendFunctionPreview(lines, definition);
    } else if (definition.kind === 'table') {
        appendTablePreview(lines, definition, isDark);
    }
}

function buildReferenceHoverSection({ fieldName, id, raw, isSignedSwitch = false, definitions = [], needsProjectScan = false, isDark = true }) {
    const lines = [
        '',
        '',
        '---',
        '',
        `**$(graph-line) ${i18n.get('referenceLabel', fieldName)}:** \`${id}\``,
    ];

    if (raw && String(raw) !== String(id)) {
        lines.push(i18n.get('rawValue', raw));
    }
    if (isSignedSwitch) {
        lines.push(i18n.get('negativeSwitchStripped'));
    }

    if (!definitions || definitions.length === 0) {
        lines.push('', i18n.get('noMatchingDefinition', id));
        if (needsProjectScan) {
            lines.push('', i18n.get('runScanIncludeTreeForDefinitions'));
        }
        return lines.join('\n');
    }

    if (definitions.length > 1) {
        lines.push('', i18n.get('matchingDefinitionsFound', definitions.length));
    }

    for (const definition of definitions.slice(0, MAX_HOVER_DEFINITIONS)) {
        appendDefinition(lines, definition, isDark);
    }

    const omitted = definitions.length - MAX_HOVER_DEFINITIONS;
    if (omitted > 0) {
        lines.push('', i18n.get('moreDefinitionsOmitted', omitted));
    }

    return lines.join('\n');
}

function buildDefinitionHoverSection(definition, isDark = true) {
    const lines = [];
    const titleStr = definition.title ? ` - _${definition.title}_` : '';
    const cleanKeyword = definition.keyword.replace(/^\*/, '');
    lines.push(`### $(graph-line) **\\*${cleanKeyword}${i18n.get('definitionIdLabel', definition.id)}**${titleStr}`);
    if (definition.kind === 'curve') {
        appendCurvePreview(lines, definition, isDark);
    } else if (definition.kind === 'functionCurve') {
        appendFunctionPreview(lines, definition);
    } else if (definition.kind === 'table') {
        appendTablePreview(lines, definition, isDark);
    }
    return lines.join('\n');
}

module.exports = {
    buildReferenceHoverSection,
    buildDefinitionHoverSection,
    definitionLink,
};

export {};

