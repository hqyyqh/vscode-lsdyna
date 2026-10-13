'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
function identityReport(report) {
    assert.equal(report.complete, true, 'Package identity verification did not pass');
    assert.match(report.vsixSha256, /^[0-9a-f]{64}$/);
    return pick(report, ['complete', 'vsixSha256', 'runtimeFilesChecked', 'packageBytes']);
}
function acceptanceReport(report) {
    return { ...pick(report, ['complete', 'scope', 'excludedChecks', 'vsixSha256', 'platform', 'arch', 'vscodeVersion', 'requestedVscodeVersion', 'reusedFromRun']),
        cases: report.cases.map(item => pick(item, ['name', 'passed', 'reused'])) };
}
function performanceReport(report) {
    return { ...pick(report, ['complete', 'baselineSha256', 'candidateSha256', 'phases', 'selectedPhasesPassed', 'scope']),
        metrics: (report.metrics || []).map(item => pick(item,
            ['name', 'field', 'statistic', 'before', 'after', 'allowance', 'passed', 'baselineCount', 'candidateCount'])),
        samples: Object.fromEntries(['baseline', 'candidate'].map(side => [side,
            (report.samples?.[side] || []).map(item => ({ ...pick(item, ['phase', 'status', 'warmSampleCount', 'vscodeVersion', 'platform', 'arch']),
                ...(item.metrics ? { metrics: item.metrics.map(metric => ({ ...pick(metric, ['name', 'durationMs', 'maxEventLoopGapMs']),
                    ...(metric.gaps ? { gaps: metric.gaps.map(gap => pick(gap, ['ms', 'activeMs', 'idleMs'])) } : {}) })) } : {}) }))])) };
}
function exportHostReports(input, output) {
    fs.mkdirSync(output, { recursive: true });
    const editor = path.join(input, 'editor-remaining.json');
    if (fs.existsSync(editor)) {
        const report = JSON.parse(fs.readFileSync(editor));
        fs.writeFileSync(path.join(output, 'editor-remaining.json'), JSON.stringify({ required: report.required, cases: report.cases.map(item => pick(item, ['name', 'status', 'required', 'reason'])) }, null, 2));
    }
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
