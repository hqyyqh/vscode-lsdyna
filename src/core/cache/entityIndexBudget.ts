// Older Darwin libuv counts only free pages; match libuv 1.52's reclaimable-page estimate.
const legacyDarwin = process.platform === 'darwin' && /^1\.(\d+)\./.test(process.versions.uv)
    && Number(process.versions.uv.split('.')[1]) < 52;
function darwinAvailableMemory(): number | undefined {
    const output: string = require('node:child_process').execFileSync('/usr/bin/vm_stat', [], {
        encoding: 'utf8', timeout: 1000, maxBuffer: 65536, env: { ...process.env, LC_ALL: 'C' },
    });
    const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
    const counts = ['free', 'inactive', 'purgeable'].map(name =>
        Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.\\s*$`, 'm').exec(output)?.[1]));
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || counts.some(n => !Number.isSafeInteger(n) || n < 0)) return undefined;
    const bytes = counts.reduce((sum, n) => sum + n, 0) * pageSize;
    return Number.isSafeInteger(bytes) ? bytes : undefined;
}

/** One managed budget shared by host caches, result pages and the query worker. */
export function entityIndexBudget(memoryMiB: unknown = 'auto', diskMiB: unknown = 4096,
    memory: { available: () => unknown; free: () => unknown; total: () => unknown; availableSource?: string } = {
        available: () => legacyDarwin ? darwinAvailableMemory()
            : typeof process.availableMemory === 'function' ? process.availableMemory() : undefined,
        availableSource: legacyDarwin ? 'macOS vm_stat' : 'process.availableMemory',
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
        memorySource: manual ? 'manual' : available !== undefined ? memory.availableSource ?? 'process.availableMemory' : 'os.freemem',
        memoryBytes,
        hostBytes: memoryBytes * 24 / 64,
        liveBytes: memoryBytes * 7 / 64,
        resultBytes: memoryBytes / 64,
        workerBytes: memoryBytes / 2,
        diskBytes: bounded(diskMiB, 4096, 128, 65536) * 1024 ** 2,
    });
}
