import { defineConfig } from 'vite';

// Static SPA served at the domain root on Render (build -> dist/). No framework plugin —
// this is Vanilla TS. jsPDF / jspdf-autotable / SheetJS(xlsx) are pulled in via dynamic
// import() at their call sites, so Rollup emits them as lazy chunks (not in the entry).
export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
