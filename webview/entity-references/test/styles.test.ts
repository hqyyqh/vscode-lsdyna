import * as fs from 'node:fs';
import path from 'node:path';

test('preserves sidebar themes, readable scopes and keyboard focus', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf8');
    expect(css).toMatch(/body\s*\{[^}]*--vscode-sideBar-background[^}]*--vscode-foreground/s);
    expect(css).toMatch(/\.query-editor\s*\{[^}]*--vscode-sideBar-background/s);
    expect(css).not.toMatch(/\.query-editor\s*\{[^}]*position:\s*sticky/s);
    expect(css).not.toMatch(/\.result-content\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toContain('--vscode-scrollbarSlider-activeBackground');
    expect(css).toMatch(/\.target-compact-row\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(css).toMatch(/\.result-badge[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toContain('--vscode-contrastBorder');
    expect(css).not.toMatch(/animation\s*:/);
    expect(css).not.toMatch(/border-left:\s*2px solid var\(--vscode-focusBorder\)/);
    expect(css).not.toMatch(/--vscode-editor-(?:background|foreground)/);
});
