'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    resolveDocumentPdfPath,
    listDeclaredPdfPaths,
    discoverManualPdfFiles,
} = require('../../src/manual/packPdf');

describe('packPdf resolution', () => {
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-pack-pdf-'));
        fs.mkdirSync(path.join(root, 'pdf'), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('prefers pdfFile over title convention', () => {
        const declared = path.join(root, 'pdf', 'Vol I R16.zh-CN.pdf');
        const legacy = path.join(root, 'pdf', 'Volume I.pdf');
        fs.writeFileSync(declared, 'pdf');
        fs.writeFileSync(legacy, 'pdf');

        const resolved = resolveDocumentPdfPath(root, {
            slug: 'vol-i',
            title: 'Volume I',
            pdfFile: 'pdf/Vol I R16.zh-CN.pdf',
        });
        assert.strictEqual(resolved, path.resolve(declared));
    });

    it('falls back to pdf/{title}.pdf for legacy packs', () => {
        const legacy = path.join(root, 'pdf', 'Volume I.pdf');
        fs.writeFileSync(legacy, 'pdf');
        const resolved = resolveDocumentPdfPath(root, {
            slug: 'vol-i',
            title: 'Volume I',
        });
        assert.strictEqual(resolved, path.resolve(legacy));
    });

    it('accepts bare basename in pdfFile', () => {
        const file = path.join(root, 'pdf', 'only.zh-CN.pdf');
        fs.writeFileSync(file, 'pdf');
        const resolved = resolveDocumentPdfPath(root, {
            slug: 'vol-i',
            pdfFile: 'only.zh-CN.pdf',
        });
        assert.strictEqual(resolved, path.resolve(file));
    });

    it('listDeclaredPdfPaths skips missing files and dedupes', () => {
        const a = path.join(root, 'pdf', 'a.pdf');
        fs.writeFileSync(a, 'pdf');
        const paths = listDeclaredPdfPaths(root, [
            { slug: 'a', pdfFile: 'pdf/a.pdf' },
            { slug: 'a2', pdfFile: 'pdf/a.pdf' },
            { slug: 'missing', pdfFile: 'pdf/nope.pdf' },
        ]);
        assert.deepStrictEqual(paths, [path.resolve(a)]);
    });

    it('discoverManualPdfFiles uses declared set when manifest present', () => {
        const keep = path.join(root, 'pdf', 'keep.zh-CN.pdf');
        const extra = path.join(root, 'pdf', 'extra.pdf');
        fs.writeFileSync(keep, 'pdf');
        fs.writeFileSync(extra, 'pdf');
        fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
            documents: [{ slug: 'vol', title: 'Vol', pdfFile: 'pdf/keep.zh-CN.pdf' }],
        }));

        const found = discoverManualPdfFiles(root);
        assert.deepStrictEqual(found, [path.resolve(keep)]);
    });

    it('discoverManualPdfFiles scans all PDFs without usable manifest mapping', () => {
        const rootPdf = path.join(root, 'loose.pdf');
        const nested = path.join(root, 'pdf', 'nested.pdf');
        fs.writeFileSync(rootPdf, 'pdf');
        fs.writeFileSync(nested, 'pdf');
        // Manifest without resolvable documents → full scan
        fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ documents: [] }));

        const found = discoverManualPdfFiles(root).map(p => path.basename(p)).sort();
        assert.deepStrictEqual(found, ['loose.pdf', 'nested.pdf']);
    });
});
