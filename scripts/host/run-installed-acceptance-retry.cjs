'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), { execFileSync } = require('node:child_process');

// Reuse product builds only for these host-side changes; invalidate every affected host case.
const retryFiles = new Set(['scripts/release/reuse-release-evidence.cjs','scripts/maintenance/validate-project-contracts.cjs', 'scripts/release/verify-release-acceptance.cjs', 'test/scripts/release/releaseAcceptanceGate.test.js', 'test/integration/extension.test.js', 'test/core/keywordIndexPerformance.test.js', 'test/core/scanner/scannerBenchmark.test.js', '.github/workflows/public-ci.yml', '.github/workflows/ci-platform.yml', '.github/workflows/ci-installed.yml', '.github/workflows/fast-ci.yml', '.github/workflows/ci-node.yml', '.github/workflows/ci.yml', '.github/workflows/release.yml', 'public-source-manifest.json',
    'scripts/host/run-installed-acceptance.cjs', 'scripts/host/run-installed-acceptance-retry.cjs',
    'scripts/release/public-release-reports.cjs', 'test/scripts/host/installedAcceptance.test.js',
    'test/scripts/host/nativeMenu.test.js', 'test/scripts/host/managerGuiCompletion.test.js', 'test/scripts/host/viewerReload.test.js',
    'test/scripts/release/publicWorkflow.test.js', 'test/scripts/release/publicReleaseReports.test.js',
    'test/scripts/host/vsixHost.test.js', 'test/scripts/host/hostBenchmark.test.js', 'test/scripts/host/hostInstrumentation.test.js']);
const affectedCases = {
    'scripts/host/run-large-file-viewer-host.cjs': ['run-large-file-viewer-host.cjs'],
    // This external test driver is excluded from VSIX; its changes invalidate host evidence, not the package.
    'test/host/release/host.cjs': ['*'],
    'scripts/benchmark/benchmark-release-hosts.cjs': ['performance'],
    'test/support/release/rendered.cjs': ['performance', 'offline', 'missing-external-manual'],
    'scripts/host/vsix-host.cjs': ['*'],
    'scripts/host/run-editor-safety-extension-host.cjs': ['run-editor-safety-extension-host.cjs', 'run-editor-safety-extension-host.cjs-functional', 'run-editor-safety-extension-host.cjs-ci-functional', 'run-editor-safety-extension-host.cjs-autosave-committed-ime', 'run-editor-safety-extension-host.cjs-after-ime'],
    'test/host/editor-safety/extension-host/index.js': ['run-editor-safety-extension-host.cjs', 'run-editor-safety-extension-host.cjs-functional', 'run-editor-safety-extension-host.cjs-ci-functional', 'run-editor-safety-extension-host.cjs-autosave-committed-ime', 'run-editor-safety-extension-host.cjs-after-ime'],
    'test/support/editor-safety/native-menu.cjs': ['run-editor-safety-extension-host.cjs', 'run-editor-safety-extension-host.cjs-functional', 'run-editor-safety-extension-host.cjs-ci-functional', 'run-editor-safety-extension-host.cjs-autosave-committed-ime', 'run-editor-safety-extension-host.cjs-after-ime'],
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
function validateBuild(run, target) {
    assert.equal(run.workflowName, 'Public collaboration / 公开协作');
    assert.ok(run.jobs.some(job => job.conclusion === 'success' && (
        (job.name.startsWith('Build, data, tests, audit and actual VSIX') && job.name.endsWith(`${target})`)) ||
        job.name === `Platform / ${target} / Build, data, tests, audit and actual VSIX (${target})` ||
        job.name === `Selected node / Node / ${target} / package`
    )), `Missing passed build for ${target}`);
}
function reusableEditorScenarios(previous, current, required, log) {
    const ts = require('typescript');
    const parse = source => {
        const tree = ts.createSourceFile('host.js', source, ts.ScriptTarget.Latest, true);
        const functions = new Map(), globals = [];
        for (const statement of tree.statements) {
            if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement);
            else globals.push(statement.getText(tree).replace(/\r\n/g, '\n'));
        }
        return { tree, functions, globals };
    };
    const before = parse(previous), after = parse(current);
    assert.deepEqual(after.globals, before.globals, 'Editor initialization changed');
    const changed = new Set();
    for (const [name, node] of after.functions) {
        if (node.getText(after.tree).replace(/\r\n/g, '\n') !== before.functions.get(name)?.getText(before.tree).replace(/\r\n/g, '\n')) changed.add(name);
    }
    for (const name of before.functions.keys()) if (!after.functions.has(name)) changed.add(name);
    const affected = (name, seen = new Set()) => {
        if (changed.has(name)) return true;
        if (seen.has(name)) return false;
        seen.add(name);
        let result = false;
        const visit = node => {
            if (ts.isIdentifier(node) && after.functions.has(node.text) && affected(node.text, seen)) result = true;
            ts.forEachChild(node, visit);
        };
        const node = after.functions.get(name); assert.ok(node, `Missing editor scenario ${name}`);
        ts.forEachChild(node, visit);
        return result;
    };
    const passed = new Set([...require('node:util').stripVTControlCharacters(log).matchAll(/\{"name":"(assert\w+)","status":"passed"\}/g)].map(match => match[1]));
    return required.filter(name => passed.has(name) && !affected(name));
}
function main() {
    const { BUILD_RUN: buildRun, RESUME_RUN: resumeRun, GITHUB_REPOSITORY: repo,
        EXPECTED_TARGET: target, VSCODE_TEST_VERSION: version, GITHUB_ENV: githubEnv } = process.env;
    assert.match(buildRun || '', /^\d+$/);
    if (resumeRun) assert.match(resumeRun, /^\d+$/);
    assert.ok(['win32-x64', 'linux-x64', 'darwin-arm64'].includes(target));
    assert.ok(['1.100.0', '1.139.1'].includes(version));
    assert.equal(process.platform + '-' + process.arch, target);
    const command = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 }).trim();
    const readRun = id => JSON.parse(command('gh', ['run', 'view', id, '--repo', repo, '--json', 'headSha,headBranch,event,jobs,workflowName']));
    const build = readRun(buildRun), previousRun = !resumeRun ? null : buildRun === resumeRun ? build : readRun(resumeRun);
    let invalidated;
    for (const run of [build, previousRun].filter(Boolean)) {
        assert.equal(run.headBranch, 'dev');
        assert.equal(run.workflowName, 'Public collaboration / 公开协作');
        assert.ok(['push', 'workflow_dispatch'].includes(run.event));
        command('git', ['merge-base', '--is-ancestor', run.headSha, 'HEAD']);
        invalidated = validateChanges(command('git', ['diff', '--name-only', run.headSha, 'HEAD']).split('\n').filter(Boolean));
    }
    validateBuild(build, target);
    command(process.execPath, ['scripts/release/verify-release-hash.cjs', 'dist/candidate.vsix']);
    if (!previousRun) return;
    const os = { 'win32-x64': 'windows-2022', 'linux-x64': 'ubuntu-22.04', 'darwin-arm64': 'macos-14' }[target];
    assert.ok(previousRun.jobs.some(job => [
        `Same VSIX / ${os} / VS Code ${version}`, `Selected node / Node / ${target} / installed / ${version}`,
    ].includes(job.name) && job.status === 'completed'),
        'Previous host is not finished');
    const directory = path.resolve('.artifacts/previous-host');
    command('gh', ['run', 'download', resumeRun, '--repo', repo, '--name', `installed-${target}-${version}`, '--dir', directory]);
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const digest = hash('dist/candidate.vsix');
    const report = JSON.parse(fs.readFileSync(path.join(directory, 'acceptance.json'), 'utf8'));
    validateReport(report, { digest, target, version });
    const editorCase = 'run-editor-safety-extension-host.cjs-ci-functional';
    if (invalidated.has(editorCase) && report.cases.some(item => item.name === editorCase)) {
        const editorFile = 'test/host/editor-safety/extension-host/index.js';
        const previous = command('git', ['show', `${previousRun.headSha}:${editorFile}`]);
        const current = fs.readFileSync(editorFile, 'utf8');
        const { editorNames } = require('../release/reuse-release-evidence.cjs');
        const required = editorNames(current);
        assert.deepEqual(editorNames(previous), required, 'Editor scenario inventory changed');
        const job = previousRun.jobs.find(item => [`Same VSIX / ${os} / VS Code ${version}`, `Selected node / Node / ${target} / installed / ${version}`].includes(item.name));
        const log = command('gh', ['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${job.databaseId}/logs`]);
        const reused = reusableEditorScenarios(previous, current, required, log);
        const editorResume = path.join(directory, 'editor-resume.json');
        fs.writeFileSync(editorResume, JSON.stringify({ sourceRun: resumeRun, sourceCommit: previousRun.headSha,
            vsixSha256: digest, target, version, required, reused }));
        fs.appendFileSync(githubEnv, `LSDYNA_EDITOR_SAFETY_RESUME=${editorResume}\n`);
    }
    report.cases = report.cases.filter(item => !invalidated.has('*') && !invalidated.has(item.name));
    console.log(`Invalidated host evidence: ${[...invalidated].join(', ') || 'none'}`);
    // Older partial reports omitted the requested version; the verified run's matrix supplies it.
    report.requestedVscodeVersion = version; report.sourceRun = resumeRun;
    const resume = path.join(directory, 'resume.json');
    fs.writeFileSync(resume, JSON.stringify(report));
    fs.appendFileSync(githubEnv, `LSDYNA_ACCEPTANCE_RESUME=${resume}\n`);
    console.log(`Reuse build ${buildRun}, completed host cases from ${resumeRun}, exact package ${digest}`);
}
module.exports = { validateChanges, validateReport, validateBuild, reusableEditorScenarios };
if (require.main === module) main();
