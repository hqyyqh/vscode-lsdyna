'use strict';

const assert = require('assert');

describe('DynaSense status bar dashboard', () => {
    const {
        LsdynaStatusBarDashboard,
        buildDashboardItems,
        formatDashboardText,
        normalizeStatusBarLevel,
        shouldShowDashboard,
    } = require('../../src/client/statusBar/dashboard');

    describe('normalizeStatusBarLevel', () => {
        it('keeps supported levels and falls back to simple', () => {
            assert.strictEqual(normalizeStatusBarLevel('off'), 'off');
            assert.strictEqual(normalizeStatusBarLevel('simple'), 'simple');
            assert.strictEqual(normalizeStatusBarLevel('detail'), 'detail');
            assert.strictEqual(normalizeStatusBarLevel('weird'), 'simple');
            assert.strictEqual(normalizeStatusBarLevel(undefined), 'simple');
        });
    });

    describe('shouldShowDashboard', () => {
        it('shows only for LS-DYNA documents when the level is enabled', () => {
            assert.strictEqual(shouldShowDashboard({ isLsdyna: true, level: 'simple' }), true);
            assert.strictEqual(shouldShowDashboard({ isLsdyna: true, level: 'detail' }), true);
            assert.strictEqual(shouldShowDashboard({ isLsdyna: true, level: 'off' }), false);
            assert.strictEqual(shouldShowDashboard({ isLsdyna: false, level: 'simple' }), false);
        });
    });

    describe('formatDashboardText', () => {
        it('formats compact and detailed healthy state', () => {
            assert.strictEqual(formatDashboardText({
                level: 'simple',
                keyword: '*PART',
                fieldIndex: 3,
                fieldCount: 8,
                manualReady: true,
                warningCount: 0,
            }), 'DynaSense: *PART');

            assert.strictEqual(formatDashboardText({
                level: 'detail',
                keyword: '*PART',
                fieldIndex: 3,
                fieldCount: 8,
                manualReady: true,
                warningCount: 0,
            }), 'DynaSense: *PART · F3/8 · Manual OK');
        });

        it('prioritizes warnings and handles empty context', () => {
            assert.strictEqual(formatDashboardText({
                level: 'detail',
                keyword: '*PART',
                fieldIndex: 3,
                fieldCount: 8,
                manualReady: true,
                warningCount: 2,
            }), 'DynaSense: 2 warnings');

            assert.strictEqual(formatDashboardText({
                level: 'detail',
                keyword: '',
                fieldIndex: null,
                fieldCount: 0,
                manualReady: false,
                warningCount: 1,
            }), 'DynaSense: 1 warning');

            assert.strictEqual(formatDashboardText({
                level: 'simple',
                keyword: '',
                fieldIndex: null,
                fieldCount: 0,
                manualReady: false,
                warningCount: 0,
            }), 'DynaSense');
        });
    });

    describe('buildDashboardItems', () => {
        it('builds high-frequency actions first and diagnostics/settings last', () => {
            const items = buildDashboardItems({
                tabNavigationEnabled: true,
                warningCount: 2,
                manualReady: false,
            });

            assert.deepStrictEqual(items.map(item => item.id), [
                'showHealth',
                'scanIncludes',
                'scanKeywordIndex',
                'configureManuals',
                'showOutput',
                'copyDiagnostics',
                'toggleTabNavigation',
            ]);
            assert.ok(items.every(item => item.label && item.description && item.detail));
            assert.ok(items.find(item => item.id === 'showHealth').description.includes('2'));
            assert.ok(items.find(item => item.id === 'copyDiagnostics').description.includes('2'));
            assert.ok(items.find(item => item.id === 'toggleTabNavigation').description.includes('On'));
        });
    });

    describe('LsdynaStatusBarDashboard', () => {
        it('updates status bar visibility and text from the current context', () => {
            const calls = [];
            const statusBarItem = {
                text: '',
                tooltip: '',
                command: '',
                show: () => calls.push('show'),
                hide: () => calls.push('hide'),
                dispose() {},
            };
            const dashboard = new LsdynaStatusBarDashboard({
                statusBarItem,
                getContext: () => ({
                    isLsdyna: true,
                    level: 'detail',
                    keyword: '*NODE',
                    fieldIndex: 2,
                    fieldCount: 4,
                    manualReady: false,
                warningCount: 0,
                    healthIssueCount: 0,
                    tabNavigationEnabled: true,
                }),
                actions: {},
            });

            dashboard.refresh();

            assert.strictEqual(statusBarItem.text, 'DynaSense: *NODE · F2/4 · Manual setup');
            assert.strictEqual(statusBarItem.command, 'extension.lsdynaStatusDashboard');
            assert.deepStrictEqual(calls, ['show']);
        });

        it('dispatches the selected quick pick action', async () => {
            const executed = [];
            const dashboard = new LsdynaStatusBarDashboard({
                statusBarItem: { show() {}, hide() {}, dispose() {} },
                getContext: () => ({
                    isLsdyna: true,
                    level: 'simple',
                    keyword: '*PART',
                    fieldIndex: 1,
                    fieldCount: 2,
                    manualReady: true,
                    warningCount: 0,
                    healthIssueCount: 1,
                    tabNavigationEnabled: true,
                }),
                showQuickPick: async (items) => items.find(item => item.id === 'showHealth'),
                actions: {
                    showHealth: () => executed.push('showHealth'),
                },
            });

            await dashboard.showMenu();

            assert.deepStrictEqual(executed, ['showHealth']);
        });
    });
});
