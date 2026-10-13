'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), yaml = require('js-yaml');
const { validate, cases, source, unchangedTests } = require('../../../scripts/release/resume-manager-reader-tests.cjs');
describe('scoped manager reader recovery provenance', () => {
    const target = 'win32-x64';
    const run = () => ({ headSha: source, headBranch: 'dev', event: 'workflow_dispatch', status: 'completed',
        workflowName: 'Public collaboration / 公开协作', jobs: [{ databaseId: 1,
            name: `Build, data, tests, audit and actual VSIX (windows-2022, ${target})`, conclusion: 'failure', steps: [
                { name: 'Build all product components', conclusion: 'success' },
                { name: 'Verify deterministic public data and source inventory', conclusion: 'success' },
                { name: 'Test the existing build; replay the full corpus once', conclusion: 'failure' },
            ] }] });
    const log = '\n 4051 passing (20m)\n 6 failing\n' + cases.map((c, i) => `\n ${i + 1}) ${c[1]}\n      ${c[2]}:\n\n AssertionError\n`).join('');
    it('retains only compatible completed passes with all six known failures accounted for', () => {
        assert.equal(validate(run(), target, log, cases.map(c => 'test/' + c[0])).passing, 4051);
        const otherSource = run(); otherSource.headSha = 'a'.repeat(40);
        const incomplete = run(); incomplete.status = 'in_progress';
        const buildFailed = run(); buildFailed.jobs[0].steps[0].conclusion = 'failure';
        for (const invalid of [otherSource, incomplete, buildFailed]) assert.throws(() => validate(invalid, target, log, []));
        for (const invalid of [log.replace('4051 passing', '4050 passing'), log.replace(cases[0][2], 'different failure'), log.replace('6 failing', '7 failing')])
            assert.throws(() => validate(run(), target, invalid, []));
        assert.throws(() => validate(run(), target, log, ['src/extension.ts']));
        assert.throws(() => validate(run(), 'linux-x64', log, []));
    });
    it('does not reuse changed unselected assertions or setup', () => {
        const original = `describe('suite', () => { it('${cases[0][2]}', () => { oldAssertion(); }); it('other', () => { safe(); }); });`;
        const fixed = original.replace(cases[0][2], cases[0][3]).replace('oldAssertion()', 'readonlyAssertion()');
        assert.equal(unchangedTests(original), unchangedTests(fixed));
        assert.notEqual(unchangedTests(original), unchangedTests(fixed.replace('safe()', 'unsafe()')));
        assert.notEqual(unchangedTests(original), unchangedTests('setup();' + fixed));
    });
    it('keeps downstream data, packaging and six installed checks after scoped recovery', () => {
        const workflow = yaml.load(fs.readFileSync('.github/workflows/public-ci.yml', 'utf8'));
        const steps = workflow.jobs['public-checks'].steps;
        const unit = steps.find(s => s.name?.startsWith('Test the existing build'));
        assert.match(unit.run, /resume-manager-reader-tests\.cjs/);
        assert.match(unit.run, /managerReaderRecovery\.test\.js/);
        assert.ok(unit.run.trim().endsWith('npm run test:data'));
        assert.equal(unit.env.UNIT_RESUME_RUN, '${{ inputs.resume_run }}');
        assert.ok(steps.some(s => s.run?.includes('package-hover-release.cjs')));
        assert.deepEqual(workflow.jobs['installed-host'].strategy.matrix.vscode, ['1.100.0', '1.139.1']);
        assert.equal(workflow.env.LSDYNA_CI_FUNCTIONAL_ONLY, '1');
    });
});
