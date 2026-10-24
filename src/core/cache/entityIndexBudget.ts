/** One managed budget shared by host caches, result pages and the query worker. */
export function entityIndexBudget(memoryMiB: unknown = 'auto', diskMiB: unknown = 4096,
    memory = { available: () => typeof process.availableMemory === 'function' ? process.availableMemory() : undefined,
        free: () => require('node:os').freemem(), total: () => require('node:os').totalmem() }) {
    const bounded = (value: unknown, fallback: number, min: number, max: number) =>
        typeof value === 'number' && Number.isFinite(value)
            ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
    const manual = typeof memoryMiB === 'number' && Number.isFinite(memoryMiB);
    const read = (fn: () => unknown) => { try {
        const value = fn();
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    } catch { return undefined; } };
    const available = manual ? undefined : read(memory.available);
    const availableBytes = manual ? undefined : available ?? read(memory.free);
    const totalBytes = manual ? undefined : read(memory.total);
    const calculatedBytes = manual ? bounded(memoryMiB, 512, 128, 4096) * 1024 ** 2
        : Math.floor(Math.min((availableBytes ?? 0) / 10, (totalBytes ?? 0) / 20, 2 * 1024 ** 3) / 1024 ** 2) * 1024 ** 2;
    const blocked = calculatedBytes < 128 * 1024 ** 2;
    const memoryBytes = blocked ? 0 : calculatedBytes;
    return Object.freeze({
        mode: manual ? 'manual' : 'auto', blocked, calculatedBytes, availableBytes, totalBytes,
        memorySource: manual ? 'manual' : available !== undefined ? 'process.availableMemory' : 'os.freemem',
        memoryBytes,
        hostBytes: memoryBytes * 24 / 64,
        liveBytes: memoryBytes * 7 / 64,
        resultBytes: memoryBytes / 64,
        workerBytes: memoryBytes / 2,
        diskBytes: bounded(diskMiB, 4096, 128, 65536) * 1024 ** 2,
    });
}
