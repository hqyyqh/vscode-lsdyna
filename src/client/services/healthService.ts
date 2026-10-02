'use strict';

const fsDefault = require('fs');
const pathDefault = require('path');
const {
    resolveManualDirectoryCandidates,
    resolveManualsRoot,
    looksLikeManualPack,
} = require('../../manual/manualsDirResolve');

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

function inspectManualDirectories({
    fs,
    pathModule,
    candidates,
    resolvedDir,
}: {
    fs: any;
    pathModule: any;
    candidates: string[];
    resolvedDir?: string;
}) {
    // Prefer the shared root pick (exe-first + pack shape); fall back to first existing.
    const existingDirs = candidates.filter(dir => safeCall(() => fs.existsSync(dir), false));
    const preferred =
        (resolvedDir && existingDirs.includes(resolvedDir) && resolvedDir)
        || existingDirs.find(dir => looksLikeManualPack(dir, fs, pathModule))
        || existingDirs[0]
        || '';
    // Scan preferred root first so Sumatra/PDF counts match the active pack.
    const scanOrder = preferred
        ? [preferred, ...existingDirs.filter(d => d !== preferred)]
        : existingDirs;

    const pdfFiles: string[] = [];
    let sumatraPath = '';

    // Align with manualIndexer: when a pack manifest declares PDFs, count only
    // those. Otherwise one readdir of root + optional pdf/ (legacy layout).
    let discoverManualPdfFiles: ((dir: string, fsImpl?: any, pathImpl?: any) => string[]) | null = null;
    try {
        discoverManualPdfFiles = require('../../manual/packPdf').discoverManualPdfFiles;
    } catch {
        discoverManualPdfFiles = null;
    }

    // Single readdir collects both PDFs and Sumatra (matches prior readdir budget).
    const scanDir = (dir: string, collectPdfs: boolean) => {
        const entries = safeCall(() => fs.readdirSync(dir), []);
        for (const entry of entries) {
            if (typeof entry !== 'string') continue;
            const fullPath = pathModule.resolve(dir, entry);
            if (collectPdfs && entry.toLowerCase().endsWith('.pdf')) {
                if (!pdfFiles.includes(fullPath)) pdfFiles.push(fullPath);
            }
            if (entry.toLowerCase() === 'sumatrapdf.exe' && !sumatraPath) {
                sumatraPath = fullPath;
            }
        }
    };

    for (const dir of scanOrder) {
        const manifestFile = pathModule.join(dir, 'manifest.json');
        let declared: string[] = [];
        if (
            typeof discoverManualPdfFiles === 'function'
            && safeCall(() => fs.existsSync(manifestFile), false)
        ) {
            declared = safeCall(() => discoverManualPdfFiles!(dir, fs, pathModule), []) || [];
        }

        if (declared.length) {
            for (const fullPath of declared) {
                const resolved = pathModule.resolve(fullPath);
                if (!pdfFiles.includes(resolved)) pdfFiles.push(resolved);
            }
            // Viewer may still sit at root or under pdf/.
            scanDir(dir, false);
            const pdfSubdir = pathModule.join(dir, 'pdf');
            if (safeCall(() => fs.existsSync(pdfSubdir), false)) {
                scanDir(pdfSubdir, false);
            }
        } else {
            scanDir(dir, true);
            const pdfSubdir = pathModule.join(dir, 'pdf');
            if (safeCall(() => fs.existsSync(pdfSubdir), false)) {
                scanDir(pdfSubdir, true);
            }
        }
    }

    return {
        existingDirs,
        resolvedDir: preferred,
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
        const preferredRoot = resolveManualsRoot({
            manualsDir,
            workspaceFolders,
            cwd,
            execPath,
            appRoot,
            extensionPath,
            pathModule,
            fs,
        });
        const manualState = inspectManualDirectories({
            fs,
            pathModule,
            candidates: manualCandidates,
            resolvedDir: preferredRoot,
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
    resolveManualsRoot,
    shouldShowHealthNotice,
};

export {};
