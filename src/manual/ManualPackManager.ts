'use strict';

/** Shared lifecycle and persisted reader state for one manual pack. */

import type { ManualReadingMode } from './manualTypes';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ManualIndexRepository, ManualLanguage, ManualLocation } from './ManualIndexRepository';
import {
    loadManualPackAuthoritySync,
    type ManualPackAuthoritySnapshot,
} from './manualPackAuthority';
const i18n = require('../core/i18n');

export interface PersistedReaderState {
    manifestIdentity: string;
    location: ManualLocation;
    language: ManualLanguage;
    readingMode?: ManualReadingMode;
    /** Separate intent from the displayed language (which may fall back for English-only packs). */
    languagePreference?: ManualReadingMode | 'auto';
    scrollY: number;
    scrollRatio?: number;
}

function canonicalRoot(packRoot: string): string {
    try {
        return fs.realpathSync(packRoot);
    } catch {
        return path.resolve(packRoot);
    }
}

function stateKey(root: string): string {
    const digest = crypto.createHash('sha256').update(root).digest('hex');
    return `lsdyna.manual.reader.v1:${digest}`;
}

/**
 * Caches the active runtime-schema repository and owns global per-pack reader
 * state. A changed manifest mtime rebuilds the repository without restart.
 */
export class ManualPackManager {
    private root = '';
    private requestedRoot = '';
    private manifestMtime = -1;
    private repository: ManualIndexRepository | undefined;
    private authoritySnapshot: ManualPackAuthoritySnapshot | null = null;

    constructor(private readonly context: vscode.ExtensionContext, private readonly onAuthorityChanged?: () => void) {}

    hasPack(packRoot: string): boolean {
        try {
            return fs.statSync(path.join(packRoot, 'manifest.json')).isFile()
                && fs.statSync(path.join(packRoot, 'indexes')).isDirectory();
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
            throw error;
        }
    }

    getRepository(packRoot: string): ManualIndexRepository {
        const requestedRoot = path.resolve(packRoot);
        const root = canonicalRoot(packRoot);
        if (!this.hasPack(root)) {
            throw new Error(i18n.get('manualReaderNoPack'));
        }
        const manifestFile = path.join(root, 'manifest.json');
        const mtime = fs.statSync(manifestFile).mtimeMs;
        if (!this.repository || this.root !== root || this.manifestMtime !== mtime) {
            const repository = new ManualIndexRepository(root);
            repository.loadNavigation();
            this.root = root;
            this.manifestMtime = mtime;
            this.repository = repository;
            const authority = loadManualPackAuthoritySync(root);
            this.authoritySnapshot = authority.status === 'ready' ? authority.snapshot : null;
            this.onAuthorityChanged?.();
        }
        this.requestedRoot = requestedRoot;
        return this.repository;
    }

    /** Memory-only authority view for Hover/Completion; never performs I/O. */
    peekAuthority(packRoot: string): ManualPackAuthoritySnapshot | null {
        if (!this.repository || path.resolve(packRoot) !== this.requestedRoot) return null;
        return this.authoritySnapshot;
    }

    /** Current cached snapshot; undefined pack data is represented by null. */
    peekCurrentAuthority(): ManualPackAuthoritySnapshot | null {
        return this.repository ? this.authoritySnapshot : null;
    }

    invalidate(): void {
        this.root = '';
        this.requestedRoot = '';
        this.manifestMtime = -1;
        this.repository = undefined;
        this.authoritySnapshot = null;
        this.onAuthorityChanged?.();
    }

    saveState(packRoot: string, state: PersistedReaderState): void {
        const root = canonicalRoot(packRoot);
        if (!this.context.globalState || typeof this.context.globalState.update !== 'function') return;
        Promise.resolve(this.context.globalState.update(stateKey(root), state)).then(undefined, () => {});
    }

    restoreState(packRoot: string, repository: ManualIndexRepository): PersistedReaderState | undefined {
        if (!this.context.globalState || typeof this.context.globalState.get !== 'function') return undefined;
        const root = canonicalRoot(packRoot);
        const saved = this.context.globalState.get<PersistedReaderState | undefined>(stateKey(root), undefined);
        const section = saved?.location && repository.getSection(saved.location.manualId, saved.location.sectionId);
        if (!saved || !section) {
            return undefined;
        }
        const caps = repository.getCapabilities();
        const language = !caps.canToggleLanguage || saved.language === 'en' ? 'en' : 'zh';
        const manifestIdentity = repository.getManifestIdentity();
        return {
            manifestIdentity,
            location: saved.manifestIdentity === manifestIdentity ? saved.location : {
                ...saved.location,
                title: language === 'zh' && section.titleZh ? section.titleZh : section.titleEn,
                pdfPage: section.pdfPage ?? null,
                anchorId: saved.location.anchorId && section.anchors.includes(saved.location.anchorId) ? saved.location.anchorId : section.anchors[0] || null,
            },
            language,
            languagePreference: saved.languagePreference === 'auto' || saved.languagePreference === 'en' || saved.languagePreference === 'zh' || saved.languagePreference === 'bilingual'
                ? saved.languagePreference : saved.readingMode === 'bilingual' ? 'bilingual' : saved.language,
            readingMode: caps.canToggleLanguage && caps.features.sentenceMap && saved.readingMode === 'bilingual' ? 'bilingual' : language,
            scrollY: Number.isFinite(saved.scrollY) ? Math.max(0, saved.scrollY) : 0,
            scrollRatio: Number.isFinite(saved.scrollRatio) ? Math.min(1, Math.max(0, Number(saved.scrollRatio))) : 0,
        };
    }

    firstLocation(repository: ManualIndexRepository): ManualLocation | undefined {
        const firstDocument = repository.listDocuments()[0];
        const firstSection = repository.listSections(firstDocument?.manualId)[0] || repository.listSections()[0];
        if (!firstSection) return undefined;
        return {
            manualId: firstSection.manualId,
            sectionId: firstSection.sectionId,
            anchorId: firstSection.anchors[0] || null,
            title: firstSection.titleEn,
            pdfPage: firstSection.pdfPage || null,
        };
    }
}
