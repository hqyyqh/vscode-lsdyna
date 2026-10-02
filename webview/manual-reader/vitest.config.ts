import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
    root: __dirname,
    plugins: [react()],
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: [path.resolve(__dirname, 'test/setup.ts')],
        restoreMocks: true,
    },
});
