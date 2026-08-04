'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FORMAT_VERSION = 1;
const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_ENGLISH_PATH = path.join(repoRoot, 'keywords', 'field_data.json');
const DEFAULT_LOCALIZED_PATH = path.join(repoRoot, 'keywords', 'field_data_zh.json');
const DEFAULT_OUTPUT_PATH = path.join(repoRoot, 'out', 'runtime', 'field_help_zh.delta.json.gz');

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function containsHan(value) {
    return /[\u3400-\u9fff]/.test(String(value || ''));
}

function parseJson(text, label) {
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${error.message}`);
    }
}

function displayPath(parts) {
    if (parts.length === 0) return '<root>';
    return parts.map((part, index) => typeof part === 'number' ? `[${part}]` : (index === 0 ? part : `.${part}`)).join('');
}

function collectHelpDelta(english, localized) {
    const values = [];

    function visit(englishNode, localizedNode, parts) {
        if (Array.isArray(englishNode)) {
            if (!Array.isArray(localizedNode)) {
                throw new Error(`${displayPath(parts)}: localized node must be an array`);
            }
            if (localizedNode.length !== englishNode.length) {
                throw new Error(
                    `${displayPath(parts)}: localized array length ${localizedNode.length} does not match ${englishNode.length}`
                );
            }
            englishNode.forEach((item, index) => visit(item, localizedNode[index], parts.concat(index)));
            return;
        }

        if (englishNode && typeof englishNode === 'object') {
            if (!localizedNode || typeof localizedNode !== 'object' || Array.isArray(localizedNode)) {
                throw new Error(`${displayPath(parts)}: localized node must be an object`);
            }
            const englishKeys = Object.keys(englishNode);
            const localizedKeys = Object.keys(localizedNode);
            if (englishKeys.length !== localizedKeys.length
                || englishKeys.some((key, index) => localizedKeys[index] !== key)) {
                throw new Error(`${displayPath(parts)}: localized object keys or key order differ from English`);
            }

            for (const key of englishKeys) {
                const englishValue = englishNode[key];
                const localizedValue = localizedNode[key];
                const nextParts = parts.concat(key);
                if (key === 'h' && typeof englishValue === 'string') {
                    if (typeof localizedValue !== 'string') {
                        throw new Error(`${displayPath(nextParts)}: localized help must be a string`);
                    }
                    if (localizedValue === englishValue) {
                        values.push(null);
                        continue;
                    }
                    const prefix = `${englishValue}\n`;
                    if (!englishValue || !localizedValue.startsWith(prefix)) {
                        throw new Error(`${displayPath(nextParts)}: localized help must preserve the exact English prefix`);
                    }
                    const suffix = localizedValue.slice(prefix.length);
                    if (!suffix || !containsHan(suffix)) {
                        throw new Error(`${displayPath(nextParts)}: localized help suffix must contain reviewed Chinese text`);
                    }
                    values.push(suffix);
                    continue;
                }
                visit(englishValue, localizedValue, nextParts);
            }
            return;
        }

        if (!Object.is(englishNode, localizedNode)) {
            throw new Error(`${displayPath(parts)}: localized structural value differs from English`);
        }
    }

    visit(english, localized, []);
    return values;
}

function buildFieldHelpDelta(englishText, localizedText) {
    const english = parseJson(englishText, 'English field data');
    const localized = parseJson(localizedText, 'Localized field data');
    const values = collectHelpDelta(english, localized);
    const localizedCount = values.reduce((count, value) => count + (value === null ? 0 : 1), 0);
    return {
        formatVersion: FORMAT_VERSION,
        baseSha256: sha256(Buffer.from(englishText, 'utf8')),
        sourceLocalizedSha256: sha256(Buffer.from(localizedText, 'utf8')),
        helpSlotCount: values.length,
        localizedCount,
        values,
    };
}

function encodeFieldHelpDelta(delta) {
    return zlib.gzipSync(Buffer.from(JSON.stringify(delta), 'utf8'), { level: 9 });
}

function generateFieldHelpDelta({
    englishPath = DEFAULT_ENGLISH_PATH,
    localizedPath = DEFAULT_LOCALIZED_PATH,
    outputPath = DEFAULT_OUTPUT_PATH,
} = {}) {
    const englishText = fs.readFileSync(englishPath, 'utf8');
    const localizedText = fs.readFileSync(localizedPath, 'utf8');
    const delta = buildFieldHelpDelta(englishText, localizedText);
    const encoded = encodeFieldHelpDelta(delta);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, encoded);
    return { delta, encodedBytes: encoded.length, outputPath };
}

function argumentValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function main() {
    const result = generateFieldHelpDelta({
        englishPath: argumentValue('--english') || DEFAULT_ENGLISH_PATH,
        localizedPath: argumentValue('--localized') || DEFAULT_LOCALIZED_PATH,
        outputPath: argumentValue('--output') || DEFAULT_OUTPUT_PATH,
    });
    console.log(
        `Generated ${path.relative(repoRoot, result.outputPath)}: `
        + `${result.delta.localizedCount}/${result.delta.helpSlotCount} localized help slots, `
        + `${result.encodedBytes} bytes.`
    );
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    FORMAT_VERSION,
    buildFieldHelpDelta,
    collectHelpDelta,
    encodeFieldHelpDelta,
    generateFieldHelpDelta,
    sha256,
};
