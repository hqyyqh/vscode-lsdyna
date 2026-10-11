/** One managed budget shared by host caches, result pages and the query worker. */
export function entityIndexBudget(memoryMiB: unknown = 512, diskMiB: unknown = 4096) {
    const bounded = (value: unknown, fallback: number, min: number, max: number) =>
        typeof value === 'number' && Number.isFinite(value)
            ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
    const memoryBytes = bounded(memoryMiB, 512, 128, 4096) * 1024 ** 2;
    return {
        memoryBytes,
        hostBytes: memoryBytes * 24 / 64,
        liveBytes: memoryBytes * 7 / 64,
        resultBytes: memoryBytes / 64,
        workerBytes: memoryBytes / 2,
        diskBytes: bounded(diskMiB, 4096, 128, 65536) * 1024 ** 2,
    };
}
