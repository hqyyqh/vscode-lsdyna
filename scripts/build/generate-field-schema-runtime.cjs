'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FORMAT_VERSION = 1;
const repoRoot = path.resolve(__dirname, "../..");
const DEFAULT_INPUT_PATH = path.join(repoRoot, "keywords/runtime/schema/field_data.json");
const DEFAULT_SCHEMA_OUTPUT_PATH = path.join(repoRoot, 'out', 'runtime', 'field_schema.runtime.json.gz');

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function buildFieldSchemaRuntime(fieldDataText) {
    const source = JSON.parse(fieldDataText);
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('invalid field schema source');
    const helpValues = [];

    function compact(value) {
        if (Array.isArray(value)) return value.map(compact);
        if (!value || typeof value !== 'object') return value;

        const result = {};
        let helpIndex = null;
        let helpText = '';
        for (const [key, child] of Object.entries(value)) {
            if (key === 'h' && typeof child === 'string') {
                helpIndex = helpValues.length;
                helpText = child;
                helpValues.push(child);
            } else {
                result[key] = compact(child);
            }
        }
        if (helpIndex !== null) result.hi = helpIndex;
        const fieldName = String(value.n || '').trim();
        if (fieldName === 'ID' || /(?:id|identifier|identification)$/i.test(fieldName)) {
            if (/defined in|reference(?:s| to)?|see \*|load curve|table id|part id,? see/i.test(helpText)) {
                result.di = 'reference';
            } else if (/unique|identification|identifier|identifies this|identification number/i.test(helpText)) {
                result.di = 'self';
            }
        }
        return result;
    }

    const baseSha256 = sha256(Buffer.from(fieldDataText, 'utf8'));
    const schema = compact(source);
    return {
        schemaRuntime: {
            formatVersion: FORMAT_VERSION,
            baseSha256,
            keywordCount: Object.keys(schema).length,
            helpSlotCount: helpValues.length,
            schema,
        },
        helpRuntime: {
            formatVersion: FORMAT_VERSION,
            baseSha256,
            helpSlotCount: helpValues.length,
            values: helpValues,
        },
    };
}

function encodeRuntime(runtime) {
    return zlib.gzipSync(Buffer.from(JSON.stringify(runtime), 'utf8'), {
        level: 9,
        mtime: 0,
    });
}

function generateFieldSchemaRuntime({
    inputPath = DEFAULT_INPUT_PATH,
    schemaOutputPath = DEFAULT_SCHEMA_OUTPUT_PATH,
} = {}) {
    const sourceText = fs.readFileSync(inputPath, 'utf8');
    const { schemaRuntime, helpRuntime } = buildFieldSchemaRuntime(sourceText);
    const schemaEncoded = encodeRuntime(schemaRuntime);
    fs.mkdirSync(path.dirname(schemaOutputPath), { recursive: true });
    fs.writeFileSync(schemaOutputPath, schemaEncoded);
    return {
        schemaRuntime,
        helpRuntime,
        schemaEncoded,
        schemaOutputPath,
    };
}

function argumentValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function main() {
    const result = generateFieldSchemaRuntime({
        inputPath: argumentValue('--input') || DEFAULT_INPUT_PATH,
        schemaOutputPath: argumentValue('--schema-output') || DEFAULT_SCHEMA_OUTPUT_PATH,
    });
    console.log(
        `Generated ${path.relative(repoRoot, result.schemaOutputPath)}: `
        + `${result.schemaRuntime.keywordCount} keywords, ${result.schemaEncoded.length} bytes, `
        + `${result.helpRuntime.helpSlotCount} help slots indexed.`,
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
    FORMAT_VERSION,
    buildFieldSchemaRuntime,
    encodeRuntime,
    generateFieldSchemaRuntime,
    sha256,
};
