'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const {
    buildFieldSchemaRuntime,
    encodeRuntime,
} = require("../../../scripts/build/generate-field-schema-runtime.cjs");
const {
    getRenderedCards,
    lookupKeywordSchema,
} = require("../../../src/core/keywordSchema");

function geometry(cards) {
    return cards.map(card => card.map(field => ({
        n: field.n,
        p: field.p,
        w: field.w,
        t: field.t,
    })));
}

function collectHelpIndexes(value, indexes = []) {
    if (Array.isArray(value)) {
        value.forEach(child => collectHelpIndexes(child, indexes));
    } else if (value && typeof value === 'object') {
        assert.equal(Object.prototype.hasOwnProperty.call(value, 'h'), false);
        if (Number.isSafeInteger(value.hi)) indexes.push(value.hi);
        Object.values(value).forEach(child => collectHelpIndexes(child, indexes));
    }
    return indexes;
}

describe('generate-field-schema-runtime', () => {
    it('separates help text while preserving layout, values, references, and identity roles', () => {
        const source = JSON.stringify({
            SAMPLE: {
                c: [[
                    { n: 'SID', p: 0, w: 10, t: 'integer', h: 'Unique identification number.', d: 7 },
                    { n: 'LCID', p: 10, w: 10, t: 'integer', h: 'Load curve ID defined in *DEFINE_CURVE.', ref: { targetKinds: ['curve'] } },
                ]],
            },
        });
        const first = buildFieldSchemaRuntime(source);
        const second = buildFieldSchemaRuntime(source);

        assert.deepEqual(first, second);
        assert.deepEqual(first.helpRuntime.values, [
            'Unique identification number.',
            'Load curve ID defined in *DEFINE_CURVE.',
        ]);
        assert.deepEqual(first.schemaRuntime.schema.SAMPLE.c[0], [
            { n: 'SID', p: 0, w: 10, t: 'integer', d: 7, hi: 0, di: 'self' },
            { n: 'LCID', p: 10, w: 10, t: 'integer', ref: { targetKinds: ['curve'] }, hi: 1, di: 'reference' },
        ]);
        assert.deepEqual(encodeRuntime(first.schemaRuntime), encodeRuntime(second.schemaRuntime));
        assert.deepEqual(encodeRuntime(first.helpRuntime), encodeRuntime(second.helpRuntime));
    });

    it('packages the complete source-locked schema without help text or the authoring JSON', () => {
        const repoRoot = path.resolve(__dirname, "../../..");
        const source = fs.readFileSync(path.join(repoRoot, "keywords/runtime/schema/field_data.json"));
        const fullSchema = JSON.parse(source.toString('utf8'));
        const schemaEncoded = fs.readFileSync(path.join(repoRoot, 'out', 'runtime', 'field_schema.runtime.json.gz'));
        const schemaRuntime = JSON.parse(zlib.gunzipSync(schemaEncoded).toString('utf8'));
        const sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');

        assert.equal(schemaRuntime.formatVersion, 1);
        assert.equal(schemaRuntime.baseSha256, sourceSha256);
        assert.equal(schemaRuntime.keywordCount, Object.keys(fullSchema).length);
        assert.ok(schemaRuntime.keywordCount > 5_000);
        assert.ok(schemaRuntime.helpSlotCount > 100_000);
        assert.ok(schemaEncoded.length < 1024 * 1024, `schema runtime is ${schemaEncoded.length} bytes`);
        assert.deepEqual(
            collectHelpIndexes(schemaRuntime.schema),
            Array.from({ length: schemaRuntime.helpSlotCount }, (_value, index) => index),
        );

        for (const keyword of [
            'PART',
            'MAT_001_TITLE',
            'CONTACT_AUTOMATIC_SINGLE_SURFACE',
            'DEFINE_CURVE_TITLE',
            'NODE',
            'PARAMETER_LOCAL',
        ]) {
            const compactLookup = lookupKeywordSchema(keyword, schemaRuntime.schema);
            const fullLookup = lookupKeywordSchema(keyword, fullSchema);
            assert.equal(compactLookup?.canonicalName, fullLookup?.canonicalName, keyword);
            assert.deepEqual(
                geometry(getRenderedCards(compactLookup.entry, compactLookup.activeOptions, 8)),
                geometry(getRenderedCards(fullLookup.entry, fullLookup.activeOptions, 8)),
                keyword,
            );
        }
    });
});
