import { userFacingReason } from '../userFacingReason';
const i18n = require('../i18n');

const {
    renderCurveSvgDataUri,
    renderTable3dSvgDataUri,
    TABLE_3D_VIEWS,
    normalizeTable3dView,
    markdownCode,
} = require('./curvePlotRenderer');
const { buildReferencePresentation } = require('./referencePresentation');
const {
    effectiveWorkspaceSearchId,
    shouldOfferWorkspaceReferenceSearch,
} = require('./workspaceReferenceSearch');

const MAX_HOVER_DEFINITIONS = 4;
const MAX_CHILD_DIAGNOSTICS = 8;
const MAX_FUNCTION_LINES = 8;
// ponytail: 300px previews fit supported 360px hovers; revisit sizing if narrower views are supported.
const HOVER_PREVIEW_WIDTH = 300;

function markdownText(value) {
    return String(value ?? '').replace(/[\\`*_{}\[\]()#+.!|<>-]/g, '\\$&').replace(/\r?\n/g, ' ');
}

function encodeCommandArgs(args) {
    return encodeURIComponent(JSON.stringify([args]));
}

function definitionLink(definition, title = i18n.get('openDefinition'), iconOnly = false) {
    const args = encodeCommandArgs({
        filePath: definition.filePath,
        lineIndex: definition.startLine || 0,
        character: 0,
    });
    const tooltip = escapeHtmlAttribute(`${title}\n${definition.filePath}`).replace(/\\/g, '\\\\');
    return `[$(go-to-file) ${iconOnly ? '' : title}](command:extension.openLsdynaReferenceDefinition?${args} "${tooltip}")`;
}

function workspaceReferenceSearchLink(referenceValue, analysis, candidateCount, context) {
    if (!context || typeof context.filePath !== 'string' || !context.filePath ||
        !Number.isInteger(context.lineIndex) || !Number.isInteger(context.character) ||
        !shouldOfferWorkspaceReferenceSearch(referenceValue, analysis, candidateCount)) {
        return '';
    }
    const id = effectiveWorkspaceSearchId(referenceValue, analysis);
    if (id === null) return '';
    const args = encodeCommandArgs({
        filePath: context.filePath,
        lineIndex: context.lineIndex,
        character: context.character,
        documentVersion: Number.isInteger(context.documentVersion)
            ? context.documentVersion
            : undefined,
        projectRootFile: typeof context.projectRootFile === 'string' && context.projectRootFile
            ? context.projectRootFile
            : undefined,
    });
    const title = i18n.get('workspaceReferenceSearchTooltip');
    const label = i18n.get('workspaceReferenceSearchAction', markdownText(id));
    return `[$(search) ${label}](command:extension.searchLsdynaReferenceInWorkspace?${args} "${title}")`;
}

function childDefinitionKindLabel(kind) {
    return kind === 'table' ? i18n.get('tableDefinitionKind') : i18n.get('curveDefinitionKind');
}

function hoverRenderOptions(themeKind, isDark = true) {
    return themeKind == null ? { isDark } : { themeKind };
}

function escapeHtmlText(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value) {
    return escapeHtmlText(value)
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/\r?\n/g, '&#10;');
}

function compactStatus(icon, label, details) {
    return `<span style="color:var(--vscode-descriptionForeground);font-size:90%;" title="${escapeHtmlAttribute(details)}">${icon} ${escapeHtmlText(label)}</span>`;
}

const TABLE_VIEW_LABEL_KEYS = {
    isometric: 'tablePreviewViewIsometric',
    'reverse-isometric': 'tablePreviewViewReverseIsometric',
    front: 'tablePreviewViewFront',
    side: 'tablePreviewViewSide',
};
const TABLE_VIEW_DETAIL_KEYS = {
    isometric: 'tablePreviewViewIsometricDetail',
    'reverse-isometric': 'tablePreviewViewReverseIsometricDetail',
    front: 'tablePreviewViewFrontDetail',
    side: 'tablePreviewViewSideDetail',
};

function tablePreviewViewSelector(context) {
    if (!context || typeof context.key !== 'string' || !context.key) return '';
    const currentView = normalizeTable3dView(context.view);
    const options = TABLE_3D_VIEWS.map(view => {
        const label = i18n.get(TABLE_VIEW_LABEL_KEYS[view]);
        if (view === currentView) return `**${label}**`;
        const args = encodeCommandArgs({
            key: context.key,
            view,
            filePath: context.filePath,
            lineIndex: context.lineIndex,
            character: context.character,
            endCharacter: context.endCharacter,
        });
        const detail = i18n.get(TABLE_VIEW_DETAIL_KEYS[view]).replace(/"/g, '&quot;');
        return `[${label}](command:extension.setLsdynaTablePreviewView?${args} "${detail}")`;
    });
    return `<span style="color:var(--vscode-descriptionForeground);font-size:90%;">${escapeHtmlText(i18n.get('tablePreviewViewLabel'))}</span> ${options.join(' · ')}`;
}

function appendCurvePreview(lines, definition, renderOptions: any = { isDark: true }) {
    const incomplete = definition.dataCompleteness && definition.dataCompleteness.state !== 'complete';
    if (incomplete) {
        if (!renderOptions.quiet) lines.push('', i18n.get('referenceDataIncomplete'));
    } else {
        const dataUri = renderCurveSvgDataUri(definition, renderOptions);
        if (dataUri) {
            lines.push('', `![${i18n.get('curvePreviewAlt')}](${dataUri}|width=${HOVER_PREVIEW_WIDTH})`);
        }
    }
}

function appendFunctionPreview(lines, definition) {
    const text = String(definition.functionText || '').split(/\r?\n/).slice(0, MAX_FUNCTION_LINES).join('\n');
    if (text) {
        const longest = Math.max(2, ...(text.match(/`+/g) || []).map(run => run.length));
        const fence = '`'.repeat(longest + 1);
        lines.push('', `${fence}lsdyna`, text, fence);
    }
}

function childAnalysisForRow(row) {
    return row && row.childAnalysis || null;
}

function appendTableChildDiagnostics(lines, rows) {
    for (const row of rows) {
        const analysis = childAnalysisForRow(row);
        if (!analysis || analysis.state === 'exact') continue;
        const childReasons = [...new Set(analysis.reasons || [])];
        const isCurrentFileSingleton = analysis.state === 'uncertain' &&
            (analysis.definitions || []).length === 1 &&
            childReasons.length > 0 &&
            childReasons.every(reason => reason === 'project-scan-unavailable');
        if (isCurrentFileSingleton) {
            continue;
        }
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
            lines.push('', compactStatus(
                '$(warning)',
                i18n.get('tableChildUncertainCompact', displayId),
                [
                    i18n.get('tableChildUncertainDetail', displayId),
                    ...childReasons.map(uncertaintyReasonLabel),
                ].join('\n')
            ));
        }
    }
}

function appendTablePreview(lines, definition, renderOptions: any = { isDark: true }) {
    const allRows = definition.rows || [];
    const requiredChildRows = allRows.filter(row =>
        !(row.childIdInput && row.childIdInput.kind === 'blank') &&
        String(row.childIdRaw || '').trim().length > 0
    );
    const allChildrenUnique = requiredChildRows.every(row => {
        const analysis = childAnalysisForRow(row);
        return !!analysis && (analysis.definitions || []).length === 1;
    });
    const incomplete = definition.dataCompleteness && definition.dataCompleteness.state !== 'complete';
    if (incomplete) {
        if (!renderOptions.quiet) lines.push('', i18n.get('referenceDataIncomplete'));
    } else if (!allChildrenUnique) {
        if (!renderOptions.quiet) lines.push('', compactStatus(
            '$(warning)',
            i18n.get('tablePreviewHidden'),
            i18n.get('tablePreviewRequiresUniqueChildren')
        ));
    } else if (requiredChildRows.some(row => {
        const child = childAnalysisForRow(row).definitions[0];
        return child.dataCompleteness && child.dataCompleteness.state !== 'complete';
    })) {
        if (!renderOptions.quiet) lines.push('', `> ${i18n.get('tablePreviewChildrenIncomplete').replace(/\n/g, '  \n> ')}`);
    } else {
        const tableWithPoints = {
            ...definition,
            rows: allRows.map(row => {
                const definitions = childAnalysisForRow(row)?.definitions || [];
                return { ...row, points: definitions.length === 1 ? definitions[0].points || [] : [] };
            }),
        };
        const tablePreviewContext = renderOptions.tablePreviewContext || null;
        const view = normalizeTable3dView(tablePreviewContext && tablePreviewContext.view);
        const dataUri = renderTable3dSvgDataUri(tableWithPoints, { ...renderOptions, view });
        if (dataUri) {
            const selector = tablePreviewViewSelector(tablePreviewContext);
            if (selector) lines.push('', selector);
            lines.push('', `![${i18n.get('table3dPreviewAlt')}](${dataUri}|width=${HOVER_PREVIEW_WIDTH})`);
        }
    }

    if (!renderOptions.quiet) appendTableChildDiagnostics(lines, allRows.slice(0, MAX_CHILD_DIAGNOSTICS));
}

function appendDefinition(lines, definition, renderOptions: any = { isDark: true }, candidate) {
    const displayPath = String(definition.filePath ?? '').split(/(?<=[\\/])/).map(markdownCode).join('<wbr>');
    const locationLines = renderOptions.compactCurve
        ? ['']
        : ['', i18n.get('definitionLocation', markdownText(definition.keyword), displayPath)];
    if (candidate.navigable) {
        locationLines.push(definitionLink(
            definition,
            i18n.get('openDefinition'),
            renderOptions.compactCurve
        ));
    }
    if (renderOptions.compactCurve && renderOptions.status) locationLines.push(renderOptions.status);
    if (renderOptions.compactCurve) lines.push(locationLines.join(' '));
    else lines.push(...locationLines);
    if (Array.isArray(definition.occurrencePathLabels) && definition.occurrencePathLabels.length > 1) {
        lines.push(i18n.get(
            'definitionOccurrence',
            markdownCode(definition.occurrencePathLabels.slice(1).join(' | '))
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
        lines.push(`_${markdownText(definition.title)}_`);
    }
    const previewMode = candidate.previewMode;
    if (!candidate.previewAllowed || previewMode === 'location-only') {
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
        'parameter-undefined': 'referenceReasonParameterUndefined',
        'parameter-cycle': 'referenceReasonParameterCycle',
        'parameter-expression-unsupported': 'referenceReasonParameterExpressionUnsupported',
        'parameter-evaluation-budget': 'referenceReasonParameterBudget',
        'parameter-evaluation-cancelled': 'referenceReasonParameterCancelled',
        'parameterized-include-unresolved': 'referenceReasonIncludeParameterUnresolved',
        'transform-offset-unresolved': 'referenceReasonTransformOffsetUnresolved',
        'transform-occurrence-ambiguous': 'referenceReasonTransformOccurrenceAmbiguous',
        'nested-transform-unsupported': 'referenceReasonNestedTransformUnsupported',
        'parameter-type-transform-unsupported': 'referenceReasonParameterTypeTransformUnsupported',
        'signed-switch-transform-unverified': 'referenceReasonSignedSwitchTransformUnverified',
        'project-scan-unavailable': 'referenceReasonProjectScanUnavailable',
        'source-result-page-limit': 'referenceReasonSourcePageLimit',
        'source-analysis-budget': 'referenceReasonSourceAnalysisLimit',
        'entity-query-index-budget': 'referenceReasonEntityIndexBudget',
        'entity-query-cancelled': 'referenceReasonEntityCancelled',
        'entity-query-low-memory': 'referenceReasonEntityLowMemory',
        'entity-query-result-budget': 'referenceReasonEntityResultBudget',
        'entity-query-incomplete': 'referenceReasonEntityQueryIncomplete',
        'project-root-ambiguous': 'referenceReasonProjectRootAmbiguous',
        'occurrence-search-path-unavailable': 'referenceReasonOccurrenceSearchPathUnavailable',
        'parameter-environment-unavailable': 'referenceReasonParameterEnvironmentUnavailable',
        'parameter-context-unavailable': 'referenceReasonParameterEnvironmentUnavailable',
        'parameter-context-pending': 'referenceReasonParameterEnvironmentUnavailable',
        'parameter-document-version-unavailable': 'referenceReasonParameterEnvironmentUnavailable',
        'parameter-project-context-unavailable': 'referenceReasonProjectScanUnavailable',
        'parameter-project-context-incomplete': 'referenceReasonProjectScanUnavailable',
        'parameter-main-file-ambiguous': 'referenceReasonProjectRootAmbiguous',
        'parameter-context-stale': 'referenceReasonParameterContextStale',
        'parameter-control-outside-int32': 'referenceReasonParameterControlRange',
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
    return key ? i18n.get(key) : userFacingReason(reason, i18n.getLanguage());
}

function compactReferenceStatus(analysis, presentation, displayValue, iconOnly = false) {
    const status = (icon, label, details) => compactStatus(
        icon, iconOnly ? '' : label, iconOnly ? `${label}\n${details}` : details
    );
    const candidates = presentation.candidates;
    const reasons = [...new Set(analysis.reasons || [])];
    const reasonDetails = reasons.map(uncertaintyReasonLabel);

    if (analysis.state === 'missing') {
        return status(
            '$(warning)',
            i18n.get('referenceStatusMissing'),
            i18n.get('referenceStatusMissingDetail', displayValue)
        );
    }

    if (analysis.state === 'ambiguous' || candidates.length > 1) {
        const details = [
            i18n.get('referenceStatusAmbiguousDetail', candidates.length),
            ...reasonDetails,
        ].join('\n');
        return status('$(warning)', i18n.get('referenceStatusAmbiguous'), details);
    }

    if (analysis.state !== 'uncertain') {
        return '';
    }

    if (candidates.length === 1) {
        const [candidate] = candidates;
        const isCurrentFilePreview = candidate.origin === 'current-file' &&
            reasons.includes('project-scan-unavailable');
        const label = i18n.get(isCurrentFilePreview
            ? 'referenceStatusCurrentFilePreview'
            : 'referenceStatusCandidatePreview');
        const primaryDetail = i18n.get(isCurrentFilePreview
            ? 'referenceStatusCurrentFilePreviewDetail'
            : 'referenceStatusCandidatePreviewDetail');
        const details = [
            primaryDetail,
            ...reasonDetails.filter((_, index) =>
                !isCurrentFilePreview || reasons[index] !== 'project-scan-unavailable'
            ),
        ].join('\n');
        return status('$(info)', label, details);
    }

    if (reasons.includes('project-scan-unavailable')) {
        const details = [
            i18n.get('referenceStatusProjectUnscannedDetail'),
            ...reasonDetails.filter((_, index) => reasons[index] !== 'project-scan-unavailable'),
        ].join('\n');
        return status('$(info)', i18n.get('referenceStatusProjectUnscanned'), details);
    }

    return status(
        '$(warning)',
        i18n.get('referenceStatusUnresolved'),
        reasonDetails.join('\n') || i18n.get('referenceStatusUnresolvedDetail')
    );
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
    tablePreviewContext = null,
    workspaceSearchContext = null,
}) {
    const effectiveReference = referenceValue || {
        kind: 'numeric',
        id,
        raw,
    };
    const effectiveAnalysis = analysis || inferLegacyAnalysis(definitions || [], needsProjectScan);
    const presentation = buildReferencePresentation(effectiveAnalysis, { documentPath });
    const resolvedDefinitions = effectiveAnalysis.definitions || [];
    const presentedCandidates = presentation.provisional && presentation.provisionalPrimary
        ? [presentation.provisionalPrimary, ...presentation.provisionalAlternatives]
        : presentation.candidates;
    const compactCurve = presentedCandidates.length === 1 && presentedCandidates[0].definition.kind === 'curve';
    const renderOptions = {
        compactCurve,
        status: '',
        ...hoverRenderOptions(themeKind, isDark),
        tablePreviewContext,
    };
    const displayValue = effectiveReference.kind === 'parameter'
        ? effectiveReference.raw
        : effectiveReference.id;
    const status = compactReferenceStatus(effectiveAnalysis, presentation, displayValue, compactCurve);
    renderOptions.status = status;
    const statusSuffix = status ? `&nbsp;&nbsp;${status}` : '';
    const lines = compactCurve ? ['', '', '---', ''] : [
        '',
        '',
        '---',
        '',
        `**$(graph-line) ${i18n.get('referenceLabel', markdownText(fieldName))}:** ${markdownCode(displayValue)}${statusSuffix}`,
    ];

    if (effectiveReference.raw && String(effectiveReference.raw) !== String(displayValue)) {
        lines.push(i18n.get('rawValue', markdownCode(effectiveReference.raw)));
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

    const workspaceSearchLink = workspaceReferenceSearchLink(
        effectiveReference,
        effectiveAnalysis,
        presentedCandidates.length,
        workspaceSearchContext
    );
    if (workspaceSearchLink) {
        lines.push('', workspaceSearchLink);
    }

    if (resolvedDefinitions.length === 0) {
        return lines.join('\n');
    }

    if (!compactCurve && presentation.provisional && presentation.provisionalPrimary) {
        lines.push('', compactStatus(
            '$(warning)',
            i18n.get('referenceCandidateNavigation'),
            i18n.get('referenceCandidateNavigationDetail'),
        ));
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

function buildDefinitionHoverSection(
    definition,
    themeOrIsDark: any = true,
    tablePreviewContext = null,
    quiet = false,
) {
    const lines = [];
    const renderOptions: any = typeof themeOrIsDark === 'boolean'
        ? { isDark: themeOrIsDark }
        : { themeKind: themeOrIsDark };
    renderOptions.tablePreviewContext = tablePreviewContext;
    renderOptions.quiet = quiet;
    const titleStr = definition.title ? ` - _${markdownText(definition.title)}_` : '';
    const cleanKeyword = markdownText(definition.keyword.replace(/^\*/, ''));
    const displayId = Number.isFinite(definition.id) ? definition.id : definition.idRaw;
    if (!quiet) lines.push(`### $(graph-line) **\\*${cleanKeyword}${i18n.get('definitionIdLabel', markdownText(displayId))}**${titleStr}`);
    if (definition.kind === 'curve') {
        appendCurvePreview(lines, definition, renderOptions);
    } else if (definition.kind === 'functionCurve') {
        appendFunctionPreview(lines, definition);
    } else if (definition.kind === 'table') {
        appendTablePreview(lines, definition, renderOptions);
    }
    return lines.join('\n');
}

function buildCompactReferenceHover(analysis, themeKind, tablePreviewContext) {
    const presentation = buildReferencePresentation(analysis);
    const candidates = presentation.candidates;
    if (candidates.length !== 1) return {
        body: '', actions: '',
        status: candidates.length > 1 ? i18n.get('hoverMultipleDefinitions', candidates.length) : '',
    };
    const candidate = candidates[0];
    const definition = candidate.definition;
    const title = i18n.get('openDefinition');
    return {
        body: candidate.previewAllowed ? buildDefinitionHoverSection(definition, themeKind, tablePreviewContext, true) : '',
        actions: candidate.navigable ? definitionLink(definition, title, true) : '',
        status: '',
    };
}

module.exports = {
    buildCompactReferenceHover,
    buildReferenceHoverSection,
    buildDefinitionHoverSection,
    definitionLink,
    uncertaintyReasonLabel,
    workspaceReferenceSearchLink,
};

export {};
