'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
async function main() {
    const vsix = path.resolve(process.env.LSDYNA_TEST_VSIX || process.argv[2]);
    const directory = path.resolve(process.env.LSDYNA_TEST_VSIX_EVIDENCE || '.artifacts/release-rebuild/installed-hosts');
    fs.mkdirSync(directory, { recursive: true });
    const executable = process.env.VSCODE_EXECUTABLE_PATH || (process.env.VSCODE_TEST_VERSION
        ? await require('@vscode/test-electron').downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION)
        : require('./run-editor-safety-extension-host.cjs').resolveVSCodeExecutable());
    const parity = JSON.parse(fs.readFileSync(vsix + '.data-equivalence.json'));
    const expected = path.join(directory, 'catalog.json');
    fs.writeFileSync(expected, JSON.stringify({ keywords: parity.keywords, fingerprint: parity.formsFingerprint }));
    const env = { ...process.env, NODE_PATH: '', LSDYNA_TEST_VSIX: vsix, VSCODE_EXECUTABLE_PATH: executable,
        LSDYNA_TEST_VSIX_EVIDENCE: directory, LSDYNA_EXPECTED_CATALOG: expected };
    const report = { complete: false, vsixSha256: crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'),
        platform: process.platform, arch: process.arch, requestedVscodeVersion: process.env.VSCODE_TEST_VERSION || null, vscodeVersion: null, cases: [] };
    const file = path.join(directory, 'acceptance.json');
    const cases = [
        ['../release/verify-release-hash.cjs', vsix], ['run-release-host.cjs', 'catalog'], ['run-release-host.cjs', 'smoke'],
        ['test-release-manual-renderer.cjs'], ['run-keyword-manager-gui.cjs'], ['run-keyword-manager-gui.cjs', '--incomplete'],
        ['../benchmark/benchmark-keyword-manager-webview.cjs'], ['run-editor-safety-extension-host.cjs'], ['run-large-file-viewer-host.cjs'],
        ...['upgrade', 'reload', 'offline', 'missing-external-manual', ...(process.platform === 'win32' ? ['ordinary-project-f5'] : [])]
            .map(name => ['run-release-lifecycle.cjs', name]),
    ];
    for (const [script, ...args] of cases) {
        const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { env, encoding: 'utf8', windowsHide: true,
            maxBuffer: 32 * 1024 * 1024, timeout: 600000 });
        const name = script === 'run-release-lifecycle.cjs' ? args[0]
            : [path.basename(script), ...args.map(arg => path.basename(arg).replace(/^--/, ''))].join('-');
        fs.writeFileSync(path.join(directory, name + '.log'), (result.stdout || '') + (result.stderr || ''));
        report.cases.push({ name, passed: result.status === 0, error: result.error?.message });
        fs.writeFileSync(file, JSON.stringify(report, null, 2));
        if (result.status !== 0) throw Error(`Installed acceptance failed: ${name}; see ${file}`);
    }
    const identities = fs.readdirSync(directory).filter(name => /^\d+-\d+\.json$/.test(name))
        .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
        .filter(item => item.sha256 === report.vsixSha256 && item.status === 'passed' && item.vscodeVersion);
    const versions = [...new Set(identities.map(item => item.vscodeVersion))];
    if (versions.length !== 1 || (report.requestedVscodeVersion && versions[0] !== report.requestedVscodeVersion))
        throw Error('Installed host identity must record one actual target VS Code version');
    report.vscodeVersion = versions[0];
    report.complete = true; fs.writeFileSync(file, JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
