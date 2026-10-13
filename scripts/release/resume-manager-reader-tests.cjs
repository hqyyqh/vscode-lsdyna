'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { stripVTControlCharacters } = require('node:util');
const ts = require('typescript');
// This recovery is limited to the reviewed reader-assertion correction, not arbitrary test skipping.
const source = '6bb318e5fa5ad2c826d402918cf224169d1b1601';
const cases = [
    ['core/semantics/nativeFormatConsumptionSupplement.test.js', 'Archived supplemental actual native field consumption', 'reads manager source values with native geometry while retaining requested input format and denying edits', 'reads manager source values with native geometry while retaining input format and filesystem read-only protection'],
    ['core/semantics/nativeSuffixReaders.test.js', 'observed suffix display operation boundaries', 'selects the observed file pool across hover and manager without changing GUI aliases', 'selects the observed file pool across hover and manager without changing GUI aliases'],
    ['core/semantics/nativeSuffixReaders.test.js', 'observed suffix display operation boundaries', 'keeps both prefix mechanisms read-only in the manager', 'protects both prefix mechanisms when the filesystem is read-only'],
    ['core/semantics/publicOrdinalSuffixSafety.test.js', 'ordinal suffix manager and invalidation boundaries', 'uses actual source branches in manager and retains operation restrictions for every input format', 'uses actual source branches in manager and retains operation restrictions for every input format'],
    ['core/semantics/staticRemainingBulkDisplaySafety.test.js', 'static remaining bulk display-only operation boundaries', 'checks all proven bindings in four formats against archived records and refuses edit authority', 'checks all proven bindings in four formats against archived records and protects read-only files'],
    ['public-behavior/descriptorHoverReplay.test.js', 'descriptor reader provider replay and editing boundaries', 'keeps displayed conditional branches outside editing and completion authorization', 'protects read-only conditional branches and retains completion restrictions'],
];
function unchangedTests(text) {
    text = text.replace(/\r\n/g, '\n').replace(/^const assertReadonlyReader\s*=\s*require\('[^']*support\/keyword-manager\/readonly-reader\.cjs'\);\n/gm, '');
    const tree = ts.createSourceFile('tests.js', text, ts.ScriptTarget.Latest, true), spans = [];
    const visit = node => {
        if (ts.isCallExpression(node) && node.expression.getText(tree) === 'it' && ts.isStringLiteral(node.arguments[0])) {
            const index = cases.findIndex(c => c.slice(2).includes(node.arguments[0].text));
            if (index >= 0) spans.push([node.getStart(tree), node.end, index]);
        }
        ts.forEachChild(node, visit);
    };
    visit(tree);
    for (const [start, end, index] of spans.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + `REVIEWED_CASE_${index}` + text.slice(end);
    return text;
}
function validate(run, target, log, changes) {
    assert.equal(run.headSha, source); assert.equal(run.headBranch, 'dev');
    assert.equal(run.event, 'workflow_dispatch'); assert.equal(run.status, 'completed');
    assert.equal(run.workflowName, 'Public collaboration / 公开协作');
    const job = run.jobs.find(j => j.name.startsWith('Build, data, tests, audit and actual VSIX') && j.name.endsWith(`${target})`));
    assert.ok(job && job.conclusion === 'failure');
    assert.deepEqual(job.steps.filter(s => s.conclusion === 'failure').map(s => s.name), ['Test the existing build; replay the full corpus once']);
    for (const name of ['Build all product components', 'Verify deterministic public data and source inventory'])
        assert.ok(job.steps.some(s => s.name === name && s.conclusion === 'success'));
    const allowed = new Set([...cases.map(c => 'test/' + c[0]), 'test/support/keyword-manager/readonly-reader.cjs',
        '.github/workflows/public-ci.yml', 'scripts/release/resume-manager-reader-tests.cjs',
        'test/scripts/release/managerReaderRecovery.test.js', 'public-source-manifest.json']);
    for (const file of changes) assert.ok(allowed.has(file), `Recovery inputs changed: ${file}`);
    const clean = stripVTControlCharacters(log).replace(/^\d{4}-\d\d-\d\dT\S+\s?/gm, '').replace(/\r/g, '');
    assert.match(clean, /\b6 failing\b/);
    const failures = [...clean.matchAll(/\n\s+\d+\) ([^\n]+)\n\s+([^\n]+):\s*\n/g)].map(m => `${m[1].trim()} ${m[2].trim()}`);
    assert.deepEqual(failures, cases.map(c => `${c[1]} ${c[2]}`), 'Unexpected failed cases; do not reuse unit results');
    const passing = Number(clean.match(/\b(\d+) passing\b/)?.[1]);
    assert.equal(passing, { 'linux-x64': 4322, 'win32-x64': 4051, 'darwin-arm64': 4050 }[target], 'Missing completed unit-suite evidence');
    return { source, target, passing, failed: failures, job: job.databaseId };
}
function main() {
    const runId = process.env.UNIT_RESUME_RUN, repo = process.env.GITHUB_REPOSITORY, target = process.env.EXPECTED_TARGET;
    assert.match(runId || '', /^\d+$/); assert.ok(repo); assert.equal(process.env.GITHUB_REF, 'refs/heads/dev');
    assert.equal(target, process.platform + '-' + process.arch);
    const command = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, timeout: 180000 });
    const run = JSON.parse(command('gh', ['run', 'view', runId, '--repo', repo, '--json', 'headSha,headBranch,event,status,workflowName,jobs']));
    command('git', ['merge-base', '--is-ancestor', source, 'HEAD']);
    const job = run.jobs.find(j => j.name.startsWith('Build, data, tests, audit and actual VSIX') && j.name.endsWith(`${target})`));
    assert.ok(job);
    const log = command('gh', ['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${job.databaseId}/logs`]);
    const proof = validate(run, target, log, command('git', ['diff', '--name-only', source, 'HEAD']).trim().split('\n'));
    for (const file of new Set(cases.map(c => 'test/' + c[0])))
        assert.equal(unchangedTests(fs.readFileSync(file, 'utf8')), unchangedTests(command('git', ['show', `${source}:${file}`])), `Unselected test or setup changed: ${file}`);
    fs.mkdirSync('.artifacts/unit-recovery', { recursive: true });
    fs.writeFileSync('.artifacts/unit-recovery/source.log', log);
    fs.writeFileSync('.artifacts/unit-recovery/reused.json', JSON.stringify({ ...proof, run: runId, current: process.env.GITHUB_SHA }, null, 2));
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const output = command(process.execPath, ['node_modules/mocha/bin/mocha.js', '--require', 'test/support/register-out.js',
        ...new Set(cases.map(c => 'test/' + c[0])), '--grep', cases.map(c => escape(`${c[1]} ${c[3]}`) + '$').join('|'), '--fail-zero', '--reporter', 'json']);
    fs.writeFileSync('.artifacts/unit-recovery/current.log', output);
    // Fixture diagnostics precede Mocha's JSON report.
    const result = JSON.parse(output.slice(output.indexOf('{\n  "stats"')));
    assert.equal(result.stats.failures, 0); assert.equal(result.stats.passes, cases.length);
    assert.deepEqual(result.passes.map(t => t.fullTitle).sort(), cases.map(c => `${c[1]} ${c[3]}`).sort());
    console.log(`Reused ${proof.passing} unchanged unit passes from ${runId}; corrected six cases passed. Downstream checks still required.`);
}
if (require.main === module) main();
module.exports = { validate, cases, source, unchangedTests };
