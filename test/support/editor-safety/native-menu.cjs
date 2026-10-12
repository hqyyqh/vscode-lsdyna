'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Query and press the actual macOS menu through Accessibility, never an editor command.
const script = `function run(args) {
    const processes = Application('System Events').applicationProcesses.whose({unixId: Number(args[0])})();
    if (processes.length !== 1) throw Error('Test host native process is unavailable');
    const host = processes[0];
    if (host.bundleIdentifier() !== 'com.microsoft.VSCode') throw Error('Unexpected native menu owner');
    const menus = host.menus();
    if (!menus.length) {
        if (args[1] === 'click') throw Error('Native context menu is closed');
        return JSON.stringify({items: [], point: null});
    }
    if (menus.length !== 1) throw Error('Ambiguous native context menu');
    const entries = menus[0].menuItems();
    const items = entries.map(item => ({text: item.name(), disabled: !item.enabled()}));
    const matches = items.flatMap((item, index) => item.text === args[2] && !item.disabled ? [index] : []);
    if (matches.length > 1) throw Error('Ambiguous native menu action');
    if (args[1] === 'click') {
        if (matches.length !== 1) throw Error('Native menu action is unavailable');
        entries[matches[0]].click();
    }
    return JSON.stringify({items, point: matches.length ? {nativeItem: args[2]} : null});
}`;

module.exports = async function nativeMenu(label, click = false) {
    if (process.platform !== 'darwin' || !['Paste', 'Cut'].includes(label)) throw Error('Unsupported native menu action');
    const { stdout } = await promisify(execFile)('/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', script, String(process.ppid), click ? 'click' : 'read', label],
        { timeout: 5000, maxBuffer: 64 * 1024 });
    return JSON.parse(stdout);
};
