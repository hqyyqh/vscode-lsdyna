import * as fs from 'node:fs';
import path from 'node:path';

test('preserves sidebar themes, readable scopes and keyboard focus', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf8');
    expect(css).toMatch(/body\s*\{[^}]*--vscode-sideBar-background[^}]*--vscode-foreground/s);
    expect(css).toMatch(/main\s*\{[^}]*padding:\s*0 8px 8px/s);
    expect(css).toMatch(/\.query-editor\s*\{[^}]*--vscode-sideBar-background[^}]*position:\s*sticky[^}]*top:\s*0/s);
    expect(css).toMatch(/\.query-tools\s*\{[^}]*flex-wrap:\s*wrap/s);
    expect(css).toMatch(/\.query-actions\s*\{[^}]*display:\s*flex/s);
    expect(css).toMatch(/\.result-field\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toContain('--vscode-contrastActiveBorder');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).not.toMatch(/border-left:\s*2px solid var\(--vscode-focusBorder\)/);
    expect(css).toMatch(/\.results h2 span\s*\{[^}]*font-size:\s*\.9em[^}]*font-weight:\s*normal/s);
    expect(css).toMatch(/\.result-main strong\s*\{[^}]*font-weight:\s*normal[^}]*line-height:\s*1\.35/s);
    expect(css).toMatch(/\.result-main small\s*\{[^}]*font-size:\s*\.9em[^}]*line-height:\s*1\.35/s);
    expect(css).not.toMatch(/--vscode-editor-(?:background|foreground)/);
    expect(css).not.toContain('.query-summary');
});
