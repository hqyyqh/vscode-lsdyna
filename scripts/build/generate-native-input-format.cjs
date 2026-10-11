'use strict';
// Public deterministic compiler; external collection and certification are separate.
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),zlib=require('node:zlib');

const sha=b=>crypto.createHash('sha256').update(b).digest('hex');

function compileConstrainedFormat(source) {
    assert.equal(source.schemaVersion, 1);
    assert.equal(source.sourceSha256, 'c90d0936a75f16ba3a60ebbaa329b56b5e3a6d8f37dca9a226096f9ada7d571a');
    assert.equal(source.consumerAddress, '0x140811090');
    assert.equal(source.allowlistAddress, '0x147f50a60');
    const bytes = Buffer.from(source.allowlistBytes, 'hex');
    assert.equal(bytes.length, 500);
    assert.equal(sha(bytes), 'dd4a124f25c3cd4d1cb6bbfb0cf850306b5eaae5d1f17938ab418540b4e23656');
    const allowed = new Set(Array.from({ length: 125 }, (_, index) => bytes.readUInt32LE(index * 4)));
    const bindings = {};
    for (const row of source.bindings) {
        assert.ok(row.keyword.startsWith('CONSTRAINED_') && !bindings[row.keyword]);
        const raw = Buffer.from(row.directoryBytes, 'hex');
        assert.equal(raw.length, 32);
        assert.equal(raw.readUInt32LE(0), row.fileCardCount);
        assert.equal(raw.readUInt32LE(4), row.nativeSubkind);
        assert.equal('0x' + raw.readBigUInt64LE(16).toString(16), row.cardArrayAddress);
        assert.equal(Number(row.typeDirectoryAddress) + 8, Number(row.nativeMapAddress));
        assert.equal(allowed.has(row.nativeSubkind), row.i10Preserved);
        bindings[row.keyword] = { cardArrayAddress: row.cardArrayAddress, nativeMapAddress: row.nativeMapAddress,
            nativeSubkind: row.nativeSubkind, slot: 12, i10Preserved: row.i10Preserved };
    }
    assert.equal(Object.keys(bindings).length, 111);
    return { sourceSha256: source.sourceSha256, bindings, evidence: source.evidence,
        scope: 'Exact CONSTRAINED file-directory identities and secondary I10 filter; does not certify card layout or writing.' };
}

module.exports = { compileConstrainedFormat };

// Validate the original binary source, then bind its result to the public checkpoint.
const rawCompile = module.exports.compileConstrainedFormat;
const publicFormat = require('../../keywords/runtime/native-readers/lspp-constrained-input-format.json');
const recordId = address => 'record:' + sha(address.toLowerCase().slice(0, -4)).slice(0, 24) + ':' + sha(address.toLowerCase()).slice(0, 24);
module.exports.compileConstrainedFormat = source => {
    const original = rawCompile(source);
    const bindings = Object.fromEntries(Object.entries(original.bindings).map(([keyword, row]) => [keyword, {
        cardSetId: recordId(row.cardArrayAddress), nativeMapAddress: recordId(row.nativeMapAddress),
        nativeSubkind: row.nativeSubkind, slot: row.slot, i10Preserved: row.i10Preserved,
    }]));
    assert.deepEqual(bindings, publicFormat.bindings, 'Public constrained bindings differ from verified binary source');
    return structuredClone(publicFormat);
};
