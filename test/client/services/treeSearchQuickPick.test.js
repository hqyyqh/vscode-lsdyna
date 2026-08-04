'use strict';

const assert = require('assert');
const {
    matchScore,
    filterIncludeEntries,
    filterKeywordEntries,
    showIncludeSearchPick,
    showKeywordSearchPick,
} = require('../../../src/client/services/treeSearchQuickPick');

describe('treeSearchQuickPick', () => {
    describe('matchScore', () => {
        it('prefers prefix matches over substring matches', () => {
            assert.ok(matchScore('mat', 'MAT_001') > matchScore('mat', 'FOO_MAT_BAR'));
        });

        it('strips leading asterisk for keyword-style comparisons', () => {
            assert.ok(matchScore('*NODE', 'NODE') > 0);
            assert.ok(matchScore('NODE', '*NODE') > 0);
        });

        it('returns 0 when there is no match', () => {
            assert.equal(matchScore('shell', 'NODE'), 0);
        });

        it('treats empty query as a match-all score', () => {
            assert.ok(matchScore('', 'anything') > 0);
        });

        it('matches spaces to underscores and segment prefixes', () => {
            assert.ok(matchScore('control time', '*CONTROL_TIMESTEP') > 0);
            assert.ok(matchScore('con en', 'CONTROL_ENERGY') > 0);
        });
    });

    describe('filterIncludeEntries', () => {
        const entries = [
            { filePath: '/p/main.k', label: 'main.k', description: '', missing: false, treeItem: {} },
            { filePath: '/p/sub/parts.k', label: 'parts.k', description: 'sub', missing: false, treeItem: {} },
            { filePath: '/p/sub/missing.k', label: 'missing.k', description: 'sub', missing: true, treeItem: {} },
            {
                filePath: '/x/mesh/parts_shell.k',
                label: 'parts_shell.k',
                description: 'mesh',
                missing: false,
                treeItem: {},
            },
        ];

        it('returns all entries for empty query (bounded by limit)', () => {
            assert.equal(filterIncludeEntries(entries, '').length, 4);
            assert.equal(filterIncludeEntries(entries, '', 2).length, 2);
        });

        it('filters by basename label only (not path description)', () => {
            const byName = filterIncludeEntries(entries, 'parts');
            assert.ok(byName.some(e => e.label === 'parts.k'));
            assert.ok(byName.some(e => e.label === 'parts_shell.k'));

            // "sub" only appears in description/path — must not match label-only scoring
            const byPath = filterIncludeEntries(entries, 'sub');
            assert.equal(byPath.length, 0);
        });

        it('matches separator-insensitive file names', () => {
            const matched = filterIncludeEntries(entries, 'parts shell');
            assert.ok(matched.length >= 1);
            assert.equal(matched[0].label, 'parts_shell.k');
        });

        it('matches ro v3 against rogue-v3.key', () => {
            const rogue = [
                {
                    filePath: '/p/rogue-v3.key',
                    label: 'rogue-v3.key',
                    description: '',
                    missing: false,
                    treeItem: {},
                },
                { filePath: '/p/main.k', label: 'main.k', description: '', missing: false, treeItem: {} },
            ];
            const matched = filterIncludeEntries(rogue, 'ro v3');
            assert.ok(matched.some(e => e.label === 'rogue-v3.key'));
            assert.ok(filterIncludeEntries(rogue, 'rov3').some(e => e.label === 'rogue-v3.key'));
        });

        it('does not surface files only because absolute path contains Project', () => {
            const list = [
                {
                    filePath: 'D:\\Project\\models\\main.k',
                    label: 'main.k',
                    description: 'models',
                    missing: false,
                    treeItem: {},
                },
                {
                    filePath: 'D:\\Project\\rogue-v3.key',
                    label: 'rogue-v3.key',
                    description: '',
                    missing: false,
                    treeItem: {},
                },
            ];
            const matched = filterIncludeEntries(list, 'ro');
            assert.ok(matched.some(e => e.label === 'rogue-v3.key'));
            assert.ok(!matched.some(e => e.label === 'main.k'));
        });
    });

    describe('filterKeywordEntries', () => {
        const entries = [
            { keyword: 'NODE', usages: [{ filePath: '/a.k', lineIndex: 0 }], treeItem: {} },
            { keyword: 'ELEMENT_SHELL', usages: [{ filePath: '/a.k', lineIndex: 2 }], treeItem: {} },
            { keyword: 'MAT_001', usages: [], treeItem: {} },
            { keyword: '*CONTROL_TIMESTEP', usages: [], treeItem: {} },
            { keyword: '*CONTROL_ONLY', usages: [], treeItem: {} },
            { keyword: '*CONTROL_ENERGY', usages: [], treeItem: {} },
        ];

        it('filters keywords case-insensitively and ranks prefixes first', () => {
            const matched = filterKeywordEntries(entries, 'mat');
            assert.ok(matched.some(e => e.keyword === 'MAT_001'));
            assert.equal(matched[0].keyword, 'MAT_001');

            const prefix = filterKeywordEntries(entries, 'ELE');
            assert.equal(prefix.length, 1);
            assert.equal(prefix[0].keyword, 'ELEMENT_SHELL');
        });

        it('ranks CONTROL_TIMESTEP for control time over CONTROL_ONLY', () => {
            const matched = filterKeywordEntries(entries, 'control time');
            assert.ok(matched.length >= 1);
            assert.equal(matched[0].keyword, '*CONTROL_TIMESTEP');
        });

        it('matches con en to CONTROL_ENERGY', () => {
            const matched = filterKeywordEntries(entries, 'con en');
            assert.ok(matched.some(e => e.keyword === '*CONTROL_ENERGY'));
        });
    });

    describe('showIncludeSearchPick', () => {
        it('prompts for scan when empty and reopens after getEntries fills', async () => {
            let scanned = false;
            let pickCalls = 0;
            let accepted = null;
            const result = await showIncludeSearchPick({
                getEntries: () => (scanned
                    ? [{ filePath: '/p/main.k', label: 'main.k', description: '', missing: false, treeItem: { id: 1 } }]
                    : []),
                onRequestScan: async () => {
                    scanned = true;
                },
                onAccept: async (entry) => {
                    accepted = entry;
                },
                showInformationMessage: async (_msg, action) => action,
                showQuickPick: async (items) => {
                    pickCalls += 1;
                    return items[0];
                },
            });
            assert.equal(pickCalls, 1);
            assert.ok(result);
            assert.equal(result.label, 'main.k');
            assert.equal(accepted.label, 'main.k');
        });

        it('returns undefined when user declines empty-state scan', async () => {
            const result = await showIncludeSearchPick({
                entries: [],
                onRequestScan: async () => {
                    throw new Error('should not scan');
                },
                onAccept: async () => {
                    throw new Error('should not accept');
                },
                showInformationMessage: async () => undefined,
                showQuickPick: async () => {
                    throw new Error('should not pick');
                },
            });
            assert.equal(result, undefined);
        });

        it('forces alwaysShow for multi-word so VS Code cannot re-hide results', async () => {
            const entries = [
                { filePath: '/p/main.k', label: 'main.k', description: '', missing: false, treeItem: {} },
                {
                    filePath: '/x/mesh/parts_shell.k',
                    label: 'parts_shell.k',
                    description: 'mesh',
                    missing: false,
                    treeItem: {},
                },
            ];
            let accepted = null;
            let lastItems = [];
            const valueHandlers = [];
            const acceptHandlers = [];

            const result = await showIncludeSearchPick({
                entries,
                onAccept: async (entry) => { accepted = entry; },
                createQuickPick: () => ({
                    title: '',
                    placeholder: '',
                    ignoreFocusOut: false,
                    matchOnDescription: true,
                    matchOnDetail: true,
                    canSelectMany: false,
                    value: '',
                    items: [],
                    selectedItems: [],
                    onDidChangeValue(cb) { valueHandlers.push(cb); return { dispose() {} }; },
                    onDidAccept(cb) { acceptHandlers.push(cb); return { dispose() {} }; },
                    onDidHide() { return { dispose() {} }; },
                    show() {
                        this.value = 'parts shell';
                        for (const cb of valueHandlers) cb();
                        lastItems = this.items;
                        this.selectedItems = [this.items[0]];
                        for (const cb of acceptHandlers) cb();
                    },
                    hide() {},
                    dispose() {},
                }),
            });

            assert.equal(lastItems.length, 1);
            assert.equal(lastItems[0].entry.label, 'parts_shell.k');
            assert.equal(lastItems[0].alwaysShow, true);
            assert.ok(String(lastItems[0].label).includes('\u0332'));
            assert.equal(result.label, 'parts_shell.k');
            assert.equal(accepted.label, 'parts_shell.k');
        });

        it('forces alwaysShow for ro v3 multi-word on basename', async () => {
            const entries = [
                {
                    filePath: 'D:\\Project\\main.k',
                    label: 'main.k',
                    description: 'Project',
                    missing: false,
                    treeItem: {},
                },
                {
                    filePath: 'D:\\Project\\rogue-v3.key',
                    label: 'rogue-v3.key',
                    description: 'Project',
                    missing: false,
                    treeItem: {},
                },
            ];
            let lastItems = [];
            const valueHandlers = [];
            const acceptHandlers = [];

            await showIncludeSearchPick({
                entries,
                onAccept: async () => {},
                createQuickPick: () => ({
                    title: '',
                    placeholder: '',
                    ignoreFocusOut: false,
                    matchOnDescription: false,
                    matchOnDetail: false,
                    canSelectMany: false,
                    value: '',
                    items: [],
                    selectedItems: [],
                    onDidChangeValue(cb) { valueHandlers.push(cb); return { dispose() {} }; },
                    onDidAccept(cb) { acceptHandlers.push(cb); return { dispose() {} }; },
                    onDidHide() { return { dispose() {} }; },
                    show() {
                        this.value = 'ro v3';
                        for (const cb of valueHandlers) cb();
                        lastItems = this.items;
                        this.selectedItems = this.items[0] ? [this.items[0]] : [];
                        for (const cb of acceptHandlers) cb();
                    },
                    hide() {},
                    dispose() {},
                }),
            });

            assert.equal(lastItems.length, 1);
            assert.equal(lastItems[0].entry.label, 'rogue-v3.key');
            assert.equal(lastItems[0].alwaysShow, true);
            assert.ok(String(lastItems[0].label).includes('\u0332'));
        });

        it('uses native path for rgv subsequence (leave alwaysShow false)', async () => {
            const entries = [
                {
                    filePath: '/p/rogue-v3.key',
                    label: 'rogue-v3.key',
                    description: '',
                    missing: false,
                    treeItem: {},
                },
            ];
            let lastItems = [];
            const valueHandlers = [];
            const acceptHandlers = [];

            await showIncludeSearchPick({
                entries,
                onAccept: async () => {},
                createQuickPick: () => ({
                    title: '',
                    placeholder: '',
                    ignoreFocusOut: false,
                    matchOnDescription: false,
                    matchOnDetail: false,
                    canSelectMany: false,
                    value: '',
                    items: [],
                    selectedItems: [],
                    onDidChangeValue(cb) { valueHandlers.push(cb); return { dispose() {} }; },
                    onDidAccept(cb) { acceptHandlers.push(cb); return { dispose() {} }; },
                    onDidHide() { return { dispose() {} }; },
                    show() {
                        this.value = 'rgv';
                        for (const cb of valueHandlers) cb();
                        lastItems = this.items;
                        this.selectedItems = this.items[0] ? [this.items[0]] : [];
                        for (const cb of acceptHandlers) cb();
                    },
                    hide() {},
                    dispose() {},
                }),
            });

            assert.equal(lastItems.length, 1);
            assert.equal(lastItems[0].alwaysShow, false);
            assert.equal(lastItems[0].label, 'rogue-v3.key');
        });
    });

    describe('showKeywordSearchPick', () => {
        it('jumps directly when a keyword has a single usage', async () => {
            let usageAccepted = null;
            const entry = {
                keyword: 'NODE',
                usages: [{ filePath: '/a.k', lineIndex: 4 }],
                treeItem: {},
            };
            const result = await showKeywordSearchPick({
                entries: [entry],
                onAcceptUsage: async (_entry, usage) => {
                    usageAccepted = usage;
                },
                showQuickPick: async (items) => items[0],
                showInformationMessage: async () => undefined,
            });
            assert.equal(result.entry.keyword, 'NODE');
            assert.equal(result.usage.lineIndex, 4);
            assert.equal(usageAccepted.lineIndex, 4);
        });

        it('opens a second pick when a keyword has multiple usages', async () => {
            const entry = {
                keyword: 'PART',
                usages: [
                    { filePath: '/a.k', lineIndex: 1 },
                    { filePath: '/b.k', lineIndex: 2 },
                ],
                treeItem: {},
            };
            let pickStage = 0;
            const result = await showKeywordSearchPick({
                entries: [entry],
                onAcceptUsage: async () => {},
                showQuickPick: async (items) => {
                    pickStage += 1;
                    if (pickStage === 1) {
                        return items[0];
                    }
                    return items[1];
                },
                showInformationMessage: async () => undefined,
            });
            assert.equal(pickStage, 2);
            assert.equal(result.usage.filePath, '/b.k');
            assert.equal(result.usage.lineIndex, 2);
        });

        it('shows con en → CONTROL_ENERGY with alwaysShow (multi-word must not be re-hidden)', async () => {
            const entries = [
                { keyword: '*CONTROL_ONLY', usages: [{ filePath: '/a.k', lineIndex: 0 }], treeItem: {} },
                { keyword: '*CONTROL_ENERGY', usages: [{ filePath: '/a.k', lineIndex: 1 }], treeItem: {} },
                { keyword: '*CONTROL_TIMESTEP', usages: [{ filePath: '/a.k', lineIndex: 2 }], treeItem: {} },
            ];
            let lastItems = [];
            const valueHandlers = [];
            const acceptHandlers = [];

            const result = await showKeywordSearchPick({
                entries,
                onAcceptUsage: async () => {},
                createQuickPick: () => ({
                    title: '',
                    placeholder: '',
                    ignoreFocusOut: false,
                    matchOnDescription: true,
                    matchOnDetail: true,
                    canSelectMany: false,
                    value: '',
                    items: [],
                    selectedItems: [],
                    onDidChangeValue(cb) { valueHandlers.push(cb); return { dispose() {} }; },
                    onDidAccept(cb) { acceptHandlers.push(cb); return { dispose() {} }; },
                    onDidHide() { return { dispose() {} }; },
                    show() {
                        this.value = 'con en';
                        for (const cb of valueHandlers) cb();
                        lastItems = this.items;
                        this.selectedItems = [this.items[0]];
                        for (const cb of acceptHandlers) cb();
                    },
                    hide() {},
                    dispose() {},
                }),
            });

            assert.ok(lastItems.length >= 1);
            const energy = lastItems.find(i => i.entry.keyword === '*CONTROL_ENERGY');
            assert.ok(energy, 'CONTROL_ENERGY must remain visible for "con en"');
            assert.equal(energy.alwaysShow, true);
            assert.ok(String(energy.label).includes('\u0332'));
            assert.ok(result.entry.keyword.includes('CONTROL'));
        });
    });
});
