'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createOfficialEdgeCaseCorpus } = require('./createOfficialCorpus');
const {
    copyDirectoryExact,
    diffSnapshots,
    snapshotDirectory,
} = require('./fileOracle');

describe('official editor-safety edge-case corpus', () => {
    let tempRoot;
    let corpusRoot;
    let manifest;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-official-corpus-'));
        corpusRoot = path.join(tempRoot, 'corpus');
        manifest = createOfficialEdgeCaseCorpus(corpusRoot);
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('generates fixed, comma, mixed-card, long, I10, and ambiguous decks', () => {
        assert.equal(manifest.files['standard-fixed-lf.key'].dataLineLengths[0], 72);
        assert.equal(manifest.files['mixed-card-formats-lf.key'].dataLineLengths[0], 80);
        assert.equal(manifest.files['long-keyword-lf.key'].dataLineLengths[0], 120);
        assert.equal(manifest.files['long-per-keyword-lf.key'].dataLineLengths[0], 120);
        assert.equal(manifest.files['i10-per-keyword-lf.key'].dataLineLengths[0], 78);
        assert.equal(manifest.files['ambiguous-whitespace-lf.key'].valid, false);
        assert.equal(manifest.files['invalid-same-card-mixed-lf.key'].valid, false);

        const mixed = fs.readFileSync(path.join(corpusRoot, 'mixed-card-formats-lf.key'), 'utf8');
        const perKeywordLong = fs.readFileSync(
            path.join(corpusRoot, 'long-per-keyword-lf.key'),
            'utf8',
        );
        assert.ok(mixed.includes(`\n${' '.repeat(6)}1001`));
        assert.ok(mixed.includes('\n0.0,0.0\n'));
        assert.ok(perKeywordLong.includes('\n*NODE+\n'));

        const commaValues = fs.readFileSync(path.join(corpusRoot, 'free-comma-values-lf.key'), 'utf8');
        assert.ok(commaValues.includes('\n1,-2.0,1.5E10,&p1,0,0\n'));
    });

    it('preserves LF, CRLF, BOM, and no-final-newline byte contracts', () => {
        const crlf = fs.readFileSync(path.join(corpusRoot, 'free-comma-crlf.key'));
        const bom = fs.readFileSync(path.join(corpusRoot, 'utf8-bom-crlf.key'));
        const noFinalNewline = fs.readFileSync(
            path.join(corpusRoot, 'column-80-tail-no-final-newline.key'),
            'utf8',
        );

        assert.equal(/(^|[^\r])\n/.test(crlf.toString('utf8')), false);
        assert.deepEqual([...bom.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
        assert.equal(noFinalNewline.endsWith('\n'), false);
        assert.ok(noFinalNewline.includes('IGNORED_AFTER_COLUMN_80'));
    });

    it('generates the official include continuation boundaries without truncation', () => {
        const expected = new Map([
            [78, [78]],
            [79, [79]],
            [80, [80]],
            [156, [80, 78]],
            [157, [80, 80, 1]],
            [236, [80, 80, 80]],
            [237, [80, 80, 81]],
        ]);

        for (const [length, physicalLineLengths] of expected) {
            const key = `include-boundaries/include-${String(length).padStart(3, '0')}-lf.key`;
            const entry = manifest.files[key];
            assert.deepEqual(entry.physicalLineLengths, physicalLineLengths);
            assert.equal(entry.logicalPathLength, length);
            assert.equal(entry.valid, length <= 236);
        }
    });

    it('is byte-stable across repeated snapshots', async () => {
        const before = await snapshotDirectory(corpusRoot);
        const after = await snapshotDirectory(corpusRoot);

        assert.equal(before.summary.fileCount, 18);
        assert.equal(diffSnapshots(before, after).clean, true);
    });

    it('allows destructive tests only in an independent copy', async () => {
        const sourceBefore = await snapshotDirectory(corpusRoot);
        const isolatedRoot = path.join(tempRoot, 'isolated');
        await copyDirectoryExact(corpusRoot, isolatedRoot);
        const isolatedBefore = await snapshotDirectory(isolatedRoot);

        fs.appendFileSync(path.join(isolatedRoot, 'standard-fixed-lf.key'), '$ isolated edit\n');

        assert.deepEqual(sourceBefore.summary, isolatedBefore.summary);
        assert.equal(diffSnapshots(sourceBefore, await snapshotDirectory(corpusRoot)).clean, true);
        assert.equal(diffSnapshots(isolatedBefore, await snapshotDirectory(isolatedRoot)).clean, false);
    });
});
