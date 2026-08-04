'use strict';

const assert = require('assert');

function scan(text) {
    const { scanParameterSymbols } = require('../../../out/core/parser/parameterScanner');
    const lines = text.split('\n');
    return scanParameterSymbols(lines.length, lineIndex => lines[lineIndex]);
}

function firstDefinition(index, name) {
    const definitions = index.definitions.get(name.toUpperCase()) || [];
    assert.ok(definitions.length > 0, `missing definition ${name}`);
    return definitions[0];
}

function permutations(values) {
    if (values.length <= 1) return [values];
    return values.flatMap((value, index) =>
        permutations(values.filter((_, candidate) => candidate !== index))
            .map(rest => [value, ...rest])
    );
}

describe('parameterScanner', () => {
    it('scans ordinary and expression definitions with precise values', () => {
        const index = scan(
            '*PARAMETER\n' +
            'R  tEnd  5.0\n' +
            '*PARAMETER_EXPRESSION\n' +
            'R  dtPlot  tEnd/100.0\n'
        );

        assert.equal(firstDefinition(index, 'TEND').value, '5.0');
        assert.equal(firstDefinition(index, 'DTPLOT').value, 'tEnd/100.0');
        assert.equal(index.references.filter(ref => ref.name === 'TEND').length, 1);
        assert.equal(index.references.find(ref => ref.name === 'TEND').syntax, 'bare');
    });

    it('accepts 1, 7, 8, and 9 character names and rejects a 10 character name', () => {
        const cases = [
            ['A', true],
            ['ABC_123', true],
            ['AB_CD_EF', true],
            ['ALPHA_123', true],
            ['ABCDEFGHIJ', false],
        ];
        for (const [name, valid] of cases) {
            const index = scan(`*PARAMETER\nR${name},1\n`);
            assert.equal(index.definitions.has(name), valid, name);
        }
    });

    it('parses a full-width 9-character name in every ordinary fixed-field slot', () => {
        const names = ['ALPHA_123', 'BETA_1234', 'GAMMA_123', 'DELTA_123'];
        const line = names.map((name, index) =>
            `R${name}` + String(index + 1).padStart(10)
        ).join('');
        const index = scan(`*PARAMETER\n${line}\n`);

        assert.deepEqual([...index.definitions.keys()], names);
        names.forEach((name, slot) => {
            const definition = firstDefinition(index, name);
            assert.equal(definition.startChar, slot * 20 + 1);
            assert.equal(definition.value, String(slot + 1));
            assert.equal(definition.valueStartChar, slot * 20 + 19);
        });
    });

    it('supports attached and spaced type markers for R, I, and C', () => {
        const index = scan(
            '*PARAMETER\n' +
            'RREALVAL,1.5, I COUNT,2, cLABEL,steel\n'
        );

        assert.equal(firstDefinition(index, 'REALVAL').parameterType, 'R');
        assert.equal(firstDefinition(index, 'COUNT').parameterType, 'I');
        assert.equal(firstDefinition(index, 'LABEL').parameterType, 'C');
    });

    it('rejects invalid and reserved parameter names', () => {
        for (const name of ['2START', 'BAD-NAME', 'TIME', 'time', 'PI', 'CURVE', 'VECTOR1', 'MATRIX1X1']) {
            const index = scan(`*PARAMETER\nR${name},1\n`);
            assert.equal(index.definitions.size, 0, name);
        }
    });

    it('supports every legal LOCAL/MUTABLE/NOECHO combination and order', () => {
        const optionSets = [
            [],
            ['LOCAL'], ['MUTABLE'], ['NOECHO'],
            ...permutations(['LOCAL', 'MUTABLE']),
            ...permutations(['LOCAL', 'NOECHO']),
            ...permutations(['MUTABLE', 'NOECHO']),
            ...permutations(['LOCAL', 'MUTABLE', 'NOECHO']),
        ];
        for (const options of optionSets) {
            const suffix = options.length ? `_${options.join('_')}` : '';
            const index = scan(`*PARAMETER${suffix}\nIPARAM,1\n`);
            const definition = firstDefinition(index, 'PARAM');
            assert.equal(definition.options.local, options.includes('LOCAL'), suffix);
            assert.equal(definition.options.mutable, options.includes('MUTABLE'), suffix);
            assert.equal(definition.options.noecho, options.includes('NOECHO'), suffix);
        }
    });

    it('requires EXPRESSION immediately after PARAMETER and rejects extraction artifacts', () => {
        for (const keyword of [
            '*PARAMETER_LOCAL_EXPRESSION',
            '*PARAMETER_OPTION',
            '*PARAMETER_EXPRES',
            '*PARAMETER_LOCAL_LOCAL',
        ]) {
            assert.equal(scan(`${keyword}\nIPARAM,1\n`).definitions.size, 0, keyword);
        }
    });

    it('supports standard fixed, comma-delimited, and whitespace cards', () => {
        const fixed = 'RFIXED'.padEnd(10) + '1.25'.padStart(10);
        const index = scan(
            `*PARAMETER\n${fixed}\n` +
            '*PARAMETER\nICOMMA,2\n' +
            '*PARAMETER\nC label steel material name\n'
        );

        assert.equal(firstDefinition(index, 'FIXED').format, 'fixed');
        assert.equal(firstDefinition(index, 'COMMA').format, 'comma');
        assert.equal(firstDefinition(index, 'LABEL').value, 'steel material name');
        assert.equal(firstDefinition(index, 'LABEL').format, 'whitespace');
    });

    it('supports per-keyword and global long physical layouts', () => {
        const globalLine = 'IGLOBAL_1'.padEnd(20) + '42'.padStart(20);
        const localLine = 'RLOCAL_123'.padEnd(20) + '3.5'.padStart(20);
        const index = scan(
            '*KEYWORD LONG=Y\n' +
            '*PARAMETER\n' + globalLine + '\n' +
            '*KEYWORD\n' +
            '*PARAMETER+\n' + localLine + '\n'
        );

        assert.equal(firstDefinition(index, 'GLOBAL_1').format, 'long-fixed');
        assert.equal(firstDefinition(index, 'GLOBAL_1').valueStartChar, 38);
        assert.equal(firstDefinition(index, 'LOCAL_123').format, 'long-fixed');
    });

    it('scans expression continuations and preserves dependency ranges', () => {
        const firstLine = 'RRESULT'.padEnd(10) + 'AB_CD_EF +';
        const continuation = ' '.repeat(10) + 'FACTOR*2';
        const index = scan(
            '*PARAMETER\n' +
            'RAB_CD_EF'.padEnd(10) + '1'.padStart(10) + '\n' +
            'RFACTOR'.padEnd(10) + '2'.padStart(10) + '\n' +
            '*PARAMETER_EXPRESSION_LOCAL_MUTABLE_NOECHO\n' +
            firstLine + '\n' + continuation + '\n'
        );
        const result = firstDefinition(index, 'RESULT');
        const factorReference = index.references.find(reference =>
            reference.name === 'FACTOR' && reference.lineIndex === 5
        );

        assert.equal(result.value, 'AB_CD_EF +\nFACTOR*2');
        assert.equal(factorReference.startChar, continuation.indexOf('FACTOR'));
        assert.equal(factorReference.nameLength, 6);
    });

    it('parses a full-width 9-character expression definition name', () => {
        const line = 'RABCDEFGHI' + 'AB_CD_EF+1';
        const index = scan(
            '*PARAMETER\n' + 'RAB_CD_EF'.padEnd(10) + '1'.padStart(10) + '\n' +
            '*PARAMETER_EXPRESSION\n' + line + '\n'
        );

        assert.equal(firstDefinition(index, 'ABCDEFGHI').startChar, 1);
        assert.equal(firstDefinition(index, 'ABCDEFGHI').value, 'AB_CD_EF+1');
    });

    it('records exact ranges for signed, character-delimited, bare, and inline references', () => {
        const text = [
            '*PARAMETER',
            'IAB_CD_EF,7',
            'CTOR_NAME,body',
            '*PARAMETER_EXPRESSION',
            'IRESULT,AB_CD_EF+1',
            '*CONTROL_TERMINATION',
            '  -&AB_CD_EF  file_&TOR_NAME^.k  <AB_CD_EF+2>,',
        ].join('\n');
        const index = scan(text);
        const line = text.split('\n')[6];
        const signed = index.references.find(reference => reference.negated);
        const character = index.references.find(reference =>
            reference.name === 'TOR_NAME' && reference.lineIndex === 6
        );
        const inline = index.references.find(reference =>
            reference.syntax === 'bare' && reference.lineIndex === 6
        );

        assert.equal(line.slice(signed.startChar, signed.startChar + signed.length), '-&AB_CD_EF');
        assert.equal(line.slice(signed.nameStartChar, signed.nameStartChar + signed.nameLength), 'AB_CD_EF');
        assert.equal(line.slice(character.startChar, character.startChar + character.length), '&TOR_NAME');
        assert.equal(line.slice(character.startChar + character.length, character.startChar + character.length + 1), '^');
        assert.equal(line.slice(inline.startChar, inline.startChar + inline.length), 'AB_CD_EF');
    });

    it('keeps every definition for duplicate names in input order', () => {
        const index = scan(
            '*PARAMETER_MUTABLE\nIPARAM,1\n' +
            '*PARAMETER\nIPARAM,2\n'
        );
        const definitions = index.definitions.get('PARAM');

        assert.equal(definitions.length, 2);
        assert.deepEqual(definitions.map(definition => definition.value), ['1', '2']);
        assert.deepEqual(definitions.map(definition => definition.lineIndex), [1, 3]);
    });

    it('parses PARAMETER_TYPE as an integer binding with PRTYP metadata', () => {
        const line = 'I WHLPID'.padEnd(10) + '100'.padStart(10) + 'PID'.padEnd(10);
        const index = scan(`*PARAMETER_TYPE\n${line}\n`);
        const definition = firstDefinition(index, 'WHLPID');

        assert.equal(definition.parameterType, 'I');
        assert.equal(definition.value, '100');
        assert.equal(definition.parameterUsageType, 'PID');
    });

    it('skips comments and non-definition PARAMETER family keywords', () => {
        const index = scan(
            '*PARAMETER\n' +
            '$ R hidden 1.0 &hidden\n' +
            'R shown 2.0\n' +
            '*PARAMETER_DUPLICATION\n' +
            'R duplicate 3.0\n'
        );

        assert.deepEqual([...index.definitions.keys()], ['SHOWN']);
        assert.equal(index.references.length, 0);
    });
});
