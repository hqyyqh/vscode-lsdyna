const path = require('path');
const vscode = require('vscode');

function normalizePathKey(filePath: string): string {
    const normalized = path.normalize(filePath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function createProjectDiagnosticStore(collection: any) {
    if (!collection || typeof collection.set !== 'function' || typeof collection.delete !== 'function') {
        throw new TypeError('createProjectDiagnosticStore requires a diagnostic collection');
    }

    const projects = new Map<string, Map<string, { filePath: string; diagnostics: any[] }>>();

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
            for (const projectDiagnostics of projects.values()) {
                const contribution = projectDiagnostics.get(uriKey);
                if (!contribution) continue;
                filePath ||= contribution.filePath;
                merged.push(...contribution.diagnostics);
            }
            const uri = vscode.Uri.file(filePath || fallbackPaths.get(uriKey) || uriKey);
            if (merged.length > 0) collection.set(uri, merged);
            else collection.delete(uri);
        }
    }

    function publish(rootFile: string, diagnosticsByUri: Map<any, any[]>): void {
        const rootKey = normalizePathKey(rootFile);
        const previous = projects.get(rootKey) || new Map();
        const next = normalizeDiagnostics(diagnosticsByUri);
        projects.set(rootKey, next);
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
        republish(new Set(previous.keys()), new Map([...previous].map(([key, value]) => [key, value.filePath])));
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
        republish(uriKeys, fallbackPaths);
    }

    return { publish, clear, dispose };
}
