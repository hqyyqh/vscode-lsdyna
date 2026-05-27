'use strict';

const assert = require('assert');
const path = require('path');
const { fakeDoc, vscodeMock } = require('../../helpers');
const { LsdynaIncludeTreeProvider } = require('../../../src/client/providers/includeTreeProvider');
const { LsdynaKeywordIndexProvider } = require('../../../src/client/providers/keywordIndexProvider');
const { publishProjectDiagnostics, LsdynaFieldCompletionProvider, getCardFieldsForLine, generateCommentLine, alignLineText, formatLineIfNeeded, handleTabAlignment, getPathEntryRange, formatPathEntryIfNeeded } = require('../../../src/extension')._internals;

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

        describe('generateCommentLine', () => {
            it('should align field names based on field offsets and width', () => {
                const { generateCommentLine } = require('../../../src/extension')._internals;
                const card = [
                    { n: 'SECID', p: 0, w: 10 },
                    { n: 'MID', p: 10, w: 10 },
                    { n: 'ELFORM', p: 20, w: 10 }
                ];
                const result = generateCommentLine(card);
                const expected = '$#   SECID       MID    ELFORM';
                assert.strictEqual(result, expected);
            });
        });

        it('should return $# completion item with documentation when typing $ under a keyword block', () => {
            const provider = new LsdynaFieldCompletionProvider();
            const document = fakeDoc('*SECTION_SHELL\n$ some extra trailing space and text\n', '/project/main.k');
            document.languageId = 'lsdyna';

            const pos = new vscodeMock.Position(1, 1); // cursor after '$'
            const items = provider.provideCompletionItems(document, pos);

            assert.strictEqual(items.length, 1);
            const item = items[0];
            assert.strictEqual(item.label, '$#');
            assert.strictEqual(item.detail, '(LS-DYNA) 插入字段注释行');
            assert.ok(item.insertText.includes('$#   SECID'));
            assert.ok(item.documentation.value.includes('$#   SECID'));
            
            // The range should cover the entire line to wipe out trailing spaces and text
            assert.strictEqual(item.range.start.line, 1);
            assert.strictEqual(item.range.start.character, 0);
            assert.strictEqual(item.range.end.line, 1);
            assert.strictEqual(item.range.end.character, 36);
        });
    });

    describe('alignLineText', () => {
        it('formats empty line and returns a space-filled line matching card length', () => {
            const cardFields = [
                { n: 'NID', p: 0, w: 8 },
                { n: 'X', p: 8, w: 16 }
            ];
            const aligned = alignLineText('', cardFields);
            assert.equal(aligned, '                        '); // 8 + 16 = 24 spaces
        });

        it('preserves the physical columns and avoids shifting values leftward', () => {
            const cardFields = [
                { n: 'NID', p: 0, w: 10 },
                { n: 'X', p: 10, w: 10 }
            ];
            const rawText = '          123'; // 10 spaces followed by '123'
            const aligned = alignLineText(rawText, cardFields);
            assert.equal(aligned, '                 123'); // 10 spaces + 7 spaces + '123'
        });

        it('falls back to whitespace-splitting for unaligned lists', () => {
            const cardFields = [
                { n: 'NID', p: 0, w: 10 },
                { n: 'X', p: 10, w: 10 }
            ];
            const rawText = '12323 10'; // Space separated but not in column 10
            const aligned = alignLineText(rawText, cardFields);
            assert.equal(aligned, '     12323        10');
        });
    });

    describe('handleTabAlignment', () => {
        it('aligns the line and moves the cursor to the next field (with +1 offset for separation if prev field is not empty)', async () => {
            const document = fakeDoc('*NODE\n12323\n', '/project/main.k');
            document.languageId = 'lsdyna';
            let editCalled = false;
            let editVal = '';
            let selectionVal = new vscodeMock.Selection(new vscodeMock.Position(1, 5), new vscodeMock.Position(1, 5));

            const editor = {
                document,
                edit: async (callback) => {
                    editCalled = true;
                    const builder = {
                        replace: (r, v) => { editVal = v; }
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
                await handleTabAlignment(editor);
                assert.ok(editCalled);
                // Width of NID is 8 in mock *NODE
                assert.equal(editVal.slice(0, 8), '   12323');
                // The next field start position is column 8. Since prev field is not empty, offset is 1 -> col 9
                assert.equal(selectionVal.active.character, 9);
                assert.equal(selectionVal.active.line, 1);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('moves the cursor to the exact field start if the previous field is empty', async () => {
            const document = fakeDoc('*NODE\n        \n', '/project/main.k');
            document.languageId = 'lsdyna';
            let editCalled = false;
            let editVal = '';
            let selectionVal = new vscodeMock.Selection(new vscodeMock.Position(1, 2), new vscodeMock.Position(1, 2));

            const editor = {
                document,
                edit: async (callback) => {
                    editCalled = true;
                    const builder = {
                        replace: (r, v) => { editVal = v; }
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
                await handleTabAlignment(editor);
                assert.ok(editCalled);
                // The next field start position is column 8. Since prev field is empty, offset is 0 -> col 8
                assert.equal(selectionVal.active.character, 8);
                assert.equal(selectionVal.active.line, 1);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('does not truncate subsequent content when tabbing on a line that already has subsequent values', async () => {
            const document = fakeDoc('*NODE\n12323               0               0\n', '/project/main.k');
            document.languageId = 'lsdyna';
            let editCalled = false;
            let editVal = '';
            let selectionVal = new vscodeMock.Selection(new vscodeMock.Position(1, 5), new vscodeMock.Position(1, 5));

            const editor = {
                document,
                edit: async (callback) => {
                    editCalled = true;
                    const builder = {
                        replace: (r, v) => { editVal = v; }
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
                await handleTabAlignment(editor);
                assert.ok(editCalled);
                // The subsequent fields (X, Y) should not be deleted, so editVal should contain '0'
                assert.ok(editVal.includes('0'));
                assert.equal(selectionVal.active.character, 9);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('loops cursor back to the first field of the current line on the last field', async () => {
            const document = fakeDoc('*NODE\n   12323               0               0\n       0       0       0\n', '/project/main.k');
            document.languageId = 'lsdyna';
            let editCalled = false;
            // Cursor placed in the last field (col 65, i.e., field index 5)
            let selectionVal = new vscodeMock.Selection(new vscodeMock.Position(1, 65), new vscodeMock.Position(1, 65));

            const editor = {
                document,
                edit: async (callback) => {
                    editCalled = true;
                    return true;
                },
                get selection() { return selectionVal; },
                set selection(v) { selectionVal = v; }
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;

            try {
                await handleTabAlignment(editor);
                // Cursor should have looped back to line 1, character 0 (first field start)
                assert.equal(selectionVal.active.line, 1);
                assert.equal(selectionVal.active.character, 0);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('loops cursor back to the first field of the current line when cursor is at the end of the last field', async () => {
            const document = fakeDoc('*NODE\n   12323               0               0\n       0       0       0\n', '/project/main.k');
            document.languageId = 'lsdyna';
            let editCalled = false;
            // The card has 8 fields of width 8. The end of the last field (field index 7) is column 80.
            let selectionVal = new vscodeMock.Selection(new vscodeMock.Position(1, 80), new vscodeMock.Position(1, 80));

            const editor = {
                document,
                edit: async (callback) => {
                    editCalled = true;
                    return true;
                },
                get selection() { return selectionVal; },
                set selection(v) { selectionVal = v; }
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;

            try {
                await handleTabAlignment(editor);
                // Cursor should have looped back to line 1, character 0
                assert.equal(selectionVal.active.line, 1);
                assert.equal(selectionVal.active.character, 0);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('does not insert a newline and loops cursor back to the first field of the current line when tabbing at the last field and the next line is a keyword', async () => {
            const document = fakeDoc('*NODE\n   12323               0               0\n*ELEMENT\n', '/project/main.k');
            document.languageId = 'lsdyna';
            let editCalled = false;
            let editVal = '';
            let selectionVal = new vscodeMock.Selection(new vscodeMock.Position(1, 80), new vscodeMock.Position(1, 80));

            const editor = {
                document,
                edit: async (callback) => {
                    editCalled = true;
                    const builder = {
                        replace: (r, v) => {},
                        insert: (pos, text) => {
                            if (text === '\n') {
                                editVal += '\n';
                            }
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
                await handleTabAlignment(editor);
                assert.ok(editCalled);
                assert.equal(editVal, ''); // should not insert a newline
                // Cursor should have looped back to line 1, character 0
                assert.equal(selectionVal.active.line, 1);
                assert.equal(selectionVal.active.character, 0);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });
    });

    describe('Selection context key setting', () => {
        it('sets shouldAlignTab context based on current line card applicability', async () => {
            let lastContextKey = null;
            let lastContextVal = null;
            const originalExecuteCommand = vscodeMock.commands.executeCommand;
            vscodeMock.commands.executeCommand = async (cmd, ...args) => {
                if (cmd === 'setContext') {
                    lastContextKey = args[0];
                    lastContextVal = args[1];
                }
                return originalExecuteCommand ? originalExecuteCommand(cmd, ...args) : undefined;
            };

            try {
                const document = fakeDoc('*NODE\n12323\n$ Comment\n', '/project/main.k');
                document.languageId = 'lsdyna';
                
                // Simulate editor select line 1 (data line)
                const editor = {
                    document,
                    selection: { active: new vscodeMock.Position(1, 2) }
                };

                // Invoke internals handler trigger
                const { handleSelectionChange } = require('../../../src/extension')._internals;
                
                handleSelectionChange(editor);
                assert.equal(lastContextKey, 'lsdyna.shouldAlignTab');
                assert.equal(lastContextVal, true);

                // Simulate editor select line 2 (comment line)
                editor.selection.active = new vscodeMock.Position(2, 2);
                handleSelectionChange(editor);
                assert.equal(lastContextKey, 'lsdyna.shouldAlignTab');
                assert.equal(lastContextVal, false);
            } finally {
                vscodeMock.commands.executeCommand = originalExecuteCommand;
            }
        });
    });

    describe('getPathEntryRange', () => {
        it('identifies the correct range for single and multi-line paths under *INCLUDE_PATH', () => {
            const document = fakeDoc(
                '*INCLUDE_PATH\n' +
                '/short/path\n' +
                '/long/path/part1/ +\n' +
                'part2/part3/ +\n' +
                'part4\n' +
                '/another/path\n',
                '/project/main.k'
            );

            // /short/path is at index 1
            const r1 = getPathEntryRange(document, 1, 0);
            assert.deepEqual(r1, { start: 1, end: 1 });

            // /long/path/... starts at 2, ends at 4
            const r2 = getPathEntryRange(document, 2, 0);
            assert.deepEqual(r2, { start: 2, end: 4 });

            const r3 = getPathEntryRange(document, 3, 0);
            assert.deepEqual(r3, { start: 2, end: 4 });

            const r4 = getPathEntryRange(document, 4, 0);
            assert.deepEqual(r4, { start: 2, end: 4 });

            // /another/path is at index 5
            const r5 = getPathEntryRange(document, 5, 0);
            assert.deepEqual(r5, { start: 5, end: 5 });
        });
    });

    describe('formatPathEntryIfNeeded', () => {
        it('wraps paths longer than 80 characters into segments of 78 characters with " +"', async () => {
            const longPath = 'a'.repeat(78) + 'b'.repeat(10); // length 88
            const document = fakeDoc(`*INCLUDE_PATH\n${longPath}\n`, '/project/main.k');
            
            let editCalled = false;
            let editRange, editVal;

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
                }
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;

            try {
                await formatPathEntryIfNeeded(document, 1, 0);
                assert.ok(editCalled);
                assert.deepEqual(editRange.start, new vscodeMock.Position(1, 0));
                assert.deepEqual(editRange.end, new vscodeMock.Position(1, 88));
                
                // Segments should be:
                // Line 1: 78 chars of 'a' + ' +' (length 80)
                // Line 2: 10 chars of 'b'
                const expectedText = 'a'.repeat(78) + ' +\n' + 'b'.repeat(10);
                assert.equal(editVal, expectedText);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('merges multi-line paths that are shortened to <= 80 characters', async () => {
            const document = fakeDoc('*INCLUDE_PATH\n/short/path/part1 +\npart2\n', '/project/main.k');
            
            let editCalled = false;
            let editRange, editVal;

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
                }
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;

            try {
                await formatPathEntryIfNeeded(document, 1, 0);
                assert.ok(editCalled);
                assert.deepEqual(editRange.start, new vscodeMock.Position(1, 0));
                // /short/path/part1 + ends on line 1, part2 is on line 2 (5 chars)
                assert.deepEqual(editRange.end, new vscodeMock.Position(2, 5));
                assert.equal(editVal, '/short/path/part1part2');
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });
    });

    describe('formatLineIfNeeded integration', () => {
        it('automatically triggers path wrapping for *INCLUDE_PATH when formatLineIfNeeded is called', async () => {
            const longPath = 'a'.repeat(85);
            const document = fakeDoc(`*INCLUDE_PATH\n${longPath}\n`, '/project/main.k');
            
            let editCalled = false;
            let editVal;

            const editor = {
                document,
                edit: async (callback) => {
                    editCalled = true;
                    const builder = {
                        replace: (r, v) => {
                            editVal = v;
                        }
                    };
                    callback(builder);
                    return true;
                }
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;

            try {
                await formatLineIfNeeded(document, 1);
                assert.ok(editCalled);
                assert.equal(editVal, 'a'.repeat(78) + ' +\n' + 'a'.repeat(7));
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });
    });

    describe('Dynamic language association', () => {
        it('should change document language to lsdyna if extension matches custom extensions list', async () => {
            const originalTextDocuments = vscodeMock.workspace.textDocuments;
            const originalOnDidOpenTextDocument = vscodeMock.workspace.onDidOpenTextDocument;
            const originalGet = vscodeMock.workspace.getConfiguration;
            
            const callbacks = [];
            vscodeMock.workspace.onDidOpenTextDocument = (callback) => {
                callbacks.push(callback);
                return { dispose() {} };
            };
            
            // Mock document matching .asc
            const doc = {
                uri: { fsPath: '/test/file.asc' },
                languageId: 'plaintext'
            };
            
            vscodeMock.workspace.textDocuments = [doc];
            
            // Setup configuration mock return for lsdyna.additionalExtensions
            vscodeMock.workspace.getConfiguration = (section) => {
                return {
                    get: (key) => {
                        if (section === 'lsdyna' && key === 'additionalExtensions') {
                            return ['.k', '.key', '.dyna', '.asc'];
                        }
                        if (key === 'language') {
                            return 'en';
                        }
                        return undefined;
                    }
                };
            };

            const extension = require('../../../src/extension');
            const context = { subscriptions: [] };
            extension.activate(context);
            
            // Verify doc languageId is set to lsdyna
            assert.equal(doc.languageId, 'lsdyna');
            
            // Mock opening a new document with configured suffix
            const newDoc = {
                uri: { fsPath: '/test/newfile.asc' },
                languageId: 'plaintext'
            };
            
            callbacks.forEach(cb => cb(newDoc));
            assert.equal(newDoc.languageId, 'lsdyna');

            // Restore mock
            vscodeMock.workspace.textDocuments = originalTextDocuments;
            vscodeMock.workspace.onDidOpenTextDocument = originalOnDidOpenTextDocument;
            vscodeMock.workspace.getConfiguration = originalGet;
        });
    });

    describe('extension.configureManualsDir command', () => {
        it('should update manualsDir config globally and show success info', async () => {
            const originalShowOpenDialog = vscodeMock.window.showOpenDialog;
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            const originalShowInformationMessage = vscodeMock.window.showInformationMessage;
            
            let updateCalled = false;
            let updateKey, updateVal, updateTarget;
            
            vscodeMock.window.showOpenDialog = async () => [{ fsPath: '/path/to/manuals' }];
            vscodeMock.workspace.getConfiguration = () => ({
                update: async (key, val, target) => {
                    updateCalled = true;
                    updateKey = key;
                    updateVal = val;
                    updateTarget = target;
                }
            });
            
            let infoMsg = '';
            vscodeMock.window.showInformationMessage = (msg) => {
                infoMsg = msg;
            };

            const extension = require('../../../src/extension');
            
            let registeredCallback;
            const originalRegisterCommand = vscodeMock.commands.registerCommand;
            vscodeMock.commands.registerCommand = (cmd, cb) => {
                if (cmd === 'extension.configureManualsDir') {
                    registeredCallback = cb;
                }
                return { dispose() {} };
            };

            const context = { subscriptions: [] };
            extension.activate(context);

            if (registeredCallback) {
                await registeredCallback();
            }

            assert.ok(updateCalled);
            assert.equal(updateKey, 'manualsDir');
            assert.equal(updateVal, '/path/to/manuals');
            assert.equal(updateTarget, vscodeMock.ConfigurationTarget.Global);
            assert.ok(infoMsg.includes('/path/to/manuals'));

            // Restore mocks
            vscodeMock.window.showOpenDialog = originalShowOpenDialog;
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            vscodeMock.window.showInformationMessage = originalShowInformationMessage;
            vscodeMock.commands.registerCommand = originalRegisterCommand;
        });

        it('should show error message if global config update fails', async () => {
            const originalShowOpenDialog = vscodeMock.window.showOpenDialog;
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            const originalShowErrorMessage = vscodeMock.window.showErrorMessage;
            
            vscodeMock.window.showOpenDialog = async () => [{ fsPath: '/path/to/manuals' }];
            vscodeMock.workspace.getConfiguration = () => ({
                update: async () => {
                    throw new Error('Permission Denied');
                }
            });
            
            let errorMsg = '';
            vscodeMock.window.showErrorMessage = (msg) => {
                errorMsg = msg;
            };

            const extension = require('../../../src/extension');
            
            let registeredCallback;
            const originalRegisterCommand = vscodeMock.commands.registerCommand;
            vscodeMock.commands.registerCommand = (cmd, cb) => {
                if (cmd === 'extension.configureManualsDir') {
                    registeredCallback = cb;
                }
                return { dispose() {} };
            };

            const context = { subscriptions: [] };
            extension.activate(context);

            if (registeredCallback) {
                await registeredCallback();
            }

            assert.ok(errorMsg.includes('Permission Denied'));

            vscodeMock.window.showOpenDialog = originalShowOpenDialog;
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            vscodeMock.window.showErrorMessage = originalShowErrorMessage;
            vscodeMock.commands.registerCommand = originalRegisterCommand;
        });
    });
});


