'use strict';
const fs = require('node:fs'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

function stableVersion(version) {
    assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Expected a stable major.minor.patch version');
    return version.split('.').map(BigInt);
}

function releasePlan(env, event, version, git) {
    const current = stableVersion(version);
    let publish = false;
    if (env.GITHUB_ONLY === 'true') {
        assert.ok(env.MANUAL_PUBLISH !== 'true' && env.REUSE_PLAN,
            'GitHub-only publishing requires reuse_plan and publish=false.');
    }
    if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/master') {
        assert.ok(!event.deleted && !event.forced, 'Automatic release requires a normal master push');
        assert.match(event.before || '', /^[a-f0-9]{40}$/, 'Missing previous master commit');
        assert.ok(!/^0+$/.test(event.before), 'Cannot infer a version increase on branch creation');
        assert.equal(event.after, env.GITHUB_SHA, 'Push commit mismatch');
        git(['merge-base', '--is-ancestor', event.before, env.GITHUB_SHA]);
        const previousVersion = JSON.parse(git(['show', `${event.before}:package.json`])).version;
        const previous = stableVersion(previousVersion);
        const different = current.findIndex((n, i) => n !== previous[i]);
        if (different !== -1) {
            assert.ok(current[different] > previous[different], 'Version must increase; refusing downgrade');
            publish = true;
        }
    } else if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF_TYPE === 'tag') {
        assert.equal(env.GITHUB_REF_NAME, `v${version}`, 'Tag does not match package.json version');
        git(['fetch', '--no-tags', 'origin', 'master']);
        git(['merge-base', '--is-ancestor', env.GITHUB_SHA, 'origin/master']);
        publish = true;
    } else if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
        (env.MANUAL_PUBLISH === 'true' || env.GITHUB_ONLY === 'true')) {
        assert.equal(env.GITHUB_REF, 'refs/heads/master', 'Manual publishing is allowed only from master');
        publish = true;
    }
    return { version, publish, tag_name: publish ? `v${version}` : '' };
}

function releaseNotes(changelog, version, appendix) {
    stableVersion(version);
    const sections = changelog.replace(/\r\n/g, '\n').split(/(?=^## )/m);
    const matches = sections.filter(section => section.split('\n')[0].match(/^## \[([^\]]+)\](?:\s+-\s+.*)?$/)?.[1] === version);
    assert.equal(matches.length, 1, `Expected exactly one CHANGELOG entry for ${version}`);
    assert.ok(matches[0].split('\n').slice(1).join('\n').trim(), 'Release CHANGELOG entry is empty');
    return `${matches[0].trim()}\n\n${appendix.trim()}\n`;
}

if (require.main === module) {
    const version = JSON.parse(fs.readFileSync('package.json')).version;
    const notes = () => fs.writeFileSync('release-notes.md', releaseNotes(
        fs.readFileSync('CHANGELOG.md', 'utf8'), version, fs.readFileSync('.github/release-appendix.md', 'utf8')));
    if (process.argv[2] === '--notes') notes();
    else {
        const plan = releasePlan(process.env, JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH)), version,
            args => execFileSync('git', args, { encoding: 'utf8' }));
        if (plan.publish) notes();
        fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(plan).map(([key, value]) => `${key}=${value}\n`).join(''));
        console.log(plan.publish ? `Release ${plan.tag_name} will use verified CI artifacts.` : 'No release requested; CI only.');
    }
}
module.exports = { releasePlan, releaseNotes };
