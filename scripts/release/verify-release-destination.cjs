'use strict';
const fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

function verifyDestination(tagCommit, commit, release, files) {
    if (tagCommit) assert.equal(tagCommit, commit, 'Release tag belongs to another commit');
    if (!release) return false;
    assert.ok(tagCommit, 'Existing release must have a verifiable tag');
    for (const asset of release.assets) {
        const file = files.find(file => file.name === asset.name);
        assert.ok(file, `Unexpected existing release asset: ${asset.name}`);
        assert.equal(asset.state, 'uploaded');
        assert.equal(asset.size, file.size);
        assert.equal(asset.digest, file.digest, 'Existing version has different package bytes; reuse its verified artifacts');
    }
    if (!release.draft) assert.equal(release.assets.length, files.length, 'Published release is missing platform assets');
    return !release.draft;
}

if (require.main === module) {
    const tag = process.env.RELEASE_TAG;
    const version = JSON.parse(fs.readFileSync('package.json')).version;
    assert.equal(tag, `v${version}`);
    assert.match(tag, /^v\d+\.\d+\.\d+$/);
    const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
    const refs = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
    const rows = refs ? refs.split('\n').map(line => line.split(/\s+/)) : [];
    const tagCommit = (rows.find(row => row[1].endsWith('^{}')) || rows[0])?.[0];
    const releases = JSON.parse(run('gh', ['api', '--paginate', '--slurp',
        `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`])).flat();
    const files = ['win32-x64', 'linux-x64', 'darwin-arm64'].map(target => {
        const bytes = fs.readFileSync(`packages/candidate-${target}/candidate.vsix`);
        return { name: `dynasense-${version}-${target}.vsix`, size: bytes.length,
            digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` };
    });
    const published = verifyDestination(tagCommit, run('git', ['rev-parse', 'HEAD']),
        releases.find(release => release.tag_name === tag), files);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `published=${published}\n`);
}
module.exports = { verifyDestination };
