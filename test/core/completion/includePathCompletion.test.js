'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    normalizeIncludePathPrefix,
    resolveValidSearchDirs,
    listBrowseLevel,
    listSearchByName,
    scoreIncludeCandidate,
    collectIncludePathEntries,
    isIncludeFilenameLineContext,
} = require('../../../src/core/completion/includePathCompletion');

describe('includePathCompletion', () => {
    describe('normalizeIncludePathPrefix', () => {
        it('treats empty card as search (no dump); slash-only and ./ as browse root', () => {
            const empty = normalizeIncludePathPrefix('');
            assert.strictEqual(empty.mode, 'search');
            assert.strictEqual(empty.namePrefix, '');

            for (const p of ['/', '\\', './', '.\\']) {
                const n = normalizeIncludePathPrefix(p);
                assert.strictEqual(n.mode, 'browse', p);
                assert.strictEqual(n.dirPrefix, '');
                assert.strictEqual(n.namePrefix, '');
            }
        });

        it('uses search mode for bare filenames', () => {
            const n = normalizeIncludePathPrefix('mat');
            assert.strictEqual(n.mode, 'search');
            assert.strictEqual(n.namePrefix, 'mat');
            assert.strictEqual(n.dirPrefix, '');
        });

        it('keeps explicit root-relative prefixes in browse mode while typing a name', () => {
            for (const p of ['/mat', '\\mat', './mat', '.\\mat']) {
                const n = normalizeIncludePathPrefix(p);
                assert.strictEqual(n.mode, 'browse', p);
                assert.strictEqual(n.dirPrefix, '', p);
                assert.strictEqual(n.namePrefix, 'mat', p);
            }

            const nested = normalizeIncludePathPrefix('/materials/st');
            assert.strictEqual(nested.mode, 'browse');
            assert.strictEqual(nested.dirPrefix, 'materials/');
            assert.strictEqual(nested.namePrefix, 'st');
        });

        it('parses browse dir and name segments with / and \\', () => {
            const a = normalizeIncludePathPrefix('sub/mo');
            assert.strictEqual(a.mode, 'browse');
            assert.strictEqual(a.dirPrefix, 'sub/');
            assert.strictEqual(a.namePrefix, 'mo');

            const b = normalizeIncludePathPrefix('sub\\models\\');
            assert.strictEqual(b.mode, 'browse');
            assert.strictEqual(b.dirPrefix, 'sub/models/');
            assert.strictEqual(b.namePrefix, '');

            const c = normalizeIncludePathPrefix('./loadcases/frontal');
            assert.strictEqual(c.mode, 'browse');
            assert.strictEqual(c.dirPrefix, 'loadcases/');
            assert.strictEqual(c.namePrefix, 'frontal');
        });
    });

    describe('scoreIncludeCandidate', () => {
        it('prefers basename and path prefix matches', () => {
            assert.ok(scoreIncludeCandidate('mat', 'steel/mat.k') > 0);
            assert.ok(
                scoreIncludeCandidate('steel/mat', 'steel/mat.k') >
                scoreIncludeCandidate('mat', 'other/xx.k')
            );
            assert.strictEqual(scoreIncludeCandidate('zzz', 'steel/mat.k'), 0);
        });
    });

    describe('listBrowseLevel / listSearchByName (temp fs)', () => {
        let tempDir;
        let rootA;
        let rootB;

        before(() => {
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-inc-comp-'));
            rootA = path.join(tempDir, 'rootA');
            rootB = path.join(tempDir, 'rootB');
            fs.mkdirSync(path.join(rootA, 'submodels'), { recursive: true });
            fs.mkdirSync(path.join(rootA, 'loadcases', 'frontal'), { recursive: true });
            for (const name of [
                '1', '2', '10', '100',
                'materials', 'mats_common', 'unrelated',
                'part1', 'part2', 'part10', 'PART11',
            ]) {
                fs.mkdirSync(path.join(rootA, name), { recursive: true });
            }
            fs.writeFileSync(path.join(rootA, 'file1.k'), '');
            fs.writeFileSync(path.join(rootA, 'file2.k'), '');
            fs.writeFileSync(path.join(rootA, 'file10.k'), '');
            fs.writeFileSync(path.join(rootA, 'mass.k'), '');
            fs.writeFileSync(path.join(rootA, 'submodels', 'file2.k'), '');
            fs.writeFileSync(path.join(rootA, 'loadcases', 'frontal', 'LC_Frontal.k'), '');
            fs.writeFileSync(path.join(rootA, 'unrelated', 'material_deep.k'), '');
            fs.mkdirSync(rootB, { recursive: true });
            fs.writeFileSync(path.join(rootB, 'file1.k'), '');
            fs.writeFileSync(path.join(rootB, 'extra.k'), '');
        });

        after(() => {
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('lists browse root with directories ending in /', () => {
            const entries = listBrowseLevel([rootA], '', '');
            const rels = entries.map(e => e.relPath);
            assert.ok(rels.includes('file1.k'));
            assert.ok(rels.includes('submodels/'));
            assert.ok(rels.includes('loadcases/'));
            assert.ok(!rels.includes('submodels/file2.k'), 'must not flatten children');
            const dirs = entries.filter(e => e.kind === 'directory');
            assert.ok(dirs.every(d => d.relPath.endsWith('/')));
        });

        it('filters browse level by name prefix', () => {
            const entries = listBrowseLevel([rootA], 'submodels/', 'fi');
            assert.deepStrictEqual(entries.map(e => e.relPath), ['submodels/file2.k']);
        });

        it('filters loadcases/fr partial segment', () => {
            const entries = listBrowseLevel([rootA], 'loadcases/', 'fr');
            assert.ok(entries.some(e => e.relPath === 'loadcases/frontal/'));
        });

        it('uses directory-first natural sorting in browse mode', () => {
            const entries = listBrowseLevel([rootA], '', '');
            const numericDirs = entries
                .filter(e => e.kind === 'directory' && /^\d+\/$/.test(e.relPath))
                .map(e => e.relPath);
            assert.deepStrictEqual(numericDirs, ['1/', '2/', '10/', '100/']);

            assert.deepStrictEqual(
                entries
                    .filter(e => e.kind === 'directory' && /^part\d+\/$/i.test(e.relPath))
                    .map(e => e.relPath),
                ['part1/', 'part2/', 'part10/', 'PART11/'],
            );
            assert.deepStrictEqual(
                entries
                    .filter(e => e.kind === 'file' && /^file\d+\.k$/.test(e.relPath))
                    .map(e => e.relPath),
                ['file1.k', 'file2.k', 'file10.k'],
            );

            const firstFile = entries.findIndex(e => e.kind === 'file');
            const lastDirectory = entries.map(e => e.kind).lastIndexOf('directory');
            assert.ok(firstFile > lastDirectory, 'all directories must sort before files');
        });

        it('keeps /name browsing at the current level instead of recursively searching files', () => {
            const result = collectIncludePathEntries([rootA], '/ma');
            assert.strictEqual(result.mode, 'browse');
            assert.deepStrictEqual(
                result.entries.map(e => e.relPath),
                ['materials/', 'mats_common/', 'mass.k'],
            );
            assert.ok(!result.entries.some(e => e.relPath === 'unrelated/material_deep.k'));

            const search = collectIncludePathEntries([rootA], 'material');
            assert.strictEqual(search.mode, 'search');
            assert.ok(search.entries.some(e => e.relPath === 'unrelated/material_deep.k'));
        });

        it('dedupes same relPath across roots at browse root', () => {
            const entries = listBrowseLevel([rootA, rootB], '', 'file1');
            const file1 = entries.filter(e => e.relPath === 'file1.k');
            assert.strictEqual(file1.length, 1);
        });

        it('searches by bare name with full relPath labels', () => {
            const entries = listSearchByName([rootA], 'LC_Front');
            assert.ok(entries.some(e => e.relPath === 'loadcases/frontal/LC_Frontal.k'));
            assert.ok(entries.every(e => e.kind === 'file'));
        });

        it('returns empty search for empty query (no dump)', () => {
            assert.deepStrictEqual(listSearchByName([rootA], ''), []);
        });

        it('collectIncludePathEntries routes browse vs search', () => {
            const b = collectIncludePathEntries([rootA], 'sub/');
            assert.strictEqual(b.mode, 'browse');

            const s = collectIncludePathEntries([rootA], 'file2');
            assert.strictEqual(s.mode, 'search');
            assert.ok(s.entries.some(e => e.relPath === 'submodels/file2.k'));
        });

        it('resolveValidSearchDirs skips missing paths', () => {
            const dirs = resolveValidSearchDirs(
                [rootA, path.join(tempDir, 'nope'), 'relative-missing'],
                tempDir,
            );
            assert.deepStrictEqual(dirs, [rootA]);
        });
    });

    describe('isIncludeFilenameLineContext', () => {
        const isKeywordLineText = (t) => /^\s*\*/.test(t);
        const classifyKeywordLine = (t) => ({
            normalizedKeyword: t.trim().split(/\s+/)[0].toUpperCase(),
        });

        it('accepts *INCLUDE filename card including empty line', () => {
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: 'sub/',
                    positionCharacter: 4,
                    linesBeforeAndCurrent: ['*INCLUDE', 'sub/'],
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                true,
            );
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: '',
                    positionCharacter: 0,
                    linesBeforeAndCurrent: ['*INCLUDE', ''],
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                true,
            );
        });

        it('rejects *INCLUDE_PATH, comments, and keyword line', () => {
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: 'shared',
                    positionCharacter: 6,
                    linesBeforeAndCurrent: ['*INCLUDE_PATH', 'shared'],
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                false,
            );
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: '$ note',
                    positionCharacter: 3,
                    linesBeforeAndCurrent: ['*INCLUDE', '$ note'],
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                false,
            );
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: '*INCLUDE',
                    positionCharacter: 8,
                    linesBeforeAndCurrent: ['*INCLUDE'],
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                false,
            );
        });

        it('accepts *INCLUDE_TRANSFORM filename card only (not offset/scale cards)', () => {
            const transform = [
                '*INCLUDE_TRANSFORM',
                'parts/door.k',
                '         0         0         0         0         0         0         0',
                '         0',
                '       1.0       1.0       1.0       1.0         1',
                '         0',
            ];
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: 'parts/door.k',
                    positionCharacter: 5,
                    linesBeforeAndCurrent: transform.slice(0, 2),
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                true,
            );
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: transform[2],
                    positionCharacter: 10,
                    linesBeforeAndCurrent: transform.slice(0, 3),
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                false,
            );
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: transform[4],
                    positionCharacter: 8,
                    linesBeforeAndCurrent: transform.slice(0, 5),
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                false,
            );
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: transform[5],
                    positionCharacter: 4,
                    linesBeforeAndCurrent: transform,
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                false,
            );
        });

        it('accepts *INCLUDE_TRANSFORM path continuation after +', () => {
            const lines = [
                '*INCLUDE_TRANSFORM',
                'very/long/path/that/needs/contin +',
                'uation/file.k',
                '         0         0         0',
            ];
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: lines[2],
                    positionCharacter: 4,
                    linesBeforeAndCurrent: lines.slice(0, 3),
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                true,
            );
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: lines[3],
                    positionCharacter: 4,
                    linesBeforeAndCurrent: lines,
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                false,
            );
        });

        it('accepts MULTISCALE filename card 2 only (not type/id card 1)', () => {
            const spot = ['*INCLUDE_MULTISCALE_SPOTWELD', '         1', 'weld_ms.k'];
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: spot[1],
                    positionCharacter: 4,
                    linesBeforeAndCurrent: spot.slice(0, 2),
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                false,
            );
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: 'weld_ms.k',
                    positionCharacter: 4,
                    linesBeforeAndCurrent: spot,
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                true,
            );

            const multi = ['*INCLUDE_MULTISCALE', '        10', 'local.k'];
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: multi[1],
                    positionCharacter: 4,
                    linesBeforeAndCurrent: multi.slice(0, 2),
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                false,
            );
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: 'local.k',
                    positionCharacter: 3,
                    linesBeforeAndCurrent: multi,
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                true,
            );
        });

        it('accepts *INCLUDE multi-file second path and ignores comments when counting cards', () => {
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: 'b.k',
                    positionCharacter: 2,
                    linesBeforeAndCurrent: ['*INCLUDE', 'a.k', 'b.k'],
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                true,
            );
            assert.strictEqual(
                isIncludeFilenameLineContext({
                    lineText: 'file.k',
                    positionCharacter: 3,
                    linesBeforeAndCurrent: ['*INCLUDE_TRANSFORM', '$ note', 'file.k'],
                    isKeywordLineText,
                    classifyKeywordLine,
                }),
                true,
            );
        });
    });
});
