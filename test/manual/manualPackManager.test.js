'use strict';

const assert = require('assert');
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

describe('ManualPackManager', () => {
    it('stores and restores the latest valid global state for a pack', () => {
        const root = createPack();
        const values = new Map();
        const manager = new ManualPackManager({ globalState: { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, update: (key, value) => { values.set(key, value); return Promise.resolve(); } } });
        try {
            const repo = manager.getRepository(root);
            const location = manager.firstLocation(repo);
            manager.saveState(root, { manifestIdentity: repo.getManifestIdentity(), location, language: 'en', scrollY: 128, scrollRatio: 0.42 });
            assert.deepStrictEqual(manager.restoreState(root, repo), {
                manifestIdentity: repo.getManifestIdentity(), location, language: 'en', scrollY: 128, scrollRatio: 0.42,
            });

            manager.saveState(root, { manifestIdentity: repo.getManifestIdentity(), location, language: 'en', scrollY: 64 });
            assert.strictEqual(manager.restoreState(root, repo).scrollRatio, 0, 'old reader state defaults to ratio zero');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
