'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript');
const { execFileSync } = require('node:child_process');
const source = 'c6c781150022cfde25f55fe89bb97705a8fbad88';
function outsidePreparation(text) {
    const tree = ts.createSourceFile('extension.ts', text, ts.ScriptTarget.Latest, true);
    const member = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'planPreparedOfficialFieldChoices');
    assert.ok(member, 'Missing reviewed field preparation function');
    return (text.slice(0, member.getStart(tree)) + 'REVIEWED_PREPARATION' + text.slice(member.end)).replace(/\r\n/g, '\n');
}
function validate(run, target, changes, before, after) {
    assert.equal(run.headSha, source); assert.equal(run.headBranch, 'dev');
    assert.equal(run.event, 'workflow_dispatch'); assert.equal(run.status, 'completed');
    assert.equal(run.workflowName, 'Public collaboration / 公开协作');
    assert.ok(run.jobs.some(job => job.name.startsWith('Build, data, tests, audit and actual VSIX') && job.name.endsWith(`${target})`) && job.conclusion === 'success'));
    const allowed = new Set(['src/extension.ts', 'test/client/services/liveEditBlockIndex.test.js',
        'test/host/editor-safety/extension-host/index.js', 'scripts/host/run-installed-acceptance-retry.cjs',
        'scripts/host/run-large-file-viewer-host.cjs', 'scripts/release/public-release-reports.cjs',
        'test/scripts/host/installedAcceptance.test.js', 'test/scripts/host/viewerReload.test.js',
        'test/scripts/release/publicReleaseReports.test.js', '.github/workflows/public-ci.yml',
        'scripts/release/resume-field-choice-tests.cjs', 'test/scripts/release/fieldChoiceRecovery.test.js', 'public-source-manifest.json']);
    for (const file of changes) assert.ok(allowed.has(file), `Unreviewed recovery change: ${file}`);
    assert.equal(outsidePreparation(before), outsidePreparation(after), 'Unrelated product logic changed');
}
function main() {
    const runId = process.env.UNIT_RESUME_RUN, repo = process.env.GITHUB_REPOSITORY, target = process.env.EXPECTED_TARGET;
    assert.equal(runId, '38381427448'); assert.ok(repo);
    assert.equal(process.env.GITHUB_REF, 'refs/heads/dev'); assert.equal(target, process.platform + '-' + process.arch);
    const command = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, timeout: 180000 });
    const run = JSON.parse(command('gh', ['run', 'view', runId, '--repo', repo, '--json', 'headSha,headBranch,event,status,workflowName,jobs']));
    command('git', ['merge-base', '--is-ancestor', source, 'HEAD']);
    const file = 'src/extension.ts';
    validate(run, target, command('git', ['diff', '--name-only', source, 'HEAD']).trim().split('\n'),
        command('git', ['show', `${source}:${file}`]), fs.readFileSync(file, 'utf8'));
    const directory = '.artifacts/unit-recovery'; fs.mkdirSync(directory, { recursive: true });
    command('gh', ['run', 'download', runId, '--repo', repo, '--name', `unit-recovery-${target}`, '--dir', directory + '/prior']);
    const proof = JSON.parse(fs.readFileSync(directory + '/prior/reused.json'));
    assert.equal(proof.current, source); assert.equal(proof.target, target); assert.equal(proof.run, '38373457591');
    assert.equal(proof.currentPasses, 15); assert.equal(proof.correctedPriorPasses, 6);
    assert.equal(proof.prior.run, '38366233304');
    assert.equal(proof.prior.passing, { 'win32-x64': 4051, 'linux-x64': 4322, 'darwin-arm64': 4050 }[target]);
    const parse = raw => JSON.parse(raw.slice(raw.indexOf('{\n  "stats"')));
    const prior = parse(fs.readFileSync(directory + '/prior/current.log', 'utf8'));
    assert.equal(prior.stats.passes, 15); assert.equal(prior.stats.failures, 0);
    const output = command(process.execPath, ['node_modules/mocha/bin/mocha.js', '--require', 'test/support/register-out.js',
        'test/client/services/liveEditBlockIndex.test.js', 'test/client/services/activeFieldChoiceController.test.js',
        'test/client/services/officialFieldChoicePicker.test.js', 'test/core/semantics/officialFieldChoicePlanner.test.js',
        'test/scripts/release/fieldChoiceRecovery.test.js', 'test/scripts/host/viewerReload.test.js',
        'test/scripts/host/installedAcceptance.test.js', 'test/scripts/release/publicReleaseReports.test.js',
        'test/scripts/release/releaseAcceptanceGate.test.js', '--fail-zero', '--reporter', 'json']);
    fs.writeFileSync(directory + '/current.log', output);
    const current = parse(output); assert.equal(current.stats.failures, 0);
    assert.ok(current.passes.some(test => test.title === 'prepares field choices with the keyword tree closed and no tree index'));
    fs.writeFileSync(directory + '/reused.json', JSON.stringify({ source, run: runId, target, current: process.env.GITHUB_SHA,
        prior: proof, currentPasses: current.stats.passes,
        scope: 'Only prepared field-choice function changed; its planner/controller/picker and shared presentation tests rerun; all other unit inputs retained' }, null, 2));
}
module.exports = { source, outsidePreparation, validate };
if (require.main === module) main();
