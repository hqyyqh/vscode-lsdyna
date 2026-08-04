const i18n = require('../i18n');

const {
    renderCurveSvgDataUri,
    renderCurveMarkdownFallback,
    renderTable3dSvgDataUri,
    markdownCode,
} = require('./curvePlotRenderer');
const { buildReferencePresentation } = require('./referencePresentation');

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

function isNavigableDefinition(definition) {
    return !!(
        definition &&
        typeof definition.filePath === 'string' &&
        definition.filePath.length > 0 &&
        Number.isInteger(definition.startLine) &&
        definition.startLine >= 0
    );
}

function childDefinitionKindLabel(kind) {
    return kind === 'table' ? i18n.get('tableDefinitionKind') : i18n.get('curveDefinitionKind');
}

function hoverRenderOptions(themeKind, isDark = true) {
    return themeKind == null ? { isDark } : { themeKind };
}

function appendCurvePreview(lines, definition, renderOptions: any = { isDark: true }) {
    const incomplete = definition.dataCompleteness && definition.dataCompleteness.state !== 'complete';
    if (incomplete) {
        lines.push('', i18n.get('referenceDataIncomplete'));
    } else {
        const dataUri = renderCurveSvgDataUri(definition, renderOptions);
        if (dataUri) {
            lines.push('', `![${i18n.get('curvePreviewAlt')}](${dataUri})`);
        }
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

function childAnalysisForRow(row) {
    return row && row.childAnalysis || null;
}

function childLink(row) {
    const raw = markdownCode(row.childIdRaw);
    const analysis = childAnalysisForRow(row);
    const definitions = analysis && analysis.definitions || [];
    if (!analysis || definitions.length === 0) return raw;
    if (analysis.state === 'exact' && definitions.length === 1) {
        const [onlyDefinition] = definitions;
        if (!isNavigableDefinition(onlyDefinition)) return raw;
        return `${raw} ${definitionLink(
            onlyDefinition,
            i18n.get('openChildDefinition', childDefinitionKindLabel(row.childKind))
        )}`;
    }
    const links = definitions
        .filter(isNavigableDefinition)
        .slice(0, MAX_HOVER_DEFINITIONS)
        .map((candidate, index) =>
            definitionLink(
                candidate,
                i18n.get(
                    'openChildCandidateDefinition',
                    childDefinitionKindLabel(row.childKind),
                    index + 1
                )
            )
        );
    if (links.length === 0) return raw;
    return `${raw}<br>${links.join('<br>')}`;
}

function appendTableChildDiagnostics(lines, rows) {
    for (const row of rows) {
        const analysis = childAnalysisForRow(row);
        if (!analysis || analysis.state === 'exact') continue;
        const displayId = Number.isSafeInteger(analysis.effectiveChildId)
            ? analysis.effectiveChildId
            : row.childIdRaw;
        if (analysis.state === 'ambiguous') {
            lines.push('', i18n.get(
                'tableChildAmbiguous',
                displayId,
                (analysis.definitions || []).length
            ));
        } else if (analysis.state === 'missing') {
            lines.push('', i18n.get(
                'tableChildMissing',
                childDefinitionKindLabel(row.childKind),
                displayId
            ));
        } else {
            lines.push('', i18n.get('tableChildUncertain', displayId));
            for (const reason of [...new Set(analysis.reasons || [])]) {
                lines.push(`- ${uncertaintyReasonLabel(reason)}`);
            }
        }
    }
}

function appendTablePreview(lines, definition, renderOptions: any = { isDark: true }) {
    const allRows = definition.rows || [];
    const requiredChildRows = allRows.filter(row =>
        !(row.childIdInput && row.childIdInput.kind === 'blank') &&
        String(row.childIdRaw || '').trim().length > 0
    );
    const allChildrenExact = requiredChildRows.every(row => {
        const analysis = childAnalysisForRow(row);
        return !!analysis && analysis.state === 'exact' &&
            (analysis.definitions || []).length === 1;
    });
    const tableWithPoints = {
        ...definition,
        rows: allRows.map(row => {
            const analysis = childAnalysisForRow(row);
            const [exactDefinition] = analysis && analysis.state === 'exact' &&
                analysis.definitions && analysis.definitions.length === 1
                ? analysis.definitions
                : [];
            const points = exactDefinition && exactDefinition.points || [];
            return { ...row, points };
        })
    };

    const incomplete = definition.dataCompleteness && definition.dataCompleteness.state !== 'complete';
    if (incomplete) {
        lines.push('', i18n.get('referenceDataIncomplete'));
    } else if (!allChildrenExact) {
        lines.push('', i18n.get('tablePreviewRequiresExactChildren'));
    } else {
        const dataUri = renderTable3dSvgDataUri(tableWithPoints, renderOptions);
        if (dataUri) {
            lines.push('', `![${i18n.get('table3dPreviewAlt')}](${dataUri})`);
        }
    }

    const childLabel = definition.tableType === '3d' || definition.tableType === '4d'
        ? i18n.get('tableIdColumn')
        : i18n.get('curveIdColumn');
    if (allRows.length === 0) {
        return;
    }
    const rows = allRows.slice(0, MAX_TABLE_ROWS);
    lines.push('', `| ${i18n.get('valueColumn')} | ${childLabel} |`, '| ---: | ---: |');
    for (const row of rows) {
        lines.push(`| ${markdownCode(row.valueRaw)} | ${childLink(row)} |`);
    }
    const omitted = allRows.length - rows.length;
    if (omitted > 0) {
        lines.push(`| ... | ${i18n.get('moreRows', omitted)} |`);
    }
    appendTableChildDiagnostics(lines, rows);
}

function appendDefinition(lines, definition, renderOptions: any = { isDark: true }, candidate = null) {
    const isPossibleMatch = candidate && candidate.relation === 'possible-match';
    if (isPossibleMatch) {
        lines.push('', `**${i18n.get(
            candidate.origin === 'current-file'
                ? 'referenceCurrentFileCandidate'
                : 'referenceProjectCandidate'
        )}**`);
    }
    const locationLines = ['', i18n.get('definitionLocation', definition.keyword, definition.filePath)];
    if (!candidate || candidate.navigable) {
        locationLines.push(definitionLink(
            definition,
            isPossibleMatch ? i18n.get('openCandidateDefinition') : i18n.get('openDefinition')
        ));
    }
    lines.push(...locationLines);
    if (Array.isArray(definition.occurrencePathLabels) && definition.occurrencePathLabels.length > 1) {
        lines.push(i18n.get(
            'definitionOccurrence',
            definition.occurrencePathLabels.slice(1).join(' | ')
        ));
    }
    if (Number.isSafeInteger(definition.idfoffOffset) && definition.idfoffOffset !== 0) {
        lines.push(i18n.get(
            'definitionTransformResolvedValue',
            definition.sourceId,
            definition.effectiveId,
            definition.idfoffOffset
        ));
    }
    if (definition.title) {
        lines.push(`_${definition.title}_`);
    }
    const previewMode = candidate && candidate.previewMode || null;
    if (previewMode === 'location-only') {
        return;
    }
    if (definition.kind === 'curve') {
        appendCurvePreview(lines, definition, renderOptions);
    } else if (definition.kind === 'functionCurve') {
        appendFunctionPreview(lines, definition);
    } else if (definition.kind === 'table') {
        appendTablePreview(lines, definition, renderOptions);
    }
}

function uncertaintyReasonLabel(reason) {
    const keyByReason = {
        'parameter-unresolved': 'referenceReasonParameterUnresolved',
        'parameter-expression-unresolved': 'referenceReasonExpressionUnresolved',
        'parameterized-include-unresolved': 'referenceReasonIncludeParameterUnresolved',
        'transform-offset-unresolved': 'referenceReasonTransformOffsetUnresolved',
        'transform-occurrence-ambiguous': 'referenceReasonTransformOccurrenceAmbiguous',
        'nested-transform-unsupported': 'referenceReasonNestedTransformUnsupported',
        'parameter-type-transform-unsupported': 'referenceReasonParameterTypeTransformUnsupported',
        'signed-switch-transform-unverified': 'referenceReasonSignedSwitchTransformUnverified',
        'project-scan-unavailable': 'referenceReasonProjectScanUnavailable',
        'project-root-ambiguous': 'referenceReasonProjectRootAmbiguous',
        'occurrence-search-path-unavailable': 'referenceReasonOccurrenceSearchPathUnavailable',
        'parameter-environment-unavailable': 'referenceReasonParameterEnvironmentUnavailable',
        'parameter-occurrence-ambiguous': 'referenceReasonParameterOccurrenceAmbiguous',
        'parameter-scope-control-unsupported': 'referenceReasonParameterScopeControlUnsupported',
        'parameter-type-unsupported': 'referenceReasonParameterTypeUnsupported',
        'parameter-duplication-order-unsupported': 'referenceReasonParameterDuplicationOrderUnsupported',
        'parameter-duplication-value-unresolved': 'referenceReasonParameterDuplicationValueUnresolved',
        'parameter-definition-reference-unresolved': 'referenceReasonParameterDefinitionReferenceUnresolved',
        'parameter-value-unresolved': 'referenceReasonParameterValueUnresolved',
        'parameter-value-unsafe': 'referenceReasonParameterValueUnsafe',
        'parameter-reference-zero': 'referenceReasonParameterReferenceZero',
        'missing-include': 'referenceReasonMissingInclude',
        'include-cycle': 'referenceReasonIncludeCycle',
        'reference-id-unresolved': 'referenceReasonIdUnresolved',
        'reference-id-offset-unsafe': 'referenceReasonIdOffsetUnsafe',
        'reference-value-unresolved': 'referenceReasonValueUnresolved',
    };
    const key = keyByReason[reason];
    return key ? i18n.get(key) : i18n.get('referenceReasonOther', reason);
}

function inferLegacyAnalysis(definitions, needsProjectScan) {
    if (needsProjectScan) {
        return {
            state: 'uncertain',
            definitions,
            reasons: ['project-scan-unavailable'],
        };
    }
    return {
        state: definitions.length === 0
            ? 'missing'
            : definitions.length === 1
                ? 'exact'
                : 'ambiguous',
        definitions,
        reasons: [],
    };
}

function buildReferenceHoverSection({
    fieldName,
    referenceValue = null,
    analysis = null,
    id,
    raw,
    isSignedSwitch = false,
    definitions = [],
    needsProjectScan = false,
    isDark = true,
    themeKind = null,
    documentPath = '',
}) {
    const effectiveReference = referenceValue || {
        kind: 'numeric',
        id,
        raw,
    };
    const effectiveAnalysis = analysis || inferLegacyAnalysis(definitions || [], needsProjectScan);
    const presentation = buildReferencePresentation(effectiveAnalysis, { documentPath });
    const resolvedDefinitions = effectiveAnalysis.definitions || [];
    const presentedCandidates = presentation.candidates;
    const renderOptions = hoverRenderOptions(themeKind, isDark);
    const displayValue = effectiveReference.kind === 'parameter'
        ? effectiveReference.raw
        : effectiveReference.id;
    const lines = [
        '',
        '',
        '---',
        '',
        `**$(graph-line) ${i18n.get('referenceLabel', fieldName)}:** \`${displayValue}\``,
    ];

    if (effectiveReference.raw && String(effectiveReference.raw) !== String(displayValue)) {
        lines.push(i18n.get('rawValue', effectiveReference.raw));
    }
    if (effectiveAnalysis.parameterResolution &&
        effectiveAnalysis.parameterResolution.resolved) {
        lines.push(i18n.get(
            'referenceParameterResolvedValue',
            effectiveAnalysis.parameterResolution.value
        ));
    }
    if (effectiveAnalysis.transformResolution &&
        effectiveAnalysis.transformResolution.resolved &&
        effectiveAnalysis.transformResolution.offset !== 0) {
        lines.push(i18n.get(
            'referenceTransformResolvedValue',
            effectiveAnalysis.transformResolution.sourceId,
            effectiveAnalysis.transformResolution.effectiveId,
            effectiveAnalysis.transformResolution.offset
        ));
    }
    if (isSignedSwitch && effectiveReference.kind === 'numeric') {
        lines.push(i18n.get('negativeSwitchStripped'));
    }

    if (effectiveAnalysis.state === 'uncertain') {
        lines.push('', i18n.get('referenceResolutionUncertain'));
        for (const reason of [...new Set(effectiveAnalysis.reasons || [])]) {
            lines.push(`- ${uncertaintyReasonLabel(reason)}`);
        }
        if (presentedCandidates.length > 0) {
            lines.push('', i18n.get('referenceKnownCandidates', presentedCandidates.length));
            for (const candidate of presentedCandidates.slice(0, MAX_HOVER_DEFINITIONS)) {
                appendDefinition(lines, candidate.definition, renderOptions, candidate);
            }
        }
        const omitted = presentedCandidates.length - MAX_HOVER_DEFINITIONS;
        if (omitted > 0) {
            lines.push('', i18n.get('moreDefinitionsOmitted', omitted));
        }
        if (presentation.showProjectScanAction) {
            lines.push('', i18n.get('runScanIncludeTreeForCrossFileDefinitions'));
        }
        return lines.join('\n');
    } else if (effectiveAnalysis.state === 'missing') {
        lines.push('', i18n.get('noMatchingDefinition', displayValue));
    } else if (effectiveAnalysis.state === 'ambiguous') {
        lines.push('', i18n.get('matchingDefinitionsFound', resolvedDefinitions.length));
    }

    if (resolvedDefinitions.length === 0) {
        return lines.join('\n');
    }

    for (const candidate of presentedCandidates.slice(0, MAX_HOVER_DEFINITIONS)) {
        appendDefinition(lines, candidate.definition, renderOptions, candidate);
    }

    const omitted = resolvedDefinitions.length - MAX_HOVER_DEFINITIONS;
    if (omitted > 0) {
        lines.push('', i18n.get('moreDefinitionsOmitted', omitted));
    }

    return lines.join('\n');
}

function buildDefinitionHoverSection(definition, themeOrIsDark: any = true) {
    const lines = [];
    const renderOptions = typeof themeOrIsDark === 'boolean'
        ? { isDark: themeOrIsDark }
        : { themeKind: themeOrIsDark };
    const titleStr = definition.title ? ` - _${definition.title}_` : '';
    const cleanKeyword = definition.keyword.replace(/^\*/, '');
    const displayId = Number.isFinite(definition.id) ? definition.id : definition.idRaw;
    lines.push(`### $(graph-line) **\\*${cleanKeyword}${i18n.get('definitionIdLabel', displayId)}**${titleStr}`);
    if (definition.kind === 'curve') {
        appendCurvePreview(lines, definition, renderOptions);
    } else if (definition.kind === 'functionCurve') {
        appendFunctionPreview(lines, definition);
    } else if (definition.kind === 'table') {
        appendTablePreview(lines, definition, renderOptions);
    }
    return lines.join('\n');
}

module.exports = {
    buildReferenceHoverSection,
    buildDefinitionHoverSection,
    definitionLink,
    uncertaintyReasonLabel,
};

export {};

