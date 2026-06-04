const vscode = require('vscode');
const i18n = require('../i18n');
const { stripTitleSuffix } = require('../keywordUtils');

let validKeywords = new Set();
let isInitialized = false;

function init(validKeywordsSet) {
    validKeywords = validKeywordsSet;
    isInitialized = true;
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
        
        // Strip _TITLE and similar suffixes
        let checkKeyword = stripTitleSuffix(rawKeyword.toUpperCase());
        
        // Check validity against built-in and custom valid keywords
        const config = vscode.workspace.getConfiguration('lsdyna', document.uri);
        const customValidKeywordsConfig: string[] = config && typeof config.get === 'function'
            ? config.get('customValidKeywords') || ['*END']
            : ['*END'];
        const customValidKeywords = new Set(customValidKeywordsConfig.map(k => {
            let kw = k.toUpperCase().trim();
            if (kw.startsWith('*')) kw = kw.substring(1);
            return kw;
        }));
        
        let isValid = false;
        const { getAliases } = require('../keywordUtils');
        const candidatesToCheck = [checkKeyword, ...getAliases(checkKeyword)];
        for (const cand of candidatesToCheck) {
            if (validKeywords.has(cand) || customValidKeywords.has(cand)) {
                isValid = true;
                break;
            }
            // Prefix matching for custom valid keywords ending with *
            for (const ckw of customValidKeywords) {
                if (ckw.endsWith('*')) {
                    const prefix = ckw.substring(0, ckw.length - 1);
                    if (cand.startsWith(prefix)) {
                        isValid = true;
                        break;
                    }
                }
            }
            if (isValid) break;
            
            // Try sub-tokens for cand
            const parts = cand.split('_');
            for (let j = parts.length - 1; j >= 1; j--) {
                const subCand = parts.slice(0, j).join('_');
                if (validKeywords.has(subCand)) {
                    isValid = true;
                    break;
                }
                const subAliases = getAliases(subCand);
                for (const sa of subAliases) {
                    if (validKeywords.has(sa)) {
                        isValid = true;
                        break;
                    }
                }
                if (isValid) break;
            }
            if (isValid) break;
        }
        
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
