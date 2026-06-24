'use strict';

const {
    renderCurveSvgDataUri,
    renderCurveMarkdownFallback,
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

function appendCurvePreview(lines, definition) {
    const dataUri = renderCurveSvgDataUri(definition);
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

function appendTablePreview(lines, definition) {
    const childLabel = definition.tableType === '3d' ? 'table ID' : 'curve ID';
    const rows = (definition.rows || []).slice(0, MAX_TABLE_ROWS);
    if (rows.length === 0) {
        return;
    }
    lines.push('', `| value | ${childLabel} |`, '| ---: | ---: |');
    for (const row of rows) {
        lines.push(`| ${markdownCode(row.valueRaw)} | ${childLink(row, definition)} |`);
    }
    const omitted = (definition.rows || []).length - rows.length;
    if (omitted > 0) {
        lines.push(`| ... | ${omitted} more rows |`);
    }
}

function appendDefinition(lines, definition) {
    lines.push('', `**${definition.keyword}** in \`${definition.filePath}\``, definitionLink(definition));
    if (definition.title) {
        lines.push(`_${definition.title}_`);
    }
    if (definition.kind === 'curve') {
        appendCurvePreview(lines, definition);
    } else if (definition.kind === 'functionCurve') {
        appendFunctionPreview(lines, definition);
    } else if (definition.kind === 'table') {
        appendTablePreview(lines, definition);
    }
}

function buildReferenceHoverSection({ fieldName, id, raw, isSignedSwitch = false, definitions = [], needsProjectScan = false }) {
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
        appendDefinition(lines, definition);
    }

    const omitted = definitions.length - MAX_HOVER_DEFINITIONS;
    if (omitted > 0) {
        lines.push('', `${omitted} more definitions omitted from hover.`);
    }

    return lines.join('\n');
}

module.exports = {
    buildReferenceHoverSection,
    definitionLink,
};

export {};
