'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function collectNames(value, output = []) {
    if (Array.isArray(value)) {
        for (const item of value) collectNames(item, output);
    } else if (value && typeof value === 'object') {
        if (typeof value.name === 'string') output.push(value.name);
        for (const child of Object.values(value)) collectNames(child, output);
    }
    return output;
}

describe('theme contracts', () => {
    it('uses standard TextMate scope families without embedding colors in grammars', () => {
        for (const relativePath of ['syntaxes/lsdyna.tmLanguage.json', 'syntaxes/lspp-cfile.tmLanguage.json']) {
            const grammar = readJson(relativePath);
            const names = collectNames(grammar);
            assert.ok(names.some(name => name.startsWith('comment.')), `${relativePath}: comment scope`);
            assert.ok(names.some(name => name.startsWith('constant.numeric')), `${relativePath}: numeric scope`);
            assert.ok(names.some(name => name.startsWith('keyword.')), `${relativePath}: keyword scope`);
            assert.ok(names.some(name => name.startsWith('string.')), `${relativePath}: string scope`);
            assert.ok(!/#(?:[0-9a-f]{3}){1,2}\b/i.test(JSON.stringify(grammar)), `${relativePath}: fixed color`);
        }
    });

    it('covers every schema-backed INCLUDE path card before numeric tokenization', () => {
        const grammar = readJson('syntaxes/lsdyna.tmLanguage.json');
        assert.equal(grammar.patterns[0].include, '#include_path_blocks');

        const blocks = grammar.repository.include_path_blocks.patterns;
        const [repeatableBlock, firstCardBlock, secondCardBlock] = blocks;
        for (const block of blocks) {
            assert.equal(block.beginCaptures['2'].name, 'keyword.control.lsdyna');
        }

        const compileBegin = pattern => new RegExp(pattern.replaceAll('(?i:', '(?:'), 'i');
        const repeatableKeyword = compileBegin(repeatableBlock.begin);
        const firstCardKeyword = compileBegin(firstCardBlock.begin);
        const secondCardKeyword = compileBegin(secondCardBlock.begin);
        const fieldData = readJson('keywords/field_data.json');
        const covered = [];

        for (const [name, schema] of Object.entries(fieldData)) {
            if (!name.startsWith('INCLUDE') || !Array.isArray(schema.c)) continue;
            const filenameCardIndex = schema.c.findIndex(card =>
                Array.isArray(card) && card.some(field =>
                    field?.t === 'string' && (field.n === 'FILENAME' || field.n === 'PATH')
                )
            );
            if (filenameCardIndex < 0) continue;

            const keywordLine = `*${name}`;
            const matches = [
                repeatableKeyword.test(keywordLine),
                firstCardKeyword.test(keywordLine),
                secondCardKeyword.test(keywordLine),
            ];
            assert.equal(matches.filter(Boolean).length, 1, `${keywordLine}: one grammar path-card rule`);
            if (schema.r === 1) {
                assert.equal(matches[0], true, `${keywordLine}: repeatable path cards`);
            } else if (filenameCardIndex === 0) {
                assert.equal(matches[1], true, `${keywordLine}: filename on card 1`);
            } else if (filenameCardIndex === 1) {
                assert.equal(matches[2], true, `${keywordLine}: filename on card 2`);
            } else {
                assert.fail(`${keywordLine}: unsupported filename card ${filenameCardIndex + 1}`);
            }
            covered.push(name);
        }

        assert.ok(covered.includes('INCLUDE_TRANSFORM'));
        assert.ok(covered.includes('INCLUDE_TRANSFORM_BINARY'));
        assert.ok(covered.includes('INCLUDE_MULTISCALE'));
        assert.ok(covered.length >= 40, 'expected the complete frozen INCLUDE path-keyword family');
    });

    it('lets editor rulers inherit editorRuler.foreground instead of forcing colors', () => {
        const manifest = readJson('package.json');
        assert.deepEqual(
            manifest.contributes.configurationDefaults['[lsdyna]']['editor.rulers'],
            [10, 20, 30, 40, 50, 60, 70, 80]
        );
    });

    it('keeps concrete runtime colors confined to the centralized fallback palette', () => {
        const sourceRoot = path.join(repoRoot, 'src');
        const allowed = new Set([
            path.join(sourceRoot, 'core', 'theme', 'extensionTheme.ts'),
        ]);
        const violations = [];
        const stack = [sourceRoot];
        while (stack.length) {
            const current = stack.pop();
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) stack.push(fullPath);
                else if (entry.name.endsWith('.ts') && !allowed.has(fullPath)) {
                    const text = fs.readFileSync(fullPath, 'utf8');
                    if (/#[0-9a-f]{6}\b/i.test(text)) {
                        violations.push(path.relative(repoRoot, fullPath));
                    }
                }
            }
        }
        assert.deepEqual(violations, []);
    });
});
