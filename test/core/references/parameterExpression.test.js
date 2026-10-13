const assert = require('node:assert/strict');
const { evaluateParameterExpression: evaluate } = require('../../../out/core/references/parameterExpression');
const environment = require('../../../out/core/references/parameterEnvironment');

describe('bounded parameter expressions', () => {
    const calc = source => evaluate(source, () => null);
    it('honors numeric types, power precedence and Fortran rounding', () => {
        for (const [source, value] of [['2/5', 0], ['2.0/5', .4], ['-2**2', -4], ['2**3**2', 512],
            ['nint(-2.5)', -3], ['aint(-2.9)', -2], ['mod(-7,3)', -1], ['sqrt(9)+abs(-2)', 5]]) {
            const result = calc(source);
            assert.equal(result.resolved, true, source);
            assert.equal(result.value, value, source);
        }
        assert.equal(calc('2.0/5').valueState, 'real');
        assert.equal(calc('2*pi').value, 2 * Math.PI);
    });
    it('rejects invalid, unsafe, unsupported and excessive input without executing it', () => {
        for (const source of ['1/0', 'sqrt(-1)', '9007199254740992', 'process.exit()', 'min(1,2,3)',
            '('.repeat(65) + '1' + ')'.repeat(65), '1'.repeat(17000)]) {
            assert.equal(calc(source).resolved, false, source.slice(0, 60));
        }
        assert.equal(calc('unknown+1').reason, 'parameter-undefined');
    });
    it('evaluates chains once in definition order and preserves old values on redefinition', () => {
        const state = environment.createParameterRuntimeState();
        environment.enterParameterFile(state, 'root', 'main.k');
        const define = (name, source) => environment.applyParameterEvent(state, {
            type: 'definition', name, rawName: name, rawValue: source, expression: true,
            parameterType: 'R', valueState: 'unknown', mutable: true,
        });
        define('A', '2.0');
        for (let i = 0; i < 8; i++) define('P' + i, (i ? 'P' + (i - 1) : 'A') + '*2');
        const old = environment.snapshotVisibleParameterBindings(state);
        assert.equal(old.get('P7').value, 512);
        define('A', '3.0');
        assert.equal(old.get('A').value, 2);
        assert.equal(environment.snapshotVisibleParameterBindings(state).get('P7').value, 512);
        define('LATER', 'MISSING+1');
        define('MISSING', '1');
        assert.equal(environment.snapshotVisibleParameterBindings(state).get('LATER').valueState, 'unknown');
        define('SELF', 'SELF+1');
        assert.equal(environment.snapshotVisibleParameterBindings(state).get('SELF').reason, 'parameter-cycle');
    });
    it('invalidates cached expressions by binding identity and honors cancellation even on cache hits', () => {
        let binding = { value: 2, valueState: 'real' };
        const lookup = () => binding;
        assert.equal(evaluate('A*2', lookup).value, 4);
        assert.equal(evaluate('A*2', lookup, { token: { isCancellationRequested: true } }).reason,
            'parameter-evaluation-cancelled');
        binding = { value: 3, valueState: 'real' };
        assert.equal(evaluate('A*2', lookup).value, 6);
        binding = { value: 1, valueState: 'real', dependencyDepth: 64 };
        assert.equal(evaluate('A*2', lookup).reason, 'parameter-evaluation-budget');
    });
    it('resolves parsed expression cards through the same positional environment used by fields', () => {
        const { scanParameterDefinitionBlock } = require('../../../out/core/references/parameterDefinitionScanner');
        const { buildProjectReferenceIndex, analyzeNumericParameterValueAtLocation } =
            require('../../../out/core/references/projectReferenceIndex');
        const file = require('node:path').resolve('parameter-expression.k');
        const events = scanParameterDefinitionBlock({ keyword: '*PARAMETER_EXPRESSION', startLine: 0 },
            '*PARAMETER_EXPRESSION\nRbase,2.0\nRderived,base*3\nRnext,derived/4\n');
        assert.equal(events.length, 3);
        const index = buildProjectReferenceIndex({ rootFile: file, files: [file],
            graph: { includeOccurrences: [], includeOccurrencesComplete: true },
            fileIndexes: new Map([[file, { parameterEvents: events, referenceDefinitions: { curves: [], tables: [] } }]]) });
        const at = lineIndex => ({ documentPath: file, lineIndex });
        assert.equal(analyzeNumericParameterValueAtLocation(index, '&next', at(4)).value, 1.5);
        assert.equal(analyzeNumericParameterValueAtLocation(index, '<next+0.5>', at(4)).value, 2);
        assert.equal(analyzeNumericParameterValueAtLocation(index, '&next', at(1)).resolved, false);
    });
    it('yields during a large environment build and does not cache a cancelled partial index', async () => {
        const { EntityReferenceQueryService } = require('../../../out/core/references/entityReferenceQueryService');
        const { analyzeNumericParameterValueAtLocation } = require('../../../out/core/references/projectReferenceIndex');
        const file = require('node:path').resolve('many-parameters.k');
        const events = Array.from({ length: 6000 }, (_, i) => ({ type: 'definition', name: 'P' + i,
            rawName: 'P' + i, rawValue: 'sqrt(9)+2.0', expression: true, parameterType: 'R', lineIndex: i + 1 }));
        const snapshot = { rootFile: file, files: [file], graph: { includeOccurrences: [] },
            fileIndexes: new Map([[file, { parameterEvents: events, keywordBlocks: [] }]]) };
        const service = new EntityReferenceQueryService(16 * 1024 * 1024);
        await assert.rejects(require('../../../out/core/references/projectReferenceIndex')
            .buildProjectReferenceIndexAsync(snapshot, undefined, 1024), /build budget/);
        const token = { isCancellationRequested: false };
        setImmediate(() => { token.isCancellationRequested = true; });
        await assert.rejects(service.indexAsync(snapshot, token), error => error.name === 'CancellationError');
        assert.equal(service.cacheStats().entries, 0);
        const [first, second] = await Promise.all([service.indexAsync(snapshot), service.indexAsync(snapshot)]);
        assert.equal(first, second);
        assert.equal(analyzeNumericParameterValueAtLocation(first, '&P5999', {documentPath:file,lineIndex:6001}).value, 5);
        service.clear();
    });
});
