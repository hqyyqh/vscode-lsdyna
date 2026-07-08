'use strict';

const fsDefault = require('fs');
const pathDefault = require('path');

type HealthState = 'ready' | 'warning' | 'info';

type HealthItem = {
    id: string;
    state: HealthState;
    labelKey: string;
    descriptionKey: string;
    detailKey: string;
    actionId?: string;
    metadata?: any;
};

type HealthReport = {
    ready: boolean;
    issueCount: number;
    issueSignature: string;
    items: HealthItem[];
};

type HealthServiceOptions = {
    fs?: any;
    pathModule?: any;
    platform?: string;
    cwd?: string;
    execPath?: string;
    appRoot?: string | null;
    extensionPath?: string | null;
    getManualsDir?: () => string;
    getManualFilesCount?: () => number;
    getKeywordDatabaseReady?: () => boolean;
    getProjectToolsReady?: () => boolean;
};

type HealthReportInput = {
    isLsdyna?: boolean;
    document?: any;
    workspaceFolders?: any[];
};

function unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

function safeCall<T>(callback: () => T, fallback: T): T {
    try {
        return callback();
    } catch (_error) {
        return fallback;
    }
}

function getDocumentPath(document: any): string {
    return document && document.uri && typeof document.uri.fsPath === 'string'
        ? document.uri.fsPath
        : '';
}

function isDocumentInWorkspace(filePath: string, workspaceFolders: any[] = [], pathModule = pathDefault): boolean {
    if (!filePath || !Array.isArray(workspaceFolders) || workspaceFolders.length === 0) {
        return false;
    }
    return workspaceFolders.some(folder => {
        const root = folder && folder.uri && folder.uri.fsPath;
        if (!root) return false;
        const relative = pathModule.relative(root, filePath);
        return relative === '' || (!relative.startsWith('..') && !pathModule.isAbsolute(relative));
    });
}

function resolveManualDirectoryCandidates({
    manualsDir,
    workspaceFolders = [],
    cwd,
    execPath,
    appRoot,
    extensionPath,
    pathModule = pathDefault,
}: {
    manualsDir: string;
    workspaceFolders?: any[];
    cwd?: string;
    execPath?: string;
    appRoot?: string | null;
    extensionPath?: string | null;
    pathModule?: any;
}): string[] {
    if (!manualsDir || typeof manualsDir !== 'string') return [];
    if (pathModule.isAbsolute(manualsDir)) return [manualsDir];

    const candidates = [];
    if (Array.isArray(workspaceFolders)) {
        for (const folder of workspaceFolders) {
            const root = folder && folder.uri && folder.uri.fsPath;
            if (root) candidates.push(pathModule.resolve(root, manualsDir));
        }
    }
    if (cwd) candidates.push(pathModule.resolve(cwd, manualsDir));
    if (execPath) candidates.push(pathModule.resolve(pathModule.dirname(execPath), manualsDir));
    if (appRoot) {
        candidates.push(pathModule.resolve(appRoot, '../../', manualsDir));
        candidates.push(pathModule.resolve(appRoot, manualsDir));
    }
    if (extensionPath) candidates.push(pathModule.resolve(extensionPath, manualsDir));

    return unique(candidates);
}

function inspectManualDirectories({
    fs,
    pathModule,
    candidates,
}: {
    fs: any;
    pathModule: any;
    candidates: string[];
}) {
    const existingDirs = candidates.filter(dir => safeCall(() => fs.existsSync(dir), false));
    const pdfFiles = [];
    let sumatraPath = '';

    for (const dir of existingDirs) {
        const entries = safeCall(() => fs.readdirSync(dir), []);
        for (const entry of entries) {
            if (typeof entry !== 'string') continue;
            const fullPath = pathModule.resolve(dir, entry);
            if (entry.toLowerCase().endsWith('.pdf')) {
                pdfFiles.push(fullPath);
            }
            if (entry.toLowerCase() === 'sumatrapdf.exe') {
                sumatraPath = fullPath;
            }
        }
    }

    return {
        existingDirs,
        resolvedDir: existingDirs[0] || '',
        pdfFiles,
        pdfCount: pdfFiles.length,
        sumatraPath,
    };
}

function item(
    id: string,
    state: HealthState,
    actionId: string | undefined = undefined,
    metadata: any = {}
): HealthItem {
    return {
        id,
        state,
        labelKey: `health_${id}_label`,
        descriptionKey: `health_${id}_${state}_description`,
        detailKey: `health_${id}_${state}_detail`,
        actionId,
        metadata,
    };
}

function createIssueSignature(items: HealthItem[]): string {
    return items
        .filter(entry => entry.state === 'warning')
        .map(entry => entry.id)
        .sort()
        .join('|');
}

function shouldShowHealthNotice({
    showFirstRunNotice = true,
    isLsdyna = false,
    report,
    lastPromptedIssueSignature = '',
}: {
    showFirstRunNotice?: boolean;
    isLsdyna?: boolean;
    report?: Partial<HealthReport>;
    lastPromptedIssueSignature?: string;
} = {}): boolean {
    if (!showFirstRunNotice || !isLsdyna || !report) return false;
    if (!report.issueCount || report.issueCount <= 0) return false;
    return String(report.issueSignature || '') !== String(lastPromptedIssueSignature || '');
}

function createHealthService({
    fs = fsDefault,
    pathModule = pathDefault,
    platform = process.platform,
    cwd = process.cwd(),
    execPath = process.execPath,
    appRoot = null,
    extensionPath = null,
    getManualsDir = () => 'lsdyna_manual_pack',
    getManualFilesCount = () => 0,
    getKeywordDatabaseReady = () => true,
    getProjectToolsReady = () => true,
}: HealthServiceOptions = {}) {
    let cachedKey = '';
    let cachedReport: HealthReport | null = null;

    function buildCacheKey(input: HealthReportInput = {}): string {
        const workspaceRoots = (input.workspaceFolders || [])
            .map(folder => folder && folder.uri && folder.uri.fsPath)
            .filter(Boolean)
            .join(';');
        return JSON.stringify({
            isLsdyna: Boolean(input.isLsdyna),
            languageId: input.document && input.document.languageId,
            filePath: getDocumentPath(input.document),
            workspaceRoots,
            manualsDir: safeCall(getManualsDir, 'lsdyna_manual_pack'),
            manualFilesCount: safeCall(getManualFilesCount, 0),
            keywordDatabaseReady: safeCall(getKeywordDatabaseReady, false),
            projectToolsReady: safeCall(getProjectToolsReady, false),
            platform,
        });
    }

    function getReport(input: HealthReportInput = {}): HealthReport {
        const cacheKey = buildCacheKey(input);
        if (cachedReport && cachedKey === cacheKey) {
            return cachedReport;
        }

        const document = input.document || null;
        const workspaceFolders = input.workspaceFolders || [];
        const filePath = getDocumentPath(document);
        const isLsdyna = Boolean(input.isLsdyna || (document && document.languageId === 'lsdyna'));
        const manualsDir = safeCall(getManualsDir, 'lsdyna_manual_pack') || 'lsdyna_manual_pack';
        const manualFilesCount = safeCall(getManualFilesCount, 0);
        const keywordDatabaseReady = safeCall(getKeywordDatabaseReady, false);
        const projectToolsReady = safeCall(getProjectToolsReady, false);
        const manualCandidates = resolveManualDirectoryCandidates({
            manualsDir,
            workspaceFolders,
            cwd,
            execPath,
            appRoot,
            extensionPath,
            pathModule,
        });
        const manualState = inspectManualDirectories({
            fs,
            pathModule,
            candidates: manualCandidates,
        });
        const workspaceReady = isDocumentInWorkspace(filePath, workspaceFolders, pathModule);
        const needsSumatra = platform === 'win32';

        const items: HealthItem[] = [
            item('language', isLsdyna ? 'ready' : 'warning', undefined, {
                languageId: document && document.languageId,
            }),
            item('workspace', workspaceReady ? 'ready' : 'info', undefined, {
                filePath,
                workspaceRoot: workspaceFolders[0] && workspaceFolders[0].uri && workspaceFolders[0].uri.fsPath,
            }),
            item('manualsDir', manualState.resolvedDir ? 'ready' : 'warning', 'configureManuals', {
                manualsDir,
                candidates: manualCandidates,
                resolvedDir: manualState.resolvedDir,
            }),
            item('pdfFiles', manualState.pdfCount > 0 ? 'ready' : 'warning', 'configureManuals', {
                pdfCount: manualState.pdfCount,
                resolvedDir: manualState.resolvedDir,
            }),
            item('manualIndex', manualFilesCount > 0 ? 'ready' : 'warning', 'configureManuals', {
                indexedPdfCount: manualFilesCount,
            }),
            item('sumatra', !needsSumatra || manualState.sumatraPath ? 'ready' : 'warning', 'configureManuals', {
                platform,
                sumatraPath: manualState.sumatraPath,
                required: needsSumatra,
            }),
            item('keywordDatabase', keywordDatabaseReady ? 'ready' : 'warning', 'showOutput', {
                ready: keywordDatabaseReady,
            }),
            item('projectTools', projectToolsReady ? 'ready' : 'warning', 'showOutput', {
                ready: projectToolsReady,
            }),
        ];
        const issueCount = items.filter(entry => entry.state === 'warning').length;
        const report = {
            ready: issueCount === 0,
            issueCount,
            issueSignature: createIssueSignature(items),
            items,
        };

        cachedKey = cacheKey;
        cachedReport = report;
        return report;
    }

    function invalidate(): void {
        cachedKey = '';
        cachedReport = null;
    }

    return {
        getReport,
        invalidate,
    };
}

module.exports = {
    createHealthService,
    resolveManualDirectoryCandidates,
    shouldShowHealthNotice,
};

export {};
