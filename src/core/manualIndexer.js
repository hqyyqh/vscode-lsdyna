'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

let keywordMap = new Map();
const CACHE_VERSION = 2;
let outputChannel;
let pdfFilesList = [];
let dirWatchers = [];
let refreshTimeout = null;

function log(msg) {
    if (!outputChannel && typeof vscode !== 'undefined' && vscode.window) {
        outputChannel = vscode.window.createOutputChannel("LS-DYNA Manuals");
    }
    if (outputChannel) {
        outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
    }
}

function cleanKeyword(raw) {
    let clean = raw.trim().toUpperCase();
    if (clean.endsWith('_TITLE')) {
        clean = clean.slice(0, -6);
    }
    if (clean && !clean.startsWith('*')) {
        clean = '*' + clean;
    }
    return clean;
}

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

function parsePdf(pdfPath) {
    if (!fs.existsSync(pdfPath)) {
        return [];
    }
    const content = fs.readFileSync(pdfPath, 'binary');
    return parsePdfContent(content);
}

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
        const manualsDir = config.get('manualsDir') || 'LS-DYNA Manuals';
        log(`Configured manualsDir: "${manualsDir}"`);

        let dirsToScan = [];
        if (path.isAbsolute(manualsDir)) {
            dirsToScan.push(manualsDir);
        } else {
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

                    const rawParts = bookmark.title.split('/');
                    for (const part of rawParts) {
                        const cleaned = cleanKeyword(part);
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

function getManualLocations(kwName) {
    return keywordMap.get(cleanKeyword(kwName)) || [];
}

function getManualFilesCount() {
    return pdfFilesList.length;
}

module.exports = {
    initialize,
    getManualLocations,
    getManualFilesCount,
    // 导出用于测试的方法
    parsePdf,
    parsePdfContent,
    cleanKeyword
};
