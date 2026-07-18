import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Static SPA served at the domain root on Render (build -> dist/). No framework plugin —
// this is Vanilla TS. jsPDF / jspdf-autotable / SheetJS(xlsx) are pulled in via dynamic
// import() at their call sites, so Rollup emits them as lazy chunks (not in the entry).
export default defineConfig({
  base: '/',
  resolve: {
    alias: {
      // basecoat-css's package "exports" map only lists Tailwind @layer/@apply source files
      // (its "." default, "vega", "components", ...) — none of them are browser-ready without a
      // Tailwind build step, and esbuild enforces "exports" strictly so a plain package-subpath
      // import can never reach the one file that IS pre-compiled: basecoat.cdn.min.css (what the
      // app's original CDN <link> tag used). Alias around "exports" to its real on-disk path.
      'basecoat-css/cdn.css': fileURLToPath(new URL('./node_modules/basecoat-css/dist/basecoat.cdn.min.css', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
