'use strict';

// Increment whenever the persisted file-index shape or scanner semantics change.
const SCANNER_VERSION = 61;

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

function isMeshKeyword(keyword) {
    const token = String(keyword).toUpperCase().replace(/[+%\-]$/, '');
    return isNodeKeyword(token) || isElementKeyword(token);
}

function isMeshEntityKind(kind) {
    return kind === 'node' || kind === 'element' || String(kind).startsWith('element-');
}

function isNodeKeyword(keyword) {
    return keyword === '*NODE' || keyword.startsWith('*NODE_');
}

function isElementKeyword(keyword) {
    return keyword === '*ELEMENT' || keyword.startsWith('*ELEMENT_');
}

module.exports = {
    SCANNER_VERSION,
    isMeshEntityKind,
    isMeshKeyword,
    createCancellationError,
    throwIfCancellationRequested,
    isNodeKeyword,
    isElementKeyword,
};

export {};
