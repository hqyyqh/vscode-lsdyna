import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repository = path.resolve(__dirname, '../../..');

describe('manual reader build and package contract', () => {
    it('targets the approved VS Code and fixed Vite output', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8'));
        const vite = fs.readFileSync(path.join(repository, 'webview/manual-reader/vite.config.ts'), 'utf8');
        const transport = fs.readFileSync(path.join(repository, 'webview/manual-reader/src/transport.ts'), 'utf8');

        expect(pkg.engines.vscode).toBe('^1.100.0');
        expect(pkg.scripts['build:webview']).toBeDefined();
        expect(pkg.scripts['vscode:prepublish']).toContain('build:webview');
        expect(vite).toContain('out/webview/manual-reader');
        expect(vite).toContain('manifest');
        expect(pkg.dependencies['markdown-it']).toBeUndefined();
        expect(pkg.dependencies.katex).toBeUndefined();
        expect(pkg.devDependencies.katex).toBeDefined();
        // vscode-messenger-webview only declares acquireVsCodeApi; never construct Messenger bare.
        expect(transport).toContain('new Messenger(vscodeApi)');
        expect(transport).toContain('globalThis');
        expect(transport).toMatch(/acquireVsCodeApi/);
        expect(transport).toMatch(/acquireWebviewVsCodeApi/);
        expect(transport).not.toMatch(/new Messenger\(\s*\)\s*;/);
    });

    it('packages built assets and excludes webview sources, maps, tests, and docs', () => {
        const ignore = fs.readFileSync(path.join(repository, '.vscodeignore'), 'utf8');

        expect(ignore).toMatch(/^webview\/$/m);
        expect(ignore).toMatch(/^\*\*\/\*\.map$/m);
        expect(ignore).not.toMatch(/^out\/webview\/manual-reader/m);
        expect(ignore).toMatch(/^test$/m);
        expect(ignore).toMatch(/^docs$/m);
        expect(ignore).toMatch(/^tsconfig\.json$/m);
        expect(ignore).toMatch(/^DEVELOPMENT\.md$/m);
    });

    it('keeps responsive, high-contrast, reduced-motion, and local overflow reading contracts', () => {
        const css = fs.readFileSync(path.join(repository, 'webview/manual-reader/src/styles.css'), 'utf8');

        expect(css).toContain('--reader-toolbar-height');
        expect(css).toMatch(/scroll-margin-top:\s*calc\(var\(--reader-toolbar-height\)/);
        expect(css).toMatch(/\.reader-table-scroll[^}]*overflow-x:\s*auto/s);
        expect(css).toMatch(/\.reader-table-scroll:focus-visible/);
        expect(css).toMatch(/\.reader-table--prose/);
        expect(css).toMatch(/\.reader-table--grid/);
        expect(css).toMatch(/\.reader-table--default/);
        // Prose/default wrap in the content column; card grids keep max-content + sticky first column.
        expect(css).toMatch(/reader-table--grid[^{]*\{[^}]*width:\s*max-content/s);
        expect(css).toMatch(/reader-table--grid[^\n]*th:first-child[^}]*position:\s*sticky/s);
        // Variable column: 2× prior 12ch cap, content-sized; code stays single-line.
        expect(css).toMatch(/reader-table--prose\s+th:first-child[^}]*max-width:\s*24ch/s);
        expect(css).toMatch(/reader-table--prose\s+th:first-child[^}]*width:\s*max-content/s);
        expect(css).not.toMatch(/reader-table--prose\s+th:first-child[^}]*max-width:\s*12ch/s);
        expect(css).toMatch(/reader-table--prose\s+th:first-child\s+code[^}]*white-space:\s*nowrap/s);
        expect(css).toMatch(/\.markdown-body thead th[^}]*position:\s*sticky/s);
        expect(css).toMatch(/\.markdown-body (?:pre|code)[^}]*overflow/s);
        expect(css).toMatch(/@media\s*\(forced-colors:\s*active\)/);
        expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
        expect(css).toMatch(/prefers-reduced-motion[\s\S]*scroll-behavior:\s*auto/);
        expect(css).toMatch(/@media\s*\(max-width:\s*760px\)/);
        expect(css).toMatch(/@media\s*\(max-width:\s*480px\)/);
        expect(css).toMatch(/\.reader-search-input-wrap input\s*\{[^}]*padding-right:\s*84px/s);
        expect(css).toMatch(/\.reader-search-mode-toggle\s*\{[^}]*width:\s*76px/s);
        // Full-bleed reading column: track panel width (pad only, no 880px cap).
        expect(css).toContain('--reader-content-pad-inline');
        expect(css).not.toMatch(/--reader-content-width/);
        expect(css).not.toMatch(/880px/);
        expect(css).toMatch(/\.reader-content,\s*\.reader-footer\s*\{[^}]*max-width:\s*none/s);
        expect(css).toMatch(/\.reader-content,\s*\.reader-footer\s*\{[^}]*width:\s*100%/s);
        // Markdown body must follow VS Code tokens, not OS prefers-color-scheme alone.
        expect(css).toMatch(/\.markdown-body[^{]*\{[^}]*--fgColor-default:\s*var\(--vscode-editor-foreground\)/s);
        expect(css).toMatch(/\.markdown-body[^{]*\{[^}]*--bgColor-default:\s*transparent/s);
        expect(css).toMatch(/\.markdown-body[^{]*\{[^}]*--fgColor-accent:\s*var\(--vscode-textLink-foreground\)/s);
        expect(css).toMatch(/\.markdown-body[^{]*\{[^}]*--borderColor-default:\s*var\(--reader-border\)/s);
        expect(css).toMatch(/\.markdown-body[^{]*\{[^}]*--bgColor-muted:\s*var\(--vscode-textCodeBlock-background/s);
        // Back-to-top FAB centers the same icon size token as the toolbar.
        expect(css).toMatch(/\.reader-back-to-top[^{]*\{[^}]*display:\s*inline-flex/s);
        expect(css).toMatch(/\.reader-back-to-top\s+\.reader-toolbar__icon/);
    });

    it('uses medium stroke icons and an SVG back-to-top control (not Unicode arrows)', () => {
        const icons = fs.readFileSync(path.join(repository, 'webview/manual-reader/src/ToolbarIcons.tsx'), 'utf8');
        const app = fs.readFileSync(path.join(repository, 'webview/manual-reader/src/ReaderApp.tsx'), 'utf8');

        expect(icons).toMatch(/strokeWidth:\s*1\.5/);
        expect(icons).not.toMatch(/strokeWidth:\s*2\b/);
        expect(icons).toMatch(/function IconArrowUp/);
        expect(app).toMatch(/IconArrowUp/);
        expect(app).toMatch(/reader-back-to-top/);
        expect(app).not.toMatch(/reader-back-to-top[^>]*>\s*↑/);
    });

    it('keeps the final reader UX contract in production sources', () => {
        const readingPosition = fs.readFileSync(path.join(repository, 'webview/manual-reader/src/useReadingPosition.ts'), 'utf8');
        const toolbarHeight = fs.readFileSync(path.join(repository, 'webview/manual-reader/src/useToolbarHeight.ts'), 'utf8');
        const markdown = fs.readFileSync(path.join(repository, 'webview/manual-reader/src/MarkdownDocument.tsx'), 'utf8');
        const lightbox = fs.readFileSync(path.join(repository, 'webview/manual-reader/src/ImageLightbox.tsx'), 'utf8');
        const search = fs.readFileSync(path.join(repository, 'webview/manual-reader/src/SearchPopover.tsx'), 'utf8');
        const toolbar = fs.readFileSync(path.join(repository, 'webview/manual-reader/src/ReaderToolbar.tsx'), 'utf8');

        expect(readingPosition).toContain('scrollRatio');
        expect(readingPosition).toContain('IntersectionObserver');
        expect(toolbarHeight).toContain('ResizeObserver');
        expect(lightbox).toContain('reader-lightbox');
        expect(markdown).toContain('preview.pinned');
        expect(markdown).toContain('tabIndex={0}');
        expect(search).toContain('reader-search-popover');
        expect(toolbar).toContain('reader-progress');
    });
});
