const assert = require('node:assert/strict');
const vscode = require('vscode');
const { createKeywordStructureDiagnostics } = require('../../out/client/services/keywordStructureDiagnostics');
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
function setup(lines = ['*NODE', 'bad']) {
    const document = { uri: vscode.Uri.file('D:/temp/structure.k'), languageId: 'lsdyna', version: 1,
        isClosed: false, lineCount: lines.length, lineAt: line => ({ text: lines[line] }) };
    let value = [], calls = [];
    const collection = { set(_uri, items) { value = items; }, delete() { value = []; }, clear() { value = []; } };
    const create = (analyze, options = {}) => createKeywordStructureDiagnostics({ collection,
        analyze: (...args) => { calls.push(args[1]); return analyze(...args); }, describe: () => 'Confirmed structural error',
        isSupported: doc => doc.languageId === 'lsdyna', debounceMs: 1, ...options });
    return { document, create, calls, value: () => value };
}
describe('conditional structure Problems lifecycle', () => {
    it('only publishes definite, unambiguous errors and removes them on correction', async () => {
        const f = setup(); let status = 'definite-error';
        const service = f.create(() => ({ status }));
        service.schedule(f.document); await tick();
        assert.equal(f.value().length, 1); assert.equal(f.value()[0].severity, vscode.DiagnosticSeverity.Error);
        for (status of ['valid', 'context-dependent', 'ambiguous', 'profile-unverified', 'unsupported-input']) {
            f.document.version++; service.schedule(f.document); assert.equal(f.value().length, 0);
            await tick(); assert.equal(f.value().length, 0, status);
        }
        service.publishManual(f.document, 0, { status: 'definite-error', mappingAmbiguous: true }, f.document.version);
        assert.equal(f.value().length, 0); service.dispose();
    });
    it('debounces, cancels stale analyses and never publishes after close/dispose', async () => {
        const f = setup();
        const service = f.create(() => { f.document.version++; return { status: 'definite-error' }; });
        service.schedule(f.document); service.schedule(f.document); await tick();
        assert.equal(f.calls.length, 1); assert.equal(f.value().length, 0);
        service.schedule(f.document); f.document.isClosed = true; service.clear(f.document); await tick();
        assert.equal(f.calls.length, 1);
        f.document.isClosed = false; service.schedule(f.document); service.dispose(); await tick();
        assert.equal(f.calls.length, 1);
    });
    it('bounds automatic documents/blocks and cancels while scanning', async () => {
        const f = setup(['*NODE', '*ELEMENT_SHELL']);
        const service = f.create(() => ({ status: 'definite-error' }), { maximumBlocks: 1 });
        service.schedule(f.document); await tick(); assert.equal(f.calls.length, 0);
        f.document.lineCount = 20001; service.schedule(f.document); await tick(); assert.equal(f.calls.length, 0);
        service.dispose();
        const large = setup(Array(10000).fill('*NODE'));
        const other = large.create(() => ({ status: 'definite-error' }));
        let reads = 0; const read = large.document.lineAt;
        large.document.lineAt = line => { reads++; if (reads === 100) setImmediate(() => other.clear(large.document)); return read(line); };
        other.schedule(large.document); await tick();
        assert.ok(reads <= 256); assert.equal(large.calls.length, 0); other.dispose();
    });
    it('manual checks survive pending automatic runs but reject stale document versions', async () => {
        const f = setup(), service = f.create(() => ({ status: 'valid' }));
        service.schedule(f.document);
        service.publishManual(f.document, 0, { status: 'definite-error' }, 1);
        await tick(); assert.equal(f.calls.length, 0); assert.equal(f.value().length, 1);
        f.document.version++; service.clear(f.document);
        service.publishManual(f.document, 0, { status: 'definite-error' }, 1);
        assert.equal(f.value().length, 0); service.dispose();
    });
    it('does not analyze keyword-looking text inside opaque COMMENT blocks', async () => {
        const f = setup(['*COMMENT *NODE', ' *NODE', 'bad', '$ comment', '*NODE', 'real']);
        const service = f.create(() => ({ status: 'valid' }));
        service.schedule(f.document); await tick();
        assert.ok(!f.calls.includes(1)); assert.ok(f.calls.includes(4)); service.dispose();
    });
});
