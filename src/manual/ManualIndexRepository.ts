'use strict';

/**
 * Runtime-schema reader for the LS-DYNA bilingual manual pack.
 *
 * This is the G3 anti-corruption boundary: it reads only `manifest.json` and
 * `indexes/*.json` emitted by the release orchestrator.  It must never read
 * MinerU build products such as `search_index.jsonl` or keyword shards.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
    ManifestDocument,
    ManualLanguage,
    ManualLocation,
    ManualKeywordEntry,
    ManualSearchMode,
    ManualSearchResult,
    ManualSearchScope,
    PackCapabilities,
    PackFeatures,
    PackFlavor,
} from './manualTypes';
import { listDeclaredPdfPaths, resolveDocumentPdfPath } from './packPdf';
import { classifyManualMatch } from '../core/manualMatch';
import {
    dedupeManualChapters,
    keywordKeysForSectionTitle,
} from './manualKeywordResolution';
export type {
    ManifestDocument,
    ManualLanguage,
    ManualLocation,
    ManualSearchMode,
    ManualSearchResult,
    ManualSearchScope,
    PackCapabilities,
    PackFeatures,
    PackFlavor,
} from './manualTypes';

const RUNTIME_SCHEMA_VERSION = 1;

export interface SectionRecord {
    manualId: string;
    sectionId: string;
    level: number;
    titleEn: string;
    titleZh?: string;
    anchors: string[];
    pathEn: string;
    pathZh: string;
    pdfPage?: number | null;
}

export interface SentencePair {
    unitId: string;
    manualId: string;
    sectionId: string;
    anchorId: string | null;
    sentenceHash: string;
    en: string;
    zh: string;
    /** Optional display-key overrides produced by pack index (Phase 1). */
    matchEn?: string;
    matchZh?: string;
}

export interface ManualDocument {
    manualId: string;
    title: string;
    order: number;
    /** Pack-root-relative PDF path when declared in manifest. */
    pdfFile?: string;
}

interface SearchDoc {
    manualId: string;
    sectionId: string;
    titleEn?: string;
    titleZh?: string;
    keywords?: string[];
    preview?: string;
}

interface PackManifest {
    schemaVersion?: number;
    generatedAt?: string;
    flavor?: string;
    languages?: string[];
    defaultLanguage?: string;
    features?: Partial<PackFeatures>;
    documents?: ManifestDocument[];
    indexes?: Record<string, string>;
    documentsRoot?: Record<string, string>;
}

function normalizePackFlavor(raw: unknown, languages: string[], features: PackFeatures): PackFlavor {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'en' || value === 'english' || value === 'en-only') return 'en';
    if (value === 'bilingual' || value === 'dual' || value === 'zh' || value === 'zh-cn') return 'bilingual';
    // Legacy packs: infer from languages / features / on-disk indexes.
    if (features.zhDocuments || features.sentenceMap || features.searchZh) return 'bilingual';
    if (languages.some(lang => /^zh/i.test(lang))) return 'bilingual';
    if (languages.length === 1 && languages[0] === 'en') return 'en';
    return 'unknown';
}

function coerceFeatures(raw: Partial<PackFeatures> | undefined, languages: string[], packRoot: string): PackFeatures {
    const indexesDir = path.join(packRoot, 'indexes');
    const hasSearchZhFile = fs.existsSync(path.join(indexesDir, 'search-zh.json'));
    const hasSentenceMapFile = fs.existsSync(path.join(indexesDir, 'sentence-map.json'));
    const hasZhDocs = fs.existsSync(path.join(packRoot, 'documents', 'zh'));
    const languageHasZh = languages.some(lang => /^zh/i.test(lang));
    // Legacy bilingual packs may omit features[]; treat zh indexes as evidence of zh docs.
    const zhSignals = hasZhDocs || languageHasZh || hasSearchZhFile || hasSentenceMapFile;
    return {
        zhDocuments: raw?.zhDocuments === true || (raw?.zhDocuments !== false && zhSignals),
        sentenceMap: raw?.sentenceMap === true || (raw?.sentenceMap !== false && hasSentenceMapFile),
        searchZh: raw?.searchZh === true || (raw?.searchZh !== false && hasSearchZhFile),
    };
}

function defaultLanguageFromManifest(raw: unknown, flavor: PackFlavor): ManualLanguage {
    const value = String(raw || '').trim().toLowerCase();
    if (value.startsWith('zh')) return 'zh';
    if (value === 'en' || value.startsWith('en')) return 'en';
    // Bilingual packs default to Chinese for Chinese-primary audiences.
    return flavor === 'bilingual' ? 'zh' : 'en';
}

export function resolvePackCapabilities(packRoot: string, manifest: PackManifest = {}): PackCapabilities {
    const languages = Array.isArray(manifest.languages)
        ? manifest.languages.map(item => String(item || '').trim()).filter(Boolean)
        : [];
    const features = coerceFeatures(manifest.features, languages, packRoot);
    let flavor = normalizePackFlavor(manifest.flavor, languages, features);
    // On-disk evidence overrides a missing/unknown flavor declaration.
    if (flavor === 'unknown') {
        if (features.zhDocuments || features.sentenceMap || features.searchZh) flavor = 'bilingual';
        else if (languages.length === 0 || languages.every(lang => lang === 'en' || lang.toLowerCase().startsWith('en'))) {
            // No zh signals → treat as English-capable; still unknown if empty legacy.
            flavor = features.zhDocuments ? 'bilingual' : (languages.length ? 'en' : 'unknown');
        }
    }
    // Explicit en flavor must never claim zh capabilities even if stale files exist.
    if (flavor === 'en') {
        features.zhDocuments = false;
        features.sentenceMap = false;
        features.searchZh = false;
    }
    const canReadZh = flavor !== 'en' && features.zhDocuments;
    const canToggleLanguage = canReadZh;
    return {
        flavor,
        languages: languages.length ? languages : (flavor === 'en' ? ['en'] : ['en', 'zh-CN']),
        defaultLanguage: defaultLanguageFromManifest(manifest.defaultLanguage, flavor === 'unknown' && canReadZh ? 'bilingual' : flavor),
        features,
        canReadZh,
        canToggleLanguage,
    };
}

function normalizeKeyword(raw: string): string {
    let key = (raw || '').trim().toUpperCase();
    if (key && !key.startsWith('*')) key = '*' + key;
    return key;
}

/** Strip leading * and separators so "control time" aligns with "CONTROL_TIMESTEP". */
export function keywordSkeleton(raw: string): string {
    return (raw || '')
        .trim()
        .toUpperCase()
        .replace(/^\*+/, '')
        .replace(/[\s_\-./]+/g, '');
}

/** Split on LS-DYNA-ish separators (space, underscore, hyphen, slash, dot). */
export function keywordTokens(raw: string): string[] {
    const upper = (raw || '').trim().toUpperCase().replace(/^\*+/, '');
    if (!upper) return [];
    return upper.split(/[\s_\-./]+/).filter(Boolean);
}

/** Every query token is a prefix of some target token (TIME → TIMESTEP). */
function tokensMatchAll(queryTokens: string[], targetTokens: string[]): boolean {
    if (!queryTokens.length || !targetTokens.length) return false;
    return queryTokens.every(q => targetTokens.some(t => t.startsWith(q)));
}

/**
 * Score a needle against a keyword string or title using skeleton + token rules.
 * Returns 0 when nothing matches.
 */
function scoreKeywordOrTitle(needle: string, candidate: string, kind: 'keyword' | 'title'): number {
    const qSkel = keywordSkeleton(needle);
    const cSkel = keywordSkeleton(candidate);
    if (!qSkel || !cSkel) return 0;

    if (kind === 'keyword') {
        if (cSkel === qSkel) return 4500;
        // Require a minimum query length before prefix/contains to limit noise.
        if (qSkel.length >= 2 && cSkel.startsWith(qSkel)) return 4200;
        if (qSkel.length >= 3 && cSkel.includes(qSkel)) return 3200;
    } else {
        if (cSkel === qSkel) return 4000;
        if (qSkel.length >= 2 && cSkel.startsWith(qSkel)) return 3500;
        if (qSkel.length >= 2 && cSkel.includes(qSkel)) return 3000;
    }

    const qTokens = keywordTokens(needle);
    const cTokens = keywordTokens(candidate);
    // Single very short token: only exact skeleton paths above.
    if (qTokens.length === 1 && (qTokens[0]?.length ?? 0) < 2) return 0;
    if (tokensMatchAll(qTokens, cTokens)) {
        return kind === 'keyword' ? 2800 + Math.min(200, qTokens.length * 50) : 2600 + Math.min(200, qTokens.length * 40);
    }
    return 0;
}

/** Allow "control time" to resolve like "CONTROL_TIME" via underscore fallback. */
function resolveKeywordCandidates(raw: string): string[] {
    const trimmed = (raw || '').trim();
    if (!trimmed) return [];
    const spacedAsUnderscore = trimmed.replace(/[\s./]+/g, '_').replace(/_+/g, '_');
    const out = [trimmed];
    if (spacedAsUnderscore !== trimmed) out.push(spacedAsUnderscore);
    return out;
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function readVersioned(file: string, payloadKey: string): any {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(`malformed index (not an object): ${file}`);
    }
    if (parsed.schemaVersion !== RUNTIME_SCHEMA_VERSION) {
        throw new Error(`unsupported schemaVersion ${parsed.schemaVersion} in ${path.basename(file)} (supported: ${RUNTIME_SCHEMA_VERSION})`);
    }
    if (!(payloadKey in parsed)) {
        throw new Error(`index ${path.basename(file)} missing payload key '${payloadKey}'`);
    }
    return parsed[payloadKey];
}

/**
 * Query layer for a manual pack.  Navigation data is loaded eagerly on first
 * use; the 80 MB sentence map and search indexes remain lazy until requested.
 */
export class ManualIndexRepository {
    private readonly indexesDir: string;
    private readonly packRoot: string;
    private keywords: Record<string, ManualKeywordEntry> = {};
    private keywordLocations = new Map<string, ManualLocation[]>();
    private keywordsByLocation = new Map<string, string[]>();
    private sections: SectionRecord[] = [];
    private sectionById = new Map<string, SectionRecord>();
    private sectionByPath = new Map<string, SectionRecord>();
    private anchors: Record<string, { manualId: string; sectionId: string }> = {};
    private sentences: SentencePair[] = [];
    private sentencesBySection = new Map<string, SentencePair[]>();
    private searchIndexes = new Map<ManualLanguage, SearchDoc[]>();
    private manifest: PackManifest | undefined;
    private capabilities: PackCapabilities | undefined;
    private navigationLoaded = false;
    private sentencesLoaded = false;

    constructor(packRoot: string) {
        this.packRoot = packRoot;
        this.indexesDir = path.join(packRoot, 'indexes');
    }

    private static sectionKey(manualId: string, sectionId: string): string {
        return `${manualId}\u0000${sectionId}`;
    }

    private static locationKey(location: ManualLocation): string {
        return [
            location.manualId,
            location.sectionId,
            location.anchorId || '',
            location.pdfPage ?? '',
        ].join('\u0000');
    }

    private addKeywordLocation(keyword: string, location: ManualLocation): void {
        const normalized = normalizeKeyword(keyword);
        if (!normalized || !location?.manualId || !location?.sectionId) return;
        const current = this.keywordLocations.get(normalized) || [];
        const next = dedupeManualChapters([...current, {
            manualId: location.manualId,
            sectionId: location.sectionId,
            anchorId: location.anchorId || null,
            pdfPage: location.pdfPage ?? null,
        }]);
        this.keywordLocations.set(normalized, next);
    }

    /** Compatibility entry point for existing callers. */
    load(): void {
        this.loadNavigation();
    }

    /** Loads only the small navigation indexes. */
    loadNavigation(): void {
        if (this.navigationLoaded) return;
        this.keywords = readVersioned(path.join(this.indexesDir, 'keywords.json'), 'keywords');
        this.sections = readVersioned(path.join(this.indexesDir, 'sections.json'), 'sections');
        this.anchors = readVersioned(path.join(this.indexesDir, 'anchors.json'), 'anchors');
        this.sectionById.clear();
        this.sectionByPath.clear();
        for (const section of this.sections) {
            this.sectionById.set(ManualIndexRepository.sectionKey(section.manualId, section.sectionId), section);
            this.sectionByPath.set(normalizePath(section.pathEn), section);
            if (section.pathZh) this.sectionByPath.set(normalizePath(section.pathZh), section);
        }

        this.keywordLocations.clear();
        for (const [keyword, primary] of Object.entries(this.keywords)) {
            this.addKeywordLocation(keyword, primary);
            for (const alternate of Array.isArray(primary.alternateLocations) ? primary.alternateLocations : []) {
                this.addKeywordLocation(keyword, alternate);
            }
        }
        // Legacy packs kept only the first title collision. Rebuild the complete
        // chapter set from authoritative compound section titles without
        // parsing PDFs. A one-name heading may repeat at category, option, or
        // restart levels; keywords.json already identifies its canonical first
        // location and such repeats are not independent chapter aliases.
        for (const section of this.sections) {
            const location: ManualLocation = {
                manualId: section.manualId,
                sectionId: section.sectionId,
                anchorId: section.anchors[0] || null,
                pdfPage: section.pdfPage ?? null,
            };
            const titleKeys = keywordKeysForSectionTitle(section.titleEn);
            for (const keyword of titleKeys) {
                if (titleKeys.length === 1 && this.keywordLocations.has(normalizeKeyword(keyword))) {
                    continue;
                }
                this.addKeywordLocation(keyword, location);
            }
        }

        this.keywordsByLocation.clear();
        for (const [keyword, locations] of this.keywordLocations) {
            for (const location of locations) {
                const key = ManualIndexRepository.locationKey(location);
                const equivalents = this.keywordsByLocation.get(key);
                if (equivalents) {
                    if (!equivalents.includes(keyword)) equivalents.push(keyword);
                } else {
                    this.keywordsByLocation.set(key, [keyword]);
                }
            }
        }
        this.navigationLoaded = true;
    }

    private loadManifest(): PackManifest {
        if (this.manifest) return this.manifest;
        const manifestFile = path.join(this.packRoot, 'manifest.json');
        this.manifest = fs.existsSync(manifestFile)
            ? JSON.parse(fs.readFileSync(manifestFile, 'utf-8'))
            : {};
        return this.manifest;
    }

    getCapabilities(): PackCapabilities {
        if (this.capabilities) return this.capabilities;
        this.capabilities = resolvePackCapabilities(this.packRoot, this.loadManifest());
        return this.capabilities;
    }

    private loadSentences(): void {
        if (this.sentencesLoaded) return;
        const mapFile = path.join(this.indexesDir, 'sentence-map.json');
        if (!this.getCapabilities().features.sentenceMap || !fs.existsSync(mapFile)) {
            this.sentences = [];
            this.sentencesBySection.clear();
            this.sentencesLoaded = true;
            return;
        }
        this.sentences = readVersioned(mapFile, 'sentences');
        this.sentencesBySection.clear();
        for (const sentence of this.sentences) {
            const key = ManualIndexRepository.sectionKey(sentence.manualId, sentence.sectionId);
            const entries = this.sentencesBySection.get(key);
            if (entries) entries.push(sentence);
            else this.sentencesBySection.set(key, [sentence]);
        }
        this.sentencesLoaded = true;
    }

    private searchDocs(language: ManualLanguage): SearchDoc[] {
        const loaded = this.searchIndexes.get(language);
        if (loaded) return loaded;
        if (language === 'zh' && !this.getCapabilities().features.searchZh) {
            this.searchIndexes.set(language, []);
            return [];
        }
        const file = path.join(this.indexesDir, `search-${language}.json`);
        if (!fs.existsSync(file)) {
            this.searchIndexes.set(language, []);
            return [];
        }
        const docs = readVersioned(file, 'docs') as SearchDoc[];
        this.searchIndexes.set(language, docs);
        return docs;
    }

    keywordCount(): number { this.loadNavigation(); return Object.keys(this.keywords).length; }
    sectionCount(): number { this.loadNavigation(); return this.sections.length; }
    sentenceCount(): number { this.loadSentences(); return this.sentences.length; }

    /** Idempotent warm path so language toggle does not cold-load the large map. */
    ensureSentencesLoaded(): void { this.loadSentences(); }
    isSentencesLoaded(): boolean { return this.sentencesLoaded; }

    getManifestIdentity(): string {
        const manifest = this.loadManifest();
        const caps = this.getCapabilities();
        return `${manifest.schemaVersion || 'unknown'}:${manifest.generatedAt || 'unknown'}:${caps.flavor}`;
    }

    listDocuments(): ManualDocument[] {
        this.loadNavigation();
        const manifest = this.loadManifest();
        const listed = (manifest.documents || []).map((doc, index) => ({
            manualId: doc.slug,
            title: doc.title || doc.slug,
            order: typeof doc.order === 'number' ? doc.order : index + 1,
            pdfFile: typeof doc.pdfFile === 'string' && doc.pdfFile.trim() ? doc.pdfFile.trim() : undefined,
        }));
        if (listed.length > 0) return listed.sort((a, b) => a.order - b.order);
        const fallback = new Map<string, ManualDocument>();
        for (const section of this.sections) {
            if (!fallback.has(section.manualId)) {
                fallback.set(section.manualId, { manualId: section.manualId, title: section.manualId, order: fallback.size + 1 });
            }
        }
        return [...fallback.values()];
    }

    /**
     * Absolute path of the current PDF for a manual slug.
     * Prefers manifest `pdfFile`, then legacy `pdf/{title}.pdf`.
     */
    resolveDocumentPdfPath(manualId: string): string | null {
        if (!manualId) return null;
        const manifest = this.loadManifest();
        const document = (manifest.documents || []).find(item => item && item.slug === manualId);
        if (document) {
            return resolveDocumentPdfPath(this.packRoot, document);
        }
        // Sections-only packs without manifest documents: no title to fall back on.
        return null;
    }

    /** Absolute paths of all PDFs declared by the pack (deduped, existing only). */
    listDeclaredPdfPaths(): string[] {
        const manifest = this.loadManifest();
        return listDeclaredPdfPaths(this.packRoot, manifest.documents || []);
    }

    listSections(manualId?: string): SectionRecord[] {
        this.loadNavigation();
        return manualId ? this.sections.filter(section => section.manualId === manualId) : [...this.sections];
    }

    resolveKeywordLocations(keyword: string): ManualLocation[] {
        this.loadNavigation();
        const requestedKeyword = normalizeKeyword(keyword);
        for (const candidate of resolveKeywordCandidates(keyword)) {
            const normalized = normalizeKeyword(candidate);
            const exact = this.keywordLocations.get(normalized);
            if (exact?.length) {
                return exact.map(location => this.withTitle({
                    ...location,
                    requestedKeyword,
                    matchedKeyword: normalized,
                    matchKind: 'exact',
                }));
            }
            let base = normalized;
            for (;;) {
                const cut = base.lastIndexOf('_');
                if (cut <= 1) break;
                base = base.slice(0, cut);
                const hits = this.keywordLocations.get(base);
                if (hits?.length) {
                    return hits.map(hit => {
                        const equivalents = this.keywordsByLocation.get(
                            ManualIndexRepository.locationKey(hit)
                        ) || [];
                        return this.withTitle({
                            ...hit,
                            requestedKeyword,
                            matchedKeyword: base,
                            matchKind: classifyManualMatch(normalized, base, equivalents),
                        });
                    });
                }
            }
        }
        return [];
    }

    resolveKeyword(keyword: string): ManualLocation | null {
        return this.resolveKeywordLocations(keyword)[0] || null;
    }

    getSection(manualId: string, sectionId: string): SectionRecord | null {
        this.loadNavigation();
        return this.sectionById.get(ManualIndexRepository.sectionKey(manualId, sectionId)) || null;
    }

    sectionPath(manualId: string, sectionId: string, language: ManualLanguage): string | null {
        const section = this.getSection(manualId, sectionId);
        if (!section) return null;
        if (language === 'zh') {
            if (!this.getCapabilities().canReadZh) return null;
            return section.pathZh || null;
        }
        return section.pathEn;
    }

    resolveAnchor(anchorId: string): ManualLocation | null {
        this.loadNavigation();
        const anchor = this.anchors[anchorId];
        if (!anchor) return null;
        const section = this.getSection(anchor.manualId, anchor.sectionId);
        return this.withTitle({ ...anchor, anchorId, pdfPage: section?.pdfPage || null });
    }

    resolveSectionPath(relativePath: string): ManualLocation | null {
        this.loadNavigation();
        const section = this.sectionByPath.get(normalizePath(relativePath));
        if (!section) return null;
        return this.withTitle({
            manualId: section.manualId,
            sectionId: section.sectionId,
            anchorId: null,
            pdfPage: section.pdfPage || null,
        });
    }

    getSectionSentences(manualId: string, sectionId: string): SentencePair[] {
        this.loadSentences();
        return this.sentencesBySection.get(ManualIndexRepository.sectionKey(manualId, sectionId)) || [];
    }

    search(
        query: string,
        scope: ManualSearchScope,
        limit = 100,
        mode: ManualSearchMode = 'keyword',
    ): ManualSearchResult[] {
        this.loadNavigation();
        const needle = (query || '').trim();
        if (!needle) return [];
        const searchMode: ManualSearchMode = mode === 'fulltext' ? 'fulltext' : 'keyword';
        const lower = needle.toLocaleLowerCase();
        const keyword = normalizeKeyword(needle);
        const terms = [...new Set(lower.split(/\s+/).filter(Boolean))];
        const results = new Map<string, ManualSearchResult>();
        const caps = this.getCapabilities();
        let languages: ManualLanguage[] = scope === 'both' ? ['en', 'zh'] : [scope];
        if (!caps.features.searchZh) {
            languages = languages.filter(language => language !== 'zh');
            if (languages.length === 0) languages = ['en'];
        }
        const add = (doc: SearchDoc, language: ManualLanguage, score: number) => {
            if (score <= 0) return;
            const section = this.getSection(doc.manualId, doc.sectionId);
            if (!section) return;
            const key = ManualIndexRepository.sectionKey(doc.manualId, doc.sectionId);
            const existing = results.get(key);
            const preview = doc.preview || '';
            if (existing) {
                if (!existing.matchedLanguages.includes(language)) existing.matchedLanguages.push(language);
                if (score > existing.score) {
                    existing.score = score;
                    existing.preview = preview;
                }
                return;
            }
            results.set(key, {
                location: this.withTitle({ manualId: doc.manualId, sectionId: doc.sectionId, anchorId: null, pdfPage: section.pdfPage || null }),
                titleEn: section.titleEn,
                titleZh: section.titleZh,
                preview,
                matchedLanguages: [language],
                score,
            });
        };

        for (const language of languages) {
            for (const doc of this.searchDocs(language)) {
                const title = (language === 'zh' ? doc.titleZh : doc.titleEn) || '';
                const preview = doc.preview || '';
                const normalizedTitle = title.trim().toLocaleLowerCase();
                const normalizedPreview = preview.toLocaleLowerCase();
                let score = 0;

                // Separator-insensitive keyword hits (space ≈ underscore ≈ hyphen).
                for (const value of doc.keywords || []) {
                    if (value.toUpperCase() === keyword) {
                        score = Math.max(score, 4500);
                        continue;
                    }
                    score = Math.max(score, scoreKeywordOrTitle(needle, value, 'keyword'));
                }

                // Title: keep literal ranks, then skeleton/token ranks.
                if (normalizedTitle === lower) score = Math.max(score, 4000);
                else if (normalizedTitle.startsWith(lower)) score = Math.max(score, 3500);
                else if (normalizedTitle.includes(lower)) score = Math.max(score, 3000);
                if (title) score = Math.max(score, scoreKeywordOrTitle(needle, title, 'title'));

                if (score === 0 && searchMode === 'fulltext') {
                    const phraseMatch = normalizedPreview.includes(lower);
                    const termHits = terms.filter(term => normalizedPreview.includes(term)).length;
                    if (phraseMatch || termHits > 0) score = 1000 + (phraseMatch ? 500 : 0) + termHits * 100;
                }
                add(doc, language, score);
            }
        }
        const direct = this.resolveKeyword(needle);
        if (direct && languages.length > 0) {
            const section = this.getSection(direct.manualId, direct.sectionId)!;
            const key = ManualIndexRepository.sectionKey(direct.manualId, direct.sectionId);
            const existing = results.get(key);
            if (existing) {
                existing.score = Math.max(existing.score, 5000);
                for (const language of languages) {
                    if (!existing.matchedLanguages.includes(language)) existing.matchedLanguages.push(language);
                }
            }
            else results.set(key, {
                location: direct,
                titleEn: section.titleEn,
                titleZh: section.titleZh,
                preview: '',
                matchedLanguages: languages,
                score: 5000,
            });
        }
        return [...results.values()]
            .sort((left, right) => right.score - left.score
                || left.titleEn.localeCompare(right.titleEn, 'en')
                || left.location.manualId.localeCompare(right.location.manualId, 'en')
                || left.location.sectionId.localeCompare(right.location.sectionId, 'en'))
            .slice(0, limit);
    }

    private withTitle(location: ManualLocation): ManualLocation {
        const section = this.getSection(location.manualId, location.sectionId);
        return { ...location, title: location.title || section?.titleEn, pdfPage: location.pdfPage ?? section?.pdfPage ?? null };
    }
}
