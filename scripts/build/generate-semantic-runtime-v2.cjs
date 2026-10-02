'use strict';
// Public deterministic compiler; external collection and certification are separate.
const crypto = require('node:crypto');

const fs = require('node:fs');

const path = require('node:path');

const zlib = require('node:zlib');

const MAX_COMPRESSED_SHARD = 2 * 1024 * 1024;

const MAX_UNCOMPRESSED_SHARD = 16 * 1024 * 1024;

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}

function json(value) { return JSON.stringify(canonical(value)); }

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function stable(prefix, value) { return `${prefix}:${sha(Buffer.from(json(value))).slice(0, 24)}`; }

function normalizeKeyword(value) {
    const keyword = String(value || '').trim().toUpperCase().replace(/^\*/, '').split(/[\s,$]/)[0];
    return keyword.replace(/[+%\-]$/, '');
}

function gzip(value) { return zlib.gzipSync(Buffer.from(json(value)), { level: 9, mtime: 0 }); }

function derivedIdentityBindings(layout) {
    return layout.records.flatMap(record => record.fields.map(field => ({
        sourceFieldMigrationId: field.fieldMigrationId,
        targetFieldMigrationId: field.fieldMigrationId,
        evidenceId: stable('option-binding-evidence', [layout.profileId, field.fieldMigrationId]),
        ...(field.canonicalFieldIdentity ? { strategy: 'stable-physical-field-identity' } : {}),
    })));
}

function compactOptionGrammarForStorage(grammar) {
    return {
        ...grammar,
        targets: (grammar.targets || []).map(target => ({
            ...target,
            layouts: (target.layouts || []).map(candidate => {
                if (!candidate.layout?.profileId || !Array.isArray(candidate.layout.records) ||
                    candidate.layout.records.some(record => !Array.isArray(record?.fields) ||
                        record.fields.some(field => !field?.fieldMigrationId))) {
                    return candidate;
                }
                const derived = derivedIdentityBindings(candidate.layout);
                if (!Array.isArray(candidate.bindings) || json(candidate.bindings) !== json(derived)) {
                    return candidate;
                }
                const { bindings, ...core } = candidate;
                const compact = { ...core, bindingEncoding: 'identity-derived-v1' };
                const { bindingEncoding, ...restoredCore } = compact;
                const restored = { ...restoredCore, bindings: derivedIdentityBindings(compact.layout) };
                if (bindingEncoding !== 'identity-derived-v1' || json(restored) !== json(candidate)) {
                    throw new Error(`semantic option binding compaction drift: ${target.spelling}`);
                }
                return compact;
            }),
        })),
    };
}

function writeShard(root, domain, prefix, records, scanners = []) {
    const storedRecords = domain === 'options' ? records.map(compactOptionGrammarForStorage) : records;
    const payload = canonical({ schemaVersion: 2, kind: `dynasense-${domain}-shard-v2`, prefix, records: storedRecords,
        ...(domain === 'references' ? { scanners } : {}) });
    const raw = Buffer.from(JSON.stringify(payload));
    const compressed = gzip(payload);
    if (raw.length > MAX_UNCOMPRESSED_SHARD || compressed.length > MAX_COMPRESSED_SHARD) {
        throw new Error(`${domain}/${prefix} shard capacity exceeded`);
    }
    const relativePath = `${domain}/${prefix}.json.gz`;
    const output = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, compressed);
    return { prefix, path: relativePath, records: records.length,
        ...(domain === 'references' ? { scanners: scanners.length } : {}), compressedBytes: compressed.length,
        uncompressedBytes: raw.length, sha256: sha(compressed), contentSha256: sha(raw) };
}

function groupedByPrefix(records, keywordOf) {
    const groups = new Map([...Array(16)].map((_, index) => [index.toString(16), []]));
    for (const record of records) {
        const prefix = sha(Buffer.from(normalizeKeyword(keywordOf(record)))).slice(0, 1);
        groups.get(prefix).push(record);
    }
    return groups;
}

module.exports = { groupedByPrefix, writeShard };
