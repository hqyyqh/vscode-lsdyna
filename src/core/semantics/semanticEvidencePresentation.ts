import type { SemanticEvidenceLocation } from './manualSemanticAdvisor';
import type { ManualPackAuthoritySnapshot } from '../../manual/manualPackAuthority';

export type SemanticEvidenceItem = {
    ruleId: string;
    evidence: SemanticEvidenceLocation[];
};

export type SemanticEvidenceTarget = {
    ruleId: string;
    evidenceId: string;
    manualId: string;
    manualLabel: string;
    page: number;
    sourceProfileId?: string;
    revision?: string;
};

function compactManualLabel(title: string, manualId: string): string {
    const value = String(title || manualId || '');
    const volume = value.match(/\bVol(?:ume)?[\s_-]+([IVXLCDM]+|\d+)\b/i)
        || String(manualId || '').match(/(?:^|[-_])vol[-_]?([ivxlcdm]+|\d+)(?:[-_]|$)/i);
    if (volume) return `Vol ${volume[1].toUpperCase()}`;
    if (/theory/i.test(value) || /theory/i.test(manualId)) return 'Theory';
    return value || manualId;
}

function validHash(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function authorityProfiles(evidenceAuthority: any): any[] {
    if (Array.isArray(evidenceAuthority?.profiles)) {
        return evidenceAuthority.profiles.filter((profile: any) =>
            validHash(profile?.sourceProfileId) && validHash(profile?.indexSha256));
    }
    return validHash(evidenceAuthority?.sourceProfileId) &&
        validHash(evidenceAuthority?.indexSha256)
        ? [evidenceAuthority]
        : [];
}

function selectedAuthorityProfile(
    evidenceAuthority: any,
    currentAuthority: ManualPackAuthoritySnapshot | null | undefined,
): any | null {
    const profiles = authorityProfiles(evidenceAuthority);
    if (profiles.length === 0) return null;
    if (currentAuthority === null) return null;
    if (currentAuthority === undefined) {
        const defaultProfileId = String(
            evidenceAuthority?.defaultSourceProfileId || evidenceAuthority?.sourceProfileId || '',
        );
        return profiles.find(profile => profile.sourceProfileId === defaultProfileId) || null;
    }
    return profiles.find(profile =>
        profile.sourceProfileId === currentAuthority.sourceProfileId &&
        profile.indexSha256 === currentAuthority.indexSha256) || null;
}

/**
 * Select already-published evidence for the current pack without any I/O.
 * A new profile-aware runtime stays silent until the configured pack exposes
 * the exact profile/index identity. Legacy runtimes retain their old labels.
 */
export function semanticEvidenceTargets(
    items: SemanticEvidenceItem[],
    currentAuthority: ManualPackAuthoritySnapshot | null | undefined,
    evidenceAuthority: any | null,
): SemanticEvidenceTarget[] {
    const profiles = authorityProfiles(evidenceAuthority);
    const profileAware = profiles.length > 0;
    const selectedProfile = profileAware
        ? selectedAuthorityProfile(evidenceAuthority, currentAuthority)
        : null;
    if (profileAware && !selectedProfile) return [];
    const lockedProfile = String(selectedProfile?.sourceProfileId || '');

    const result: SemanticEvidenceTarget[] = [];
    const seen = new Set<string>();
    for (const item of items || []) {
        for (const evidence of item.evidence || []) {
            const sourceProfileId = String(evidence.sourceProfileId || lockedProfile || '');
            if (!item.ruleId || !evidence.evidenceId || !evidence.manualId ||
                !Number.isInteger(evidence.page) || Number(evidence.page) < 1 ||
                (profileAware && sourceProfileId !== lockedProfile)) {
                continue;
            }
            const key = `${sourceProfileId}\u0000${evidence.manualId}\u0000${evidence.page}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const currentDocument = currentAuthority?.documents
                .find(document => document.manualId === evidence.manualId);
            const lockedDocument = (Array.isArray(selectedProfile?.documents)
                ? selectedProfile.documents
                : []).find((document: any) => document?.manualId === evidence.manualId);
            const title = String(currentDocument?.title || lockedDocument?.title || evidence.manualId);
            result.push({
                ruleId: item.ruleId,
                evidenceId: evidence.evidenceId,
                manualId: evidence.manualId,
                manualLabel: compactManualLabel(title, evidence.manualId),
                page: Number(evidence.page),
                ...(sourceProfileId ? { sourceProfileId } : {}),
                ...((currentDocument?.revision || lockedDocument?.revision)
                    ? { revision: String(currentDocument?.revision || lockedDocument?.revision) }
                    : {}),
            });
        }
    }
    return result;
}

export function semanticEvidenceTargetLabel(target: SemanticEvidenceTarget): string {
    return `${target.manualLabel} · P${target.page}`;
}
