'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Keyword Manager visual contract', () => {
    it('uses theme surfaces, scrolling forms and inline change review', () => {
        const css = fs.readFileSync(path.join(__dirname,
            '../../webview/keyword-options/src/styles.css'), 'utf8');
        assert.match(css, /background:\s*var\(--vscode-editor-background\)/);
        assert.match(css, /font-family:\s*var\(--vscode-editor-font-family\)/);
        assert.match(css, /header\s*\{[^}]*flex-wrap:\s*wrap/s);
        assert.match(css, /\.formScroll\s*\{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto/s);
        assert.match(css, /\.editorLayout\s*\{[^}]*overflow-x:\s*auto/s);
        assert.match(css, /\.changePreview\s*\{/);
        assert.match(css, /\.detailsToolbar\s+\.toolbarTextAction\.primaryText\s*\{[^}]*var\(--vscode-button-background\)/s);
    });
});
