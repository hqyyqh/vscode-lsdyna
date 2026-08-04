'use strict';

/**
 * Pure helpers for Manual Reader toolbar identity (volume · chapter).
 * Reuses the same chapter grouping rules as the Activity Bar TOC.
 */

import type { ManualLocation } from './manualTypes';
import type { ReaderChromeIdentity } from './readerProtocol';
import {
    buildChapterGroups,
    findChapterKeyForSection,
    type SidebarSectionLike,
} from './manualSidebarTree';

export interface ChromeDocumentLike {
    manualId: string;
    title: string;
}

/**
 * Build toolbar chrome identity from pack documents + sections for the active location.
 */
export function readerChromeIdentity(
    documents: ChromeDocumentLike[],
    sections: SidebarSectionLike[],
    location: Pick<ManualLocation, 'manualId' | 'sectionId'>,
): ReaderChromeIdentity {
    const volume = documents.find(doc => doc.manualId === location.manualId);
    const volumeTitle = (volume?.title || location.manualId || '').trim() || location.manualId;
    const groups = buildChapterGroups(sections);
    const chapterKey = findChapterKeyForSection(groups, location.sectionId);
    const group = chapterKey ? groups.find(g => g.key === chapterKey) : undefined;
    const chapterLabel = (group?.label || '').trim();
    return {
        volumeTitle,
        chapterLabel,
        chapterKey,
    };
}

/** Crumb line for the toolbar: "Volume · Chapter" or volume alone. */
export function formatReaderChromeCrumb(chrome: ReaderChromeIdentity): string {
    const volume = (chrome.volumeTitle || '').trim();
    const chapter = (chrome.chapterLabel || '').trim();
    if (volume && chapter) return `${volume} · ${chapter}`;
    return volume || chapter;
}
