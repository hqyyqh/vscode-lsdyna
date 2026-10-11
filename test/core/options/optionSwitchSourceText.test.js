'use strict';
const assert = require('node:assert/strict');
const { planOptionSwitch, planProvisionalOptionSwitch } = require('../../../out/core/options/optionSwitchPlanner');
const field = (position = 0) => ({ fieldMigrationId: 'x', name: 'X', type: 'integer', position, width: 10 });
const record = fields => ({ recordMigrationId: 'r', fields });
const layout = records => ({ profileId: 'layout', keyword: '*A', records });
const inputFor = (text, fields = [field()], targets = [record([field(10)])]) => ({
    currentKeyword: '*A', targetKeyword: '*B', inputFormat: 'standard',
    currentLayout: layout([record(fields)]), targetLayout: layout(targets),
    records: [{ text, comments: ['$ keep'] }],
});

describe('option switch source text conservation', () => {
    for (const planner of [planOptionSwitch, planProvisionalOptionSwitch]) {
        it(`${planner.name} rejects tails, gaps and deleted records with unmodeled text`, () => {
            for (const input of [inputFor('         7TAIL'),
                inputFor('TAIL               7', [field(10)], [record([field()])]),
                inputFor('         7TAIL', [field()], [record([])]),
                inputFor('          TAIL', [field()], [record([])]),
                inputFor('         7GAP                8', [field(), { ...field(20), fieldMigrationId: 'y' }])]) {
                const plan = planner(input);
                assert.equal(plan.status, 'blocked', plan.reason);
                assert.equal(plan.reason, 'unmodeled-source-text');
                assert.deepEqual(plan.replacementRecords, []);
                assert.equal(input.records[0].comments[0], '$ keep');
            }
        });
        it(`${planner.name} preserves complete unchanged records and permits blank unmodeled columns`, () => {
            const original = '         7TAIL';
            const preserved = planner(inputFor(original, [field()], [record([field()])]));
            assert.equal(preserved.status, 'ready', preserved.reason);
            assert.equal(preserved.replacementRecords[0].text, original);
            const migrated = planner(inputFor('         7      '));
            assert.equal(migrated.status, 'ready', migrated.reason);
            assert.equal(migrated.replacementRecords[0].text.slice(10, 20), '         7');
            assert.equal(migrated.requiresLossConfirmation, false);
            const removed = planner(inputFor('         7      ', [field()], [record([])]));
            assert.equal(removed.status, 'ready', removed.reason);
            assert.equal(removed.requiresLossConfirmation, true);
            assert.deepEqual(removed.discardedFields.map(field => field.value), ['7']);
        });
    }
    it('requires physical coverage from custom readers and uses their actual format ranges', () => {
        const input = { ...inputFor('                   7TAIL'), inputFormat: 'long',
            readField: text => text.slice(0, 20).trim(),
            writeField: (_text, _record, _index, value) => value.padStart(20), createRecord: () => ' '.repeat(20) };
        assert.equal(planOptionSwitch(input).reason, 'source-record-coverage-unproven');
        const coverage = { ...input, readRecordRanges: () => [{ start: 0, end: 20 }] };
        assert.equal(planOptionSwitch(coverage).reason, 'unmodeled-source-text');
        assert.equal(planOptionSwitch({ ...coverage, records: [{ text: '                   7', comments: [] }] }).status, 'ready');
        for (const readRecordRanges of [() => null, () => [{ start: -1, end: 20 }], () => { throw new Error('missing geometry'); }])
            assert.equal(planOptionSwitch({ ...input, readRecordRanges }).reason, 'source-record-coverage-unproven');
    });
    it('rejects unmodeled extra preview rows and keeps keyword-only fallback byte faithful', () => {
        const input = inputFor('         7');
        input.records.push({ text: 'TAIL', comments: ['$ extra'] });
        assert.equal(planProvisionalOptionSwitch(input).reason, 'unmodeled-source-text');
        const fallback = planOptionSwitch({ ...input, applicationMode: 'keyword-only-preserve-block' });
        assert.equal(fallback.status, 'ready');
        assert.deepEqual(fallback.replacementRecords, input.records);
    });
});
