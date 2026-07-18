/* ============================================================================
   Entry point. Loads styles (in the documented cascade order: Basecoat first,
   then theme, then page CSS), the Leaflet CSS, and Basecoat's component
   behaviors; injects the Google Sans @font-face; then boots the app.
   ============================================================================ */
import 'basecoat-css';                 // Basecoat component CSS — first (brand tokens map onto it)
import 'leaflet/dist/leaflet.css';     // map CSS
import './styles/theme.css';           // design system (after Basecoat, per theme.css header)
import './styles/app.css';             // page-specific components (last)
import 'basecoat-css/basecoat.min';    // Basecoat component behaviors (was the CDN defer <script>)

import { registerGoogleSansWebFont } from './engine/fonts';
import { initApp } from './app';

registerGoogleSansWebFont();
document.addEventListener('DOMContentLoaded', initApp);
