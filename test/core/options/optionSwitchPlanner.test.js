'use strict';

const assert = require('node:assert/strict');
const {
    planOptionSwitch,
    OPTION_SWITCH_MAX_BYTES,
    OptionSwitchPlanner,
    planProvisionalOptionSwitch,
} = require('../../../out/core/options/optionSwitchPlanner');

function field(id, name, position, width, extra = {}) {
    return { fieldMigrationId: id, name, type: 'integer', position, width, ...extra };
}

function layout(keyword, records) {
    return { profileId: keyword, keyword, records };
}

describe('official option switch planner', () => {
    it('protects column-one syntax through creation, retention and removal', () => {
        const base = { recordMigrationId: 'base', fields: [field('x', 'X', 0, 10)] };
        const marked = { recordMigrationId: 'mpp2',
            recordMarker: { kind: 'column-one', value: '&', fieldIndex: 0, evidenceIds: ['manual-contact-mpp'] },
            fields: [field('marker', '&', 0, 10, { type: 'string' }), field('pensf', 'PENSF', 10, 10)] };
        const input = { currentKeyword: '*A', targetKeyword: '*B', inputFormat: 'standard',
            currentLayout: layout('*A', [base]), targetLayout: layout('*B', [marked, base]),
            records: [{ text: '         7', comments: ['$ keep'] }] };
        const added = planOptionSwitch(input);
        assert.equal(added.status, 'ready');
        assert.equal(added.replacementRecords[0].text, '&'.padEnd(20));
        assert.equal(added.replacementRecords[1].text, '         7');
        assert.ok(added.emptyTargetFields.every(item => item.name !== '&'));
        const retained = planOptionSwitch({ ...input, currentLayout: input.targetLayout,
            records: added.replacementRecords });
        assert.equal(retained.replacementRecords[0].text, added.replacementRecords[0].text);
        const remove = records => planOptionSwitch({ ...input, currentLayout: input.targetLayout,
            targetLayout: input.currentLayout, records });
        assert.equal(remove(added.replacementRecords).requiresLossConfirmation, false);
        const filled = [{ text: '&         ' + '0.5'.padStart(10), comments: [] }, added.replacementRecords[1]];
        assert.equal(remove(filled).requiresLossConfirmation, true);
        assert.deepEqual(remove(filled).discardedFields.map(item => item.name), ['PENSF']);
        for (const text of ['         &', '&extra    ']) {
            assert.equal(remove([{ text, comments: [] }, added.replacementRecords[1]]).reason,
                'source-record-marker-mismatch');
        }
        assert.equal(planOptionSwitch({ ...input, writeField: () => '         &' }).reason,
            'target-record-marker-mismatch');
    });
    it('exports the stable OptionSwitchPlanner facade', () => {
        const one = layout('*A', [{ recordMigrationId: 'r', fields: [field('x', 'X', 0, 10)] }]);
        const plan = new OptionSwitchPlanner().plan({
            currentKeyword: '*A', targetKeyword: '*A', currentLayout: one, targetLayout: one,
            records: [{ text: '         1', comments: [] }], inputFormat: 'standard',
        });
        assert.equal(plan.status, 'no-change');
    });

    it('migrates a lexical token across columns and leaves new target fields blank', () => {
        const current = layout('*A', [{
            recordMigrationId: 'core:0',
            fields: [field('keep', 'KEEP', 0, 10), field('gone', 'GONE', 10, 10, { removalDisposition: 'official-target-absent' })],
        }]);
        const target = layout('*B', [{
            recordMigrationId: 'core:0',
            fields: [field('new', 'NEW', 0, 10), field('keep', 'KEEP', 10, 10)],
        }]);
        const plan = planOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: current, targetLayout: target,
            records: [{ text: '        &P        42', comments: [] }], inputFormat: 'standard',
        });
        assert.equal(plan.status, 'ready');
        assert.equal(plan.replacementRecords[0].text, '                  &P');
        assert.equal(plan.migratedFields[0].value, '&P');
        assert.deepEqual(plan.discardedFields.map(item => item.value), ['42']);
        assert.equal(plan.emptyTargetFields[0].name, 'NEW');
    });

    it('previews non-empty loss for confirmation and blocks target width overflow', () => {
        const current = layout('*A', [{ recordMigrationId: 'r', fields: [field('x', 'X', 0, 10)] }]);
        const missing = layout('*B', [{ recordMigrationId: 'r', fields: [] }]);
        const loss = planOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: current, targetLayout: missing,
            records: [{ text: '1234567890', comments: [] }], inputFormat: 'standard',
        });
        assert.equal(loss.status, 'ready');
        assert.equal(loss.requiresLossConfirmation, true);
        assert.deepEqual(loss.discardedFields.map(item => item.value), ['1234567890']);

        const narrow = layout('*B', [{ recordMigrationId: 'r', fields: [field('x', 'X', 0, 3)] }]);
        assert.equal(planOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: current, targetLayout: narrow,
            records: [{ text: '1234567890', comments: [] }], inputFormat: 'standard',
        }).reason, 'target-field-width-overflow');
    });

    it('updates only the affected recognized field header and preserves prose', () => {
        const current = layout('*A', [{ recordMigrationId: 'r', fields: [field('x', 'OLD', 0, 10)] }]);
        const target = layout('*B', [{ recordMigrationId: 'r', fields: [field('x', 'NEW', 0, 10)] }]);
        const plan = planOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: current, targetLayout: target,
            records: [{ text: '         7', comments: ['$ engineer note', '$#     old'] }], inputFormat: 'standard',
            analyzeComment: text => text.startsWith('$#')
                ? { recordIndex: 0, style: 'dollar-hash-fixed', labelCase: 'lower', exactMatch: true }
                : null,
            generateComment: () => '$#     new',
        });
        assert.equal(plan.status, 'ready');
        assert.deepEqual(plan.replacementRecords[0].comments, ['$ engineer note', '$#     new']);
        assert.deepEqual(plan.commentChanges.map(change => change.kind), ['replace']);
    });

    it('uses only an explicit approved binding across renamed fields and reorders records by target identity', () => {
        const current = layout('*A', [
            { recordMigrationId: 'second', fields: [field('old-id', 'OLD_ID', 0, 10)] },
            { recordMigrationId: 'first', fields: [field('stable', 'STABLE', 0, 10)] },
        ]);
        const target = layout('*B', [
            { recordMigrationId: 'first', fields: [field('stable', 'STABLE', 0, 10)] },
            { recordMigrationId: 'second', fields: [field('new-id', 'NEW_ID', 10, 10)] },
        ]);
        const plan = planOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: current, targetLayout: target,
            records: [
                { text: '        12', comments: ['$ source second'] },
                { text: '        34', comments: ['$ source first'] },
            ],
            inputFormat: 'standard',
            bindings: [{ sourceFieldMigrationId: 'old-id', targetFieldMigrationId: 'new-id', evidenceId: 'official-binding' }],
        });
        assert.equal(plan.status, 'ready');
        assert.equal(plan.replacementRecords[0].text.trim(), '34');
        assert.equal(plan.replacementRecords[1].text.trim(), '12');
        assert.deepEqual(plan.replacementRecords.map(record => record.comments[0]), ['$ source first', '$ source second']);
    });

    it('does not introduce comments into a commentless block and preserves ambiguous $# headers', () => {
        const current = layout('*A', [{ recordMigrationId: 'r', fields: [field('x', 'X', 0, 10)] }]);
        const target = layout('*B', [
            { recordMigrationId: 'r', fields: [field('x', 'X', 0, 10)] },
            { recordMigrationId: 'new', fields: [field('y', 'Y', 0, 10)] },
        ]);
        const clean = planOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: current, targetLayout: target,
            records: [{ text: '         1', comments: [] }], inputFormat: 'standard',
            generateComment: () => '$#       y',
        });
        assert.equal(clean.status, 'ready');
        assert.deepEqual(clean.replacementRecords[1].comments, []);

        const changed = layout('*B', [{ recordMigrationId: 'r', fields: [field('z', 'Z', 0, 10)] }]);
        const ambiguous = planOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: current, targetLayout: changed,
            records: [{ text: '         1', comments: ['$# mystery'] }], inputFormat: 'standard',
            analyzeComment: () => null,
            generateComment: () => '$#       z',
        });
        assert.equal(ambiguous.status, 'ready');
        assert.deepEqual(ambiguous.replacementRecords[0].comments, ['$# mystery']);
    });

    it('fails closed for non-standard input and the 8 MiB budget', () => {
        const one = layout('*A', [{ recordMigrationId: 'r', fields: [field('x', 'X', 0, 10)] }]);
        assert.equal(planOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: one, targetLayout: one,
            records: [{ text: '1,2', comments: [] }], inputFormat: 'free',
        }).reason, 'non-standard-input');
        assert.equal(planOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: one, targetLayout: one,
            records: [{ text: ' '.repeat(100), comments: [] }], inputFormat: 'standard', maxBytes: 10,
        }).reason, 'edit-budget-exceeded');
        assert.equal(OPTION_SWITCH_MAX_BYTES, 8 * 1024 * 1024);
    });

    it('blocks repeat and conditional layouts until one physical occurrence is resolved', () => {
        const current = layout('*A', [{
            recordMigrationId: 'r', occurrence: { kind: 'repeat' }, fields: [field('x', 'X', 0, 10)],
        }]);
        const target = layout('*B', [{
            recordMigrationId: 'r', occurrence: { kind: 'exactly-once' }, fields: [field('x', 'X', 0, 10)],
        }]);
        assert.equal(planOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: current, targetLayout: target,
            records: [{ text: '         1', comments: [] }], inputFormat: 'standard',
        }).reason, 'repeat-or-conditional-occurrence-unresolved');
    });

    it('blocks overlapping fixed-column fields before planning a writable switch', () => {
        const overlapping = layout('*A', [{
            recordMigrationId: 'r',
            fields: [field('x', 'X', 0, 10), field('y', 'Y', 5, 10)],
        }]);
        const target = layout('*B', [{
            recordMigrationId: 'r', fields: [field('x', 'X', 0, 10)],
        }]);
        assert.equal(planOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: overlapping, targetLayout: target,
            records: [{ text: '              1', comments: [] }], inputFormat: 'standard',
        }).reason, 'overlapping-field-migration');
    });

    it('moves an authorized shared record intact and blocks reshaping its fields', () => {
        const shared = { recordMigrationId: 'shared', sharedByteEditing: 'native-shared-bytes-v1',
            fields: [field('x', 'X', 0, 10), field('y', 'Y', 5, 10)] };
        const normal = { recordMigrationId: 'normal', fields: [field('z', 'Z', 0, 10)] };
        const input = { currentKeyword: '*A', targetKeyword: '*B', inputFormat: 'standard',
            currentLayout: layout('*A', [shared, normal]), targetLayout: layout('*B', [normal, shared]),
            records: [{ text: '   123     456 ', comments: [] }, { text: '         9', comments: [] }] };
        const plan = planOptionSwitch(input);
        assert.equal(plan.status, 'ready', plan.reason);
        assert.equal(plan.replacementRecords[1].text, input.records[0].text);
        const changed = structuredClone(shared);
        changed.fields[1].position++;
        assert.equal(planOptionSwitch({ ...input, targetLayout: layout('*B', [normal, changed]) }).reason,
            'shared-byte-layout-change');
    });

    it('preserves the complete block in keyword-only spelling mode', () => {
        const empty = layout('*A', []);
        const records = [
            { text: '  original data  ', comments: ['$ note', '$# header'] },
            { text: '', comments: [] },
        ];
        const plan = planOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: empty, targetLayout: empty,
            records, inputFormat: 'standard', applicationMode: 'keyword-only-preserve-block',
        });
        assert.equal(plan.status, 'ready');
        assert.equal(plan.applicationMode, 'keyword-only-preserve-block');
        assert.deepEqual(plan.replacementRecords, records);
        assert.equal(plan.requiresLossConfirmation, false);
    });
});

describe('provisional option preview planner', () => {
    it('maps by name/type, card slot and ordinal without blocking unmatched fields', () => {
        const current = layout('*A', [{
            recordMigrationId: 'source-card',
            fields: [field('old-x', 'X', 0, 10), field('old-y', 'Y', 10, 10)],
        }]);
        const target = layout('*B', [{
            recordMigrationId: 'target-card',
            fields: [field('new-x', 'X', 10, 10), field('new-z', 'Z', 20, 10), field('new-q', 'Q', 30, 10)],
        }]);
        const plan = planProvisionalOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B', currentLayout: current, targetLayout: target,
            records: [{ text: '         1         2', comments: ['$ note'] }], inputFormat: 'standard',
        });
        assert.equal(plan.status, 'ready');
        assert.equal(plan.provisional, true);
        assert.equal(plan.migratedFields[0].mapping, 'name-type');
        assert.equal(plan.migratedFields[0].value, '1');
        assert.ok(plan.unmatchedFields.some(item => item.name === 'Q'));
        assert.deepEqual(plan.replacementRecords[0].comments, ['$ note']);
    });

    it('preserves the complete block when a target has no layout', () => {
        const records = [{ text: 'raw data', comments: ['$ user'] }];
        const plan = planProvisionalOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*B',
            currentLayout: layout('*A', [{ recordMigrationId: 'r', fields: [field('x', 'X', 0, 10)] }]),
            targetLayout: layout('*B', []), records, inputFormat: 'standard',
        });
        assert.equal(plan.status, 'ready');
        assert.equal(plan.applicationMode, 'keyword-only-preserve-block');
        assert.deepEqual(plan.replacementRecords, records);
        assert.ok(plan.unmatchedFields.some(item => item.kind === 'layout-unavailable'));
    });

    it('leaves a target-only TITLE record blank and aligns shared records by stable identity', () => {
        const current = layout('*A', [{
            recordMigrationId: 'data-card', fields: [field('mid', 'MID', 0, 10)],
        }]);
        const target = layout('*A_TITLE', [
            { recordMigrationId: 'title-card', fields: [field('title', 'TITLE', 0, 80, 'string')] },
            { recordMigrationId: 'data-card', fields: [field('mid', 'MID', 0, 10)] },
        ]);
        const plan = planProvisionalOptionSwitch({
            currentKeyword: '*A', targetKeyword: '*A_TITLE', currentLayout: current, targetLayout: target,
            records: [{ text: '         1'.padEnd(80), comments: [] }], inputFormat: 'standard',
        });

        assert.equal(plan.status, 'ready');
        assert.equal(plan.replacementRecords[0].text.trim(), '');
        assert.equal(plan.replacementRecords[1].text.slice(0, 10), '         1');
        assert.equal(plan.migratedFields[0].sourceRecordMigrationId, 'data-card');
        assert.equal(plan.migratedFields[0].targetRecordMigrationId, 'data-card');
    });
});


describe('option-switch comment preservation', () => {
    it('preserves unknown comments in source order before the next surviving record or at block end', () => {
        const records = ['a', 'b', 'c', 'd'].map(id => ({ recordMigrationId: id, fields: [field(id, id, 0, 10)] }));
        const input = { currentKeyword: '*A', targetKeyword: '*B', currentLayout: layout('*A', records),
            targetLayout: layout('*B', [records[2]]),
            records: records.map((_, i) => ({ text: ' '.repeat(10), comments: ['$# unknown ' + i] })),
            analyzeComment: () => null };
        const plan = planOptionSwitch(input);
        assert.equal(plan.status, 'ready');
        assert.deepStrictEqual(plan.replacementRecords[0].comments, ['$# unknown 0', '$# unknown 1', '$# unknown 2']);
        assert.deepStrictEqual(plan.trailingComments, ['$# unknown 3']);
        assert.equal(plan.requiresLossConfirmation, false);
        const empty = planOptionSwitch({ ...input, targetLayout: layout('*B', []) });
        assert.equal(empty.status, 'ready');
        assert.deepStrictEqual(empty.replacementRecords, []);
        assert.deepStrictEqual(empty.trailingComments, input.records.flatMap(r => r.comments));
    });

    it('keeps data migration available when comment generation throws', () => {
        const current = layout('*A', [{ recordMigrationId: 'r', fields: [field('id', 'OLD', 0, 10)] }]);
        const target = layout('*B', [{ recordMigrationId: 'r', fields: [field('id', 'NEW', 0, 10)] }]);
        const plan = planOptionSwitch({ currentKeyword: '*A', targetKeyword: '*B', currentLayout: current,
            targetLayout: target, records: [{ text: '         7', comments: ['$# old'] }],
            analyzeComment: (_text, cards) => { assert.equal(cards.length, 1); return {
                exactMatch: true, recordIndex: 0, style: 'dollar-hash-fixed', labelCase: 'lower' }; },
            generateComment: () => { throw new Error('cannot render'); } });
        assert.equal(plan.status, 'ready');
        assert.deepStrictEqual(plan.replacementRecords[0], { text: '         7', comments: ['$# old'] });
    });
    it('serializes orphan comments before existing block-tail comments without a fake data row', function () {
        this.timeout(10000);
        const { optionSwitchReplacement } = require('../../../src/extension')._internals;
        const { fakeDoc } = require("../../support/helpers");
        const document = fakeDoc('*A\n          \n*END');
        const replacement = optionSwitchReplacement(document, { keywordLine: 0 }, {
            plan: { targetKeyword: '*B', replacementRecords: [], trailingComments: ['$ orphan'] },
            block: { blockEnd: 2, trailingComments: ['$ original tail'] },
        });
        assert.equal(replacement.text, '*B\n$ orphan\n$ original tail\n');
        assert.equal(replacement.range.end.line, 2);
    });

});
