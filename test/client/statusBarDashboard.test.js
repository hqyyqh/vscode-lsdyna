'use strict';

const assert = require('assert');

describe('DynaSense status bar dashboard', () => {
    const {
        LsdynaStatusBarDashboard,
        buildDashboardItems,
        formatDashboardText,
        formatDashboardTooltip,
        normalizeStatusBarLevel,
        shouldShowDashboard,
    } = require('../../src/client/statusBar/dashboard');

    it('merges field choices and column guides while retaining problem priority', () => {
        const context = {errorCount:1,manualReady:true,
            fieldChoice:{text:'FLAG: 3 choices',tooltip:'Choose a verified value',command:{title:'Choose field value'}},
            columnGuides:{enabled:true,label:'Toggle column guides',state:'On'}};
        const items=buildDashboardItems(context);
        assert.equal(items[0].id,'showDiagnostics');
        assert.equal(items.find(item=>item.id==='pickFieldValue').description,'FLAG: 3 choices');
        assert.equal(items.find(item=>item.id==='toggleColumnGuides').description,'On');
        assert.ok(formatDashboardTooltip(context).includes('Choose a verified value'));
    });

    it('keeps literal dollar and placeholder tokens in file and main-deck labels', () => {
        for (const token of ['$&', '$`', "$'", '$$', '{1}']) {
            const scanRootName = `cash${token}deck.k`, mainDeckRootName = `main${token}deck.k`;
            const tooltip = formatDashboardTooltip({ scanRootName, mainDeckRootName, mainDeckContextState: 'selected' });
            assert.ok(tooltip.includes(scanRootName), tooltip);
            assert.ok(tooltip.includes(mainDeckRootName), tooltip);
        }
    });

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
        it('shows keyword in quiet state and ignores setup when keyword exists', () => {
            assert.strictEqual(formatDashboardText({
                level: 'simple',
                keyword: '*PART',
                fieldIndex: 3,
                fieldCount: 8,
                manualReady: true,
                errorCount: 0,
                warningCount: 0,
                healthIssueCount: 3,
            }), 'LS-DYNA: *PART');

            assert.strictEqual(formatDashboardText({
                level: 'detail',
                keyword: '*PART',
                fieldIndex: 3,
                fieldCount: 8,
                manualReady: true,
                errorCount: 0,
                warningCount: 0,
            }), 'LS-DYNA: *PART · 3/8');
        });

        it('prioritizes errors over warnings over keyword over setup', () => {
            assert.strictEqual(formatDashboardText({
                level: 'detail',
                keyword: '*PART',
                manualReady: true,
                errorCount: 2,
                warningCount: 5,
                healthIssueCount: 9,
            }), 'LS-DYNA · $(error) 2');

            assert.strictEqual(formatDashboardText({
                level: 'simple',
                keyword: '*PART',
                errorCount: 0,
                warningCount: 2,
                healthIssueCount: 9,
            }), 'LS-DYNA · $(warning) 2');

            assert.strictEqual(formatDashboardText({
                level: 'simple',
                keyword: '',
                manualReady: false,
                errorCount: 0,
                warningCount: 0,
                healthIssueCount: 2,
            }), 'LS-DYNA: Manual setup');

            assert.strictEqual(formatDashboardText({
                level: 'simple',
                keyword: '',
                manualReady: true,
                errorCount: 0,
                warningCount: 0,
                healthIssueCount: 0,
            }), 'LS-DYNA');
        });

        it('detail can append scan short name without Manual OK', () => {
            assert.strictEqual(formatDashboardText({
                level: 'detail',
                keyword: '*MAT_024',
                fieldIndex: 1,
                fieldCount: 8,
                manualReady: true,
                scanRootName: 'front_lh.k',
            }), 'LS-DYNA: *MAT_024 · 1/8 · front_lh.k');
        });

        it('simple mode does not append scan short name', () => {
            assert.strictEqual(formatDashboardText({
                level: 'simple',
                keyword: '*MAT_024',
                scanRootName: 'front_lh.k',
                errorCount: 0,
                warningCount: 0,
                manualReady: true,
            }), 'LS-DYNA: *MAT_024');
        });
    });

    describe('formatDashboardTooltip', () => {
        it('states current-file scope and keyword', () => {
            const tip = formatDashboardTooltip({
                keyword: '*CONTACT',
                fieldIndex: 2,
                fieldCount: 8,
                errorCount: 1,
                warningCount: 2,
            });
            assert.ok(tip.includes('Current file'));
            assert.ok(tip.includes('1') && tip.includes('2'));
            assert.ok(tip.includes('*CONTACT'));
            assert.ok(tip.includes('2/8') || tip.includes('Field'));
            assert.ok(tip.includes('not scanned') || tip.includes('scan'));
        });

        it('shows scanned root basename when provided', () => {
            const tip = formatDashboardTooltip({
                keyword: '*PART',
                scanRootName: 'front_lh.k',
                errorCount: 0,
                warningCount: 0,
            });
            assert.ok(tip.includes('front_lh.k'));
            assert.ok(!tip.includes('not scanned'));
        });

        it('shows a selected or ambiguous main deck context', () => {
            const selected = formatDashboardTooltip({
                mainDeckContextState: 'selected',
                mainDeckRootName: 'condition_a.k',
            });
            assert.ok(selected.includes('Main deck context'));
            assert.ok(selected.includes('condition_a.k'));

            const ambiguous = formatDashboardTooltip({
                mainDeckContextState: 'ambiguous',
                mainDeckRootName: null,
            });
            assert.ok(ambiguous.includes('No main deck has been selected for analysis'));
        });
    });

    describe('buildDashboardItems', () => {
        it('puts problems and manuals CTA first when broken, health before log', () => {
            const items = buildDashboardItems({
                tabNavigationEnabled: true,
                errorCount: 1,
                warningCount: 1,
                healthIssueCount: 2,
                manualReady: false,
                labels: {
                    toggleTabNavigationLabel: '$(keyboard) 字段跳转',
                    tabNavigationOnDescription: '已开启',
                },
            });

            assert.deepStrictEqual(items.map(item => item.id), [
                'showDiagnostics',
                'configureManuals',
                'scanIncludes',
                'scanKeywordIndex',
                'toggleTabNavigation',
                'toggleFieldHover',
                'manageCustomValidKeywords',
                'showHealth',
                'showOutput',
            ]);
            assert.ok(items.every(item => item.label && item.description && item.detail));
            assert.ok(items.find(item => item.id === 'showHealth').description.includes('2'));
            assert.equal(items.find(item => item.id === 'toggleTabNavigation').label, '$(keyboard) 字段跳转');
            assert.ok(items.find(item => item.id === 'showDiagnostics').description.toLowerCase().includes('error'));
        });

        it('keeps include before keyword index; sinks health; diagnostics stay discoverable', () => {
            const items = buildDashboardItems({
                tabNavigationEnabled: false,
                fieldHoverMenuState: 'off',
                errorCount: 0,
                warningCount: 0,
                healthIssueCount: 0,
                manualReady: true,
            });

            assert.deepStrictEqual(items.map(item => item.id), [
                'scanIncludes',
                'scanKeywordIndex',
                'toggleTabNavigation',
                'toggleFieldHover',
                'manageCustomValidKeywords',
                'configureManuals',
                'showDiagnostics',
                'showHealth',
                'showOutput',
            ]);
            assert.ok(items.find(item => item.id === 'showHealth').description.includes('OK'));
            assert.ok(items.find(item => item.id === 'showDiagnostics').description.includes('No problems'));
            assert.ok(items.find(item => item.id === 'toggleFieldHover').description.includes('Off'));
        });

        it('shows session-off description for field hover menu state', () => {
            const items = buildDashboardItems({
                fieldHoverMenuState: 'offSession',
                labels: {
                    fieldHoverOffSessionDescription: '关（本会话）',
                },
            });
            assert.equal(
                items.find(item => item.id === 'toggleFieldHover').description,
                '关（本会话）',
            );
        });

        it('offers a main deck action only for selected or ambiguous shared contexts', () => {
            const ambiguous = buildDashboardItems({
                mainDeckContextState: 'ambiguous',
            });
            assert.ok(ambiguous.find(item =>
                item.id === 'selectMainDeckContext' &&
                item.description.includes('choose')
            ));

            const selected = buildDashboardItems({
                mainDeckContextState: 'selected',
                mainDeckRootName: 'condition_a.k',
            });
            assert.ok(selected.find(item =>
                item.id === 'selectMainDeckContext' &&
                item.description.includes('condition_a.k')
            ));

            const unique = buildDashboardItems({
                mainDeckContextState: 'unique',
                mainDeckRootName: 'condition_a.k',
            });
            assert.equal(unique.some(item => item.id === 'selectMainDeckContext'), false);
        });
    });

    describe('LsdynaStatusBarDashboard', () => {
        it('cancels a scheduler handle of zero when replaced or disposed', () => {
            for (const action of ['reschedule', 'dispose']) {
                const pending = new Map(), cancelled = [];
                let nextHandle = 0, shown = 0, disposed = 0;
                const dashboard = new LsdynaStatusBarDashboard({
                    statusBarItem: { show() { shown++; }, hide() {}, dispose() { disposed++; } },
                    getContext: () => ({ isLsdyna: true }),
                    schedule(callback) { const handle = nextHandle++; pending.set(handle, callback); return handle; },
                    cancel(handle) { cancelled.push(handle); pending.delete(handle); },
                });
                dashboard.scheduleRefresh();
                if (action === 'reschedule') dashboard.scheduleRefresh();
                else dashboard.dispose();
                assert.deepStrictEqual(cancelled, [0]);
                assert.equal(pending.size, action === 'reschedule' ? 1 : 0);
                for (const [handle, callback] of pending) { pending.delete(handle); callback(); }
                assert.equal(shown, action === 'reschedule' ? 1 : 0);
                assert.equal(dashboard.timer, null);
                if (action === 'reschedule') dashboard.dispose();
                assert.equal(disposed, 1);
            }
        });

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
                    manualReady: true,
                    errorCount: 0,
                    warningCount: 0,
                    healthIssueCount: 0,
                    tabNavigationEnabled: true,
                }),
                actions: {},
            });

            dashboard.refresh();

            assert.strictEqual(statusBarItem.text, 'LS-DYNA: *NODE · 2/4');
            assert.ok(String(statusBarItem.tooltip).includes('*NODE'));
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
                    errorCount: 0,
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

        it('dispatches custom valid keyword management from the status menu', async () => {
            const executed = [];
            const dashboard = new LsdynaStatusBarDashboard({
                statusBarItem: { show() {}, hide() {}, dispose() {} },
                getContext: () => ({ isLsdyna: true, level: 'simple' }),
                showQuickPick: async (items) => items.find(item => item.id === 'manageCustomValidKeywords'),
                actions: {
                    manageCustomValidKeywords: () => executed.push('manageCustomValidKeywords'),
                },
            });

            await dashboard.showMenu();

            assert.deepStrictEqual(executed, ['manageCustomValidKeywords']);
        });

        it('dispatches main deck context selection from the status menu', async () => {
            const executed = [];
            const dashboard = new LsdynaStatusBarDashboard({
                statusBarItem: { show() {}, hide() {}, dispose() {} },
                getContext: () => ({
                    isLsdyna: true,
                    level: 'simple',
                    mainDeckContextState: 'ambiguous',
                }),
                showQuickPick: async items =>
                    items.find(item => item.id === 'selectMainDeckContext'),
                actions: {
                    selectMainDeckContext: () => executed.push('selectMainDeckContext'),
                },
            });

            await dashboard.showMenu();

            assert.deepStrictEqual(executed, ['selectMainDeckContext']);
        });
    });
});
