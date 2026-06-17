const vscode = require('vscode');
const i18n = require('../i18n');
const { getAliases } = require('../keywordUtils');
const keywordSchema = require('../keywordSchema');

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
    if (validKeywords.has(keyword) || schema[keyword]) return true;
    for (const alias of getAliases(keyword)) {
        if (validKeywords.has(alias) || schema[alias]) return true;
    }
    return false;
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
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        const text = line.text.trim();
        
        if (!text.startsWith('*')) continue;
        
        if (text.startsWith('**')) {
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
        const fullKeywordMatch = text.match(/^\*([A-Za-z0-9_+\-]+)/);
        if (!fullKeywordMatch) continue;
        
        const rawKeyword = fullKeywordMatch[1];
        
        // Check for lowercase letters
        if (/[a-z]/.test(rawKeyword)) {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(i, 0, i, line.text.length),
                i18n.get('keywordLowercase', rawKeyword),
                vscode.DiagnosticSeverity.Warning
            );
            diagnostic.source = 'lsdyna';
            diagnostics.push(diagnostic);
        }
        
        const checkKeyword = normalizeKeyword(rawKeyword);
        
        // Check validity against built-in and custom valid keywords
        const config = vscode.workspace.getConfiguration('lsdyna', document.uri);
        const customValidKeywordsConfig: string[] = config && typeof config.get === 'function'
            ? config.get('customValidKeywords') || DEFAULT_CUSTOM_VALID_KEYWORDS
            : DEFAULT_CUSTOM_VALID_KEYWORDS;
        const customValidKeywords = new Set(customValidKeywordsConfig.map(normalizeKeyword));
        
        const schema = getValidationSchema();
        const isValid = customKeywordMatches(checkKeyword, customValidKeywords)
            || builtInKeywordMatches(checkKeyword, schema);
        
        if (!isValid) {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(i, 0, i, line.text.length),
                i18n.get('unknownKeyword', checkKeyword),
                vscode.DiagnosticSeverity.Error
            );
            diagnostic.source = 'lsdyna';
            diagnostics.push(diagnostic);
        }
    }
    
    return diagnostics;
}

module.exports = {
    init,
    collectKeywordValidationDiagnostics
};

export {};
