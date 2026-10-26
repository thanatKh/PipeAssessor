import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { VitePWA } from 'vite-plugin-pwa';

// Static SPA served at the domain root on Render (build -> dist/). No framework plugin —
// this is Vanilla TS. jsPDF / jspdf-autotable / SheetJS(xlsx) are pulled in via dynamic
// import() at their call sites, so Rollup emits them as lazy chunks (not in the entry).
export default defineConfig({
  base: '/',
  plugins: [
    // Installable app + precached app shell, so the app opens on a phone with no signal (it then
    // shows the existing "check your connection" login state). Deliberately caches ONLY our own
    // build output: Supabase API/auth, R2 photos and Esri tiles always go to the network.
    // registerType 'prompt' (not autoUpdate): an automatic reload on deploy would wipe a
    // half-entered finding — main.ts shows a "Reload" toast instead (see onNeedRefresh).
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['RGB_OR_Full color.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Pipe Assessor – Findings Tracker',
        short_name: 'Pipe Assessor',
        description: 'Piping abnormal-findings tracker with ASME B31.3 wall-thickness assessment.',
        start_url: '/#/list',
        scope: '/',
        display: 'standalone',
        background_color: '#f8fafc',
        theme_color: '#ffffff',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Lazy chunks (jspdf/xlsx/exifr) and the Sarabun PDF fonts are included so Export/Import
        // still work from cache; xlsx alone is ~500 kB, hence the raised per-file ceiling. Legacy
        // .woff duplicates are skipped — every service-worker-capable browser takes .woff2.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2,ttf}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
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
