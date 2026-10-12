'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), { execFileSync } = require('node:child_process');

// Reuse product builds only for these host-side changes; invalidate every affected host case.
const retryFiles = new Set(['.github/workflows/public-ci.yml', '.github/workflows/ci.yml', '.github/workflows/release.yml', 'public-source-manifest.json',
    'scripts/host/run-installed-acceptance.cjs', 'scripts/host/run-installed-acceptance-retry.cjs',
    'scripts/release/public-release-reports.cjs', 'test/scripts/host/installedAcceptance.test.js',
    'test/scripts/host/nativeMenu.test.js', 'test/scripts/host/managerGuiCompletion.test.js',
    'test/scripts/release/publicWorkflow.test.js', 'test/scripts/release/publicReleaseReports.test.js',
    'test/scripts/host/vsixHost.test.js']);
const affectedCases = {
    'scripts/host/vsix-host.cjs': ['*'],
    'test/host/editor-safety/extension-host/index.js': ['run-editor-safety-extension-host.cjs'],
    'test/support/editor-safety/native-menu.cjs': ['run-editor-safety-extension-host.cjs'],
    'scripts/host/run-keyword-manager-gui.cjs': ['run-keyword-manager-gui.cjs', 'run-keyword-manager-gui.cjs-incomplete'],
    'test/host/keyword-manager/extension-host.cjs': ['run-keyword-manager-gui.cjs', 'run-keyword-manager-gui.cjs-incomplete'],
};
function validateChanges(files) {
    const invalidated = new Set();
    for (const file of files) {
        assert.ok(retryFiles.has(file) || Object.hasOwn(affectedCases, file), `Cannot reuse installed evidence after changing ${file}`);
        for (const name of affectedCases[file] || []) invalidated.add(name);
    }
    return invalidated;
}
function validateReport(report, { digest, target, version }) {
    assert.equal(report.vsixSha256, digest, 'Previous report belongs to another VSIX');
    assert.equal(`${report.platform}-${report.arch}`, target, 'Previous report target mismatch');
    assert.ok(!report.requestedVscodeVersion || report.requestedVscodeVersion === version, 'Previous requested version mismatch');
    assert.ok(!report.vscodeVersion || report.vscodeVersion === version, 'Previous actual version mismatch');
    assert.ok(Array.isArray(report.cases), 'Previous report has no case results');
}
function main() {
    const { BUILD_RUN: buildRun, RESUME_RUN: resumeRun, GITHUB_REPOSITORY: repo,
        EXPECTED_TARGET: target, VSCODE_TEST_VERSION: version, GITHUB_ENV: githubEnv } = process.env;
    for (const run of [buildRun, resumeRun]) assert.match(run || '', /^\d+$/);
    assert.ok(['win32-x64', 'linux-x64', 'darwin-arm64'].includes(target));
    assert.ok(['1.100.0', '1.139.1'].includes(version));
    assert.equal(process.platform + '-' + process.arch, target);
    const command = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 }).trim();
    const readRun = id => JSON.parse(command('gh', ['run', 'view', id, '--repo', repo, '--json', 'headSha,headBranch,event,jobs,workflowName']));
    const build = readRun(buildRun), previousRun = buildRun === resumeRun ? build : readRun(resumeRun);
    let invalidated;
    for (const run of [build, previousRun]) {
        assert.equal(run.headBranch, 'dev');
        assert.equal(run.workflowName, 'Public collaboration / 公开协作');
        assert.ok(['push', 'workflow_dispatch'].includes(run.event));
        command('git', ['merge-base', '--is-ancestor', run.headSha, 'HEAD']);
        invalidated = validateChanges(command('git', ['diff', '--name-only', run.headSha, 'HEAD']).split('\n').filter(Boolean));
    }
    for (const platform of ['win32-x64', 'linux-x64', 'darwin-arm64'])
        assert.ok(build.jobs.some(job => job.name.startsWith('Build, data, tests, audit and actual VSIX')
            && job.name.endsWith(`${platform})`) && job.conclusion === 'success'), `Missing passed build for ${platform}`);
    const os = { 'win32-x64': 'windows-2022', 'linux-x64': 'ubuntu-22.04', 'darwin-arm64': 'macos-14' }[target];
    assert.ok(previousRun.jobs.some(job => job.name === `Same VSIX / ${os} / VS Code ${version}` && job.status === 'completed'),
        'Previous host is not finished');
    const directory = path.resolve('.artifacts/previous-host');
    command('gh', ['run', 'download', resumeRun, '--repo', repo, '--name', `installed-${target}-${version}`, '--dir', directory]);
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const digest = hash('dist/candidate.vsix');
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'acceptance.json'), 'utf8'));
    validateReport(report, { digest, target, version });
    report.cases = report.cases.filter(item => !invalidated.has('*') && !invalidated.has(item.name));
    console.log(`Invalidated host evidence: ${[...invalidated].join(', ') || 'none'}`);
    // Older partial reports omitted the requested version; the verified run's matrix supplies it.
    report.requestedVscodeVersion = version; report.sourceRun = resumeRun;
    const resume = path.join(directory, 'resume.json');
    fs.writeFileSync(resume, JSON.stringify(report));
    fs.appendFileSync(githubEnv, `LSDYNA_ACCEPTANCE_RESUME=${resume}\n`);
    const performanceFile = path.join(directory, 'performance.json');
    if (!invalidated.has('*') && fs.existsSync(performanceFile)) {
        const performance = JSON.parse(fs.readFileSync(performanceFile));
        if (performance.complete === true && performance.candidateSha256 === digest
            && performance.baselineSha256 === hash('dist/candidate.vsix.baseline.vsix')
            && performance.metrics?.length && performance.metrics.every(item => item.passed === true)) {
            fs.mkdirSync('.artifacts/public-host', { recursive: true });
            fs.copyFileSync(performanceFile, '.artifacts/public-host/performance.json');
            fs.appendFileSync(githubEnv, 'LSDYNA_REUSE_PERFORMANCE=1\n');
        }
    }
    console.log(`Reuse build ${buildRun}, completed host cases from ${resumeRun}, exact package ${digest}`);
}
if (require.main === module) main();
module.exports = { validateChanges, validateReport };
