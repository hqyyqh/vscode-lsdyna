'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('Keyword Manager visual contract', () => {
    it('uses theme surfaces, scrolling forms and native modal review', () => {
        const css = fs.readFileSync(path.join(__dirname,
            '../../webview/keyword-options/src/styles.css'), 'utf8');
        assert.match(css, /background:\s*var\(--vscode-editor-background\)/);
        assert.match(css, /font-family:\s*var\(--vscode-editor-font-family\)/);
        assert.match(css, /\.formScroll\s*\{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto/s);
        assert.match(css, /\.editorLayout\s*\{[^}]*overflow-x:\s*auto/s);
        assert.match(css, /\.cards\s*\{[^}]*min-width:\s*calc\(80ch\s*\+\s*32px\)/s);
        assert.match(css, /dialog::backdrop/);
        assert.match(css, /\.reviewBody\s*\{[^}]*overflow:\s*auto/s);
        assert.doesNotMatch(css, /min-width:\s*520px/);
        assert.match(css, /@media\s*\(max-width:\s*360px\)/);
        assert.doesNotMatch(css, /@media\s*\(max-width:\s*560px\)/);
    });
});
