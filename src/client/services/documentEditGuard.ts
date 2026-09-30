import * as fs from 'fs';

function documentIdentity(document): string {
    const uri = document?.uri;
    return uri?.toString && uri.toString !== Object.prototype.toString
        ? uri.toString()
        : `${uri?.scheme || ''}:${uri?.fsPath || ''}`;
}

/** Capture before planning or awaiting UI, then check again immediately before apply. */
export function createDocumentEditGuard(document, editor = undefined): () => boolean {
    const version = document?.version;
    const identity = documentIdentity(document);
    return () => !!document && !document.isClosed && document.version === version &&
        documentIdentity(document) === identity && (!editor || editor.document === document);
}

export function matchesConfiguredReadonlyPattern(document, settingName, vscode) {
    if (!document || !document.uri || !vscode.languages || typeof vscode.languages.match !== 'function') {
        return false;
    }
    const patterns = vscode.workspace
        .getConfiguration('files', document.uri)
        .get(settingName, {});
    if (!patterns || typeof patterns !== 'object' || Array.isArray(patterns)) return false;

    for (const [pattern, enabled] of Object.entries(patterns)) {
        if (!enabled || typeof pattern !== 'string' || pattern.length === 0) continue;
        try {
            const filter = { scheme: document.uri.scheme, pattern };
            if (vscode.languages.match(filter, document) > 0) return true;
        } catch (_) {
            // An invalid user glob must not crash selection or editor switching.
        }
    }
    return false;
}

export async function isDocumentReadonlyForAutomaticEdit(document, vscode) {
    const isCurrent = createDocumentEditGuard(document);
    if (!isCurrent()) return true;
    const included = matchesConfiguredReadonlyPattern(document, 'readonlyInclude', vscode);
    const excluded = included && matchesConfiguredReadonlyPattern(document, 'readonlyExclude', vscode);
    if (included && !excluded) return true;

    const scheme = document?.uri?.scheme;
    if (scheme === 'untitled') return !isCurrent();
    if (scheme && vscode.workspace.fs?.isWritableFileSystem?.(scheme) === false) return true;
    if (
        document?.uri &&
        vscode.workspace.fs &&
        typeof vscode.workspace.fs.stat === 'function'
    ) {
        try {
            const stat = await vscode.workspace.fs.stat(document.uri);
            const readonlyFlag = vscode.FilePermission && vscode.FilePermission.Readonly;
            if (readonlyFlag && (Number(stat.permissions || 0) & readonlyFlag) !== 0) return true;
        } catch (_) {
            // A missing or concurrently removed file is not a safe automatic edit target.
            return true;
        }

    }

    // Probe the OS independently of readonlyFromPermissions and the provider's
    // optional permissions flag. Opening r+ never truncates or writes the file.
    if (scheme === 'file') {
        if (!document.uri.fsPath) return true;
        let handle = null;
        try {
            handle = await fs.promises.open(document.uri.fsPath, 'r+');
            await handle.close();
            handle = null;
        } catch (_) {
            if (handle) {
                try {
                    await handle.close();
                } catch (_) {
                    // The permission probe already failed; keep the edit blocked.
                }
            }
            return true;
        }
    }
    return !isCurrent();
}
