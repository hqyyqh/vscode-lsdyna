'use strict';

const assert = require('assert');
const {
    REQUIRED_FILES,
    validatePackageFiles,
} = require('../../scripts/validate-package-contents.cjs');

describe('VSIX content contract', () => {
    function completeFiles() {
        return [
            ...REQUIRED_FILES,
            'out/webview/manual-reader/assets/index.js',
            'out/webview/manual-reader/assets/index.css',
        ];
    }

    it('accepts required runtime files without authoring sources', () => {
        assert.deepEqual(validatePackageFiles(completeFiles()), []);
    });

    it('rejects the full Chinese source and process documents', () => {
        const errors = validatePackageFiles([
            ...completeFiles(),
            'keywords/field_data_zh.json',
            'docs/plans/release.md',
        ]);
        assert.deepEqual(errors, [
            'VSIX contains forbidden authoring/process file: docs/plans/release.md',
            'VSIX contains forbidden authoring/process file: keywords/field_data_zh.json',
        ]);
    });
});
