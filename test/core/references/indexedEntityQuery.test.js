'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
const {
    indexedEntityKinds,
    normalizeIndexedEntityId,
    queryIndexedEntityId,
} = require('../../../src/core/references/indexedEntityQuery');

describe('indexedEntityQuery', () => {
    it('normalizes positive integer and bounded alphanumeric identities', () => {
        assert.equal(normalizeIndexedEntityId(' 2000101 '), 2000101);
        assert.equal(normalizeIndexedEntityId('+17'), 17);
        assert.equal(normalizeIndexedEntityId('MAT_LABEL_1'), 'MAT_LABEL_1');
        assert.equal(normalizeIndexedEntityId('0'), null);
        assert.equal(normalizeIndexedEntityId('-1'), null);
        assert.equal(normalizeIndexedEntityId('&MID'), null);
        assert.ok(indexedEntityKinds().includes('material'));
        assert.ok(indexedEntityKinds().includes('curve'));
    });

    it('does not backfill an unresolved LS-PrePost PART/MID relationship from another source', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-indexed-entity-'));
        const filePath = path.join(tempRoot, 'large.key');
        fs.writeFileSync(filePath, [
            '*KEYWORD',
            '*DEFINE_CURVE',
            '   2000101         0',
            '       0.0       1.0',
            '*LOAD_BODY_Z',
            '   2000101       1.0',
            '*PART',
            'material part',
            '         1         1   2000101         0         0         0         0         0',
            '*MAT_ELASTIC',
            '   20001011.82900E-9     300.0       0.3       0.0       0.0       0.0',
            '*END',
        ].join('\n'), 'utf8');

        try {
            const fileIndex = await buildFileIndex(filePath);
            const result = await queryIndexedEntityId({
                snapshot: {
                    scope: 'single-file',
                    rootFile: filePath,
                    files: [filePath],
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                    fileIndexes: new Map([[filePath, fileIndex]]),
                },
                id: 2000101,
                targetKind: 'material',
            });

            assert.equal(result.state, 'partial', JSON.stringify(result.reasons));
            assert.equal(result.scope, 'single-file');
            assert.deepEqual(
                result.locations.map(location => ({
                    role: location.role,
                    keyword: location.keyword,
                    fieldName: location.fieldName,
                    line: location.line,
                })),
                [
                    { role: 'definition', keyword: '*MAT_ELASTIC', fieldName: 'MID', line: 10 },
                ],
            );
            assert.ok(result.reasons.some(reason => reason.includes(
                'lspp-link-code-multi-target')));
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('continues definition lookup when explicit reference coverage is incomplete', async () => {
        const filePath = path.resolve('indexed-entity', 'incomplete.k');
        const result = await queryIndexedEntityId({
            snapshot: {
                scope: 'single-file',
                rootFile: filePath,
                files: [filePath],
                graph: { includeOccurrences: [] },
                fileIndexes: new Map([[filePath, {
                    parameterEvents: [],
                    referenceDefinitions: { curves: [], tables: [], genericDefinitions: [] },
                    registryReferences: {
                        complete: false,
                        reasons: ['registry-reference-capacity-exceeded'],
                        referenceOccurrences: [],
                        valueDomainOccurrences: [],
                    },
                }]]),
            },
            id: 2000101,
            targetKind: 'material',
            scanDefinitions: async () => ({
                state: 'complete',
                definitions: [{ filePath, idLine: 4, idStartChar: 0, idEndChar: 7,
                    keyword: '*MAT_ELASTIC', fieldName: 'ID' }],
                reasons: [],
            }),
        });

        assert.equal(result.state, 'partial');
        assert.deepEqual(result.locations.map(location => location.role), ['definition']);
        assert.ok(result.reasons.some(reason => reason.includes('registry-reference-capacity-exceeded')));
    });

    it('injects the caller block reader into on-demand definition scanning', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-indexed-reader-'));
        const filePath = path.join(tempRoot, 'reader.key');
        fs.writeFileSync(filePath, '*MAT_ELASTIC\n         1\n', 'utf8');
        const marker = async () => ({ complete: true, lineCount: 0 });
        let received = null;
        try {
            const fileIndex = await buildFileIndex(filePath);
            const query = await queryIndexedEntityId({
                snapshot: {
                    scope: 'single-file', rootFile: filePath, files: [filePath],
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                    fileIndexes: new Map([[filePath, fileIndex]]),
                },
                id: 1,
                targetKind: 'material',
                scanBlockLines: marker,
                scanDefinitions: async options => {
                    received = options.scanBlockLines;
                    return { state: 'complete', definitions: [], reasons: [] };
                },
            });

            assert.equal(query.state, 'complete');
            assert.strictEqual(received, marker);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('returns verified partial locations without claiming unresolved project occurrences are complete', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-indexed-partial-'));
        const filePath = path.join(tempRoot, 'partial.key');
        fs.writeFileSync(filePath, '*MAT_ELASTIC\n   2000102\n', 'utf8');
        try {
            const fileIndex = await buildFileIndex(filePath);
            const query = await queryIndexedEntityId({
                snapshot: {
                    scope: 'project', rootFile: filePath, files: [filePath],
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                    fileIndexes: new Map([[filePath, fileIndex]]),
                },
                id: 2000102,
                targetKind: 'material',
                collectReferences: (_referenceIndex, _query, options) => {
                    assert.equal(options.retainVerifiedMatchesOnIncomplete, true);
                    return {
                        state: 'partial',
                        locations: [{
                            filePath, line: 8, startCharacter: 23, endCharacter: 30,
                        }],
                        reasons: [
                            `${filePath}:20:transform-offset-unresolved`,
                            `${filePath}:40:transform-offset-unresolved`,
                        ],
                    };
                },
                scanDefinitions: async () => ({
                    state: 'partial',
                    definitions: [{
                        filePath, idLine: 1, idStartChar: 3, idEndChar: 10,
                        keyword: '*MAT_ELASTIC', fieldName: 'ID',
                    }],
                    reasons: ['occurrence-search-path-unavailable'],
                }),
            });

            assert.equal(query.state, 'partial');
            assert.deepEqual(query.locations.map(location => location.role), ['definition', 'reference']);
            assert.deepEqual(query.reasons, [
                'occurrence-search-path-unavailable',
                'transform-offset-unresolved (2 occurrences)',
            ]);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
