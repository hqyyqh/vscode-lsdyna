'use strict';
// VSCE scans all files before applying .vscodeignore. Stage only release roots
// so development/native traces cannot make packaging unbounded.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { pack } = require('@vscode/vsce/out/package');
const validation = require('./validate-package-contents.cjs');
const { compactStage, pruneInputFormShards } = require('./compact-release-stage.cjs');
const root = path.resolve(__dirname, "../..");
const manifest = require("../../package.json");
const output = path.resolve(process.argv[2] || `${manifest.name}-${manifest.version}.vsix`);
const stage = fs.mkdtempSync(path.join(root, 'out/vsix-stage-'));
const internalDirectory = fs.mkdtempSync(path.join(root, 'out/private-release-checks-'));
const publicIdentity = require('./public-release-reports.cjs').identityReport;
function validateVsix(file) {
    const files = validation.listVsixFiles(file);
    const errors = validation.validateVsix(file);
    if (errors.length) throw Error(errors.join('\n'));
    return files;
}
const copy = relative => {
    const source = path.join(root, relative), target = path.join(stage, relative);
    if (!fs.existsSync(source)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true });
};
function overlayDataBuild() {
    const dataStage = path.join(root, 'out/data-build');
    const lineage = JSON.parse(fs.readFileSync(path.join(dataStage, 'keywords/provenance/current-data.json')));
    assert.equal(lineage.kind, 'dynasense-local-data-projection');
    const expected = { ...lineage.outputs, ...lineage.derived };
    for (const [file, expectedSha] of Object.entries(expected)) {
        require('./update-source-manifest.cjs').safePath(file);
        const source = path.join(dataStage, file), relative = path.relative(dataStage, fs.realpathSync(source));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Data build escaped stage');
        assert.equal(fs.lstatSync(source).isSymbolicLink(), false, 'Data build must not contain symlinks');
        const bytes = fs.readFileSync(source);
        assert.equal(require('./build-public-runtime-data.cjs').sha256(bytes), expectedSha, `Staged data identity changed: ${file}`);
        const target = path.join(stage, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
    }
    fs.mkdirSync(path.join(stage, 'keywords/provenance'), { recursive: true });
    fs.copyFileSync(path.join(dataStage, 'keywords/provenance/current-data.json'), path.join(stage, 'keywords/provenance/current-data.json'));
}
const safeRemoveStage = () => {
    const resolved = fs.realpathSync(stage), relative = path.relative(path.join(root, 'out'), resolved);
    if (!/^vsix-stage-[^\\/]+$/.test(relative) || relative.startsWith('..'))
        throw Error(`Refusing to remove unexpected release stage: ${resolved}`);
    fs.rmSync(resolved, { recursive: true, force: true });
};
async function main() {
    try {
        const publicSource = true;
        if (publicSource) require('./build-public-runtime-data.cjs').verifyPublicData(root);
        for (const name of ['.vscodeignore', 'package.json', 'package.nls.json', 'package.nls.zh-cn.json',
            'README.md', 'README_zh.md', 'CHANGELOG.md', 'SUPPORT.md', 'LICENSE',
            'language-configuration.json', 'language-configuration-lspp-cfile.json',
            'out/extension.js', 'keywords', 'images', 'snippets', 'syntaxes',
            ...['client', 'core', 'manual', 'platform', 'server', 'shared', 'worker', 'runtime', 'webview']
                .map(name => `out/${name}`)]) copy(name);
        // Overlay this checkout's verified fresh build; internal stages are projected below.
        overlayDataBuild();
        copy('package-lock.json');
        const npm = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
            { cwd: stage, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
        if (npm.status !== 0) throw Error(`Clean production dependency installation failed: ${npm.stderr}`);
        const snapshot = (functionalOnly = false, projectionReport) => {
            const result = spawnSync(process.execPath, [path.join(root, "scripts/release/compare-release-data.cjs"),
                functionalOnly ? '--functional-snapshot' : '--snapshot', stage, ...(projectionReport ? [projectionReport] : [])],
                { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NODE_PATH: '' } });
            if (result.status !== 0) throw Error(`Release data snapshot failed: ${result.stderr}`);
            return JSON.parse(result.stdout);
        };
        
        
        
        // The public baseline must satisfy the same process-file boundary as the candidate.
        for (const name of ['authority-lock.json', 'build-report.json', 'proof-report.json'])
            fs.rmSync(path.join(stage, "keywords/runtime/semantic-v2", name), { force: true });
        fs.appendFileSync(path.join(stage, '.vscodeignore'), "\n!keywords/runtime/native-readers/descriptor-identities.json\n");
        pruneInputFormShards(stage);
        const baseline = snapshot();
        const baselineMetadata = require('./prepare-release-metadata.cjs').prepareReleaseMetadata(stage, { renameResources: false });
        fs.writeFileSync(path.join(internalDirectory, 'baseline-metadata.json'), JSON.stringify(baselineMetadata, null, 2));
        require('node:assert/strict').deepEqual(snapshot(), baseline, 'Baseline metadata cleanup changed functional data');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        // Both public packages use the same sanitized frozen data; the baseline precedes compaction.
        const baselineOutput = output + '.baseline.vsix';
        await pack({ cwd: stage, packagePath: baselineOutput });
        validateVsix(baselineOutput);
        const baselineIdentity = spawnSync(process.env.PYTHON || 'python', [
            path.join(root, "scripts/release/verify-hover-vsix-identity.py"), baselineOutput, stage, path.join(internalDirectory, 'baseline-identity.json'),
        ], { encoding: 'utf8', windowsHide: true });
        if (baselineIdentity.status !== 0) throw Error(`Baseline identity failed: ${baselineIdentity.stderr}`);
        fs.writeFileSync(baselineOutput + '.identity.json', JSON.stringify(publicIdentity(
            JSON.parse(fs.readFileSync(path.join(internalDirectory, 'baseline-identity.json')))), null, 2));
        compactStage(stage);
        const icon = spawnSync(process.env.PYTHON || 'python', [path.join(root, "scripts/release/resize-release-icon.py"),
            path.join(root, 'images/extension-icon.png'), path.join(stage, 'images/extension-icon.png')],
            { encoding: 'utf8', windowsHide: true });
        if (icon.status !== 0) throw Error(`Release icon generation failed: ${icon.stderr}`);
        if (process.env.DYNASENSE_RELEASE_SHARED_RULES === '1')
            require('./compact-input-form.cjs').compactInputForm(stage, process.env.DYNASENSE_RELEASE_BROTLI === '1' ? 'br' : 'gzip');
        if (process.env.DYNASENSE_RELEASE_BROTLI === '1') require('./compact-field-help.cjs').compactFieldHelp(stage);
        fs.appendFileSync(path.join(stage, '.vscodeignore'), "\n!keywords/runtime/input-form/*.json.br\n");
        const compacted = snapshot();
        require('node:assert/strict').deepEqual(compacted, baseline, 'Release compaction changed functional data');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output + '.data-equivalence.json', JSON.stringify({ complete: true,
            scope: 'pre-bundle isolated runtime catalogs', ...baseline.counts,
            formsFingerprint: require('./compare-release-data.cjs').digest(baseline.forms),
            fingerprint: require('./compare-release-data.cjs').digest(baseline) }, null, 2));
        fs.copyFileSync(output + '.data-equivalence.json', baselineOutput + '.data-equivalence.json');
        const metadata = require('./prepare-release-metadata.cjs').prepareReleaseMetadata(stage);
        require('node:assert/strict').deepEqual(snapshot(), compacted, 'Release metadata/path cleanup changed functional data');
        fs.writeFileSync(path.join(internalDirectory, 'metadata.json'), JSON.stringify(metadata, null, 2));
        if (process.env.DYNASENSE_RELEASE_BUNDLE === '1') {
            const report = await require('./bundle-release.cjs').bundleRelease(stage);
            fs.writeFileSync(path.join(internalDirectory, 'bundle.json'), JSON.stringify(report));
        }
        fs.mkdirSync(path.dirname(output), { recursive: true });
        await pack({ cwd: stage, packagePath: output }); // prepublish already ran in acceptance
        const files = validateVsix(output);
        const identityReport = path.join(internalDirectory, 'candidate-identity.json');
        const identity = spawnSync(process.env.PYTHON || 'python', [
            path.join(root, "scripts/release/verify-hover-vsix-identity.py"), output, stage, identityReport,
        ], { cwd: root, encoding: 'utf8', windowsHide: true });
        if (identity.status !== 0) throw Error(`VSIX runtime identity failed: ${identity.stderr || identity.stdout}`);
        const identityResult = JSON.parse(fs.readFileSync(identityReport));
        fs.writeFileSync(output + '.identity.json', JSON.stringify(publicIdentity(identityResult), null, 2));
        console.log(JSON.stringify({ files: files.length, identity: { complete: identityResult.complete,
            vsixSha256: identityResult.vsixSha256, packageBytes: identityResult.packageBytes },
            package: output }));
    } finally {
        safeRemoveStage();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
