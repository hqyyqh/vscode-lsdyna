'use strict';

const assert = require('assert');
const vscode = require("../../support/vscode-mock");

describe('LS-DYNA formatting registration boundary', () => {
    it('registers neither a document formatter nor a range formatter', async () => {
        const documentCount = vscode.languages._documentFormattingRegistrations.length;
        const rangeCount = vscode.languages._documentRangeFormattingRegistrations.length;
        const extension = require('../../../src/extension');

        await extension.activate({ subscriptions: [] });

        assert.equal(vscode.languages._documentFormattingRegistrations.length, documentCount);
        assert.equal(vscode.languages._documentRangeFormattingRegistrations.length, rangeCount);
        assert.equal(
            Object.prototype.hasOwnProperty.call(
                extension._internals,
                'LsdynaDocumentFormattingEditProvider',
            ),
            false,
        );
    });
});
