const vscode = require('vscode');

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
                `Invalid keyword format: LS-DYNA keywords should start with a single '*'`,
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
                `Keyword '*${rawKeyword}' contains lowercase letters. LS-DYNA keywords should be uppercase.`,
                vscode.DiagnosticSeverity.Warning
            );
            diagnostic.source = 'lsdyna';
            diagnostics.push(diagnostic);
        }
        
        // Strip _TITLE
        let checkKeyword = rawKeyword.toUpperCase();
        if (checkKeyword.endsWith('_TITLE')) {
            checkKeyword = checkKeyword.substring(0, checkKeyword.length - 6);
        }
        
        // Check validity
        if (!validKeywords.has(checkKeyword)) {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(i, 0, i, line.text.length),
                `Unknown or invalid keyword: *${checkKeyword}`,
                vscode.DiagnosticSeverity.Warning
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
