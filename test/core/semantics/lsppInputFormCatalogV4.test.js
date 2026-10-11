'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const Module = require('node:module');
const {
    CatalogInputFormCatalogV4,
    getCatalogInputFormCatalogV4,
    resetCatalogInputFormCatalogV4ForTesting,
} = require("../../../out/core/semantics/catalogInputFormCatalogV4");

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const descriptorFixture = require('../../fixtures/public-behavior/synthetic-descriptor-identities.json').extent;
const makeTempDirectory = require('../../support/tempDirectories').trackTempDirectories();

function catalogFixture(formOverride) {
    const root = makeTempDirectory(path.join(os.tmpdir(), 'lspp-input-form-v4-'));
    const datasetSha256 = 'a'.repeat(64);
    const formRule = formOverride || {
        ruleId: 'lspp-native-input-form', cards: [{ cardIndex: 1, fields: [
            { name: 'FIT', choices: ['0.0', '1.0'] },
        ] }],
    };
    const shard = {
        schemaVersion: 4,
        kind: "keyword-input-form-shard",
        datasetSha256,
        keywords: {
            MAT_BARLAT_YLD2000: { formRuleIds: ['form'], fieldRuleIds: ['state'] },
            CONTROL_IMPLICIT_MODES: { formRuleIds: ['form'] },
            CONTACT_AUTOMATIC_SURFACE_TO_SURFACE: { formRuleIds: ['form'] },
            CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_MPP: {
                formRuleIds: ['form'], aliasOf: 'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            },
        },
        rules: { form: formRule, state: { ruleId: 'lspp-native-field-layout-states' } },
    };
    const decoded = Buffer.from(JSON.stringify(shard));
    const contentHash = digest(decoded);
    const encoded = zlib.gzipSync(decoded, { level: 9, mtime: 0 });
    const file = `${contentHash}.json.gz`;
    fs.writeFileSync(path.join(root, file), encoded);
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
        schemaVersion: 4,
        kind: "keyword-input-form-manifest",
        dataset: { sha256: datasetSha256, datasetVersion: "catalog-v1" },
        summary: { conservationSatisfied: true, unresolvedRelations: 0, safeWriteGaps: 0 },
        auditSha256: 'b'.repeat(64),
        shards: { [contentHash]: {
            file: `card_conditions.v4/${file}`,
            sha256: digest(encoded),
            uncompressedSha256: contentHash,
            compressedBytes: encoded.length,
            uncompressedBytes: decoded.length,
        } },
        keywords: Object.fromEntries(Object.keys(shard.keywords).map(keyword =>
            [keyword, { shard: contentHash }])),
    }));
    return root;
}

describe("keyword catalog Input Form catalog v4", () => {
    it('reports missing or malformed alias data consistently and preserves custom-root aliases', async () => {
        const rootDir = catalogFixture();
        const aliasFile = path.join(rootDir, 'aliases.json');
        const catalog = new CatalogInputFormCatalogV4({ rootDir });
        const originalLoad = Module._load;
        const catalogFile = require.resolve("../../../out/core/semantics/catalogInputFormCatalogV4");
        Module._load = function (request, parent, isMain) {
            return originalLoad.call(this, parent?.filename === catalogFile &&
                request.endsWith('lspp-node-readers.json') ? aliasFile : request, parent, isMain);
        };
        try {
            for (const malformed of [false, true]) {
                if (malformed) fs.writeFileSync(aliasFile, '{');
                const expected = malformed ? SyntaxError : { code: 'MODULE_NOT_FOUND' };
                assert.throws(() => catalog.formForKeyword('SYNTHETIC_ALIAS'), expected);
                assert.throws(() => catalog.resolveFormForKeyword('UNKNOWN'), expected);
                await assert.rejects(catalog.prepareKeyword('SYNTHETIC_ALIAS'), expected);
                await assert.rejects(catalog.prepareKeyword('UNKNOWN'), expected);
                assert.ok(catalog.formForKeyword('MAT_BARLAT_YLD2000'), 'indexed forms do not require aliases');
                await catalog.prepareKeyword('MAT_BARLAT_YLD2000');
            }
            fs.writeFileSync(aliasFile, JSON.stringify({ bindings: {
                SYNTHETIC_ALIAS: { aliasOf: 'MAT_BARLAT_YLD2000' },
            } }));
            await catalog.prepareKeyword('*synthetic_alias');
            assert.deepEqual(catalog.formForKeyword('*synthetic_alias'), catalog.formForKeyword('MAT_BARLAT_YLD2000'));
            assert.equal(catalog.resolveFormForKeyword('UNKNOWN'), null);
            await catalog.prepareKeyword('UNKNOWN');
        } finally {
            Module._load = originalLoad;
            delete require.cache[aliasFile];
        }
    });

    it('coalesces async preparation and preserves the verified synchronous form', async () => {
        const rootDir = catalogFixture();
        let reads = 0;
        const catalog = new CatalogInputFormCatalogV4({ rootDir, readFile: file => { reads++; return fs.readFileSync(file); } });
        await Promise.all(Array.from({ length: 8 }, () => catalog.prepareKeyword('MAT_BARLAT_YLD2000')));
        assert.equal(reads, 2, 'one manifest and one shard');
        assert.deepStrictEqual(catalog.formForKeyword('MAT_BARLAT_YLD2000'),
            new CatalogInputFormCatalogV4({ rootDir }).formForKeyword('MAT_BARLAT_YLD2000'));
        await catalog.prepareKeyword('MAT_BARLAT_YLD2000');
        assert.equal(reads, 2);
    });
    it('prepares a shared shard once and preserves the synchronous form contract', async () => {
        const root = catalogFixture();
        let shardReads = 0;
        const catalog = new CatalogInputFormCatalogV4({ rootDir: root, readFile(file) {
            if (file.endsWith('.gz')) shardReads++;
            return fs.readFileSync(file);
        } });
        await Promise.all([catalog.prepareKeyword('MAT_BARLAT_YLD2000'), catalog.prepareKeyword('CONTROL_IMPLICIT_MODES')]);
        const form = catalog.formForKeyword('MAT_BARLAT_YLD2000');
        assert.equal(form.source.conservationSatisfied, true);
        assert.equal(form.keyword, 'MAT_BARLAT_YLD2000');
        assert.equal(shardReads, 1);
    });

    it('rejects corrupted bytes during asynchronous preparation without installing a form', async () => {
        const root = catalogFixture();
        const catalog = new CatalogInputFormCatalogV4({ rootDir: root });
        const shard = fs.readdirSync(root).find(name => name.endsWith('.gz'));
        fs.writeFileSync(path.join(root, shard), 'corrupt');
        await assert.rejects(catalog.prepareKeyword('MAT_BARLAT_YLD2000'), /integrity/);
        assert.throws(() => catalog.formForKeyword('MAT_BARLAT_YLD2000'), /integrity/);
    });

    it('keeps path, producer and content checks across both loading paths', async () => {
        for (const [change, expected] of [
            [(manifest, descriptor) => { descriptor.file = '../escaped.json.gz'; }, /path is unsafe/],
            [(manifest, descriptor) => { descriptor.sha256 = '0'.repeat(64); }, /integrity mismatch/],
            [(manifest, descriptor) => { descriptor.uncompressedBytes++; }, /content mismatch/],
            [(manifest) => { manifest.dataset.sha256 = 'c'.repeat(64); }, /payload is invalid/],
        ]) {
            const rootDir = catalogFixture();
            const manifestFile = path.join(rootDir, 'manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestFile));
            change(manifest, Object.values(manifest.shards)[0]);
            fs.writeFileSync(manifestFile, JSON.stringify(manifest));
            const catalog = new CatalogInputFormCatalogV4({ rootDir });
            assert.throws(() => catalog.formForKeyword('MAT_BARLAT_YLD2000'), expected);
            await assert.rejects(catalog.prepareKeyword('MAT_BARLAT_YLD2000'), expected);
        }
    });

    function extentRule() {
        return structuredClone(descriptorFixture);
    }

    it('shares the verified extent across consumers and retains the stored raw descriptors', () => {
        const raw = extentRule();
        const rootDir = catalogFixture(raw);
        const catalog = new CatalogInputFormCatalogV4({ rootDir });
        for (const keyword of ['MAT_BARLAT_YLD2000', 'CONTROL_IMPLICIT_MODES']) {
            const rule = catalog.formForKeyword(keyword).rules.form;
            assert.deepEqual(rule.cards.map(card => card.fields[0].name), ['CYCL']);
            assert.deepEqual(rule.initialSnapshot.cardOrder, [1]);
            assert.equal(rule.initialSnapshot.controls[0].enabled, false);
        }
        const shardFile = fs.readdirSync(rootDir).find(name => name.endsWith('.json.gz'));
        const stored = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(rootDir, shardFile))));
        assert.deepEqual(stored.rules.form, raw);
        assert.equal(stored.rules.form.cards.length, 2);
    });

    it('rejects stale sources, descriptor geometry and out-of-range snapshots instead of falling back', () => {
        for (const change of [
            rule => { rule.nativeDescriptorExtent.datasetSha256 = 'd'.repeat(64); },
            rule => { rule.nativeDescriptorExtent.cardCount = 3; },
            rule => { rule.cards[0].cardRecordId = rule.cards[1].cardRecordId; },
            rule => { rule.nativeDescriptorExtent.initialSnapshot.cardOrder = [1, 2]; },
            rule => { rule.nativeDescriptorExtent.initialSnapshot.controls[0].controlId = 'card-2-field-0'; },
            rule => { rule.nativeDescriptorExtent.initialSnapshot.controls = []; },
        ]) {
            const rule = extentRule();
            change(rule);
            const catalog = new CatalogInputFormCatalogV4({ rootDir: catalogFixture(rule) });
            assert.throws(() => catalog.formForKeyword('CONTROL_IMPLICIT_MODES'), /descriptor extent is invalid/);
        }
    });

    it('projects static records without claiming GUI state and retains the raw snapshot', () => {
        const raw = extentRule();
        raw.nativeDescriptorExtent.consumption = 'static-descriptor-records';
        delete raw.nativeDescriptorExtent.initialSnapshot;
        const before = structuredClone(raw);
        const rootDir = catalogFixture(raw);
        const catalog = new CatalogInputFormCatalogV4({ rootDir });
        const effective = catalog.formForKeyword('CONTROL_IMPLICIT_MODES').rules.form;
        assert.deepEqual(effective.cards.map(card => card.fields[0].name), ['CYCL']);
        assert.equal(Object.hasOwn(effective, 'initialSnapshot'), false);
        assert.equal(effective.cards[0].fields[0].help, 'Native help.');
        assert.deepEqual(raw, before);
        const shardFile = fs.readdirSync(rootDir).find(name => name.endsWith('.json.gz'));
        const stored = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(rootDir, shardFile))));
        assert.deepEqual(stored.rules.form, before);
        assert.throws(() => catalog.formForKeyword('MAT_BARLAT_YLD2000'), /conflicts with field state rules/);
    });

    it('rejects dynamic semantics and unknown modes in a static descriptor contract', () => {
        for (const change of [
            rule => { rule.states = [{ formSnapshot: { controls: [] } }]; },
            rule => { rule.domains = [{ field: 'GEOM' }]; },
            rule => { rule.recordSelection = { kind: 'native-record-selection' }; },
            rule => { rule.cards[1].when = { field: 'GEOM' }; },
            rule => { rule.cards[0].fields[0].when = { field: 'GEOM' }; },
            rule => { rule.nativeDescriptorExtent.consumption = 'unverified'; },
        ]) {
            const raw = extentRule();
            raw.nativeDescriptorExtent.consumption = 'static-descriptor-records';
            delete raw.nativeDescriptorExtent.initialSnapshot;
            change(raw);
            const catalog = new CatalogInputFormCatalogV4({ rootDir: catalogFixture(raw) });
            assert.throws(() => catalog.formForKeyword('CONTROL_IMPLICIT_MODES'), /descriptor extent is invalid/);
        }
    });

    it('requires exact field help coverage and preserves a verified missing description', () => {
        for (const fieldHelp of [undefined, [], [{ fieldRecordId: '0x9999', help: 'wrong' }],
            [{ fieldRecordId: descriptorFixture.nativeDescriptorExtent.fieldHelp[0].fieldRecordId, help: false }],
            [{ fieldRecordId: descriptorFixture.nativeDescriptorExtent.fieldHelp[0].fieldRecordId }],
            [{ fieldRecordId: descriptorFixture.nativeDescriptorExtent.fieldHelp[0].fieldRecordId, help: 'one' },
             { fieldRecordId: descriptorFixture.nativeDescriptorExtent.fieldHelp[0].fieldRecordId, help: 'duplicate' }]]) {
            const raw = extentRule();
            raw.nativeDescriptorExtent.consumption = 'static-descriptor-records';
            raw.nativeDescriptorExtent.fieldHelp = fieldHelp;
            const catalog = new CatalogInputFormCatalogV4({ rootDir: catalogFixture(raw) });
            assert.throws(() => catalog.formForKeyword('CONTROL_IMPLICIT_MODES'), /descriptor extent is invalid/);
        }
        const raw = extentRule();
        raw.cards[0].fields[0].help = 'stale';
        raw.nativeDescriptorExtent.consumption = 'static-descriptor-records';
        raw.nativeDescriptorExtent.fieldHelp[0].help = null;
        const catalog = new CatalogInputFormCatalogV4({ rootDir: catalogFixture(raw) });
        assert.equal(Object.hasOwn(catalog.formForKeyword('CONTROL_IMPLICIT_MODES').rules.form.cards[0].fields[0], 'help'), false);
        assert.equal(raw.cards[0].fields[0].help, 'stale');
    });

    it('loads category-qualified forms and native choices from verified shards', () => {
        const runtimeRoot = catalogFixture();
        const catalog = new CatalogInputFormCatalogV4({ rootDir: runtimeRoot });
        const summary = catalog.summary();
        assert.equal(summary.schemaVersion, 4);
        assert.equal(summary.keywordCount, 4);
        assert.equal(summary.shardCount, 1);
        assert.match(summary.datasetSha256, /^[a-f0-9]{64}$/);

        const form = catalog.formForKeyword('*MAT_BARLAT_YLD2000');
        assert.equal(form.keyword, 'MAT_BARLAT_YLD2000');
        const native = form.rules[form.reference.formRuleIds[0]];
        const fit = native.cards.flatMap(card => card.fields).find(field => field.name === 'FIT');
        assert.deepEqual(fit.choices, ['0.0', '1.0']);
        assert.ok(form.reference.fieldRuleIds.length > 0);
        assert.ok(catalog.formForKeyword('*CONTROL_IMPLICIT_MODES'));
        assert.equal(catalog.formForKeyword('*IMPLICIT_MODES'), null);
    });

    it('isolates returned references and nested rules from a shared shard cache', async () => {
        for (const prepare of [false, true]) {
            const catalog = new CatalogInputFormCatalogV4({ rootDir: catalogFixture() });
            if (prepare) await catalog.prepareKeyword('MAT_BARLAT_YLD2000');
            const first = catalog.formForKeyword('MAT_BARLAT_YLD2000');
            first.reference.formRuleIds.push('consumer-only');
            first.rules.form.cards[0].fields[0].name = 'CHANGED';
            first.rules.form.cards[0].fields[0].choices.push('consumer-only');
            for (const keyword of ['MAT_BARLAT_YLD2000', 'CONTROL_IMPLICIT_MODES']) {
                const next = catalog.resolveFormForKeyword(keyword);
                assert.deepEqual(next.reference.formRuleIds, ['form']);
                assert.equal(next.rules.form.cards[0].fields[0].name, 'FIT');
                assert.deepEqual(next.rules.form.cards[0].fields[0].choices, ['0.0', '1.0']);
            }
        }
    });

    it('preserves numeric value semantics in isolated warmed rules and aliases', async () => {
        const rootDir = catalogFixture({ ruleId: 'lspp-native-input-form', cards: [{ cardIndex: 1,
            fields: [{ name: 'FIT', choices: ['0.0', '1.0'], defaultValue: 'signed-zero', largeExponent: 'overflow' }] }] });
        const manifestPath = path.join(rootDir, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath));
        const descriptor = Object.values(manifest.shards)[0];
        // These valid JSON numbers must survive an isolated copy, including their sign/range.
        const decoded = Buffer.from(zlib.gunzipSync(fs.readFileSync(path.join(rootDir,
            descriptor.file.replace(/^card_conditions\.v4[\\/]/, '')))).toString('utf8')
            .replace('"signed-zero"', '-0').replace('"overflow"', '1e400'));
        const hash = digest(decoded), encoded = zlib.gzipSync(decoded), file = `${hash}.json.gz`;
        fs.writeFileSync(path.join(rootDir, file), encoded);
        manifest.shards = { [hash]: { file: `card_conditions.v4/${file}`, sha256: digest(encoded),
            uncompressedSha256: hash, compressedBytes: encoded.length, uncompressedBytes: decoded.length } };
        for (const index of Object.values(manifest.keywords)) index.shard = hash;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        for (const prepare of [false, true]) {
            const catalog = new CatalogInputFormCatalogV4({ rootDir });
            if (prepare) await catalog.prepareKeyword('MAT_BARLAT_YLD2000');
            const first = catalog.formForKeyword('MAT_BARLAT_YLD2000'), field = first.rules.form.cards[0].fields[0];
            assert.ok(Object.is(field.defaultValue, -0));
            assert.equal(field.largeExponent, Infinity);
            field.defaultValue = 0; field.largeExponent = 0;
            first.source.datasetSha256 = 'consumer-only';
            for (const keyword of ['MAT_BARLAT_YLD2000', 'CONTROL_IMPLICIT_MODES']) {
                const next = catalog.resolveFormForKeyword(keyword).rules.form.cards[0].fields[0];
                assert.ok(Object.is(next.defaultValue, -0));
                assert.equal(next.largeExponent, Infinity);
                assert.equal(catalog.formForKeyword(keyword).source.datasetSha256, 'a'.repeat(64));
            }
        }
    });

    it('resolves an EXE input-form state suffix without a keyword-specific case', () => {
        const runtimeRoot = catalogFixture();
        const catalog = new CatalogInputFormCatalogV4({ rootDir: runtimeRoot });
        assert.equal(
            catalog.resolveFormForKeyword('*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_MPP').keyword,
            'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_MPP',
        );
        assert.equal(catalog.resolveFormForKeyword('*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_UNKNOWN'), null);
    });

    it('fails closed when a compressed shard does not match the manifest', () => {
        const runtimeRoot = catalogFixture();
        const catalog = new CatalogInputFormCatalogV4({
            rootDir: runtimeRoot,
            readFile(filePath) {
                const value = fs.readFileSync(filePath);
                return filePath.endsWith('.json.gz') ? Buffer.concat([value, Buffer.from([0])]) : value;
            },
        });
        assert.throws(() => catalog.formForKeyword('*MAT_BARLAT_YLD2000'), /integrity mismatch/);
    });

    for (const [change, expected] of [
        [manifest => { delete manifest.auditSha256; }, /auditSha256 is missing or invalid/],
        [manifest => { manifest.auditSha256 = 'invalid'; }, /auditSha256 is missing or invalid/],
        [manifest => { manifest.summary.conservationSatisfied = false; }, /conservation and safe-write/],
        [manifest => { manifest.summary.unresolvedRelations = 1; }, /conservation and safe-write/],
        [manifest => { manifest.summary.safeWriteGaps = 1; }, /conservation and safe-write/],
    ]) {
        it(`reports the failed manifest gate before reading any shard: ${change}`, () => {
            const runtimeRoot = catalogFixture();
            const manifestPath = path.join(runtimeRoot, 'manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            change(manifest);
            fs.writeFileSync(manifestPath, JSON.stringify(manifest));
            const catalog = new CatalogInputFormCatalogV4({
                rootDir: runtimeRoot,
                readFile(filePath) {
                    assert.equal(filePath, manifestPath, 'an invalid manifest must not load a shard');
                    return fs.readFileSync(filePath);
                },
            });
            assert.throws(() => catalog.formForKeyword('*MAT_BARLAT_YLD2000'), expected);
        });
    }

    it('permits loading manifest in unaudited diagnostic mode when allowUnaudited is true', () => {
        const runtimeRoot = catalogFixture();
        const manifestPath = path.join(runtimeRoot, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        delete manifest.auditSha256;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        const catalog = new CatalogInputFormCatalogV4({
            rootDir: runtimeRoot,
            allowUnaudited: true,
        });
        const form = catalog.formForKeyword('*MAT_BARLAT_YLD2000');
        assert.ok(form, 'form should be loaded in diagnostic mode');
        assert.equal(form.keyword, 'MAT_BARLAT_YLD2000');
        assert.equal(form.source.conservationSatisfied, false);
        assert.equal(form.source.isUnauditedDiagnostic, true);
    });

    it('permits loading manifest when DYNASENSE_ALLOW_UNAUDITED_CATALOG is 1', () => {
        const runtimeRoot = catalogFixture();
        const manifestPath = path.join(runtimeRoot, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        delete manifest.auditSha256;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        const previous = process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG;
        process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG = '1';
        try {
            const catalog = new CatalogInputFormCatalogV4({
                rootDir: runtimeRoot,
            });
            const form = catalog.formForKeyword('*MAT_BARLAT_YLD2000');
            assert.ok(form);
            assert.equal(form.source.isUnauditedDiagnostic, true);
        } finally {
            if (previous === undefined) delete process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG;
            else process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG = previous;
        }
    });

    it('reuses singleton instance when allowUnaudited option is unchanged', () => {
        resetCatalogInputFormCatalogV4ForTesting();
        try {
            const instance1 = getCatalogInputFormCatalogV4({ allowUnaudited: true });
            const instance2 = getCatalogInputFormCatalogV4({ allowUnaudited: true });
            assert.strictEqual(instance1, instance2, 'should return identical instance');

            const instance3 = getCatalogInputFormCatalogV4({ allowUnaudited: false });
            assert.notStrictEqual(instance1, instance3, 'should recreate instance when allowUnaudited changes');

            resetCatalogInputFormCatalogV4ForTesting();
            const instance4 = getCatalogInputFormCatalogV4({ allowUnaudited: false });
            assert.notStrictEqual(instance3, instance4, 'should create new instance after reset');
        } finally {
            resetCatalogInputFormCatalogV4ForTesting();
        }
    });
});
