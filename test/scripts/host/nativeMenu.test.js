'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

describe('macOS context menu ownership and action checks', () => {
    function fixture({ owner = 'com.microsoft.VSCode', labels = ['Paste', 'Cut'], enabled = true, menus = 1, frontmost = true } = {}) {
        const pressed = [], source = fs.readFileSync(path.resolve(__dirname, '../../support/editor-safety/native-menu.cjs'), 'utf8');
        const module = { exports: {} };
        const execFile = (_file, args, options, callback) => {
            assert.equal(options.timeout, 5000);
            const Application = name => {
                assert.equal(name, 'System Events');
                return { keyCode: code => pressed.push(code), applicationProcesses: { whose(query) {
                    assert.equal(query.unixId, 321);
                    return () => [{ bundleIdentifier: () => owner, frontmost: () => frontmost, uiElements: () => [{role: () => 'AXWindow'}], windows: () => [{role: () => 'AXWindow', uiElements: () => [], menus: () => []}], menus: () => Array.from({ length: menus }, () => ({
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
        waitForRendererMenuItem:async()=>{throw primary;},require:()=>async()=>{throw cleanup;},
    };
    const run = vm.runInNewContext(source.slice(start,end)+'; assertRendererContextMenuPasteAndCutAreScopedAndUndoable',context);
    await assert.rejects(run(),error=>error===primary && error.cleanupError===cleanup);
    assert.equal(closed,true);assert.equal(restored,true);
});
