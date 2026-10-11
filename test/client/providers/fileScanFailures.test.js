'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeDoc, vscodeMock } = require('../../support/helpers');
const { collectKeywordsFromFile } = require('../../../src/core/parser/keywordScanner');
const { collectBlocksFromFile } = require('../../../src/core/parser/blockScanner');
const { collectIncludeDirectivesFromFile } = require('../../../src/core/parser/includeScanner');
const { BlockIndex } = require('../../../src/core/incremental/blockIndex');
const { ProjectGraph } = require('../../../src/core/project/projectGraph');
const { createGraphUpdater } = require('../../../src/core/incremental/graphUpdater');
const { createProjectIndexer } = require('../../../src/core/project/projectIndexer');
const { LsdynaIncludeTreeProvider } = require('../../../src/client/providers/includeTreeProvider');
const { LsdynaKeywordIndexProvider } = require('../../../src/client/providers/keywordIndexProvider');
const i18n = require('../../../src/core/i18n');

describe('file scan failure publication', () => {
    let directory, file, originalStat, originalEditor, originalProgress, originalLocation;
    beforeEach(() => {
        originalStat = fs.promises.stat;
        originalEditor = vscodeMock.window.activeTextEditor;
        originalProgress = vscodeMock.window.withProgress;
        originalLocation = vscodeMock.ProgressLocation;
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-scan-failure-'));
        file = path.join(directory, 'main.k');
        fs.writeFileSync(file, '*PART\npart\n1,1,1\n');
        vscodeMock.window.activeTextEditor = { document: fakeDoc('*PART\npart\n1,1,1\n', file) };
        vscodeMock.window.withProgress = async (_options, task) => task({ report() {} }, {});
        vscodeMock.ProgressLocation = { Window: 10, Notification: 15 };
    });
    afterEach(() => {
        fs.promises.stat = originalStat;
        vscodeMock.window.activeTextEditor = originalEditor;
        vscodeMock.window.withProgress = originalProgress;
        vscodeMock.ProgressLocation = originalLocation;
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const collectors = [collectKeywordsFromFile, collectBlocksFromFile, collectIncludeDirectivesFromFile];
    function deny(error) {
        fs.promises.stat = function (name) {
            return name === file ? Promise.reject(error) : originalStat.apply(this, arguments);
        };
    }

    it('propagates metadata failures instead of returning valid empty scan results', async () => {
        for (const code of ['EACCES', 'EIO', 'ENOENT']) {
            const failure = Object.assign(new Error('fixture stat failure'), { code });
            deny(failure);
            for (const collect of collectors) await assert.rejects(collect(file), error => error === failure);
        }
    });

    it('keeps successfully scanned files with no keywords distinct from scan failures', async () => {
        fs.writeFileSync(file, '$ comment only\n');
        assert.deepEqual(await collectKeywordsFromFile(file), []);
        assert.deepEqual(await collectBlocksFromFile(file), []);
        assert.deepEqual((await collectIncludeDirectivesFromFile(file)).includeEntries, []);
    });

    it('propagates real file deletion between metadata lookup and reading', async () => {
        for (const collect of collectors) {
            fs.writeFileSync(file, '*PART\n1,1,1\n');
            fs.promises.stat = async function (name) {
                const result = await originalStat.apply(this, arguments);
                if (name === file) fs.unlinkSync(file);
                return result;
            };
            await assert.rejects(collect(file), error => error.code === 'ENOENT');
        }
    });

    it('propagates cancellation before filesystem access through all disk collectors', async () => {
        let reads = 0;
        fs.promises.stat = () => { reads++; throw Error('must not read after cancellation'); };
        for (const collect of collectors) await assert.rejects(
            collect(file, { cancellationToken: { isCancellationRequested: true } }),
            error => error.name === 'CancellationError',
        );
        assert.equal(reads, 0);
    });

    it('retains an existing BlockIndex when its disk rebuild fails', async () => {
        const index = new BlockIndex(file);
        index.buildIndex(2, line => ['*PART', '1,1,1'][line]);
        const previous = index.blocks;
        const failure = Object.assign(new Error('fixture denied'), { code: 'EACCES' });
        deny(failure);
        await assert.rejects(index.buildIndexFromFile(file), error => error === failure);
        assert.strictEqual(index.blocks, previous);
        assert.equal(index.lineCount, 2);
    });

    it('does not cache a successful legacy project snapshot when a collector fails', async () => {
        const indexer = createProjectIndexer({
            collectKeywordsFromFile: (...args) => collectKeywordsFromFile(...args),
            collectIncludeDirectivesFromFile: (...args) => collectIncludeDirectivesFromFile(...args),
            getFileSignature: async () => ({ mtimeMs: 1, size: 1 }),
        });
        const failure = Object.assign(new Error('fixture denied'), { code: 'EACCES' });
        deny(failure);
        await assert.rejects(indexer.buildProjectIndex(file), error => error === failure);
        assert.equal(indexer.getMemoryCacheStats().entryCount, 0);
    });

    it('preserves graph and keyword ownership for permission, IO and cancellation failures', async () => {
        for (const failure of [Object.assign(new Error('denied'), { code: 'EACCES' }),
            Object.assign(new Error('IO failed'), { code: 'EIO' }),
            Object.assign(new Error('cancelled'), { name: 'CancellationError' })]) {
            const child = path.join(directory, 'child.k');
            const graph = new ProjectGraph();
            graph.addIncludeEdge(file, child);
            const keywordMap = new Map([['PART', [{ keyword: 'PART', filePath: file, lineIndex: 0 }]]]);
            const snapshot = { rootFile: file, files: [file, child], graph, keywordMap };
            const before = JSON.stringify({ tree: graph.toTree(file), files: snapshot.files, keywords: [...keywordMap] });
            const updater = createGraphUpdater({ collectIncludeDirectivesFromFile: async () => { throw failure; } });
            await assert.rejects(updater.updateFile(file, snapshot), error => error === failure);
            assert.equal(JSON.stringify({ tree: graph.toTree(file), files: snapshot.files, keywords: [...keywordMap] }), before);
        }
    });

    it('still removes an actually absent file from a legacy graph', async () => {
        const graph = new ProjectGraph();
        graph.addFile(file);
        const snapshot = { rootFile: file, files: [file], graph,
            keywordMap: new Map([['PART', [{ keyword: 'PART', filePath: file, lineIndex: 0 }]]]) };
        const updater = createGraphUpdater({ collectIncludeDirectivesFromFile: async () => {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        } });
        assert.deepEqual((await updater.updateFile(file, snapshot)).removedFiles, [file]);
        assert.deepEqual(snapshot.files, []);
    });

    it('publishes an incomplete legacy Include tree with an explicit failed node', async () => {
        const provider = new LsdynaIncludeTreeProvider();
        const view = {};
        provider.attachTreeView(view);
        deny(Object.assign(new Error('fixture denied'), { code: 'EACCES' }));
        assert.equal(await provider.scan(), null);
        assert.equal(provider.scanPhase, 'incomplete');
        assert.equal(provider.root.description, i18n.get('scanFailed'));
        assert.ok(view.message.includes(i18n.get('sidebarIncomplete')));
    });

    it('keeps prior project keyword roots and reports an incomplete legacy scan', async () => {
        const provider = new LsdynaKeywordIndexProvider({ collectIncludeFiles: async () => [file] });
        const previous = [{ label: 'Previous project' }];
        provider.roots = previous;
        const failure = Object.assign(new Error('fixture denied'), { code: 'EACCES' });
        deny(failure);
        await assert.rejects(provider.scan(), error => error === failure);
        assert.strictEqual(provider.roots, previous);
        assert.equal(provider.scanState, 'incomplete');
    });

    it('marks a legacy Include scan incomplete when only a child cannot be scanned', async () => {
        const child = path.join(directory, 'child.k');
        fs.writeFileSync(file, '*INCLUDE\nchild.k\n');
        fs.writeFileSync(child, '*KEYWORD\n');
        fs.promises.stat = function (name) {
            return name === child ? Promise.reject(Object.assign(new Error('child denied'), { code: 'EACCES' }))
                : originalStat.apply(this, arguments);
        };
        const provider = new LsdynaIncludeTreeProvider();
        assert.equal(await provider.scan(), null);
        assert.equal(provider.scanPhase, 'incomplete');
        assert.equal(provider.root.children[0].description, i18n.get('scanFailed'));
        assert.equal(provider.root.children[0].parent, provider.root);
    });

    it('resolves a relative child without an injected resolver and propagates real resolver faults', async () => {
        const child = path.join(directory, 'child.k');
        fs.writeFileSync(file, '*INCLUDE\nchild.k\n');
        fs.writeFileSync(child, '*KEYWORD\n*END\n');
        const provider = new LsdynaIncludeTreeProvider();
        await provider.scan();
        assert.equal(provider.scanPhase, 'complete');
        assert.equal(provider.root.children[0].filePath, child);
        for (const code of ['EACCES', 'EIO']) {
            const failure = Object.assign(new Error('resolver fault'), { code });
            const failed = new LsdynaIncludeTreeProvider({ searchFileFromPaths() { throw failure; } });
            await assert.rejects(() => failed.scan(), error => error === failure);
        }
    });

    it('keeps failed local disk indexes unavailable and recovers on a successful retry', async () => {
        const provider = new LsdynaKeywordIndexProvider();
        const view = {};
        provider.attachTreeView(view);
        const previousFile = path.join(directory, 'previous.k');
        fs.writeFileSync(previousFile, '*NODE\n1,0,0,0\n');
        const uri = name => ({ fsPath: name, toString: () => 'file://' + name });
        vscodeMock.window.activeTextEditor = undefined;
        await provider.refreshFromUriOrDocument(uri(previousFile));
        assert.ok(provider.findOccurrence(previousFile, 0));
        const failure = Object.assign(new Error('fixture denied'), { code: 'EACCES' });
        deny(failure);
        await provider.refreshFromUriOrDocument(uri(file));
        assert.equal(provider.scanState, 'incomplete');
        assert.equal(provider.documentIndices.has(uri(file).toString()), false);
        assert.equal(provider.findOccurrence(previousFile, 0), null);
        assert.deepEqual(provider.roots, []);
        assert.ok(view.message.includes(i18n.get('sidebarIncomplete')));
        fs.promises.stat = originalStat;
        await provider.refreshFromUriOrDocument(uri(file));
        assert.equal(provider.scanState, 'complete');
        assert.equal(provider.findOccurrence(file, 0).keyword, 'PART');
        assert.ok(!view.message.includes(i18n.get('sidebarIncomplete')));
        provider.stopAutomaticWork();
    });
});
