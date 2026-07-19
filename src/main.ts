/* ============================================================================
   Entry point. Loads styles (in the documented cascade order: Basecoat first,
   then theme, then page CSS), the Leaflet CSS, and Basecoat's component
   behaviors; injects the Google Sans @font-face + the Thai companion webfont;
   then boots the app.
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
import 'basecoat-css/toast';           // Toaster component JS (registers on window.basecoat — must load after basecoat.min)

// Noto Sans Thai — Google Sans's embedded TTFs have no Thai glyphs (documented, intentional), so
// Thai text was silently falling through to whichever generic Thai font the OS happens to pick
// (inconsistent-looking next to Google Sans). Each @font-face here is unicode-range-scoped to the
// Thai block, so it only ever supplies the codepoints Google Sans is missing — Latin/numeric text
// is completely unaffected. Weights mirror the existing Google Sans mapping (400/500 -> Regular,
// 600/700 -> Bold) so weight jumps look consistent across scripts.
import '@fontsource/noto-sans-thai/400.css';
import '@fontsource/noto-sans-thai/500.css';
import '@fontsource/noto-sans-thai/600.css';
import '@fontsource/noto-sans-thai/700.css';

import { registerGoogleSansWebFont } from './engine/fonts';
import { initApp } from './app';

registerGoogleSansWebFont();
document.addEventListener('DOMContentLoaded', initApp);
