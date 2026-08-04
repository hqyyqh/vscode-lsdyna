const assert = require('assert');
const {
    scanParameterDefinitionBlock,
    scanParameterEventsFromFileIndex,
} = require('../../../out/core/references/parameterDefinitionScanner');

describe('parameterDefinitionScanner', () => {
    it('parses official fixed-width integer cards and keyword options', () => {
        const events = scanParameterDefinitionBlock(
            {
                keyword: '*PARAMETER_LOCAL_MUTABLE',
                startLine: 10,
            },
            [
                '*PARAMETER_LOCAL_MUTABLE',
                'ICID'.padEnd(10) + '100'.padStart(10) +
                    'IFOFF'.padEnd(10) + '20'.padStart(10),
            ].join('\n')
        );

        assert.deepEqual(
            events.map(event => ({
                name: event.name,
                value: event.value,
                valueState: event.valueState,
                local: event.local,
                mutable: event.mutable,
                lineIndex: event.lineIndex,
            })),
            [
                { name: 'CID', value: 100, valueState: 'integer', local: true, mutable: true, lineIndex: 11 },
                { name: 'FOFF', value: 20, valueState: 'integer', local: true, mutable: true, lineIndex: 11 },
            ]
        );
    });

    it('keeps expressions and non-integer parameter types unknown', () => {
        const expression = scanParameterDefinitionBlock(
            { keyword: '*PARAMETER_EXPRESSION_LOCAL', startLine: 3 },
            '*PARAMETER_EXPRESSION_LOCAL\nICID      BASE+1'
        );
        const real = scanParameterDefinitionBlock(
            { keyword: '*PARAMETER', startLine: 8 },
            '*PARAMETER\nRFACTOR          1.5'
        );

        assert.equal(expression[0].name, 'CID');
        assert.equal(expression[0].valueState, 'unknown');
        assert.equal(expression[0].reason, 'parameter-expression-unresolved');
        assert.equal(real[0].name, 'FACTOR');
        assert.equal(real[0].valueState, 'unknown');
        assert.equal(real[0].reason, 'unsupported-parameter-type');
    });

    it('records duplication and unsupported scope controls in input order', async () => {
        const blocks = [
            { keyword: '*PARAMETER_DUPLICATION', startLine: 1, text: '*PARAMETER_DUPLICATION\n         4' },
            { keyword: '*PARAMETER_PUSH', startLine: 3, text: '*PARAMETER_PUSH' },
            { keyword: '*PARAMETER', startLine: 4, text: '*PARAMETER\nICID              7' },
        ];
        const events = await scanParameterEventsFromFileIndex(
            { keywordBlocks: blocks },
            block => Promise.resolve(block.text)
        );

        assert.deepEqual(events.map(event => event.type), [
            'duplication',
            'scope-control',
            'definition',
        ]);
        assert.equal(events[0].dflag, 4);
    });

    it('accepts underscores and rejects hyphens, reserved names, and names longer than nine characters', () => {
        const events = scanParameterDefinitionBlock(
            { keyword: '*PARAMETER', startLine: 0 },
            [
                '*PARAMETER',
                'IA-B'.padEnd(10) + '1'.padStart(10),
                'IAB_CD_EF'.padEnd(10) + '2'.padStart(10),
                'ITIME'.padEnd(10) + '3'.padStart(10),
                'ITOOLONG999,2',
            ].join('\n')
        );

        assert.deepEqual(events.map(event => event.name), ['AB_CD_EF']);
    });

    it('joins expression continuations and retains all keyword option metadata', () => {
        const events = scanParameterDefinitionBlock(
            { keyword: '*PARAMETER_EXPRESSION_NOECHO_MUTABLE_LOCAL', startLine: 5 },
            [
                '*PARAMETER_EXPRESSION_NOECHO_MUTABLE_LOCAL',
                'IRESULT'.padEnd(10) + 'BASE +',
                ' '.repeat(10) + 'OFFSET',
            ].join('\n')
        );

        assert.equal(events.length, 1);
        assert.equal(events[0].rawValue, 'BASE +\nOFFSET');
        assert.equal(events[0].local, true);
        assert.equal(events[0].mutable, true);
        assert.equal(events[0].noecho, true);
    });

    it('treats PARAMETER_TYPE as an integer binding and retains PRTYP metadata', async () => {
        const blocks = [{
            keyword: '*PARAMETER_TYPE',
            startLine: 0,
            text: '*PARAMETER_TYPE\nI WHLPID,100,PID',
        }];
        const events = await scanParameterEventsFromFileIndex(
            { keywordBlocks: blocks },
            block => Promise.resolve(block.text)
        );

        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'definition');
        assert.equal(events[0].name, 'WHLPID');
        assert.equal(events[0].value, 100);
        assert.equal(events[0].parameterUsageType, 'PID');
    });

    it('honors deck-wide long format while building parameter events', async () => {
        const longCard = 'IGLOBAL_1'.padEnd(20) + '42'.padStart(20);
        const blocks = [
            { keyword: '*KEYWORD', startLine: 0, text: '*KEYWORD LONG=Y' },
            { keyword: '*PARAMETER', startLine: 1, text: `*PARAMETER\n${longCard}` },
        ];
        const events = await scanParameterEventsFromFileIndex(
            { keywordBlocks: blocks },
            block => Promise.resolve(block.text)
        );

        assert.equal(events.length, 1);
        assert.equal(events[0].name, 'GLOBAL_1');
        assert.equal(events[0].value, 42);
        assert.equal(events[0].format, 'long-fixed');
    });

    it('uses DFLAG 1 for an empty first duplication card and ignores unknown keyword suffixes', async () => {
        const blocks = [
            { keyword: '*PARAMETER_DUPLICATION', startLine: 0, text: '*PARAMETER_DUPLICATION' },
            { keyword: '*PARAMETER_UNKNOWN', startLine: 1, text: '*PARAMETER_UNKNOWN\nICID              9' },
        ];
        const events = await scanParameterEventsFromFileIndex(
            { keywordBlocks: blocks },
            block => Promise.resolve(block.text)
        );

        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'duplication');
        assert.equal(events[0].dflag, 1);
    });
});
