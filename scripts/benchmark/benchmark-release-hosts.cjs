'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const [baseline, candidate, report] = process.argv.slice(2).map(value => path.resolve(value));
const results = { baseline: [], candidate: [] }, failures = [];
const sha = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const identity = { baselineSha256: sha(baseline), candidateSha256: sha(candidate) };
fs.mkdirSync(path.dirname(report), { recursive: true });
try {
    for (const phase of ['hover', 'manager', 'experience']) for (let run = 0; run < 2; run++) {
        for (const name of run % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
            const child = spawnSync(process.execPath, [path.join(__dirname, "../host/run-release-host.cjs"), phase], {
                env: { ...process.env, NODE_PATH: '', LSDYNA_TEST_VSIX: name === 'baseline' ? baseline : candidate },
                encoding: 'utf8', maxBuffer: 16*1024*1024, windowsHide: true, timeout: 180000 });
            const resultFile = /Release host result: (.+)\r?\n/.exec(child.stdout || '')?.[1].trim();
            const result = resultFile ? JSON.parse(fs.readFileSync(resultFile)) : { status: 'failed', error: child.stderr };
            results[name].push(result);
            const warmName = phase === 'experience' ? 'manager-refresh' : phase === 'hover' ? 'warm-hover' : 'warm-manager-command';
            const hasMetrics = Array.isArray(result.metrics) && result.metrics.filter(item => item.name === warmName).length === 2 &&
                (phase === 'experience' ? ['first-manager-rendered', 'manager-refresh', 'manual-open', 'scan'] : ['activation', 'first-' + phase]).every(metricName => result.metrics.some(item => item.name === metricName));
            if (child.status !== 0 || result.status !== 'passed' || result.warmSampleCount !== 2 || !hasMetrics)
                failures.push(`${name}/${phase}/${run}: ${result.error || child.error?.message || (!hasMetrics ? 'missing metrics' : 'incomplete samples')}`);
            fs.writeFileSync(report, JSON.stringify({ ...identity, complete: false, samples: results, failures }, null, 2));
            console.log(`${phase} ${run+1}/2 ${name} ${result.status}`);
        }
    }
    const metrics = [];
    const names = new Set(results.baseline.flatMap(row => (row.metrics || []).map(item => item.name)));
    for (const name of names) for (const field of ['durationMs', 'maxEventLoopGapMs', 'rss', 'peakRss']) {
        const values = key => results[key].flatMap(row => (row.metrics || []).filter(item => item.name === name)
            .map(item => field === 'rss' ? item.memoryAfter.rss : item[field]));
        const before = Math.max(...values('baseline')), after = Math.max(...values('candidate'));
        const allowance = Math.max(before*.05, ['rss', 'peakRss'].includes(field) ? 10*1024*1024 : 20);
        const passed = Number.isFinite(before) && Number.isFinite(after) && after <= before + allowance;
        metrics.push({ name, field, statistic: 'maximum', before, after, allowance, passed, baselineCount: values('baseline').length, candidateCount: values('candidate').length });
        if (!passed) failures.push(`${name}/${field}/maximum`);
    }
    fs.writeFileSync(report, JSON.stringify({ ...identity, complete: !failures.length, scope: 'two-round performance spot check (not percentile certification); installed activation, Hover, rendered manager and refresh, manual rendering and scan; peak RSS is extension-host high-water mark',
        metrics, samples: results, failures }, null, 2));
    assert.deepEqual(failures, []);
} catch (error) {
    const current = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report)) : {};
    fs.writeFileSync(report, JSON.stringify({ ...current, complete: false, error: String(error) }, null, 2));
    console.error(error); process.exitCode = 1;
}
