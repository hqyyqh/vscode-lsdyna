'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { identityReport, acceptanceReport, performanceReport } = require("../../../scripts/release/public-release-reports.cjs");
describe('public release report boundary', () => {
    it('keeps gate inputs and omits local paths, errors, inventories and raw measurements', () => {
        const privateData = { file: 'C:/private/extractor.py', error: 'private callback', files: [{ file: 'private' }] };
        const identity = identityReport({ complete: true, vsixSha256: 'a'.repeat(64), runtimeFilesChecked: 3, packageBytes: 4, ...privateData });
        assert.deepEqual(identity, { complete: true, vsixSha256: 'a'.repeat(64), runtimeFilesChecked: 3, packageBytes: 4 });
        assert.throws(() => identityReport({ complete: false }), /did not pass/);
        const acceptance = acceptanceReport({ complete: false, scope: 'required-functional-acceptance', excludedChecks: ['performance', 'native-system-menu'], vsixSha256: 'a'.repeat(64), platform: 'win32', vscodeVersion: '1.100.0',
            ...privateData, cases: [{ name: 'catalog', passed: false, ...privateData }] });
        assert.deepEqual(acceptance.excludedChecks, ['performance', 'native-system-menu']);
        assert.equal(acceptance.scope, 'required-functional-acceptance');
        assert.deepEqual(acceptance.cases, [{ name: 'catalog', passed: false }]);
        const performance = performanceReport({ complete: true, ...privateData, baselineSha256: 'b'.repeat(64), candidateSha256: 'a'.repeat(64),
            metrics: [{ name: 'scan', field: 'peakRss', statistic: 'maximum', before: 1, after: 1, allowance: 1,
                passed: true, baselineCount: 2, candidateCount: 2, ...privateData }],
            samples: { baseline: [{ phase: 'hover', status: 'passed', warmSampleCount: 2, ...privateData }], candidate: [] } });
        assert.equal(performance.metrics[0].baselineCount, 2);
        assert.deepEqual(performance.samples.baseline, [{ phase: 'hover', status: 'passed', warmSampleCount: 2 }]);
        assert.ok(!JSON.stringify([identity, acceptance, performance]).includes('private'));
    });
    it('uploads only declared packages and public summaries in both workflows', () => {
        for (const name of ['ci.yml', 'release.yml']) {
            const workflow = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows', name), 'utf8');
            assert.ok(workflow.includes('uses: ./.github/workflows/public-ci.yml'));
            assert.ok(!workflow.includes('path: .artifacts/'));
        }
        const workflow = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/public-ci.yml'), 'utf8');
        assert.ok(workflow.includes('node scripts/release/public-release-reports.cjs'));
        assert.ok(workflow.includes('path: public-acceptance'));
        assert.ok(!/path:.*\.vsix.*\*/.test(workflow));
        // Scoped unit continuation publishes its reviewed provenance bundle only.
        assert.deepEqual(workflow.match(/path: \.artifacts\/[^\r\n]+/g), ['path: .artifacts/unit-recovery']);
    });
    it('preserves a passed selected phase as incomplete public evidence', () => {
        const report=performanceReport({complete:false,phases:['experience'],selectedPhasesPassed:true,
            scope:'two-round performance spot check (not percentile certification)',metrics:[]});
        assert.equal(report.complete,false);assert.equal(report.selectedPhasesPassed,true);
        assert.deepEqual(report.phases,['experience']);assert.match(report.scope,/not percentile/);
    });
    it('preserves interval diagnostics without exporting nested private data', () => {
        const report = performanceReport({ samples: { candidate: [{ phase: 'manager', metrics: [{
            name: 'first-manager', durationMs: 250, maxEventLoopGapMs: 180, file: 'private',
            gaps: [{ ms: 180, activeMs: 5, idleMs: 175, endUs: 123456, error: 'private' }],
        }] }] } });
        assert.deepEqual(report.samples.candidate[0].metrics, [{ name: 'first-manager', durationMs: 250,
            maxEventLoopGapMs: 180, gaps: [{ ms: 180, activeMs: 5, idleMs: 175 }] }]);
        assert.ok(!JSON.stringify(report).includes('private'));
    });
});
