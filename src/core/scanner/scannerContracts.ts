'use strict';

const SCANNER_VERSION = 2;

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
