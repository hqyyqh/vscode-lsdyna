const assert = require('assert');
const path = require('path');
const {
    buildProjectReferenceIndex,
    resolveReferenceDefinitions,
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
            fileIndexes: new Map([[filePath, {
                referenceDefinitions: {
                    curves: [{ kind: 'curve', id: 1001, filePath, keyword: '*DEFINE_CURVE', startLine: 20, endLine: 22, points: [] }],
                    tables: [table],
                },
            }]]),
        });

        const resolved = attachResolvedTableChildren(table, index);

        assert.notStrictEqual(resolved, table);
        assert.equal(resolved.resolvedChildren.get(1001)[0].keyword, '*DEFINE_CURVE');
    });
});
