'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ManualIndexRepository } = require('../../src/manual/ManualIndexRepository');
const { keywordKeysForSectionTitle } = require('../../src/manual/manualKeywordResolution');

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

function versioned(payloadKey, value) {
    return { schemaVersion: 1, [payloadKey]: value };
}

function createFixturePack() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-manual-index-repository-'));
    const indexes = path.join(root, 'indexes');
    fs.mkdirSync(indexes);

    writeJson(path.join(root, 'manifest.json'), {
        schemaVersion: 1,
        generatedAt: '2026-07-14T00:00:00Z',
        documents: [
            { slug: 'vol-i', title: 'Volume I', order: 2 },
            { slug: 'theory', title: 'Theory Manual', order: 1 },
        ],
    });
    writeJson(path.join(indexes, 'sections.json'), versioned('sections', [
        {
            manualId: 'vol-i', sectionId: 'node', level: 2,
            titleEn: 'Node Definition', titleZh: '节点定义', anchors: ['node-anchor'],
            pathEn: 'documents/en/vol-i/chunks/node.md',
            pathZh: 'documents/zh/vol-i/chunks/node.md', pdfPage: 12,
        },
        {
            manualId: 'vol-i', sectionId: 'mat-024', level: 2,
            titleEn: 'Material Model', titleZh: '材料模型', anchors: ['mat-anchor'],
            pathEn: 'documents/en/vol-i/chunks/mat-024.md',
            pathZh: 'documents/zh/vol-i/chunks/mat-024.md', pdfPage: 42,
        },
        {
            manualId: 'vol-i', sectionId: 'mat-072', level: 2,
            titleEn: 'Concrete Damage', titleZh: '混凝土损伤', anchors: ['mat-072-anchor'],
            pathEn: 'documents/en/vol-i/chunks/mat-072.md',
            pathZh: 'documents/zh/vol-i/chunks/mat-072.md', pdfPage: 72,
        },
        {
            manualId: 'theory', sectionId: 'control', level: 2,
            titleEn: 'Control Cards', titleZh: '控制卡', anchors: ['control-anchor'],
            pathEn: 'documents/en/theory/chunks/control.md',
            pathZh: 'documents/zh/theory/chunks/control.md', pdfPage: 3,
        },
        {
            manualId: 'vol-i', sectionId: 'control-timestep', level: 2,
            titleEn: '*CONTROL_TIMESTEP', titleZh: '时间步控制', anchors: [],
            pathEn: 'documents/en/vol-i/chunks/control-timestep.md',
            pathZh: 'documents/zh/vol-i/chunks/control-timestep.md', pdfPage: 88,
        },
        {
            manualId: 'vol-i', sectionId: 'mat-160', level: 2,
            titleEn: 'MAT_160/MAT_ALE_INCOMPRESSIBLE', titleZh: '不可压缩 ALE 材料 160',
            anchors: ['mat-160-anchor'],
            pathEn: 'documents/en/vol-i/chunks/mat-160.md',
            pathZh: 'documents/zh/vol-i/chunks/mat-160.md', pdfPage: 160,
        },
        {
            manualId: 'vol-i', sectionId: 'mat-ale-05', level: 2,
            titleEn: 'MAT_ALE_05/MAT_ALE_INCOMPRESSIBLE', titleZh: '不可压缩 ALE 材料 05',
            anchors: ['mat-ale-05-anchor'],
            pathEn: 'documents/en/vol-i/chunks/mat-ale-05.md',
            pathZh: 'documents/zh/vol-i/chunks/mat-ale-05.md', pdfPage: 205,
        },
        { manualId: 'theory', sectionId: 'a-tie', level: 2, titleEn: 'Tie', titleZh: '并列', anchors: [], pathEn: 'documents/en/theory/chunks/a.md', pathZh: 'documents/zh/theory/chunks/a.md' },
        { manualId: 'vol-i', sectionId: 'b-tie', level: 2, titleEn: 'Tie', titleZh: '并列', anchors: [], pathEn: 'documents/en/vol-i/chunks/b.md', pathZh: 'documents/zh/vol-i/chunks/b.md' },
        { manualId: 'vol-i', sectionId: 'c-tie', level: 2, titleEn: 'Tie', titleZh: '并列', anchors: [], pathEn: 'documents/en/vol-i/chunks/c.md', pathZh: 'documents/zh/vol-i/chunks/c.md' },
    ]));
    writeJson(path.join(indexes, 'keywords.json'), versioned('keywords', {
        '*NODE': { manualId: 'vol-i', sectionId: 'node', anchorId: 'node-anchor', pdfPage: 12 },
        '*MAT_024': { manualId: 'vol-i', sectionId: 'mat-024', anchorId: 'mat-anchor', pdfPage: 42 },
        '*MAT_PIECEWISE_LINEAR_PLASTICITY': {
            manualId: 'vol-i', sectionId: 'mat-024', anchorId: 'mat-anchor', pdfPage: 42,
        },
        '*MAT_CONCRETE_DAMAGE': {
            manualId: 'vol-i', sectionId: 'mat-072', anchorId: 'mat-072-anchor', pdfPage: 72,
        },
        '*CONTROL_TIMESTEP': { manualId: 'vol-i', sectionId: 'control-timestep', anchorId: null, pdfPage: 88 },
    }));
    writeJson(path.join(indexes, 'anchors.json'), versioned('anchors', {
        'node-anchor': { manualId: 'vol-i', sectionId: 'node' },
        'mat-anchor': { manualId: 'vol-i', sectionId: 'mat-024' },
        'mat-072-anchor': { manualId: 'vol-i', sectionId: 'mat-072' },
        'control-anchor': { manualId: 'theory', sectionId: 'control' },
    }));
    writeJson(path.join(indexes, 'sentence-map.json'), versioned('sentences', [
        {
            unitId: 'node-1', manualId: 'vol-i', sectionId: 'node', anchorId: 'node-anchor',
            sentenceHash: 'abc123', en: 'Define a node.', zh: '定义节点。',
        },
    ]));
    writeJson(path.join(indexes, 'search-en.json'), versioned('docs', [
        {
            manualId: 'vol-i', sectionId: 'node', titleEn: 'Node Definition',
            keywords: ['*NODE'], preview: 'A material example is included here.',
        },
        {
            manualId: 'vol-i', sectionId: 'mat-024', titleEn: 'Material Model',
            keywords: ['*MAT_024'], preview: 'Configure the selected model.',
        },
        { manualId: 'theory', sectionId: 'control', titleEn: 'Control Cards', keywords: ['*CONTROL_ONLY'], preview: 'Configure controls.' },
        {
            manualId: 'vol-i', sectionId: 'control-timestep', titleEn: '*CONTROL_TIMESTEP',
            keywords: ['*CONTROL_TIMESTEP'], preview: 'Mass scaling and timestep control.',
        },
        { manualId: 'theory', sectionId: 'a-tie', titleEn: 'Tie', preview: 'shared needle' },
        { manualId: 'vol-i', sectionId: 'b-tie', titleEn: 'Tie', preview: 'shared needle' },
        { manualId: 'vol-i', sectionId: 'c-tie', titleEn: 'Tie', preview: 'shared needle' },
    ]));
    writeJson(path.join(indexes, 'search-zh.json'), versioned('docs', [
        {
            manualId: 'vol-i', sectionId: 'node', titleZh: '节点定义',
            keywords: ['*NODE'], preview: '这里包含材料示例。',
        },
        {
            manualId: 'vol-i', sectionId: 'mat-024', titleZh: '材料模型',
            keywords: ['*MAT_024'], preview: '配置材料参数。',
        },
        {
            manualId: 'vol-i', sectionId: 'control-timestep', titleZh: '时间步控制',
            keywords: ['*CONTROL_TIMESTEP'], preview: '质量缩放与时间步。',
        },
    ]));
    return root;
}

function createEnglishOnlyPack() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-manual-index-en-only-'));
    const indexes = path.join(root, 'indexes');
    fs.mkdirSync(indexes);
    fs.mkdirSync(path.join(root, 'documents', 'en', 'vol-i', 'chunks'), { recursive: true });
    writeJson(path.join(root, 'manifest.json'), {
        schemaVersion: 2,
        generatedAt: '2026-07-20T00:00:00Z',
        flavor: 'en',
        languages: ['en'],
        defaultLanguage: 'en',
        features: { zhDocuments: false, sentenceMap: false, searchZh: false },
        documents: [{ slug: 'vol-i', title: 'Volume I', order: 1 }],
    });
    writeJson(path.join(indexes, 'sections.json'), versioned('sections', [
        {
            manualId: 'vol-i', sectionId: 'node', level: 2,
            titleEn: 'Node Definition', titleZh: '节点定义', anchors: ['node-anchor'],
            pathEn: 'documents/en/vol-i/chunks/node.md',
            pathZh: 'documents/zh/vol-i/chunks/node.md', pdfPage: 12,
        },
    ]));
    writeJson(path.join(indexes, 'keywords.json'), versioned('keywords', {
        '*NODE': { manualId: 'vol-i', sectionId: 'node', anchorId: 'node-anchor', pdfPage: 12 },
    }));
    writeJson(path.join(indexes, 'anchors.json'), versioned('anchors', {
        'node-anchor': { manualId: 'vol-i', sectionId: 'node' },
    }));
    writeJson(path.join(indexes, 'search-en.json'), versioned('docs', [
        {
            manualId: 'vol-i', sectionId: 'node', titleEn: 'Node Definition',
            keywords: ['*NODE'], preview: 'Define a node.',
        },
    ]));
    return root;
}

describe('ManualIndexRepository', () => {
    let packRoot;

    beforeEach(() => {
        packRoot = createFixturePack();
    });

    afterEach(() => {
        fs.rmSync(packRoot, { recursive: true, force: true });
    });

    it('infers bilingual capabilities for legacy packs with zh indexes', () => {
        const repository = new ManualIndexRepository(packRoot);
        const caps = repository.getCapabilities();
        assert.strictEqual(caps.flavor, 'bilingual');
        assert.strictEqual(caps.canReadZh, true);
        assert.strictEqual(caps.canToggleLanguage, true);
        assert.strictEqual(caps.features.searchZh, true);
        assert.strictEqual(caps.features.sentenceMap, true);
    });

    it('loads an English-only pack without requiring zh indexes or sentence-map', () => {
        const enRoot = createEnglishOnlyPack();
        try {
            const repository = new ManualIndexRepository(enRoot);
            repository.loadNavigation();
            const caps = repository.getCapabilities();
            assert.strictEqual(caps.flavor, 'en');
            assert.strictEqual(caps.canReadZh, false);
            assert.strictEqual(caps.canToggleLanguage, false);
            assert.strictEqual(repository.sectionPath('vol-i', 'node', 'zh'), null);
            assert.strictEqual(repository.sectionPath('vol-i', 'node', 'en'), 'documents/en/vol-i/chunks/node.md');
            assert.strictEqual(repository.sentenceCount(), 0);
            assert.deepStrictEqual(repository.search('node', 'zh').map(r => r.location.sectionId), ['node']);
            assert.deepStrictEqual(repository.search('node', 'both').map(r => r.matchedLanguages), [['en']]);
        } finally {
            fs.rmSync(enRoot, { recursive: true, force: true });
        }
    });

    it('resolves document PDFs from pdfFile with legacy title fallback', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-manual-pdf-resolve-'));
        try {
            const indexes = path.join(root, 'indexes');
            fs.mkdirSync(indexes);
            fs.mkdirSync(path.join(root, 'pdf'), { recursive: true });
            const declared = path.join(root, 'pdf', 'Volume I R16.zh-CN.pdf');
            const legacy = path.join(root, 'pdf', 'Theory Manual.pdf');
            fs.writeFileSync(declared, 'pdf');
            fs.writeFileSync(legacy, 'pdf');
            writeJson(path.join(root, 'manifest.json'), {
                schemaVersion: 2,
                documents: [
                    { slug: 'vol-i', title: 'Volume I', order: 1, pdfFile: 'pdf/Volume I R16.zh-CN.pdf' },
                    { slug: 'theory', title: 'Theory Manual', order: 2 },
                ],
            });
            writeJson(path.join(indexes, 'sections.json'), versioned('sections', []));
            writeJson(path.join(indexes, 'keywords.json'), versioned('keywords', {}));
            writeJson(path.join(indexes, 'anchors.json'), versioned('anchors', {}));

            const repository = new ManualIndexRepository(root);
            assert.strictEqual(repository.resolveDocumentPdfPath('vol-i'), path.resolve(declared));
            assert.strictEqual(repository.resolveDocumentPdfPath('theory'), path.resolve(legacy));
            assert.strictEqual(repository.resolveDocumentPdfPath('missing'), null);
            assert.deepStrictEqual(
                repository.listDeclaredPdfPaths().map(p => path.basename(p)).sort(),
                ['Theory Manual.pdf', 'Volume I R16.zh-CN.pdf']
            );
            assert.strictEqual(repository.listDocuments()[0].pdfFile, 'pdf/Volume I R16.zh-CN.pdf');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('loads navigation without reading sentence or search indexes until they are used', () => {
        const reads = [];
        const originalReadFileSync = fs.readFileSync;
        fs.readFileSync = function (file, ...args) {
            reads.push(path.basename(file));
            return originalReadFileSync.call(this, file, ...args);
        };

        try {
            const repository = new ManualIndexRepository(packRoot);
            assert.strictEqual(repository.keywordCount(), 5);
            assert.strictEqual(repository.sectionCount(), 10);
            assert.ok(reads.includes('keywords.json'));
            assert.ok(reads.includes('sections.json'));
            assert.ok(reads.includes('anchors.json'));
            assert.ok(!reads.includes('sentence-map.json'));
            assert.ok(!reads.includes('search-en.json'));
            assert.ok(!reads.includes('search-zh.json'));

            repository.getSectionSentences('vol-i', 'node');
            assert.ok(reads.includes('sentence-map.json'));
            assert.ok(!reads.includes('search-en.json'));

            repository.search('node', 'en');
            assert.ok(reads.includes('search-en.json'));
            assert.ok(!reads.includes('search-zh.json'));
        } finally {
            fs.readFileSync = originalReadFileSync;
        }
    });

    it('distinguishes exact, schema-backed section, and approximate matches', () => {
        const repository = new ManualIndexRepository(packRoot);

        assert.deepStrictEqual(repository.resolveKeyword('mat_024'), {
            manualId: 'vol-i', sectionId: 'mat-024', anchorId: 'mat-anchor', pdfPage: 42, title: 'Material Model',
            requestedKeyword: '*MAT_024', matchedKeyword: '*MAT_024', matchKind: 'exact',
        });
        assert.deepStrictEqual(repository.resolveKeyword('*MAT_024_LOG_INTERPOLATION'), {
            manualId: 'vol-i', sectionId: 'mat-024', anchorId: 'mat-anchor', pdfPage: 42, title: 'Material Model',
            requestedKeyword: '*MAT_024_LOG_INTERPOLATION', matchedKeyword: '*MAT_024', matchKind: 'section',
        });
        assert.deepStrictEqual(repository.resolveKeyword('*MAT_CONCRETE_DAMAGE_PLASTIC_MODEL'), {
            manualId: 'vol-i', sectionId: 'mat-072', anchorId: 'mat-072-anchor', pdfPage: 72, title: 'Concrete Damage',
            requestedKeyword: '*MAT_CONCRETE_DAMAGE_PLASTIC_MODEL',
            matchedKeyword: '*MAT_CONCRETE_DAMAGE',
            matchKind: 'approximate',
        });
        assert.strictEqual(repository.resolveKeyword('*MAT_UNKNOWN'), null);
    });

    it('recovers real chapter collisions from legacy section titles', () => {
        const repository = new ManualIndexRepository(packRoot);

        assert.deepStrictEqual(
            repository.resolveKeywordLocations('*MAT_ALE_INCOMPRESSIBLE').map(location => [
                location.sectionId,
                location.pdfPage,
                location.matchKind,
            ]),
            [
                ['mat-160', 160, 'exact'],
                ['mat-ale-05', 205, 'exact'],
            ],
        );
        assert.deepStrictEqual(
            repository.resolveKeywordLocations('*MAT_160').map(location => location.sectionId),
            ['mat-160'],
        );
        assert.deepStrictEqual(
            repository.resolveKeywordLocations('*MAT_ALE_05').map(location => location.sectionId),
            ['mat-ale-05'],
        );
    });

    it('does not turn repeated one-name headings into chapter choices', () => {
        const sectionFile = path.join(packRoot, 'indexes', 'sections.json');
        const sectionDoc = JSON.parse(fs.readFileSync(sectionFile, 'utf8'));
        sectionDoc.sections.push({
            manualId: 'vol-i', sectionId: 'restart-control-timestep', level: 2,
            titleEn: '*CONTROL_TIMESTEP', titleZh: '重启动时间步控制',
            anchors: ['restart-control-timestep'],
            pathEn: 'documents/en/vol-i/chunks/restart-control-timestep.md',
            pathZh: 'documents/zh/vol-i/chunks/restart-control-timestep.md',
            pdfPage: 88,
        });
        writeJson(sectionFile, sectionDoc);

        const repository = new ManualIndexRepository(packRoot);
        assert.deepStrictEqual(
            repository.resolveKeywordLocations('*CONTROL_TIMESTEP').map(location => location.sectionId),
            ['control-timestep'],
        );
    });

    it('loads explicit alternateLocations while preserving the legacy primary', () => {
        const keywordFile = path.join(packRoot, 'indexes', 'keywords.json');
        const keywordDoc = JSON.parse(fs.readFileSync(keywordFile, 'utf8'));
        keywordDoc.keywords['*MAT_ALE_INCOMPRESSIBLE'] = {
            manualId: 'vol-i', sectionId: 'mat-160', anchorId: 'mat-160-anchor', pdfPage: 160,
            alternateLocations: [
                {
                    manualId: 'vol-i', sectionId: 'mat-ale-05',
                    anchorId: 'mat-ale-05-anchor', pdfPage: 205,
                },
            ],
        };
        writeJson(keywordFile, keywordDoc);

        const repository = new ManualIndexRepository(packRoot);
        const locations = repository.resolveKeywordLocations('*MAT_ALE_INCOMPRESSIBLE');
        assert.deepStrictEqual(locations.map(location => location.sectionId), ['mat-160', 'mat-ale-05']);
        assert.strictEqual(repository.resolveKeyword('*MAT_ALE_INCOMPRESSIBLE').sectionId, 'mat-160');
    });

    it('derives the same authoritative title keys as the manual builder', () => {
        assert.deepStrictEqual(
            keywordKeysForSectionTitle('MAT_054-055/MAT_ENHANCED_COMPOSITE_DAMAGE'),
            ['*MAT_054', '*MAT_055', '*MAT_ENHANCED_COMPOSITE_DAMAGE'],
        );
        assert.deepStrictEqual(
            keywordKeysForSectionTitle('MAT_181/MAT_SIMPLIFIED_RUBBER/FOAM'),
            ['*MAT_181', '*MAT_SIMPLIFIED_RUBBER'],
        );
        assert.deepStrictEqual(
            keywordKeysForSectionTitle('*CONTACT_2D_[SLIDING, TIED, & PENALTY]'),
            ['*CONTACT_2D'],
        );
    });

    it('searches each language with stable scores and deduplicates bilingual results', () => {
        const repository = new ManualIndexRepository(packRoot);

        // Default mode is keyword: title/keywords only (no preview noise).
        const englishKeyword = repository.search('material', 'en');
        assert.deepStrictEqual(englishKeyword.map(result => [result.location.sectionId, result.score]), [
            ['mat-024', 3500],
        ]);

        const englishFulltext = repository.search('material', 'en', 100, 'fulltext');
        assert.deepStrictEqual(englishFulltext.map(result => [result.location.sectionId, result.score]), [
            ['mat-024', 3500],
            ['node', 1600],
        ]);

        const chineseFulltext = repository.search('材料', 'zh', 100, 'fulltext');
        assert.deepStrictEqual(chineseFulltext.map(result => [result.location.sectionId, result.score]), [
            ['mat-024', 3500],
            ['node', 1600],
        ]);

        const bilingual = repository.search('*MAT_024', 'both');
        assert.strictEqual(bilingual.length, 1);
        assert.strictEqual(bilingual[0].location.sectionId, 'mat-024');
        assert.strictEqual(bilingual[0].score, 5000);
        assert.deepStrictEqual(bilingual[0].matchedLanguages, ['en', 'zh']);

        assert.strictEqual(repository.search('*CONTROL_ONLY', 'en')[0].score, 4500);
        assert.strictEqual(repository.search('Material Model', 'en')[0].score, 4000);
        assert.strictEqual(repository.search('Model', 'en')[0].score, 3000);
        assert.strictEqual(repository.search('selected model', 'en', 100, 'fulltext')[0].score, 1700);
        assert.deepStrictEqual(repository.search('selected model', 'en', 100, 'keyword'), []);

        assert.deepStrictEqual(repository.search('shared needle', 'en', 100, 'fulltext').map(result => [
            result.titleEn, result.location.manualId, result.location.sectionId,
        ]), [
            ['Tie', 'theory', 'a-tie'],
            ['Tie', 'vol-i', 'b-tie'],
            ['Tie', 'vol-i', 'c-tie'],
        ]);
        assert.deepStrictEqual(repository.search('shared needle', 'en', 100, 'keyword'), []);
    });

    it('warms the sentence map idempotently via ensureSentencesLoaded', () => {
        const repository = new ManualIndexRepository(packRoot);
        assert.strictEqual(repository.isSentencesLoaded(), false);
        repository.ensureSentencesLoaded();
        assert.strictEqual(repository.isSentencesLoaded(), true);
        assert.strictEqual(repository.sentenceCount(), 1);
        repository.ensureSentencesLoaded();
        assert.strictEqual(repository.sentenceCount(), 1);
    });

    it('matches LS-DYNA keywords when spaces replace underscores', () => {
        const repository = new ManualIndexRepository(packRoot);

        const spaced = repository.search('control time', 'en', 100, 'keyword');
        assert.ok(spaced.length >= 1, 'expected hits for "control time"');
        assert.strictEqual(spaced[0].location.sectionId, 'control-timestep');
        assert.ok(spaced[0].score >= 2800);

        assert.strictEqual(repository.search('control_time', 'en', 100, 'keyword')[0].location.sectionId, 'control-timestep');
        assert.strictEqual(repository.search('CONTROL TIME', 'en', 100, 'keyword')[0].location.sectionId, 'control-timestep');
        assert.strictEqual(repository.search('*control timestep', 'en', 100, 'keyword')[0].location.sectionId, 'control-timestep');
        assert.strictEqual(repository.search('CONTROL_TIMESTEP', 'en', 100, 'keyword')[0].location.sectionId, 'control-timestep');

        // Token-AND should not rank CONTROL_ONLY above CONTROL_TIMESTEP for "control time".
        assert.ok(!spaced.some(r => r.location.sectionId === 'control' && r.score >= spaced[0].score));
    });

    it('resolves anchors and normalized English or Chinese section paths', () => {
        const repository = new ManualIndexRepository(packRoot);

        assert.deepStrictEqual(repository.resolveAnchor('mat-anchor'), {
            manualId: 'vol-i', sectionId: 'mat-024', anchorId: 'mat-anchor', pdfPage: 42, title: 'Material Model',
        });
        assert.strictEqual(repository.resolveSectionPath('./documents/en/vol-i/chunks/node.md').sectionId, 'node');
        assert.strictEqual(repository.resolveSectionPath('documents\\zh\\vol-i\\chunks\\mat-024.md').sectionId, 'mat-024');
        assert.strictEqual(repository.resolveSectionPath('documents/en/missing.md'), null);
    });
});
