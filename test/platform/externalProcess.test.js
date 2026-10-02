'use strict';

const assert = require('assert');

describe('external process safety', () => {
    it('passes hostile Unicode Windows paths as opaque spawn arguments', () => {
        const { openPdfWithSumatra } = require('../../out/platform/externalProcess');
        const executable = 'C:\\手册 (2026) & data\\SumatraPDF.exe';
        const pdfPath = 'C:\\模型 100%!\\manual.pdf';
        let call;
        let unrefCalled = false;
        const child = { on() {}, unref() { unrefCalled = true; } };

        openPdfWithSumatra(executable, pdfPath, 12, () => {}, (exe, args, options) => {
            call = { exe, args, options };
            return child;
        });

        assert.deepStrictEqual(call, {
            exe: executable,
            args: ['-reuse-instance', '-page', '12', pdfPath],
            options: {
                shell: false,
                detached: true,
                stdio: 'ignore',
                windowsHide: false,
            },
        });
        assert.equal(unrefCalled, true);
    });

    it('invokes fallback at most once for asynchronous launch errors', () => {
        const { openPdfWithSumatra } = require('../../out/platform/externalProcess');
        let errorHandler;
        let fallbackCount = 0;
        const child = {
            on(event, handler) { if (event === 'error') errorHandler = handler; },
            unref() {},
        };

        openPdfWithSumatra('SumatraPDF.exe', 'manual.pdf', undefined, () => fallbackCount++, () => child);
        errorHandler(new Error('failed'));
        errorHandler(new Error('failed again'));

        assert.equal(fallbackCount, 1);
    });
});
