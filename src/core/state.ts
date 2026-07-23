/* ============================================================================
   Shared mutable application state. ESM imports are read-only bindings, so cross-
   module writes go through set*() and cross-module reads use the live binding
   (which reflects the latest set*()). filters/selectedIds-style objects are also
   mutated in place. Extracted from the app monolith.
   ============================================================================ */

// Loaded caches and view state:
export let session: any = null;
export function setSession(v: any) { session = v; }

/* Signed-in user's role, from public.profiles (db/schema.sql section 9). Defaults to the LEAST
   privileged value so a failed/pending profile fetch can never accidentally expose maintenance-only
   controls — the DB enforces the real boundary either way (RLS + the pa_guard_repair_fields
   trigger), this only drives which chrome is rendered. */
export let userRole: 'inspector' | 'maintenance' = 'inspector';
export function setUserRole(v: 'inspector' | 'maintenance') { userRole = v; }
export function isMaintenance() { return userRole === 'maintenance'; }

export let findings: any = [];
export function setFindings(v: any) { findings = v; }

export let lineList: any = [];
export function setLineList(v: any) { lineList = v; }

export let current: any = null;
export function setCurrent(v: any) { current = v; }

export let currentPhotos: any = [];
export function setCurrentPhotos(v: any) { currentPhotos = v; }

export let currentHistory: any = [];
export function setCurrentHistory(v: any) { currentHistory = v; }

export let currentAssessments: any = [];
export function setCurrentAssessments(v: any) { currentAssessments = v; }

export let editingId: any = null;
export function setEditingId(v: any) { editingId = v; }

export let pendingPhotos: any = [];
export function setPendingPhotos(v: any) { pendingPhotos = v; }

export let pickMap: any = null;
export function setPickMap(v: any) { pickMap = v; }

export let pickMarker: any = null;
export function setPickMarker(v: any) { pickMarker = v; }

export let dashMap: any = null;
export function setDashMap(v: any) { dashMap = v; }

export let dashLayer: any = null;
export function setDashLayer(v: any) { dashLayer = v; }

// The dashboard map's two base tile layers, created once in ensureDashMap and swapped in/out via
// toggleMapBaseLayer rather than re-created per toggle.
export let dashSatLayer: any = null;
export function setDashSatLayer(v: any) { dashSatLayer = v; }

export let dashStreetLayer: any = null;
export function setDashStreetLayer(v: any) { dashStreetLayer = v; }

// Which base layer is active. Remembered across renders (not re-derived from Leaflet state) so
// toggling doesn't need to introspect which tileLayer is currently on the map.
export let mapBaseLayer: 'satellite' | 'street' = 'satellite';
export function setMapBaseLayer(v: 'satellite' | 'street') { mapBaseLayer = v; }

export let photoCounts: any = {};
export function setPhotoCounts(v: any) { photoCounts = v; }

export let photoThumbs: any = {};
export function setPhotoThumbs(v: any) { photoThumbs = v; }

export let dashMarkers: any = {};
export function setDashMarkers(v: any) { dashMarkers = v; }

// Which dimension the dashboard map's pins + legend are colored by. 'status' matches the
// register's status pills; 'type'/'severity' surface risk concentration by damage mechanism or
// severity across the terminal, independent of lifecycle status.
export let mapColorBy: 'status' | 'type' | 'severity' = 'status';
export function setMapColorBy(v: 'status' | 'type' | 'severity') { mapColorBy = v; }

// Presentation-mode-only overlay: a translucent real-world-radius circle around each pin, a
// visual risk-zone aid (not a computed consequence distance) so an engineer walking through
// findings on the big screen can see clustering/proximity. Off by default (kept off outside
// presentation mode entirely — see toggleMapPresentation/renderRiskRadius in dashboard.ts).
export let mapShowRiskRadius = false;
export function setMapShowRiskRadius(v: boolean) { mapShowRiskRadius = v; }

// Separate Leaflet layer group for the risk-radius circles (kept apart from dashLayer's pins so
// toggling the overlay just clears/refills this group, without touching pins/popups/tooltips).
export let dashRiskLayer: any = null;
export function setDashRiskLayer(v: any) { dashRiskLayer = v; }

export let dashAddMarker: any = null;
export function setDashAddMarker(v: any) { dashAddMarker = v; }

export let pendingNewCoords: any = null;
export function setPendingNewCoords(v: any) { pendingNewCoords = v; }

export let selectedIds: any = new Set();
export function setSelectedIds(v: any) { selectedIds = v; }

export let lastRenderedRows: any = [];
export function setLastRenderedRows(v: any) { lastRenderedRows = v; }

export let importValidRows: any = [];
export function setImportValidRows(v: any) { importValidRows = v; }

export let lineListValidRows: any = [];
export function setLineListValidRows(v: any) { lineListValidRows = v; }

export let photoPasteTarget: any = 'found';
export function setPhotoPasteTarget(v: any) { photoPasteTarget = v; }

export let assessResult: any = null;
export function setAssessResult(v: any) { assessResult = v; }

export let severityTouched: any = false;
export function setSeverityTouched(v: any) { severityTouched = v; }

export let lastLoadedAssessInputs: any = null;
export function setLastLoadedAssessInputs(v: any) { lastLoadedAssessInputs = v; }

export let awFormView: any = null;
export function setAwFormView(v: any) { awFormView = v; }

export let assessToggleTouched: any = false;
export function setAssessToggleTouched(v: any) { assessToggleTouched = v; }

export let awQuickView: any = null;
export function setAwQuickView(v: any) { awQuickView = v; }

export let detailMap: any = null;
export function setDetailMap(v: any) { detailMap = v; }

export let detailMarker: any = null;
export function setDetailMarker(v: any) { detailMarker = v; }

export let dlgTarget: any = null;
export function setDlgTarget(v: any) { dlgTarget = v; }

// Register filter (mutated in place; never wholesale-reassigned):
export const filters: any = { terminal: '', status: '', type: '', q: '' };

// Risk Ranking page (#/risk): every finding's latest assessment row, loaded once per visit (all
// findings at once, not per-finding like the detail page) — see features/risk.ts's loadRiskData().
export let riskAssessments: any = [];
export function setRiskAssessments(v: any) { riskAssessments = v; }

export const riskFilters: any = { terminal: '', includeResolved: false, band: '', q: '' };
