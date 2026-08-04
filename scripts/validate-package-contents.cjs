'use strict';

const childProcess = require('child_process');
const path = require('path');

const REQUIRED_FILES = [
    'package.json',
    'out/extension.js',
    'out/runtime/field_help_zh.delta.json.gz',
    'keywords/field_data.json',
    'keywords/field_reference_index.json',
    'out/core/theme/extensionTheme.js',
    'out/webview/manual-reader/index.html',
    'out/webview/manual-reader/manifest.json',
];
const FORBIDDEN_FILES = new Set([
    'DEVELOPMENT.md',
    'keywords/field_data_zh.json',
    'keywords/pydyna-source.json',
]);
const FORBIDDEN_PREFIXES = [
    '.artifacts/',
    '.github/',
    '.pytest_cache/',
    '.uv-cache/',
    'dist/',
    'docs/',
    'scripts/',
    'src/',
    'test/',
    'webview/',
    'keywords/tests/',
];

function validatePackageFiles(rawFiles) {
    const files = rawFiles.map(file => file.trim().replace(/\\/g, '/')).filter(Boolean);
    const fileSet = new Set(files);
    const errors = [];
    for (const required of REQUIRED_FILES) {
        if (!fileSet.has(required)) errors.push(`VSIX is missing required file: ${required}`);
    }
    if (!files.some(file => /^out\/webview\/manual-reader\/assets\/[^/]+\.js$/.test(file))) {
        errors.push('VSIX is missing the built manual-reader JavaScript asset');
    }
    if (!files.some(file => /^out\/webview\/manual-reader\/assets\/[^/]+\.css$/.test(file))) {
        errors.push('VSIX is missing the built manual-reader CSS asset');
    }
    for (const file of files) {
        if (FORBIDDEN_FILES.has(file) ||
            FORBIDDEN_PREFIXES.some(prefix => file.startsWith(prefix)) ||
            file.split('/').includes('__pycache__')) {
            errors.push(`VSIX contains forbidden authoring/process file: ${file}`);
        }
    }
    return errors.sort();
}

function listPackageFiles() {
    const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
    const result = childProcess.spawnSync(process.execPath, [vsce, 'ls'], {
        encoding: 'utf8',
        windowsHide: true,
    });
    if (result.status !== 0) {
        throw new Error(`vsce ls failed: ${result.error?.message || result.stderr || result.status}`);
    }
    return result.stdout.split(/\r?\n/);
}

if (require.main === module) {
    try {
        const files = listPackageFiles();
        const errors = validatePackageFiles(files);
        if (errors.length) {
            console.error(errors.join('\n'));
            process.exitCode = 1;
        } else {
            console.log(`VSIX content contract PASS (${files.filter(Boolean).length} files)`);
        }
    } catch (error) {
        console.error(error && error.stack ? error.stack : String(error));
        process.exitCode = 1;
    }
}

module.exports = {
    REQUIRED_FILES,
    validatePackageFiles,
};
