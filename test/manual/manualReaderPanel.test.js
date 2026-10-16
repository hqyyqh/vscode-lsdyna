'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { ManualIndexRepository } = require('../../src/manual/ManualIndexRepository');
const { ManualReaderPanel } = require('../../src/manual/ManualReaderPanel');
const { ManualPackManager } = require('../../src/manual/ManualPackManager');
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
        // Default reading language follows the effective plugin locale.
        vscode.env.language = 'zh-cn';
        i18n.updateLanguage();
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-manual-reader-')));
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
        const location = { manualId: 'vol', sectionId: 'formula', anchorId: 'formula' };
        return ManualReaderPanel.show(root, repository, manager, location, restored && { location, ...restored });
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

    function replaceManifest(patch) {
        const file = path.join(root, 'manifest.json');
        const modified = fs.statSync(file).mtimeMs + 1000;
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }));
        fs.utimesSync(file, new Date(modified), new Date(modified));
    }

    for (const host of ['en', 'zh-cn']) for (const setting of ['auto', 'en', 'zh-cn']) {
        it(`defaults bilingual content to effective locale (${host}/${setting})`, async () => {
            vscode.env.language = host;
            vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => key === 'language' ? setting : fallback });
            i18n.updateLanguage();
            const expected = (setting === 'auto' ? host : setting) === 'en' ? 'en' : 'zh';
            replaceManifest({ defaultLanguage: expected === 'en' ? 'zh' : 'en' });
            show();
            const state = (await request('reader/ready', { revision: -1 })).result;
            assert.equal(state.language, expected);
            assert.equal(state.search.scope, expected);
            assert.ok(state.content.chunkBaseUri.includes(`/documents/${expected}/`));
            panel.dispose();
            assert.equal(savedStates.at(-1).languagePreference, 'auto');
        });
    }

    it('keeps an open automatic document stable and follows locale after reopening', async () => {
        show();
        const initial = (await request('reader/ready', { revision: -1 })).result;
        vscode.env.language = 'en';
        i18n.updateLanguage();
        ManualReaderPanel.refreshUiLanguage();
        assert.equal(latestState().uiLocale, 'en');
        assert.equal(latestState().language, 'zh');
        assert.equal(latestState().content.markdown, initial.content.markdown);
        panel.dispose();
        show(savedStates.at(-1));
        const reopened = (await request('reader/ready', { revision: -1 })).result;
        assert.equal(reopened.language, 'en');
        assert.equal(reopened.location.title, 'Formula');
    });

    it('persists a deliberate same-language choice instead of treating it as automatic', async () => {
        show();
        const initial = (await request('reader/ready', { revision: -1 })).result;
        await request('reader/toggleLanguage', { revision: initial.revision, mode: 'zh' });
        panel.dispose();
        const saved = savedStates.at(-1);
        assert.equal(saved.languagePreference, 'zh');
        vscode.env.language = 'en';
        i18n.updateLanguage();
        show(saved);
        assert.equal((await request('reader/ready', { revision: -1 })).result.language, 'zh');
    });

    it('falls back to English without erasing the chosen Chinese preference', async () => {
        replaceManifest({ flavor: 'en', languages: ['en'], defaultLanguage: 'en' });
        show({ language: 'zh', languagePreference: 'zh', scrollY: 0 });
        const current = (await request('reader/ready', { revision: -1 })).result;
        assert.equal(current.language, 'en');
        assert.equal(current.canToggleLanguage, false);
        assert.equal((await request('reader/toggleLanguage', { revision: current.revision, mode: 'zh' })).result, false);
        panel.dispose();
        const saved = savedStates.at(-1);
        assert.equal(saved.languagePreference, 'zh');
        replaceManifest({ flavor: 'bilingual', languages: ['en', 'zh'], defaultLanguage: 'en' });
        show(saved);
        assert.equal((await request('reader/ready', { revision: -1 })).result.language, 'zh');
    });

    it('keeps a pack language choice across sections without restoring another section scroll', async () => {
        show({ language: 'en', languagePreference: 'en', location: { manualId: 'vol', sectionId: 'next' }, scrollY: 999, scrollRatio: 0.8 });
        const state = (await request('reader/ready', { revision: -1 })).result;
        assert.equal(state.language, 'en');
        assert.equal(state.location.sectionId, 'formula');
        assert.equal(state.restore.scrollY, 0);
        assert.equal(state.restore.scrollRatio, 0);
    });

    it('selects, persists and restores bilingual reading without changing source-language paths', async () => {
        show();
        const initial = (await request('reader/ready', { revision: -1 })).result;
        assert.equal(initial.canCompareLanguages, true);
        const selected = await request('reader/toggleLanguage', { revision: initial.revision, mode: 'bilingual', anchorId: 'reader-unit-u1' });
        assert.equal(selected.result, true);
        const current = latestState();
        assert.equal(current.language, 'zh');
        assert.equal(current.readingMode, 'bilingual');
        assert.equal(current.content.comparison, true);
        assert.equal(current.restore.anchorId, 'reader-unit-u1');
        assert.equal(current.search.scope, 'both');
        assert.equal((await request('reader/toggleLanguage', { revision: current.revision, mode: 'invalid' })).result, false);
        await new Promise(resolve => setTimeout(resolve, 240));
        assert.equal(savedStates.at(-1).readingMode, 'bilingual');
        const saved = savedStates.at(-1);
        panel.dispose();
        show(saved);
        assert.equal((await request('reader/ready', { revision: -1 })).result.readingMode, 'bilingual');
    });

    for (const [name, locations] of [
        ['chapter/cache', [
            { manualId: 'vol', sectionId: 'formula\u0000next', anchorId: 'anchor' },
            { manualId: 'vol\u0000formula', sectionId: 'next', anchorId: 'anchor' },
        ]],
        ['section/anchor', [
            { manualId: 'vol', sectionId: 'formula', anchorId: 'next\u0000anchor' },
            { manualId: 'vol', sectionId: 'formula\u0000next', anchorId: 'anchor' },
        ]],
    ]) {
        it(`keeps ${name} tuples separate in content, history and restored scroll`, async () => {
            const file = path.join(root, 'indexes', 'sections.json');
            const sections = JSON.parse(fs.readFileSync(file, 'utf8'));
            sections.sections.forEach((section, index) => {
                Object.assign(section, locations[index], { anchors: [locations[index].anchorId] });
            });
            fs.writeFileSync(file, JSON.stringify(sections));
            const repository = new ManualIndexRepository(root);
            const manager = { saveState(_packRoot, state) { savedStates.push(state); } };
            ManualReaderPanel.show(root, repository, manager, locations[0]);
            const first = (await request('reader/ready', { revision: -1 })).result;
            assert.match(first.content.markdown, /此卡片控制质量缩放行为/);
            await request('reader/navigate', { revision: first.revision, target: locations[1] });
            assert.match(latestState().content.markdown, /下一节/);
            assert.equal(latestState().navigation.canBack, true);
            await request('reader/navigate', { revision: latestState().revision, target: 'back' });
            assert.match(latestState().content.markdown, /此卡片控制质量缩放行为/);
            await notify('reader/scrollChanged', { revision: latestState().revision, scrollY: 180, scrollRatio: 0.6, anchorId: locations[0].anchorId });
            ManualReaderPanel.show(root, new ManualIndexRepository(root), manager, locations[1]);
            const second = latestState();
            assert.match(second.content.markdown, /下一节/);
            assert.equal(second.restore.scrollY, 0);
            assert.equal(second.restore.scrollRatio, 0);
            assert.equal(second.navigation.canBack, true);
            await request('reader/navigate', { revision: second.revision, target: 'back' });
            assert.deepEqual(latestState().location.manualId, locations[0].manualId);
            assert.deepEqual(latestState().location.sectionId, locations[0].sectionId);
            assert.match(latestState().content.markdown, /此卡片控制质量缩放行为/);
            await request('reader/navigate', { revision: latestState().revision, target: locations[1] });
            assert.match(latestState().content.markdown, /下一节/);
            await request('reader/toggleLanguage', { revision: latestState().revision });
            assert.match(latestState().content.markdown, /Next section/);
            await request('reader/navigate', { revision: latestState().revision, target: 'back' });
            assert.match(latestState().content.markdown, /This card controls mass scaling behavior/);
            assert.equal(htmlAssignments, 1);
        });
    }

    it('uses a refreshed same-root manager repository while preserving history, scroll and the panel shell', async () => {
        const state = new Map();
        const manager = new ManualPackManager({ globalState: {
            get: key => state.get(key), update: async (key, value) => { state.set(key, value); },
        } });
        const original = manager.getRepository(root);
        ManualReaderPanel.show(root, original, manager, { manualId: 'vol', sectionId: 'formula' });
        const initial = (await request('reader/ready', { revision: -1 })).result;
        await request('reader/navigate', { revision: initial.revision, target: 'nextSection' });
        const before = latestState();
        await notify('reader/scrollChanged', { revision: before.revision, scrollY: 180, scrollRatio: 0.6, anchorId: 'next' });
        for (const language of ['en', 'zh']) {
            fs.writeFileSync(path.join(root, 'documents', language, 'vol', 'chunks', 'next.md'),
                `<a id="next"></a>\n${language === 'en' ? 'Updated chapter body.' : '本章内容已更新。'}`);
        }
        const sectionsFile = path.join(root, 'indexes', 'sections.json');
        const sections = JSON.parse(fs.readFileSync(sectionsFile, 'utf8'));
        Object.assign(sections.sections[1], { titleEn: 'Updated next section', titleZh: '更新后的下一节', pdfPage: 42 });
        fs.writeFileSync(sectionsFile, JSON.stringify(sections));
        fs.writeFileSync(path.join(root, 'pdf', 'Updated.pdf'), 'pdf');
        replaceManifest({ generatedAt: 'updated', documents: [{ slug: 'vol', title: 'Updated volume', pdfFile: 'pdf/Updated.pdf' }] });
        const refreshed = manager.getRepository(root);
        assert.notStrictEqual(refreshed, original);
        panel.viewColumn = vscode.ViewColumn.Two;
        ManualReaderPanel.show(root, refreshed, manager, { manualId: 'vol', sectionId: 'next', anchorId: 'next' });
        const after = latestState();
        assert.match(after.content.markdown, /本章内容已更新/);
        assert.match(panel.title, /更新后的下一节/);
        assert.equal(after.location.pdfPage, 42);
        assert.equal(after.restore.scrollY, 180);
        assert.equal(after.restore.scrollRatio, 0.6);
        assert.equal(after.navigation.canBack, true);
        assert.equal(htmlAssignments, 1);
        assert.equal(panel.reveals.at(-1), vscode.ViewColumn.Two);
        assert.ok(after.revision > before.revision);
        assert.equal((await request('reader/toggleLanguage', { revision: before.revision })).result, false);
        await request('reader/openPdf', { revision: after.revision });
        assert.deepEqual(commands.at(-1), ['extension.openManual', path.join(root, 'pdf', 'Updated.pdf'), 42]);
        const back = await request('reader/navigate', { revision: after.revision, target: 'back' });
        assert.equal(back.result, true);
        assert.equal(latestState().location.sectionId, 'formula');
    });

    it('updates same-root language capabilities while retaining the user’s chosen language when supported', async () => {
        const manager = new ManualPackManager({});
        ManualReaderPanel.show(root, manager.getRepository(root), manager, { manualId: 'vol', sectionId: 'formula' });
        const initial = (await request('reader/ready', { revision: -1 })).result;
        await request('reader/toggleLanguage', { revision: initial.revision });
        assert.equal(latestState().language, 'en');
        replaceManifest({ generatedAt: 'bilingual-refresh' });
        ManualReaderPanel.show(root, manager.getRepository(root), manager, { manualId: 'vol', sectionId: 'formula' });
        assert.equal(latestState().language, 'en');
        await request('reader/toggleLanguage', { revision: latestState().revision });
        assert.equal(latestState().language, 'zh');
        replaceManifest({ generatedAt: 'english-refresh', flavor: 'en', languages: ['en'], defaultLanguage: 'en' });
        ManualReaderPanel.show(root, manager.getRepository(root), manager, { manualId: 'vol', sectionId: 'formula' });
        const refreshed = latestState();
        assert.equal(refreshed.language, 'en');
        assert.equal(refreshed.search.scope, 'en');
        assert.equal(refreshed.uiLocale, 'zh');
        assert.equal(refreshed.canToggleLanguage, false);
        assert.deepEqual(refreshed.content.sentencePairs, []);
        assert.equal((await request('reader/toggleLanguage', { revision: refreshed.revision })).result, false);
        assert.equal(htmlAssignments, 1);
    });

    it('refreshes saved target metadata on repository replacement before reopening the same position', async () => {
        const manager = new ManualPackManager({});
        ManualReaderPanel.show(root, manager.getRepository(root), manager, { manualId: 'vol', sectionId: 'next', anchorId: 'next' });
        const before = latestState();
        await notify('reader/scrollChanged', { revision: before.revision, scrollY: 180, scrollRatio: 0.6, anchorId: 'next' });
        const savedLocation = { ...latestState().location };
        const file = path.join(root, 'indexes', 'sections.json');
        const sections = JSON.parse(fs.readFileSync(file, 'utf8'));
        Object.assign(sections.sections[1], { titleEn: 'Updated next section', titleZh: '更新后的下一节', pdfPage: 42 });
        fs.writeFileSync(file, JSON.stringify(sections));
        replaceManifest({ generatedAt: 'saved-location-refresh' });
        ManualReaderPanel.show(root, manager.getRepository(root), manager, savedLocation);
        const after = latestState();
        assert.equal(after.location.title, '更新后的下一节');
        assert.equal(after.location.pdfPage, 42);
        assert.equal(after.location.anchorId, 'next');
        assert.equal(after.restore.scrollY, 180);
        assert.equal(after.restore.scrollRatio, 0.6);
        assert.equal(htmlAssignments, 1);
        await request('reader/openPdf', { revision: after.revision });
        assert.equal(commands.at(-1)[2], 42);
    });

    it('removes obsolete history entries when a same-root repository no longer contains their section', async () => {
        const manager = new ManualPackManager({});
        ManualReaderPanel.show(root, manager.getRepository(root), manager, { manualId: 'vol', sectionId: 'formula' });
        await request('reader/navigate', { revision: latestState().revision, target: 'nextSection' });
        assert.equal(latestState().navigation.canBack, true);
        const sectionsFile = path.join(root, 'indexes', 'sections.json');
        const sections = JSON.parse(fs.readFileSync(sectionsFile, 'utf8'));
        sections.sections = sections.sections.filter(section => section.sectionId === 'next');
        fs.writeFileSync(sectionsFile, JSON.stringify(sections));
        replaceManifest({ generatedAt: 'section-removed' });
        ManualReaderPanel.show(root, manager.getRepository(root), manager, { manualId: 'vol', sectionId: 'next', anchorId: 'next' });
        assert.equal(latestState().navigation.canBack, false);
        assert.equal((await request('reader/navigate', { revision: latestState().revision, target: 'back' })).result, false);
    });

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
        // Repeated opens retain the same indexed page and fire-and-forget command.
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

    it('rechecks a restored or removed PDF in the same reader session', async () => {
        const pdfPath = path.join(root, 'pdf', 'Volume.pdf');
        const manifestFile = path.join(root, 'manifest.json');
        const manifestBytes = fs.readFileSync(manifestFile);
        fs.unlinkSync(pdfPath);
        show({ language: 'en' });
        const state = (await request('reader/ready', { revision: -1 })).result;
        const open = () => request('reader/openPdf', { revision: state.revision });
        assert.equal((await open()).result, false);
        assert.equal(commands.length, 0);

        fs.writeFileSync(pdfPath, 'restored PDF');
        assert.equal((await open()).result, true);
        assert.deepEqual(commands[0], ['extension.openManual', pdfPath, 1]);
        fs.unlinkSync(pdfPath);
        assert.equal((await open()).result, false);
        assert.equal(commands.length, 1, 'a removed PDF must not launch the cached path');

        fs.writeFileSync(pdfPath, 'restored again');
        assert.equal((await request('reader/openPdf', { revision: state.revision - 1 })).result, false);
        assert.equal(commands.length, 1, 'a stale request must not launch the PDF');
        assert.equal((await open()).result, true);
        assert.deepEqual(commands[1], commands[0]);
        assert.equal(htmlAssignments, 1, 'file restoration must not recreate the reader');
        assert.equal(latestState().revision, state.revision);
        assert.deepEqual(fs.readFileSync(manifestFile), manifestBytes);
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
