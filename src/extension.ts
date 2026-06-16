/**
 * @fileoverview Main entry point for the LS-DYNA VS Code extension.
 * @module extension
 * 
 * This file coordinates client-side VS Code features: registering document providers
 * (definition, reference, rename, hover, codelens, folding, document symbols, completions,
 * file decorations), launching the LSP background server, watching the workspace for file changes,
 * managing diagnostics reporting, and providing commands to navigate keywords and open manuals.
 * 
 * Role in System: Main extension process controller.
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const child_process = require('child_process');
const manualIndexer = require('./core/manualIndexer');
const keywordSchema = require('./core/keywordSchema');
const { LsdynaIncludeTreeProvider, normalizePathKey } = require('./client/providers/includeTreeProvider');
const { LsdynaKeywordIndexProvider } = require('./client/providers/keywordIndexProvider');
const { createIndexClient } = require('./client/services/indexClient');
const { createDiskSnapshotStore } = require('./core/cache/diskSnapshotStore');
const { findAffectedProjectRoots } = require('./core/incremental/fileInvalidation');
const includeScanner = require('./core/parser/includeScanner');
const keywordScanner = require('./core/parser/keywordScanner');
const keywordValidator = require('./core/parser/keywordValidator');
const { createWorkerPool } = require('./worker/workerPool');
const { createProjectIndexLoader } = require('./worker/projectIndexLoader');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');
const i18n = require('./core/i18n');

/**
 * Launches the background language server as a separate node process via VS Code LanguageClient.
 * 
 * @param {import('vscode').ExtensionContext} context - The extension context.
 * @returns {import('vscode-languageclient/node').LanguageClient} Active LanguageClient instance.
 */
function startLanguageServer(context) {
    const serverModule = path.join(__dirname, 'server', 'server.js');
    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

    const serverOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions },
    };

    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'lsdyna' }],
        initializationOptions: {
            globalStoragePath: context.globalStorageUri ? path.join(context.globalStorageUri.fsPath, 'project-snapshots') : null,
            maxCacheBytes: PROJECT_SNAPSHOT_DISK_CACHE_BYTES,
        },
    };

    const client = new LanguageClient(
        'lsdynaLanguageServer',
        'LS-DYNA Language Server',
        serverOptions,
        clientOptions
    );

    const disposable = client.start();
    context.subscriptions.push(disposable);
    return client;
}

const LARGE_DOCUMENT_LINE_THRESHOLD = 100000;
const PROJECT_SNAPSHOT_DISK_CACHE_BYTES = 256 * 1024 * 1024;
const STREAM_SCAN_YIELD_INTERVAL = 50000;
const includeDirectiveCache = new WeakMap();

function getLsdynaConfigurationValue(key, defaultValue, resource = undefined) {
    const config = vscode.workspace.getConfiguration('lsdyna', resource);
    if (!config || typeof config.get !== 'function') {
        return defaultValue;
    }
    return config.get(key, defaultValue);
}

function getExtensionPath(context) {
    if (!context) return __dirname;
    if (context.extensionPath) return context.extensionPath;
    if (context.extensionUri && context.extensionUri.fsPath) return context.extensionUri.fsPath;
    if (typeof context.asAbsolutePath === 'function') {
        return path.resolve(context.asAbsolutePath('.'));
    }
    return __dirname;
}

function logDebug(message) {
    console.log(`[lsdyna] ${message}`);
}

// --- Folding ---

/**
 * Folding range provider to collapse individual keyword blocks (*KEYWORD) in LS-DYNA decks.
 * @implements {vscode.FoldingRangeProvider}
 */
class LsDynaFoldingProvider {
    /**
     * Resolves folding ranges for *KEYWORD blocks.
     * 
     * @param {import('vscode').TextDocument} document - Target document.
     * @returns {import('vscode').FoldingRange[]} Folding ranges.
     */
    provideFoldingRanges(document) {
        if (shouldSkipAutomaticDocumentScan(document)) return [];

        const ranges = [];
        let foldStart = -1;

        for (let i = 0; i < document.lineCount; i++) {
            if (/^\*/.test(document.lineAt(i).text)) {
                if (foldStart !== -1 && i - 1 > foldStart) {
                    ranges.push(new vscode.FoldingRange(foldStart, i - 1));
                }
                foldStart = i;
            }
        }

        if (foldStart !== -1 && document.lineCount - 1 > foldStart) {
            ranges.push(new vscode.FoldingRange(foldStart, document.lineCount - 1));
        }

        return ranges;
    }
}

// --- Symbol Provider ---

/**
 * Document symbol provider to list all *KEYWORD blocks in the outline views.
 * @implements {vscode.DocumentSymbolProvider}
 */
class LsdynaKeywordSymbolProvider {
    /**
     * Collects *KEYWORD occurrences as DocumentSymbol objects.
     * 
     * @param {import('vscode').TextDocument} document - Target document.
     * @returns {import('vscode').DocumentSymbol[]} Document symbols.
     */
    provideDocumentSymbols(document) {
        if (shouldSkipAutomaticDocumentScan(document)) return [];

        const symbols = [];
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            if (line.text.startsWith('*')) {
                symbols.push(new vscode.DocumentSymbol(
                    line.text.trim(),
                    '',
                    vscode.SymbolKind.Property,
                    line.range,
                    line.range
                ));
            }
        }
        return symbols;
    }
}

// --- Document Link Provider ---

/**
 * Document link provider for jumping to included files.
 * @implements {vscode.DocumentLinkProvider}
 */
class LsdynaDocumentLinkProvider {
    /**
     * Collects DocumentLinks for include files.
     * 
     * @param {import('vscode').TextDocument} document - Target document.
     * @returns {import('vscode').DocumentLink[]} Document links.
     */
    provideDocumentLinks(document) {
        return collectIncludeDocumentLinks(document);
    }
}

// --- Helpers ---

/**
 * Scans includes in the document, caching the result by document version.
 * 
 * @param {import('vscode').TextDocument} document - Target document.
 * @returns {import('./core/parser/includeScanner').IncludeResult} include directive results.
 */
function getIncludeDirectiveData(document) {
    const version = document.version ?? null;
    const cached = includeDirectiveCache.get(document);
    if (cached && cached.version === version) {
        return cached.value;
    }

    const value = includeScanner.collectIncludeDirectivesFromLineReader(
        document.lineCount,
        i => document.lineAt(i).text,
        path.dirname(document.uri.fsPath)
    );

    includeDirectiveCache.set(document, { version, value });
    return value;
}

/**
 * Guard check to skip automatic parsing/diagnostics for very large files.
 * 
 * @param {import('vscode').TextDocument} document - Document to inspect.
 * @returns {boolean} True if size exceeds line threshold.
 */
function shouldSkipAutomaticDocumentScan(document) {
    if (!document) return false;
    if (getLsdynaConfigurationValue('largeFile.enableRendering', true, document.uri)) {
        return false;
    }
    return document.lineCount > LARGE_DOCUMENT_LINE_THRESHOLD;
}

/**
 * Resolves the URI of the currently active text editor or tab resource.
 * 
 * @returns {import('vscode').Uri|null} Active file URI.
 */
function getActiveUri() {
    const editor = vscode.window.activeTextEditor;
    if (editor) return editor.document.uri;
    const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
    if (activeTab && activeTab.input) {
        const input = activeTab.input;
        if (input.uri) return input.uri;
        if (input.resource) return input.resource;
        if (input.modified) return input.modified;
        if (input.original) return input.original;
    }
    return null;
}

/**
 * Checks if a file URI represents an LS-DYNA file extension.
 * 
 * @param {import('vscode').Uri|null} uri - URI to inspect.
 * @returns {boolean} True if lsdyna extension.
 */
function isLsdynaUri(uri) {
    if (!uri) return false;
    const ext = path.extname(uri.fsPath).toLowerCase();
    const configExtensions = getLsdynaConfigurationValue('additionalExtensions', ['.k', '.key', '.dyna', '.asc']) || ['.k', '.key', '.dyna', '.asc'];
    const normalizedExtensions = configExtensions.map(e => {
        const trimmed = e.trim().toLowerCase();
        return trimmed.startsWith('.') ? trimmed : '.' + trimmed;
    });
    return normalizedExtensions.includes(ext);
}

/**
 * Checks if a TextDocument represents an LS-DYNA file.
 * 
 * @param {import('vscode').TextDocument|null} document - Document.
 * @returns {boolean} True if lsdyna file.
 */
function isLsdynaFile(document) {
    if (!document || !document.uri) return false;
    return isLsdynaUri(document.uri) || document.languageId === 'lsdyna';
}

function associateLsdynaLanguages() {
    vscode.workspace.textDocuments.forEach(doc => {
        if (isLsdynaUri(doc.uri) && doc.languageId !== 'lsdyna') {
            vscode.languages.setTextDocumentLanguage(doc, 'lsdyna').then(undefined, err => {
                console.error('[lsdyna] Failed to set text document language:', err);
            });
        }
    });
}

/**
 * Scans document to construct clickable DocumentLinks targeting resolved includes.
 * 
 * @param {import('vscode').TextDocument} document - Target document.
 * @returns {import('vscode').DocumentLink[]} Link objects.
 */
function collectIncludeDocumentLinks(document) {
    if (!document || shouldSkipAutomaticDocumentScan(document)) return [];

    const searchPaths = getSearchPath(document);
    return findIncludeFileLines(document)
        .flatMap((entry) => {
            try {
                const fullPath = searchFileFromPaths(entry.fileName, searchPaths);
                return includeScanner.getIncludeEntryRanges(entry)
                    .map(({ lineIndex, startChar, endLineIndex, endChar }) =>
                        new vscode.DocumentLink(
                            new vscode.Range(lineIndex, startChar, endLineIndex, endChar),
                            vscode.Uri.file(fullPath)
                        )
                    );
            } catch (e) {
                return [];
            }
        });
}

/**
 * Scans lines exceeding 80 characters (excluding comments) to flag them as warnings.
 * 
 * @param {import('vscode').TextDocument} document - Target document.
 * @returns {import('vscode').Diagnostic[]} Diagnostics list.
 */
function collectLineLengthDiagnostics(document) {
    if (!document || !isLsdynaFile(document) || shouldSkipAutomaticDocumentScan(document)) return [];

    const issues = [];
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        if (!line.text.startsWith('$') && line.text.length > 80) {
            issues.push(new vscode.Diagnostic(
                new vscode.Range(i, 80, i, line.text.length),
                `Line exceeds 80 characters (${line.text.length}); LS-DYNA may truncate it`,
                vscode.DiagnosticSeverity.Warning
            ));
        }
    }
    return issues;
}

/**
 * Constructs decoration ranges (color markers) for resolved versus missing include files.
 * 
 * @param {import('vscode').TextDocument} document - Target document.
 * @returns {{resolved: import('vscode').DecorationOptions[], missing: import('vscode').DecorationOptions[]}} Decoration collections.
 */
function collectIncludeDecorationSets(document) {
    if (!document || !isLsdynaFile(document) || shouldSkipAutomaticDocumentScan(document)) {
        return { resolved: [], missing: [] };
    }

    const searchPaths = getSearchPath(document);
    const resolved = [];
    const missing = [];

    for (const entry of findIncludeFileLines(document)) {
        const ranges = includeScanner.getIncludeEntryRanges(entry)
            .map(({ lineIndex, startChar, endLineIndex, endChar }) => ({
                range: new vscode.Range(lineIndex, startChar, endLineIndex, endChar),
            }));
        try {
            searchFileFromPaths(entry.fileName, searchPaths);
            resolved.push(...ranges);
        } catch (e) {
            missing.push(...ranges);
        }
    }

    return { resolved, missing };
}

/**
 * Scans the document for keywords and returns decoration ranges.
 * 
 * @param {import('vscode').TextDocument} document - Document to scan.
 * @returns {import('vscode').Range[]} Keyword decoration ranges.
 */
function collectKeywordDecorationRanges(document) {
    if (!document || !isLsdynaFile(document) || shouldSkipAutomaticDocumentScan(document)) {
        return [];
    }

    const ranges = [];
    for (let i = 0; i < document.lineCount; i++) {
        const text = document.lineAt(i).text;
        const match = text.match(/^(\s*)(\*[^\s,$]+)/);
        if (match) {
            const startChar = match[1].length;
            const keywordLength = match[2].length;
            ranges.push(new vscode.Range(i, startChar, i, startChar + keywordLength));
        }
    }
    return ranges;
}

/**
 * Checks if the specified line index falls within any include file card definition.
 * 
 * @param {import('vscode').TextDocument} document - Document.
 * @param {number} currentLine - Line number to check.
 * @returns {boolean} True if is on include declaration line.
 */
function isIncludeLine(document, currentLine) {
    if (!document || !isLsdynaFile(document) || shouldSkipAutomaticDocumentScan(document)) {
        return false;
    }

    return findIncludeFileLines(document)
        .some(entry => includeScanner.includeEntryContainsLine(entry, currentLine));
}

/**
 * Returns raw include scan entries for the document.
 * 
 * @param {import('vscode').TextDocument} document - Document.
 * @returns {import('./core/parser/includeScanner').IncludeEntry[]} include entry lists.
 */
function findIncludeFileLines(document) {
    return getIncludeDirectiveData(document).includeEntries;
}

// --- Parameter helpers ---

/**
 * Scans parameters (*PARAMETER...) defined in a document, cataloging their details.
 * 
 * @param {import('vscode').TextDocument} document - Document to scan.
 * @returns {Map<string, { lineIndex: number, startChar: number, length: number, name: string, value: string }>} Parameter definitions map.
 */
function findParameterDefinitions(document) {
    if (shouldSkipAutomaticDocumentScan(document)) return new Map();

    const defs = new Map(); // UPPERCASE name -> { lineIndex, startChar, length, name }
    let inParamBlock = false;

    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i).text;
        if (line.startsWith('$')) continue;
        if (line.startsWith('*')) {
            const kw = line.trim();
            inParamBlock = kw === '*PARAMETER' || kw.startsWith('*PARAMETER_');
            continue;
        }
        if (!inParamBlock) continue;

        // Space-delimited: R  paramName  value
        let m = line.match(/^(\s*[RICric]\s*)(\w+)\s+(.*\S)/);
        // Fixed-width fallback: type(1) + name(9) + expression with no space separator
        if (!m) m = line.match(/^(\s*[RICric])(\w{1,9})(\S.*)/);
        if (m) {
            const startChar = m[1].length;
            const name = m[2];
            const value = m[3].trim();
            defs.set(name.toUpperCase(), { lineIndex: i, startChar, length: name.length, name, value });
        }
    }
    return defs;
}

/**
 * Scans parameters referenced via '&name' or bare names inside expressions.
 * 
 * @param {import('vscode').TextDocument} document - Document to scan.
 * @returns {Array<{ name: string, lineIndex: number, startChar: number, length: number }>} Reference locations list.
 */
function findParameterReferences(document) {
    if (shouldSkipAutomaticDocumentScan(document)) return [];

    const defs = findParameterDefinitions(document);
    const refs = [];
    const ampPattern = /&(\w+)/g;
    let inExprBlock = false;

    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i).text;
        if (line.startsWith('$')) continue;
        if (line.startsWith('*')) {
            inExprBlock = line.trim().startsWith('*PARAMETER_EXPRESSION');
            continue;
        }

        // Standard &name references anywhere in the file
        ampPattern.lastIndex = 0;
        let m;
        while ((m = ampPattern.exec(line)) !== null) {
            refs.push({ name: m[1].toUpperCase(), lineIndex: i, startChar: m.index, length: m[0].length });
        }

        // Bare name references in *PARAMETER_EXPRESSION value expressions
        if (inExprBlock) {
            const spaceMatch = line.match(/^(\s*[RICric]\s*)(\w+)\s+/);
            const fwMatch = !spaceMatch && line.match(/^(\s*[RICric])(\w{1,9})/);
            const exprStart = spaceMatch ? spaceMatch[0].length : fwMatch ? fwMatch[0].length : null;
            if (exprStart !== null) {
                const barePattern = /\b([A-Za-z]\w*)\b/g;
                let bm;
                while ((bm = barePattern.exec(line.slice(exprStart))) !== null) {
                    const nameUpper = bm[1].toUpperCase();
                    if (defs.has(nameUpper)) {
                        refs.push({ name: nameUpper, lineIndex: i, startChar: exprStart + bm.index, length: bm[1].length });
                    }
                }
            }
        }
    }
    return refs;
}

/**
 * Finds the parameter name and token range under the cursor position.
 * 
 * @param {import('vscode').TextDocument} document - Target document.
 * @param {import('vscode').Position} position - Editor position.
 * @returns {{ name: string, range: import('vscode').Range }|null} Active parameter token, or null.
 */
function getParameterAtCursor(document, position) {
    if (shouldSkipAutomaticDocumentScan(document)) return null;

    const line = document.lineAt(position.line).text;

    // On a &reference
    const refRange = document.getWordRangeAtPosition(position, /&\w+/);
    if (refRange) {
        return { name: document.getText(refRange).slice(1), range: refRange };
    }

    // On a definition line under *PARAMETER*
    let keyword = '';
    for (let i = position.line; i >= 0; i--) {
        const l = document.lineAt(i).text;
        if (l.startsWith('$')) continue;
        if (l.startsWith('*')) { keyword = l.trim(); break; }
    }
    if (keyword === '*PARAMETER' || keyword.startsWith('*PARAMETER_')) {
        const m = line.match(/^(\s*[RICric]\s+)(\w+)/);
        if (m) {
            const startChar = m[1].length;
            const name = m[2];
            const range = new vscode.Range(position.line, startChar, position.line, startChar + name.length);
            if (range.contains(position)) return { name, range };
        }
    }

    // Bare name reference in a *PARAMETER_EXPRESSION value (e.g. TEnd in "TEnd/100.0")
    if (keyword.startsWith('*PARAMETER_EXPRESSION')) {
        const defMatch = line.match(/^(\s*[RICric]\s+\w+\s+)/);
        if (defMatch && position.character >= defMatch[1].length) {
            const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z]\w*/);
            if (wordRange) {
                const word = document.getText(wordRange);
                const defs = findParameterDefinitions(document);
                if (defs.has(word.toUpperCase())) {
                    return { name: word, range: wordRange };
                }
            }
        }
    }

    return null;
}

// --- Parameter providers ---

/**
 * Provider to support 'Go to Definition' command for parameter names.
 * @implements {vscode.DefinitionProvider}
 */
class LsdynaDefinitionProvider {
    /**
     * Resolves parameter definition target location.
     * 
     * @param {import('vscode').TextDocument} document - Document.
     * @param {import('vscode').Position} position - Position.
     * @returns {import('vscode').Location|null} definition destination.
     */
    provideDefinition(document, position) {
        const param = getParameterAtCursor(document, position);
        if (!param) return null;
        const def = findParameterDefinitions(document).get(param.name.toUpperCase());
        if (!def) return null;
        return new vscode.Location(document.uri, new vscode.Position(def.lineIndex, def.startChar));
    }
}

/**
 * Provider to support 'Find All References' command for parameter names.
 * @implements {vscode.ReferenceProvider}
 */
class LsdynaReferenceProvider {
    /**
     * Gathers all parameter usage references.
     * 
     * @param {import('vscode').TextDocument} document - Document.
     * @param {import('vscode').Position} position - Position.
     * @param {import('vscode').ReferenceContext} context - Reference options.
     * @returns {import('vscode').Location[]} References.
     */
    provideReferences(document, position, context) {
        const param = getParameterAtCursor(document, position);
        if (!param) return [];
        const nameUpper = param.name.toUpperCase();
        const locations = [];

        if (context.includeDeclaration) {
            const def = findParameterDefinitions(document).get(nameUpper);
            if (def) {
                locations.push(new vscode.Location(document.uri,
                    new vscode.Range(def.lineIndex, def.startChar, def.lineIndex, def.startChar + def.length)));
            }
        }

        for (const ref of findParameterReferences(document)) {
            if (ref.name === nameUpper) {
                locations.push(new vscode.Location(document.uri,
                    new vscode.Range(ref.lineIndex, ref.startChar, ref.lineIndex, ref.startChar + ref.length)));
            }
        }
        return locations;
    }
}

/**
 * Rename provider enabling parameter renaming (F2) throughout a document.
 * @implements {vscode.RenameProvider}
 */
class LsdynaRenameProvider {
    /**
     * Validates if renaming can occur under cursor.
     * 
     * @param {import('vscode').TextDocument} document - Document.
     * @param {import('vscode').Position} position - Position.
     * @returns {import('vscode').Range} Renamable token range.
     */
    prepareRename(document, position) {
        const param = getParameterAtCursor(document, position);
        if (!param) throw new Error('Cannot rename this symbol.');
        return param.range;
    }

    /**
     * Resolves WorkspaceEdits replacing parameter definitions and references.
     * 
     * @param {import('vscode').TextDocument} document - Document.
     * @param {import('vscode').Position} position - Position.
     * @param {string} newName - Target name.
     * @returns {import('vscode').WorkspaceEdit|null} Renamed workspace edits.
     */
    provideRenameEdits(document, position, newName) {
        const param = getParameterAtCursor(document, position);
        if (!param) return null;
        const nameUpper = param.name.toUpperCase();
        const edit = new vscode.WorkspaceEdit();

        const def = findParameterDefinitions(document).get(nameUpper);
        if (def) {
            edit.replace(document.uri,
                new vscode.Range(def.lineIndex, def.startChar, def.lineIndex, def.startChar + def.length),
                newName);
        }

        for (const ref of findParameterReferences(document)) {
            if (ref.name === nameUpper) {
                // replace just the name part after &
                edit.replace(document.uri,
                    new vscode.Range(ref.lineIndex, ref.startChar + 1, ref.lineIndex, ref.startChar + ref.length),
                    newName);
            }
        }
        return edit;
    }
}

// ---------------------------------------------------------------------------
// Keyword field hover
// ---------------------------------------------------------------------------

let _fieldData = null;

/**
 * Loads keyword card field descriptors dictionary (field_data.json) from folder lazily.
 * 
 * @returns {Object} Keyword fields schema data.
 */
function getFieldData() {
    if (!_fieldData) {
        _fieldData = keywordSchema.loadKeywordSchema(() => i18n.getLanguage());
        if (!_fieldData) _fieldData = {};
    }
    return _fieldData;
}

/**
 * Searches the schema dictionary for a keyword definition, supporting aliases and variants.
 * 
 * @param {string} name - Keyword string.
 * @returns {Object|null} Schema lookup descriptor, or null.
 */
function lookupKeywordInfo(name) {
    return keywordSchema.lookupKeywordSchema(name, getFieldData());
}

function lookupKeyword(name) {
    const lookup = lookupKeywordInfo(name);
    return lookup ? lookup.entry : null;
}

/**
 * Assembles Markdown text summarizing card structure for a keyword hover card.
 * 
 * @param {string} kwName - Keyword name.
 * @param {Object} entry - Schema definition entry.
 * @returns {string} Markdown text.
 */
function keywordHoverMarkdown(kwName, entry, activeOptions = []) {
    const cards = keywordSchema.getRenderedCards(entry, activeOptions);
    const lines = [`### $(symbol-keyword) **\\*${kwName}**\n\n---\n`];
    let cardNum = 1;
    
    const tableHeader = `| Card | 1-10 | 11-20 | 21-30 | 31-40 | 41-50 | 51-60 | 61-70 | 71-80 |`;
    const tableSeparator = `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |`;
    const tableRows = [];

    for (const card of cards) {
        if (!card.length) continue;
        const isWide = card.length === 1 && card[0].w >= 40;
        if (isWide) {
            tableRows.push(`| **${cardNum}** | \`${card[0].n}\` | *(Title)* | | | | | | |`);
        } else {
            const rowCells = Array(8).fill('');
            for (const f of card) {
                const bin = Math.floor(f.p / 10);
                if (bin >= 0 && bin < 8) {
                    rowCells[bin] = `\`${f.n}\``;
                    if (f.w > 10) {
                        const spanBins = Math.round(f.w / 10);
                        for (let i = 1; i < spanBins; i++) {
                            if (bin + i < 8) rowCells[bin + i] = `→`;
                        }
                    }
                }
            }
            tableRows.push(`| **${cardNum}** | ${rowCells.join(' | ')} |`);
        }
        cardNum++;
    }

    if (tableRows.length > 0) {
        lines.push(tableHeader);
        lines.push(tableSeparator);
        lines.push(...tableRows);
        lines.push('');
    }

    if (entry.r) lines.push('*(✨ Last card repeats for each data row)*\n');
    if (entry.o && entry.o.length) {
        const options = entry.o.map(option => `\`${option.n}\``);
        lines.push(`**$(gear) Available Options:**\n${options.join(' • ')}`);
    }
    return lines.join('\n');
}

function appendKeywordOptionCommand(md, entry) {
    if (!entry || !entry.o || entry.o.length === 0) return;
    md.appendMarkdown(`\n\n---\n\n[$(list-selection) ${i18n.get('chooseKeywordOptions')}](command:extension.lsdynaChooseKeywordOptions)`);
}

function normalizeOptionName(name) {
    return String(name || '').trim().toUpperCase();
}

function parseKeywordOptionOrder(option) {
    const [position, rawIndex] = String(option && option.co || '').split('/');
    const index = Number.parseInt(rawIndex, 10);
    return {
        position,
        index: Number.isFinite(index) ? index : 0,
    };
}

function titleKeywordOptions(entry) {
    return (entry.o || [])
        .filter(option => (option.to || 0) > 0)
        .sort((a, b) => (a.to || 0) - (b.to || 0));
}

function postKeywordOptions(entry) {
    return (entry.o || [])
        .filter(option => parseKeywordOptionOrder(option).position === 'post')
        .sort((a, b) => parseKeywordOptionOrder(a).index - parseKeywordOptionOrder(b).index);
}

function keywordOptionCardCount(options) {
    return options.reduce((count, option) => count + (option.c || []).length, 0);
}

function keywordOptionCardSkeleton(card) {
    if (!card || card.length === 0) return '';
    const lastField = card[card.length - 1];
    const width = (lastField.p || 0) + (lastField.w || 0);
    if (card.length === 1 && width >= 40) return '';
    return ' '.repeat(Math.max(0, width));
}

function keywordOptionCards(options) {
    const cards = [];
    for (const option of options) {
        for (const card of option.c || []) {
            cards.push(card);
        }
    }
    return cards;
}

function managedCommentLineForCard(card) {
    return generateCommentLine(card).toLowerCase();
}

function strictCommentKey(text) {
    return String(text || '').trimEnd().toLowerCase();
}

function strictCommentTextForCard(card) {
    return strictCommentKey(managedCommentLineForCard(card));
}

function isStrictManagedCommentForCard(text, card) {
    return strictCommentKey(text) === strictCommentTextForCard(card);
}

function keywordOptionManagedLines(options, startCardIndex = 0) {
    const lines = [];
    for (const card of keywordOptionCards(options).slice(startCardIndex)) {
        lines.push(managedCommentLineForCard(card));
        lines.push(keywordOptionCardSkeleton(card));
    }
    return lines;
}

function keywordOptionRangeLabel(options, count) {
    if (count <= 0) return i18n.get('keywordOptionNone');
    const names = options.slice(0, count).map(option => normalizeOptionName(option.n));
    const singleLetters = names.every(name => /^[A-Z]$/.test(name));
    if (singleLetters && names.length > 1) {
        return `${names[0]}-${names[names.length - 1]}`;
    }
    return names.join(', ');
}

function keywordOptionSummary(entry) {
    const titleNames = titleKeywordOptions(entry).map(option => normalizeOptionName(option.n));
    const postOptions = postKeywordOptions(entry);
    const parts = [];
    if (titleNames.length) parts.push(titleNames.join(', '));
    if (postOptions.length) parts.push(keywordOptionRangeLabel(postOptions, postOptions.length));
    return parts.join(', ');
}

function keywordLineNameFromText(text) {
    return String(text || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function findKeywordLineForLine(document, lineNum) {
    for (let index = Math.min(lineNum, document.lineCount - 1); index >= 0; index--) {
        const text = document.lineAt(index).text.trimStart();
        if (text.startsWith('*')) return index;
    }
    return null;
}

function findKeywordBlockEnd(document, keywordLine) {
    for (let index = keywordLine + 1; index < document.lineCount; index++) {
        if (document.lineAt(index).text.trimStart().startsWith('*')) return index;
    }
    return document.lineCount;
}

function collectKeywordDataLines(document, keywordLine, blockEnd) {
    const lines = [];
    for (let index = keywordLine + 1; index < blockEnd; index++) {
        const text = document.lineAt(index).text;
        if (text.trimStart().startsWith('$')) continue;
        lines.push({ line: index, text });
    }
    return lines;
}

function buildKeywordLineWithTitleOptions(originalLine, canonicalName, selectedTitleNames) {
    const match = String(originalLine || '').match(/^(\s*)\*([A-Za-z0-9_+\-]+)(.*)$/);
    const suffix = selectedTitleNames.length ? `_${selectedTitleNames.join('_')}` : '';
    if (!match) return `*${canonicalName}${suffix}`;
    return `${match[1]}*${canonicalName}${suffix}${match[3] || ''}`;
}

function lineWholeRange(document, lineNum) {
    const lineText = document.lineAt(lineNum).text;
    return new vscode.Range(lineNum, 0, lineNum, lineText.length);
}

function insertLinesAt(editBuilder, document, lineNum, lines) {
    if (!lines || lines.length === 0) return;
    if (lineNum >= document.lineCount) {
        const lastLine = Math.max(0, document.lineCount - 1);
        const lastText = document.lineAt(lastLine).text;
        editBuilder.insert(new vscode.Position(lastLine, lastText.length), '\n' + lines.join('\n'));
        return;
    }
    editBuilder.insert(new vscode.Position(lineNum, 0), lines.join('\n') + '\n');
}

function removeLineRange(editBuilder, document, startLine, count) {
    if (count <= 0) return;
    const endLine = Math.min(document.lineCount, startLine + count);
    if (endLine < document.lineCount) {
        editBuilder.replace(new vscode.Range(startLine, 0, endLine, 0), '');
    } else if (startLine > 0) {
        const previousText = document.lineAt(startLine - 1).text;
        const lastText = document.lineAt(endLine - 1).text;
        editBuilder.replace(new vscode.Range(startLine - 1, previousText.length, endLine - 1, lastText.length), '');
    } else {
        const lastLine = document.lineAt(endLine - 1).text;
        editBuilder.replace(new vscode.Range(startLine, 0, endLine - 1, lastLine.length), '');
    }
}

function addLineDeletionRange(ranges, startLine, count) {
    if (count <= 0) return;
    ranges.push({
        startLine,
        endLine: startLine + count,
    });
}

function mergeLineDeletionRanges(ranges) {
    if (!ranges.length) return [];
    const sorted = ranges
        .map(range => ({ startLine: range.startLine, endLine: range.endLine }))
        .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
    const merged = [sorted[0]];
    for (const range of sorted.slice(1)) {
        const last = merged[merged.length - 1];
        if (range.startLine <= last.endLine) {
            last.endLine = Math.max(last.endLine, range.endLine);
        } else {
            merged.push(range);
        }
    }
    return merged;
}

function removeLineDeletionRanges(editBuilder, document, ranges) {
    for (const range of mergeLineDeletionRanges(ranges)) {
        removeLineRange(editBuilder, document, range.startLine, range.endLine - range.startLine);
    }
}

function addManagedDataLineDeletionRange(ranges, document, keywordLine, dataLine, card) {
    if (!dataLine) return;
    let startLine = dataLine.line;
    if (card && startLine - 1 > keywordLine && isStrictManagedCommentForCard(document.lineAt(startLine - 1).text, card)) {
        startLine -= 1;
    }
    addLineDeletionRange(ranges, startLine, dataLine.line - startLine + 1);
}

function addOrphanManagedCommentDeletionRanges(ranges, document, keywordLine, blockEnd, allOptionCards, selectedOptionCards) {
    const selectedComments = new Set(selectedOptionCards.map(strictCommentTextForCard));
    const allComments = new Set(allOptionCards.map(strictCommentTextForCard));

    for (let lineNum = keywordLine + 1; lineNum < blockEnd; lineNum++) {
        const text = document.lineAt(lineNum).text;
        const comment = strictCommentKey(text);
        if (!text.trimStart().startsWith('$#')) continue;
        if (allComments.has(comment) && !selectedComments.has(comment)) {
            const nextLine = lineNum + 1;
            const nextText = nextLine < blockEnd ? document.lineAt(nextLine).text : '';
            const hasEmptySkeleton = nextLine < blockEnd
                && !nextText.trimStart().startsWith('$')
                && !nextText.trimStart().startsWith('*')
                && nextText.trim().length === 0;
            addLineDeletionRange(ranges, lineNum, hasEmptySkeleton ? 2 : 1);
        }
    }
}

function insertionLineForDataIndex(document, keywordLine, dataLines, dataIndex, fallbackLine) {
    const dataLine = dataLines[dataIndex];
    if (!dataLine) return fallbackLine;
    const previousLine = dataLine.line - 1;
    if (previousLine > keywordLine && document.lineAt(previousLine).text.trimStart().startsWith('$#')) {
        return previousLine;
    }
    return dataLine.line;
}

async function confirmRemoveNonEmptyOptionLines(lines) {
    const hasNonEmpty = lines.some(line => String(line.text || '').trim().length > 0);
    if (!hasNonEmpty) return true;
    const choice = await vscode.window.showWarningMessage(
        i18n.get('removeNonEmptyOptionLinesWarning'),
        { modal: true },
        i18n.get('removeLines')
    );
    return choice === i18n.get('removeLines');
}

function inferCurrentPostOptionCount(entry, activeTitleNames, dataLineCount) {
    const activeTitleOptions = titleKeywordOptions(entry)
        .filter(option => activeTitleNames.includes(normalizeOptionName(option.n)));
    const requiredLineCount = keywordOptionCardCount(activeTitleOptions) + (entry.c || []).length;
    let remaining = Math.max(0, dataLineCount - requiredLineCount);
    let count = 0;
    for (const option of postKeywordOptions(entry)) {
        const optionLineCount = (option.c || []).length;
        if (remaining < optionLineCount) break;
        remaining -= optionLineCount;
        count++;
    }
    return count;
}

async function chooseKeywordOptionsForEditor(editor = vscode.window.activeTextEditor, requestedLine = null) {
    if (!editor || !editor.document) return;
    const document = editor.document;
    const activeLine = Number.isInteger(requestedLine)
        ? requestedLine
        : (editor.selection && editor.selection.active ? editor.selection.active.line : 0);
    const keywordLine = findKeywordLineForLine(document, activeLine);
    if (keywordLine === null) {
        vscode.window.showInformationMessage(i18n.get('noKeywordAtCursor'));
        return;
    }

    const keywordText = document.lineAt(keywordLine).text;
    const lookup = lookupKeywordInfo(keywordLineNameFromText(keywordText));
    if (!lookup || !lookup.entry.o || lookup.entry.o.length === 0) {
        vscode.window.showInformationMessage(i18n.get('noKeywordOptionsAvailable'));
        return;
    }

    const entry = lookup.entry;
    const titleOptions = titleKeywordOptions(entry);
    const postOptions = postKeywordOptions(entry);
    const currentTitleNames = lookup.activeOptions
        .filter(name => titleOptions.some(option => normalizeOptionName(option.n) === name));

    let selectedTitleNames = currentTitleNames;
    if (titleOptions.length) {
        const currentSet = new Set(currentTitleNames);
        const titleItems = titleOptions.map(option => {
            const name = normalizeOptionName(option.n);
            return {
                label: name,
                picked: currentSet.has(name),
                optionName: name,
            };
        });
        const picked = await vscode.window.showQuickPick(titleItems, {
            canPickMany: true,
            placeHolder: i18n.get('chooseKeywordTitleOptions'),
        });
        if (!picked) return;
        selectedTitleNames = picked.map(item => item.optionName || normalizeOptionName(item.label));
    }

    const blockEnd = findKeywordBlockEnd(document, keywordLine);
    const dataLines = collectKeywordDataLines(document, keywordLine, blockEnd);
    const currentPostCount = inferCurrentPostOptionCount(entry, currentTitleNames, dataLines.length);
    let selectedPostCount = currentPostCount;
    if (postOptions.length) {
        const postItems = [{ label: keywordOptionRangeLabel(postOptions, 0), postCount: 0, picked: currentPostCount === 0 }];
        for (let index = 0; index < postOptions.length; index++) {
            postItems.push({
                label: keywordOptionRangeLabel(postOptions, index + 1),
                postCount: index + 1,
                picked: currentPostCount === index + 1,
            });
        }
        const picked = await vscode.window.showQuickPick(postItems, {
            placeHolder: i18n.get('chooseConsecutiveOptionalCards'),
        });
        if (!picked) return;
        selectedPostCount = picked.postCount || 0;
    }

    const currentTitleOptions = titleOptions.filter(option => currentTitleNames.includes(normalizeOptionName(option.n)));
    const selectedTitleOptions = titleOptions.filter(option => selectedTitleNames.includes(normalizeOptionName(option.n)));
    const currentPreLineCount = keywordOptionCardCount(currentTitleOptions);
    const selectedPreLineCount = keywordOptionCardCount(selectedTitleOptions);
    const currentPostLineCount = keywordOptionCardCount(postOptions.slice(0, currentPostCount));
    const selectedPostLineCount = keywordOptionCardCount(postOptions.slice(0, selectedPostCount));
    const currentPreCards = keywordOptionCards(currentTitleOptions);
    const currentPostCards = keywordOptionCards(postOptions.slice(0, currentPostCount));

    const removedLines = [];
    if (selectedPreLineCount < currentPreLineCount) {
        removedLines.push(...dataLines.slice(selectedPreLineCount, currentPreLineCount));
    }
    if (selectedPostLineCount < currentPostLineCount) {
        removedLines.push(...dataLines.slice(dataLines.length - (currentPostLineCount - selectedPostLineCount)));
    }
    if (!(await confirmRemoveNonEmptyOptionLines(removedLines))) return;

    const selectedTitleNamesInOrder = titleOptions
        .map(option => normalizeOptionName(option.n))
        .filter(name => selectedTitleNames.includes(name));
    const nextKeywordLine = buildKeywordLineWithTitleOptions(keywordText, lookup.canonicalName, selectedTitleNamesInOrder);
    const preLinesToInsert = keywordOptionManagedLines(selectedTitleOptions, currentPreLineCount);
    const postLinesToInsert = keywordOptionManagedLines(postOptions.slice(0, selectedPostCount), currentPostLineCount);
    const deletionRanges = [];

    if (selectedPreLineCount < currentPreLineCount) {
        const removedDataLines = dataLines.slice(selectedPreLineCount, currentPreLineCount);
        const removedCards = currentPreCards.slice(selectedPreLineCount, currentPreLineCount);
        removedDataLines.forEach((line, index) => {
            addManagedDataLineDeletionRange(deletionRanges, document, keywordLine, line, removedCards[index]);
        });
    }
    if (selectedPostLineCount < currentPostLineCount) {
        const count = currentPostLineCount - selectedPostLineCount;
        const removedDataLines = dataLines.slice(dataLines.length - count);
        const removedCards = currentPostCards.slice(selectedPostLineCount);
        removedDataLines.forEach((line, index) => {
            addManagedDataLineDeletionRange(deletionRanges, document, keywordLine, line, removedCards[index]);
        });
    }
    addOrphanManagedCommentDeletionRanges(
        deletionRanges,
        document,
        keywordLine,
        blockEnd,
        keywordOptionCards([...titleOptions, ...postOptions]),
        keywordOptionCards([...selectedTitleOptions, ...postOptions.slice(0, selectedPostCount)])
    );

    await editor.edit(editBuilder => {
        if (nextKeywordLine !== keywordText) {
            editBuilder.replace(lineWholeRange(document, keywordLine), nextKeywordLine);
        }
        removeLineDeletionRanges(editBuilder, document, deletionRanges);
        if (postLinesToInsert.length) {
            insertLinesAt(editBuilder, document, blockEnd, postLinesToInsert);
        }
        if (preLinesToInsert.length) {
            const insertAt = insertionLineForDataIndex(document, keywordLine, dataLines, currentPreLineCount, keywordLine + 1);
            insertLinesAt(editBuilder, document, insertAt, preLinesToInsert);
        }
    });
}

class LsdynaKeywordOptionsCodeLensProvider {
    provideCodeLenses(document) {
        if (!document || shouldSkipAutomaticDocumentScan(document)) return [];
        const lenses = [];
        for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
            const text = document.lineAt(lineNum).text.trimStart();
            if (!text.startsWith('*') || text.startsWith('**')) continue;
            const lookup = lookupKeywordInfo(keywordLineNameFromText(text));
            if (!lookup || !lookup.entry.o || lookup.entry.o.length === 0) continue;
            const summary = keywordOptionSummary(lookup.entry);
            const range = new vscode.Range(lineNum, 0, lineNum, 0);
            lenses.push(new vscode.CodeLens(range, {
                title: summary ? i18n.get('keywordOptionsCodeLensWithSummary', summary) : i18n.get('keywordOptionsCodeLens'),
                command: 'extension.lsdynaChooseKeywordOptions',
                arguments: [lineNum],
            }));
            lenses.push(new vscode.CodeLens(range, {
                title: i18n.get('selectKeywordCodeLens'),
                command: 'extension.selectKeyword',
                arguments: [lineNum],
            }));
            lenses.push(new vscode.CodeLens(range, {
                title: i18n.get('formatKeywordCodeLens'),
                command: 'extension.lsdynaFormatSelection',
                arguments: [lineNum],
            }));
        }
        return lenses;
    }
}

/**
 * Replaces newlines in help descriptors with markdown hard breaks.
 * 
 * @param {string} helpText - Input help string.
 * @returns {string} Formatted output.
 */
function formatHoverHelpText(helpText) {
    return helpText.replace(/\r?\n/g, '  \n');
}

/**
 * Resolves local manuals mapping and appends SumatraPDF/PDF links to hover Markdown card.
 * 
 * @param {import('vscode').MarkdownString} md - Markdown card.
 * @param {string} kwName - Cleaned keyword name.
 */
function appendManualLinks(md, kwName) {
    const cleanKw = manualIndexer.cleanKeyword(kwName);
    const manuals = manualIndexer.getManualLocations(cleanKw);
    const manualsDir = getLsdynaConfigurationValue('manualsDir', 'lsdyna_manual_pack') || 'lsdyna_manual_pack';
    const fileCount = manualIndexer.getManualFilesCount();

    const notConfigured = fileCount === 0;

    if (notConfigured) {
        md.appendMarkdown('\n\n---');
        md.appendMarkdown(`\n\n${i18n.get('manualDirNotConfigured')}`);
        md.appendMarkdown(`\n\n[${i18n.get('configureFolder')}](command:extension.configureManualsDir)`);
    } else if (manuals.length > 0) {
        md.appendMarkdown('\n\n---');
        const links = [];
        for (const man of manuals) {
            const volName = path.basename(man.file, '.pdf');
            const openArgs = encodeURIComponent(JSON.stringify([man.file, man.page]));
            links.push(`[$(book) ${volName} (${i18n.get('page', man.page)})](command:extension.openManual?${openArgs})`);
        }
        const matchedKw = manuals[0].matchedKeyword || cleanKw;
        const displayKw = matchedKw.startsWith('*') ? `\\${matchedKw}` : matchedKw;
        md.appendMarkdown(`\n\n[$(settings-gear)](command:extension.configureManualsDir "${i18n.get('modifyManualPath')}") &nbsp;&nbsp; **${displayKw}** &nbsp;&nbsp; ${links.join(' &nbsp;&nbsp; ')}`);
    }
}

/**
 * Hover provider delivering detailed keyword and card field documentation on mouse hover.
 * @implements {vscode.HoverProvider}
 */
class LsdynaFieldHoverProvider {
    /**
     * Generates Hover cards for includes, parameter references, keywords, or card fields.
     * 
     * @param {import('vscode').TextDocument} document - Active document.
     * @param {import('vscode').Position} position - Cursor position.
     * @returns {import('vscode').Hover|null} Hover card or null.
     */
    provideHover(document, position) {
        if (shouldSkipAutomaticDocumentScan(document)) return null;

        // Hover on include file paths
        const includeEntries = findIncludeFileLines(document);
        const includeEntry = includeEntries.find(entry => includeScanner.includeEntryContainsLine(entry, position.line));
        if (includeEntry) {
            const ranges = includeScanner.getIncludeEntryRanges(includeEntry);
            const rangeOnLine = ranges.find(r => r.lineIndex === position.line && position.character >= r.startChar && position.character <= r.endChar);
            if (rangeOnLine) {
                try {
                    const searchPaths = getSearchPath(document);
                    const fullPath = searchFileFromPaths(includeEntry.fileName, searchPaths);
                    const uri = vscode.Uri.file(fullPath);
                    const hoverRange = new vscode.Range(rangeOnLine.lineIndex, rangeOnLine.startChar, rangeOnLine.lineIndex, rangeOnLine.endChar);
                    
                    const openNewTabArgs = encodeURIComponent(JSON.stringify([fullPath]));
                    const openSplitArgs = encodeURIComponent(JSON.stringify([fullPath]));
                    const openFolderArgs = encodeURIComponent(JSON.stringify([fullPath]));
                    
                    const md = new vscode.MarkdownString(
                        `[$(go-to-file)](command:extension.openIncludeNewTab?${openNewTabArgs} "${i18n.get('openNewTab')}") &nbsp;&nbsp;&nbsp;&nbsp; ` +
                        `[$(split-horizontal)](command:extension.openIncludeSplit?${openSplitArgs} "${i18n.get('openSplit')}") &nbsp;&nbsp;&nbsp;&nbsp; ` +
                        `[$(folder-opened)](command:extension.openIncludeFolder?${openFolderArgs} "${i18n.get('openFolder')}")`
                    );
                    md.isTrusted = true;
                    md.supportThemeIcons = true;
                    return new vscode.Hover(md, hoverRange);
                } catch (e) {
                    // File does not exist, fall through to default keyword/field hover
                }
            }
        }

        const line = document.lineAt(position.line);
        const text = line.text;
        const trimmed = text.trimStart();

        // Hover on &parameter references
        const paramPattern = /&(\w+)/g;
        let pm;
        while ((pm = paramPattern.exec(text)) !== null) {
            const start = pm.index;
            const end = pm.index + pm[0].length;
            if (position.character >= start && position.character < end) {
                const defs = findParameterDefinitions(document);
                const def = defs.get(pm[1].toUpperCase());
                if (def?.value) {
                    const md = new vscode.MarkdownString(`**${pm[1]}** = ${def.value}`);
                    return new vscode.Hover(md, new vscode.Range(position.line, start, position.line, end));
                }
                return null;
            }
        }

        // Hover on keyword lines
        if (trimmed.startsWith('*')) {
            const kwName = trimmed.slice(1).toUpperCase().split(/[\s,$]/)[0];
            if (!kwName) return null;
            const lookup = lookupKeywordInfo(kwName);
            if (!lookup) {
                const cleanKw = manualIndexer.cleanKeyword(kwName);
                const manuals = manualIndexer.getManualLocations(cleanKw);
                const fileCount = manualIndexer.getManualFilesCount();
                const hasManuals = manuals.length > 0;
                const notConfigured = fileCount === 0;
                
                if (hasManuals || notConfigured) {
                    const md = new vscode.MarkdownString(`**\\*${kwName}**`);
                    md.isTrusted = true;
                    md.supportThemeIcons = true;
                    appendManualLinks(md, kwName);
                    return new vscode.Hover(md);
                }
                return null;
            }
            const md = new vscode.MarkdownString(keywordHoverMarkdown(kwName, lookup.entry, lookup.activeOptions));
            md.isTrusted = true;
            md.supportThemeIcons = true;
            appendKeywordOptionCommand(md, lookup.entry);
            appendManualLinks(md, kwName);
            return new vscode.Hover(md);
        }

        // Skip comment lines
        if (trimmed.startsWith('$')) return null;

        // Find the enclosing keyword line
        let kwLine = null;
        for (let i = position.line - 1; i >= 0; i--) {
            const t = document.lineAt(i).text.trimStart();
            if (t.startsWith('*')) { kwLine = i; break; }
        }
        if (kwLine === null) return null;

        const kwText = document.lineAt(kwLine).text.trim();
        const kwName = kwText.slice(1).toUpperCase().split(/[\s,]/)[0];
        const card = keywordSchema.getCardForDocumentLine(document, position.line, getFieldData());
        if (!card || card.length === 0) return null;

        const col = position.character;
        const field = card.find(f => col >= f.p && col < f.p + f.w);
        if (!field) return null;

        const typeLabel = field.t ? ` *(${field.t})*` : '';
        const helpText = field.h ? `\n\n${formatHoverHelpText(field.h)}` : '';

        const columnsHeader = card.map(f => `${f.p + 1}-${f.p + f.w}`);
        const separators = card.map(() => ':---:'); // Center align all columns
        const fieldNamesBody = card.map((f) => {
            if (f.n === field.n) {
                return `<span style="color:var(--vscode-badge-foreground);background-color:var(--vscode-badge-background);">**&nbsp;${f.n}&nbsp;**</span>`;
            }
            return `\`${f.n}\``; // Use inline code for inactive fields to look like input cells
        });

        const gridTable = [
            `| ${columnsHeader.join(' | ')} |`,
            `| ${separators.join(' | ')} |`,
            `| ${fieldNamesBody.join(' | ')} |`
        ].join('\n');

        const md = new vscode.MarkdownString(`### $(symbol-field) <span style="color:var(--vscode-textLink-foreground);">**${field.n}**</span>${typeLabel}${helpText}\n\n---\n\n**$(table) Card Columns:**\n\n${gridTable}`);
        md.isTrusted = true;
        md.supportHtml = true;
        md.supportThemeIcons = true;
        appendManualLinks(md, kwName);
        const range = new vscode.Range(position.line, field.p, position.line, field.p + field.w);
        return new vscode.Hover(md, range);
    }
}

/**
 * CodeLens provider putting parameter usage reference counts above definition cards.
 * @implements {vscode.CodeLensProvider}
 */
class LsdynaParameterCodeLensProvider {
    /**
     * Spawns CodeLenses for parameter definitions.
     * 
     * @param {import('vscode').TextDocument} document - Document.
     * @returns {import('vscode').CodeLens[]} CodeLenses.
     */
    provideCodeLenses(document) {
        const defs = findParameterDefinitions(document);
        const refs = findParameterReferences(document);
        const lenses = [];
        for (const [key, def] of defs) {
            const count = refs.filter(r => r.name === key).length;
            const pos = new vscode.Position(def.lineIndex, def.startChar);
            const range = new vscode.Range(pos, pos);
            lenses.push(new vscode.CodeLens(range, {
                title: count === 1 ? '1 reference' : `${count} references`,
                command: 'editor.action.findReferences',
                arguments: [document.uri, pos],
            }));
        }
        return lenses;
    }
}


/**
 * Fetches search path directories resolved for this file.
 * 
 * @param {import('vscode').TextDocument} document - Active document.
 * @returns {string[]} Search paths list.
 */
function getSearchPath(document) {
    return getIncludeDirectiveData(document).searchPaths;
}

/**
 * Synchronously searches backward to locate the starting line of the enclosing keyword block.
 * 
 * @param {number} lineCount - Document lines.
 * @param {function(number): string} getLine - Line retrieval callback.
 * @param {number} lineindex - Starting line index.
 * @returns {number} 0-indexed line index of keyword statement.
 */
function startLineOfCurrentKeywordFromLineReader(lineCount, getLine, lineindex) {
    for (let i = lineindex; i >= 0; i--) {
        if (getLine(i).startsWith('*')) return i;
    }
    throw new Error('Not on any keyword.');
}

/**
 * Synchronously searches forward to locate the ending line of the enclosing keyword block.
 * 
 * @param {number} lineCount - Document lines.
 * @param {function(number): string} getLine - Line retrieval callback.
 * @param {number} lineindex - Starting line index.
 * @returns {number} 0-indexed line index of keyword block end.
 */
function endLineOfCurrentKeywordFromLineReader(lineCount, getLine, lineindex) {
    for (let i = lineindex + 1; i < lineCount; i++) {
        if (getLine(i).startsWith('*')) return i - 1;
    }
    return lineCount - 1;
}

/**
 * Resolves the filename corresponding to an include keyword line.
 * 
 * @param {number} lineCount - Total lines.
 * @param {function(number): string} getLine - Line reader callback.
 * @param {number} lineindex - Line index inside include block.
 * @param {string} basePath - Base directory path.
 * @returns {string} include filename.
 */
function getFilenameFromKeywordFromLineReader(lineCount, getLine, lineindex, basePath) {
    const linestart = startLineOfCurrentKeywordFromLineReader(lineCount, getLine, lineindex);
    const keyword = getLine(linestart).trim();
    if (keyword.startsWith('*INCLUDE_PATH')) {
        throw new Error('This keyword does not have a filename card.');
    }
    if (!keyword.startsWith('*INCLUDE')) {
        throw new Error('This keyword is not supported.');
    }

    const lineend = endLineOfCurrentKeywordFromLineReader(lineCount, getLine, linestart);
    const blockLen = lineend - linestart + 1;
    const { includeEntries: entries } = includeScanner.collectIncludeDirectivesFromLineReader(
        blockLen,
        i => getLine(linestart + i),
        basePath
    );
    const relIdx = lineindex - linestart;
    const currentEntry = entries.find(entry => includeScanner.includeEntryContainsLine(entry, relIdx));

    if (currentEntry) return currentEntry.fileName;
    if (entries.length > 0) return entries[0].fileName;
    throw new Error('No file to jump to.');
}

function startLineOfCurrentKeyword(lines, lineindex) {
    return startLineOfCurrentKeywordFromLineReader(lines.length, i => lines[i], lineindex);
}

function endLineOfCurrentKeyword(lines, lineindex) {
    return endLineOfCurrentKeywordFromLineReader(lines.length, i => lines[i], lineindex);
}

function getFilenameFromKeyword(lines, lineindex) {
    return getFilenameFromKeywordFromLineReader(lines.length, i => lines[i], lineindex, '.');
}

function getFilenameFromDocument(document, lineindex) {
    return getFilenameFromKeywordFromLineReader(
        document.lineCount,
        i => document.lineAt(i).text,
        lineindex,
        path.dirname(document.uri.fsPath)
    );
}

/**
 * Iterates folders in path list to find where target file exists on disk.
 * 
 * @param {string} filePath - Target file.
 * @param {string[]} paths - Ordered list of folders.
 * @returns {string} Absolute path.
 */
function searchFileFromPaths(filePath, paths) {
    for (const searchPath of paths) {
        const fullPath = path.resolve(searchPath, filePath);
        if (fs.existsSync(fullPath)) return fullPath;
    }
    throw new Error(`${filePath} not found.`);
}

/**
 * Locates the next line starting with '*' (excluding currentLine).
 * 
 * @param {number} lineCount - Total lines.
 * @param {function(number): string} getLine - Line reader.
 * @param {number} currentLine - Current line.
 * @returns {number} Next line index.
 */
function findNextKeywordFromLineReader(lineCount, getLine, currentLine) {
    for (let i = currentLine + 1; i < lineCount; i++) {
        if (getLine(i).startsWith('*')) return i;
    }
    throw new Error('No more keywords found.');
}

function findNextKeyword(lines, currentLine) {
    return findNextKeywordFromLineReader(lines.length, i => lines[i], currentLine);
}

function findNextKeywordInDocument(document, currentLine) {
    return findNextKeywordFromLineReader(document.lineCount, i => document.lineAt(i).text, currentLine);
}

/**
 * Locates the previous line starting with '*' (excluding currentLine).
 * 
 * @param {number} lineCount - Total lines.
 * @param {function(number): string} getLine - Line reader.
 * @param {number} currentLine - Current line.
 * @returns {number} Previous line index.
 */
function findPreviousKeywordFromLineReader(lineCount, getLine, currentLine) {
    for (let i = currentLine - 1; i >= 0; i--) {
        if (getLine(i).startsWith('*')) return i;
    }
    throw new Error('No previous keywords found.');
}

function findPreviousKeyword(lines, currentLine) {
    return findPreviousKeywordFromLineReader(lines.length, i => lines[i], currentLine);
}

function findPreviousKeywordInDocument(document, currentLine) {
    return findPreviousKeywordFromLineReader(document.lineCount, i => document.lineAt(i).text, currentLine);
}

/**
 * Creates a debounced callback function for updating document views on typing.
 * 
 * @param {function(): import('vscode').TextDocument|null} getActiveDocument - Gets current document.
 * @param {function(any): void} refreshDocument - Callback to trigger update.
 * @param {number} [delayMs=500] - Timer delay.
 * @param {function} [schedule=setTimeout] - Scheduling handle.
 * @param {function} [cancel=clearTimeout] - Cancellation handle.
 * @returns {function(any): void} Debounced caller.
 */
function createActiveDocumentDebouncer(getActiveDocument, refreshDocument, delayMs = 500, schedule = setTimeout, cancel = clearTimeout) {
    let timer;
    return (changedDocument) => {
        cancel(timer);
        timer = schedule(() => {
            if (getActiveDocument() === changedDocument) {
                refreshDocument(changedDocument);
            }
        }, delayMs);
    };
}

// --- Shared include traversal ---

/**
 * Recursively scans files in project inclusion tree starting from a root.
 * 
 * @param {string} rootPath - Main file path.
 * @param {function(number): void} [onProgress] - Progress listener callback.
 * @returns {Promise<string[]>} List of all dependency files found.
 */
async function collectIncludeFiles(rootPath, onProgress) {
    const visited = new Set();
    const queue = [rootPath];
    const files = [];
    while (queue.length > 0) {
        const filePath = queue.shift();
        if (visited.has(filePath) || !fs.existsSync(filePath)) continue;
        visited.add(filePath);
        files.push(filePath);
        if (onProgress) onProgress(files.length);
    const { includeEntries, searchPaths } = await includeScanner.collectIncludeDirectivesFromFile(filePath);
        for (const { fileName } of includeEntries) {
            try { queue.push(searchFileFromPaths(fileName, searchPaths)); } catch (e) {}
        }
        await new Promise(r => setImmediate(r));
    }
    return files;
}

/**
 * File decorations provider for Include Tree views, overlaying warnings or success icons.
 * @implements {vscode.FileDecorationProvider}
 */
class LsdynaFileDecorationProvider {
    includeTreeProvider: any;
    _onDidChangeFileDecorations: any;
    onDidChangeFileDecorations: any;

    constructor(includeTreeProvider) {
        this.includeTreeProvider = includeTreeProvider;
        this._onDidChangeFileDecorations = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
    }

    refresh() {
        this._onDidChangeFileDecorations.fire(undefined);
    }

    provideFileDecoration(uri) {
        if (uri.scheme !== 'file') return undefined;
        const key = normalizePathKey(uri.fsPath);

        if (this.includeTreeProvider.missingPaths.has(key)) {
            return {
                badge: '⚠',
                tooltip: 'Missing Include Reference',
                color: new vscode.ThemeColor('list.warningForeground')
            };
        }

        if (this.includeTreeProvider.resolvedPaths.has(key)) {
            return {
                tooltip: 'Resolved Include Reference',
                color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground')
            };
        }

        return undefined;
    }
}

/**
 * Autocomplete provider for relative include filenames based on scan directories.
 * @implements {vscode.CompletionItemProvider}
 */
class LsdynaIncludeCompletionProvider {
    provideCompletionItems(document, position, token, context) {
        if (!document || !document.uri || !document.uri.fsPath) return [];
        if (shouldSkipAutomaticDocumentScan(document)) return [];

        const lineText = document.lineAt(position.line).text;
        if (lineText.trimStart().startsWith('$')) {
            return [];
        }

        // Find enclosing keyword
        let kwLine = -1;
        for (let i = position.line; i >= 0; i--) {
            const text = document.lineAt(i).text.trimStart();
            if (text.startsWith('*')) {
                kwLine = i;
                break;
            }
        }

        if (kwLine === -1 || position.line === kwLine) return [];

        const kwText = document.lineAt(kwLine).text.trim().toUpperCase();
        if (!kwText.startsWith('*INCLUDE') || kwText.startsWith('*INCLUDE_PATH')) {
            return [];
        }

        const searchPaths = getSearchPath(document);
        const validPaths = [];
        for (const p of searchPaths) {
            let targetPath = p;
            if (!path.isAbsolute(p)) {
                targetPath = path.resolve(path.dirname(document.uri.fsPath), p);
            }
            try {
                if (fs.existsSync(targetPath)) {
                    const stats = fs.statSync(targetPath);
                    if (stats.isDirectory()) {
                        validPaths.push(targetPath);
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        const suggestions = new Set<string>();
        const maxFiles = 300;
        const maxDepth = 3;

        function walkDir(dir, baseDir, depth = 0) {
            if (depth > maxDepth || suggestions.size >= maxFiles) {
                return;
            }
            try {
                const list = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of list) {
                    if (suggestions.size >= maxFiles) break;

                    const name = entry.name;
                    if (name.startsWith('.') || 
                        name === 'node_modules' || 
                        name === 'venv' || 
                        name === '.git' ||
                        name === '.github' ||
                        name === '.vscode' ||
                        name === 'build' ||
                        name === 'dist' ||
                        name === 'out' ||
                        name === 'target') {
                        continue;
                    }

                    const fullPath = path.join(dir, name);
                    if (entry.isDirectory()) {
                        walkDir(fullPath, baseDir, depth + 1);
                    } else if (entry.isFile()) {
                        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
                        suggestions.add(relPath);
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        for (const baseDir of validPaths) {
            walkDir(baseDir, baseDir);
        }

        const trimmedStart = lineText.length - lineText.trimStart().length;
        if (position.character < trimmedStart) {
            return [];
        }
        const range = new vscode.Range(position.line, trimmedStart, position.line, position.character);
        const currentPrefix = lineText.slice(trimmedStart, position.character);

        const items = [];
        for (const file of suggestions) {
            const item = new vscode.CompletionItem(file, vscode.CompletionItemKind.File);
            item.detail = 'Include File';
            item.range = range;
            if (!file.includes('/') && !file.includes('\\')) {
                if (currentPrefix.startsWith('./')) {
                    item.filterText = './' + file;
                } else if (currentPrefix.startsWith('.\\')) {
                    item.filterText = '.\\' + file;
                } else if (currentPrefix.startsWith('/')) {
                    item.filterText = '/' + file;
                } else if (currentPrefix.startsWith('\\')) {
                    item.filterText = '\\' + file;
                }
            }
            items.push(item);
        }

        return new vscode.CompletionList(items, true);
    }
}

function getCardFieldsForLine(document, lineNum) {
    let kwLine = null;
    for (let i = lineNum - 1; i >= 0; i--) {
        const t = document.lineAt(i).text.trimStart();
        if (t.startsWith('*')) { kwLine = i; break; }
    }
    if (kwLine === null) return null;

    const kwText = document.lineAt(kwLine).text.trim();
    
    const ignoreKeywords = getLsdynaConfigurationValue('ignoreFormattingKeywords', [], document.uri) || [];
    const kwTextUpper = kwText.toUpperCase();
    for (const prefix of ignoreKeywords) {
        if (kwTextUpper.startsWith(prefix.toUpperCase())) {
            return null;
        }
    }

    return keywordSchema.getCardForDocumentLine(document, lineNum, getFieldData());
}

function getDataCardDisplayIndexForLine(document, lineNum) {
    let kwLine = null;
    for (let i = lineNum - 1; i >= 0; i--) {
        const t = document.lineAt(i).text.trimStart();
        if (t.startsWith('*')) { kwLine = i; break; }
    }
    if (kwLine === null) return 0;

    let dataIndex = 0;
    for (let i = kwLine + 1; i <= lineNum && i < document.lineCount; i++) {
        const t = document.lineAt(i).text.trimStart();
        if (!t.startsWith('$') && t.length > 0) dataIndex++;
    }

    const current = document.lineAt(lineNum).text.trimStart();
    if (current.length === 0) {
        dataIndex++;
    }

    return Math.max(0, dataIndex - 1);
}

class LsdynaFieldCompletionProvider {
    provideCompletionItems(document, position, token, context) {
        if (!document || shouldSkipAutomaticDocumentScan(document)) return [];

        const line = document.lineAt(position.line);
        const text = line.text;
        const trimmed = text.trimStart();
        const textBeforeCursor = text.slice(0, position.character).trim();
        const isCommentTrigger = textBeforeCursor === '$' || textBeforeCursor === '$#';

        // Guard: Skip keywords and non-trigger comments
        if (trimmed.startsWith('*') || (trimmed.startsWith('$') && !isCommentTrigger)) return [];

        if (isCommentTrigger) {
            let targetLineNum = position.line + 1;
            for (let i = targetLineNum; i < document.lineCount; i++) {
                const t = document.lineAt(i).text.trimStart();
                if (t.startsWith('*')) break;
                if (!t.startsWith('$')) {
                    targetLineNum = i;
                    break;
                }
            }
            
            const card = targetLineNum < document.lineCount ? getCardFieldsForLine(document, targetLineNum) : null;
            if (!card || card.length === 0) return [];

            const commentText = generateCommentLine(card);
            if (!commentText) return [];

            const item = new vscode.CompletionItem(commentText.trimEnd(), vscode.CompletionItemKind.Snippet);
            item.detail = '(LS-DYNA) 插入字段注释行';
            item.documentation = new vscode.MarkdownString(`**插入字段注释行**\n\n按下 Tab 将插入：\n\`\`\`lsdyna\n${commentText}\n\`\`\``);
            item.insertText = commentText;
            item.range = new vscode.Range(position.line, 0, position.line, line.text.length);

            return [item];
        }

        const card = getCardFieldsForLine(document, position.line);
        if (!card || card.length === 0) return [];

        // Skip completions for title/filename fields (single wide field)
        if (card.length === 1 && card[0].w >= 40) return [];

        const displayIndex = getDataCardDisplayIndexForLine(document, position.line);

        const items = [];

        // 1. Row Card Template (Only when line is empty or near the beginning)
        if (text.trim().length === 0 || position.character <= 1) {
            const templateItem = new vscode.CompletionItem(
                i18n.get('rowTemplateLabel', displayIndex + 1),
                vscode.CompletionItemKind.Snippet
            );
            templateItem.detail = i18n.get('rowTemplateDetail');
            templateItem.documentation = new vscode.MarkdownString('Insert a pre-aligned full data card row.');

            let snippetText = '';
            let prevEnd = 0;
            for (let j = 0; j < card.length; j++) {
                const f = card[j];
                const gap = f.p - prevEnd;
                if (gap > 0) snippetText += ' '.repeat(gap);

                const isFloat = f.h && (f.h.toLowerCase().includes('float') || f.h.toLowerCase().includes('real') || f.n.toUpperCase().startsWith('X') || f.n.toUpperCase().startsWith('Y') || f.n.toUpperCase().startsWith('Z'));
                const defVal = isFloat ? '0.0' : '0';
                const padLen = Math.max(0, f.w - defVal.length);
                const placeholder = f.w >= 40 ? defVal + ' '.repeat(padLen) : ' '.repeat(padLen) + defVal;

                snippetText += `\${${j + 1}:${placeholder}}`;
                prevEnd = f.p + f.w;
            }
            templateItem.insertText = new vscode.SnippetString(snippetText);
            // Ensure template is sorted at top
            templateItem.sortText = '0_' + displayIndex;
            items.push(templateItem);
        }

        // 2. Individual Aligned Fields
        const col = position.character;
        for (let j = 0; j < card.length; j++) {
            const f = card[j];
            if (col <= f.p) {
                const padding = f.p - col;
                const label = i18n.get('fieldCompletionLabel', f.n, f.p + 1, f.p + f.w);
                const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Field);
                item.detail = i18n.get('fieldDetail', f.t || 'I', f.n);
                if (f.h) {
                    item.documentation = new vscode.MarkdownString(f.h);
                }

                const isFloat = f.h && (f.h.toLowerCase().includes('float') || f.h.toLowerCase().includes('real') || f.n.toUpperCase().startsWith('X') || f.n.toUpperCase().startsWith('Y') || f.n.toUpperCase().startsWith('Z'));
                const defVal = isFloat ? '0.0' : '0';
                const padLen = Math.max(0, f.w - defVal.length);
                const placeholder = ' '.repeat(padLen) + defVal;

                // Insert spaces to align, then insert aligned placeholder
                const insertText = ' '.repeat(padding) + `\${1:${placeholder}}`;
                item.insertText = new vscode.SnippetString(insertText);
                item.range = new vscode.Range(position.line, col, position.line, col);
                // Sort individual fields in order of column position
                item.sortText = '1_' + String(f.p).padStart(3, '0');
                items.push(item);
            }
        }

        return items;
    }
}

const snippetFile = path.join(__dirname, '..', 'snippets', 'lsdyna.json');
let keywordSnippets = null;

class LsdynaKeywordCompletionProvider {
    provideCompletionItems(document, position, token, context) {
        if (!document || shouldSkipAutomaticDocumentScan(document)) return [];

        const line = document.lineAt(position.line);
        const textBeforeCursor = line.text.slice(0, position.character);

        // Only trigger keyword completion if we are exactly at the beginning of the line.
        // It strictly requires that there are no leading spaces before the `*`.
        if (!textBeforeCursor.startsWith('*')) {
            return [];
        }

        if (!keywordSnippets) {
            try {
                const fs = require('fs');
                const data = fs.readFileSync(snippetFile, 'utf8');
                const parsed = JSON.parse(data);
                keywordSnippets = [];
                for (const key in parsed) {
                    const snippet = parsed[key];
                    if (!snippet.prefix || snippet.prefix.length === 0) continue;
                    const item = new vscode.CompletionItem(snippet.prefix[0], vscode.CompletionItemKind.Snippet);
                    let bodyStr = snippet.body.join('\n');
                    // Remove the extra newline before $0 at the end of the snippet
                    bodyStr = bodyStr.replace(/\n\$0$/, '$0');
                    
                    // Remove leading '*' from the snippet body to prevent double '**'
                    if (bodyStr.startsWith('*')) {
                        bodyStr = bodyStr.substring(1);
                    }
                    
                    // Replace non-numeric placeholders with spaces
                    bodyStr = bodyStr.replace(/\$\{\d+:([^}]+)\}/g, (match, p1) => {
                        const trimmed = p1.trim();
                        const isNum = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/i.test(trimmed);
                        if (!isNum && trimmed.length > 0) {
                            return match.replace(p1, ' '.repeat(p1.length));
                        }
                        return match;
                    });

                    item.insertText = new vscode.SnippetString(bodyStr);
                    if (snippet.description) {
                        item.documentation = new vscode.MarkdownString(snippet.description);
                        item.detail = snippet.description;
                    }
                    keywordSnippets.push(item);
                }
            } catch (e) {
                logDebug('Failed to load LS-DYNA snippets: ' + e.message);
                keywordSnippets = [];
            }
        }

        return keywordSnippets;
    }
}


function generateCommentLine(card) {
    if (!card || card.length === 0) return '';
    let line = '$#';
    let written = 2;
    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        const available = f.p + f.w - written;
        if (available <= 0) continue;
        
        const name = (f.n || '').toLowerCase().substring(0, available);
        
        if (f.w >= 40) {
            if (i === 0) {
                line = ('$# ' + name).padEnd(f.p + f.w, ' ');
            } else {
                line += name.padEnd(available, ' ');
            }
        } else {
            line += name.padStart(available, ' ');
        }
        
        written = f.p + f.w;
    }
    return line;
}

async function handleEnterIndentationRemoval(event) {
    if (event.document.languageId !== 'lsdyna') return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) return;

    const change = event.contentChanges[0];
    if (!change) return;

    if (change.rangeLength === 0 && (change.text.startsWith('\n') || change.text.startsWith('\r\n'))) {
        const textAfterNewline = change.text.replace(/^\r?\n/, '');
        if (textAfterNewline.length > 0 && /^\s+$/.test(textAfterNewline)) {
            try {
                const nextLineNum = change.range.start.line + 1;
                const nextLineText = event.document.lineAt(nextLineNum).text;
                if (nextLineText === textAfterNewline) {
                    await editor.edit(editBuilder => {
                        const replaceRange = new vscode.Range(
                            nextLineNum, 0,
                            nextLineNum, textAfterNewline.length
                        );
                        editBuilder.delete(replaceRange);
                    }, { undoStopBefore: false, undoStopAfter: false });
                }
            } catch (err) {
                console.error('[lsdyna] Failed to clear auto indent spaces:', err);
            }
        }
    }
}


function extractSmartTokens(text) {
    const trimmed = text.trimStart();
    const rawTokens = trimmed.split(/\s+/).filter(t => t.length > 0);
    const tokens = [];
    const numPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/i;
    for (const t of rawTokens) {
        if (numPattern.test(t)) {
            tokens.push(t);
            continue;
        }
        const matchAlphaSignedNum = t.match(/^([A-Za-z0-9_]+)([+-](?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/i);
        if (matchAlphaSignedNum) {
            tokens.push(matchAlphaSignedNum[1], matchAlphaSignedNum[2]);
            continue;
        }
        const matchNumNum = t.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([+-](?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/i);
        if (matchNumNum) {
            tokens.push(matchNumNum[1], matchNumNum[2]);
            continue;
        }
        tokens.push(t);
    }
    return tokens;
}

function alignLineText(text, card, isCommentLine = false) {
    if (!card || card.length === 0) return text;

    let processText = text;
    let commentPrefix = '';

    if (isCommentLine) {
        processText = text.trimStart();
        const match = processText.match(/^(\$#?)\s*/);
        if (match) {
            commentPrefix = match[1];
            processText = processText.substring(commentPrefix.length).trimStart();
        } else if (processText.startsWith('$')) {
            commentPrefix = '$';
            processText = processText.substring(1).trimStart();
        }
    }

    if (!processText.trim()) {
        let emptyLine = '';
        let prevEnd = 0;
        for (const f of card) {
            const gap = f.p - prevEnd;
            if (gap > 0) emptyLine += ' '.repeat(gap);
            emptyLine += ' '.repeat(f.w);
            prevEnd = f.p + f.w;
        }
        if (isCommentLine && commentPrefix) {
            if (emptyLine.startsWith(' '.repeat(commentPrefix.length))) {
                return commentPrefix + emptyLine.substring(commentPrefix.length);
            }
            return commentPrefix + emptyLine.substring(1);
        }
        return emptyLine;
    }

    const hasComma = processText.includes(',');
    let useTokens = false;
    let tokens = [];

    if (hasComma) {
        tokens = processText.split(',').map(t => t.trim());
        useTokens = true;
    } else {
        tokens = extractSmartTokens(processText);
        
        let hasInvalidInternalSpace = false;
        const totalCardWidth = card[card.length - 1].p + card[card.length - 1].w;
        const isOverflowing = processText.trimEnd().length > totalCardWidth;

        for (let i = 0; i < card.length; i++) {
            const f = card[i];
            if (f.p >= processText.length) break;
            const rawVal = processText.slice(f.p, Math.min(processText.length, f.p + f.w));
            const val = rawVal.trim();
            if (val.length > 0 && /\s/.test(val)) {
                if (f.t !== 'string' && f.t !== 'character') {
                    hasInvalidInternalSpace = true;
                }
            }
        }
        
        const validPhysValsCount = card.map(f => processText.slice(f.p, f.p + f.w).trim()).filter(v => v.length > 0).length;

        if (isCommentLine || ((hasInvalidInternalSpace || isOverflowing) && tokens.length >= validPhysValsCount)) {
            useTokens = true;
        }
    }

    const physVals = [];
    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        if (f.p >= processText.length) {
            physVals.push('');
            continue;
        }
        const rawVal = processText.slice(f.p, Math.min(processText.length, f.p + f.w));
        physVals.push(rawVal.trim());
    }

    let alignedText = '';
    let prevEnd = 0;

    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        const gap = f.p - prevEnd;
        if (gap > 0) alignedText += ' '.repeat(gap);

        let val = '';
        if (useTokens) {
            if (i < tokens.length) {
                if (i === card.length - 1 && tokens.length > card.length) {
                    val = tokens.slice(i).join(hasComma ? ',' : ' ');
                } else {
                    val = tokens[i];
                }
            }
        } else {
            val = physVals[i];
        }

        let paddedVal;
        if (f.n && f.n.startsWith('PRMR')) {
            let match = val.match(/^([a-zA-Z])\s*(.*)$/);
            if (match) {
                const prefix = match[1];
                const name = match[2];
                if (name.length > 0) {
                    if (1 + 1 + name.length <= f.w) {
                        paddedVal = (prefix + ' ' + name).padEnd(f.w);
                    } else {
                        paddedVal = (prefix + name).substring(0, f.w).padEnd(f.w);
                    }
                } else {
                    paddedVal = prefix.padEnd(f.w);
                }
            } else {
                paddedVal = val.padEnd(f.w);
            }
        } else if (f.w >= 40) {
            paddedVal = val.padEnd(f.w, ' ');
        } else {
            paddedVal = val.padStart(f.w, ' ');
        }
        
        if (isCommentLine && i === 0 && commentPrefix) {
            if (f.w >= 40) {
                paddedVal = (commentPrefix + ' ' + val).substring(0, f.w).padEnd(f.w, ' ');
            } else {
                let trimmedVal = paddedVal.trimStart();
                let spacesLeft = Math.max(0, f.w - commentPrefix.length - trimmedVal.length);
                paddedVal = commentPrefix + ' '.repeat(spacesLeft) + trimmedVal;
            }
        }
        
        alignedText += paddedVal;
        prevEnd = f.p + f.w;
    }

    return alignedText;
}

function getPathEntryRange(document, lineNum, kwLine) {
    let start = lineNum;
    while (start > kwLine + 1) {
        const prevText = document.lineAt(start - 1).text.trim();
        if (prevText.startsWith('*') || prevText.startsWith('$')) {
            break;
        }
        if (prevText.endsWith(' +')) {
            start--;
        } else {
            break;
        }
    }

    let end = lineNum;
    while (end < document.lineCount - 1) {
        const curText = document.lineAt(end).text.trim();
        if (curText.endsWith(' +')) {
            const nextText = document.lineAt(end + 1).text.trim();
            if (nextText.startsWith('*') || nextText.startsWith('$')) {
                break;
            }
            end++;
        } else {
            break;
        }
    }

    return { start, end };
}

async function formatPathEntryIfNeeded(document, lineNum, kwLine) {
    const range = getPathEntryRange(document, lineNum, kwLine);
    const lines = [];
    for (let i = range.start; i <= range.end; i++) {
        lines.push(document.lineAt(i).text);
    }

    const parts = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.endsWith(' +')) {
            parts.push(trimmed.slice(0, -2));
        } else {
            parts.push(trimmed);
        }
    }

    const fullPath = parts.join('');
    
    let newLines = [];
    if (fullPath.length > 80) {
        const maxSegmentLength = 78;
        for (let i = 0; i < fullPath.length; i += maxSegmentLength) {
            const segment = fullPath.slice(i, i + maxSegmentLength);
            if (i + maxSegmentLength < fullPath.length) {
                newLines.push(segment + ' +');
            } else {
                newLines.push(segment);
            }
        }
    } else {
        newLines.push(fullPath);
    }

    const newText = newLines.join('\n');
    const oldText = lines.join('\n');

    if (newText === oldText) return;

    isFormattingLine = true;
    try {
        const endLineText = document.lineAt(range.end).text;
        const replaceRange = new vscode.Range(
            new vscode.Position(range.start, 0),
            new vscode.Position(range.end, endLineText.length)
        );

        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document) {
            await editor.edit(editBuilder => {
                editBuilder.replace(replaceRange, newText);
            }, { undoStopBefore: false, undoStopAfter: false });
        } else {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, replaceRange, newText);
            await vscode.workspace.applyEdit(edit);
        }
    } catch (err) {
        console.error('Error formatting path entry:', err);
    } finally {
        isFormattingLine = false;
    }
}

let isFormattingLine = false;

async function formatLineIfNeeded(document, lineNum) {
    if (isFormattingLine) return;
    if (lineNum >= document.lineCount) return;

    const line = document.lineAt(lineNum);
    const text = line.text;
    const trimmed = text.trimStart();
    
    // Skip keywords
    if (trimmed.startsWith('*')) return;

    // Find the enclosing keyword line
    let kwLine = null;
    for (let i = lineNum - 1; i >= 0; i--) {
        const t = document.lineAt(i).text.trimStart();
        if (t.startsWith('*')) { kwLine = i; break; }
    }
    
    if (kwLine !== null) {
        const kwText = document.lineAt(kwLine).text.trim().toUpperCase();
        if (kwText.startsWith('*PARAMETER')) return;
        if (kwText === '*INCLUDE_PATH' || kwText === '*INCLUDE_PATH_RELATIVE') {
            await formatPathEntryIfNeeded(document, lineNum, kwLine);
            return;
        }
    }

    const isCommentLine = trimmed.startsWith('$');
    let targetLineNum = lineNum;

    if (isCommentLine) {
        for (let i = lineNum + 1; i < document.lineCount; i++) {
            const t = document.lineAt(i).text.trimStart();
            if (t.startsWith('*')) return; // No data card after comment
            if (!t.startsWith('$')) {
                targetLineNum = i;
                break;
            }
        }
    }

    if (targetLineNum === lineNum && isCommentLine) return; // Could not find target data line

    const cardFields = getCardFieldsForLine(document, targetLineNum);
    if (!cardFields || cardFields.length === 0) return;

    const alignedText = alignLineText(text, cardFields, isCommentLine);
    if (text === alignedText) return;

    isFormattingLine = true;
    try {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document) {
            const range = new vscode.Range(
                new vscode.Position(lineNum, 0),
                new vscode.Position(lineNum, text.length)
            );
            await editor.edit(editBuilder => {
                editBuilder.replace(range, alignedText);
            }, { undoStopBefore: false, undoStopAfter: false });
        } else {
            const edit = new vscode.WorkspaceEdit();
            const range = new vscode.Range(
                new vscode.Position(lineNum, 0),
                new vscode.Position(lineNum, text.length)
            );
            edit.replace(document.uri, range, alignedText);
            await vscode.workspace.applyEdit(edit);
        }
    } catch (err) {
        console.error('Error formatting line:', err);
    } finally {
        isFormattingLine = false;
    }
}

async function handleTabAlignment(editor, direction = 1) {
    if (!editor) return;

    const document = editor.document;
    const selection = editor.selection;
    const lineNum = selection.start.line;
    const col = selection.start.character;

    const line = document.lineAt(lineNum);
    const text = line.text;

    const card = getCardFieldsForLine(document, lineNum);
    if (!card || card.length === 0) {
        if (direction === 1) await vscode.commands.executeCommand('tab');
        return;
    }

    // Skip alignment for title/filename fields (single wide field)
    if (card.length === 1 && card[0].w >= 40) {
        if (direction === 1) await vscode.commands.executeCommand('tab');
        return;
    }

    // 1. Determine current field index based on cursor position
    let currentFieldIndex = -1;
    
    const hasComma = text.includes(',');
    let useTokens = false;
    let tokens = [];

    if (hasComma) {
        useTokens = true;
    } else {
        tokens = extractSmartTokens(text);
        
        let hasInvalidInternalSpace = false;
        const totalCardWidth = card[card.length - 1].p + card[card.length - 1].w;
        const isOverflowing = text.trimEnd().length > totalCardWidth;

        for (let i = 0; i < card.length; i++) {
            const f = card[i];
            if (f.p >= text.length) break;
            const rawVal = text.slice(f.p, Math.min(text.length, f.p + f.w));
            const val = rawVal.trim();
            if (val.length > 0 && /\s/.test(val)) {
                if (f.t !== 'string' && f.t !== 'character') {
                    hasInvalidInternalSpace = true;
                }
            }
        }
        
        const validPhysValsCount = card.map(f => text.slice(f.p, f.p + f.w).trim()).filter(v => v.length > 0).length;

        if ((hasInvalidInternalSpace || isOverflowing) && tokens.length >= validPhysValsCount) {
            useTokens = true;
        }
    }

    if (useTokens) {
        const textUpToCursor = text.slice(0, col);
        if (hasComma) {
            currentFieldIndex = textUpToCursor.split(',').length - 1;
        } else {
            const tokensUpToCursor = extractSmartTokens(textUpToCursor);
            if (tokensUpToCursor.length === 0) {
                currentFieldIndex = 0;
            } else {
                currentFieldIndex = tokensUpToCursor.length - 1;
            }
        }
        currentFieldIndex = Math.max(0, Math.min(currentFieldIndex, card.length - 1));
    } else {
        for (let i = 0; i < card.length; i++) {
            const f = card[i];
            const nextF = card[i + 1];
            const end = nextF ? nextF.p : (f.p + f.w);
            if (col >= f.p && col < end) {
                currentFieldIndex = i;
                break;
            }
        }
        if (currentFieldIndex === -1) {
            if (col >= card[card.length - 1].p) {
                currentFieldIndex = card.length - 1;
            } else {
                currentFieldIndex = 0;
            }
        }
    }

    let targetIndex;
    if (direction === 1) {
        targetIndex = currentFieldIndex + 1;
    } else if (direction === -1) {
        targetIndex = currentFieldIndex - 1;
    } else {
        targetIndex = currentFieldIndex;
    }

    // 2. Align current line
    let alignedText = alignLineText(text, card);

    // Ensure alignedText is padded to encompass the target field
    let targetF_pad;
    if (targetIndex >= card.length) {
        targetF_pad = card[0];
    } else if (targetIndex < 0) {
        targetF_pad = card[card.length - 1];
    } else {
        targetF_pad = card[targetIndex];
    }
    const targetEnd = targetF_pad.p + targetF_pad.w;
    if (alignedText.length < targetEnd) {
        alignedText = alignedText.padEnd(targetEnd, ' ');
    }

    // 3. Edit current line
    await editor.edit(editBuilder => {
        const range = new vscode.Range(
            new vscode.Position(lineNum, 0),
            new vscode.Position(lineNum, text.length)
        );
        editBuilder.replace(range, alignedText);
    }, { undoStopBefore: false, undoStopAfter: false });

    // 4. Handle cursor movement
    let targetF;
    let isFirstField = false;
    if (targetIndex >= card.length) {
        targetF = card[0];
        isFirstField = true;
    } else if (targetIndex < 0) {
        targetF = card[card.length - 1];
        isFirstField = false;
    } else {
        targetF = card[targetIndex];
        isFirstField = targetIndex === 0;
    }
    
    const targetCol = targetF.p;
    const targetW = targetF.w;
    const previousF = targetIndex > 0 && targetIndex < card.length ? card[targetIndex - 1] : null;
    const previousValue = previousF ? alignedText.slice(previousF.p, previousF.p + previousF.w).trim() : '';
    const shouldPreserveSeparator = !isFirstField && previousValue.length > 0;
    
    let selStart, selEnd;
    if (isFirstField) {
        selStart = new vscode.Position(lineNum, targetCol);
        selEnd = new vscode.Position(lineNum, targetCol + targetW);
    } else {
        // Preserve the first character as a space for field separation
        selStart = new vscode.Position(lineNum, targetCol + (shouldPreserveSeparator ? 1 : 0));
        selEnd = new vscode.Position(lineNum, targetCol + targetW);
    }
    
    editor.selection = new vscode.Selection(selEnd, selStart);
}

let lastActiveLineNum = null;
let lastActiveDoc = null;

function handleSelectionChange(e) {
    const editor = e && e.textEditor ? e.textEditor : e;
    if (!editor || !isLsdynaFile(editor.document)) {
        lastActiveLineNum = null;
        lastActiveDoc = null;
        vscode.commands.executeCommand('setContext', 'lsdyna.shouldAlignTab', false);
        return;
    }

    const currentLineNum = editor.selection.active.line;
    const currentDoc = editor.document;

    const line = currentDoc.lineAt(currentLineNum);
    const text = line.text;
    const trimmed = text.trimStart();
    const isCardLine = !trimmed.startsWith('*') && !trimmed.startsWith('$');
    const cardFields = isCardLine ? getCardFieldsForLine(currentDoc, currentLineNum) : null;
    const isWideField = cardFields && cardFields.length === 1 && cardFields[0].w >= 40;
    const hasCard = !!(cardFields && cardFields.length > 0) && !isWideField;
    
    vscode.commands.executeCommand('setContext', 'lsdyna.shouldAlignTab', hasCard);

    if (getLsdynaConfigurationValue('autoFormat', 'disabled') === 'onBlur') {
        if (lastActiveDoc === currentDoc && lastActiveLineNum !== null && lastActiveLineNum !== currentLineNum) {
            formatLineIfNeeded(currentDoc, lastActiveLineNum);
        }
    }

    lastActiveLineNum = currentLineNum;
    lastActiveDoc = currentDoc;
}

// --- Activate ---

/**
 * Standard VS Code extension activation hook. Configures commands, providers, and watchers.
 * 
 * @param {import('vscode').ExtensionContext} context - The extension context.
 */
function activate(context) {

    let includeTreeView;
    let keywordTreeView;

    manualIndexer.initialize(context).catch(err => {
        console.error('Failed to initialize manual indexer:', err);
    });

    const debugChannel = vscode.window.createOutputChannel("LS-DYNA Debug");
    context.subscriptions.push(debugChannel);
    function logDebug(message) {
        debugChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
    logDebug("Extension activated.");

    const snippetsPath = typeof context.asAbsolutePath === 'function'
        ? context.asAbsolutePath(path.join('snippets', 'lsdyna.json'))
        : path.join(getExtensionPath(context), 'snippets', 'lsdyna.json');
    fs.readFile(snippetsPath, 'utf8', (err, data) => {
        if (!err) {
            try {
                const json = JSON.parse(data);
                const validSet = new Set();
                for (const key of Object.keys(json)) {
                    if (key.startsWith('*')) {
                        validSet.add(key.slice(1).toUpperCase());
                    }
                }
                keywordValidator.init(validSet);
                vscode.workspace.textDocuments.forEach(updateDiagnostics);
            } catch (e) {
                console.error("Failed to parse lsdyna.json for keyword validation", e);
            }
        }
    });

    associateLsdynaLanguages();

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            if (isLsdynaUri(doc.uri) && doc.languageId !== 'lsdyna') {
                vscode.languages.setTextDocumentLanguage(doc, 'lsdyna').then(undefined, err => {
                    console.error('[lsdyna] Failed to set text document language:', err);
                });
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('lsdyna.language')) {
                i18n.updateLanguage();
                _fieldData = null;
                if (includeTreeView) {
                    includeTreeView.title = i18n.get('includeTreeTitle');
                }
                if (keywordTreeView) {
                    keywordTreeView.title = i18n.get('keywordIndexTitle');
                }
            }
            if (e.affectsConfiguration('lsdyna.additionalExtensions')) {
                associateLsdynaLanguages();
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(handleEnterIndentationRemoval)
    );

    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider({ language: 'lsdyna' }, new LsDynaFoldingProvider())
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider({ language: 'lsdyna' }, new LsdynaKeywordSymbolProvider())
    );

    // context.subscriptions.push(
    //     vscode.languages.registerDocumentLinkProvider({ language: 'lsdyna' }, new LsdynaDocumentLinkProvider())
    // );

    context.subscriptions.push(
        vscode.languages.registerHoverProvider({ language: 'lsdyna' }, new LsdynaFieldHoverProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ language: 'lsdyna' }, new LsdynaParameterCodeLensProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ language: 'lsdyna' }, new LsdynaKeywordOptionsCodeLensProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'lsdyna' },
            new LsdynaIncludeCompletionProvider(),
            '/', '\\'
        )
    );
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'lsdyna' },
            new LsdynaFieldCompletionProvider(),
            '$', '#'
        )
    );
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'lsdyna' },
            new LsdynaKeywordCompletionProvider(),
            '*'
        )
    );


    const client = startLanguageServer(context);
    const indexClient = createIndexClient({ languageClient: client });

    const projectDiagnostics = vscode.languages.createDiagnosticCollection('lsdyna-project');
    context.subscriptions.push(projectDiagnostics);

    const originalLoadProjectSnapshot = indexClient.loadProjectSnapshot;
    indexClient.loadProjectSnapshot = async (rootFile) => {
        const snapshot = await originalLoadProjectSnapshot(rootFile);
        publishProjectDiagnostics(snapshot, projectDiagnostics);
        return snapshot;
    };

    const enqueueProjectSnapshotRefresh = createProjectSnapshotRefreshQueue({
        loadProjectSnapshot: indexClient.loadProjectSnapshot,
        onError(error, rootFile) {
            console.error(`[lsdyna] Failed to refresh project snapshot for ${rootFile}:`, error);
        },
    });
    const invalidateChangedProjectRoots = createBatchedManifestInvalidator({
        indexClient,
        onInvalidatedRoots(roots) {
            for (const rootFile of roots) {
                enqueueProjectSnapshotRefresh(rootFile);
            }
        },
    });
    const includeTreeProvider = new LsdynaIncludeTreeProvider({
        searchFileFromPaths,
        loadProjectSnapshot: indexClient.loadProjectSnapshot,
        invalidateProjectSnapshot: indexClient.invalidate,
    });
    includeTreeView = vscode.window.createTreeView('lsdynaIncludeTree', {
        treeDataProvider: includeTreeProvider
    });
    includeTreeView.title = i18n.get('includeTreeTitle');
    context.subscriptions.push(includeTreeView);

    const fileDecorationProvider = new LsdynaFileDecorationProvider(includeTreeProvider);
    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(fileDecorationProvider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.scanIncludeTree', async () => {
            await includeTreeProvider.scan();
            fileDecorationProvider.refresh();
        })
    );

    const keywordIndexProvider = new LsdynaKeywordIndexProvider({
        shouldSkipAutomaticDocumentScan,
        searchFileFromPaths,
        loadProjectSnapshot: indexClient.loadProjectSnapshot,
        invalidateProjectSnapshot: indexClient.invalidate,
    });
    keywordTreeView = vscode.window.createTreeView('lsdynaKeywordIndex', {
        treeDataProvider: keywordIndexProvider
    });
    keywordTreeView.title = i18n.get('keywordIndexTitle');
    context.subscriptions.push(keywordTreeView);
    vscode.commands.executeCommand('setContext', 'lsdyna.keywordIndexMode', 'local');
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.scanKeywordIndex', () => keywordIndexProvider.scan())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.keywordIndexSetLocal', () => keywordIndexProvider.setLocal())
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            logDebug(`onDidChangeActiveTextEditor: editor=${editor ? editor.document.uri.toString() : 'none'}, languageId=${editor ? editor.document.languageId : 'none'}`);
            if (editor) {
                keywordIndexProvider.refreshFromUriOrDocument(editor.document);
            } else {
                const uri = getActiveUri();
                logDebug(`onDidChangeActiveTextEditor callback fallback: getActiveUri=${uri ? uri.toString() : 'null'}`);
                if (uri) {
                    keywordIndexProvider.refreshFromUriOrDocument(uri);
                }
            }
        })
    );
    if (vscode.window.tabGroups && typeof vscode.window.tabGroups.onDidChangeTabs === 'function') {
        context.subscriptions.push(
            vscode.window.tabGroups.onDidChangeTabs(() => {
                const uri = getActiveUri();
                const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
                logDebug(`onDidChangeTabs: activeTab=${activeTab ? activeTab.label : 'none'}, inputType=${activeTab?.input?.constructor?.name || 'none'}, getActiveUri=${uri ? uri.toString() : 'null'}`);
                if (uri) {
                    keywordIndexProvider.refreshFromUriOrDocument(uri);
                }
            })
        );
    }
    const scheduleKeywordIndexRefresh = createActiveDocumentDebouncer(
        () => vscode.window.activeTextEditor?.document || getActiveUri(),
        uriOrDoc => {
            logDebug(`Debounced keyword index refresh triggered`);
            keywordIndexProvider.refreshFromUriOrDocument(uriOrDoc);
        }
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (vscode.window.activeTextEditor?.document === e.document) {
                keywordIndexProvider.updateDocumentIndex(e.document, e);
                scheduleKeywordIndexRefresh(e.document);
            }
        })
    );
    const workspaceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{k,key,dyna}');
    context.subscriptions.push(workspaceWatcher);
    context.subscriptions.push(workspaceWatcher.onDidChange(uri => invalidateChangedProjectRoots(uri)));
    context.subscriptions.push(workspaceWatcher.onDidCreate(uri => invalidateChangedProjectRoots(uri)));
    context.subscriptions.push(workspaceWatcher.onDidDelete(uri => invalidateChangedProjectRoots(uri)));

    const initialUri = getActiveUri();
    logDebug(`initialUri: ${initialUri ? initialUri.toString() : 'null'}`);
    if (initialUri) {
        keywordIndexProvider.refreshFromUriOrDocument(initialUri);
    }
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.goToKeywordUsage', (filePath, lineIndex) => {
            const uri = vscode.Uri.file(filePath);
            const pos = new vscode.Position(lineIndex, 0);
            const range = new vscode.Range(pos, pos);
            vscode.commands.executeCommand('vscode.open', uri, { selection: range }).then(undefined, () => {
                vscode.workspace.openTextDocument(filePath).then(doc => {
                    vscode.window.showTextDocument(doc, { selection: range });
                });
            });
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openToSide', (node) => {
            const uri = node.resourceUri || (node.filePath ? vscode.Uri.file(node.filePath) : null);
            if (uri) {
                vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Beside });
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.revealInExplorer', (node) => {
            const uri = node.resourceUri || (node.filePath ? vscode.Uri.file(node.filePath) : null);
            if (uri) {
                if (process.platform === 'win32') {
                    child_process.exec(`explorer.exe /select,"${uri.fsPath}"`);
                } else {
                    vscode.commands.executeCommand('revealFileInOS', uri);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openIncludeNewTab', (filePath) => {
            try {
                const uri = vscode.Uri.file(filePath);
                vscode.commands.executeCommand('vscode.open', uri, { preview: false });
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openIncludeSplit', (filePath) => {
            try {
                const uri = vscode.Uri.file(filePath);
                vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to split open file: ${err.message}`);
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openIncludeFolder', (filePath) => {
            try {
                const uri = vscode.Uri.file(filePath);
                if (process.platform === 'win32') {
                    child_process.exec(`explorer.exe /select,"${uri.fsPath}"`);
                } else {
                    vscode.commands.executeCommand('revealFileInOS', uri);
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to reveal folder: ${err.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openManual', async (pdfPath, pageNum) => {
            if (!pdfPath) return;
            if (typeof pdfPath !== 'string') return;
            if (pdfPath.includes('"') || pdfPath.includes('&') || pdfPath.includes('|') || pdfPath.includes(';')) {
                vscode.env.openExternal(vscode.Uri.file(pdfPath));
                return;
            }

            if (process.platform === 'win32') {
                try {
                    const exePath = await resolveSumatraPath(context);
                    if (exePath) {
                        const args = ['-reuse-instance'];
                        if (pageNum) {
                            args.push('-page', String(pageNum));
                        }
                        args.push(`"${pdfPath}"`);

                        // Use cmd.exe 'start' to launch SumatraPDF in a new window context.
                        // Direct spawn inherits VS Code Extension Host's hidden-window flags,
                        // which prevents GUI applications from creating visible windows.
                        const cmdArgs = args.join(' ');
                        const cmd = `start "" "${exePath}" ${cmdArgs}`;
                        child_process.exec(cmd, (err) => {
                            if (err) {
                                openManualFallback(pdfPath, pageNum);
                            }
                        });
                    } else {
                        openManualFallback(pdfPath, pageNum);
                    }
                } catch (e) {
                    openManualFallback(pdfPath, pageNum);
                }
            } else {
                vscode.env.openExternal(vscode.Uri.file(pdfPath));
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.configureManualsDir', async () => {
            const folders = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: i18n.get('selectFolder')
            });
            if (folders && folders[0]) {
                const selectedPath = folders[0].fsPath;
                const config = vscode.workspace.getConfiguration('lsdyna');
                try {
                    await config.update('manualsDir', selectedPath, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage(i18n.get('manualDirSetTo', selectedPath));
                } catch (err) {
                    vscode.window.showErrorMessage(i18n.get('failedToSaveGlobalConfig', err.message));
                }
                
                if (process.platform === 'win32') {
                    const fs = require('fs');
                    const path = require('path');
                    const sumatraPath = path.join(selectedPath, 'SumatraPDF.exe');
                    if (!fs.existsSync(sumatraPath)) {
                        vscode.window.showWarningMessage(i18n.get('sumatraNotFound'));
                    }
                }
                await manualIndexer.initialize(context);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaChooseKeywordOptions', async (lineNum) => {
            return chooseKeywordOptionsForEditor(vscode.window.activeTextEditor, lineNum);
        })
    );

    const diagnostics = vscode.languages.createDiagnosticCollection('lsdyna');
    context.subscriptions.push(diagnostics);

    function updateDiagnostics(document) {
        if (!isLsdynaFile(document)) return;
        
        const lineLengthDiagnostics = collectLineLengthDiagnostics(document);
        const keywordValidationDiagnostics = keywordValidator.collectKeywordValidationDiagnostics(document, shouldSkipAutomaticDocumentScan);
        
        diagnostics.set(document.uri, [...lineLengthDiagnostics, ...keywordValidationDiagnostics]);
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => updateDiagnostics(doc))
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => updateDiagnostics(e.document))
    );
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => diagnostics.delete(doc.uri))
    );
    vscode.workspace.textDocuments.forEach(updateDiagnostics);

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider({ language: 'lsdyna' }, new LsdynaDefinitionProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerReferenceProvider({ language: 'lsdyna' }, new LsdynaReferenceProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerRenameProvider({ language: 'lsdyna' }, new LsdynaRenameProvider())
    );

    // Decorations: green for resolved paths, yellow for missing ones
    const checkmarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="%2389d185" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"></path></svg>`;
    const resolvedDecoration = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor('textLink.foreground'),
        gutterIconPath: vscode.Uri.parse(`data:image/svg+xml;utf8,${checkmarkSvg}`),
        gutterIconSize: 'contain',
    });
    
    const warningSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="%23cca700" d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z"></path></svg>`;
    const missingDecoration = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor('list.warningForeground'),
        fontStyle: 'italic',
        gutterIconPath: vscode.Uri.parse(`data:image/svg+xml;utf8,${warningSvg}`),
        gutterIconSize: 'contain',
    });
    const keywordDecoration = vscode.window.createTextEditorDecorationType({
        fontWeight: 'bold'
    });
    context.subscriptions.push(resolvedDecoration, missingDecoration, keywordDecoration);

    function updateDecorations(editor) {
        if (!editor || !isLsdynaFile(editor.document)) return;
        const { resolved, missing } = collectIncludeDecorationSets(editor.document);

        editor.setDecorations(resolvedDecoration, resolved);
        editor.setDecorations(missingDecoration, missing);

        const keywordRanges = collectKeywordDecorationRanges(editor.document);
        editor.setDecorations(keywordDecoration, keywordRanges);
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (lastActiveDoc && lastActiveLineNum !== null) {
                formatLineIfNeeded(lastActiveDoc, lastActiveLineNum);
            }
            if (editor) {
                lastActiveLineNum = editor.selection.active.line;
                lastActiveDoc = editor.document;
            } else {
                lastActiveLineNum = null;
                lastActiveDoc = null;
            }
            updateDecorations(editor);
            updateIncludeLineContext(editor);
        })
    );
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (vscode.window.activeTextEditor?.document === event.document) {
                updateDecorations(vscode.window.activeTextEditor);
            }
        })
    );

    updateDecorations(vscode.window.activeTextEditor);

    function updateIncludeLineContext(editor) {
        if (!editor || !isLsdynaFile(editor.document)) {
            vscode.commands.executeCommand('setContext', 'lsdyna.onIncludeLine', false);
            return;
        }
        const currentLine = editor.selection.active.line;
        const onInclude = isIncludeLine(editor.document, currentLine);
        vscode.commands.executeCommand('setContext', 'lsdyna.onIncludeLine', onInclude);
    }

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
            handleSelectionChange(e);
            updateIncludeLineContext(e.textEditor);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
            if (lastActiveDoc === doc && lastActiveLineNum !== null) {
                formatLineIfNeeded(doc, lastActiveLineNum);
            }
        })
    );

    updateIncludeLineContext(vscode.window.activeTextEditor);
    if (vscode.window.activeTextEditor) {
        lastActiveLineNum = vscode.window.activeTextEditor.selection.active.line;
        lastActiveDoc = vscode.window.activeTextEditor.document;
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaTab', () => {
            return handleTabAlignment(vscode.window.activeTextEditor, 1);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaShiftTab', () => {
            return handleTabAlignment(vscode.window.activeTextEditor, -1);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaSelectCell', () => {
            return handleTabAlignment(vscode.window.activeTextEditor, 0);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.lsdynaFormatSelection', async (lineNumArg) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const document = editor.document;
            let selections = editor.selections;
            
            if (typeof lineNumArg === 'number') {
                try {
                    const startLine = startLineOfCurrentKeywordFromLineReader(
                        document.lineCount,
                        i => document.lineAt(i).text,
                        lineNumArg
                    );
                    const endLine = endLineOfCurrentKeywordFromLineReader(
                        document.lineCount,
                        i => document.lineAt(i).text,
                        lineNumArg
                    );
                    selections = [new vscode.Selection(
                        new vscode.Position(startLine, 0),
                        new vscode.Position(endLine, 0)
                    )];
                } catch (e) {
                    // Fallback
                }
            }
            
            await editor.edit(editBuilder => {
                for (const sel of selections) {
                    for (let lineNum = sel.start.line; lineNum <= sel.end.line; lineNum++) {
                        const line = document.lineAt(lineNum);
                        const text = line.text;
                        const trimmed = text.trimStart();
                        let currentKwText = null;
                        for (let i = lineNum; i >= 0; i--) {
                            const t = document.lineAt(i).text.trimStart();
                            if (t.startsWith('*')) {
                                currentKwText = t.toUpperCase();
                                break;
                            }
                        }
                        if (currentKwText && currentKwText.startsWith('*PARAMETER')) continue;

                        const isCardLine = !trimmed.startsWith('*') && !trimmed.startsWith('$');
                        const isCommentLine = trimmed.startsWith('$');
                        
                        let targetLineNum = lineNum;
                        if (isCommentLine) {
                            for (let i = lineNum + 1; i < document.lineCount; i++) {
                                const t = document.lineAt(i).text.trimStart();
                                if (t.startsWith('*')) break;
                                if (!t.startsWith('$')) {
                                    targetLineNum = i;
                                    break;
                                }
                            }
                        }

                        if (targetLineNum !== lineNum || isCardLine) {
                            const card = getCardFieldsForLine(document, targetLineNum);
                            if (card && card.length > 0) {
                                const alignedText = alignLineText(text, card, isCommentLine);
                                if (alignedText !== text) {
                                    const range = new vscode.Range(
                                        new vscode.Position(lineNum, 0),
                                        new vscode.Position(lineNum, text.length)
                                    );
                                    editBuilder.replace(range, alignedText);
                                }
                            }
                        }
                    }
                }
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openIncludeFile', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            try {
                const fullPath = searchFileFromPaths(
                    getFilenameFromDocument(editor.document, editor.selection.active.line),
                    getSearchPath(editor.document)
                );
                const uri = vscode.Uri.file(fullPath);
                vscode.commands.executeCommand('vscode.open', uri).then(undefined, () => {
                    vscode.workspace.openTextDocument(fullPath).then(doc => vscode.window.showTextDocument(doc));
                });
            } catch (error) {
                vscode.window.showErrorMessage(error.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.selectKeyword', (lineNumArg) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const currentLine = typeof lineNumArg === 'number' ? lineNumArg : editor.selection.active.line;
            try {
                const startLine = startLineOfCurrentKeywordFromLineReader(
                    editor.document.lineCount,
                    i => editor.document.lineAt(i).text,
                    currentLine
                );
                const endLine = endLineOfCurrentKeywordFromLineReader(
                    editor.document.lineCount,
                    i => editor.document.lineAt(i).text,
                    currentLine
                );
                editor.selection = new vscode.Selection(
                    new vscode.Position(startLine, 0),
                    new vscode.Position(endLine + 1, 0)
                );
            } catch (error) {
                vscode.window.showErrorMessage(error.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.jumpToNextKeyword', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            try {
                const nextLine = findNextKeywordInDocument(editor.document, editor.selection.active.line);
                const position = new vscode.Position(nextLine, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            } catch (error) {
                vscode.window.showErrorMessage(error.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.jumpToPreviousKeyword', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            try {
                const prevLine = findPreviousKeywordInDocument(editor.document, editor.selection.active.line);
                const position = new vscode.Position(prevLine, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            } catch (error) {
                vscode.window.showErrorMessage(error.message);
            }
        })
    );
}

/**
 * Standard VS Code extension deactivation hook.
 */
function deactivate() {
}

/**
 * Creates an invalidation trigger that flushes caches mapping to modified files.
 * 
 * @param {Object} params - Options.
 * @param {Object} params.indexClient - Index client handle.
 * @param {function} [params.findAffectedRoots] - Roots mapping function.
 * @returns {function(string|import('vscode').Uri): void} Invalidation callback.
 */
type ManifestDrivenInvalidatorOptions = {
    indexClient?: any;
    findAffectedRoots?: (changedFilePath: string, manifestEntries: any[]) => string[];
};

function createManifestDrivenInvalidator({ indexClient, findAffectedRoots = findAffectedProjectRoots }: ManifestDrivenInvalidatorOptions = {}) {
    if (!indexClient || typeof indexClient.invalidate !== 'function' || typeof indexClient.getManifestEntries !== 'function') {
        throw new TypeError('createManifestDrivenInvalidator requires indexClient.invalidate and indexClient.getManifestEntries');
    }
    if (typeof findAffectedRoots !== 'function') {
        throw new TypeError('createManifestDrivenInvalidator requires a findAffectedRoots function');
    }

    return function invalidateChangedFile(fileUriOrPath) {
        const changedFilePath = typeof fileUriOrPath === 'string'
            ? fileUriOrPath
            : fileUriOrPath && fileUriOrPath.fsPath;
        if (!changedFilePath) return;

        const affectedRoots = findAffectedRoots(changedFilePath, indexClient.getManifestEntries());
        for (const rootFile of affectedRoots) {
            indexClient.invalidate(rootFile);
        }
    };
}

/**
 * Creates a debounced invalidation trigger that groups file modifications into batched updates.
 * 
 * @param {Object} params - Options.
 * @param {Object} params.indexClient - Index client.
 * @param {function} [params.findAffectedRoots] - Affected roots resolver.
 * @param {function(string[]): void} [params.onInvalidatedRoots] - Batched roots completion callback.
 * @param {number} [params.delayMs=100] - Debounce delay.
 * @param {function} [params.schedule=setTimeout] - Scheduler.
 * @param {function} [params.cancel=clearTimeout] - Canceler.
 * @returns {function(string|import('vscode').Uri): void} Enqueuing callback.
 */
function createBatchedManifestInvalidator({
    indexClient,
    findAffectedRoots = findAffectedProjectRoots,
    onInvalidatedRoots = () => {},
    delayMs = 100,
    schedule = setTimeout,
    cancel = clearTimeout,
}: {
    indexClient?: any;
    findAffectedRoots?: (changedFilePath: string, manifestEntries: any[]) => string[];
    onInvalidatedRoots?: (roots: string[]) => void;
    delayMs?: number;
    schedule?: (callback: () => void, delayMs: number) => any;
    cancel?: (timer: any) => void;
} = {}) {
    if (typeof onInvalidatedRoots !== 'function') {
        throw new TypeError('createBatchedManifestInvalidator requires onInvalidatedRoots to be a function');
    }
    let timer = null;
    const pendingRoots = new Map();

    return function queueChangedFile(fileUriOrPath) {
        const changedFilePath = typeof fileUriOrPath === 'string'
            ? fileUriOrPath
            : fileUriOrPath && fileUriOrPath.fsPath;
        if (!changedFilePath) return;

        const affectedRoots = findAffectedRoots(changedFilePath, indexClient.getManifestEntries());
        if (affectedRoots.length === 0) return;
        for (const rootFile of affectedRoots) {
            const resolvedRootFile = path.resolve(rootFile);
            const rootKey = process.platform === 'win32'
                ? resolvedRootFile.toLowerCase()
                : resolvedRootFile;
            pendingRoots.set(rootKey, rootFile);
        }

        if (timer) cancel(timer);
        timer = schedule(() => {
            timer = null;
            const roots = [...pendingRoots.values()];
            pendingRoots.clear();
            for (const rootFile of roots) {
                indexClient.invalidate(rootFile);
            }
            onInvalidatedRoots(roots);
        }, delayMs);
    };
}

/**
 * Creates a sequential execution queue for rebuilding project snapshots, deduplicating rapid triggers.
 * 
 * @param {Object} params - Options.
 * @param {function(string): Promise<any>} params.loadProjectSnapshot - Loader function.
 * @param {function(Error, string): void} [params.onError] - Error callback.
 * @param {function} [params.schedule=setImmediate] - Queue execution handler.
 * @returns {function(string): void} Enqueue project callback.
 */
function createProjectSnapshotRefreshQueue({
    loadProjectSnapshot,
    onError = () => {},
    schedule = setImmediate,
}: {
    loadProjectSnapshot?: (rootFile: string) => Promise<any>;
    onError?: (error: any, rootFile: string | null) => void;
    schedule?: (callback: () => void) => any;
} = {}) {
    if (typeof loadProjectSnapshot !== 'function') {
        throw new TypeError('createProjectSnapshotRefreshQueue requires a loadProjectSnapshot function');
    }
    if (typeof onError !== 'function') {
        throw new TypeError('createProjectSnapshotRefreshQueue requires an onError function');
    }
    if (typeof schedule !== 'function') {
        throw new TypeError('createProjectSnapshotRefreshQueue requires a schedule function');
    }

    const pendingRoots = new Map();
    let activeRootKey = null;
    let flushScheduled = false;
    let processing = false;

    async function drainQueue() {
        if (processing) return;
        processing = true;
        flushScheduled = false;
        try {
            while (pendingRoots.size > 0) {
                const [rootKey, rootFile] = pendingRoots.entries().next().value;
                pendingRoots.delete(rootKey);
                activeRootKey = rootKey;
                try {
                    await loadProjectSnapshot(rootFile);
                } catch (error) {
                    onError(error, rootFile);
                } finally {
                    activeRootKey = null;
                }
            }
        } finally {
            processing = false;
        }
    }

    return function enqueueProjectSnapshotRefresh(rootFile) {
        const resolvedRootFile = path.resolve(rootFile);
        const rootKey = process.platform === 'win32'
            ? resolvedRootFile.toLowerCase()
            : resolvedRootFile;
        if (rootKey === activeRootKey || pendingRoots.has(rootKey)) return;

        pendingRoots.set(rootKey, resolvedRootFile);
        if (flushScheduled || processing) return;

        flushScheduled = true;
        schedule(() => {
            drainQueue().catch(error => onError(error, null));
        });
    };
}

// createProjectIndexLoader is now imported from src/worker/projectIndexLoader.js

/**
 * Factory helper to construct the persistent L2 cache in globalStorage.
 * 
 * @param {Object} params - Options.
 * @param {import('vscode').Uri|null} [params.storageUri] - VS Code global storage directory URI.
 * @param {function(Object): import('./core/cache/diskSnapshotStore').DiskSnapshotStore} [params.createStore] - Store factory.
 * @returns {import('./core/cache/diskSnapshotStore').DiskSnapshotStore|null} Store instance, or null.
 */
function createProjectSnapshotPersistentCache({
    storageUri = null,
    createStore = createDiskSnapshotStore,
}: {
    storageUri?: any;
    createStore?: (options: { cacheDirectory: string; maxCacheBytes: number }) => any;
} = {}) {
    if (!storageUri || typeof storageUri.fsPath !== 'string' || storageUri.fsPath.trim() === '') {
        return null;
    }

    return createStore({
        cacheDirectory: path.join(storageUri.fsPath, 'project-snapshots'),
        maxCacheBytes: PROJECT_SNAPSHOT_DISK_CACHE_BYTES,
    });
}

/**
 * Publishes diagnostic warnings and errors (missing files, circular dependencies)
 * mapped to project snapshot results.
 * 
 * @param {import('./core/project/projectIndexer').ProjectIndexResult} snapshot - snapshot to translate.
 * @param {import('vscode').DiagnosticCollection} diagnosticsCollection - Target collection.
 */
function publishProjectDiagnostics(snapshot, diagnosticsCollection) {
    if (!snapshot || !snapshot.files) return;

    for (const filePath of snapshot.files) {
        diagnosticsCollection.delete(vscode.Uri.file(filePath));
    }

    const fileDiagnostics = new Map();

    const addDiag = (filePath, diag) => {
        if (!fileDiagnostics.has(filePath)) fileDiagnostics.set(filePath, []);
        fileDiagnostics.get(filePath).push(diag);
    };

    for (const record of snapshot.missingFiles || []) {
        if (!record.fromFile) continue;
        const lineIdx = record.lineIndex !== undefined ? record.lineIndex : 0;
        const start = record.startChar !== undefined ? record.startChar : 0;
        const end = record.endChar !== undefined ? record.endChar : 80;
        const range = new vscode.Range(
            new vscode.Position(lineIdx, start),
            new vscode.Position(lineIdx, end)
        );
        const diagnostic = new vscode.Diagnostic(
            range,
            `Included file "${record.fileName}" not found.`,
            vscode.DiagnosticSeverity.Warning
        );
        diagnostic.source = 'lsdyna';
        diagnostic.code = 'missing-include';
        addDiag(record.fromFile, diagnostic);
    }

    for (const record of snapshot.cycles || []) {
        if (!record.fromFile) continue;
        const lineIdx = record.lineIndex !== undefined ? record.lineIndex : 0;
        const start = record.startChar !== undefined ? record.startChar : 0;
        const end = record.endChar !== undefined ? record.endChar : 80;
        const range = new vscode.Range(
            new vscode.Position(lineIdx, start),
            new vscode.Position(lineIdx, end)
        );
        const cyclePathStr = record.path ? record.path.map(p => path.basename(p)).join(' -> ') : '';
        const diagnostic = new vscode.Diagnostic(
            range,
            `Circular include dependency detected: ${cyclePathStr}`,
            vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = 'lsdyna';
        diagnostic.code = 'circular-include';
        addDiag(record.fromFile, diagnostic);
    }

    for (const [filePath, diags] of fileDiagnostics.entries()) {
        diagnosticsCollection.set(vscode.Uri.file(filePath), diags);
    }
}


/**
 * Resolves absolute path to SumatraPDF.exe in manuals directory if available.
 * 
 * @param {import('vscode').ExtensionContext} context - Context.
 * @returns {Promise<string|null>} Resolved path, or null.
 */
async function resolveSumatraPath(context) {
    const fs = require('fs');
    const path = require('path');
    const manualsDir = getLsdynaConfigurationValue('manualsDir', 'lsdyna_manual_pack') || 'lsdyna_manual_pack';
    if (manualsDir && typeof manualsDir === 'string') {
        const dirsToCheck = [];
        if (path.isAbsolute(manualsDir)) {
            dirsToCheck.push(manualsDir);
        } else {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                dirsToCheck.push(path.resolve(workspaceFolders[0].uri.fsPath, manualsDir));
            }
            dirsToCheck.push(path.resolve(process.cwd(), manualsDir));
            if (vscode.env && vscode.env.appRoot) {
                dirsToCheck.push(path.resolve(vscode.env.appRoot, manualsDir));
            }
            dirsToCheck.push(path.resolve(getExtensionPath(context), manualsDir));
        }

        for (const dir of dirsToCheck) {
            const sumatraPath = path.join(dir, 'SumatraPDF.exe');
            if (fs.existsSync(sumatraPath)) {
                return sumatraPath;
            }
        }
    }
    return null;
}

/**
 * Fallback open command invoking cmd.exe shell start to recycle SumatraPDF or system browser windows.
 * 
 * @param {string} pdfPath - File path.
 * @param {number} [pageNum] - Page number.
 */
function openManualFallback(pdfPath, pageNum) {
    let fileUrl = `file:///${pdfPath.replace(/\\/g, '/')}`;
    if (pageNum) {
        fileUrl += `#page=${pageNum}`;
    }
    try {
        child_process.exec(`cmd.exe /c start "" "${fileUrl}"`, (error) => {
            if (error) {
                vscode.env.openExternal(vscode.Uri.file(pdfPath));
            }
        });
    } catch (e) {
        vscode.env.openExternal(vscode.Uri.file(pdfPath));
    }
}

module.exports = { activate, deactivate };

// Exported for unit testing
module.exports._internals = {
    publishProjectDiagnostics,
    collectIncludeDecorationSets,
    collectKeywordDecorationRanges,
    collectIncludeDocumentLinks,
    collectLineLengthDiagnostics,
    createActiveDocumentDebouncer,
    collectIncludeFiles,
    findParameterDefinitions,
    findParameterReferences,
    findIncludeFileLines,
    LsdynaIncludeTreeProvider,
    LsdynaFieldHoverProvider,
    LsdynaKeywordOptionsCodeLensProvider,
    LsdynaKeywordIndexProvider,
    LsdynaKeywordSymbolProvider,
    LsDynaFoldingProvider,
    getFilenameFromDocument,
    getSearchPath,
    getParameterAtCursor,
    isIncludeLine,
    isLsdynaUri,
    findNextKeywordInDocument,
    findPreviousKeywordInDocument,
    shouldSkipAutomaticDocumentScan,
    startLineOfCurrentKeyword,
    endLineOfCurrentKeyword,
    getFilenameFromKeyword,
    searchFileFromPaths,
    findNextKeyword,
    findPreviousKeyword,
    createManifestDrivenInvalidator,
    createBatchedManifestInvalidator,
    createProjectSnapshotRefreshQueue,
    createProjectIndexLoader,
    createProjectSnapshotPersistentCache,
    chooseKeywordOptionsForEditor,
    LsdynaFileDecorationProvider,
    normalizePathKey,
    LsdynaIncludeCompletionProvider,
    LsdynaFieldCompletionProvider,
    getCardFieldsForLine,
    generateCommentLine,
    handleEnterIndentationRemoval,
    alignLineText,
    formatLineIfNeeded,
    handleTabAlignment,
    handleSelectionChange,
    getPathEntryRange,
    formatPathEntryIfNeeded,
    LsdynaKeywordCompletionProvider,
};
