'use strict';

// Increment whenever the persisted file-index shape or scanner semantics change.
const SCANNER_VERSION = 16;

function createCancellationError(message = 'Operation cancelled') {
    const error = new Error(message);
    error.name = 'CancellationError';
    return error;
}

function throwIfCancellationRequested(cancellationToken) {
    if (cancellationToken?.isCancellationRequested === true) {
        throw createCancellationError();
    }
}

function isNodeKeyword(keyword) {
    return keyword === '*NODE' || keyword.startsWith('*NODE_');
}

function isElementKeyword(keyword) {
    return keyword === '*ELEMENT' || keyword.startsWith('*ELEMENT_');
}

module.exports = {
    SCANNER_VERSION,
    createCancellationError,
    throwIfCancellationRequested,
    isNodeKeyword,
    isElementKeyword,
};

export {};
