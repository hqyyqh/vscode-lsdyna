const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { vscodeMock: vscode } = require("../support/helpers");
const { LargeFileViewerProvider } = require('../../src/client/LargeFileViewerProvider');
const { buildFileIndex } = require('../../src/core/scanner/fileIndexBuilder');

describe('large-file viewer scanner contract', () => {
    it('packages Codicon with a relative CSS URL that resolves inside the webview bundle', () => {
        const root = path.resolve(__dirname, '../../out/webview/large-file-viewer');
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
        const cssPath = path.join(root, manifest['index.html'].css[0]);
        const css = fs.readFileSync(cssPath, 'utf8');
        const url = css.match(/src:url\(([^)]+codicon[^)]+)\)/)?.[1];
        assert.ok(url?.startsWith('./'), 'Font must resolve relative to the bundled CSS, not the webview origin');
        const font = path.resolve(path.dirname(cssPath), url.split('?')[0]);
        assert.ok(font.startsWith(root + path.sep));
        assert.ok(fs.statSync(font).size > 0);
    });
    it('marks the keyword destination so it supersedes buffered scroll positions', async () => {
        const provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {});
        const session = searchSession(provider, path.join(os.tmpdir(), 'viewer-keyword-target.k'));
        session.state.anchorLine = 100;
        session.index = { keywordBlocks: [{ startLine: 110, keyword: '*MAT_ELASTIC' }] };
        let loaded;
        provider.loadWindow = async (_session, line) => { loaded = line; };
        assert.equal(await provider.navigateKeyword(session, 1, 'MAT'), true);
        assert.equal(loaded, 110);
        assert.equal(session.state.navigationTarget.line, 110);
        assert.equal(session.state.navigationTarget.endColumn, 12);
        assert.ok(session.state.navigationTarget.requestId);
        assert.deepEqual(session.state.keywordSearch, { query: 'MAT', count: 1, currentIndex: 0 });
        session.state.anchorLine = 110;
        assert.equal(await provider.navigateKeyword(session, 1, 'MAT'), true);
        assert.equal(loaded, 110);
        assert.equal(await provider.navigateKeyword(session, -1, 'MAT'), true);
        assert.equal(loaded, 110);
        session.index.keywordBlocks.push({ startLine: 150, keyword: '*MAT_ELASTIC' });
        assert.equal(await provider.navigateKeyword(session, 1, 'MAT'), true);
        assert.equal(loaded, 150);
        assert.equal(session.state.keywordSearch.currentIndex, 1);
        session.state.anchorLine = 150;
        assert.equal(await provider.navigateKeyword(session, 1, 'MAT'), true);
        assert.equal(loaded, 110);
        assert.equal(session.state.keywordSearch.currentIndex, 0);
        assert.equal(await provider.navigateKeyword(session, 1, 'missing'), true);
        assert.deepEqual(session.state.keywordSearch, { query: 'missing', count: 0, currentIndex: -1 });
        assert.equal(session.state.navigationTarget, undefined);
    });
    it('keeps the exact object range and reveals context when reopening a large viewer', async () => {
        const provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {});
        const file = path.join(os.tmpdir(), 'viewer-target.k');
        const session = searchSession(provider, file);
        session.panel = { reveal() {} };
        let anchor;
        provider.navigate = async (_session, line) => { anchor = line; return true; };
        await provider.openAt(vscode.Uri.file(file), 250, undefined, 10, 20);
        assert.equal(anchor, 246);
        const { requestId, ...range } = session.state.navigationTarget;
        assert.deepEqual(range, { line: 250, startColumn: 10, endColumn: 20 });
        await provider.openAt(vscode.Uri.file(file), 250, undefined, 10, 20);
        assert.notEqual(session.state.navigationTarget.requestId, requestId);
    });

    it('updates buffered position without loading or replacing field bindings, and rejects stale positions', () => {
        const provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {});
        const session = searchSession(provider, path.join(os.tmpdir(), 'viewer-position.k'));
        session.state = { ...session.state, anchorLine: 100, lines: [{ lineNumber: 100 }, { lineNumber: 101 }] };
        session.fields = new Map([['token', {}]]);
        let positionChanged;
        provider.messenger.onNotification = (type, handler) => { positionChanged = handler; return { dispose() {} }; };
        provider.messenger.onRequest = () => ({ dispose() {} });
        provider.registerHandlers(session);
        positionChanged({ revision: 0, line: 101 });
        assert.equal(session.state.anchorLine, 101);
        assert.ok(session.fields.has('token'));
        positionChanged({ revision: 0, line: 500 });
        assert.equal(session.state.anchorLine, 101);
        session.state.stale = true;
        positionChanged({ revision: 0, line: 100 });
        assert.equal(session.state.anchorLine, 101);
    });

    it('still reveals the requested line when long context exhausts the window byte budget', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-viewer-long-context-'));
        const file = path.join(root, 'long.k');
        fs.writeFileSync(file, ('x'.repeat(65536) + '\n').repeat(80) + '*END\n');
        try {
            const provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {});
            const session = searchSession(provider, file);
            const stat = fs.statSync(file);
            Object.assign(session, { signature: { size: stat.size, mtimeMs: stat.mtimeMs }, requestGeneration: 0,
                windowCache: new Map(), windowCacheBytes: 0,
                index: { largeFileLineMap: { stride: 4096, offsets: [0], lineCount: 81 }, keywordBlocks: [] } });
            provider.annotateLines = async (_session, lines) => lines;
            await provider.loadWindow(session, 70);
            assert.equal(session.state.anchorLine, 70);
            assert.equal(session.state.lines[0].lineNumber, 70);
            assert.ok(session.state.lines.some(line => line.text === '*END'));
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    it('uses only matching verified current-file object summaries and preserves uncertainty', () => {
        const catalog = require('../../src/core/references/definitionRegistry').getDefinitionRegistryCatalog();
        const descriptor = catalog.definitionDescriptorForKeyword;
        const provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {});
        const block = { keyword: '*MAT_ELASTIC_TITLE', displayIdentity: { confidence: 'verified', canonicalKeyword: 'MAT_ELASTIC',
            identity: { field: 'MID', value: '7' }, title: 'Steel' } };
        const target = { targetKind: 'material', id: 7 };
        const session = { index: { keywordBlocks: [block] } };
        try {
            catalog.definitionDescriptorForKeyword = keyword => keyword === 'MAT_ELASTIC' ? { targetKind: 'material', fieldName: 'MID' } : null;
            assert.equal(provider.objectName(session, target), 'Steel');
            assert.equal(provider.objectName(session, { targetKind: 'part', id: 7 }), undefined);
            assert.equal(provider.objectName(session, { targetKind: 'material', id: 8 }), undefined);
            session.index.keywordBlocks = [block, { ...block }];
            assert.equal(provider.objectName(session, target), undefined);
            session.index.keywordBlocks = [{ ...block, displayIdentity: { ...block.displayIdentity, confidence: 'fallback' } }];
            assert.equal(provider.objectName(session, target), undefined);
            session.index.keywordBlocks = [block];
            catalog.definitionDescriptorForKeyword = () => ({ targetKind: 'material', fieldName: 'MID', recordMode: 'repeat-all-data-records' });
            assert.equal(provider.objectName(session, target), undefined);
        } finally { catalog.definitionDescriptorForKeyword = descriptor; }
    });

    function searchSession(provider, file) {
        const session = { document: { uri: vscode.Uri.file(file) }, generation: 1, searchGeneration: 0,
            searchMatches: [], signature: { size: 4, mtimeMs: 1 },
            state: { revision: 0, stale: false, search: { query: '', loading: false } } };
        provider.sessions.set(process.platform === 'win32' ? file.toLocaleLowerCase() : file, session);
        provider.publish = () => { session.state = { ...session.state, revision: session.state.revision + 1 }; };
        return session;
    }

    it('publishes the current matching line, clears the old object target and wraps search steps', async () => {
        const reader = require('../../src/core/scanner/largeFileWindowReader');
        const original = reader.searchLargeFileLiteral;
        const provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {});
        const session = searchSession(provider, path.join(os.tmpdir(), 'viewer-search-target.k'));
        session.state.navigationTarget = { line: 5, startColumn: 0, endColumn: 10 };
        let loaded;
        provider.loadWindow = async (_session, line) => { loaded = line; provider.publish(session); };
        try {
            reader.searchLargeFileLiteral = async () => ({ matches: [{ lineNumber: 201 }, { lineNumber: 215 }], truncated: false, stale: false });
            assert.equal(await provider.search(session, '*MAT_ELASTIC'), true);
            assert.equal(session.state.navigationTarget, undefined);
            assert.equal(session.state.search.currentLine, 201);
            assert.equal(loaded, 201);
            await provider.searchStep(session, -1);
            assert.equal(session.state.search.currentLine, 215);
            assert.equal(loaded, 215);
            await provider.search(session, '');
            assert.equal(session.state.search.currentLine, undefined);
            assert.equal(session.state.search.count, 0);
        } finally { reader.searchLargeFileLiteral = original; }
    });

    it('ends current search loading after a read error and allows retry', async () => {
        const reader = require('../../src/core/scanner/largeFileWindowReader');
        const original = reader.searchLargeFileLiteral;
        const provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {});
        const session = searchSession(provider, path.join(os.tmpdir(), 'viewer-search-error.k'));
        try {
            reader.searchLargeFileLiteral = async () => { throw Error('private read error'); };
            assert.equal(await provider.search(session, 'MID'), false);
            assert.equal(session.state.search.loading, false);
            assert.equal(session.state.search.message, require('../../src/core/i18n').get('largeFileSearchFailed'));
            assert.ok(!session.state.search.message.includes('private read error'));
            reader.searchLargeFileLiteral = async () => ({ matches: [], truncated: false, stale: false });
            assert.equal(await provider.search(session, 'MID'), true);
            assert.equal(session.state.search.message, require('../../src/core/i18n').get('largeFileSearchNoResults'));
        } finally { reader.searchLargeFileLiteral = original; }
    });

    it('does not publish obsolete search failures or detached session results', async () => {
        const reader = require('../../src/core/scanner/largeFileWindowReader');
        const original = reader.searchLargeFileLiteral;
        const provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {});
        const file = path.join(os.tmpdir(), 'viewer-search-obsolete.k');
        const session = searchSession(provider, file);
        let reject;
        try {
            reader.searchLargeFileLiteral = () => new Promise((_, fail) => { reject = fail; });
            const old = provider.search(session, 'old');
            await provider.search(session, '');
            const current = session.state;
            reject(Error('superseded read'));
            assert.equal(await old, false);
            assert.equal(session.state, current);
            let resolve;
            reader.searchLargeFileLiteral = () => new Promise(done => { resolve = done; });
            const detached = provider.search(session, 'new');
            provider.sessions.clear();
            const detachedState = session.state;
            resolve({ matches: [], truncated: false, stale: false });
            assert.equal(await detached, false);
            assert.equal(session.state, detachedState);
        } finally { reader.searchLargeFileLiteral = original; }
    });

    it('refreshes active viewer labels, locale, messages and selected help without clearing search state', () => {
        const i18n = require('../../src/core/i18n');
        const original = i18n.getLanguage;
        const provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {});
        const session = searchSession(provider, path.join(os.tmpdir(), 'viewer-language.k'));
        session.fields = new Map();
        session.state = { ...session.state, indexing: 'error', indexingMessage: 'old failure', labels: { searchNoResults: 'old empty' },
            selectedField: { token: 'field', localizedHelp: '材料编号', englishHelp: 'Material identifier' },
            search: { query: 'MID', loading: false, count: 0, currentIndex: -1, message: 'old empty' } };
        const publish = provider.publish;
        // Use the real publication path; only the outbound transport is intercepted.
        delete provider.publish;
        provider.messenger.sendNotification = () => {};
        try {
            i18n.getLanguage = () => 'en';
            provider.refreshUiLanguage();
            assert.equal(session.state.locale, 'en');
            assert.equal(session.state.labels.reload, i18n.get('largeFileReload'));
            assert.equal(session.state.indexingMessage, i18n.get('largeFileIndexFailed'));
            assert.equal(session.state.search.query, 'MID');
            assert.equal(session.state.search.message, i18n.get('largeFileSearchNoResults'));
            assert.equal(session.state.selectedField.token, 'field');
        } finally { i18n.getLanguage = original; provider.publish = publish; }
    });

    it('does not cache or annotate a window after the owning session is detached', async () => {
        const reader = require('../../src/core/scanner/largeFileWindowReader');
        const original = reader.readLargeFileWindow;
        const provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {});
        const session = searchSession(provider, path.join(os.tmpdir(), 'viewer-detached-window.k'));
        session.requestGeneration = 0;
        session.windowCache = new Map();
        session.windowCacheBytes = 0;
        let resolve;
        let annotations = 0;
        provider.annotateLines = async () => { annotations++; return []; };
        try {
            reader.readLargeFileWindow = () => new Promise(done => { resolve = done; });
            const window = provider.loadWindow(session, 0);
            provider.sessions.clear();
            resolve({ anchorLine: 0, lines: [{ lineNumber: 0, text: '*NODE', truncated: false }], stale: false });
            await window;
            assert.equal(annotations, 0);
            assert.equal(session.windowCache.size, 0);
        } finally { reader.readLargeFileWindow = original; }
    });

    it('publishes an indexing error when the initial window read fails and releases its token', async () => {
        const file = path.join(os.tmpdir(), 'dynasense-unreadable-model.k');
        const provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {
            loadFileIndex: async () => { throw Error('index must not run'); },
        });
        const session = { document: { uri: vscode.Uri.file(file) }, generation: 1, index: null,
            state: { indexing: 'loading' } };
        provider.sessions.set(process.platform === 'win32' ? file.toLocaleLowerCase() : file, session);
        let publications = 0;
        provider.loadWindow = async () => { throw Error('initial read unavailable'); };
        provider.publish = () => { publications++; };
        await provider.initialize(session, 0);
        assert.equal(session.state.indexing, 'error');
        assert.equal(session.state.indexingMessage, require('../../src/core/i18n').get('largeFileIndexFailed'));
        assert.ok(!session.state.indexingMessage.includes('initial read unavailable'));
        assert.equal(publications, 1);
        assert.equal(session.indexCancellation, null);
    });

    it('accounts for replaced anchor windows and retains the exact cache budget', () => {
        const provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {});
        const session = { windowCache: new Map(), windowCacheBytes: 0 };
        const value = size => ({ lines: [{ text: 'x'.repeat(size - 32) }] });
        const totalBytes = () => [...session.windowCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        for (let repeat = 0; repeat < 10; repeat++) {
            provider.cacheWindow(session, 0, value(2 * 1024 * 1024));
            assert.equal(session.windowCache.size, 1);
            assert.equal(session.windowCacheBytes, totalBytes());
        }
        provider.cacheWindow(session, 0, value(1 * 1024 * 1024));
        assert.equal(session.windowCacheBytes, 1 * 1024 * 1024);
        provider.cacheWindow(session, 1, value(16 * 1024 * 1024));
        assert.deepEqual([...session.windowCache.keys()], [1]);
        assert.equal(session.windowCacheBytes, totalBytes());
        provider.cacheWindow(session, 1, value(16 * 1024 * 1024 + 1));
        assert.equal(session.windowCacheBytes, 16 * 1024 * 1024);
        assert.equal(session.windowCacheBytes, totalBytes());
    });

    it('accepts the current real scanner output and rejects old or mismatched indexes', async function () {
        this.timeout(10000); // Includes cold loading of the real scanner's semantic catalogs.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-viewer-index-'));
        const file = path.join(root, 'model.k');
        fs.writeFileSync(file, '*KEYWORD\n*NODE\n1,0,0,0\n*END\n');
        try {
            const index = await buildFileIndex(file, { largeFileThresholdBytes: 0 });
            for (const change of [{}, { scannerVersion: index.scannerVersion - 1 }, { largeFileLineMap: null }, { size: index.size + 1 }]) {
                const actual = { ...index, ...change };
                const provider = new LargeFileViewerProvider(root, { get() {}, update() {} }, { loadFileIndex: async () => actual });
                const uri = vscode.Uri.file(file);
                const session = { document: { uri }, generation: 1, index: null,
                    signature: { size: index.size, mtimeMs: index.mtimeMs }, state: { indexing: 'loading' } };
                provider.sessions.set(process.platform === 'win32' ? file.toLocaleLowerCase() : file, session);
                provider.loadWindow = async () => {};
                provider.publish = () => {};
                await provider.initialize(session, 0);
                assert.equal(session.state.indexing, Object.keys(change).length ? 'error' : 'ready');
                if (!Object.keys(change).length) assert.equal(session.index, actual);
                else assert.equal(session.index, null);
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
