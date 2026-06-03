'use strict';

const TITLE_SUFFIXES = [
    '_ID_HEADING',
    '_ID_TITLE',
    '_TITLE',
    '_HEADING',
    '_ID',
    '_BLANK'
];

/**
 * Checks if the keyword name ends with any of the title-related suffixes.
 * @param {string} kwName The keyword name (uppercase recommended).
 * @returns {boolean} True if it has a title suffix.
 */
function hasTitleSuffix(kwName) {
    return TITLE_SUFFIXES.some(s => kwName.endsWith(s));
}

/**
 * Strips the title-related suffix from the keyword name if present.
 * @param {string} kwName The keyword name.
 * @returns {string} The stripped keyword name.
 */
function stripTitleSuffix(kwName) {
    for (const s of TITLE_SUFFIXES) {
        if (kwName.endsWith(s)) {
            return kwName.substring(0, kwName.length - s.length);
        }
    }
    return kwName;
}

module.exports = {
    TITLE_SUFFIXES,
    hasTitleSuffix,
    stripTitleSuffix
};
