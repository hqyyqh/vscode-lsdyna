'use strict';

/** Shared lifecycle and persisted reader state for one manual pack. */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ManualIndexRepository, ManualLanguage, ManualLocation } from './ManualIndexRepository';
const i18n = require('../core/i18n');

export interface PersistedReaderState {
    manifestIdentity: string;
    location: ManualLocation;
    language: ManualLanguage;
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
    private manifestMtime = -1;
    private repository: ManualIndexRepository | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {}

    hasPack(packRoot: string): boolean {
        return fs.existsSync(path.join(packRoot, 'manifest.json'))
            && fs.existsSync(path.join(packRoot, 'indexes'));
    }

    getRepository(packRoot: string): ManualIndexRepository {
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
        }
        return this.repository;
    }

    invalidate(): void {
        this.root = '';
        this.manifestMtime = -1;
        this.repository = undefined;
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
        if (!saved || !saved.location || !repository.getSection(saved.location.manualId, saved.location.sectionId)) {
            return undefined;
        }
        const caps = repository.getCapabilities();
        const language = !caps.canToggleLanguage || saved.language === 'en' ? 'en' : 'zh';
        return {
            manifestIdentity: repository.getManifestIdentity(),
            location: saved.location,
            language,
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
