'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { runTests: runDevelopmentTests } = require('@vscode/test-electron');

function resolveExecutable(executable, platform = process.platform) {
    if (!executable || platform !== 'darwin' || fs.existsSync(executable)) return executable;
    const directory = path.dirname(executable);
    const plist = fs.readFileSync(path.resolve(directory, '../Info.plist'), 'utf8');
    const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    assert.ok(name && path.basename(name) === name, 'Missing or unsafe macOS bundle executable');
    const actual = path.join(directory, name);
    assert.ok(fs.statSync(actual).isFile(), 'macOS bundle executable is missing');
    return actual;
}

function resolveCliEntry(executable) {
    const root = path.dirname(executable);
    const standard = process.platform === 'darwin'
        ? path.resolve(root, "../Resources/app/out/cli.js") : path.join(root, 'resources/app/out/cli.js');
    if (fs.existsSync(standard)) return standard;
    // Current Windows archives keep app resources under the build commit directory.
    const candidates = fs.readdirSync(root, { withFileTypes: true })
        .filter(item => item.isDirectory() && /^[a-f0-9]{10,40}$/i.test(item.name))
        .map(item => path.join(root, item.name, 'resources/app/out/cli.js')).filter(file => fs.existsSync(file));
    assert.equal(candidates.length, 1, 'Expected one VS Code CLI entry in the selected archive');
    return candidates[0];
}

// Existing scenarios can test either the development tree or an installed VSIX.
// The development extension in installed mode is only a test driver, never DynaSense.
async function runTests(options) {
    const executable = resolveExecutable(options.vscodeExecutablePath);
    if (executable !== options.vscodeExecutablePath) options = { ...options, vscodeExecutablePath: executable };
    if (!process.env.LSDYNA_TEST_VSIX) return runDevelopmentTests(options);
    const vsix = path.resolve(process.env.LSDYNA_TEST_VSIX);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex');
    if (process.env.LSDYNA_TEST_VSIX_SHA256) assert.equal(sha256, process.env.LSDYNA_TEST_VSIX_SHA256);
    const argPath = name => {
        const value = options.launchArgs.find(arg => arg.startsWith(`--${name}=`));
        assert.ok(value, `Installed host needs an isolated ${name}`);
        return path.resolve(value.slice(name.length + 3));
    };
    const extensions = argPath('extensions-dir'), profile = argPath('user-data-dir');
    fs.mkdirSync(extensions, { recursive: true });
    fs.mkdirSync(profile, { recursive: true });
    const installation = spawnSync(options.vscodeExecutablePath, [resolveCliEntry(options.vscodeExecutablePath),
        '--install-extension', vsix, '--force', `--extensions-dir=${extensions}`, `--user-data-dir=${profile}`,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    assert.equal(installation.status, 0, installation.error?.message || installation.stderr || installation.stdout);
    const candidates = fs.readdirSync(extensions).map(name => path.join(extensions, name)).filter(dir => {
        try { const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
            return manifest.publisher === 'hqyyqh' && manifest.name === 'dynasense' &&
                (!process.env.LSDYNA_TEST_PACKAGE_VERSION || manifest.version === process.env.LSDYNA_TEST_PACKAGE_VERSION); } catch { return false; }
    });
    assert.equal(candidates.length, 1, 'Exactly one installed DynaSense must be selected');
    const installed = candidates[0];
    // Compare every installed package entry with the same ZIP used for all hosts.
    const verification = spawnSync(process.env.PYTHON || 'python', ['-c', [
        'import json,pathlib,sys,zipfile',
        'root=pathlib.Path(sys.argv[2]).resolve()',
        'with zipfile.ZipFile(sys.argv[1]) as z:',
        ' for entry in z.infolist():',
        '  if not entry.filename.startswith("extension/") or entry.is_dir(): continue',
        '  target=(root/entry.filename[len("extension/"):]).resolve()',
        '  assert target.is_relative_to(root), entry.filename',
        '  actual,expected=target.read_bytes(),z.read(entry)',
        '  if entry.filename=="extension/package.json":',
        '   actual,expected=json.loads(actual),json.loads(expected)',
        '   actual.pop("__metadata",None)',
        '   expected.pop("__metadata",None)',
        '  assert actual==expected, entry.filename',
    ].join('\n'), vsix, installed], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    assert.equal(verification.status, 0, verification.error?.message || verification.stderr);
    const driver = path.join(profile, 'release-test-driver');
    fs.mkdirSync(driver, { recursive: true });
    fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({
        name: 'release-test-driver', publisher: 'local', version: '0.0.0', engines: { vscode: '^1.100.0' },
    }));
    const evidenceRoot = path.resolve(process.env.LSDYNA_TEST_VSIX_EVIDENCE || '.artifacts/release-rebuild/installed-hosts');
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const resultFile = path.join(evidenceRoot, `${Date.now()}-${process.pid}.json`);
    const identity = { vsix, sha256, installed, entry: options.extensionTestsPath,
        vscodeExecutablePath: options.vscodeExecutablePath, platform: process.platform,
        packageVersion: JSON.parse(fs.readFileSync(path.join(installed, 'package.json'))).version,
        installedBytesMatchZip: true, installationMetadataException: 'package.json.__metadata added by VS Code', status: 'running' };
    fs.writeFileSync(resultFile, JSON.stringify(identity, null, 2));
    const entry = path.join(driver, 'test.cjs');
    fs.writeFileSync(entry, `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vscode=require('vscode');
exports.run=async()=>{
const hostIdentity=JSON.parse(fs.readFileSync(${JSON.stringify(resultFile)},'utf8'));
hostIdentity.vscodeVersion=vscode.version; fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(hostIdentity,null,2));
if(process.env.VSCODE_TEST_VERSION) assert.equal(vscode.version,process.env.VSCODE_TEST_VERSION,'Installed host version differs from requested matrix version');
const extension=vscode.extensions.getExtension('hqyyqh.dynasense');
 assert.ok(extension,'Installed DynaSense must be discoverable');
 assert.equal(fs.realpathSync(extension.extensionPath),fs.realpathSync(${JSON.stringify(installed)}));
 const installedRoot=fs.realpathSync(extension.extensionPath);
 const withinInstalled=file=>{const relative=path.relative(installedRoot,fs.realpathSync(file));
  return relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
 const Module=require('node:module'),originalResolve=Module._resolveFilename;
 Module._resolveFilename=function(request,parent,...rest){
  const resolved=originalResolve.call(this,request,parent,...rest);
  if(parent?.filename&&path.isAbsolute(parent.filename)&&request!=='vscode'&&path.isAbsolute(resolved)&&withinInstalled(parent.filename))
   assert.ok(withinInstalled(resolved),'Installed runtime escaped its package: '+resolved);
  if(process.platform==='win32'&&path.isAbsolute(resolved)&&withinInstalled(resolved))
   return resolved[0].toLowerCase()+resolved.slice(1);
  return resolved;
 };
 await require(${JSON.stringify(options.extensionTestsPath)}).run();
};\n`);
    // VS Code terminates test mode when Reload Window is invoked. A normal development
    // driver survives the real reload and exits only after the new host verifies it.
    const runReload = async () => {
        const completed = path.join(driver, 'completed.json');
        fs.writeFileSync(path.join(driver, 'package.json'), JSON.stringify({ name: 'release-test-driver', publisher: 'local',
            version: '0.0.0', engines: { vscode: '^1.100.0' }, main: './activate.cjs', activationEvents: ['onStartupFinished'] }));
        fs.writeFileSync(path.join(driver, 'activate.cjs'), `exports.activate=async()=>{
            const fs=require('node:fs'),vscode=require('vscode');
            try { await require('./test.cjs').run(); fs.writeFileSync(${JSON.stringify(completed)},JSON.stringify({passed:true})); }
            catch(error) { fs.writeFileSync(${JSON.stringify(completed)},JSON.stringify({passed:false,error:String(error.stack||error)})); }
            await vscode.commands.executeCommand('workbench.action.quit');
        };`);
        await new Promise((resolve, reject) => {
            const child = spawn(options.vscodeExecutablePath, [...options.launchArgs.filter(arg => arg !== '--disable-extensions'),
                `--extensionDevelopmentPath=${driver}`], { env: { ...process.env, ...options.extensionTestsEnv, NODE_PATH: '',
                    LSDYNA_INSTALLED_EXTENSION_PATH: installed }, stdio: 'inherit', windowsHide: true });
            const timer = setTimeout(() => { child.kill(); reject(Object.assign(Error('Reload host timeout'), { runtimeMayBeActive: true })); }, 120000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('close', (code, signal) => {
                clearTimeout(timer);
                if (code !== 0 || signal) reject(Object.assign(Error(`Reload host exit ${code}/${signal}`), { runtimeMayBeActive: !!signal }));
                else resolve();
            });
        });
        const state = JSON.parse(fs.readFileSync(completed, 'utf8'));
        assert.equal(state.passed, true, state.error);
    };
    console.log(`Installed VSIX identity: ${JSON.stringify(identity)}`);
    let hostError;
    try {
        const result = options.reloadLifecycle ? await runReload() : await runDevelopmentTests({ ...options, extensionDevelopmentPath: driver,
            extensionTestsPath: entry,
            launchArgs: options.launchArgs.filter(arg => arg !== '--disable-extensions'),
            extensionTestsEnv: { ...options.extensionTestsEnv, NODE_PATH: '', LSDYNA_INSTALLED_EXTENSION_PATH: installed },
        });
        identity.status = 'passed';
        return result;
    } catch (error) {
        hostError = error;
        identity.status = 'failed';
        identity.error = String(error);
        throw error;
    } finally {
        try {
            identity.vscodeVersion = JSON.parse(fs.readFileSync(resultFile, 'utf8')).vscodeVersion;
            fs.writeFileSync(resultFile, JSON.stringify(identity, null, 2));
        } catch (evidenceError) {
            console.error(`Installed host diagnostics could not be saved: ${resultFile}`, evidenceError);
            if (hostError) hostError.evidenceError = evidenceError;
            throw Object.assign(hostError || evidenceError, { evidenceSaveFailed: true });
        }
    }
}
module.exports = { runTests, resolveCliEntry, resolveExecutable };
