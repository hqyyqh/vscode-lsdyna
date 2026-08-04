'use strict';

const assert = require('assert');
const vscode = require('vscode');
const { ManualSidebarProvider } = require('../../src/manual/ManualSidebarProvider');
const i18n = require('../../src/core/i18n');

function createView() {
    const webview = {
        html: '',
        options: {},
        onDidReceiveMessage(callback) {
            this.receive = callback;
            return { dispose() {} };
        },
    };
    return { webview };
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
        assert.ok(closedHtml.includes('search-mode-toggle'));
        assert.ok(closedHtml.includes('mode: currentSearchMode()'), 'sidebar search must send mode with query');
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

        // Cold paint with location expands reading path in SSR HTML.
        provider.refresh(undefined);
        provider.refresh(repository, { manualId: 'vol-i', sectionId: 'card-2', anchorId: 'mandatory-card-2' });
        const openHtml = view.webview.html;
        assert.ok(/data-manual-id="vol-i"[^>]*\sopen/.test(openHtml) || openHtml.includes('data-manual-id="vol-i" open'));
        assert.ok(/data-chapter-key="12_contact"[^>]*\sopen/.test(openHtml));
        assert.ok(!/data-chapter-key="13_control"[^>]*\sopen/.test(openHtml), 'unrelated chapters stay collapsed');
        assert.ok(openHtml.includes('data-section-id="card-2"') && openHtml.includes(' active'));
        assert.ok(openHtml.includes('Node &lt;Definition&gt;'));

        view.webview.receive({ type: 'openLocation', manualId: 'vol-i', sectionId: 'card-2', anchorId: 'mandatory-card-2' });
        view.webview.receive({ type: 'openLocation', manualId: 'vol-i', sectionId: 'missing' });
        assert.deepStrictEqual(opened, [{
            manualId: 'vol-i',
            sectionId: 'card-2',
            anchorId: 'mandatory-card-2',
            title: 'Mandatory Card 2',
            pdfPage: 7,
        }]);

        view.webview.receive({ type: 'search', query: 'node', requestId: 3 });
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

    it('follows the extension language setting and reserves room for full search-mode labels', () => {
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
            assert.ok(view.webview.html.includes('>Keyword</button>'));
            assert.ok(view.webview.html.includes('Full text'));
            assert.ok(!view.webview.html.includes('>KW</button>'));
            assert.match(view.webview.html, /\.search-bar input\s*\{[^}]*padding:\s*4px 84px 4px 8px/s);
            assert.match(view.webview.html, /\.search-mode-toggle\s*\{[^}]*width:\s*76px/s);

            language = 'zh-cn';
            i18n.updateLanguage();
            provider.refreshUiLanguage();
            assert.ok(view.webview.html.includes('<html lang="zh-CN">'));
            assert.ok(view.webview.html.includes('>关键字</button>'));
            assert.ok(view.webview.html.includes('搜索手册正文'));
        } finally {
            vscode.workspace.getConfiguration = originalGetConfiguration;
            i18n.updateLanguage();
        }
    });
});
