import { defineConfig } from 'vite';

// Relative base, so a build works wherever it is served from: the repo root
// on GitHub Pages (/threegrease/), a custom domain, or a dist/ folder opened
// straight off disk. Hardcoding '/threegrease/' would break the moment the
// repo is renamed or a domain is attached.
//
// NB the bundler stays Vite rather than bare esbuild: Vite already uses
// esbuild for the TypeScript transform, and it additionally resolves
// `new Worker(new URL('./x.worker.ts', import.meta.url))` (solvers/stringart,
// solvers/wireart) and processes index.html + styles.css. Bare esbuild does
// neither, so swapping it in would silently drop the solver workers.
export default defineConfig({
  base: './',
  server: { port: 5199 },
  build: {
    outDir: 'dist',
    // the three.js + Spark + mediapipe bundle is legitimately large; the
    // warning is noise rather than a signal here
    chunkSizeWarningLimit: 8000,
  },
});
