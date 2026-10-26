'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildProjectReferenceIndex } = require('../../../out/core/references/projectReferenceIndex');
const { scanParameterDefinitionBlock } = require('../../../out/core/references/parameterDefinitionScanner');
const { parameterCompletionPage, visibleParameters } = require('../../../out/core/references/visibleParameters');
const root = path.resolve('main.k'), child = path.resolve('child.k');
const event = (keyword, text, line) => scanParameterDefinitionBlock({ keyword, startLine: line - 1 }, keyword + '\n' + text);
function index(main, local = [], edges = []) {
    return buildProjectReferenceIndex({ rootFile: root, files: [root, ...(edges.length ? [child] : [])],
        graph: { includeOccurrences: edges, includeOccurrencesComplete: true },
        fileIndexes: new Map([[root, { parameterEvents: main }], [child, { parameterEvents: local }]]) });
}
const edge = (line, id) => ({ fromFile: root, filePath: child, keywordLine: line, lineIndex: line + 1,
    occurrenceId: id, keyword: '*INCLUDE', fileName: 'child.k' });

describe('visible parameters at the use position', () => {
    it('preserves spelling and offers distinct case-sensitive bindings with case-insensitive filtering', async () => {
        const data = index([...event('*PARAMETER', 'Rfoo,1', 1),
            ...event('*PARAMETER', 'RFOO,2', 3), ...event('*PARAMETER', 'RFoo,3', 5)]);
        const rows = (await parameterCompletionPage(data, root, 7, 0, 'fO')).items;
        assert.deepEqual(new Map(rows.map(row => [row.name, row.value])),
            new Map([['foo', 1], ['FOO', 2], ['Foo', 3]]));
        assert.ok(rows.every(row => !row.ambiguous));
    });
    before(function () {
        this.timeout(20000); // Cold runtime catalog loading is separate from scope-query assertions.
        index([]);
    });
    it('excludes future definitions and the definition currently being entered', async () => {
        const data = index([...event('*PARAMETER', 'Rfirst,1', 1), ...event('*PARAMETER', 'Rlater,2', 5)]);
        assert.deepEqual((await parameterCompletionPage(data, root, 3, 1, '')).items.map(x => x.name), ['first']);
        assert.deepEqual((await parameterCompletionPage(data, root, 1, 7, '')).items, []);
        assert.equal((await parameterCompletionPage(data, root, 6, 0, 'la')).items[0].value, 2);
    });
    it('preserves the previous mutable value while its replacement expression is being entered', async () => {
        const data = index([...event('*PARAMETER_MUTABLE', 'Rval,2', 1),
            ...event('*PARAMETER_EXPRESSION', 'Rval,val+3', 3)]);
        assert.equal((await parameterCompletionPage(data, root, 3, 8, '')).items[0].value, 2);
        assert.equal((await parameterCompletionPage(data, root, 4, 0, '')).items[0].value, 5);
    });
    it('keeps multiline expressions unavailable until their final segment has been read', async () => {
        const data = index(event('*PARAMETER_EXPRESSION', 'Rval,1\n          +2', 1));
        assert.equal((await parameterCompletionPage(data, root, 2, 11, '')).items.length, 0);
        assert.equal((await parameterCompletionPage(data, root, 3, 0, '')).items[0].value, 3);
    });
    it('applies LOCAL masking inside an Include and restores global visibility afterwards', async () => {
        const data = index(event('*PARAMETER', 'Rval,1', 1), event('*PARAMETER_LOCAL', 'Rval,2', 1), [edge(3, 'child')]);
        const local = (await parameterCompletionPage(data, child, 3, 0, '')).items[0];
        assert.equal(local.value, 2); assert.equal(local.filePath, child); assert.equal(local.line, 1);
        assert.equal((await parameterCompletionPage(data, root, 5, 0, '')).items[0].value, 1);
    });
    it('does not merge different occurrence definitions just because their values match', async () => {
        const data = index([], event('*PARAMETER_LOCAL', 'Rval,2', 1), [edge(1, 'first'), edge(3, 'second')]);
        const row = (await parameterCompletionPage(data, child, 3, 0, '')).items[0];
        assert.equal(row.ambiguous, true); assert.equal(row.value, null); assert.equal(row.filePath, null);
    });
    it('preserves incomplete and unsupported scope states without presenting an empty result as complete', async () => {
        const data = index(event('*PARAMETER', 'Rval,1', 1));
        data.completenessReasons.push('missing-include');
        const result = await parameterCompletionPage(data, root, 5, 0, '');
        assert.deepEqual(result.items, []); assert.equal(result.incomplete, true);
        assert.ok(result.reasons.includes('missing-include'));
        assert.ok((await parameterCompletionPage(data, child, 5, 0, '')).reasons.includes('parameter-context-unavailable'));
    });
    it('does not invent effective values for unsupported expressions or character parameters', async () => {
        const data = index([...event('*PARAMETER_EXPRESSION', 'Rval,unknown(1)', 1), ...event('*PARAMETER', 'Clabel,text', 3)]);
        const rows = (await parameterCompletionPage(data, root, 5, 0, '')).items;
        assert.ok(rows.every(row => row.value === null));
        assert.equal(rows.find(row => row.name === 'label').rawValue, 'text');
    });
    it('does not fabricate a source or an occurrence identity for evaluation-only events', async () => {
        const data = index([{ type: 'definition', name: 'VAL', rawName: 'val', parameterType: 'R',
            lineIndex: 1, valueState: 'real', value: 2, rawValue: '2' }]);
        const result = await parameterCompletionPage(data, root, 3, 0, '');
        assert.deepEqual(result.items, []); assert.equal(result.incomplete, true);
        assert.ok(result.reasons.includes('parameter-definition-source-unavailable'));
    });
    it('bounds output and honours cancellation', async () => {
        const data = index(Array.from({ length: 205 }, (_, i) => event('*PARAMETER', `Rp${i},1`, i * 2 + 1)).flat());
        const result = await parameterCompletionPage(data, root, 500, 0, '');
        assert.equal(result.items.length, 200); assert.equal(result.incomplete, true);
        await assert.rejects(visibleParameters(data, root, 500, 0, { isCancellationRequested: true }), /cancel/i);
    });
});
