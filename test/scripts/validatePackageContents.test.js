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

    it('rejects authoring sources, process documents, and local caches', () => {
        const errors = validatePackageFiles([
            ...completeFiles(),
            '.artifacts/push-preparation/plan.md',
            '.pytest_cache/v/cache/nodeids',
            '.uv-cache/CACHEDIR.TAG',
            'dist/dynasense.vsix',
            'keywords/field_data_zh.json',
            'docs/plans/release.md',
            'keywords/tests/__pycache__/test_schema.pyc',
        ]);
        assert.deepEqual(errors, [
            'VSIX contains forbidden authoring/process file: .artifacts/push-preparation/plan.md',
            'VSIX contains forbidden authoring/process file: .pytest_cache/v/cache/nodeids',
            'VSIX contains forbidden authoring/process file: .uv-cache/CACHEDIR.TAG',
            'VSIX contains forbidden authoring/process file: dist/dynasense.vsix',
            'VSIX contains forbidden authoring/process file: docs/plans/release.md',
            'VSIX contains forbidden authoring/process file: keywords/field_data_zh.json',
            'VSIX contains forbidden authoring/process file: keywords/tests/__pycache__/test_schema.pyc',
        ]);
    });
});
