const vscode = require('vscode');
const i18n = require('../i18n');
const { getAliases } = require('../keywordUtils');
const keywordSchema = require('../keywordSchema');
const { classifyKeywordLine } = require('./keywordLine');

let validKeywords = new Set();
let isInitialized = false;
const DEFAULT_CUSTOM_VALID_KEYWORDS = ['*END', '*TITLE', '*CASE_BEGIN', '*CASE_END'];

function init(validKeywordsSet) {
    validKeywords = validKeywordsSet;
    isInitialized = true;
}

function normalizeKeyword(keyword) {
    let normalized = keyword.toUpperCase().trim();
    if (normalized.startsWith('*')) normalized = normalized.substring(1);
    return normalized;
}

function getValidationSchema() {
    try {
        return keywordSchema.loadKeywordSchema(() => 'en') || {};
    } catch (err) {
        return {};
    }
}

function customKeywordMatches(keyword, customValidKeywords) {
    if (customValidKeywords.has(keyword)) return true;
    for (const customKeyword of customValidKeywords) {
        if (customKeyword.endsWith('*')) {
            const prefix = customKeyword.substring(0, customKeyword.length - 1);
            if (keyword.startsWith(prefix)) return true;
        }
    }
    return false;
}

function builtInKeywordMatches(keyword, schema) {
    if (/^CASE_(BEGIN|END)_\d+$/.test(keyword)) return true;
    if (validKeywords.has(keyword) || schema[keyword]) return true;
    for (const alias of getAliases(keyword)) {
        if (validKeywords.has(alias) || schema[alias]) return true;
    }
    return false;
}

/**
 * Line index of the first `*END` directive (LS-DYNA stops reading input there).
 * Returns document.lineCount when no `*END` is present, so callers can use it as an
 * exclusive scan upper bound unconditionally.
 *
 * Strict column 1: `*END` must be a keyword at indent 0 (an indented `*END` is data,
 * not the terminator). `*END` itself is a valid keyword and stays inside the scanned
 * range; only lines after it are skipped.
 *
 * @param {import('vscode').TextDocument} document
 * @returns {number}
 */
function findEndDirectiveLine(document) {
    if (!document || typeof document.lineCount !== 'number') return 0;
    for (let i = 0; i < document.lineCount; i++) {
        const classification = classifyKeywordLine(document.lineAt(i).text);
        if (classification.isKeyword && classification.indent === 0
            && classification.normalizedKeyword === '*END') {
            return i;
        }
    }
    return document.lineCount;
}

/**
 * Normalize lsdyna.unknownKeywordSeverity config value.
 * @param {any} value
 * @returns {'error'|'warning'|'hint'|'off'}
 */
function normalizeUnknownKeywordSeverity(value) {
    const mode = String(value || 'error').toLowerCase();
    if (mode === 'warning' || mode === 'hint' || mode === 'off' || mode === 'error') {
        return mode;
    }
    return 'error';
}

/**
 * Map severity mode to vscode.DiagnosticSeverity, or null when off.
 * @param {any} value
 * @returns {number|null}
 */
function resolveUnknownKeywordSeverity(value) {
    const mode = normalizeUnknownKeywordSeverity(value);
    if (mode === 'off') return null;
    if (mode === 'warning') return vscode.DiagnosticSeverity.Warning;
    if (mode === 'hint') return vscode.DiagnosticSeverity.Hint;
    return vscode.DiagnosticSeverity.Error;
}

/**
 * Validates keywords in the given document and generates diagnostics.
 * @param {import('vscode').TextDocument} document 
 * @param {function} shouldSkipAutomaticDocumentScan 
 * @returns {import('vscode').Diagnostic[]}
 */
function collectKeywordValidationDiagnostics(document, shouldSkipAutomaticDocumentScan) {
    if (!isInitialized || validKeywords.size === 0) return [];
    if (shouldSkipAutomaticDocumentScan && shouldSkipAutomaticDocumentScan(document)) return [];
    
    const diagnostics = [];
    const config = vscode.workspace.getConfiguration('lsdyna', document.uri);
    const customValidKeywordsConfig: string[] = config && typeof config.get === 'function'
        ? config.get('customValidKeywords') || DEFAULT_CUSTOM_VALID_KEYWORDS
        : DEFAULT_CUSTOM_VALID_KEYWORDS;
    const customValidKeywords = new Set(customValidKeywordsConfig.map(normalizeKeyword));
    const unknownSeverity = resolveUnknownKeywordSeverity(
        config && typeof config.get === 'function'
            ? config.get('unknownKeywordSeverity', 'error')
            : 'error'
    );
    // LS-DYNA is case-insensitive for keywords, so lowercase (e.g. *node) is legal.
    // Some pre-processors emit lowercase decks; only warn when a team opts in to an
    // uppercase house style. Default off to avoid a warning on every keyword line.
    const warnLowercase = config && typeof config.get === 'function'
        ? config.get('warnLowercaseKeyword', false) === true
        : false;
    const schema = getValidationSchema();

    // LS-DYNA stops reading input at *END; scratch keywords, retired includes and
    // notes are routinely parked after it. Validate through the *END line itself but
    // not beyond, so that content never produces unknown-keyword false positives.
    const scanUpperBound = Math.min(document.lineCount, findEndDirectiveLine(document) + 1);

    for (let i = 0; i < scanUpperBound; i++) {
        const line = document.lineAt(i);
        const classification = classifyKeywordLine(line.text);
        if (!classification.isKeyword) continue;
        
        if (classification.rawKeyword.startsWith('**')) {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(i, 0, i, line.text.length),
                i18n.get('invalidKeywordFormat'),
                vscode.DiagnosticSeverity.Error
            );
            diagnostic.source = 'lsdyna';
            diagnostics.push(diagnostic);
            continue;
        }
        
        // Extract the keyword part (up to the first space or comma)
        const fullKeywordMatch = classification.rawKeyword.match(/^\*([A-Za-z0-9_+\-]+)$/);
        if (!fullKeywordMatch) continue;
        
        const rawKeyword = fullKeywordMatch[1];
        
        // Check for lowercase letters (opt-in; lowercase keywords are valid LS-DYNA)
        if (warnLowercase && classification.hasLowercase) {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(i, 0, i, line.text.length),
                i18n.get('keywordLowercase', rawKeyword),
                vscode.DiagnosticSeverity.Warning
            );
            diagnostic.source = 'lsdyna';
            diagnostics.push(diagnostic);
        }
        
        const checkKeyword = normalizeKeyword(rawKeyword);
        
        const isValid = customKeywordMatches(checkKeyword, customValidKeywords)
            || builtInKeywordMatches(checkKeyword, schema);
        
        if (!isValid && unknownSeverity !== null) {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(i, 0, i, line.text.length),
                i18n.get('unknownKeyword', checkKeyword),
                unknownSeverity
            );
            diagnostic.source = 'lsdyna';
            diagnostic.code = 'unknown-keyword';
            diagnostic.unknownKeyword = checkKeyword;
            diagnostics.push(diagnostic);
        }
    }
    
    return diagnostics;
}

module.exports = {
    init,
    collectKeywordValidationDiagnostics,
    normalizeKeyword,
    customKeywordMatches,
    builtInKeywordMatches,
    normalizeUnknownKeywordSeverity,
    resolveUnknownKeywordSeverity,
    findEndDirectiveLine,
    DEFAULT_CUSTOM_VALID_KEYWORDS,
};

export {};
