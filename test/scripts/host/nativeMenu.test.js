'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

describe('macOS context menu ownership and action checks', () => {
    function fixture({ owner = 'com.microsoft.VSCode', labels = ['Paste', 'Cut'], enabled = true, menus = 1 } = {}) {
        const pressed = [], source = fs.readFileSync(path.resolve(__dirname, '../../support/editor-safety/native-menu.cjs'), 'utf8');
        const module = { exports: {} };
        const execFile = (_file, args, options, callback) => {
            assert.equal(options.timeout, 5000);
            const Application = name => {
                assert.equal(name, 'System Events');
                return { applicationProcesses: { whose(query) {
                    assert.equal(query.unixId, 321);
                    return () => [{ bundleIdentifier: () => owner, menus: () => Array.from({ length: menus }, () => ({
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
