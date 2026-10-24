const assert = require('node:assert/strict');
const { entityQueryDiagnosticSummary } = require('../../out/worker/entityQueryDiagnosticSummary');
describe('entity query diagnostic summary', () => {
    it('preserves typed offsets and repeated occurrences without paths or source text', () => {
        const root = 'C:/private/main.k', child = 'C:/private/secret.k';
        const edge = { fromFile: root, filePath: child, fileName: 'secret.k', lineIndex: 12,
            transform: { offsets: { idmoff: { kind: 'numeric', value: 100, raw: '100' },
                idfoff: { kind: 'parameter', raw: '&secretParameter' } }, rawCards: ['sensitive model text'] } };
        const result = entityQueryDiagnosticSummary({ rootFile: root, fileIndexes: new Map([[root, {}], [child, { documentVersion: 3 }]]),
            graph: { includeOccurrences: [edge, edge] } }, { parameterContextsByFile: new Map([[child, [
                { includeOffsets: { idmoff: 100 }, uncertaintyReasons: ['nested-transform-unsupported'] },
                { includeOffsets: { idmoff: 200 } },
            ]]]) });
        assert.equal(result.includes[0].to, result.includes[1].to);
        assert.equal(result.includes[0].transform.offsets.idmoff.value, 100);
        assert.equal(result.includes[0].transform.offsets.idfoff.kind, 'parameter');
        assert.deepEqual(result.contexts.map(row => row.offsets.idmoff), [100, 200]);
        assert.equal(result.sources[1].source, 'editor');
        assert(!/private|secret|sensitive|rawCards/.test(JSON.stringify(result)));
    });
    it('bounds records and explicitly reports truncation', () => {
        const result = entityQueryDiagnosticSummary({ rootFile: '/root.k', fileIndexes: new Map(),
            graph: { includeOccurrences: Array.from({ length: 1000 }, () => ({ fromFile: '/root.k', filePath: '/child.k', lineIndex: 0 })) } });
        assert.equal(result.includes.length, 128); assert.equal(result.includeCount, 1000);
        assert.equal(result.truncated, true);
        require('../../out/shared/indexPages').assertIndexPayload(result);
    });
});
