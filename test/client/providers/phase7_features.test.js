'use strict';

const assert = require('assert');
const path = require('path');
const { fakeDoc, vscodeMock } = require('../../helpers');
const { LsdynaIncludeTreeProvider } = require('../../../src/client/providers/includeTreeProvider');
const { LsdynaKeywordIndexProvider } = require('../../../src/client/providers/keywordIndexProvider');
const { publishProjectDiagnostics, LsdynaFieldCompletionProvider, getCardFieldsForLine, alignCardFields } = require('../../../src/extension')._internals;

describe('Phase 7 Features', () => {
    describe('LsdynaIncludeTreeProvider Markers', () => {
        it('marks circular include nodes as circular with a sync icon and no children', () => {
            const provider = new LsdynaIncludeTreeProvider();
            const treeNode = {
                filePath: '/project/main.k',
                children: [
                    {
                        filePath: '/project/cycle.k',
                        children: [],
                        cycle: true,
                    }
                ]
            };
            const item = provider._buildItemFromTreeNode(treeNode);
            assert.equal(item.children.length, 1);
            
            const childItem = item.children[0];
            assert.equal(childItem.filePath, '/project/cycle.k');
            assert.equal(childItem.description, 'circular');
            assert.equal(childItem.collapsibleState, vscodeMock.TreeItemCollapsibleState.None);
            assert.deepEqual(childItem.iconPath, new vscodeMock.ThemeIcon('sync'));
        });

        it('marks missing include nodes as missing with a warning icon and no children', () => {
            const provider = new LsdynaIncludeTreeProvider();
            const treeNode = {
                filePath: '/project/main.k',
                children: [
                    {
                        filePath: '/project/missing.k',
                        fileName: 'missing.k',
                        missing: true,
                        children: [],
                    }
                ]
            };
            const item = provider._buildItemFromTreeNode(treeNode);
            assert.equal(item.children.length, 1);
            
            const childItem = item.children[0];
            assert.equal(childItem.filePath, '/project/missing.k');
            assert.equal(childItem.description, 'missing');
            assert.equal(childItem.collapsibleState, vscodeMock.TreeItemCollapsibleState.None);
            assert.deepEqual(childItem.iconPath, new vscodeMock.ThemeIcon('warning'));
        });
    });

    describe('LsdynaKeywordIndexProvider Folding', () => {
        it('does not fold when total usages are below threshold', () => {
            const provider = new LsdynaKeywordIndexProvider({
                shouldSkipAutomaticDocumentScan: () => false,
            });
            const keywordMap = new Map([
                ['PART', [
                    { filePath: '/project/a.key', lineIndex: 10 },
                    { filePath: '/project/b.key', lineIndex: 20 },
                ]]
            ]);
            const roots = provider._buildRootsFromKeywordMap(keywordMap, '/project');
            assert.equal(roots.length, 1);
            assert.equal(roots[0].label, 'PART');
            assert.equal(roots[0].children.length, 2);
            assert.equal(roots[0].children[0].label, 'a.key');
            assert.equal(roots[0].children[0].description, ':line 11');
            assert.equal(roots[0].children[1].label, 'b.key');
            assert.equal(roots[0].children[1].description, ':line 21');
        });

        it('folds and groups by file when total usages are above KEYWORD_FOLDING_THRESHOLD', () => {
            const provider = new LsdynaKeywordIndexProvider({
                shouldSkipAutomaticDocumentScan: () => false,
            });

            // Create 110 usages (above 100 threshold)
            // 60 in file a.key (above 50 threshold -> aggregated)
            // 50 in file b.key (exactly 50 threshold -> not aggregated)
            const usages = [];
            for (let i = 0; i < 60; i++) {
                usages.push({ filePath: '/project/a.key', lineIndex: i });
            }
            for (let i = 0; i < 50; i++) {
                usages.push({ filePath: '/project/b.key', lineIndex: i });
            }

            const keywordMap = new Map([['PART', usages]]);
            const roots = provider._buildRootsFromKeywordMap(keywordMap, '/project');
            
            assert.equal(roots.length, 1);
            assert.equal(roots[0].label, 'PART');
            
            // a.key should be 1 aggregated item
            // b.key should be 50 individual items
            // total children: 1 + 50 = 51
            assert.equal(roots[0].children.length, 51);
            
            // First item should be the aggregated node for a.key
            const aggItem = roots[0].children[0];
            assert.equal(aggItem.label, 'a.key');
            assert.equal(aggItem.description, '60 usages');
            assert.equal(aggItem.resourceUri.fsPath, '/project/a.key');
            assert.equal(aggItem.command.arguments[0], '/project/a.key');
            assert.equal(aggItem.command.arguments[1], 0); // first line index

            // Next items should be individual b.key items
            assert.equal(roots[0].children[1].label, 'b.key');
            assert.equal(roots[0].children[1].description, ':line 1');
        });

        it('uses blockIndex for local incremental updates on edits', () => {
            const provider = new LsdynaKeywordIndexProvider({
                shouldSkipAutomaticDocumentScan: () => false,
            });

            const document = fakeDoc('*NODE\n1,2,3\n', '/project/main.k');
            document.languageId = 'lsdyna';
            provider.refreshFromDocument(document);

            assert.equal(provider.roots.length, 1);
            assert.equal(provider.roots[0].label, 'NODE');

            // Apply incremental update: change line 1 (1,2,3) to '*ELEMENT_SHELL\n999'
            // line count is now 3
            const updatedDocument = fakeDoc('*NODE\n*ELEMENT_SHELL\n999', '/project/main.k');
            updatedDocument.languageId = 'lsdyna';
            const event = {
                contentChanges: [
                    {
                        range: new vscodeMock.Range(1, 0, 1, 5),
                        text: '*ELEMENT_SHELL\n999'
                    }
                ]
            };

            provider.updateDocumentIndex(updatedDocument, event);
            provider.refreshFromDocument(updatedDocument);

            assert.equal(provider.roots.length, 2);
            assert.equal(provider.roots[0].label, 'ELEMENT_SHELL');
            assert.equal(provider.roots[1].label, 'NODE');
        });
    });

    describe('publishProjectDiagnostics', () => {
        it('publishes warnings for missing files and errors for cycles at exact source ranges', () => {
            const diagnosticsCollection = {
                deletedFiles: [],
                sets: new Map(),
                delete(uri) {
                    this.deletedFiles.push(uri.fsPath);
                },
                set(uri, diagnostics) {
                    this.sets.set(uri.fsPath, diagnostics);
                }
            };

            const snapshot = {
                files: ['/project/main.k', '/project/child.k'],
                missingFiles: [
                    {
                        fromFile: '/project/main.k',
                        fileName: 'missing.k',
                        lineIndex: 2,
                        startChar: 5,
                        endChar: 15,
                    }
                ],
                cycles: [
                    {
                        fromFile: '/project/child.k',
                        path: ['/project/main.k', '/project/child.k', '/project/main.k'],
                        lineIndex: 4,
                        startChar: 10,
                        endChar: 25,
                    }
                ]
            };

            publishProjectDiagnostics(snapshot, diagnosticsCollection);

            // Verified both files were cleared first
            assert.deepEqual(diagnosticsCollection.deletedFiles.sort(), ['/project/main.k', '/project/child.k'].sort());

            // Check diagnostics set
            const mainDiags = diagnosticsCollection.sets.get('/project/main.k');
            assert.equal(mainDiags.length, 1);
            assert.equal(mainDiags[0].message, 'Included file "missing.k" not found.');
            assert.equal(mainDiags[0].severity, vscodeMock.DiagnosticSeverity.Warning);
            assert.equal(mainDiags[0].range.start.line, 2);
            assert.equal(mainDiags[0].range.start.character, 5);
            assert.equal(mainDiags[0].range.end.character, 15);

            const childDiags = diagnosticsCollection.sets.get('/project/child.k');
            assert.equal(childDiags.length, 1);
            assert.equal(childDiags[0].message, 'Circular include dependency detected: main.k -> child.k -> main.k');
            assert.equal(childDiags[0].severity, vscodeMock.DiagnosticSeverity.Error);
            assert.equal(childDiags[0].range.start.line, 4);
            assert.equal(childDiags[0].range.start.character, 10);
            assert.equal(childDiags[0].range.end.character, 25);
        });
    });

    describe('LsdynaFieldCompletionProvider', () => {
        it('skips keywords and comment lines', () => {
            const provider = new LsdynaFieldCompletionProvider();
            const document = fakeDoc('*NODE\n$ This is a comment\n', '/project/main.k');
            document.languageId = 'lsdyna';
            
            const pos1 = new vscodeMock.Position(0, 2); // on *NODE
            const items1 = provider.provideCompletionItems(document, pos1);
            assert.deepEqual(items1, []);

            const pos2 = new vscodeMock.Position(1, 4); // on comment
            const items2 = provider.provideCompletionItems(document, pos2);
            assert.deepEqual(items2, []);
        });

        it('returns full row template and individual fields on empty line', () => {
            const provider = new LsdynaFieldCompletionProvider();
            const document = fakeDoc('*NODE\n\n', '/project/main.k');
            document.languageId = 'lsdyna';

            const pos = new vscodeMock.Position(1, 0); // start of empty line
            const items = provider.provideCompletionItems(document, pos);
            
            assert.ok(items.length > 0);
            // Should contain row template item at index 0
            const templateItem = items[0];
            assert.ok(templateItem.label.includes('卡片') || templateItem.label.includes('Template'));
            assert.equal(templateItem.insertText.value.length, 102); // 102 chars with snippet wrappers

            // Should contain individual fields starting from index 1
            const fieldItem1 = items[1];
            assert.ok(fieldItem1.label.includes('NID'));
            assert.equal(fieldItem1.insertText.value, '${1:       0}'); // 0 spaces padding + 8 chars placeholder
        });

        it('calculates smart padding on a non-empty line with existing content', () => {
            const provider = new LsdynaFieldCompletionProvider();
            const document = fakeDoc('*NODE\n12345\n', '/project/main.k'); // "12345" on line 1
            document.languageId = 'lsdyna';

            const pos = new vscodeMock.Position(1, 5); // cursor at column 5
            const items = provider.provideCompletionItems(document, pos);

            // Row template should NOT be returned
            const templates = items.filter(item => item.label.includes('卡片') || item.label.includes('Template'));
            assert.equal(templates.length, 0);

            // The next field is X (p=8). Spacing should be 8 - 5 = 3 spaces.
            const xItem = items.find(item => item.label.includes('X'));
            assert.ok(xItem);
            assert.equal(xItem.insertText.value, '   ${1:             0.0}'); // 3 spaces padding + X placeholder
        });
    });

    describe('alignCardFields', () => {
        it('identifies and right-aligns edited fields dynamically on a card line', async () => {
            const document = fakeDoc('*NODE\n       0       0       0\n', '/project/main.k');
            document.languageId = 'lsdyna';

            let editCalled = false;
            let editRange, editVal, editOptions;
            let selectionVal;

            const editor = {
                document,
                edit: async (callback, options) => {
                    editCalled = true;
                    editOptions = options;
                    const builder = {
                        replace: (r, v) => {
                            editRange = r;
                            editVal = v;
                        }
                    };
                    callback(builder);
                    return true;
                },
                get selection() { return selectionVal; },
                set selection(v) { selectionVal = v; }
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;

            try {
                // Simulate user typing '12' replacing the default placeholder '       0' (columns 0-8)
                const changeEvent = {
                    document,
                    contentChanges: [{
                        range: new vscodeMock.Range(1, 0, 1, 8),
                        rangeLength: 8,
                        text: '12'
                    }]
                };

                // The document text has already been updated to contain the change.
                // In our fakeDoc, we can just replace '       0' with '12' to simulate the state of the document after the change.
                const originalLineAt = document.lineAt;
                document.lineAt = (index) => {
                    if (index === 1) return { text: '12       0       0' };
                    return originalLineAt(index);
                };

                await alignCardFields(changeEvent);

                assert.ok(editCalled);
                assert.deepEqual(editRange.start, new vscodeMock.Position(1, 0));
                assert.deepEqual(editRange.end, new vscodeMock.Position(1, 2));
                assert.equal(editVal, '      12'); // '12' padded to width 8
                assert.deepEqual(editOptions, { undoStopBefore: false, undoStopAfter: false });
                assert.deepEqual(selectionVal.active, new vscodeMock.Position(1, 8)); // Cursor placed at the end of the field (col 8)
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('retains column alignment when character is inserted in the middle of field text', async () => {
            const document = fakeDoc('*NODE\n      12       0       0\n', '/project/main.k');
            document.languageId = 'lsdyna';

            let editCalled = false;
            let editRange, editVal;
            let selectionVal;

            const editor = {
                document,
                edit: async (callback) => {
                    editCalled = true;
                    const builder = {
                        replace: (r, v) => {
                            editRange = r;
                            editVal = v;
                        }
                    };
                    callback(builder);
                    return true;
                },
                get selection() { return selectionVal; },
                set selection(v) { selectionVal = v; }
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;

            try {
                // User inserts '3' at position (1, 7) - between '1' and '2' in '      12'
                const changeEvent = {
                    document,
                    contentChanges: [{
                        range: new vscodeMock.Range(1, 7, 1, 7),
                        rangeLength: 0,
                        text: '3'
                    }]
                };

                const originalLineAt = document.lineAt;
                document.lineAt = (index) => {
                    if (index === 1) return { text: '      132       0       0' };
                    return originalLineAt(index);
                };

                await alignCardFields(changeEvent);

                assert.ok(editCalled);
                assert.deepEqual(editRange.start, new vscodeMock.Position(1, 0));
                assert.deepEqual(editRange.end, new vscodeMock.Position(1, 9));
                assert.equal(editVal, '     132'); // '132' padded to width 8
                // Characters after cursor: '2' (length 1). New cursor position: 0 + 8 - 1 = 7
                assert.deepEqual(selectionVal.active, new vscodeMock.Position(1, 7));
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });
    });
});
