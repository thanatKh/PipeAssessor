/* ============================================================================
   Domain configuration constants (finding types, statuses, status colors/metadata,
   default map view, satellite tiles). Immutable — the single source shared by the
   dashboard, form, detail, and PDF surfaces. Extracted from the app monolith.
   ============================================================================ */

export const PHOTO_BUCKET = 'finding-photos';

export const FINDING_TYPES = [
  'External Corrosion',
  'Internal Corrosion',
  'CUI (Corrosion Under Insulation)',
  'CUS (Corrosion Under Support)',
  'Coating / Painting Damage',
  'Pipe Support Defect',
  'Leak',
  'Dent / Mechanical Damage',
  'Other'
];

// Short axis labels for the findings-by-type radar (must fit at ~9px around a small chart).
export const FINDING_TYPE_SHORT = {
  'External Corrosion': 'Ext Corr',
  'Internal Corrosion': 'Int Corr',
  'CUI (Corrosion Under Insulation)': 'CUI',
  'CUS (Corrosion Under Support)': 'CUS',
  'Coating / Painting Damage': 'Coating',
  'Pipe Support Defect': 'Support',
  'Leak': 'Leak',
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

// Same default view as the calculator's site-location map.
export const DEFAULT_MAP_VIEW = { center: [13.097720, 100.887211], zoom: 14 };
export const SAT_TILES = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Imagery (c) Esri, Maxar, Earthstar Geographics',
  maxZoom: 19
};

