'use strict';

const vscode = require('vscode');

type StatusBarLevel = 'off' | 'simple' | 'detail';

type DashboardContext = {
    isLsdyna?: boolean;
    level?: StatusBarLevel | string;
    keyword?: string;
    fieldIndex?: number | null;
    fieldCount?: number | null;
    manualReady?: boolean;
    warningCount?: number;
    healthIssueCount?: number;
    tabNavigationEnabled?: boolean;
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
    copyDiagnostics?: () => Promise<void> | void;
    toggleTabNavigation?: () => Promise<void> | void;
};

const DEFAULT_COMMAND_ID = 'extension.lsdynaStatusDashboard';

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
    copyDiagnosticsLabel: string;
    diagnosticsSingularDescription: string;
    diagnosticsPluralDescription: string;
    copyDiagnosticsDetail: string;
    toggleTabNavigationLabel: string;
    tabNavigationOnDescription: string;
    tabNavigationOffDescription: string;
    toggleTabNavigationDetail: string;
};

const DEFAULT_DASHBOARD_LABELS: DashboardLabels = {
    dashboardTooltip: 'DynaSense project dashboard',
    placeHolder: 'DynaSense actions for the current LS-DYNA file',
    showHealthLabel: '$(checklist) Environment Status',
    healthReadyDescription: 'Ready',
    healthIssuesDescription: '{0} setup items',
    showHealthDetail: 'Check manuals, PDF index, SumatraPDF, language mode, and project tools.',
    scanIncludesLabel: '$(references) Scan Include Tree',
    scanIncludesDescription: 'Project includes',
    scanIncludesDetail: 'Build the include hierarchy for the current LS-DYNA root file.',
    scanKeywordIndexLabel: '$(list-tree) Scan Keyword Index',
    scanKeywordIndexDescription: 'Project keywords',
    scanKeywordIndexDetail: 'Index keywords in the current file and its includes.',
    configureManualsLabel: '$(book) Configure Manuals',
    manualReadyDescription: 'Manual OK',
    manualSetupDescription: 'Manual setup required',
    configureManualsDetail: 'Select the LS-DYNA PDF manual folder used by hover links.',
    showOutputLabel: '$(output) Open Log',
    showOutputDescription: 'DynaSense output',
    showOutputDetail: 'Open the extension output channel for recent scan and indexing messages.',
    copyDiagnosticsLabel: '$(copy) Copy Diagnostics',
    diagnosticsSingularDescription: '1 warning',
    diagnosticsPluralDescription: '{0} warnings',
    copyDiagnosticsDetail: 'Copy active-file diagnostics and DynaSense context to the clipboard.',
    toggleTabNavigationLabel: '$(keyboard) Toggle Tab Navigation',
    tabNavigationOnDescription: 'On',
    tabNavigationOffDescription: 'Off',
    toggleTabNavigationDetail: 'Switch fixed-width LS-DYNA field navigation for the Tab key.',
};

function resolveDashboardLabels(overrides: Partial<DashboardLabels> = {}): DashboardLabels {
    return { ...DEFAULT_DASHBOARD_LABELS, ...overrides };
}

function formatLabelTemplate(template: string, value: number): string {
    return String(template || '').replace('{0}', String(value));
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

function formatDashboardText(context: DashboardContext = {}): string {
    const level = normalizeStatusBarLevel(context.level);
    if (level === 'off') return '';

    const warningCount = Math.max(0, Number(context.warningCount || 0));
    if (warningCount > 0) {
        return warningCount === 1
            ? 'DynaSense: 1 warning'
            : `DynaSense: ${warningCount} warnings`;
    }
    const healthIssueCount = Math.max(0, Number(context.healthIssueCount || 0));
    if (healthIssueCount > 0) {
        return healthIssueCount === 1
            ? 'DynaSense: 1 setup item'
            : `DynaSense: ${healthIssueCount} setup items`;
    }

    const keyword = normalizeKeyword(context.keyword);
    if (level === 'simple') {
        return keyword ? `DynaSense: ${keyword}` : 'DynaSense';
    }

    const parts = [];
    if (keyword) parts.push(keyword);
    if (
        Number.isFinite(context.fieldIndex)
        && Number.isFinite(context.fieldCount)
        && Number(context.fieldIndex) > 0
        && Number(context.fieldCount) > 0
    ) {
        parts.push(`F${context.fieldIndex}/${context.fieldCount}`);
    }
    parts.push(context.manualReady ? 'Manual OK' : 'Manual setup');

    return parts.length > 0
        ? `DynaSense: ${parts.join(' · ')}`
        : 'DynaSense';
}

function buildDashboardItems(context: DashboardContext = {}): DashboardItem[] {
    const warningCount = Math.max(0, Number(context.warningCount || 0));
    const healthIssueCount = Math.max(0, Number(context.healthIssueCount ?? context.warningCount ?? 0));
    const tabNavigationEnabled = context.tabNavigationEnabled !== false;
    const manualReady = Boolean(context.manualReady);
    const labels = resolveDashboardLabels(context.labels || {});
    const diagnosticsDescription = warningCount === 1
        ? labels.diagnosticsSingularDescription
        : formatLabelTemplate(labels.diagnosticsPluralDescription, warningCount);

    return [
        {
            id: 'showHealth',
            label: labels.showHealthLabel,
            description: healthIssueCount > 0
                ? formatLabelTemplate(labels.healthIssuesDescription, healthIssueCount)
                : labels.healthReadyDescription,
            detail: labels.showHealthDetail,
        },
        {
            id: 'scanIncludes',
            label: labels.scanIncludesLabel,
            description: labels.scanIncludesDescription,
            detail: labels.scanIncludesDetail,
        },
        {
            id: 'scanKeywordIndex',
            label: labels.scanKeywordIndexLabel,
            description: labels.scanKeywordIndexDescription,
            detail: labels.scanKeywordIndexDetail,
        },
        {
            id: 'configureManuals',
            label: labels.configureManualsLabel,
            description: manualReady ? labels.manualReadyDescription : labels.manualSetupDescription,
            detail: labels.configureManualsDetail,
        },
        {
            id: 'showOutput',
            label: labels.showOutputLabel,
            description: labels.showOutputDescription,
            detail: labels.showOutputDetail,
        },
        {
            id: 'copyDiagnostics',
            label: labels.copyDiagnosticsLabel,
            description: diagnosticsDescription,
            detail: labels.copyDiagnosticsDetail,
        },
        {
            id: 'toggleTabNavigation',
            label: labels.toggleTabNavigationLabel,
            description: tabNavigationEnabled ? labels.tabNavigationOnDescription : labels.tabNavigationOffDescription,
            detail: labels.toggleTabNavigationDetail,
        },
    ];
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
        this.statusBarItem.tooltip = resolveDashboardLabels(context.labels || {}).dashboardTooltip;
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
    normalizeStatusBarLevel,
    shouldShowDashboard,
};

export {};
