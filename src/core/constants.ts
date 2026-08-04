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

// The three terminals. Mirrors the `check (terminal in (...))` constraint on findings, line_list
// and inspection_plan in db/schema.sql — same "must match exactly in both places" rule as STATUSES.
// Used by import-export.ts's row validators and risk.ts's terminal chart. index.html's several
// <option>KBY</option>-style selects still hardcode the list in markup — a JS constant can't
// populate static HTML options without adding render logic those selects don't otherwise need,
// so that duplication is left alone rather than forcing an unrelated refactor onto them.
export const TERMINALS = ['KBY', 'SRC', 'BRP'];

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
// ASME PCC-2 part numbering: Part 2 = Welded Repairs, Part 3 = Mechanical Repairs (bolted clamps,
// component replacement), Part 4 = Nonmetallic and Bonded Repairs (composite wraps, ISO 24817).
// These citations were previously reversed (Composite -> Part 2, Welded -> Part 3, Clamp -> Part 4)
// and were corrected in place. Findings saved under the OLD strings no longer match this list; the
// status dialog's legacy path handles that gracefully (openStatusDialog pre-selects 'Other' and
// prefills the free-text field with the stored value, so nothing is lost) until they are normalized.
export const REPAIR_METHOD_OPTIONS = [
  'Composite Repair (PCC-2 Part 4)',
  'Welded Sleeve (PCC-2 Part 2)',
  'Weld Overlay / Buildup (PCC-2 Part 2)',
  'Mechanical Clamp (PCC-2 Part 3)',
  'Replacement / Spool Replacement (PCC-2 Part 3)',
  'Coating / Recoat Repair',
  'Support Repair / Replacement',
  'No Repair Required (Monitoring Cleared)',
  'Other',
];

/* ================= Temporary repair / emergency stop-leak (#panelTempRepair) =================
   The in-app replacement for the legacy "รายงานการหยุดรั่วฉุกเฉิน" Excel form. The panel is only
   shown for a finding flagged is_leaking, and the record is one row per finding in public.temp_repair.
   All three arrays below mirror that table's check constraints EXACTLY — same "must match in both
   places" rule that already applies to STATUSES. */

export const TEMP_REPAIR_METHODS = [
  'Mechanical Clamp',
  'Bolted Split Sleeve / Enclosure',
  'Composite Wrap',
  'Epoxy Putty / Sealant',
  'Injection Sealing',
  'Other',
];

// Which branch of method-specific fields the form shows and the report prints. Keyed off the method
// value, never DOM/array position, so reordering TEMP_REPAIR_METHODS can't silently swap the branch.
// 'other' methods (injection sealing, a one-off) get the common fields only.
export const TEMP_REPAIR_METHOD_KIND = {
  'Mechanical Clamp':               'clamp',
  'Bolted Split Sleeve / Enclosure': 'clamp',
  'Composite Wrap':                 'composite',
  'Epoxy Putty / Sealant':          'composite',
  'Injection Sealing':              'other',
  'Other':                          'other',
};

export const TEMP_REPAIR_VERIFY_RESULTS = ['Not yet tested', 'Pass', 'Pass with observation', 'Fail'];

// Fixed hex rather than CSS vars: the same values drive the PDF's verification callout, where custom
// properties do not resolve — the same rationale as STATUS_COLORS and the PDF_* constants.
export const TEMP_REPAIR_RESULT_COLORS = {
  'Not yet tested':        '#64748b',
  'Pass':                  '#059669',
  'Pass with observation': '#d97706',
  'Fail':                  '#dc2626',
};

/* ============================ Inspection Plan (#/plan) ============================ */

// Pill classes for task status, mirroring STATUS_META's shape/role for findings. (The plain
// enumerations — plan pipe category, plan status, task status — aren't duplicated here as JS
// arrays: each only ever needs to equal one of a <select>'s own options, which can't submit an
// invalid value, so there's no membership check anywhere for them to back — same reason
// findings' own STATUSES isn't used for that kind of validation either. The database's check
// constraints, not a client-side array, are what actually enforces these three.)
export const PLAN_TASK_STATUS_META = {
  'Not Started': { cls: 'pt-todo' },
  'In Progress': { cls: 'pt-prog' },
  'Done':        { cls: 'pt-done' },
  'Cancelled':   { cls: 'pt-cancel' }
};

// Gantt bar fills per task status. Fixed hex rather than CSS vars because the same values are
// reused by the PDF export (features/pdf.ts's buildPlanPdf), where CSS custom properties do not
// resolve — the same rationale as STATUS_COLORS and the PDF_* constants.
export const PLAN_TASK_COLORS = {
  'Not Started': '#64748b',
  'In Progress': '#2563eb',
  'Done':        '#059669',
  'Cancelled':   '#94a3b8'
};

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

