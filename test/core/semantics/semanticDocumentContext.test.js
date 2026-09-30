const assert = require('assert');

const {
    buildSemanticDocumentContext,
} = require('../../../out/core/semantics/semanticDocumentContext');

function fakeDoc(lines) {
    return {
        lineCount: lines.length,
        lineAt(index) {
            return { text: lines[index] };
        },
    };
}

function field(name, position = 0, width = 10) {
    return { n: name, p: position, w: width, t: 'integer' };
}

describe('bounded semantic document context', () => {
    it('reads only uniquely addressed predicate fields and preserves parameter text', () => {
        const schema = {
            MAT_TEST: {
                c: [[field('FLAG')], [field('OTHER')]],
                o: [],
            },
        };
        const document = fakeDoc([
            '*MAT_TEST',
            '        -1',
            '   &VALUE',
            '*END',
        ]);

        const result = buildSemanticDocumentContext(
            document,
            0,
            schema,
            ['FLAG', 'OTHER'],
        );

        assert.equal(result.catalogKeyword, '*MAT_TEST');
        assert.equal(result.context.fields.get('FLAG').trim(), '-1');
        assert.equal(result.context.fields.get('OTHER').trim(), '&VALUE');
        assert.deepEqual(result.unresolvedFields, []);
        assert.equal(result.scannedPhysicalLines, 2);
        assert.equal(result.truncated, false);
    });

    it('does not guess a duplicated field layout', () => {
        const schema = {
            TEST: {
                c: [[field('MODE')], [field('MODE')]],
                o: [],
            },
        };
        const result = buildSemanticDocumentContext(
            fakeDoc(['*TEST', '         1', '         2']),
            0,
            schema,
            ['MODE'],
        );

        assert.equal(result.context.fields, undefined);
        assert.deepEqual(result.unresolvedFields, ['MODE']);
        assert.equal(result.scannedPhysicalLines, 0);
    });

    it('keeps comma-delimited and long-format values unresolved', () => {
        const schema = { TEST: { c: [[field('FLAG')]], o: [] } };
        const free = buildSemanticDocumentContext(
            fakeDoc(['*TEST', '-1,0,0', '*END']),
            0,
            schema,
            ['FLAG'],
        );
        const long = buildSemanticDocumentContext(
            fakeDoc(['*TEST+', '                  -1', '*END']),
            0,
            schema,
            ['FLAG'],
        );

        assert.deepEqual(free.unresolvedFields, ['FLAG']);
        assert.equal(long.unsupportedFormat, true);
        assert.equal(long.scannedPhysicalLines, 0);
    });

    it('uses deck-wide input mode while preserving local standard overrides', () => {
        const schema = { TEST: { c: [[field('FLAG')]], o: [] } };
        for (const globalInputFormat of ['long', 'i10']) {
            const unsupported = buildSemanticDocumentContext(
                fakeDoc(['*TEST', '         8', '*END']),
                0,
                schema,
                ['FLAG'],
                { globalInputFormat },
            );
            assert.equal(unsupported.unsupportedFormat, true, globalInputFormat);
            assert.equal(unsupported.scannedPhysicalLines, 0, globalInputFormat);
            assert.deepEqual(unsupported.unresolvedFields, ['FLAG'], globalInputFormat);
        }

        const localStandard = buildSemanticDocumentContext(
            fakeDoc(['*TEST-', '         8', '*END']),
            0,
            schema,
            ['FLAG'],
            { globalInputFormat: 'long' },
        );
        assert.equal(localStandard.unsupportedFormat, false);
        assert.equal(localStandard.context.fields.get('FLAG').trim(), '8');

        const explicitStandard = buildSemanticDocumentContext(
            fakeDoc(['*TEST', '         8', '*END']),
            0,
            schema,
            ['FLAG'],
            { globalInputFormat: 'standard' },
        );
        assert.equal(explicitStandard.unsupportedFormat, false);
        assert.equal(explicitStandard.context.fields.get('FLAG').trim(), '8');
    });

    it('skips native space-prefixed comments and keeps blank lines as data cards', () => {
        const schema = {
            TEST: {
                c: [[field('FIRST')], [field('FLAG')]],
                o: [],
            },
        };
        const columnOneComment = buildSemanticDocumentContext(
            fakeDoc(['*TEST', '$ ignored', '', '         8', '*END']),
            0,
            schema,
            ['FIRST', 'FLAG'],
        );
        assert.equal(columnOneComment.context.fields.get('FIRST'), '');
        assert.equal(columnOneComment.context.fields.get('FLAG').trim(), '8');
        assert.equal(columnOneComment.scannedPhysicalLines, 3);

        const indentedDollar = buildSemanticDocumentContext(
            fakeDoc(['*TEST', '  $data', '         8', '*END']),
            0,
            schema,
            ['FIRST', 'FLAG'],
        );
        assert.equal(indentedDollar.context.fields.get('FIRST').trim(), '8');
        assert.equal(indentedDollar.context.fields.has('FLAG'), false);
        assert.equal(indentedDollar.scannedPhysicalLines, 2);
    });

    it('honors a hard physical-line budget without scanning a large repeated block', () => {
        const schema = {
            TEST: {
                c: [[field('A')], [field('FLAG')]],
                o: [],
            },
        };
        const document = fakeDoc(['*TEST', ...Array(1000).fill('         0')]);
        const result = buildSemanticDocumentContext(
            document,
            0,
            schema,
            ['FLAG'],
            { maximumPhysicalLines: 1 },
        );

        assert.equal(result.scannedPhysicalLines, 1);
        assert.equal(result.truncated, true);
        assert.deepEqual(result.unresolvedFields, ['FLAG']);
    });

    it('carries only explicitly parsed keyword options and never creates slot mappings', () => {
        const schema = {
            MAT_TEST: {
                c: [[field('FLAG')]],
                o: [{ n: 'SPM', co: 'title/1', to: 1, c: [] }],
            },
        };
        const result = buildSemanticDocumentContext(
            fakeDoc(['*MAT_TEST_SPM', '         0']),
            0,
            schema,
            [],
        );

        assert.deepEqual(result.context.keywordOptions, ['SPM']);
        assert.equal(result.context.keywordOptionSlots, undefined);
    });
});
