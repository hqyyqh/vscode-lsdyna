'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const {
    cleanKeyword,
    parsePdf,
    parsePdfContent,
    initialize,
    getManualLocations,
    getManualFilesCount
} = require('../../src/core/manualIndexer');

describe('manualIndexer', () => {
    let tempDir;
    let mockPdfPath;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-manual-indexer-test-'));
        mockPdfPath = path.join(tempDir, 'mock_manual.pdf');

        // Create a minimal mock PDF with outline and pages tree
        const mockPdfContent = `%PDF-1.5
1 0 obj
<<
  /Type /Catalog
  /Pages 2 0 R
  /Outlines 3 0 R
>>
endobj
2 0 obj
<<
  /Type /Pages
  /Kids [ 4 0 R 5 0 R ]
  /Count 2
>>
endobj
3 0 obj
<<
  /Type /Outlines
  /First 6 0 R
  /Last 6 0 R
>>
endobj
4 0 obj
<<
  /Type /Page
  /Parent 2 0 R
>>
endobj
5 0 obj
<<
  /Type /Page
  /Parent 2 0 R
>>
endobj
6 0 obj
<<
  /Title (*NODE_TITLE)
  /Dest [ 4 0 R /XYZ ]
  /Next 7 0 R
>>
endobj
7 0 obj
<<
  /Title <FEFF002A0045004F0053005F003000300031>
  /Dest [ 5 0 R /XYZ ]
>>
endobj
trailer
<<
  /Root 1 0 R
>>
%%EOF`;

        fs.writeFileSync(mockPdfPath, mockPdfContent, 'binary');
    });

    after(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
    });

    describe('cleanKeyword', () => {
        it('trims whitespace and converts to uppercase', () => {
            assert.strictEqual(cleanKeyword('  *node  '), '*NODE');
        });

        it('removes title suffixes (case-insensitive)', () => {
            assert.strictEqual(cleanKeyword('*NODE_TITLE'), '*NODE');
            assert.strictEqual(cleanKeyword('*node_title'), '*NODE');
            assert.strictEqual(cleanKeyword('  *control_termination_title  '), '*CONTROL_TERMINATION');
            assert.strictEqual(cleanKeyword('*PART_ID'), '*PART');
            assert.strictEqual(cleanKeyword('*SECTION_SOLID_HEADING'), '*SECTION_SOLID');
            assert.strictEqual(cleanKeyword('*MAT_ELASTIC_ID_TITLE'), '*MAT_ELASTIC');
            assert.strictEqual(cleanKeyword('*NODE_BLANK'), '*NODE');
        });

        it('does not remove title suffixes if it is not a suffix', () => {
            assert.strictEqual(cleanKeyword('*TITLE_SUFFIX'), '*TITLE_SUFFIX');
        });
    });

    describe('parsePdf & parsePdfContent', () => {
        it('returns empty array if PDF does not exist', () => {
            const result = parsePdf(path.join(tempDir, 'non_existent.pdf'));
            assert.deepEqual(result, []);
        });

        it('successfully parses bookmarks and pages mapping from mock PDF', () => {
            const bookmarks = parsePdf(mockPdfPath);
            assert.deepEqual(bookmarks, [
                { title: '*NODE_TITLE', page: 1 },
                { title: '*EOS_001', page: 2 }
            ]);
        });

        it('does not cause infinite loop on cyclic Page tree', () => {
            const cyclicPdf = `%PDF-1.5
1 0 obj
<<
  /Type /Catalog
  /Pages 2 0 R
>>
endobj
2 0 obj
<<
  /Type /Pages
  /Kids [ 2 0 R ]
  /Count 1
>>
endobj
trailer
<< /Root 1 0 R >>
%%EOF`;
            const bookmarks = parsePdfContent(cyclicPdf);
            assert.deepEqual(bookmarks, []);
        });

        it('does not cause infinite loop on cyclic Outlines tree', () => {
            const cyclicPdf = `%PDF-1.5
1 0 obj
<<
  /Type /Catalog
  /Pages 2 0 R
  /Outlines 3 0 R
>>
endobj
2 0 obj
<<
  /Type /Pages
  /Kids [ 4 0 R ]
  /Count 1
>>
endobj
3 0 obj
<<
  /Type /Outlines
  /First 5 0 R
>>
endobj
4 0 obj
<<
  /Type /Page
>>
endobj
5 0 obj
<<
  /Title (Loop)
  /Dest [ 4 0 R /XYZ ]
  /Next 5 0 R
>>
endobj
trailer
<< /Root 1 0 R >>
%%EOF`;
            const bookmarks = parsePdfContent(cyclicPdf);
            assert.deepEqual(bookmarks, [
                { title: 'Loop', page: 1 }
            ]);
        });

        it('handles nested Pages trees and does not confuse Pages with Page', () => {
            const nestedPdf = `%PDF-1.5
1 0 obj
<<
  /Type /Catalog
  /Pages 2 0 R
  /Outlines 3 0 R
>>
endobj
2 0 obj
<<
  /Type /Pages
  /Kids [ 8 0 R ]
  /Count 2
>>
endobj
8 0 obj
<<
  /Type /Pages
  /Kids [ 4 0 R 5 0 R ]
  /Count 2
>>
endobj
3 0 obj
<<
  /Type /Outlines
  /First 6 0 R
>>
endobj
4 0 obj
<<
  /Type /Page
>>
endobj
5 0 obj
<<
  /Type /Page
>>
endobj
6 0 obj
<<
  /Title (Page Two)
  /Dest [ 5 0 R /XYZ ]
>>
endobj
trailer
<< /Root 1 0 R >>
%%EOF`;
            const bookmarks = parsePdfContent(nestedPdf);
            assert.deepEqual(bookmarks, [
                { title: 'Page Two', page: 2 }
            ]);
        });

        it('does not get confused by /TitleBar or other substrings containing /Title', () => {
            const titleConfPdf = `%PDF-1.5
1 0 obj
<<
  /Type /Catalog
  /Pages 2 0 R
  /Outlines 3 0 R
>>
endobj
2 0 obj
<<
  /Type /Pages
  /Kids [ 4 0 R ]
  /Count 1
>>
endobj
3 0 obj
<<
  /Type /Outlines
  /First 5 0 R
>>
endobj
4 0 obj
<<
  /Type /Page
>>
endobj
5 0 obj
<<
  /TitleBar (Confusing Header)
  /Title (Correct Title)
  /Dest [ 4 0 R /XYZ ]
>>
endobj
trailer
<< /Root 1 0 R >>
%%EOF`;
            const bookmarks = parsePdfContent(titleConfPdf);
            assert.deepEqual(bookmarks, [
                { title: 'Correct Title', page: 1 }
            ]);
        });
    });

    describe('initialize & getManualLocations', () => {
        let mockState;
        let mockContext;

        beforeEach(() => {
            mockState = new Map();
            mockContext = {
                workspaceState: {
                    get: (key) => mockState.get(key),
                    update: async (key, val) => {
                        mockState.set(key, val);
                    }
                }
            };
        });

        it('counts successful scans separately from discovered PDFs and uses that count in health readiness', async () => {
            const failedPdf = path.join(tempDir, 'failed.pdf');
            fs.copyFileSync(mockPdfPath, failedPdf);
            const originalGetConfiguration = vscode.workspace.getConfiguration;
            const originalRead = fs.readFileSync;
            const originalStat = fs.statSync;
            const { createHealthService } = require('../../src/client/services/healthService');
            vscode.workspace.getConfiguration = () => ({ get: key => key === 'manualsDir' ? tempDir : undefined });
            const health = createHealthService({ getManualsDir: () => tempDir, getManualFilesCount });
            try {
                for (const failure of ['stat', 'read', 'all']) {
                    mockState.clear();
                    const shouldFail = file => path.resolve(String(file)) === failedPdf ||
                        (failure === 'all' && path.resolve(String(file)) === mockPdfPath);
                    fs.statSync = function (file, ...args) {
                        if (failure === 'stat' && shouldFail(file)) throw Object.assign(new Error('stat denied'), { code: 'EACCES' });
                        return originalStat.call(this, file, ...args);
                    };
                    fs.readFileSync = function (file, ...args) {
                        if (failure !== 'stat' && shouldFail(file)) throw Object.assign(new Error('read failed'), { code: 'EIO' });
                        return originalRead.call(this, file, ...args);
                    };
                    await initialize(mockContext);
                    const expected = failure === 'all' ? 0 : 1;
                    assert.equal(getManualFilesCount(), expected, failure);
                    assert.equal(getManualLocations('*NODE').length, expected, failure);
                    health.invalidate();
                    const report = health.getReport({ isLsdyna: true });
                    assert.equal(report.items.find(item => item.id === 'pdfFiles').metadata.pdfCount, 2);
                    const index = report.items.find(item => item.id === 'manualIndex');
                    assert.equal(index.metadata.indexedPdfCount, expected);
                    assert.equal(index.state, expected ? 'ready' : 'warning');
                }
            } finally {
                fs.readFileSync = originalRead;
                fs.statSync = originalStat;
                vscode.workspace.getConfiguration = originalGetConfiguration;
                fs.rmSync(failedPdf, { force: true });
            }
        });
        it('indexes only the manual root selected by the reader when several candidates exist', async () => {
            const originalGetConfiguration = vscode.workspace.getConfiguration, folders = vscode.workspace.workspaceFolders;
            const candidate = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dynasense-manual-roots-'));
            const first = path.join(candidate, 'one', 'manuals'), second = path.join(candidate, 'two', 'manuals');
            try {
                for (const dir of [first, second]) {
                    fs.mkdirSync(path.join(dir, 'indexes'), { recursive: true });
                    fs.copyFileSync(mockPdfPath, path.join(dir, 'manual.pdf'));
                }
                vscode.workspace.getConfiguration = () => ({ get: key => key === 'manualsDir' ? 'manuals' : undefined });
                vscode.workspace.workspaceFolders = [first, second].map(dir => ({ uri: { fsPath: path.dirname(dir) } }));
                await initialize(mockContext);
                assert.equal(getManualFilesCount(), 1);
                assert.deepEqual(getManualLocations('*NODE').map(item => item.file), [path.join(first, 'manual.pdf')]);
            } finally {
                // Close the production watchers before removing this test's roots.
                vscode.workspace.getConfiguration = () => ({ get: key => key === 'manualsDir' ? path.join(candidate, 'absent') : undefined });
                await initialize(mockContext);
                vscode.workspace.getConfiguration = originalGetConfiguration;
                vscode.workspace.workspaceFolders = folders;
                assert.ok(path.basename(candidate).startsWith('dynasense-manual-roots-'));
                fs.rmSync(candidate, { recursive: true, force: true });
            }
        });

        it('keeps successful scan readiness when persisting the optional bookmark cache fails', async () => {
            const originalGetConfiguration = vscode.workspace.getConfiguration;
            vscode.workspace.getConfiguration = () => ({ get: key => key === 'manualsDir' ? tempDir : undefined });
            mockContext.workspaceState.update = async () => { throw new Error('cache write failed'); };
            try {
                await initialize(mockContext);
                assert.equal(getManualFilesCount(), 1);
                assert.equal(getManualLocations('*NODE').length, 1);
            } finally {
                vscode.workspace.getConfiguration = originalGetConfiguration;
            }
        });

        it('does not restore an older file count after a newer initialization finishes', async () => {
            const originalGetConfiguration = vscode.workspace.getConfiguration;
            let configured = tempDir;
            let release;
            const persisted = new Promise(resolve => { release = resolve; });
            vscode.workspace.getConfiguration = () => ({ get: key => key === 'manualsDir' ? configured : undefined });
            mockContext.workspaceState.update = () => persisted;
            try {
                const older = initialize(mockContext);
                configured = path.join(tempDir, 'not-configured');
                await initialize({ workspaceState: { get: () => undefined } });
                assert.equal(getManualFilesCount(), 0);
                release();
                await older;
                assert.equal(getManualFilesCount(), 0);
                assert.deepEqual(getManualLocations('*NODE'), []);
            } finally {
                release();
                vscode.workspace.getConfiguration = originalGetConfiguration;
            }
        });

        it('scans PDF directory and registers bookmark keywords in keywordMap', async () => {
            // Setup configuration stub
            const originalGetConfiguration = vscode.workspace.getConfiguration;
            vscode.workspace.getConfiguration = (section) => {
                if (section === 'lsdyna') {
                    return {
                        get: (key) => {
                            if (key === 'manualsDir') return tempDir;
                            return undefined;
                        }
                    };
                }
                return originalGetConfiguration(section);
            };

            try {
                await initialize(mockContext);

                // Check keywordMap contents via getManualLocations
                const nodeLocs = getManualLocations('*NODE_TITLE');
                const eosLocs = getManualLocations('*EOS_001');
                const invalidLocs = getManualLocations('NON_EXISTENT');

                assert.strictEqual(nodeLocs.length, 1);
                assert.strictEqual(nodeLocs[0].page, 1);
                assert.strictEqual(nodeLocs[0].file, path.resolve(mockPdfPath));
                assert.strictEqual(nodeLocs[0].requestedKeyword, '*NODE');
                assert.strictEqual(nodeLocs[0].matchedKeyword, '*NODE');
                assert.strictEqual(nodeLocs[0].matchKind, 'exact');

                assert.strictEqual(eosLocs.length, 1);
                assert.strictEqual(eosLocs[0].page, 2);
                assert.strictEqual(eosLocs[0].file, path.resolve(mockPdfPath));
                assert.strictEqual(eosLocs[0].matchKind, 'exact');

                assert.deepEqual(invalidLocs, []);

                // Check backtrack matching
                const backtrackedLocs = getManualLocations('*NODE_SUB_KW');
                assert.strictEqual(backtrackedLocs.length, 1);
                assert.strictEqual(backtrackedLocs[0].file, nodeLocs[0].file);
                assert.strictEqual(backtrackedLocs[0].page, nodeLocs[0].page);
                assert.strictEqual(backtrackedLocs[0].requestedKeyword, '*NODE_SUB_KW');
                assert.strictEqual(backtrackedLocs[0].matchedKeyword, '*NODE');
                assert.strictEqual(backtrackedLocs[0].matchKind, 'approximate');

                // Verify cache is updated in workspaceState
                const cache = mockState.get('manuals_bookmark_cache');
                assert.ok(cache);
                assert.ok(cache[path.resolve(mockPdfPath)]);
                assert.strictEqual(cache[path.resolve(mockPdfPath)].bookmarks.length, 2);
            } finally {
                vscode.workspace.getConfiguration = originalGetConfiguration;
            }
        });

        it('scans a packaged pdf subdirectory as well as the legacy root layout', async () => {
            const originalGetConfiguration = vscode.workspace.getConfiguration;
            const packagedPdfDir = path.join(tempDir, 'pdf');
            const packagedPdf = path.join(packagedPdfDir, 'packaged_manual.pdf');
            fs.mkdirSync(packagedPdfDir, { recursive: true });
            fs.copyFileSync(mockPdfPath, packagedPdf);
            vscode.workspace.getConfiguration = (section) => section === 'lsdyna' ? {
                get: key => key === 'manualsDir' ? tempDir : undefined,
            } : originalGetConfiguration(section);

            try {
                await initialize(mockContext);
                const locations = getManualLocations('*NODE_TITLE');
                assert.ok(locations.some(location => location.file === path.resolve(packagedPdf)));
                assert.ok(getManualFilesCount() >= 2);
            } finally {
                vscode.workspace.getConfiguration = originalGetConfiguration;
                fs.rmSync(packagedPdfDir, { recursive: true, force: true });
            }
        });

        it('indexes only manifest-declared PDFs when pdfFile is present', async () => {
            const originalGetConfiguration = vscode.workspace.getConfiguration;
            const packagedPdfDir = path.join(tempDir, 'pdf');
            fs.mkdirSync(packagedPdfDir, { recursive: true });
            const keep = path.join(packagedPdfDir, 'keep.zh-CN.pdf');
            const extra = path.join(packagedPdfDir, 'extra.pdf');
            fs.copyFileSync(mockPdfPath, keep);
            fs.copyFileSync(mockPdfPath, extra);
            // Remove root-level mock so only pack PDFs remain candidates.
            const rootMock = mockPdfPath;
            fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({
                documents: [{ slug: 'vol', title: 'Vol', pdfFile: 'pdf/keep.zh-CN.pdf' }],
            }));
            vscode.workspace.getConfiguration = (section) => section === 'lsdyna' ? {
                get: key => key === 'manualsDir' ? tempDir : undefined,
            } : originalGetConfiguration(section);

            try {
                await initialize(mockContext);
                assert.strictEqual(getManualFilesCount(), 1);
                const locations = getManualLocations('*NODE_TITLE');
                assert.strictEqual(locations.length, 1);
                assert.strictEqual(locations[0].file, path.resolve(keep));
            } finally {
                vscode.workspace.getConfiguration = originalGetConfiguration;
                fs.rmSync(path.join(tempDir, 'manifest.json'), { force: true });
                fs.rmSync(packagedPdfDir, { recursive: true, force: true });
                // root mock still present from suite setup
                void rootMock;
            }
        });

        it('refreshes bookmarks after native PDF replacements that preserve modification time', async () => {
            const originalConfig = vscode.workspace.getConfiguration;
            const originalBytes = fs.readFileSync(mockPdfPath);
            const originalStats = fs.statSync(mockPdfPath);
            const fixedTime = new Date('2025-01-01T00:00:00Z');
            vscode.workspace.getConfiguration = () => ({ get: key => key === 'manualsDir' ? tempDir : undefined });
            try {
                for (const larger of [false, true]) {
                    fs.writeFileSync(mockPdfPath, originalBytes);
                    fs.utimesSync(mockPdfPath, fixedTime, fixedTime);
                    mockState.clear();
                    await initialize(mockContext);
                    const before = fs.statSync(mockPdfPath);
                    const replacement = originalBytes.toString('binary').replace('*NODE_TITLE', '*PART_TITLE') + (larger ? '\n' : '');
                    fs.writeFileSync(mockPdfPath, replacement, 'binary');
                    fs.utimesSync(mockPdfPath, fixedTime, fixedTime);
                    const after = fs.statSync(mockPdfPath);
                    assert.equal(after.mtimeMs, before.mtimeMs);
                    assert.equal(after.size === before.size, !larger);
                    assert.notEqual(after.ctimeMs, before.ctimeMs, 'native change time identifies the replacement');
                    await initialize(mockContext);
                    assert.deepEqual(getManualLocations('*NODE'), []);
                    assert.equal(getManualLocations('*PART')[0]?.page, 1);
                }
            } finally {
                fs.writeFileSync(mockPdfPath, originalBytes);
                fs.utimesSync(mockPdfPath, originalStats.atime, originalStats.mtime);
                vscode.workspace.getConfiguration = () => ({ get: key => key === 'manualsDir' ? path.join(tempDir, 'absent') : undefined });
                await initialize(mockContext);
                vscode.workspace.getConfiguration = originalConfig;
            }
        });

        it('re-parses an older cache that lacks size and change time', async () => {
            const originalConfig = vscode.workspace.getConfiguration;
            vscode.workspace.getConfiguration = () => ({ get: key => key === 'manualsDir' ? tempDir : undefined });
            try {
                mockState.set('manuals_bookmark_cache', { [path.resolve(mockPdfPath)]: {
                    version: 2, mtimeMs: fs.statSync(mockPdfPath).mtimeMs,
                    bookmarks: [{ title: '*CACHED_KEYWORD', page: 42 }],
                } });
                await initialize(mockContext);
                assert.deepEqual(getManualLocations('*CACHED_KEYWORD'), []);
                assert.equal(getManualLocations('*NODE')[0]?.page, 1);
            } finally { vscode.workspace.getConfiguration = originalConfig; }
        });

        it('uses cache when file metadata has not changed', async () => {
            const originalGetConfiguration = vscode.workspace.getConfiguration;
            vscode.workspace.getConfiguration = (section) => {
                if (section === 'lsdyna') {
                    return {
                        get: (key) => {
                            if (key === 'manualsDir') return tempDir;
                            return undefined;
                        }
                    };
                }
                return originalGetConfiguration(section);
            };

            try {
                const stats = fs.statSync(mockPdfPath);
                const mockCache = {};
                mockCache[path.resolve(mockPdfPath)] = {
                    version: 2,
                    mtimeMs: stats.mtimeMs,
                    size: stats.size,
                    ctimeMs: stats.ctimeMs,
                    bookmarks: [
                        { title: '*CACHED_KEYWORD', page: 42 }
                    ]
                };
                mockState.set('manuals_bookmark_cache', mockCache);

                await initialize(mockContext);

                const cachedLocs = getManualLocations('*CACHED_KEYWORD');
                assert.strictEqual(cachedLocs.length, 1);
                assert.strictEqual(cachedLocs[0].page, 42);
                assert.strictEqual(cachedLocs[0].file, path.resolve(mockPdfPath));

                // Original PDF keywords should not be in map because we used cache
                const nodeLocs = getManualLocations('*NODE');
                assert.deepEqual(nodeLocs, []);
            } finally {
                vscode.workspace.getConfiguration = originalGetConfiguration;
            }
        });

        it('re-parses PDF when cache version is mismatched or missing', async () => {
            const originalGetConfiguration = vscode.workspace.getConfiguration;
            vscode.workspace.getConfiguration = (section) => {
                if (section === 'lsdyna') {
                    return {
                        get: (key) => {
                            if (key === 'manualsDir') return tempDir;
                            return undefined;
                        }
                    };
                }
                return originalGetConfiguration(section);
            };

            try {
                const stats = fs.statSync(mockPdfPath);
                const mockCache = {};
                // Cache has old version
                mockCache[path.resolve(mockPdfPath)] = {
                    version: 1,
                    mtimeMs: stats.mtimeMs,
                    bookmarks: [
                        { title: '*CACHED_KEYWORD', page: 42 }
                    ]
                };
                mockState.set('manuals_bookmark_cache', mockCache);

                await initialize(mockContext);

                // Should NOT use cache
                const cachedLocs = getManualLocations('*CACHED_KEYWORD');
                assert.deepEqual(cachedLocs, []);

                // Should re-parse original PDF keywords
                const nodeLocs = getManualLocations('*NODE');
                assert.strictEqual(nodeLocs.length, 1);
                assert.strictEqual(nodeLocs[0].page, 1);
            } finally {
                vscode.workspace.getConfiguration = originalGetConfiguration;
            }
        });

        it('registers slash-separated keywords with prefixes correctly from cache', async () => {
            const originalGetConfiguration = vscode.workspace.getConfiguration;
            vscode.workspace.getConfiguration = (section) => {
                if (section === 'lsdyna') {
                    return {
                        get: (key) => {
                            if (key === 'manualsDir') return tempDir;
                            return undefined;
                        }
                    };
                }
                return originalGetConfiguration(section);
            };

            try {
                const stats = fs.statSync(mockPdfPath);
                const mockCache = {};
                mockCache[path.resolve(mockPdfPath)] = {
                    version: 2,
                    mtimeMs: stats.mtimeMs,
                    size: stats.size,
                    ctimeMs: stats.ctimeMs,
                    bookmarks: [
                        { title: '14. *MAT_026/*MAT_HONEYCOMB', page: 40 },
                        { title: 'CONTROL_TERMINATION/CONTROL_TIMESTEP', page: 50 },
                        { title: '*MAT_024/*MAT_PIECEWISE_LINEAR_PLASTICITY', page: 60 },
                        { title: '*CONTACT', page: 70 },
                        { title: '*CONTACT_TIED_SHELL_EDGE_TO_SURFACE_OFFSET', page: 71 }
                    ]
                };
                mockState.set('manuals_bookmark_cache', mockCache);

                await initialize(mockContext);

                const mat26Locs = getManualLocations('*MAT_026');
                const honeycombLocs = getManualLocations('*MAT_HONEYCOMB');
                const terminationLocs = getManualLocations('*CONTROL_TERMINATION');
                const timestepLocs = getManualLocations('*CONTROL_TIMESTEP');
                const matOptionLocs = getManualLocations('*MAT_024_LOG_INTERPOLATION');

                assert.strictEqual(mat26Locs.length, 1);
                assert.strictEqual(mat26Locs[0].page, 40);

                assert.strictEqual(honeycombLocs.length, 1);
                assert.strictEqual(honeycombLocs[0].page, 40);

                assert.strictEqual(terminationLocs.length, 1);
                assert.strictEqual(terminationLocs[0].page, 50);

                assert.strictEqual(timestepLocs.length, 1);
                assert.strictEqual(timestepLocs[0].page, 50);

                assert.strictEqual(matOptionLocs.length, 1);
                assert.strictEqual(matOptionLocs[0].page, 60);
                assert.strictEqual(matOptionLocs[0].matchedKeyword, '*MAT_024');
                assert.strictEqual(matOptionLocs[0].matchKind, 'section');
                for (const spelling of ['*CONTACT_TIED_SHELL_EDGE_TO_SURFACE_ID_OFFSET',
                    '*CONTACT_ID_TIED_SHELL_EDGE_TO_SURFACE_OFFSET']) {
                    const locations = getManualLocations(spelling);
                    assert.equal(locations.length, 1);
                    assert.equal(locations[0].page, 71); // Canonical chapter takes precedence over generic CONTACT fallback.
                    assert.equal(locations[0].matchKind, 'section');
                }
            } finally {
                vscode.workspace.getConfiguration = originalGetConfiguration;
            }
        });

        it('returns correct count of indexed files', () => {
            const count = getManualFilesCount();
            assert.strictEqual(typeof count, 'number');
            assert.ok(count >= 1);
        });
    });
});
