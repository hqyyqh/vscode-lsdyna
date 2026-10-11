'use strict';

const fs = require('fs');
const { throwIfCancellationRequested } = require('./scannerContracts');

// One scan owns this bounded window; source revisions are checked before publication.
function createBlockReadWindow(handle, windowBytes = 64 * 1024) {
    const window = Buffer.alloc(windowBytes);
    let start = -1, length = 0;
    return { async read(buffer, offset, size, position) {
        if (size > windowBytes) return handle.read(buffer, offset, size, position);
        if (position < start || position + size > start + length) {
            const result = await handle.read(window, 0, windowBytes, position);
            start = position; length = result.bytesRead;
        }
        const bytesRead = Math.max(0, Math.min(size, start + length - position));
        if (bytesRead) window.copy(buffer, offset, position - start, position - start + bytesRead);
        return { bytesRead, buffer };
    } };
}

async function readBlockBuffer(block, options: {
    cancellationToken?: { isCancellationRequested?: boolean };
    handle?: any;
    maxBytes?: number;
    chunkBytes?: number;
    onTruncated?: (details: { totalBytes: number, readBytes: number }) => void;
} = {}) {
    const totalBytes = Math.max(0, block.endOffset - block.startOffset);
    const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes >= 0
        ? Math.floor(options.maxBytes)
        : totalBytes;
    const length = Math.min(totalBytes, maxBytes);
    const chunkBytes = Number.isFinite(options.chunkBytes) && options.chunkBytes > 0
        ? Math.floor(options.chunkBytes)
        : 1024 * 1024;
    throwIfCancellationRequested(options.cancellationToken);
    const handle = options.handle || await fs.promises.open(block.filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        let bytesRead = 0;
        while (bytesRead < length) {
            throwIfCancellationRequested(options.cancellationToken);
            const nextLength = Math.min(chunkBytes, length - bytesRead);
            const result = await handle.read(
                buffer,
                bytesRead,
                nextLength,
                block.startOffset + bytesRead,
            );
            if (!result.bytesRead) {
                const error = new Error('Keyword block changed while reading: unexpected end of file');
                error.name = 'ScanChangedError';
                throw error;
            }
            bytesRead += result.bytesRead;
        }
        throwIfCancellationRequested(options.cancellationToken);
        if (length < totalBytes && typeof options.onTruncated === 'function') {
            options.onTruncated({ totalBytes, readBytes: bytesRead });
        }
        return buffer;
    } finally {
        if (!options.handle) await handle.close();
    }
}

async function readBlockText(block, encoding: BufferEncoding = 'utf8', options = {}) {
    const buffer = await readBlockBuffer(block, options);
    return buffer.toString(encoding);
}

// Definition selectors need only their header, not every member of a large set.
async function readBlockHeaderText(block, dataRecords, options: any = {}) {
    const total = Math.max(0, block.endOffset - block.startOffset);
    const cap = Number.isFinite(options.maxBytes) && options.maxBytes >= 0
        ? Math.min(total, Math.floor(options.maxBytes)) : total;
    let length = Math.min(cap, 4096);
    for (;;) {
        const text = await readBlockText(block, 'utf8', { ...options, maxBytes: length, onTruncated: undefined });
        const lines = text.split(/\r\n|\r|\n/);
        let seen = 0, prefix = lines[0];
        for (let i = 1; i < lines.length; i++) {
            if (i === lines.length - 1 && length < total) break;
            prefix += '\n' + lines[i];
            const value = lines[i].trim();
            if (value.startsWith('*')) break;
            if (value && !value.startsWith('$') && ++seen >= dataRecords) return prefix;
        }
        if (length >= cap) {
            if (length < total) options.onTruncated?.({ totalBytes: total, readBytes: length });
            return text;
        }
        length = Math.min(cap, length * 2);
    }
}

module.exports = {
    createBlockReadWindow,
    readBlockBuffer,
    readBlockText,
    readBlockHeaderText,
};

export {};
