'use strict';

export type ManualLanguage = 'en' | 'zh';
export type ManualSearchScope = ManualLanguage | 'both';
/** Keyword: resolve + keywords + titles. Fulltext: also section preview/excerpt. */
export type ManualSearchMode = 'keyword' | 'fulltext';
/** Pack SKU: en-only or full bilingual (legacy packs without flavor are inferred). */
export type PackFlavor = 'en' | 'bilingual' | 'unknown';

export interface PackFeatures {
    zhDocuments: boolean;
    sentenceMap: boolean;
    searchZh: boolean;
}

export interface PackCapabilities {
    flavor: PackFlavor;
    languages: string[];
    defaultLanguage: ManualLanguage;
    features: PackFeatures;
    /** True when the pack can serve Chinese document chunks. */
    canReadZh: boolean;
    /** True when language toggle / bilingual sentence preview is useful. */
    canToggleLanguage: boolean;
}

/** One document entry from pack manifest.json (subset used by the extension). */
export interface ManifestDocument {
    slug: string;
    title?: string;
    order?: number;
    /** Pack-root-relative path, e.g. `pdf/Vol I R16.zh-CN.pdf`. */
    pdfFile?: string;
    /** Optional human-readable PDF edition tag (not used for path resolution). */
    pdfVersion?: string;
}

export interface ManualLocation {
    manualId: string;
    sectionId: string;
    anchorId: string | null;
    title?: string;
    pdfPage?: number | null;
    /** Normalized keyword originally requested by the user. */
    requestedKeyword?: string;
    /** Normalized keyword whose manual entry supplied this location. */
    matchedKeyword?: string;
    /** How confidently the requested keyword maps to the returned manual location. */
    matchKind?: 'exact' | 'section' | 'approximate';
}

export interface ManualKeywordEntry extends ManualLocation {
    /** Additional official chapters that define the same keyword title. */
    alternateLocations?: ManualLocation[];
}

export interface ManualSearchResult {
    location: ManualLocation;
    titleEn: string;
    titleZh?: string;
    preview: string;
    matchedLanguages: ManualLanguage[];
    score: number;
}
