'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), assert = require('node:assert/strict');
const root = path.resolve(process.argv[2]), report = process.argv[3];
const groups = ["keywords/runtime/input-form", "keywords/runtime/semantic-v2", "keywords/runtime/manual-semantics",
    "keywords/runtime/native-help", 'out/runtime/field_help'];
const p95 = values => [...values].sort((a,b) => a-b)[Math.ceil(values.length * .95)-1];
const results = [];
for (const group of groups) {
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory()
        ? walk(path.join(dir, item.name)) : item.name.endsWith('.json.gz') ? [path.join(dir, item.name)] : []);
    let gzipBytes = 0, brotliBytes = 0, largest;
    for (const file of walk(path.join(root, group))) {
        const raw = zlib.gunzipSync(fs.readFileSync(file));
        const gzip = zlib.gzipSync(raw, { level: 9 }), brotli = zlib.brotliCompressSync(raw,
            { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
        assert.deepEqual(zlib.brotliDecompressSync(brotli), raw);
        gzipBytes += zlib.deflateRawSync(gzip, { level: 9 }).length;
        brotliBytes += zlib.deflateRawSync(brotli, { level: 9 }).length;
        if (!largest || raw.length > largest.raw) largest = { raw: raw.length, gzip, brotli };
    }
    const timings = { gzip: [], brotli: [] };
    for (let iteration = 0; iteration < 120; iteration++) for (const codec of iteration % 2 ? ['brotli', 'gzip'] : ['gzip', 'brotli']) {
        const start = performance.now();
        JSON.parse((codec === 'gzip' ? zlib.gunzipSync(largest.gzip) : zlib.brotliDecompressSync(largest.brotli)).toString());
        timings[codec].push(performance.now() - start);
    }
    const before = p95(timings.gzip), after = p95(timings.brotli), saving = 1 - brotliBytes / gzipBytes;
    const result = { group, gzipBytes, brotliBytes, saving, gzipP95Ms: before, brotliP95Ms: after,
        eligibleForIntegration: saving >= .03 && after <= before + Math.max(before * .05, 20),
        note: 'Codec microbenchmark only; integration and host performance gates are still required' };
    results.push(result); console.log(JSON.stringify(result));
    fs.writeFileSync(report, JSON.stringify(results, null, 2));
}
