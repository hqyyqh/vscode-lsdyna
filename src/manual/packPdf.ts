'use strict';

/**
 * Resolve pack PDF files without guessing versioned basenames.
 *
 * Prefer `documents[].pdfFile` (pack-root relative). Fall back to the legacy
 * `pdf/{title}.pdf` convention so older packs keep working.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PackDocumentPdfRef {
    slug?: string;
    title?: string;
    pdfFile?: string;
}

export interface PackPdfManifest {
    documents?: PackDocumentPdfRef[];
}

function isInside(root: string, candidate: string): boolean {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve one document's PDF to an absolute path, or null if missing.
 */
export function resolveDocumentPdfPath(
    packRoot: string,
    document: PackDocumentPdfRef | null | undefined,
    fsImpl: typeof fs = fs,
    pathImpl: typeof path = path
): string | null {
    if (!document || !packRoot) return null;

    const tryPath = (relativeOrAbsolute: string): string | null => {
        const absolute = pathImpl.isAbsolute(relativeOrAbsolute)
            ? pathImpl.resolve(relativeOrAbsolute)
            : pathImpl.resolve(packRoot, relativeOrAbsolute);
        if (!isInside(packRoot, absolute)) return null;
        return fsImpl.existsSync(absolute) ? absolute : null;
    };

    if (typeof document.pdfFile === 'string' && document.pdfFile.trim()) {
        const raw = document.pdfFile.trim().replace(/\\/g, '/');
        const hit = tryPath(raw) || tryPath(pathImpl.join('pdf', pathImpl.basename(raw)));
        if (hit) return hit;
    }

    if (typeof document.title === 'string' && document.title.trim()) {
        const legacy = tryPath(pathImpl.join('pdf', `${document.title.trim()}.pdf`));
        if (legacy) return legacy;
    }

    return null;
}

/**
 * Absolute paths for every document that resolves to an on-disk PDF (deduped).
 */
export function listDeclaredPdfPaths(
    packRoot: string,
    documents: PackDocumentPdfRef[] | null | undefined,
    fsImpl: typeof fs = fs,
    pathImpl: typeof path = path
): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const document of documents || []) {
        const resolved = resolveDocumentPdfPath(packRoot, document, fsImpl, pathImpl);
        if (!resolved) continue;
        const key = pathImpl.resolve(resolved);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

function scanPdfDirectory(
    dir: string,
    out: string[],
    seen: Set<string>,
    fsImpl: typeof fs,
    pathImpl: typeof path
): void {
    let entries: string[] = [];
    try {
        entries = fsImpl.readdirSync(dir);
    } catch {
        return;
    }
    for (const entry of entries) {
        if (typeof entry !== 'string' || !entry.toLowerCase().endsWith('.pdf')) continue;
        const full = pathImpl.resolve(dir, entry);
        if (seen.has(full)) continue;
        // Trust readdir entries; avoid a second existsSync so lightweight fs
        // mocks (health tests) and race-free scans stay a single readdir.
        seen.add(full);
        out.push(full);
    }
}

/**
 * Discover PDFs under a manuals directory.
 *
 * - With a readable pack `manifest.json` and at least one resolvable document PDF:
 *   return only those declared files.
 * - Otherwise: scan the directory root and a nested `pdf/` folder (legacy / hand-assembled).
 */
export function discoverManualPdfFiles(
    manualsDir: string,
    fsImpl: typeof fs = fs,
    pathImpl: typeof path = path
): string[] {
    const root = pathImpl.resolve(manualsDir);
    const manifestFile = pathImpl.join(root, 'manifest.json');
    if (fsImpl.existsSync(manifestFile)) {
        try {
            const manifest = JSON.parse(fsImpl.readFileSync(manifestFile, 'utf-8')) as PackPdfManifest;
            const declared = listDeclaredPdfPaths(root, manifest.documents, fsImpl, pathImpl);
            if (declared.length > 0) return declared;
        } catch {
            // Fall through to full scan when manifest is unreadable.
        }
    }

    const out: string[] = [];
    const seen = new Set<string>();
    scanPdfDirectory(root, out, seen, fsImpl, pathImpl);
    const pdfSubdir = pathImpl.join(root, 'pdf');
    if (fsImpl.existsSync(pdfSubdir)) {
        scanPdfDirectory(pdfSubdir, out, seen, fsImpl, pathImpl);
    }
    return out;
}
