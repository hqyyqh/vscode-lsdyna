const fs = require('fs');
const path = require('path');

const COUNT_BUFFER_BYTES = 1024 * 1024;
const BOUNDARY_BUFFER_BYTES = 64 * 1024;
const MAX_CACHE_ENTRIES = 128;
const tailWindowCache = new Map<string, { startOffset: number; startLineIndex: number }>();

function cacheKey(filePath: string, fileStat: { size: number; mtimeMs: number }, tailBytes: number): string {
    return `${path.resolve(filePath)}\0${fileStat.size}\0${fileStat.mtimeMs}\0${tailBytes}`;
}

async function advanceToCompleteLine(fileHandle, initialOffset: number, fileSize: number): Promise<number> {
    if (initialOffset <= 0) return 0;
    let position = initialOffset;
    const buffer = Buffer.allocUnsafe(BOUNDARY_BUFFER_BYTES);
    while (position < fileSize) {
        const length = Math.min(buffer.length, fileSize - position);
        const { bytesRead } = await fileHandle.read(buffer, 0, length, position);
        if (bytesRead === 0) break;
        const newline = buffer.indexOf(0x0a, 0);
        if (newline !== -1 && newline < bytesRead) return position + newline + 1;
        position += bytesRead;
    }
    return fileSize;
}

async function countLinesBefore(fileHandle, endOffset: number): Promise<number> {
    const buffer = Buffer.allocUnsafe(COUNT_BUFFER_BYTES);
    let position = 0;
    let lines = 0;
    while (position < endOffset) {
        const length = Math.min(buffer.length, endOffset - position);
        const { bytesRead } = await fileHandle.read(buffer, 0, length, position);
        if (bytesRead === 0) break;
        for (let index = 0; index < bytesRead; index++) {
            if (buffer[index] === 0x0a) lines++;
        }
        position += bytesRead;
    }
    return lines;
}

export async function locateTailWindow(
    filePath: string,
    fileStat: { size: number; mtimeMs: number },
    tailBytes = 200 * 1024
): Promise<{ startOffset: number; startLineIndex: number }> {
    const key = cacheKey(filePath, fileStat, tailBytes);
    const cached = tailWindowCache.get(key);
    if (cached) return cached;

    const fileHandle = await fs.promises.open(filePath, 'r');
    try {
        const initialOffset = Math.max(0, fileStat.size - Math.max(0, tailBytes));
        const startOffset = await advanceToCompleteLine(fileHandle, initialOffset, fileStat.size);
        const startLineIndex = await countLinesBefore(fileHandle, startOffset);
        const result = { startOffset, startLineIndex };
        tailWindowCache.set(key, result);
        if (tailWindowCache.size > MAX_CACHE_ENTRIES) {
            tailWindowCache.delete(tailWindowCache.keys().next().value);
        }
        return result;
    } finally {
        await fileHandle.close();
    }
}
