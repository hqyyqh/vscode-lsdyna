'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeDoc } = require('./helpers');
const { LsdynaIncludeTreeProvider } = require('../src/client/providers/includeTreeProvider');
const { LsdynaKeywordIndexProvider } = require('../src/client/providers/keywordIndexProvider');

const {
    collectIncludeDecorationSets,
    collectIncludeDocumentLinks,
    collectLineLengthDiagnostics,
    createActiveDocumentDebouncer,
    findParameterDefinitions,
    findParameterReferences,
    findIncludeFileLines,
    getFilenameFromDocument,
    getSearchPath,
    getParameterAtCursor,
    isIncludeLine,
    LsdynaFieldHoverProvider,
    LsdynaKeywordSymbolProvider,
    LsDynaFoldingProvider,
    findNextKeywordInDocument,
    findPreviousKeywordInDocument,
    startLineOfCurrentKeyword,
    endLineOfCurrentKeyword,
    getFilenameFromKeyword,
    searchFileFromPaths,
    findNextKeyword,
    findPreviousKeyword,
    collectIncludeFiles,
    shouldSkipAutomaticDocumentScan,
} = require('../src/extension')._internals;

const FIXTURE_DIR = path.join(__dirname, 'Bolt_A_Explicit');

// ---------------------------------------------------------------------------
// findParameterDefinitions
// ---------------------------------------------------------------------------

describe('findParameterDefinitions', () => {
    it('finds basic *PARAMETER definitions', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\nI  count  10\n');
        const defs = findParameterDefinitions(doc);
        assert.equal(defs.size, 2);
        assert.ok(defs.has('TEND'));
        assert.equal(defs.get('TEND').value, '5.0');
        assert.equal(defs.get('COUNT').value, '10');
    });

    it('finds *PARAMETER_EXPRESSION definitions', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*PARAMETER_EXPRESSION\nR  dtPlot  tEnd/100.0\n');
        const defs = findParameterDefinitions(doc);
        assert.ok(defs.has('DTPLOT'));
        assert.equal(defs.get('DTPLOT').value, 'tEnd/100.0');
    });

    it('is case-insensitive on key lookup', () => {
        const doc = fakeDoc('*PARAMETER\nR  MyParam  42.0\n');
        const defs = findParameterDefinitions(doc);
        assert.ok(defs.has('MYPARAM'));
        assert.equal(defs.get('MYPARAM').name, 'MyParam');
    });

    it('skips comment lines inside *PARAMETER block', () => {
        const doc = fakeDoc('*PARAMETER\n$ a comment\nR  tEnd  5.0\n');
        const defs = findParameterDefinitions(doc);
        assert.equal(defs.size, 1);
    });

    it('stops collecting at next keyword', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*CONTROL_TERMINATION\nR  notAParam  0\n');
        const defs = findParameterDefinitions(doc);
        assert.equal(defs.size, 1);
    });

    it('records correct line and column for definition', () => {
        const doc = fakeDoc('*PARAMETER\nR   tEnd   5.0\n');
        const defs = findParameterDefinitions(doc);
        const def = defs.get('TEND');
        assert.equal(def.lineIndex, 1);
        assert.equal(doc.lineAt(def.lineIndex).text.slice(def.startChar, def.startChar + def.length), 'tEnd');
    });

    it('parses the real fixture file', () => {
        const fs = require('fs');
        const text = fs.readFileSync(path.join(FIXTURE_DIR, 'mainboltaexpl.k'), 'utf8');
        const doc = fakeDoc(text, path.join(FIXTURE_DIR, 'mainboltaexpl.k'));
        const defs = findParameterDefinitions(doc);
        assert.ok(defs.has('TEND'));
        assert.ok(defs.has('DTPLOT'));
        assert.ok(defs.has('BLTFORCE'));
    });
});

// ---------------------------------------------------------------------------
// findParameterReferences
// ---------------------------------------------------------------------------

describe('findParameterReferences', () => {
    it('finds &name references', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*CONTROL_TERMINATION\n     &tEnd\n');
        const refs = findParameterReferences(doc);
        const r = refs.filter(r => r.name === 'TEND');
        assert.equal(r.length, 1);
        assert.equal(r[0].lineIndex, 3);
    });

    it('finds multiple references to same parameter', () => {
        const doc = fakeDoc('*PARAMETER\nR  t  5.0\n*KEYWORD\n&t  &t\n');
        const refs = findParameterReferences(doc).filter(r => r.name === 'T');
        assert.equal(refs.length, 2);
    });

    it('finds bare name references in *PARAMETER_EXPRESSION values', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*PARAMETER_EXPRESSION\nR  dtPlot  tEnd/100.0\n');
        const refs = findParameterReferences(doc).filter(r => r.name === 'TEND');
        assert.equal(refs.length, 1);
        assert.equal(refs[0].lineIndex, 3);
    });

    it('does not treat expression definition name as a reference', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*PARAMETER_EXPRESSION\nR  dtPlot  tEnd/100.0\n');
        const refs = findParameterReferences(doc).filter(r => r.name === 'DTPLOT');
        assert.equal(refs.length, 0);
    });

    it('skips comment lines', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n$ &tEnd this is a comment\n');
        const refs = findParameterReferences(doc).filter(r => r.name === 'TEND');
        assert.equal(refs.length, 0);
    });
});

// ---------------------------------------------------------------------------
// findIncludeFileLines
// ---------------------------------------------------------------------------

describe('findIncludeFileLines', () => {
    it('finds a basic *INCLUDE', () => {
        const doc = fakeDoc('*INCLUDE\ngeometry.k\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].fileName, 'geometry.k');
    });

    it('finds multiple filenames under a single *INCLUDE block', () => {
        const doc = fakeDoc('*INCLUDE\na.key\nb.key\nc.key\n');
        const lines = findIncludeFileLines(doc);
        assert.deepEqual(lines.map(line => line.fileName), ['a.key', 'b.key', 'c.key']);
    });

    it('skips *INCLUDE_PATH entries', () => {
        const doc = fakeDoc('*INCLUDE_PATH\n/some/dir\n*INCLUDE\ngeometry.k\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].fileName, 'geometry.k');
    });

    it('skips *INCLUDE_PATH_RELATIVE entries', () => {
        const doc = fakeDoc('*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\ngeometry.k\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines.length, 1);
    });

    it('handles multiple *INCLUDE blocks', () => {
        const doc = fakeDoc('*INCLUDE\na.k\n*INCLUDE\nb.k\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines.length, 2);
        assert.equal(lines[0].fileName, 'a.k');
        assert.equal(lines[1].fileName, 'b.k');
    });

    it('skips commented include filename lines', () => {
        const doc = fakeDoc('*INCLUDE\n$commented.k\nreal.k\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].fileName, 'real.k');
    });

    it('skips comment lines inside include continuations', () => {
        const doc = fakeDoc('*INCLUDE\npart_a +\n$ skip me\npart_b.key\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines.length, 1);
        assert.equal(lines[0].fileName, 'part_apart_b.key');
        assert.equal(lines[0].endLineIndex, 3);
    });

    it('finds correct line index and startChar', () => {
        const doc = fakeDoc('*KEYWORD\n*INCLUDE\n  geometry.k\n');
        const lines = findIncludeFileLines(doc);
        assert.equal(lines[0].lineIndex, 2);
        assert.equal(lines[0].startChar, 2);
    });

    it('parses includes from the real fixture file', () => {
        const fs = require('fs');
        const text = fs.readFileSync(path.join(FIXTURE_DIR, 'mainboltaexpl.k'), 'utf8');
        const doc = fakeDoc(text, path.join(FIXTURE_DIR, 'mainboltaexpl.k'));
        const lines = findIncludeFileLines(doc);
        const names = lines.map(l => l.fileName);
        assert.ok(names.includes('includes.k'));
        assert.ok(names.includes('material_props.k'));
        assert.ok(names.includes('missing_geometry.k'));
    });
});

// ---------------------------------------------------------------------------
// getSearchPath
// ---------------------------------------------------------------------------

describe('getSearchPath', () => {
    it('always includes the document directory as first path', () => {
        const doc = fakeDoc('*KEYWORD\n', '/project/main.k');
        const paths = getSearchPath(doc);
        assert.equal(paths[0], '/project');
    });

    it('appends *INCLUDE_PATH directories', () => {
        const doc = fakeDoc('*INCLUDE_PATH\n/shared/libs\n', '/project/main.k');
        const paths = getSearchPath(doc);
        assert.ok(paths.includes('/shared/libs'));
    });

    it('resolves *INCLUDE_PATH_RELATIVE against document directory', () => {
        const doc = fakeDoc('*INCLUDE_PATH_RELATIVE\nsubmodels\n', '/project/main.k');
        const paths = getSearchPath(doc);
        assert.ok(paths.some(p => p.endsWith('submodels')));
    });

    it('handles both path types together', () => {
        const doc = fakeDoc(
            '*INCLUDE_PATH\n/abs/path\n*INCLUDE_PATH_RELATIVE\nreldir\n',
            '/project/main.k'
        );
        const paths = getSearchPath(doc);
        assert.equal(paths.length, 3);
    });

    it('resolves *INCLUDE_PATH_RELATIVE correctly in real fixture', () => {
        const fs = require('fs');
        const fixturePath = path.join(FIXTURE_DIR, 'mainboltaexpl.k');
        const text = fs.readFileSync(fixturePath, 'utf8');
        const doc = fakeDoc(text, fixturePath);
        const paths = getSearchPath(doc);
        const submodels = path.join(FIXTURE_DIR, 'submodels');
        assert.ok(paths.includes(submodels), 'should include submodels/');
    });

    it('reuses one include parse for repeated lookups on the same document version', () => {
        const doc = fakeDoc('*INCLUDE_PATH\n/shared\n*INCLUDE\na.key\n', '/project/main.k');
        doc.version = 1;

        let lineAtCalls = 0;
        const originalLineAt = doc.lineAt;
        doc.lineAt = (index) => {
            lineAtCalls++;
            return originalLineAt(index);
        };

        getSearchPath(doc);
        findIncludeFileLines(doc);
        getSearchPath(doc);

        assert.equal(lineAtCalls, doc.lineCount);
    });

    it('invalidates cached include parse results when the document version changes', () => {
        const doc = fakeDoc('*INCLUDE\na.key\n', '/project/main.k');
        doc.version = 1;

        let lineAtCalls = 0;
        const originalLineAt = doc.lineAt;
        doc.lineAt = (index) => {
            lineAtCalls++;
            return originalLineAt(index);
        };

        getSearchPath(doc);
        doc.version = 2;
        findIncludeFileLines(doc);

        assert.equal(lineAtCalls, doc.lineCount * 2);
    });
});

// ---------------------------------------------------------------------------
// searchFileFromPaths
// ---------------------------------------------------------------------------

describe('searchFileFromPaths', () => {
    it('resolves a file that exists', () => {
        const result = searchFileFromPaths('mainboltaexpl.k', [FIXTURE_DIR]);
        assert.equal(result, path.join(FIXTURE_DIR, 'mainboltaexpl.k'));
    });

    it('checks paths in order and returns first match', () => {
        const result = searchFileFromPaths('material_props.k', [
            FIXTURE_DIR,
            path.join(FIXTURE_DIR, 'submodels'),
        ]);
        assert.equal(result, path.join(FIXTURE_DIR, 'submodels', 'material_props.k'));
    });

    it('throws when file is not found in any path', () => {
        assert.throws(
            () => searchFileFromPaths('missing_geometry.k', [FIXTURE_DIR]),
            /not found/
        );
    });

    it('resolves material_props.k via INCLUDE_PATH_RELATIVE in real fixture', () => {
        const fs = require('fs');
        const fixturePath = path.join(FIXTURE_DIR, 'mainboltaexpl.k');
        const text = fs.readFileSync(fixturePath, 'utf8');
        const doc = fakeDoc(text, fixturePath);
        const paths = getSearchPath(doc);
        const result = searchFileFromPaths('material_props.k', paths);
        assert.ok(result.endsWith('material_props.k'));
    });

    it('resolves prescribed_motion.k via ../  from submodels/loading/', () => {
        const loadingDir = path.join(FIXTURE_DIR, 'submodels', 'loading');
        const result = searchFileFromPaths('../material_props.k', [loadingDir]);
        assert.ok(result.endsWith('material_props.k'));
    });
});

// ---------------------------------------------------------------------------
// Keyword navigation
// ---------------------------------------------------------------------------

describe('findNextKeyword', () => {
    it('finds the next * line', () => {
        assert.equal(findNextKeyword(['*A', 'data', '*B', 'data'], 0), 2);
    });

    it('throws when no next keyword exists', () => {
        assert.throws(() => findNextKeyword(['*A', 'data'], 0));
    });

    it('skips over data lines', () => {
        assert.equal(findNextKeyword(['*A', 'x', 'y', 'z', '*B'], 0), 4);
    });
});

describe('findPreviousKeyword', () => {
    it('finds the previous * line', () => {
        assert.equal(findPreviousKeyword(['*A', 'data', '*B', 'data'], 3), 2);
    });

    it('throws when no previous keyword exists', () => {
        assert.throws(() => findPreviousKeyword(['data', 'data'], 1));
    });
});

describe('startLineOfCurrentKeyword', () => {
    it('returns own line when on a keyword', () => {
        assert.equal(startLineOfCurrentKeyword(['*A', 'data'], 0), 0);
    });

    it('searches backwards to find enclosing keyword', () => {
        assert.equal(startLineOfCurrentKeyword(['*A', 'data', 'more'], 2), 0);
    });

    it('throws when not under any keyword', () => {
        assert.throws(() => startLineOfCurrentKeyword(['data', 'data'], 1));
    });
});

describe('endLineOfCurrentKeyword', () => {
    it('ends one line before the next keyword', () => {
        assert.equal(endLineOfCurrentKeyword(['*A', 'data', '*B'], 0), 1);
    });

    it('returns last line when no next keyword', () => {
        assert.equal(endLineOfCurrentKeyword(['*A', 'data', 'more'], 0), 2);
    });
});

// ---------------------------------------------------------------------------
// getFilenameFromKeyword
// ---------------------------------------------------------------------------

describe('getFilenameFromKeyword', () => {
    it('extracts filename from *INCLUDE', () => {
        const lines = ['*INCLUDE', 'geometry.k'];
        assert.equal(getFilenameFromKeyword(lines, 1), 'geometry.k');
    });

    it('combines continued filenames inside *INCLUDE blocks', () => {
        const lines = ['*INCLUDE', 'part_a +', 'part_b.key'];
        assert.equal(getFilenameFromKeyword(lines, 1), 'part_apart_b.key');
    });

    it('returns the selected filename inside a multi-file *INCLUDE block', () => {
        const lines = ['*INCLUDE', 'a.key', 'b.key', 'c.key'];
        assert.equal(getFilenameFromKeyword(lines, 2), 'b.key');
    });

    it('throws on *INCLUDE_PATH (no filename card)', () => {
        const lines = ['*INCLUDE_PATH', '/some/path'];
        assert.throws(() => getFilenameFromKeyword(lines, 1));
    });

    it('throws when not on an include keyword', () => {
        const lines = ['*CONTROL_TERMINATION', '  5.0'];
        assert.throws(() => getFilenameFromKeyword(lines, 1));
    });

    it('skips comment lines before filename', () => {
        const lines = ['*INCLUDE', '$ a comment', 'real.k'];
        assert.equal(getFilenameFromKeyword(lines, 0), 'real.k');
    });
});

// ---------------------------------------------------------------------------
// document-based keyword helpers
// ---------------------------------------------------------------------------

describe('document-based keyword helpers', () => {
    it('extracts include filenames without reading the whole document text', () => {
        const doc = fakeDoc('*INCLUDE\na.key\nb.key\n');
        doc.getText = () => { throw new Error('getText should not be used'); };

        assert.equal(getFilenameFromDocument(doc, 2), 'b.key');
    });

    it('navigates between keyword lines without reading the whole document text', () => {
        const doc = fakeDoc('*A\ndata\n*B\nmore\n*C\n');
        doc.getText = () => { throw new Error('getText should not be used'); };

        assert.equal(findNextKeywordInDocument(doc, 0), 2);
        assert.equal(findPreviousKeywordInDocument(doc, 4), 2);
    });
});

// ---------------------------------------------------------------------------
// LsdynaIncludeTreeProvider
// ---------------------------------------------------------------------------

describe('LsdynaIncludeTreeProvider', () => {
    it('builds include trees without readFileSync on scanned files', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-tree-'));
        const submodelsDir = path.join(tempRoot, 'submodels');
        const mainFile = path.join(tempRoot, 'main.k');
        const aFile = path.join(tempRoot, 'a.key');
        const bFile = path.join(submodelsDir, 'b.key');

        fs.mkdirSync(submodelsDir);
        fs.writeFileSync(mainFile, '*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\na.key\nb.key\n');
        fs.writeFileSync(aFile, '*KEYWORD\n');
        fs.writeFileSync(bFile, '*KEYWORD\n');

        const provider = new LsdynaIncludeTreeProvider({ searchFileFromPaths });
        const originalReadFileSync = fs.readFileSync;
        fs.readFileSync = function patchedReadFileSync(filePath) {
            if (filePath === mainFile || filePath === aFile || filePath === bFile) {
                throw new Error('include tree scanning should not use readFileSync for deck files');
            }
            return originalReadFileSync.apply(this, arguments);
        };

        try {
            const root = await provider._buildItem(mainFile, new Set(), { report() {} });
            assert.deepEqual(
                root.children.map(child => child.filePath).sort(),
                [aFile, bFile].sort()
            );
        } finally {
            fs.readFileSync = originalReadFileSync;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// LsdynaKeywordIndexProvider
// ---------------------------------------------------------------------------

describe('LsdynaKeywordIndexProvider', () => {
    it('yields during large single-file keyword scans', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-keyword-index-'));
        const bigFile = path.join(tempRoot, 'big.k');
        const lines = ['*KEYWORD'];
        for (let i = 0; i < 50000; i++) lines.push(`$ line ${i}`);
        fs.writeFileSync(bigFile, lines.join('\n'));

        const provider = new LsdynaKeywordIndexProvider({ collectIncludeFiles, shouldSkipAutomaticDocumentScan });
        const originalSetImmediate = global.setImmediate;
        let yieldCount = 0;
        global.setImmediate = (callback, ...args) => {
            yieldCount++;
            callback(...args);
            return yieldCount;
        };

        try {
            await provider._buildRootsAsync([bigFile], tempRoot);
            assert.ok(yieldCount >= 2, `expected at least 2 yields, got ${yieldCount}`);
        } finally {
            global.setImmediate = originalSetImmediate;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Debounce helpers
// ---------------------------------------------------------------------------

describe('createActiveDocumentDebouncer', () => {
    it('refreshes only if the changed document is still active when the timer fires', () => {
        const scheduled = new Map();
        let nextTimerId = 1;
        let activeDocument = { uri: { fsPath: '/a.k' } };
        const refreshed = [];

        const debouncer = createActiveDocumentDebouncer(
            () => activeDocument,
            (document) => refreshed.push(document.uri.fsPath),
            500,
            (callback) => {
                const timerId = nextTimerId++;
                scheduled.set(timerId, callback);
                return timerId;
            },
            (timerId) => scheduled.delete(timerId)
        );

        const changedDocument = { uri: { fsPath: '/a.k' } };
        debouncer(changedDocument);
        activeDocument = { uri: { fsPath: '/b.k' } };
        scheduled.forEach(callback => callback());

        assert.deepEqual(refreshed, []);
    });
});

// ---------------------------------------------------------------------------
// large document guards
// ---------------------------------------------------------------------------

describe('large document guards', () => {
    function createHugeDoc() {
        return {
            languageId: 'lsdyna',
            lineCount: 100001,
            version: 1,
            uri: { fsPath: '/project/huge.k' },
            lineAt() {
                throw new Error('lineAt should not be used for very large automatic scans');
            },
        };
    }

    it('skips automatic line-length diagnostics for very large documents', () => {
        assert.deepEqual(collectLineLengthDiagnostics(createHugeDoc()), []);
    });

    it('skips automatic include decorations for very large documents', () => {
        assert.deepEqual(collectIncludeDecorationSets(createHugeDoc()), { resolved: [], missing: [] });
    });

    it('uses multi-line ranges for continued include decorations', () => {
        const doc = fakeDoc('*INCLUDE\npart_a +\npart_b.key\n', '/project/main.k');
        doc.languageId = 'lsdyna';

        const { missing } = collectIncludeDecorationSets(doc);

        assert.equal(missing.length, 1);
        assert.equal(missing[0].range.start.line, 1);
        assert.equal(missing[0].range.end.line, 2);
        assert.equal(missing[0].range.end.character, 'part_b.key'.length);
    });

    it('splits continued include decorations around skipped comment lines', () => {
        const doc = fakeDoc('*INCLUDE\npart_a +\n$ skip me\npart_b.key\n', '/project/main.k');
        doc.languageId = 'lsdyna';

        const { missing } = collectIncludeDecorationSets(doc);

        assert.equal(missing.length, 2);
        assert.deepEqual(
            missing.map(item => [item.range.start.line, item.range.end.line]),
            [[1, 1], [3, 3]]
        );
    });

    it('skips automatic include document links for very large documents', () => {
        assert.deepEqual(collectIncludeDocumentLinks(createHugeDoc()), []);
    });

    it('splits continued include document links around skipped comment lines', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-links-'));
        const includeFile = path.join(tempRoot, 'part_apart_b.key');
        const mainFile = path.join(tempRoot, 'main.k');

        fs.writeFileSync(includeFile, '*KEYWORD\n');
        fs.writeFileSync(mainFile, '*INCLUDE\npart_a +\n$ skip me\npart_b.key\n');

        try {
            const doc = fakeDoc(fs.readFileSync(mainFile, 'utf8'), mainFile);
            const links = collectIncludeDocumentLinks(doc);

            assert.equal(links.length, 2);
            assert.deepEqual(
                links.map(link => [link.range.start.line, link.range.end.line]),
                [[1, 1], [3, 3]]
            );
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('treats very large documents as not being on an include line without scanning', () => {
        assert.equal(isIncludeLine(createHugeDoc(), 10), false);
    });

    it('treats continuation lines as include lines but skips comment gaps', () => {
        const doc = fakeDoc('*INCLUDE\npart_a +\n$ skip me\npart_b.key\n');
        doc.languageId = 'lsdyna';

        assert.equal(isIncludeLine(doc, 1), true);
        assert.equal(isIncludeLine(doc, 2), false);
        assert.equal(isIncludeLine(doc, 3), true);
    });

    it('skips local keyword index refresh for very large documents', () => {
        const provider = new LsdynaKeywordIndexProvider({ collectIncludeFiles, shouldSkipAutomaticDocumentScan });
        provider.roots = [{ label: 'stale' }];

        provider.refreshFromDocument(createHugeDoc());

        assert.deepEqual(provider.roots, []);
    });

    it('skips folding ranges for very large documents', () => {
        const provider = new LsDynaFoldingProvider();
        assert.deepEqual(provider.provideFoldingRanges(createHugeDoc()), []);
    });

    it('skips keyword symbols for very large documents', () => {
        const provider = new LsdynaKeywordSymbolProvider();
        assert.deepEqual(provider.provideDocumentSymbols(createHugeDoc()), []);
    });

    it('skips hover work for very large documents', () => {
        const provider = new LsdynaFieldHoverProvider();
        assert.equal(provider.provideHover(createHugeDoc(), { line: 0, character: 0 }), null);
    });

    it('skips parameter definitions for very large documents', () => {
        assert.equal(findParameterDefinitions(createHugeDoc()).size, 0);
    });

    it('skips parameter references for very large documents', () => {
        assert.deepEqual(findParameterReferences(createHugeDoc()), []);
    });

    it('returns no parameter at cursor for very large documents', () => {
        assert.equal(getParameterAtCursor(createHugeDoc(), { line: 0, character: 0 }), null);
    });
});

// ---------------------------------------------------------------------------
// getParameterAtCursor
// ---------------------------------------------------------------------------

describe('getParameterAtCursor', () => {
    const { Position } = require('./vscode-mock');

    it('detects &name reference', () => {
        const doc = fakeDoc('*KEYWORD\n  &tEnd\n');
        const result = getParameterAtCursor(doc, new Position(1, 3));
        assert.ok(result);
        assert.equal(result.name, 'tEnd');
    });

    it('detects parameter definition name', () => {
        const doc = fakeDoc('*PARAMETER\nR   tEnd   5.0\n');
        const result = getParameterAtCursor(doc, new Position(1, 5));
        assert.ok(result);
        assert.equal(result.name, 'tEnd');
    });

    it('detects bare name reference in *PARAMETER_EXPRESSION value', () => {
        const doc = fakeDoc('*PARAMETER\nR  tEnd  5.0\n*PARAMETER_EXPRESSION\nR  dtPlot  tEnd/100.0\n');
        const result = getParameterAtCursor(doc, new Position(3, 11));
        assert.ok(result);
        assert.equal(result.name.toUpperCase(), 'TEND');
    });

    it('returns null outside any parameter context', () => {
        const doc = fakeDoc('*KEYWORD\nsome data line\n');
        const result = getParameterAtCursor(doc, new Position(1, 3));
        assert.equal(result, null);
    });
});

// ---------------------------------------------------------------------------
// LsdynaFieldHoverProvider
// ---------------------------------------------------------------------------

describe('LsdynaFieldHoverProvider', () => {
    it('preserves embedded help newlines as markdown hard breaks', () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc('*CONTROL_TERMINATION\n                                                            \n');

        const hover = provider.provideHover(doc, { line: 1, character: 35 });

        assert.ok(hover);
        assert.equal(
            hover.contents[0].value,
            '**ENDENG** *(real)*\n\nPercent change in energy ratio for termination of calculation. If undefined, this option is inactive.  \n中文：用于终止计算的能量比变化百分比。若未定义，则该选项不启用。'
        );
    });
});
