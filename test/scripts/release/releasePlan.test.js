'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { releasePlan, releaseNotes } = require('../../../scripts/release/release-plan.cjs');
const { verifyDestination } = require('../../../scripts/release/verify-release-destination.cjs');
const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/master', GITHUB_SHA: 'b'.repeat(40) };
const event = { before: 'a'.repeat(40), after: env.GITHUB_SHA };
const git = previous => args => args[0] === 'show' ? JSON.stringify({ version: previous }) : '';

describe('automatic stable release planning', () => {
    it('keeps legacy settings documented outside README without dropping default checks', () => {
        const { validateReadmeSettings } = require('../../../scripts/maintenance/validate-project-contracts.cjs');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-docs-'));
        try {
            const readme = path.join(root, 'README.md'); fs.writeFileSync(readme, '# Brief guide');
            const properties = { 'lsdyna.legacy': { default: 256 } };
            const check = () => { const errors = []; validateReadmeSettings(readme, properties, errors); return errors; };
            assert.match(check()[0], /missing setting/);
            fs.writeFileSync(path.join(root, 'CONTRIBUTING.md'), '| `lsdyna.legacy` | `256` | Legacy / 旧版 |');
            assert.deepEqual(check(), []);
            fs.writeFileSync(path.join(root, 'CONTRIBUTING.md'), '| `lsdyna.legacy` | `128` | Legacy / 旧版 |');
            assert.match(check()[0], /expected 256/);
            fs.writeFileSync(readme, '| `lsdyna.legacy` | `256` | Legacy |');
            assert.match(check()[0], /disagree/);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
    it('publishes only a numeric version increase on a normal master push', () => {
        for (const [before, after] of [['3.2.0', '3.2.1'], ['3.9.0', '3.10.0'], ['3.9.9', '4.0.0']]) {
            assert.deepEqual(releasePlan(env, event, after, git(before)), { version: after, publish: true, tag_name: `v${after}` });
        }
        assert.equal(releasePlan(env, event, '3.2.0', git('3.2.0')).publish, false);
        assert.equal(releasePlan({ ...env, GITHUB_REF: 'refs/heads/dev' }, event, '3.3.0', git('3.2.0')).publish, false);
        assert.equal(releasePlan({ ...env, GITHUB_EVENT_NAME: 'pull_request' }, event, '3.3.0', git('3.2.0')).publish, false);
    });
    it('rejects downgrade, invalid versions and missing or rewritten history', () => {
        assert.throws(() => releasePlan(env, event, '3.1.0', git('3.2.0')), /downgrade/);
        for (const version of ['3.2.1-beta.1', '3.02.1', '3.2', '3.2.1\npublish=true'])
            assert.throws(() => releasePlan(env, event, version, git('3.2.0')), /stable/);
        for (const bad of [{ before: '0'.repeat(40) }, { before: '' }, { after: 'c'.repeat(40) }, { forced: true }, { deleted: true }])
            assert.throws(() => releasePlan(env, { ...event, ...bad }, '3.3.0', git('3.2.0')));
        assert.throws(() => releasePlan(env, event, '3.3.0', () => { throw Error('Missing commit'); }), /Missing commit/);
    });
    it('retains tag ancestry and manual publishing guards', () => {
        const tag = { ...env, GITHUB_REF: 'refs/tags/v3.2.0', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v3.2.0' };
        const calls = [];
        assert.equal(releasePlan(tag, {}, '3.2.0', args => calls.push(args)).publish, true);
        assert.deepEqual(calls[1], ['merge-base', '--is-ancestor', env.GITHUB_SHA, 'origin/master']);
        assert.throws(() => releasePlan(tag, {}, '3.2.1', git('3.2.0')), /Tag/);
        assert.throws(() => releasePlan(tag, {}, '3.2.0', () => { throw Error('Not ancestor'); }), /ancestor/);
        const manual = { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' };
        assert.equal(releasePlan(manual, {}, '3.2.0', git()).publish, false);
        assert.equal(releasePlan({ ...manual, MANUAL_PUBLISH: 'true' }, {}, '3.2.0', git()).publish, true);
        assert.throws(() => releasePlan({ ...manual, GITHUB_REF: 'refs/heads/dev', MANUAL_PUBLISH: 'true' }, {}, '3.2.0', git()), /only from master/);
        assert.throws(() => releasePlan({ ...manual, GITHUB_ONLY: 'true' }, {}, '3.2.0', git()), /requires reuse_plan/);
        assert.throws(() => releasePlan({ ...manual, GITHUB_ONLY: 'true', REUSE_PLAN: '{}', MANUAL_PUBLISH: 'true' }, {}, '3.2.0', git()), /requires reuse_plan/);
        assert.equal(releasePlan({ ...manual, GITHUB_ONLY: 'true', REUSE_PLAN: '{}' }, {}, '3.2.0', git()).publish, true);
    });
    it('extracts exactly the requested bilingual entry and replaces rather than appends notes', () => {
        const changelog = '# Changelog\r\n\r\n## [Unreleased]\r\nLater\r\n## [3.2.1] - 2026-10-17\r\n\r\n### Fixed / 修复\r\n- English\r\n- 中文\r\n\r\n## [3.2.0]\r\nOlder\r\n';
        const notes = releaseNotes(changelog, '3.2.1', 'Appendix / 附录');
        assert.equal(notes, '## [3.2.1] - 2026-10-17\n\n### Fixed / 修复\n- English\n- 中文\n\nAppendix / 附录\n');
        assert.throws(() => releaseNotes(changelog, '3.3.0', ''), /exactly one/);
        assert.throws(() => releaseNotes(changelog + '\n## [3.2.1]\nDuplicate', '3.2.1', ''), /exactly one/);
        assert.throws(() => releaseNotes('## [3.2.1]\n\n', '3.2.1', ''), /empty/);
        assert.throws(() => releaseNotes('## [3.2.1]', '3.2.1', ''), /empty/);
    });
    it('runs the actual metadata CLI against the push boundary in a temporary Git repository', function () {
        this.timeout(20000);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-'));
        const runGit = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
        try {
            runGit(['init', '-q']); runGit(['config', 'user.name', 'Test']); runGit(['config', 'user.email', 'test@example.invalid']);
            fs.writeFileSync(path.join(root, 'package.json'), '{"version":"3.2.0"}');
            runGit(['add', '.']); runGit(['commit', '-qm', 'base']); const before = runGit(['rev-parse', 'HEAD']);
            fs.writeFileSync(path.join(root, 'package.json'), '{"version":"3.2.1"}');
            runGit(['add', '.']); runGit(['commit', '-qm', 'bump']); const after = runGit(['rev-parse', 'HEAD']);
            fs.mkdirSync(path.join(root, '.github'));
            fs.writeFileSync(path.join(root, '.github/release-appendix.md'), '附录');
            fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '## [3.2.1]\n\n- Fixed / 修复\n');
            fs.writeFileSync(path.join(root, 'event.json'), JSON.stringify({ before, after }));
            const output = path.join(root, 'output');
            execFileSync(process.execPath, [path.resolve(__dirname, '../../../scripts/release/release-plan.cjs')], {
                cwd: root, env: { ...process.env, ...env, GITHUB_SHA: after, GITHUB_EVENT_PATH: path.join(root, 'event.json'), GITHUB_OUTPUT: output,
                    MANUAL_PUBLISH: '', GITHUB_ONLY: '', REUSE_PLAN: '' }
            });
            assert.match(fs.readFileSync(output, 'utf8'), /publish=true\ntag_name=v3.2.1/);
            assert.match(fs.readFileSync(path.join(root, 'release-notes.md'), 'utf8'), /修复\n\n附录/);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
});

describe('release destination safety', () => {
    const files = ['windows', 'linux', 'mac'].map(name => ({ name, size: 42, digest: 'sha256:verified' }));
    const release = { draft: false, assets: files.map(file => ({ ...file, state: 'uploaded' })) };
    it('permits new versions and identical published retries, and resumes matching drafts', () => {
        assert.equal(verifyDestination(undefined, 'commit', undefined, files), false);
        assert.equal(verifyDestination('commit', 'commit', release, files), true);
        assert.equal(verifyDestination('commit', 'commit', { draft: true, assets: release.assets.slice(0, 1) }, files), false);
    });
    it('blocks conflicting tags, changed artifacts and incomplete published releases', () => {
        assert.throws(() => verifyDestination('other', 'commit', undefined, files), /another commit/);
        assert.throws(() => verifyDestination(undefined, 'commit', release, files), /verifiable tag/);
        assert.throws(() => verifyDestination('commit', 'commit', release, files.map(f => ({ ...f, digest: 'different' }))), /different package bytes/);
        assert.throws(() => verifyDestination('commit', 'commit', { ...release, assets: [] }, files), /missing platform/);
        assert.throws(() => verifyDestination('commit', 'commit', { ...release, assets: [{ ...release.assets[0], name: 'unknown' }] }, files), /Unexpected/);
    });
});
