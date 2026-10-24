'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function testBatches(root) {
    const batches = new Map();
    for (const file of [...fs.globSync('test/**/*.test.js', { cwd: root })].sort()) {
        if (/^test[/\\]scripts[/\\]native[/\\]/.test(file)) continue;
        const directory = path.dirname(file);
        if (!batches.has(directory)) batches.set(directory, []);
        batches.get(directory).push(file);
    }
    return [...batches.values()];
}

function run(root, args, spawn = spawnSync) {
    const batches = testBatches(root);
    if (!batches.length) throw Error('No unit test files found');
    // Release retained source archives and module state between test directories.
    for (const files of batches) {
        console.log(`Unit tests: ${path.dirname(files[0])} (${files.length} files)`);
        const result = spawn(process.execPath, [require.resolve('mocha/bin/mocha.js'),
            '--require', 'test/support/register-out.js', ...files, ...args],
        { cwd: root, stdio: 'inherit', windowsHide: true });
        if (result.error) throw result.error;
        if (result.status !== 0) return result.status || 1;
    }
    return 0;
}

if (require.main === module) process.exitCode = run(path.resolve(__dirname, '../..'), process.argv.slice(2));
module.exports = { testBatches, run };
