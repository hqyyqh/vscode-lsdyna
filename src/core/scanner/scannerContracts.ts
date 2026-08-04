'use strict';

// Increment whenever the persisted file-index shape or scanner semantics change.
const SCANNER_VERSION = 6;

function isNodeKeyword(keyword) {
    return keyword === '*NODE' || keyword.startsWith('*NODE_');
}

function isElementKeyword(keyword) {
    return keyword === '*ELEMENT' || keyword.startsWith('*ELEMENT_');
}

module.exports = {
    SCANNER_VERSION,
    isNodeKeyword,
    isElementKeyword,
};

export {};
