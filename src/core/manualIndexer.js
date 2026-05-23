'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

let keywordMap = new Map();

function cleanKeyword(raw) {
    let clean = raw.trim().toUpperCase();
    if (clean.endsWith('_TITLE')) {
        clean = clean.slice(0, -6);
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
                while (k <= 3 && /[0-7]/.test(content[i + k])) {
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
    const idx = objContent.indexOf('/Title');
    if (idx === -1) return null;
    let i = idx + 6;
    while (i < objContent.length && (objContent[i] === ' ' || objContent[i] === '\t' || objContent[i] === '\r' || objContent[i] === '\n')) {
        i++;
    }
    if (i >= objContent.length) return null;
    let parsed = null;
    if (objContent[i] === '(') {
        parsed = parseLiteralString(objContent, i);
    } else if (objContent[i] === '<') {
        parsed = parseHexString(objContent, i);
    }
    if (parsed) {
        return decodePdfString(parsed.value);
    }
    return null;
}

function parsePdf(pdfPath) {
    if (!fs.existsSync(pdfPath)) {
        return [];
    }
    const content = fs.readFileSync(pdfPath, 'binary');
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

    const catalogObj = [...objMap.values()].find(val => val.includes('/Type/Catalog') || val.includes('/Type /Catalog'));
    if (!catalogObj) return [];

    const pagesRefMatch = catalogObj.match(/\/Pages\s*(\d+)\s+\d+\s+R/);
    if (!pagesRefMatch) return [];
    const pagesRootId = parseInt(pagesRefMatch[1], 10);

    const pageIds = [];
    function traversePages(id) {
        const obj = objMap.get(id);
        if (!obj) return;
        if (obj.includes('/Type/Page') || obj.includes('/Type /Page')) {
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
            if (obj.includes('/Type/Page') || obj.includes('/Type /Page')) {
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

    function traverseOutlines(id) {
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

async function initialize(context) {
    keywordMap.clear();
    try {
        const config = vscode.workspace.getConfiguration('lsdyna');
        const manualsDir = config.get('manualsDir') || 'LS-DYNA Manuals';

        let resolvedDir = manualsDir;
        if (!path.isAbsolute(resolvedDir)) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                resolvedDir = path.resolve(workspaceFolders[0].uri.fsPath, resolvedDir);
            } else {
                resolvedDir = path.resolve(process.cwd(), resolvedDir);
            }
        }

        if (!fs.existsSync(resolvedDir)) {
            return;
        }

        const files = fs.readdirSync(resolvedDir);
        const pdfFiles = files
            .filter(f => f.toLowerCase().endsWith('.pdf'))
            .map(f => path.resolve(resolvedDir, f));

        let cache = context.workspaceState.get('manuals_bookmark_cache') || {};
        let cacheUpdated = false;

        for (const pdfPath of pdfFiles) {
            try {
                const stats = fs.statSync(pdfPath);
                const mtimeMs = stats.mtimeMs;

                let bookmarks;
                if (cache[pdfPath] && cache[pdfPath].mtimeMs === mtimeMs) {
                    bookmarks = cache[pdfPath].bookmarks;
                } else {
                    bookmarks = parsePdf(pdfPath);
                    cache[pdfPath] = {
                        mtimeMs,
                        bookmarks
                    };
                    cacheUpdated = true;
                }

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
                            }
                        }
                    }
                }
            } catch (err) {
                console.error(`Error parsing manual PDF ${pdfPath}:`, err);
            }
        }

        if (cacheUpdated) {
            await context.workspaceState.update('manuals_bookmark_cache', cache);
        }
    } catch (e) {
        console.error('Error during manualIndexer initialization:', e);
    }
}

function getManualLocations(kwName) {
    return keywordMap.get(cleanKeyword(kwName)) || [];
}

module.exports = {
    initialize,
    getManualLocations,
    parsePdf,
    cleanKeyword
};
