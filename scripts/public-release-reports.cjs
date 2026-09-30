'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
function identityReport(report) {
    assert.equal(report.complete, true, 'Package identity verification did not pass');
    assert.match(report.vsixSha256, /^[0-9a-f]{64}$/);
    return pick(report, ['complete', 'vsixSha256', 'runtimeFilesChecked', 'packageBytes']);
}
function acceptanceReport(report) {
    return { ...pick(report, ['complete', 'vsixSha256', 'platform', 'vscodeVersion']),
        cases: report.cases.map(item => pick(item, ['name', 'passed'])) };
}
function performanceReport(report) {
    return { ...pick(report, ['complete', 'baselineSha256', 'candidateSha256']),
        metrics: (report.metrics || []).map(item => pick(item,
            ['name', 'field', 'percentile', 'before', 'after', 'allowance', 'passed', 'baselineCount', 'candidateCount'])),
        samples: Object.fromEntries(['baseline', 'candidate'].map(side => [side,
            (report.samples?.[side] || []).map(item => pick(item, ['phase', 'status', 'warmSampleCount']))])) };
}
function exportHostReports(input, output) {
    fs.mkdirSync(output, { recursive: true });
    for (const [name, summarize] of [['acceptance.json', acceptanceReport], ['performance.json', performanceReport]]) {
        const file = path.join(input, name);
        if (fs.existsSync(file)) fs.writeFileSync(path.join(output, name), JSON.stringify(summarize(JSON.parse(fs.readFileSync(file))), null, 2));
    }
}
if (require.main === module) {
    const [input, output] = process.argv.slice(2);
    assert.ok(input && output, 'Usage: public-release-reports.cjs <internal-host-reports> <public-output>');
    exportHostReports(input, output);
}
module.exports = { identityReport, acceptanceReport, performanceReport, exportHostReports };
