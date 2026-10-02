'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { buildFieldSchemaRuntime } = require('./generate-field-schema-runtime.cjs');
const { buildFieldHelpDelta } = require('./generate-field-help-zh-delta.cjs');

const FORMAT_VERSION = 1;
const DEFAULT_SHARD_SIZE = 2048;
const repoRoot = path.resolve(__dirname, "../..");
const DEFAULT_ENGLISH_PATH = path.join(repoRoot, "keywords/runtime/schema/field_data.json");
const DEFAULT_LOCALIZED_PATH = path.join(repoRoot, "keywords/authoring/field_data_zh.json");
const DEFAULT_OUTPUT_DIRECTORY = path.join(repoRoot, 'out', 'runtime', 'field_help');
const DEFAULT_TEXT_TRANSLATIONS = path.join(repoRoot, "keywords/authoring/native_field_help_zh.json");
const DEFAULT_MANUAL_SEMANTICS_PATH = path.join(repoRoot, "keywords/authoring/manual_semantics_zh.json");

// Only layout whitespace is equivalent. Never discard punctuation, signs or words.
const normalizeHelp = text => text.trim().replace(/\s+/gu, ' ');

function buildHelpTextIndex(shards, translations = []) {
    const entries = {};
    const localizedByKey = new Map();
    const ambiguous = new Set();
    for (const { payload } of shards) payload.english.forEach((english, index) => {
        const localized = payload.localized[index];
        if (!english.trim() || !localized) return;
        const key = sha256(normalizeHelp(english));
        if (localizedByKey.has(key) && localizedByKey.get(key) !== localized) ambiguous.add(key);
        else {
            localizedByKey.set(key, localized);
            entries[key] = payload.start + index;
        }
    });
    for (const key of ambiguous) delete entries[key];
    const seen = new Map();
    for (const item of translations) {
        if (typeof item.english !== 'string' || !item.english.trim()
            || typeof item.localized !== 'string' || !/\p{Script=Han}/u.test(item.localized)) {
            throw new Error('Reviewed help translations must contain an English source and Chinese text');
        }
        const key = sha256(normalizeHelp(item.english));
        if (seen.has(key)) {
            if (seen.get(key) !== item.localized) {
                throw new Error(`Conflicting reviewed help translation for: ${item.english}`);
            }
            continue;
        }
        seen.set(key, item.localized);
        if (typeof entries[key] === 'number' && localizedByKey.get(key) === item.localized) continue;
        entries[key] = item.localized;
    }
    return entries;
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function encodeRuntime(value) {
    return zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8'), {
        level: 9,
        mtime: 0,
    });
}

function buildFieldHelpRuntime(englishText, localizedText, shardSize = DEFAULT_SHARD_SIZE) {
    if (!Number.isSafeInteger(shardSize) || shardSize <= 0) {
        throw new TypeError('field-help shard size must be a positive integer');
    }
    const { helpRuntime } = buildFieldSchemaRuntime(englishText);
    const localizedDelta = buildFieldHelpDelta(englishText, localizedText);
    if (helpRuntime.baseSha256 !== localizedDelta.baseSha256
        || helpRuntime.helpSlotCount !== localizedDelta.helpSlotCount) {
        throw new Error('English and localized field-help sources do not share one slot contract');
    }

    const shards = [];
    for (let start = 0, shardIndex = 0; start < helpRuntime.helpSlotCount; start += shardSize, shardIndex++) {
        const count = Math.min(shardSize, helpRuntime.helpSlotCount - start);
        const payload = {
            formatVersion: FORMAT_VERSION,
            baseSha256: helpRuntime.baseSha256,
            shardIndex,
            start,
            count,
            english: helpRuntime.values.slice(start, start + count),
            localized: localizedDelta.values.slice(start, start + count),
        };
        const encoded = encodeRuntime(payload);
        const file = `${String(shardIndex).padStart(4, '0')}.json.gz`;
        shards.push({ file, payload, encoded });
    }

    const manifest = {
        formatVersion: FORMAT_VERSION,
        baseSha256: helpRuntime.baseSha256,
        localizedSourceSha256: localizedDelta.sourceLocalizedSha256,
        helpSlotCount: helpRuntime.helpSlotCount,
        localizedCount: localizedDelta.localizedCount,
        shardSize,
        shardCount: shards.length,
        shards: shards.map(({ file, payload, encoded }) => ({
            file,
            shardIndex: payload.shardIndex,
            start: payload.start,
            count: payload.count,
            compressedBytes: encoded.length,
            sha256: sha256(encoded),
        })),
    };
    return { manifest, shards };
}

function removeOldShardFiles(shardsDirectory) {
    let names = [];
    try {
        names = fs.readdirSync(shardsDirectory);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    for (const name of names) {
        if (/^\d{4}\.json\.gz$/.test(name)) {
            fs.rmSync(path.join(shardsDirectory, name), { force: true });
        }
    }
}

function generateFieldHelpRuntime({
    englishPath = DEFAULT_ENGLISH_PATH,
    localizedPath = DEFAULT_LOCALIZED_PATH,
    outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
    shardSize = DEFAULT_SHARD_SIZE,
    textTranslationsPath = DEFAULT_TEXT_TRANSLATIONS,
    manualSemanticsPath = DEFAULT_MANUAL_SEMANTICS_PATH,
} = {}) {
    const englishText = fs.readFileSync(englishPath, 'utf8');
    const localizedText = fs.readFileSync(localizedPath, 'utf8');
    const result = buildFieldHelpRuntime(englishText, localizedText, shardSize);
    const nativeTranslations = JSON.parse(fs.readFileSync(textTranslationsPath, 'utf8'));
    let manualTranslations = [];
    if (fs.existsSync(manualSemanticsPath)) {
        manualTranslations = JSON.parse(fs.readFileSync(manualSemanticsPath, 'utf8'));
    }
    const translations = [...nativeTranslations, ...manualTranslations];
    const textIndex = encodeRuntime(buildHelpTextIndex(result.shards, translations));
    result.manifest.textIndex = { file: 'text-index.json.gz', sha256: sha256(textIndex),
        sourceSha256: sha256(fs.readFileSync(textTranslationsPath)) };
    if (fs.existsSync(manualSemanticsPath)) {
        result.manifest.textIndex.manualSemanticsSha256 = sha256(fs.readFileSync(manualSemanticsPath));
    }
    const resolvedOutputDirectory = path.resolve(outputDirectory);
    const shardsDirectory = path.join(resolvedOutputDirectory, 'shards');
    fs.mkdirSync(shardsDirectory, { recursive: true });
    fs.writeFileSync(path.join(resolvedOutputDirectory, 'text-index.json.gz'), textIndex);
    removeOldShardFiles(shardsDirectory);
    for (const shard of result.shards) {
        fs.writeFileSync(path.join(shardsDirectory, shard.file), shard.encoded);
    }
    fs.writeFileSync(
        path.join(resolvedOutputDirectory, 'manifest.json'),
        `${JSON.stringify(result.manifest, null, 2)}\n`,
        'utf8',
    );
    return {
        ...result,
        outputDirectory: resolvedOutputDirectory,
        compressedBytes: result.shards.reduce((total, shard) => total + shard.encoded.length, 0),
    };
}

function argumentValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function main() {
    const shardSizeValue = argumentValue('--shard-size');
    const result = generateFieldHelpRuntime({
        englishPath: argumentValue('--english') || DEFAULT_ENGLISH_PATH,
        localizedPath: argumentValue('--localized') || DEFAULT_LOCALIZED_PATH,
        outputDirectory: argumentValue('--output') || DEFAULT_OUTPUT_DIRECTORY,
        shardSize: shardSizeValue ? Number(shardSizeValue) : DEFAULT_SHARD_SIZE,
    });
    console.log(
        `Generated ${path.relative(repoRoot, result.outputDirectory)}: `
        + `${result.manifest.shardCount} shards, ${result.manifest.helpSlotCount} help slots, `
        + `${result.compressedBytes} compressed bytes.`,
    );
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error?.stack || error);
        process.exitCode = 1;
    }
}

module.exports = {
    DEFAULT_SHARD_SIZE,
    FORMAT_VERSION,
    buildFieldHelpRuntime,
    encodeRuntime,
    generateFieldHelpRuntime,
    sha256,
    buildHelpTextIndex,
    normalizeHelp,
};
