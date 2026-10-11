'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { verify } = require("../../../scripts/release/verify-release-acceptance.cjs");
const { performanceReport } = require("../../../scripts/release/public-release-reports.cjs");
describe('immutable release acceptance gate', () => {
    it('requires all six platform/version reports for exactly the candidate hash', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-test-')), vsix = path.join(root, 'candidate.vsix');
        try {
            fs.writeFileSync(vsix, 'candidate');
            fs.writeFileSync(vsix + '.baseline.vsix', 'baseline');
            const sha = crypto.createHash('sha256').update('candidate').digest('hex');
            const baselineSha = crypto.createHash('sha256').update('baseline').digest('hex');
            assert.throws(() => verify(vsix, root), /Missing/);
            const names = ['run-release-host.cjs-catalog', 'run-release-host.cjs-smoke', 'test-release-manual-renderer.cjs',
                'run-keyword-manager-gui.cjs', 'run-keyword-manager-gui.cjs-incomplete', 'benchmark-keyword-manager-webview.cjs',
                'run-editor-safety-extension-host.cjs', 'run-large-file-viewer-host.cjs',
                'upgrade', 'reload', 'offline', 'missing-external-manual', 'ordinary-project-f5'];
            let last;
            for (const platform of ['win32', 'linux', 'darwin']) for (const version of ['1.100.0', '1.139.1']) {
                const directory = path.join(root, platform + version); fs.mkdirSync(directory);
                last = path.join(directory, 'acceptance.json');
                fs.writeFileSync(last, JSON.stringify({ complete: true, platform, arch: platform === 'darwin' ? 'arm64' : 'x64', vscodeVersion: version, vsixSha256: sha,
                    cases: names.map(name => ({ name, passed: true })) }));
                const samples = ['hover', 'manager', 'experience'].flatMap(phase => Array.from({ length: 20 }, () => ({ phase, status: 'passed', warmSampleCount: 100, vscodeVersion: version, platform, arch: platform === 'darwin' ? 'arm64' : 'x64' })));
                const metrics = ['activation', 'first-hover', 'warm-hover', 'first-manager', 'warm-manager-command'].flatMap(name =>
                    ['durationMs', 'maxEventLoopGapMs', 'rss'].flatMap(field => [.5, .95].map(percentile => ({ name, field, percentile, passed: true }))));
                metrics.push(...['first-manager-rendered', 'manager-refresh', 'manual-open', 'scan'].flatMap(name =>
                    ['durationMs', 'maxEventLoopGapMs', 'peakRss'].flatMap(field => [.5, .95].map(percentile =>
                        ({ name, field, percentile, passed: true, baselineCount: 100, candidateCount: 100 })))));
                fs.writeFileSync(path.join(directory, 'performance.json'), JSON.stringify(performanceReport({ complete: true, candidateSha256: sha, baselineSha256: baselineSha,
                    metrics, samples: { baseline: samples, candidate: samples }, internalPath: 'private' })));
            }
            assert.equal(verify(vsix, root).complete, true);
            assert.equal(verify(vsix, root, 'win32-x64').platforms, 1);
            assert.equal(verify(vsix, root, 'darwin-arm64').platforms, 1);
            const architectureFile = path.join(root, 'darwin1.100.0/acceptance.json');
            const architectureReport = JSON.parse(fs.readFileSync(architectureFile));
            fs.writeFileSync(architectureFile, JSON.stringify({...architectureReport, arch: 'x64'}));
            assert.throws(() => verify(vsix, root, 'darwin-arm64'), /architecture mismatch/);
            fs.writeFileSync(architectureFile, JSON.stringify(architectureReport));
            assert.throws(() => verify(vsix, root, 'darwin-x64'), /Unknown release target/);
            const performanceFile = path.join(path.dirname(last), 'performance.json');
            const performance = JSON.parse(fs.readFileSync(performanceFile));
            const wrongHost = JSON.parse(JSON.stringify(performance));
            wrongHost.samples.candidate[0].vscodeVersion = '0.0.0';
            fs.writeFileSync(performanceFile, JSON.stringify(wrongHost));
            assert.throws(() => verify(vsix, root), /Performance sample host identity/);
            const withoutPeak = { ...performance, metrics: performance.metrics.filter(item => item.field !== 'peakRss') };
            fs.writeFileSync(performanceFile, JSON.stringify(withoutPeak));
            assert.throws(() => verify(vsix, root), /Missing full-plan performance/);
            fs.writeFileSync(performanceFile, JSON.stringify(performance));
            const data = JSON.parse(fs.readFileSync(last));
            for (const status of [false, 'false', '0', 1, {}, []]) {
                data.cases[0].passed = status; fs.writeFileSync(last, JSON.stringify(data));
                assert.throws(() => verify(vsix, root), /Missing acceptance/);
            }
            data.cases[0].passed = true; fs.writeFileSync(last, JSON.stringify(data));
            fs.writeFileSync(vsix, 'changed after testing');
            assert.throws(() => verify(vsix, root), /Missing/);
        } finally { assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); }
    });
});
