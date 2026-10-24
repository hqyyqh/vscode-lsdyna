
// Approximate retained memory, counting shared objects once. Stop work at the
// cache budget: oversized entries are never admitted and need no exact size.
function estimateMemorySize(value, budget = 48 * 1024 * 1024,
    accounting = { seen: new WeakSet<object>(), strings: new Set<string>() }) {
    const { seen, strings } = accounting;
    const pending = [value];
    let bytes = 0;
    while (pending.length) {
        const item = pending.pop();
        if (typeof item === 'string') {
            bytes += 8;
            if (!strings.has(item)) { strings.add(item); bytes += 16 + item.length * 2; }
        }
        else if (item && typeof item === 'object' && !seen.has(item)) {
            seen.add(item);
            bytes += 32;
            if (ArrayBuffer.isView(item)) bytes += item.byteLength;
            else if (item instanceof Map) {
                bytes += item.size * 32;
                for (const [key, entry] of item) pending.push(key, entry);
            } else if (item instanceof Set) {
                bytes += item.size * 16;
                for (const entry of item) pending.push(entry);
            } else {
                for (const key of Object.keys(item)) {
                    bytes += 8;
                    pending.push(item[key]);
                }
            }
        } else bytes += 8;
        if (bytes > budget) return Number.POSITIVE_INFINITY;
    }
    return bytes;
}
module.exports = { estimateMemorySize };
export {};
