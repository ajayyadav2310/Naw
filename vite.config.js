import { defineConfig } from 'vite';

// Relative base so the bundle also works when served from Capacitor's local origin.
export default defineConfig({
  root: 'www',
  base: './',
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2020' }
});
