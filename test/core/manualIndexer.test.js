'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const {
    cleanKeyword,
    parsePdf,
    initialize,
    getManualLocations
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

        it('removes _TITLE suffix (case-insensitive)', () => {
            assert.strictEqual(cleanKeyword('*NODE_TITLE'), '*NODE');
            assert.strictEqual(cleanKeyword('*node_title'), '*NODE');
            assert.strictEqual(cleanKeyword('  *control_termination_title  '), '*CONTROL_TERMINATION');
        });

        it('does not remove _TITLE if it is not a suffix', () => {
            assert.strictEqual(cleanKeyword('*TITLE_SUFFIX'), '*TITLE_SUFFIX');
        });
    });

    describe('parsePdf', () => {
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

                assert.strictEqual(eosLocs.length, 1);
                assert.strictEqual(eosLocs[0].page, 2);
                assert.strictEqual(eosLocs[0].file, path.resolve(mockPdfPath));

                assert.deepEqual(invalidLocs, []);

                // Verify cache is updated in workspaceState
                const cache = mockState.get('manuals_bookmark_cache');
                assert.ok(cache);
                assert.ok(cache[path.resolve(mockPdfPath)]);
                assert.strictEqual(cache[path.resolve(mockPdfPath)].bookmarks.length, 2);
            } finally {
                vscode.workspace.getConfiguration = originalGetConfiguration;
            }
        });

        it('uses cache when file modification time has not changed', async () => {
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
                    mtimeMs: stats.mtimeMs,
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
    });
});
