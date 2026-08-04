const path = require('path');
const vscode = require('vscode');

function normalizePathKey(filePath: string): string {
    const normalized = path.normalize(filePath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function createProjectDiagnosticStore(
    collection: any,
    {
        resolveRootForFile = null,
    }: {
        resolveRootForFile?: ((filePath: string, rootFiles: string[]) => string | null | undefined) | null,
    } = {}
) {
    if (!collection || typeof collection.set !== 'function' || typeof collection.delete !== 'function') {
        throw new TypeError('createProjectDiagnosticStore requires a diagnostic collection');
    }

    const projects = new Map<string, Map<string, { filePath: string; diagnostics: any[] }>>();
    const projectRootFiles = new Map<string, string>();

    function normalizeDiagnostics(diagnosticsByUri: Map<any, any[]>): Map<string, { filePath: string; diagnostics: any[] }> {
        const result = new Map();
        for (const [uriOrPath, diagnostics] of diagnosticsByUri || []) {
            const filePath = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath?.fsPath;
            if (!filePath) continue;
            result.set(normalizePathKey(filePath), {
                filePath,
                diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
            });
        }
        return result;
    }

    function republish(uriKeys: Set<string>, fallbackPaths = new Map<string, string>()): void {
        for (const uriKey of uriKeys) {
            const merged = [];
            let filePath = null;
            const contributions = [];
            for (const [rootKey, projectDiagnostics] of projects) {
                const contribution = projectDiagnostics.get(uriKey);
                if (!contribution) continue;
                filePath ||= contribution.filePath;
                contributions.push({ rootKey, contribution });
            }
            const resolvedFilePath = filePath || fallbackPaths.get(uriKey) || uriKey;
            const selectedRoot = typeof resolveRootForFile === 'function'
                ? resolveRootForFile(
                    resolvedFilePath,
                    contributions.map(({ rootKey }) => projectRootFiles.get(rootKey) || rootKey)
                )
                : undefined;
            const selectedRootKey = typeof selectedRoot === 'string'
                ? normalizePathKey(selectedRoot)
                : null;
            for (const { rootKey, contribution } of contributions) {
                if (selectedRoot === null) continue;
                if (selectedRootKey && rootKey !== selectedRootKey) continue;
                merged.push(...contribution.diagnostics);
            }
            const uri = vscode.Uri.file(resolvedFilePath);
            if (merged.length > 0) collection.set(uri, merged);
            else collection.delete(uri);
        }
    }

    function publish(rootFile: string, diagnosticsByUri: Map<any, any[]>): void {
        const rootKey = normalizePathKey(rootFile);
        const previous = projects.get(rootKey) || new Map();
        const next = normalizeDiagnostics(diagnosticsByUri);
        projects.set(rootKey, next);
        projectRootFiles.set(rootKey, rootFile);
        const fallbackPaths = new Map();
        for (const [key, value] of previous) fallbackPaths.set(key, value.filePath);
        for (const [key, value] of next) fallbackPaths.set(key, value.filePath);
        republish(new Set([...previous.keys(), ...next.keys()]), fallbackPaths);
    }

    function clear(rootFile: string): void {
        const rootKey = normalizePathKey(rootFile);
        const previous = projects.get(rootKey);
        if (!previous) return;
        projects.delete(rootKey);
        projectRootFiles.delete(rootKey);
        republish(new Set(previous.keys()), new Map([...previous].map(([key, value]) => [key, value.filePath])));
    }

    function refresh(filePath: string | null = null): void {
        if (filePath) {
            const uriKey = normalizePathKey(filePath);
            republish(new Set([uriKey]), new Map([[uriKey, filePath]]));
            return;
        }
        const uriKeys = new Set<string>();
        const fallbackPaths = new Map<string, string>();
        for (const projectDiagnostics of projects.values()) {
            for (const [uriKey, value] of projectDiagnostics) {
                uriKeys.add(uriKey);
                fallbackPaths.set(uriKey, value.filePath);
            }
        }
        republish(uriKeys, fallbackPaths);
    }

    function dispose(): void {
        const uriKeys = new Set<string>();
        const fallbackPaths = new Map<string, string>();
        for (const projectDiagnostics of projects.values()) {
            for (const [uriKey, value] of projectDiagnostics) {
                uriKeys.add(uriKey);
                fallbackPaths.set(uriKey, value.filePath);
            }
        }
        projects.clear();
        projectRootFiles.clear();
        republish(uriKeys, fallbackPaths);
    }

    return { publish, clear, refresh, dispose };
}
