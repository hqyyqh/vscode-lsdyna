'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '../../..');
const read = file => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8'));
describe('platform release workflow dependency closure', () => {
    it('builds once for standalone tests and keeps compiled test commands free of build steps', () => {
        const scripts = require('../../../package.json').scripts;
        const expand = name => scripts[name].split(' && ').flatMap(command => {
            const match = /^npm run ([\w:-]+)$/.exec(command);
            return match ? expand(match[1]) : [command];
        });
        const build = expand('build');
        assert.deepEqual(expand('pretest'), build);
        assert.deepEqual(expand('test'), expand('test:compiled'));
        const compiled = [...expand('test:compiled'), ...expand('test:webview:compiled')];
        assert.ok(compiled.every(command => !build.includes(command)));
        assert.deepEqual(expand('test:webview'), [...expand('typecheck:webview'), ...expand('test:webview:compiled')]);
    });
    it('isolates manual requests and platform failures while retaining the complete release gate', () => {
        const full = read('public-ci.yml'), platform = read('ci-platform.yml');
        assert.equal(full.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
        assert.ok(full.concurrency.group.includes("github.event_name == 'pull_request' && 'latest' || github.run_id"));
        assert.equal(read('fast-ci.yml').concurrency['cancel-in-progress'], true);
        assert.equal(full.jobs.platforms.uses, './.github/workflows/ci-platform.yml');
        assert.equal(full.jobs.platforms.strategy['fail-fast'], false);
        assert.equal(platform.jobs['public-checks'].needs, undefined);
        assert.equal(platform.jobs['installed-host'].needs, 'public-checks');
        assert.equal(platform.jobs['installed-host'].if, undefined, 'Failed builds must not start installation');
        assert.equal(platform.jobs['installed-host'].strategy['fail-fast'], false);
        assert.equal(platform.jobs['installed-host'].uses, './.github/workflows/ci-installed.yml');
        for (const workflow of [full, platform, read('ci-installed.yml')]) {
            for (const job of Object.values(workflow.jobs)) {
                assert.ok(!job['continue-on-error']);
                assert.ok((job.steps || []).every(step => !step['continue-on-error']));
            }
        }
        assert.match(read('release.yml').jobs.publish.if, /needs.build.result == 'success'/);
        const node = read('ci-node.yml').jobs.node.steps;
        for (const step of node.filter(step => step.uses?.startsWith('actions/setup-python@') || step.run?.startsWith('python -m pip')))
            assert.equal(step.if, "${{ inputs.node != 'audit' }}");
        for (const workflow of [full, platform, read('ci-node.yml'), read('fast-ci.yml')]) {
            const commands = Object.values(workflow.jobs).flatMap(job => (job.steps || []).map(step => step.run || '')).join('\n');
            assert.ok(!commands.includes('npm audit --omit=dev'));
            assert.ok(!commands.includes('validate-package-contents.cjs --vsix'));
        }
        const pack = fs.readFileSync(path.join(root, 'scripts/release/package-hover-release.cjs'), 'utf8');
        assert.ok(pack.includes('const files = validateVsix(output)'));
    });
    it('records failed and skipped build stages without leaking step outputs', () => {
        const steps = read('ci-platform.yml').jobs['public-checks'].steps;
        const save = steps.find(step => step.name === 'Save build step outcomes');
        assert.equal(save.if, 'always()');
        assert.equal(steps.find(step => step.name === 'Upload build outcomes, including failed runs').if, 'always()');
        const source = save.run.split("node <<'NODE'\n")[1].split('\nNODE')[0];
        let report;
        require('node:vm').runInNewContext(source, {
            process: { env: { STEP_RESULTS: JSON.stringify({ unit: { outcome: 'failure', conclusion: 'failure', outputs: { secret: 'private' } }, package: { outcome: 'skipped', conclusion: 'skipped' } }), TARGET: 'linux-x64', GITHUB_SHA: 'a'.repeat(40) } },
            require: name => { assert.equal(name, 'node:fs'); return { mkdirSync() {}, writeFileSync(file, bytes) { report = JSON.parse(bytes); } }; },
        });
        assert.deepEqual(report.steps, [{ name: 'unit', outcome: 'failure', conclusion: 'failure' }, { name: 'package', outcome: 'skipped', conclusion: 'skipped' }]);
        assert.ok(!JSON.stringify(report).includes('private'));
    });
    it('uses Node 24 throughout CI and pins approved dependency install scripts', () => {
        for (const file of fs.readdirSync(path.join(root, '.github/workflows'))) {
            for (const job of Object.values(read(file).jobs || {})) {
                for (const step of job.steps || []) if (step.uses?.startsWith('actions/setup-node@'))
                    assert.equal(step.with['node-version'], 24, `${file}: Node 24 required`);
            }
        }
        const pkg = require('../../../package.json');
        const lock = require('../../../package-lock.json');
        const names = ['esbuild', '@tybys/wasm-util', '@vscode/sqlite3', '@vscode/vsce-sign'];
        assert.deepEqual(Object.keys(pkg.allowScripts).sort(), names.map(name => `${name}@${lock.packages[`node_modules/${name}`].version}`).sort());
        assert.ok(Object.values(pkg.allowScripts).every(value => value === true));
    });
    it('bounds dev feedback without replacing complete release acceptance', () => {
        const quick = read('fast-ci.yml'), full = read('public-ci.yml');
        assert.deepEqual(quick.on.push.branches, ['dev']);
        assert.deepEqual(quick.on.pull_request.branches, ['dev']);
        assert.equal(full.on.push, undefined, 'master push must build only once through release');
        assert.deepEqual(read('release.yml').on.push.branches, ['master']);
        assert.deepEqual(full.on.pull_request.branches, ['master']);
        assert.ok('workflow_dispatch' in full.on && 'workflow_call' in full.on);
        assert.equal(quick.jobs.build.needs, undefined);
        assert.equal(quick.jobs.contracts.needs, undefined);
        for (const job of Object.values(quick.jobs)) assert.equal(job['timeout-minutes'], 10);
        assert.deepEqual(quick.jobs.build.strategy.matrix.os, ['windows-2022', 'ubuntu-22.04', 'macos-14']);
        const commands = quick.jobs.build.steps.map(step => step.run || '').join('\n');
        assert.ok(commands.includes('npm run build\n'));
        assert.ok(commands.includes('--bail'));
        assert.ok(commands.includes('official field value completions'));
        assert.ok(commands.includes('npm run test:webview:compiled'));
        const checks = quick.jobs.contracts.steps.map(step => step.run || '').join('\n');
        assert.ok(checks.indexOf('npm run compile') >= 0 && checks.indexOf('npm run compile') < checks.indexOf('check:contracts'));
        assert.ok(!commands.includes('npm run test:unit'));
        assert.ok(!JSON.stringify(quick).includes('vsce publish'));
        assert.equal(read('release.yml').jobs.build.uses, './.github/workflows/public-ci.yml');
    });
    it('builds SQLite and a target VSIX on each matching runner and tests that artifact twice', () => {
        const workflow = read('public-ci.yml'), build = read('ci-platform.yml').jobs['public-checks'], host = read('ci-installed.yml').jobs.host;
        assert.ok('workflow_call' in workflow.on);
        const targets = ['win32-x64', 'linux-x64', 'darwin-arm64'];
        assert.deepEqual(workflow.jobs.platforms.strategy.matrix.include.map(row => row.target), targets);
        assert.equal(build['runs-on'], '${{ inputs.os }}');
        assert.deepEqual(workflow.jobs['installed-host'].strategy.matrix.platform.map(row => row.target), targets);
        assert.equal(workflow.jobs['installed-host'].strategy.matrix.exclude, "${{ fromJSON(inputs.retry_exclude || '[]') }}");
        assert.deepEqual(read('ci-platform.yml').jobs['installed-host'].strategy.matrix.vscode, ['1.100.0', '1.139.1']);
        const commands = build.steps.map(step => step.run || '').join('\n');
        assert.ok(commands.indexOf('build:native-sqlite') < commands.indexOf('package-hover-release.cjs'));
        assert.ok(commands.includes('dist/candidate.vsix "${{ inputs.target }}"'));
        const upload = build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
        const download = host.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
        assert.equal(upload.with.name, 'candidate-${{ inputs.target }}');
        assert.equal(download.with.name, 'candidate-${{ inputs.target }}');
        assert.ok(upload.with.path.includes('candidate.vsix.baseline.vsix'));
        const acceptance = host.steps.find(step => step.run?.includes('run-installed-acceptance.cjs'));
        assert.ok(!acceptance.run.includes('benchmark-release-hosts.cjs'));
        assert.equal(workflow.env.LSDYNA_CI_FUNCTIONAL_ONLY, '1');
    });
    it('reuses the build and same-run Linux corpus check without skipping platform tests', () => {
        const workflow = read('ci-platform.yml'), build = workflow.jobs['public-checks'];
        const commands = build.steps.map(step => step.run || '').join('\n');
        assert.equal((commands.match(/^npm run build$/gm) || []).length, 1);
        assert.ok(!/npm test(?:\s|$)/.test(commands));
        assert.ok(!commands.includes('npm run data:check'));
        assert.ok(!commands.includes('npm run update:source-manifest'));
        assert.ok(commands.includes('npm run check:contracts'));
        const contract = fs.readFileSync(path.join(root, 'scripts/release/validate-public-source-contracts.cjs'), 'utf8');
        assert.ok(contract.includes('updateSourceManifest(process.cwd())'));
        const tests = build.steps.find(step => step.name?.startsWith('Test the existing build'));
        assert.ok(tests.run.includes('if [[ "$RUNNER_OS" == "Linux" ]]'));
        assert.ok(tests.run.includes('npm run test:unit\n'));
        assert.ok(tests.run.includes("npm run test:unit -- --grep '\\[full-corpus\\]' --invert"));
        assert.ok(tests.run.includes('npm run test:data'));
        assert.equal(workflow.jobs['installed-host'].needs, 'public-checks');
    });
    it('publishes only after the reusable checks and target-specific evidence verification', () => {
        const release = read('release.yml');
        assert.equal(release.on.workflow_dispatch.inputs.publish.default, false);
        assert.match(release.jobs.build.if, /!inputs.reuse_plan/);
        assert.match(JSON.stringify(release.jobs.reuse), /reuse-release-evidence.cjs/);
        assert.ok(release.jobs.publish.needs.includes('reuse'));
        assert.match(release.jobs.publish.if, /needs.reuse.result == 'success'/);
        assert.equal(release.jobs.build.uses, './.github/workflows/public-ci.yml');
        assert.ok(release.jobs.publish.needs.includes('build'));
        assert.deepEqual(release.concurrency, { group: 'release-publishing', 'cancel-in-progress': false, queue: 'max' });
        const steps = release.jobs.publish.steps;
        const index = text => steps.findIndex(step => (step.run || '').includes(text));
        assert.ok(index('verify-release-acceptance.cjs') >= 0);
        assert.ok(index('verify-release-acceptance.cjs') < index('vsce publish'));
        assert.ok(index('release-plan.cjs --notes') < index('vsce publish'));
        assert.ok(index('verify-release-destination.cjs') < index('vsce publish'));
        assert.ok(!steps.some(step => /npm run build|package-hover-release/.test(step.run || '')), 'Publish the verified artifact without rebuilding');
        const downloads = steps.filter(step => step.uses?.startsWith('actions/download-artifact@') && step.with.pattern);
        assert.deepEqual(downloads.map(step => step.with.pattern), ['candidate-*', 'installed-*']);
        assert.ok(downloads.every(step => !step.with['run-id']), 'Automatic publication uses the same run');
        assert.ok(index('Missing repository secret: OVSX_PAT') < index('vsce publish'));
        assert.ok(steps[index('verify-release-acceptance.cjs')].run.includes('"$target"'));
        assert.ok(!JSON.stringify(release).includes('requirements-codegen'));
        assert.ok(fs.existsSync(path.join(root, '.github/scripts/marketplace-release.cjs')));
        assert.ok(fs.existsSync(path.join(root, '.github/release-appendix.md')));
        assert.ok(read('verify-marketplace.yml').jobs);
    });
    it('supports GitHub-only artifact publication without rebuilding or invoking marketplace credentials', () => {
        const release = read('release.yml'), steps = release.jobs.publish.steps;
        assert.equal(release.on.workflow_dispatch.inputs.github_only.default, false);
        const metadata = release.jobs.metadata.steps.find(step => step.id === 'metadata');
        assert.equal(metadata.run, 'node scripts/release/release-plan.cjs');
        assert.equal(metadata.env.GITHUB_ONLY, '${{ inputs.github_only }}');
        for (const name of ['Verify Open VSX credentials', 'Sign in to Azure with GitHub OIDC',
            'Publish to Visual Studio Marketplace', 'Publish to Open VSX', 'Create marketplace release verification issue']) {
            assert.equal(steps.find(step => step.name === name).if, '${{ !inputs.github_only }}');
        }
        const upload = steps.findIndex(step => step.name === 'Create GitHub Release');
        assert.equal(steps[upload].if, "${{ steps.destination.outputs.published != 'true' }}");
        assert.equal(steps[upload].with.body_path, 'release-notes.md');
        assert.equal(steps[upload].with.generate_release_notes, false);
        assert.equal(steps[upload].with.append_body, false);
        assert.equal(steps[upload].with.draft, true, 'Keep release a draft until asset upload succeeds');
        assert.equal(steps[upload].with.fail_on_unmatched_files, true);
        assert.equal(steps[upload].with.files, 'release-assets/*.vsix');
        assert.ok(steps.findIndex(step => step.name === 'Publish completed GitHub Release') > upload);
    });
    it('allows installation-only retries only with verified source builds and case reports', () => {
        const workflow = read('public-ci.yml'), host = read('ci-installed.yml').jobs.host;
        assert.ok(workflow.on.workflow_dispatch.inputs.build_run);
        for (const name of ['public-ci.yml', 'ci.yml', 'release.yml']) assert.equal(read(name).permissions.actions, 'read');
        assert.equal(workflow.jobs.platforms.if, "${{ (!inputs.node || inputs.node == 'full') && !inputs.build_run }}");
        assert.equal(read('ci-platform.yml').jobs['installed-host'].needs, 'public-checks');
        assert.ok(workflow.jobs['installed-host'].if.includes("github.event_name == 'workflow_dispatch'"));
        const prepare = host.steps.findIndex(step => step.run?.includes('run-installed-acceptance-retry.cjs'));
        const run = host.steps.findIndex(step => step.run?.includes('node scripts/host/run-installed-acceptance.cjs'));
        assert.ok(prepare >= 0 && prepare < run);
        assert.equal(host.steps.find(step => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'], 0);
        assert.equal(host.steps.find(step => step.uses?.startsWith('actions/download-artifact@')).with['run-id'], '${{ inputs.build_run || github.run_id }}');
        assert.ok(!host.steps[run].run.includes('LSDYNA_REUSE_PERFORMANCE'));
    });
    it('routes a selected node away from the full build and installed matrices', () => {
        const full = read('public-ci.yml'), node = read('ci-node.yml');
        assert.equal(full.jobs['selected-node'].uses, './.github/workflows/ci-node.yml');
        assert.equal(full.on.workflow_dispatch.inputs.node.default, 'full');
        assert.ok(full.on.workflow_dispatch.inputs.node.options.every(Boolean));
        assert.equal(full.jobs['selected-node'].if, "${{ inputs.node && inputs.node != 'full' }}");
        for (const job of [full.jobs.platforms, full.jobs['installed-host']])
            assert.ok(job.if.includes("(!inputs.node || inputs.node == 'full')"));
        assert.ok(full.jobs.platforms.if.includes('!inputs.node'));
        assert.ok(full.jobs['installed-host'].if.includes('!inputs.node'));
        assert.ok(full.on.workflow_dispatch.inputs.node.options.includes('installed'));
        assert.ok(!node.on.push && !node.on.pull_request);
        const steps = node.jobs.node.steps, text = steps.map(step => step.run || '').join('\n');
        assert.ok(text.includes('--fail-zero') && text.includes('"test/$TEST_FILE"'));
        assert.ok(text.includes('refs/heads/dev'));
        const guard = steps.findIndex(step => step.run === 'node scripts/host/run-installed-acceptance-retry.cjs');
        const host = steps.findIndex(step => step.run?.includes('node scripts/host/run-installed-acceptance.cjs'));
        assert.ok(guard >= 0 && guard < host);
        assert.equal(node.jobs.node.env.LSDYNA_ACCEPTANCE_CASE, '${{ inputs.host_case }}');
    });
    it('rejects empty selections, escaped test paths and non-dev node requests before execution', () => {
        const run = read('ci-node.yml').jobs.node.steps.find(step => step.name === 'Validate request and record exact source').run;
        const source = run.split("node <<'NODE'\n")[1].split('\nNODE')[0];
        const execute = values => require('node:vm').runInNewContext(source, {
            process: { platform: process.platform, arch: process.arch, env: {
                CI_NODE: 'unit', EXPECTED_TARGET: `${process.platform}-${process.arch}`, TEST_GREP: 'workflow',
                TEST_FILE: 'scripts/release/publicWorkflow.test.js', GITHUB_REF: 'refs/heads/dev', ...values,
            } },
            require: name => name === 'node:fs' ? { ...fs, mkdirSync() {}, writeFileSync() {} } : require(name),
        });
        execute({});
        for (const node of ['profile', 'performance']) assert.throws(() => execute({ CI_NODE: node, BUILD_RUN: '123' }));
        for (const values of [{TEST_GREP:''}, {TEST_GREP:'['}, {TEST_FILE:'../package.json'},
            {CI_NODE:'profile',LSDYNA_ACCEPTANCE_CASE:'../manager',BUILD_RUN:'123'},
            {CI_NODE:'profile',LSDYNA_ACCEPTANCE_CASE:'manager',BUILD_RUN:''},
            {GITHUB_REF:'refs/heads/master'}, {CI_NODE:'unknown'}, {CI_NODE:'installed',LSDYNA_ACCEPTANCE_CASE:''}])
            assert.throws(() => execute(values));
    });
    it('excludes performance and native menus while preserving functional CI and local diagnostic tools', () => {
        const full = read('public-ci.yml'), quick = read('fast-ci.yml'), node = read('ci-node.yml');
        assert.ok(!full.on.workflow_dispatch.inputs.node.options.includes('performance'));
        assert.ok(!full.on.workflow_dispatch.inputs.node.options.includes('profile'));
        for (const workflow of [full, quick]) assert.equal(workflow.env.LSDYNA_CI_FUNCTIONAL_ONLY, '1');
        assert.equal(node.jobs.node.env.LSDYNA_CI_FUNCTIONAL_ONLY, '1');
        for (const workflow of [full, quick, node, read('ci-platform.yml'), read('ci-installed.yml')]) {
            const commands = Object.values(workflow.jobs).flatMap(job => (job.steps || []).map(step => step.run || '')).join('\n');
            assert.ok(!commands.includes('benchmark-release-hosts.cjs'));
            assert.ok(!commands.includes('mouse-context-menu'));
        }
        assert.ok(fs.existsSync(path.join(root, 'scripts/benchmark/benchmark-release-hosts.cjs')));
        assert.ok(fs.existsSync(path.join(root, 'test/support/editor-safety/native-menu.cjs')));
    });
});
