'use strict';

const fs = require('fs');

async function readBlockBuffer(block) {
    const length = Math.max(0, block.endOffset - block.startOffset);
    const handle = await fs.promises.open(block.filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, block.startOffset);
        return buffer;
    } finally {
        await handle.close();
    }
}

async function readBlockText(block, encoding: BufferEncoding = 'utf8') {
    const buffer = await readBlockBuffer(block);
    return buffer.toString(encoding);
}

module.exports = {
    readBlockBuffer,
    readBlockText,
};

export {};
