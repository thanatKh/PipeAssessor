/* ============================================================================
   Entry point. Loads styles (in the documented cascade order: Basecoat first,
   then theme, then page CSS), the Leaflet CSS, and Basecoat's component
   behaviors; injects the Google Sans @font-face; then boots the app.
   ============================================================================ */
// Every CSS file basecoat-css exposes through its package "exports" map (the "." default, "vega",
// "components", etc.) is raw Tailwind @layer/@apply source meant for a Tailwind build step — it
// renders with zero .btn/.dialog/etc. styling under a plain bundler. The one fully pre-compiled,
// self-contained stylesheet (basecoat.cdn.min.css — what the original CDN <link> tag used) isn't
// listed in "exports", so esbuild/Rollup refuse a plain package-subpath import; aliased to its
// real on-disk path in vite.config.ts instead.
import 'basecoat-css/cdn.css';
import 'leaflet/dist/leaflet.css';     // map CSS
import './styles/theme.css';           // design system (after Basecoat, per theme.css header)
import './styles/app.css';             // page-specific components (last)
import 'basecoat-css/basecoat.min';    // Basecoat component behaviors (was the CDN defer <script>)

import { registerGoogleSansWebFont } from './engine/fonts';
import { initApp } from './app';

registerGoogleSansWebFont();
document.addEventListener('DOMContentLoaded', initApp);
