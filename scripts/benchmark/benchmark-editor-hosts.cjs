'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const [baseline, candidate, output] = process.argv.slice(2).map(value => path.resolve(value));
if (!baseline || !candidate || !output) throw Error('Usage: benchmark-editor-hosts.cjs baseline.vsix candidate.vsix report.json');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const packages = { baseline, candidate }, identities = { baseline: hash(baseline), candidate: hash(candidate) };
const versions = ['1.100.0', '1.136.2'];
const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output)) : { complete: false, identities, samples: [], failures: [] };
require('node:assert/strict').deepEqual(report.identities, identities, 'Do not resume with different packages');
if (!report.samples.length && process.argv[5]) {
    const file = path.resolve(process.argv[5]), fixed = JSON.parse(fs.readFileSync(file));
    require('node:assert/strict').equal(fixed.identities.baseline, identities.baseline, 'Fixed baseline package must match');
    report.fixedBaseline = { file, sha256: hash(file) };
    report.samples = fixed.samples.filter(row => row.name === 'baseline');
    report.failures = fixed.failures.filter(row => row.name === 'baseline');
}
for (const row of report.samples) require('node:assert/strict').ok(versions.includes(row.version) && row.result?.vscodeVersion === row.version,
    'Resumed sample actual host version must match its requested version');
const save = () => { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); };
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
for (const version of versions) for (const phase of ['activation', 'hover', 'manager', 'choices']) {
    for (let run = 0; run < 3; run++) for (const name of run % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        if (report.samples.some(row => row.version === version && row.phase === phase && row.run === run && row.name === name)) continue;
        const executable = path.resolve(__dirname, `../../.vscode-test/vscode-win32-x64-archive-${version}/Code.exe`);
        if (!fs.existsSync(executable)) throw Error(`VS Code ${version} executable is missing: ${executable}; download the requested host before benchmarking`);
        const child = spawnSync(process.execPath, [path.join(__dirname, "../host/run-release-host.cjs"), phase], {
            encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000, windowsHide: true,
            env: { ...process.env, VSCODE_EXECUTABLE_PATH: executable, VSCODE_TEST_VERSION: version,
                LSDYNA_TEST_VSIX: packages[name], LSDYNA_TEST_VSIX_SHA256: identities[name] },
        });
        const log = `${output}.${version}.${phase}.${run}.${name}.log`;
        fs.writeFileSync(log, (child.stdout || '') + (child.stderr || ''));
        const resultFile = /Release host result: (.+)\r?\n/.exec(child.stdout || '')?.[1].trim();
        const result = resultFile ? JSON.parse(fs.readFileSync(resultFile)) : { status: 'failed', error: child.error?.message || 'No host result' };
        const versionMatches = result.vscodeVersion === version;
        report.samples.push({ version, phase, run, name, result, log });
        if (child.status !== 0 || result.status !== 'passed' || !versionMatches) report.failures.push({ version, phase, run, name,
            kind: versionMatches && result.functionalChecksPassed ? 'performance' : 'functional',
            error: !versionMatches ? `Actual host version ${result.vscodeVersion || 'unknown'} differs from requested ${version}` : result.error });
        save();
        console.log(JSON.stringify({ version, phase, run, name, status: result.status,
            metrics: result.metrics?.filter(item => !item.name.startsWith('warm-')).map(item => ({ name: item.name,
                ms: item.durationMs, gap: item.maxEventLoopGapMs })) }));
    }
}
report.gates = [];
for (const version of versions) for (const phase of ['activation', 'hover', 'manager', 'choices']) {
    const rows = name => report.samples.filter(row => row.version === version && row.phase === phase && row.name === name);
    const before = rows('baseline'), after = rows('candidate');
    const metrics = (rows, select, field) => rows.flatMap(row => (row.result.metrics || []).filter(select).map(item => field(item)));
    const coldName = phase === 'activation' ? 'activation' : 'first-' + phase;
    const cold = name => rows(name).map(row => (row.result.metrics || [])
        .filter(item => item.name === 'activation' || item.name === coldName)
        .reduce((sum, item) => sum + item.durationMs, 0));
    const beforeMedian = quantile(cold('baseline'), .5), afterMedian = quantile(cold('candidate'), .5);
    const maxGap = Math.max(...metrics(after, () => true, item => item.maxEventLoopGapMs));
    const rss = rows => Math.max(...rows.map(row => row.result.peakRssBytes ||
        Math.max(...metrics([row], () => true, item => item.memoryAfter.rss))));
    const gate = { version, phase, coldMetric: 'activation-plus-first-available', beforeMedian, afterMedian, maxGap, beforeRss: rss(before), afterRss: rss(after),
        cold: afterMedian <= beforeMedian + Math.max(beforeMedian * .05, 20), synchronous: maxGap <= 100,
        memory: rss(after) <= rss(before) + Math.max(rss(before) * .05, 10 * 1024 * 1024) };
    if (phase !== 'activation') {
        gate.warm = after.every(row => {
            const candidateP95 = row.result.warmP95Ms;
            const baselineP95 = before.find(other => other.run === row.run)?.result.warmP95Ms;
            return row.result.warmSampleCount >= 30 && candidateP95 <= baselineP95 + Math.max(baselineP95 * .05, 2);
        });
    }
    report.gates.push(gate);
}
report.complete = !report.failures.some(failure => failure.name === 'candidate' || failure.kind !== 'performance') &&
    report.gates.every(gate => gate.cold && gate.synchronous && gate.memory && gate.warm !== false);
save();
console.log(JSON.stringify({ complete: report.complete, gates: report.gates, failures: report.failures }));
if (!report.complete) process.exitCode = 1;
