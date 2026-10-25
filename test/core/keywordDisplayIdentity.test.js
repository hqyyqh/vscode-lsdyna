'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const path = require('path');
const {
    createKeywordIdentityAccumulatorFactory,
    createKeywordIdentityAccumulator,
    summarizeKeywordIdentity,
} = require('../../src/core/keywordDisplayIdentity');

describe('keyword display identity', () => {
    it('reuses the prepared field schema without rereading the layout runtime', () => {
        const schema = require('../../src/core/keywordSchema').loadKeywordSchema();
        const fs = require('fs'), originalRead = fs.readFileSync;
        fs.readFileSync = function (filePath, ...args) {
            assert.ok(!String(filePath).replace(/\\/g, '/').endsWith('/runtime/field_schema.runtime.json.gz'),
                'identity extraction must reuse the prepared schema');
            return originalRead.call(this, filePath, ...args);
        };
        try {
            assert.strictEqual(require('../../src/core/keywordDisplayIdentity').loadKeywordLayoutSchema(), schema);
            const result = summarizeKeywordIdentity('PART', ['Front Rail', '      1201        12        24']);
            assert.deepEqual(result.identity, { field: 'PID', value: '1201' });
        } finally { fs.readFileSync = originalRead; }
    });
    it('rejects an array layout runtime and uses the existing source fallback', function () {
        this.timeout(20000); // Starts a fresh process and parses the complete source fallback.
        const repoRoot = path.resolve(__dirname, '..', '..');
        const child = childProcess.spawnSync(process.execPath, ['-e', String.raw`
            const fs = require('fs'), zlib = require('zlib');
            const originalRead = fs.readFileSync;
            fs.readFileSync = function (filePath, ...args) {
                if (String(filePath).replace(/\\/g, '/').endsWith('/runtime/field_schema.runtime.json.gz')) {
                    return zlib.gzipSync(JSON.stringify({ formatVersion: 1, baseSha256: 'a'.repeat(64),
                        keywordCount: 1, helpSlotCount: 0, schema: [{ c: [] }] }));
                }
                return originalRead.call(this, filePath, ...args);
            };
            const identity = require('./out/core/keywordDisplayIdentity');
            const schema = identity.loadKeywordLayoutSchema();
            process.stdout.write(JSON.stringify({ array: Array.isArray(schema), part: !!schema.PART,
                result: identity.summarizeKeywordIdentity('PART', ['Front Rail', '      1201        12        24']) }));
        `], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
        assert.equal(child.status, 0, child.stderr);
        const result = JSON.parse(child.stdout);
        assert.equal(result.array, false);
        assert.equal(result.part, true);
        assert.deepEqual(result.result.identity, { field: 'PID', value: '1201' });
    });
    it('clips UTF-8 prefixes at complete code points without borrowing later physical lines', () => {
        for (const character of ['汉', '😀']) {
            const accumulator = createKeywordIdentityAccumulator('INCLUDE', { maxBytes: 256 });
            assert.equal(accumulator.acceptLine(character.repeat(256)), true);
            assert.equal(accumulator.isCaptureComplete(), true);
            assert.equal(accumulator.acceptLine('later.k'), false);
            const prefix = character.repeat(Math.floor(256 / Buffer.byteLength(character)));
            assert.equal(accumulator.finish().path, prefix);
            assert.ok(Buffer.byteLength(prefix) <= 256);
            assert.ok(!accumulator.finish().path.includes('\uFFFD'));
        }
        const full = createKeywordIdentityAccumulatorFactory()({ keyword: 'INCLUDE' }, '*INCLUDE');
        assert.equal(full.acceptLine('汉'.repeat(3000)), true);
        assert.equal(full.isCaptureComplete(), true);
        assert.equal(full.acceptLine('later.k'), false);
        const filename = require.resolve('../../src/core/keywordDisplayIdentity');
        const readFromModule = require('node:module').createRequire(filename);
        const actualSchema = readFromModule('./keywordSchema');
        let observedLines;
        const context = { module: { exports: {} }, exports: {}, Buffer, console, __dirname: path.dirname(filename), require(name) {
            if (name === './keywordSchema') return { ...actualSchema, getRenderedCardsForLookup(...args) {
                observedLines = args[1];
                return actualSchema.getRenderedCardsForLookup(...args);
            } };
            return readFromModule(name);
        } };
        context.exports = context.module.exports;
        require('node:vm').runInNewContext(require('node:fs').readFileSync(filename, 'utf8'), context, { filename });
        const observed = context.module.exports.createKeywordIdentityAccumulatorFactory()({ keyword: 'INCLUDE' }, '*INCLUDE');
        observed.acceptLine(Buffer.from('汉'.repeat(3000)));
        observed.finish();
        assert.equal(Buffer.byteLength(observedLines.join('')), 8190);
        assert.ok(!observedLines.join('').includes('\uFFFD'));

        const remainder = createKeywordIdentityAccumulator('NODE', { maxBytes: 256 });
        assert.equal(remainder.acceptLine('a'.repeat(255)), true);
        assert.equal(remainder.acceptLine('汉'), false);
        assert.equal(remainder.isCaptureComplete(), true);
        assert.equal(remainder.acceptLine('b'), false);
    });
    it('never borrows FIT as MID when the fixed-width identity slot is blank', () => {
        const result = summarizeKeywordIdentity('MAT_BARLAT_YLD2000', [
            ''.padEnd(40) + '1.0'.padStart(10) + ''.padEnd(30),
        ]);
        assert.equal(result.identity, undefined);
        assert.deepEqual(result.missingIdentity, { field: 'MID', status: 'empty' });
    });
    it('combines human titles with authoritative engineering IDs', () => {
        const part = summarizeKeywordIdentity('PART', [
            'Front Bumper',
            '      1201        12        24',
        ]);
        assert.equal(part.kind, 'named');
        assert.equal(part.title, 'Front Bumper');
        assert.deepEqual(part.identity, { field: 'PID', value: '1201' });

        const material = summarizeKeywordIdentity('MAT_ELASTIC_TITLE', [
            'Steel 6061-T6',
            '        24   2.70E-9   70000.0       0.3',
        ]);
        assert.equal(material.canonicalKeyword, 'MAT_ELASTIC');
        assert.equal(material.title, 'Steel 6061-T6');
        assert.deepEqual(material.identity, { field: 'MID', value: '24' });
    });

    it('supports comma free format, raw parameter IDs, and title variants', () => {
        const curve = summarizeKeywordIdentity('DEFINE_CURVE_TITLE', [
            'Crash pulse',
            '&CURVE_ID,0,1.0,1.0,0.0,0.0',
        ]);
        assert.equal(curve.title, 'Crash pulse');
        assert.deepEqual(curve.identity, { field: 'LCID', value: '&CURVE_ID' });
    });

    it('does not mistake reference IDs for a block identity', () => {
        const schema = {
            CUSTOM_LOAD: {
                c: [[
                    { n: 'LCID', p: 0, w: 10, h: 'Load curve ID defined in *DEFINE_CURVE.' },
                    { n: 'SF', p: 10, w: 10, h: 'Scale factor.' },
                ]],
            },
        };
        const summary = summarizeKeywordIdentity('CUSTOM_LOAD', ['        37       1.0'], { schema });
        assert.equal(summary.kind, 'keyword');
        assert.equal(summary.identity, undefined);
    });

    it('stops capture at 32 lines while preserving the full collection count', () => {
        const accumulator = createKeywordIdentityAccumulator('NODE');
        for (let index = 0; index < 32; index++) {
            assert.equal(accumulator.isCaptureComplete(), false);
            assert.equal(accumulator.acceptLine(`${index + 1},0,0,0`), true);
        }
        assert.equal(accumulator.isCaptureComplete(), true);
        assert.equal(accumulator.acceptLine('33,0,0,0'), false);
        const summary = accumulator.finish({ dataLineCount: 100000 });
        assert.equal(summary.kind, 'collection');
        assert.deepEqual(summary.collection, { kind: 'data-lines', count: 100000 });
    });

    it('uses reviewed engineering signatures only when no entity identity exists', () => {
        const termination = summarizeKeywordIdentity('CONTROL_TERMINATION', ['      0.12']);
        assert.equal(termination.kind, 'signature');
        assert.deepEqual(termination.signature, [{ field: 'ENDTIM', value: '0.12' }]);
    });

    it('offsets explicit TITLE cards that are lost across schema alias redirects', () => {
        const nodeSet = summarizeKeywordIdentity('SET_NODE_TITLE', [
            'Crash interface nodes',
            '42,0,0,0,0,MECH',
            '1,2,3,4,5,6,7,8',
        ]);
        assert.equal(nodeSet.kind, 'named');
        assert.equal(nodeSet.title, 'Crash interface nodes');
        assert.deepEqual(nodeSet.identity, { field: 'SID', value: '42' });
    });

    it('keeps fixed long-format and percent-format IDs in their native column widths', () => {
        const longFactory = createKeywordIdentityAccumulatorFactory();
        longFactory({ keyword: 'KEYWORD' }, '*KEYWORD LONG=Y').finish();
        const longPart = longFactory({ keyword: 'PART' }, '*PART');
        longPart.acceptLine('Long-format bumper');
        longPart.acceptLine(`${'1201'.padStart(20)}${'12'.padStart(20)}${'24'.padStart(20)}`);
        assert.deepEqual(longPart.finish({ dataLineCount: 2 }).identity, { field: 'PID', value: '1201' });

        const percentPart = summarizeKeywordIdentity('PART%', [
            'Percent-format bumper',
            `${'1202'.padStart(10)}${'13'.padStart(10)}${'25'.padStart(10)}`,
        ], { longFormat: true, percentFormat: true });
        assert.deepEqual(percentPart.identity, { field: 'PID', value: '1202' });
    });

    it('uses the same variable-width format geometry as field editing for display identities', () => {
        // Full-width neighboring values expose a wrong slice; whitespace
        // fallback must not make an undersized slice appear to pass.
        const schema = { MAT_ELASTIC: { c: [[
            { n: 'MID', p: 0, w: 8, t: 1 }, { n: 'RO', p: 8, w: 16, t: 2 },
        ]] } };
        const percent = summarizeKeywordIdentity('MAT_ELASTIC', ['1234567890' + '0.125'.padStart(16)],
            { schema, percentFormat: true });
        assert.deepEqual(percent.identity, { field: 'MID', value: '1234567890' });
        const long = summarizeKeywordIdentity('MAT_ELASTIC', ['12345678901234567890' + '0.125'.padStart(20)],
            { schema, longFormat: true });
        assert.deepEqual(long.identity, { field: 'MID', value: '12345678901234567890' });
    });

    it('uses LONG=K as long input and LONG=S as standard input', () => {
        const longFactory = createKeywordIdentityAccumulatorFactory();
        longFactory({ keyword: 'KEYWORD' }, '*KEYWORD LONG=K').finish();
        const longPart = longFactory({ keyword: 'PART' }, '*PART');
        longPart.acceptLine('Long-format rail');
        longPart.acceptLine(`${'1203'.padStart(20)}${'14'.padStart(20)}${'26'.padStart(20)}`);
        assert.deepEqual(longPart.finish({ dataLineCount: 2 }).identity, { field: 'PID', value: '1203' });

        const overridePart = longFactory({ keyword: 'PART' }, '*PART -');
        overridePart.acceptLine('Keyword-standard rail');
        overridePart.acceptLine(`${'1204'.padStart(8)}${'15'.padStart(8)}${'27'.padStart(8)}`);
        assert.deepEqual(overridePart.finish({ dataLineCount: 2 }).identity, { field: 'PID', value: '1204' });

        longFactory({ keyword: 'KEYWORD' }, '*KEYWORD LONG=S').finish();
        const standardPart = longFactory({ keyword: 'PART' }, '*PART');
        standardPart.acceptLine('Standard-format rail');
        standardPart.acceptLine(`${'1205'.padStart(8)}${'16'.padStart(8)}${'28'.padStart(8)}`);
        assert.deepEqual(standardPart.finish({ dataLineCount: 2 }).identity, { field: 'PID', value: '1205' });
    });

    it('keeps include paths and unknown private cards explicit instead of inventing IDs', () => {
        const include = summarizeKeywordIdentity('INCLUDE', ['../submodels/front rail.k']);
        assert.equal(include.path, '../submodels/front rail.k');

        const custom = summarizeKeywordIdentity('ACME_PRIVATE_CARD', ['100,200,300']);
        assert.equal(custom.kind, 'keyword');
        assert.equal(custom.identity, undefined);
        assert.equal(custom.confidence, 'fallback');
    });

    it('keeps project identity scans independent from field-help manifests and shards', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const script = String.raw`
            const fs = require('fs');
            const originalRead = fs.readFileSync;
            const originalStat = fs.statSync;
            let helpAccesses = 0;
            function isHelp(filePath) {
                return String(filePath).replace(/\\/g, '/').includes('/out/runtime/field_help/');
            }
            fs.readFileSync = function (filePath, ...args) {
                if (isHelp(filePath)) { helpAccesses++; throw new Error('project scan touched field help'); }
                return originalRead.call(this, filePath, ...args);
            };
            fs.statSync = function (filePath, ...args) {
                if (isHelp(filePath)) { helpAccesses++; throw new Error('project scan touched field help'); }
                return originalStat.call(this, filePath, ...args);
            };
            const identity = require('./out/core/keywordDisplayIdentity');
            const result = identity.summarizeKeywordIdentity('PART', [
                'Front Rail',
                '      1201        12        24',
            ]);
            process.stdout.write(JSON.stringify({ helpAccesses, result }));
        `;
        const child = childProcess.spawnSync(process.execPath, ['-e', script], {
            cwd: repoRoot,
            encoding: 'utf8',
            windowsHide: true,
        });
        assert.equal(child.status, 0, child.stderr);
        const result = JSON.parse(child.stdout);
        assert.equal(result.helpAccesses, 0);
        assert.deepEqual(result.result.identity, { field: 'PID', value: '1201' });
    });
});
