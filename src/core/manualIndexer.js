'use strict';

/**
 * @fileoverview Bookmark extraction and location indexing service for LS-DYNA PDF manuals.
 * @module core/manualIndexer
 * 
 * This service parses PDF outlines (bookmarks) using custom low-level binary readers to map
 * LS-DYNA keywords (e.g. *NODE, *ELEMENT) to their corresponding page numbers in PDF manuals.
 * It caches the parsed outlines in the extension's workspaceState using mtime/size checks and 
 * installs directory watch loops to auto-reload if PDF manuals are added or updated.
 * 
 * Role in System: Provides targets for keyword and field hovers and powers the openManual command
 * to jump to precise pages in PDF manuals (including SumatraPDF precision alignment).
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

/**
 * @typedef {Object} ManualLocation
 * @property {string} file - Absolute path to the PDF manual file.
 * @property {number} page - 1-based page number where the keyword definition resides.
 */

/**
 * @typedef {Object} BookmarkEntry
 * @property {string} title - The title text of the PDF outline item.
 * @property {number|null} page - The 1-based page number reference, or null if unresolved.
 */

/**
 * Global map storing associations between cleaned keyword names and their locations in the manuals.
 * @type {Map<string, ManualLocation[]>}
 */
let keywordMap = new Map();

/**
 * Version number for the bookmark serialization format.
 * Used to invalidate cached items if parsing rules change.
 * @type {number}
 */
const CACHE_VERSION = 2;

/**
 * VS Code OutputChannel for indexer log messages.
 * @type {import('vscode').OutputChannel}
 */
let outputChannel;

/**
 * List of resolved PDF manuals files.
 * @type {string[]}
 */
let pdfFilesList = [];

/**
 * Watcher instances for manuals directories.
 * @type {import('fs').FSWatcher[]}
 */
let dirWatchers = [];

/**
 * Debouncing timer for manual file change refreshes.
 * @type {NodeJS.Timeout|null}
 */
let refreshTimeout = null;

/**
 * Appends a log line to the LS-DYNA Manuals output channel.
 * 
 * @param {string} msg - Message to log.
 */
function log(msg) {
    if (!outputChannel && typeof vscode !== 'undefined' && vscode.window) {
        outputChannel = vscode.window.createOutputChannel("LS-DYNA Manuals");
    }
    if (outputChannel) {
        outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
    }
}

const { stripTitleSuffix } = require('./keywordUtils');

/**
 * Normalizes a keyword string (e.g., trims, capitalizes, strips title suffixes, adds leading '*').
 * 
 * @param {string} raw - The raw keyword text.
 * @returns {string} Normalized keyword.
 */
function cleanKeyword(raw) {
    let clean = raw.trim().toUpperCase();
    clean = stripTitleSuffix(clean);
    if (clean && !clean.startsWith('*')) {
        clean = '*' + clean;
    }
    return clean;
}

/**
 * Parses a PDF literal string (contained in parentheses) starting at the given offset.
 * Handles nested parentheses, octal escape codes, and common escapes.
 * 
 * @param {string} content - Raw PDF file binary content.
 * @param {number} start - Index of the opening '(' character.
 * @returns {{value: string, end: number}|null} Decoded string value and end index, or null if invalid.
 */
function parseLiteralString(content, start) {
    let depth = 0;
    let result = [];
    let i = start;
    if (content[i] !== '(') return null;
    i++; // skip '('
    while (i < content.length) {
        const char = content[i];
        if (char === '\\') {
            if (i + 1 >= content.length) {
                result.push('\\');
                i++;
                break;
            }
            const nextChar = content[i + 1];
            if (nextChar === '(' || nextChar === ')' || nextChar === '\\') {
                result.push(nextChar);
                i += 2;
            } else if (/[0-7]/.test(nextChar)) {
                // Octal escape, up to 3 digits
                let octalStr = '';
                let k = 1;
                while (k <= 3 && i + k < content.length && /[0-7]/.test(content[i + k])) {
                    octalStr += content[i + k];
                    k++;
                }
                const byteVal = parseInt(octalStr, 8);
                result.push(String.fromCharCode(byteVal));
                i += k;
            } else {
                if (nextChar === 'n') result.push('\n');
                else if (nextChar === 'r') result.push('\r');
                else if (nextChar === 't') result.push('\t');
                else if (nextChar === 'b') result.push('\b');
                else if (nextChar === 'f') result.push('\f');
                else result.push(nextChar);
                i += 2;
            }
        } else if (char === '(') {
            depth++;
            result.push(char);
            i++;
        } else if (char === ')') {
            if (depth === 0) {
                return { value: result.join(''), end: i + 1 };
            }
            depth--;
            result.push(char);
            i++;
        } else {
            result.push(char);
            i++;
        }
    }
    return { value: result.join(''), end: i };
}

/**
 * Parses a PDF hexadecimal string (contained in angular brackets) starting at the given offset.
 * 
 * @param {string} content - Raw PDF file binary content.
 * @param {number} start - Index of the opening '<' character.
 * @returns {{value: string, end: number}|null} Decoded string value and end index, or null if invalid.
 */
function parseHexString(content, start) {
    if (content[start] !== '<') return null;
    let i = start + 1;
    let hex = '';
    while (i < content.length) {
        const char = content[i];
        if (char === '>') {
            break;
        }
        if (/[0-9a-fA-F]/.test(char)) {
            hex += char;
        }
        i++;
    }
    if (hex.length % 2 !== 0) {
        hex += '0';
    }
    let value = '';
    for (let k = 0; k < hex.length; k += 2) {
        const byteHex = hex.substring(k, k + 2);
        value += String.fromCharCode(parseInt(byteHex, 16));
    }
    return { value, end: i + 1 };
}

/**
 * Decodes a PDF string, resolving big-endian UTF-16 markers (BOM: FE FF).
 * 
 * @param {string} str - Raw parsed PDF string.
 * @returns {string} Decoded UTF-8/ASCII string.
 */
function decodePdfString(str) {
    if (str.length >= 2 && str.charCodeAt(0) === 0xFE && str.charCodeAt(1) === 0xFF) {
        let decoded = '';
        for (let i = 2; i < str.length - 1; i += 2) {
            const high = str.charCodeAt(i);
            const low = str.charCodeAt(i + 1);
            decoded += String.fromCharCode((high << 8) | low);
        }
        return decoded;
    }
    return str;
}

/**
 * Extracts the title property value from a PDF object definition content string.
 * 
 * @param {string} objContent - Text content of the PDF object.
 * @returns {string|null} Resolved title value, or null if missing.
 */
function extractTitle(objContent) {
    const titleRegex = /\/Title\b/g;
    let match;
    while ((match = titleRegex.exec(objContent)) !== null) {
        const idx = match.index;
        let i = idx + 6;
        while (i < objContent.length && (objContent[i] === ' ' || objContent[i] === '\t' || objContent[i] === '\r' || objContent[i] === '\n')) {
            i++;
        }
        if (i >= objContent.length) continue;
        let parsed = null;
        if (objContent[i] === '(') {
            parsed = parseLiteralString(objContent, i);
        } else if (objContent[i] === '<') {
            parsed = parseHexString(objContent, i);
        }
        if (parsed) {
            return decodePdfString(parsed.value);
        }
    }
    return null;
}

/**
 * Parses raw PDF content, traversing objects to find the Pages catalog tree and Document Outline bookmarks.
 * 
 * @param {string} content - Raw binary data of the PDF file.
 * @returns {BookmarkEntry[]} Extracted outlines/bookmarks.
 */
function parsePdfContent(content) {
    const objMap = new Map();
    const regex = /(\d+)\s+0\s+obj/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        const objId = parseInt(match[1], 10);
        const startIdx = match.index;
        const endIdx = content.indexOf('endobj', regex.lastIndex);
        if (endIdx !== -1) {
            objMap.set(objId, content.substring(startIdx, endIdx + 6));
        }
    }

    const catalogObj = [...objMap.values()].find(val => /\/Type\s*\/Catalog\b/.test(val));
    if (!catalogObj) return [];

    const pagesRefMatch = catalogObj.match(/\/Pages\s*(\d+)\s+\d+\s+R/);
    if (!pagesRefMatch) return [];
    const pagesRootId = parseInt(pagesRefMatch[1], 10);

    const pageIds = [];
    const visitedPages = new Set();

    /**
     * Traverses the PDF Page Tree.
     * @param {number} id - Object ID.
     */
    function traversePages(id) {
        if (visitedPages.has(id)) return;
        visitedPages.add(id);

        const obj = objMap.get(id);
        if (!obj) return;

        const isPage = /\/Type\s*\/Page\b/.test(obj);
        const isPages = /\/Type\s*\/Pages\b/.test(obj);

        if (isPage && !isPages) {
            if (!obj.includes('/Kids')) {
                pageIds.push(id);
                return;
            }
        }

        const kidsMatch = obj.match(/\/Kids\s*\[([^\]]+)\]/);
        if (kidsMatch) {
            const kidsContent = kidsMatch[1];
            const kidRefRegex = /(\d+)\s+\d+\s+R/g;
            let kidMatch;
            const kidIds = [];
            while ((kidMatch = kidRefRegex.exec(kidsContent)) !== null) {
                kidIds.push(parseInt(kidMatch[1], 10));
            }
            for (const kidId of kidIds) {
                traversePages(kidId);
            }
        } else {
            if (isPage && !isPages) {
                pageIds.push(id);
            }
        }
    }

    traversePages(pagesRootId);

    const outlinesRefMatch = catalogObj.match(/\/Outlines\s*(\d+)\s+\d+\s+R/);
    if (!outlinesRefMatch) return [];
    const outlinesId = parseInt(outlinesRefMatch[1], 10);
    const outlinesRoot = objMap.get(outlinesId);
    if (!outlinesRoot) return [];

    const bookmarks = [];
    const visitedOutlines = new Set();

    /**
     * Traverses PDF outlines/bookmarks hierarchy.
     * @param {number} id - Outline object ID.
     */
    function traverseOutlines(id) {
        if (visitedOutlines.has(id)) return;
        visitedOutlines.add(id);

        const obj = objMap.get(id);
        if (!obj) return;

        const title = extractTitle(obj);
        if (title) {
            let pageRefId = null;
            const destMatch = obj.match(/\/Dest\s*\[\s*(\d+)\s+\d+\s+R/);
            if (destMatch) {
                pageRefId = parseInt(destMatch[1], 10);
            } else {
                const actionMatch = obj.match(/\/A\s*<<[^>]*\/S\s*\/GoTo[^>]*\/D\s*\[?\s*(\d+)\s+\d+\s+R/);
                if (actionMatch) {
                    pageRefId = parseInt(actionMatch[1], 10);
                } else {
                    const dMatch = obj.match(/\/D(?:est)?\s*\[?\s*(\d+)\s+\d+\s+R/);
                    if (dMatch) {
                        pageRefId = parseInt(dMatch[1], 10);
                    }
                }
            }

            if (pageRefId !== null) {
                const pageIndex = pageIds.indexOf(pageRefId);
                const pageNum = pageIndex !== -1 ? pageIndex + 1 : null;
                bookmarks.push({ title, page: pageNum });
            }
        }

        const firstMatch = obj.match(/\/First\s*(\d+)\s+\d+\s+R/);
        if (firstMatch) {
            traverseOutlines(parseInt(firstMatch[1], 10));
        }
        const nextMatch = obj.match(/\/Next\s*(\d+)\s+\d+\s+R/);
        if (nextMatch) {
            traverseOutlines(parseInt(nextMatch[1], 10));
        }
    }

    const firstMatch = outlinesRoot.match(/\/First\s*(\d+)\s+\d+\s+R/);
    if (firstMatch) {
        traverseOutlines(parseInt(firstMatch[1], 10));
    }

    return bookmarks;
}

/**
 * Reads a PDF file synchronously and parses its outlines.
 * 
 * @param {string} pdfPath - Path to the PDF file.
 * @returns {BookmarkEntry[]} List of outline bookmarks.
 */
function parsePdf(pdfPath) {
    if (!fs.existsSync(pdfPath)) {
        return [];
    }
    const content = fs.readFileSync(pdfPath, 'binary');
    return parsePdfContent(content);
}

/**
 * Initializes/scans manuals directories and loads PDF outlines into cache.
 * Installs watchers on manual folders to trigger automatic index refreshes.
 * 
 * @param {import('vscode').ExtensionContext} context - The extension context.
 * @returns {Promise<void>}
 */
async function initialize(context) {
    keywordMap.clear();
    pdfFilesList = [];
    for (const w of dirWatchers) {
        try { w.close(); } catch (e) {}
    }
    dirWatchers = [];
    log("Initializing LS-DYNA Manuals Indexer...");
    try {
        const config = vscode.workspace.getConfiguration('lsdyna');
        const manualsDir = config.get('manualsDir') || 'lsdyna_manual_pack';
        log(`Configured manualsDir: "${manualsDir}"`);

        let dirsToScan = [];
        if (path.isAbsolute(manualsDir)) {
            dirsToScan.push(manualsDir);
        } else {
            // Highest priority: Relative to VS Code installation folder (where code.exe is)
            const codeExeDir = path.dirname(process.execPath);
            dirsToScan.push(path.resolve(codeExeDir, manualsDir));
            
            // appRoot is usually resources/app, so code.exe is two levels up
            if (vscode.env && vscode.env.appRoot) {
                dirsToScan.push(path.resolve(vscode.env.appRoot, '../../', manualsDir));
                dirsToScan.push(path.resolve(vscode.env.appRoot, manualsDir));
            }

            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                for (const folder of workspaceFolders) {
                    dirsToScan.push(path.resolve(folder.uri.fsPath, manualsDir));
                }
            } else {
                dirsToScan.push(path.resolve(process.cwd(), manualsDir));
            }
        }
        if (context && context.extensionPath) {
            dirsToScan.push(path.resolve(context.extensionPath, manualsDir));
        }

        const uniqueDirs = [...new Set(dirsToScan)].filter(d => {
            const exists = fs.existsSync(d);
            if (exists) {
                log(`Found existing manuals directory candidate: "${d}"`);
            }
            return exists;
        });

        if (uniqueDirs.length === 0) {
            log("No valid manuals directories found. Manual hovers will be disabled.");
            return;
        }

        const pdfFiles = [];
        for (const dir of uniqueDirs) {
            log(`Scanning directory: "${dir}"`);
            try {
                const watcher = fs.watch(dir, (eventType, filename) => {
                    if (filename && filename.toLowerCase().endsWith('.pdf')) {
                        log(`Manual PDF directory changed (${eventType} on ${filename}). Re-initializing indexer...`);
                        if (refreshTimeout) clearTimeout(refreshTimeout);
                        refreshTimeout = setTimeout(() => {
                            initialize(context).catch(err => log(`Failed to auto-refresh manuals: ${err.message}`));
                        }, 1000);
                    }
                });
                dirWatchers.push(watcher);
            } catch (watchErr) {
                log(`Failed to watch directory "${dir}": ${watchErr.message}`);
            }
            try {
                const files = fs.readdirSync(dir);
                const pdfs = files
                    .filter(f => f.toLowerCase().endsWith('.pdf'))
                    .map(f => path.resolve(dir, f));
                log(`Found ${pdfs.length} PDF(s) in "${dir}"`);
                for (const pdf of pdfs) {
                    if (!pdfFiles.includes(pdf)) {
                        pdfFiles.push(pdf);
                    }
                }
            } catch (err) {
                log(`Error reading directory "${dir}": ${err.message}`);
            }
        }

        log(`Total unique PDF manuals to index: ${pdfFiles.length}`);
        let cache = context && context.workspaceState ? (context.workspaceState.get('manuals_bookmark_cache') || {}) : {};
        let cacheUpdated = false;

        for (const pdfPath of pdfFiles) {
            try {
                const stats = fs.statSync(pdfPath);
                const mtimeMs = stats.mtimeMs;
                const fileName = path.basename(pdfPath);

                let bookmarks;
                if (cache[pdfPath] && cache[pdfPath].version === CACHE_VERSION && cache[pdfPath].mtimeMs === mtimeMs && Array.isArray(cache[pdfPath].bookmarks) && cache[pdfPath].bookmarks.length > 0) {
                    log(`Loading bookmarks for "${fileName}" from cache...`);
                    bookmarks = cache[pdfPath].bookmarks;
                } else {
                    log(`Parsing bookmarks for "${fileName}" from PDF...`);
                    bookmarks = parsePdf(pdfPath);
                    cache[pdfPath] = {
                        version: CACHE_VERSION,
                        mtimeMs,
                        bookmarks
                    };
                    cacheUpdated = true;
                }
                log(`Loaded ${bookmarks.length} bookmark(s) for "${fileName}".`);

                let kwCount = 0;
                for (const bookmark of bookmarks) {
                    if (bookmark.page === null) continue;

                    const titleUpper = bookmark.title.toUpperCase();
                    const matches = titleUpper.match(/\*[A-Z0-9_]+/g);
                    
                    const kwsToRegister = [];
                    if (matches && matches.length > 0) {
                        for (const m of matches) {
                            kwsToRegister.push(m);
                        }
                    } else {
                        const rawParts = bookmark.title.split('/');
                        for (const part of rawParts) {
                            kwsToRegister.push(part);
                        }
                    }

                    for (const rawKw of kwsToRegister) {
                        const cleaned = cleanKeyword(rawKw);
                        if (cleaned.startsWith('*')) {
                            const existing = keywordMap.get(cleaned) || [];
                            const isDuplicate = existing.some(
                                loc => loc.file === pdfPath && loc.page === bookmark.page
                            );
                            if (!isDuplicate) {
                                existing.push({ file: pdfPath, page: bookmark.page });
                                keywordMap.set(cleaned, existing);
                                kwCount++;
                            }
                        }
                    }
                }
                log(`Registered ${kwCount} keyword mapping(s) from "${fileName}".`);
            } catch (err) {
                log(`Error processing manual PDF "${pdfPath}": ${err.message}`);
                console.error(`Error parsing manual PDF ${pdfPath}:`, err);
            }
        }

        log(`Indexer initialization complete. Total unique keywords indexed: ${keywordMap.size}`);

        if (cacheUpdated && context && context.workspaceState) {
            await context.workspaceState.update('manuals_bookmark_cache', cache);
            log("Saved updated bookmarks cache to workspaceState.");
        }
        pdfFilesList = pdfFiles;
    } catch (e) {
        log(`Error during manualIndexer initialization: ${e.message}`);
        console.error('Error during manualIndexer initialization:', e);
    }
}

/**
 * Returns matching manual locations for a given keyword name.
 * 
 * @param {string} kwName - The keyword name (e.g. "*NODE").
 * @returns {ManualLocation[]} Mapped page numbers and file paths.
 */
function getManualLocations(kwName) {
    const cleaned = cleanKeyword(kwName);
    const { getAliases } = require('./keywordUtils');
    const candidatesToCheck = [cleaned, ...getAliases(cleaned)];

    for (const cand of candidatesToCheck) {
        let locs = keywordMap.get(cand);
        if (locs && locs.length > 0) {
            return locs.map(loc => ({ ...loc, matchedKeyword: cand }));
        }

        const tokens = cand.split('_');
        for (let i = tokens.length - 1; i >= 1; i--) {
            const candidate = tokens.slice(0, i).join('_');
            locs = keywordMap.get(candidate);
            if (locs && locs.length > 0) {
                return locs.map(loc => ({ ...loc, matchedKeyword: candidate }));
            }
            const subAliases = getAliases(candidate);
            for (const sa of subAliases) {
                locs = keywordMap.get(sa);
                if (locs && locs.length > 0) {
                    return locs.map(loc => ({ ...loc, matchedKeyword: sa }));
                }
            }
        }
    }
    return [];
}

/**
 * Returns the total number of PDF manual files successfully indexed.
 * 
 * @returns {number} Count of files.
 */
function getManualFilesCount() {
    return pdfFilesList.length;
}

module.exports = {
    initialize,
    getManualLocations,
    getManualFilesCount,
    // Exported for unit tests
    parsePdf,
    parsePdfContent,
    cleanKeyword
};
