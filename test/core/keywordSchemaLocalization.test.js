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

    it('decodes the gzip artifact format', () => {
        const { delta } = fixture();
        const encoded = zlib.gzipSync(Buffer.from(JSON.stringify(delta)));
        assert.deepEqual(keywordSchema.decodeFieldHelpDelta(encoded), delta);
    });

    it('loads one shared English schema and attaches the generated Chinese overlay lazily', () => {
        const originalReadFileSync = fs.readFileSync;
        let englishReads = 0;
        let deltaReads = 0;
        fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
            const normalized = String(filePath).replace(/\\/g, '/');
            if (normalized.endsWith('/keywords/field_data.json')) englishReads++;
            if (normalized.endsWith('/out/runtime/field_help_zh.delta.json.gz')) deltaReads++;
            return originalReadFileSync.call(this, filePath, ...args);
        };

        try {
            const english = keywordSchema.loadKeywordSchema(() => 'en');
            assert.equal(englishReads, 1);
            assert.equal(deltaReads, 0);

            const chinese = keywordSchema.loadKeywordSchema(() => 'zh-cn');
            assert.strictEqual(chinese, english);
            assert.equal(englishReads, 1);
            assert.equal(deltaReads, 1);

            let translatedField = null;
            for (const entry of Object.values(chinese)) {
                for (const card of entry.c || []) {
                    translatedField = card.find(field => keywordSchema.getLocalizedFieldHelp(field));
                    if (translatedField) break;
                }
                if (translatedField) break;
            }
            assert.ok(translatedField, 'expected at least one translated base-card field');
            assert.ok(!/[\u3400-\u9fff]/.test(translatedField.h), 'English schema help must remain English');
            assert.ok(/[\u3400-\u9fff]/.test(keywordSchema.getLocalizedFieldHelp(translatedField)));
            assert.equal(keywordSchema.getFieldHelpLocalizationState().state, 'loaded');
        } finally {
            fs.readFileSync = originalReadFileSync;
        }
    });

    it('falls back to the English schema and warns once when the delta cannot be read', () => {
        const originalReadFileSync = fs.readFileSync;
        const originalWarn = console.warn;
        let warnings = 0;
        fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
            if (String(filePath).replace(/\\/g, '/').endsWith('/out/runtime/field_help_zh.delta.json.gz')) {
                throw new Error('fixture delta missing');
            }
            return originalReadFileSync.call(this, filePath, ...args);
        };
        console.warn = () => { warnings++; };

        try {
            const schema = keywordSchema.loadKeywordSchema(() => 'zh-cn');
            assert.ok(schema.DEMO || Object.keys(schema).length > 0);
            assert.equal(keywordSchema.getFieldHelpLocalizationState().state, 'unavailable');
            keywordSchema.loadKeywordSchema(() => 'zh-cn');
            assert.equal(warnings, 1);
        } finally {
            fs.readFileSync = originalReadFileSync;
            console.warn = originalWarn;
        }
    });
});
