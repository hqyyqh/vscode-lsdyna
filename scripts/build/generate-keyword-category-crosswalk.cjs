#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, "../..");
const schemaPath = path.join(repoRoot, "keywords/runtime/schema/field_data.json");
const runtimeOutputPath = path.join(repoRoot, "keywords/runtime/categories/lspp_keyword_categories.runtime.json");
const crosswalkOutputPath = path.join(repoRoot, "keywords/runtime/categories/keyword_category_crosswalk.json");

// Definition filenames in the extracted LS-PrePost table use the RESTART_* spelling for these
// three public *RIGID_DEFORMABLE_* keywords.  Keep the reviewed bridge explicit and auditable.
const REVIEWED_OVERRIDES = {
    // LS-PrePost registers the same definition under broad DEFINE and module-specific PARTICLE
    // anchors.  The module category is the more useful single reveal target for an analyst.
    DEFINE_PARTICLE_BLAST: 'PARTICLE',
    RIGID_DEFORMABLE_CONTROL: 'DELETE',
    RIGID_DEFORMABLE_D2R: 'DELETE',
    RIGID_DEFORMABLE_R2D: 'DELETE',
};

function parseArgs(argv) {
    const result = { catalog: '', check: false };
    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (value === '--catalog') result.catalog = argv[++index] || '';
        else if (value === '--check') result.check = true;
        else throw new Error(`Unknown argument: ${value}`);
    }
    return result;
}

function normalize(value) {
    return String(value || '')
        .trim()
        .replace(/^\*/, '')
        .replace(/\.[^.]+$/, '')
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .toUpperCase();
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function addCandidate(registry, keyword, category, score, source) {
    const key = normalize(keyword);
    if (!key || !category) return;
    if (!registry.has(key)) registry.set(key, new Map());
    const candidates = registry.get(key);
    const existing = candidates.get(category);
    if (!existing || score > existing.score) {
        candidates.set(category, { category, score, source });
    }
}

function connect(graph, left, right) {
    const a = normalize(left);
    const b = normalize(right);
    if (!a || !b || a === b) return;
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b);
    graph.get(b).add(a);
}

function buildArtifacts(catalogBuffer, schemaBuffer) {
    const catalog = JSON.parse(catalogBuffer.toString('utf8'));
    const schema = JSON.parse(schemaBuffer.toString('utf8'));
    const schemaNames = Object.keys(schema).map(normalize).sort();
    const schemaNameSet = new Set(schemaNames);
    const candidates = new Map();
    const graph = new Map();

    const categories = (catalog.categories || []).map(category => ({
        code: String(category.code || ''),
        name: normalize(category.name),
        ordinal: Number(category.ordinal) || 0,
        displayIndex: Number(category.displayIndex) || 0,
        keywordRecordCount: Number(category.keywordRecordCount) || 0,
        uniqueKeywordCount: Number(category.uniqueKeywordCount) || 0,
        keywords: (category.keywords || []).map(item => normalize(item.normalizedName)).filter(Boolean),
    }));
    const categoryByName = new Map(categories.map(category => [category.name, category]));

    for (const category of catalog.categories || []) {
        const categoryName = normalize(category.name);
        for (const keyword of category.keywords || []) {
            const registeredName = normalize(keyword.normalizedName);
            addCandidate(candidates, `${categoryName}_${registeredName}`, categoryName, 80, 'category-registration');

            for (const definitionFile of keyword.definitionFiles || []) {
                const definitionName = normalize(definitionFile);
                addCandidate(candidates, definitionName, categoryName, 90, 'definition-file');
                for (const segment of String(definitionFile || '').split(/__+/)) {
                    addCandidate(candidates, normalize(segment), categoryName, 88, 'definition-file-alias');
                }
            }
        }
    }

    for (const [keyword, category] of Object.entries(REVIEWED_OVERRIDES)) {
        addCandidate(candidates, keyword, category, 100, 'reviewed-override');
    }

    // Schema-declared aliases, variants and canonical redirects are the only safe way to inherit
    // a category across suffixes such as _ID, _TITLE and _ID_TITLE.
    for (const [rawName, entry] of Object.entries(schema)) {
        const name = normalize(rawName);
        for (const alias of entry.a || []) connect(graph, name, alias);
        for (const variant of Object.keys(entry.v || {})) connect(graph, name, variant);
        if (entry.x) connect(graph, name, entry.x);
    }

    // A small set of structural suffix relationships is needed for generated schemas that expose
    // the variant as a top-level key but omit the reverse `v` edge.
    const suffixes = [
        '_ID_TITLE', '_ID_HEADING', '_TITLE_ID', '_HEADING_ID',
        '_TITLE', '_HEADING', '_ID',
    ];
    for (const name of schemaNames) {
        for (const suffix of suffixes) {
            if (!name.endsWith(suffix)) continue;
            const base = name.slice(0, -suffix.length);
            if (schemaNameSet.has(base)) connect(graph, name, base);
        }
    }

    // Propagate only high-confidence evidence through verified schema relationships.
    let changed = true;
    while (changed) {
        changed = false;
        for (const [name, neighbours] of graph.entries()) {
            for (const neighbour of neighbours) {
                const sourceCandidates = candidates.get(neighbour);
                if (!sourceCandidates) continue;
                for (const value of sourceCandidates.values()) {
                    if (value.score < 75) continue;
                    const before = candidates.get(name)?.get(value.category)?.score || -1;
                    addCandidate(candidates, name, value.category, Math.min(79, value.score - 1), 'schema-variant');
                    const after = candidates.get(name)?.get(value.category)?.score || -1;
                    if (after > before) changed = true;
                }
            }
        }
    }

    const categoryNamesByLength = [...categoryByName.keys()].sort((a, b) => b.length - a.length);
    for (const name of schemaNames) {
        if (candidates.has(name)) continue;
        const prefix = categoryNamesByLength.find(category => name === category || name.startsWith(`${category}_`));
        if (prefix) addCandidate(candidates, name, prefix, 50, 'category-prefix');
    }

    const categoryRank = new Map(categories.map(category => [category.name, category.displayIndex]));
    const keywordToCategory = {};
    const sourceCounts = {};
    const confidenceCounts = { verified: 0, inferred: 0, fallback: 0 };

    for (const name of schemaNames) {
        const values = [...(candidates.get(name)?.values() || [])];
        values.sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            const leftPrefix = name === left.category || name.startsWith(`${left.category}_`) ? 1 : 0;
            const rightPrefix = name === right.category || name.startsWith(`${right.category}_`) ? 1 : 0;
            if (rightPrefix !== leftPrefix) return rightPrefix - leftPrefix;
            return (categoryRank.get(left.category) ?? 999) - (categoryRank.get(right.category) ?? 999);
        });

        const primary = values[0] || { category: 'OTHER', score: 0, source: 'explicit-fallback' };
        const confidence = primary.score >= 75 ? 'verified' : primary.score >= 50 ? 'inferred' : 'fallback';
        const aliases = values
            .filter(item => item.category !== primary.category)
            .map(item => item.category);
        keywordToCategory[name] = {
            primaryCategory: primary.category,
            aliases,
            source: primary.source,
            confidence,
        };
        sourceCounts[primary.source] = (sourceCounts[primary.source] || 0) + 1;
        confidenceCounts[confidence]++;
    }

    const sourceMetadata = {
        catalogSha256: sha256(catalogBuffer),
        fieldDataSha256: sha256(schemaBuffer),
        datasetVersion: catalog.source?.datasetVersion || '',
        datasetSha256: catalog.source?.datasetSha256 || '',
    };
    const runtime = {
        schemaVersion: 1,
        kind: 'lspp-keyword-categories-runtime',
        source: sourceMetadata,
        summary: {
            functionalCategoryCount: categories.length,
            nonEmptyCategoryCount: categories.filter(category => category.uniqueKeywordCount > 0).length,
            registeredKeywordCount: categories.reduce((sum, category) => sum + category.keywords.length, 0),
        },
        categories,
    };
    const crosswalk = {
        schemaVersion: 1,
        kind: 'lsdyna-keyword-category-crosswalk',
        source: sourceMetadata,
        summary: {
            schemaKeywordCount: schemaNames.length,
            confidenceCounts,
            sourceCounts: Object.fromEntries(Object.entries(sourceCounts).sort(([a], [b]) => a.localeCompare(b))),
        },
        keywordToCategory,
    };
    return { runtime, crosswalk };
}

function stableJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function writeOrCheck(filePath, content, check) {
    if (check) {
        if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== content) {
            throw new Error(`${path.relative(repoRoot, filePath)} is stale; regenerate the category artifacts`);
        }
        return;
    }
    fs.writeFileSync(filePath, content, 'utf8');
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.catalog) {
        throw new Error('Pass --catalog <normalized/keyword_categories.json> from LSPP_database_standalone');
    }
    const catalogPath = path.resolve(args.catalog);
    const catalogBuffer = fs.readFileSync(catalogPath);
    const schemaBuffer = fs.readFileSync(schemaPath);
    const artifacts = buildArtifacts(catalogBuffer, schemaBuffer);
    writeOrCheck(runtimeOutputPath, stableJson(artifacts.runtime), args.check);
    writeOrCheck(crosswalkOutputPath, stableJson(artifacts.crosswalk), args.check);
    const summary = artifacts.crosswalk.summary;
    process.stdout.write(
        `Keyword category crosswalk: ${summary.schemaKeywordCount} keywords; `
        + `${summary.confidenceCounts.verified} verified, `
        + `${summary.confidenceCounts.inferred} inferred, `
        + `${summary.confidenceCounts.fallback} fallback.\n`
    );
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
        process.exitCode = 1;
    }
}

module.exports = { buildArtifacts, normalize };
