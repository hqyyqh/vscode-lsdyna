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

function definitionLink(definition, title = 'Open definition') {
    const args = encodeCommandArgs({
        filePath: definition.filePath,
        lineIndex: definition.startLine || 0,
        character: 0,
    });
    return `[$(go-to-file) ${title}](command:extension.openLsdynaReferenceDefinition?${args} "${title}")`;
}

function appendCurvePreview(lines, definition, isDark = true) {
    const dataUri = renderCurveSvgDataUri(definition, { isDark });
    if (dataUri) {
        lines.push('', `![curve preview](${dataUri})`);
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
    return `${markdownCode(row.childIdRaw)} ${definitionLink(matches[0], `Open child ${row.childKind}`)}`;
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
        lines.push('', `![3D table preview](${dataUri})`);
    }

    // Fallback text table underneath
    const childLabel = definition.tableType === '3d' || definition.tableType === '4d' ? 'table ID' : 'curve ID';
    const allRows = definition.rows || [];
    if (allRows.length === 0) {
        return;
    }
    const rows = allRows.slice(0, MAX_TABLE_ROWS);
    lines.push('', `| value | ${childLabel} |`, '| ---: | ---: |');
    for (const row of rows) {
        lines.push(`| ${markdownCode(row.valueRaw)} | ${childLink(row, definition)} |`);
    }
    const omitted = allRows.length - rows.length;
    if (omitted > 0) {
        lines.push(`| ... | ${omitted} more rows |`);
    }
}

function appendDefinition(lines, definition, isDark = true) {
    lines.push('', `**${definition.keyword}** in \`${definition.filePath}\``, definitionLink(definition));
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
        `**$(graph-line) ${fieldName} reference:** \`${id}\``,
    ];

    if (raw && String(raw) !== String(id)) {
        lines.push(`Raw value: \`${raw}\`.`);
    }
    if (isSignedSwitch) {
        lines.push('$(info) negative switch stripped for lookup.');
    }

    if (!definitions || definitions.length === 0) {
        lines.push('', `$(warning) No matching curve/table definition found for ID \`${id}\`.`);
        if (needsProjectScan) {
            lines.push('', 'Run **Scan Include Tree** to index cross-file curve/table definitions.');
        }
        return lines.join('\n');
    }

    if (definitions.length > 1) {
        lines.push('', `$(warning) ${definitions.length} matching definitions found. Review duplicates or ambiguity before trusting the preview.`);
    }

    for (const definition of definitions.slice(0, MAX_HOVER_DEFINITIONS)) {
        appendDefinition(lines, definition, isDark);
    }

    const omitted = definitions.length - MAX_HOVER_DEFINITIONS;
    if (omitted > 0) {
        lines.push('', `${omitted} more definitions omitted from hover.`);
    }

    return lines.join('\n');
}

function buildDefinitionHoverSection(definition, isDark = true) {
    const lines = [];
    const titleStr = definition.title ? ` - _${definition.title}_` : '';
    const cleanKeyword = definition.keyword.replace(/^\*/, '');
    lines.push(`### $(graph-line) **\\*${cleanKeyword} (ID: ${definition.id})**${titleStr}`);
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

