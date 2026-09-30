'use strict';

import * as fs from 'node:fs';
const { throwIfCancellationRequested } = require('./scannerContracts');

export type LargeFileLineMap = {
    stride: 4096;
    offsets: number[];
    lineCount: number;
};

export type LargeFileSignature = { size: number; mtimeMs: number };
export type LargeFileWindowLine = {
    lineNumber: number;
    text: string;
    truncated: boolean;
};

export const LARGE_FILE_THRESHOLD_BYTES = 50 * 1024 * 1024;
export const LARGE_FILE_WINDOW_LINES = 240;
export const LARGE_FILE_WINDOW_MAX_BYTES = 2 * 1024 * 1024;
export const LARGE_FILE_LINE_MAX_BYTES = 64 * 1024;

type CancellationToken = { isCancellationRequested?: boolean };

function sameSignature(left: LargeFileSignature, right: LargeFileSignature): boolean {
    return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function signature(filePath: string): Promise<LargeFileSignature> {
    const value = await fs.promises.stat(filePath);
    return { size: value.size, mtimeMs: value.mtimeMs };
}

async function scanPhysicalLines(
    filePath: string,
    startOffset: number,
    startLine: number,
    accept: (line: Buffer, lineNumber: number, truncated: boolean) => boolean,
    options: { cancellationToken?: CancellationToken; maxLineBytes: number; isCurrent?: () => boolean },
): Promise<void> {
    const stream = fs.createReadStream(filePath, {
        start: Math.max(0, startOffset),
        highWaterMark: 128 * 1024,
    });
    let parts: Buffer[] = [];
    let partBytes = 0;
    let lineTruncated = false;
    let lineNumber = startLine;
    let stopped = false;

    const append = (value: Buffer) => {
        if (value.length === 0) return;
        const remaining = Math.max(0, options.maxLineBytes - partBytes);
        if (remaining > 0) {
            const slice = value.subarray(0, remaining);
            parts.push(slice);
            partBytes += slice.length;
        }
        if (value.length > remaining) lineTruncated = true;
    };
    const finishLine = () => {
        let line = partBytes === 0 ? Buffer.alloc(0) : Buffer.concat(parts, partBytes);
        if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        if (lineNumber === 0 && line.length >= 3 &&
            line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) {
            line = line.subarray(3);
        }
        const keepGoing = accept(line, lineNumber, lineTruncated);
        lineNumber++;
        parts = [];
        partBytes = 0;
        lineTruncated = false;
        if (!keepGoing) {
            stopped = true;
            stream.destroy();
        }
    };

    try {
        for await (const rawChunk of stream) {
            throwIfCancellationRequested(options.cancellationToken);
            if (options.isCurrent && !options.isCurrent()) {
                stream.destroy();
                break;
            }
            const chunk = rawChunk as Buffer;
            let cursor = 0;
            while (!stopped) {
                const newline = chunk.indexOf(0x0a, cursor);
                if (newline < 0) {
                    append(chunk.subarray(cursor));
                    break;
                }
                append(chunk.subarray(cursor, newline));
                finishLine();
                cursor = newline + 1;
            }
            if (stopped) break;
        }
        if (!stopped && (partBytes > 0 || lineTruncated)) finishLine();
    } finally {
        stream.destroy();
    }
}

export async function readLargeFileWindow(
    filePath: string,
    lineMap: LargeFileLineMap | null,
    anchorLine: number,
    options: {
        expectedSignature?: LargeFileSignature;
        cancellationToken?: CancellationToken;
        maxLines?: number;
        maxBytes?: number;
    } = {},
): Promise<{
    anchorLine: number;
    lines: LargeFileWindowLine[];
    lineCount?: number;
    signature: LargeFileSignature;
    stale: boolean;
}> {
    throwIfCancellationRequested(options.cancellationToken);
    const before = await signature(filePath);
    if (options.expectedSignature && !sameSignature(before, options.expectedSignature)) {
        return { anchorLine, lines: [], lineCount: lineMap?.lineCount, signature: before, stale: true };
    }
    const knownCount = Number.isSafeInteger(lineMap?.lineCount) ? Number(lineMap!.lineCount) : undefined;
    const requested = Math.max(0, Math.floor(Number(anchorLine) || 0));
    const targetLine = knownCount === undefined
        ? 0
        : Math.min(requested, Math.max(0, knownCount - 1));
    const checkpoint = lineMap
        ? Math.min(Math.floor(targetLine / lineMap.stride), Math.max(0, lineMap.offsets.length - 1))
        : 0;
    const startOffset = lineMap?.offsets[checkpoint] || 0;
    const startLine = lineMap ? checkpoint * lineMap.stride : 0;
    const lines: LargeFileWindowLine[] = [];
    const maxLines = Math.max(1, Math.min(300, options.maxLines || LARGE_FILE_WINDOW_LINES));
    const maxBytes = Math.max(1, Math.min(LARGE_FILE_WINDOW_MAX_BYTES,
        options.maxBytes || LARGE_FILE_WINDOW_MAX_BYTES));
    let decodedBytes = 0;

    await scanPhysicalLines(filePath, startOffset, startLine, (buffer, lineNumber, truncated) => {
        if (lineNumber < targetLine) return true;
        if (lines.length >= maxLines) return false;
        const nextBytes = buffer.length;
        if (lines.length > 0 && decodedBytes + nextBytes > maxBytes) return false;
        lines.push({ lineNumber, text: buffer.toString('utf8'), truncated });
        decodedBytes += nextBytes;
        return lines.length < maxLines && decodedBytes < maxBytes;
    }, {
        cancellationToken: options.cancellationToken,
        maxLineBytes: LARGE_FILE_LINE_MAX_BYTES,
    });

    throwIfCancellationRequested(options.cancellationToken);
    const after = await signature(filePath);
    return {
        anchorLine: targetLine,
        lines,
        lineCount: knownCount,
        signature: after,
        stale: !sameSignature(before, after),
    };
}

export async function searchLargeFileLiteral(
    filePath: string,
    query: string,
    options: {
        expectedSignature?: LargeFileSignature;
        cancellationToken?: CancellationToken;
        limit?: number;
        isCurrent?: () => boolean;
    } = {},
): Promise<{
    matches: Array<{ lineNumber: number; preview: string }>;
    truncated: boolean;
    signature: LargeFileSignature;
    stale: boolean;
}> {
    const needle = String(query || '').toLocaleLowerCase();
    if (!needle) throw new TypeError('search query must not be empty');
    const before = await signature(filePath);
    if (options.expectedSignature && !sameSignature(before, options.expectedSignature)) {
        return { matches: [], truncated: false, signature: before, stale: true };
    }
    const limit = Math.max(1, Math.min(500, options.limit || 500));
    const matches: Array<{ lineNumber: number; preview: string }> = [];
    let truncated = false;
    await scanPhysicalLines(filePath, 0, 0, (buffer, lineNumber) => {
        if (options.isCurrent && !options.isCurrent()) return false;
        const text = buffer.toString('utf8');
        if (!text.toLocaleLowerCase().includes(needle)) return true;
        if (matches.length >= limit) {
            truncated = true;
            return false;
        }
        matches.push({ lineNumber, preview: text.slice(0, 240) });
        return true;
    }, {
        cancellationToken: options.cancellationToken,
        maxLineBytes: LARGE_FILE_WINDOW_MAX_BYTES,
        isCurrent: options.isCurrent,
    });
    const after = await signature(filePath);
    return { matches, truncated, signature: after, stale: !sameSignature(before, after) };
}

export const __test = { sameSignature };
