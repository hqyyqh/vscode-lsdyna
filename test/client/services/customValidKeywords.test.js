'use strict';

const assert = require('assert');
const {
    normalizeCustomKeywordEntry,
    listCustomValidKeywords,
    inspectCustomValidKeywords,
    isCoveredByCustomList,
    addCustomValidKeyword,
    addManyCustomValidKeywords,
    removeCustomValidKeyword,
    replaceCustomValidKeyword,
    suggestPrefixWildcard,
    resolveEntrySource,
    FALLBACK_DEFAULTS,
} = require('../../../src/client/services/customValidKeywords');

function createConfigMock({ effective, globalValue, workspaceValue, defaultValue } = {}) {
    const updates = [];
    const state = {
        effective: effective != null ? effective.slice() : (FALLBACK_DEFAULTS.slice()),
        globalValue: globalValue,
        workspaceValue: workspaceValue,
        defaultValue: defaultValue != null ? defaultValue : FALLBACK_DEFAULTS.slice(),
    };
    return {
        updates,
        get(_key, fallback) {
            return state.effective != null ? state.effective : fallback;
        },
        inspect() {
            return {
                key: 'lsdyna.customValidKeywords',
                defaultValue: state.defaultValue,
                globalValue: state.globalValue,
                workspaceValue: state.workspaceValue,
            };
        },
        async update(_key, value, target) {
            updates.push({ value: value.slice(), target });
            state.effective = value.slice();
            if (target === 2) {
                state.workspaceValue = value.slice();
            } else {
                state.globalValue = value.slice();
            }
        },
    };
}

describe('customValidKeywords service', () => {
    describe('normalizeCustomKeywordEntry', () => {
        it('normalizes exact keywords to *UPPER form', () => {
            assert.equal(normalizeCustomKeywordEntry(' foo_bar '), '*FOO_BAR');
            assert.equal(normalizeCustomKeywordEntry('*foo_bar'), '*FOO_BAR');
            assert.equal(normalizeCustomKeywordEntry('FOO_BAR'), '*FOO_BAR');
        });

        it('keeps trailing wildcard as prefix pattern', () => {
            assert.equal(normalizeCustomKeywordEntry('*mat_*'), '*MAT_*');
            assert.equal(normalizeCustomKeywordEntry('mat_*'), '*MAT_*');
        });

        it('rejects empty or illegal names', () => {
            assert.equal(normalizeCustomKeywordEntry(''), null);
            assert.equal(normalizeCustomKeywordEntry('*'), null);
            assert.equal(normalizeCustomKeywordEntry('*FOO BAR'), null);
            assert.equal(normalizeCustomKeywordEntry('*FOO/BAR'), null);
        });
    });

    describe('isCoveredByCustomList', () => {
        it('matches exact and prefix wildcards', () => {
            const list = ['*END', '*MAT_*'];
            assert.equal(isCoveredByCustomList('*END', list), true);
            assert.equal(isCoveredByCustomList('*MAT_001', list), true);
            assert.equal(isCoveredByCustomList('*NODE', list), false);
            assert.equal(isCoveredByCustomList('*MAT_001', [' mat_* ']), true);
        });
    });

    describe('add/remove/replace', () => {
        it('appends a new keyword to the effective list and writes Global by default', async () => {
            const config = createConfigMock({
                effective: ['*END', '*TITLE'],
                globalValue: undefined,
            });
            const result = await addCustomValidKeyword({
                keyword: 'zzz_test',
                config,
            });
            assert.equal(result.status, 'added');
            assert.equal(result.entry, '*ZZZ_TEST');
            assert.ok(result.list.includes('*ZZZ_TEST'));
            assert.ok(result.list.includes('*END'));
            assert.equal(config.updates.length, 1);
            assert.equal(config.updates[0].target, 1);
        });

        it('does not duplicate when already covered', async () => {
            const config = createConfigMock({
                effective: ['*END', '*ZZZ_TEST'],
                globalValue: ['*END', '*ZZZ_TEST'],
            });
            const result = await addCustomValidKeyword({
                keyword: '*zzz_test',
                config,
            });
            assert.equal(result.status, 'exists');
            assert.equal(config.updates.length, 0);
        });

        it('writes workspace target when requested', async () => {
            const config = createConfigMock({
                effective: ['*END'],
                globalValue: ['*END'],
            });
            const result = await addCustomValidKeyword({
                keyword: '*WS_ONLY',
                target: 'workspace',
                config,
            });
            assert.equal(result.status, 'added');
            assert.equal(config.updates[0].target, 2);
            assert.ok(config.updates[0].value.includes('*WS_ONLY'));
        });

        it('removes from the written layer', async () => {
            const config = createConfigMock({
                effective: ['*END', '*ZZZ_TEST'],
                globalValue: ['*END', '*ZZZ_TEST'],
            });
            const result = await removeCustomValidKeyword({
                keyword: '*ZZZ_TEST',
                target: 'global',
                config,
            });
            assert.equal(result.status, 'removed');
            assert.deepEqual(result.list, ['*END']);
        });

        it('replaces an entry on the target layer', async () => {
            const config = createConfigMock({
                effective: ['*OLD'],
                globalValue: ['*OLD'],
            });
            const result = await replaceCustomValidKeyword({
                from: '*OLD',
                to: '*NEW',
                target: 'global',
                config,
            });
            assert.equal(result.status, 'replaced');
            assert.deepEqual(result.list, ['*NEW']);
        });

        it('adds many keywords in a single update and skips covered ones', async () => {
            const config = createConfigMock({
                effective: ['*END', '*KEEP'],
                globalValue: ['*END', '*KEEP'],
            });
            const result = await addManyCustomValidKeywords({
                keywords: ['*AAA', 'keep', '*BBB', '*AAA'],
                config,
            });
            assert.equal(result.status, 'added');
            assert.deepEqual(result.added, ['*AAA', '*BBB']);
            assert.ok(result.skipped.includes('*KEEP'));
            assert.equal(config.updates.length, 1);
            assert.ok(config.updates[0].value.includes('*AAA'));
            assert.ok(config.updates[0].value.includes('*BBB'));
            assert.ok(config.updates[0].value.includes('*KEEP'));
        });

        it('returns none when every keyword is already covered', async () => {
            const config = createConfigMock({
                effective: ['*END', '*AAA'],
                globalValue: ['*END', '*AAA'],
            });
            const result = await addManyCustomValidKeywords({
                keywords: ['*AAA', '*END'],
                config,
            });
            assert.equal(result.status, 'none');
            assert.equal(config.updates.length, 0);
        });
    });

    describe('inspect and helpers', () => {
        it('does not assign effective-only or scoped entries to a writable layer', () => {
            const entry = '*UNKNOWN_OWNER';
            assert.equal(resolveEntrySource(entry, { config: { get: () => [entry] } }), 'unknown');
            for (const layer of ['workspaceFolderValue', 'defaultLanguageValue', 'globalLanguageValue',
                'workspaceLanguageValue', 'workspaceFolderLanguageValue']) {
                const config = createConfigMock({ effective: [entry], globalValue: [entry] });
                const inspect = config.inspect;
                config.inspect = () => ({ ...inspect(), [layer]: [entry] });
                assert.equal(resolveEntrySource(entry, { config }), 'unknown', layer);
            }
        });

        it('attributes array settings to the effective layer and refuses inconsistent adapter metadata', () => {
            const config = createConfigMock({ effective: ['*FOO'], globalValue: ['*FOO'], workspaceValue: ['*FOO'] });
            assert.equal(resolveEntrySource('*FOO', { config }), 'workspace');
            assert.equal(resolveEntrySource('*NOT_EFFECTIVE', { config }), 'none');
            const inconsistent = createConfigMock({ effective: ['*FOO'], globalValue: ['*FOO', '*BAR'] });
            assert.equal(resolveEntrySource('*FOO', { config: inconsistent }), 'unknown');
        });

        it('rechecks a selected entry before offering writes and explains unknown ownership', async () => {
            const { showManageCustomValidKeywordsPick } = require('../../../src/client/services/customValidKeywordsUi');
            const i18n = require('../../../src/core/i18n');
            let effective = ['*OLD'], reads = 0;
            const warnings = [], updates = [];
            const config = { get: () => effective, inspect: () => ({ globalValue: ['*OLD'] }),
                update: (...args) => updates.push(args) };
            await showManageCustomValidKeywordsPick({ config,
                showQuickPick: async items => {
                    assert.equal(items[0].action, 'add', 'must not offer edit/delete for an unknown source');
                    if (reads++ > 0) return undefined;
                    const item = items.find(item => item.entry === '*OLD');
                    assert.equal(item.source, 'global');
                    effective = ['*OLD', '*UNKNOWN_OWNER'];
                    return item;
                },
                showWarningMessage: async message => { warnings.push(message); },
                showInputBox: async () => { throw new Error('must not request a replacement'); },
            });
            assert.equal(warnings.length, 1);
            assert.equal(warnings[0], i18n.get('customValidKeywordSourceUnknownReadOnly', '*OLD'));
            assert.deepEqual(updates, []);
        });

        it('rejects ownership changes while choosing an action or entering a replacement', async () => {
            const { showManageCustomValidKeywordsPick } = require('../../../src/client/services/customValidKeywordsUi');
            for (const phase of ['selection', 'delete', 'edit']) {
                let workspaceValue, rootReads = 0;
                const warnings = [], updates = [];
                const config = { get: () => ['*OLD'], inspect: () => ({ globalValue: ['*OLD'], workspaceValue }),
                    update: (...args) => updates.push(args) };
                await showManageCustomValidKeywordsPick({ config,
                    showQuickPick: async items => {
                        if (items[0].action === 'add') {
                            if (rootReads++ > 0) return undefined;
                            const item = items.find(item => item.entry === '*OLD');
                            if (phase === 'selection') workspaceValue = ['*OLD'];
                            return item;
                        }
                        if (phase === 'delete') workspaceValue = ['*OLD'];
                        return items.find(item => item.action === phase);
                    },
                    showInputBox: async () => { workspaceValue = ['*OLD']; return '*NEW'; },
                    showWarningMessage: async message => { warnings.push(message); },
                });
                assert.equal(warnings.length, 1, phase);
                assert.deepEqual(updates, [], phase);
            }
        });

        it('opens the affected setting from the unknown-source warning without a write', async () => {
            const { showManageCustomValidKeywordsPick } = require('../../../src/client/services/customValidKeywordsUi');
            const i18n = require('../../../src/core/i18n');
            const commands = [], updates = [];
            await showManageCustomValidKeywordsPick({
                config: { get: () => ['*UNKNOWN_OWNER'], update: (...args) => updates.push(args) },
                showQuickPick: async items => {
                    const item = items.find(item => item.entry === '*UNKNOWN_OWNER');
                    assert.equal(item.source, 'unknown');
                    assert.equal(item.description, i18n.get('customValidKeywordSourceUnknown'));
                    return item;
                },
                showWarningMessage: async (_message, action) => action,
                executeCommand: async (...args) => { commands.push(args); },
            });
            assert.deepEqual(commands, [['workbench.action.openSettings', 'lsdyna.customValidKeywords']]);
            assert.deepEqual(updates, []);
        });

        it('lists effective keywords and inspect layers', () => {
            const config = createConfigMock({
                effective: ['*END', '*FOO'],
                globalValue: ['*END', '*FOO'],
                workspaceValue: undefined,
                defaultValue: FALLBACK_DEFAULTS,
            });
            assert.deepEqual(listCustomValidKeywords({ config }), ['*END', '*FOO']);
            const layers = inspectCustomValidKeywords({ config });
            assert.deepEqual(layers.global, ['*END', '*FOO']);
            assert.equal(layers.workspace, undefined);
            assert.equal(resolveEntrySource('*FOO', { config }), 'global');
            assert.equal(resolveEntrySource('*END', { config }), 'global');
        });

        it('suggests prefix wildcards from the last underscore segment', () => {
            assert.equal(suggestPrefixWildcard('*FOO_BAR'), '*FOO_*');
            assert.equal(suggestPrefixWildcard('*FOO'), null);
            assert.equal(suggestPrefixWildcard('*MAT_*'), null);
        });
    });
});
