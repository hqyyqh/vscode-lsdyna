'use strict';
// Separate processes: neither candidate nor baseline can inherit the other's module/data cache.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const { releasePath, authoringPath } = require('./release-resource-paths.cjs');
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function snapshot(root, { functionalOnly = false } = {}) {
    root = fs.realpathSync(root);
    const released = fs.existsSync(path.join(root, 'out/runtime/catalog-input-form/manifest.json'));
    const resource = name => path.join(root, released ? releasePath(name) : name);
    const normalize = value => value;
    const Module = require('node:module'), resolve = Module._resolveFilename;
    Module._resolveFilename = function (...args) {
        const result = resolve.apply(this, args);
        if (path.isAbsolute(result)) assert.ok(!path.relative(root, result).startsWith('..'), `Package escaped: ${result}`);
        return result;
    };
    const { CatalogInputFormCatalogV4 } = require(resource("out/core/semantics/catalogInputFormCatalogV4.js"));
    const manifest = JSON.parse(fs.readFileSync(resource('out/runtime/lspp-input-form/manifest.json')));
    const catalog = new CatalogInputFormCatalogV4({ maximumCacheBytes: 512 * 1024 * 1024 });
    const forms = {};
    for (const keyword of Object.keys(manifest.keywords).sort()) {
        const form = catalog.formForKeyword(keyword);
        assert.ok(form, `Missing form ${keyword}`);
        forms[keyword] = digest(normalize(form));
    }
    assert.equal(catalog.formForKeyword('NOT_A_REAL_KEYWORD'), null);
    const { SemanticRuntimeCatalogV2 } = require(path.join(root, 'out/core/semantics/semanticRuntimeV2.js'));
    const semantics = new SemanticRuntimeCatalogV2(path.join(root, "keywords/runtime/semantic-v2"));
    const references = semantics.allReferenceRecords(), definitions = semantics.allDefinitionScanners(), options = semantics.allOptionGrammars();
    assert.ok(semantics.status().ready);
    const payloads = {};
    const visit = directory => {
        for (const item of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
            const physical = `${directory}/${item.name}`;
            const relative = released ? authoringPath(physical) : physical;
            if (relative.startsWith("keywords/runtime/input-form") || relative.startsWith('out/runtime/lspp-input-form') ||
                /^keywords\/runtime\/semantic-v2\/(authority-lock|build-report|proof-report)\.json$/.test(relative) ||
                relative === 'out/runtime/release-code.json') continue;
            if (item.isDirectory()) { visit(physical); continue; }
            if (!/\.json(\.(gz|br))?$/.test(relative)) continue;
            const bytes = fs.readFileSync(path.join(root, physical));
            const zlib = require('node:zlib');
            const raw = relative.endsWith('.gz') ? zlib.gunzipSync(bytes) : relative.endsWith('.br') ? zlib.brotliDecompressSync(bytes) : bytes;
            const value = JSON.parse(raw);
            if (relative === "keywords/runtime/references/field_reference_index.json" && value.lsppBlockedReferences?.file)
                value.lsppBlockedReferences.file = authoringPath(value.lsppBlockedReferences.file);
            if (relative === "keywords/runtime/categories/lspp_keyword_categories.runtime.json" && value.source) {
                // Audited non-consumer metadata only; category data and integrity identities remain compared.
                delete value.source.datasetVersion;
                delete value.source.datasetSha256;
            }
            if (relative === 'out/runtime/field_help/manifest.json') {
                delete value.storageCodec;
                for (const descriptor of [...value.shards, value.textIndex].filter(Boolean)) {
                    // Only codec-derived fields differ; slot ranges and source bindings remain identical.
                    descriptor.file = descriptor.file.replace(/\.br$/, '.gz'); delete descriptor.sha256; delete descriptor.compressedBytes;
                }
            }
            payloads[relative.replace(/\.br$/, '.gz')] = digest(value);
        }
    };
    if (!functionalOnly) { visit('keywords'); visit('out/runtime'); }
    return { forms, payloads, summary: normalize(catalog.summary()), references: digest(normalize(references)), definitions: digest(normalize(definitions)),
        options: digest(normalize(options)), counts: { keywords: Object.keys(forms).length, references: references.length,
            definitions: definitions.length, options: options.length,
            optionTargets: options.reduce((sum, item) => sum + (item.targets || []).length, 0) } };
}
function compare(baseline, candidate, report) {
    const results = [baseline, candidate].map(root => {
        const child = spawnSync(process.execPath, [__filename, '--snapshot', path.resolve(root)],
            { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, NODE_PATH: '' }, windowsHide: true });
        assert.equal(child.status, 0, child.stderr || child.error?.message);
        return JSON.parse(child.stdout);
    });
    assert.deepEqual(results[1], results[0], 'Packaged runtime behavior changed');
    const result = { complete: true, baseline: path.resolve(baseline), candidate: path.resolve(candidate), ...results[0].counts,
        functionalFingerprint: digest(results[0]) };
    fs.writeFileSync(report, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}
if (require.main === module) {
    if (process.argv[2] === '--snapshot') console.log(JSON.stringify(snapshot(process.argv[3])));
    else if (process.argv[2] === '--functional-snapshot') console.log(JSON.stringify(snapshot(process.argv[3], {
        functionalOnly: true })));
    else compare(...process.argv.slice(2));
}
module.exports = { canonical, compare, snapshot, digest };
