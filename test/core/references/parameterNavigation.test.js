'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
const { parameterProject } = require('../../support/parameter-project.cjs');
const { parameterNavigation } = require('../../../out/core/references/parameterNavigation');
const { visibleParameters, parameterBindingId } = require('../../../out/core/references/visibleParameters');
const root = path.resolve('main.k'), child = path.resolve('child.k'), leaf = path.resolve('leaf.k');
const edge = (fromFile, filePath, line, occurrenceId) => ({ fromFile, filePath, keywordLine: line,
    lineIndex: line + 1, keyword: '*INCLUDE', occurrenceId, fileName: path.basename(filePath) });
const query = (data, opts = {}, token, reader) => parameterNavigation(data.index, data.fileIndexes,
    { filePath: root, line: 1, character: 2, name: 'base', declaration: true, references: true,
        includeDeclaration: true, ...opts }, token, reader || data.scanBlockLines);
describe('parameter references by name and definitions by effective binding', () => {
    it('separates case-only names across files, bare expressions and ampersand references', async () => {
        const data = await parameterProject(root, new Map([[root,
            '*PARAMETER\nRfoo,2\nRFOO,8\n*INCLUDE\nchild.k\n*END'], [child,
            '*PARAMETER_EXPRESSION\nRsum,foo+FOO\n*NODE\n1,&foo,&FOO,0\n*END']]),
        [edge(root, child, 3, 'child')]);
        for (const [name, declarationLine, column] of [['foo', 1, 6], ['FOO', 2, 10]]) {
            const definition = await query(data, { filePath: child, line: 1, character: column,
                name, declaration: false, references: false });
            assert.equal(definition.incomplete, false);
            assert.deepEqual(definition.items.map(row => [row.filePath, row.line]), [[root, declarationLine]]);
            const refs = await query(data, { name });
            assert.deepEqual(refs.items.map(row => [row.filePath, row.line, row.startCharacter]),
                [[root, declarationLine, 1], [child, 1, column - 1], [child, 3, name === 'foo' ? 2 : 7]]);
        }
        const missing = await query(data, { filePath: child, line: 3, character: 4,
            name: 'Foo', declaration: false, references: false });
        assert.equal(missing.incomplete, true);
        assert.deepEqual(missing.items, []);
    });
    before(async function () { this.timeout(20000); await parameterProject(root, new Map([[root, '*END']])); });
    it('finds cross-file bare and ampersand references but excludes future and literal text', async () => {
        const data = await parameterProject(root, new Map([[root,
            '*PARAMETER\nRbase,2\n*INCLUDE\nchild.k\n*PARAMETER\nRfuture,3\n*END'], [child,
            '*PARAMETER_EXPRESSION\nRsum,base+1\nClabel,base\n          base\n*NODE\n1,&base,0,0\n2,&future,0,0\n$ &base\n*COMMENT\n&base\n*END']]),
        [edge(root, child, 2, 'child')]);
        const result = await query(data);
        assert.equal(result.incomplete, false);
        assert.deepEqual(result.items.map(x => [x.filePath, x.line]), [[root, 1], [child, 1], [child, 5]]);
        const def = await query(data, { filePath: child, line: 1, character: 6, declaration: false, references: false });
        assert.deepEqual(def.items.map(x => [x.filePath, x.line]), [[root, 1]]);
        const future = await query(data, { filePath: child, line: 6, character: 4, name: 'future', declaration: false, references: false });
        assert.equal(future.incomplete, true); assert.deepEqual(future.items, []);
    });
    it('skips only proven empty shared blocks and retains expression continuations and exact names', async () => {
        const text = '*PARAMETER\nRbase,2\n*NODE\n1,0,0,0\n*PARAMETER_EXPRESSION\nRsum,base\n          +base\n*NODE\n2,&base2,0,0\n3,<base+1>,0,0\n4,&base,0,0\n*END';
        const data = await parameterProject(root, new Map([[root,text]]));
        const blocks = data.fileIndexes.get(root).keywordBlocks;
        blocks.find(block => block.startLine === 2).parameterCandidates = false;
        // Even a marker-free expression block must be parsed for bare names and continuations.
        blocks.find(block => block.startLine === 4).parameterCandidates = false;
        const visited = [];
        const result = await query(data, {}, null, async (block, visit, token) => {
            visited.push(block.startLine);
            return data.scanBlockLines(block, visit, token);
        });
        assert.equal(result.incomplete, false);
        assert.ok(!visited.includes(2));
        assert.ok(visited.includes(4));
        assert.deepEqual(result.items.map(row => row.line), [1,5,6,9,10]);
        data.fileIndexes.get(root).documentVersion = 2;
        let liveReads = 0;
        await query(data, {}, null, async (block, visit, token) => {
            if (block.startLine === 2) liveReads++;
            return data.scanBlockLines(block, visit, token);
        });
        assert.equal(liveReads, 1, 'disk candidate facts cannot suppress live document reads');
        delete data.fileIndexes.get(root).documentVersion;
        delete blocks.find(block => block.startLine === 2).parameterCandidates;
        assert.deepEqual((await query(data)).items, result.items, 'legacy metadata remains conservative');
    });
    it('finds same-name uses across LOCAL scopes without changing definition resolution', async () => {
        const data = await parameterProject(root, new Map([[root,
            '*PARAMETER\nRbase,2\n*INCLUDE\nchild.k\n*NODE\n1,&base,0,0\n*END'], [child,
            '*PARAMETER_LOCAL\nRbase,8\n*NODE\n1,&base,0,0\n*END']]), [edge(root, child, 2, 'child')]);
        assert.deepEqual((await query(data)).items.map(x => [x.filePath, x.line]), [[root, 1], [root, 5], [child, 1], [child, 3]]);
        assert.deepEqual((await query(data, { filePath: child })).items.map(x => [x.filePath, x.line]), [[root, 1], [root, 5], [child, 1], [child, 3]]);
    });
    it('finds an accepted global redefinition even while LOCAL masks it in the defining file', async () => {
        const data = await parameterProject(root, new Map([[root,
            '*PARAMETER_MUTABLE\nRbase,2\n*INCLUDE\nchild.k\n*NODE\n1,&base,0,0\n*END'], [child,
            '*PARAMETER_LOCAL\nRbase,8\n*PARAMETER\nRbase,3\n*NODE\n1,&base,0,0\n*END']]), [edge(root, child, 2, 'child')]);
        const result = await query(data, { filePath: child, line: 3 });
        assert.equal(result.incomplete, false);
        assert.deepEqual(result.items.map(x => [x.filePath, x.line]), [[root, 1], [root, 5], [child, 1], [child, 3], [child, 5]]);
    });
    it('binds a MUTABLE replacement expression to the previous value, later uses to the new definition', async () => {
        const data = await parameterProject(root, new Map([[root,
            '*PARAMETER_MUTABLE\nRbase,2\n*PARAMETER_EXPRESSION\nRbase,base+1\n*NODE\n1,&base,0,0\n*END']]));
        assert.deepEqual((await query(data)).items.map(x => x.line), [1, 3, 3, 5]);
        assert.deepEqual((await query(data, { line: 3 })).items.map(x => x.line), [1, 3, 3, 5]);
        assert.deepEqual((await query(data, { line: 5, character: 4, declaration: false, references: false })).items.map(x => x.line), [3]);
    });
    it('keeps the old binding through every continuation and honours long-format token positions', async () => {
        const data = await parameterProject(root, new Map([[root,
            '*KEYWORD LONG=Y\n*PARAMETER_MUTABLE\n' + 'Rbase'.padEnd(20) + '2\n*PARAMETER_EXPRESSION\n' +
            'Rbase'.padEnd(20) + 'base\n' + ' '.repeat(20) + '+base\n*NODE\n1,&base,0,0\n*END']]));
        assert.deepEqual((await query(data, { line: 2 })).items.map(x => x.line), [2, 4, 4, 5, 7]);
        assert.deepEqual((await query(data, { line: 4 })).items.map(x => x.line), [2, 4, 4, 5, 7]);
        const definition = await query(data, { line: 5, character: 22, declaration: false, references: false });
        assert.equal(definition.items[0].line, 2); assert.equal(definition.items[0].startCharacter, 1);
    });
    it('retains repeated ancestor identity, even with the same leaf and value', async () => {
        const data = await parameterProject(root, new Map([[root, '*INCLUDE\nchild.k\n*INCLUDE\nchild.k\n*END'],
            [child, '*INCLUDE\nleaf.k\n*END'], [leaf, '*PARAMETER_LOCAL\nRbase,2\n*NODE\n1,&base,0,0\n*END']]),
        [edge(root, child, 0, 'first'), edge(root, child, 2, 'second'), edge(child, leaf, 0, 'leaf')]);
        const reads = new Map();
        const result = await query(data, { filePath: leaf }, null, async (block, visit, token) => {
            const key = block.filePath + ':' + block.startLine;
            reads.set(key, (reads.get(key) || 0) + 1);
            return data.scanBlockLines(block, visit, token);
        });
        assert.ok([...reads.values()].every(count => count === 1));
        assert.equal(result.incomplete, false);
        assert.deepEqual(result.items.map(x => [x.filePath, x.line]), [[leaf, 1], [leaf, 3]]);
        const definition = await query(data, { filePath: leaf, line: 3, character: 4, declaration: false, references: false });
        assert.equal(definition.incomplete, true); assert.deepEqual(definition.items, []);
        const visible = await visibleParameters(data.index, leaf, 3, 4);
        assert.equal(new Set(visible.scopes.map(scope => parameterBindingId(scope.get('base')))).size, 2);
        assert.ok(visible.reasons.includes('occurrence-search-path-unavailable'));
    });
    it('deduplicates shared physical locations and preserves definition alternatives', async () => {
        const data = await parameterProject(root, new Map([[root,
            '*PARAMETER_MUTABLE\nRbase,2\n*INCLUDE\nchild.k\n*PARAMETER\nRbase,3\n*INCLUDE\nchild.k\n*END'],
        [child, '*NODE\n1,&base,0,0\n*END']]), [edge(root, child, 2, 'one'), edge(root, child, 6, 'two')]);
        const result = await query(data);
        assert.equal(result.ambiguous, false); assert.deepEqual(result.items.map(x => [x.filePath, x.line]), [[root, 1], [root, 5], [child, 1]]);
        assert.deepEqual((await query(data, { filePath: child, line: 1, character: 4, declaration: false,
            references: false })).items.map(x => x.line), [1, 5]);
    });
    it('fails closed on unknown scope, cancelled input and unavailable live text', async () => {
        const data = await parameterProject(root, new Map([[root, '*PARAMETER\nRbase,2\n*NODE\n1,&base,0,0']]));
        await assert.rejects(query(data, {}, { isCancellationRequested: true }), /cancel/i);
        const token = { isCancellationRequested: false };
        await assert.rejects(query(data, {}, token, async (block, visit) => {
            await data.scanBlockLines(block, visit); token.isCancellationRequested = true; return { complete: true };
        }), /cancel/i);
        data.fileIndexes.get(root).documentVersion = 1;
        const guarded = await parameterNavigation(data.index, data.fileIndexes, {
            filePath: root, line: 1, character: 2, name: 'base', declaration: true,
            references: true, includeDeclaration: false });
        assert.equal(guarded.incomplete, true); assert.deepEqual(guarded.items, []);
        assert.ok(guarded.reasons.includes('parameter-live-source-unavailable'));
        data.index.completenessReasons.push('missing-include');
        const result = await query(data); assert.equal(result.incomplete, true); assert.deepEqual(result.items.map(x => x.line), [1, 3]);
        const definition = await query(data, { references: false });
        assert.equal(definition.incomplete, true); assert.deepEqual(definition.items, []);
    });
    it('marks read failures and output bounds as partial without fabricating complete results', async () => {
        const data = await parameterProject(root, new Map([[root, '*PARAMETER\nRbase,2\n*NODE\n' +
            Array.from({ length: 1100 }, (_, i) => `${i+1},&base,0,0`).join('\n')]]));
        const result = await query(data); assert.equal(result.items.length, 1000); assert.equal(result.incomplete, true);
        const failed = await query(data, {}, null, async () => ({ complete: false, reason: 'on-demand-file-read-failed' }));
        assert.equal(failed.incomplete, true); assert.ok(failed.reasons.includes('on-demand-file-read-failed'));
    });
    it('preserves confirmed locations when semantic work reaches the unchanged budget', async () => {
        const data = await parameterProject(root, new Map([[root, '*PARAMETER\nRbase,2\n*END']]));
        data.fileIndexes.get(root).keywordBlocks = [data.fileIndexes.get(root).keywordBlocks[0], ...Array(500001).fill({ keyword: '*NODE', startLine: 2,
            endLine: 3, parameterCandidates: false })];
        const result = await query(data, {}, null, async (block, visit, token) => { assert.equal(block.startLine, 0); return data.scanBlockLines(block, visit, token); });
        assert.equal(result.incomplete, true);
        assert.ok(result.reasons.includes('parameter-reference-limit'));
        assert.deepEqual(result.items.map(row => row.line), [1]);
    });
    it('rejects a source outside the shared tree and excludes declarations when requested', async () => {
        const data = await parameterProject(root, new Map([[root, '*PARAMETER\nRbase,2\n*NODE\n1,&base,0,0']]));
        const outside = await query(data, { filePath: leaf });
        assert.deepEqual(outside.items, []);
        assert.ok(outside.reasons.includes('parameter-context-unavailable'));
        assert.deepEqual((await query(data, { includeDeclaration: false })).items.map(row => row.line), [3]);
    });
    it('marks a truncated definition alternatives page as incomplete too', async () => {
        const contexts = Array.from({ length: 1001 }, (_, n) => ({ timeline: [], initialBindings: new Map([['base', {
            name: 'base', filePath: path.resolve(`origin-${n}.k`), occurrenceId: String(n), definitionLine: 1,
            definitionStart: 1, definitionLength: 4, sequence: 0,
        }]]) }));
        const result = await parameterNavigation({ completenessReasons: [], parameterContextsByFile: new Map([[root, contexts]]) },
            new Map(), { filePath: root, line: 3, character: 1, name: 'base', declaration: false, references: false });
        assert.equal(result.items.length, 1000); assert.equal(result.incomplete, true); assert.equal(result.ambiguous, true);
    });
});
