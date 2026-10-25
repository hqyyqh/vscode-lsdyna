const assert = require('node:assert/strict');
const { fakeDoc: makeDoc, vscodeMock } = require('../support/helpers');
let sequence = 0;
const fakeDoc = text => makeDoc(text, `/compact-hover/${++sequence}.k`);
const i18n = require('../../out/core/i18n');
const { LsdynaFieldHoverProvider, buildFieldHelpMarkdown, beginHoverRequest, handleHoverAction, clearReferenceIndexCacheForTesting } = require('../../out/extension')._internals;
const { buildCompactReferenceHover } = require('../../out/core/references/fieldReferenceHover');
const MarkdownIt = require('markdown-it');
const { parseDocument, DomUtils } = require('htmlparser2');
const parser = new MarkdownIt({ html: true });
parser.validateLink = () => true;
const curve = '*DEFINE_CURVE\n   1000001\n               0.000           1.0000000\n           5.0000000           1.0000000\n*END';
function value(hover) { assert.ok(hover); return hover.contents.map(c => c.value).join('\n'); }
describe('compact native hover', () => {
    let config, editor, execute, picker;
    beforeEach(() => { config=vscodeMock.workspace.getConfiguration; editor=vscodeMock.window.activeTextEditor;
        execute=vscodeMock.commands.executeCommand; picker=vscodeMock.window.showQuickPick; });
    afterEach(() => { vscodeMock.workspace.getConfiguration=config; vscodeMock.window.activeTextEditor=editor;
        vscodeMock.commands.executeCommand=execute; vscodeMock.window.showQuickPick=picker; i18n.updateLanguage(); clearReferenceIndexCacheForTesting(); });
    for (const language of ['zh-cn','en']) {
        it(`expands only field help with icon-only controls and preserves the full text (${language})`, async () => {
            vscodeMock.workspace.getConfiguration=()=>({get:key=>key==='language'?language:undefined}); i18n.updateLanguage();
            const doc=fakeDoc(curve), position=new vscodeMock.Position(1,5);
            const active={document:doc, selection:new vscodeMock.Selection(position,position)};
            vscodeMock.window.activeTextEditor=active;
            vscodeMock.commands.executeCommand=async()=>{};
            const request=beginHoverRequest(doc,position);
            const field={n:'TEST',nativeIdentity:true};
            for (const text of ['Line 1\nLine 2\nLine 3\nKeep FLAG = -1.', 'First paragraph.\n\nKeep FLAG = -1.']) {
                const context={compact:true,hoverRequest:request,schemaText:text};
                const compact=buildFieldHelpMarkdown(field,context);
                const link=DomUtils.getElementsByTagName('a',parseDocument(parser.render(compact)).children)[0];
                assert.ok(link.attribs.href.startsWith('command:extension.toggleFieldHelp?'));
                assert.equal(link.attribs.title,i18n.get('fieldHelpExpand'));
                assert.equal(DomUtils.textContent(link),'$(chevron-down)');
                assert.doesNotMatch(compact,/Keep FLAG| …/);
                assert.equal(await handleHoverAction(request.id,false,true),true);
                assert.equal(request.expanded,false);
                const full=buildFieldHelpMarkdown(field,context);
                assert.match(full,/Keep FLAG = -1\./);
                assert.match(full,/\$\(chevron-up\)/);
                assert.ok(full.includes(`"${i18n.get('fieldHelpCollapse')}"`));
                assert.equal(await handleHoverAction(request.id,false,true),true);
                assert.equal(buildFieldHelpMarkdown(field,context),compact);
            }
            assert.doesNotMatch(buildFieldHelpMarkdown(field,{compact:true,hoverRequest:request,schemaText:'Short help.'}),/chevron|toggleFieldHelp/);
            doc.version++;
            assert.equal(await handleHoverAction(request.id,false,true),false);
            assert.equal(request.fieldHelpExpanded,false);
        });
        it(`keeps one curve identity, no raw tables or warning blocks (${language})`, async () => {
            vscodeMock.workspace.getConfiguration=()=>({get:key=>key==='language'?language:undefined}); i18n.updateLanguage();
            const markdown=value(await new LsdynaFieldHoverProvider().provideHover(fakeDoc(curve), {line:0,character:5}));
            const dom=parseDocument(parser.render(markdown));
            assert.ok(markdown.includes('data:image/svg+xml;base64,'));
            assert.equal((DomUtils.textContent(dom).match(/DEFINE_CURVE/g)||[]).length,1);
            assert.equal(DomUtils.getElementsByTagName('table',dom.children).length,0);
            assert.doesNotMatch(markdown,/###|\$\(warning\)|manualDirNotConfigured|\n---/);
            assert.ok(markdown.includes('command:extension.hoverMore'));
            assert.ok(markdown.includes('command:extension.lsdynaChooseKeywordOptions'));
        });
        it(`keeps incomplete preview compact and full reasons available (${language})`, async () => {
            vscodeMock.workspace.getConfiguration=()=>({get:key=>key==='language'?language:undefined}); i18n.updateLanguage();
            const doc=fakeDoc(curve.replace('           5.0000000           1.0000000','           5.0000000'));
            const provider=new LsdynaFieldHoverProvider();
            const compact=value(await provider.provideHover(doc,{line:0,character:5}));
            assert.ok(compact.includes(i18n.get('hoverUnavailable')));
            assert.ok(!compact.includes('data:image/svg+xml'));
            assert.ok(!compact.includes(i18n.get('referenceDataIncomplete')));
            const full=value(await provider.provideDetailedHover(doc,{line:0,character:5}));
            assert.ok(full.includes(i18n.get('referenceDataIncomplete')));
        });
    }
    it('preserves field order in two small rows without repeating global settings', async () => {
        const doc=fakeDoc('*SET_SEGMENT\n'+['1','0','0','0','0','0','0','0'].map(x=>x.padStart(10)).join('')+'\n*END');
        const md=value(await new LsdynaFieldHoverProvider().provideHover(doc,{line:1,character:15}));
        const dom=parseDocument(parser.render(md));
        const rows=DomUtils.getElementsByTagName('tr',dom.children);
        assert.equal(rows.length,2);
        assert.ok(md.includes('<sub>11&#8209;20</sub>'));
        assert.ok(!md.includes('command:extension.disableFieldHover'));
        assert.ok(!md.includes('command:extension.muteFieldHoverSession'));
        assert.ok(!md.includes('###'));
    });
    it('does not imply a source parameter definition is a resolved effective value', async () => {
        const doc=fakeDoc('*PARAMETER\nR  tEnd  5.0\n*CONTROL_TERMINATION\n     &tEnd\n');
        const md=value(await new LsdynaFieldHoverProvider().provideHover(doc,{line:1,character:5}));
        assert.ok(md.includes(i18n.get('hoverUnresolved')));
        assert.ok(!md.includes(' = '));
    });
    it('does not choose an arbitrary curve for ambiguous references', () => {
        const definitions=[1,2].map(id=>({kind:'curve',keyword:'*DEFINE_CURVE',id,filePath:`${id}.k`,startLine:0,points:[{x:0,y:0},{x:1,y:id}]}));
        const result=buildCompactReferenceHover({state:'ambiguous',definitions,reasons:[]},1,null);
        assert.equal(result.body,''); assert.equal(result.actions,'');
        assert.ok(result.status.includes('2'));
    });
    it('does not draw incomplete table children or list their diagnostics', () => {
        const definition={kind:'table',keyword:'*DEFINE_TABLE_2D',id:1,rows:[{childIdRaw:'3',value:1,childAnalysis:{state:'missing',definitions:[],reasons:[]}}]};
        const result=buildCompactReferenceHover({state:'exact',definitions:[definition],reasons:[]},1,null);
        assert.equal(result.body,'');
    });
    it('marks uncertain table children without restoring diagnostic paragraphs', () => {
        const child={kind:'curve',points:[{x:0,y:1},{x:1,y:2}]};
        const row={childIdRaw:'3',value:1,childAnalysis:{state:'uncertain',definitions:[child],reasons:['project-scan-unavailable']}};
        const definition={kind:'table',keyword:'*DEFINE_TABLE_2D',id:1,rows:[row]};
        const uncertain=buildCompactReferenceHover({state:'exact',definitions:[definition],reasons:[]},1,null);
        assert.equal(uncertain.status,i18n.get('hoverCandidate'));
        assert.ok(!uncertain.body.includes('$(warning)'));
        const encoded=uncertain.body.match(/data:image\/svg\+xml;base64,([^|)]+)/);
        assert.ok(encoded);
        const svg=Buffer.from(encoded[1],'base64').toString('utf8');
        assert.ok(svg.includes('aria-label="*DEFINE_TABLE_2D"'));
        assert.ok(!/<text[^>]*>\*DEFINE_TABLE_2D<\/text>/.test(svg));
        row.childAnalysis.state='exact';
        assert.equal(buildCompactReferenceHover({state:'exact',definitions:[definition]},1,null).status,'');
    });
    it('rejects an edited document while the more menu is open', async () => {
        const doc=fakeDoc(curve), position=new vscodeMock.Position(0,5);
        vscodeMock.window.activeTextEditor={document:doc};
        vscodeMock.window.showQuickPick=async items=>{doc.version++;return items[0];};
        const request=beginHoverRequest(doc,position);
        assert.equal(await handleHoverAction(request.id,true),false);
        assert.equal(request.expanded,false);
    });
    it('expands via the real menu handler, anchors the target, and rejects edited documents', async () => {
        const doc=fakeDoc(curve); const position=new vscodeMock.Position(0,5);
        const selections=[new vscodeMock.Selection(1,0,1,3)];
        const active={document:doc,selections,get selection(){return this.selections[0]},set selection(v){this.selections=[v]}};
        vscodeMock.window.activeTextEditor=active;
        vscodeMock.commands.executeCommand=async()=>{};
        vscodeMock.window.showQuickPick=async items=>items[0];
        const request=beginHoverRequest(doc,position);
        assert.equal(await handleHoverAction(request.id,true),true);
        assert.equal(request.expanded,true); assert.equal(active.selection.active.line,0); assert.equal(active.selection.active.character,5);
        const full=value(await new LsdynaFieldHoverProvider().provideHover(doc,position));
        assert.ok(full.includes('command:extension.toggleHoverDetails'));
        assert.equal(await handleHoverAction(request.id),true); assert.equal(request.expanded,false);
        doc.version++; assert.equal(await handleHoverAction(request.id),false);
    });
    it('rejects requests after close/reopen and after another hover replaces the menu target', async () => {
        const first=fakeDoc(curve), second=fakeDoc(curve);
        const position=new vscodeMock.Position(0,5);
        const request=beginHoverRequest(first,position);
        vscodeMock.window.activeTextEditor={document:second};
        assert.equal(await handleHoverAction(request.id),false);
        vscodeMock.window.activeTextEditor={document:first};
        beginHoverRequest(second,position);
        assert.equal(await handleHoverAction(request.id),false);
    });
});
