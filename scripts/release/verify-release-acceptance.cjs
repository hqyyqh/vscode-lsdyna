'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
function verify(vsix, directory, target) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex');
    const baselineSha = crypto.createHash('sha256').update(fs.readFileSync(vsix + '.baseline.vsix')).digest('hex');
    const walk = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(item => item.isDirectory()
        ? walk(path.join(root, item.name)) : item.name === 'acceptance.json' ? [path.join(root, item.name)] : []);
    const reports = walk(directory).map(file => ({ file, data: JSON.parse(fs.readFileSync(file)) }));
    if (target) assert.ok(['win32-x64', 'linux-x64', 'darwin-arm64'].includes(target), 'Unknown release target');
    const platforms = target ? [target.split('-')[0]] : ['win32', 'linux', 'darwin'];
    for (const platform of platforms) for (const version of ['1.100.0', '1.139.1']) {
        const matches = reports.filter(item => item.data.platform === platform && item.data.vscodeVersion === version && item.data.vsixSha256 === sha);
        assert.equal(matches.length, 1, `Missing or ambiguous acceptance for ${platform}/${version}`);
        const { file, data } = matches[0]; assert.equal(data.complete, true);
        if (target) assert.equal(data.arch, target.split('-')[1], 'Acceptance architecture mismatch');
        const required = ['run-release-host.cjs-catalog', 'run-release-host.cjs-smoke', 'test-release-manual-renderer.cjs',
            'run-keyword-manager-gui.cjs', 'run-keyword-manager-gui.cjs-incomplete', 'benchmark-keyword-manager-webview.cjs',
            'run-editor-safety-extension-host.cjs', 'run-large-file-viewer-host.cjs',
            'upgrade', 'reload', 'offline', 'missing-external-manual'];
        if (platform === 'win32') required.push('ordinary-project-f5');
        for (const name of required) assert.ok(data.cases.some(item => item.name === name && item.passed === true), `Missing acceptance case ${name}`);
        const performance = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'performance.json')));
        assert.equal(performance.candidateSha256, sha); assert.equal(performance.complete, true);
        assert.equal(performance.baselineSha256, baselineSha, 'Performance baseline does not match the paired build');
        assert.ok(performance.metrics?.length && performance.metrics.every(item => item.passed === true), 'Missing or failed performance metrics');
        for (const name of ['activation', 'first-hover', 'warm-hover', 'first-manager', 'warm-manager-command'])
            for (const field of ['durationMs', 'maxEventLoopGapMs', 'rss']) for (const p of [.5, .95])
                assert.ok(performance.metrics.some(item => item.name === name && item.field === field && item.percentile === p),
                    `Missing performance distribution ${name}/${field}/${p}`);
        // Command completion is not rendered readiness, and final RSS is not peak RSS.
        // These distributions intentionally block publication until their collectors exist.
        for (const name of ['first-manager-rendered', 'manager-refresh', 'manual-open', 'scan'])
            for (const field of ['durationMs', 'maxEventLoopGapMs', 'peakRss']) for (const p of [.5, .95])
                assert.ok(performance.metrics.some(item => item.name === name && item.field === field && item.percentile === p
                    && item.baselineCount >= (name === 'manager-refresh' ? 100 : 20)
                    && item.candidateCount >= (name === 'manager-refresh' ? 100 : 20)),
                    `Missing full-plan performance distribution ${name}/${field}/${p}`);
        for (const side of ['baseline', 'candidate']) for (const phase of ['hover', 'manager', 'experience']) {
            const samples = performance.samples[side].filter(item => item.phase === phase);
            assert.equal(samples.length, 20, `${side}/${phase} needs 20 cold samples`);
            assert.ok(samples.every(item => item.status === 'passed' && item.warmSampleCount === 100
                && item.vscodeVersion === version && item.platform === platform
                && (!target || item.arch === target.split('-')[1])), 'Performance sample host identity or completeness mismatch');
        }
    }
    return { complete: true, vsixSha256: sha, platforms: platforms.length, versions: 2 };
}
if (require.main === module) { console.log(JSON.stringify(verify(...process.argv.slice(2)))); }
module.exports = { verify };
