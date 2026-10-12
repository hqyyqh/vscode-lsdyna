'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
async function main() {
    const vsix = path.resolve(process.env.LSDYNA_TEST_VSIX || process.argv[2]);
    const directory = path.resolve(process.env.LSDYNA_TEST_VSIX_EVIDENCE || '.artifacts/release-rebuild/installed-hosts');
    fs.mkdirSync(directory, { recursive: true });
    const downloaded = process.env.VSCODE_EXECUTABLE_PATH || (process.env.VSCODE_TEST_VERSION
        ? await require('@vscode/test-electron').downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION)
        : require('./run-editor-safety-extension-host.cjs').resolveVSCodeExecutable());
    const executable = require('./vsix-host.cjs').resolveExecutable(downloaded);
    const parity = JSON.parse(fs.readFileSync(vsix + '.data-equivalence.json'));
    const expected = path.join(directory, 'catalog.json');
    fs.writeFileSync(expected, JSON.stringify({ keywords: parity.keywords, fingerprint: parity.formsFingerprint }));
    const env = { ...process.env, NODE_PATH: '', LSDYNA_TEST_VSIX: vsix, VSCODE_EXECUTABLE_PATH: executable,
        LSDYNA_TEST_VSIX_EVIDENCE: directory, LSDYNA_EXPECTED_CATALOG: expected };
    const report = { complete: false, vsixSha256: crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'),
        platform: process.platform, arch: process.arch, requestedVscodeVersion: process.env.VSCODE_TEST_VERSION || null, vscodeVersion: null, cases: [] };
    const file = path.join(directory, 'acceptance.json');
    const previous = process.env.LSDYNA_ACCEPTANCE_RESUME
        ? JSON.parse(fs.readFileSync(process.env.LSDYNA_ACCEPTANCE_RESUME, 'utf8')) : null;
    if (previous) {
        for (const key of ['vsixSha256', 'platform', 'arch', 'requestedVscodeVersion'])
            if (!report[key] || previous[key] !== report[key]) throw Error(`Resume identity mismatch: ${key}`);
        if (previous.vscodeVersion && previous.vscodeVersion !== report.requestedVscodeVersion)
            throw Error('Resume actual VS Code version mismatch');
        report.reusedFromRun = previous.sourceRun;
    }
    const cases = [
        ['../release/verify-release-hash.cjs', vsix], ['run-release-host.cjs', 'catalog'], ['run-release-host.cjs', 'smoke'],
        ['test-release-manual-renderer.cjs'], ['run-keyword-manager-gui.cjs'], ['run-keyword-manager-gui.cjs', '--incomplete'],
        ['../benchmark/benchmark-keyword-manager-webview.cjs'], ['run-editor-safety-extension-host.cjs'], ['run-large-file-viewer-host.cjs'],
        ...['upgrade', 'reload', 'offline', 'missing-external-manual', ...(process.platform === 'win32' ? ['ordinary-project-f5'] : [])]
            .map(name => ['run-release-lifecycle.cjs', name]),
    ];
    const caseName = ([script, ...args]) => script === 'run-release-lifecycle.cjs' ? args[0]
        : [path.basename(script), ...args.map(arg => path.basename(arg).replace(/^--/, ''))].join('-');
    const selected = process.env.LSDYNA_ACCEPTANCE_CASE;
    const selectedCases = selected ? new Set(selected.split(',').map(name => name.trim())) : null;
    for (const name of selectedCases || []) {
        if (!cases.slice(1).some(item => caseName(item) === name))
            throw Error(`Unknown installed acceptance case: ${name}`);
    }
    for (const entry of cases) {
        const [script, ...args] = entry, name = caseName(entry);
        // Always recheck package integrity; only reuse explicitly passed host cases.
        if (script !== '../release/verify-release-hash.cjs' && previous?.cases.some(item => item.name === name && item.passed === true)) {
            report.cases.push({ name, passed: true, reused: true });
            fs.writeFileSync(file, JSON.stringify(report, null, 2));
            continue;
        }
        if (selectedCases && script !== '../release/verify-release-hash.cjs' && !selectedCases.has(name)) continue;
        const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { env, encoding: 'utf8', windowsHide: true,
            maxBuffer: 32 * 1024 * 1024, timeout: 600000 });
        fs.writeFileSync(path.join(directory, name + '.log'), (result.stdout || '') + (result.stderr || ''));
        report.cases.push({ name, passed: result.status === 0, error: result.error?.message });
        fs.writeFileSync(file, JSON.stringify(report, null, 2));
        if (result.status !== 0) {
            console.error(`Failed installed case: ${name}\n${result.stdout || ''}\n${result.stderr || ''}`);
            if (!selectedCases || selectedCases.size === 1 || result.error || result.signal)
                throw Error(`Installed acceptance failed: ${name} (${result.error?.message || result.signal || result.status}); see ${file}`);
        }
    }
    const identities = fs.readdirSync(directory).filter(name => /^\d+-\d+\.json$/.test(name))
        .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
        .filter(item => item.sha256 === report.vsixSha256 && item.status === 'passed' && item.vscodeVersion);
    const versions = [...new Set([...identities.map(item => item.vscodeVersion), ...(previous?.vscodeVersion ? [previous.vscodeVersion] : [])])];
    if (versions.length !== 1 || (report.requestedVscodeVersion && versions[0] !== report.requestedVscodeVersion))
        throw Error('Installed host identity must record one actual target VS Code version');
    report.vscodeVersion = versions[0];
    report.complete = cases.every(entry => report.cases.some(item => item.name === caseName(entry) && item.passed === true));
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    if (report.cases.some(item => item.passed === false)) throw Error(`Selected acceptance cases failed; see ${file}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
