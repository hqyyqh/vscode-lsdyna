'use strict';

const fs = require('fs');
const { throwIfCancellationRequested } = require('./scannerContracts');

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
        return bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
        if (!options.handle) await handle.close();
    }
}

async function readBlockText(block, encoding: BufferEncoding = 'utf8', options = {}) {
    const buffer = await readBlockBuffer(block, options);
    return buffer.toString(encoding);
}

module.exports = {
    readBlockBuffer,
    readBlockText,
};

export {};
