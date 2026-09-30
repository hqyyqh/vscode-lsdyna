'use strict';

const assert = require('assert');
const vscodeMock = require('../../vscode-mock');

const {
    buildOfficialFieldChoiceQuickPickItems,
    createOfficialFieldChoicePicker,
} = require('../../../out/client/services/officialFieldChoicePicker');

function fakePlan(overrides = {}) {
    return {
        status: 'ready',
        reason: 'official-field-choices-ready',
        documentVersion: 3,
        keyword: '*MAT_DAMAGE_1',
        catalogKeyword: '*MAT_DAMAGE_1',
        keywordLine: 0,
        physicalCardIndex: 2,
        fieldIndex: 7,
        fieldName: 'FLAG',
        fieldType: 'integer',
        fieldWidth: 10,
        fieldRange: { line: 2, startCharacter: 70, endCharacter: 80 },
        currentRawValue: '0',
        currentValueKind: 'numeric',
        domainKind: 'closed',
        domainComplete: true,
        ruleId: 'rule:flag',
        summary: 'Damage type flag documented by the official manual.',
        evidence: [{ evidenceId: 'evidence:flag', manualId: 'manual-vol-ii', page: 832 }],
        choices: [
            { value: 0, valueText: '0', role: 'sentinel', id: 'choice:0', replacementText: '         0' },
            { value: 10, valueText: '10', role: 'enum', id: 'choice:10', replacementText: '        10' },
        ],
        lineReads: 3,
        usedBlockIndex: true,
        ...overrides,
    };
}

function fakeDocument(options = {}) {
    const lines = options.lines || [
        '*MAT_DAMAGE_1',
        ' '.repeat(80),
        `${'A'.repeat(70)}         0`,
    ];
    const uriText = options.uri || 'file:///project/model.k';
    return {
        languageId: 'lsdyna',
        version: options.version ?? 3,
        lineCount: lines.length,
        uri: {
            fsPath: '/project/model.k',
            toString: () => uriText,
        },
        lineAt(index) { return { text: lines[index] }; },
        _lines: lines,
    };
}

function fakeEditor(document) {
    return {
        document,
        selection: {
            isEmpty: true,
            active: { line: 2, character: 75 },
            start: { line: 2, character: 75 },
        },
        selections: [{}],
    };
}

function createHarness(overrides = {}) {
    const document = overrides.document || fakeDocument();
    let editor = overrides.editor || fakeEditor(document);
    const plans = overrides.plans || [fakePlan(), fakePlan()];
    let planIndex = 0;
    const statuses = [];
    const edits = [];
    const deps = {
        vscode: vscodeMock,
        getActiveEditor: () => editor,
        isLsdynaDocument: doc => doc?.languageId === 'lsdyna',
        documentIdentity: doc => doc?.uri?.toString?.() || '',
        plan: (_document, _position, _options) => plans[Math.min(planIndex++, plans.length - 1)],
        translate: (key, ...args) => `${key}${args.length ? `:${args.join('|')}` : ''}`,
        showStatus: (key, ...args) => statuses.push([key, ...args]),
        pickChoice: async () => 'choice:10',
        applyEdit: async edit => {
            edits.push(edit);
            return true;
        },
        ...overrides.deps,
    };
    return {
        document,
        deps,
        statuses,
        edits,
        picker: createOfficialFieldChoicePicker(deps),
        setEditor(value) { editor = value; },
        get planCalls() { return planIndex; },
    };
}

describe('official field choice picker', () => {
    for (const phase of ['initial', 'final']) it(`rejects a moved caret during the ${phase} asynchronous plan`, async () => {
        let finish, calls = 0, opened = 0;
        const h = createHarness({ deps: {
            plan: () => ++calls === (phase === 'initial' ? 1 : 2)
                ? new Promise(resolve => { finish = resolve; }) : fakePlan(),
            pickChoice: async () => { opened++; return 'choice:10'; },
        } });
        const pending = h.picker.pick();
        while (!finish) await new Promise(resolve => setImmediate(resolve));
        h.deps.getActiveEditor().selection = { isEmpty: true, active: { line: 1, character: 1 } };
        finish(fakePlan());
        assert.equal(await pending, null);
        assert.equal(opened, phase === 'initial' ? 0 : 1);
        assert.deepEqual(h.statuses, [['officialFieldChoiceUnavailable']]);
        assert.equal(h.edits.length, 0);
    });
    it('rejects a document change while the initial asynchronous plan is preparing', async () => {
        let finish, picked = false;
        const h = createHarness({ deps: {
            plan: () => new Promise(resolve => { finish = resolve; }),
            pickChoice: async () => { picked = true; return 'choice:10'; },
        } });
        const pending = h.picker.pick();
        h.document.version++;
        finish(fakePlan());
        assert.equal(await pending, null);
        assert.equal(picked, false);
        assert.equal(h.edits.length, 0);
    });
    it('rejects OS/provider readonly independently of readonlyFromPermissions without applying a draft', async () => {
        const h = createHarness({ deps: { vscode: {
            ...vscodeMock,
            FilePermission: { Readonly: 1 },
            workspace: {
                ...vscodeMock.workspace,
                getConfiguration: () => ({ get: (_key, fallback) => fallback }),
                fs: { stat: async () => ({ permissions: 1 }) },
            },
        } } });
        const before = h.document._lines.slice();
        assert.equal(await h.picker.pick(), null);
        assert.equal(h.edits.length, 0);
        assert.deepEqual(h.document._lines, before);
        assert.deepEqual(h.statuses.at(-1), ['editReadonly']);
    });

    for (const change of ['close', 'replace', 'permission-await-version']) {
        it(`rejects ${change} before committing an official choice`, async () => {
            const h = createHarness();
            if (change === 'permission-await-version') {
                h.deps.vscode = {
                    ...vscodeMock,
                    workspace: { ...vscodeMock.workspace, fs: { stat: async () => {
                        await Promise.resolve();
                        h.document.version++;
                        return { permissions: 0 };
                    } } },
                };
            } else h.deps.pickChoice = async () => {
                if (change === 'close') h.document.isClosed = true;
                else h.deps.getActiveEditor().document = { ...h.document };
                return 'choice:10';
            };
            assert.equal(await h.picker.pick(), null);
            assert.equal(h.edits.length, 0);
            assert.equal(h.planCalls, 1);
            assert.deepEqual(h.statuses.at(-1), ['officialFieldChoiceSourceInactive']);
        });
    }

    it('builds role/current/evidence items while preserving the mixed-domain warning at plan level', () => {
        const plan = fakePlan({ domainKind: 'mixed', domainComplete: false });
        const items = buildOfficialFieldChoiceQuickPickItems(plan, {
            vscode: vscodeMock,
            translate: (key, ...args) => `${key}:${args.join('|')}`,
        });

        assert.equal(items.length, 2);
        assert.ok(items[0].description.includes('officialChoiceRoleSentinel'));
        assert.ok(items[0].description.includes('officialFieldChoiceCurrentValue'));
        assert.ok(!items[1].description.includes('officialFieldChoiceCurrentValue'));
        assert.ok(items[0].detail.includes('Damage type flag'));
        assert.ok(items[0].detail.includes('manual-vol-ii P832'));
        assert.equal(items[0].buttons.length, 1);
        assert.equal(items[0].buttons[0].evidence.evidenceId, 'evidence:flag');
    });

    it('keeps choices visible while silently hiding evidence for an uncovered profile', () => {
        const items = buildOfficialFieldChoiceQuickPickItems(fakePlan(), {
            vscode: vscodeMock,
            translate: (key, ...args) => `${key}:${args.join('|')}`,
            presentEvidence: () => null,
        });
        assert.equal(items.length, 2);
        assert.equal(items[0].buttons, undefined);
        assert.ok(!items[0].detail.includes('P832'));

        const matched = buildOfficialFieldChoiceQuickPickItems(fakePlan(), {
            vscode: vscodeMock,
            translate: (key, ...args) => `${key}:${args.join('|')}`,
            presentEvidence: () => ({ label: 'Vol II · P832', tooltip: 'Open P832' }),
        });
        assert.ok(matched[0].detail.includes('Vol II · P832'));
        assert.equal(matched[0].buttons[0].tooltip, 'Open P832');
    });

    it('supports bilingual presentation with localized summary, fallback notice, and original button', () => {
        const planWithZh = fakePlan({
            summary: 'Axis for PTYPE = 1 or 2.',
            localizedSummary: 'PTYPE = 1 或 2 时的坐标轴。',
        });
        const zhItems = buildOfficialFieldChoiceQuickPickItems(planWithZh, {
            vscode: vscodeMock,
            translate: (key, ...args) => key === 'fieldHelpEnglishOriginal' ? '原文' : `${key}:${args.join('|')}`,
            isZh: true,
        });
        assert.ok(zhItems[0].detail.includes('PTYPE = 1 或 2 时的坐标轴。'));
        assert.ok(!zhItems[0].detail.includes('fieldHelpUntranslatedInline'));
        assert.equal(zhItems[0].buttons[0].englishOriginal, 'Axis for PTYPE = 1 or 2.');
        assert.equal(zhItems[0].buttons[0].tooltip, '原文');

        const planWithoutZh = fakePlan({
            summary: 'Untranslated summary.',
            localizedSummary: null,
        });
        const fallbackItems = buildOfficialFieldChoiceQuickPickItems(planWithoutZh, {
            vscode: vscodeMock,
            translate: (key, ...args) => key === 'fieldHelpUntranslatedInline' ? '暂无已核对中文说明' : `${key}:${args.join('|')}`,
            isZh: true,
        });
        assert.ok(fallbackItems[0].detail.includes('Untranslated summary. （暂无已核对中文说明）'));

        const enItems = buildOfficialFieldChoiceQuickPickItems(planWithZh, {
            vscode: vscodeMock,
            translate: (key, ...args) => `${key}:${args.join('|')}`,
            isZh: false,
        });
        assert.ok(enItems[0].detail.includes('Axis for PTYPE = 1 or 2.'));
        assert.ok(!enItems[0].detail.includes('坐标轴'));
    });

    it('re-plans before and after the pick, then replaces exactly one fixed-width cell', async () => {
        const harness = createHarness();
        const result = await harness.picker.pick({
            uri: 'file:///project/model.k',
            line: 2,
            character: 75,
            documentVersion: 3,
        });

        assert.ok(result);
        assert.equal(harness.planCalls, 2);
        assert.equal(harness.edits.length, 1);
        assert.equal(harness.edits[0].edits.length, 1);
        const edit = harness.edits[0].edits[0];
        assert.equal(edit.range.start.line, 2);
        assert.equal(edit.range.start.character, 70);
        assert.equal(edit.range.end.character, 80);
        assert.equal(edit.text, '        10');
        const original = harness.document._lines[2];
        const applied = original.slice(0, 70) + edit.text + original.slice(80);
        assert.equal(applied.slice(0, 70), original.slice(0, 70));
        assert.equal(applied.slice(80), original.slice(80));
        assert.equal(applied.slice(70, 80), '        10');
        assert.deepEqual(harness.statuses.at(-1), ['officialFieldChoiceApplied', 'FLAG', '10']);
    });

    it('rejects non-identity payload fields, wrong URI, and stale versions before planning', async () => {
        for (const request of [
            {
                uri: 'file:///project/model.k', line: 2, character: 75, documentVersion: 3,
                replacementText: 'FORGED',
            },
            { uri: 'file:///project/other.k', line: 2, character: 75, documentVersion: 3 },
            { uri: 'file:///project/model.k', line: 2, character: 75, documentVersion: 2 },
        ]) {
            const harness = createHarness();
            assert.equal(await harness.picker.pick(request), null);
            assert.equal(harness.planCalls, 0);
            assert.equal(harness.edits.length, 0);
            assert.equal(harness.statuses.at(-1)[0], 'officialFieldChoiceSourceInactive');
        }
    });

    it('supports command-palette use from the current selection without trusting semantic input', async () => {
        const harness = createHarness();
        const result = await harness.picker.pick();
        assert.ok(result);
        assert.equal(harness.planCalls, 2);
        assert.equal(harness.edits.length, 1);
    });

    it('treats cancel as a no-op and does not perform the second plan', async () => {
        const harness = createHarness({
            deps: { pickChoice: async () => null },
        });
        assert.equal(await harness.picker.pick(), null);
        assert.equal(harness.planCalls, 1);
        assert.equal(harness.edits.length, 0);
        assert.deepEqual(harness.statuses, []);
    });

    it('fails open when the editor/version or writable field changes while the picker is open', async () => {
        const changedDocument = fakeDocument({ version: 4 });
        const versionHarness = createHarness({
            deps: {
                pickChoice: async () => {
                    versionHarness.setEditor(fakeEditor(changedDocument));
                    return 'choice:10';
                },
            },
        });
        assert.equal(await versionHarness.picker.pick(), null);
        assert.equal(versionHarness.edits.length, 0);
        assert.equal(versionHarness.statuses.at(-1)[0], 'officialFieldChoiceSourceInactive');

        const sameDocumentOtherEditorHarness = createHarness({
            deps: {
                pickChoice: async () => {
                    sameDocumentOtherEditorHarness.setEditor(fakeEditor(sameDocumentOtherEditorHarness.document));
                    return 'choice:10';
                },
            },
        });
        assert.equal(await sameDocumentOtherEditorHarness.picker.pick(), null);
        assert.equal(sameDocumentOtherEditorHarness.edits.length, 0);
        assert.equal(sameDocumentOtherEditorHarness.statuses.at(-1)[0], 'officialFieldChoiceSourceInactive');

        for (const finalPlan of [
            fakePlan({ ruleId: 'rule:changed' }),
            fakePlan({ fieldRange: { line: 2, startCharacter: 60, endCharacter: 70 } }),
            fakePlan({ choices: [fakePlan().choices[0]] }),
        ]) {
            const harness = createHarness({ plans: [fakePlan(), finalPlan] });
            assert.equal(await harness.picker.pick(), null);
            assert.equal(harness.edits.length, 0);
            assert.equal(harness.statuses.at(-1)[0], 'officialFieldChoiceUnavailable');
        }
    });

    it('keeps applyEdit=false and apply errors non-destructive', async () => {
        for (const applyEdit of [async () => false, async () => { throw new Error('apply failed'); }]) {
            const harness = createHarness({ deps: { applyEdit } });
            assert.equal(await harness.picker.pick(), null);
            assert.equal(harness.statuses.at(-1)[0], 'officialFieldChoiceApplyFailed');
        }
    });

    it('does not create an edit when the selected replacement already matches the exact cell', async () => {
        const document = fakeDocument({
            lines: ['*MAT_DAMAGE_1', ' '.repeat(80), `${'A'.repeat(70)}        10`],
        });
        const current = fakePlan({ currentRawValue: '10' });
        const harness = createHarness({ document, plans: [current, current] });
        const result = await harness.picker.pick();
        assert.equal(result.unchanged, true);
        assert.equal(harness.edits.length, 0);
        assert.deepEqual(harness.statuses, []);
    });

    for (const original of [false, true]) it(`opens ${original ? 'complete English help' : 'source-locked evidence'} from a native item button without changing its edit`, async () => {
        const opened = [];
        let capturedQuickPick = null;
        const vscode = {
            ...vscodeMock,
            ThemeIcon: vscodeMock.ThemeIcon,
            window: {
                ...vscodeMock.window,
                createQuickPick() {
                    const handlers = {};
                    capturedQuickPick = {
                        items: [],
                        activeItems: [],
                        selectedItems: [],
                        onDidAccept(callback) { handlers.accept = callback; return { dispose() {} }; },
                        onDidHide(callback) { handlers.hide = callback; return { dispose() {} }; },
                        onDidTriggerItemButton(callback) { handlers.button = callback; return { dispose() {} }; },
                        show() {
                            handlers.button({ button: this.items[0].buttons[0] });
                            this.selectedItems = [this.items[1]];
                            handlers.accept();
                        },
                        hide() { handlers.hide?.(); },
                        dispose() {},
                    };
                    return capturedQuickPick;
                },
            },
        };
        const harness = createHarness({
            ...(original ? { plans: [fakePlan({ localizedSummary: '已核对说明。' }), fakePlan({ localizedSummary: '已核对说明。' })] } : {}),
            deps: {
                vscode,
                pickChoice: undefined,
                isZh: original,
                openEnglish: text => opened.push(text),
                openEvidence: request => opened.push(request),
            },
        });
        const result = await harness.picker.pick({
            uri: 'file:///project/model.k',
            line: 2,
            character: 75,
            documentVersion: 3,
        });

        assert.ok(result);
        assert.ok(capturedQuickPick.title.includes('officialFieldChoiceClosedTitle'));
        assert.deepEqual(opened, original ? [fakePlan().summary] : [{
            keyword: '*MAT_DAMAGE_1',
            ruleId: 'rule:flag',
            evidenceId: 'evidence:flag',
        }]);
        assert.equal(harness.edits.length, 1);
    });
});
