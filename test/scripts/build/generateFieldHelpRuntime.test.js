'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const {
    buildFieldHelpRuntime,
    generateFieldHelpRuntime,
} = require("../../../scripts/build/generate-field-help-runtime.cjs");
const {
    buildFieldSchemaRuntime,
} = require("../../../scripts/build/generate-field-schema-runtime.cjs");
const {
    buildFieldHelpDelta,
} = require("../../../scripts/build/generate-field-help-zh-delta.cjs");

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

describe('generate-field-help-runtime', () => {
    const createTempDirectory = require('../../support/tempDirectories').trackTempDirectories();
    function fixture() {
        const root = createTempDirectory(path.join(os.tmpdir(), 'field-help-publication-'));
        const english = { DEMO: { c: [[{ n: 'ID', h: 'Identifier.' }, { n: 'VALUE', h: 'Value.' }, { n: 'OTHER', h: 'Other.' }]] } };
        const englishPath = path.join(root, 'english.json'), localizedPath = path.join(root, 'localized.json');
        fs.writeFileSync(englishPath, JSON.stringify(english));
        fs.writeFileSync(localizedPath, JSON.stringify(english));
        const textTranslationsPath = path.join(root, 'translations.json');
        fs.writeFileSync(textTranslationsPath, '[]');
        const options = { englishPath, localizedPath, textTranslationsPath, shardSize: 2,
            manualSemanticsPath: path.join(root, 'absent.json'), outputDirectory: path.join(root, 'help') };
        generateFieldHelpRuntime(options);
        return options;
    }

    it('regenerates identical help without mutating any published file', () => {
        const options = fixture(), operations = [];
        const methods = ['writeFileSync', 'rmSync', 'renameSync'];
        const originals = Object.fromEntries(methods.map(method => [method, fs[method]]));
        const manifestPath = path.join(options.outputDirectory, 'manifest.json');
        const manifest = fs.readFileSync(manifestPath);
        const shards = JSON.parse(manifest).shards.map(entry => ({ path: path.join(options.outputDirectory, 'shards', entry.file),
            bytes: fs.readFileSync(path.join(options.outputDirectory, 'shards', entry.file)) }));
        try {
            for (const method of methods) fs[method] = (file, ...args) => {
                const result = originals[method](file, ...args);
                operations.push(method);
                assert.deepEqual(fs.readFileSync(manifestPath), manifest);
                for (const shard of shards) assert.deepEqual(fs.readFileSync(shard.path), shard.bytes);
                return result;
            };
            generateFieldHelpRuntime(options);
            assert.deepEqual(operations, []);
        } finally { for (const method of methods) fs[method] = originals[method]; }
    });

    it('refuses edited or unlisted stale shards and removes only owned unchanged shards', () => {
        const options = fixture(), directory = path.join(options.outputDirectory, 'shards');
        const manifestPath = path.join(options.outputDirectory, 'manifest.json'), manifest = fs.readFileSync(manifestPath);
        const stale = path.join(directory, '0001.json.gz'), original = fs.readFileSync(stale);
        fs.writeFileSync(stale, 'unreviewed');
        assert.throws(() => generateFieldHelpRuntime({ ...options, shardSize: 3 }), /edited obsolete help shard/);
        assert.deepEqual(fs.readFileSync(manifestPath), manifest);
        assert.equal(fs.readFileSync(stale, 'utf8'), 'unreviewed');
        fs.writeFileSync(stale, original);
        const unknown = path.join(directory, '9999.json.gz');
        fs.writeFileSync(unknown, 'unlisted');
        assert.throws(() => generateFieldHelpRuntime({ ...options, shardSize: 3 }), /Unlisted or edited obsolete help shard/);
        assert.deepEqual(fs.readFileSync(manifestPath), manifest);
        fs.rmSync(unknown);
        fs.writeFileSync(path.join(directory, 'notes.txt'), 'keep');
        const result = generateFieldHelpRuntime({ ...options, shardSize: 3 });
        assert.equal(result.manifest.shardCount, 1);
        assert.deepEqual(fs.readdirSync(directory).sort(), ['0000.json.gz', 'notes.txt']);
        assert.equal(fs.readFileSync(path.join(directory, 'notes.txt'), 'utf8'), 'keep');
    });

    it('restores the prior generation if publishing its manifest fails', () => {
        const options = fixture(), directory = options.outputDirectory;
        const paths = ['manifest.json', 'text-index.json.gz', 'shards/0000.json.gz', 'shards/0001.json.gz'];
        const previous = new Map(paths.map(file => [file, fs.readFileSync(path.join(directory, file))]));
        const failure = new Error('Controlled help manifest replacement');
        const rename = fs.renameSync;
        try {
            fs.renameSync = (from, destination) => {
                if (destination === path.join(directory, 'manifest.json') && path.basename(from) !== 'previous') throw failure;
                return rename(from, destination);
            };
            assert.throws(() => generateFieldHelpRuntime({ ...options, shardSize: 3 }), error => error === failure);
        } finally { fs.renameSync = rename; }
        for (const [file, bytes] of previous) assert.deepEqual(fs.readFileSync(path.join(directory, file)), bytes);
        assert.deepEqual(fs.readdirSync(directory).sort(), ['manifest.json', 'shards', 'text-index.json.gz']);
        assert.deepEqual(fs.readdirSync(path.join(directory, 'shards')).sort(), ['0000.json.gz', '0001.json.gz']);
    });

    it('builds deterministic contiguous shards containing aligned English and localized slots', () => {
        const english = {
            DEMO: {
                c: [[
                    { n: 'ID', h: 'Identifier.' },
                    { n: 'VALUE', h: 'Value.' },
                ]],
                v: { nested: [{ h: 'Nested help.' }] },
            },
        };
        const localized = JSON.parse(JSON.stringify(english));
        localized.DEMO.c[0][0].h = 'Identifier.\n标识符。';
        localized.DEMO.v.nested[0].h = 'Nested help.\n嵌套说明。';
        const englishText = JSON.stringify(english);
        const localizedText = JSON.stringify(localized);

        const first = buildFieldHelpRuntime(englishText, localizedText, 2);
        const second = buildFieldHelpRuntime(englishText, localizedText, 2);

        assert.deepEqual(first.manifest, second.manifest);
        assert.deepEqual(first.shards.map(shard => shard.encoded), second.shards.map(shard => shard.encoded));
        assert.equal(first.manifest.helpSlotCount, 3);
        assert.equal(first.manifest.localizedCount, 2);
        assert.equal(first.manifest.shardCount, 2);
        assert.deepEqual(first.manifest.shards.map(shard => ({
            file: shard.file,
            start: shard.start,
            count: shard.count,
        })), [
            { file: '0000.json.gz', start: 0, count: 2 },
            { file: '0001.json.gz', start: 2, count: 1 },
        ]);
        assert.deepEqual(first.shards.map(shard => shard.payload.english), [
            ['Identifier.', 'Value.'],
            ['Nested help.'],
        ]);
        assert.deepEqual(first.shards.map(shard => shard.payload.localized), [
            ['标识符。', null],
            ['嵌套说明。'],
        ]);
        first.shards.forEach((shard, index) => {
            assert.equal(first.manifest.shards[index].compressedBytes, shard.encoded.length);
            assert.equal(first.manifest.shards[index].sha256, sha256(shard.encoded));
        });
    });

    it('packages every source-locked help slot in bounded independently verified shards', function () {
        this.timeout(5000);
        const repoRoot = path.resolve(__dirname, "../../..");
        const english = fs.readFileSync(path.join(repoRoot, "keywords/runtime/schema/field_data.json"));
        const localized = fs.readFileSync(path.join(repoRoot, "keywords/authoring/field_data_zh.json"));
        const englishText = english.toString('utf8');
        const localizedText = localized.toString('utf8');
        const expectedEnglish = buildFieldSchemaRuntime(englishText).helpRuntime.values;
        const expectedLocalized = buildFieldHelpDelta(englishText, localizedText).values;
        const runtimeDirectory = path.join(repoRoot, 'out', 'runtime', 'field_help');
        const manifestText = fs.readFileSync(path.join(runtimeDirectory, 'manifest.json'), 'utf8');
        const manifest = JSON.parse(manifestText);
        const collectedEnglish = [];
        const collectedLocalized = [];
        let compressedBytes = 0;
        let maximumShardBytes = 0;

        assert.equal(manifest.formatVersion, 1);
        assert.equal(manifest.baseSha256, sha256(english));
        assert.equal(manifest.localizedSourceSha256, sha256(localized));
        assert.equal(manifest.helpSlotCount, expectedEnglish.length);
        assert.equal(manifest.helpSlotCount, expectedLocalized.length);
        assert.equal(manifest.shardCount, Math.ceil(manifest.helpSlotCount / manifest.shardSize));
        assert.equal(manifest.shards.length, manifest.shardCount);

        manifest.shards.forEach((entry, index) => {
            assert.equal(entry.file, `${String(index).padStart(4, '0')}.json.gz`);
            assert.equal(entry.shardIndex, index);
            assert.equal(entry.start, index * manifest.shardSize);
            assert.equal(entry.count, Math.min(manifest.shardSize, manifest.helpSlotCount - entry.start));
            const encoded = fs.readFileSync(path.join(runtimeDirectory, 'shards', entry.file));
            assert.equal(encoded.length, entry.compressedBytes);
            assert.equal(sha256(encoded), entry.sha256);
            const payload = JSON.parse(zlib.gunzipSync(encoded).toString('utf8'));
            assert.equal(payload.baseSha256, manifest.baseSha256);
            assert.equal(payload.shardIndex, entry.shardIndex);
            assert.equal(payload.start, entry.start);
            assert.equal(payload.count, entry.count);
            assert.equal(payload.english.length, entry.count);
            assert.equal(payload.localized.length, entry.count);
            collectedEnglish.push(...payload.english);
            collectedLocalized.push(...payload.localized);
            compressedBytes += encoded.length;
            maximumShardBytes = Math.max(maximumShardBytes, encoded.length);
        });

        assert.deepEqual(collectedEnglish, expectedEnglish);
        assert.deepEqual(collectedLocalized, expectedLocalized);
        assert.ok(compressedBytes < 4 * 1024 * 1024, `help shards total ${compressedBytes} bytes`);
        assert.ok(maximumShardBytes < 256 * 1024, `largest help shard is ${maximumShardBytes} bytes`);
    });
});
