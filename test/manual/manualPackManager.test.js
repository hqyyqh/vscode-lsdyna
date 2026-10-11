'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ManualPackManager } = require('../../src/manual/ManualPackManager');

function writeJson(file, payloadKey, value) {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, [payloadKey]: value }), 'utf8');
}

function createPack() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-manual-pack-manager-'));
    const indexes = path.join(root, 'indexes');
    fs.mkdirSync(indexes);
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 2, generatedAt: 'now', documents: [{ slug: 'vol', title: 'Volume', order: 1 }] }));
    const section = { manualId: 'vol', sectionId: 'first', level: 1, titleEn: 'First', anchors: ['first'], pathEn: 'documents/en/vol/chunks/first.md', pathZh: 'documents/zh/vol/chunks/first.md', pdfPage: 1 };
    writeJson(path.join(indexes, 'sections.json'), 'sections', [section]);
    writeJson(path.join(indexes, 'keywords.json'), 'keywords', {});
    writeJson(path.join(indexes, 'anchors.json'), 'anchors', { first: { manualId: 'vol', sectionId: 'first' } });
    writeJson(path.join(indexes, 'sentence-map.json'), 'sentences', []);
    writeJson(path.join(indexes, 'search-en.json'), 'docs', []);
    writeJson(path.join(indexes, 'search-zh.json'), 'docs', []);
    return root;
}

function addAuthority(root) {
    const pdfDir = path.join(root, 'pdf');
    fs.mkdirSync(pdfDir);
    const pdfFile = 'pdf/vol.pdf';
    const pdfBytes = Buffer.from('pdf');
    fs.writeFileSync(path.join(root, pdfFile), pdfBytes);
    const sourceDocumentId = 'a'.repeat(64);
    const sourceProfileId = 'b'.repeat(64);
    const authority = {
        schema: 'lsdyna.pdf.authority-index.v1',
        schemaVersion: 1,
        flavor: 'en',
        sourceProfileId,
        documents: [{
            manualId: 'vol',
            sourceDocumentId,
            revision: 'master@abc123def (01/02/26)',
            pages: 1,
            artifactSha256: crypto.createHash('sha256').update(pdfBytes).digest('hex'),
            artifactBytes: pdfBytes.length,
            pdfFile,
        }],
    };
    const indexBytes = Buffer.from(JSON.stringify(authority));
    fs.writeFileSync(path.join(root, 'indexes', 'pdf-authority.json'), indexBytes);
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
        schema: 'lsdyna.manual.package.v2',
        schemaVersion: 2,
        generatedAt: 'authority',
        flavor: 'en',
        documents: [{
            slug: 'vol',
            title: 'Volume',
            order: 1,
            pdfFile,
            pdfAuthoritySourceDocumentId: sourceDocumentId,
        }],
        indexes: { pdfAuthority: 'indexes/pdf-authority.json' },
        pdfAuthority: {
            index: 'indexes/pdf-authority.json',
            indexSha256: crypto.createHash('sha256').update(indexBytes).digest('hex'),
            sourceProfileId,
            schemaVersion: 1,
        },
    }));
    return sourceProfileId;
}

describe('ManualPackManager', () => {
    it('distinguishes missing pack paths from access failures', () => {
        const root = createPack();
        const manager = new ManualPackManager({ globalState: {} });
        const originalExists = fs.existsSync;
        const originalStat = fs.statSync;
        const manifest = path.join(root, 'manifest.json');
        const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });
        try {
            assert.equal(manager.hasPack(root), true);
            assert.equal(manager.hasPack(path.join(root, 'missing')), false);
            fs.existsSync = file => file === manifest ? false : originalExists(file);
            fs.statSync = (file, ...args) => { if (file === manifest) throw denied; return originalStat(file, ...args); };
            assert.throws(() => manager.hasPack(root), error => error === denied);
        } finally {
            fs.existsSync = originalExists;
            fs.statSync = originalStat;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('restores current section metadata after a pack update without losing saved scroll', () => {
        const root = createPack();
        const values = new Map();
        const manager = new ManualPackManager({ globalState: {
            get: key => values.get(key), update: async (key, value) => { values.set(key, value); },
        } });
        try {
            const original = manager.getRepository(root);
            const location = { ...manager.firstLocation(original), anchorId: 'removed', title: 'Old title', pdfPage: 99 };
            manager.saveState(root, { manifestIdentity: original.getManifestIdentity(), location, language: 'zh', scrollY: 128, scrollRatio: 0.42 });
            writeJson(path.join(root, 'indexes', 'sections.json'), 'sections', [{
                manualId: 'vol', sectionId: 'first', titleEn: 'Updated section', titleZh: '更新后的章节',
                anchors: ['current'], pathEn: 'documents/en/vol/chunks/first.md', pathZh: 'documents/zh/vol/chunks/first.md', pdfPage: null,
            }]);
            const manifestFile = path.join(root, 'manifest.json');
            const previousTime = fs.statSync(manifestFile).mtimeMs;
            fs.writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 2, generatedAt: 'updated', flavor: 'bilingual', documents: [{ slug: 'vol', title: 'Volume' }] }));
            fs.utimesSync(manifestFile, new Date(previousTime + 1000), new Date(previousTime + 1000));
            const refreshed = manager.getRepository(root);
            assert.notStrictEqual(refreshed, original);
            const restored = manager.restoreState(root, refreshed);
            assert.deepStrictEqual(restored.location, { ...location, title: '更新后的章节', pdfPage: null, anchorId: 'current' });
            assert.equal(restored.scrollY, 128);
            assert.equal(restored.scrollRatio, 0.42);
            assert.equal(restored.manifestIdentity, refreshed.getManifestIdentity());
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('loads one authority snapshot with the repository and peeks it without another read', () => {
        const root = createPack();
        const sourceProfileId = addAuthority(root);
        const manager = new ManualPackManager({ globalState: {} });
        try {
            manager.getRepository(root);
            assert.equal(manager.peekCurrentAuthority().sourceProfileId, sourceProfileId);
            assert.equal(manager.peekAuthority(root).documents[0].manualId, 'vol');
            manager.invalidate();
            assert.equal(manager.peekCurrentAuthority(), null);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('stores and restores the latest valid global state for a pack', () => {
        const root = createPack();
        const values = new Map();
        const manager = new ManualPackManager({ globalState: { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, update: (key, value) => { values.set(key, value); return Promise.resolve(); } } });
        try {
            const repo = manager.getRepository(root);
            const location = manager.firstLocation(repo);
            manager.saveState(root, { manifestIdentity: repo.getManifestIdentity(), location, language: 'en', scrollY: 128, scrollRatio: 0.42 });
            assert.deepStrictEqual(manager.restoreState(root, repo), {
                manifestIdentity: repo.getManifestIdentity(), location, language: 'en', readingMode: 'en', scrollY: 128, scrollRatio: 0.42,
            });

            manager.saveState(root, { manifestIdentity: repo.getManifestIdentity(), location, language: 'en', scrollY: 64 });
            assert.strictEqual(manager.restoreState(root, repo).scrollRatio, 0, 'old reader state defaults to ratio zero');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

it('notifies structural checks when manual authority is loaded or invalidated', () => {
    const root = createPack(); let calls = 0;
    try {
        const manager = new ManualPackManager({}, () => { calls++; });
        manager.getRepository(root); assert.equal(calls, 1);
        manager.getRepository(root); assert.equal(calls, 1);
        manager.invalidate(); assert.equal(calls, 2);
        manager.getRepository(root); assert.equal(calls, 3);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
