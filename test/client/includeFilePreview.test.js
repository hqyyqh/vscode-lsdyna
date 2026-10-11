'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const makeTemp = require('../support/tempDirectories').trackTempDirectories();
const { fakeDoc, vscodeMock: vscode } = require('../support/helpers');
const i18n = require('../../src/core/i18n');
const { LsdynaFieldHoverProvider } = require('../../src/extension')._internals;

describe('include preview resource ownership', () => {
    let root, file, document, configuration;
    beforeEach(() => {
        root = makeTemp(path.join(os.tmpdir(), 'dynasense-include-preview-unit-'));
        file = path.join(root, 'child.k');
        fs.writeFileSync(file, '*KEYWORD\n$ original 中文 &X\n*END');
        document = fakeDoc('*INCLUDE\nchild.k\n', path.join(root, 'main.k'));
        document.languageId = 'lsdyna';
        configuration = vscode.workspace.getConfiguration;
    });
    afterEach(() => { vscode.workspace.getConfiguration = configuration; });
    const hover = () => new LsdynaFieldHoverProvider().provideHover(document, { line: 1, character: 3 }, undefined, true);
    const setting = value => {
        vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => key === 'hover.previewMaxLines' ? value : fallback });
    };
    it('keeps invalid settings outside file allocation and preserves include actions', async () => {
        const open = fs.promises.open;
        let opens = 0;
        fs.promises.open = async (...args) => { opens++; return open(...args); };
        try {
            for (const value of ['not-a-number', -1, 501, Infinity, NaN]) {
                setting(value);
                const result = await hover();
                assert.ok(result.contents[0].value.includes('extension.openIncludeNewTab'));
                for (const label of ['openNewTab', 'openSplit', 'openFolder']) {
                    assert.ok(result.contents[0].value.includes(`${i18n.get(label)}](command:`), 'Visible action name survives preview failure');
                }
                assert.ok(!result.contents[0].value.includes('```lsdyna'));
            }
            assert.equal(opens, 0);
        } finally { fs.promises.open = open; }
    });
    it('preserves supported fractional settings and reports the actual byte cap', async () => {
        setting(34.141);
        const complete = await hover();
        assert.ok(complete.contents[0].value.includes('$ original 中文 &X'));
        fs.writeFileSync(file, 'x'.repeat(4100));
        const capped = await hover();
        assert.ok(!capped.contents[0].value.includes('```lsdyna'));
        assert.ok(capped.contents[0].value.includes('Partial file preview'));
    });
    for (const phase of ['read throw', 'read rejection', 'close rejection']) {
        it(`closes its real file handle on ${phase} and omits a failed preview`, async () => {
            const open = fs.promises.open;
            let handle, descriptor, closes = 0;
            fs.promises.open = async (...args) => {
                const actual = await open(...args);
                if (path.resolve(String(args[0])) !== path.resolve(file)) return actual;
                handle = actual; descriptor = handle.fd;
                const close = handle.close.bind(handle);
                if (phase === 'read throw') handle.read = () => { throw Error('controlled read failure'); };
                if (phase === 'read rejection') handle.read = async () => { throw Error('controlled read rejection'); };
                handle.close = async () => {
                    closes++; await close();
                    if (phase === 'close rejection') throw Error('controlled report after real close');
                };
                return handle;
            };
            try {
                const result = await hover();
                assert.ok(result.contents[0].value.includes('extension.openIncludeNewTab'));
                assert.ok(!result.contents[0].value.includes('```lsdyna'));
                assert.equal(closes, 1);
                assert.equal(handle.fd, -1);
                assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
            } finally {
                fs.promises.open = open;
                if (handle?.fd >= 0) await handle.close();
            }
        });
    }
});
