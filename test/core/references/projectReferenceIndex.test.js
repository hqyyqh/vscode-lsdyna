const assert = require('assert');
const path = require('path');
const { ProjectGraph } = require('../../../out/core/project/projectGraph');
const {
    buildProjectReferenceIndex,
    resolveReferenceDefinitions,
    analyzeReference,
    analyzeParameterReferenceAtLocation,
    attachResolvedTableChildren,
} = require('../../../out/core/references/projectReferenceIndex');

describe('projectReferenceIndex', () => {
    it('resolves curve and table ids from project file indexes', () => {
        const rootFile = path.resolve('model', 'main.k');
        const childFile = path.resolve('model', 'curves.k');
        const snapshot = {
            rootFile,
            files: [rootFile, childFile],
            fileIndexes: new Map([
                [childFile, {
                    referenceDefinitions: {
                        curves: [{ kind: 'curve', id: 1001, filePath: childFile, keyword: '*DEFINE_CURVE', startLine: 1, endLine: 3, points: [] }],
                        tables: [{ kind: 'table', id: 2001, tableType: '2d', filePath: childFile, keyword: '*DEFINE_TABLE_2D', startLine: 4, endLine: 7, rows: [] }],
                    },
                }],
            ]),
        };

        const index = buildProjectReferenceIndex(snapshot);

        assert.deepEqual(resolveReferenceDefinitions(index, 1001, ['curve']).map(def => def.id), [1001]);
        assert.deepEqual(resolveReferenceDefinitions(index, 2001, ['table']).map(def => def.id), [2001]);
        assert.deepEqual(resolveReferenceDefinitions(index, 2001, ['curve']), []);
    });

    it('preserves duplicate definitions in project file order', () => {
        const fileA = path.resolve('model', 'a.k');
        const fileB = path.resolve('model', 'b.k');
        const makeCurve = filePath => ({ kind: 'curve', id: 7, filePath, keyword: '*DEFINE_CURVE', startLine: 1, endLine: 4, points: [] });
        const index = buildProjectReferenceIndex({
            rootFile: fileA,
            files: [fileA, fileB],
            fileIndexes: {
                [fileA]: { referenceDefinitions: { curves: [makeCurve(fileA)], tables: [] } },
                [fileB]: { referenceDefinitions: { curves: [makeCurve(fileB)], tables: [] } },
            },
        });

        assert.deepEqual(resolveReferenceDefinitions(index, 7, ['curve']).map(def => def.filePath), [fileA, fileB]);
    });

    it('attaches resolved child definitions to table rows', () => {
        const filePath = path.resolve('model', 'main.k');
        const table = {
            kind: 'table',
            id: 2001,
            rows: [{ value: 0.01, valueRaw: '0.01', childId: 1001, childIdRaw: '1001', childKind: 'curve', lineIndex: 10 }],
        };
        const index = buildProjectReferenceIndex({
            rootFile: filePath,
            files: [filePath],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[filePath, {
                referenceDefinitions: {
                    curves: [{ kind: 'curve', id: 1001, filePath, keyword: '*DEFINE_CURVE', startLine: 20, endLine: 22, points: [] }],
                    tables: [table],
                },
            }]]),
        });

        const resolved = attachResolvedTableChildren(table, index);

        assert.notStrictEqual(resolved, table);
        assert.equal(resolved.rows[0].childAnalysis.state, 'exact');
        assert.equal(resolved.rows[0].childAnalysis.definitions[0].keyword, '*DEFINE_CURVE');
    });

    it('resolves generic DEFINE targets by exact keyword when IDs overlap', () => {
        const filePath = path.resolve('model', 'gas.k');
        const cpg = { kind: 'generic', id: 7001, filePath, keyword: '*DEFINE_CPG_GAS_PROPERTIES_TITLE', targetKeyword: 'DEFINE_CPG_GAS_PROPERTIES', startLine: 1, endLine: 2 };
        const cpm = { kind: 'generic', id: 7001, filePath, keyword: '*DEFINE_CPM_GAS_PROPERTIES', startLine: 3, endLine: 4 };
        const index = buildProjectReferenceIndex({
            rootFile: filePath,
            files: [filePath],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[filePath, {
                referenceDefinitions: { curves: [], tables: [], genericDefinitions: [cpg, cpm] },
            }]]),
        });

        assert.deepEqual(
            resolveReferenceDefinitions(index, 7001, [], ['DEFINE_CPG_GAS_PROPERTIES']).map(def => def.keyword),
            ['*DEFINE_CPG_GAS_PROPERTIES_TITLE']
        );
        assert.deepEqual(
            resolveReferenceDefinitions(index, 7001, [], ['DEFINE_CPM_GAS_PROPERTIES']).map(def => def.keyword),
            ['*DEFINE_CPM_GAS_PROPERTIES']
        );
    });

    it('applies a proven table occurrence IDFOFF when resolving child curve rows', () => {
        const index = emptyIndexForTest();
        const childCurve = {
            kind: 'curve',
            id: 1101,
            filePath: path.resolve('model', 'curves.k'),
            keyword: '*DEFINE_CURVE',
            points: [],
        };
        index.curvesById.set(1101, [childCurve]);
        const table = {
            kind: 'table',
            id: 2101,
            sourceId: 2001,
            effectiveId: 2101,
            idfoffOffset: 100,
            rows: [{
                value: 0.01,
                valueRaw: '0.01',
                childId: 1001,
                childIdRaw: '1001',
                childKind: 'curve',
                lineIndex: 10,
            }],
        };

        const resolved = attachResolvedTableChildren(table, index);

        assert.equal(resolved.rows[0].childAnalysis.effectiveChildId, 1101);
        assert.equal(resolved.rows[0].childAnalysis.state, 'exact');
        assert.strictEqual(resolved.rows[0].childAnalysis.definitions[0], childCurve);
    });

    it('preserves ambiguity and incomplete project coverage for table child rows', () => {
        const index = emptyIndexForTest();
        const candidates = [
            { kind: 'curve', id: 1001, filePath: 'a.k', keyword: '*DEFINE_CURVE' },
            { kind: 'curve', id: 1001, filePath: 'b.k', keyword: '*DEFINE_CURVE' },
        ];
        index.curvesById.set(1001, candidates);
        const table = {
            kind: 'table',
            rows: [{
                valueRaw: '0.01',
                childId: 1001,
                childIdRaw: '1001',
                childKind: 'curve',
            }],
        };

        const complete = attachResolvedTableChildren(table, index);
        const localOnly = attachResolvedTableChildren(table, index, { projectScoped: false });

        assert.equal(complete.rows[0].childAnalysis.state, 'ambiguous');
        assert.deepEqual(complete.rows[0].childAnalysis.definitions, candidates);
        assert.equal(localOnly.rows[0].childAnalysis.state, 'uncertain');
        assert.deepEqual(localOnly.rows[0].childAnalysis.definitions, candidates);
        assert.ok(localOnly.rows[0].childAnalysis.reasons.includes('project-scan-unavailable'));
    });

    it('distinguishes uncertain and missing table child rows', () => {
        const index = emptyIndexForTest();
        const parameterizedTable = {
            kind: 'table',
            rows: [{
                valueRaw: '0.01',
                childId: null,
                childIdRaw: '&CID',
                childIdInput: { kind: 'parameter', raw: '&CID', name: 'CID' },
                childKind: 'curve',
            }],
        };
        const missingTable = {
            kind: 'table',
            rows: [{
                valueRaw: '0.01',
                childId: 999,
                childIdRaw: '999',
                childKind: 'curve',
            }],
        };

        const uncertain = attachResolvedTableChildren(parameterizedTable, index);
        const missing = attachResolvedTableChildren(missingTable, index);

        assert.equal(uncertain.rows[0].childAnalysis.state, 'uncertain');
        assert.deepEqual(uncertain.rows[0].childAnalysis.reasons, ['parameter-unresolved']);
        assert.equal(missing.rows[0].childAnalysis.state, 'missing');
        assert.equal(missing.rows[0].childAnalysis.effectiveChildId, 999);
    });

    it('does not treat an unresolved table occurrence offset as zero', () => {
        const index = emptyIndexForTest();
        index.curvesById.set(1001, [{ kind: 'curve', id: 1001 }]);
        const table = {
            kind: 'table',
            idfoffOffset: null,
            rows: [{ childId: 1001, childIdRaw: '1001', childKind: 'curve' }],
        };

        const resolved = attachResolvedTableChildren(table, index);

        assert.equal(resolved.rows[0].childAnalysis.state, 'uncertain');
        assert.ok(resolved.rows[0].childAnalysis.reasons.includes('transform-offset-unresolved'));
    });

    it('resolves the same table row independently for different occurrence offsets', () => {
        const index = emptyIndexForTest();
        const curveA = { kind: 'curve', id: 1101, filePath: 'a.k' };
        const curveB = { kind: 'curve', id: 1201, filePath: 'b.k' };
        index.curvesById.set(1101, [curveA]);
        index.curvesById.set(1201, [curveB]);
        const sourceTable = {
            kind: 'table',
            rows: [{ childId: 1001, childIdRaw: '1001', childKind: 'curve' }],
        };

        const occurrenceA = attachResolvedTableChildren(
            { ...sourceTable, idfoffOffset: 100 },
            index
        );
        const occurrenceB = attachResolvedTableChildren(
            { ...sourceTable, idfoffOffset: 200 },
            index
        );

        assert.equal(occurrenceA.rows[0].childAnalysis.effectiveChildId, 1101);
        assert.strictEqual(occurrenceA.rows[0].childAnalysis.definitions[0], curveA);
        assert.equal(occurrenceB.rows[0].childAnalysis.effectiveChildId, 1201);
        assert.strictEqual(occurrenceB.rows[0].childAnalysis.definitions[0], curveB);
    });

    it('distinguishes exact, ambiguous and missing results on a complete occurrence graph', () => {
        const rootFile = path.resolve('model', 'main.k');
        const childFile = path.resolve('model', 'curves.k');
        const curve = {
            kind: 'curve',
            id: 1001,
            filePath: childFile,
            keyword: '*DEFINE_CURVE',
            startLine: 1,
            endLine: 3,
            points: [],
        };
        const makeSnapshot = includeOccurrences => ({
            rootFile,
            files: [rootFile, childFile],
            graph: { includeOccurrences },
            fileIndexes: new Map([
                [rootFile, { referenceDefinitions: { curves: [], tables: [] } }],
                [childFile, { referenceDefinitions: { curves: [curve], tables: [] } }],
            ]),
        });
        const zeroTransform = {
            offsets: { idfoff: { kind: 'numeric', raw: '0', value: 0 } },
        };
        const oneOccurrence = [{
            occurrenceId: 'root:1',
            fromFile: rootFile,
            filePath: childFile,
            fileName: 'curves.k',
            lineIndex: 1,
            transform: zeroTransform,
        }];
        const exactIndex = buildProjectReferenceIndex(makeSnapshot(oneOccurrence));

        assert.equal(
            analyzeReference(exactIndex, { kind: 'numeric', id: 1001, raw: '1001' }, ['curve']).state,
            'exact'
        );
        assert.equal(
            analyzeReference(exactIndex, { kind: 'numeric', id: 9999, raw: '9999' }, ['curve']).state,
            'missing'
        );

        const ambiguousIndex = buildProjectReferenceIndex(makeSnapshot([
            ...oneOccurrence,
            { ...oneOccurrence[0], occurrenceId: 'root:2', lineIndex: 2 },
        ]));
        const ambiguous = analyzeReference(
            ambiguousIndex,
            { kind: 'numeric', id: 1001, raw: '1001' },
            ['curve']
        );
        assert.equal(ambiguous.state, 'ambiguous');
        assert.equal(ambiguous.definitions.length, 2);
        assert.deepEqual(
            ambiguous.definitions.map(definition => definition.occurrencePath.at(-1)),
            ['root:1', 'root:2']
        );
    });

    it('applies one numeric IDFOFF occurrence and keeps parameterized offsets uncertain', () => {
        const rootFile = path.resolve('model', 'main.k');
        const childFile = path.resolve('model', 'curves.k');
        const makeIndex = idfoff => buildProjectReferenceIndex({
            rootFile,
            files: [rootFile, childFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:1',
                    fromFile: rootFile,
                    filePath: childFile,
                    fileName: 'curves.k',
                    lineIndex: 1,
                    transform: { offsets: { idfoff } },
                }],
            },
            fileIndexes: new Map([
                [rootFile, { referenceDefinitions: { curves: [], tables: [] } }],
                [childFile, {
                    referenceDefinitions: {
                        curves: [{ kind: 'curve', id: 1001, filePath: childFile, keyword: '*DEFINE_CURVE', points: [] }],
                        tables: [],
                    },
                }],
            ]),
        });

        const numericIndex = makeIndex({ kind: 'numeric', raw: '100', value: 100 });
        const numeric = analyzeReference(
            numericIndex,
            { kind: 'numeric', id: 1101, raw: '1101' },
            ['curve']
        );
        assert.equal(numeric.state, 'exact');
        assert.equal(numeric.definitions[0].sourceId, 1001);
        assert.equal(numeric.definitions[0].effectiveId, 1101);
        assert.equal(numeric.definitions[0].idfoffOffset, 100);
        assert.equal(numeric.definitions[0].evidenceRule, 'E-T02');
        assert.equal(
            analyzeReference(
                numericIndex,
                { kind: 'numeric', id: 1001, raw: '1001' },
                ['curve']
            ).state,
            'missing'
        );

        const parameterized = analyzeReference(
            makeIndex({ kind: 'parameter', raw: '&FOFF', name: 'FOFF', negated: false }),
            { kind: 'numeric', id: 1001, raw: '1001' },
            ['curve']
        );
        assert.equal(parameterized.state, 'uncertain');
        assert.ok(parameterized.reasons.includes('transform-offset-unresolved'));
        assert.ok(!parameterized.definitions.length);

        const signedResult = analyzeReference(
            numericIndex,
            { kind: 'numeric', id: 1101, raw: '-1101', isSignedSwitch: true },
            ['curve']
        );
        assert.ok(signedResult.reasons.includes('signed-switch-transform-unverified'));
    });

    it('applies numeric IDFOFF to a reference inside one included occurrence', () => {
        const rootFile = path.resolve('model', 'main.k');
        const childFile = path.resolve('model', 'curves.k');
        const index = buildProjectReferenceIndex({
            rootFile,
            files: [rootFile, childFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:1',
                    fromFile: rootFile,
                    filePath: childFile,
                    fileName: 'curves.k',
                    lineIndex: 1,
                    transform: {
                        offsets: {
                            idfoff: { kind: 'numeric', raw: '100', value: 100 },
                        },
                    },
                }],
            },
            fileIndexes: new Map([
                [rootFile, { referenceDefinitions: { curves: [], tables: [] } }],
                [childFile, {
                    referenceDefinitions: {
                        curves: [{
                            kind: 'curve',
                            id: 1001,
                            filePath: childFile,
                            keyword: '*DEFINE_CURVE',
                            points: [],
                        }],
                        tables: [],
                    },
                }],
            ]),
        });

        const result = analyzeReference(
            index,
            { kind: 'numeric', id: 1001, raw: '1001' },
            ['curve'],
            {
                projectScoped: true,
                documentPath: childFile,
                lineIndex: 5,
            }
        );

        assert.equal(result.state, 'exact');
        assert.equal(result.id, 1101);
        assert.equal(result.sourceId, 1001);
        assert.equal(result.effectiveId, 1101);
        assert.equal(result.offset, 100);
        assert.equal(result.transformResolution.evidenceRule, 'E-T02');
    });

    it('keeps unsafe IDFOFF results uncertain and supports a safe negative offset', () => {
        const rootFile = path.resolve('model', 'main.k');
        const childFile = path.resolve('model', 'curves.k');
        const makeIndex = (sourceId, offset) => buildProjectReferenceIndex({
            rootFile,
            files: [rootFile, childFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:1',
                    fromFile: rootFile,
                    filePath: childFile,
                    fileName: 'curves.k',
                    lineIndex: 1,
                    transform: {
                        offsets: {
                            idfoff: { kind: 'numeric', raw: String(offset), value: offset },
                        },
                    },
                }],
            },
            fileIndexes: new Map([
                [rootFile, { referenceDefinitions: { curves: [], tables: [] } }],
                [childFile, {
                    referenceDefinitions: {
                        curves: [{
                            kind: 'curve',
                            id: sourceId,
                            filePath: childFile,
                            keyword: '*DEFINE_CURVE',
                            points: [],
                        }],
                        tables: [],
                    },
                }],
            ]),
        });

        const negative = analyzeReference(
            makeIndex(1001, -100),
            { kind: 'numeric', id: 901, raw: '901' },
            ['curve']
        );
        assert.equal(negative.state, 'exact');
        assert.equal(negative.definitions[0].effectiveId, 901);

        const unsafe = analyzeReference(
            makeIndex(1001, Number.MAX_SAFE_INTEGER),
            { kind: 'numeric', id: 1001, raw: '1001' },
            ['curve']
        );
        assert.equal(unsafe.state, 'uncertain');
        assert.ok(unsafe.reasons.includes('reference-id-offset-unsafe'));
    });

    it('ignores unrelated typed offsets when IDFOFF is known zero', () => {
        const rootFile = path.resolve('model', 'main.k');
        const childFile = path.resolve('model', 'curves.k');
        const index = buildProjectReferenceIndex({
            rootFile,
            files: [rootFile, childFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:1',
                    fromFile: rootFile,
                    filePath: childFile,
                    fileName: 'curves.k',
                    lineIndex: 1,
                    transform: {
                        offsets: {
                            idnoff: { kind: 'numeric', raw: '500', value: 500 },
                            idfoff: { kind: 'numeric', raw: '0', value: 0 },
                        },
                    },
                }],
            },
            fileIndexes: new Map([
                [rootFile, { referenceDefinitions: { curves: [], tables: [] } }],
                [childFile, {
                    referenceDefinitions: {
                        curves: [{ kind: 'curve', id: 7, filePath: childFile, keyword: '*DEFINE_CURVE', points: [] }],
                        tables: [],
                    },
                }],
            ]),
        });

        assert.equal(
            analyzeReference(index, { kind: 'numeric', id: 7, raw: '7' }, ['curve']).state,
            'exact'
        );
    });

    it('keeps parameterized definitions uncertain only for their target kind', () => {
        const rootFile = path.resolve('model', 'main.k');
        const index = buildProjectReferenceIndex({
            rootFile,
            files: [rootFile],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[rootFile, {
                referenceDefinitions: {
                    curves: [{
                        kind: 'curve',
                        id: null,
                        idRaw: '&CID',
                        idInput: { kind: 'parameter', raw: '&CID', name: 'CID', negated: false },
                        filePath: rootFile,
                        keyword: '*DEFINE_CURVE',
                        points: [],
                    }],
                    tables: [],
                },
            }]]),
        });

        const curveResult = analyzeReference(
            index,
            { kind: 'numeric', id: 7, raw: '7' },
            ['curve']
        );
        const tableResult = analyzeReference(
            index,
            { kind: 'numeric', id: 7, raw: '7' },
            ['table']
        );

        assert.equal(curveResult.state, 'uncertain');
        assert.ok(curveResult.reasons.includes('parameter-unresolved'));
        assert.equal(tableResult.state, 'missing');
    });

    it('treats an unresolved parameter reference as uncertain without numeric lookup', () => {
        const result = analyzeReference(
            emptyIndexForTest(),
            { kind: 'parameter', raw: '-&CID', parameterName: 'CID', isSignedSwitch: true },
            ['curve']
        );

        assert.equal(result.state, 'uncertain');
        assert.deepEqual(result.definitions, []);
        assert.deepEqual(result.reasons, ['parameter-unresolved']);
    });

    it('evaluates integer parameters in include occurrence and input order', () => {
        const rootFile = path.resolve('cases', 'main.k');
        const childFile = path.resolve('cases', 'shared-curves.k');
        const parameterEvent = (lineIndex, value) => ({
            type: 'definition',
            keyword: '*PARAMETER',
            lineIndex,
            sequence: 0,
            name: 'CID',
            rawName: 'CID',
            parameterType: 'I',
            rawValue: String(value),
            value,
            valueState: 'integer',
            reason: null,
            local: false,
            mutable: false,
            expression: false,
        });
        const curve = {
            kind: 'curve',
            id: null,
            idRaw: '&CID',
            idInput: { kind: 'parameter', raw: '&CID', name: 'CID', negated: false },
            filePath: childFile,
            keyword: '*DEFINE_CURVE',
            startLine: 1,
            endLine: 3,
            points: [],
        };
        const index = buildProjectReferenceIndex({
            rootFile,
            files: [rootFile, childFile],
            graph: {
                includeOccurrences: [
                    {
                        occurrenceId: 'root:first',
                        fromFile: rootFile,
                        filePath: childFile,
                        fileName: 'shared-curves.k',
                        keywordLine: 3,
                        lineIndex: 4,
                    },
                    {
                        occurrenceId: 'root:second',
                        fromFile: rootFile,
                        filePath: childFile,
                        fileName: 'shared-curves.k',
                        keywordLine: 7,
                        lineIndex: 8,
                    },
                ],
            },
            fileIndexes: new Map([
                [rootFile, {
                    parameterEvents: [
                        { type: 'duplication', keyword: '*PARAMETER_DUPLICATION', lineIndex: 0, sequence: 0, dflag: 4 },
                        parameterEvent(1, 100),
                        parameterEvent(5, 200),
                    ],
                    referenceDefinitions: { curves: [], tables: [] },
                }],
                [childFile, {
                    parameterEvents: [],
                    referenceDefinitions: { curves: [curve], tables: [] },
                }],
            ]),
        });

        assert.equal(resolveReferenceDefinitions(index, 100, ['curve']).length, 1);
        assert.equal(resolveReferenceDefinitions(index, 200, ['curve']).length, 1);
        assert.equal(resolveReferenceDefinitions(index, 100, ['curve'])[0].occurrencePath.at(-1), 'root:first');
        assert.equal(resolveReferenceDefinitions(index, 200, ['curve'])[0].occurrencePath.at(-1), 'root:second');

        const sharedReference = analyzeParameterReferenceAtLocation(index, 'CID', {
            documentPath: childFile,
            lineIndex: 0,
        });
        assert.equal(sharedReference.resolved, false);
        assert.ok(sharedReference.reasons.includes('parameter-occurrence-ambiguous'));
        assert.deepEqual(sharedReference.results.map(result => result.value), [100, 200]);
    });

    it('keeps parameterized definitions uncertain after unsupported scope control', () => {
        const rootFile = path.resolve('cases', 'scope-control.k');
        const index = buildProjectReferenceIndex({
            rootFile,
            files: [rootFile],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[rootFile, {
                parameterEvents: [
                    {
                        type: 'definition',
                        keyword: '*PARAMETER',
                        lineIndex: 1,
                        sequence: 0,
                        name: 'CID',
                        rawName: 'CID',
                        parameterType: 'I',
                        rawValue: '1001',
                        value: 1001,
                        valueState: 'integer',
                        reason: null,
                        local: false,
                        mutable: false,
                        expression: false,
                    },
                    {
                        type: 'scope-control',
                        keyword: '*PARAMETER_PUSH',
                        lineIndex: 2,
                        sequence: 0,
                    },
                ],
                referenceDefinitions: {
                    curves: [{
                        kind: 'curve',
                        id: null,
                        idRaw: '&CID',
                        idInput: {
                            kind: 'parameter',
                            raw: '&CID',
                            name: 'CID',
                            negated: false,
                        },
                        filePath: rootFile,
                        keyword: '*DEFINE_CURVE',
                        startLine: 3,
                        endLine: 5,
                        points: [],
                    }],
                    tables: [],
                },
            }]]),
        });

        assert.equal(resolveReferenceDefinitions(index, 1001, ['curve']).length, 0);
        const result = analyzeReference(
            index,
            { kind: 'numeric', id: 1001, raw: '1001', isSignedSwitch: false },
            ['curve'],
            { projectScoped: true }
        );
        assert.equal(result.state, 'uncertain');
        assert.ok(result.reasons.includes('parameter-scope-control-unsupported'));
    });

    it('resolves a parameter reference only from the current root input stream', () => {
        const rootFile = path.resolve('cases', 'condition-a.k');
        const curveFile = path.resolve('cases', 'curves-a.k');
        const index = buildProjectReferenceIndex({
            rootFile,
            files: [rootFile, curveFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:curve',
                    fromFile: rootFile,
                    filePath: curveFile,
                    fileName: 'curves-a.k',
                    keywordLine: 5,
                    lineIndex: 6,
                }],
            },
            fileIndexes: new Map([
                [rootFile, {
                    parameterEvents: [{
                        type: 'definition',
                        keyword: '*PARAMETER',
                        lineIndex: 1,
                        sequence: 0,
                        name: 'CID',
                        rawName: 'CID',
                        parameterType: 'I',
                        rawValue: '1001',
                        value: 1001,
                        valueState: 'integer',
                        reason: null,
                        local: false,
                        mutable: false,
                        expression: false,
                    }],
                    referenceDefinitions: { curves: [], tables: [] },
                }],
                [curveFile, {
                    parameterEvents: [],
                    referenceDefinitions: {
                        curves: [{
                            kind: 'curve',
                            id: 1001,
                            filePath: curveFile,
                            keyword: '*DEFINE_CURVE',
                            startLine: 1,
                            endLine: 3,
                            points: [],
                        }],
                        tables: [],
                    },
                }],
            ]),
        });

        const result = analyzeReference(
            index,
            {
                kind: 'parameter',
                raw: '&CID',
                parameterName: 'CID',
                isSignedSwitch: false,
            },
            ['curve'],
            {
                projectScoped: true,
                documentPath: rootFile,
                lineIndex: 3,
            }
        );

        assert.equal(result.state, 'exact');
        assert.equal(result.id, 1001);
        assert.equal(result.parameterResolution.value, 1001);
        assert.equal(result.definitions[0].filePath, curveFile);

        const inheritedParameter = analyzeParameterReferenceAtLocation(index, 'CID', {
            documentPath: curveFile,
            lineIndex: 0,
        });
        assert.equal(inheritedParameter.resolved, true);
        assert.equal(inheritedParameter.value, 1001);
    });

    it('evaluates a parameter only after its definition in input order', () => {
        const rootFile = path.resolve('cases', 'definition-order.k');
        const index = buildProjectReferenceIndex({
            rootFile,
            files: [rootFile],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[rootFile, {
                parameterEvents: [{
                    type: 'definition',
                    keyword: '*PARAMETER',
                    lineIndex: 5,
                    sequence: 0,
                    name: 'CID',
                    rawName: 'CID',
                    parameterType: 'I',
                    rawValue: '77',
                    value: 77,
                    valueState: 'integer',
                    reason: null,
                    local: false,
                    mutable: false,
                    expression: false,
                }],
                referenceDefinitions: { curves: [], tables: [] },
            }]]),
        });

        const before = analyzeParameterReferenceAtLocation(index, 'CID', {
            documentPath: rootFile,
            lineIndex: 3,
        });
        const after = analyzeParameterReferenceAtLocation(index, '&cid', {
            documentPath: rootFile,
            lineIndex: 6,
        });

        assert.equal(before.resolved, false);
        assert.ok(before.reasons.includes('parameter-unresolved'));
        assert.equal(after.resolved, true);
        assert.equal(after.value, 77);
    });

    it('does not expose a LOCAL child parameter after returning to the parent file', () => {
        const rootFile = path.resolve('cases', 'local-scope-main.k');
        const childFile = path.resolve('cases', 'local-scope-child.k');
        const index = buildProjectReferenceIndex({
            rootFile,
            files: [rootFile, childFile],
            graph: {
                includeOccurrences: [{
                    occurrenceId: 'root:local-child',
                    fromFile: rootFile,
                    filePath: childFile,
                    fileName: 'local-scope-child.k',
                    keywordLine: 2,
                    lineIndex: 3,
                }],
            },
            fileIndexes: new Map([
                [rootFile, {
                    parameterEvents: [],
                    referenceDefinitions: { curves: [], tables: [] },
                }],
                [childFile, {
                    parameterEvents: [{
                        type: 'definition',
                        keyword: '*PARAMETER_LOCAL',
                        lineIndex: 1,
                        sequence: 0,
                        name: 'CID',
                        rawName: 'CID',
                        parameterType: 'I',
                        rawValue: '55',
                        value: 55,
                        valueState: 'integer',
                        reason: null,
                        local: true,
                        mutable: false,
                        expression: false,
                    }],
                    referenceDefinitions: { curves: [], tables: [] },
                }],
            ]),
        });

        const insideChild = analyzeParameterReferenceAtLocation(index, 'CID', {
            documentPath: childFile,
            lineIndex: 2,
        });
        const afterInclude = analyzeParameterReferenceAtLocation(index, 'CID', {
            documentPath: rootFile,
            lineIndex: 4,
        });

        assert.equal(insideChild.resolved, true);
        assert.equal(insideChild.value, 55);
        assert.equal(afterInclude.resolved, false);
        assert.ok(afterInclude.reasons.includes('parameter-unresolved'));
    });

    it('falls back to uncertain for legacy graphs without occurrence data', () => {
        const rootFile = path.resolve('model', 'main.k');
        const legacyGraph = ProjectGraph.fromJSON({
            children: [[rootFile, []]],
            includeEntries: [[rootFile, []]],
            parents: [[rootFile, []]],
        });
        const index = buildProjectReferenceIndex({
            rootFile,
            files: [rootFile],
            graph: legacyGraph,
            fileIndexes: new Map([[rootFile, {
                referenceDefinitions: {
                    curves: [{ kind: 'curve', id: 7, filePath: rootFile, keyword: '*DEFINE_CURVE', points: [] }],
                    tables: [],
                },
            }]]),
        });
        const analysis = analyzeReference(
            index,
            { kind: 'numeric', id: 7, raw: '7' },
            ['curve'],
            { projectScoped: true }
        );

        assert.equal(legacyGraph.includeOccurrencesComplete, false);
        assert.equal(analysis.state, 'uncertain');
        assert.ok(analysis.reasons.includes('project-scan-unavailable'));
        assert.equal(analysis.definitions.length, 1);
    });
});

function emptyIndexForTest() {
    return buildProjectReferenceIndex({
        rootFile: path.resolve('model', 'main.k'),
        files: [],
        graph: { includeOccurrences: [] },
        fileIndexes: new Map(),
    });
}
