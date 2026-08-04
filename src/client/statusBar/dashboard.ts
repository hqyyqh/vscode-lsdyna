'use strict';

/**
 * @fileoverview LS-DYNA status bar as a deck-edit context HUD (not an env dashboard).
 * @module client/statusBar/dashboard
 */

const vscode = require('vscode');

type StatusBarLevel = 'off' | 'simple' | 'detail';

type DashboardContext = {
    isLsdyna?: boolean;
    level?: StatusBarLevel | string;
    keyword?: string;
    fieldIndex?: number | null;
    fieldCount?: number | null;
    manualReady?: boolean;
    /** Deck diagnostics on the active file (Error severity). */
    errorCount?: number;
    /** Deck diagnostics on the active file (Warning severity). */
    warningCount?: number;
    /** Environment/setup issues (manuals, Sumatra, …) — menu only except quiet fallback. */
    healthIssueCount?: number;
    tabNavigationEnabled?: boolean;
    /** Effective field-help state for menu description. */
    fieldHoverMenuState?: 'on' | 'offSession' | 'off';
    fieldHoverEnabled?: boolean;
    /** Optional last Include scan root basename (detail + tooltip). */
    scanRootName?: string | null;
    /** Main deck used to interpret the active file, if one is unambiguous. */
    mainDeckRootName?: string | null;
    mainDeckContextState?: 'exact' | 'unique' | 'selected' | 'ambiguous' | 'unavailable' | string;
    labels?: Partial<DashboardLabels>;
};

type DashboardItem = {
    id: string;
    label: string;
    description: string;
    detail: string;
};

type DashboardActions = {
    showHealth?: () => Promise<void> | void;
    scanIncludes?: () => Promise<void> | void;
    scanKeywordIndex?: () => Promise<void> | void;
    configureManuals?: () => Promise<void> | void;
    showOutput?: () => Promise<void> | void;
    showDiagnostics?: () => Promise<void> | void;
    toggleTabNavigation?: () => Promise<void> | void;
    toggleFieldHover?: () => Promise<void> | void;
    manageCustomValidKeywords?: () => Promise<void> | void;
    selectMainDeckContext?: () => Promise<void> | void;
};

const DEFAULT_COMMAND_ID = 'extension.lsdynaStatusDashboard';
const BRAND = 'LS-DYNA';

type DashboardLabels = {
    dashboardTooltip: string;
    placeHolder: string;
    showHealthLabel: string;
    healthReadyDescription: string;
    healthIssuesDescription: string;
    showHealthDetail: string;
    scanIncludesLabel: string;
    scanIncludesDescription: string;
    scanIncludesDetail: string;
    scanKeywordIndexLabel: string;
    scanKeywordIndexDescription: string;
    scanKeywordIndexDetail: string;
    configureManualsLabel: string;
    manualReadyDescription: string;
    manualSetupDescription: string;
    configureManualsDetail: string;
    showOutputLabel: string;
    showOutputDescription: string;
    showOutputDetail: string;
    showDiagnosticsLabel: string;
    diagnosticsNoneDescription: string;
    diagnosticsErrorsDescription: string;
    diagnosticsWarningsDescription: string;
    diagnosticsMixedDescription: string;
    showDiagnosticsDetail: string;
    toggleTabNavigationLabel: string;
    tabNavigationOnDescription: string;
    tabNavigationOffDescription: string;
    toggleTabNavigationDetail: string;
    toggleFieldHoverLabel: string;
    fieldHoverOnDescription: string;
    fieldHoverOffSessionDescription: string;
    fieldHoverOffDescription: string;
    toggleFieldHoverDetail: string;
    manageCustomValidKeywordsLabel: string;
    manageCustomValidKeywordsDescription: string;
    manageCustomValidKeywordsDetail: string;
    mainDeckContextLabel: string;
    mainDeckContextSelectedDescription: string;
    mainDeckContextAmbiguousDescription: string;
    mainDeckContextDetail: string;
    /** Status bar / tooltip fragments (optional overrides). */
    barManualSetup?: string;
    tooltipCurrentFile?: string;
    tooltipNoProblems?: string;
    tooltipErrors?: string;
    tooltipWarnings?: string;
    tooltipKeyword?: string;
    tooltipField?: string;
    tooltipScan?: string;
    tooltipNotScanned?: string;
    tooltipMainDeck?: string;
    tooltipMainDeckAmbiguous?: string;
    tooltipClick?: string;
};

const DEFAULT_DASHBOARD_LABELS: DashboardLabels = {
    dashboardTooltip: 'LS-DYNA deck context',
    placeHolder: 'LS-DYNA quick actions for the current file',
    showHealthLabel: '$(checklist) Environment and manuals',
    healthReadyDescription: 'OK',
    healthIssuesDescription: 'Setup required: {0}',
    showHealthDetail: 'Check manuals, PDF index, SumatraPDF, language mode, and project tools.',
    scanIncludesLabel: '$(references) Scan Include Tree',
    scanIncludesDescription: 'Project includes',
    scanIncludesDetail: 'Build the include hierarchy for the current LS-DYNA root file.',
    scanKeywordIndexLabel: '$(list-tree) Scan Keyword Index',
    scanKeywordIndexDescription: 'Project keywords',
    scanKeywordIndexDetail: 'Index keywords in the current file and its includes.',
    configureManualsLabel: '$(book) Configure Manuals',
    manualReadyDescription: 'Manuals ready',
    manualSetupDescription: 'Manual setup required',
    configureManualsDetail: 'Select the LS-DYNA PDF manual folder used by hover links.',
    showOutputLabel: '$(output) Open DynaSense Output',
    showOutputDescription: 'Runtime log',
    showOutputDetail: 'Open recent scan, indexing, and diagnostics messages.',
    showDiagnosticsLabel: '$(pulse) View problems',
    diagnosticsNoneDescription: 'No problems',
    diagnosticsErrorsDescription: 'Errors: {0}',
    diagnosticsWarningsDescription: 'Warnings: {0}',
    diagnosticsMixedDescription: 'Errors: {0}; warnings: {1}',
    showDiagnosticsDetail: 'View current-file diagnostics, jump to a problem, or copy the full report.',
    toggleTabNavigationLabel: '$(keyboard) Tab field navigation',
    tabNavigationOnDescription: 'On',
    tabNavigationOffDescription: 'Off',
    toggleTabNavigationDetail: 'Turn Tab navigation between fixed-width LS-DYNA fields on or off.',
    toggleFieldHoverLabel: '$(info) Field Help',
    fieldHoverOnDescription: 'On',
    fieldHoverOffSessionDescription: 'Off (this session)',
    fieldHoverOffDescription: 'Off',
    toggleFieldHoverDetail: 'Turn this off when field help is not needed while editing; re-enable it from this menu.',
    manageCustomValidKeywordsLabel: '$(list-unordered) Manage Custom Valid Keywords',
    manageCustomValidKeywordsDescription: 'Custom valid keywords',
    manageCustomValidKeywordsDetail: 'Add, edit, or remove keywords accepted by validation.',
    mainDeckContextLabel: '$(root-folder) Main deck context',
    mainDeckContextSelectedDescription: 'Selected: {0}',
    mainDeckContextAmbiguousDescription: 'Shared file: choose a load case',
    mainDeckContextDetail: 'Choose which already-scanned main deck interprets this shared file for this session.',
    barManualSetup: 'Manual setup',
    tooltipCurrentFile: 'Current file: {0}',
    tooltipNoProblems: 'no problems',
    tooltipErrors: 'Errors: {0}',
    tooltipWarnings: 'Warnings: {0}',
    tooltipKeyword: 'Keyword: {0}',
    tooltipField: 'Field: {0}/{1}',
    tooltipScan: 'Include Tree scan: {0}',
    tooltipNotScanned: 'not scanned',
    tooltipMainDeck: 'Main deck context: {0}',
    tooltipMainDeckAmbiguous: 'Main deck context: choose one for this shared file',
    tooltipClick: 'Click: quick actions',
};

function resolveDashboardLabels(overrides: Partial<DashboardLabels> = {}): DashboardLabels {
    return { ...DEFAULT_DASHBOARD_LABELS, ...overrides };
}

function formatLabelTemplate(template: string, ...values: Array<string | number>): string {
    let out = String(template || '');
    for (let i = 0; i < values.length; i++) {
        out = out.replace(`{${i}}`, String(values[i]));
    }
    return out;
}

function normalizeStatusBarLevel(value: any): StatusBarLevel {
    return value === 'off' || value === 'simple' || value === 'detail'
        ? value
        : 'simple';
}

function shouldShowDashboard({ isLsdyna, level }: { isLsdyna?: boolean; level?: string }): boolean {
    return Boolean(isLsdyna) && normalizeStatusBarLevel(level) !== 'off';
}

function normalizeKeyword(keyword: any): string {
    if (typeof keyword !== 'string') return '';
    return keyword.trim();
}

function countOrZero(value: any): number {
    return Math.max(0, Number(value || 0) || 0);
}

function hasFieldPosition(context: DashboardContext): boolean {
    return (
        Number.isFinite(context.fieldIndex)
        && Number.isFinite(context.fieldCount)
        && Number(context.fieldIndex) > 0
        && Number(context.fieldCount) > 0
    );
}

function normalizeScanRootName(name: any): string {
    if (typeof name !== 'string') return '';
    return name.trim();
}

/**
 * Deck edit context bar text.
 * Priority: errors > warnings > keyword (+ detail field/scan) > quiet brand > setup only if empty.
 */
function formatDashboardText(context: DashboardContext = {}): string {
    const level = normalizeStatusBarLevel(context.level);
    if (level === 'off') return '';

    const labels = resolveDashboardLabels(context.labels || {});
    const errorCount = countOrZero(context.errorCount);
    const warningCount = countOrZero(context.warningCount);
    const keyword = normalizeKeyword(context.keyword);
    const manualReady = Boolean(context.manualReady);

    // P1: deck errors on active file
    if (errorCount > 0) {
        return `${BRAND} · ${errorCount}✗`;
    }
    // P2: deck warnings
    if (warningCount > 0) {
        return `${BRAND} · ${warningCount}⚠`;
    }

    // P3/P4: keyword (+ detail field / scan short name)
    if (keyword) {
        if (level === 'simple') {
            return `${BRAND}: ${keyword}`;
        }
        const parts = [keyword];
        if (hasFieldPosition(context)) {
            parts.push(`${context.fieldIndex}/${context.fieldCount}`);
        }
        const scan = normalizeScanRootName(context.scanRootName);
        if (scan) {
            parts.push(scan);
        }
        return `${BRAND}: ${parts.join(' · ')}`;
    }

    // Setup fallback only when no deck issues and no keyword (A+B hybrid)
    if (!manualReady) {
        return `${BRAND}: ${labels.barManualSetup || labels.manualSetupDescription}`;
    }

    // P5 quiet
    return BRAND;
}

/**
 * Honest multi-line tooltip for the status bar item.
 */
function formatDashboardTooltip(context: DashboardContext = {}): string {
    const labels = resolveDashboardLabels(context.labels || {});
    const errorCount = countOrZero(context.errorCount);
    const warningCount = countOrZero(context.warningCount);
    const keyword = normalizeKeyword(context.keyword);
    const lines: string[] = [];

    let fileLine: string;
    if (errorCount > 0 && warningCount > 0) {
        fileLine = formatLabelTemplate(
            labels.tooltipCurrentFile || 'Current file: {0}',
            formatLabelTemplate(
                labels.diagnosticsMixedDescription || '{0} errors, {1} warnings',
                errorCount,
                warningCount,
            ),
        );
    } else if (errorCount > 0) {
        fileLine = formatLabelTemplate(
            labels.tooltipCurrentFile || 'Current file: {0}',
            formatLabelTemplate(labels.tooltipErrors || '{0} errors', errorCount),
        );
    } else if (warningCount > 0) {
        fileLine = formatLabelTemplate(
            labels.tooltipCurrentFile || 'Current file: {0}',
            formatLabelTemplate(labels.tooltipWarnings || '{0} warnings', warningCount),
        );
    } else {
        fileLine = formatLabelTemplate(
            labels.tooltipCurrentFile || 'Current file: {0}',
            labels.tooltipNoProblems || 'no problems',
        );
    }
    lines.push(fileLine);

    if (keyword) {
        lines.push(formatLabelTemplate(labels.tooltipKeyword || 'Keyword: {0}', keyword));
    }
    if (hasFieldPosition(context)) {
        lines.push(
            formatLabelTemplate(
                labels.tooltipField || 'Field: {0}/{1}',
                Number(context.fieldIndex),
                Number(context.fieldCount),
            ),
        );
    }

    const scan = normalizeScanRootName(context.scanRootName);
    if (scan) {
        lines.push(formatLabelTemplate(labels.tooltipScan || 'Include scan: {0}', scan));
    } else {
        lines.push(
            formatLabelTemplate(
                labels.tooltipScan || 'Include scan: {0}',
                labels.tooltipNotScanned || 'not scanned',
            ),
        );
    }

    if (context.mainDeckContextState === 'ambiguous') {
        lines.push(
            labels.tooltipMainDeckAmbiguous ||
            'Main deck context: choose one for this shared file'
        );
    } else {
        const mainDeck = normalizeScanRootName(context.mainDeckRootName);
        if (mainDeck) {
            lines.push(
                formatLabelTemplate(
                    labels.tooltipMainDeck || 'Main deck context: {0}',
                    mainDeck
                )
            );
        }
    }

    lines.push(labels.tooltipClick || labels.dashboardTooltip || 'Click: quick actions');
    return lines.join('\n');
}

function diagnosticsMenuDescription(
    labels: DashboardLabels,
    errorCount: number,
    warningCount: number,
): string {
    if (errorCount > 0 && warningCount > 0) {
        return formatLabelTemplate(labels.diagnosticsMixedDescription, errorCount, warningCount);
    }
    if (errorCount > 0) {
        return formatLabelTemplate(labels.diagnosticsErrorsDescription, errorCount);
    }
    if (warningCount > 0) {
        return formatLabelTemplate(labels.diagnosticsWarningsDescription, warningCount);
    }
    return labels.diagnosticsNoneDescription;
}

/**
 * Quick-action menu: problems / manuals CTA first, Include high, env sunk, log last.
 */
function buildDashboardItems(context: DashboardContext = {}): DashboardItem[] {
    const errorCount = countOrZero(context.errorCount);
    const warningCount = countOrZero(context.warningCount);
    const problemCount = errorCount + warningCount;
    const healthIssueCount = countOrZero(context.healthIssueCount);
    const tabNavigationEnabled = context.tabNavigationEnabled !== false;
    const manualReady = Boolean(context.manualReady);
    const labels = resolveDashboardLabels(context.labels || {});
    const fieldHoverMenuState = context.fieldHoverMenuState
        || (context.fieldHoverEnabled === false ? 'off' : 'on');
    const fieldHoverDescription =
        fieldHoverMenuState === 'offSession'
            ? labels.fieldHoverOffSessionDescription
            : fieldHoverMenuState === 'off'
                ? labels.fieldHoverOffDescription
                : labels.fieldHoverOnDescription;

    const diagnosticsItem: DashboardItem = {
        id: 'showDiagnostics',
        label: labels.showDiagnosticsLabel,
        description: diagnosticsMenuDescription(labels, errorCount, warningCount),
        detail: labels.showDiagnosticsDetail,
    };
    const manualsItem: DashboardItem = {
        id: 'configureManuals',
        label: labels.configureManualsLabel,
        description: manualReady ? labels.manualReadyDescription : labels.manualSetupDescription,
        detail: labels.configureManualsDetail,
    };
    const healthItem: DashboardItem = {
        id: 'showHealth',
        label: labels.showHealthLabel,
        description: healthIssueCount > 0
            ? formatLabelTemplate(labels.healthIssuesDescription, healthIssueCount)
            : labels.healthReadyDescription,
        detail: labels.showHealthDetail,
    };
    const scanIncludes: DashboardItem = {
        id: 'scanIncludes',
        label: labels.scanIncludesLabel,
        description: labels.scanIncludesDescription,
        detail: labels.scanIncludesDetail,
    };
    const scanKeywordIndex: DashboardItem = {
        id: 'scanKeywordIndex',
        label: labels.scanKeywordIndexLabel,
        description: labels.scanKeywordIndexDescription,
        detail: labels.scanKeywordIndexDetail,
    };
    const toggleTab: DashboardItem = {
        id: 'toggleTabNavigation',
        label: labels.toggleTabNavigationLabel,
        description: tabNavigationEnabled ? labels.tabNavigationOnDescription : labels.tabNavigationOffDescription,
        detail: labels.toggleTabNavigationDetail,
    };
    const toggleHover: DashboardItem = {
        id: 'toggleFieldHover',
        label: labels.toggleFieldHoverLabel,
        description: fieldHoverDescription,
        detail: labels.toggleFieldHoverDetail,
    };
    const customKw: DashboardItem = {
        id: 'manageCustomValidKeywords',
        label: labels.manageCustomValidKeywordsLabel,
        description: labels.manageCustomValidKeywordsDescription,
        detail: labels.manageCustomValidKeywordsDetail,
    };
    const showOutput: DashboardItem = {
        id: 'showOutput',
        label: labels.showOutputLabel,
        description: labels.showOutputDescription,
        detail: labels.showOutputDetail,
    };
    const mainDeckContextItem: DashboardItem | null =
        context.mainDeckContextState === 'selected' ||
        context.mainDeckContextState === 'ambiguous'
            ? {
                id: 'selectMainDeckContext',
                label: labels.mainDeckContextLabel,
                description: context.mainDeckContextState === 'selected'
                    ? formatLabelTemplate(
                        labels.mainDeckContextSelectedDescription,
                        normalizeScanRootName(context.mainDeckRootName)
                    )
                    : labels.mainDeckContextAmbiguousDescription,
                detail: labels.mainDeckContextDetail,
            }
            : null;

    const items: DashboardItem[] = [];

    // Problems first when any deck diagnostics exist
    if (problemCount > 0) {
        items.push(diagnosticsItem);
    }
    // Manuals CTA when not ready (after problems if any)
    if (!manualReady) {
        items.push(manualsItem);
    }

    if (mainDeckContextItem) {
        items.push(mainDeckContextItem);
    }
    items.push(scanIncludes, scanKeywordIndex, toggleTab, toggleHover, customKw);

    // Manuals when already ready: mid-low (not promoted)
    if (manualReady) {
        items.push(manualsItem);
    }

    // Diagnostics when none: keep discoverable after structure/edit, before env
    if (problemCount === 0) {
        items.push(diagnosticsItem);
    }

    items.push(healthItem, showOutput);
    return items;
}

class LsdynaStatusBarDashboard {
    statusBarItem: any;
    getContext: () => DashboardContext;
    showQuickPick: (items: DashboardItem[], options?: object) => Promise<DashboardItem | undefined>;
    actions: DashboardActions;
    commandId: string;
    timer: any;
    schedule: (callback: () => void, delayMs: number) => any;
    cancel: (timer: any) => void;
    debounceMs: number;

    constructor({
        statusBarItem,
        getContext = () => ({}),
        showQuickPick = (items, options) => vscode.window.showQuickPick(items, options),
        actions = {},
        commandId = DEFAULT_COMMAND_ID,
        debounceMs = 100,
        schedule = setTimeout,
        cancel = clearTimeout,
    }: {
        statusBarItem: any;
        getContext?: () => DashboardContext;
        showQuickPick?: (items: DashboardItem[], options?: object) => Promise<DashboardItem | undefined>;
        actions?: DashboardActions;
        commandId?: string;
        debounceMs?: number;
        schedule?: (callback: () => void, delayMs: number) => any;
        cancel?: (timer: any) => void;
    }) {
        if (!statusBarItem) {
            throw new TypeError('LsdynaStatusBarDashboard requires a statusBarItem');
        }
        this.statusBarItem = statusBarItem;
        this.getContext = getContext;
        this.showQuickPick = showQuickPick;
        this.actions = actions;
        this.commandId = commandId;
        this.debounceMs = debounceMs;
        this.schedule = schedule;
        this.cancel = cancel;
        this.timer = null;
    }

    refresh(): void {
        const context = this.getContext() || {};
        if (!shouldShowDashboard({ isLsdyna: context.isLsdyna, level: context.level })) {
            this.statusBarItem.hide();
            return;
        }

        this.statusBarItem.text = formatDashboardText(context);
        this.statusBarItem.tooltip = formatDashboardTooltip(context);
        this.statusBarItem.command = this.commandId;
        this.statusBarItem.show();
    }

    scheduleRefresh(): void {
        if (this.timer) this.cancel(this.timer);
        this.timer = this.schedule(() => {
            this.timer = null;
            this.refresh();
        }, this.debounceMs);
    }

    async showMenu(): Promise<void> {
        const context = this.getContext() || {};
        if (!shouldShowDashboard({ isLsdyna: context.isLsdyna, level: context.level })) {
            return;
        }

        const picked = await this.showQuickPick(buildDashboardItems(context), {
            placeHolder: resolveDashboardLabels(context.labels || {}).placeHolder,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked || !picked.id) return;

        const action = this.actions[picked.id];
        if (typeof action === 'function') {
            await action();
        }
    }

    dispose(): void {
        if (this.timer) {
            this.cancel(this.timer);
            this.timer = null;
        }
        if (this.statusBarItem && typeof this.statusBarItem.dispose === 'function') {
            this.statusBarItem.dispose();
        }
    }
}

module.exports = {
    DEFAULT_COMMAND_ID,
    DEFAULT_DASHBOARD_LABELS,
    LsdynaStatusBarDashboard,
    buildDashboardItems,
    formatDashboardText,
    formatDashboardTooltip,
    normalizeStatusBarLevel,
    shouldShowDashboard,
};

export {};
