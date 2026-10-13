/** Limits include room for the JSON-RPC / worker envelope. */
export const INDEX_PROTOCOL_VERSION = 1;
export const INDEX_MESSAGE_BYTES = 1024 * 1024;
export const INDEX_PAYLOAD_BYTES = INDEX_MESSAGE_BYTES - 4096;
export const INDEX_PAGE_ROWS = 200;

/** Reject large records before JSON.stringify can allocate a large string. */
export function indexJsonBytes(value: any, limit = INDEX_PAYLOAD_BYTES): number {
    let bytes = 0;
    const seen = new Set<object>();
    const add = (count: number) => {
        bytes += count;
        if (bytes > limit) throw new RangeError('Index record exceeds transport budget');
    };
    const string = (text: string) => {
        add(2);
        // JSON escapes control characters, quotes and backslashes; lone surrogates use six bytes.
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) add(2);
            else if (c < 32) add(6);
            else if (c < 128) add(1);
            else if (c < 2048) add(2);
            else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length &&
                text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { add(4); i++; }
            else if (c >= 0xd800 && c <= 0xdfff) add(6);
            else add(3);
        }
    };
    const visit = (item: any) => {
        if (item === null || item === undefined) { add(4); return; }
        if (typeof item === 'string') { string(item); return; }
        if (typeof item === 'number' || typeof item === 'boolean') { add(JSON.stringify(item).length); return; }
        if (typeof item !== 'object' || seen.has(item)) throw new TypeError('Invalid index record');
        seen.add(item);
        add(2);
        let count = 0;
        if (Array.isArray(item)) {
            for (const child of item) { if (count++) add(1); visit(child); }
        } else {
            for (const key of Object.keys(item)) {
                if (item[key] === undefined) continue;
                if (count++) add(1);
                string(key); add(1); visit(item[key]);
            }
        }
        seen.delete(item);
    };
    visit(value);
    return bytes;
}

export function assertIndexPayload<T>(value: T): T {
    indexJsonBytes(value);
    return value;
}

export function boundedIndexPage<T>(rows: Iterable<T>, header: any): T[] {
    let bytes = indexJsonBytes({ ...header, rows: [] });
    const page: T[] = [];
    for (const row of rows) {
        const size = indexJsonBytes(row);
        if (size + bytes + 1 > INDEX_PAYLOAD_BYTES) {
            if (!page.length) throw new RangeError('Index record exceeds page budget');
            break;
        }
        page.push(row); bytes += size + 1;
        if (page.length === INDEX_PAGE_ROWS) break;
    }
    return page;
}
