'use strict';

/**
 * Pure helpers for the manual Activity Bar TOC.
 * Chapters are aggregated from pack paths:
 *   documents/.../chunks/<chapterKey>/...
 * so the sidebar can render volume → chapter → section instead of a flat list.
 */

export interface SidebarSectionLike {
    sectionId: string;
    titleEn: string;
    pathEn: string;
    level?: number;
}

export interface ChapterGroup<T extends SidebarSectionLike = SidebarSectionLike> {
    key: string;
    label: string;
    sections: T[];
}

/** Fallback bucket when pathEn has no /chunks/<dir>/ segment. */
export const ROOT_CHAPTER_KEY = '_root';

/**
 * Extract chapter directory from a pack-relative pathEn.
 * Examples:
 *   documents/en/vol-i/chunks/12_contact/12_08_....md → 12_contact
 *   documents/en/vol-i/chunks/node.md → _root (file directly under chunks)
 */
export function chapterKeyFromPath(pathEn: string): string {
    const normalized = (pathEn || '').replace(/\\/g, '/');
    const match = normalized.match(/\/chunks\/([^/]+)\//);
    if (match) return match[1];
    // File directly under chunks/ with no subdirectory
    if (/\/chunks\/[^/]+\.md$/i.test(normalized)) return ROOT_CHAPTER_KEY;
    return ROOT_CHAPTER_KEY;
}

/** Humanize folder keys like 12_contact → 12 Contact. */
export function prettifyChapterKey(key: string): string {
    if (!key || key === ROOT_CHAPTER_KEY) return 'Sections';
    return key
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b[a-z]/g, ch => ch.toUpperCase());
}

/**
 * Prefer the first section's English title (e.g. *CONTACT); otherwise prettify the key.
 */
export function chapterLabel(key: string, sections: SidebarSectionLike[]): string {
    const first = sections[0];
    const title = (first?.titleEn || '').trim();
    if (title) return title;
    return prettifyChapterKey(key);
}

/**
 * Group sections into chapters, preserving first-seen chapter order and
 * repository order within each chapter.
 */
export function buildChapterGroups<T extends SidebarSectionLike>(sections: T[]): ChapterGroup<T>[] {
    const order: string[] = [];
    const map = new Map<string, T[]>();
    for (const section of sections) {
        const key = chapterKeyFromPath(section.pathEn);
        if (!map.has(key)) {
            map.set(key, []);
            order.push(key);
        }
        map.get(key)!.push(section);
    }
    return order.map(key => {
        const groupSections = map.get(key)!;
        return {
            key,
            label: chapterLabel(key, groupSections),
            sections: groupSections,
        };
    });
}

/** Locate which chapter contains a section id (for expand-path). */
export function findChapterKeyForSection<T extends SidebarSectionLike>(
    groups: ChapterGroup<T>[],
    sectionId: string,
): string | null {
    for (const group of groups) {
        if (group.sections.some(section => section.sectionId === sectionId)) {
            return group.key;
        }
    }
    return null;
}
