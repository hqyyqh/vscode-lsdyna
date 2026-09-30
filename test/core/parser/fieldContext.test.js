const assert = require('assert');
const { fakeDoc } = require('../../helpers');
const schemaApi = require('../../../src/core/keywordSchema');
const { buildSemanticDocumentContext } = require('../../../src/core/semantics/semanticDocumentContext');
const schema = { TEST: { c: [
    [{ n: 'FIRST', p: 0, w: 10, t: 'integer' }, { n: 'VALUE', p: 10, w: 10, t: 'integer' }],
    [{ n: 'SECOND', p: 0, w: 20, t: 'integer' }],
] } };

describe('data-only bounded field resolution', () => {
    it('keeps card identity, geometry and predicate values invariant under comment changes', () => {
        for (const comments of [[], ['$ ordinary note'], ['$#    SECOND'], ['$HMNAME TEST 1'],
            ['$# FIRST VALUE', '$ other note'], ['$# OLD WRONG'], ['   $ ordinary note', ' $# WRONG']]) {
            const doc = fakeDoc(['*TEST', ...comments, '         7         8', '                  9', '*END'].join('\n'));
            const line = comments.length + 1;
            const info = schemaApi.getCardInfoForDocumentLine(doc, line, schema);
            assert.deepStrictEqual(info.card, schema.TEST.c[0]);
            assert.equal(info.cardIndex, 1);
            assert.equal(info.observedDataLineOrdinal, 1);
            assert.equal(info.cardCommentNotice, undefined);
            const context = buildSemanticDocumentContext(doc, 0, schema, ['FIRST', 'SECOND']);
            assert.deepStrictEqual([...context.context.fields], [['FIRST', '         7'], ['SECOND', '                  9']]);
        }
    });

    it('limits missing-index lookup and comment-dense prefixes independently of document size', () => {
        for (const size of [100000, 1000000]) {
            for (const known of [true, false]) {
                let reads = 0;
                const doc = { version: 1, lineCount: size, lineAt(line) {
                    reads++; return { text: line === 0 ? '*TEST' : line === size - 1 ? '         7' : '$# FIRST VALUE' };
                } };
                const options = known ? { keywordLine: 0 } : {};
                const result = schemaApi.resolveCardForDocumentLine(doc, size - 1, schema, options);
                assert.equal(result.status, 'truncated');
                assert.ok(reads <= 256, reads);
                const previous = reads;
                assert.equal(schemaApi.resolveCardForDocumentLine(doc, size - 1, schema, options).status, 'truncated');
                assert.equal(reads, previous, 'cached truncation must not rescan');
            }
        }
    });

    it('shares a prefix across queries and invalidates on version, schema and close', () => {
        const lines = ['*TEST', '$ note', '         1', '                  2'];
        let reads = 0;
        const doc = { version: 1, lineCount: lines.length, lineAt(line) { reads++; return { text: lines[line] }; } };
        const options = { keywordLine: 0 };
        schemaApi.resolveCardForDocumentLine(doc, 2, schema, options);
        const before = reads;
        schemaApi.resolveCardForDocumentLine(doc, 3, schema, options);
        assert.equal(reads, before + 1, 'only the new record is read');
        schemaApi.resolveCardForDocumentLine(doc, 2, schema, options);
        assert.equal(reads, before + 1);
        doc.version++;
        schemaApi.resolveCardForDocumentLine(doc, 2, schema, options);
        assert.ok(reads > before + 1);
        const other = { TEST: { c: [[{ n: 'CHANGED', p: 0, w: 10 }]] } };
        assert.equal(schemaApi.getCardInfoForDocumentLine(doc, 2, other, options).card[0].n, 'CHANGED');
        const oldReads = reads;
        schemaApi.clearFieldContextCache(doc);
        schemaApi.resolveCardForDocumentLine(doc, 2, other, options);
        assert.ok(reads > oldReads);
    });

    it('skips native ASCII-space comments without inventing repetition', () => {
        const doc = fakeDoc('*TEST\n $ indented comment\n         7');
        assert.equal(schemaApi.getCardInfoForDocumentLine(doc, 2, schema).card[0].n, 'FIRST');
        assert.equal(schemaApi.resolveCardForDocumentLine(doc, 1, schema).reason, 'comment-line');
        const one = { ONE: { c: [[{ n: 'ID', p: 0, w: 10 }]] } };
        assert.equal(schemaApi.resolveCardForDocumentLine(fakeDoc('*ONE\n1\n2'), 2, one).status, 'unresolved');
    });

    it('reuses only proven homogeneous geometry without inventing an instance ordinal', () => {
        let reads = 0;
        const one = { ONE: { r: 1, c: [[{ n: 'ID', p: 0, w: 10 }]] } };
        const doc = { version: 1, lineCount: 1000000, lineAt(line) { reads++; return { text: line ? '         1' : '*ONE' }; } };
        const result = schemaApi.resolveCardForDocumentLine(doc, 999999, one, { keywordLine: 0, keywordBlockEnd: 999999 });
        assert.equal(result.status, 'resolved');
        assert.equal(result.cardInfo.cardIndex, 1);
        assert.equal(result.cardInfo.observedDataLineOrdinal, undefined);
        assert.ok(reads <= 2);
        for (let line = 1; line <= 300; line++) {
            assert.equal(schemaApi.resolveCardForDocumentLine(doc, line, one,
                { keywordLine: 0, keywordBlockEnd: 999999 }).status, 'resolved');
        }
        const exact = schemaApi.getCardInfoForDocumentLine(doc, 999999, one, { keywordLine: 0, dataLineOrdinal: 999999 });
        assert.equal(exact.observedDataLineOrdinal, 999999);
        assert.equal(exact.cardIndex, 1);
    });

    it('rejects oversized input and unsupported fixed-cell formats', () => {
        assert.equal(schemaApi.resolveCardForDocumentLine(fakeDoc('*TEST\n' + 'x'.repeat(65537)), 1, schema).status, 'truncated');
        assert.equal(schemaApi.resolveCardForDocumentLine(fakeDoc('*TEST\n1,2'), 1, schema).status, 'unsupported');
        assert.equal(schemaApi.resolveCardForDocumentLine(fakeDoc('*TEST+\n         1'), 1, schema).status, 'unsupported');
        const doc = fakeDoc('*TEST\n$123456789\n         7');
        assert.equal(schemaApi.resolveCardForDocumentLine(doc, 2, schema, { maximumInputBytes: 15 }).status, 'truncated');
    });

    it('does not let a truncated row poison other homogeneous rows in the block cache', () => {
        const one = { ONE: { r: 1, c: [[{ n: 'ID', p: 0, w: 10 }]] } };
        let reads = 0;
        const doc = { version: 1, lineCount: 3, lineAt(line) {
            reads++;
            return { text: ['*ONE', 'x'.repeat(65537), '         2'][line] };
        } };
        const options = { keywordLine: 0, keywordBlockEnd: 2 };
        assert.equal(schemaApi.resolveCardForDocumentLine(doc, 1, one, options).status, 'truncated');
        const before = reads;
        assert.equal(schemaApi.resolveCardForDocumentLine(doc, 1, one, options).status, 'truncated');
        assert.equal(reads, before);
        assert.equal(schemaApi.resolveCardForDocumentLine(doc, 2, one, options).status, 'resolved');
    });
});
