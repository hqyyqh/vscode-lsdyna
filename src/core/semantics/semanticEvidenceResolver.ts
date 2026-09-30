import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    normalizeSemanticKeyword,
} from './manualSemanticCatalog';
import {
    authorityDocument,
    loadManualPackAuthority,
    type ManualPackAuthorityDocument,
} from '../../manual/manualPackAuthority';

type SemanticCatalog = {
    rulesForKeyword(keyword: string): any[];
    summary(): any;
};

export type SemanticEvidenceRequest = {
    keyword: string;
    ruleId: string;
    evidenceId: string;
};

export type SemanticEvidenceResolution =
    | {
        status: 'resolved';
        pdfPath: string;
        page: number;
        manualId: string;
        title: string;
        sourceProfileId?: string;
        revision?: string;
        flavor?: string;
    }
    | {
        status:
            | 'invalid-request'
            | 'source-lock-unavailable'
            | 'manual-pack-unavailable'
            | 'manual-pack-authority-unavailable'
            | 'manual-pack-authority-invalid'
            | 'manual-pack-profile-unavailable'
            | 'manual-pack-evidence-unavailable'
            | 'manual-document-unavailable'
            | 'pdf-unavailable'
            | 'pdf-integrity-mismatch'
            | 'page-out-of-range';
    };

function sha256(bytes: Buffer): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validHash(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function findPublishedEvidence(catalog: SemanticCatalog, request: SemanticEvidenceRequest): any | null {
    const keyword = normalizeSemanticKeyword(request?.keyword);
    const ruleId = String(request?.ruleId || '');
    const evidenceId = String(request?.evidenceId || '');
    if (!keyword || !ruleId || !evidenceId) return null;
    const rule = catalog.rulesForKeyword(keyword).find(item => item?.ruleId === ruleId);
    return (Array.isArray(rule?.evidence) ? rule.evidence : [])
        .find((item: any) => item?.evidenceId === evidenceId) || null;
}

function evidenceLocations(evidence: any, defaultSourceProfileId: string): any[] {
    const candidates = Array.isArray(evidence?.locations) && evidence.locations.length > 0
        ? evidence.locations
        : [evidence];
    return candidates.map((item: any) => ({
        manualId: String(item?.manualId || evidence?.manualId || ''),
        page: Number(item?.page ?? evidence?.page),
        sourceProfileId: String(
            item?.sourceProfileId || evidence?.sourceProfileId || defaultSourceProfileId || '',
        ),
    }));
}

function authorityProfiles(evidenceAuthority: any): any[] {
    if (Array.isArray(evidenceAuthority?.profiles)) {
        return evidenceAuthority.profiles.filter((profile: any) =>
            validHash(profile?.sourceProfileId) && validHash(profile?.indexSha256) &&
            Array.isArray(profile?.documents));
    }
    return validHash(evidenceAuthority?.sourceProfileId) &&
        validHash(evidenceAuthority?.indexSha256) &&
        Array.isArray(evidenceAuthority?.documents)
        ? [evidenceAuthority]
        : [];
}

function defaultSourceProfileId(evidenceAuthority: any): string {
    const value = String(
        evidenceAuthority?.defaultSourceProfileId || evidenceAuthority?.sourceProfileId || '',
    );
    return validHash(value) ? value : '';
}

function lockedAuthorityDocument(profile: any, manualId: string): any | null {
    return (Array.isArray(profile?.documents) ? profile.documents : [])
        .find((document: any) => document?.manualId === manualId) || null;
}

function authorityDocumentMatches(
    current: ManualPackAuthorityDocument,
    locked: any,
): boolean {
    return Boolean(locked) &&
        current.sourceDocumentId === locked.sourceDocumentId &&
        current.artifactSha256 === locked.artifactSha256 &&
        current.artifactBytes === locked.artifactBytes &&
        current.pages === locked.pages &&
        current.revision === locked.revision &&
        current.pdfFile === locked.pdfFile;
}

/** Explicit-click resolver; never runs from hover construction or document scanning. */
export class SemanticEvidenceResolver {
    private readonly hashCache = new Map<string, {
        fingerprint: string;
        promise: Promise<string>;
    }>();

    private async fileSha256(filePath: string, size: number, mtimeMs: number): Promise<string> {
        const fingerprint = `${size}:${mtimeMs}`;
        const cached = this.hashCache.get(filePath);
        if (cached?.fingerprint === fingerprint) return cached.promise;
        const promise = new Promise<string>((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('error', reject);
            stream.on('end', () => resolve(hash.digest('hex')));
        });
        this.hashCache.delete(filePath);
        this.hashCache.set(filePath, { fingerprint, promise });
        while (this.hashCache.size > 8) {
            const oldest = this.hashCache.keys().next().value;
            if (oldest === undefined) break;
            this.hashCache.delete(oldest);
        }
        try {
            return await promise;
        } catch (error) {
            if (this.hashCache.get(filePath)?.promise === promise) this.hashCache.delete(filePath);
            throw error;
        }
    }

    async resolve(
        request: SemanticEvidenceRequest,
        catalog: SemanticCatalog,
        manualPackRoot: string,
    ): Promise<SemanticEvidenceResolution> {
        let evidence: any;
        let summary: any;
        try {
            evidence = findPublishedEvidence(catalog, request);
            summary = catalog.summary();
        } catch (_error) {
            return { status: 'invalid-request' };
        }
        if (!evidence) return { status: 'invalid-request' };
        const evidenceAuthority = summary?.evidenceAuthority;
        if (authorityProfiles(evidenceAuthority).length > 0) {
            return this.resolvePackScoped(
                evidence,
                evidenceAuthority,
                manualPackRoot,
            );
        }
        const sourceLock = summary?.sourceLock;
        if (!sourceLock || !validHash(sourceLock.manualPackManifestSha256) ||
            !Array.isArray(sourceLock.documents)) {
            return { status: 'source-lock-unavailable' };
        }

        const manualId = String(evidence.manualId || '');
        const page = Number(evidence.page);
        const expectedDocument = sourceLock.documents.find((item: any) => item?.manualId === manualId);
        if (!expectedDocument || !validHash(expectedDocument.sha256)) {
            return { status: 'manual-document-unavailable' };
        }
        if (!Number.isInteger(page) || page < 1 ||
            (Number.isInteger(expectedDocument.pages) && page > expectedDocument.pages)) {
            return { status: 'page-out-of-range' };
        }

        const root = path.resolve(String(manualPackRoot || ''));
        const manifestPath = path.join(root, 'manifest.json');
        let manifestBytes: Buffer;
        let manifest: any;
        try {
            manifestBytes = await fs.promises.readFile(manifestPath);
            if (sha256(manifestBytes) !== sourceLock.manualPackManifestSha256) {
                return { status: 'manual-pack-evidence-unavailable' };
            }
            manifest = JSON.parse(manifestBytes.toString('utf8'));
        } catch (_error) {
            return { status: 'manual-pack-unavailable' };
        }

        const packDocument = (Array.isArray(manifest?.documents) ? manifest.documents : [])
            .find((item: any) => item?.slug === manualId);
        const relativePdf = String(packDocument?.pdfFile || expectedDocument.pdfFile || '').trim();
        if (!packDocument || !relativePdf) return { status: 'manual-document-unavailable' };
        const unresolvedPdf = path.resolve(root, relativePdf);
        if (!isInside(root, unresolvedPdf)) return { status: 'pdf-unavailable' };

        let realRoot: string;
        let pdfPath: string;
        let pdfStat: fs.Stats;
        try {
            [realRoot, pdfPath, pdfStat] = await Promise.all([
                fs.promises.realpath(root),
                fs.promises.realpath(unresolvedPdf),
                fs.promises.stat(unresolvedPdf),
            ]);
        } catch (_error) {
            return { status: 'pdf-unavailable' };
        }
        if (!pdfStat.isFile() || !isInside(realRoot, pdfPath)) return { status: 'pdf-unavailable' };
        if (Number.isInteger(expectedDocument.size) && pdfStat.size !== expectedDocument.size) {
            return { status: 'pdf-integrity-mismatch' };
        }
        try {
            if (await this.fileSha256(pdfPath, pdfStat.size, pdfStat.mtimeMs) !== expectedDocument.sha256) {
                return { status: 'pdf-integrity-mismatch' };
            }
        } catch (_error) {
            return { status: 'pdf-unavailable' };
        }

        return {
            status: 'resolved',
            pdfPath,
            page,
            manualId,
            title: String(expectedDocument.title || manualId),
        };
    }

    private async resolvePackScoped(
        evidence: any,
        evidenceAuthority: any,
        manualPackRoot: string,
    ): Promise<SemanticEvidenceResolution> {
        const loaded = await loadManualPackAuthority(manualPackRoot);
        if (loaded.status !== 'ready') return loaded;
        const snapshot = loaded.snapshot;
        const profile = authorityProfiles(evidenceAuthority).find(item =>
            item.sourceProfileId === snapshot.sourceProfileId &&
            item.indexSha256 === snapshot.indexSha256);
        if (!profile) {
            return { status: 'manual-pack-profile-unavailable' };
        }
        const location = evidenceLocations(evidence, defaultSourceProfileId(evidenceAuthority))
            .find(item => item.sourceProfileId === snapshot.sourceProfileId);
        if (!location || !location.manualId) {
            return { status: 'manual-pack-profile-unavailable' };
        }
        const page = Number(location.page);
        const currentDocument = authorityDocument(snapshot, location.manualId);
        const expectedDocument = lockedAuthorityDocument(profile, location.manualId);
        if (!currentDocument || !authorityDocumentMatches(currentDocument, expectedDocument)) {
            return { status: 'manual-document-unavailable' };
        }
        if (!Number.isInteger(page) || page < 1 || page > currentDocument.pages) {
            return { status: 'page-out-of-range' };
        }

        const root = path.resolve(String(manualPackRoot || ''));
        const unresolvedPdf = path.resolve(root, currentDocument.pdfFile);
        if (!isInside(root, unresolvedPdf)) return { status: 'pdf-unavailable' };
        let realRoot: string;
        let pdfPath: string;
        let pdfStat: fs.Stats;
        try {
            [realRoot, pdfPath, pdfStat] = await Promise.all([
                fs.promises.realpath(root),
                fs.promises.realpath(unresolvedPdf),
                fs.promises.stat(unresolvedPdf),
            ]);
        } catch (_error) {
            return { status: 'pdf-unavailable' };
        }
        if (!pdfStat.isFile() || !isInside(realRoot, pdfPath)) return { status: 'pdf-unavailable' };
        if (pdfStat.size !== currentDocument.artifactBytes) {
            return { status: 'pdf-integrity-mismatch' };
        }
        try {
            if (await this.fileSha256(pdfPath, pdfStat.size, pdfStat.mtimeMs) !==
                currentDocument.artifactSha256) {
                return { status: 'pdf-integrity-mismatch' };
            }
        } catch (_error) {
            return { status: 'pdf-unavailable' };
        }
        return {
            status: 'resolved',
            pdfPath,
            page,
            manualId: currentDocument.manualId,
            title: currentDocument.title,
            sourceProfileId: snapshot.sourceProfileId,
            revision: currentDocument.revision,
            flavor: snapshot.flavor,
        };
    }
}
