'use strict';

const assert = require('node:assert');

const {
    scanRegistryReferenceOccurrencesFromFileIndex,
    uniqueApprovedTableReferenceField,
    scanOperationalBlock,
    lsppReferenceRecordsForKeyword,
    getCatalogFieldReferenceInfo,
    commaTokenRange,
    relationNamespaces,
    formatTokenRange,
    semanticOccurrence,
} = require('../../../out/core/references/registryReferenceScanner');
const {
    parseTableBlock,
} = require('../../../out/core/references/curveTableDefinitionScanner');
const {
    getRegistryApprovedFieldReferenceInfo,
    parseFieldReferenceValue,
} = require('../../../out/core/references/fieldReferenceClassifier');
const registry = require("../../../keywords/runtime/definitions/definition_registry.json");
const { getDefinitionRegistryCatalog } = require('../../../out/core/references/definitionRegistry');
const keywordSchema = require('../../../out/core/keywordSchema');
const { getSemanticRuntimeCatalogV2 } = require('../../../out/core/semantics/semanticRuntimeV2');

const legacyRegistryCatalog = getDefinitionRegistryCatalog();
const LEGACY_REFERENCE_CATALOG = {
    recordsForKeyword: keyword => legacyRegistryCatalog.rulesForKeyword(keyword).filter(record =>
        record.kind === 'entity-reference' || record.kind === 'value-branch'),
    infoForField: getRegistryApprovedFieldReferenceInfo,
};

function partText(adpopt) {
    return [
        '*PART',
        'Registry scanner fixture',
        [1, 0, 0, 0, 0, 0, adpopt, 0].map(value => String(value).padStart(10)).join(''),
    ].join('\n');
}

function formattedPartText(mode, adpopt) {
    const values = [1, 0, 0, 0, 0, 0, adpopt, 0];
    if (mode === 'comma') return ['*PART', 'Formatted fixture', values.join(',')].join('\n');
    const width = mode === 'long' ? 20 : 10;
    const marker = mode === 'long' ? '+' : mode === 'i10' ? '%' : '';
    return [`*PART${marker}`, 'Formatted fixture', values.map(value => String(value).padStart(width)).join('')].join('\n');
}

function siblingBoundText(keyword, mode, pid, ptype) {
    const values = keyword === 'DEFORMABLE_TO_RIGID' ? [pid, 0, ptype] : [pid, ptype];
    const marker = mode === 'long' ? '+' : mode === 'i10' ? '%' : '';
    const line = mode === 'comma'
        ? values.map(value => value ?? '').join(',')
        : values.map(value => value === null ? ''.padStart(mode === 'long' ? 20 : 10)
            : String(value).padStart(mode === 'long' ? 20 : 10)).join('');
    return [`*${keyword}${marker}`, line].join('\n');
}

function constrainedLagrangeText(mode, lcidpor, ctype, poreini) {
    const cards = [
        [1, 'Context fixture'],
        [1, 1, 0, 0, 0, ctype, 0, 0],
        [0, 0, 1, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, lcidpor, 0, 0],
        [0, 0, 0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0, 0, poreini],
        [0, 0, 0, 0, 0],
    ];
    const marker = mode === 'long' ? '+' : mode === 'i10' ? '%' : '';
    const lines = cards.map(values => mode === 'comma'
        ? values.map(value => value ?? '').join(',')
        : values.map(value => String(value ?? '').padStart(mode === 'long' ? 20 : 10))
            .join(''));
    return [`*CONSTRAINED_LAGRANGE_IN_SOLID${marker}`, ...lines].join('\n');
}

function partLabelText() {
    return [
        '*PART',
        'Label reference fixture',
        [1, 'SEC A', 'HS Steel', 0, 0, 0, 0, 'THERM A']
            .map(value => String(value).padStart(10)).join(''),
    ].join('\n');
}

function fluxText(spd1, spd2) {
    return [
        '*BOUNDARY_FLUX_TRAJECTORY',
        [11, 12, 0, spd1, 0, spd2, 0].map(value => String(value).padStart(10)).join(''),
    ].join('\n');
}

function loadBodyText(lcid) {
    return [
        '*LOAD_BODY_Z',
        [lcid, 9806, 0, 0, 0, 0, 0].map(value => String(value).padStart(10)).join(''),
    ].join('\n');
}

function loadBodyPartsText(psid) {
    return [
        '*LOAD_BODY_PARTS',
        [psid, 1, 0].map(value => String(value).padStart(10)).join(''),
    ].join('\n');
}

async function scanBlocks(blocks, texts, referenceDefinitions = { curves: [], tables: [], genericDefinitions: [] }, options = {}) {
    return scanRegistryReferenceOccurrencesFromFileIndex(
        { filePath: '/fixture/main.k', keywordBlocks: blocks, referenceDefinitions },
        async block => texts.get(block.startLine),
        { referenceCatalog: LEGACY_REFERENCE_CATALOG, ...options },
    );
}

function legacyBoundaryText(keyword, mode, value) {
    const cards = keywordSchema.getRenderedCardsForLookup(keywordSchema.lookupKeywordSchema(
        keyword, keywordSchema.loadKeywordSchema(() => 'en')));
    const rows = cards.map((card, row) => {
        const values = card.map((field, index) => row === 0 && index === 0 ? value
            : ['integer', 'real'].includes(field.t) ? '0' : '');
        if (mode === 'comma') return values.join(',');
        const end = Math.max(...card.map((field, index) => mode === 'long'
            ? (index + 1) * 20 : field.p + field.w));
        const characters = Array(end).fill(' ');
        card.forEach((field, index) => {
            const position = mode === 'long' ? index * 20 : field.p;
            const width = mode === 'long' ? 20 : field.w;
            const offset = mode === 'long' && row === 0 && index === 0 ? 5 : width - values[index].length;
            [...values[index]].forEach((character, i) => characters[position + offset + i] = character);
        });
        return characters.join('');
    });
    return [`*${keyword}${mode === 'long' ? ' +' : mode === 'i10' ? ' %' : ''}`, ...rows, '*END'].join('\n');
}

describe('Demanded reference namespaces', () => {
    it('skips proven mesh-only fields while retaining mixed set, coordinate and curve references', async () => {
        const texts = {
            SET_NODE_LIST: '1\n1,2,3,4', SET_SEGMENT: '2\n1,2,3,4',
            CONSTRAINED_SPOTWELD: '1,2,0,0,0,0', INITIAL_STRESS_SHELL: '1,1,1\n0,0,0,0,0,0,0',
            DATABASE_HISTORY_NODE: '1,2,3,4',
            CONSTRAINED_NODAL_RIGID_BODY: '1,7,42,99,0,0,0',
            BOUNDARY_SPC_NODE: '99,7,1,1,1,1,1,1', LOAD_NODE_POINT: '99,1,123,1,7,0,0,0',
        };
        const blocks = Object.keys(texts).map((name, index) => ({ keyword: '*' + name,
            rawKeyword: '*' + name, filePath: '/fixture/mixed.k', startLine: index * 4, endLine: index * 4 + 3 }));
        const reads = [];
        const result = await scanRegistryReferenceOccurrencesFromFileIndex({ keywordBlocks: blocks }, async block => {
            const name = block.keyword.slice(1); reads.push(name); return block.keyword + '\n' + texts[name];
        }, { excludeMeshEntities: true });
        assert.deepEqual(reads, ['SET_SEGMENT', 'INITIAL_STRESS_SHELL', 'DATABASE_HISTORY_NODE',
            'CONSTRAINED_NODAL_RIGID_BODY', 'BOUNDARY_SPC_NODE', 'LOAD_NODE_POINT']);
        // The combined catalog retains set/coordinate branches in these families.
        const pure = blocks.slice(0, 5);
        let nativeReads = 0;
        await scanRegistryReferenceOccurrencesFromFileIndex({ keywordBlocks: pure }, async () => { nativeReads++; return ''; },
            { excludeMeshEntities: true, referenceCatalog: require('../../../out/core/references/registryReferenceScanner').LSPP_REFERENCE_CATALOG });
        assert.equal(nativeReads, 0);
        const fields = result.referenceOccurrences.map(record => record.fieldName);
        assert.ok(fields.includes('NSID')); assert.ok(fields.includes('LCID')); assert.ok(fields.includes('CID'));
        assert.ok(!fields.includes('NID') && !fields.includes('PNODE'));
    });
    it('selects repeated keyword rules once and keeps unknown gaps while excluding mesh-only blockers', async () => {
        let lookups = 0, reads = 0;
        const blocks = Array.from({ length: 200 }, (_, startLine) => ({ keyword: '*TEST_REPEATED', startLine }));
        const result = await scanRegistryReferenceOccurrencesFromFileIndex({ keywordBlocks: blocks }, async () => {
            reads++; return '*TEST_REPEATED\n1';
        }, { excludeMeshEntities: true, referenceCatalog: {
            recordsForKeyword: () => { lookups++; return []; },
            blockedForKeyword: () => [{ reason: 'mesh', targetKind: 'node' }, { reason: 'unknown' }],
            infoForField: () => null,
        } });
        assert.equal(lookups, 1); assert.equal(reads, 200);
        assert.equal(result.referenceCoverage.gaps.length, 200);
        assert.ok(result.referenceCoverage.gaps.every(gap => gap.reason === 'lspp-unknown'));
    });
    it('does not read NODE or ELEMENT blocks for curves but retains ELEMENT part references', async () => {
        const blocks = ['NODE', 'ELEMENT_SHELL', 'LOAD_BODY_Z'].map((keyword, index) =>
            ({ keyword: '*' + keyword, rawKeyword: '*' + keyword, startLine: index * 3, endLine: index * 3 + 2 }));
        const texts = { '*NODE': '*NODE\n1,0,0,0', '*ELEMENT_SHELL': '*ELEMENT_SHELL\n1,7,1,2,3,4',
            '*LOAD_BODY_Z': '*LOAD_BODY_Z\n9,1.0' };
        const read = [];
        const index = { filePath: require('node:path').resolve('demand.k'), keywordBlocks: blocks };
        const curves = await scanRegistryReferenceOccurrencesFromFileIndex(index, async block => {
            read.push(block.keyword); return texts[block.keyword];
        }, { targetKinds: ['curve'] });
        assert.deepEqual(read, ['*LOAD_BODY_Z']);
        assert.ok(curves.referenceOccurrences.some(record => record.fieldName === 'LCID'));
        read.length = 0;
        const parts = await scanRegistryReferenceOccurrencesFromFileIndex(index, async block => {
            read.push(block.keyword); return texts[block.keyword];
        }, { targetKinds: ['part'] });
        assert.ok(read.includes('*ELEMENT_SHELL'));
        assert.ok(parts.referenceOccurrences.some(record => record.fieldName === 'PID'));
    });
});

describe('registryReferenceScanner', () => {
    it('reads real legacy-approved boundary fields in every supported format and distinguishes empty cells', async () => {
        for (const keyword of ['BOUNDARY_PRESCRIBED_MOTION_SET_SEGMENT_ID', 'BOUNDARY_SPC_SET_BIRTH_DEATH_ID']) {
            for (const mode of ['standard', 'long', 'i10', 'comma']) {
                const value = mode === 'long' ? '2147483647' : '42';
                const text = legacyBoundaryText(keyword, mode, value);
                const block = { keyword: `*${keyword}`, rawKeyword: text.split('\n')[0], startLine: 0,
                    endLine: text.split('\n').length - 1, filePath: '/fixture/main.k' };
                const result = await scanRegistryReferenceOccurrencesFromFileIndex(
                    { filePath: block.filePath, keywordBlocks: [block] }, async () => text);
                const occurrence = result.referenceOccurrences.find(item => item.fieldName === 'ID');
                assert.equal(result.complete, true, `${keyword}/${mode}`);
                assert.equal(occurrence.referenceValue.id, Number(value));
                assert.deepEqual([occurrence.startCharacter, occurrence.endCharacter], mode === 'long'
                    ? [5, 15] : mode === 'comma' ? [0, 2] : [8, 10]);
                const empty = legacyBoundaryText(keyword, mode, '');
                const blank = await scanRegistryReferenceOccurrencesFromFileIndex(
                    { filePath: block.filePath, keywordBlocks: [block] }, async () => empty);
                assert.equal(blank.complete, true, `${keyword}/${mode}/blank`);
                assert.deepEqual(blank.referenceOccurrences, []);
                assert.deepEqual(blank.referenceCoverage.gaps, []);
            }
        }
    });

    it('retains a scoped unknown instead of truncating LONG references after a real catalog shard read failure', async () => {
        const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
        const runtime = require('../../../out/core/semantics/semanticRuntimeV2');
        const keyword = 'BOUNDARY_PRESCRIBED_MOTION_SET_SEGMENT_ID';
        const text = legacyBoundaryText(keyword, 'long', '2147483647');
        const block = { keyword: `*${keyword}`, rawKeyword: text.split('\n')[0], startLine: 0,
            endLine: text.split('\n').length - 1, filePath: '/fixture/main.k' };
        const scan = () => scanRegistryReferenceOccurrencesFromFileIndex(
            { filePath: block.filePath, keywordBlocks: [block] }, async () => text);
        assert.equal((await scan()).referenceOccurrences.find(item => item.fieldName === 'ID').referenceValue.id,
            2147483647); // Warm the actual classifier approval; only the later format reload fails.
        const catalog = getSemanticRuntimeCatalogV2(), lookup = catalog.referenceRecordsForKeyword;
        const manifest = catalog.manifest(), prefix = manifest.referenceKeywordIndex[keyword];
        const shard = path.resolve(runtime.semanticRuntimeV2Root(),
            manifest.referenceShards.find(item => item.prefix === prefix).path);
        const read = fs.readFileSync, hash = () => crypto.createHash('sha256').update(read(shard)).digest('hex');
        const before = hash();
        let failures = 0;
        catalog.referenceRecordsForKeyword = function (name) {
            if (name === keyword && new Error().stack.includes('formatTokenRange')) {
                this.cache.delete(`references:${prefix}`);
            }
            return lookup.call(this, name);
        };
        fs.readFileSync = function (file, ...args) {
            if (typeof file === 'string' && path.resolve(file) === shard &&
                new Error().stack.includes('formatTokenRange')) {
                failures++;
                const error = new Error('controlled exact reference shard EIO after eviction');
                error.code = 'EIO'; throw error;
            }
            return read.call(this, file, ...args);
        };
        try {
            const result = await scan();
            assert.equal(failures, 1);
            assert.equal(catalog.status().ready, false);
            assert.equal(result.complete, false);
            assert.deepEqual(result.referenceOccurrences, []);
            assert.deepEqual(result.reasons, ['registry-reference-format-unavailable']);
            assert.ok(result.referenceCoverage.gaps.some(gap => gap.reason === 'registry-reference-format-unavailable' &&
                gap.keyword === `*${keyword}` && gap.startLine === 1 && gap.scope === 'namespaces' &&
                gap.targetKinds.join() === 'set'));
            assert.ok(result.referenceCoverage.gaps.some(gap => gap.reason === 'registry-reference-catalog-unavailable'));
            assert.deepEqual(catalog.referenceRecordsForKeyword(keyword), []); // Failure stays sticky.
            assert.equal(hash(), before);
        } finally {
            fs.readFileSync = read;
            catalog.referenceRecordsForKeyword = lookup;
            runtime.resetSemanticRuntimeCatalogV2ForTesting();
        }
    });

    it('rejects missing or invalid legacy coordinates without treating unknown cells as empty', () => {
        const keyword = 'BOUNDARY_PRESCRIBED_MOTION_SET_SEGMENT_ID';
        const field = keywordSchema.getRenderedCardsForLookup(keywordSchema.lookupKeywordSchema(
            keyword, keywordSchema.loadKeywordSchema(() => 'en')))[0][0];
        const info = getRegistryApprovedFieldReferenceInfo({ keyword, cardIndex: 1, field });
        assert.equal(info.definitionRegistry.selectorSource, 'operational-projection');
        const record = getSemanticRuntimeCatalogV2().referenceRecordsForKeyword(keyword).find(item =>
            item.authoringRelationId === info.definitionRegistry.authoringRelationId);
        const key = info.definitionRegistry.authoringRelationId;
        for (const mode of ['standard', 'long', 'i10', 'comma']) {
            const invalid = mode === 'comma' ? [{ mode: 'comma', fieldIndex: -1 },
                { mode: 'comma', fieldIndex: 0.5 }, { mode: 'fixed', fieldIndex: 0 }]
                : [{ mode: 'fixed', position: -1, width: 10 }, { mode: 'fixed', position: 0, width: 0 },
                    { mode: 'fixed', position: 0.5, width: 10 }, { mode: 'comma', fieldIndex: 0 }];
            for (const coordinate of [undefined, ...invalid]) {
                const formats = { ...record.field.formats, [mode]: coordinate };
                const options = { formatCache: new Map([[key, formats]]), infoCache: new Map(),
                    referenceCatalog: { infoForField: getRegistryApprovedFieldReferenceInfo } };
                assert.equal(formatTokenRange('        42', field, mode, info.definitionRegistry, options, keyword), undefined);
                const result = { complete: true, reasons: [], referenceOccurrences: [], valueDomainOccurrences: [],
                    referenceCoverage: { complete: true, gaps: [] } };
                semanticOccurrence({ block: { keyword: `*${keyword}`, startLine: 0 }, keyword,
                    cardIndex: 1, field, line: '        42', lineIndex: 1, result, options, formatMode: mode });
                assert.equal(result.complete, false);
                assert.deepEqual(result.referenceOccurrences, []);
                assert.equal(result.referenceCoverage.gaps[0].reason, 'registry-reference-format-unavailable');
                assert.deepEqual(result.referenceCoverage.gaps[0].targetKinds, ['set']);
            }
        }
    });

    it('requires every locked representation and preserves exact selected relation identity for formats', () => {
        const catalog = getSemanticRuntimeCatalogV2(), lookup = catalog.referenceRecordsForKeyword;
        const select = (keyword, name) => {
            const cards = keywordSchema.getRenderedCardsForLookup(keywordSchema.lookupKeywordSchema(
                keyword, keywordSchema.loadKeywordSchema(() => 'en')));
            const cardIndex = cards.findIndex(card => card.some(field => field.n === name)) + 1;
            const field = cards[cardIndex - 1].find(item => item.n === name);
            const info = getRegistryApprovedFieldReferenceInfo({ keyword, cardIndex, field });
            const source = info.definitionRegistry.operationalProjection.projectedSourceKeyword;
            return { keyword, field, approved: info.definitionRegistry, records: lookup.call(catalog, source) };
        };
        const representation = select('DATABASE_CROSS_SECTION_SET_ID', 'BSID');
        const option = select('PART_COMPOSITE', 'HGID');
        const alias = select('MAT_SAMP_LIGHT_TITLE', 'LCEMOD');
        const range = (selection, records, approved = selection.approved) => {
            catalog.referenceRecordsForKeyword = function (keyword) {
                return new Error().stack.includes('formatTokenRange') ? records : lookup.call(this, keyword);
            };
            return formatTokenRange(' '.repeat(selection.field.p) + '42'.padStart(selection.field.w),
                selection.field, 'standard', approved, { formatCache: new Map() }, selection.keyword);
        };
        try {
            const ids = representation.approved.operationalProjection.representationAuthoringRelationIds;
            assert.equal(ids.length, 2);
            assert.equal(range(representation, representation.records).raw, '42');
            for (const id of ids) {
                assert.equal(range(representation, representation.records.filter(record => record.authoringRelationId !== id)), undefined);
            }
            const peer = representation.records.find(record => record.authoringRelationId === ids[0]);
            assert.equal(range(representation, [...representation.records, peer]), undefined);
            assert.equal(range(representation, representation.records.map(record => record === peer ? { ...record,
                field: { ...record.field, formats: { ...record.field.formats,
                    long: { ...record.field.formats.long, position: record.field.formats.long.position + 1 } } } } : record)), undefined);
            const selected = option.approved.operationalProjection.selectedAuthoringRelationId;
            assert.ok(option.approved.operationalProjection.excludedAuthoringRelationIds.length > 0);
            assert.equal(range(option, option.records).raw, '42');
            assert.equal(range(option, option.records.filter(record => record.authoringRelationId !== selected)), undefined);
            assert.equal(range(alias, alias.records).raw, '42');
            assert.ok(alias.records.filter(record => record.coordinateId === alias.approved.coordinateId).length > 1);
            assert.equal(range(alias, alias.records, { ...alias.approved, authoringRelationId: undefined }), undefined);
        } finally { catalog.referenceRecordsForKeyword = lookup; }
    });

    it('collects nested shared namespaces once while preserving seeds and cycle protection', () => {
        const branch = { targetKinds: [' node ', 'curve', 'node'],
            targetKeywords: ['*NODE%', '*DEFINE_CURVE'], targetDefinitions: ['*NODE'] };
        const relation = { targetKinds: ['table'], branches: [branch], repeated: branch };
        relation.branches.push(relation);
        const kinds = new Set(['part']), definitions = new Set(['PART']);
        const expected = { targetKinds: ['curve', 'node', 'part', 'table'],
            targetDefinitions: ['DEFINE_CURVE', 'NODE', 'PART'] };
        assert.deepEqual(relationNamespaces(relation, kinds, definitions), expected);
        assert.deepEqual([...kinds].sort(), expected.targetKinds);
        assert.deepEqual([...definitions].sort(), expected.targetDefinitions);
        assert.deepEqual(relationNamespaces(null, kinds, definitions), expected);
        assert.deepEqual(relationNamespaces(relation, undefined, null), {
            targetKinds: ['curve', 'node', 'table'], targetDefinitions: [],
        });
    });
    it('rejects missing or invalid runtime blocker descriptors before scanning', () => {
        const fs = require('node:fs');
        const path = require('node:path');
        const Module = require('node:module');
        const originalDescriptor = require('../../../out/core/references/referenceRuleCatalog')
            .getReferenceRuleCatalog().metadata('lsppBlockedReferences');
        const scannerFile = require.resolve('../../../out/core/references/registryReferenceScanner');
        const source = fs.readFileSync(scannerFile, 'utf8');
        for (const descriptor of [undefined, {}, { file: originalDescriptor.file },
            { ...originalDescriptor, sha256: 'bad' },
            { ...originalDescriptor, file: 7 },
            ...[undefined, 0, -1, '1', 1.5].map(compressedBytes =>
                ({ ...originalDescriptor, compressedBytes }))]) {
            const scanner = new Module(scannerFile, module);
            scanner.filename = scannerFile;
            scanner.paths = Module._nodeModulePaths(path.dirname(scannerFile));
            const originalRequire = scanner.require.bind(scanner);
            let intercepted = 0;
            scanner.require = request => {
                if (request === './referenceRuleCatalog') {
                    return { getReferenceRuleCatalog: () => ({ metadata: name => {
                        assert.equal(name, 'lsppBlockedReferences');
                        intercepted++;
                        return descriptor;
                    } }) };
                }
                return originalRequire(request);
            };
            assert.throws(() => scanner._compile(source, scannerFile), /reference blocker runtime integrity mismatch/);
            assert.equal(intercepted, 1, 'The descriptor fault must reach the actual staged runtime input');
        }
    });

    it('deduplicates coverage gaps in linear work while preserving every affected location', async () => {
        const blocks = Array.from({ length: 1000 }, (_, startLine) => ({ keyword: '*PART', startLine }));
        const record = { reason: 'unverified-test-relation', targetKind: 'part' };
        const referenceCatalog = {
            recordsForKeyword: () => [],
            blockedForKeyword: () => [record, record],
            infoForField: () => null,
        };
        const stringify = JSON.stringify;
        let gapSerializations = 0;
        let scanned;
        JSON.stringify = function (value, ...args) {
            if (value?.reason === 'lspp-unverified-test-relation' && value.scope) gapSerializations++;
            return stringify.call(JSON, value, ...args);
        };
        try {
            scanned = await scanRegistryReferenceOccurrencesFromFileIndex(
                { keywordBlocks: blocks }, async () => '*PART\n', { referenceCatalog },
            );
        } finally { JSON.stringify = stringify; }
        assert.equal(scanned.complete, false);
        assert.equal(scanned.referenceCoverage.complete, false);
        assert.deepEqual(scanned.referenceCoverage.gaps.map(gap => gap.startLine), blocks.map(block => block.startLine));
        assert.ok(scanned.referenceCoverage.gaps.every(gap => gap.scope === 'namespaces' && gap.targetKinds[0] === 'part'));
        assert.ok(gapSerializations <= blocks.length * 2, `${gapSerializations} gap serializations for ${blocks.length} blocks`);
        assert.deepEqual(JSON.parse(JSON.stringify(scanned)).referenceCoverage, scanned.referenceCoverage);
    });

    it('extracts approved reference tokens in standard, I10, long, and comma layouts', async () => {
        const starts = {};
        for (const mode of ['standard', 'i10', 'long', 'comma']) {
            const block = {
                filePath: '/fixture/main.k', keyword: '*PART',
                rawKeyword: `*PART${mode === 'long' ? '+' : mode === 'i10' ? '%' : ''}`,
                startLine: 0, endLine: 2,
            };
            const scanned = await scanBlocks([block], new Map([[0, formattedPartText(mode, -17)]]));
            const occurrence = scanned.referenceOccurrences.find(item => item.fieldName === 'ADPOPT');
            assert.equal(scanned.complete, true, mode);
            assert.equal(occurrence.referenceValue.id, 17, mode);
            starts[mode] = occurrence.startCharacter;
        }
        assert.equal(starts.standard, starts.i10);
        assert.ok(starts.long > starts.standard);
        assert.ok(starts.comma < starts.standard);
    });

    it('resolves exact PID namespaces from sibling PTYPE in every input layout', async function () {
        this.timeout(10_000);
        const cases = [
            ['DEFORMABLE_TO_RIGID', 'PART', 'part', 'PART'],
            ['DEFORMABLE_TO_RIGID', 'PSET', 'part-set', 'SET_PART'],
            ['FATIGUE', '0', 'part', 'PART'],
            ['FATIGUE', '1', 'part-set', 'SET_PART'],
            ['FATIGUE', '2', 'set', 'SET_SOLID'],
            ['FATIGUE', '3', 'set', 'SET_BEAM'],
            ['FATIGUE', '4', 'set', 'SET_SHELL'],
            ['FATIGUE', '5', 'set', 'SET_TSHELL'],
        ];
        for (const mode of ['standard', 'i10', 'long', 'comma']) {
            for (const [keyword, ptype, targetKind, targetDefinition] of cases) {
                const block = { filePath: '/fixture/main.k', keyword: `*${keyword}`,
                    rawKeyword: `*${keyword}${mode === 'long' ? '+' : mode === 'i10' ? '%' : ''}`,
                    startLine: 0, endLine: 1 };
                const result = await scanBlocks([block], new Map([[
                    0, siblingBoundText(keyword, mode, 73, ptype),
                ]]));
                const occurrence = result.referenceOccurrences.find(item => item.fieldName === 'PID');
                assert.equal(result.complete, true, `${keyword}/${ptype}/${mode}`);
                assert.ok(occurrence, `${keyword}/${ptype}/${mode}: PID occurrence missing`);
                assert.equal(occurrence.referenceValue.id, 73, `${keyword}/${ptype}/${mode}`);
                assert.deepEqual(occurrence.targetKinds, [targetKind],
                    `${keyword}/${ptype}/${mode}`);
                assert.deepEqual(occurrence.targetDefinitions, [targetDefinition],
                    `${keyword}/${ptype}/${mode}`);
            }
        }
    });

    it('uses locked PTYPE defaults but fails closed for unknown or parameterized siblings', async () => {
        for (const [keyword, expectedDefinition] of [
            ['DEFORMABLE_TO_RIGID', 'PART'], ['FATIGUE', 'PART'],
        ]) {
            const block = { filePath: '/fixture/main.k', keyword: `*${keyword}`,
                rawKeyword: `*${keyword}`, startLine: 0, endLine: 1 };
            const blank = await scanBlocks([block], new Map([[
                0, siblingBoundText(keyword, 'standard', 73, null),
            ]]));
            assert.equal(blank.complete, true, keyword);
            assert.deepEqual(blank.referenceOccurrences.find(item => item.fieldName === 'PID')
                .targetDefinitions, [expectedDefinition], keyword);
            for (const ptype of ['99', '&PTYPE']) {
                const blocked = await scanBlocks([block], new Map([[
                    0, siblingBoundText(keyword, 'standard', 73, ptype),
                ]]));
                assert.equal(blocked.complete, false, `${keyword}/${ptype}`);
                assert.ok(blocked.reasons.includes(
                    'registry-reference-sibling-discriminator-indeterminate'));
                assert.equal(blocked.referenceOccurrences.some(item => item.fieldName === 'PID'), false);
                assert.equal(blocked.valueDomainOccurrences.find(item => item.fieldName === 'PID')
                    .semantic.state, 'indeterminate');
            }
        }

        const block = { filePath: '/fixture/main.k', keyword: '*FATIGUE',
            rawKeyword: '*FATIGUE', startLine: 0, endLine: 1 };
        const parameter = await scanBlocks([block], new Map([[
            0, siblingBoundText('FATIGUE', 'standard', '&PID', '2'),
        ]]));
        const occurrence = parameter.referenceOccurrences.find(item => item.fieldName === 'PID');
        assert.equal(parameter.complete, true);
        assert.equal(occurrence.semantic.state, 'reference-potential');
        assert.deepEqual(occurrence.targetDefinitions, ['SET_SOLID']);
    });

    it('opens negative LCIDPOR only under the locked CTYPE and POREINI context', async () => {
        for (const mode of ['standard', 'i10', 'long', 'comma']) {
            const positiveBlock = { filePath: '/fixture/main.k',
                keyword: '*CONSTRAINED_LAGRANGE_IN_SOLID',
                rawKeyword: `*CONSTRAINED_LAGRANGE_IN_SOLID${
                    mode === 'long' ? '+' : mode === 'i10' ? '%' : ''}`,
                startLine: 0, endLine: 7 };
            const positive = await scanBlocks([positiveBlock], new Map([[
                0, constrainedLagrangeText(mode, 74, 2, -1),
            ]]));
            assert.equal(positive.complete, true, `${mode}/positive`);
            assert.equal(positive.referenceOccurrences.find(item =>
                item.fieldName === 'LCIDPOR').referenceValue.id, 74);
            for (const [ctype, poreini] of [[11, 0], [11, 0.25], [12, 0], [12, 0.5]]) {
                const block = { filePath: '/fixture/main.k',
                    keyword: '*CONSTRAINED_LAGRANGE_IN_SOLID',
                    rawKeyword: `*CONSTRAINED_LAGRANGE_IN_SOLID${
                        mode === 'long' ? '+' : mode === 'i10' ? '%' : ''}`,
                    startLine: 0, endLine: 7 };
                const result = await scanBlocks([block], new Map([[
                    0, constrainedLagrangeText(mode, -73, ctype, poreini),
                ]]));
                const occurrence = result.referenceOccurrences.find(item =>
                    item.fieldName === 'LCIDPOR');
                assert.equal(result.complete, true, `${mode}/${ctype}/${poreini}`);
                assert.equal(occurrence.referenceValue.id, 73, `${mode}/${ctype}/${poreini}`);
                assert.equal(occurrence.referenceValue.isSignedSwitch, true);
                assert.deepEqual(occurrence.targetKinds, ['curve']);
            }
        }
        for (const [ctype, poreini] of [[2, 0], [4, 1], [11, -0.1], [12, -1]]) {
            const block = { filePath: '/fixture/main.k',
                keyword: '*CONSTRAINED_LAGRANGE_IN_SOLID',
                rawKeyword: '*CONSTRAINED_LAGRANGE_IN_SOLID', startLine: 0, endLine: 7 };
            const result = await scanBlocks([block], new Map([[
                0, constrainedLagrangeText('standard', -73, ctype, poreini),
            ]]));
            assert.equal(result.complete, true, `${ctype}/${poreini}`);
            assert.equal(result.referenceOccurrences.some(item =>
                item.fieldName === 'LCIDPOR'), false);
            assert.equal(result.valueDomainOccurrences.find(item =>
                item.fieldName === 'LCIDPOR').semantic.role, 'context-excluded');
        }
        for (const [ctype, poreini] of [['&CTYPE', 0], [11, '&POREINI']]) {
            const block = { filePath: '/fixture/main.k',
                keyword: '*CONSTRAINED_LAGRANGE_IN_SOLID',
                rawKeyword: '*CONSTRAINED_LAGRANGE_IN_SOLID', startLine: 0, endLine: 7 };
            const result = await scanBlocks([block], new Map([[
                0, constrainedLagrangeText('standard', -73, ctype, poreini),
            ]]));
            assert.equal(result.complete, false, `${ctype}/${poreini}`);
            assert.ok(result.reasons.includes(
                'registry-reference-contextual-predicate-indeterminate'));
            assert.equal(result.referenceOccurrences.some(item =>
                item.fieldName === 'LCIDPOR'), false);
        }
    });

    it('records official PART label references without treating them as unsupported input', async () => {
        const block = {
            filePath: '/fixture/main.k', keyword: '*PART', rawKeyword: '*PART',
            startLine: 0, endLine: 2,
        };
        const result = await scanBlocks([block], new Map([[0, partLabelText()]]));
        const labels = result.referenceOccurrences.filter(item =>
            ['SECID', 'MID', 'TMID'].includes(item.fieldName)
        );
        assert.equal(result.complete, true);
        assert.deepEqual(labels.map(item => [item.fieldName, item.referenceValue.kind,
            item.referenceValue.id]), [
            ['SECID', 'label', 'SEC A'],
            ['MID', 'label', 'HS Steel'],
            ['TMID', 'label', 'THERM A'],
        ]);
    });

    it('keeps an opaque unrelated relation value from invalidating the file scan', async () => {
        const block = {
            filePath: '/fixture/main.k', keyword: '*PART', rawKeyword: '*PART',
            startLine: 0, endLine: 2,
        };
        const result = await scanBlocks([block], new Map([[0, partText('UNKNOWN')]]));
        assert.equal(result.complete, true);
        assert.equal(result.referenceOccurrences.some(item => item.fieldName === 'ADPOPT'), false);
        assert.equal(result.valueDomainOccurrences.find(item => item.fieldName === 'ADPOPT')
            .semantic.role, 'unparsed-input');
    });

    it('retains reference expressions for context-aware binding after physical scanning', async () => {
        const block = { filePath: '/fixture/main.k', keyword: '*LOAD_BODY_Z',
            rawKeyword: '*LOAD_BODY_Z', startLine: 0, endLine: 1 };
        for (const referenceCatalog of [LEGACY_REFERENCE_CATALOG, undefined]) {
            for (const raw of ['<CID>', '<17>', '<min(CID,17)>']) {
                const result = await scanBlocks([block], new Map([[0,
                    `*LOAD_BODY_Z\n${raw},9806,0,0,0,0,0`,
                ]]), undefined, { referenceCatalog });
                const occurrence = result.valueDomainOccurrences.find(item => item.fieldName === 'LCID');
                assert.equal(occurrence.rawValue, raw);
                assert.deepEqual(occurrence.semantic, { state: 'reference-potential', role: 'reference' });
                const reference = result.referenceOccurrences.find(item => item.fieldName === 'LCID');
                assert.equal(reference.referenceValue.kind, 'expression');
                assert.equal(reference.referenceValue.raw, raw);
                assert.equal(result.complete, true);
                assert.deepEqual(result.reasons, []);
                assert.equal(result.referenceCoverage.complete, true,
                    'Physical coverage is complete; binding must still resolve the symbolic value');
            }
        }
    });

    it('retains expressions on the operational coordinate path', () => {
        const result = { complete: true, reasons: [], referenceOccurrences: [],
            valueDomainOccurrences: [], referenceCoverage: { complete: true, gaps: [] } };
        const relation = lsppReferenceRecordsForKeyword('LOAD_BODY_Z')
            .find(record => record.fieldName === 'LCID');
        assert.ok(relation);
        scanOperationalBlock({
            block: { filePath: '/fixture/operational.k', keyword: '*LOAD_BODY_Z', startLine: 3 },
            text: '*LOAD_BODY_Z\n<CID>,9806,0,0,0,0,0', relations: [relation], result,
            formatMode: 'standard', options: { infoCache: new Map(),
                referenceCatalog: { infoForField: getCatalogFieldReferenceInfo },
                maxReferenceOccurrences: 100, maxValueDomainOccurrences: 100 },
        });
        assert.deepEqual(result.valueDomainOccurrences[0].semantic,
            { state: 'reference-potential', role: 'reference' });
        assert.equal(result.referenceOccurrences[0].referenceValue.kind, 'expression');
        assert.equal(result.referenceOccurrences[0].lineIndex, 4);
        assert.deepEqual(result.referenceCoverage.gaps, []);
        assert.equal(result.complete, true);
    });

    it('keeps comma-bearing expressions within their original physical field', () => {
        const line = ' , <min(CID,17)> ,9806,,0';
        assert.equal(commaTokenRange(line, 0), null);
        assert.deepEqual(commaTokenRange(line, 1),
            { raw: '<min(CID,17)>', startCharacter: 3, endCharacter: 16 });
        assert.deepEqual(commaTokenRange(line, 2),
            { raw: '9806', startCharacter: 18, endCharacter: 22 });
        assert.equal(commaTokenRange(line, 3), null);
        assert.deepEqual(commaTokenRange(line, 4),
            { raw: '0', startCharacter: 24, endCharacter: 25 });
        assert.equal(commaTokenRange(line, 5), null);
    });

    it('projects only actionable approved coordinates through exact Registry selectors', () => {
        const records = Object.values(registry.byKeyword).flat();
        const byCoordinate = new Map();
        for (const record of records.filter(item => item.kind !== 'entity-definition')) {
            if (!byCoordinate.has(record.coordinateId)) byCoordinate.set(record.coordinateId, []);
            byCoordinate.get(record.coordinateId).push(record);
        }
        assert.equal(byCoordinate.size, 72);
        let actionable = 0;
        let blocked = 0;
        for (const coordinateRecords of byCoordinate.values()) {
            const chosen = coordinateRecords.find(record => record.kind === 'value-branch') ||
                coordinateRecords.find(record => record.kind === 'entity-reference');
            const field = chosen.field;
            const info = getRegistryApprovedFieldReferenceInfo({
                keyword: field.keyword,
                cardIndex: field.cardIndex,
                field: {
                    n: field.fieldName,
                    t: field.fieldType,
                    p: field.position,
                    w: field.width,
                },
            });
            if (!info) {
                blocked += 1;
                continue;
            }
            actionable += 1;
            assert.equal(info.definitionRegistry.sourceRuleId, chosen.sourceRuleId);
            const raw = (chosen.relation.branches || []).some(branch =>
                branch.role === 'reference' && branch.when?.op === 'lt'
            ) ? '-1' : '1';
            const reference = parseFieldReferenceValue(raw, info);
            assert.ok(reference, `${chosen.coordinateId}:${field.fieldName}`);
        }
        assert.ok(actionable > 0, 'fixture must retain actionable exact coordinates');
        assert.ok(blocked > 0, 'fixture must cover fail-closed namespace mismatches');
    });

    it('scans every approved manual supplemental field from a generated physical block', async function () {
        this.timeout(120_000); // Generates and checks all 2,732 blocks; not an interactive latency budget.
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const runtime = getSemanticRuntimeCatalogV2();
        const keywords = new Set(runtime.allReferenceRecords().map(record => record.field.keyword));
        const physical = new Set();
        const expected = new Set();
        const blocks = [];
        const texts = new Map();
        let nextLine = 0;
        const safeReferenceValue = info => {
            const candidates = new Set([-1_000_001, -1_001, -100, -10, -2, -1,
                1, 2, 10, 100, 1_001, 1_000_001]);
            const collect = value => {
                if (!value || typeof value !== 'object') return;
                if (Number.isFinite(value.value)) {
                    candidates.add(value.value);
                    candidates.add(value.value - 1);
                    candidates.add(value.value + 1);
                }
                for (const child of Object.values(value)) collect(child);
            };
            collect(info.relation);
            return [...candidates].find(value => value !== 0 && Number.isSafeInteger(value) &&
                parseFieldReferenceValue(String(value), info));
        };
        for (const keyword of keywords) {
            const lookup = keywordSchema.lookupKeywordSchema(keyword, schema);
            if (!lookup) continue;
            const rendered = keywordSchema.getRenderedCardsForLookup(lookup);
            for (let cardOffset = 0; cardOffset < rendered.length; cardOffset++) {
                for (let fieldIndex = 0; fieldIndex < rendered[cardOffset].length; fieldIndex++) {
                    const field = rendered[cardOffset][fieldIndex];
                    const coordinate = [keyword, cardOffset + 1, fieldIndex,
                        field.n, field.t, field.p, field.w].join('|');
                    if (physical.has(coordinate)) continue;
                    physical.add(coordinate);
                    const info = getRegistryApprovedFieldReferenceInfo({
                        keyword, cardIndex: cardOffset + 1, field,
                    });
                    if (!info) continue;
                    const raw = safeReferenceValue(info);
                    assert.notEqual(raw, undefined, `${coordinate}: no safe reference fixture value`);
                    const lines = [keyword,
                        ...rendered.slice(0, cardOffset + 1).map((card, index) => {
                            const line = ''.padEnd(200).split('');
                            const first = card[0];
                            if (first) {
                                const firstInfo = getRegistryApprovedFieldReferenceInfo({ keyword,
                                    cardIndex: index + 1, field: first });
                                line.splice(first.p, first.w, ...String(firstInfo ? safeReferenceValue(firstInfo) : 0).padStart(first.w));
                            }
                            else line[0] = '0';
                            return line.join('');
                        })];
                    const data = lines[cardOffset + 1].split('');
                    data.splice(field.p, field.w, ...String(raw).padStart(field.w));
                    lines[cardOffset + 1] = data.join('');
                    const startLine = nextLine;
                    nextLine += lines.length + 1;
                    blocks.push({ filePath: '/fixture/all-actionable.k',
                        keyword, rawKeyword: keyword,
                        startLine, endLine: startLine + lines.length - 1 });
                    texts.set(startLine, lines.join('\n'));
                    expected.add(info.definitionRegistry.coordinateId);
                }
            }
        }

        const result = await scanBlocks(blocks, texts);
        assert.equal(result.complete, true, JSON.stringify({ reasons: result.reasons,
            indeterminate: result.valueDomainOccurrences.filter(item => item.semantic.state === 'indeterminate')
                .map(item => [item.keyword, item.cardIndex, item.fieldName, item.rawValue, item.semantic.reason]) }));
        const aliasContract = require('../../fixtures/public-behavior/reference-numbered-alias-contract.json');
        for (const coordinate of aliasContract.actionable)
            assert.ok(physical.has(coordinate), `Missing current numbered-alias field: ${coordinate}`);
        // Current frozen schema adds nine actionable fields for each CONSTRAINED spelling.
        assert.equal(aliasContract.actionable.length, 18);
        assert.equal(blocks.length, 2732);
        assert.equal(expected.size, 2731);
        const actual = new Set(result.referenceOccurrences.map(item => item.coordinateId));
        assert.deepEqual(actual, expected,
            `missing actionable coordinates: ${[...expected].filter(id => !actual.has(id)).join(',')}`);
    });

    it('records signed reference and enum branches without merging the value domain', async () => {
        const block = {
            filePath: '/fixture/main.k', keyword: '*PART', rawKeyword: '*PART', startLine: 0, endLine: 2,
        };
        const negative = await scanBlocks([block], new Map([[0, partText(-17)]]));
        const positive = await scanBlocks([block], new Map([[0, partText(2)]]));

        const signed = negative.referenceOccurrences.find(item => item.fieldName === 'ADPOPT');
        assert.equal(negative.complete, true);
        assert.equal(signed.referenceValue.id, 17);
        assert.equal(signed.referenceValue.idTransform, 'abs');
        assert.equal(signed.referenceValue.isSignedSwitch, true);
        assert.equal(signed.sourceRuleId, registry.byKeyword.PART.find(record =>
            record.kind === 'value-branch' && record.field.fieldName === 'ADPOPT'
        ).sourceRuleId);
        assert.equal(
            negative.valueDomainOccurrences.find(item => item.fieldName === 'ADPOPT').semantic.state,
            'reference',
        );
        assert.equal(positive.referenceOccurrences.some(item => item.fieldName === 'ADPOPT'), false);
        assert.equal(
            positive.valueDomainOccurrences.find(item => item.fieldName === 'ADPOPT').semantic.state,
            'non-reference',
        );
        assert.equal(
            positive.valueDomainOccurrences.find(item => item.fieldName === 'ADPOPT').semantic.role,
            'enum',
        );
    });

    it('keeps signed and parameterized branch semantics on the default product scanner', async () => {
        const block = { filePath: '/fixture/main.k', keyword: '*PART', rawKeyword: '*PART', startLine: 0, endLine: 2 };
        for (const raw of [-17, 2, '-&TAB']) {
            const result = await scanBlocks([block], new Map([[0, partText(raw)]]), undefined, { referenceCatalog: undefined });
            const references = result.referenceOccurrences.filter(item => item.fieldName === 'ADPOPT');
            if (raw === 2) { assert.deepEqual(references, []); continue; }
            assert.equal(references.length, 1);
            assert.deepEqual(references[0].targetKinds, ['curve']);
            assert.ok(references[0].sourceRuleId.startsWith('lspp:-4864:'));
            assert.ok(references[0].referenceValue.semanticRelation, 'Retain the value predicate until parameter resolution');
            if (raw === -17) {
                assert.equal(references[0].referenceValue.id, 17);
                assert.equal(references[0].referenceValue.idTransform, 'abs');
            } else {
                assert.equal(references[0].referenceValue.kind, 'parameter');
                assert.equal(references[0].semantic.state, 'reference-potential');
            }
        }
    });

    it('scans a concrete LOAD_BODY family occurrence with its approved curve namespace', async () => {
        const block = {
            filePath: '/fixture/main.k', keyword: '*LOAD_BODY_Z', rawKeyword: '*LOAD_BODY_Z',
            startLine: 0, endLine: 1,
        };
        const result = await scanBlocks([block], new Map([[0, loadBodyText(1000001)]]));
        const occurrence = result.referenceOccurrences.find(item => item.fieldName === 'LCID');

        assert.equal(result.complete, true);
        assert.equal(occurrence.referenceValue.id, 1000001);
        assert.deepEqual(occurrence.targetKinds, ['curve']);
        assert.deepEqual(occurrence.targetDefinitions, ['DEFINE_CURVE']);
        assert.equal(occurrence.sourceRuleId, registry.byKeyword.LOAD_BODY_Z.find(record =>
            record.kind === 'entity-reference' && record.field.fieldName === 'LCID'
        ).sourceRuleId);
    });

    it('scans LOAD_BODY_PARTS PSID with the corrected SET_PART namespace', async () => {
        const block = {
            filePath: '/fixture/main.k', keyword: '*LOAD_BODY_PARTS', rawKeyword: '*LOAD_BODY_PARTS',
            startLine: 0, endLine: 1,
        };
        const result = await scanBlocks([block], new Map([[0, loadBodyPartsText(1000001)]]));
        const occurrence = result.referenceOccurrences.find(item => item.fieldName === 'PSID');
        const approved = registry.byKeyword.LOAD_BODY_PARTS.find(record =>
            record.kind === 'entity-reference' && record.field.fieldName === 'PSID');

        assert.equal(result.complete, true);
        assert.equal(occurrence.referenceValue.id, 1000001);
        assert.deepEqual(occurrence.targetKinds, ['part-set']);
        assert.deepEqual(occurrence.targetDefinitions, ['SET_PART']);
        assert.equal(occurrence.sourceRuleId, approved.sourceRuleId);
    });

    it('preserves parameter-controlled signed references for occurrence-aware resolution', async () => {
        const block = {
            filePath: '/fixture/main.k', keyword: '*PART', rawKeyword: '*PART', startLine: 0, endLine: 2,
        };
        const result = await scanBlocks([block], new Map([[0, partText('-&LCID')]]));
        const occurrence = result.referenceOccurrences.find(item => item.fieldName === 'ADPOPT');

        assert.equal(result.complete, true);
        assert.equal(occurrence.referenceValue.kind, 'parameter');
        assert.equal(occurrence.referenceValue.parameterName, 'LCID');
        assert.equal(occurrence.referenceValue.isSignedSwitch, true);
        assert.equal(occurrence.semantic.state, 'reference-potential');
    });

    it('preserves both signed SPD value domains and their co-located reference projections', async () => {
        const block = {
            filePath: '/fixture/main.k', keyword: '*BOUNDARY_FLUX_TRAJECTORY',
            rawKeyword: '*BOUNDARY_FLUX_TRAJECTORY', startLine: 0, endLine: 1,
        };
        const negative = await scanBlocks([block], new Map([[0, fluxText(-17, -18)]]));
        const positive = await scanBlocks([block], new Map([[0, fluxText(17, 18)]]));
        const signed = negative.referenceOccurrences.filter(item => ['SPD1', 'SPD2'].includes(item.fieldName));
        assert.deepEqual(signed.map(item => [item.fieldName, item.referenceValue.id]),
            [['SPD1', 17], ['SPD2', 18]]);
        assert.ok(signed.every(item => item.referenceValue.idTransform === 'abs' &&
            item.targetKinds.includes('curve')));
        assert.deepEqual(negative.valueDomainOccurrences
            .filter(item => ['SPD1', 'SPD2'].includes(item.fieldName))
            .map(item => item.semantic.state), ['reference', 'reference']);
        assert.equal(positive.referenceOccurrences.some(item => ['SPD1', 'SPD2'].includes(item.fieldName)), false);
        assert.deepEqual(positive.valueDomainOccurrences
            .filter(item => ['SPD1', 'SPD2'].includes(item.fieldName))
            .map(item => [item.semantic.state, item.semantic.role]),
        [['non-reference', 'literal'], ['non-reference', 'literal']]);
    });

    it('scans every verified repeated child-table row with fixed token locations', async () => {
        const text = [
            '*DEFINE_TABLE_3D',
            [73, 1, 0].map(value => String(value).padStart(10)).join(''),
            `${String(0).padStart(20)}${String(101).padStart(20)}`,
            `${String(1).padStart(20)}${String(102).padStart(20)}`,
        ].join('\n');
        const block = {
            filePath: '/fixture/main.k', keyword: '*DEFINE_TABLE_3D', rawKeyword: '*DEFINE_TABLE_3D',
            startLine: 0, endLine: 3,
        };
        const table = parseTableBlock(block, text);
        const result = await scanBlocks(
            [block],
            new Map([[0, text]]),
            { curves: [], tables: [table], genericDefinitions: [] },
        );

        assert.equal(result.complete, true);
        assert.deepEqual(
            result.referenceOccurrences.map(item => [item.referenceValue.id, item.lineIndex, item.startCharacter, item.endCharacter]),
            [[101, 2, 37, 40], [102, 3, 37, 40]],
        );
        assert.ok(result.referenceOccurrences.every(item => item.targetKinds.includes('table')));
    });

    it('maps a TITLE table only through the shifted complete card signature', async () => {
        const text = [
            '*DEFINE_TABLE_3D_TITLE',
            'Shifted table title',
            [73, 1, 0].map(value => String(value).padStart(10)).join(''),
            `${String(0).padStart(20)}${String(101).padStart(20)}`,
        ].join('\n');
        const block = {
            filePath: '/fixture/main.k', keyword: '*DEFINE_TABLE_3D_TITLE', rawKeyword: '*DEFINE_TABLE_3D_TITLE',
            startLine: 0, endLine: 3,
        };
        const table = parseTableBlock(block, text);
        const result = await scanBlocks(
            [block], new Map([[0, text]]),
            { curves: [], tables: [table], genericDefinitions: [] },
        );

        assert.equal(result.complete, true);
        assert.equal(result.referenceOccurrences.length, 1);
        assert.equal(result.referenceOccurrences[0].cardIndex, 3);
        assert.equal(result.referenceOccurrences[0].referenceValue.id, 101);
    });

    it('selects repeated table child rows from approved coordinates without a field-name prefilter', async () => {
        const text = [
            '*DEFINE_TABLE_3D',
            [73, 1, 0].map(value => String(value).padStart(10)).join(''),
            `${String(0).padStart(20)}${String(101).padStart(20)}`,
        ].join('\n');
        const block = {
            filePath: '/fixture/main.k', keyword: '*DEFINE_TABLE_3D', rawKeyword: '*DEFINE_TABLE_3D',
            startLine: 0, endLine: 2,
        };
        const table = parseTableBlock(block, text);
        const result = await scanBlocks(
            [block], new Map([[0, text]]),
            { curves: [], tables: [table], genericDefinitions: [] },
        );

        assert.equal(result.complete, true);
        assert.equal(result.referenceOccurrences.length, 1);
        assert.equal(
            uniqueApprovedTableReferenceField.toString().includes('TBID'),
            false,
            'table row selection must not prefilter by a field-name guess',
        );
        assert.equal(result.referenceOccurrences[0].sourceRuleId, 'rule:e5311e8a2db956f9dc6dd393');
        assert.equal(result.referenceOccurrences[0].referenceValue.id, 101);
    });

    it('supports long input and marks bounded-capacity truncation incomplete', async () => {
        const longBlock = {
            filePath: '/fixture/main.k', keyword: '*PART+', rawKeyword: '*PART+', startLine: 0, endLine: 2,
        };
        const long = await scanBlocks([longBlock], new Map([[0, formattedPartText('long', -17)]]));
        assert.equal(long.complete, true);
        assert.equal(long.referenceOccurrences.find(item => item.fieldName === 'ADPOPT').referenceValue.id, 17);

        const block = { ...longBlock, keyword: '*PART', rawKeyword: '*PART' };
        const bounded = await scanBlocks(
            [block],
            new Map([[0, partText(-17)]]),
            undefined,
            { maxValueDomainOccurrences: 1 },
        );
        assert.equal(bounded.complete, false);
        assert.ok(bounded.reasons.includes('registry-value-domain-capacity-exceeded'));
    });
});


describe('coverage gap indexing', function () {
    it('deduplicates in linear work while retaining distinct source locations and first occurrence order', async function () {
        const count = 2000;
        const blocks = Array.from({ length: count }, (_, startLine) => ({
            keyword: '*AUDIT_UNKNOWN', startLine, filePath: 'fixture.key',
        }));
        const stringify = JSON.stringify;
        let gapKeys = 0;
        JSON.stringify = function (value, ...args) {
            if (value?.reason === 'lspp-unverified') gapKeys++;
            return stringify.call(JSON, value, ...args);
        };
        let result;
        try {
            result = await scanRegistryReferenceOccurrencesFromFileIndex(
                { filePath: 'fixture.key', keywordBlocks: [...blocks, ...blocks] },
                async () => '*AUDIT_UNKNOWN\n1',
                { referenceCatalog: {
                    recordsForKeyword: () => [],
                    blockedForKeyword: () => [{ reason: 'unverified' }],
                } },
            );
        } finally { JSON.stringify = stringify; }
        assert.strictEqual(gapKeys, count * 2);
        assert.deepStrictEqual(result.referenceCoverage.gaps.map(g => g.startLine), blocks.map(b => b.startLine));
        assert.strictEqual(result.referenceCoverage.complete, false);
        assert.strictEqual(JSON.stringify(result).includes('coverageKeys'), false);
    });
});


describe('reference data line splitting', () => {
    it('preserves blank card positions and source lines across mixed newline formats', () => {
        const { activeDataEntries }=require('../../../out/core/references/registryReferenceScanner');
        const lines=['*PART','$ comment','title','','123','', '*END','ignored'];
        const expected=[{text:'title',lineIndex:42},{text:'',lineIndex:43},{text:'123',lineIndex:44}];
        for(const separator of ['\n','\r\n','\r']) {
            assert.deepStrictEqual(activeDataEntries({startLine:40},lines.join(separator)),expected);
        }
        assert.deepStrictEqual(activeDataEntries({startLine:40},'*PART\r\n$ comment\rtitle\n\r\n123\r\r*END\nignored'),expected);
    });
});
