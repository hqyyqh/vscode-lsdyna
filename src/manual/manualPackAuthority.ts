import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const AUTHORITY_INDEX_PATH = 'indexes/pdf-authority.json';
const AUTHORITY_INDEX_SCHEMA = 'lsdyna.pdf.authority-index.v1';
const MAXIMUM_METADATA_BYTES = 2 * 1024 * 1024;
const MAXIMUM_DOCUMENTS = 32;

export type ManualPackAuthorityDocument = {
    manualId: string;
    title: string;
    sourceDocumentId: string;
    revision: string;
    pages: number;
    artifactSha256: string;
    artifactBytes: number;
    pdfFile: string;
};

export type ManualPackAuthoritySnapshot = {
    packRoot: string;
    flavor: string;
    displayName: string;
    sourceProfileId: string;
    indexSha256: string;
    documents: ManualPackAuthorityDocument[];
};

export type ManualPackAuthorityLoadResult =
    | { status: 'ready'; snapshot: ManualPackAuthoritySnapshot }
    | {
        status:
            | 'manual-pack-unavailable'
            | 'manual-pack-authority-unavailable'
            | 'manual-pack-authority-invalid';
      };

function sha256(bytes: Buffer): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validSha256(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function normalizedRelative(value: unknown): string {
    const raw = String(value || '').trim().replace(/\\/g, '/');
    let normalized = raw;
    while (normalized.startsWith('./')) normalized = normalized.slice(2);
    return normalized;
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function safePackPath(packRoot: string, relative: unknown, expectedExtension: string): string | null {
    const normalized = normalizedRelative(relative);
    if (!normalized || path.isAbsolute(normalized) ||
        !normalized.toLowerCase().endsWith(expectedExtension.toLowerCase())) {
        return null;
    }
    const candidate = path.resolve(packRoot, normalized);
    return isInside(packRoot, candidate) ? candidate : null;
}

function parseJson(bytes: Buffer): any | null {
    if (bytes.length <= 0 || bytes.length > MAXIMUM_METADATA_BYTES) return null;
    try {
        return JSON.parse(bytes.toString('utf8'));
    } catch {
        return null;
    }
}

function validateAuthority(
    packRoot: string,
    manifestBytes: Buffer,
    indexBytes: Buffer,
): ManualPackAuthoritySnapshot | null {
    const manifest = parseJson(manifestBytes);
    const index = parseJson(indexBytes);
    if (!manifest || !index ||
        manifest.schema !== 'lsdyna.manual.package.v2' || manifest.schemaVersion !== 2 ||
        index.schema !== AUTHORITY_INDEX_SCHEMA || index.schemaVersion !== 1 ||
        !validSha256(index.sourceProfileId) ||
        !Array.isArray(index.documents) || index.documents.length < 1 ||
        index.documents.length > MAXIMUM_DOCUMENTS) {
        return null;
    }
    const pointer = normalizedRelative(manifest?.indexes?.pdfAuthority);
    const descriptor = manifest?.pdfAuthority;
    if (pointer !== AUTHORITY_INDEX_PATH ||
        normalizedRelative(descriptor?.index) !== AUTHORITY_INDEX_PATH ||
        descriptor?.schemaVersion !== 1 ||
        descriptor.indexSha256 !== sha256(indexBytes) ||
        descriptor.sourceProfileId !== index.sourceProfileId ||
        (manifest.flavor && index.flavor !== manifest.flavor)) {
        return null;
    }

    const manifestDocuments = new Map<string, any>();
    for (const document of Array.isArray(manifest.documents) ? manifest.documents : []) {
        const manualId = String(document?.slug || '');
        if (!manualId || manifestDocuments.has(manualId)) return null;
        manifestDocuments.set(manualId, document);
    }

    const documents: ManualPackAuthorityDocument[] = [];
    const seen = new Set<string>();
    for (const source of index.documents) {
        const manualId = String(source?.manualId || '');
        const sourceDocumentId = String(source?.sourceDocumentId || '');
        const artifactSha256 = String(source?.artifactSha256 || '');
        const revision = String(source?.revision || '');
        const pdfFile = normalizedRelative(source?.pdfFile);
        const pages = Number(source?.pages);
        const artifactBytes = Number(source?.artifactBytes);
        const declared = manifestDocuments.get(manualId);
        if (!manualId || seen.has(manualId) || !declared ||
            !validSha256(sourceDocumentId) || !validSha256(artifactSha256) ||
            !Number.isSafeInteger(pages) || pages < 1 ||
            !Number.isSafeInteger(artifactBytes) || artifactBytes < 1 ||
            !/^master@[0-9a-f]+\s*\([^)]+\)$/i.test(revision) ||
            !safePackPath(packRoot, pdfFile, '.pdf') ||
            normalizedRelative(declared.pdfFile) !== pdfFile ||
            declared.pdfAuthoritySourceDocumentId !== sourceDocumentId) {
            return null;
        }
        seen.add(manualId);
        documents.push({
            manualId,
            title: String(declared.title || manualId),
            sourceDocumentId,
            revision,
            pages,
            artifactSha256,
            artifactBytes,
            pdfFile,
        });
    }
    const declaredPdfDocuments = [...manifestDocuments.values()]
        .filter(document => typeof document?.pdfFile === 'string' && document.pdfFile.trim());
    if (declaredPdfDocuments.length !== documents.length) return null;

    return {
        packRoot: path.resolve(packRoot),
        flavor: String(index.flavor || manifest.flavor || 'unknown'),
        displayName: String(manifest.displayName || ''),
        sourceProfileId: index.sourceProfileId,
        indexSha256: descriptor.indexSha256,
        documents,
    };
}

function classifyMissing(packRoot: string): ManualPackAuthorityLoadResult {
    return fs.existsSync(path.join(packRoot, 'manifest.json'))
        ? { status: 'manual-pack-authority-unavailable' }
        : { status: 'manual-pack-unavailable' };
}

function indexPathFromManifest(packRoot: string, manifestBytes: Buffer): string | null {
    const manifest = parseJson(manifestBytes);
    if (!manifest) return null;
    const pointer = normalizedRelative(manifest?.indexes?.pdfAuthority);
    if (pointer !== AUTHORITY_INDEX_PATH) return null;
    return safePackPath(packRoot, pointer, '.json');
}

function realPathInsideSync(packRoot: string, candidate: string): boolean {
    try {
        return isInside(fs.realpathSync(packRoot), fs.realpathSync(candidate));
    } catch {
        return false;
    }
}

/** Small, bounded synchronous read used only while the manual repository initializes. */
export function loadManualPackAuthoritySync(packRoot: string): ManualPackAuthorityLoadResult {
    const root = path.resolve(String(packRoot || ''));
    const manifestPath = path.join(root, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return { status: 'manual-pack-unavailable' };
    try {
        const manifestStat = fs.statSync(manifestPath);
        if (!manifestStat.isFile() || manifestStat.size > MAXIMUM_METADATA_BYTES) {
            return { status: 'manual-pack-authority-invalid' };
        }
        const manifestBytes = fs.readFileSync(manifestPath);
        const indexPath = indexPathFromManifest(root, manifestBytes);
        if (!indexPath || !fs.existsSync(indexPath)) return classifyMissing(root);
        const indexStat = fs.statSync(indexPath);
        if (!indexStat.isFile() || indexStat.size > MAXIMUM_METADATA_BYTES ||
            !realPathInsideSync(root, indexPath)) {
            return { status: 'manual-pack-authority-invalid' };
        }
        const snapshot = validateAuthority(root, manifestBytes, fs.readFileSync(indexPath));
        return snapshot
            ? { status: 'ready', snapshot }
            : { status: 'manual-pack-authority-invalid' };
    } catch {
        return { status: 'manual-pack-authority-invalid' };
    }
}

async function readBounded(filePath: string): Promise<Buffer | null> {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAXIMUM_METADATA_BYTES) return null;
    return fs.promises.readFile(filePath);
}

/** Explicit-click reload; never called from Hover, Completion, selection, or project scans. */
export async function loadManualPackAuthority(packRoot: string): Promise<ManualPackAuthorityLoadResult> {
    const root = path.resolve(String(packRoot || ''));
    const manifestPath = path.join(root, 'manifest.json');
    let manifestBytes: Buffer | null;
    try {
        manifestBytes = await readBounded(manifestPath);
    } catch {
        return { status: 'manual-pack-unavailable' };
    }
    if (!manifestBytes) return { status: 'manual-pack-authority-invalid' };
    const indexPath = indexPathFromManifest(root, manifestBytes);
    if (!indexPath) return { status: 'manual-pack-authority-unavailable' };
    try {
        const [realRoot, realIndex, indexBytes] = await Promise.all([
            fs.promises.realpath(root),
            fs.promises.realpath(indexPath),
            readBounded(indexPath),
        ]);
        if (!indexBytes || !isInside(realRoot, realIndex)) {
            return { status: 'manual-pack-authority-invalid' };
        }
        const snapshot = validateAuthority(root, manifestBytes, indexBytes);
        return snapshot
            ? { status: 'ready', snapshot }
            : { status: 'manual-pack-authority-invalid' };
    } catch {
        return fs.existsSync(indexPath)
            ? { status: 'manual-pack-authority-invalid' }
            : { status: 'manual-pack-authority-unavailable' };
    }
}

export function authorityDocument(
    snapshot: ManualPackAuthoritySnapshot | null | undefined,
    manualId: string,
): ManualPackAuthorityDocument | null {
    return snapshot?.documents.find(document => document.manualId === manualId) || null;
}

export const MANUAL_PACK_AUTHORITY_INDEX_PATH = AUTHORITY_INDEX_PATH;
export const MANUAL_PACK_AUTHORITY_MAXIMUM_BYTES = MAXIMUM_METADATA_BYTES;
