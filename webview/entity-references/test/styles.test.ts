import * as fs from 'node:fs';
import path from 'node:path';

test('preserves sidebar themes, readable scopes and keyboard focus', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf8');
    expect(css).toMatch(/body\s*\{[^}]*--vscode-sideBar-background[^}]*--vscode-foreground/s);
    expect(css).toMatch(/main\s*\{[^}]*padding:\s*0 8px 8px/s);
    expect(css).toMatch(/\.query-editor\s*\{[^}]*--vscode-sideBar-background/s);
    expect(css).not.toMatch(/\.query-editor\s*\{[^}]*position:\s*sticky/s);
    expect(css).not.toMatch(/\.result-content\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).toContain('--vscode-scrollbarSlider-activeBackground');
    expect(css).toMatch(/\.target-compact-row\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(css).toMatch(/\.result-badge[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toContain('--vscode-contrastBorder');
    expect(css).not.toMatch(/animation\s*:/);
    expect(css).not.toMatch(/border-left:\s*2px solid var\(--vscode-focusBorder\)/);
    expect(css).toMatch(/\.count\s*\{[^}]*font-size:\s*\.9em[^}]*font-weight:\s*normal/s);
    expect(css).toMatch(/\.result-main\s*\{[^}]*display:\s*flex[^}]*line-height:\s*1\.4/s);
    expect(css).not.toMatch(/background-image|linear-gradient|radial-gradient/);
    expect(css).not.toMatch(/--vscode-editor-(?:background|foreground)/);
    expect(css).not.toContain('.query-summary');
});
