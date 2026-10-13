'use strict';
const assert = require('node:assert/strict');
const { source, outsidePreparation, validate } = require('../../../scripts/release/resume-field-choice-tests.cjs');
describe('field choice recovery provenance', () => {
    it('requires the pinned successful build and limits product changes to prepared choices', () => {
        const target = 'linux-x64', before = 'function other(){return 1;} async function planPreparedOfficialFieldChoices(){return 1;}';
        const after = before.replace('Choices(){return 1', 'Choices(){return 2');
        const run = { headSha: source, headBranch: 'dev', event: 'workflow_dispatch', status: 'completed',
            workflowName: 'Public collaboration / 公开协作', jobs: [
                { name: `Build, data, tests, audit and actual VSIX (ubuntu-22.04, ${target})`, conclusion: 'success' }] };
        validate(run, target, ['src/extension.ts'], before, after);
        assert.throws(() => validate(run, target, ['package-lock.json'], before, after));
        assert.throws(() => validate(run, target, [], before, after.replace('other(){return 1', 'other(){return 2')));
        for (const override of [{ headSha: 'wrong' }, { status: 'in_progress' }, { jobs: [] }])
            assert.throws(() => validate({ ...run, ...override }, target, [], before, after));
        assert.throws(() => outsidePreparation('function other(){}'));
    });
});
