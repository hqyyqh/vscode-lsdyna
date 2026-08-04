'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const {
    FORMAT_VERSION,
    buildFieldHelpDelta,
    encodeFieldHelpDelta,
    generateFieldHelpDelta,
} = require('../../scripts/generate-field-help-zh-delta.cjs');

function fixture() {
    const english = {
        DEMO: {
            c: [[
                { n: 'ID', p: 0, w: 10, h: 'Identifier.', t: 'integer' },
                { n: 'VALUE', p: 10, w: 10, h: 'Real value.', t: 'real' },
            ]],
            o: [{ n: 'OPTION', co: 'post/0', c: [[{ n: 'FLAG', h: 'Flag.' }]] }],
            v: { nested: [{ h: 'Nested help.' }] },
        },
    };
    const localized = JSON.parse(JSON.stringify(english));
    localized.DEMO.c[0][0].h = 'Identifier.\n标识符。';
    localized.DEMO.o[0].c[0][0].h = 'Flag.\n标志。';
    localized.DEMO.v.nested[0].h = 'Nested help.\n嵌套说明。';
    return { english, localized };
}

describe('field-help Chinese delta generator', () => {
    it('stores only Chinese suffixes while preserving every recursive help slot', () => {
        const { english, localized } = fixture();
        const delta = buildFieldHelpDelta(JSON.stringify(english), JSON.stringify(localized));

        assert.equal(delta.formatVersion, FORMAT_VERSION);
        assert.equal(delta.helpSlotCount, 4);
        assert.equal(delta.localizedCount, 3);
        assert.deepEqual(delta.values, ['标识符。', null, '标志。', '嵌套说明。']);
        assert.match(delta.baseSha256, /^[a-f0-9]{64}$/);
        assert.match(delta.sourceLocalizedSha256, /^[a-f0-9]{64}$/);
    });

    it('rejects localized-only help, stale prefixes, and structural drift', () => {
        const { english, localized } = fixture();
        localized.DEMO.c[0][0].h = '仅中文。';
        assert.throws(
            () => buildFieldHelpDelta(JSON.stringify(english), JSON.stringify(localized)),
            /exact English prefix/
        );

        const second = fixture();
        second.localized.DEMO.c[0][0].h = 'Old identifier.\n标识符。';
        assert.throws(
            () => buildFieldHelpDelta(JSON.stringify(second.english), JSON.stringify(second.localized)),
            /exact English prefix/
        );

        const third = fixture();
        third.localized.DEMO.c[0][0].w = 20;
        assert.throws(
            () => buildFieldHelpDelta(JSON.stringify(third.english), JSON.stringify(third.localized)),
            /structural value differs/
        );
    });

    it('rejects key-order drift so ordinal decoding stays deterministic', () => {
        const { english, localized } = fixture();
        localized.DEMO.c[0][0] = {
            h: localized.DEMO.c[0][0].h,
            n: 'ID',
            p: 0,
            w: 10,
            t: 'integer',
        };
        assert.throws(
            () => buildFieldHelpDelta(JSON.stringify(english), JSON.stringify(localized)),
            /keys or key order differ/
        );
    });

    it('produces deterministic gzip bytes', () => {
        const { english, localized } = fixture();
        const delta = buildFieldHelpDelta(JSON.stringify(english), JSON.stringify(localized));
        const first = encodeFieldHelpDelta(delta);
        const second = encodeFieldHelpDelta(delta);

        assert.deepEqual(first, second);
        assert.deepEqual(JSON.parse(zlib.gunzipSync(first)), delta);
    });

    it('writes the generated artifact without modifying either source file', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-field-help-delta-'));
        const englishPath = path.join(tempRoot, 'field_data.json');
        const localizedPath = path.join(tempRoot, 'field_data_zh.json');
        const outputPath = path.join(tempRoot, 'out', 'field_help_zh.delta.json.gz');
        const { english, localized } = fixture();
        const englishText = JSON.stringify(english);
        const localizedText = JSON.stringify(localized);
        fs.writeFileSync(englishPath, englishText);
        fs.writeFileSync(localizedPath, localizedText);

        try {
            const result = generateFieldHelpDelta({ englishPath, localizedPath, outputPath });
            assert.ok(fs.existsSync(outputPath));
            assert.equal(fs.readFileSync(englishPath, 'utf8'), englishText);
            assert.equal(fs.readFileSync(localizedPath, 'utf8'), localizedText);
            assert.equal(result.delta.localizedCount, 3);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
