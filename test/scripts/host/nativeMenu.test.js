'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

describe('macOS context menu ownership and action checks', () => {
    const create = require('../../support/tempDirectories.js').trackTempDirectories();
    it('retains macOS menu evidence without masking failure when native capture is unavailable', async () => {
        const script = path.resolve(__dirname, '../../host/editor-safety/extension-host/index.js');
        const hostRequire = require('node:module').createRequire(script);
        const root = create(path.join(require('node:os').tmpdir(), 'host-menu-diagnostic-'));
        const sandbox = { module: { exports: {} }, __dirname: path.join(root, 'test/host/editor-safety/extension-host'),
            process: { platform: 'darwin', env: { GITHUB_ACTIONS: 'true', LSDYNA_EDITOR_SAFETY_WORKSPACE: path.join(root, 'workspace') } },
            console: { error() {} }, setTimeout, clearTimeout, Buffer, require(name) {
                if (name === 'vscode') return {};
                if (name === 'node:child_process') return { execFileSync(file, args, options) {
                    assert.equal(file, '/usr/sbin/screencapture');
                    assert.equal(options.timeout, 5000);
                    assert.equal(path.dirname(args[1]), path.join(root, '.artifacts/node/editor-diagnostics'));
                    throw Error('Screen capture unavailable');
                } };
                return hostRequire(name);
            } };
        vm.runInNewContext(fs.readFileSync(script, 'utf8') + '\nmodule.exports = captureRendererDiagnostic;', sandbox);
        const state = { activeElement: null, visibleContextOrMenuElements: [] };
        const result = await sandbox.module.exports({ call: async method => method === 'Page.captureScreenshot'
            ? { data: Buffer.from('fixture pixels').toString('base64') } : { result: { value: state } } }, 'context-menu-Ctrl-V');
        assert.equal(result, state);
        const output = path.join(root, '.artifacts/node/editor-diagnostics/context-menu-Ctrl-V');
        assert.equal(fs.readFileSync(output + '.png', 'utf8'), 'fixture pixels');
        assert.deepEqual(JSON.parse(fs.readFileSync(output + '.json')), state);
    });

    function fixture({ owner = 'com.microsoft.VSCode', labels = ['Paste', 'Cut'], enabled = true, menus = 1, frontmost = true, inaccessible = false } = {}) {
        const pressed = [], source = fs.readFileSync(path.resolve(__dirname, '../../support/editor-safety/native-menu.cjs'), 'utf8');
        const module = { exports: {} };
        const execFile = (_file, args, options, callback) => {
            assert.equal(options.timeout, 5000);
            const Application = name => {
                assert.equal(name, 'System Events');
                return { keyCode: code => pressed.push(code), applicationProcesses: { whose(query) {
                    assert.equal(query.unixId, 321);
                    return () => [{ bundleIdentifier: () => owner, get frontmost() { return () => frontmost; }, set frontmost(value) { frontmost = value; }, uiElements: () => { if(inaccessible) throw Error('Cannot get object'); return [{role: () => 'AXWindow'}]; }, windows: () => [{role: () => 'AXWindow', uiElements: () => [], menus: () => []}], menus: () => Array.from({ length: menus }, () => ({
                        menuItems: () => labels.map(label => ({ name: () => label, enabled: () => enabled,
                            click: () => pressed.push(label) })),
                    })) }];
                } } };
            };
            try {
                const stdout = vm.runInNewContext(args[3] + '; run(' + JSON.stringify(args.slice(4)) + ')', { Application });
                callback(null, stdout);
            } catch (error) { callback(error); }
        };
        // Match execFile's promisified {stdout, stderr} result without invoking macOS on other platforms.
        const util = require('node:util');
        execFile[util.promisify.custom] = (...args) => new Promise((resolve, reject) =>
            execFile(...args, (error, stdout) => error ? reject(error) : resolve({ stdout })));
        vm.runInNewContext(source, { module, process: { platform: 'darwin', ppid: 321 },
            require: name => name === 'node:child_process' ? { execFile } : require(name) });
        return { menu: module.exports, pressed };
    }
    it('reads without clicking, then presses only the requested enabled native item', async () => {
        const f = fixture();
        assert.equal((await f.menu('Paste')).point.nativeItem, 'Paste');
        assert.deepEqual(f.pressed, []);
        await f.menu('Cut', true);
        assert.deepEqual(f.pressed, ['Cut']);
    });
    it('captures only the owned AX tree without performing an action', async () => {
        const f=fixture();
        const result=await f.menu('Inspect');
        assert.equal(result.pid,321);assert.equal(result.tree.children[0].role,'AXWindow');
        assert.ok(result.focused.error);assert.deepEqual(f.pressed,[]);
        await assert.rejects(f.menu('Inspect',true));
        await assert.rejects(fixture({owner:'another.app'}).menu('Inspect'));
    });
    it('dismisses only the owned foreground native menu and preserves empty-menu diagnostics', async () => {
        const f = fixture({menus: 0});
        const empty = await f.menu('Paste');
        assert.equal(empty.native.frontmost, true);
        assert.equal(empty.native.roles[0], 'AXWindow');
        await f.menu('Escape', true);
        assert.deepEqual(f.pressed, [53]);
        for (const options of [{frontmost: false}, {owner: 'another.app'}]) {
            const other = fixture(options);
            await assert.rejects(other.menu('Escape', true));
            assert.deepEqual(other.pressed, []);
        }
        await assert.rejects(f.menu('Escape'));
    });
    it('focuses only the owned test host and keeps optional AX diagnostic errors separate', async () => {
        const f = fixture({frontmost:false,menus:0,inaccessible:true});
        assert.equal((await f.menu('Focus',true)).focused,true);
        const state = await f.menu('Paste');
        assert.equal(state.native.frontmost,true);
        assert.match(state.native.roles.error,/Cannot get object/);
        assert.equal(state.point,null);
        const wrong = fixture({owner:'another.app'});
        await assert.rejects(wrong.menu('Focus',true));
        assert.deepEqual(wrong.pressed,[]);
    });
    for (const [name, options] of [['wrong owner', { owner: 'another.app' }],
        ['closed menu', { menus: 0 }], ['multiple menus', { menus: 2 }],
        ['duplicate action', { labels: ['Paste', 'Paste'] }], ['disabled action', { enabled: false }]]) {
        it(`rejects ${name} without clicking`, async () => {
            const f = fixture(options);
            await assert.rejects(f.menu('Paste', true));
            assert.deepEqual(f.pressed, []);
        });
    }
});

it('preserves the menu failure when native cleanup also fails and still closes CDP', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../host/editor-safety/extension-host/index.js'), 'utf8');
    const start = source.indexOf('async function assertRendererContextMenuPasteAndCutAreScopedAndUndoable()');
    const end = source.indexOf('async function assertCellDeleteCannotModifyReadonlyDeck()', start);
    const primary = Error('menu missing'), cleanup = Error('background host');
    let closed = false, restored = false;
    const context = {
        process: {platform:'darwin'}, console: {error() {}},
        vscode: {commands:{executeCommand:async()=>{}},env:{clipboard:{readText:async()=> 'original'}},
            ViewColumn:{One:1},Selection:class { constructor(){this.start={line:2,character:0};this.end=this.start;} }},
        workspaceSnapshot:()=>({}), connectWorkbenchDevTools:async()=>({close(){closed=true;}}),
        openFixture:async()=>({document:{getText:()=>'',lineAt:()=>({text:''})},editor:{}}),
        waitForRendererEditorFocus:async()=>{},writeClipboardText:async value=>{if(value==='original')restored=true;},
        getRendererEditorPositionPoint:async()=>({}),dispatchRendererMouseClick:async()=>{},
        waitForRendererMenuItem:async()=>{throw primary;},require:()=>async label=>{if(label!=='Focus')throw cleanup;},
    };
    const run = vm.runInNewContext(source.slice(start,end)+'; assertRendererContextMenuPasteAndCutAreScopedAndUndoable',context);
    await assert.rejects(run(),error=>error===primary && error.cleanupError===cleanup);
    assert.equal(closed,true);assert.equal(restored,true);
});
