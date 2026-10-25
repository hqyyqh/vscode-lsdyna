'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.check = async (extension, root, checks) => {
    // Windows can expose a different drive-letter case in extensionPath. Requiring
    // it again would create a second, unactivated module with different caches.
    const entry = path.join(extension.extensionPath, 'out/extension.js').toLowerCase();
    const module = Object.values(require.cache).find(item => item.filename.toLowerCase() === entry);
    assert.ok(module, 'Use the running extension module');
    const api = module.exports._internals;
    const file = path.join(root, 'workspace', 'reference-hover.k');
    fs.writeFileSync(file, ['*LOAD_BODY_Z', '         1         1', '*DEFINE_CURVE', '         1',
        '                   0                   1', '                   5                   1',
        '*DEFINE_TABLE_2D', '         2', '                   0                   1',
        '*DEFINE_TABLE', '         3', '                   0', '*DEFINE_CURVE', '         4',
        '                   0                   1', '                   5                   1',
        '*DEFINE_TABLE_3D', '         5', '                   0                   3'].join('\n'));
    const cases = [{ file, positions: [[1, 9], [2, 2], [6, 2], [18, 39]] }];
    const actualFile = path.join(root, 'workspace', 'interaction.k');
    if (fs.existsSync(actualFile)) {
        const lines = fs.readFileSync(actualFile, 'utf8').split(/\r?\n/);
        const load = lines.findIndex(line => line.trim() === '*LOAD_BODY_Z');
        const curve = lines.findIndex(line => line.trim() === '*DEFINE_CURVE');
        assert.ok(load >= 0 && curve >= 0);
        let reference = load + 1;
        while (lines[reference].trimStart().startsWith('$')) reference++;
        cases.push({ file: actualFile, positions: [[reference, 5], [curve, 2]] });
    }
    for (const scenario of cases) {
        const document = await vscode.workspace.openTextDocument(scenario.file);
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('extension.scanIncludeTree', scenario.file);
        const snapshot = (await api.getReferenceIndexForDocument(document)).snapshot;
        assert.equal(api.cacheReferenceIndexFromSnapshot(snapshot, { maxBytes: 1 }), false);
        assert.equal(api.getMainDeckContextForDocumentPath(scenario.file).project?.snapshot, undefined);
        for (const [line, character] of scenario.positions) {
            const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri,
                new vscode.Position(line, character));
            const markdown = (hover || []).flatMap(item => item.contents.map(content =>
                typeof content === 'string' ? content : content.value || '')).join('\n');
            if (!markdown.includes('data:image/svg+xml;base64,')) {
                const state = await api.getReferenceIndexForDocument(document);
                fs.writeFileSync(path.join(root, 'hover-failure.json'), JSON.stringify({ markdown,
                    state: state && { unavailable: state.unavailable, reasons: state.incompleteReasons,
                        rootFile: state.rootFile, files: state.snapshot?.files,
                        indexes: [...(state.snapshot?.fileIndexes || [])],
                        referenceIndex: state.referenceIndex } }, null, 2));
            }
            assert.ok(markdown.includes('data:image/svg+xml;base64,'), `${scenario.file}:${line + 1}`);
            checks.push(`${path.basename(scenario.file)}:${line + 1}: SVG after cache rejection`);
        }
    }
    if (process.env.LSDYNA_RELEASE_CDP_PORT) {
        await require('./table-hover.cjs').check(file, root, checks);
    }
};
