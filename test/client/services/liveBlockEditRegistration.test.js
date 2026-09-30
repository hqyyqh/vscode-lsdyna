'use strict';
const assert = require('node:assert/strict');
const { fakeDoc, vscodeMock } = require('../../helpers');
const extension = require('../../../src/extension');

describe('live block index document-event registration', () => {
    it('retains current block boundaries while invalidating derived references after a data edit', async () => {
        const callbacks = [];
        const priorRegistration = vscodeMock.workspace.onDidChangeTextDocument;
        const priorEditor = vscodeMock.window.activeTextEditor;
        const context = { subscriptions: [] };
        const api = extension._internals;
        const rows = ['*KEYWORD', '*NODE', ...Array(10001).fill('       1             0.0             1.0         -2.5E-3       0       0'), '*END'];
        const document = fakeDoc(rows.join('\n'), '/live-block-event/model.k');
        document.version = 1;
        document.languageId = 'lsdyna';
        document.lineAt = line => ({ text: rows[line], range: new vscodeMock.Range(line, 0, line, rows[line].length) });
        document.getText = () => rows.join('\n');
        vscodeMock.workspace.onDidChangeTextDocument = callback => {
            callbacks.push(callback);
            return { dispose() {} };
        };
        vscodeMock.window.activeTextEditor = undefined;
        try {
            await extension.activate(context);
            api.setFileIndexForTesting(document.uri.fsPath, {
                keywordBlocks: [
                    { keyword: '*KEYWORD', startLine: 0, endLine: 0 },
                    { keyword: '*NODE', startLine: 1, endLine: rows.length - 2 },
                    { keyword: '*END', startLine: rows.length - 1, endLine: rows.length - 1 },
                ],
                referenceDefinitions: { curves: [{ id: 999 }] },
            });
            rows[6002] = rows[6002].slice(0, 7) + '2' + rows[6002].slice(8);
            document.version++;
            document.isDirty = true;
            const event = { document, contentChanges: [{ range: new vscodeMock.Range(6002, 7, 6002, 8), rangeLength: 1, text: '2' }] };
            for (const callback of callbacks) await callback(event);
            const current = api.getFileIndexForDocument(document);
            assert.ok(current, 'document listeners must preserve the structural index for a data-only edit');
            assert.equal(current.documentVersion, document.version);
            assert.equal(current.referenceDefinitions, undefined, 'derived definitions cannot survive the edit');
            const fields = api.getCardFieldsForLine(document, 9000);
            assert.deepEqual(fields.map(field => [field.n, field.p, field.w]), [
                ['NID', 0, 8], ['X', 8, 16], ['Y', 24, 16], ['Z', 40, 16], ['TC', 56, 8], ['RC', 64, 8],
            ]);
        } finally {
            api.setFileIndexForTesting(document.uri.fsPath, null);
            for (const disposable of context.subscriptions) await disposable?.dispose?.();
            vscodeMock.workspace.onDidChangeTextDocument = priorRegistration;
            vscodeMock.window.activeTextEditor = priorEditor;
        }
    });
});
