'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { verify } = require("../../../scripts/release/verify-release-acceptance.cjs");
describe('immutable release acceptance gate', () => {
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
                'run-keyword-manager-gui.cjs', 'run-keyword-manager-gui.cjs-incomplete', 'benchmark-keyword-manager-webview.cjs',
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
