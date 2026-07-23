/* ============================================================================
   Domain configuration constants (finding types, statuses, status colors/metadata,
   default map view, satellite tiles). Immutable — the single source shared by the
   dashboard, form, detail, and PDF surfaces. Extracted from the app monolith.
   ============================================================================ */

// Photo storage lives on Cloudflare R2, not Supabase Storage (Supabase's free tier storage
// cap forced aggressive downscaling; R2's free tier is 10x larger with zero egress fees).
// Uploads/deletes go through a small Cloudflare Worker (worker/, deployed separately via
// Wrangler — see CLAUDE.md) since R2 write access can't be done safely from the browser.
// Reads are a plain public URL, same model as Supabase Storage's public bucket before it.
export const R2_UPLOAD_ENDPOINT = 'https://pipeassessor-photo-worker.thanat-kh.workers.dev';
export const R2_PUBLIC_BASE = 'https://pub-515a1eb709644dedb7c78238192f0edc.r2.dev';

// Deployed origin — used to build the QR-code share URL printed on the finding PDF report
// (`${PUBLIC_BASE_URL}/#/s/<finding-id>`), which opens the read-only public finding view with no
// sign-in required (backed by the get_public_finding RPC — see db/public-share-migration.sql).
export const PUBLIC_BASE_URL = 'https://pipeassessor.onrender.com';

// Leak is NOT a finding type here — it's orthogonal to the damage mechanism (a corrosion, dent,
// or CUI finding can independently be actively leaking or not). See the "Actively Leaking"
// checkbox (form.ts's is_leaking field) and the repair advisor's leaking overlay
// (src/workbench/repair-advisor.ts) instead.
export const FINDING_TYPES = [
  'External Corrosion',
  'Internal Corrosion',
  'CUI (Corrosion Under Insulation)',
  'CUS (Corrosion Under Support)',
  'Coating / Painting Damage',
  'Pipe Support Defect',
  'Dent / Mechanical Damage',
  'Other'
];

// Finding types where a UT reading is inherently expected — the ASME B31.3 wall-thickness engine
// (and the numeric branch of the repair advisor, src/workbench/repair-advisor.ts) only applies to
// these. Lives in constants.ts (not features/form.ts) so both form.ts and the workbench module can
// import it without a features->workbench->features import cycle.
export const WALL_LOSS_TYPES = ['External Corrosion', 'Internal Corrosion', 'CUI (Corrosion Under Insulation)', 'CUS (Corrosion Under Support)'];

// Finding types that do not represent fluid-containing pressure boundary breaches
export const NON_LEAKABLE_TYPES = ['Coating / Painting Damage', 'Pipe Support Defect'];

// Short labels for the map legend's Type mode (core/dashboard.ts's renderMapLegend) — full names
// like "CUI (Corrosion Under Insulation)" wrap poorly even on the legend's own row.
export const FINDING_TYPE_SHORT = {
  'External Corrosion': 'Ext Corr',
  'Internal Corrosion': 'Int Corr',
  'CUI (Corrosion Under Insulation)': 'CUI',
  'CUS (Corrosion Under Support)': 'CUS',
  'Coating / Painting Damage': 'Coating',
  'Pipe Support Defect': 'Support',
  'Dent / Mechanical Damage': 'Dent',
  'Other': 'Other'
};

export const STATUSES = ['Open', 'Monitoring', 'Repair Planned', 'Repaired', 'Closed'];

// Statuses an `inspector` may set. The rest (Repair Planned / Repaired / Closed) are the repair
// handover and belong to `maintenance`. Enforced for real by the pa_guard_repair_fields trigger in
// db/schema.sql section 9 — this list only drives which buttons the detail page renders.
export const INSPECTOR_STATUSES = ['Open', 'Monitoring'];

// Self-registration is restricted to these email domains. The real gate is the
// pa_enforce_signup_domain trigger on auth.users (db/schema.sql section 9); this copy exists only
// so the sign-up form can reject a bad address with a friendly message before calling Supabase.
export const ALLOWED_SIGNUP_DOMAINS = ['pttor.com', 'pttplc.com'];

export const PHOTO_LIMIT_PER_KIND = 4; // As Found and After Repair each capped at 4 -> 8 total per finding

// Repair method options for the "Repaired" status-change dialog's dropdown — the same PCC-2
// category names used by workbench/repair-advisor.ts's numeric REPAIR-status guidance, plus a few
// non-pressure-repair categories (Coating, Support, non-repair dispositions) for the non-wall-loss
// finding types, and a trailing 'Other' that reveals a free-text field. Kept here (not derived from
// repair-advisor.ts's item titles) since this is a fixed closed list for data entry, independent of
// any specific finding's advisor content.
export const REPAIR_METHOD_OPTIONS = [
  'Composite Repair (PCC-2 Part 2)',
  'Welded Sleeve (PCC-2 Part 3)',
  'Weld Overlay / Buildup (PCC-2 Part 3)',
  'Mechanical Clamp (PCC-2 Part 4)',
  'Replacement / Spool Replacement (PCC-2 Part 3)',
  'Coating / Recoat Repair',
  'Support Repair / Replacement',
  'No Repair Required (Monitoring Cleared)',
  'Other',
];

export const STATUS_META = {
  'Open':           { cls: 'st-open' },
  'Monitoring':     { cls: 'st-mon' },
  'Repair Planned': { cls: 'st-plan' },
  'Repaired':       { cls: 'st-rep' },
  'Closed':         { cls: 'st-closed' }
};

// Dashboard-map pin fills — deliberately theme-independent fixed hex (drawn over satellite
// imagery, whose background never changes with the app theme — same rationale as the PDF_*
// constants in calculator.html). Single source: the legend is generated from this object too.
export const STATUS_COLORS = {
  'Open':           '#dc2626',
  'Monitoring':     '#d97706',
  'Repair Planned': '#2563eb',
  'Repaired':       '#059669',
  'Closed':         '#64748b'
};

// Common risk-convention 3-color scale (green/amber/red) — same theme-independence rationale as
// STATUS_COLORS above (drawn over satellite imagery). Used when the map's "color by" mode is
// Severity (see app.ts's colorBy wiring / dashboard.ts's renderMap).
export const SEVERITY_COLORS = {
  'Low':    '#059669',
  'Medium': '#d97706',
  'High':   '#dc2626'
};

// 8 hues, one per FINDING_TYPES entry — deliberately clear of red/amber/orange (STATUS_COLORS'
// and SEVERITY_COLORS' territory) so Type mode never looks like a repaint of Status/Severity mode
// on the map's "color by" selector. Validated against the dataviz skill's categorical-color
// checks (OKLCH lightness band, chroma floor, CVD ΔE, normal-vision floor) on the *adjacent*
// pairlist, i.e. each type vs. its neighbors in this exact FINDING_TYPES order — reordering the
// object's keys would invalidate that check, so keep this order in sync with FINDING_TYPES above.
// 'Other' is the sole exception: kept as the existing desaturated neutral (a deliberate non-hue
// catch-all, not part of the validated set) rather than spending a hue slot on it.
export const TYPE_COLORS = {
  'External Corrosion':                '#1d6fa8', // navy blue
  'Internal Corrosion':                '#4d7c0f', // olive green
  'CUI (Corrosion Under Insulation)':   '#7c3aed', // violet
  'CUS (Corrosion Under Support)':      '#be5314', // burnt orange
  'Coating / Painting Damage':          '#0284c7', // sky blue
  'Pipe Support Defect':                '#c0257a', // magenta
  'Dent / Mechanical Damage':           '#166534', // dark green
  'Other':                              '#64748b'  // neutral gray (unvalidated, deliberate)
};

// Same default view as the calculator's site-location map.
export const DEFAULT_MAP_VIEW = { center: [13.097720, 100.887211], zoom: 14 };
export const SAT_TILES = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Imagery (c) Esri, Maxar, Earthstar Geographics',
  maxZoom: 19
};
// Same Esri tile family as SAT_TILES (no new provider/API key) — the dashboard map's street-mode
// alternative to satellite imagery.
export const STREET_TILES = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Esri, HERE, Garmin, FAO, NOAA, USGS, (c) OpenStreetMap contributors',
  maxZoom: 19
};

