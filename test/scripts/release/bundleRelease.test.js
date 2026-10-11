'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { bundleRelease } = require("../../../scripts/release/bundle-release.cjs");
describe('release bundling', () => {
    it('preserves module-relative resources and all three independent entrypoints after regular expressions and templates', async function () {
        this.timeout(30000);
        const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-bundle-test-')));
        const root = path.join(temporary, 'stage'), alias = path.join(temporary, 'alias');
        fs.mkdirSync(root);
        fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
        const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
        try {
            fs.mkdirSync(path.join(root, 'out/runtime'), { recursive: true });
            write('.vscodeignore', ''); write('node_modules/unused/LICENSE', 'retain license'); write('node_modules/unused/unused.js', 'throw Error()');
            write('out/core/fixture.json', '{"value":42}');
            write('out/core/helper.js', `const regex=/["'/]/;module.exports={directory:__dirname,file:\`\${__filename}\`,data:require('./fixture.json'),regex:regex.test("'")};`);
            write('out/extension.js', "module.exports=require('./core/helper');");
            for (const entry of ['server/server', 'worker/scanWorker']) write(`out/${entry}.js`, "module.exports=require('../core/helper');");
            await bundleRelease(alias);
            for (const entry of ['extension', 'server/server', 'worker/scanWorker']) {
                const value = require(path.join(root, 'out', entry));
                assert.equal(value.directory, path.join(root, 'out/core'));
                assert.equal(value.file, path.join(root, 'out/core/helper.js'));
                assert.deepEqual(value.data, { value: 42 }); assert.equal(value.regex, true);
            }
            assert.ok(!fs.existsSync(path.join(root, 'out/core/helper.js')));
            assert.ok(!fs.existsSync(path.join(root, 'node_modules/unused/unused.js')));
            assert.equal(fs.readFileSync(path.join(root, 'node_modules/unused/LICENSE'), 'utf8'), 'retain license');
        } finally {
            assert.equal(path.dirname(fs.realpathSync(temporary)), fs.realpathSync(os.tmpdir()));
            fs.rmSync(temporary, { recursive: true, force: true });
        }
    });
});
