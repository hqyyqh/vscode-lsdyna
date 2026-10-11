const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const makeTemp = require('../support/tempDirectories').trackTempDirectories();
const vscode = require('../support/vscode-mock');
const { chooseManualDirectory, validateManualDirectory } = require('../../src/manual/manualSetup');
const i18n = require('../../src/core/i18n');

describe('manual setup', () => {
    let pick, dialog, external, language;
    beforeEach(() => { language=i18n.getLanguage; i18n.getLanguage=()=> 'zh-cn'; pick=vscode.window.showQuickPick; dialog=vscode.window.showOpenDialog; external=vscode.env.openExternal; });
    afterEach(() => { i18n.getLanguage=language; vscode.window.showQuickPick=pick; vscode.window.showOpenDialog=dialog; vscode.env.openExternal=external; });
    function legacyPack() {
        const root=makeTemp(path.join(os.tmpdir(), 'manual-setup-')); fs.mkdirSync(path.join(root,'indexes'));
        fs.writeFileSync(path.join(root,'manifest.json'), JSON.stringify({documents:[],languages:['en']}));
        for(const [name,payload] of Object.entries({keywords:{},sections:[{manualId:'v',sectionId:'a',titleEn:'A',pathEn:'a.md',anchors:[]}],anchors:{}}))
            fs.writeFileSync(path.join(root,'indexes',name+'.json'),JSON.stringify({schemaVersion:1,[name]:payload}));
        return root;
    }
    it('accepts old schema-1 packs without new capability fields and legacy PDF folders', () => {
        validateManualDirectory(legacyPack());
        const root=makeTemp(path.join(os.tmpdir(), 'manual-pdf-')); fs.writeFileSync(path.join(root,'manual.pdf'),'test');
        validateManualDirectory(root);
    });
    it('rejects unsupported or missing indexes even when a sibling PDF exists', () => {
        const root=legacyPack();fs.writeFileSync(path.join(root,'manual.pdf'),'test');
        fs.writeFileSync(path.join(root,'indexes/keywords.json'),JSON.stringify({schemaVersion:99,keywords:{}}));
        assert.throws(()=>validateManualDirectory(root),/schemaVersion/);
        fs.unlinkSync(path.join(root,'indexes/keywords.json'));
        assert.throws(()=>validateManualDirectory(root));
        assert.throws(()=>validateManualDirectory(makeTemp(path.join(os.tmpdir(), 'manual-empty-'))));
    });
    it('cancels without downloading or selecting a directory', async () => {
        vscode.window.showQuickPick=async()=>undefined;
        vscode.env.openExternal=async()=>assert.fail('unexpected download');
        assert.equal(await chooseManualDirectory(),undefined);
    });
    for(const [action,url] of [
        ['bilingual','https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-bilingual.zip'],
        ['en','https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-en.zip'],
    ]) it('opens only the selected '+action+' download destination',async()=>{
        vscode.window.showQuickPick=async items=>items.find(item=>item.action===action);
        let opened;vscode.env.openExternal=async uri=>{opened=uri.toString();return true;};
        assert.equal(await chooseManualDirectory(),undefined);assert.equal(opened,url);
    });
    it('offers only the English pack and local folder in English mode', async () => {
        i18n.getLanguage=()=> 'en';
        vscode.window.showQuickPick=async items=>{
            assert.deepEqual(items.map(item=>item.action), ['folder','en']);
            return items[1];
        };
        let opened; vscode.env.openExternal=async uri=>{opened=uri.toString();return true;};
        await chooseManualDirectory();
        assert.ok(opened.endsWith('/lsdyna-manual-pack-en.zip'));
    });
    it('reoffers setup after an invalid folder without returning it for config persistence', async () => {
        let attempts=0;const root=legacyPack();
        vscode.window.showQuickPick=async (items,options)=>{
            if(attempts)assert.equal(options.placeHolder,i18n.get('manualSetupUnavailable'));
            return items[0];
        };
        vscode.window.showOpenDialog=async()=>[{fsPath:attempts++ ? root : path.join(root,'missing')}];
        assert.equal(await chooseManualDirectory(),root);assert.equal(attempts,2);
    });
    for(const failure of [false,'throw'])it('handles download launch failure: '+failure,async()=>{
        let calls=0;vscode.window.showQuickPick=async(items,options)=>{
            if(calls++){assert.equal(options.placeHolder,i18n.get('manualDownloadFailed'));return;}
            return items[1];
        };
        vscode.env.openExternal=async()=>{if(failure==='throw')throw Error('offline');return false;};
        assert.equal(await chooseManualDirectory(),undefined);assert.equal(calls,2);
    });
});
