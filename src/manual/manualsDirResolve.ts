'use strict';

/**
 * Shared resolution for `lsdyna.manualsDir`.
 *
 * Portable / zero-config contract:
 * - Default config value is the relative name `lsdyna_manual_pack`.
 * - Relative paths prefer the VS Code install root (`dirname(process.execPath)`),
 *   so a folder next to Code.exe wins over a same-named folder in the workspace.
 * - Absolute paths are used as-is.
 */

const pathDefault = require('path');
const fsDefault = require('fs');

export type ManualsDirResolveOptions = {
    manualsDir: string;
    workspaceFolders?: Array<{ uri?: { fsPath?: string } } | null | undefined>;
    cwd?: string | null;
    execPath?: string | null;
    appRoot?: string | null;
    extensionPath?: string | null;
    pathModule?: any;
    fs?: any;
};

function unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

/**
 * Whether a directory looks like a shipped manual pack (or a usable manuals root).
 * Minimal gate: indexes/ or manifest.json — avoids treating an empty same-name folder as the pack.
 */
function looksLikeManualPack(dir: string, fs: any = fsDefault, pathModule: any = pathDefault): boolean {
    if (!dir || typeof dir !== 'string') return false;
    try {
        if (fs.existsSync(pathModule.join(dir, 'indexes'))) return true;
        if (fs.existsSync(pathModule.join(dir, 'manifest.json'))) return true;
    } catch {
        return false;
    }
    return false;
}

/**
 * Ordered candidate roots for a configured manualsDir value.
 * Relative: Code.exe dir → appRoot parents → workspaces → cwd → extension.
 */
function resolveManualDirectoryCandidates({
    manualsDir,
    workspaceFolders = [],
    cwd,
    execPath,
    appRoot,
    extensionPath,
    pathModule = pathDefault,
}: ManualsDirResolveOptions): string[] {
    if (!manualsDir || typeof manualsDir !== 'string') return [];
    if (pathModule.isAbsolute(manualsDir)) return [manualsDir];

    const candidates: string[] = [];

    // 1) VS Code / portable install root (Code.exe directory) — highest priority
    if (execPath) {
        candidates.push(pathModule.resolve(pathModule.dirname(execPath), manualsDir));
    }

    // 2) appRoot is usually resources/app; install root is two levels up
    if (appRoot) {
        candidates.push(pathModule.resolve(appRoot, '../../', manualsDir));
        candidates.push(pathModule.resolve(appRoot, manualsDir));
    }

    // 3) Workspace folders (secondary; loses to exe when both exist)
    if (Array.isArray(workspaceFolders)) {
        for (const folder of workspaceFolders) {
            const root = folder && folder.uri && folder.uri.fsPath;
            if (root) candidates.push(pathModule.resolve(root, manualsDir));
        }
    }

    // 4) process cwd
    if (cwd) candidates.push(pathModule.resolve(cwd, manualsDir));

    // 5) Extension install path (last resort; full packs are not shipped in the vsix)
    if (extensionPath) candidates.push(pathModule.resolve(extensionPath, manualsDir));

    return unique(candidates);
}

/**
 * Pick the manuals root that should drive reader, indexer, Sumatra, and health.
 * Prefer the first candidate that exists and looks like a pack; else first existing;
 * else the first candidate (may not exist — caller handles missing).
 */
function resolveManualsRoot({
    manualsDir,
    workspaceFolders = [],
    cwd,
    execPath,
    appRoot,
    extensionPath,
    pathModule = pathDefault,
    fs = fsDefault,
}: ManualsDirResolveOptions): string {
    const candidates = resolveManualDirectoryCandidates({
        manualsDir,
        workspaceFolders,
        cwd,
        execPath,
        appRoot,
        extensionPath,
        pathModule,
    });
    if (candidates.length === 0) {
        return manualsDir && typeof manualsDir === 'string' ? manualsDir : '';
    }

    const existing = candidates.filter(dir => {
        try {
            return fs.existsSync(dir);
        } catch {
            return false;
        }
    });

    for (const dir of existing) {
        if (looksLikeManualPack(dir, fs, pathModule)) return dir;
    }
    if (existing.length > 0) return existing[0];
    return candidates[0];
}

module.exports = {
    looksLikeManualPack,
    resolveManualDirectoryCandidates,
    resolveManualsRoot,
};
