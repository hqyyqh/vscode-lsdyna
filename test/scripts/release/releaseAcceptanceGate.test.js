'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { verify } = require("../../../scripts/release/verify-release-acceptance.cjs");
describe('immutable release acceptance gate', () => {
    it('binds explicit 3.2.2 local acceptance to the authorized build, source and package', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-release-acceptance-'));
        const vsix = path.join(root, 'candidate.vsix'); fs.writeFileSync(vsix, 'package bytes');
        const savedPlan = process.env.REUSE_PLAN, savedSha = process.env.GITHUB_SHA;
        const plan = { localAcceptance: true, buildRun: '40160820298', reason: 'User confirmed local testing' };
        process.env.REUSE_PLAN = JSON.stringify(plan); process.env.GITHUB_SHA = 'a'.repeat(40);
        const record = { scope: 'user-confirmed-local-acceptance', version: '3.2.2', target: 'win32-x64',
            installedCi: 'waived-by-user-not-passed', buildRun: plan.buildRun, reason: plan.reason,
            buildCommit: '4cb6b5207bc70c3421b30eff2b46d5af329d66d7', releaseCommit: process.env.GITHUB_SHA,
            vsixSha256: crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex') };
        const report = path.join(root, 'local-win32-x64.json');
        const previousDirectory = process.cwd();
        const packageFile = path.join(root, 'package.json');
        try {
            fs.writeFileSync(packageFile, JSON.stringify({ version: '3.2.2' }));
            process.chdir(root);
            fs.writeFileSync(report, JSON.stringify(record));
            assert.equal(verify(vsix, root, 'win32-x64').installedCi, 'waived-by-user-not-passed');
            for (const field of ['vsixSha256', 'releaseCommit', 'buildCommit', 'buildRun', 'target', 'reason', 'installedCi']) {
                fs.writeFileSync(report, JSON.stringify({ ...record, [field]: 'wrong' }));
                assert.throws(() => verify(vsix, root, 'win32-x64'), field);
            }
            fs.writeFileSync(report, JSON.stringify(record));
            process.env.REUSE_PLAN = JSON.stringify({ ...plan, buildRun: '1' });
            assert.throws(() => verify(vsix, root, 'win32-x64'));
            process.env.REUSE_PLAN = JSON.stringify(plan);
            fs.writeFileSync(packageFile, JSON.stringify({ version: '3.2.3' }));
            assert.throws(() => verify(vsix, root, 'win32-x64'), /3\.2\.3.*3\.2\.2/s);
        } finally {
            process.chdir(previousDirectory);
            if (savedPlan === undefined) delete process.env.REUSE_PLAN; else process.env.REUSE_PLAN = savedPlan;
            if (savedSha === undefined) delete process.env.GITHUB_SHA; else process.env.GITHUB_SHA = savedSha;
            fs.unlinkSync(packageFile); fs.unlinkSync(report); fs.unlinkSync(vsix); fs.rmdirSync(root);
        }
    });
    it('accepts only matching completed host jobs across original, platform and retry routes', () => {
        const { validateHostJob } = require('../../../scripts/release/reuse-release-evidence.cjs');
        const suffix = 'Same VSIX / windows-2022 / VS Code 1.100.0';
        for (const name of [suffix, `Platform / win32-x64 / Installed / 1.100.0 / ${suffix}`, `Retry / win32-x64 / 1.100.0 / ${suffix}`]) {
            const run = { jobs: [{ name, status: 'completed', conclusion: 'success' }] };
            assert.equal(validateHostJob(run, 'win32-x64', '1.100.0'), run.jobs[0]);
            assert.throws(() => validateHostJob(run, 'linux-x64', '1.100.0'));
            assert.throws(() => validateHostJob(run, 'win32-x64', '1.139.1'));
            run.jobs[0].conclusion = 'failure';
            assert.throws(() => validateHostJob(run, 'win32-x64', '1.100.0'));
            run.jobs[0].status = 'in_progress';
            assert.throws(() => validateHostJob(run, 'win32-x64', '1.100.0', false));
        }
    });
    it('composes editor coverage only from unchanged assertions and all remaining passes', () => {
        const { combineEditor, editorNames } = require('../../../scripts/release/reuse-release-evidence.cjs');
        const currentSource = fs.readFileSync(path.resolve(__dirname, '../../host/editor-safety/extension-host/index.js'), 'utf8');
        const required = editorNames(currentSource), split = required.indexOf('assertAutoSaveFormatIsLocalAndUndoable');
        const input = { currentSource, prefixSource: currentSource, pairSource: currentSource,
            log: required.slice(0, split).map(name => JSON.stringify({ name, status: 'passed' })).join('\n'),
            pairReport: { complete: false, cases: [{ name: 'run-editor-safety-extension-host.cjs-autosave-committed-ime', passed: true }] },
            report: { cases: [{ name: 'run-editor-safety-extension-host.cjs-after-ime', passed: true }] },
            remaining: { required, cases: required.slice(split + 2).map(name => ({ name, status: 'passed' })) } };
        assert.deepEqual(combineEditor(input), required);
        assert.deepEqual(combineEditor({ ...input, log: input.log.replaceAll('"status"', '\u001b[32m"status"\u001b[0m') }), required);
        assert.throws(() => combineEditor({ ...input, log: '' }), /Missing prior/);
        assert.throws(() => combineEditor({ ...input, pairSource: currentSource + '\nconst changedHelper = true;' }), /assertions changed/);
        assert.throws(() => combineEditor({ ...input, prefixSource: currentSource + '\nconst changedHelper = true;' }), /helpers changed/);
        assert.throws(() => combineEditor({ ...input, remaining: { required, cases: input.remaining.cases.slice(1) } }), /remaining editor/);
        const failed = structuredClone(input.remaining); failed.cases[0].status = 'failed';
        assert.throws(() => combineEditor({ ...input, remaining: failed }), /safety failed/);
    });
    it('requires all six platform/version reports for exactly the candidate hash', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-test-')), vsix = path.join(root, 'candidate.vsix');
        try {
            fs.writeFileSync(vsix, 'candidate');
            const sha = crypto.createHash('sha256').update('candidate').digest('hex');
            assert.throws(() => verify(vsix, root), /Missing/);
            const names = ['run-release-host.cjs-catalog', 'run-release-host.cjs-smoke', 'test-release-manual-renderer.cjs',
                'run-keyword-manager-gui.cjs', 'run-keyword-manager-gui.cjs-incomplete',
                'run-editor-safety-extension-host.cjs-ci-functional', 'run-large-file-viewer-host.cjs',
                'upgrade', 'reload', 'offline', 'missing-external-manual', 'ordinary-project-f5'];
            let last;
            for (const platform of ['win32', 'linux', 'darwin']) for (const version of ['1.100.0', '1.139.1']) {
                const directory = path.join(root, platform + version); fs.mkdirSync(directory);
                last = path.join(directory, 'acceptance.json');
                fs.writeFileSync(last, JSON.stringify({ complete: true, scope: 'required-functional-acceptance', excludedChecks: ['performance', 'native-system-menu'], platform, arch: platform === 'darwin' ? 'arm64' : 'x64', vscodeVersion: version, vsixSha256: sha,
                    cases: names.map(name => ({ name, passed: true })) }));

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
            const data = JSON.parse(fs.readFileSync(last));
            fs.writeFileSync(last, JSON.stringify({ ...data, scope: 'legacy' }));
            assert.throws(() => verify(vsix, root));
            fs.writeFileSync(last, JSON.stringify({ ...data, cases: data.cases.filter(item => item.name !== 'run-editor-safety-extension-host.cjs-ci-functional') }));
            assert.throws(() => verify(vsix, root), /Missing acceptance case/);
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
