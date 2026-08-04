'use strict';

import type { ManualLocation } from './manualTypes';

const LOOKUP_RE = /^[A-Z0-9_]+$/;
const RANGE_RE = /^([A-Z][A-Z0-9_]*_)(\d+)-(\d+)$/;
const OPTION_TAIL_RE = /[ _]*[\[({].*$/;

function segmentKeys(raw: string): string[] {
    let segment = String(raw || '').trim();
    if (segment.startsWith('*')) segment = segment.slice(1).trim();
    const range = RANGE_RE.exec(segment);
    if (range) {
        const [, prefix, low, high] = range;
        const width = low.length;
        const out: string[] = [];
        for (let value = Number(low); value <= Number(high); value += 1) {
            out.push(`*${prefix}${String(value).padStart(width, '0')}`);
        }
        return out;
    }
    if (!LOOKUP_RE.test(segment)) return [];
    if (!segment.includes('_') && !/\d/.test(segment)) return [];
    return [`*${segment}`];
}

/** Mirrors the manual builder's authoritative chunk-title keyword derivation. */
export function keywordKeysForSectionTitle(title: string): string[] {
    const value = String(title || '').trim().toUpperCase();
    if (!value) return [];
    if (value.startsWith('*')) {
        const body = value.slice(1).replace(OPTION_TAIL_RE, '').replace(/[ _]+$/, '');
        return LOOKUP_RE.test(body) ? [`*${body}`] : [];
    }
    if (!value.includes('/') || value.includes(' ')) return [];
    return value.split('/').flatMap(segmentKeys);
}

export function manualChapterKey(location: ManualLocation): string {
    return `${location.manualId}\u0000${location.sectionId}`;
}

export function dedupeManualChapters(locations: ManualLocation[]): ManualLocation[] {
    const out: ManualLocation[] = [];
    const seen = new Set<string>();
    for (const location of locations) {
        if (!location || !location.manualId || !location.sectionId) continue;
        const key = manualChapterKey(location);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(location);
    }
    return out;
}
