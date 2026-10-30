'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), vm = require('node:vm'), ts = require('typescript');
const { execFileSync } = require('node:child_process');
const { stripVTControlCharacters } = require('node:util');
const { validateRunSource, validateChanges, validateBuild, validateReport } = require('../host/run-installed-acceptance-retry.cjs');
const { verify } = require('./verify-release-acceptance.cjs');
const targets = ['win32-x64', 'linux-x64', 'darwin-arm64'], versions = ['1.100.0', '1.139.1'];
const pair = ['assertAutoSaveFormatIsLocalAndUndoable', 'assertCommittedImeTextIsEditorLocalAndUndoable'];
const editorFile = 'test/host/editor-safety/extension-host/index.js';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function editorNames(source) {
    const start = source.indexOf('        assertPassiveOperationsDoNotWrite,', source.indexOf('    const caseInsensitiveIncludes ='));
    assert.ok(start >= 0);
    const end = source.indexOf('        assertRendererCtrlSlashFiresColumnZeroCommentWhileSuggestVisible,', start);
    assert.ok(end > start);
    const array = source.slice(start, end) + '        assertRendererCtrlSlashFiresColumnZeroCommentWhileSuggestVisible,';
    const context = { caseInsensitiveIncludes: true };
    for (const name of array.match(/assert\w+/g)) context[name] = name;
    return Array.from(vm.runInNewContext('[' + array + ']', context)).filter(name =>
        !['assertInteractiveLatencyBaseline', 'assertRendererContextMenuPasteAndCutAreScopedAndUndoable'].includes(name));
}
function stableEditorSource(source, allowAutosaveFix) {
    const tree = ts.createSourceFile(editorFile, source, ts.ScriptTarget.Latest, true);
    return tree.statements.filter(item => !(ts.isFunctionDeclaration(item) &&
        (item.name.text === 'runScenarios' || (allowAutosaveFix && item.name.text === pair[0]))))
        .map(item => item.getText(tree).replace(/\r\n/g, '\n')).join('\n');
}
function combineEditor({ prefixSource, pairSource, currentSource, log, pairReport, remaining, report }) {
    const required = editorNames(currentSource);
    assert.deepEqual(editorNames(prefixSource), required, 'Editor scenario inventory changed');
    assert.equal(stableEditorSource(prefixSource, true), stableEditorSource(currentSource, true), 'Prior editor assertions/helpers changed');
    assert.equal(stableEditorSource(pairSource, false), stableEditorSource(currentSource, false), 'Verified autosave/IME assertions changed');
    assert.equal(pairReport.complete, false);
    assert.ok(pairReport.cases.some(item => item.name === 'run-editor-safety-extension-host.cjs-autosave-committed-ime' && item.passed === true));
    assert.ok(report.cases.some(item => item.name === 'run-editor-safety-extension-host.cjs-after-ime' && item.passed === true));
    assert.deepEqual(remaining.required, required);
    const prefix = new Set([...stripVTControlCharacters(log).matchAll(/\{"name":"(assert\w+)","status":"passed"\}/g)].map(match => match[1]));
    const split = required.indexOf(pair[0]); assert.ok(split > 0); assert.equal(required[split + 1], pair[1]);
    for (const name of required.slice(0, split)) assert.ok(prefix.has(name), `Missing prior editor scenario: ${name}`);
    const tail = remaining.cases.filter(item => item.required !== false);
    assert.deepEqual(tail.map(item => item.name), required.slice(split + 2), 'Missing or extra remaining editor scenarios');
    assert.ok(tail.every(item => item.status === 'passed'), 'Remaining editor safety failed');
    return required;
}
function validateHostJob(run, target, version, success = true) {
    const os = { 'win32-x64': 'windows-2022', 'linux-x64': 'ubuntu-22.04', 'darwin-arm64': 'macos-14' }[target];
    const job = run.jobs.find(job => [`build / Platform / ${target} / Installed / ${version} / Same VSIX / ${os} / VS Code ${version}`, `Same VSIX / ${os} / VS Code ${version}`,
        `Platform / ${target} / Installed / ${version} / Same VSIX / ${os} / VS Code ${version}`,
        `Retry / ${target} / ${version} / Same VSIX / ${os} / VS Code ${version}`, `Selected node / Node / ${target} / installed / ${version}`].includes(job.name));
    assert.ok(job && job.status === 'completed' && (!success || job.conclusion === 'success'), 'Missing successful host job');
    return job;
}
function main() {
    const plan = JSON.parse(process.env.REUSE_PLAN || 'null');
    assert.ok(plan && (plan.hosts || plan.localAcceptance === true), 'Supply an explicit reuse plan');
    const localAcceptance = plan.localAcceptance === true;
    if (localAcceptance) {
        assert.equal(plan.buildRun, '40160820298');
        assert.equal(JSON.parse(fs.readFileSync('package.json')).version, '3.2.2');
        assert.ok(typeof plan.reason === 'string' && plan.reason.trim(), 'Record the local acceptance authorization');
    }
    const id = value => { assert.match(value, /^\d+$/); return value; };
    id(plan.buildRun);
    if (!localAcceptance) assert.deepEqual(Object.keys(plan.hosts).sort(), targets.flatMap(target => versions.map(version => `${target}/${version}`)).sort());
    const repo = process.env.GITHUB_REPOSITORY; assert.ok(repo);
    const command = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, timeout: 120000 }).trim();
    const cache = new Map(), root = path.resolve('.artifacts/release-reuse'); fs.mkdirSync(root, { recursive: true });
    const readRun = value => {
        const runId = id(value); if (cache.has(runId)) return cache.get(runId);
        const run = JSON.parse(command('gh', ['run', 'view', runId, '--repo', repo, '--json', 'headSha,headBranch,event,jobs,workflowName,status']));
        assert.equal(run.status, 'completed'); validateRunSource(run);
        assert.equal(run.event, 'workflow_dispatch');
        command('git', ['merge-base', '--is-ancestor', run.headSha, 'HEAD']);
        validateChanges(command('git', ['diff', '--name-only', run.headSha, 'HEAD']).split('\n').filter(Boolean));
        cache.set(runId, run); return run;
    };
    const download = (runId, name) => {
        const directory = path.join(root, id(runId), name);
        if (!fs.existsSync(directory)) command('gh', ['run', 'download', runId, '--repo', repo, '--name', name, '--dir', directory]);
        return directory;
    };
    const host = (runId, target, version, success = true) => {
        const run = readRun(runId), job = validateHostJob(run, target, version, success);
        const directory = download(runId, `installed-${target}-${version}`);
        const report = JSON.parse(fs.readFileSync(path.join(directory, 'acceptance.json')));
        validateReport(report, { digest: sha(path.join('packages', `candidate-${target}`, 'candidate.vsix')), target, version });
        assert.equal(report.scope, 'required-functional-acceptance'); assert.deepEqual(report.excludedChecks, ['performance', 'native-system-menu']);
        if (success) assert.equal(report.vscodeVersion, version);
        return { run, job, directory, report };
    };
    const build = readRun(plan.buildRun);
    for (const target of targets) {
        validateBuild(build, target);
        const source = download(plan.buildRun, `candidate-${target}`), destination = path.join('packages', `candidate-${target}`);
        assert.ok(!fs.existsSync(destination), 'Use an empty output directory'); fs.cpSync(source, destination, { recursive: true });
        command(process.execPath, ['scripts/release/verify-release-hash.cjs', path.join(destination, 'candidate.vsix')]);
        if (localAcceptance) {
            fs.mkdirSync('acceptance-evidence', { recursive: true });
            fs.writeFileSync(path.join('acceptance-evidence', `local-${target}.json`), JSON.stringify({
                scope: 'user-confirmed-local-acceptance', version: '3.2.2', target,
                releaseCommit: command('git', ['rev-parse', 'HEAD']), buildRun: plan.buildRun,
                buildCommit: build.headSha, vsixSha256: sha(path.join(destination, 'candidate.vsix')),
                installedCi: 'waived-by-user-not-passed', reason: plan.reason,
            }, null, 2));
            verify(path.join(destination, 'candidate.vsix'), 'acceptance-evidence', target);
            continue;
        }
        for (const version of versions) {
            const runId = id(plan.hosts[`${target}/${version}`]), entry = host(runId, target, version), report = entry.report;
            if (!report.complete) {
                assert.equal(target, 'win32-x64'); assert.equal(version, '1.139.1');
                assert.ok(plan.editorRecovery, 'Incomplete acceptance needs explicit editor recovery evidence');
                const prefix = host(id(plan.editorRecovery.prefixRun), target, version, false);
                const paired = host(id(plan.editorRecovery.pairRun), target, version);
                assert.equal(prefix.job.conclusion, 'failure');
                assert.ok(prefix.report.cases.some(item => item.name === 'run-editor-safety-extension-host.cjs-ci-functional' && item.passed === false));
                const log = command('gh', ['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${prefix.job.databaseId}/logs`]);
                const source = revision => command('git', ['show', `${revision}:${editorFile}`]);
                const currentSource = fs.readFileSync(editorFile, 'utf8');
                assert.equal(stableEditorSource(source(entry.run.headSha), false), stableEditorSource(currentSource, false), 'Remaining editor assertions changed');
                assert.deepEqual(editorNames(source(entry.run.headSha)), editorNames(currentSource), 'Remaining editor inventory changed');
                const coverage = combineEditor({ prefixSource: source(prefix.run.headSha), pairSource: source(paired.run.headSha),
                    currentSource, log, pairReport: paired.report, report,
                    remaining: JSON.parse(fs.readFileSync(path.join(entry.directory, 'editor-remaining.json'))) });
                report.cases = report.cases.filter(item => item.name !== 'run-editor-safety-extension-host.cjs-ci-functional');
                report.cases.push({ name: 'run-editor-safety-extension-host.cjs-ci-functional', passed: true,
                    evidenceRuns: [plan.editorRecovery.prefixRun, plan.editorRecovery.pairRun, runId], scenarios: coverage });
                report.complete = true; // The normal matrix verifier below still requires every host case.
            }
            report.evidenceSource = { run: runId, commit: entry.run.headSha, buildRun: plan.buildRun, buildCommit: build.headSha };
            const output = path.join('acceptance-evidence', `installed-${target}-${version}`); fs.mkdirSync(output, { recursive: true });
            fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2));
        }
        verify(path.join(destination, 'candidate.vsix'), 'acceptance-evidence', target);
    }
    fs.writeFileSync('reuse-verification.json', JSON.stringify({ complete: true, plan, sources: Object.fromEntries(cache) }, null, 2));
}
if (require.main === module) main();
module.exports = { combineEditor, editorNames, stableEditorSource, validateHostJob };
