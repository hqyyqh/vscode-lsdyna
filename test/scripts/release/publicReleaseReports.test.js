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
        const acceptance = acceptanceReport({ complete: false, vsixSha256: 'a'.repeat(64), platform: 'win32', vscodeVersion: '1.100.0',
            ...privateData, cases: [{ name: 'catalog', passed: false, ...privateData }] });
        assert.deepEqual(acceptance.cases, [{ name: 'catalog', passed: false }]);
        const performance = performanceReport({ complete: true, ...privateData, baselineSha256: 'b'.repeat(64), candidateSha256: 'a'.repeat(64),
            metrics: [{ name: 'scan', field: 'peakRss', percentile: .95, before: 1, after: 1, allowance: 1,
                passed: true, baselineCount: 20, candidateCount: 20, ...privateData }],
            samples: { baseline: [{ phase: 'hover', status: 'passed', warmSampleCount: 100, ...privateData }], candidate: [] } });
        assert.equal(performance.metrics[0].baselineCount, 20);
        assert.deepEqual(performance.samples.baseline, [{ phase: 'hover', status: 'passed', warmSampleCount: 100 }]);
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
        assert.ok(!workflow.includes('path: .artifacts/'));
    });
});
