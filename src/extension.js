const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { LsdynaIncludeTreeProvider } = require('./client/providers/includeTreeProvider');
const { LsdynaKeywordIndexProvider } = require('./client/providers/keywordIndexProvider');
const { createIndexClient } = require('./client/services/indexClient');
const { createDiskSnapshotStore } = require('./core/cache/diskSnapshotStore');
const { findAffectedProjectRoots } = require('./core/incremental/fileInvalidation');
const includeScanner = require('./core/parser/includeScanner');
const keywordScanner = require('./core/parser/keywordScanner');
const { createWorkerPool } = require('./worker/workerPool');
const { createProjectIndexLoader } = require('./worker/projectIndexLoader');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

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

// --- Folding ---

class LsDynaFoldingProvider {
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

class LsdynaKeywordSymbolProvider {
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

class LsdynaDocumentLinkProvider {
    provideDocumentLinks(document) {
        return collectIncludeDocumentLinks(document);
    }
}

// --- Helpers ---

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

function shouldSkipAutomaticDocumentScan(document) {
    return Boolean(document) && document.lineCount > LARGE_DOCUMENT_LINE_THRESHOLD;
}

function isLsdynaFile(document) {
    if (!document || !document.uri) return false;
    const ext = path.extname(document.uri.fsPath).toLowerCase();
    return document.languageId === 'lsdyna' || ext === '.k' || ext === '.key' || ext === '.dyna';
}

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

function isIncludeLine(document, currentLine) {
    if (!document || !isLsdynaFile(document) || shouldSkipAutomaticDocumentScan(document)) {
        return false;
    }

    return findIncludeFileLines(document)
        .some(entry => includeScanner.includeEntryContainsLine(entry, currentLine));
}

function findIncludeFileLines(document) {
    return getIncludeDirectiveData(document).includeEntries;
}

// --- Parameter helpers ---

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

class LsdynaDefinitionProvider {
    provideDefinition(document, position) {
        const param = getParameterAtCursor(document, position);
        if (!param) return null;
        const def = findParameterDefinitions(document).get(param.name.toUpperCase());
        if (!def) return null;
        return new vscode.Location(document.uri, new vscode.Position(def.lineIndex, def.startChar));
    }
}

class LsdynaReferenceProvider {
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

class LsdynaRenameProvider {
    prepareRename(document, position) {
        const param = getParameterAtCursor(document, position);
        if (!param) throw new Error('Cannot rename this symbol.');
        return param.range;
    }

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

function getFieldData() {
    if (!_fieldData) {
        const dataPaths = [
            path.join(__dirname, '..', 'keywords', 'field_data_zh.json'),
            path.join(__dirname, '..', 'keywords', 'field_data.json'),
        ];
        for (const dataPath of dataPaths) {
            try {
                _fieldData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
                break;
            } catch {}
        }
        if (!_fieldData) _fieldData = {};
    }
    return _fieldData;
}

function lookupKeyword(name) {
    const data = getFieldData();
    if (data[name]) return data[name];
    const tokens = name.split('_');
    for (let i = tokens.length - 1; i >= 1; i--) {
        const candidate = tokens.slice(0, i).join('_');
        if (data[candidate]) return data[candidate];
    }
    return null;
}

function keywordHoverMarkdown(kwName, entry) {
    const cards = entry.c;
    const lines = [`**\\*${kwName}**`];
    let cardNum = 1;
    for (const card of cards) {
        if (!card.length) continue;
        const isWide = card.length === 1 && card[0].w >= 40;
        if (isWide) {
            lines.push(`\n*Card ${cardNum} (title):* ${card[0].n}`);
        } else {
            const names = card.map(f => f.n).join(', ');
            lines.push(`\n*Card ${cardNum}:* ${names}`);
        }
        cardNum++;
    }
    if (entry.r) lines.push('\n*Last card repeats for each data row.*');
    return lines.join('\n');
}

function formatHoverHelpText(helpText) {
    return helpText.replace(/\r?\n/g, '  \n');
}

class LsdynaFieldHoverProvider {
    provideHover(document, position) {
        if (shouldSkipAutomaticDocumentScan(document)) return null;

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
            const entry = lookupKeyword(kwName);
            if (!entry) return null;
            const md = new vscode.MarkdownString(keywordHoverMarkdown(kwName, entry));
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
        const entry = lookupKeyword(kwName);
        if (!entry) return null;

        // Count which card index this line is (skip comments between keyword and here)
        let cardIndex = 0;
        for (let i = kwLine + 1; i < position.line; i++) {
            const t = document.lineAt(i).text.trimStart();
            if (!t.startsWith('$') && t.length > 0) cardIndex++;
        }

        const cards = entry.c;
        // For repeating keywords, clamp to last card
        const clampedIndex = entry.r ? Math.min(cardIndex, cards.length - 1) : cardIndex;
        const card = cards[clampedIndex];
        if (!card || card.length === 0) return null;

        const col = position.character;
        const field = card.find(f => col >= f.p && col < f.p + f.w);
        if (!field) return null;

        const typeLabel = field.t ? ` *(${field.t})*` : '';
        const helpText = field.h ? `\n\n${formatHoverHelpText(field.h)}` : '';
        const md = new vscode.MarkdownString(`**${field.n}**${typeLabel}${helpText}`);
        const range = new vscode.Range(position.line, field.p, position.line, field.p + field.w);
        return new vscode.Hover(md, range);
    }
}

class LsdynaParameterCodeLensProvider {
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


function getSearchPath(document) {
    return getIncludeDirectiveData(document).searchPaths;
}

function startLineOfCurrentKeywordFromLineReader(lineCount, getLine, lineindex) {
    for (let i = lineindex; i >= 0; i--) {
        if (getLine(i).startsWith('*')) return i;
    }
    throw new Error('Not on any keyword.');
}

function endLineOfCurrentKeywordFromLineReader(lineCount, getLine, lineindex) {
    for (let i = lineindex + 1; i < lineCount; i++) {
        if (getLine(i).startsWith('*')) return i - 1;
    }
    return lineCount - 1;
}

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

function searchFileFromPaths(filePath, paths) {
    for (const searchPath of paths) {
        const fullPath = path.resolve(searchPath, filePath);
        if (fs.existsSync(fullPath)) return fullPath;
    }
    throw new Error(`${filePath} not found.`);
}

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

// --- Activate ---

function activate(context) {
    context.subscriptions.push(
        vscode.languages.registerFoldingRangeProvider({ language: 'lsdyna' }, new LsDynaFoldingProvider())
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider({ language: 'lsdyna' }, new LsdynaKeywordSymbolProvider())
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentLinkProvider({ language: 'lsdyna' }, new LsdynaDocumentLinkProvider())
    );

    context.subscriptions.push(
        vscode.languages.registerHoverProvider({ language: 'lsdyna' }, new LsdynaFieldHoverProvider())
    );
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ language: 'lsdyna' }, new LsdynaParameterCodeLensProvider())
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
    });
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('lsdynaIncludeTree', includeTreeProvider)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.scanIncludeTree', () => includeTreeProvider.scan())
    );

    const keywordIndexProvider = new LsdynaKeywordIndexProvider({
        collectIncludeFiles,
        loadProjectSnapshot: indexClient.loadProjectSnapshot,
        shouldSkipAutomaticDocumentScan,
    });
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('lsdynaKeywordIndex', keywordIndexProvider)
    );
    vscode.commands.executeCommand('setContext', 'lsdyna.keywordIndexMode', 'local');
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.scanKeywordIndex', () => keywordIndexProvider.scan())
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.keywordIndexSetLocal', () => keywordIndexProvider.setLocal())
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => keywordIndexProvider.refreshFromDocument(editor?.document))
    );
    const scheduleKeywordIndexRefresh = createActiveDocumentDebouncer(
        () => vscode.window.activeTextEditor?.document,
        document => keywordIndexProvider.refreshFromDocument(document)
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

    if (vscode.window.activeTextEditor) {
        keywordIndexProvider.refreshFromDocument(vscode.window.activeTextEditor.document);
    }
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.goToKeywordUsage', (filePath, lineIndex) => {
            vscode.workspace.openTextDocument(filePath).then(doc => {
                const pos = new vscode.Position(lineIndex, 0);
                vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
            });
        })
    );

    const diagnostics = vscode.languages.createDiagnosticCollection('lsdyna');
    context.subscriptions.push(diagnostics);

    function updateDiagnostics(document) {
        if (!isLsdynaFile(document)) return;
        diagnostics.set(document.uri, collectLineLengthDiagnostics(document));
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
    const resolvedDecoration = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor('textLink.foreground'),
    });
    const missingDecoration = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor('editorWarning.foreground'),
        fontStyle: 'italic',
    });
    context.subscriptions.push(resolvedDecoration, missingDecoration);

    function updateDecorations(editor) {
        if (!editor || !isLsdynaFile(editor.document)) return;
        const { resolved, missing } = collectIncludeDecorationSets(editor.document);

        editor.setDecorations(resolvedDecoration, resolved);
        editor.setDecorations(missingDecoration, missing);
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => updateDecorations(editor))
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
        vscode.window.onDidChangeTextEditorSelection(e => updateIncludeLineContext(e.textEditor))
    );
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => updateIncludeLineContext(editor))
    );

    updateIncludeLineContext(vscode.window.activeTextEditor);

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.openIncludeFile', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            try {
                const fullPath = searchFileFromPaths(
                    getFilenameFromDocument(editor.document, editor.selection.active.line),
                    getSearchPath(editor.document)
                );
                vscode.workspace.openTextDocument(fullPath).then(doc => vscode.window.showTextDocument(doc));
            } catch (error) {
                vscode.window.showErrorMessage(error.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('extension.selectKeyword', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const currentLine = editor.selection.active.line;
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

function deactivate() {}

function createManifestDrivenInvalidator({ indexClient, findAffectedRoots = findAffectedProjectRoots } = {}) {
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

function createBatchedManifestInvalidator({
    indexClient,
    findAffectedRoots = findAffectedProjectRoots,
    onInvalidatedRoots = () => {},
    delayMs = 100,
    schedule = setTimeout,
    cancel = clearTimeout,
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

function createProjectSnapshotRefreshQueue({
    loadProjectSnapshot,
    onError = () => {},
    schedule = setImmediate,
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

function createProjectSnapshotPersistentCache({
    storageUri = null,
    createStore = createDiskSnapshotStore,
} = {}) {
    if (!storageUri || typeof storageUri.fsPath !== 'string' || storageUri.fsPath.trim() === '') {
        return null;
    }

    return createStore({
        cacheDirectory: path.join(storageUri.fsPath, 'project-snapshots'),
        maxCacheBytes: PROJECT_SNAPSHOT_DISK_CACHE_BYTES,
    });
}

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

module.exports = { activate, deactivate };

// Exported for unit testing
module.exports._internals = {
    publishProjectDiagnostics,
    collectIncludeDecorationSets,
    collectIncludeDocumentLinks,
    collectLineLengthDiagnostics,
    createActiveDocumentDebouncer,
    collectIncludeFiles,
    findParameterDefinitions,
    findParameterReferences,
    findIncludeFileLines,
    LsdynaIncludeTreeProvider,
    LsdynaFieldHoverProvider,
    LsdynaKeywordIndexProvider,
    LsdynaKeywordSymbolProvider,
    LsDynaFoldingProvider,
    getFilenameFromDocument,
    getSearchPath,
    getParameterAtCursor,
    isIncludeLine,
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
};
