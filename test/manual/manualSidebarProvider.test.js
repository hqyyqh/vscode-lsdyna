'use strict';

const assert = require('assert');
const vscode = require('vscode');
const { ManualSidebarProvider } = require('../../src/manual/ManualSidebarProvider');
const i18n = require('../../src/core/i18n');

function createView() {
    const webview = {
        html: '',
        cspSource: 'vscode-resource:',
        asWebviewUri: uri => uri,
        options: {},
        onDidReceiveMessage(callback) {
            this.receive = callback;
            return { dispose() {} };
        },
    };
    return { webview };
}

function receive(view, message) {
    view.webview.receive({ revision: Number(view.webview.html.match(/const revision = (\d+);/)[1]), ...message });
}

function section(partial) {
    return {
        level: 2,
        titleZh: '中文标题',
        anchors: [partial.sectionId],
        pathZh: partial.pathEn.replace('/en/', '/zh/'),
        pdfPage: 7,
        ...partial,
    };
}

describe('ManualSidebarProvider', () => {
    it('distinguishes pack load failures from absent packs and relocalizes both states', () => {
        const originalGetConfiguration = vscode.workspace.getConfiguration;
        let language = 'en';
        vscode.workspace.getConfiguration = () => ({ get: key => key === 'language' ? language : undefined });
        try {
            i18n.updateLanguage();
            let retries = 0;
            const provider = new ManualSidebarProvider(() => {}, undefined, () => { retries++; });
            const view = createView();
            provider.resolveWebviewView(view);
            assert.ok(view.webview.html.includes('No usable manual pack was found'));
            provider.refresh({ listDocuments() { throw new Error('broken manifest'); } });
            assert.ok(view.webview.html.includes('Cannot load manual contents'));
            assert.ok(!view.webview.html.includes('No usable manual pack was found'));
            assert.ok(view.webview.html.includes('>Try again</button>'));
            receive(view, { type: 'retryLoad' });
            assert.equal(retries, 1);
            provider.refresh(undefined, undefined, true);
            assert.ok(view.webview.html.includes('Cannot load manual contents'));
            language = 'zh-cn'; i18n.updateLanguage(); provider.refreshUiLanguage();
            assert.ok(view.webview.html.includes('无法加载手册内容'));
            assert.ok(view.webview.html.includes('>重试</button>'));
            assert.ok(!view.webview.html.includes('未找到可用的手册包'));
            provider.refresh(undefined);
            assert.ok(view.webview.html.includes('未找到可用的手册包'));
        } finally {
            vscode.workspace.getConfiguration = originalGetConfiguration; i18n.updateLanguage();
        }
    });

    const sections = [
        section({
            manualId: 'vol-i',
            sectionId: 'contact-home',
            titleEn: '*CONTACT',
            pathEn: 'documents/en/vol-i/chunks/12_contact/12_00_contact.md',
            anchors: ['contact'],
        }),
        section({
            manualId: 'vol-i',
            sectionId: 'card-2',
            titleEn: 'Mandatory Card 2',
            pathEn: 'documents/en/vol-i/chunks/12_contact/12_08_mandatory-card-2.md',
            anchors: ['mandatory-card-2'],
        }),
        section({
            manualId: 'vol-i',
            sectionId: 'control-home',
            titleEn: '*CONTROL',
            pathEn: 'documents/en/vol-i/chunks/13_control/13_00_control.md',
            anchors: ['control'],
        }),
        section({
            manualId: 'vol-i',
            sectionId: 'node',
            titleEn: 'Node <Definition>',
            pathEn: 'documents/en/vol-i/chunks/06_boundary/06_01_node.md',
            anchors: ['node'],
        }),
    ];

    const repository = {
        listDocuments: () => [
            { manualId: 'vol-i', title: 'Volume I', order: 1 },
            { manualId: 'vol-ii', title: 'Volume II', order: 2 },
        ],
        listSections: (manualId) => {
            if (manualId === 'vol-ii') {
                return [section({
                    manualId: 'vol-ii',
                    sectionId: 'mat-home',
                    titleEn: '*MAT',
                    pathEn: 'documents/en/vol-ii/chunks/03_mat/03_00.md',
                })];
            }
            return sections.filter(s => s.manualId === (manualId || 'vol-i'));
        },
        getSection: (manualId, sectionId) => {
            const all = repository.listSections(manualId);
            return all.find(s => s.sectionId === sectionId) || null;
        },
        search: (query) => query.trim()
            ? [{
                location: { manualId: 'vol-i', sectionId: 'node', anchorId: null, pdfPage: 7 },
                titleEn: 'Node <Definition>', titleZh: '节点定义', preview: 'node definition', matchedLanguages: ['en'], score: 3000,
            }]
            : [],
    };

    it('renders a collapsed volume/chapter tree, expands the reading path, and keeps English-only titles', () => {
        const opened = [];
        const provider = new ManualSidebarProvider(location => opened.push(location));
        const view = createView();
        const posts = [];
        view.webview.postMessage = message => { posts.push(message); return Promise.resolve(true); };
        provider.resolveWebviewView(view);

        // No location: volumes present but not forced open.
        provider.refresh(repository);
        const closedHtml = view.webview.html;
        assert.ok(closedHtml.includes('class="volume"'));
        assert.ok(closedHtml.includes('data-chapter-key="12_contact"'));
        assert.ok(closedHtml.includes('data-chapter-key="13_control"'));
        assert.ok(closedHtml.includes('*CONTACT'));
        assert.ok(!closedHtml.includes(' class="volume" open') && !closedHtml.includes('class="volume" open'),
            'volumes should start collapsed without a current location');
        // Leaf content is in the DOM but under closed details.
        assert.ok(closedHtml.includes('Mandatory Card 2'));
        assert.ok(closedHtml.includes('id="sidebar-search"'));
        assert.ok(closedHtml.includes('id="sidebar-search-mode"'));
        assert.ok(closedHtml.includes('search-modes'));
        assert.ok(closedHtml.includes('mode = searchMode'), 'sidebar search must send mode with query');
        assert.ok(!closedHtml.includes('中文标题'), 'sidebar must not show Chinese titles');
        assert.ok(closedHtml.includes('setActiveLocation'), 'incremental active-location path for click updates');
        assert.ok(closedHtml.includes('revealIfNeeded'));
        // Webview script is embedded in a TS template literal — must still parse as JS.
        const scriptMatch = closedHtml.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
        assert.ok(scriptMatch, 'sidebar page must include a script block');
        assert.doesNotThrow(() => {
            // eslint-disable-next-line no-new-func
            new Function(scriptMatch[1]);
        }, 'embedded webview script must be valid JavaScript (template-literal escaping)');
        assert.ok(closedHtml.includes('dataset.manualId'), 'active location uses dataset matching, not CSS attr selectors');
        assert.ok(!scriptMatch[1].includes('cssAttrEscape'), 'must not embed cssAttrEscape (template-string backslash trap)');

        // Same pack + live TOC: location changes postMessage only (preserve webview scroll).
        const htmlStable = view.webview.html;
        const postsBefore = posts.length;
        provider.refresh(repository, { manualId: 'vol-i', sectionId: 'node', anchorId: 'node' });
        assert.strictEqual(view.webview.html, htmlStable, 'same-pack location updates must not rebuild webview HTML');
        assert.ok(posts.length > postsBefore);
        const activeMsg = posts[posts.length - 1];
        assert.equal(activeMsg.type, 'setActiveLocation');
        assert.equal(activeMsg.manualId, 'vol-i');
        assert.equal(activeMsg.sectionId, 'node');
        assert.equal(activeMsg.chapterKey, '06_boundary');
        assert.equal(activeMsg.revision, provider.pageRevision);

        // Cold paint with location expands reading path in SSR HTML.
        provider.refresh(undefined);
        provider.refresh(repository, { manualId: 'vol-i', sectionId: 'card-2', anchorId: 'mandatory-card-2' });
        const openHtml = view.webview.html;
        assert.ok(/data-manual-id="vol-i"[^>]*\sopen/.test(openHtml) || openHtml.includes('data-manual-id="vol-i" open'));
        assert.ok(/data-chapter-key="12_contact"[^>]*\sopen/.test(openHtml));
        assert.ok(!/data-chapter-key="13_control"[^>]*\sopen/.test(openHtml), 'unrelated chapters stay collapsed');
        assert.ok(openHtml.includes('data-section-id="card-2"') && openHtml.includes(' active'));
        assert.ok(openHtml.includes('Node &lt;Definition&gt;'));

        receive(view, { type: 'openLocation', manualId: 'vol-i', sectionId: 'card-2', anchorId: 'mandatory-card-2' });
        receive(view, { type: 'openLocation', manualId: 'vol-i', sectionId: 'missing' });
        assert.deepStrictEqual(opened, [{
            manualId: 'vol-i',
            sectionId: 'card-2',
            anchorId: 'mandatory-card-2',
            title: 'Mandatory Card 2',
            pdfPage: 7,
        }]);

        receive(view, { type: 'search', query: 'node', requestId: 3 });
        const searchPost = posts.filter(p => p.type === 'searchResults').pop();
        assert.ok(searchPost);
        assert.equal(searchPost.requestId, 3);
        assert.equal(searchPost.results[0].title, 'Node <Definition>');
        assert.equal(searchPost.results[0].sectionId, 'node');
    });

    it('uses flex fill layout for search results instead of 40vh cap', () => {
        const provider = new ManualSidebarProvider(() => {});
        const view = createView();
        view.webview.postMessage = () => Promise.resolve(true);
        provider.resolveWebviewView(view);
        provider.refresh(repository);
        const html = view.webview.html;

        assert.ok(!/max-height\s*:\s*40vh/.test(html), 'must not cap search results at 40vh');
        assert.ok(!/\.search-results\s*\{[^}]*max-height\s*:/.test(html), 'search-results must not use max-height');

        assert.ok(/html\s*,\s*body\s*\{[^}]*height\s*:\s*100%/.test(html)
            || (/html[^}]*height\s*:\s*100%/.test(html) && /body[^}]*height\s*:\s*100%/.test(html)),
            'html/body should fill webview height');
        assert.ok(/body\s*\{[^}]*display\s*:\s*flex/.test(html), 'body should be a flex column container');
        assert.ok(/body\s*\{[^}]*flex-direction\s*:\s*column/.test(html), 'body should stack search + main vertically');
        assert.ok(/body\s*\{[^}]*overflow\s*:\s*hidden/.test(html), 'body should not scroll; children scroll');

        assert.ok(/\.search-results\s*\{[^}]*min-height\s*:\s*0/.test(html), 'search-results needs min-height:0 for flex scroll');
        assert.ok(/\.search-results\s*\{[^}]*overflow\s*:\s*auto/.test(html), 'search-results should scroll internally');
        assert.ok(/\.search-panel\s*\{[^}]*min-height\s*:\s*0/.test(html), 'search-panel needs min-height:0');
        assert.ok(/\.search-panel\[hidden\]\s*\{[^}]*display\s*:\s*none/.test(html), 'hidden search-panel must force display:none over flex');

        assert.ok(/#toc\s*\{[^}]*min-height\s*:\s*0/.test(html), 'toc needs min-height:0 for flex scroll');
        assert.ok(/#toc\s*\{[^}]*overflow\s*:\s*auto/.test(html), 'toc should scroll when long');
        assert.ok(/#toc\.hidden\s*\{[^}]*display\s*:\s*none/.test(html), 'hidden toc must not leave a flex gap');
    });

    it('uses localized compact search labels with descriptive tooltips', () => {
        const originalGetConfiguration = vscode.workspace.getConfiguration;
        let language = 'en';
        vscode.workspace.getConfiguration = () => ({
            get: (key, defaultValue) => key === 'language' ? language : defaultValue,
        });

        try {
            i18n.updateLanguage();
            const provider = new ManualSidebarProvider(() => {});
            const view = createView();
            view.webview.postMessage = () => Promise.resolve(true);
            provider.resolveWebviewView(view);
            provider.refresh(repository);

            assert.ok(view.webview.html.includes('<html lang="en">'));
            assert.ok(view.webview.html.includes('Current search: keywords and titles. Switch to full text.'));
            assert.ok(view.webview.html.includes('Current search: full text.'));
            assert.ok(view.webview.html.includes('Search keywords and section titles.'));
            assert.ok(view.webview.html.includes('aria-label="Current search: keywords and titles. Switch to full text."'));
            assert.equal(view.description, '↑↓ Navigate · Enter Open manual · Esc Clear search');
            assert.ok(!view.webview.html.includes('search-footer'), 'shortcuts should not consume a separate webview row');
            assert.ok(!view.webview.html.includes('>KW</button>'));
            assert.ok(!view.webview.html.includes('<select'));
            assert.match(view.webview.html, /\.search-modes\s*\{[^}]*flex-wrap:\s*wrap/s);

            language = 'zh-cn';
            i18n.updateLanguage();
            provider.refreshUiLanguage();
            assert.ok(view.webview.html.includes('<html lang="zh-CN">'));
            assert.ok(view.webview.html.includes('当前搜索：关键字与标题；切换为全文搜索'));
            assert.ok(view.webview.html.includes('已索引摘要'));
            assert.equal(view.description, '↑↓ 导航 · Enter 打开手册 · Esc 清空搜索');
            for (const unavailable of [undefined, { listDocuments: () => [] }, { listDocuments() { throw Error('broken index'); } }]) {
                provider.refresh(unavailable);
                assert.equal(view.description, undefined, 'hide search shortcuts when the sidebar cannot search');
            }
            provider.refresh(repository);
            assert.equal(view.description, '↑↓ 导航 · Enter 打开手册 · Esc 清空搜索');
        } finally {
            vscode.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });

    it('bounds results, reports failures and rejects messages from a replaced page', () => {
        const posts = [], opened = [];
        let limit;
        const provider = new ManualSidebarProvider(location => opened.push(location));
        const view = createView();
        view.webview.postMessage = message => { posts.push(message); return Promise.resolve(true); };
        provider.resolveWebviewView(view);
        provider.refresh({ ...repository, search(query, scope, maximum) {
            limit = maximum;
            return Array.from({ length: 101 }, () => repository.search('node')[0]);
        } });
        const oldRevision = provider.pageRevision;
        receive(view, { type: 'search', query: 'node', requestId: 4 });
        assert.equal(limit, 101);
        assert.equal(posts.at(-1).results.length, 100);
        assert.equal(posts.at(-1).truncated, true);
        assert.equal(posts.at(-1).results[0].volumeTitle, 'Volume I');
        receive(view, { type: 'search', query: 'node', requestId: 5, mode: 'fulltext' });
        assert.equal(posts.at(-1).results[0].chapterTitle, 'Node <Definition>');
        provider.refresh({ ...repository, search() { throw Error('unreadable index'); } });
        view.webview.receive({ revision: oldRevision, type: 'openLocation', manualId: 'vol-i', sectionId: 'node' });
        assert.equal(opened.length, 0);
        receive(view, { type: 'search', query: 'node', requestId: 5 });
        assert.equal(posts.at(-1).failed, true);
        assert.deepEqual(posts.at(-1).results, []);
    });

    it('copies only the current chapter keyword and reports clipboard failures', async () => {
        const originalWrite = vscode.env.clipboard.writeText, copied = [], posts = [];
        vscode.env.clipboard.writeText = text => { copied.push(text); return Promise.resolve(); };
        try {
            const provider = new ManualSidebarProvider(() => {}), view = createView();
            view.webview.postMessage = message => { posts.push(message); return Promise.resolve(true); };
            provider.resolveWebviewView(view); provider.refresh(repository);
            receive(view, { type: 'copyKeyword', manualId: 'vol-i', sectionId: 'contact-home', keyword: '*FORGED' });
            receive(view, { type: 'copyKeyword', manualId: 'vol-i', sectionId: 'node' });
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(copied, ['*CONTACT']);
            assert.equal(posts.at(-1).copied, true);
            vscode.env.clipboard.writeText = () => Promise.reject(Error('denied'));
            receive(view, { type: 'copyKeyword', manualId: 'vol-i', sectionId: 'contact-home' });
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(posts.at(-1).copied, false);
            vscode.env.clipboard.writeText = () => { throw Error('clipboard unavailable'); };
            receive(view, { type: 'copyKeyword', manualId: 'vol-i', sectionId: 'contact-home' });
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(posts.at(-1).copied, false);
        } finally { vscode.env.clipboard.writeText = originalWrite; }
    });

    it('runs grouped/text search, safe highlights, keyboard navigation and stale-reply handling in the actual page script', async function () {
        this.timeout(10_000); // Includes the first cold load of JSDOM, not just search handling.
        const { JSDOM } = require('jsdom');
        const opened = [], outgoing = [];
        const provider = new ManualSidebarProvider(location => opened.push(location)), view = createView();
        view.webview.postMessage = () => Promise.resolve(true);
        provider.resolveWebviewView(view); provider.refresh(repository);
        const dom = new JSDOM(view.webview.html, { runScripts: 'dangerously', pretendToBeVisual: true,
            beforeParse(window) {
                window.acquireVsCodeApi = () => ({ postMessage: message => outgoing.push(message) });
                window.HTMLElement.prototype.getClientRects = function () {
                    return this.closest('details:not([open])') ? [] : [{}];
                };
            } });
        try {
            const { document, Event, MessageEvent, KeyboardEvent } = dom.window;
            const input = document.getElementById('sidebar-search');
            const search = (query, mode = 'keyword') => {
                input.value = query;
                const button = document.getElementById('sidebar-search-mode');
                if (button.dataset.mode !== mode) button.click();
                else { button.click(); button.click(); }
                assert.equal(button.dataset.mode, mode);
                assert.ok(button.getAttribute('aria-label'));
                return outgoing.at(-1);
            };
            const reply = (request, extra = {}) => dom.window.dispatchEvent(new MessageEvent('message', { data: {
                ...request, type: 'searchResults', results: [
                    { manualId: 'vol-i', sectionId: 'node', title: 'Node <img src=x onerror=alert(1)>', volumeTitle: 'Volume I', preview: 'node definition' },
                    { manualId: 'vol-ii', sectionId: 'mat-home', title: '*MAT', keyword: '*MAT', volumeTitle: 'Volume II', preview: 'Material example' },
                ], ...extra,
            } }));
            const first = search('node'); reply(first);
            assert.equal(document.querySelectorAll('.result-group').length, 2);
            assert.equal(document.querySelectorAll('.search-result strong mark').length, 1);
            assert.equal(document.querySelectorAll('img').length, 0, 'source text must not become HTML');
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            assert.ok(document.activeElement.classList.contains('search-result'));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            assert.equal(outgoing.at(-1).type, 'openLocation');
            const newer = search('mat', 'fulltext'); reply(first);
            assert.equal(document.querySelectorAll('.search-result').length, 0, 'ignore an older query');
            reply({ ...newer, mode: 'keyword' });
            assert.equal(document.querySelectorAll('.search-result').length, 0, 'ignore a different mode');
            reply(newer);
            assert.equal(document.querySelectorAll('.result-group').length, 0);
            assert.equal(document.querySelectorAll('.result-source').length, 2);
            document.querySelector('.result-copy').click();
            assert.equal(outgoing.at(-1).type, 'copyKeyword');
            input.value = 'next'; input.dispatchEvent(new Event('input', { bubbles: true }));
            reply(newer);
            assert.equal(document.querySelectorAll('.search-result').length, 0, 'invalidate before debounce ends');
            document.querySelector('#search-clear').click(); reply(newer);
            assert.equal(document.querySelector('#search-panel').hidden, true);
            assert.equal(document.querySelector('#toc').classList.contains('hidden'), false);
            const retry = search('node'); reply(retry, { failed: true });
            assert.equal(document.querySelector('.search-retry').hidden, false);
            document.querySelector('.search-retry').click();
            assert.ok(outgoing.at(-1).requestId > retry.requestId);
            const pending = outgoing.at(-1);
            input.dispatchEvent(new Event('compositionstart', { bubbles: true }));
            reply(pending);
            assert.equal(document.querySelectorAll('.search-result').length, 0, 'ignore replies while composing');
            input.dispatchEvent(new Event('compositionend', { bubbles: true }));
        } finally { dom.window.close(); }
    });
});
