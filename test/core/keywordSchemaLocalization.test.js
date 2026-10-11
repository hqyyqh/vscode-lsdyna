'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const keywordSchema = require('../../src/core/keywordSchema');

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture() {
    const schema = {
        DEMO: {
            c: [[
                { n: 'ID', h: 'Identifier.' },
                { n: 'VALUE', h: 'Real value.' },
            ]],
            v: { nested: [{ h: 'Nested help.' }] },
        },
    };
    const baseText = JSON.stringify(schema);
    return {
        schema,
        baseSha256: sha256(Buffer.from(baseText)),
        delta: {
            formatVersion: 1,
            baseSha256: sha256(Buffer.from(baseText)),
            sourceLocalizedSha256: 'a'.repeat(64),
            helpSlotCount: 3,
            localizedCount: 2,
            values: ['标识符。', null, '嵌套说明。'],
        },
    };
}

describe('keyword schema field-help localization', () => {
    afterEach(() => keywordSchema.resetKeywordSchemaCache());

    it('rejects array runtime and authoring roots without poisoning the cache', () => {
        keywordSchema.resetKeywordSchemaCache();
        const originalRead = fs.readFileSync;
        let authoring = '[{"c":[]}]';
        fs.readFileSync = function (filePath, ...args) {
            const normalized = String(filePath).replace(/\\/g, '/');
            if (normalized.endsWith('/out/runtime/field_schema.runtime.json.gz')) {
                return zlib.gzipSync(JSON.stringify({ formatVersion: 1, baseSha256: 'a'.repeat(64),
                    keywordCount: 1, helpSlotCount: 0, schema: [{ c: [] }] }));
            }
            if (normalized.endsWith('/schema/field_data.json')) return authoring;
            return originalRead.call(this, filePath, ...args);
        };
        try {
            assert.throws(() => keywordSchema.loadKeywordSchema(), /invalid field schema source/);
            authoring = '{"DEMO":{"c":[[{"n":"ID","p":0,"w":10,"h":"Identifier."}]]}}';
            const schema = keywordSchema.loadKeywordSchema();
            assert.ok(!Array.isArray(schema));
            assert.equal(schema.DEMO.c[0][0].h, 'Identifier.');
        } finally { fs.readFileSync = originalRead; }
    });

    it('maps an exact ordinal delta without changing English field help', () => {
        const { schema, baseSha256, delta } = fixture();
        const idField = schema.DEMO.c[0][0];
        const valueField = schema.DEMO.c[0][1];
        const nested = schema.DEMO.v.nested[0];

        const result = keywordSchema.buildLocalizedHelpCache(schema, baseSha256, delta);

        assert.equal(idField.h, 'Identifier.');
        assert.equal(result.cache.get(idField), '标识符。');
        assert.equal(result.cache.get(valueField), undefined);
        assert.equal(result.cache.get(nested), '嵌套说明。');
        assert.equal(result.helpSlotCount, 3);
        assert.equal(result.localizedCount, 2);
    });

    it('keeps sparse delta slots out of the localized cache', () => {
        const { schema, baseSha256, delta } = fixture();
        delta.values = new Array(3);
        delta.values[0] = '标识符。';
        delta.localizedCount = 1;
        const result = keywordSchema.buildLocalizedHelpCache(schema, baseSha256, delta);
        assert.equal(result.cache.get(schema.DEMO.c[0][0]), '标识符。');
        assert.equal(result.cache.has(schema.DEMO.c[0][1]), false);
        assert.equal(result.cache.has(schema.DEMO.v.nested[0]), false);
        assert.equal(result.helpSlotCount, 3);
        assert.equal(result.localizedCount, 1);
    });

    it('keeps applicability conditions on CRVOPT and IDRFLG in the generated help', () => {
        const schema = keywordSchema.loadKeywordSchema();
        const { selectFieldHelp } = require('../../src/core/hover/fieldHelpPresentation');
        for (const [field, english, localized] of [
            [schema.BOUNDARY_ACOUSTIC_NON_REFLECTING.c[0][4], 'Coordinate Yc for CRVOPT = 2.', 'CRVOPT = 2 时的 Yc 坐标。'],
            [schema.CONTROL_DYNAMIC_RELAXATION.c[3][0], 'Part set ID for IDRFLG = 2.', 'IDRFLG = 2 时的部件集 ID。'],
        ]) {
            assert.equal(keywordSchema.getEnglishFieldHelp(field), english);
            assert.equal(keywordSchema.getLocalizedFieldHelp(field), localized);
            assert.deepEqual(selectFieldHelp(english, localized, 'en'), { primary: english, secondary: null });
            assert.deepEqual(selectFieldHelp(english, localized, 'zh-cn'), { primary: localized, secondary: english });
        }
    });

    it('rejects base, slot, value, and localized-count mismatches atomically', () => {
        const { schema, baseSha256, delta } = fixture();
        assert.throws(
            () => keywordSchema.buildLocalizedHelpCache(schema, 'b'.repeat(64), delta),
            /base hash/
        );
        assert.throws(
            () => keywordSchema.buildLocalizedHelpCache(schema, baseSha256, { ...delta, helpSlotCount: 2 }),
            /slot count/
        );
        assert.throws(
            () => keywordSchema.buildLocalizedHelpCache(schema, baseSha256, { ...delta, values: ['中文', '', null] }),
            /invalid localized value/
        );
        assert.throws(
            () => keywordSchema.buildLocalizedHelpCache(schema, baseSha256, { ...delta, localizedCount: 1 }),
            /localized count/
        );
    });

    it('preserves source key order when a parent help slot follows a nested child', () => {
        const schema = {
            DEMO: {
                nested: {
                    child: { h: 'Child help.' },
                    h: 'Parent help.',
                },
            },
        };
        const baseText = JSON.stringify(schema);
        const result = keywordSchema.buildLocalizedHelpCache(
            schema,
            sha256(Buffer.from(baseText)),
            {
                formatVersion: 1,
                baseSha256: sha256(Buffer.from(baseText)),
                sourceLocalizedSha256: 'c'.repeat(64),
                helpSlotCount: 2,
                localizedCount: 2,
                values: ['子项说明。', '父项说明。'],
            },
        );
        assert.equal(result.cache.get(schema.DEMO.nested.child), '子项说明。');
        assert.equal(result.cache.get(schema.DEMO.nested), '父项说明。');
    });

    it('decodes the gzip artifact format', () => {
        const { delta } = fixture();
        const encoded = zlib.gzipSync(Buffer.from(JSON.stringify(delta)));
        assert.deepEqual(keywordSchema.decodeFieldHelpDelta(encoded), delta);
    });

    it('loads one compact schema and only the requested shared help shard', () => {
        const originalReadFileSync = fs.readFileSync;
        let schemaReads = 0;
        let manifestReads = 0;
        let shardReads = 0;
        fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
            const normalized = String(filePath).replace(/\\/g, '/');
            if (normalized.endsWith('/out/runtime/field_schema.runtime.json.gz')) schemaReads++;
            if (normalized.endsWith('/out/runtime/field_help/manifest.json')) manifestReads++;
            if (/\/out\/runtime\/field_help\/shards\/\d{4}\.json\.gz$/.test(normalized)) shardReads++;
            return originalReadFileSync.call(this, filePath, ...args);
        };

        try {
            const english = keywordSchema.loadKeywordSchema(() => 'en');
            assert.equal(schemaReads, 1);
            assert.equal(manifestReads, 0);
            assert.equal(shardReads, 0);

            const chinese = keywordSchema.loadKeywordSchema(() => 'zh-cn');
            assert.strictEqual(chinese, english);
            assert.equal(schemaReads, 1);
            assert.equal(manifestReads, 0);
            assert.equal(shardReads, 0);
            assert.equal(keywordSchema.getFieldHelpLocalizationState().state, 'unloaded');

            const translatedField = chinese.MAT_001.c[0][0];
            assert.ok(keywordSchema.getLocalizedFieldHelp(translatedField));
            assert.equal(manifestReads, 1);
            assert.equal(shardReads, 1);
            const englishHelp = keywordSchema.getEnglishFieldHelp(translatedField);
            assert.ok(englishHelp);
            assert.ok(!/[\u3400-\u9fff]/.test(englishHelp), 'English help runtime must remain English');
            assert.ok(/[\u3400-\u9fff]/.test(keywordSchema.getLocalizedFieldHelp(translatedField)));
            assert.equal(manifestReads, 1);
            assert.equal(shardReads, 1, 'English and localized help must share one cached shard');
            assert.equal(keywordSchema.getFieldHelpLocalizationState().state, 'loaded');
        } finally {
            fs.readFileSync = originalReadFileSync;
        }
    });

    it('keeps schema access available and warns once when the shard manifest cannot be read', () => {
        const originalReadFileSync = fs.readFileSync;
        const originalWarn = console.warn;
        let warnings = 0;
        fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
            if (String(filePath).replace(/\\/g, '/').endsWith('/out/runtime/field_help/manifest.json')) {
                throw new Error('fixture manifest missing');
            }
            return originalReadFileSync.call(this, filePath, ...args);
        };
        console.warn = () => { warnings++; };

        try {
            const schema = keywordSchema.loadKeywordSchema(() => 'zh-cn');
            assert.ok(Object.keys(schema).length > 0);
            assert.equal(keywordSchema.getFieldHelpLocalizationState().state, 'unloaded');
            const field = schema.MAT_001.c[0][0];
            assert.equal(keywordSchema.getLocalizedFieldHelp(field), null);
            assert.equal(keywordSchema.getFieldHelpLocalizationState().state, 'unavailable');
            assert.equal(keywordSchema.getLocalizedFieldHelp(field), null);
            assert.equal(warnings, 1);
        } finally {
            fs.readFileSync = originalReadFileSync;
            console.warn = originalWarn;
        }
    });

    it('rejects a shard whose compressed identity differs and does not retry it', () => {
        const originalReadFileSync = fs.readFileSync;
        const originalWarn = console.warn;
        const schema = keywordSchema.loadKeywordSchema();
        const field = schema.MAT_001.c[0][0];
        const targetName = `${String(Math.floor(field.hi / 2048)).padStart(4, '0')}.json.gz`;
        let shardReads = 0;
        let warnings = 0;
        fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
            const value = originalReadFileSync.call(this, filePath, ...args);
            const normalized = String(filePath).replace(/\\/g, '/');
            if (normalized.endsWith(`/out/runtime/field_help/shards/${targetName}`)) {
                shardReads++;
                const corrupted = Buffer.from(value);
                corrupted[corrupted.length - 1] ^= 0xff;
                return corrupted;
            }
            return value;
        };
        console.warn = () => { warnings++; };

        try {
            assert.equal(keywordSchema.getEnglishFieldHelp(field), null);
            assert.equal(keywordSchema.getEnglishFieldHelp(field), null);
            assert.equal(shardReads, 1);
            assert.equal(warnings, 1);
            assert.equal(keywordSchema.getFieldHelpLocalizationState().state, 'unavailable');
        } finally {
            fs.readFileSync = originalReadFileSync;
            console.warn = originalWarn;
        }
    });

    it('bounds retained help shards with an LRU and reuses a recent shard', () => {
        const schema = keywordSchema.loadKeywordSchema();
        const targets = new Map();
        function visit(value) {
            if (Array.isArray(value)) {
                value.forEach(visit);
                return;
            }
            if (!value || typeof value !== 'object') return;
            if (Number.isSafeInteger(value.hi)) {
                const shard = Math.floor(value.hi / 2048);
                if (shard <= 9 && !targets.has(shard)) targets.set(shard, value);
            }
            Object.values(value).forEach(visit);
        }
        visit(schema);
        assert.equal(targets.size, 10);

        const originalReadFileSync = fs.readFileSync;
        const reads = new Map();
        fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
            const normalized = String(filePath).replace(/\\/g, '/');
            const match = normalized.match(/\/field_help\/shards\/(\d{4})\.json\.gz$/);
            if (match) reads.set(match[1], (reads.get(match[1]) || 0) + 1);
            return originalReadFileSync.call(this, filePath, ...args);
        };

        try {
            assert.ok(keywordSchema.getEnglishFieldHelp(targets.get(0)));
            assert.ok(keywordSchema.getEnglishFieldHelp(targets.get(1)));
            assert.ok(keywordSchema.getEnglishFieldHelp(targets.get(0)));
            assert.equal([...reads.values()].reduce((sum, value) => sum + value, 0), 2);
            for (let shard = 2; shard <= 9; shard++) {
                assert.ok(keywordSchema.getEnglishFieldHelp(targets.get(shard)));
            }
            assert.ok(keywordSchema.getEnglishFieldHelp(targets.get(0)));
            assert.equal(reads.get('0000'), 2, 'oldest shard must be evicted and read again');
        } finally {
            fs.readFileSync = originalReadFileSync;
        }
    });
});
