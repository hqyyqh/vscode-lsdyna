const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { vscodeMock: vscode } = require('../helpers');
const { LargeFileViewerProvider } = require('../../src/client/LargeFileViewerProvider');
const { buildFileIndex } = require('../../src/core/scanner/fileIndexBuilder');

describe('large-file viewer scanner contract', () => {
    it('accepts the current real scanner output and rejects old or mismatched indexes', async function () {
        this.timeout(10000); // Includes cold loading of the real scanner's semantic catalogs.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-viewer-index-'));
        const file = path.join(root, 'model.k');
        fs.writeFileSync(file, '*KEYWORD\n*NODE\n1,0,0,0\n*END\n');
        try {
            const index = await buildFileIndex(file, { largeFileThresholdBytes: 0 });
            for (const change of [{}, { scannerVersion: index.scannerVersion - 1 }, { largeFileLineMap: null }, { size: index.size + 1 }]) {
                const actual = { ...index, ...change };
                const provider = new LargeFileViewerProvider(root, { get() {}, update() {} }, { loadFileIndex: async () => actual });
                const uri = vscode.Uri.file(file);
                const session = { document: { uri }, generation: 1, index: null,
                    signature: { size: index.size, mtimeMs: index.mtimeMs }, state: { indexing: 'loading' } };
                provider.sessions.set(process.platform === 'win32' ? file.toLocaleLowerCase() : file, session);
                provider.loadWindow = async () => {};
                provider.publish = () => {};
                await provider.initialize(session, 0);
                assert.equal(session.state.indexing, Object.keys(change).length ? 'error' : 'ready');
                if (!Object.keys(change).length) assert.equal(session.index, actual);
                else assert.equal(session.index, null);
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
