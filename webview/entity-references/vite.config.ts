import { codiconAssets } from '../shared/codiconAssets';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    root: __dirname,
    base: './',
    plugins: [react(), codiconAssets()],
    build: {
        outDir: path.resolve(__dirname, '../../out/webview/entity-references'),
        emptyOutDir: true,
        manifest: 'manifest.json',
        sourcemap: false,
        rollupOptions: { input: path.resolve(__dirname, 'index.html') },
    },
});
