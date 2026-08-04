/**
 * Short-lived in-memory stash for long English field-help text shown via hover command links.
 * Avoids stuffing full help into command: URI query strings.
 *
 * @module core/hover/fieldHelpEnglishStore
 */

import { randomBytes } from 'crypto';

export const FIELD_HELP_ENGLISH_STORE_MAX = 32;

type Entry = {
    text: string;
    ts: number;
};

const store = new Map<string, Entry>();
/** Monotonic sequence so same-ms inserts still evict FIFO. */
let seq = 0;

function evictIfNeeded(): void {
    while (store.size > FIELD_HELP_ENGLISH_STORE_MAX) {
        let oldestId: string | null = null;
        let oldestTs = Infinity;
        for (const [id, entry] of store) {
            if (entry.ts < oldestTs) {
                oldestTs = entry.ts;
                oldestId = id;
            }
        }
        if (!oldestId) {
            break;
        }
        store.delete(oldestId);
    }
}

/**
 * Store English help text and return an opaque id for command args.
 */
export function stashFieldHelpEnglish(text: string): string {
    const body = String(text ?? '');
    const id = randomBytes(8).toString('hex');
    seq += 1;
    store.set(id, { text: body, ts: seq });
    evictIfNeeded();
    return id;
}

/**
 * Read stashed text by id (does not remove; allows multi-click).
 */
export function getFieldHelpEnglish(id: string): string | undefined {
    if (id == null || id === '') {
        return undefined;
    }
    const entry = store.get(String(id));
    return entry ? entry.text : undefined;
}

/** Test / dispose helper. */
export function clearFieldHelpEnglishStore(): void {
    store.clear();
}

/** Test helper: current entry count. */
export function fieldHelpEnglishStoreSize(): number {
    return store.size;
}

module.exports = {
    FIELD_HELP_ENGLISH_STORE_MAX,
    stashFieldHelpEnglish,
    getFieldHelpEnglish,
    clearFieldHelpEnglishStore,
    fieldHelpEnglishStoreSize,
};
