/* ============================================================================
   Shared mutable application state. ESM imports are read-only bindings, so cross-
   module writes go through set*() and cross-module reads use the live binding
   (which reflects the latest set*()). filters/selectedIds-style objects are also
   mutated in place. Extracted from the app monolith.
   ============================================================================ */

// Loaded caches and view state:
export let session: any = null;
export function setSession(v: any) { session = v; }

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

export let photoCounts: any = {};
export function setPhotoCounts(v: any) { photoCounts = v; }

export let photoThumbs: any = {};
export function setPhotoThumbs(v: any) { photoThumbs = v; }

export let dashMarkers: any = {};
export function setDashMarkers(v: any) { dashMarkers = v; }

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
