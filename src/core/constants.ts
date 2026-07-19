/* ============================================================================
   Domain configuration constants (finding types, statuses, status colors/metadata,
   default map view, satellite tiles). Immutable — the single source shared by the
   dashboard, form, detail, and PDF surfaces. Extracted from the app monolith.
   ============================================================================ */

export const PHOTO_BUCKET = 'finding-photos';

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
export const PHOTO_LIMIT_PER_KIND = 3; // As Found and After Repair each capped at 3 -> 6 total per finding

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

// 8 visually distinct hues, one per FINDING_TYPES entry — chosen for contrast against satellite
// imagery and against each other (not a sequential/diverging scale, since finding type has no
// inherent order). Used when the map's "color by" mode is Type.
export const TYPE_COLORS = {
  'External Corrosion':                '#dc2626',
  'Internal Corrosion':                '#ea580c',
  'CUI (Corrosion Under Insulation)':   '#d97706',
  'CUS (Corrosion Under Support)':      '#65a30d',
  'Coating / Painting Damage':          '#0891b2',
  'Pipe Support Defect':                '#2563eb',
  'Dent / Mechanical Damage':           '#7c3aed',
  'Other':                              '#64748b'
};

// Same default view as the calculator's site-location map.
export const DEFAULT_MAP_VIEW = { center: [13.097720, 100.887211], zoom: 14 };
export const SAT_TILES = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Imagery (c) Esri, Maxar, Earthstar Geographics',
  maxZoom: 19
};

