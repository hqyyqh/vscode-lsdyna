import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    root: __dirname,
    plugins: [react()],
    build: {
        outDir: path.resolve(__dirname, '../../out/webview/manual-reader'),
        emptyOutDir: true,
        manifest: 'manifest.json',
        sourcemap: false,
        chunkSizeWarningLimit: 900,
        rollupOptions: { input: path.resolve(__dirname, 'index.html') },
    },
});
