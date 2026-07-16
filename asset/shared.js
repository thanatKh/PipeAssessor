/* ============================================================================
   Pipe Assessor — shared JS utilities (classic script, no build step).
   Loaded by BOTH index.html (dashboard) and calculator.html with a plain non-defer
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

/* ============================================================================
   ASME B31.3 assessment engine — data tables + pure compute function.
   The SINGLE source of the pipe wall-thickness math, shared by calculator.html
   (full workbench: diagrams/equations/PDF) and index.html's inline finding
   assessment. Keep it DOM-free and side-effect-free — validation returns an
   `errors` map the caller maps onto its own UI. Renaming/moving safety-relevant
   calc code is high-risk: any change here must pass the numeric-identity
   regression (compute-parity.js) before shipping.
   ============================================================================ */

const PA_PIPE_DATABASE = {
  '1/2"': {
    od: 21.34,
    schedules: {
      '40': { t: 2.77, label: 'Sch 40 (STD)' },
      '80': { t: 3.73, label: 'Sch 80 (XS)' },
      '160': { t: 4.78, label: 'Sch 160' },
      'XXS': { t: 7.47, label: 'Sch XXS' }
    }
  },
  '3/4"': {
    od: 26.67,
    schedules: {
      '40': { t: 2.87, label: 'Sch 40 (STD)' },
      '80': { t: 3.91, label: 'Sch 80 (XS)' },
      '160': { t: 5.56, label: 'Sch 160' },
      'XXS': { t: 7.82, label: 'Sch XXS' }
    }
  },
  '1"': {
    od: 33.40,
    schedules: {
      '40': { t: 3.38, label: 'Sch 40 (STD)' },
      '80': { t: 4.55, label: 'Sch 80 (XS)' },
      '160': { t: 6.35, label: 'Sch 160' },
      'XXS': { t: 9.09, label: 'Sch XXS' }
    }
  },
  '1-1/4"': {
    od: 42.16,
    schedules: {
      '40': { t: 3.56, label: 'Sch 40 (STD)' },
      '80': { t: 4.85, label: 'Sch 80 (XS)' },
      '160': { t: 6.35, label: 'Sch 160' },
      'XXS': { t: 9.70, label: 'Sch XXS' }
    }
  },
  '1-1/2"': {
    od: 48.26,
    schedules: {
      '40': { t: 3.68, label: 'Sch 40 (STD)' },
      '80': { t: 5.08, label: 'Sch 80 (XS)' },
      '160': { t: 7.14, label: 'Sch 160' },
      'XXS': { t: 10.15, label: 'Sch XXS' }
    }
  },
  '2"': {
    od: 60.33,
    schedules: {
      '10': { t: 2.77, label: 'Sch 10' },
      '40': { t: 3.91, label: 'Sch 40 (STD)' },
      '80': { t: 5.54, label: 'Sch 80 (XS)' },
      '160': { t: 8.74, label: 'Sch 160' },
      'XXS': { t: 11.07, label: 'Sch XXS' }
    }
  },
  '2-1/2"': {
    od: 73.03,
    schedules: {
      '10': { t: 3.05, label: 'Sch 10' },
      '40': { t: 5.16, label: 'Sch 40 (STD)' },
      '80': { t: 7.01, label: 'Sch 80 (XS)' },
      '160': { t: 9.53, label: 'Sch 160' },
      'XXS': { t: 14.02, label: 'Sch XXS' }
    }
  },
  '3"': {
    od: 88.90,
    schedules: {
      '10': { t: 3.05, label: 'Sch 10' },
      '40': { t: 5.49, label: 'Sch 40 (STD)' },
      '80': { t: 8.08, label: 'Sch 80 (XS)' },
      '160': { t: 11.13, label: 'Sch 160' },
      'XXS': { t: 15.24, label: 'Sch XXS' }
    }
  },
  '4"': {
    od: 114.30,
    schedules: {
      '10': { t: 3.05, label: 'Sch 10' },
      '40': { t: 6.02, label: 'Sch 40 (STD)' },
      '80': { t: 8.56, label: 'Sch 80 (XS)' },
      '120': { t: 11.13, label: 'Sch 120' },
      '160': { t: 13.49, label: 'Sch 160' },
      'XXS': { t: 17.12, label: 'Sch XXS' }
    }
  },
  '6"': {
    od: 168.28,
    schedules: {
      '10': { t: 3.40, label: 'Sch 10' },
      '40': { t: 7.11, label: 'Sch 40 (STD)' },
      '80': { t: 10.97, label: 'Sch 80 (XS)' },
      '120': { t: 14.27, label: 'Sch 120' },
      '160': { t: 18.26, label: 'Sch 160' },
      'XXS': { t: 21.95, label: 'Sch XXS' }
    }
  },
  '8"': {
    od: 219.08,
    schedules: {
      '10': { t: 3.76, label: 'Sch 10' },
      '20': { t: 6.35, label: 'Sch 20' },
      '30': { t: 7.04, label: 'Sch 30' },
      '40': { t: 8.18, label: 'Sch 40 (STD)' },
      '60': { t: 10.31, label: 'Sch 60' },
      '80': { t: 12.70, label: 'Sch 80 (XS)' },
      '100': { t: 15.09, label: 'Sch 100' },
      '120': { t: 18.26, label: 'Sch 120' },
      '140': { t: 20.62, label: 'Sch 140' },
      '160': { t: 23.01, label: 'Sch 160' },
      'XXS': { t: 22.23, label: 'Sch XXS' }
    }
  },
  '10"': {
    od: 273.05,
    schedules: {
      '10': { t: 4.19, label: 'Sch 10' },
      '20': { t: 6.35, label: 'Sch 20' },
      '30': { t: 7.80, label: 'Sch 30' },
      '40': { t: 9.27, label: 'Sch 40 (STD)' },
      '60': { t: 12.70, label: 'Sch 60 (XS)' },
      '80': { t: 15.09, label: 'Sch 80' },
      '100': { t: 18.26, label: 'Sch 100' },
      '120': { t: 21.44, label: 'Sch 120' },
      '140': { t: 25.40, label: 'Sch 140' },
      '160': { t: 28.58, label: 'Sch 160' }
    }
  },
  '12"': {
    od: 323.85,
    schedules: {
      '10': { t: 4.57, label: 'Sch 10' },
      '20': { t: 6.35, label: 'Sch 20' },
      '30': { t: 8.38, label: 'Sch 30' },
      '40': { t: 10.31, label: 'Sch 40 (STD)' },
      '60': { t: 14.27, label: 'Sch 60' },
      '80': { t: 17.48, label: 'Sch 80 (XS)' },
      '100': { t: 21.44, label: 'Sch 100' },
      '120': { t: 25.40, label: 'Sch 120' },
      '140': { t: 28.58, label: 'Sch 140' },
      '160': { t: 33.32, label: 'Sch 160' }
    }
  },
  '14"': {
    od: 355.60,
    schedules: {
      '10': { t: 6.35, label: 'Sch 10' },
      '20': { t: 7.92, label: 'Sch 20' },
      '30': { t: 9.53, label: 'Sch 30 (STD/XS)' },
      '40': { t: 11.13, label: 'Sch 40' },
      '60': { t: 15.09, label: 'Sch 60' },
      '80': { t: 19.05, label: 'Sch 80' },
      '100': { t: 23.83, label: 'Sch 100' },
      '120': { t: 27.79, label: 'Sch 120' },
      '140': { t: 31.75, label: 'Sch 140' },
      '160': { t: 35.71, label: 'Sch 160' }
    }
  },
  '16"': {
    od: 406.40,
    schedules: {
      '10': { t: 6.35, label: 'Sch 10' },
      '20': { t: 7.92, label: 'Sch 20' },
      '30': { t: 9.53, label: 'Sch 30 (STD)' },
      '40': { t: 12.70, label: 'Sch 40 (XS)' },
      '60': { t: 16.66, label: 'Sch 60' },
      '80': { t: 21.44, label: 'Sch 80' },
      '100': { t: 26.19, label: 'Sch 100' },
      '120': { t: 30.96, label: 'Sch 120' },
      '140': { t: 36.53, label: 'Sch 140' },
      '160': { t: 40.49, label: 'Sch 160' }
    }
  },
  '18"': {
    od: 457.20,
    schedules: {
      '10': { t: 6.35, label: 'Sch 10' },
      '20': { t: 7.92, label: 'Sch 20' },
      '30': { t: 11.13, label: 'Sch 30 (STD)' },
      '40': { t: 14.27, label: 'Sch 40 (XS)' },
      '60': { t: 19.05, label: 'Sch 60' },
      '80': { t: 23.83, label: 'Sch 80' },
      '100': { t: 29.36, label: 'Sch 100' },
      '120': { t: 34.93, label: 'Sch 120' },
      '140': { t: 39.67, label: 'Sch 140' },
      '160': { t: 45.24, label: 'Sch 160' }
    }
  },
  '20"': {
    od: 508.00,
    schedules: {
      '10': { t: 6.35, label: 'Sch 10' },
      '20': { t: 9.53, label: 'Sch 20 (STD)' },
      '30': { t: 12.70, label: 'Sch 30 (XS)' },
      '40': { t: 15.09, label: 'Sch 40' },
      '60': { t: 20.62, label: 'Sch 60' },
      '80': { t: 26.19, label: 'Sch 80' },
      '100': { t: 32.54, label: 'Sch 100' },
      '120': { t: 38.10, label: 'Sch 120' },
      '140': { t: 44.45, label: 'Sch 140' },
      '160': { t: 50.01, label: 'Sch 160' }
    }
  },
  '24"': {
    od: 609.60,
    schedules: {
      '10': { t: 6.35, label: 'Sch 10' },
      '20': { t: 9.53, label: 'Sch 20 (STD)' },
      '30': { t: 14.27, label: 'Sch 30 (XS)' },
      '40': { t: 17.48, label: 'Sch 40' },
      '60': { t: 24.61, label: 'Sch 60' },
      '80': { t: 30.96, label: 'Sch 80' },
      '100': { t: 38.89, label: 'Sch 100' },
      '120': { t: 46.02, label: 'Sch 120' },
      '140': { t: 52.37, label: 'Sch 140' },
      '160': { t: 59.54, label: 'Sch 160' }
    }
  }
};

const PA_MATERIALS = [
  { name: 'Carbon Steel: ASTM A106 Gr. B / A53 Gr. B', stress: 137.9, code: 'A106B' },
  { name: 'Carbon Steel: API 5L Gr. B', stress: 137.9, code: 'API5LB' },
  { name: 'High Yield Carbon Steel: API 5L X42', stress: 144.8, code: 'X42' },
  { name: 'High Yield Carbon Steel: API 5L X52', stress: 179.3, code: 'X52' },
  { name: 'High Yield Carbon Steel: API 5L X60', stress: 206.8, code: 'X60' },
  { name: 'Stainless Steel: ASTM A312 TP304', stress: 137.9, code: 'TP304' },
  { name: 'Stainless Steel: ASTM A312 TP316', stress: 137.9, code: 'TP316' },
  { name: 'Manual Input (Specify below)', stress: null, code: 'MANUAL' }
];

/* API 574 Default Minimum Structural Thickness for Carbon/Low-Alloy Steel */
function paGetApi574Min(nps) {
  const map = {
    '1/2"': 1.8,
    '3/4"': 1.8,
    '1"': 1.8,
    '1-1/4"': 1.8,
    '1-1/2"': 1.8,
    '2"': 1.8,
    '2-1/2"': 1.8,
    '3"': 2.0,
    '4"': 2.3,
    '6"': 2.8,
    '8"': 2.8,
    '10"': 2.8,
    '12"': 2.8,
    '14"': 2.8,
    '16"': 2.8,
    '18"': 2.8,
    '20"': 3.1,
    '24"': 3.1
  };
  return map[nps] || 3.1;
}

/* Field convention: Sch 80 for small-bore (<=1-1/2"), Sch 40 for 2" NPS and above */
function paDefaultScheduleForNps(nps) {
  const smallBore = ['1/2"', '3/4"', '1"', '1-1/4"', '1-1/2"'];
  return smallBore.includes(nps) ? '80' : '40';
}

/* Numeric display: fixed decimals, em-dash for null/non-finite (mirrors the page `fmt`). */
function paFmt(val, decimals) {
  if (decimals == null) decimals = 2;
  return (val !== null && isFinite(val)) ? Number(val).toFixed(decimals) : '\u2014';
}

/* Pure ASME B31.3 assessment.
   Input p (all tolerant of string/number):
     nps, sch            keys into PA_PIPE_DATABASE
     overrideTnom        number or ''/null — if > 0 replaces the schedule wall thickness
     overrideOd          number or ''/null — if > 0 replaces the table OD
     mode                'depth' | 'tmeas'
     depth, tmeas        mm (the one matching mode is used)
     ca, pInput          mm, pressure (in pUnit)
     pUnit               'bar' | 'psi'
     S, E, W, Y, CR      allowable stress (MPa), joint/weld/coeff factors, corrosion rate
     matCode             material code (drives the CS-reference caveat)
     isInternal          bool (carried through for the caller's UI; no effect on math)
   Returns:
     { errors: {field: true | message}, ... }  — non-empty errors => invalid, result fields absent
     otherwise the full result object (same field names the calculator page has always used),
     with hasErrors:false and errors:{}.
   Validation field keys: overrideTnom, overrideOd, P, S, depth, tmeas, ca. */
function computeB313(p) {
  const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? (d == null ? NaN : d) : n; };
  const errors = {};

  const pipe = PA_PIPE_DATABASE[p.nps];
  if (!pipe) return { hasErrors: true, errors: { nps: 'Unknown pipe size.' } };
  const schObj = pipe.schedules[p.sch];
  if (!schObj) return { hasErrors: true, errors: { sch: 'Unknown schedule for this size.' } };

  // OD (optional as-found override)
  let D = pipe.od;
  const ovrOdOn = p.overrideOd !== '' && p.overrideOd != null;
  if (ovrOdOn) {
    const customD = parseFloat(p.overrideOd);
    if (!isNaN(customD) && customD > 0) D = customD;
    else errors.overrideOd = true;
  }

  // Nominal wall thickness (optional override)
  let t_nom = schObj.t;
  const ovrTOn = p.overrideTnom !== '' && p.overrideTnom != null;
  if (ovrTOn) {
    const customT = parseFloat(p.overrideTnom);
    if (!isNaN(customT) && customT > 0) t_nom = customT;
    else errors.overrideTnom = true;
  }

  const mode = p.mode === 'tmeas' ? 'tmeas' : 'depth';
  let t_meas = 0, depth = 0;
  if (mode === 'depth') {
    depth = num(p.depth, 0);
    t_meas = Math.max(0, t_nom - depth);
  } else {
    t_meas = num(p.tmeas, 0);
    depth = Math.max(0, t_nom - t_meas);
  }

  const ca = num(p.ca, 0);
  const P_input = num(p.pInput, 0);
  const pUnit = p.pUnit === 'psi' ? 'psi' : 'bar';
  const P = (pUnit === 'bar') ? P_input * 0.1 : P_input * 0.006894757;

  const S = num(p.S, 0);
  const E = num(p.E, 1);
  const W = num(p.W, 1);
  const Y = num(p.Y, 0.4);
  const CR = num(p.CR, 0);

  if (P_input <= 0) errors.P = true;
  if (S <= 0) errors.S = true;
  if (mode === 'depth' && depth > t_nom) errors.depth = true;
  if (mode === 'tmeas' && t_meas > t_nom) errors.tmeas = true;
  if (ca < 0) errors.ca = 'CA cannot be negative.';
  else if (ca >= t_meas) errors.ca = 'CA cannot exceed remaining measured wall thickness.';

  if (Object.keys(errors).length) return { hasErrors: true, errors };

  // ASME B31.3 Para. 304.1.2 required thickness: t = (P*D) / (2*(S*E*W + P*Y))
  const denom = 2 * (S * E * W + P * Y);
  const t_req_noCA = denom > 0 ? (P * D) / denom : 0;
  const t_req_total = t_req_noCA + ca;
  const margin = t_meas - t_req_total;
  const pctRemainNom = (t_meas / t_nom) * 100;

  // MAWP: P = (2*S*E*W*t) / (D - 2*Y*t)
  function computeMAWP(t_use) {
    if (t_use <= 0) return 0;
    const denomM = D - (2 * Y * t_use);
    if (denomM <= 0) return 0;
    const P_mpa = (2 * S * E * W * t_use) / denomM;
    return (pUnit === 'bar') ? P_mpa / 0.1 : P_mpa / 0.006894757;
  }
  const mawp_with = computeMAWP(Math.max(0, t_meas - ca));
  const mawp_no = computeMAWP(t_meas);

  const t_struct = paGetApi574Min(p.nps);
  const matCode = p.matCode;
  const isCsRef = (matCode === 'TP304' || matCode === 'TP316' || matCode === 'MANUAL');

  let status = 'OK';
  let desc = 'Pipe meets allowable pressure limits with sufficient design margin.';
  let structRefWarning = false;

  if (margin < 0) {
    status = 'REPAIR';
    desc = 'CRITICAL: Remaining wall thickness is below minimum required design limit (including Corrosion Allowance). Immediately plan repair or spool replacement.';
  } else if (t_meas < t_struct) {
    status = 'MONITOR';
    desc = 'WARNING: Remaining wall thickness (' + paFmt(t_meas) + ' mm) is below API 574 minimum structural threshold (' + paFmt(t_struct) + ' mm). Pipeline is at risk of sag or collapse under structural loads.';
    if (isCsRef) structRefWarning = true;
  } else if (margin < 0.1 * t_req_total || pctRemainNom < 50) {
    status = 'MONITOR';
    desc = 'WARNING: Wall thickness is approaching design limits (remaining margin is less than 10% of required limit, or pipe has lost over 50% of its nominal thickness). Increase inspection frequency.';
  }
  if (structRefWarning) {
    desc += ' NOTE: The API 574 structural minimum used above is a carbon/low-alloy steel reference table; it has not been validated for the selected material and may not be an appropriate structural floor for this pipe.';
  }

  let remainingLife = null;
  if (CR > 0) remainingLife = (t_meas - t_req_total) / CR;

  return {
    hasErrors: false, errors: {},
    t_nom, t_meas, depth, D,
    t_req_noCA, t_req_total, t_struct, isCsRef,
    margin, pctRemainNom, mawp_with, mawp_no,
    status, desc, remainingLife,
    ca, CR, P_input, pUnit, isInternal: !!p.isInternal,
    S, E, W, Y, P
  };
}


/* ---------------- embedded OR logo (full-color, base64) ----------------
   Used by BOTH pages' PDF reports so the logo embeds even offline (a plain <img src>/fetch
   of asset/RGB_OR_Full color.png can't be read into a canvas/PDF on file://). Regenerate from
   asset/RGB_OR_Full color.png downscaled to ~600px if the brand asset changes. */
const OR_LOGO_DATAURL = 'data:image/png;base64,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';
