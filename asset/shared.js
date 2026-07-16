/* ============================================================================
   Pipe Assessor — shared JS utilities (classic script, no build step).
   Loaded by BOTH index.html and findings.html with a plain non-defer
   <script> tag in <head>: each page's inline script references these
   globals at parse time, so this file must be fully evaluated first.
   Keep this file dependency-free (no Basecoat/Leaflet/Supabase access).
   ============================================================================ */

/* ---------------- Supabase project (Singapore) ---------------- */

/* Publishable key — safe to commit: Row Level Security only grants access to signed-in
   users (see db/schema.sql). Single source for both the tracker page and the calculator's
   finding-link mode. */
const PA_SUPABASE_URL = 'https://uuwcftjduphtngmhwvrb.supabase.co';
const PA_SUPABASE_KEY = 'sb_publishable_-wA0hWoW-SIOpdlSpNrXkw_-YsUQYMH';

/* ---------------- dd/Mmm/yyyy — the one date format used everywhere ---------------- */

const PA_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Accepts a Date, an ISO date/timestamp string, or null; returns the display dash for
   anything unparseable so callers never print "Invalid Date". */
function paFmtDate(v) {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return '—';
  return `${String(d.getDate()).padStart(2, '0')}/${PA_MONTHS[d.getMonth()]}/${d.getFullYear()}`;
}

/* ---------------- photo downscale ---------------- */

/* Mandatory before any photo is stored or embedded (PDF, Supabase upload) — raw phone
   photos are 3–12 MP. Resolves a JPEG dataURL. */
function downscaleImage(fileOrBlob, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (e) { reject(e); }
      finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

/* ---------------- theme ---------------- */

const PA_ICON_SUN = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
const PA_ICON_MOON = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

/* Restore the saved theme (falling back to the OS preference on first visit).
   Adds/removes `dark` on BOTH <body> (app tokens) and <html> (Basecoat's component
   styles are gated on html.dark) — see the alias-block comment in theme.css. */
function paApplyStoredTheme() {
  const saved = localStorage.getItem('theme');
  const dark = saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('dark', dark);
}

/* Wire a .theme-btn: toggles both dark classes, persists to localStorage, repaints the
   icon. Returns the repaint function so callers can re-sync the icon after restoring a
   theme themselves (e.g. in initApp). */
function paWireThemeToggle(btn, onAfterToggle) {
  const paint = () => {
    btn.innerHTML = document.body.classList.contains('dark') ? PA_ICON_SUN : PA_ICON_MOON;
  };
  btn.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    const isDark = document.body.classList.contains('dark');
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    paint();
    if (onAfterToggle) onAfterToggle(isDark);
  });
  paint();
  return paint;
}
