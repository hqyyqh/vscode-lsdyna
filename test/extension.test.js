'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fakeDoc, vscodeMock } = require('./helpers');
const i18n = require('../src/core/i18n');
const extensionModule = require('../src/extension');
const { LsdynaIncludeTreeProvider } = require('../src/client/providers/includeTreeProvider');
const { LsdynaKeywordIndexProvider } = require('../src/client/providers/keywordIndexProvider');
const { buildProjectIndex } = require('../src/core/project/projectIndexer');
const {
    collectIncludeDecorationSets,
    collectKeywordDecorationRanges,
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
    isLsdynaUri,
    LsdynaFieldHoverProvider,
    LsdynaKeywordOptionsCodeLensProvider,
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
    createManifestDrivenInvalidator,
    createBatchedManifestInvalidator,
    createProjectSnapshotRefreshQueue,
    createProjectIndexLoader,
    createProjectSnapshotPersistentCache,
    chooseKeywordOptionsForEditor,
    updateDocumentDiagnostics,
    cacheReferenceIndexFromSnapshot,
    clearReferenceIndexCacheForTesting,
    setFileIndexForTesting,
} = extensionModule._internals;

describe('updateDocumentDiagnostics', () => {
    it('deletes stale diagnostics when a document is no longer LS-DYNA', () => {
        const deleted = [];
        const document = fakeDoc('plain text', '/project/readme.txt');
        document.languageId = 'plaintext';
        updateDocumentDiagnostics(document, {
            set() {},
            delete(uri) { deleted.push(uri.fsPath); },
        });

        assert.deepStrictEqual(deleted, ['/project/readme.txt']);
    });
});

describe('indented keyword editor features', () => {
    it('provides symbols and folds for indented mixed-case keywords', () => {
        const document = fakeDoc(' \t*node\n1,2,3\n  *Part\ntitle\n');
        document.languageId = 'lsdyna';

        const symbols = new LsdynaKeywordSymbolProvider().provideDocumentSymbols(document);
        const folds = new LsDynaFoldingProvider().provideFoldingRanges(document);

        assert.equal(symbols.length, 2);
        assert.deepStrictEqual(folds.map(range => [range.start, range.end]), [[0, 1], [2, 4]]);
    });
});

const FIXTURE_DIR = path.join(__dirname, 'Bolt_A_Explicit');

function decodeCommandUriArgs(uri) {
    const text = uri.toString ? uri.toString() : uri.fsPath;
    const query = text.slice(text.indexOf('?') + 1);
    return JSON.parse(decodeURIComponent(query));
}

function makeEditableEditor(lines, activeLine = 0) {
    const editableLines = lines.slice();
    const document = {
        get lineCount() {
            return editableLines.length;
        },
        uri: { fsPath: '/project/main.k' },
        languageId: 'lsdyna',
        lineAt(index) {
            const text = editableLines[index] || '';
            return { text, range: new vscodeMock.Range(index, 0, index, text.length) };
        },
        getText(range) {
            if (!range) return editableLines.join('\n');
            if (range.start.line === range.end.line) {
                return editableLines[range.start.line].slice(range.start.character, range.end.character);
            }
            return editableLines.slice(range.start.line, range.end.line + 1)
                .map((line, index, all) => {
                    if (index === 0) return line.slice(range.start.character);
                    if (index === all.length - 1) return line.slice(0, range.end.character);
                    return line;
                })
                .join('\n');
        },
    };

    function applyReplace(range, text) {
        const before = editableLines.slice(0, range.start.line);
        const after = editableLines.slice(range.end.line);
        if (range.end.line < editableLines.length) {
            after[0] = editableLines[range.end.line].slice(range.end.character);
        }
        const firstPrefix = editableLines[range.start.line].slice(0, range.start.character);
        const lastSuffix = range.end.line < editableLines.length
            ? editableLines[range.end.line].slice(range.end.character)
            : '';
        const replacement = (firstPrefix + text + lastSuffix).split('\n');
        editableLines.splice(0, editableLines.length, ...before, ...replacement, ...after.slice(1));
    }

    let selection = new vscodeMock.Selection(
        new vscodeMock.Position(activeLine, 0),
        new vscodeMock.Position(activeLine, 0)
    );

    return {
        document,
        lines: editableLines,
        get selection() { return selection; },
        set selection(value) { selection = value; },
        async edit(callback) {
            const edits = [];
            callback({
                replace(range, text) {
                    edits.push({ range, text });
                },
                insert(position, text) {
                    edits.push({ range: new vscodeMock.Range(position, position), text });
                },
            });
            edits.sort((a, b) => {
                if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
                return b.range.start.character - a.range.start.character;
            });
            for (const edit of edits) {
                applyReplace(edit.range, edit.text);
            }
            return true;
        },
    };
}

// ---------------------------------------------------------------------------
// findParameterDefinitions
// ---------------------------------------------------------------------------

describe('findParameterDefinitions', () => {
    it('handles indented mixed-case parameter keywords', () => {
        const doc = fakeDoc('  *parameter\nR  tEnd  5.0\n\t*parameter_expression\nR  dtPlot  tEnd/100.0\n');
        const defs = findParameterDefinitions(doc);

        assert.ok(defs.has('TEND'));
        assert.ok(defs.has('DTPLOT'));
        assert.equal(findParameterReferences(doc).filter(ref => ref.name === 'TEND').length, 1);
    });

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
    it('finds indented mixed-case keyword lines', () => {
        assert.equal(findNextKeyword(['*A', 'data', ' \t*b'], 0), 2);
    });

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
    it('finds indented mixed-case keyword lines', () => {
        assert.equal(findPreviousKeyword([' \t*a', 'data', '*B'], 2), 0);
    });

    it('finds the previous * line', () => {
        assert.equal(findPreviousKeyword(['*A', 'data', '*B', 'data'], 3), 2);
    });

    it('throws when no previous keyword exists', () => {
        assert.throws(() => findPreviousKeyword(['data', 'data'], 1));
    });
});

describe('startLineOfCurrentKeyword', () => {
    it('finds an indented mixed-case enclosing keyword', () => {
        assert.equal(startLineOfCurrentKeyword([' \t*node', 'data'], 1), 0);
    });

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
    it('ends before an indented mixed-case keyword', () => {
        assert.equal(endLineOfCurrentKeyword(['*A', 'data', ' \t*node'], 0), 1);
    });

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
    it('extracts filenames from indented mixed-case include keywords', () => {
        assert.equal(getFilenameFromKeyword([' \t*Include', 'geometry.k'], 1), 'geometry.k');
    });

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

    it('builds include tree items from a project snapshot', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-tree-'));
        const mainFile = path.join(tempRoot, 'main.k');
        const aFile = path.join(tempRoot, 'a.key');
        const bFile = path.join(tempRoot, 'b.key');

        fs.writeFileSync(mainFile, '*KEYWORD\n');
        fs.writeFileSync(aFile, '*KEYWORD\n');
        fs.writeFileSync(bFile, '*KEYWORD\n');

        const provider = new LsdynaIncludeTreeProvider({ searchFileFromPaths });
        const snapshot = {
            graph: {
                toTree(filePath) {
                    assert.equal(filePath, mainFile);
                    return {
                        filePath: mainFile,
                        children: [
                            {
                                filePath: aFile,
                                children: [
                                    {
                                        filePath: bFile,
                                        children: [],
                                    },
                                ],
                            },
                        ],
                    };
                },
            },
        };

        try {
            const root = provider._buildRootFromSnapshot(snapshot, mainFile);
            assert.equal(root.filePath, mainFile);
            assert.deepEqual(root.children.map(child => child.filePath), [aFile]);
            assert.deepEqual(root.children[0].children.map(child => child.filePath), [bFile]);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('preserves missing include nodes when building tree items from a project snapshot', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-tree-'));
        const mainFile = path.join(tempRoot, 'main.k');
        const childFile = path.join(tempRoot, 'child.key');
        const missingFile = path.join(tempRoot, 'missing.key');
        const provider = new LsdynaIncludeTreeProvider({ searchFileFromPaths });

        fs.writeFileSync(mainFile, '*INCLUDE\nchild.key\nmissing.key\n', 'utf8');
        fs.writeFileSync(childFile, '*KEYWORD\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(mainFile);
            const root = provider._buildRootFromSnapshot(snapshot, mainFile);

            assert.deepEqual(root.children.map(child => child.filePath), [childFile, missingFile]);
            assert.equal(root.children[1].description, 'missing');
            assert.equal(root.children[1].command, undefined);
            assert.equal(root.children[1].collapsibleState, vscodeMock.TreeItemCollapsibleState.None);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('preserves duplicate missing include nodes when building tree items from a project snapshot', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-tree-'));
        const mainFile = path.join(tempRoot, 'main.k');
        const childFile = path.join(tempRoot, 'child.key');
        const missingFile = path.join(tempRoot, 'missing.key');
        const provider = new LsdynaIncludeTreeProvider({ searchFileFromPaths });

        fs.writeFileSync(mainFile, '*INCLUDE\nmissing.key\nmissing.key\nchild.key\n', 'utf8');
        fs.writeFileSync(childFile, '*KEYWORD\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(mainFile);
            const root = provider._buildRootFromSnapshot(snapshot, mainFile);

            assert.deepEqual(root.children.map(child => child.filePath), [missingFile, missingFile, childFile]);
            assert.equal(root.children[0].description, 'missing');
            assert.equal(root.children[1].description, 'missing');
            assert.equal(root.children[0].command, undefined);
            assert.equal(root.children[1].command, undefined);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('uses the shared project snapshot loader during scans when available', async () => {
        const rootFile = path.join('project', 'snapshot-root', 'main.k');
        const aFile = path.join('project', 'snapshot-root', 'a.key');
        const provider = new LsdynaIncludeTreeProvider({
            searchFileFromPaths() {
                throw new Error('searchFileFromPaths should not be used when loadProjectSnapshot is available');
            },
            loadProjectSnapshot: async (filePath) => {
                assert.equal(filePath, rootFile);
                return {
                    graph: {
                        toTree(treeRootFile) {
                            assert.equal(treeRootFile, rootFile);
                            return {
                                filePath: rootFile,
                                children: [
                                    { filePath: aFile, children: [] },
                                ],
                            };
                        },
                    },
                };
            },
        });
        const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
        const originalWithProgress = vscodeMock.window.withProgress;
        const originalProgressLocation = vscodeMock.ProgressLocation;

        vscodeMock.window.activeTextEditor = {
            document: {
                languageId: 'lsdyna',
                uri: { fsPath: rootFile },
            },
        };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} });
        vscodeMock.ProgressLocation = { Notification: 15 };

        try {
            await provider.scan();

            assert.ok(provider.root);
            assert.equal(provider.root.filePath, rootFile);
            assert.deepEqual(provider.root.children.map(child => child.filePath), [aFile]);
        } finally {
            vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            vscodeMock.window.withProgress = originalWithProgress;
            vscodeMock.ProgressLocation = originalProgressLocation;
        }
    });
});

// ---------------------------------------------------------------------------
// LsdynaKeywordIndexProvider
// ---------------------------------------------------------------------------

describe('LsdynaKeywordIndexProvider', () => {
    it('builds keyword roots from a project snapshot', () => {
        const rootDir = path.join('project', 'snapshot-root');
        const aFile = path.join(rootDir, 'submodels', 'a.key');
        const bFile = path.join(rootDir, 'b.key');
        const provider = new LsdynaKeywordIndexProvider();
        const snapshot = {
            keywordMap: new Map([
                ['PART', [
                    { filePath: aFile, lineIndex: 1 },
                    { filePath: bFile, lineIndex: 7 },
                ]],
                ['MAT_ELASTIC', [
                    { filePath: bFile, lineIndex: 4 },
                ]],
            ]),
        };

        const roots = provider._buildRootsFromSnapshot(snapshot, rootDir);

        assert.deepEqual(roots.map(item => item.label), ['MAT_ELASTIC', 'PART']);
        assert.deepEqual(
            roots[1].children.map(child => child.command.arguments),
            [
                [aFile, 1],
                [bFile, 7],
            ]
        );
    });

    it('uses the project snapshot during recursive scans when available', async () => {
        const rootFile = path.join('project', 'snapshot-root', 'main.k');
        const provider = new LsdynaKeywordIndexProvider({
            collectIncludeFiles: async () => {
                throw new Error('collectIncludeFiles should not be called when loadProjectSnapshot is available');
            },
            loadProjectSnapshot: async (filePath) => {
                assert.equal(filePath, rootFile);
                return {
                    keywordMap: new Map([
                        ['PART', [{ filePath: rootFile, lineIndex: 2 }]],
                    ]),
                };
            },
            shouldSkipAutomaticDocumentScan,
        });
        const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
        const originalWithProgress = vscodeMock.window.withProgress;
        const originalProgressLocation = vscodeMock.ProgressLocation;

        vscodeMock.window.activeTextEditor = {
            document: {
                languageId: 'lsdyna',
                uri: { fsPath: rootFile },
            },
        };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} });
        vscodeMock.ProgressLocation = { Notification: 15 };

        try {
            await provider.scan();

            assert.equal(provider._mode, 'recursive');
            assert.deepEqual(provider.roots.map(item => item.label), ['PART']);
            assert.deepEqual(
                provider.roots[0].children.map(child => child.command.arguments),
                [[rootFile, 2]]
            );
        } finally {
            vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            vscodeMock.window.withProgress = originalWithProgress;
            vscodeMock.ProgressLocation = originalProgressLocation;
        }
    });

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

describe('activate', () => {
    it('registers document links for clickable include paths', () => {
        const context = { subscriptions: [] };
        const disposable = { dispose() {} };
        let registration;
        const originalRegisterTreeDataProvider = vscodeMock.window.registerTreeDataProvider;
        const originalOnDidChangeActiveTextEditor = vscodeMock.window.onDidChangeActiveTextEditor;
        const originalOnDidChangeTextEditorSelection = vscodeMock.window.onDidChangeTextEditorSelection;
        const originalCreateTextEditorDecorationType = vscodeMock.window.createTextEditorDecorationType;
        const originalRegisterHoverProvider = vscodeMock.languages.registerHoverProvider;
        const originalRegisterCodeLensProvider = vscodeMock.languages.registerCodeLensProvider;
        const originalRegisterDocumentLinkProvider = vscodeMock.languages.registerDocumentLinkProvider;

        vscodeMock.window.registerTreeDataProvider = () => disposable;
        vscodeMock.window.onDidChangeActiveTextEditor = () => disposable;
        vscodeMock.window.onDidChangeTextEditorSelection = () => disposable;
        vscodeMock.window.createTextEditorDecorationType = () => disposable;
        vscodeMock.languages.registerHoverProvider = () => disposable;
        vscodeMock.languages.registerCodeLensProvider = () => disposable;
        vscodeMock.languages.registerDocumentLinkProvider = (selector, provider) => {
            registration = { selector, provider };
            return disposable;
        };

        try {
            extensionModule.activate(context);

            assert.deepEqual(registration.selector, { language: 'lsdyna' });
            assert.equal(typeof registration.provider.provideDocumentLinks, 'function');
        } finally {
            vscodeMock.window.registerTreeDataProvider = originalRegisterTreeDataProvider;
            vscodeMock.window.onDidChangeActiveTextEditor = originalOnDidChangeActiveTextEditor;
            vscodeMock.window.onDidChangeTextEditorSelection = originalOnDidChangeTextEditorSelection;
            vscodeMock.window.createTextEditorDecorationType = originalCreateTextEditorDecorationType;
            vscodeMock.languages.registerHoverProvider = originalRegisterHoverProvider;
            vscodeMock.languages.registerCodeLensProvider = originalRegisterCodeLensProvider;
            vscodeMock.languages.registerDocumentLinkProvider = originalRegisterDocumentLinkProvider;
        }
    });

    it('injects a shared project snapshot loader into both tree providers', () => {
        const context = { subscriptions: [] };
        const registrations = new Map();
        const disposable = { dispose() {} };
        const originalRegisterTreeDataProvider = vscodeMock.window.registerTreeDataProvider;
        const originalCreateTreeView = vscodeMock.window.createTreeView;
        const originalOnDidChangeActiveTextEditor = vscodeMock.window.onDidChangeActiveTextEditor;
        const originalOnDidChangeTextEditorSelection = vscodeMock.window.onDidChangeTextEditorSelection;
        const originalCreateTextEditorDecorationType = vscodeMock.window.createTextEditorDecorationType;
        const originalRegisterHoverProvider = vscodeMock.languages.registerHoverProvider;
        const originalRegisterCodeLensProvider = vscodeMock.languages.registerCodeLensProvider;

        vscodeMock.window.registerTreeDataProvider = (viewId, provider) => {
            registrations.set(viewId, provider);
            return disposable;
        };
        vscodeMock.window.createTreeView = (viewId, options) => {
            registrations.set(viewId, options.treeDataProvider);
            return {
                title: '',
                dispose() {}
            };
        };
        vscodeMock.window.onDidChangeActiveTextEditor = () => disposable;
        vscodeMock.window.onDidChangeTextEditorSelection = () => disposable;
        vscodeMock.window.createTextEditorDecorationType = () => disposable;
        vscodeMock.languages.registerHoverProvider = () => disposable;
        vscodeMock.languages.registerCodeLensProvider = () => disposable;

        try {
            extensionModule.activate(context);

            const includeTreeProvider = registrations.get('lsdynaIncludeTree');
            const keywordIndexProvider = registrations.get('lsdynaKeywordIndex');
            assert.ok(includeTreeProvider instanceof LsdynaIncludeTreeProvider);
            assert.ok(keywordIndexProvider instanceof LsdynaKeywordIndexProvider);
            assert.equal(typeof includeTreeProvider.loadProjectSnapshot, 'function');
            assert.equal(typeof keywordIndexProvider.loadProjectSnapshot, 'function');
            assert.strictEqual(keywordIndexProvider.loadProjectSnapshot, includeTreeProvider.loadProjectSnapshot);
        } finally {
            vscodeMock.window.registerTreeDataProvider = originalRegisterTreeDataProvider;
            vscodeMock.window.createTreeView = originalCreateTreeView;
            vscodeMock.window.onDidChangeActiveTextEditor = originalOnDidChangeActiveTextEditor;
            vscodeMock.window.onDidChangeTextEditorSelection = originalOnDidChangeTextEditorSelection;
            vscodeMock.window.createTextEditorDecorationType = originalCreateTextEditorDecorationType;
            vscodeMock.languages.registerHoverProvider = originalRegisterHoverProvider;
            vscodeMock.languages.registerCodeLensProvider = originalRegisterCodeLensProvider;
        }
    });

    it('registers a workspace watcher for LS-DYNA project files', () => {
        const context = { subscriptions: [] };
        const disposable = { dispose() {} };
        const watcherGlobs = [];
        const originalCreateFileSystemWatcher = vscodeMock.workspace.createFileSystemWatcher;
        const originalRegisterTreeDataProvider = vscodeMock.window.registerTreeDataProvider;
        const originalOnDidChangeActiveTextEditor = vscodeMock.window.onDidChangeActiveTextEditor;
        const originalOnDidChangeTextEditorSelection = vscodeMock.window.onDidChangeTextEditorSelection;
        const originalCreateTextEditorDecorationType = vscodeMock.window.createTextEditorDecorationType;
        const originalRegisterHoverProvider = vscodeMock.languages.registerHoverProvider;
        const originalRegisterCodeLensProvider = vscodeMock.languages.registerCodeLensProvider;

        vscodeMock.workspace.createFileSystemWatcher = (glob) => {
            watcherGlobs.push(glob);
            return {
                onDidChange: () => disposable,
                onDidCreate: () => disposable,
                onDidDelete: () => disposable,
                dispose() {},
            };
        };
        vscodeMock.window.registerTreeDataProvider = () => disposable;
        vscodeMock.window.onDidChangeActiveTextEditor = () => disposable;
        vscodeMock.window.onDidChangeTextEditorSelection = () => disposable;
        vscodeMock.window.createTextEditorDecorationType = () => disposable;
        vscodeMock.languages.registerHoverProvider = () => disposable;
        vscodeMock.languages.registerCodeLensProvider = () => disposable;

        try {
            extensionModule.activate(context);
            assert.deepEqual(watcherGlobs, ['**/*.asc', '**/*.dyna', '**/*.k', '**/*.key']);
        } finally {
            vscodeMock.workspace.createFileSystemWatcher = originalCreateFileSystemWatcher;
            vscodeMock.window.registerTreeDataProvider = originalRegisterTreeDataProvider;
            vscodeMock.window.onDidChangeActiveTextEditor = originalOnDidChangeActiveTextEditor;
            vscodeMock.window.onDidChangeTextEditorSelection = originalOnDidChangeTextEditorSelection;
            vscodeMock.window.createTextEditorDecorationType = originalCreateTextEditorDecorationType;
            vscodeMock.languages.registerHoverProvider = originalRegisterHoverProvider;
            vscodeMock.languages.registerCodeLensProvider = originalRegisterCodeLensProvider;
        }
    });
});

describe('createManifestDrivenInvalidator', () => {
    it('invalidates every affected project root for a changed tracked file', () => {
        const rootA = path.resolve('project', 'root-a.k');
        const rootB = path.resolve('project', 'root-b.k');
        const changedFile = path.resolve('project', 'shared.key');
        const invalidatedRoots = [];
        const invalidateChangedFile = createManifestDrivenInvalidator({
            indexClient: {
                getManifestEntries() {
                    return [
                        { rootFile: rootA, trackedFiles: [rootA, changedFile] },
                        { rootFile: rootB, trackedFiles: [rootB, changedFile] },
                    ];
                },
                invalidate(rootFile) {
                    invalidatedRoots.push(rootFile);
                },
            },
        });

        invalidateChangedFile({ fsPath: changedFile });

        assert.deepEqual(invalidatedRoots, [rootA, rootB]);
    });

    it('ignores untracked files', () => {
        const rootFile = path.resolve('project', 'root.k');
        const invalidatedRoots = [];
        const invalidateChangedFile = createManifestDrivenInvalidator({
            indexClient: {
                getManifestEntries() {
                    return [
                        { rootFile, trackedFiles: [rootFile] },
                    ];
                },
                invalidate(root) {
                    invalidatedRoots.push(root);
                },
            },
        });

        invalidateChangedFile({ fsPath: path.resolve('project', 'other.key') });

        assert.deepEqual(invalidatedRoots, []);
    });
});

describe('createBatchedManifestInvalidator', () => {
    it('coalesces rapid file events into one invalidation per affected root', () => {
        const rootFile = path.resolve('project', 'root.k');
        const changedFile = path.resolve('project', 'shared.key');
        const invalidatedRoots = [];
        const scheduled = new Map();
        let nextTimerId = 1;
        const batchedInvalidator = createBatchedManifestInvalidator({
            indexClient: {
                getManifestEntries() {
                    return [{ rootFile, trackedFiles: [rootFile, changedFile] }];
                },
                invalidate(root) {
                    invalidatedRoots.push(root);
                },
            },
            delayMs: 50,
            schedule(callback) {
                const timerId = nextTimerId++;
                scheduled.set(timerId, callback);
                return timerId;
            },
            cancel(timerId) {
                scheduled.delete(timerId);
            },
        });

        batchedInvalidator({ fsPath: changedFile });
        batchedInvalidator({ fsPath: changedFile });
        scheduled.forEach(callback => callback());

        assert.deepEqual(invalidatedRoots, [rootFile]);
    });

    it('batches multiple roots discovered across rapid file events', () => {
        const rootA = path.resolve('project', 'root-a.k');
        const rootB = path.resolve('project', 'root-b.k');
        const invalidatedRoots = [];
        const scheduled = new Map();
        let nextTimerId = 1;
        const batchedInvalidator = createBatchedManifestInvalidator({
            indexClient: {
                getManifestEntries() {
                    return [
                        { rootFile: rootA, trackedFiles: [rootA, path.resolve('project', 'a.key')] },
                        { rootFile: rootB, trackedFiles: [rootB, path.resolve('project', 'b.key')] },
                    ];
                },
                invalidate(root) {
                    invalidatedRoots.push(root);
                },
            },
            delayMs: 50,
            schedule(callback) {
                const timerId = nextTimerId++;
                scheduled.set(timerId, callback);
                return timerId;
            },
            cancel(timerId) {
                scheduled.delete(timerId);
            },
        });

        batchedInvalidator({ fsPath: path.resolve('project', 'a.key') });
        batchedInvalidator({ fsPath: path.resolve('project', 'b.key') });
        scheduled.forEach(callback => callback());

        assert.deepEqual(invalidatedRoots.sort(), [rootA, rootB].sort());
    });

    it('does not reschedule the timer for untracked file events', () => {
        const rootFile = path.resolve('project', 'root.k');
        const trackedFile = path.resolve('project', 'tracked.key');
        const untrackedFile = path.resolve('project', 'other.key');
        const invalidatedRoots = [];
        const scheduled = new Map();
        let nextTimerId = 1;
        let scheduledCount = 0;
        let cancelledCount = 0;
        const batchedInvalidator = createBatchedManifestInvalidator({
            indexClient: {
                getManifestEntries() {
                    return [{ rootFile, trackedFiles: [rootFile, trackedFile] }];
                },
                invalidate(root) {
                    invalidatedRoots.push(root);
                },
            },
            delayMs: 50,
            schedule(callback) {
                scheduledCount += 1;
                const timerId = nextTimerId++;
                scheduled.set(timerId, callback);
                return timerId;
            },
            cancel(timerId) {
                cancelledCount += 1;
                scheduled.delete(timerId);
            },
        });

        batchedInvalidator({ fsPath: trackedFile });
        batchedInvalidator({ fsPath: untrackedFile });
        scheduled.forEach(callback => callback());

        assert.equal(scheduledCount, 1);
        assert.equal(cancelledCount, 0);
        assert.deepEqual(invalidatedRoots, [rootFile]);
    });
});

describe('createProjectSnapshotRefreshQueue', () => {
    it('refreshes queued roots sequentially and deduplicates repeated roots', async () => {
        const rootA = path.resolve('project', 'root-a.k');
        const rootB = path.resolve('project', 'root-b.k');
        const startedRoots = [];
        const resolvers = [];
        const scheduled = [];
        const enqueueRefresh = createProjectSnapshotRefreshQueue({
            loadProjectSnapshot(rootFile) {
                startedRoots.push(rootFile);
                return new Promise(resolve => resolvers.push(resolve));
            },
            schedule(callback) {
                scheduled.push(callback);
                return scheduled.length;
            },
        });

        enqueueRefresh(rootA);
        enqueueRefresh(rootA);
        enqueueRefresh(rootB);

        assert.equal(scheduled.length, 1);

        scheduled.shift()();
        assert.deepEqual(startedRoots, [rootA]);

        resolvers.shift()();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(startedRoots, [rootA, rootB]);
    });

    it('continues refreshing later roots after a refresh failure', async () => {
        const rootA = path.resolve('project', 'root-a.k');
        const rootB = path.resolve('project', 'root-b.k');
        const errors = [];
        const startedRoots = [];
        const scheduled = [];
        const enqueueRefresh = createProjectSnapshotRefreshQueue({
            async loadProjectSnapshot(rootFile) {
                startedRoots.push(rootFile);
                if (rootFile === rootA) throw new Error('refresh failed');
            },
            onError(error, rootFile) {
                errors.push({ message: error.message, rootFile });
            },
            schedule(callback) {
                scheduled.push(callback);
                return scheduled.length;
            },
        });

        enqueueRefresh(rootA);
        enqueueRefresh(rootB);
        scheduled.shift()();
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(startedRoots, [rootA, rootB]);
        assert.deepEqual(errors, [{ message: 'refresh failed', rootFile: rootA }]);
    });

    it('keeps refreshes sequential when new roots are enqueued during active processing', async () => {
        const rootA = path.resolve('project', 'root-a.k');
        const rootB = path.resolve('project', 'root-b.k');
        const startedRoots = [];
        const activeRoots = new Set();
        let maxConcurrent = 0;
        let resolveRootA;
        const scheduled = [];
        const enqueueRefresh = createProjectSnapshotRefreshQueue({
            loadProjectSnapshot(rootFile) {
                startedRoots.push(rootFile);
                activeRoots.add(rootFile);
                maxConcurrent = Math.max(maxConcurrent, activeRoots.size);
                if (rootFile === rootA) {
                    return new Promise(resolve => {
                        resolveRootA = () => {
                            activeRoots.delete(rootFile);
                            resolve();
                        };
                    });
                }
                activeRoots.delete(rootFile);
                return Promise.resolve();
            },
            schedule(callback) {
                scheduled.push(callback);
                return scheduled.length;
            },
        });

        enqueueRefresh(rootA);
        scheduled.shift()();
        assert.deepEqual(startedRoots, [rootA]);

        enqueueRefresh(rootB);
        assert.equal(scheduled.length, 0);

        resolveRootA();
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(startedRoots, [rootA, rootB]);
        assert.equal(maxConcurrent, 1);
    });
});

describe('createProjectIndexLoader', () => {
    it('creates the worker pool lazily on first project index request and disposes it', async () => {
        const createdPools = [];
        let disposed = false;
        const snapshot = { rootFile: path.resolve('project', 'main.k') };
        const loader = createProjectIndexLoader({
            createPool({ workerPath }) {
                createdPools.push(workerPath);
                return {
                    buildProjectIndex: async () => snapshot,
                    dispose: async () => {
                        disposed = true;
                    },
                };
            },
            workerPath: path.resolve('custom', 'scanWorker.js'),
        });

        assert.deepEqual(createdPools, []);
        assert.strictEqual(await loader.buildProjectIndex(snapshot.rootFile), snapshot);
        assert.deepEqual(createdPools, [path.resolve('custom', 'scanWorker.js')]);

        await loader.dispose();
        assert.equal(disposed, true);
    });

    it('recreates the worker pool after a fatal worker failure', async () => {
        const createdPools = [];
        const snapshot = { rootFile: path.resolve('project', 'main.k') };
        let firstPoolDisposed = false;
        const loader = createProjectIndexLoader({
            createPool() {
                createdPools.push(createdPools.length + 1);
                if (createdPools.length === 1) {
                    return {
                        async buildProjectIndex() {
                            firstPoolDisposed = true;
                            throw new Error('worker crashed');
                        },
                        isDisposed() {
                            return firstPoolDisposed;
                        },
                        dispose: async () => {},
                    };
                }

                return {
                    async buildProjectIndex() {
                        return snapshot;
                    },
                    isDisposed() {
                        return false;
                    },
                    dispose: async () => {},
                };
            },
        });

        await assert.rejects(loader.buildProjectIndex(snapshot.rootFile), /worker crashed/);
        assert.strictEqual(await loader.buildProjectIndex(snapshot.rootFile), snapshot);
        assert.deepEqual(createdPools, [1, 2]);
    });
});

describe('createProjectSnapshotPersistentCache', () => {
    it('returns null when no global storage path is available', () => {
        assert.equal(createProjectSnapshotPersistentCache(), null);
        assert.equal(createProjectSnapshotPersistentCache({ storageUri: {} }), null);
    });

    it('creates the disk snapshot store under the extension global storage directory', () => {
        const created = [];
        const persistentCache = createProjectSnapshotPersistentCache({
            storageUri: { fsPath: path.resolve('storage-root') },
            createStore(options) {
                created.push(options);
                return { kind: 'disk-store' };
            },
        });

        assert.deepEqual(created, [{
            cacheDirectory: path.resolve('storage-root', 'project-snapshots'),
            maxCacheBytes: 256 * 1024 * 1024,
        }]);
        assert.deepEqual(persistentCache, { kind: 'disk-store' });
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
    let originalGetConfiguration;

    before(() => {
        originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'largeFile.enableRendering' ? false : defaultValue
        });
    });

    after(() => {
        vscodeMock.workspace.getConfiguration = originalGetConfiguration;
    });

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

    it('uses file index for folding and symbols without scanning huge documents', () => {
        const document = createHugeDoc();
        const fileIndex = {
            keywordBlocks: [
                { keyword: '*KEYWORD', startLine: 0, endLine: 9, keywordStartChar: 0 },
                { keyword: '*NODE', startLine: 10, endLine: 100, keywordStartChar: 0 },
                { keyword: '*END', startLine: 101, endLine: 101, keywordStartChar: 0 },
            ],
        };

        setFileIndexForTesting(document.uri.fsPath, fileIndex);
        try {
            const folds = new LsDynaFoldingProvider().provideFoldingRanges(document);
            const symbols = new LsdynaKeywordSymbolProvider().provideDocumentSymbols(document);

            assert.deepStrictEqual(folds.map(range => [range.start, range.end]), [[0, 9], [10, 100]]);
            assert.equal(symbols.length, 3);
        } finally {
            setFileIndexForTesting(document.uri.fsPath, null);
        }
    });

    it('skips automatic line-length diagnostics for very large documents', () => {
        assert.deepEqual(collectLineLengthDiagnostics(createHugeDoc()), []);
    });

    it('skips automatic keyword decorations for very large documents', () => {
        assert.deepEqual(collectKeywordDecorationRanges(createHugeDoc()), []);
    });

    it('collects keyword decoration ranges correctly', () => {
        const doc = fakeDoc('*NODE\n*ELEMENT_MASS, id=1\n  *MAT_ADD_EROSION\n$ comment line\n', '/project/main.k');
        doc.languageId = 'lsdyna';

        const ranges = collectKeywordDecorationRanges(doc);
        assert.equal(ranges.length, 3);

        assert.equal(ranges[0].start.line, 0);
        assert.equal(ranges[0].start.character, 0);
        assert.equal(ranges[0].end.line, 0);
        assert.equal(ranges[0].end.character, 5);

        assert.equal(ranges[1].start.line, 1);
        assert.equal(ranges[1].start.character, 0);
        assert.equal(ranges[1].end.line, 1);
        assert.equal(ranges[1].end.character, 13);

        assert.equal(ranges[2].start.line, 2);
        assert.equal(ranges[2].start.character, 2);
        assert.equal(ranges[2].end.line, 2);
        assert.equal(ranges[2].end.character, 18);
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

    it('creates document links for valid *INCLUDE_PATH directories', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-path-link-'));
        const includeDir = path.join(tempRoot, 'includes');
        const mainFile = path.join(tempRoot, 'main.k');
        fs.mkdirSync(includeDir);
        const mainFileContent = `*INCLUDE_PATH\n${includeDir}\n`;
        fs.writeFileSync(mainFile, mainFileContent);

        try {
            const doc = fakeDoc(mainFileContent, mainFile);
            const links = collectIncludeDocumentLinks(doc);

            assert.equal(links.length, 1);
            const targetText = links[0].target.toString();
            assert.ok(targetText.startsWith('command:extension.revealInExplorer?'));
            assert.equal(path.normalize(decodeCommandUriArgs(links[0].target)[0].resourceUri.fsPath), path.normalize(includeDir));
            assert.equal(links[0].range.start.line, 1);
            assert.equal(links[0].range.start.character, 0);
            assert.equal(links[0].range.end.line, 1);
            assert.equal(links[0].range.end.character, includeDir.length);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('creates document links for continued *INCLUDE_PATH directories', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-continued-path-link-'));
        const includeDir = path.join(tempRoot, 'long-' + 'a'.repeat(50), 'includes');
        const mainFile = path.join(tempRoot, 'main.k');
        fs.mkdirSync(includeDir, { recursive: true });

        const part1 = includeDir.slice(0, 78);
        const part2 = includeDir.slice(78);
        const mainFileContent = `*INCLUDE_PATH\n${part1} +\n${part2}\n`;
        fs.writeFileSync(mainFile, mainFileContent);

        try {
            const doc = fakeDoc(mainFileContent, mainFile);
            const links = collectIncludeDocumentLinks(doc);

            assert.equal(links.length, 1);
            const targetText = links[0].target.toString();
            assert.ok(targetText.startsWith('command:extension.revealInExplorer?'));
            assert.equal(path.normalize(decodeCommandUriArgs(links[0].target)[0].resourceUri.fsPath), path.normalize(includeDir));
            assert.equal(links[0].range.start.line, 1);
            assert.equal(links[0].range.end.line, 2);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('resolves include document links through continued *INCLUDE_PATH directories', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-path-links-'));
        const includeDir = path.join(tempRoot, 'shared', 'includes');
        const includeFile = path.join(includeDir, 'continued.k');
        const mainFile = path.join(tempRoot, 'main.k');
        fs.mkdirSync(includeDir, { recursive: true });
        fs.writeFileSync(includeFile, '*KEYWORD\n');

        const part1 = includeDir.slice(0, 78);
        const part2 = includeDir.slice(78);
        const mainFileContent = `*INCLUDE_PATH\n${part1} +\n${part2}\n*INCLUDE\ncontinued.k\n`;
        fs.writeFileSync(mainFile, mainFileContent);

        try {
            const doc = fakeDoc(mainFileContent, mainFile);
            const links = collectIncludeDocumentLinks(doc);
            const includeLink = links.find(link => path.normalize(link.target.fsPath) === path.normalize(includeFile));

            assert.ok(includeLink);
            assert.equal(path.normalize(includeLink.target.fsPath), path.normalize(includeFile));
            assert.equal(includeLink.range.start.line, 4);
            assert.equal(includeLink.range.end.line, 4);
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

    it('skips local keyword index refresh for very large documents', async () => {
        const provider = new LsdynaKeywordIndexProvider({ collectIncludeFiles, shouldSkipAutomaticDocumentScan });
        provider.roots = [{ label: 'stale' }];

        await provider.refreshFromDocument(createHugeDoc());

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

    it('skips keyword option CodeLens for very large documents', () => {
        const provider = new LsdynaKeywordOptionsCodeLensProvider();
        assert.deepEqual(provider.provideCodeLenses(createHugeDoc()), []);
    });

    it('skips hover work for very large documents', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(createHugeDoc(), { line: 0, character: 0 });
        assert.equal(hover, null);
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
    afterEach(() => {
        if (typeof clearReferenceIndexCacheForTesting === 'function') {
            clearReferenceIndexCacheForTesting();
        }
    });

    it('preserves embedded help newlines as markdown hard breaks', async () => {
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        manualIndexer.getManualLocations = () => [];

        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*CONTROL_TERMINATION\n                                                            \n');

            const hover = await provider.provideHover(doc, { line: 1, character: 45 });

            assert.ok(hover);
            const value = hover.contents[0].value;
            assert.ok(value.startsWith('### $(symbol-field) <span style="color:var(--vscode-textLink-foreground);">**ENDMAS**</span> *(real)*'));
            assert.ok(value.includes('DT2MS.  \nLT.0.0:'));
            assert.ok(value.includes('**$(table) Card Columns:**'));
            assert.ok(value.includes('**&nbsp;ENDMAS&nbsp;**'));
        } finally {
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });

    it('appends curve preview and definition link for current-file LCSS references from cached file index', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-hover-curve-'));
        const filePath = path.join(tempRoot, 'main.k');
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0      1001         0       0.0',
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';

        const fileIndex = {
            filePath,
            referenceDefinitions: {
                curves: [{
                    kind: 'curve',
                    id: 1001,
                    keyword: '*DEFINE_CURVE',
                    filePath,
                    startLine: 10,
                    endLine: 13,
                    points: [
                        { x: 0, y: 400, xRaw: '0', yRaw: '400', lineIndex: 12 },
                        { x: 0.1, y: 450, xRaw: '0.1', yRaw: '450', lineIndex: 13 },
                    ],
                }],
                tables: [],
            },
        };

        try {
            setFileIndexForTesting(filePath, fileIndex);
            const provider = new LsdynaFieldHoverProvider();
            const hover = await provider.provideHover(doc, { line: 4, character: 24 });
            const value = hover.contents[0].value;

            assert.ok(value.includes('**LCSS**'));
            assert.ok(value.includes('LCSS reference'));
            assert.ok(value.includes('*DEFINE_CURVE'));
            assert.ok(value.includes('command:extension.openLsdynaReferenceDefinition'));
            assert.ok(value.includes('data:image/svg+xml;base64,'));
            assert.ok(!value.includes('Scan Include Tree'));
        } finally {
            setFileIndexForTesting(filePath, null);
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('suggests scanning the include tree when a reference field has no cached project index', async () => {
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0      1001         0       0.0',
        ].join('\n'), '/project/main.k');
        doc.languageId = 'lsdyna';

        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 4, character: 24 });
        const value = hover.contents[0].value;

        assert.ok(value.includes('LCSS reference'));
        assert.ok(value.includes('Scan Include Tree'));
    });

    it('resolves cross-file references from cached project snapshots', async () => {
        const rootFile = path.resolve('model', 'main.k');
        const childFile = path.resolve('model', 'curves.k');
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0      1001         0       0.0',
        ].join('\n'), rootFile);
        doc.languageId = 'lsdyna';

        cacheReferenceIndexFromSnapshot({
            rootFile,
            files: [rootFile, childFile],
            fileIndexes: new Map([[childFile, {
                referenceDefinitions: {
                    curves: [{
                        kind: 'curve',
                        id: 1001,
                        keyword: '*DEFINE_CURVE',
                        filePath: childFile,
                        startLine: 2,
                        endLine: 4,
                        points: [
                            { x: 0, y: 1, xRaw: '0', yRaw: '1' },
                            { x: 1, y: 2, xRaw: '1', yRaw: '2' },
                        ],
                    }],
                    tables: [],
                },
            }]]),
        });

        const provider = new LsdynaFieldHoverProvider();
        const hover = await provider.provideHover(doc, { line: 4, character: 24 });
        const value = hover.contents[0].value;

        assert.ok(value.includes(childFile));
        assert.ok(value.includes('*DEFINE_CURVE'));
        assert.ok(!value.includes('Scan Include Tree'));
    });

    it('resolves _TITLE suffix title and data lines through keyword schema', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc('*MAT_001_TITLE\nSteel\n$      MID|       RO|\n    100000    2.7E-9\n');

        const titleHover = await provider.provideHover(doc, { line: 1, character: 2 });
        assert.ok(titleHover);
        assert.ok(titleHover.contents[0].value.includes('**TITLE**'));
        assert.ok(titleHover.contents[0].value.includes('Additional title line'));

        // Hovering on comment line (line 2) should return null
        const commentHover = await provider.provideHover(doc, { line: 2, character: 2 });
        assert.strictEqual(commentHover, null);

        // Hovering on data line (line 3) for character 5 (MID field, width 10)
        const dataHover = await provider.provideHover(doc, { line: 3, character: 5 });
        assert.ok(dataHover);
        assert.ok(dataHover.contents[0].value.includes('<span style="color:var(--vscode-badge-foreground);background-color:var(--vscode-badge-background);">**&nbsp;MID&nbsp;**</span>'));
    });

    it('resolves curve preview on LCSS field in MAT_PIECEWISE_LINEAR_PLASTICITY_TITLE', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-hover-title-curve-'));
        const filePath = path.join(tempRoot, 'main.k');
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY_TITLE',
            'Material Title',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0         1         0       0.0',
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';

        const fileIndex = {
            filePath,
            referenceDefinitions: {
                curves: [{
                    kind: 'curve',
                    id: 1,
                    keyword: '*DEFINE_CURVE',
                    filePath,
                    startLine: 10,
                    endLine: 13,
                    points: [
                        { x: 0, y: 400, xRaw: '0', yRaw: '400', lineIndex: 12 },
                        { x: 0.1, y: 450, xRaw: '0.1', yRaw: '450', lineIndex: 13 },
                    ],
                }],
                tables: [],
            },
        };

        try {
            setFileIndexForTesting(filePath, fileIndex);
            const provider = new LsdynaFieldHoverProvider();
            const hover = await provider.provideHover(doc, { line: 5, character: 24 });
            const value = hover.contents[0].value;

            assert.ok(value.includes('**LCSS**'));
            assert.ok(value.includes('LCSS reference'));
            assert.ok(value.includes('*DEFINE_CURVE'));
            assert.ok(value.includes('data:image/svg+xml;base64,'));
        } finally {
            setFileIndexForTesting(filePath, null);
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('prepends curve definition preview when hovering on *DEFINE_CURVE definition keyword line', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-hover-def-curve-'));
        const filePath = path.join(tempRoot, 'main.k');
        const doc = fakeDoc([
            '*DEFINE_CURVE_TITLE',
            'My Curve Title',
            '      1001         0       1.0       1.0       0.0       0.0',
            '       0.0     400.0',
            '       0.1     450.0',
        ].join('\n'), filePath);
        doc.languageId = 'lsdyna';

        const fileIndex = {
            filePath,
            referenceDefinitions: {
                curves: [{
                    kind: 'curve',
                    id: 1001,
                    keyword: '*DEFINE_CURVE_TITLE',
                    filePath,
                    startLine: 0,
                    endLine: 4,
                    title: 'My Curve Title',
                    points: [
                        { x: 0, y: 400, xRaw: '0.0', yRaw: '400.0', lineIndex: 3 },
                        { x: 0.1, y: 450, xRaw: '0.1', yRaw: '450.0', lineIndex: 4 },
                    ],
                }],
                tables: [],
            },
        };

        try {
            setFileIndexForTesting(filePath, fileIndex);
            const provider = new LsdynaFieldHoverProvider();
            // Hover directly on line 0 (the *DEFINE_CURVE_TITLE keyword line)
            const hover = await provider.provideHover(doc, { line: 0, character: 5 });
            assert.ok(hover);
            const value = hover.contents[0].value;

            // Assert it contains both the graph preview and the keyword documentation
            assert.ok(value.includes('### $(graph-line) **\\*DEFINE_CURVE_TITLE (ID: 1001)** - _My Curve Title_'));
            assert.ok(value.includes('data:image/svg+xml;base64,'));
            assert.ok(value.includes('**\\*DEFINE_CURVE')); // Manual/help text
        } finally {
            setFileIndexForTesting(filePath, null);
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('resolves CONTACT optional card fields by data line count', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base card 1',
            'base card 2',
            'base card 3',
            'optional card A',
            'optional card B',
            'optional card C',
            'optional card D',
            'optional card E',
            'optional card F',
            ''
        ].join('\n'));

        const hover = await provider.provideHover(doc, { line: 9, character: 2 });
        assert.ok(hover);
        assert.ok(hover.contents[0].value.includes('**PSTIFF**'));
    });

    it('does not show keyword option command links on keyword hovers with options', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = fakeDoc('*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE\n');

        const hover = await provider.provideHover(doc, { line: 0, character: 3 });

        assert.ok(hover);
        assert.ok(hover.contents[0].value.includes('**\\*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE**'));
        assert.ok(!hover.contents[0].value.includes('command:extension.lsdynaChooseKeywordOptions'));
        assert.ok(!hover.contents[0].value.includes('Choose keyword options'));
    });

    it('returns custom hover actions for existing include files', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-hover-test-'));
        const includeFile = path.join(tempRoot, 'sub.key');
        const mainFile = path.join(tempRoot, 'main.k');

        fs.writeFileSync(includeFile, '*KEYWORD\n');
        fs.writeFileSync(mainFile, '*INCLUDE\nsub.key\n');

        try {
            const doc = fakeDoc(fs.readFileSync(mainFile, 'utf8'), mainFile);
            doc.languageId = 'lsdyna';
            const provider = new LsdynaFieldHoverProvider();

            // Hovering over 'sub.key' on line 1, character 3
            const hover = await provider.provideHover(doc, { line: 1, character: 3 });

            assert.ok(hover);
            assert.strictEqual(hover.contents[0].supportThemeIcons, true);
            assert.ok(hover.contents[0].value.includes('extension.openIncludeNewTab'));
            assert.ok(hover.contents[0].value.includes('extension.openIncludeSplit'));
            assert.ok(hover.contents[0].value.includes('extension.openIncludeFolder'));
            assert.ok(hover.contents[0].value.includes('"' + i18n.get('openNewTab') + '"'));
            assert.ok(hover.contents[0].value.includes('"' + i18n.get('openSplit') + '"'));
            assert.ok(hover.contents[0].value.includes('"' + i18n.get('openFolder') + '"'));
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('falls back to default field hover for non-existent include files', async () => {
        const doc = fakeDoc('*INCLUDE\nmissing_file.key\n', '/project/main.k');
        doc.languageId = 'lsdyna';
        const provider = new LsdynaFieldHoverProvider();

        const hover = await provider.provideHover(doc, { line: 1, character: 3 });
        assert.ok(hover);
        assert.ok(hover.contents[0].value.includes('<span style="color:var(--vscode-badge-foreground);background-color:var(--vscode-badge-background);">**&nbsp;FILENAME&nbsp;**</span>'));
    });

    it('appends manual links to keyword and field hovers when available', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        
        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? 'd:/manuals' : undefined
        });
        manualIndexer.getManualFilesCount = () => 1;
        manualIndexer.getManualLocations = (kw) => {
            if (kw === '*CONTROL_TERMINATION') {
                return [{ file: 'd:/manuals/Vol I.pdf', page: 20 }];
            }
            return [];
        };

        try {
            const provider = new LsdynaFieldHoverProvider();
            
            // Hovering over keyword line *CONTROL_TERMINATION
            const doc = fakeDoc('*CONTROL_TERMINATION\n');
            const kwHover = await provider.provideHover(doc, { line: 0, character: 3 });
            assert.ok(kwHover);
            assert.strictEqual(kwHover.contents[0].supportThemeIcons, true);
            assert.ok(kwHover.contents[0].value.includes('command:extension.openManual'));
            assert.ok(kwHover.contents[0].value.includes('Vol I (' + i18n.get('page', 20) + ')'));
            assert.ok(kwHover.contents[0].value.includes('**\\*CONTROL_TERMINATION**'));

            // Hovering over field line ENDENG under *CONTROL_TERMINATION
            const docField = fakeDoc('*CONTROL_TERMINATION\n                                                            \n');
            const fieldHover = await provider.provideHover(docField, { line: 1, character: 35 });
            assert.ok(fieldHover);
            assert.strictEqual(fieldHover.contents[0].supportThemeIcons, true);
            assert.ok(fieldHover.contents[0].value.includes('command:extension.openManual'));
            assert.ok(fieldHover.contents[0].value.includes('Vol I (' + i18n.get('page', 20) + ')'));
            assert.ok(fieldHover.contents[0].value.includes('**\\*CONTROL_TERMINATION**'));

        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });

    it('displays fallback hover with manual links for keywords missing in field_data.json but present in PDF bookmarks', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualLocations = manualIndexer.getManualLocations;
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        
        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? 'd:/manuals' : undefined
        });
        manualIndexer.getManualFilesCount = () => 1;
        // Mock a keyword that is NOT in field_data.json but is in the manuals
        manualIndexer.getManualLocations = (kw) => {
            if (kw === '*SOME_UNUSUAL_KEYWORD') {
                return [{ file: 'd:/manuals/Vol III.pdf', page: 99 }];
            }
            return [];
        };

        try {
            const provider = new LsdynaFieldHoverProvider();
            
            // Hovering over keyword line *SOME_UNUSUAL_KEYWORD
            const doc = fakeDoc('*SOME_UNUSUAL_KEYWORD\n');
            const hover = await provider.provideHover(doc, { line: 0, character: 3 });
            assert.ok(hover);
            assert.strictEqual(hover.contents[0].supportThemeIcons, true);
            assert.ok(hover.contents[0].value.includes('**\\*SOME_UNUSUAL_KEYWORD**'));
            assert.ok(hover.contents[0].value.includes('command:extension.openManual'));
            assert.ok(hover.contents[0].value.includes('Vol III (' + i18n.get('page', 99) + ')'));
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });

    it('displays configure prompt hover on unrecognized keyword when manualsDir is not configured', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        
        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? '' : undefined
        });
        manualIndexer.getManualFilesCount = () => 0;

        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*UNRECOGNIZED_KEYWORD\n');
            const hover = await provider.provideHover(doc, { line: 0, character: 3 });
            assert.ok(hover);
            assert.ok(hover.contents[0].value.includes(i18n.get('manualDirNotConfigured')));
            assert.ok(hover.contents[0].value.includes('command:extension.configureManualsDir'));
            const expectedGuide = hover.contents[0].value.includes('未设置手册路径')
                ? 'README_zh.md#手册集成设置'
                : 'README.md#manual-integration-setup';
            assert.ok(hover.contents[0].value.includes(expectedGuide), hover.contents[0].value);
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
        }
    });

    it('returns null on unrecognized keyword when manualsDir is configured but no manuals found', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        const originalGetManualLocations = manualIndexer.getManualLocations;
        
        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? 'some/dir' : undefined
        });
        manualIndexer.getManualFilesCount = () => 1;
        manualIndexer.getManualLocations = () => [];

        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*UNRECOGNIZED_KEYWORD\n');
            const hover = await provider.provideHover(doc, { line: 0, character: 3 });
            assert.strictEqual(hover, null);
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });

    it('hides bottom manual section when manualsDir is configured but no manuals found for recognized keyword', async () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;
        const manualIndexer = require('../src/core/manualIndexer');
        const originalGetManualFilesCount = manualIndexer.getManualFilesCount;
        const originalGetManualLocations = manualIndexer.getManualLocations;
        
        workspace.getConfiguration = () => ({
            get: (key) => key === 'manualsDir' ? 'some/dir' : undefined
        });
        manualIndexer.getManualFilesCount = () => 1;
        manualIndexer.getManualLocations = () => [];

        try {
            const provider = new LsdynaFieldHoverProvider();
            const doc = fakeDoc('*CONTROL_TERMINATION\n');
            const hover = await provider.provideHover(doc, { line: 0, character: 3 });
            assert.ok(hover);
            assert.ok(!hover.contents[0].value.includes('command:extension.openManual'));
            assert.ok(!hover.contents[0].value.includes('command:extension.configureManualsDir'));
        } finally {
            workspace.getConfiguration = originalGetConfiguration;
            manualIndexer.getManualFilesCount = originalGetManualFilesCount;
            manualIndexer.getManualLocations = originalGetManualLocations;
        }
    });
});

// ---------------------------------------------------------------------------
// Keyword option interactions
// ---------------------------------------------------------------------------

describe('LS-DYNA keyword option interactions', () => {
    let originalShowQuickPick;
    let originalShowInformationMessage;
    let originalShowWarningMessage;

    beforeEach(() => {
        originalShowQuickPick = vscodeMock.window.showQuickPick;
        originalShowInformationMessage = vscodeMock.window.showInformationMessage;
        originalShowWarningMessage = vscodeMock.window.showWarningMessage;
    });

    afterEach(() => {
        vscodeMock.window.showQuickPick = originalShowQuickPick;
        vscodeMock.window.showInformationMessage = originalShowInformationMessage;
        vscodeMock.window.showWarningMessage = originalShowWarningMessage;
        i18n.updateLanguage();
    });

    it('shows CodeLens entries for keywords with selectable options', () => {
        const provider = new LsdynaKeywordOptionsCodeLensProvider();
        const doc = fakeDoc('*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE\n');

        const lenses = provider.provideCodeLenses(doc);

        assert.equal(lenses.length, 3);
        const optionsLens = lenses.find(lens => lens.command.command === 'extension.lsdynaChooseKeywordOptions');
        assert.ok(optionsLens);
        assert.ok(optionsLens.command.title.includes('Options'));
        assert.ok(optionsLens.command.title.includes('ID, MPP, A-G'));
        assert.ok(lenses.some(lens => lens.command.command === 'extension.selectKeyword'));
        assert.ok(lenses.some(lens => lens.command.command === 'extension.lsdynaFormatSelection'));
    });

    it('shows an information message when the current keyword has no options', async () => {
        const editor = makeEditableEditor(['*NODE'], 0);
        let message = '';
        vscodeMock.window.showInformationMessage = (value) => {
            message = value;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.ok(message.includes('No LS-DYNA keyword options'));
    });

    it('adds TITLE to MAT_001 and inserts a managed title comment with skeleton line', async () => {
        const editor = makeEditableEditor(['*MAT_001', '        1'], 0);
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) {
                return items.filter(item => item.label === 'TITLE');
            }
            return undefined;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.deepEqual(editor.lines, [
            '*MAT_001_TITLE',
            '$# title                                                                        ',
            '',
            '        1'
        ]);
    });

    it('removes a strict managed TITLE comment with its empty skeleton line', async () => {
        const editor = makeEditableEditor([
            '*MAT_001_TITLE',
            '$# title                                                                        ',
            '',
            '        1'
        ], 0);
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return undefined;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.deepEqual(editor.lines, ['*MAT_001', '        1']);
    });

    it('removes orphan strict option comments that are not selected', async () => {
        const editor = makeEditableEditor([
            '*MAT_024',
            '$# title                                                                        ',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '                                                                 1e+21          '
        ], 0);
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return undefined;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.deepEqual(editor.lines, [
            '*MAT_024',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '                                                                 1e+21          '
        ]);
    });

    it('removes orphan strict option comments with adjacent empty skeleton lines', async () => {
        const editor = makeEditableEditor([
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE',
            '$#  ignore      bckt    lcbckt    ns2trk   inititr    parmax    unused    cparm8',
            '$#     cidheading                                                               ',
            '',
            '$#    ssid      msid     sstyp     mstyp    sboxid    mboxid       spr       mpr',
            ''
        ], 0);
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return items.find(item => item.label === 'None');
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.deepEqual(editor.lines, [
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE',
            '$#    ssid      msid     sstyp     mstyp    sboxid    mboxid       spr       mpr',
            ''
        ]);
    });

    it('does not remove a non-empty TITLE line without confirmation', async () => {
        const editor = makeEditableEditor(['*MAT_001_TITLE', 'Steel', '        1'], 0);
        let warning = '';
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return undefined;
        };
        vscodeMock.window.showWarningMessage = async (value) => {
            warning = value;
            return undefined;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.ok(warning.includes('non-empty'));
        assert.deepEqual(editor.lines, ['*MAT_001_TITLE', 'Steel', '        1']);
    });

    it('adds CONTACT optional cards A-F from the range picker', async () => {
        const editor = makeEditableEditor([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base 1',
            'base 2',
            'base 3',
        ], 0);
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return items.find(item => item.label === 'A-F');
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.equal(editor.lines.length, 16);
        assert.equal(editor.lines[0], '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE');
        assert.equal(editor.lines[4], '$#    soft    sofscl    lcidab    maxpar     sbopt     depth     bsort    frcfrq');
        assert.equal(editor.lines[14], '$#  pstiff   ignroff               fstol    2dbinr    ssftyp     swtpr    tetfac');
        assert.equal(editor.lines[15].trim(), '');
    });

    it('removes strict CONTACT optional card comments when shrinking options', async () => {
        const editor = makeEditableEditor([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base 1',
            'base 2',
            'base 3',
            '$#    soft    sofscl    lcidab    maxpar     sbopt     depth     bsort    frcfrq',
            '',
            '$#  penmax    thkopt    shlthk     snlog      isym     i2d3d    sldthk    sldstf',
            '',
            '$#    igap    ignore    dprfac    dtstif     edgek              flangl   cid_rcf',
            '',
            '$#   q2tri    dtpchk     sfnbr    fnlscl    dnlscl      tcso    tiedid    shledg',
            '',
            '$#  sharec    cparm8    ipback     srnde    fricsf      icor     ftorq    region',
            '',
            '$#  pstiff   ignroff               fstol    2dbinr    ssftyp     swtpr    tetfac',
            ''
        ], 0);
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return items.find(item => item.label === 'A-C');
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.deepEqual(editor.lines, [
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base 1',
            'base 2',
            'base 3',
            '$#    soft    sofscl    lcidab    maxpar     sbopt     depth     bsort    frcfrq',
            '',
            '$#  penmax    thkopt    shlthk     snlog      isym     i2d3d    sldthk    sldstf',
            '',
            '$#    igap    ignore    dprfac    dtstif     edgek              flangl   cid_rcf',
            ''
        ]);
    });

    it('does not shrink CONTACT F to C when removed option cards contain user data', async () => {
        const editor = makeEditableEditor([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base 1',
            'base 2',
            'base 3',
            '',
            '',
            '',
            'user data in optional D',
            '',
            '',
        ], 0);
        let warning = '';
        vscodeMock.window.showQuickPick = async (items, options) => {
            if (options && options.canPickMany) return [];
            return items.find(item => item.label === 'A-C');
        };
        vscodeMock.window.showWarningMessage = async (value) => {
            warning = value;
            return undefined;
        };

        await chooseKeywordOptionsForEditor(editor);

        assert.ok(warning.includes('non-empty'));
        assert.equal(editor.lines.length, 10);
        assert.equal(editor.lines[7], 'user data in optional D');
    });

    it('localizes keyword option CodeLens and picker messages', async () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key) => key === 'language' ? 'zh-cn' : undefined
        });
        i18n.updateLanguage();

        try {
            const provider = new LsdynaKeywordOptionsCodeLensProvider();
            const lenses = provider.provideCodeLenses(fakeDoc('*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE\n'));
            const optionsLens = lenses.find(lens => lens.command.command === 'extension.lsdynaChooseKeywordOptions');
            assert.ok(optionsLens.command.title.includes('选项'));

            const editor = makeEditableEditor(['*NODE'], 0);
            let message = '';
            vscodeMock.window.showInformationMessage = (value) => {
                message = value;
            };
            await chooseKeywordOptionsForEditor(editor);

            assert.ok(message.includes('没有可用的 LS-DYNA 关键字选项'));
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });

    it('supports auto language mode by following VS Code language', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        const originalEnv = vscodeMock.env;
        vscodeMock.env = { ...(vscodeMock.env || {}), language: 'en' };
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key) => key === 'language' ? 'auto' : undefined
        });

        try {
            i18n.updateLanguage();
            assert.equal(i18n.getLanguage(), 'en');

            vscodeMock.env.language = 'zh-cn';
            i18n.updateLanguage();
            assert.equal(i18n.getLanguage(), 'zh-cn');
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            vscodeMock.env = originalEnv;
            i18n.updateLanguage();
        }
    });

    it('declares auto as the default extension language option', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        const languageConfig = pkg.contributes.configuration.properties['lsdyna.language'];

        assert.equal(languageConfig.default, 'auto');
        assert.deepEqual(languageConfig.enum, ['auto', 'zh-cn', 'en']);
    });

    it('keeps runtime i18n keys complete for both supported languages', () => {
        function collectSourceFiles(dir, result = []) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const entryPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    collectSourceFiles(entryPath, result);
                } else if (entry.name.endsWith('.ts')) {
                    result.push(entryPath);
                }
            }
            return result;
        }

        function collectUsedI18nKeys(srcDir) {
            const keys = new Set();
            for (const filePath of collectSourceFiles(srcDir)) {
                const source = fs.readFileSync(filePath, 'utf8');
                for (const match of source.matchAll(/i18n\.get\('([^']+)'/g)) {
                    keys.add(match[1]);
                }
            }
            return keys;
        }

        function collectLocaleKeys(source, locale, nextLocale) {
            const blockPattern = new RegExp(`'${locale}':\\s*{([\\s\\S]*?)\\n\\s*}${nextLocale ? `,\\s*\\n\\s*'${nextLocale}':` : '\\s*\\n};'}`);
            const match = source.match(blockPattern);
            assert.ok(match, `${locale} locale block should exist`);
            return new Set([...match[1].matchAll(/\n\s*([A-Za-z0-9_]+):/g)].map(item => item[1]));
        }

        const repoRoot = path.join(__dirname, '..');
        const i18nSource = fs.readFileSync(path.join(repoRoot, 'src', 'core', 'i18n.ts'), 'utf8');
        const usedKeys = collectUsedI18nKeys(path.join(repoRoot, 'src'));
        const zhKeys = collectLocaleKeys(i18nSource, 'zh-cn', 'en');
        const enKeys = collectLocaleKeys(i18nSource, 'en');

        for (const key of usedKeys) {
            assert.ok(zhKeys.has(key), `${key} should exist in zh-cn runtime locale`);
            assert.ok(enKeys.has(key), `${key} should exist in en runtime locale`);
        }
    });

    it('localizes line length diagnostics in Chinese', () => {
        const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        vscodeMock.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'language' ? 'zh-cn' : defaultValue
        });
        i18n.updateLanguage();

        try {
            const doc = fakeDoc('*NODE\n' + '1'.repeat(81) + '\n', '/project/main.k');
            doc.languageId = 'lsdyna';
            const diagnostics = collectLineLengthDiagnostics(doc);

            assert.equal(diagnostics.length, 1);
            assert.equal(diagnostics[0].message, i18n.get('lineExceeds80Characters', 81));
        } finally {
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });
});

// ---------------------------------------------------------------------------
// isLsdynaUri
// ---------------------------------------------------------------------------

describe('isLsdynaUri', () => {
    it('checks standard and custom file extensions correctly', () => {
        const workspace = require('./vscode-mock').workspace;
        const originalGetConfiguration = workspace.getConfiguration;

        // 1. Mock default extensions
        workspace.getConfiguration = () => ({
            get: (key) => key === 'additionalExtensions' ? ['.k', '.key', '.dyna', '.asc'] : undefined
        });

        assert.strictEqual(isLsdynaUri({ fsPath: 'model.k' }), true);
        assert.strictEqual(isLsdynaUri({ fsPath: 'model.key' }), true);
        assert.strictEqual(isLsdynaUri({ fsPath: 'model.dyna' }), true);
        assert.strictEqual(isLsdynaUri({ fsPath: 'model.asc' }), true);
        assert.strictEqual(isLsdynaUri({ fsPath: 'model.txt' }), false);

        // 2. Mock custom extensions (some without leading dots)
        workspace.getConfiguration = () => ({
            get: (key) => key === 'additionalExtensions' ? ['dat', '.incl'] : undefined
        });

        assert.strictEqual(isLsdynaUri({ fsPath: 'model.dat' }), true);
        assert.strictEqual(isLsdynaUri({ fsPath: 'model.incl' }), true);
        assert.strictEqual(isLsdynaUri({ fsPath: 'model.k' }), false);

        workspace.getConfiguration = originalGetConfiguration;
    });
});

// ---------------------------------------------------------------------------
// readFileSnippet
// ---------------------------------------------------------------------------

describe('readFileSnippet', () => {
    it('reads a specific range of lines from a file efficiently', async () => {
        const tempFile = path.join(os.tmpdir(), `lsdyna-snippet-test-${Date.now()}.k`);
        fs.writeFileSync(tempFile, 'line0\nline1\nline2\nline3\nline4\nline5\n', 'utf8');
        try {
            const { readFileSnippet } = require('../src/client/providers/keywordIndexProvider');
            const snippet = await readFileSnippet(tempFile, 2, 3);
            assert.strictEqual(snippet, 'line2\nline3\nline4');
        } finally {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        }
    });
});

// ---------------------------------------------------------------------------
// formatBytes & formatShortBytes
// ---------------------------------------------------------------------------

describe('formatBytes', () => {
    it('converts byte counts to readable file size strings with appropriate units', () => {
        const { formatBytes, formatShortBytes, formatVividBytes, applyVividDescription } = require('../src/client/providers/includeTreeProvider');
        assert.strictEqual(formatBytes(0), '0 B');
        assert.strictEqual(formatBytes(512), '512.0 B');
        assert.strictEqual(formatBytes(1024), '1.0 KB');
        assert.strictEqual(formatBytes(1536), '1.5 KB');
        assert.strictEqual(formatBytes(1024 * 1024), '1.0 MB');
        assert.strictEqual(formatBytes(1024 * 1024 * 1024 * 2.5), '2.5 GB');

        assert.strictEqual(formatShortBytes(0), '0');
        assert.strictEqual(formatShortBytes(512), '1k');
        assert.strictEqual(formatShortBytes(1024), '1k');
        assert.strictEqual(formatShortBytes(1536), '2k');
        assert.strictEqual(formatShortBytes(1024 * 45), 'K');
        assert.strictEqual(formatShortBytes(1024 * 1024 * 1.2), '1M');
        assert.strictEqual(formatShortBytes(1024 * 1024 * 1024 * 125), 'G');

        // Test formatVividBytes
        assert.strictEqual(formatVividBytes(0), '▏ 0 B');
        assert.strictEqual(formatVividBytes(512), '▏ 512.0 B');
        assert.strictEqual(formatVividBytes(1024 * 5), '▏ 5.0 KB');
        assert.strictEqual(formatVividBytes(1024 * 45), '▌ 45.0 KB');
        assert.strictEqual(formatVividBytes(1024 * 1024 * 1.2), '█ 1.2 MB');

        // Test applyVividDescription
        const mockItem1 = { contextValue: 'file', description: '', fileSizeVal: 1024 * 5 };
        applyVividDescription(mockItem1, 'sub');
        assert.strictEqual(mockItem1.description, '▏ 5.0 KB');
        assert.strictEqual(mockItem1.relDir, 'sub');

        const mockItem2 = { contextValue: 'file-missing', description: 'not found' };
        applyVividDescription(mockItem2, 'sub');
        assert.strictEqual(mockItem2.description, 'not found');
        assert.strictEqual(mockItem2.relDir, 'sub');
    });
});

// ---------------------------------------------------------------------------
// LsdynaFileDecorationProvider
// ---------------------------------------------------------------------------

describe('LsdynaFileDecorationProvider', () => {
    it('provides file decorations with size badge and status colors', () => {
        const { LsdynaFileDecorationProvider, normalizePathKey } = extensionModule._internals;
        const includeTreeProvider = {
            resolvedPaths: new Map([
                [normalizePathKey('some/file.k'), '']
            ]),
            missingPaths: new Set([
                normalizePathKey('some/missing.k')
            ])
        };
        const provider = new LsdynaFileDecorationProvider(includeTreeProvider);

        // Test resolved
        const resolvedUri = { scheme: 'file', fsPath: 'some/file.k' };
        const resolvedDec = provider.provideFileDecoration(resolvedUri);
        assert.ok(resolvedDec);
        assert.strictEqual(resolvedDec.badge, undefined);
        assert.strictEqual(resolvedDec.color.constructor.name, 'ThemeColor');

        // Test missing
        const missingUri = { scheme: 'file', fsPath: 'some/missing.k' };
        const missingDec = provider.provideFileDecoration(missingUri);
        assert.ok(missingDec);
        assert.strictEqual(missingDec.badge, '⚠');

        // Test untracked
        const untrackedUri = { scheme: 'file', fsPath: 'some/other.k' };
        const untrackedDec = provider.provideFileDecoration(untrackedUri);
        assert.strictEqual(untrackedDec, undefined);
    });
});

// ---------------------------------------------------------------------------
// LsdynaIncludeCompletionProvider
// ---------------------------------------------------------------------------

describe('LsdynaIncludeCompletionProvider', () => {
    it('provides completion items for includes inside valid paths', () => {
        const { LsdynaIncludeCompletionProvider } = extensionModule._internals;
        const provider = new LsdynaIncludeCompletionProvider();

        // Create a temporary workspace layout
        const tempDir = path.join(os.tmpdir(), `lsdyna-completion-test-${Date.now()}`);
        fs.mkdirSync(tempDir);
        
        const subDir = path.join(tempDir, 'submodels');
        fs.mkdirSync(subDir);

        const invalidDir = path.join(os.tmpdir(), 'non_existent_folder_xyz_12345');
        
        fs.writeFileSync(path.join(tempDir, 'file1.k'), '');
        fs.writeFileSync(path.join(subDir, 'file2.k'), '');

        // Main file has valid relative path and invalid absolute path from another machine
        const mainFileContent = `*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE_PATH\n${invalidDir}\n*INCLUDE\n`;
        const mainFile = path.join(tempDir, 'main.k');
        fs.writeFileSync(mainFile, mainFileContent);

        const doc = fakeDoc(mainFileContent, mainFile);

        try {
            // Position is at line 5 (directly under *INCLUDE)
            const position = { line: 5, character: 0 };
            const list = provider.provideCompletionItems(doc, position);

            assert.ok(list);
            assert.strictEqual(list.isIncomplete, true);
            const items = list.items;
            const labels = items.map(item => item.label);
            
            // Should contain files from submodels (since submodels is valid)
            assert.ok(labels.includes('file2.k'));
            
            // Should not show anything from the invalidDir since it is validated to not exist
            assert.ok(!labels.includes('non_existent_xyz'));

            // Check that items have a range property
            for (const item of items) {
                assert.ok(item.range);
                assert.strictEqual(item.range.start.line, 5);
                assert.strictEqual(item.range.start.character, 0);
                assert.strictEqual(item.range.end.character, 0);
            }

            // Test case for range with prefix: '  sub1/ma'
            // The text starts at index 2. Cursor is at index 9.
            const prefixContent = `*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\n  sub1/ma`;
            const prefixDoc = fakeDoc(prefixContent, mainFile);
            const prefixList = provider.provideCompletionItems(prefixDoc, { line: 3, character: 9 });
            assert.ok(prefixList);
            for (const item of prefixList.items) {
                assert.strictEqual(item.range.start.line, 3);
                assert.strictEqual(item.range.start.character, 2);
                assert.strictEqual(item.range.end.character, 9);
            }

            // Test position on keyword line (line 4) -> should be empty
            const listOnKeywordLine = provider.provideCompletionItems(doc, { line: 4, character: 0 });
            assert.strictEqual(listOnKeywordLine.length || listOnKeywordLine.items?.length || 0, 0);

            // Test position on path line (line 1) -> should be empty
            const listOnPathLine = provider.provideCompletionItems(doc, { line: 1, character: 0 });
            assert.strictEqual(listOnPathLine.length || listOnPathLine.items?.length || 0, 0);

            // Test comment line
            const commentFileContent = `*INCLUDE\n$ this is a comment\n`;
            const docWithComment = fakeDoc(commentFileContent, mainFile);
            const listOnComment = provider.provideCompletionItems(docWithComment, { line: 1, character: 0 });
            assert.strictEqual(listOnComment.length || listOnComment.items?.length || 0, 0);

            // Test case: triggers autocomplete with '/' for same-directory file 'file1.k'
            const slashDoc = fakeDoc(`*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\n/`, mainFile);
            const slashList = provider.provideCompletionItems(slashDoc, { line: 3, character: 1 });
            assert.ok(slashList);
            const file1ItemSlash = slashList.items.find(item => item.label === 'file1.k');
            assert.ok(file1ItemSlash, 'should suggest file1.k when typing /');
            assert.strictEqual(file1ItemSlash.filterText, '/file1.k');

            // Test case: triggers autocomplete with '\' for same-directory file 'file1.k'
            const backslashDoc = fakeDoc(`*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\n\\`, mainFile);
            const backslashList = provider.provideCompletionItems(backslashDoc, { line: 3, character: 1 });
            assert.ok(backslashList);
            const file1ItemBackslash = backslashList.items.find(item => item.label === 'file1.k');
            assert.ok(file1ItemBackslash, 'should suggest file1.k when typing \\');
            assert.strictEqual(file1ItemBackslash.filterText, '\\file1.k');

            // Test case: triggers autocomplete with './' for same-directory file 'file1.k'
            const dotSlashDoc = fakeDoc(`*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\n./`, mainFile);
            const dotSlashList = provider.provideCompletionItems(dotSlashDoc, { line: 3, character: 2 });
            assert.ok(dotSlashList);
            const file1ItemDotSlash = dotSlashList.items.find(item => item.label === 'file1.k');
            assert.ok(file1ItemDotSlash, 'should suggest file1.k when typing ./');
            assert.strictEqual(file1ItemDotSlash.filterText, './file1.k');

        } finally {
            // Cleanup
            try { fs.unlinkSync(path.join(tempDir, 'file1.k')); } catch (e) {}
            try { fs.unlinkSync(path.join(subDir, 'file2.k')); } catch (e) {}
            try { fs.rmdirSync(subDir); } catch (e) {}
            try { fs.unlinkSync(mainFile); } catch (e) {}
            try { fs.rmdirSync(tempDir); } catch (e) {}
        }
    });

    it('provides completion items from continued *INCLUDE_PATH directories', () => {
        const { LsdynaIncludeCompletionProvider } = extensionModule._internals;
        const provider = new LsdynaIncludeCompletionProvider();

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-completion-continued-'));
        const includeDir = path.join(tempDir, 'shared', 'includes');
        const mainFile = path.join(tempDir, 'main.k');
        fs.mkdirSync(includeDir, { recursive: true });
        fs.writeFileSync(path.join(includeDir, 'continued.k'), '');

        const part1 = includeDir.slice(0, 78);
        const part2 = includeDir.slice(78);
        const mainFileContent = `*INCLUDE_PATH\n${part1} +\n${part2}\n*INCLUDE\n`;
        fs.writeFileSync(mainFile, mainFileContent);
        const doc = fakeDoc(mainFileContent, mainFile);

        try {
            const list = provider.provideCompletionItems(doc, { line: 4, character: 0 });
            assert.ok(list);
            const labels = list.items.map(item => item.label);
            assert.ok(labels.includes('continued.k'));
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});

describe('file reveal commands', () => {
    it('send hostile paths only through the VS Code reveal API', () => {
        const originalPlatform = process.platform;
        const originalRegisterCommand = vscodeMock.commands.registerCommand;
        const originalExecuteCommand = vscodeMock.commands.executeCommand;
        const originalExec = require('child_process').exec;
        const commands = new Map();
        const executions = [];
        let execCount = 0;
        vscodeMock.commands.registerCommand = (id, callback) => {
            commands.set(id, callback);
            return { dispose() {} };
        };
        vscodeMock.commands.executeCommand = (id, ...args) => {
            executions.push([id, ...args]);
            return Promise.resolve();
        };
        require('child_process').exec = () => { execCount++; };
        Object.defineProperty(process, 'platform', { value: 'win32' });

        try {
            extensionModule.activate({ subscriptions: [], asAbsolutePath: value => value });
            const filePath = 'C:\\模型 (2026) & data\\part.key';
            commands.get('extension.openIncludeFolder')(filePath);
            commands.get('extension.revealInExplorer')({ filePath });

            const revealCalls = executions.filter(([id]) => id === 'revealFileInOS');
            assert.deepStrictEqual(revealCalls.map(call => call[1].fsPath), [filePath, filePath]);
            assert.equal(execCount, 0);
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform });
            vscodeMock.commands.registerCommand = originalRegisterCommand;
            vscodeMock.commands.executeCommand = originalExecuteCommand;
            require('child_process').exec = originalExec;
        }
    });
});

describe('extension.openManual command', () => {
    let originalPlatform;
    let originalExec;
    let originalSpawn;
    let originalExistsSync;
    let originalOpenExternal;
    let originalGetConfiguration;
    let originalRegisterCommand;
    let originalPathEnv;
    let originalLocalAppdataEnv;
    let originalAppdataEnv;

    let execCalls = [];
    let spawnCalls = [];
    let openExternalCalls = [];
    let registeredCommands = new Map();
    let mockExistsMap = {};
    let mockRegistryData = {};
    let mockConfig = {};
    let mockSpawnError = false;

    before(() => {
        originalPlatform = process.platform;
        originalExec = require('child_process').exec;
        originalSpawn = require('child_process').spawn;
        originalExistsSync = require('fs').existsSync;
        originalOpenExternal = vscodeMock.env ? vscodeMock.env.openExternal : undefined;
        originalGetConfiguration = vscodeMock.workspace.getConfiguration;
        originalRegisterCommand = vscodeMock.commands.registerCommand;
        originalPathEnv = process.env.PATH;
        originalLocalAppdataEnv = process.env.LOCALAPPDATA;
        originalAppdataEnv = process.env.APPDATA;

        vscodeMock.commands.registerCommand = (id, callback) => {
            registeredCommands.set(id, callback);
            return { dispose() {} };
        };

        if (!vscodeMock.env) {
            vscodeMock.env = {};
        }
        vscodeMock.env.openExternal = (uri) => {
            openExternalCalls.push(uri);
            return Promise.resolve(true);
        };
    });

    after(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        require('child_process').exec = originalExec;
        require('child_process').spawn = originalSpawn;
        require('fs').existsSync = originalExistsSync;
        if (originalOpenExternal) {
            vscodeMock.env.openExternal = originalOpenExternal;
        } else {
            delete vscodeMock.env.openExternal;
        }
        vscodeMock.workspace.getConfiguration = originalGetConfiguration;
        vscodeMock.commands.registerCommand = originalRegisterCommand;
        process.env.PATH = originalPathEnv;
        process.env.LOCALAPPDATA = originalLocalAppdataEnv;
        process.env.APPDATA = originalAppdataEnv;
    });

    beforeEach(() => {
        execCalls = [];
        spawnCalls = [];
        openExternalCalls = [];
        registeredCommands.clear();
        mockExistsMap = {};
        mockRegistryData = {};
        mockConfig = {};
        mockSpawnError = false;
        process.env.PATH = originalPathEnv;
        process.env.LOCALAPPDATA = originalLocalAppdataEnv;
        process.env.APPDATA = originalAppdataEnv;

        require('fs').existsSync = (p) => {
            if (p in mockExistsMap) {
                return mockExistsMap[p];
            }
            if (typeof p === 'string' && p.toLowerCase().includes('sumatrapdf.exe')) {
                return false;
            }
            return originalExistsSync(p);
        };

        require('child_process').exec = (cmd, options, cb) => {
            if (typeof options === 'function') {
                cb = options;
                options = undefined;
            }
            execCalls.push(cmd);
            if (cmd in mockRegistryData) {
                const res = mockRegistryData[cmd];
                if (res.error) {
                    cb(new Error(res.error));
                } else {
                    cb(null, res.stdout || '');
                }
            } else {
                cb(null, '');
            }
        };

        require('child_process').spawn = (exe, args, options) => {
            spawnCalls.push({ exe, args, options });
            const mockChild = {
                on: (event, cb) => {
                    if (event === 'error' && mockSpawnError) {
                        cb(new Error('Spawn error'));
                    }
                },
                unref: () => {}
            };
            return mockChild;
        };

        vscodeMock.workspace.getConfiguration = (section) => {
            return {
                get: (key) => {
                    if (section === 'lsdyna' && key === 'manualsDir') {
                        return mockConfig.manualsDir;
                    }
                    return undefined;
                }
            };
        };

        vscodeMock.workspace.workspaceFolders = undefined;

        // Activate extension to trigger registrations
        const context = {
            subscriptions: [],
            asAbsolutePath: (relPath) => `C:\\mock-extension-path\\${relPath}`
        };
        extensionModule.activate(context);
    });

    it('uses absolute manualsDir path to resolve SumatraPDF.exe when present', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'C:\\custom\\manuals';
        mockExistsMap['C:\\custom\\manuals\\SumatraPDF.exe'] = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path\\to\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.deepStrictEqual(spawnCalls, [{
            exe: 'C:\\custom\\manuals\\SumatraPDF.exe',
            args: ['-reuse-instance', '-page', '12', pdfPath],
            options: { shell: false, detached: true, stdio: 'ignore', windowsHide: false },
        }]);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 0);
    });

    it('uses relative manualsDir path resolved against workspaceFolders when present', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'relative/manuals';
        vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: 'C:\\workspace' } }];
        mockExistsMap['C:\\workspace\\relative\\manuals\\SumatraPDF.exe'] = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path\\to\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].exe, 'C:\\workspace\\relative\\manuals\\SumatraPDF.exe');
        assert.deepStrictEqual(spawnCalls[0].args, ['-reuse-instance', '-page', '12', pdfPath]);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 0);
    });

    it('uses relative manualsDir path resolved against process.cwd() when workspaceFolders is not present', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'relative/manuals';
        vscodeMock.workspace.workspaceFolders = undefined;
        const resolvedPath = path.resolve(process.cwd(), 'relative/manuals', 'SumatraPDF.exe');
        mockExistsMap[resolvedPath] = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path\\to\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].exe, resolvedPath);
        assert.deepStrictEqual(spawnCalls[0].args, ['-reuse-instance', '-page', '12', pdfPath]);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 0);
    });

    it('returns null and falls back to fallback command when manualsDir is not configured', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = undefined;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path\\to\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 0);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 1);
    });

    it('returns null and falls back when SumatraPDF.exe does not exist in manualsDir', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'C:\\custom\\manuals';
        mockExistsMap['C:\\custom\\manuals\\SumatraPDF.exe'] = false;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path\\to\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 0);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 1);
    });

    it('falls back to the system PDF handler when Sumatra launch fails', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'C:\\custom\\manuals';
        mockExistsMap['C:\\custom\\manuals\\SumatraPDF.exe'] = true;

        mockSpawnError = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path\\to\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 1);
    });

    it('passes shell metacharacters in PDF paths as opaque arguments', async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockConfig.manualsDir = 'C:\\custom\\manuals';
        mockExistsMap['C:\\custom\\manuals\\SumatraPDF.exe'] = true;

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = 'C:\\path & 100%!\\manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].args.at(-1), pdfPath);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 0);
    });

    it('directly uses vscode.env.openExternal on non-Windows platforms', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });

        const openManual = registeredCommands.get('extension.openManual');
        assert.ok(openManual);

        const pdfPath = '/path/to/manual.pdf';
        await openManual(pdfPath, 12);

        assert.strictEqual(spawnCalls.length, 0);
        assert.strictEqual(execCalls.length, 0);
        assert.strictEqual(openExternalCalls.length, 1);
        assert.strictEqual(openExternalCalls[0].fsPath, '/path/to/manual.pdf');
    });
});
