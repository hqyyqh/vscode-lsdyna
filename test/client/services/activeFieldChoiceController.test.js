'use strict';

const assert = require('assert');

const {
    ACTIVE_FIELD_CHOICE_CONTEXT_KEY,
    createActiveFieldChoiceController,
    officialFieldChoiceCommandRequest,
} = require('../../../out/client/services/activeFieldChoiceController');

function readyPlan(overrides = {}) {
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
        summary: 'Official FLAG summary.',
        evidence: [{ evidenceId: 'evidence:flag', manualId: 'manual-vol-ii', page: 832 }],
        choices: [
            { valueText: '-1', role: 'enum', id: 'choice:-1', replacementText: '        -1' },
            { valueText: '0', role: 'sentinel', id: 'choice:0', replacementText: '         0' },
            { valueText: '1', role: 'enum', id: 'choice:1', replacementText: '         1' },
            { valueText: '10', role: 'enum', id: 'choice:10', replacementText: '        10' },
            { valueText: '11', role: 'enum', id: 'choice:11', replacementText: '        11' },
        ],
        lineReads: 3,
        usedBlockIndex: true,
        ...overrides,
    };
}

function fakeDocument() {
    const lines = ['*MAT_DAMAGE_1', ' '.repeat(80), ' '.repeat(80)];
    return {
        languageId: 'lsdyna',
        version: 3,
        lineCount: lines.length,
        uri: { toString: () => 'file:///project/model.k' },
        lineAt(line) { return { text: lines[line] }; },
    };
}

function fakeEditor(document, selection = {}) {
    const start = selection.start || { line: 2, character: 70 };
    const end = selection.end || start;
    return {
        document,
        selections: selection.multiple ? [{}, {}] : [{}],
        selection: {
            isEmpty: selection.isEmpty ?? true,
            active: selection.active || end,
            start,
            end,
        },
    };
}

function createStatusItem() {
    return {
        text: '',
        tooltip: '',
        command: null,
        visible: false,
        showCount: 0,
        hideCount: 0,
        disposed: false,
        show() { this.visible = true; this.showCount++; },
        hide() { this.visible = false; this.hideCount++; },
        dispose() { this.disposed = true; },
    };
}

function harness(overrides = {}) {
    const document = overrides.document || fakeDocument();
    let editor = overrides.editor || fakeEditor(document);
    let level = overrides.level || 'simple';
    let planResult = overrides.planResult || readyPlan();
    const item = createStatusItem();
    const contexts = [];
    const prompts = [];
    const commands = [];
    const plannedPositions = [];
    const scheduled = [];
    const deps = {
        statusBarItem: item,
        getActiveEditor: () => editor,
        isLsdynaDocument: doc => doc?.languageId === 'lsdyna',
        documentIdentity: doc => doc?.uri?.toString?.() || '',
        getStatusBarLevel: () => level,
        plan: (_doc, position, options) => {
            plannedPositions.push({ position: { ...position }, options: { ...options } });
            return typeof planResult === 'function' ? planResult(position, options) : planResult;
        },
        translate: (key, ...args) => `${key}${args.length ? `:${args.join('|')}` : ''}`,
        setContext: (key, value) => contexts.push([key, value]),
        showInformationMessage: async (...args) => {
            prompts.push(args);
        },
        executeCommand: (command, ...args) => commands.push([command, ...args]),
        schedule: callback => {
            const handle = { callback, cancelled: false };
            scheduled.push(handle);
            return handle;
        },
        cancel: handle => { handle.cancelled = true; },
        debounceMs: 100,
        ...overrides.deps,
    };
    const controller = createActiveFieldChoiceController(deps);
    return {
        controller,
        document,
        item,
        contexts,
        prompts,
        commands,
        plannedPositions,
        scheduled,
        setEditor(value) { editor = value; },
        setLevel(value) { level = value; },
        setPlan(value) { planResult = value; },
    };
}

describe('active field choice controller', () => {
    it('accepts async plans and prevents stale completion from hiding a newer result', async () => {
        let finish;
        const h = harness({ planResult: () => new Promise(resolve => { finish = resolve; }) });
        h.controller.refreshNow();
        assert.equal(h.item.visible, false);
        h.setPlan(readyPlan());
        h.controller.refreshNow();
        assert.equal(h.item.visible, true);
        finish(null);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.item.visible, true);
    });
    it('rejects async plans after document changes or closing', async () => {
        for (const invalidate of [doc => doc.version++, doc => { doc.isClosed = true; }]) {
            let finish;
            const h = harness({ planResult: () => new Promise(resolve => { finish = resolve; }) });
            h.controller.refreshNow();
            invalidate(h.document);
            finish(readyPlan());
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(h.item.visible, false);
            assert.equal(h.controller.getActivePlan(), null);
        }
    });
    it('shows a closed-domain status with an exact identity-only command payload', () => {
        const h = harness();
        const plan = h.controller.refreshNow();

        assert.equal(plan.status, 'ready');
        assert.equal(h.item.visible, true);
        assert.equal(h.item.text, '$(list-selection) officialFieldChoiceStatusClosedLabel:FLAG|5');
        assert.ok(h.item.tooltip.includes('officialFieldChoiceStatusClosedTooltip'));
        assert.equal(h.item.command.command, 'extension.pickOfficialFieldValue');
        assert.deepEqual(h.item.command.arguments[0], {
            uri: 'file:///project/model.k',
            line: 2,
            character: 70,
            documentVersion: 3,
        });
        assert.deepEqual(Object.keys(h.item.command.arguments[0]).sort(), [
            'character', 'documentVersion', 'line', 'uri',
        ]);
        assert.deepEqual(h.contexts.at(-1), [ACTIVE_FIELD_CHOICE_CONTEXT_KEY, true]);
        assert.equal(h.plannedPositions[0].options.maximumKeywordLookback, 0);
    });

    it('uses distinct mixed-domain wording and adds summary/evidence only in detail mode', () => {
        const mixed = readyPlan({
            fieldName: 'TMAX',
            domainKind: 'mixed',
            domainComplete: false,
            choices: [readyPlan().choices[1]],
            summary: 'Mixed curve branch.',
        });
        const simple = harness({
            planResult: mixed,
        });
        simple.controller.refreshNow();
        assert.equal(simple.item.text, '$(info) officialFieldChoiceStatusMixedLabel:TMAX|1');
        assert.ok(!simple.item.tooltip.includes('Mixed curve branch.'));

        const detail = harness({
            planResult: mixed,
            level: 'detail',
        });
        detail.controller.refreshNow();
        assert.ok(detail.item.tooltip.includes('Mixed curve branch.'));
        assert.ok(detail.item.tooltip.includes('manual-vol-ii P832'));

        const uncovered = harness({
            planResult: mixed,
            level: 'detail',
            deps: { presentEvidence: () => null },
        });
        uncovered.controller.refreshNow();
        assert.ok(uncovered.item.tooltip.includes('Mixed curve branch.'));
        assert.ok(!uncovered.item.tooltip.includes('P832'));
    });

    it('supports bilingual tooltip in detail mode with localized summary and fallback notice', () => {
        const planWithZh = readyPlan({
            summary: 'Axis for PTYPE = 1 or 2.',
            localizedSummary: 'PTYPE = 1 或 2 时的坐标轴。',
        });
        const zh = harness({
            planResult: planWithZh,
            level: 'detail',
            deps: {
                isZh: true,
                translate: (key, ...args) => key === 'fieldHelpEnglishOriginal' ? '原文' : `${key}${args.length ? `:${args.join('|')}` : ''}`,
            },
        });
        zh.controller.refreshNow();
        assert.ok(zh.item.tooltip.includes('PTYPE = 1 或 2 时的坐标轴。'));
        assert.ok(zh.item.tooltip.includes('原文: Axis for PTYPE = 1 or 2.'));

        const planWithoutZh = readyPlan({
            summary: 'Untranslated axis summary.',
            localizedSummary: null,
        });
        const fallback = harness({
            planResult: planWithoutZh,
            level: 'detail',
            deps: {
                isZh: true,
                translate: (key, ...args) => key === 'fieldHelpUntranslatedInline' ? '暂无已核对中文说明' : `${key}${args.length ? `:${args.join('|')}` : ''}`,
            },
        });
        fallback.controller.refreshNow();
        assert.ok(fallback.item.tooltip.includes('Untranslated axis summary. （暂无已核对中文说明）'));
    });

    it('dynamically updates tooltip language across multiple switches on the same controller instance', () => {
        let currentLang = 'en';
        const planWithZh = readyPlan({
            summary: 'Axis for PTYPE = 1 or 2.',
            localizedSummary: 'PTYPE = 1 或 2 时的坐标轴。',
        });
        let activePlan = planWithZh;
        const h = harness({
            planResult: () => activePlan,
            level: 'detail',
            deps: {
                getLanguage: () => currentLang,
                translate: (key, ...args) => {
                    const dict = {
                        en: {
                            officialFieldChoiceStatusClosedTooltip: `Choose official value for ${args[0]} (${args[1]} options)`,
                            fieldHelpEnglishOriginal: 'Original',
                            fieldHelpUntranslatedInline: 'no verified Chinese translation',
                        },
                        'zh-cn': {
                            officialFieldChoiceStatusClosedTooltip: `选择 ${args[0]} 的官方取值（${args[1]} 个候选）`,
                            fieldHelpEnglishOriginal: '原文',
                            fieldHelpUntranslatedInline: '暂无已核对中文说明',
                        },
                    };
                    const langDict = dict[currentLang] || dict['en'];
                    return langDict[key] || `${key}:${args.join('|')}`;
                },
            },
        });

        // 1. Initial English state
        h.controller.refreshNow();
        assert.ok(h.item.tooltip.includes('Choose official value for FLAG'));
        assert.ok(h.item.tooltip.includes('Axis for PTYPE = 1 or 2.'));
        assert.ok(!h.item.tooltip.includes('坐标轴'));
        assert.ok(!h.item.tooltip.includes('原文:'));
        assert.ok(!h.item.tooltip.includes('Original:'));

        // 2. Switch to Chinese (zh-cn) on the SAME controller instance
        currentLang = 'zh-cn';
        h.controller.refreshNow();
        assert.ok(h.item.tooltip.includes('选择 FLAG 的官方取值'));
        assert.ok(h.item.tooltip.includes('PTYPE = 1 或 2 时的坐标轴。'));
        assert.ok(h.item.tooltip.includes('原文: Axis for PTYPE = 1 or 2.'));

        // 3. Switch back to English (en) on the SAME controller instance
        currentLang = 'en';
        h.controller.refreshNow();
        assert.ok(h.item.tooltip.includes('Choose official value for FLAG'));
        assert.ok(h.item.tooltip.includes('Axis for PTYPE = 1 or 2.'));
        assert.ok(!h.item.tooltip.includes('坐标轴'));
        assert.ok(!h.item.tooltip.includes('原文:'));

        // 4. Test untranslated fallback switching on the same controller instance
        activePlan = readyPlan({
            summary: 'Untranslated axis summary.',
            localizedSummary: null,
        });

        // Chinese mode: shows untranslated note
        currentLang = 'zh-cn';
        h.controller.refreshNow();
        assert.ok(h.item.tooltip.includes('Untranslated axis summary. （暂无已核对中文说明）'));

        // English mode: shows plain English without untranslated note
        currentLang = 'en';
        h.controller.refreshNow();
        assert.ok(h.item.tooltip.includes('Untranslated axis summary.'));
        assert.ok(!h.item.tooltip.includes('暂无已核对中文说明'));
        assert.ok(!h.item.tooltip.includes('no verified Chinese translation'));
    });

    it('keeps right-click eligibility but does not show status while statusBar.level is off', async () => {
        const h = harness({ level: 'off' });
        assert.equal(h.controller.refreshNow().status, 'ready');
        await Promise.resolve();
        assert.equal(h.plannedPositions.length, 1);
        assert.equal(h.item.visible, false);
        assert.deepEqual(h.contexts.at(-1), [ACTIVE_FIELD_CHOICE_CONTEXT_KEY, true]);
        assert.equal(h.prompts.length, 0);
    });

    it('hides for multiple selections, unsupported plans, and a changed active editor', () => {
        const multi = harness({ editor: fakeEditor(fakeDocument(), { multiple: true }) });
        assert.equal(multi.controller.refreshNow(), null);
        assert.equal(multi.plannedPositions.length, 0);

        const unavailable = harness({ planResult: readyPlan({ status: 'document-unindexed' }) });
        assert.equal(unavailable.controller.refreshNow(), null);
        assert.equal(unavailable.item.visible, false);
        assert.deepEqual(unavailable.contexts.at(-1), [ACTIVE_FIELD_CHOICE_CONTEXT_KEY, false]);

        const changed = harness({
            planResult: () => {
                changed.setEditor(fakeEditor(fakeDocument()));
                return readyPlan();
            },
        });
        assert.equal(changed.controller.refreshNow(), null);
        assert.equal(changed.item.visible, false);
    });

    it('uses the normalized start of a Tab-established cell selection', () => {
        const document = fakeDocument();
        const editor = fakeEditor(document, {
            isEmpty: false,
            start: { line: 2, character: 70 },
            end: { line: 2, character: 80 },
            active: { line: 2, character: 80 },
        });
        const h = harness({
            document,
            editor,
        });
        h.controller.refreshNow();
        assert.deepEqual(h.plannedPositions[0].position, { line: 2, character: 70 });
    });

    it('hides stale status immediately and ignores cancelled debounce generations', () => {
        const h = harness();
        h.controller.refreshNow();
        assert.equal(h.item.visible, true);
        const initialPlanCalls = h.plannedPositions.length;

        h.controller.scheduleRefresh();
        assert.equal(h.item.visible, false);
        h.controller.scheduleRefresh();
        assert.equal(h.scheduled.length, 2);
        assert.equal(h.scheduled[0].cancelled, true);

        h.scheduled[0].callback();
        assert.equal(h.plannedPositions.length, initialPlanCalls);
        h.scheduled[1].callback();
        assert.equal(h.plannedPositions.length, initialPlanCalls + 1);
        assert.equal(h.item.visible, true);
    });

    it('refreshes manual entry points without automatically notifying or opening a picker', async () => {
        for (const domainKind of ['closed', 'mixed']) {
            const h = harness({ planResult: readyPlan({ domainKind }) });
            h.controller.refreshNow();
            h.controller.scheduleRefresh();
            h.scheduled.at(-1).callback();
            await Promise.resolve();
            assert.equal(h.item.visible, true);
            assert.equal(h.item.command.command, 'extension.pickOfficialFieldValue');
            assert.deepEqual(h.prompts, []);
            assert.deepEqual(h.commands, []);
        }
    });

    it('builds a request only from document identity and position', () => {
        const document = fakeDocument();
        assert.deepEqual(
            officialFieldChoiceCommandRequest(document, { line: 2, character: 75 }, doc => doc.uri.toString()),
            {
                uri: 'file:///project/model.k',
                line: 2,
                character: 75,
                documentVersion: 3,
            },
        );
    });

    it('disposes the timer, status item, active plan, and context state', () => {
        const h = harness();
        h.controller.refreshNow();
        h.controller.scheduleRefresh();
        h.controller.dispose();
        assert.equal(h.scheduled[0].cancelled, true);
        assert.equal(h.item.visible, false);
        assert.equal(h.item.disposed, true);
        assert.equal(h.controller.getActivePlan(), null);
        assert.deepEqual(h.contexts.at(-1), [ACTIVE_FIELD_CHOICE_CONTEXT_KEY, false]);
    });
});
