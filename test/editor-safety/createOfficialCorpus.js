'use strict';

const fs = require('fs');
const path = require('path');

function right(value, width) {
    const text = String(value);
    if (text.length > width) throw new Error(`Value exceeds width ${width}: ${text}`);
    return text.padStart(width, ' ');
}

function fixedCard(values, widths) {
    if (values.length !== widths.length) throw new Error('Card values and widths differ');
    return values.map((value, index) => right(value, widths[index])).join('');
}

function standardNode(values = ['1', '0.0', '1.0', '-2.0', '0', '0']) {
    return fixedCard(values, [8, 16, 16, 16, 8, 8]);
}

function longNode(values = ['1', '0.0', '1.0', '-2.0', '0', '0']) {
    return fixedCard(values, [20, 20, 20, 20, 20, 20]);
}

function i10Node(values = ['1', '0.0', '1.0', '-2.0', '0', '0']) {
    return fixedCard(values, [10, 16, 16, 16, 10, 10]);
}

function defineCurveHeader() {
    return fixedCard(['1001', '0', '1.0', '1.0', '0.0', '0.0', '0', '0'], Array(8).fill(10));
}

function splitOfficialIncludePath(value) {
    if (value.length <= 80) return [value];
    if (value.length <= 156) return [
        `${value.slice(0, 78)} +`,
        value.slice(78),
    ];
    return [
        `${value.slice(0, 78)} +`,
        `${value.slice(78, 156)} +`,
        value.slice(156),
    ];
}

function createOfficialEdgeCaseCorpus(rootPath) {
    const root = path.resolve(rootPath);
    if (fs.existsSync(root)) {
        throw new Error(`Corpus target already exists: ${root}`);
    }
    fs.mkdirSync(root, { recursive: true });

    const files = {};
    function add(relativePath, content, metadata) {
        const outputPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        fs.writeFileSync(outputPath, buffer);
        files[relativePath.split(path.sep).join('/')] = {
            bytes: buffer.length,
            ...metadata,
        };
    }

    // General Card Format, official Vol I physical page 395 / printed page 2-29.
    add(
        'standard-fixed-lf.key',
        `*KEYWORD\n*NODE\n${standardNode()}\n*END\n`,
        { format: 'fixed', eol: 'lf', dataLineLengths: [72] },
    );
    add(
        'free-comma-crlf.key',
        '*KEYWORD\r\n*NODE\r\n1,0.0,1.0,-2.0,0,0\r\n*END\r\n',
        { format: 'comma', eol: 'crlf' },
    );
    add(
        'mixed-card-formats-lf.key',
        `*KEYWORD\n*DEFINE_CURVE\n${defineCurveHeader()}\n0.0,0.0\n1.0,1.0\n*END\n`,
        { format: 'fixed-and-comma-across-cards', eol: 'lf', dataLineLengths: [80, 7, 7] },
    );
    // Real engineer values in comma-free format that the vehicle corpus does not
    // exercise together: a negative, a scientific-notation value, and an inline
    // *PARAMETER reference (&name). Official Vol I physical page 395 / printed
    // page 2-29 (free format) + pages 3588-3590 / 36-2-36-4 (& parameter use).
    add(
        'free-comma-values-lf.key',
        '*KEYWORD\n*NODE\n1,-2.0,1.5E10,&p1,0,0\n*END\n',
        { format: 'comma-values', eol: 'lf' },
    );

    // Long/I10 rules, official Vol I physical pages 397-398 / printed pages 2-31 to 2-32.
    add(
        'long-keyword-lf.key',
        `*KEYWORD long=y\n*NODE\n${longNode()}\n*END\n`,
        { format: 'long-global', eol: 'lf', dataLineLengths: [120] },
    );
    add(
        'long-per-keyword-lf.key',
        `*KEYWORD\n*NODE+\n${longNode(['2', '2.0', '3.0', '4.0', '0', '0'])}\n*END\n`,
        { format: 'long-keyword-plus', eol: 'lf', dataLineLengths: [120] },
    );
    add(
        'i10-per-keyword-lf.key',
        `*KEYWORD\n*NODE %\n${i10Node()}\n*END\n`,
        { format: 'i10-keyword-percent', eol: 'lf', dataLineLengths: [78] },
    );

    const ignoredTailLine = `${defineCurveHeader()}IGNORED_AFTER_COLUMN_80`;
    add(
        'column-80-tail-no-final-newline.key',
        `*KEYWORD\n*DEFINE_CURVE\n${ignoredTailLine}\n*END`,
        {
            format: 'fixed-with-ignored-tail',
            eol: 'lf',
            finalNewline: false,
            dataLineLengths: [ignoredTailLine.length],
        },
    );

    add(
        'utf8-bom-crlf.key',
        Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from(`*KEYWORD\r\n*NODE\r\n${standardNode()}\r\n*END\r\n`, 'utf8'),
        ]),
        { format: 'fixed', eol: 'crlf', encoding: 'utf8-bom', dataLineLengths: [72] },
    );

    // These are intentionally ambiguous or invalid and exist only for fail-closed tests.
    add(
        'ambiguous-whitespace-lf.key',
        '*KEYWORD\n*NODE\n1 2 3 4\n*END\n',
        { format: 'ambiguous-whitespace', eol: 'lf', valid: false },
    );
    add(
        'invalid-same-card-mixed-lf.key',
        '*KEYWORD\n*NODE\n       1,0.0             1.0\n*END\n',
        { format: 'invalid-same-card-mixed', eol: 'lf', valid: false },
    );

    // *INCLUDE filename rules, physical page 2994 / printed page 27-8.
    for (const length of [78, 79, 80, 156, 157, 236, 237]) {
        const logicalPath = 'p'.repeat(length);
        const physicalLines = splitOfficialIncludePath(logicalPath);
        const suffix = String(length).padStart(3, '0');
        add(
            `include-boundaries/include-${suffix}-lf.key`,
            `*KEYWORD\n*INCLUDE\n${physicalLines.join('\n')}\n*END\n`,
            {
                format: 'include-path',
                eol: 'lf',
                logicalPathLength: length,
                physicalLineLengths: physicalLines.map(line => line.length),
                valid: length <= 236,
            },
        );
    }

    return { root, files };
}

module.exports = {
    createOfficialEdgeCaseCorpus,
    defineCurveHeader,
    fixedCard,
    i10Node,
    longNode,
    splitOfficialIncludePath,
    standardNode,
};
