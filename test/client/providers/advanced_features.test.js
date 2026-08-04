'use strict';

const assert = require('assert');
const path = require('path');
const { fakeDoc, vscodeMock } = require('../../helpers');
const i18n = require('../../../src/core/i18n');
const { LsdynaIncludeTreeProvider } = require('../../../src/client/providers/includeTreeProvider');
const { LsdynaKeywordIndexProvider } = require('../../../src/client/providers/keywordIndexProvider');
const { publishProjectDiagnostics, LsdynaFieldCompletionProvider, getCardFieldsForLine, generateCommentLine, handleEnterIndentationRemoval, findNextDataLineInKeywordBlock, planAlignedLine, alignLineText, formatLineIfNeeded, setFormatLineErrorObserverForTesting, handleTabAlignment, handleSelectionChange, handleActiveEditorChangeForFormatting, getPathEntryRange, splitIncludePathEntry, formatPathEntryIfNeeded, collectIncludePathLengthDiagnostics, LsdynaDocumentFormattingEditProvider } = require('../../../src/extension')._internals;

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
            assert.equal(childItem.description, i18n.get('circular'));
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

        it('listSearchEntries returns unique include nodes with missing flags', () => {
            const provider = new LsdynaIncludeTreeProvider();
            provider.root = provider._buildRootFromSnapshot({
                graph: {
                    toTree: () => ({
                        filePath: '/project/main.k',
                        children: [
                            {
                                filePath: '/project/parts.k',
                                children: [],
                            },
                            {
                                filePath: '/project/missing.k',
                                missing: true,
                                children: [],
                            },
                            {
                                // duplicate path should be de-duplicated in search entries
                                filePath: '/project/parts.k',
                                children: [],
                            },
                        ],
                    }),
                },
            }, '/project/main.k');

            const entries = provider.listSearchEntries();
            assert.equal(entries.length, 3);
            assert.equal(entries[0].label, 'main.k');
            assert.equal(entries[1].label, 'parts.k');
            assert.equal(entries[2].label, 'missing.k');
            // Graph-marked missing and on-disk-absent fixtures both surface as missing for search.
            assert.equal(entries[2].missing, true);
            assert.equal(provider.getParent(entries[1].treeItem), provider.root);
            assert.equal(entries[1].treeItem, provider.root.children[0]);
        });

        it('listSearchEntries returns empty list when tree is not scanned', () => {
            const provider = new LsdynaIncludeTreeProvider();
            assert.deepEqual(provider.listSearchEntries(), []);
        });

        it('getLastScanRootName returns root basename after scan tree is built', () => {
            const provider = new LsdynaIncludeTreeProvider();
            assert.strictEqual(provider.getLastScanRootName(), null);

            provider.root = provider._buildRootFromSnapshot({
                graph: {
                    toTree: () => ({
                        filePath: '/project/jobs/front_lh.k',
                        children: [],
                    }),
                },
            }, '/project/jobs/front_lh.k');

            assert.strictEqual(provider.getLastScanRootName(), 'front_lh.k');
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

        it('listSearchEntries exposes keyword names and usages for QuickPick', () => {
            const provider = new LsdynaKeywordIndexProvider({
                shouldSkipAutomaticDocumentScan: () => false,
            });
            const keywordMap = new Map([
                ['PART', [
                    { filePath: '/project/a.key', lineIndex: 10 },
                    { filePath: '/project/b.key', lineIndex: 20 },
                ]],
                ['NODE', [
                    { filePath: '/project/a.key', lineIndex: 0 },
                ]],
            ]);
            provider.roots = provider._buildRootsFromKeywordMap(keywordMap, '/project');
            const entries = provider.listSearchEntries();
            assert.equal(entries.length, 2);
            assert.equal(entries[0].keyword, 'NODE');
            assert.equal(entries[0].usages.length, 1);
            assert.equal(entries[1].keyword, 'PART');
            assert.equal(entries[1].usages.length, 2);
            assert.equal(entries[1].treeItem.label, 'PART');
        });

        it('listSearchEntries returns empty list when index is empty', () => {
            const provider = new LsdynaKeywordIndexProvider();
            assert.deepEqual(provider.listSearchEntries(), []);
        });
    });

    describe('publishProjectDiagnostics', () => {
        it('publishes warnings for missing files and errors for cycles at exact source ranges', () => {
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            vscodeMock.workspace.getConfiguration = () => ({
                get: (key, defaultValue) => key === 'language' ? 'zh-cn' : defaultValue
            });
            i18n.updateLanguage();

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

            try {
                publishProjectDiagnostics(snapshot, diagnosticsCollection);

                // Verified both files were cleared first
                assert.deepEqual(diagnosticsCollection.deletedFiles.sort(), ['/project/main.k', '/project/child.k'].sort());

                // Check diagnostics set
                const mainDiags = diagnosticsCollection.sets.get('/project/main.k');
                assert.equal(mainDiags.length, 1);
                assert.equal(mainDiags[0].message, i18n.get('includedFileNotFound', 'missing.k'));
                assert.equal(mainDiags[0].severity, vscodeMock.DiagnosticSeverity.Warning);
                assert.equal(mainDiags[0].range.start.line, 2);
                assert.equal(mainDiags[0].range.start.character, 5);
                assert.equal(mainDiags[0].range.end.character, 15);

                const childDiags = diagnosticsCollection.sets.get('/project/child.k');
                assert.equal(childDiags.length, 1);
                assert.equal(childDiags[0].message, i18n.get('circularIncludeDependency', 'main.k -> child.k -> main.k'));
                assert.equal(childDiags[0].severity, vscodeMock.DiagnosticSeverity.Error);
                assert.equal(childDiags[0].range.start.line, 4);
                assert.equal(childDiags[0].range.start.character, 10);
                assert.equal(childDiags[0].range.end.character, 25);
            } finally {
                vscodeMock.workspace.getConfiguration = originalGetConfiguration;
                i18n.updateLanguage();
            }
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
            assert.equal(templateItem.label, i18n.get('rowTemplateLabel', 1));
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
            const templates = items.filter(item => item.detail === i18n.get('rowTemplateDetail'));
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
                const expected = '$#   secid       mid    elform';
                assert.strictEqual(result, expected);
            });

            it('should not pad single wide path comment fields beyond 80 characters', () => {
                const { generateCommentLine } = require('../../../src/extension')._internals;
                const result = generateCommentLine([{ n: 'PATH', p: 0, w: 512 }]);

                assert.strictEqual(result, '$# path');
                assert.ok(result.length <= 80);
            });
        });

        it('should return $# completion item with documentation when typing $ under a keyword block', () => {
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            vscodeMock.workspace.getConfiguration = () => ({
                get: (key, defaultValue) => key === 'language' ? 'en' : defaultValue
            });
            i18n.updateLanguage();

            const provider = new LsdynaFieldCompletionProvider();
            const document = fakeDoc('*SECTION_SHELL\n$ some extra trailing space and text\n', '/project/main.k');
            document.languageId = 'lsdyna';

            try {
                const pos = new vscodeMock.Position(1, 1); // cursor after '$'
                const items = provider.provideCompletionItems(document, pos);

                assert.strictEqual(items.length, 1);
                const item = items[0];
                assert.strictEqual(item.label, item.insertText.trimEnd());
                assert.strictEqual(item.detail, i18n.get('fieldCommentCompletionDetail'));
                assert.ok(item.label.includes('secid'));
                assert.ok(item.insertText.includes('$#   secid'));
                assert.ok(item.documentation.value.includes(i18n.get('fieldCommentCompletionTitle')));
                assert.ok(item.documentation.value.includes(i18n.get('fieldCommentCompletionInsertHint')));
                assert.ok(item.documentation.value.includes('$#   secid'));
                
                // The range should cover the entire line to wipe out trailing spaces and text
                assert.strictEqual(item.range.start.line, 1);
                assert.strictEqual(item.range.start.character, 0);
                assert.strictEqual(item.range.end.line, 1);
                assert.strictEqual(item.range.end.character, 36);
            } finally {
                vscodeMock.workspace.getConfiguration = originalGetConfiguration;
                i18n.updateLanguage();
            }
        });

        it('does not resolve a field-header completion across the next keyword boundary', () => {
            const provider = new LsdynaFieldCompletionProvider();
            const document = fakeDoc(
                '*NODE\n' +
                '       1             0.0             0.0             0.0\n' +
                '$#\n' +
                '*SECTION_SHELL\n' +
                '\n',
                '/project/main.k'
            );
            document.languageId = 'lsdyna';

            const items = provider.provideCompletionItems(
                document,
                new vscodeMock.Position(2, 2)
            );

            assert.deepEqual(items, []);
        });

        it('finds the next data line in the same block while skipping indented comments', () => {
            const document = fakeDoc(
                '*SECTION_SHELL\n' +
                '$#\n' +
                '   $ ordinary comment\n' +
                '         1         2\n',
                '/project/main.k'
            );

            assert.equal(findNextDataLineInKeywordBlock(document, 2), 3);
        });

        it('localizes row template completion documentation in Chinese', () => {
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            vscodeMock.workspace.getConfiguration = () => ({
                get: (key, defaultValue) => key === 'language' ? 'zh-cn' : defaultValue
            });
            i18n.updateLanguage();

            try {
                const provider = new LsdynaFieldCompletionProvider();
                const document = fakeDoc('*NODE\n\n', '/project/main.k');
                document.languageId = 'lsdyna';

                const items = provider.provideCompletionItems(document, new vscodeMock.Position(1, 0));
                const templateItem = items[0];

                assert.equal(templateItem.documentation.value, i18n.get('rowTemplateDocumentation'));
            } finally {
                vscodeMock.workspace.getConfiguration = originalGetConfiguration;
                i18n.updateLanguage();
            }
        });

        it('should return CONTACT optional card comment completion based on data line count', () => {
            const provider = new LsdynaFieldCompletionProvider();
            const document = fakeDoc([
                '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
                'base card 1',
                'base card 2',
                'base card 3',
                'optional card A',
                'optional card B',
                'optional card C',
                'optional card D',
                'optional card E',
                '$',
                ''
            ].join('\n'), '/project/main.k');
            document.languageId = 'lsdyna';

            const pos = new vscodeMock.Position(9, 1);
            const items = provider.provideCompletionItems(document, pos);

            assert.strictEqual(items.length, 1);
            assert.strictEqual(items[0].label, items[0].insertText.trimEnd());
            assert.ok(items[0].label.includes('pstiff'));
            assert.ok(items[0].insertText.includes('pstiff'));
            assert.ok(items[0].documentation.value.includes('pstiff'));
        });
    });

    describe('handleEnterIndentationRemoval', () => {
        it('should delete auto-copied spaces on enter key press', async () => {
            const document = fakeDoc('        line 1\n        ', '/project/main.k');
            document.languageId = 'lsdyna';

            let deleteCalled = false;
            let deletedRange = null;

            const activeEditor = {
                document,
                edit: async (callback) => {
                    const editBuilder = {
                        delete: (range) => {
                            deleteCalled = true;
                            deletedRange = range;
                        }
                    };
                    callback(editBuilder);
                }
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = activeEditor;

            const event = {
                document,
                contentChanges: [{
                    range: new vscodeMock.Range(0, 14, 0, 14),
                    rangeLength: 0,
                    text: '\n        '
                }]
            };

            await handleEnterIndentationRemoval(event);

            assert.ok(deleteCalled);
            assert.strictEqual(deletedRange.start.line, 1);
            assert.strictEqual(deletedRange.start.character, 0);
            assert.strictEqual(deletedRange.end.line, 1);
            assert.strictEqual(deletedRange.end.character, 8);

            // Restore
            vscodeMock.window.activeTextEditor = originalActiveTextEditor;
        });

        it('clears auto-copied indentation for every cursor or none', async () => {
            const document = fakeDoc('line 1\n    \nline 2\n\t', '/project/main.k');
            document.languageId = 'lsdyna';
            const deletedRanges = [];
            const activeEditor = {
                document,
                edit: async callback => {
                    callback({ delete: range => deletedRanges.push(range) });
                    return true;
                },
            };
            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = activeEditor;

            try {
                await handleEnterIndentationRemoval({
                    document,
                    contentChanges: [
                        {
                            range: new vscodeMock.Range(0, 6, 0, 6),
                            rangeLength: 0,
                            text: '\n    ',
                        },
                        {
                            range: new vscodeMock.Range(1, 6, 1, 6),
                            rangeLength: 0,
                            text: '\n\t',
                        },
                    ],
                });

                assert.deepEqual(
                    deletedRanges.map(range => [
                        range.start.line,
                        range.start.character,
                        range.end.line,
                        range.end.character,
                    ]),
                    [
                        [1, 0, 1, 4],
                        [3, 0, 3, 1],
                    ],
                );
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
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

        it('preserves the entire line when a token exceeds its field width', () => {
            const cardFields = [
                { n: 'SECID', p: 0, w: 10 },
                { n: 'MID', p: 10, w: 10 }
            ];
            const rawText = '12345678901 2';
            const result = planAlignedLine(rawText, cardFields);

            assert.equal(result.status, 'unsafe');
            assert.equal(result.reason, 'field-overflow');
            assert.equal(result.text, rawText);
            assert.equal(alignLineText(rawText, cardFields), rawText);
        });

        it('does not truncate an over-width PRMR value', () => {
            const cardFields = [
                { n: 'PRMR1', p: 0, w: 8 },
                { n: 'VALUE', p: 8, w: 8 }
            ];
            const rawText = 'Rparameter_name 2';
            const result = planAlignedLine(rawText, cardFields);

            assert.equal(result.status, 'unsafe');
            assert.equal(result.text, rawText);
        });

        it('keeps safe PRMR normalization behavior when the value fits', () => {
            const cardFields = [
                { n: 'PRMR1', p: 0, w: 8 },
                { n: 'VALUE', p: 8, w: 8 }
            ];
            const result = planAlignedLine('Rfoo 2', cardFields);

            assert.equal(result.status, 'aligned');
            assert.equal(result.text.slice(0, 8), 'R foo   ');
            assert.equal(result.text.slice(8, 16), '       2');
        });

        it('still aligns a safe $# field-header line', () => {
            const cardFields = [
                { n: 'SECID', p: 0, w: 10 },
                { n: 'MID', p: 10, w: 10 }
            ];
            const result = planAlignedLine('$# secid mid', cardFields, true);

            assert.equal(result.status, 'aligned');
            assert.equal(result.text, '$#   secid       mid');
        });
    });

    describe('handleTabAlignment', () => {
        it('fails closed without partially rewriting a multi-cursor edit', async () => {
            const document = fakeDoc('*NODE\n1\n2\n', '/project/main.k');
            document.languageId = 'lsdyna';
            let editCalled = false;
            let selectionSet = false;
            let selectionVal = new vscodeMock.Selection(
                new vscodeMock.Position(1, 0),
                new vscodeMock.Position(1, 0),
            );
            const originalSelections = [
                selectionVal,
                new vscodeMock.Selection(
                    new vscodeMock.Position(2, 0),
                    new vscodeMock.Position(2, 0),
                ),
            ];
            const editor = {
                document,
                selections: originalSelections,
                edit: async () => {
                    editCalled = true;
                    return true;
                },
                get selection() { return selectionVal; },
                set selection(value) {
                    selectionSet = true;
                    selectionVal = value;
                },
            };

            await handleTabAlignment(editor, 1);

            assert.equal(editCalled, false);
            assert.equal(selectionSet, false);
            assert.strictEqual(editor.selections, originalSelections);
        });

        for (const [label, line] of [
            ['valid comma-delimited', '1,2,3,4'],
            ['ambiguous whitespace-collapsed', '1 2 3 4'],
        ]) {
            it(`hands a ${label} card back to native Tab without rewriting it`, async () => {
                const document = fakeDoc(`*NODE\n${line}\n`, '/project/main.k');
                document.languageId = 'lsdyna';
                let editCalled = false;
                let selectionSet = false;
                let delegatedCommand = null;
                let selectionVal = new vscodeMock.Selection(
                    new vscodeMock.Position(1, 0),
                    new vscodeMock.Position(1, 0),
                );
                const editor = {
                    document,
                    edit: async () => {
                        editCalled = true;
                        return true;
                    },
                    get selection() { return selectionVal; },
                    set selection(value) {
                        selectionSet = true;
                        selectionVal = value;
                    },
                };
                const originalExecuteCommand = vscodeMock.commands.executeCommand;
                vscodeMock.commands.executeCommand = async command => {
                    delegatedCommand = command;
                };

                try {
                    await handleTabAlignment(editor, 1);
                    assert.equal(editCalled, false);
                    assert.equal(selectionSet, false);
                    assert.equal(delegatedCommand, 'tab');
                } finally {
                    vscodeMock.commands.executeCommand = originalExecuteCommand;
                }
            });
        }

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

        it('uses the invoking caret when an older selection event arrives while Tab is pending', async () => {
            const document = fakeDoc('*NODE\n12323\n', '/project/main.k');
            document.languageId = 'lsdyna';
            let selectionVal = new vscodeMock.Selection(
                new vscodeMock.Position(1, 0),
                new vscodeMock.Position(1, 0),
            );
            const editor = {
                document,
                selections: [selectionVal],
                edit: async callback => {
                    callback({ replace: () => {} });
                    return true;
                },
                get selection() { return selectionVal; },
                set selection(value) {
                    selectionVal = value;
                    this.selections = [value];
                },
            };
            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;

            try {
                const tabPromise = handleTabAlignment(editor, 1);
                selectionVal = new vscodeMock.Selection(
                    new vscodeMock.Position(1, 16),
                    new vscodeMock.Position(1, 16),
                );
                editor.selections = [selectionVal];
                handleSelectionChange({ textEditor: editor });
                await tabPromise;

                assert.equal(selectionVal.active.line, 1);
                assert.equal(selectionVal.active.character, 9);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('leaves whitespace-collapsed multi-value lines to native Tab', async () => {
            const document = fakeDoc('*NODE\n1 2 3 4\n', '/project/main.k');
            document.languageId = 'lsdyna';
            let editCalled = false;
            let delegatedCommand = null;
            let selectionVal = new vscodeMock.Selection(new vscodeMock.Position(1, 0), new vscodeMock.Position(1, 0));
            const editor = {
                document,
                edit: async () => {
                    editCalled = true;
                    return true;
                },
                get selection() { return selectionVal; },
                set selection(v) { selectionVal = v; },
            };
            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            const originalExecuteCommand = vscodeMock.commands.executeCommand;
            vscodeMock.window.activeTextEditor = editor;
            vscodeMock.commands.executeCommand = async command => {
                delegatedCommand = command;
            };
            try {
                await handleTabAlignment(editor, 1);
                assert.equal(editCalled, false);
                assert.equal(delegatedCommand, 'tab');
                assert.equal(selectionVal.active.character, 0);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
                vscodeMock.commands.executeCommand = originalExecuteCommand;
            }
        });

        it('hands an unsafe over-width line back to native Tab without guessed navigation', async () => {
            const document = fakeDoc('*NODE\n123456789 2 3 4\n', '/project/main.k');
            document.languageId = 'lsdyna';
            let editCalled = false;
            let delegatedCommand = null;
            let selectionVal = new vscodeMock.Selection(
                new vscodeMock.Position(1, 0),
                new vscodeMock.Position(1, 0)
            );
            const editor = {
                document,
                edit: async () => {
                    editCalled = true;
                    return true;
                },
                get selection() { return selectionVal; },
                set selection(v) { selectionVal = v; },
            };

            const originalExecuteCommand = vscodeMock.commands.executeCommand;
            vscodeMock.commands.executeCommand = async command => {
                delegatedCommand = command;
            };
            try {
                await handleTabAlignment(editor, 1);

                assert.equal(editCalled, false);
                assert.equal(selectionVal.active.character, 0);
                assert.equal(delegatedCommand, 'tab');
            } finally {
                vscodeMock.commands.executeCommand = originalExecuteCommand;
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

        it('advances from a field whose start touches the previous empty field boundary', async () => {
            const dataLine = '       1.0       1.0                           1.0       1.0       1.0       1.0';
            const document = fakeDoc(
                '*CONTACT_AUTOMATIC_SINGLE_SURFACE\n' +
                '$#   surfa     surfb  surfatyp  surfbtyp   saboxid   sbboxid      sapr      sbpr\n' +
                '                             0         0                             0         0\n' +
                '$#      fs        fd        dc        vc       vdc    penchk        bt        dt\n' +
                '       0.0       0.0       0.0       0.0       0.0                 0.0   1.0E+20\n' +
                '$#    sfsa      sfsb      sast      sbst     sfsat     sfsbt       fsf       vsf\n' +
                dataLine + '\n',
                '/project/main.k'
            );
            document.languageId = 'lsdyna';

            let selectionVal = new vscodeMock.Selection(
                new vscodeMock.Position(6, 30),
                new vscodeMock.Position(6, 40)
            );
            const editor = {
                document,
                edit: async (callback) => {
                    callback({ replace() {} });
                    return true;
                },
                get selection() { return selectionVal; },
                set selection(v) { selectionVal = v; }
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;

            try {
                await handleTabAlignment(editor);
                assert.equal(selectionVal.active.line, 6);
                assert.equal(selectionVal.active.character, 40);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('Tab from full previous exclusive end advances to next field (does not skip)', async () => {
            // *NODE: NID w=8, X w=16. Full NID exclusive end = col 8 = X start.
            // Without tab-nav ownership, fieldIndexAt(8)=1 → Tab would land on Y (skip X).
            // With ownership, current=NID → Tab selects X (keep-separator start 9, end 24).
            const document = fakeDoc('*NODE\n12345678               0               0\n', '/project/main.k');
            document.languageId = 'lsdyna';
            let selectionVal = new vscodeMock.Selection(
                new vscodeMock.Position(1, 8),
                new vscodeMock.Position(1, 8)
            );
            const editor = {
                document,
                edit: async (callback) => {
                    callback({ replace() {} });
                    return true;
                },
                get selection() { return selectionVal; },
                set selection(v) { selectionVal = v; },
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;
            try {
                await handleTabAlignment(editor, 1);
                // Selection is built as Selection(selEnd, selStart); active is the nav left edge.
                assert.equal(selectionVal.active.line, 1);
                assert.equal(selectionVal.active.character, 9);
                assert.equal(selectionVal.anchor.character, 24);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('Tab from empty previous field start still advances (no loop)', async () => {
            // Empty NID; caret at X start (col 8) after Tab into empty X.
            // Geometric current = X → Tab must advance to Y (not re-select X).
            // *NODE X ends at 24; Y starts at 24; prev X may be empty → sel at 24.
            const document = fakeDoc('*NODE\n                                 0\n', '/project/main.k');
            document.languageId = 'lsdyna';
            let selectionVal = new vscodeMock.Selection(
                new vscodeMock.Position(1, 8),
                new vscodeMock.Position(1, 8)
            );
            const editor = {
                document,
                edit: async (callback) => {
                    callback({ replace() {} });
                    return true;
                },
                get selection() { return selectionVal; },
                set selection(v) { selectionVal = v; },
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;
            try {
                await handleTabAlignment(editor, 1);
                assert.equal(selectionVal.active.line, 1);
                // Y is field 2 at p=24; empty X → no keep-separator → active at 24
                assert.equal(selectionVal.active.character, 24);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('Shift+Tab at next-field start after full previous goes to previous field', async () => {
            const document = fakeDoc('*NODE\n12345678               0               0\n', '/project/main.k');
            document.languageId = 'lsdyna';
            // Caret at col 8: geometric field X; Shift+Tab must select NID [0,8), not skip past it.
            let selectionVal = new vscodeMock.Selection(
                new vscodeMock.Position(1, 8),
                new vscodeMock.Position(1, 8)
            );
            const editor = {
                document,
                edit: async (callback) => {
                    callback({ replace() {} });
                    return true;
                },
                get selection() { return selectionVal; },
                set selection(v) { selectionVal = v; },
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;
            try {
                await handleTabAlignment(editor, -1);
                assert.equal(selectionVal.active.line, 1);
                // First field: Selection(selEnd=8, selStart=0) → active 0, anchor 8
                assert.equal(selectionVal.active.character, 0);
                assert.equal(selectionVal.anchor.character, 8);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });
    });

    describe('Selection context key setting', () => {
        it('sets shouldAlignTab context based on current line card applicability', async () => {
            const contextMap = Object.create(null);
            const originalExecuteCommand = vscodeMock.commands.executeCommand;
            vscodeMock.commands.executeCommand = async (cmd, ...args) => {
                if (cmd === 'setContext') {
                    contextMap[args[0]] = args[1];
                }
                return originalExecuteCommand ? originalExecuteCommand(cmd, ...args) : undefined;
            };

            try {
                const document = fakeDoc('*NODE\n12323\n$ Comment\n', '/project/main.k');
                document.languageId = 'lsdyna';
                
                // Simulate editor select line 1 (data line)
                const editor = {
                    document,
                    selection: {
                        active: new vscodeMock.Position(1, 2),
                        start: new vscodeMock.Position(1, 2),
                        end: new vscodeMock.Position(1, 2),
                        isEmpty: true,
                    },
                };

                // Invoke internals handler trigger
                const { handleSelectionChange } = require('../../../src/extension')._internals;
                
                handleSelectionChange(editor);
                assert.equal(contextMap['lsdyna.shouldAlignTab'], true);
                // Caret inside a card field also enables cell-edit protect context
                assert.equal(contextMap['lsdyna.cellEditActive'], true);

                // Simulate editor select line 2 (comment line)
                editor.selection = {
                    active: new vscodeMock.Position(2, 2),
                    start: new vscodeMock.Position(2, 2),
                    end: new vscodeMock.Position(2, 2),
                    isEmpty: true,
                };
                handleSelectionChange(editor);
                assert.equal(contextMap['lsdyna.shouldAlignTab'], false);
                assert.equal(contextMap['lsdyna.cellEditActive'], false);
            } finally {
                vscodeMock.commands.executeCommand = originalExecuteCommand;
            }
        });

        it('preserves ordinary mouse drag selections that happen to match a field value', () => {
            const dataLine = '       1.0       1.0                           1.0       1.0       1.0       1.0';
            const document = fakeDoc(
                '*AIRBAG_ADIABATIC_GAS_MODEL\n' +
                '         0\n' +
                dataLine + '\n',
                '/project/main.k'
            );
            const makePosition = (line, character) => {
                const position = new vscodeMock.Position(line, character);
                position.isEqual = other => other && position.line === other.line && position.character === other.character;
                return position;
            };
            const valueStart = dataLine.lastIndexOf('1.0');
            document.languageId = 'lsdyna';
            document.getWordRangeAtPosition = () => ({
                start: makePosition(2, valueStart),
                end: makePosition(2, dataLine.length),
                isEqual: range => range && range.start.character === valueStart && range.end.character === dataLine.length,
            });

            const dragSelection = {
                start: makePosition(2, valueStart),
                end: makePosition(2, dataLine.length),
                anchor: makePosition(2, dataLine.length),
                active: makePosition(2, valueStart),
                isEmpty: false,
            };
            let selectionValue = dragSelection;
            const editor = {
                document,
                get selection() { return selectionValue; },
                set selection(value) { selectionValue = value; },
            };

            handleSelectionChange({ textEditor: editor, kind: 2, selections: [dragSelection] });

            assert.strictEqual(selectionValue, dragSelection);
        });

        it('does not auto-format when autoFormat is unset', () => {
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            const originalApplyEdit = vscodeMock.workspace.applyEdit;
            let applyEditCount = 0;

            vscodeMock.workspace.getConfiguration = () => ({
                get: () => undefined,
            });
            vscodeMock.workspace.applyEdit = () => {
                applyEditCount += 1;
                return Promise.resolve(true);
            };

            try {
                const resetDoc = fakeDoc('$ reset\n', '/project/reset.txt');
                resetDoc.languageId = 'plaintext';
                handleSelectionChange({
                    document: resetDoc,
                    selection: { active: new vscodeMock.Position(0, 0) }
                });

                const document = fakeDoc('*NODE\n1 2 3\n$ Comment\n', '/project/main.k');
                document.languageId = 'lsdyna';
                const editor = {
                    document,
                    selection: { active: new vscodeMock.Position(1, 0) }
                };

                handleSelectionChange(editor);
                editor.selection.active = new vscodeMock.Position(2, 0);
                handleSelectionChange(editor);

                assert.equal(applyEditCount, 0);
            } finally {
                vscodeMock.workspace.getConfiguration = originalGetConfiguration;
                vscodeMock.workspace.applyEdit = originalApplyEdit;
            }
        });

        it('does not format the previous editor when autoFormat is disabled', async () => {
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            const originalApplyEdit = vscodeMock.workspace.applyEdit;
            let applyEditCount = 0;

            vscodeMock.workspace.getConfiguration = () => ({
                get: (key, defaultValue) => key === 'autoFormat' ? 'disabled' : defaultValue,
            });
            vscodeMock.workspace.applyEdit = async () => {
                applyEditCount += 1;
                return true;
            };

            try {
                const resetDoc = fakeDoc('$ reset\n', '/project/reset.txt');
                resetDoc.languageId = 'plaintext';
                handleSelectionChange({
                    document: resetDoc,
                    selection: { active: new vscodeMock.Position(0, 0) }
                });

                const previousDoc = fakeDoc('*NODE\n1 2 3\n', '/project/previous.k');
                previousDoc.languageId = 'lsdyna';
                handleSelectionChange({
                    document: previousDoc,
                    selection: { active: new vscodeMock.Position(1, 0) }
                });

                const nextDoc = fakeDoc('*NODE\n\n', '/project/next.k');
                nextDoc.languageId = 'lsdyna';
                await handleActiveEditorChangeForFormatting({
                    document: nextDoc,
                    selection: { active: new vscodeMock.Position(1, 0) }
                });

                assert.equal(applyEditCount, 0);
            } finally {
                vscodeMock.workspace.getConfiguration = originalGetConfiguration;
                vscodeMock.workspace.applyEdit = originalApplyEdit;
            }
        });

        it('formats the previous editor on switch only when autoFormat is onBlur', async () => {
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            const originalApplyEdit = vscodeMock.workspace.applyEdit;
            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            let appliedEdits = [];

            vscodeMock.workspace.getConfiguration = () => ({
                get: (key, defaultValue) => key === 'autoFormat' ? 'onBlur' : defaultValue,
            });
            vscodeMock.workspace.applyEdit = async edit => {
                appliedEdits = edit.edits;
                return true;
            };

            try {
                const resetDoc = fakeDoc('$ reset\n', '/project/reset.txt');
                resetDoc.languageId = 'plaintext';
                handleSelectionChange({
                    document: resetDoc,
                    selection: { active: new vscodeMock.Position(0, 0) }
                });

                const previousDoc = fakeDoc('*NODE\n1 2 3\n', '/project/previous.k');
                previousDoc.languageId = 'lsdyna';
                handleSelectionChange({
                    document: previousDoc,
                    selection: { active: new vscodeMock.Position(1, 0) }
                });

                const nextDoc = fakeDoc('*NODE\n\n', '/project/next.k');
                nextDoc.languageId = 'lsdyna';
                const nextEditor = {
                    document: nextDoc,
                    selection: { active: new vscodeMock.Position(1, 0) }
                };
                vscodeMock.window.activeTextEditor = nextEditor;
                await handleActiveEditorChangeForFormatting(nextEditor);

                assert.equal(appliedEdits.length, 1);
                assert.equal(appliedEdits[0].uri, previousDoc.uri);
                assert.notEqual(appliedEdits[0].text, '1 2 3');
            } finally {
                vscodeMock.workspace.getConfiguration = originalGetConfiguration;
                vscodeMock.workspace.applyEdit = originalApplyEdit;
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('does not dirty the previous document when the last editor closes', async () => {
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            const originalApplyEdit = vscodeMock.workspace.applyEdit;
            let applyEditCount = 0;

            vscodeMock.workspace.getConfiguration = () => ({
                get: (key, defaultValue) => key === 'autoFormat' ? 'onBlur' : defaultValue,
            });
            vscodeMock.workspace.applyEdit = async () => {
                applyEditCount += 1;
                return true;
            };

            try {
                const previousDoc = fakeDoc('*NODE\n1 2 3\n', '/project/closing.k');
                previousDoc.languageId = 'lsdyna';
                handleSelectionChange({
                    document: previousDoc,
                    selection: { active: new vscodeMock.Position(1, 0) }
                });

                await handleActiveEditorChangeForFormatting(undefined);

                assert.equal(applyEditCount, 0);
            } finally {
                vscodeMock.workspace.getConfiguration = originalGetConfiguration;
                vscodeMock.workspace.applyEdit = originalApplyEdit;
            }
        });

        it('does not retarget onBlur formatting from an inactive editor selection event', async () => {
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            const originalApplyEdit = vscodeMock.workspace.applyEdit;
            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            const appliedUris = [];

            vscodeMock.workspace.getConfiguration = () => ({
                get: (key, defaultValue) => key === 'autoFormat' ? 'onBlur' : defaultValue,
            });
            vscodeMock.workspace.applyEdit = async edit => {
                appliedUris.push(...edit.edits.map(item => item.uri));
                return true;
            };

            const makeEditor = (filePath, line) => {
                const document = fakeDoc(`*NODE\n${line}\n`, filePath);
                document.languageId = 'lsdyna';
                return {
                    document,
                    selection: { active: new vscodeMock.Position(1, 0) },
                };
            };
            const activeEditor = makeEditor('/project/active-condition.k', '1 2 3');
            const inactiveEditor = makeEditor('/project/inactive-condition.k', '4 5 6');
            const nextEditor = makeEditor('/project/next-condition.k', '7 8 9');
            const resetEditor = {
                document: Object.assign(fakeDoc('$ reset\n', '/project/reset.txt'), {
                    languageId: 'plaintext',
                }),
                selection: { active: new vscodeMock.Position(0, 0) },
            };

            try {
                vscodeMock.window.activeTextEditor = resetEditor;
                handleSelectionChange(resetEditor);
                vscodeMock.window.activeTextEditor = activeEditor;
                handleSelectionChange(activeEditor);

                // The VS Code event carries the editor whose selection changed;
                // it is not guaranteed to be the active editor in a split view.
                handleSelectionChange({
                    textEditor: inactiveEditor,
                    selections: [inactiveEditor.selection],
                    kind: 3,
                });

                vscodeMock.window.activeTextEditor = nextEditor;
                await handleActiveEditorChangeForFormatting(nextEditor);

                assert.deepEqual(appliedUris, [activeEditor.document.uri]);
            } finally {
                vscodeMock.window.activeTextEditor = resetEditor;
                handleSelectionChange(resetEditor);
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
                vscodeMock.workspace.getConfiguration = originalGetConfiguration;
                vscodeMock.workspace.applyEdit = originalApplyEdit;
            }
        });

        it('preserves the previous onBlur target when the new editor selection event arrives first', async () => {
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            const originalApplyEdit = vscodeMock.workspace.applyEdit;
            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            const appliedUris = [];

            vscodeMock.workspace.getConfiguration = () => ({
                get: (key, defaultValue) => key === 'autoFormat' ? 'onBlur' : defaultValue,
            });
            vscodeMock.workspace.applyEdit = async edit => {
                appliedUris.push(...edit.edits.map(item => item.uri));
                return true;
            };

            const makeEditor = (filePath, line) => {
                const document = fakeDoc(`*NODE\n${line}\n`, filePath);
                document.languageId = 'lsdyna';
                return {
                    document,
                    selection: { active: new vscodeMock.Position(1, 0) },
                };
            };
            const previousEditor = makeEditor('/project/event-order-previous.k', '1 2 3');
            const nextEditor = makeEditor('/project/event-order-next.k', '7 8 9');
            const resetEditor = {
                document: Object.assign(fakeDoc('$ reset\n', '/project/reset.txt'), {
                    languageId: 'plaintext',
                }),
                selection: { active: new vscodeMock.Position(0, 0) },
            };

            try {
                vscodeMock.window.activeTextEditor = resetEditor;
                handleSelectionChange(resetEditor);
                vscodeMock.window.activeTextEditor = previousEditor;
                handleSelectionChange(previousEditor);

                // VS Code may publish the new editor's selection before its
                // onDidChangeActiveTextEditor listener has consumed the transition.
                vscodeMock.window.activeTextEditor = nextEditor;
                handleSelectionChange({
                    textEditor: nextEditor,
                    selections: [nextEditor.selection],
                    kind: 3,
                });
                await handleActiveEditorChangeForFormatting(nextEditor);

                assert.deepEqual(appliedUris, [previousEditor.document.uri]);
            } finally {
                vscodeMock.window.activeTextEditor = resetEditor;
                handleSelectionChange(resetEditor);
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
                vscodeMock.workspace.getConfiguration = originalGetConfiguration;
                vscodeMock.workspace.applyEdit = originalApplyEdit;
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
        it('enforces the 80/156/236 LS-DYNA path boundaries', () => {
            const cases = [
                [80, 'unchanged', 1],
                [81, 'formatted', 2],
                [156, 'formatted', 2],
                [157, 'formatted', 3],
                [236, 'formatted', 3],
            ];

            for (const [length, status, lineCount] of cases) {
                const result = splitIncludePathEntry('x'.repeat(length));
                assert.equal(result.status, status, `length ${length}`);
                assert.equal(result.lines.length, lineCount, `length ${length}`);
                assert.ok(result.lines.every(line => line.length <= 80), `length ${length}`);
            }

            assert.deepEqual(splitIncludePathEntry('x'.repeat(237)), {
                status: 'tooLong',
                maxLength: 236,
                actualLength: 237,
            });
        });

        it('does not edit a 237-character path and emits an explicit diagnostic', async () => {
            const longPath = 'x'.repeat(237);
            const document = fakeDoc(
                `*INCLUDE_PATH\r\n${longPath}\r\n*INCLUDE\r\n${longPath}\r\n`,
                '/project/main.k'
            );
            let editCalled = false;
            const editor = {
                document,
                edit: async () => {
                    editCalled = true;
                    return true;
                },
            };
            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;

            try {
                const result = await formatPathEntryIfNeeded(document, 1, 0);
                const diagnostics = collectIncludePathLengthDiagnostics(document);

                assert.equal(result.status, 'tooLong');
                assert.equal(editCalled, false);
                assert.equal(diagnostics.length, 2);
                assert.ok(diagnostics.every(diagnostic => diagnostic.code === 'include-path-too-long'));
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

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

        it('wraps the maximum LS-DYNA include pathname length into three physical lines', async () => {
            const longPath = 'a'.repeat(78) + 'b'.repeat(78) + 'c'.repeat(80); // length 236
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
                await formatPathEntryIfNeeded(document, 1, 0);
                assert.ok(editCalled);
                assert.equal(
                    editVal,
                    'a'.repeat(78) + ' +\n' +
                    'b'.repeat(78) + ' +\n' +
                    'c'.repeat(80)
                );
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

        it('automatically wraps single 80-column *INCLUDE filename cards', async () => {
            const longPath = 'a'.repeat(78) + 'b'.repeat(12);
            const document = fakeDoc(`*INCLUDE\n${longPath}\n`, '/project/main.k');

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
                assert.equal(editVal, 'a'.repeat(78) + ' +\n' + 'b'.repeat(12));
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('leaves ordinary comments unchanged', async () => {
            const document = fakeDoc(
                '*SECTION_SHELL\n' +
                '$ Units: mm, ms, kg\n' +
                '         1         2',
                '/project/main.k'
            );
            document.languageId = 'lsdyna';
            let editCalled = false;
            const editor = {
                document,
                edit: async () => {
                    editCalled = true;
                    return true;
                }
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;
            try {
                await formatLineIfNeeded(document, 1);
                assert.equal(editCalled, false);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('leaves an unsafe over-width data line unchanged', async () => {
            const document = fakeDoc(
                '*SECTION_SHELL\n' +
                '12345678901 2',
                '/project/main.k'
            );
            document.languageId = 'lsdyna';
            let editCalled = false;
            const editor = {
                document,
                edit: async () => {
                    editCalled = true;
                    return true;
                }
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;
            try {
                await formatLineIfNeeded(document, 1);
                assert.equal(editCalled, false);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('does not call a TextEditor that became invisible during an async check', async () => {
            const document = fakeDoc('*NODE\n1 2 3\n', '/project/closing.k');
            document.languageId = 'lsdyna';
            let editCalled = false;
            const errors = [];
            const editor = {
                document,
                viewColumn: undefined,
                edit: async () => {
                    editCalled = true;
                    throw new Error('Illegal argument: TextEditor');
                },
            };
            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            vscodeMock.window.activeTextEditor = editor;
            setFormatLineErrorObserverForTesting(error => errors.push(error));

            try {
                await formatLineIfNeeded(document, 1);
                assert.equal(editCalled, false);
                assert.deepEqual(errors, []);
            } finally {
                setFormatLineErrorObserverForTesting(null);
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });

        it('keeps automatic line formatting single-flight across async readonly checks', async () => {
            const firstDocument = fakeDoc('*NODE\n1 2 3\n', '/project/first.k');
            const secondDocument = fakeDoc('*NODE\n4 5 6\n', '/project/second.k');
            firstDocument.languageId = 'lsdyna';
            secondDocument.languageId = 'lsdyna';
            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            const originalApplyEdit = vscodeMock.workspace.applyEdit;
            const appliedUris = [];
            let releaseApply;
            const applyGate = new Promise(resolve => {
                releaseApply = resolve;
            });

            vscodeMock.window.activeTextEditor = {
                document: fakeDoc('*NODE\n\n', '/project/current.k'),
            };
            vscodeMock.workspace.applyEdit = async edit => {
                appliedUris.push(...edit.edits.map(item => item.uri));
                await applyGate;
                return true;
            };

            try {
                const first = formatLineIfNeeded(firstDocument, 1);
                const second = formatLineIfNeeded(secondDocument, 1);
                await new Promise(resolve => setImmediate(resolve));

                assert.equal(appliedUris.length, 1);
                releaseApply();
                await Promise.all([first, second]);
            } finally {
                releaseApply();
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
                vscodeMock.workspace.applyEdit = originalApplyEdit;
            }
        });

        it('abandons automatic formatting when the document closes during the readonly check', async () => {
            const document = fakeDoc('*NODE\n1 2 3\n', '/project/closing.k');
            document.languageId = 'lsdyna';
            document.isClosed = false;
            const originalLineAt = document.lineAt.bind(document);
            document.lineAt = line => {
                if (document.isClosed) throw new Error('closed document accessed');
                return originalLineAt(line);
            };
            const originalGetConfiguration = vscodeMock.workspace.getConfiguration;
            const originalWorkspaceFs = vscodeMock.workspace.fs;
            const originalApplyEdit = vscodeMock.workspace.applyEdit;
            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            let releaseStat;
            const statGate = new Promise(resolve => {
                releaseStat = resolve;
            });
            let applyEditCount = 0;

            vscodeMock.workspace.getConfiguration = section => ({
                get: (key, defaultValue) =>
                    section === 'files' && key === 'readonlyFromPermissions'
                        ? true
                        : defaultValue,
            });
            vscodeMock.workspace.fs = {
                async stat() {
                    await statGate;
                    return { permissions: 0 };
                },
            };
            vscodeMock.workspace.applyEdit = async () => {
                applyEditCount += 1;
                return true;
            };
            vscodeMock.window.activeTextEditor = undefined;

            try {
                const formatting = formatLineIfNeeded(document, 1);
                document.isClosed = true;
                releaseStat();
                await formatting;
                assert.equal(applyEditCount, 0);
            } finally {
                releaseStat();
                vscodeMock.workspace.getConfiguration = originalGetConfiguration;
                vscodeMock.workspace.fs = originalWorkspaceFs;
                vscodeMock.workspace.applyEdit = originalApplyEdit;
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
            }
        });
    });

    describe('LsdynaDocumentFormattingEditProvider path wrapping', () => {
        it('does not emit edits for ordinary comments or unsafe data lines', () => {
            const provider = new LsdynaDocumentFormattingEditProvider();
            const commentDocument = fakeDoc(
                '*SECTION_SHELL\n' +
                '$ Units: mm, ms, kg\n' +
                '         1         2',
                '/project/comments.k'
            );
            commentDocument.languageId = 'lsdyna';
            const unsafeDocument = fakeDoc(
                '*SECTION_SHELL\n' +
                '12345678901 2',
                '/project/unsafe.k'
            );
            unsafeDocument.languageId = 'lsdyna';

            const commentEdits = provider.provideDocumentRangeFormattingEdits(
                commentDocument,
                new vscodeMock.Range(1, 0, 1, commentDocument.lineAt(1).text.length),
                {},
                {}
            );
            const unsafeEdits = provider.provideDocumentRangeFormattingEdits(
                unsafeDocument,
                new vscodeMock.Range(1, 0, 1, unsafeDocument.lineAt(1).text.length),
                {},
                {}
            );

            assert.deepEqual(commentEdits, []);
            assert.deepEqual(unsafeEdits, []);
        });

        it('formats long Windows *INCLUDE_PATH entries into LS-DYNA continuation lines', () => {
            const longPath = 'D:\\temp\\LSDYNA\\lsdyna_mat\\model\\sim_model\\temp\\LSDYNA\\lsdyna_mat\\model\\sim_model\\temp\\LSDYNA\\lsdyna_mat\\model\\sim_model';
            const document = fakeDoc(`*INCLUDE_PATH\n${longPath}\n`, 'D:\\project\\main.k');
            document.languageId = 'lsdyna';
            const provider = new LsdynaDocumentFormattingEditProvider();

            const edits = provider.provideDocumentRangeFormattingEdits(
                document,
                new vscodeMock.Range(0, 0, document.lineCount, 0),
                {},
                {}
            );

            assert.equal(edits.length, 1);
            assert.equal(
                edits[0].newText,
                longPath.slice(0, 78) + ' +\n' + longPath.slice(78)
            );
        });

        it('formats long *INCLUDE_PATH entries through the code lens command', async () => {
            const longPath = 'D:\\temp\\LSDYNA\\lsdyna_mat\\model\\sim_model\\temp\\LSDYNA\\lsdyna_mat\\model\\sim_model\\temp\\LSDYNA\\lsdyna_mat\\model\\sim_model';
            const document = fakeDoc(`*INCLUDE_PATH\n${longPath}\n`, 'D:\\project\\main.k');
            document.languageId = 'lsdyna';

            let editVal = '';
            const editor = {
                document,
                selection: { active: new vscodeMock.Position(1, 0) },
                selections: [new vscodeMock.Selection(
                    new vscodeMock.Position(0, 0),
                    new vscodeMock.Position(2, 0)
                )],
                setDecorations() {},
                edit: async (callback) => {
                    callback({
                        replace(_range, value) {
                            editVal = value;
                        },
                    });
                    return true;
                },
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            const originalRegisterCommand = vscodeMock.commands.registerCommand;
            const registeredCommands = new Map();
            vscodeMock.window.activeTextEditor = editor;
            vscodeMock.commands.registerCommand = (cmd, cb) => {
                registeredCommands.set(cmd, cb);
                return { dispose() {} };
            };

            try {
                const extension = require('../../../src/extension');
                await extension.activate({ subscriptions: [] });
                await registeredCommands.get('extension.lsdynaFormatSelection')(0);

                assert.equal(editVal, longPath.slice(0, 78) + ' +\n' + longPath.slice(78));
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
                vscodeMock.commands.registerCommand = originalRegisterCommand;
            }
        });

        it('keeps ordinary comments unchanged through the format-selection command', async () => {
            const document = fakeDoc(
                '*SECTION_SHELL\n' +
                '$ Units: mm, ms, kg\n' +
                '         1         2',
                '/project/main.k'
            );
            document.languageId = 'lsdyna';
            let replaceCount = 0;
            const commentSelection = new vscodeMock.Selection(
                new vscodeMock.Position(1, 0),
                new vscodeMock.Position(1, document.lineAt(1).text.length)
            );
            const editor = {
                document,
                selection: commentSelection,
                selections: [commentSelection],
                setDecorations() {},
                edit: async callback => {
                    callback({
                        replace() {
                            replaceCount += 1;
                        },
                    });
                    return true;
                },
            };

            const originalActiveTextEditor = vscodeMock.window.activeTextEditor;
            const originalRegisterCommand = vscodeMock.commands.registerCommand;
            const registeredCommands = new Map();
            vscodeMock.window.activeTextEditor = editor;
            vscodeMock.commands.registerCommand = (cmd, cb) => {
                registeredCommands.set(cmd, cb);
                return { dispose() {} };
            };

            try {
                const extension = require('../../../src/extension');
                await extension.activate({ subscriptions: [] });
                await registeredCommands.get('extension.lsdynaFormatSelection')();

                assert.equal(replaceCount, 0);
            } finally {
                vscodeMock.window.activeTextEditor = originalActiveTextEditor;
                vscodeMock.commands.registerCommand = originalRegisterCommand;
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
            await extension.activate(context);
            
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
            vscodeMock.window.showInformationMessage = (msg, ...items) => {
                infoMsg = msg;
                if (items.length > 0) {
                    return Promise.resolve(items[0]);
                }
                return Promise.resolve();
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
            await extension.activate(context);

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
            const originalShowInformationMessage = vscodeMock.window.showInformationMessage;
            vscodeMock.window.showInformationMessage = (msg, ...items) => {
                if (items.length > 0) {
                    return Promise.resolve(items[0]);
                }
                return Promise.resolve();
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
            await extension.activate(context);

            if (registeredCallback) {
                await registeredCallback();
            }

            assert.ok(errorMsg.includes('Permission Denied'));

            // Restore mocks
            vscodeMock.window.showOpenDialog = originalShowOpenDialog;
            vscodeMock.workspace.getConfiguration = originalGetConfiguration;
            vscodeMock.window.showErrorMessage = originalShowErrorMessage;
            vscodeMock.window.showInformationMessage = originalShowInformationMessage;
            vscodeMock.commands.registerCommand = originalRegisterCommand;
        });
    });
});
