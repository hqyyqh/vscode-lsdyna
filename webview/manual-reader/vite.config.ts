import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    root: __dirname,
    base: './',
    plugins: [react()],
    build: {
        outDir: path.resolve(__dirname, '../../out/webview/manual-reader'),
        emptyOutDir: true,
        manifest: 'manifest.json',
        sourcemap: false,
        // Webview CSP permits packaged fonts, not data: fonts. Relative URLs also
        // keep stylesheet font requests inside the extension's resource origin.
        assetsInlineLimit: 0,
        chunkSizeWarningLimit: 900,
        rollupOptions: { input: path.resolve(__dirname, 'index.html') },
    },
});
