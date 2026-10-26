'use strict';
const assert = require('node:assert/strict');
const { fakeDoc, vscodeMock } = require("../../support/helpers");
const MarkdownIt = require('markdown-it');
const { parseDocument, DomUtils } = require('htmlparser2');
const { buildDefinitionHoverSection, buildReferenceHoverSection } = require('../../../out/core/references/fieldReferenceHover');
const { HOVER_TRUST, LsdynaFieldHoverProvider, clearReferenceIndexCacheForTesting, setFileIndexForTesting } = require('../../../out/extension')._internals;

describe('model text in trusted reference hovers', () => {
    afterEach(() => {
        clearReferenceIndexCacheForTesting();
        setFileIndexForTesting('/hover-command-safety/model.k', null);
    });
    const parser = new MarkdownIt({ html: true });
    parser.validateLink = () => true; // Exercise command links, as VS Code does.
    function commands(markdown) {
        const result = [];
        const visit = tokens => tokens.forEach(token => {
            if (token.type === 'link_open') result.push(token.attrGet('href'));
            if (token.children) visit(token.children);
        });
        visit(parser.parse(markdown, {}));
        return result.filter(url => url.startsWith('command:'));
    }
    it('omits curve data cells and keeps paths in the navigation tooltip', () => {
        const definition = { kind: 'curve', keyword: '*DEFINE_CURVE', id: 17, startLine: 0,
            filePath: 'C:/very-long-model-directory/'.repeat(4) + 'short-records.k',
            dataCompleteness: { state: 'incomplete' }, points: [{ xRaw: '4', yRaw: '' }] };
        const markdown = buildReferenceHoverSection({ fieldName: 'LCID', id: 17, definitions: [definition] });
        const dom = parseDocument(parser.render(markdown));
        const cells = DomUtils.getElementsByTagName('td', dom.children);
        assert.deepEqual(cells, []);
        assert.ok(!DomUtils.textContent(dom).includes(definition.filePath));
        assert.equal(DomUtils.getElementsByTagName('wbr', dom.children).length, 0);
        assert.ok(!DomUtils.textContent(dom).includes('short-records.k'));
        const links = DomUtils.getElementsByTagName('a', dom.children);
        assert.equal(links.length, 1);
        assert.ok(links[0].attribs.title.includes(definition.filePath));
        const [request] = JSON.parse(decodeURIComponent(links[0].attribs.href.split('?')[1]));
        assert.equal(request.filePath, definition.filePath);
    });
    it('omits raw curve and table data without creating commands or HTML', () => {
        const values = ['<A|B>', 'A\\|B', 'A\\\\|B', '`A|B`', '<a href="command:evil">A|B</a>', '[x](command:evil)|A', '中|文😀', '&lt;|&gt;'];
        for (const kind of ['curve', 'table']) {
            const definition = { kind, id: 1, keyword: kind === 'curve' ? '*DEFINE_CURVE' : '*DEFINE_TABLE_2D',
                dataCompleteness: { state: 'partial', reasons: ['expression-unresolved'] },
                points: values.map((value, index) => ({ xRaw: value, yRaw: String(index + 1) })),
                rows: values.map((value, index) => ({ valueRaw: value, childIdRaw: String(index + 1), childIds: [] })) };
            const markdown = buildDefinitionHoverSection(definition);
            const dom = parseDocument(parser.render(markdown));
            assert.equal(DomUtils.getElementsByTagName('table', dom.children).length, 0);
            assert.deepEqual(commands(markdown), []);
            assert.equal(DomUtils.getElementsByTagName('a', dom.children).length, 0);
            assert.ok(!markdown.includes('data:image/svg+xml;base64,'));
        }
    });
    it('keeps titles, file paths and fenced function bodies literal while retaining intended navigation', () => {
        const attack = '[run](command:workbench.action.terminal.new)';
        const ownCommandAttack = '[run](command:extension.openManual?%5B%22evil%22%5D)';
        const definition = { kind: 'functionCurve', keyword: '*DEFINE_CURVE_FUNCTION', id: 1,
            title: attack + ownCommandAttack + '<a href="command:evil">x</a>',
            filePath: 'model/`' + attack + '`/main.k', startLine: 0,
            functionText: '```\n' + attack + '\n````\n' + ownCommandAttack };
        assert.deepEqual(commands(buildDefinitionHoverSection(definition)), []);
        const rendered = buildReferenceHoverSection({ fieldName: 'LCID', id: 1,
            raw: '`' + attack + '`', definitions: [definition] });
        const links = commands(rendered);
        assert.equal(links.length, 1);
        assert.ok(links[0].startsWith('command:extension.openLsdynaReferenceDefinition?'));
        const [request] = JSON.parse(decodeURIComponent(links[0].split('?')[1]));
        assert.equal(request.filePath, definition.filePath);
        const dom = parseDocument(parser.render(rendered));
        assert.ok(DomUtils.getElementsByTagName('a', dom.children)[0].attribs.title.includes(definition.filePath));
        assert.ok(parser.render(rendered).includes('workbench.action.terminal.new'));
    });
    it('restricts command trust to the explicit extension actions', () => {
        assert.ok(Array.isArray(HOVER_TRUST.enabledCommands));
        assert.ok(HOVER_TRUST.enabledCommands.includes('extension.openLsdynaReferenceDefinition'));
        assert.ok(!HOVER_TRUST.enabledCommands.includes('workbench.action.terminal.new'));
        assert.ok(!HOVER_TRUST.enabledCommands.includes('evil'));
    });
    it('applies restricted trust to the actual keyword Hover provider', async () => {
        const doc = fakeDoc('*DEFINE_CURVE_TITLE\n[run](command:workbench.action.terminal.new)\n         1\n                 0.0                 0.0\n                 1.0                 1.0\n*END', '/hover-command-safety/model.k');
        const hover = await new LsdynaFieldHoverProvider().provideHover(doc, new vscodeMock.Position(0, 5));
        assert.ok(hover);
        for (const content of hover.contents) {
            assert.notEqual(content.isTrusted, true);
            if (content.isTrusted) assert.deepEqual(content.isTrusted, HOVER_TRUST);
            assert.ok(!commands(content.value).includes('command:workbench.action.terminal.new'));
        }
    });
});
