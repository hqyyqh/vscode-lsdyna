const assert = require('node:assert/strict');
const { fakeDoc } = require("../../support/helpers");
const { LsdynaKeywordIndexProvider } = require('../../../src/client/providers/keywordIndexProvider');

describe('live block index editing boundary', () => {
    it('requires a live document identity and version, including same-URI reopen', async () => {
        const provider = new LsdynaKeywordIndexProvider({ shouldSkipAutomaticDocumentScan: () => false });
        const document = { ...fakeDoc('*NODE\n1\n*END'), version: 1, languageId: 'lsdyna' };
        assert.equal(provider.getDocumentBlockIndexIfReady(document), null);
        await provider.refreshFromDocument(document);
        assert.equal(provider.getDocumentBlockIndexIfReady(document).findBlockAtLine(1).startLine, 0);
        document.version++;
        assert.equal(provider.getDocumentBlockIndexIfReady(document), null);
        await provider.refreshFromDocument(document);
        assert.ok(provider.getDocumentBlockIndexIfReady(document));
        document.isClosed = true;
        assert.equal(provider.getDocumentBlockIndexIfReady(document), null);
        const reopened = { ...document, isClosed: false };
        assert.equal(provider.getDocumentBlockIndexIfReady(reopened), null);
        await provider.refreshFromDocument(reopened);
        assert.ok(provider.getDocumentBlockIndexIfReady(reopened));
        assert.equal(provider.getDocumentBlockIndexIfReady({ ...reopened }), null);
    });
});

describe('shared document presentation', () => {
    const { prepareDocumentPresentation, updateDocumentPresentationAfterChange,
        collectKeywordDecorationRanges } = require('../../../src/extension')._internals;
    const includes = require('../../../src/core/parser/includeScanner');
    it('shares preparation and does not reread a million-line deck for numeric edits', async () => {
        let reads = 0, value = '       1       0.0       0.0';
        const document = { ...fakeDoc(''), version: 1, lineCount: 1000000, languageId: 'lsdyna',
            lineAt: line => { reads++; return { text: line === 0 ? '*NODE' : value }; } };
        const pending = prepareDocumentPresentation(document);
        assert.equal(prepareDocumentPresentation(document), pending);
        const prepared = await pending;
        assert.equal(prepared.ranges.length, 1);
        prepared.painted = true;
        reads = 0;
        for (let i = 0; i < 30; i++) {
            const character = i % 2 ? 0 : 15;
            value = character === 0 ? '2      1       2.0       0.0' : '       1       2.0       0.0';
            document.version++;
            assert.equal(updateDocumentPresentationAfterChange({ document, contentChanges: [{
                range: { start: { line: 999999, character }, end: { line: 999999, character: character + 1 } }, text: '2',
            }] }), true);
            assert.equal(await prepareDocumentPresentation(document), prepared);
            assert.equal(collectKeywordDecorationRanges(document), prepared.ranges);
            assert.equal(prepared.skipDecorationsVersion, document.version);
        }
        assert.equal(reads, 30, 'one changed line per edit, independent of file length');
    });
    it('preserves parser results for paths, continuation, transforms and opaque comments', async () => {
        const texts = [
            '*INCLUDE_PATH_RELATIVE\nfolder +\n/sub\n*NODE\n1,0,0,0\n*INCLUDE\none.k +\n/part\n*END',
            '*INCLUDE_TRANSFORM\npart.k\n1,2,3,4,5\n*INCLUDE +\nother.k\n*END',
            '*COMMENT\n *INCLUDE\nhidden.k\n*INCLUDE\nvisible.k\n*END',
        ];
        for (const text of texts) {
            const document = { ...fakeDoc(text), version: 1, languageId: 'lsdyna' };
            const prepared = await prepareDocumentPresentation(document);
            const expected = includes.collectIncludeDirectivesFromLineReader(document.lineCount,
                i => document.lineAt(i).text, require('node:path').dirname(document.uri.fsPath));
            assert.deepEqual(await includes.collectIncludeDirectivesFromDocumentBlocks(document, prepared.blocks), expected);
        }
    });
    it('yields and honours cancellation even when every block is unrelated to Include', async () => {
        const original = performance.now;
        let clock = 0, cancelled = false;
        performance.now = () => clock += 9;
        try {
            setImmediate(() => { cancelled = true; });
            const document = fakeDoc('*NODE\n1,0');
            const blocks = Array.from({ length: 512 }, () => ({ keyword: 'NODE' }));
            const result = await includes.collectIncludeDirectivesFromDocumentBlocks(document, blocks, () => cancelled);
            assert.equal(result, null);
        } finally { performance.now = original; }
    });
    it('invalidates structural, Include and multi-location changes', async () => {
        for (const [line, text, extra] of [[1, 'x', false], [3, '*COMMENT', false], [3, '2', true]]) {
            const document = { ...fakeDoc('*INCLUDE\npart.k\n*NODE\n1,0'), version: 1, languageId: 'lsdyna' };
            const before = await prepareDocumentPresentation(document);
            const change = { range: { start: { line, character: line === 3 && !extra ? 0 : 1 }, end: { line, character: 2 } }, text };
            const originalLineAt = document.lineAt;
            document.lineAt = index => index === line ? { text: originalLineAt(index).text.slice(0, change.range.start.character) +
                text + originalLineAt(index).text.slice(change.range.end.character) } : originalLineAt(index);
            document.version++;
            assert.equal(updateDocumentPresentationAfterChange({ document, contentChanges: extra ? [change, change] : [change] }), false);
            assert.notEqual(await prepareDocumentPresentation(document), before);
        }
    });
    it('rejects closed/obsolete scans and does not reuse a same-URI reopened document', async () => {
        const document = { ...fakeDoc(''), version: 1, lineCount: 20000, languageId: 'lsdyna',
            lineAt: i => ({ text: i === 0 ? '*NODE' : '1,0,0,0' }) };
        const stale = prepareDocumentPresentation(document);
        document.version++;
        assert.equal(await stale, null);
        const next = prepareDocumentPresentation(document);
        document.isClosed = true;
        assert.equal(await next, null);
        const reopened = { ...document, isClosed: false };
        assert.ok(await prepareDocumentPresentation(reopened));
    });
});

describe('field interaction preparation', () => {
    const { prepareFieldInteraction } = require('../../../src/extension')._internals;
    it('prepares field choices with the keyword tree closed and no tree index', async () => {
        const api = require('../../../src/extension')._internals;
        const text = '*MAT_DAMAGE_1\n' + ' '.repeat(80) + '\n' + '7'.repeat(70) + '         0';
        const document = { ...fakeDoc(text), version: 1, languageId: 'lsdyna' };
        const position = { line: 2, character: 75 };
        const result = await api.planPreparedOfficialFieldChoices(document, position,
            { expectedDocumentVersion: 1, maximumKeywordLookback: 0 });
        assert.equal(result?.status, 'ready');
        assert.equal(result.keywordLine, 0);
        assert.equal(result.fieldName, 'FLAG');
        assert.deepEqual(result.choices.map(item => item.valueText), ['-1', '0', '1']);
        assert.equal(document.getText(), text);
    });
    it('rejects changed, closed and cancelled documents during asynchronous preparation', async () => {
        for (const mode of ['edit', 'close', 'cancel']) {
            const document = { ...fakeDoc('*MAT_DAMAGE_1\n1\n0'), version: 1, languageId: 'lsdyna' };
            const token = { isCancellationRequested: false };
            const pending = prepareFieldInteraction(document, { line: 2, character: 0 }, { cancellationToken: token });
            if (mode === 'edit') document.version++;
            if (mode === 'close') document.isClosed = true;
            if (mode === 'cancel') token.isCancellationRequested = true;
            assert.equal(await pending, false);
        }
    });
    it('does not publish choices after edits, close or cancellation during shared preparation', async () => {
        const { planPreparedOfficialFieldChoices } = require('../../../src/extension')._internals;
        for (const mode of ['edit', 'close', 'cancel']) {
            const document = { ...fakeDoc('*MAT_DAMAGE_1\n1\n0'), version: 1, languageId: 'lsdyna' };
            const token = { isCancellationRequested: false };
            const pending = planPreparedOfficialFieldChoices(document, { line: 2, character: 0 },
                { expectedDocumentVersion: 1, maximumKeywordLookback: 0, cancellationToken: token });
            if (mode === 'edit') document.version++;
            if (mode === 'close') document.isClosed = true;
            if (mode === 'cancel') token.isCancellationRequested = true;
            assert.equal(await pending, null);
        }
    });
});
