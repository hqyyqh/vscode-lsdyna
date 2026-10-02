'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { ManualIndexRepository } = require('../../src/manual/ManualIndexRepository');
const { ManualReaderPanel } = require('../../src/manual/ManualReaderPanel');
const i18n = require('../../src/core/i18n');

function versioned(key, value) { return { schemaVersion: 1, [key]: value }; }

describe('ManualReaderPanel React host', () => {
    let root;
    let panel;
    let panelOptions;
    let htmlAssignments;
    let outbound;
    let disposers;
    let savedStates;
    let commands;
    let externalUris;
    let originalCreatePanel;
    let originalExecuteCommand;
    let originalOpenExternal;
    let originalLanguage;
    let originalGetConfiguration;
    let requestId;

    beforeEach(() => {
        originalLanguage = vscode.env.language;
        originalGetConfiguration = vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'language' ? 'auto' : defaultValue,
        });
        // Chinese VS Code UI enables language toggle + Alt sentence pairs.
        vscode.env.language = 'zh-cn';
        i18n.updateLanguage();
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-manual-reader-'));
        const indexes = path.join(root, 'indexes');
        fs.mkdirSync(indexes, { recursive: true });
        for (const language of ['en', 'zh']) {
            const chunks = path.join(root, 'documents', language, 'vol', 'chunks');
            const assets = path.join(root, 'documents', language, 'vol', 'assets');
            fs.mkdirSync(chunks, { recursive: true });
            fs.mkdirSync(assets, { recursive: true });
            const heading = language === 'zh' ? '公式' : 'Formula';
            const sentence = language === 'zh' ? '此卡片控制质量缩放行为。' : 'This card controls mass scaling behavior.';
            fs.writeFileSync(path.join(chunks, 'formula.md'), `<a id="formula"></a>\n# ${heading}\n\n${sentence}\n\n$$\n\\frac{a}{b}\n$$\n\n![sample](../assets/sample.png)\n`);
            fs.writeFileSync(path.join(chunks, 'next.md'), `<a id="next"></a>\n# ${language === 'zh' ? '下一节' : 'Next section'}\n`);
            fs.writeFileSync(path.join(assets, 'sample.png'), 'png');
        }
        fs.mkdirSync(path.join(root, 'pdf'), { recursive: true });
        fs.writeFileSync(path.join(root, 'pdf', 'Volume.pdf'), 'pdf');
        fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 2, generatedAt: 'test', documents: [{ slug: 'vol', title: 'Volume', order: 1 }] }));
        fs.writeFileSync(path.join(indexes, 'sections.json'), JSON.stringify(versioned('sections', [
            { manualId: 'vol', sectionId: 'formula', level: 1, titleEn: 'Formula', titleZh: '公式', anchors: ['formula'], pathEn: 'documents/en/vol/chunks/formula.md', pathZh: 'documents/zh/vol/chunks/formula.md', pdfPage: 1 },
            { manualId: 'vol', sectionId: 'next', level: 1, titleEn: 'Next section', titleZh: '下一节', anchors: ['next'], pathEn: 'documents/en/vol/chunks/next.md', pathZh: 'documents/zh/vol/chunks/next.md', pdfPage: 2 },
        ])));
        fs.writeFileSync(path.join(indexes, 'keywords.json'), JSON.stringify(versioned('keywords', {})));
        fs.writeFileSync(path.join(indexes, 'anchors.json'), JSON.stringify(versioned('anchors', {
            formula: { manualId: 'vol', sectionId: 'formula' }, next: { manualId: 'vol', sectionId: 'next' },
        })));
        fs.writeFileSync(path.join(indexes, 'sentence-map.json'), JSON.stringify(versioned('sentences', [
            { unitId: 'u1', manualId: 'vol', sectionId: 'formula', anchorId: 'formula', sentenceHash: 'hash', en: 'This card controls mass scaling behavior.', zh: '此卡片控制质量缩放行为。' },
            { unitId: 'u2', manualId: 'vol', sectionId: 'formula', anchorId: 'formula', sentenceHash: 'hash2', en: 'Default', zh: '默认' },
            { unitId: 'u3', manualId: 'vol', sectionId: 'formula', anchorId: 'formula', sentenceHash: 'hash3', en: 'Same both sides', zh: 'Same both sides' },
            { unitId: 'u4', manualId: 'vol', sectionId: 'formula', anchorId: 'formula', sentenceHash: 'hash4', en: 'Optional card', zh: '可选卡片 D', matchZh: '可选卡片' },
        ])));
        const docs = [{ manualId: 'vol', sectionId: 'formula', titleEn: 'Formula', titleZh: '公式', keywords: ['*CONTROL_TIMESTEP'], preview: 'mass scaling behavior' }];
        fs.writeFileSync(path.join(indexes, 'search-en.json'), JSON.stringify(versioned('docs', docs)));
        fs.writeFileSync(path.join(indexes, 'search-zh.json'), JSON.stringify(versioned('docs', docs)));

        htmlAssignments = 0;
        outbound = [];
        disposers = [];
        savedStates = [];
        commands = [];
        externalUris = [];
        requestId = 0;
        const webview = {
            cspSource: 'vscode-resource:',
            asWebviewUri: uri => ({ toString: () => `vscode-resource:${uri.fsPath.replace(/\\/g, '/')}` }),
            onDidReceiveMessage(callback) { panel.onMessage = callback; return { dispose() {} }; },
            postMessage(message) { outbound.push(message); return Promise.resolve(true); },
        };
        Object.defineProperty(webview, 'html', {
            get() { return this._html || ''; },
            set(value) { htmlAssignments++; this._html = value; },
        });
        originalCreatePanel = vscode.window.createWebviewPanel;
        vscode.window.createWebviewPanel = (_viewType, _title, column, options) => {
            panelOptions = options;
            const reveals = [];
            panel = {
                viewType: 'lsdynaManualReader',
                title: '',
                visible: true,
                // First open uses ViewColumn.Beside; subsequent TOC navigations must
                // re-reveal this same column (not Beside again relative to active editor).
                viewColumn: column ?? vscode.ViewColumn.Beside,
                webview,
                reveals,
                reveal(targetColumn) { reveals.push(targetColumn); },
                onDidDispose(callback) { disposers.push(callback); return { dispose() {} }; },
                dispose() { disposers.splice(0).forEach(callback => callback()); },
            };
            return panel;
        };
        originalExecuteCommand = vscode.commands.executeCommand;
        vscode.commands.executeCommand = async (...args) => { commands.push(args); };
        originalOpenExternal = vscode.env.openExternal;
        vscode.env.openExternal = async uri => { externalUris.push(String(uri)); return true; };
    });

    afterEach(() => {
        if (panel) panel.dispose();
        vscode.window.createWebviewPanel = originalCreatePanel;
        vscode.commands.executeCommand = originalExecuteCommand;
        vscode.env.openExternal = originalOpenExternal;
        vscode.env.language = originalLanguage;
        vscode.workspace.getConfiguration = originalGetConfiguration;
        i18n.updateLanguage();
        fs.rmSync(root, { recursive: true, force: true });
    });

    function show(restored) {
        const repository = new ManualIndexRepository(root);
        repository.loadNavigation();
        const manager = { saveState(_packRoot, state) { savedStates.push(state); } };
        return ManualReaderPanel.show(root, repository, manager, { manualId: 'vol', sectionId: 'formula', anchorId: 'formula' }, restored);
    }

    async function request(method, params) {
        const id = `request-${++requestId}`;
        await panel.onMessage({ id, method, receiver: { type: 'extension' }, params });
        await new Promise(resolve => setImmediate(resolve));
        return outbound.find(message => message.id === id && !message.method);
    }

    async function notify(method, params) {
        await panel.onMessage({ method, receiver: { type: 'extension' }, params });
        await new Promise(resolve => setImmediate(resolve));
    }

    function latestState() {
        const states = outbound.filter(message => message.method === 'reader/stateChanged');
        return states.at(-1)?.params;
    }

    it('reveals the existing editor column on TOC navigations (not ViewColumn.Beside again)', async () => {
        show();
        assert.deepEqual(panel.reveals, [vscode.ViewColumn.Beside]);
        // Simulate user having dragged the reader into a fixed column.
        panel.viewColumn = vscode.ViewColumn.Two;
        show();
        assert.deepEqual(panel.reveals, [vscode.ViewColumn.Beside, vscode.ViewColumn.Two]);
        show();
        assert.deepEqual(panel.reveals, [
            vscode.ViewColumn.Beside,
            vscode.ViewColumn.Two,
            vscode.ViewColumn.Two,
        ]);
        assert.equal(htmlAssignments, 1, 'TOC open reuses the same panel shell');
    });

    it('initializes one strict static shell and rejects actions from stale revisions', async () => {
        show({ language: 'zh', scrollY: 73 });

        assert.equal(htmlAssignments, 1);
        assert.match(panel.webview.html, /default-src 'none'/);
        assert.match(panel.webview.html, /script-src vscode-resource: 'nonce-[^']+'/);
        assert.match(panel.webview.html, /style-src vscode-resource:/);
        assert.ok(!panel.webview.html.includes("'unsafe-inline'"));
        assert.match(panel.webview.html, /assets\/index-.*\.js/);
        assert.match(panel.webview.html, /assets\/index-.*\.css/);
        assert.equal(panelOptions.localResourceRoots.length, 2);
        assert.ok(panelOptions.localResourceRoots.some(uri => path.resolve(uri.fsPath) === path.resolve(root)));
        assert.ok(panelOptions.localResourceRoots.some(uri => uri.fsPath.replace(/\\/g, '/').endsWith('/out/webview/manual-reader')));

        const ready = await request('reader/ready', { revision: -1 });
        const initial = ready.result;
        assert.equal(initial.content.kind, 'document');
        assert.equal(initial.uiLocale, 'zh');
        assert.equal(initial.language, 'zh');
        assert.match(initial.content.markdown, /\\frac\{a\}\{b\}/);
        assert.match(initial.content.chunkBaseUri, /documents\/zh\/vol\/chunks/);
        assert.deepEqual(initial.content.sentencePairs, [
            { primary: '此卡片控制质量缩放行为。', secondary: 'This card controls mass scaling behavior.', unitId: 'u1' },
            { primary: '可选卡片', secondary: 'Optional card', unitId: 'u4' },
            { primary: '默认', secondary: 'Default', unitId: 'u2' },
        ]);
        assert.deepEqual(initial.restore, { anchorId: 'formula', scrollY: 73, scrollRatio: 0 });

        const moved = await request('reader/navigate', { revision: initial.revision, target: 'nextSection' });
        assert.equal(moved.result, true);
        assert.equal(htmlAssignments, 1, 'navigation must not replace webview.html');
        assert.match(panel.title, /下一节/);
        const afterMove = latestState();
        assert.ok(afterMove.revision > initial.revision);
        assert.equal(afterMove.location.sectionId, 'next');

        const stale = await request('reader/toggleLanguage', { revision: initial.revision });
        assert.equal(stale.result, false);
        assert.equal(latestState().language, 'zh');
    });

    it('handles language, search, repository links, external links, PDF, and persisted scroll state', async () => {
        show();
        let current = (await request('reader/ready', { revision: -1 })).result;
        assert.equal(current.uiLocale, 'zh');
        assert.equal(current.language, 'zh');

        await notify('reader/scrollChanged', { revision: current.revision, scrollY: 240, scrollRatio: 0.6, anchorId: 'formula' });

        assert.equal((await request('reader/toggleLanguage', { revision: current.revision })).result, true);
        current = latestState();
        assert.equal(current.language, 'en');
        assert.match(current.content.markdown, /This card controls mass scaling behavior/);
        assert.deepEqual(current.restore, { anchorId: 'formula', scrollY: 240, scrollRatio: 0.6 });

        // Default keyword mode ignores preview-only hits.
        assert.equal((await request('reader/search', { revision: current.revision, query: 'mass', scope: 'both' })).result, true);
        current = latestState();
        assert.equal(current.search.mode, 'keyword');
        assert.equal(current.search.results.length, 0);

        assert.equal((await request('reader/search', {
            revision: current.revision, query: 'mass', scope: 'both', mode: 'fulltext',
        })).result, true);
        current = latestState();
        assert.equal(current.search.mode, 'fulltext');
        assert.equal(current.search.results.length, 1);
        assert.deepEqual(current.search.results[0].matchedLanguages.sort(), ['en', 'zh']);

        assert.equal((await request('reader/openLink', { revision: current.revision, href: '#next' })).result, true);
        current = latestState();
        assert.equal(current.location.sectionId, 'next');

        assert.equal((await request('reader/openLink', { revision: current.revision, href: 'https://example.com/manual' })).result, true);
        assert.deepEqual(externalUris, ['https://example.com/manual']);

        assert.equal((await request('reader/openPdf', { revision: current.revision })).result, true);
        assert.deepEqual(commands[0], ['extension.openManual', path.join(root, 'pdf', 'Volume.pdf'), 2]);
        // Second open is a path-cache hit and still uses the same fire-and-forget command.
        assert.equal((await request('reader/openPdf', { revision: current.revision })).result, true);
        assert.equal(commands.length, 2);
        assert.deepEqual(commands[1], commands[0]);

        await notify('reader/scrollChanged', { revision: current.revision, scrollY: 333, scrollRatio: 0.75, anchorId: 'next' });
        panel.dispose();
        panel = null;
        assert.equal(savedStates.at(-1).scrollY, 333);
        assert.equal(savedStates.at(-1).scrollRatio, 0.75);
        assert.equal(savedStates.at(-1).location.anchorId, 'next');
    });

    it('allows bilingual document toggle under English VS Code UI when pack supports zh', async () => {
        vscode.env.language = 'en';
        i18n.updateLanguage();
        show({ language: 'zh', scrollY: 10 });
        const ready = await request('reader/ready', { revision: -1 });
        const initial = ready.result;
        // Chrome stays English (uiLocale); document language follows pack/restored preference.
        assert.equal(initial.uiLocale, 'en');
        assert.equal(initial.canToggleLanguage, true);
        assert.equal(initial.language, 'zh');
        assert.match(initial.content.chunkBaseUri, /documents\/zh\/vol\/chunks/);
        // Sentence pairs are available whenever sentence-map exists (not gated on UI locale).
        assert.ok(initial.content.sentencePairs.length > 0);
        assert.equal((await request('reader/toggleLanguage', { revision: initial.revision })).result, true);
        assert.equal(latestState().language, 'en');
        assert.match(latestState().content.chunkBaseUri, /documents\/en\/vol\/chunks/);
    });

    it('refreshes reader chrome when the extension language setting changes', async () => {
        const originalGetConfiguration = vscode.workspace.getConfiguration;
        let language = 'en';
        vscode.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'language' ? language : defaultValue,
        });

        try {
            i18n.updateLanguage();
            show();
            const ready = await request('reader/ready', { revision: -1 });
            assert.equal(ready.result.uiLocale, 'en');
            assert.match(panel.title, / - Manual$/);

            language = 'zh-cn';
            i18n.updateLanguage();
            ManualReaderPanel.refreshUiLanguage();
            assert.equal(latestState().uiLocale, 'zh');
            assert.match(panel.title, /（手册）$/);
            assert.equal(htmlAssignments, 1, 'changing chrome language must not rebuild the webview shell');
        } finally {
            vscode.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });

    it('opens PDF using pack index pdfPage (not live bookmark overrides)', async () => {
        const manualIndexer = require('../../src/core/manualIndexer');
        const original = manualIndexer.getManualLocations;
        const pdfPath = path.join(root, 'pdf', 'Volume.pdf');
        // Even if hover bookmarks claim another page, reader trusts pack indexes.
        manualIndexer.getManualLocations = () => [{ file: pdfPath, page: 99 }];
        try {
            show({ language: 'en' });
            const ready = await request('reader/ready', { revision: -1 });
            // Section formula has pdfPage: 1 in the fixture index.
            assert.equal((await request('reader/openPdf', { revision: ready.result.revision })).result, true);
            assert.deepEqual(commands[0], ['extension.openManual', pdfPath, 1]);
        } finally {
            manualIndexer.getManualLocations = original;
        }
    });

    it('opens PDF via manifest pdfFile when title.pdf is absent', async () => {
        const zhOnly = path.join(root, 'pdf', 'Volume R16.zh-CN.pdf');
        fs.writeFileSync(zhOnly, 'pdf');
        fs.unlinkSync(path.join(root, 'pdf', 'Volume.pdf'));
        fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
            schemaVersion: 2,
            generatedAt: 'test',
            documents: [{ slug: 'vol', title: 'Volume', order: 1, pdfFile: 'pdf/Volume R16.zh-CN.pdf' }],
        }));
        // Recreate panel against updated manifest.
        if (panel) {
            panel.dispose();
            panel = null;
        }
        show({ language: 'zh' });
        const ready = await request('reader/ready', { revision: -1 });
        assert.equal((await request('reader/openPdf', { revision: ready.result.revision })).result, true);
        assert.deepEqual(commands[0], ['extension.openManual', path.resolve(zhOnly), 1]);
    });
});
