import * as path from 'node:path';

/** Distinguish files using cached results only, before pagination. */
export function displayPathLabels(paths: readonly string[]): Map<string, string> {
    const files = new Map<string, { full: string; parts: string[] }>();
    const identity = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    for (const filePath of paths) {
        const full = path.normalize(filePath).replace(/\\/g, '/');
        const key = identity(full);
        if (!files.has(key)) files.set(key, { full, parts: full.split('/').filter(Boolean) });
    }
    const suffixCounts = new Map<string, number>();
    for (const { parts } of files.values()) {
        for (let depth = 1; depth <= parts.length; depth++) {
            const suffix = identity(parts.slice(-depth).join('/'));
            suffixCounts.set(suffix, (suffixCounts.get(suffix) || 0) + 1);
        }
    }
    const names = new Map<string, string>();
    for (const [key, { full, parts }] of files) {
        let label = full;
        for (let depth = 1; depth <= parts.length; depth++) {
            const suffix = parts.slice(-depth).join('/');
            if (suffixCounts.get(identity(suffix)) === 1) { label = suffix; break; }
        }
        names.set(key, label);
    }
    return new Map(paths.map(filePath => [filePath,
        names.get(identity(path.normalize(filePath).replace(/\\/g, '/')))!]));
}
