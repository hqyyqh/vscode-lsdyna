import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export function codiconAssets(icons: readonly string[] = []): Plugin {
    const root = path.resolve(__dirname, '../../node_modules/@vscode/codicons');
    return {
        name: 'codicon-assets',
        generateBundle() {
            this.emitFile({ type: 'asset', fileName: 'codicons-LICENSE.txt',
                source: 'Codicons by Microsoft. https://github.com/microsoft/vscode-codicons\nLicensed under CC BY 4.0.\n\n' + fs.readFileSync(path.join(root, 'LICENSE'), 'utf8') });
            for (const icon of icons) this.emitFile({ type: 'asset', fileName: `icons/${icon}.svg`,
                source: fs.readFileSync(path.join(root, 'src/icons', `${icon}.svg`)) });
        },
    };
}
