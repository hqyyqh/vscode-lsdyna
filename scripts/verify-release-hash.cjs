'use strict';
const fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const file = process.argv[2];
const report = JSON.parse(fs.readFileSync(file + '.identity.json'));
assert.equal(report.complete, true, 'Release stage identity verification did not pass');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), report.vsixSha256,
    'The VSIX changed after validation');
const parity = JSON.parse(fs.readFileSync(file + '.data-equivalence.json'));
assert.equal(parity.complete, true, 'Release data equivalence did not pass');
console.log(`Verified immutable release ${report.vsixSha256}`);
