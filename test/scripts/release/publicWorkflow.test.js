'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const yaml = require('js-yaml');
const root = path.resolve(__dirname, '../../..');
const read = file => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8'));
describe('platform release workflow dependency closure', () => {
    it('bounds dev feedback without replacing complete release acceptance', () => {
        const quick = read('fast-ci.yml'), full = read('public-ci.yml');
        assert.deepEqual(quick.on.push.branches, ['dev']);
        assert.deepEqual(quick.on.pull_request.branches, ['dev']);
        assert.deepEqual(full.on.push.branches, ['master']);
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
        assert.ok(commands.includes('npm run test:webview'));
        const checks = quick.jobs.contracts.steps.map(step => step.run || '').join('\n');
        assert.ok(checks.indexOf('npm run compile') >= 0 && checks.indexOf('npm run compile') < checks.indexOf('check:contracts'));
        assert.ok(!commands.includes('npm run test:unit'));
        assert.ok(!JSON.stringify(quick).includes('vsce publish'));
        assert.equal(read('release.yml').jobs.build.uses, './.github/workflows/public-ci.yml');
    });
    it('builds SQLite and a target VSIX on each matching runner and tests that artifact twice', () => {
        const workflow = read('public-ci.yml'), build = workflow.jobs['public-checks'], host = workflow.jobs['installed-host'];
        assert.ok('workflow_call' in workflow.on);
        const targets = ['win32-x64', 'linux-x64', 'darwin-arm64'];
        assert.deepEqual(build.strategy.matrix.include.map(row => row.target), targets);
        assert.deepEqual(host.strategy.matrix.platform.map(row => row.target), targets);
        assert.equal(host.strategy.matrix.exclude, "${{ fromJSON(inputs.build_run && inputs.retry_exclude || '[]') }}");
        assert.deepEqual(host.strategy.matrix.vscode, ['1.100.0', '1.139.1']);
        const commands = build.steps.map(step => step.run || '').join('\n');
        assert.ok(commands.indexOf('build:native-sqlite') < commands.indexOf('package-hover-release.cjs'));
        assert.ok(commands.includes('dist/candidate.vsix "${{ matrix.target }}"'));
        const upload = build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
        const download = host.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
        assert.equal(upload.with.name, 'candidate-${{ matrix.target }}');
        assert.equal(download.with.name, 'candidate-${{ matrix.platform.target }}');
        assert.ok(upload.with.path.includes('candidate.vsix.baseline.vsix'));
        const acceptance = host.steps.find(step => step.run?.includes('run-installed-acceptance.cjs'));
        assert.ok(!acceptance.run.includes('benchmark-release-hosts.cjs'));
        assert.equal(workflow.env.LSDYNA_CI_FUNCTIONAL_ONLY, '1');
    });
    it('reuses the build and same-run Linux corpus check without skipping platform tests', () => {
        const workflow = read('public-ci.yml'), build = workflow.jobs['public-checks'];
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
        const steps = release.jobs.publish.steps;
        const index = text => steps.findIndex(step => (step.run || '').includes(text));
        assert.ok(index('verify-release-acceptance.cjs') >= 0);
        assert.ok(index('verify-release-acceptance.cjs') < index('vsce publish'));
        assert.ok(index('Missing repository secret: OVSX_PAT') < index('vsce publish'));
        assert.ok(steps[index('verify-release-acceptance.cjs')].run.includes('"$target"'));
        assert.ok(!JSON.stringify(release).includes('requirements-codegen'));
        assert.ok(fs.existsSync(path.join(root, '.github/scripts/marketplace-release.cjs')));
        assert.ok(fs.existsSync(path.join(root, '.github/release-appendix.md')));
        assert.ok(read('verify-marketplace.yml').jobs);
    });
    it('allows installation-only retries only with verified source builds and case reports', () => {
        const workflow = read('public-ci.yml'), host = workflow.jobs['installed-host'];
        assert.ok(workflow.on.workflow_dispatch.inputs.build_run);
        for (const name of ['public-ci.yml', 'ci.yml', 'release.yml']) assert.equal(read(name).permissions.actions, 'read');
        assert.equal(workflow.jobs['public-checks'].if, '${{ !inputs.node && !inputs.build_run }}');
        assert.ok(host.if.includes("needs.public-checks.result == 'success'"));
        assert.ok(host.if.includes("github.event_name == 'workflow_dispatch'"));
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
        assert.ok(full.jobs['public-checks'].if.includes('!inputs.node'));
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
        for (const workflow of [full, quick, node]) {
            const commands = Object.values(workflow.jobs).flatMap(job => (job.steps || []).map(step => step.run || '')).join('\n');
            assert.ok(!commands.includes('benchmark-release-hosts.cjs'));
            assert.ok(!commands.includes('mouse-context-menu'));
        }
        assert.ok(fs.existsSync(path.join(root, 'scripts/benchmark/benchmark-release-hosts.cjs')));
        assert.ok(fs.existsSync(path.join(root, 'test/support/editor-safety/native-menu.cjs')));
    });
});
