'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
function verify(vsix, directory, target) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex');
    const walk = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(item => item.isDirectory()
        ? walk(path.join(root, item.name)) : item.name === 'acceptance.json' ? [path.join(root, item.name)] : []);
    const reports = walk(directory).map(file => ({ file, data: JSON.parse(fs.readFileSync(file)) }));
    if (target) assert.ok(['win32-x64', 'linux-x64', 'darwin-arm64'].includes(target), 'Unknown release target');
    const platforms = target ? [target.split('-')[0]] : ['win32', 'linux', 'darwin'];
    for (const platform of platforms) for (const version of ['1.100.0', '1.139.1']) {
        const matches = reports.filter(item => item.data.platform === platform && item.data.vscodeVersion === version && item.data.vsixSha256 === sha);
        assert.equal(matches.length, 1, `Missing or ambiguous acceptance for ${platform}/${version}`);
        const { data } = matches[0]; assert.equal(data.complete, true);
        if (target) assert.equal(data.arch, target.split('-')[1], 'Acceptance architecture mismatch');
        const required = ['run-release-host.cjs-catalog', 'run-release-host.cjs-smoke', 'test-release-manual-renderer.cjs',
            'run-keyword-manager-gui.cjs', 'run-keyword-manager-gui.cjs-incomplete', 'benchmark-keyword-manager-webview.cjs',
            'run-editor-safety-extension-host.cjs-ci-functional', 'run-large-file-viewer-host.cjs',
            'upgrade', 'reload', 'offline', 'missing-external-manual'];
        if (platform === 'win32') required.push('ordinary-project-f5');
        for (const name of required) assert.ok(data.cases.some(item => item.name === name && item.passed === true), `Missing acceptance case ${name}`);
        assert.equal(data.scope, 'required-functional-acceptance');
        assert.deepEqual(data.excludedChecks, ['performance', 'native-system-menu']);
    }
    return { complete: true, scope: 'required-functional-acceptance', excludedChecks: ['performance', 'native-system-menu'], vsixSha256: sha, platforms: platforms.length, versions: 2 };
}
if (require.main === module) { console.log(JSON.stringify(verify(...process.argv.slice(2)))); }
module.exports = { verify };
