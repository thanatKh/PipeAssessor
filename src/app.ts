// @ts-nocheck — Phase 1: this 1:1-ported view monolith is verified behaviorally (engine
// parity + Playwright), not via types. Strict typing is added incrementally as app.ts is split
// into core/ + feature modules. The engine (src/engine) and workbench are already strictly typed.
/* ============================================================================
   Pipe Assessor — application module (ported from index.html's inline <script>).
   Phase-1 posture: this is the full app as a single ES module. Its top-level
   const/let/function share module scope, which resolves names exactly the way the
   old global <script> scope did — so the port is 1:1. External libraries come in
   as imports; jsPDF / jspdf-autotable / SheetJS(xlsx) are dynamic-import()ed at
   their call sites so Rollup emits them as lazy chunks. (Later phase: split this
   into core/ + features/ modules behind a shared state object.)
   ============================================================================ */
import L from 'leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIconUrl from 'leaflet/dist/images/marker-icon.png';
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png';
import { sb, PA_SUPABASE_URL, PA_SUPABASE_KEY } from './core/supabase';
import { computeB313, PA_PIPE_DATABASE, PA_MATERIALS, paDefaultScheduleForNps } from './engine/compute';
import { paFmtDate, paFmtDateTime, paFmtBaht, paFmtBahtShort } from './engine/format';
import { downscaleImage, OR_LOGO_DATAURL } from './engine/branding';
import { registerGoogleSansFonts } from './engine/fonts';
import { paCreateAssessView, paAdvisorItems, PA_SCOPE_TEXT, paCrossSectionPng } from './workbench/assess-view';

// SheetJS (xlsx) is loaded on demand (import/export only) so it stays out of the initial bundle.
let XLSX: any;
async function ensureXLSX() { if (!XLSX) XLSX = await import('xlsx'); return XLSX; }

// Leaflet resolves its default marker icons relative to its own script URL, which breaks under
// bundling — repoint them at the bundled asset URLs so the position-picker pin shows.
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIconUrl, shadowUrl: markerShadowUrl });

/* =====================================================================
   Findings Tracker — Phase 1
   Data lives in Supabase (PostgreSQL + Storage), auth via email/password.
   The anon (publishable) key below is safe to expose: Row Level Security
   only grants access to signed-in users. See db/schema.sql.
   ===================================================================== */

const SUPABASE_URL = PA_SUPABASE_URL;  // from asset/shared.js — single source for both pages
const SUPABASE_KEY = PA_SUPABASE_KEY;
const PHOTO_BUCKET = 'finding-photos';

const FINDING_TYPES = [
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
const FINDING_TYPE_SHORT = {
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

const STATUSES = ['Open', 'Monitoring', 'Repair Planned', 'Repaired', 'Closed'];
const PHOTO_LIMIT_PER_KIND = 3; // As Found and After Repair each capped at 3 -> 6 total per finding

const STATUS_META = {
  'Open':           { cls: 'st-open' },
  'Monitoring':     { cls: 'st-mon' },
  'Repair Planned': { cls: 'st-plan' },
  'Repaired':       { cls: 'st-rep' },
  'Closed':         { cls: 'st-closed' }
};

// Dashboard-map pin fills — deliberately theme-independent fixed hex (drawn over satellite
// imagery, whose background never changes with the app theme — same rationale as the PDF_*
// constants in calculator.html). Single source: the legend is generated from this object too.
const STATUS_COLORS = {
  'Open':           '#dc2626',
  'Monitoring':     '#d97706',
  'Repair Planned': '#2563eb',
  'Repaired':       '#059669',
  'Closed':         '#64748b'
};

// Same default view as the calculator's site-location map.
const DEFAULT_MAP_VIEW = { center: [13.097720, 100.887211], zoom: 14 };
const SAT_TILES = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Imagery (c) Esri, Maxar, Earthstar Geographics',
  maxZoom: 19
};

// sb is imported from ./core/supabase (created once at module load).              // Supabase client
let session = null;
let findings = [];          // list cache
let lineList = [];          // master line-list cache (pipe tag -> nps/schedule/material/metadata)
let current = null;         // finding shown in detail view
let currentPhotos = [];
let currentHistory = [];
let currentAssessments = [];
let editingId = null;       // null = creating
let pendingPhotos = [];     // [{file, previewUrl}] queued on the NEW form
let pickMap = null, pickMarker = null;
let dashMap = null, dashLayer = null;

/* ---------------- helpers ---------------- */

const $ = (id) => document.getElementById(id);
const val = (id) => $(id).value;

// Wraps native <dialog> showModal()/close() with the transitions.dev modal open/close
// animation (see the dialog.app-dlg/#lightbox CSS above) — .is-open drives the scale+fade
// in, .is-closing plays a quicker scale-down before the dialog actually closes so it never
// just vanishes.
// Slides a .seg-row's pill under whichever .seg-btn is currently .active. animate=false
// (first paint, resize, or a freshly-rendered #segTerminal) suspends the transition so the
// pill snaps into place instead of sliding in from translateX(0)/width:0.
function positionSegPill(segRow, animate) {
  const pill = segRow.querySelector('.seg-pill');
  const active = segRow.querySelector('.seg-btn.active');
  if (!pill || !active) return;
  if (!animate) {
    const prev = pill.style.transition;
    pill.style.transition = 'none';
    pill.style.transform = `translateX(${active.offsetLeft - segRow.clientLeft}px)`;
    pill.style.width = `${active.offsetWidth}px`;
    void pill.offsetWidth;
    pill.style.transition = prev;
  } else {
    pill.style.transform = `translateX(${active.offsetLeft - segRow.clientLeft}px)`;
    pill.style.width = `${active.offsetWidth}px`;
  }
}

function openDialog(el) {
  el.showModal();
  el.classList.remove('is-closing');
  void el.offsetWidth; // reflow so the open transition always replays from --modal-scale
  el.classList.add('is-open');
}
function closeDialog(el) {
  const closeMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--modal-close-dur')) || 150;
  el.classList.remove('is-open');
  el.classList.add('is-closing');
  setTimeout(() => { el.classList.remove('is-closing'); el.close(); }, closeMs);
}

// Native <details> removes its content the instant [open] is toggled off, which would skip
// the collapse animation entirely (the grid-rows/opacity/blur transitions in theme.css's
// accordion-expand block only play while [open] is still present). Intercept the summary
// click, keep `open` set for one more frame, and let it fall away only after the collapse
// transition has had time to run. Opening needs no interception — the browser adds `open`
// immediately and the CSS transitions in from grid-template-rows: 0fr on its own.
document.addEventListener('click', (e) => {
  const summary = e.target.closest('summary.panel-collapse');
  if (!summary) return;
  const details = summary.closest('details.panel');
  if (!details || !details.open) return; // opening — let the browser handle it natively
  e.preventDefault();
  const collapseMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--acc-collapse')) || 250;
  // `open` stays set through the whole animation (removing it early would instantly hide the
  // content) — .is-closing is what actually drives the grid-rows back to 0fr (see theme.css's
  // `details.panel.is-closing > .panel-b-track` override). Only strip `open` once the CSS
  // transition has had time to finish, which is what actually collapses the details element.
  details.classList.add('is-closing');
  setTimeout(() => { details.removeAttribute('open'); details.classList.remove('is-closing'); }, collapseMs);
});

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const fmtDate = paFmtDate; // shared "dd Mmm yyyy" helper (asset/shared.js)
const fmtDateTime = paFmtDateTime; // shared "dd Mmm yyyy HH:mm" (24-hour) helper (asset/shared.js)

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isOverdue(f) {
  const today = todayISO();
  if ((f.status === 'Open' || f.status === 'Repair Planned') && f.target_date && f.target_date < today) return true;
  if (f.status === 'Monitoring' && f.next_check_date && f.next_check_date < today) return true;
  return false;
}

function dueDateOf(f) {
  if (f.status === 'Monitoring') return f.next_check_date;
  if (f.status === 'Open' || f.status === 'Repair Planned') return f.target_date;
  return null;
}

function pillHtml(status) {
  const m = STATUS_META[status] || { cls: 'st-closed' };
  return `<span class="pill ${m.cls}">${esc(status)}</span>`;
}

let toastTimer = null;
function notify(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2800);
}

function setBusy(btn, busy, busyText) {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = busyText || 'Working…';
    btn.disabled = true;
  } else {
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
    btn.disabled = false;
  }
}

// downscaleImage() lives in asset/shared.js

/* ---------------- auth ---------------- */

function updateAuthUI() {
  document.body.classList.toggle('authed', !!session);
  $('hdrUser').textContent = session ? (session.user.email || '') : '';
}

async function signIn() {
  const errBox = $('loginErr');
  errBox.style.display = 'none';
  const email = val('loginEmail').trim();
  const pass = val('loginPass');
  if (!email || !pass) {
    errBox.textContent = 'Enter both email and password.';
    errBox.style.display = 'block';
    return;
  }
  setBusy($('btnSignIn'), true, 'Signing in…');
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  setBusy($('btnSignIn'), false);
  if (error) {
    errBox.textContent = error.message === 'Invalid login credentials'
      ? 'Email or password is incorrect.' : error.message;
    errBox.style.display = 'block';
    return;
  }
  $('loginPass').value = '';
}

/* ---------------- routing ---------------- */

function show(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === viewId));
  window.scrollTo(0, 0);
  // Seg-row pills measure offsetLeft/offsetWidth, which read 0 while their view was
  // display:none — same gotcha as the dashboard/detail Leaflet maps. Re-snap (no animation)
  // now that the view is visible.
  document.querySelectorAll(`#${viewId} .seg-row`).forEach(row => positionSegPill(row, false));
}

async function route() {
  if (!session) { show('viewLogin'); return; }
  const h = location.hash || '#/list';

  if (h.startsWith('#/f/')) {
    const ok = await loadDetail(h.slice(4));
    if (ok) { renderDetail(); show('viewDetail'); }
    else location.hash = '#/list';
    return;
  }
  if (h === '#/new') {
    openForm(null);
    show('viewForm');
    return;
  }
  if (h === '#/calc') {
    // standalone what-if workbench — nothing loads, nothing saves
    show('viewCalc');
    return;
  }
  if (h.startsWith('#/edit/')) {
    const id = h.slice(7);
    let f = findings.find(x => x.id === id) || (current && current.id === id ? current : null);
    if (!f) {
      const { data, error } = await sb.from('findings').select('*').eq('id', id).single();
      if (error) { notify('Finding not found.', true); location.hash = '#/list'; return; }
      f = data;
    }
    openForm(f);
    show('viewForm');
    return;
  }
  // default: list — show the view BEFORE rendering so the Leaflet container has
  // real dimensions (a map initialized inside display:none sizes to 0×0)
  await loadFindings();
  if (!lineList.length) await loadLineList(); // cheap no-op once cached
  show('viewList');
  renderList();
}

/* ---------------- data ---------------- */

let photoCounts = {}; // finding_id -> number of photos, for the register's camera chip
let photoThumbs = {}; // finding_id -> {storage_path, kind}, for the register's thumbnail

async function loadFindings() {
  selectedIds.clear(); // fresh data -> drop any selection from a previous load (ids may be stale)
  const [fq, pq] = await Promise.all([
    sb.from('findings').select('*').order('created_at', { ascending: false }),
    sb.from('finding_photos').select('finding_id, storage_path, kind, created_at').order('created_at', { ascending: true })
  ]);
  if (fq.error) { notify('Load failed: ' + fq.error.message, true); return; }
  findings = fq.data || [];
  photoCounts = {};
  photoThumbs = {}; // finding_id -> storage_path of its earliest "found" photo (falls back to any)
  (pq.data || []).forEach(p => {
    photoCounts[p.finding_id] = (photoCounts[p.finding_id] || 0) + 1;
    const cur = photoThumbs[p.finding_id];
    if (!cur || (cur.kind !== 'found' && p.kind === 'found')) photoThumbs[p.finding_id] = p;
  });
}

/* Days since the inspection date (falls back to created_at) — how long the finding has existed. */
function ageDays(f) {
  const base = f.inspection_date || f.created_at;
  if (!base) return null;
  const ms = Date.now() - new Date(base).getTime();
  if (isNaN(ms)) return null;
  return Math.max(0, Math.floor(ms / 86400000));
}

/* Sort priority: overdue first, then nearest due date (nulls last), then newest — surfaces
   exactly what needs attention instead of burying it under recently-added rows. */
const STATUS_RANK = { 'Open': 0, 'Repair Planned': 1, 'Monitoring': 2, 'Repaired': 3, 'Closed': 4 };
function sortFindings(rows) {
  return rows.slice().sort((a, b) => {
    const ao = isOverdue(a), bo = isOverdue(b);
    if (ao !== bo) return ao ? -1 : 1;
    const ad = dueDateOf(a), bd = dueDateOf(b);
    if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
    if (ad && !bd) return -1;
    if (!ad && bd) return 1;
    const ar = STATUS_RANK[a.status] ?? 9, br = STATUS_RANK[b.status] ?? 9;
    if (ar !== br) return ar - br;
    return (b.created_at || '').localeCompare(a.created_at || '');
  });
}

async function loadDetail(id) {
  const [f, ph, hi, as] = await Promise.all([
    sb.from('findings').select('*').eq('id', id).single(),
    sb.from('finding_photos').select('*').eq('finding_id', id).order('created_at', { ascending: true }),
    sb.from('status_history').select('*').eq('finding_id', id).order('changed_at', { ascending: false }),
    sb.from('assessments').select('*').eq('finding_id', id).order('created_at', { ascending: false })
  ]);
  if (f.error) { notify('Finding not found.', true); return false; }
  current = f.data;
  currentPhotos = ph.data || [];
  currentHistory = hi.data || [];
  currentAssessments = as.data || [];
  return true;
}

function photoUrl(path) {
  return sb.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
}

/* ---------------- list view ---------------- */

const filters = { terminal: '', status: '', type: '', q: '' };

function applyFilters(rows) {
  const q = filters.q.trim().toLowerCase();
  return rows.filter(f => {
    if (filters.terminal && f.terminal !== filters.terminal) return false;
    if (filters.status === '__overdue') { if (!isOverdue(f)) return false; }
    else if (filters.status === '__complete') { if (f.status !== 'Repaired' && f.status !== 'Closed') return false; }
    else if (filters.status === '__outstanding') { if (f.status === 'Repaired' || f.status === 'Closed') return false; }
    else if (filters.status && f.status !== filters.status) return false;
    if (filters.type && f.finding_type !== filters.type) return false;
    if (q) {
      const hay = [f.pipe_tag, f.description, f.location_desc, f.report_no, f.sap_notification, f.sap_order, f.pid_no, f.service]
        .map(x => (x || '').toLowerCase()).join(' ');
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Circumference of the ring's r=42 circle (2 * PI * 42) — stroke-dasharray/-dashoffset are set
// in absolute SVG units, not percentages, so this constant drives the fill math below.
const KPI_RING_CIRCUMFERENCE = 2 * Math.PI * 42;

function renderKpis() {
  const count = (st) => findings.filter(f => f.status === st).length;
  const overdue = findings.filter(isOverdue).length;
  const items = [
    { label: 'Open', num: count('Open'), filter: 'Open' },
    { label: 'Monitoring', num: count('Monitoring'), filter: 'Monitoring' },
    { label: 'Repair Planned', num: count('Repair Planned'), filter: 'Repair Planned' },
    { label: 'Overdue', num: overdue, filter: '__overdue', cls: 'k-overdue' },
    { label: 'Repaired', num: count('Repaired'), filter: 'Repaired' },
    { label: 'All', num: findings.length, filter: '' }
  ];
  $('kpiRowBottom').innerHTML = items.map(it =>
    `<button type="button" class="kpi ${it.cls || ''} ${filters.status === it.filter && (it.filter !== '' || filters.status === '') ? '' : ''}" data-filter="${esc(it.filter)}">
       <span class="k-num">${it.num}</span><span class="k-label">${esc(it.label)}</span>
     </button>`).join('');
  $('kpiRowBottom').querySelectorAll('.kpi').forEach(btn => {
    if (btn.dataset.filter === filters.status) btn.classList.add('active');
    btn.addEventListener('click', () => {
      filters.status = btn.dataset.filter;
      $('filStatus').value = filters.status;
      renderList();
    });
  });

  // Completion ring: Repaired + Closed vs. all findings. A finding is "resolved" once its
  // repair is confirmed OR the record is formally closed out — matches the register's own
  // dimmed/"row-dim" treatment for these two statuses.
  const total = findings.length;
  const complete = count('Repaired') + count('Closed');
  const pct = total > 0 ? Math.round((complete / total) * 100) : 0;
  const offset = KPI_RING_CIRCUMFERENCE * (1 - (total > 0 ? complete / total : 0));
  $('kpiRingFill').style.strokeDasharray = `${KPI_RING_CIRCUMFERENCE}`;
  $('kpiRingFill').style.strokeDashoffset = `${offset}`;
  $('kpiRingPct').textContent = `${pct}%`;
  $('kpiRingFraction').textContent = `${complete} of ${total}`;
  $('kpiRingCard').classList.toggle('active', filters.status === '__complete');

  renderBudgetKpi();
  renderTypeRadar();
}

// Outstanding repair budget: Σ estimated_cost over findings not yet Repaired/Closed, with a
// High/Medium/Low split. Computed globally (like the KPI chips), independent of the active filter.
function renderBudgetKpi() {
  const isOut = f => f.status !== 'Repaired' && f.status !== 'Closed';
  const out = findings.filter(isOut);
  const sum = arr => arr.reduce((s, f) => s + (Number(f.estimated_cost) || 0), 0);
  const noEst = out.filter(f => f.estimated_cost == null).length;
  $('kbTotal').textContent = paFmtBahtShort(sum(out));
  $('kbSub').textContent = `${out.length} finding${out.length === 1 ? '' : 's'}${noEst ? ` · ${noEst} not yet estimated` : ''}`;
  const sev = s => paFmtBahtShort(sum(out.filter(f => f.severity === s)));
  $('kbSev').innerHTML =
    `<span class="kb-hi"><i></i>High <b>${sev('High')}</b></span>` +
    `<span class="kb-md"><i></i>Med <b>${sev('Medium')}</b></span>` +
    `<span class="kb-lo"><i></i>Low <b>${sev('Low')}</b></span>`;
  $('kpiBudgetCard').classList.toggle('active', filters.status === '__outstanding');
}

// Findings-by-type radar: for each of the 9 FINDING_TYPES, Remaining (not Repaired/Closed) nested
// inside Total (all of that type). Hand-drawn SVG (no charting lib), fixed axes for a stable shape.
function renderTypeRadar() {
  const el = $('kpiRadar');
  const types = FINDING_TYPES;
  const N = types.length;
  const totalOf = t => findings.filter(f => f.finding_type === t).length;
  const remainOf = t => findings.filter(f => f.finding_type === t && f.status !== 'Repaired' && f.status !== 'Closed').length;
  const totals = types.map(totalOf);
  const remains = types.map(remainOf);
  const sumT = totals.reduce((a, b) => a + b, 0);
  const sumR = remains.reduce((a, b) => a + b, 0);

  if (!findings.length) {
    el.innerHTML = `<div class="radar-empty">No findings yet</div>`;
    return;
  }

  const cx = 120, cy = 100, maxR = 68;
  // "nice" max so the outer ring isn't cramped (grid rings at 1/4..4/4 of it)
  const rawMax = Math.max(1, ...totals);
  const step = rawMax <= 4 ? 1 : rawMax <= 8 ? 2 : Math.ceil(rawMax / 4);
  const maxVal = step * 4;
  const RINGS = 4;
  const ang = i => (-90 + i * (360 / N)) * Math.PI / 180;
  const pt = (i, v) => {
    const r = (v / maxVal) * maxR;
    return [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];
  };
  const poly = vals => vals.map((v, i) => pt(i, v).map(n => n.toFixed(1)).join(',')).join(' ');

  let grid = '';
  for (let g = 1; g <= RINGS; g++) {
    const rv = maxVal * g / RINGS;
    grid += `<polygon class="radar-grid" points="${poly(types.map(() => rv))}"></polygon>`;
  }
  let axes = '', labels = '';
  types.forEach((t, i) => {
    const [ex, ey] = pt(i, maxVal);
    axes += `<line class="radar-axis" x1="${cx}" y1="${cy}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}"></line>`;
    const [lx, ly] = pt(i, maxVal + 0.9);
    const a = ang(i);
    const anchor = Math.abs(Math.cos(a)) < 0.3 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end');
    const dy = Math.sin(a) > 0.3 ? '0.7em' : (Math.sin(a) < -0.3 ? '-0.2em' : '0.3em');
    labels += `<text class="radar-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" dy="${dy}">${esc(FINDING_TYPE_SHORT[t] || t)}</text>`;
  });
  const totalPoly = `<polygon class="radar-total" points="${poly(totals)}"></polygon>`;
  const remainPoly = `<polygon class="radar-remain" points="${poly(remains)}"></polygon>`;
  const remainDots = remains.map((v, i) => { const [x, y] = pt(i, v); return v > 0 ? `<circle class="radar-remain-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2"></circle>` : ''; }).join('');

  el.innerHTML =
    `<svg viewBox="0 0 240 200" role="img" aria-label="Findings by type, remaining vs total">` +
    grid + axes + totalPoly + remainPoly + remainDots + labels +
    `</svg>` +
    `<div class="radar-legend"><span class="rl-remain"><i></i>Remaining <b>${sumR}</b></span><span class="rl-total"><i></i>Total <b>${sumT}</b></span></div>`;
}

/* ---------------- dashboard map ---------------- */

function ensureDashMap() {
  const el = $('dashMap');
  if (typeof L === 'undefined') {
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.fontSize = '11px';
    el.style.color = 'var(--text-light)';
    el.textContent = 'Map unavailable — check your connection.';
    return;
  }
  if (dashMap) { setTimeout(() => dashMap.invalidateSize(), 80); return; }
  dashMap = L.map(el, { center: DEFAULT_MAP_VIEW.center, zoom: DEFAULT_MAP_VIEW.zoom, scrollWheelZoom: false });
  L.tileLayer(SAT_TILES.url, { maxZoom: SAT_TILES.maxZoom, attribution: SAT_TILES.attribution }).addTo(dashMap);
  dashLayer = L.layerGroup().addTo(dashMap);
  // scroll-zoom only after the user clicks the map — otherwise page scrolling gets hijacked
  dashMap.on('focus click', () => dashMap.scrollWheelZoom.enable());
  dashMap.on('blur', () => dashMap.scrollWheelZoom.disable());
  // double-click drops a pin and offers "Add finding here" instead of zooming
  dashMap.doubleClickZoom.disable();
  dashMap.on('dblclick', (e) => showAddFindingPopup(e.latlng));
  dashMap.on('popupclose', () => { if (dashAddMarker) { dashLayer.removeLayer(dashAddMarker); dashAddMarker = null; } });
  setTimeout(() => dashMap.invalidateSize(), 150);
}

function popupHtml(f) {
  return `<div class="map-popup">
    <div class="mp-tag">${esc(f.pipe_tag || f.location_desc || '—')}</div>
    ${pillHtml(f.status)}${isOverdue(f) ? ' <span class="ov-badge">OVERDUE</span>' : ''}
    <div class="mp-meta">${esc(f.terminal)} — ${esc(f.finding_type)}</div>
    <a href="#/f/${esc(f.id)}">Open finding &#8594;</a>
  </div>`;
}

let dashMarkers = {}; // finding_id -> circleMarker, for row->pin highlighting
let dashAddMarker = null;   // temporary pin dropped by a dbl-click "add finding here"
let pendingNewCoords = null; // {lat,lng} carried from a map dbl-click into the next new-finding form

// Double-click the dashboard map -> drop a temporary pin + a small popup that opens the New
// Finding form pre-seeded with these coordinates. openForm(null) reads pendingNewCoords in its
// map-init branch and calls setPin() to place the picker pin.
function showAddFindingPopup(latlng) {
  if (dashAddMarker) dashLayer.removeLayer(dashAddMarker);
  dashAddMarker = L.circleMarker(latlng, {
    radius: 8, color: '#156B95', fillColor: '#38bdf8', fillOpacity: 0.9, weight: 2
  }).addTo(dashLayer);

  // build as a DOM node so the button's handler wires cleanly (no id lookup across popups)
  const node = document.createElement('div');
  node.className = 'map-popup';
  node.innerHTML = `<div class="mp-tag">Add a finding here?</div>
    <div class="mp-meta mono">${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}</div>`;
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.type = 'button';
  btn.style.marginTop = '6px';
  btn.textContent = 'Add finding here';
  btn.addEventListener('click', () => {
    pendingNewCoords = { lat: latlng.lat, lng: latlng.lng };
    dashMap.closePopup();
    location.hash = '#/new';
  });
  node.appendChild(btn);

  L.popup({ closeButton: true }).setLatLng(latlng).setContent(node).openOn(dashMap);
}

function renderMap(rows) {
  ensureDashMap();
  if (!dashMap) return;
  // The container was display:none while another view was active; Leaflet's cached size is
  // stale (0×0), and fitBounds against a zero-size map computes a world-level zoom. Re-measure
  // synchronously — show('viewList') has already run by the time renderMap is called. A second,
  // deferred invalidate is cheap insurance against any layout not being fully settled yet
  // (fonts/webfont swap, etc.) on the first paint.
  dashMap.invalidateSize();
  setTimeout(() => dashMap.invalidateSize(), 100);
  dashLayer.clearLayers();
  dashMarkers = {};
  const pts = rows.filter(f => f.lat != null && f.lng != null);
  pts.forEach(f => {
    const color = STATUS_COLORS[f.status] || '#64748b';
    if (isOverdue(f)) {
      // dashed red halo reads over any pin fill (a red ring on the red Open pin would vanish)
      dashLayer.addLayer(L.circleMarker([f.lat, f.lng], {
        radius: 14, fill: false, color: '#dc2626', weight: 2, dashArray: '4,4', interactive: false
      }));
    }
    const pin = L.circleMarker([f.lat, f.lng], {
      radius: 8, fillColor: color, fillOpacity: 0.95, color: '#ffffff', weight: 2
    });
    pin.bindPopup(popupHtml(f));
    // clicking a pin flashes + scrolls to its table row (the reverse of row->pin hover)
    pin.on('click', () => flashRow(f.id));
    dashLayer.addLayer(pin);
    dashMarkers[f.id] = pin;
  });
  if (pts.length) {
    dashMap.fitBounds(L.latLngBounds(pts.map(f => [f.lat, f.lng])).pad(0.25), { maxZoom: 17 });
  } else {
    dashMap.setView(DEFAULT_MAP_VIEW.center, DEFAULT_MAP_VIEW.zoom);
  }
}

/* row -> pin: emphasize the marker while hovering its row */
function highlightPin(id, on) {
  const m = dashMarkers[id];
  if (!m) return;
  m.setRadius(on ? 12 : 8);
  m.setStyle({ weight: on ? 3 : 2 });
  if (on) m.bringToFront();
}

/* pin -> row: scroll the row into view and flash it */
function flashRow(id) {
  const tr = document.querySelector(`#listBody tr[data-id="${CSS.escape(id)}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  tr.classList.remove('row-flash');
  void tr.offsetWidth; // restart the animation
  tr.classList.add('row-flash');
}

const CAMERA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

function ageHtml(f) {
  const d = ageDays(f);
  if (d == null) return '<span class="age">—</span>';
  const active = f.status !== 'Repaired' && f.status !== 'Closed';
  const cls = active && d >= 180 ? 'age age-old' : active && d >= 90 ? 'age age-warn' : 'age';
  return `<span class="${cls}" title="Days since inspection">${d}d</span>`;
}

// Row selection for the Summary PDF (see exportSummaryPdf): a plain Set of finding ids,
// persisted across re-renders/filter changes within the same list load, cleared whenever
// loadFindings() pulls fresh data (stale ids could otherwise reference deleted rows).
let selectedIds = new Set();
let lastRenderedRows = [];

function renderTable(rows) {
  lastRenderedRows = rows;
  const body = $('listBody');
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">${findings.length ? 'No findings match the current filters.' : 'No findings recorded yet — use “+ New Finding” to add the first one.'}</td></tr>`;
    updateSelectionUI();
    return;
  }
  body.innerHTML = rows.map(f => {
    const due = dueDateOf(f);
    const dueHtml = isOverdue(f)
      ? `<span class="ov-badge">${fmtDate(due)}</span>`
      : `<span class="mono" style="font-size:12px;">${fmtDate(due)}</span>`;
    const np = photoCounts[f.id] || 0;
    const photoChip = np ? `<span class="t-photos">${CAMERA_SVG}${np}</span>` : '';
    const thumb = photoThumbs[f.id];
    const thumbHtml = thumb
      ? `<img class="row-thumb" src="${esc(photoUrl(thumb.storage_path))}" alt="" loading="lazy">`
      : `<span class="row-thumb row-thumb-empty"></span>`;
    const dim = (f.status === 'Repaired' || f.status === 'Closed') ? ' row-dim' : '';
    const checked = selectedIds.has(f.id) ? ' checked' : '';
    return `<tr data-id="${esc(f.id)}" class="${dim.trim()}">
      <td class="c-check"><input type="checkbox" class="row-check" data-sel="${esc(f.id)}"${checked}></td>
      <td>${pillHtml(f.status)}</td>
      <td class="c-tag">
        <div class="c-tag-flex">
          ${thumbHtml}
          <div class="c-tag-text">
            <div class="t-tag-row"><span class="t-tag" title="${esc(f.pipe_tag || f.location_desc || '')}">${esc(f.pipe_tag || f.location_desc || '—')}</span>${photoChip}</div>
            <div class="t-type" title="${esc(f.finding_type)}">${esc(f.finding_type)}</div>
            ${(f.pipe_tag && f.location_desc) ? `<div class="t-desc" title="${esc(f.location_desc)}"><span class="t-desc-label">Loc:</span> ${esc(f.location_desc)}</div>` : ''}
            ${f.description ? `<div class="t-desc" title="${esc(f.description)}"><span class="t-desc-label">Anomaly:</span> ${esc(f.description)}</div>` : ''}
          </div>
        </div>
      </td>
      <td style="font-size:12px;">${esc(f.terminal)}</td>
      <td>${ageHtml(f)}</td>
      <td>${dueHtml}</td>
    </tr>`;
  }).join('');
  body.querySelectorAll('tr[data-id]').forEach(tr => {
    const id = tr.dataset.id;
    tr.addEventListener('click', (e) => { if (e.target.closest('.c-check')) return; location.hash = '#/f/' + id; });
    tr.addEventListener('mouseenter', () => highlightPin(id, true));
    tr.addEventListener('mouseleave', () => highlightPin(id, false));
  });
  body.querySelectorAll('.row-check[data-sel]').forEach(chk => {
    chk.addEventListener('click', (e) => e.stopPropagation());
    chk.addEventListener('change', () => {
      const id = chk.dataset.sel;
      if (chk.checked) selectedIds.add(id); else selectedIds.delete(id);
      updateSelectionUI();
    });
  });
  updateSelectionUI();
}

// Syncs the header "select all" checkbox (checked/indeterminate) and the selection bar
// (count + Summary PDF button label) to the current selectedIds / rendered-rows state.
function updateSelectionUI() {
  const selectAll = $('chkSelectAll');
  const idsOnPage = lastRenderedRows.map(f => f.id);
  const selectedOnPage = idsOnPage.filter(id => selectedIds.has(id)).length;
  if (selectAll) {
    selectAll.checked = idsOnPage.length > 0 && selectedOnPage === idsOnPage.length;
    selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < idsOnPage.length;
  }
  const bar = $('selBar');
  const btn = $('btnExport');
  if (selectedIds.size > 0) {
    bar.hidden = false;
    $('selCount').textContent = `${selectedIds.size} selected`;
    btn.textContent = `Export (${selectedIds.size})`;
  } else {
    bar.hidden = true;
    btn.textContent = 'Export';
  }
}

// Tag combobox options: union of findings' own history and the master line list, each paired
// with a location (for search) and a terminal (so the list can be scoped to whichever terminal
// is selected on the form — a KBY finding has no business suggesting an SRC tag). Findings supply
// the learned location (most recent wins); line-list-only tags show their service as the sub-line.
function buildTagOptions() {
  const byTag = new Map();
  // findings newest-first so the first location seen per tag is the most recent
  [...findings].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).forEach(f => {
    if (!f.pipe_tag) return;
    if (!byTag.has(f.pipe_tag)) byTag.set(f.pipe_tag, { location: f.location_desc || '', terminal: f.terminal || '' });
  });
  lineList.forEach(r => {
    if (!r.pipe_tag) return;
    if (!byTag.has(r.pipe_tag)) byTag.set(r.pipe_tag, { location: r.service || '', terminal: r.terminal || '' });
  });
  return [...byTag.entries()].map(([tag, o]) => ({ tag, location: o.location, terminal: o.terminal })).sort((a, b) => a.tag.localeCompare(b.tag));
}

function renderList() {
  renderKpis();
  const rows = sortFindings(applyFilters(findings));
  renderTable(rows);
  renderMap(rows);
}

/* ---------------- CSV export (filtered register, Excel-friendly UTF-8 BOM) ---------------- */

const CSV_COLS = [
  'terminal', 'pipe_tag', 'pid_no', 'service', 'location_desc', 'finding_type', 'severity',
  'status', 'description', 'vendor', 'report_no', 'report_link', 'inspection_date', 'method',
  't_nominal', 't_measured', 'defect_length_mm', 'defect_width_mm', 'lat', 'lng',
  'target_date', 'next_check_date', 'sap_notification', 'sap_order', 'estimated_cost',
  'repair_method', 'repaired_date', 'closing_note', 'created_by_email', 'created_at'
];

function exportCsv(rows, includeBudget) {
  if (!rows || !rows.length) { notify('Nothing to export with the current filters.', true); return; }
  // estimated_cost (budget) is emitted only when the export explicitly opted in
  const cols = includeBudget ? CSV_COLS : CSV_COLS.filter(c => c !== 'estimated_cost');
  const cell = (v) => {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = [
    cols.join(','),
    ...rows.map(f => cols.map(c => cell(f[c])).join(','))
  ];
  // \uFEFF BOM so Excel opens the file as UTF-8 (Thai text in descriptions survives)
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `findings_${todayISO().replace(/-/g, '')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  notify(`Exported ${rows.length} finding(s).`);
}

/* ---------------- Excel / CSV import ---------------- */

// Column template. header = spreadsheet column label; field = findings column; type coerces.
const IMPORT_COLS = [
  { header: 'Terminal', field: 'terminal', required: true },
  { header: 'Pipe Tag', field: 'pipe_tag', required: true },
  { header: 'P&ID No.', field: 'pid_no' },
  { header: 'Service', field: 'service' },
  { header: 'Location', field: 'location_desc' },
  { header: 'Finding Type', field: 'finding_type', required: true },
  { header: 'Severity', field: 'severity' },
  { header: 'Description', field: 'description' },
  { header: 'Vendor', field: 'vendor' },
  { header: 'Report No.', field: 'report_no' },
  { header: 'Report Link', field: 'report_link' },
  { header: 'Inspection Date', field: 'inspection_date', type: 'date' },
  { header: 'Method', field: 'method' },
  { header: 'Nominal Thickness (mm)', field: 't_nominal', type: 'num' },
  { header: 'Measured Thickness (mm)', field: 't_measured', type: 'num' },
  { header: 'Target Date', field: 'target_date', type: 'date' },
  { header: 'SAP Notification', field: 'sap_notification' },
  { header: 'SAP Order', field: 'sap_order' },
  { header: 'Latitude', field: 'lat', type: 'num' },
  { header: 'Longitude', field: 'lng', type: 'num' }
];

let importValidRows = []; // payloads ready to insert, set after a file is parsed+validated

const normHeader = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

function importHeaderMap() {
  const m = {};
  IMPORT_COLS.forEach(c => { m[normHeader(c.header)] = c; m[normHeader(c.field)] = c; });
  return m;
}

function resolveFindingType(v) {
  if (!v) return null;
  const n = normHeader(v);
  let hit = FINDING_TYPES.find(t => normHeader(t) === n);
  if (hit) return hit;
  const cands = FINDING_TYPES.filter(t => normHeader(t).includes(n) || n.includes(normHeader(t)));
  return cands.length === 1 ? cands[0] : null;
}

function toImportDate(v) {
  if (v == null || v === '') return null;
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d)) return undefined; // undefined = present but unparseable -> flagged
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toImportNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

// Validate one spreadsheet row (object keyed by original headers) -> { payload } or { reasons: [] }.
function validateImportRow(raw) {
  const map = importHeaderMap();
  const p = {};
  const reasons = [];
  for (const key of Object.keys(raw)) {
    const col = map[normHeader(key)];
    if (!col) continue; // unknown column -> ignored
    let val = raw[key];
    if (typeof val === 'string') val = val.trim();
    if (val === '' || val == null) continue;
    if (col.type === 'num') {
      const n = toImportNum(val);
      if (n === undefined) { reasons.push(`${col.header}: not a number`); continue; }
      p[col.field] = n;
    } else if (col.type === 'date') {
      const d = toImportDate(val);
      if (d === undefined) { reasons.push(`${col.header}: bad date`); continue; }
      p[col.field] = d;
    } else {
      p[col.field] = String(val);
    }
  }
  // required + domain checks
  const term = (p.terminal || '').toUpperCase();
  if (!['KBY', 'SRC', 'BRP'].includes(term)) reasons.push('Terminal must be KBY, SRC or BRP');
  else p.terminal = term;
  if (!p.pipe_tag) reasons.push('Pipe Tag is required');
  const ft = resolveFindingType(p.finding_type);
  if (!ft) reasons.push('Finding Type unrecognized');
  else p.finding_type = ft;
  if (p.severity) {
    const sev = { low: 'Low', medium: 'Medium', high: 'High' }[String(p.severity).toLowerCase()];
    if (sev) p.severity = sev; else delete p.severity; // silently drop unknown severity
  }
  return reasons.length ? { reasons } : { payload: p };
}

function renderImportPreview(results) {
  const valid = results.filter(r => r.payload);
  const invalid = results.filter(r => r.reasons);
  importValidRows = valid.map(r => r.payload);
  const box = $('importPreview');
  box.style.display = 'block';
  const head = `<div class="import-summary"><span class="ok">${valid.length} ready</span> · <span class="bad">${invalid.length} with problems</span> (of ${results.length} rows)</div>`;
  const rowsHtml = results.slice(0, 40).map((r, i) => {
    const ok = !!r.payload;
    const p = r.payload || {};
    return `<tr class="${ok ? '' : 'bad'}">
      <td class="${ok ? 'rowstat-ok' : 'rowstat-bad'}">${ok ? '✓' : '✕'}</td>
      <td>${esc(p.terminal || '—')}</td>
      <td>${esc(p.pipe_tag || '—')}</td>
      <td>${esc(p.finding_type || '—')}</td>
      <td class="import-reason">${ok ? '' : esc(r.reasons.join('; '))}</td>
    </tr>`;
  }).join('');
  box.innerHTML = head +
    `<div class="import-tbl-scroll"><table class="import-tbl"><thead><tr><th></th><th>Terminal</th><th>Pipe Tag</th><th>Finding Type</th><th>Problems</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` +
    (results.length > 40 ? `<div class="hint">Showing first 40 of ${results.length} rows.</div>` : '');
  $('importConfirm').disabled = valid.length === 0;
  $('importConfirm').textContent = valid.length ? `Import ${valid.length} finding(s)` : 'Import';
}

async function parseImportFile(file) {
  await ensureXLSX();
  $('errImport').style.display = 'none';
  importValidRows = [];
  $('importConfirm').disabled = true;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) { $('errImport').textContent = 'No rows found in the first sheet.'; $('errImport').style.display = 'block'; return; }
    renderImportPreview(rows.map(validateImportRow));
  } catch (e) {
    $('errImport').textContent = 'Could not read the file: ' + e.message;
    $('errImport').style.display = 'block';
  }
}

async function doImport() {
  if (!importValidRows.length) return;
  const btn = $('importConfirm');
  setBusy(btn, true, 'Importing…');
  try {
    const { data, error } = await sb.from('findings').insert(importValidRows).select('id');
    if (error) throw error;
    // opening history entry for each imported finding (insert order is preserved)
    const hist = (data || []).map(r => ({ finding_id: r.id, old_status: null, new_status: 'Open', note: 'Imported from spreadsheet' }));
    if (hist.length) await sb.from('status_history').insert(hist);
    closeDialog($('importDlg'));
    notify(`Imported ${data.length} finding(s).`);
    await loadFindings();
    renderList();
  } catch (e) {
    $('errImport').textContent = 'Import failed: ' + e.message;
    $('errImport').style.display = 'block';
  } finally {
    setBusy(btn, false);
  }
}

async function downloadImportTemplate() {
  await ensureXLSX();
  const headers = IMPORT_COLS.map(c => c.header);
  const example = ['KBY', '953-P-0001-10"-D1101-N', '15-3-KBY-906-0117_Rev.Z2', 'Diesel B7',
    'Elbow downstream of P-101', 'External Corrosion', 'High', 'Severe external corrosion at extrados',
    'ABC Inspection Co.', 'RPT-2026-014', 'https://pttor.sharepoint.com/…', '2026-06-20', 'UT',
    9.27, 5.4, '2026-08-01', '10012345', '40012345', 13.097720, 100.887211];
  const ws = XLSX.utils.aoa_to_sheet([headers, example]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Findings');
  XLSX.writeFile(wb, 'findings_import_template.xlsx');
}

function openImportDialog() {
  ensureXLSX(); // preload the spreadsheet lib while the dialog is open
  $('importFile').value = '';
  $('importPreview').style.display = 'none';
  $('importPreview').innerHTML = '';
  $('errImport').style.display = 'none';
  importValidRows = [];
  $('importConfirm').disabled = true;
  $('importConfirm').textContent = 'Import';
  openDialog($('importDlg'));
}

/* ===================== Master line list (import + prefill) =====================
   A maintained pipe-tag -> NPS/schedule/material + P&ID/service/location reference,
   imported from Excel/CSV (same UX pattern as the findings import above, kept as a
   parallel set of functions rather than threading a mode flag through the findings-
   import pipeline — that pipeline is tightly coupled to the findings table shape
   (terminal/finding_type checks, a status_history side-insert), which a second table
   doesn't need. Only the table-agnostic helpers (normHeader/toImportNum/toImportDate)
   are reused as-is. Used by applyTagMemory() to pre-fill a brand-new tag that has never
   appeared on a finding before. */

const LINE_LIST_IMPORT_COLS = [
  { header: 'Pipe Tag', field: 'pipe_tag', required: true },
  { header: 'Terminal', field: 'terminal' },
  { header: 'NPS', field: 'nps', required: true },
  { header: 'Schedule', field: 'schedule', required: true },
  { header: 'Material', field: 'material', required: true },
  { header: 'P&ID No.', field: 'pid_no' },
  { header: 'Service', field: 'service' }
];

let lineListValidRows = [];  // payloads ready to upsert, set after a file is parsed+validated

function lineListHeaderMap() {
  const m = {};
  LINE_LIST_IMPORT_COLS.forEach(c => { m[normHeader(c.header)] = c; m[normHeader(c.field)] = c; });
  return m;
}

// NPS is a precise engineering value fed straight into computeB313 — unlike
// resolveFindingType's substring fallback, this is exact-match only (normalized for
// whitespace/inch-marker variance); a wrong silent match would produce actively
// incorrect wall-thickness math.
function resolveNps(v) {
  if (!v) return null;
  let s = String(v).trim().replace(/\s+in(ch(es)?)?\.?$/i, '').replace(/"$/, '').trim();
  const candidate = s + '"';
  if (PA_PIPE_DATABASE[candidate]) return candidate;
  const stripped = s.replace(/\s+/g, '');
  const hit = Object.keys(PA_PIPE_DATABASE).find(k => k.replace(/\s+/g, '').replace(/"$/, '') === stripped);
  return hit || null;
}

// Schedules are NPS-scoped — only call once resolveNps has already succeeded for the row.
function resolveSchedule(nps, v) {
  if (!v || !PA_PIPE_DATABASE[nps]) return null;
  const s = String(v).trim().replace(/^sch\.?\s*/i, '').toUpperCase();
  const schedules = PA_PIPE_DATABASE[nps].schedules;
  return Object.keys(schedules).find(k => k.toUpperCase() === s) || null;
}

// Match against PA_MATERIALS[].code first (exact, case-insensitive), then fall back to
// PA_MATERIALS[].name via the same loose normHeader-based comparison validateImportRow
// already uses — a line list is more likely to carry a human material description
// ("API 5L Gr. B") than the internal code. Never implicitly matches 'MANUAL'.
function resolveMaterialCode(v) {
  if (!v) return null;
  const s = String(v).trim();
  const byCode = PA_MATERIALS.find(m => m.code.toLowerCase() === s.toLowerCase() && m.code !== 'MANUAL');
  if (byCode) return byCode.code;
  const n = normHeader(s);
  const byName = PA_MATERIALS.find(m => m.code !== 'MANUAL' &&
    (normHeader(m.name) === n || normHeader(m.name).includes(n) || n.includes(normHeader(m.name))));
  return byName ? byName.code : null;
}

// Validate one spreadsheet row (object keyed by original headers) -> { payload } or { reasons: [] }.
function validateLineListRow(raw) {
  const map = lineListHeaderMap();
  const p = {};
  const reasons = [];
  for (const key of Object.keys(raw)) {
    const col = map[normHeader(key)];
    if (!col) continue;
    let val = raw[key];
    if (typeof val === 'string') val = val.trim();
    if (val === '' || val == null) continue;
    p[col.field] = String(val);
  }
  if (!p.pipe_tag) reasons.push('Pipe Tag is required');
  if (p.terminal) {
    const term = p.terminal.toUpperCase();
    if (!['KBY', 'SRC', 'BRP'].includes(term)) reasons.push('Terminal must be KBY, SRC or BRP');
    else p.terminal = term;
  }
  const nps = resolveNps(p.nps);
  if (!nps) reasons.push(`NPS "${p.nps || ''}" not recognized`);
  else p.nps = nps;
  if (nps) {
    const sch = resolveSchedule(nps, p.schedule);
    if (!sch) reasons.push(`Schedule "${p.schedule || ''}" not valid for NPS ${nps}`);
    else p.schedule = sch;
  }
  const mat = resolveMaterialCode(p.material);
  if (!mat) reasons.push(`Material "${p.material || ''}" not recognized`);
  else p.material = mat;
  return reasons.length ? { reasons } : { payload: p };
}

function renderLineListImportPreview(results) {
  const valid = results.filter(r => r.payload);
  const invalid = results.filter(r => r.reasons);
  lineListValidRows = valid.map(r => r.payload);
  const box = $('lineListImportPreview');
  box.style.display = 'block';
  const head = `<div class="import-summary"><span class="ok">${valid.length} ready</span> · <span class="bad">${invalid.length} with problems</span> (of ${results.length} rows)</div>`;
  const rowsHtml = results.slice(0, 40).map((r) => {
    const ok = !!r.payload;
    const p = r.payload || {};
    return `<tr class="${ok ? '' : 'bad'}">
      <td class="${ok ? 'rowstat-ok' : 'rowstat-bad'}">${ok ? '✓' : '✕'}</td>
      <td>${esc(p.pipe_tag || '—')}</td>
      <td>${esc(p.terminal || '—')}</td>
      <td>${esc(p.nps || '—')}</td>
      <td>${esc(p.schedule || '—')}</td>
      <td>${esc(p.material || '—')}</td>
      <td class="import-reason">${ok ? '' : esc(r.reasons.join('; '))}</td>
    </tr>`;
  }).join('');
  box.innerHTML = head +
    `<div class="import-tbl-scroll"><table class="import-tbl"><thead><tr><th></th><th>Pipe Tag</th><th>Terminal</th><th>NPS</th><th>Schedule</th><th>Material</th><th>Problems</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` +
    (results.length > 40 ? `<div class="hint">Showing first 40 of ${results.length} rows.</div>` : '');
  $('lineListImportConfirm').disabled = valid.length === 0;
  $('lineListImportConfirm').textContent = valid.length ? `Import ${valid.length} entr${valid.length === 1 ? 'y' : 'ies'}` : 'Import';
}

async function parseLineListImportFile(file) {
  await ensureXLSX();
  $('errLineListImport').style.display = 'none';
  lineListValidRows = [];
  $('lineListImportConfirm').disabled = true;
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) { $('errLineListImport').textContent = 'No rows found in the first sheet.'; $('errLineListImport').style.display = 'block'; return; }
    renderLineListImportPreview(rows.map(validateLineListRow));
  } catch (e) {
    $('errLineListImport').textContent = 'Could not read the file: ' + e.message;
    $('errLineListImport').style.display = 'block';
  }
}

async function doLineListImport() {
  if (!lineListValidRows.length) return;
  const btn = $('lineListImportConfirm');
  setBusy(btn, true, 'Importing…');
  try {
    const { data, error } = await sb.from('line_list')
      .upsert(lineListValidRows, { onConflict: 'pipe_tag' }).select('id');
    if (error) throw error;
    closeDialog($('lineListImportDlg'));
    notify(`Imported ${data.length} line list entr${data.length === 1 ? 'y' : 'ies'}.`);
    await loadLineList();
    if ($('lineListManageDlg').open) renderLineListManageTable();
  } catch (e) {
    $('errLineListImport').textContent = 'Import failed: ' + e.message;
    $('errLineListImport').style.display = 'block';
  } finally {
    setBusy(btn, false);
  }
}

async function downloadLineListTemplate() {
  await ensureXLSX();
  const headers = LINE_LIST_IMPORT_COLS.map(c => c.header);
  // Several worked rows spanning different NPS/Schedule/Material combos — Pipe Tag/Terminal/
  // P&ID/Service are free text (any value is fine); NPS/Schedule/Material must match one of the
  // exact spellings on the "Valid Values" sheet below.
  const examples = [
    ['953-P-0001-10"-D1101-N', 'KBY', '10"', '40', 'A106B', '15-3-KBY-906-0117_Rev.Z2', 'Diesel B7'],
    ['906200-P-6"-D311011-N', 'KBY', '6"', '80', 'API5LB', '', 'Jet A-1'],
    ['953-P-009-4"-D1101-ET-80', 'SRC', '4"', '40', 'X52', '', ''],
    ['906200-25-P-4404', 'BRP', '2"', '40', 'TP316', '', '']
  ];
  const lineListWs = XLSX.utils.aoa_to_sheet([headers, ...examples]);

  // Reference sheet: every valid NPS (with its valid schedules) and every valid material
  // (name + the shorter code, either spelling is accepted) — generated live from the same
  // PA_PIPE_DATABASE/PA_MATERIALS the engine and resolveNps/resolveSchedule/resolveMaterialCode
  // validate against, so this can never drift out of sync with what actually gets accepted.
  const npsRows = [['NPS', 'Valid Schedules']];
  Object.keys(PA_PIPE_DATABASE).forEach(nps => {
    npsRows.push([nps, Object.keys(PA_PIPE_DATABASE[nps].schedules).join(', ')]);
  });
  npsRows.push([]);
  npsRows.push(['Material Name', 'Material Code']);
  PA_MATERIALS.filter(m => m.code !== 'MANUAL').forEach(m => npsRows.push([m.name, m.code]));
  const valuesWs = XLSX.utils.aoa_to_sheet(npsRows);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, lineListWs, 'Line List');
  XLSX.utils.book_append_sheet(wb, valuesWs, 'Valid Values');
  XLSX.writeFile(wb, 'line_list_import_template.xlsx');
}

function openLineListImportDialog() {
  ensureXLSX(); // preload the spreadsheet lib while the dialog is open
  $('lineListImportFile').value = '';
  $('lineListImportPreview').style.display = 'none';
  $('lineListImportPreview').innerHTML = '';
  $('errLineListImport').style.display = 'none';
  lineListValidRows = [];
  $('lineListImportConfirm').disabled = true;
  $('lineListImportConfirm').textContent = 'Import';
  openDialog($('lineListImportDlg'));
}

// Loads the master list into memory; called once during the list route's initial data load
// and again after a successful import. Lazy-loaded defensively inside applyTagMemory() too,
// since #/new and #/edit/ can be reached without visiting #/list first (see route()).
// PostgREST silently caps any unlimited select() at 1000 rows server-side — page through in
// 1000-row batches so a line list larger than that isn't quietly truncated (missing tags in the
// combobox / management dialog, with no error to explain why).
async function loadLineList() {
  const PAGE = 1000;
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from('line_list').select('*').order('pipe_tag').range(from, from + PAGE - 1);
    if (error) { notify('Failed to load line list: ' + error.message, true); return; }
    all = all.concat(data || []);
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  lineList = all;
}

function renderLineListManageTable() {
  const body = $('lineListTableBody');
  const q = ($('lineListSearch').value || '').trim().toLowerCase();
  const rows = q ? lineList.filter(r =>
    [r.pipe_tag, r.terminal, r.nps, r.schedule, r.material, r.pid_no, r.service]
      .some(v => (v || '').toLowerCase().includes(q))
  ) : lineList;

  if (!lineList.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="8">No line list entries yet — click Import to add some.</td></tr>`;
  } else if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="8">No entries match "${esc(q)}".</td></tr>`;
  } else {
    body.innerHTML = rows.map(r => `<tr data-id="${esc(r.id)}">
      <td>${esc(r.pipe_tag)}</td><td>${esc(r.terminal || '—')}</td><td>${esc(r.nps || '—')}</td><td>${esc(r.schedule || '—')}</td>
      <td>${esc(r.material || '—')}</td><td>${esc(r.pid_no || '—')}</td>
      <td>${esc(r.service || '—')}</td>
      <td><button type="button" class="link-btn" data-del="${esc(r.id)}">Delete</button></td>
    </tr>`).join('');
    body.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => deleteLineListRow(btn.dataset.del)));
  }
  $('lineListCount').textContent = q && rows.length !== lineList.length
    ? `${rows.length} of ${lineList.length} entr${lineList.length === 1 ? 'y' : 'ies'}`
    : `${lineList.length} entr${lineList.length === 1 ? 'y' : 'ies'}`;
}

async function deleteLineListRow(id) {
  const row = lineList.find(r => r.id === id);
  if (!window.confirm(`Delete line list entry "${row ? row.pipe_tag : ''}"?`)) return;
  try {
    const { error } = await sb.from('line_list').delete().eq('id', id);
    if (error) throw error;
    lineList = lineList.filter(r => r.id !== id);
    renderLineListManageTable();
    notify('Line list entry deleted.');
  } catch (e) { notify('Delete failed: ' + e.message, true); }
}

function openLineListManageDialog() {
  $('lineListSearch').value = '';
  renderLineListManageTable();
  openDialog($('lineListManageDlg'));
}

/* ---------------- form (new / edit) ---------------- */

function clearValidation() {
  ['fTerminal', 'fLocationDesc', 'fType'].forEach(id => $(id).removeAttribute('aria-invalid'));
  ['errTerminal', 'errLocationDesc', 'errType'].forEach(id => $(id).style.display = 'none');
}

function setPin(lat, lng, recenter) {
  $('fLat').value = lat.toFixed(6);
  $('fLng').value = lng.toFixed(6);
  if (pickMap && typeof L !== 'undefined') {
    if (!pickMarker) pickMarker = L.marker([lat, lng]).addTo(pickMap);
    else pickMarker.setLatLng([lat, lng]);
    if (recenter) pickMap.setView([lat, lng], Math.max(pickMap.getZoom(), 16));
  }
}

function clearPin() {
  $('fLat').value = '';
  $('fLng').value = '';
  if (pickMarker && pickMap) { pickMap.removeLayer(pickMarker); pickMarker = null; }
}

function ensurePickMap() {
  const el = $('fMap');
  if (typeof L === 'undefined') {
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.fontSize = '11px';
    el.style.color = 'var(--text-light)';
    el.textContent = 'Map unavailable — enter coordinates manually.';
    return;
  }
  if (pickMap) { setTimeout(() => pickMap.invalidateSize(), 80); return; }
  pickMap = L.map(el, { center: DEFAULT_MAP_VIEW.center, zoom: DEFAULT_MAP_VIEW.zoom, scrollWheelZoom: true });
  L.tileLayer(SAT_TILES.url, { maxZoom: SAT_TILES.maxZoom, attribution: SAT_TILES.attribution }).addTo(pickMap);
  pickMap.on('click', (e) => setPin(e.latlng.lat, e.latlng.lng, false));
  setTimeout(() => pickMap.invalidateSize(), 150);
}

function renderPendingGrid() {
  const grid = $('pendingPhotoGrid');
  grid.innerHTML = pendingPhotos.map((p, i) =>
    `<div class="photo-thumb">
       <img src="${p.previewUrl}" alt="Pending photo">
       <button type="button" class="photo-remove" data-i="${i}" title="Remove">&#215;</button>
     </div>`).join('');
  $('pendingPhotoEmpty').style.display = pendingPhotos.length ? 'none' : 'block';
  grid.querySelectorAll('.photo-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingPhotos.splice(Number(btn.dataset.i), 1);
      renderPendingGrid();
    });
  });
  const addBtn = $('btnAddPendingPhoto');
  const atLimit = pendingPhotos.length >= PHOTO_LIMIT_PER_KIND;
  addBtn.disabled = atLimit;
  addBtn.textContent = atLimit ? `Max ${PHOTO_LIMIT_PER_KIND} reached` : `+ Add photos (${pendingPhotos.length}/${PHOTO_LIMIT_PER_KIND})`;
}

// Queue as-found photos on the new-finding form (downscaled preview held in memory until save).
async function addPendingFiles(files) {
  const room = Math.max(0, PHOTO_LIMIT_PER_KIND - pendingPhotos.length);
  if (room <= 0) {
    notify(`Limit reached: ${PHOTO_LIMIT_PER_KIND} As Found photos max.`, true);
    return 0;
  }
  const toQueue = files.filter(f => f.type && f.type.startsWith('image/')).slice(0, room);
  let n = 0;
  for (const file of toQueue) {
    try {
      const previewUrl = await downscaleImage(file, 480, 0.7);
      pendingPhotos.push({ file, previewUrl });
      n++;
    } catch (err) { console.warn('preview failed', err); }
  }
  renderPendingGrid();
  if (files.length > toQueue.length) {
    notify(`${n} photo(s) queued (${files.length - toQueue.length} skipped — ${PHOTO_LIMIT_PER_KIND} max reached).`, true);
  }
  return n;
}

// Which detail-page photo group a Ctrl+V paste targets (set when a group's "+ Add" is used).
let photoPasteTarget = 'found';

// Extract image files from a clipboard/DataTransfer; [] when the paste is plain text.
function imageFilesFromClipboard(dt) {
  const out = [];
  if (!dt || !dt.items) return out;
  for (const it of dt.items) {
    if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

async function onPastePhoto(e) {
  if (!session) return;
  const files = imageFilesFromClipboard(e.clipboardData);
  if (!files.length) return; // not an image paste — let normal text paste happen
  if ($('viewForm').classList.contains('active')) {
    e.preventDefault();
    if (editingId) {
      addDetailPhotos(files, photoPasteTarget, editingId); // shows its own progress/result toast
    } else {
      const n = await addPendingFiles(files);
      if (n && n === files.length) notify(n + ' photo(s) pasted.');
    }
  } else if ($('viewDetail').classList.contains('active') && current) {
    e.preventDefault();
    addDetailPhotos(files, photoPasteTarget); // shows its own progress/result toast
  }
}

/* ---------------- inline ASME B31.3 assessment (combined into the finding form) ---------------- */

// Finding types where a UT reading is inherently expected — used only for the Corrosion Type
// prefill below. Kept separate from AUTO_ASSESS_TYPES: CUI/CUS still map to a sensible corrosion
// type if the user manually turns the assessment on, even though it no longer auto-enables.
const WALL_LOSS_TYPES = ['External Corrosion', 'Internal Corrosion', 'CUI (Corrosion Under Insulation)', 'CUS (Corrosion Under Support)'];

// Finding types that auto-enable the assessment panel. Deliberately excludes CUI/CUS — under
// insulation/supports a thickness reading usually isn't available at the time the finding is
// first logged (needs insulation/support removal to inspect), so auto-opening the assessment
// there was more often wrong than helpful. The user can still turn it on manually for those types.
const AUTO_ASSESS_TYPES = ['External Corrosion', 'Internal Corrosion'];

// The finding type dictates whether the wall loss is internal or external, so the assessment's
// Corrosion Type follows it automatically (CUI/CUS are external-surface mechanisms).
const CORR_TYPE_BY_FINDING = {
  'External Corrosion': 'external',
  'Internal Corrosion': 'internal',
  'CUI (Corrosion Under Insulation)': 'external',
  'CUS (Corrosion Under Support)': 'external'
};
function syncCorrTypeFromFinding() {
  const c = CORR_TYPE_BY_FINDING[$('fType').value];
  if (c) $('aCorrType').value = c;
}

// Sensible starting severity by finding type, shown before any assessment has run — the user
// can always override it (severityTouched short-circuits every auto-suggestion below once set).
// Corrosion/CUI/CUS start at Medium since the real severity depends on the reading, which isn't
// known yet; Leak is High as a safety-relevant default; cosmetic coating damage starts Low.
const SEVERITY_BY_FINDING = {
  'External Corrosion': 'Medium',
  'Internal Corrosion': 'Medium',
  'CUI (Corrosion Under Insulation)': 'Medium',
  'CUS (Corrosion Under Support)': 'Medium',
  'Coating / Painting Damage': 'Low',
  'Pipe Support Defect': 'Medium',
  'Leak': 'High',
  'Dent / Mechanical Damage': 'Medium'
};
function suggestSeverityFromType() {
  if (severityTouched) return;
  const sev = SEVERITY_BY_FINDING[$('fType').value];
  if (!sev) return;
  $('fSeverity').value = sev;
}

let assessResult = null;   // last valid computeB313 result, or null
let severityTouched = false; // user manually picked a severity -> stop auto-suggesting
let lastLoadedAssessInputs = null; // JSON of the restored assessment (edit) -> dedupe on save

function aMode() {
  const b = document.querySelector('#aModeSeg .seg-btn.active');
  return b ? b.dataset.mode : 'tmeas';
}

function setAssessOn(on) {
  $('assessPanel').classList.toggle('on', on);
  $('aToggle').checked = on;
  if (on) recalcAssessment();
}

function updateAschedules(keepValue) {
  const nps = $('aNps').value;
  const pipe = PA_PIPE_DATABASE[nps];
  if (!pipe) return;
  const prev = $('aSch').value;
  $('aSch').innerHTML = Object.keys(pipe.schedules)
    .map(s => `<option value="${s}">${pipe.schedules[s].label}</option>`).join('');
  const def = paDefaultScheduleForNps(nps);
  $('aSch').value = (keepValue && pipe.schedules[prev]) ? prev : (pipe.schedules[def] ? def : Object.keys(pipe.schedules)[0]);
  autofillAtnom();
}

function autofillAtnom() {
  const pipe = PA_PIPE_DATABASE[$('aNps').value];
  const sch = pipe && pipe.schedules[$('aSch').value];
  if (sch) $('aTnom').value = sch.t;
}

function applyMaterialStress() {
  const m = PA_MATERIALS.find(x => x.code === $('aMat').value);
  if (m && m.stress !== null) { $('aS').value = m.stress; $('aS').disabled = true; }
  else { $('aS').disabled = false; }
}

function gatherAssessParams() {
  return {
    nps: $('aNps').value, sch: $('aSch').value,
    overrideTnom: $('aTnom').value, overrideOd: '',
    mode: aMode(), depth: $('aDepth').value, tmeas: $('aTmeas').value,
    ca: $('aCa').value, pInput: $('aP').value, pUnit: $('aPUnit').value,
    S: $('aS').value, E: $('aE').value, W: $('aW').value, Y: $('aY').value, CR: $('aCr').value,
    matCode: $('aMat').value, isInternal: $('aCorrType').value === 'internal'
  };
}

// best-effort thickness for the finding record, even if the full calc can't run (no pressure yet)
function assessThickness() {
  const pipe = PA_PIPE_DATABASE[$('aNps').value];
  const schT = pipe && pipe.schedules[$('aSch').value] ? pipe.schedules[$('aSch').value].t : null;
  const tnom = $('aTnom').value !== '' ? Number($('aTnom').value) : schT;
  let tmeas = null;
  if (aMode() === 'tmeas') {
    if ($('aTmeas').value !== '') tmeas = Number($('aTmeas').value);
  } else if ($('aDepth').value !== '' && tnom != null) {
    tmeas = Math.max(0, tnom - Number($('aDepth').value));
  }
  return { t_nom: tnom, t_meas: tmeas };
}

// The form's live workbench instance (paCreateAssessView), created in initAssessment().
let awFormView = null;

function recalcAssessment() {
  if (!$('assessPanel').classList.contains('on')) { assessResult = null; return; }
  const res = computeB313(gatherAssessParams());
  const hint = $('aCalcHint');
  if (res.hasErrors) {
    assessResult = null;
    // Distinguish "not filled in yet" (neutral banner, no red) from "typed something invalid"
    // (ERROR banner + targeted message) — same cold-load rule the calculator used. (CA >= t_meas
    // is no longer an error — a thin wall below its reserve is a valid case; only ca < 0 errors.)
    const readingEmpty = aMode() === 'tmeas' ? $('aTmeas').value === '' : $('aDepth').value === '';
    const msg = (res.errors.tmeas || res.errors.depth) && !readingEmpty ? 'Check the UT reading (cannot exceed nominal thickness).'
      : (res.errors.ca && !readingEmpty) ? (typeof res.errors.ca === 'string' ? res.errors.ca : 'Check the corrosion allowance.')
      : (res.errors.P && $('aP').value !== '') ? 'Design pressure must be positive.'
      : res.errors.overrideTnom ? 'Check the nominal thickness.'
      : (res.errors.S && $('aS').value !== '') ? 'Allowable stress S must be positive.'
      : '';
    hint.style.display = msg ? 'block' : 'none';
    hint.textContent = msg;
    if (awFormView) awFormView.render(res, { neutral: !msg, nps: $('aNps').value });
    return;
  }
  assessResult = res;
  hint.style.display = 'none';
  if (awFormView) awFormView.render(res, { nps: $('aNps').value });

  // auto-suggest severity from the result unless the user has set it themselves — the assessment
  // result is more precise than the finding-type prefill (suggestSeverityFromType), so it wins
  // whenever it's available.
  if (!severityTouched) {
    const sev = res.status === 'OK' ? 'Low' : res.status === 'MONITOR' ? 'Medium' : 'High';
    $('fSeverity').value = sev;
  }
}

// Restore assessment fields from a saved assessment.inputs object. If skipReading, leave the
// tmeas/depth blank (used by per-tag memory: reuse the pipe setup, not the old measurement).
function loadAssessmentInto(inp, skipReading) {
  if (!inp) return;
  if (inp.nps && PA_PIPE_DATABASE[inp.nps]) { $('aNps').value = inp.nps; updateAschedules(false); }
  if (inp.schedule) { $('aSch').value = inp.schedule; autofillAtnom(); }
  if (inp.material) { $('aMat').value = inp.material; applyMaterialStress(); }
  if (inp.S != null && inp.S !== '') $('aS').value = inp.S;
  if (inp.design_temp != null) $('aTemp').value = inp.design_temp;
  if (inp.P != null) $('aP').value = inp.P;
  if (inp.p_unit) $('aPUnit').value = inp.p_unit;
  if (inp.ca != null) $('aCa').value = inp.ca;
  if (inp.corr_type) $('aCorrType').value = inp.corr_type;
  if (inp.cr != null) $('aCr').value = inp.cr;
  if (inp.E != null) $('aE').value = inp.E;
  if (inp.W != null) $('aW').value = inp.W;
  if (inp.Y != null) $('aY').value = inp.Y;
  if (inp.override_tnom != null && inp.override_tnom !== '') $('aTnom').value = inp.override_tnom;
  if (!skipReading) {
    const m = inp.mode === 'depth' ? 'depth' : 'tmeas';
    document.querySelectorAll('#aModeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    positionSegPill($('aModeSeg'), false);
    $('aTmeasGrp').style.display = m === 'tmeas' ? 'block' : 'none';
    $('aDepthGrp').style.display = m === 'depth' ? 'block' : 'none';
    if (inp.tmeas != null) $('aTmeas').value = inp.tmeas;
    if (inp.depth != null) $('aDepth').value = inp.depth;
  }
}

function resetAssessment() {
  $('aNps').value = '4"';
  updateAschedules(false);
  $('aMat').value = 'API5LB'; // default line-pipe material
  applyMaterialStress();
  $('aTemp').value = '';
  $('aP').value = '';
  $('aPUnit').value = 'bar';
  $('aCa').value = '1.5';
  $('aCorrType').value = 'external';
  $('aCr').value = '';
  $('aE').value = '1.0'; $('aW').value = '1.0'; $('aY').value = '0.4';
  $('aTmeas').value = ''; $('aDepth').value = '';
  document.querySelectorAll('#aModeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'depth'));
  positionSegPill($('aModeSeg'), false);
  $('aTmeasGrp').style.display = 'none';
  $('aDepthGrp').style.display = 'block';
  autofillAtnom();
  assessResult = null;
  $('aCalcHint').style.display = 'none';
  if (awFormView) awFormView.render(null, { neutral: true });
}

function initAssessment() {
  $('aNps').innerHTML = Object.keys(PA_PIPE_DATABASE).map(n => `<option>${n}</option>`).join('');
  $('aMat').innerHTML = PA_MATERIALS.map(m => `<option value="${m.code}">${m.name}</option>`).join('');

  // Full workbench under the inputs (advisor + equations ship collapsed to keep the column
  // scannable). The drag handle writes back into whichever reading field is active.
  awFormView = paCreateAssessView($('awForm'), {
    sections: ['status', 'svg', 'results', 'advisor', 'equations', 'scope'],
    collapsed: ['advisor', 'equations'],
    onDepthDrag: (depth_mm) => {
      if (!assessResult) return;
      if (aMode() === 'depth') {
        $('aDepth').value = depth_mm.toFixed(2);
      } else {
        $('aTmeas').value = (assessResult.t_nom - depth_mm).toFixed(2);
      }
      recalcAssessment();
    }
  });
  awFormView.render(null, { neutral: true });

  $('aToggle').addEventListener('change', () => setAssessOn($('aToggle').checked));
  $('aNps').addEventListener('change', () => { updateAschedules(false); recalcAssessment(); });
  $('aSch').addEventListener('change', () => { autofillAtnom(); recalcAssessment(); });
  $('aMat').addEventListener('change', () => { applyMaterialStress(); recalcAssessment(); });
  document.querySelectorAll('#aModeSeg .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#aModeSeg .seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      positionSegPill($('aModeSeg'), true);
      const m = btn.dataset.mode;
      $('aTmeasGrp').style.display = m === 'tmeas' ? 'block' : 'none';
      $('aDepthGrp').style.display = m === 'depth' ? 'block' : 'none';
      recalcAssessment();
    });
  });
  ['aTnom', 'aTmeas', 'aDepth', 'aCa', 'aP', 'aPUnit', 'aCorrType', 'aS', 'aTemp', 'aE', 'aW', 'aY', 'aCr']
    .forEach(id => $(id).addEventListener('input', recalcAssessment));

  $('fType').addEventListener('change', () => {
    // corrosion type follows the finding type
    syncCorrTypeFromFinding();
    // auto-enable the assessment for types where a UT reading is normally already on hand
    // (only when creating, and only if the user hasn't already turned it on/off deliberately for
    // this finding) — CUI/CUS are deliberately excluded, see AUTO_ASSESS_TYPES.
    if (!editingId && !assessToggleTouched) {
      setAssessOn(AUTO_ASSESS_TYPES.includes($('fType').value));
    }
    suggestSeverityFromType();
    recalcAssessment();
  });
  $('aToggle').addEventListener('change', () => { assessToggleTouched = true; });

  $('fSeverity').addEventListener('change', () => {
    severityTouched = true;
  });
}

let assessToggleTouched = false;

// Per-tag memory: reuse metadata + pipe setup from the last finding with the same tag, falling
// back to the master line list for tags that have never appeared on a finding before. A prior
// finding's own recorded assessment always wins over the line list — it reflects what an
// engineer actually measured and verified for that tag (possibly correcting a stale master-list
// entry), while the line list is a bulk-imported, unverified-per-row reference. Metadata fields
// combine both sources under the same fill-only-if-empty rule rather than picking one source
// exclusively, so a partially-known prior finding can still pick up whatever the line list has
// that it doesn't.
async function applyTagMemory() {
  if (editingId) return; // only when creating
  const tag = $('fTag').value.trim();
  if (!tag) return;
  if (!lineList.length) await loadLineList(); // lazy-load: #/new is reachable without #/list first
  const lineRow = lineList.find(r => r.pipe_tag === tag);
  const prior = findings.filter(f => f.pipe_tag === tag)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  // metadata: prior finding first, then whatever the line list has that's still empty
  const last = prior[0];
  if (last) {
    if (!$('fPid').value && last.pid_no) $('fPid').value = last.pid_no;
    if (!$('fService').value && last.service) $('fService').value = last.service;
    if (!$('fLocationDesc').value && last.location_desc) $('fLocationDesc').value = last.location_desc;
  }
  if (lineRow) {
    if (!$('fPid').value && lineRow.pid_no) $('fPid').value = lineRow.pid_no;
    if (!$('fService').value && lineRow.service) $('fService').value = lineRow.service;
    if (!$('fTerminal').value && lineRow.terminal) $('fTerminal').value = lineRow.terminal;
  }

  // engineering setup: prior finding's own assessment wins; line list is the fallback
  if (prior.length) {
    try {
      const ids = prior.map(f => f.id);
      const { data } = await sb.from('assessments').select('inputs, created_at')
        .in('finding_id', ids).order('created_at', { ascending: false }).limit(1);
      if (data && data.length) {
        if (!$('assessPanel').classList.contains('on')) setAssessOn(true);
        loadAssessmentInto(data[0].inputs, true); // reuse pipe setup, not the old reading
        recalcAssessment();
        notify('Pre-filled pipe data from a previous finding on this tag.');
        return;
      }
    } catch (e) { /* memory is best-effort */ }
  }
  if (lineRow && lineRow.nps) {
    if (!$('assessPanel').classList.contains('on')) setAssessOn(true);
    loadAssessmentInto({ nps: lineRow.nps, schedule: lineRow.schedule, material: lineRow.material }, true);
    recalcAssessment();
    notify('Pre-filled pipe data from the master line list.');
  }
}

// Searchable combobox for #fTag: options come from buildTagOptions() (tag + learned location +
// terminal), typing filters on tag OR location so a location-only search finds the tag, and the
// list is scoped to whichever Terminal is currently selected (a KBY finding has no business
// suggesting an SRC tag) — tags with no known terminal (never seen on a finding or line-list row)
// still show, since scoping them out would just hide legitimately unknown tags. Free text is
// always preserved (it's a plain <input>); selecting an option fires a native `change` so
// applyTagMemory runs. Keeps #fTag as the source of truth — collectForm still just reads its .value.
const TAG_COMBO_MAX = 50; // raised from 20 so a large tag list doesn't hide likely matches

function initTagCombo() {
  const input = $('fTag');
  const menu = $('tagCombo');
  let items = [];   // current filtered [{tag, location, terminal}]
  let active = -1;  // highlighted index

  const close = () => { menu.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };

  // position:fixed menu — escape .panel's overflow:hidden (see the .combo-menu CSS comment).
  // Re-measured on every open since the field can be anywhere in a scrolled form.
  const position = () => {
    const r = input.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top = (r.bottom + 2) + 'px';
    menu.style.width = r.width + 'px';
  };

  const render = () => {
    if (!items.length) { menu.innerHTML = '<li class="combo-empty">No matching tags — type to add a new one.</li>'; }
    else {
      const shown = items.slice(0, matchCount > TAG_COMBO_MAX ? TAG_COMBO_MAX : items.length);
      menu.innerHTML = shown.map((o, i) => `<li class="combo-item${i === active ? ' active' : ''}" role="option" data-i="${i}">
        <div class="combo-tag">${esc(o.tag)}</div>${o.location ? `<div class="combo-loc">${esc(o.location)}</div>` : ''}
      </li>`).join('') +
        (matchCount > TAG_COMBO_MAX ? `<li class="combo-more">Showing ${TAG_COMBO_MAX} of ${matchCount} — keep typing to narrow</li>` : '');
    }
    position();
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  let matchCount = 0;
  const openFiltered = () => {
    const q = input.value.trim().toLowerCase();
    const term = val('fTerminal');
    const all = buildTagOptions().filter(o => !term || !o.terminal || o.terminal === term);
    const matched = q ? all.filter(o => o.tag.toLowerCase().includes(q) || (o.location || '').toLowerCase().includes(q)) : all;
    matchCount = matched.length;
    items = matched.slice(0, TAG_COMBO_MAX);
    active = -1;
    render();
  };

  const choose = (i) => {
    if (i < 0 || i >= items.length) return;
    input.value = items[i].tag;
    close();
    input.dispatchEvent(new Event('change', { bubbles: true })); // fires applyTagMemory
  };

  input.addEventListener('focus', openFiltered);
  input.addEventListener('input', openFiltered);
  // changing Terminal re-scopes the tag list — re-filter if the menu happens to be open
  $('fTerminal').addEventListener('change', () => { if (!menu.hidden) openFiltered(); });
  window.addEventListener('resize', () => { if (!menu.hidden) position(); });
  window.addEventListener('scroll', () => { if (!menu.hidden) position(); }, true);
  input.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { close(); }
  });
  menu.addEventListener('mousedown', (e) => {
    // mousedown (not click) so it fires before the input's blur closes the menu
    const li = e.target.closest('.combo-item');
    if (li) { e.preventDefault(); choose(Number(li.dataset.i)); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

/* ---------------- quick calculator (#/calc — standalone what-if, nothing saves) ----------------
   Its own small input set (q-prefixed ids) + workbench instance, fully independent of the
   finding form so a what-if never clobbers a half-entered finding's assessment. */
let awQuickView = null;

function initQuickCalc() {
  $('qNps').innerHTML = Object.keys(PA_PIPE_DATABASE).map(n => `<option>${n}</option>`).join('');
  $('qMat').innerHTML = PA_MATERIALS.map(m => `<option value="${m.code}">${m.name}</option>`).join('');

  const qMode = () => {
    const b = document.querySelector('#qModeSeg .seg-btn.active');
    return b ? b.dataset.mode : 'tmeas';
  };
  const updateSchedules = (keepValue) => {
    const pipe = PA_PIPE_DATABASE[$('qNps').value];
    if (!pipe) return;
    const prev = $('qSch').value;
    $('qSch').innerHTML = Object.keys(pipe.schedules)
      .map(s => `<option value="${s}">${pipe.schedules[s].label}</option>`).join('');
    const def = paDefaultScheduleForNps($('qNps').value);
    $('qSch').value = (keepValue && pipe.schedules[prev]) ? prev : (pipe.schedules[def] ? def : Object.keys(pipe.schedules)[0]);
    autofillTnom();
  };
  const autofillTnom = () => {
    const pipe = PA_PIPE_DATABASE[$('qNps').value];
    const sch = pipe && pipe.schedules[$('qSch').value];
    if (sch) $('qTnom').value = sch.t;
  };
  const applyStress = () => {
    const m = PA_MATERIALS.find(x => x.code === $('qMat').value);
    if (m && m.stress !== null) { $('qS').value = m.stress; $('qS').disabled = true; }
    else { $('qS').disabled = false; }
  };
  const params = () => ({
    nps: $('qNps').value, sch: $('qSch').value,
    overrideTnom: $('qTnom').value, overrideOd: '',
    mode: qMode(), depth: $('qDepth').value, tmeas: $('qTmeas').value,
    ca: $('qCa').value, pInput: $('qP').value, pUnit: $('qPUnit').value,
    S: $('qS').value, E: $('qE').value, W: $('qW').value, Y: $('qY').value, CR: $('qCr').value,
    matCode: $('qMat').value, isInternal: $('qCorrType').value === 'internal'
  });

  let lastQuickRes = null;
  const recalcQuick = () => {
    const res = computeB313(params());
    const hint = $('qCalcHint');
    if (res.hasErrors) {
      lastQuickRes = null;
      // same neutral-vs-invalid rule as the form's assessment section
      const readingEmpty = qMode() === 'tmeas' ? $('qTmeas').value === '' : $('qDepth').value === '';
      const msg = (res.errors.tmeas || res.errors.depth) && !readingEmpty ? 'Check the UT reading (cannot exceed nominal thickness).'
        : (res.errors.ca && !readingEmpty) ? (typeof res.errors.ca === 'string' ? res.errors.ca : 'Check the corrosion allowance.')
        : (res.errors.P && $('qP').value !== '') ? 'Design pressure must be positive.'
        : res.errors.overrideTnom ? 'Check the nominal thickness.'
        : (res.errors.S && $('qS').value !== '') ? 'Allowable stress S must be positive.'
        : '';
      hint.style.display = msg ? 'block' : 'none';
      hint.textContent = msg;
      awQuickView.render(res, { neutral: !msg, nps: $('qNps').value });
      return;
    }
    lastQuickRes = res;
    hint.style.display = 'none';
    awQuickView.render(res, { nps: $('qNps').value });
  };

  awQuickView = paCreateAssessView($('awQuick'), {
    sections: ['status', 'svg', 'results', 'advisor', 'equations', 'scope'],
    collapsed: ['advisor', 'equations'],
    onDepthDrag: (depth_mm) => {
      if (!lastQuickRes) return;
      if (qMode() === 'depth') $('qDepth').value = depth_mm.toFixed(2);
      else $('qTmeas').value = (lastQuickRes.t_nom - depth_mm).toFixed(2);
      recalcQuick();
    }
  });

  const reset = () => {
    $('qNps').value = '4"';
    updateSchedules(false);
    $('qMat').value = 'API5LB';
    applyStress();
    $('qP').value = ''; $('qPUnit').value = 'bar';
    $('qCa').value = '1.5'; $('qCorrType').value = 'external'; $('qCr').value = '';
    $('qE').value = '1.0'; $('qW').value = '1.0'; $('qY').value = '0.4';
    $('qTmeas').value = ''; $('qDepth').value = '';
    document.querySelectorAll('#qModeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'depth'));
    positionSegPill($('qModeSeg'), false);
    $('qTmeasGrp').style.display = 'none';
    $('qDepthGrp').style.display = 'block';
    autofillTnom();
    lastQuickRes = null;
    $('qCalcHint').style.display = 'none';
    awQuickView.render(null, { neutral: true });
  };

  $('qNps').addEventListener('change', () => { updateSchedules(false); recalcQuick(); });
  $('qSch').addEventListener('change', () => { autofillTnom(); recalcQuick(); });
  $('qMat').addEventListener('change', () => { applyStress(); recalcQuick(); });
  document.querySelectorAll('#qModeSeg .seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#qModeSeg .seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      positionSegPill($('qModeSeg'), true);
      const m = btn.dataset.mode;
      $('qTmeasGrp').style.display = m === 'tmeas' ? 'block' : 'none';
      $('qDepthGrp').style.display = m === 'depth' ? 'block' : 'none';
      recalcQuick();
    });
  });
  ['qTnom', 'qTmeas', 'qDepth', 'qCa', 'qP', 'qPUnit', 'qCorrType', 'qS', 'qE', 'qW', 'qY', 'qCr']
    .forEach(id => $(id).addEventListener('input', recalcQuick));
  $('btnQuickReset').addEventListener('click', reset);

  reset();
}

function openForm(f) {
  editingId = f ? f.id : null;
  clearValidation();
  pendingPhotos = [];
  renderPendingGrid();
  severityTouched = false;
  assessToggleTouched = false;
  lastLoadedAssessInputs = null;
  resetAssessment();
  setAssessOn(false);

  $('formTitle').textContent = f ? 'Edit Finding' : 'New Finding';
  $('btnDelete').style.display = f ? 'inline-flex' : 'none';
  // New findings queue photos in memory (uploaded on save); existing findings manage photos
  // immediately via the same Photographic Record panel/logic the detail page uses.
  $('pendingPhotoPanel').style.display = f ? 'none' : 'block';
  $('editPhotoPanel').style.display = f ? 'block' : 'none';
  photoPasteTarget = 'found'; // Ctrl+V defaults to As Found until a group's "+ Add" is clicked
  if (f) {
    // `current` may not point at this finding (e.g. navigating straight from the dashboard
    // list to #/edit/<id> without visiting the detail page first) — load its photos explicitly
    // rather than assuming currentPhotos is already correct.
    sb.from('finding_photos').select('*').eq('finding_id', f.id).order('created_at', { ascending: true })
      .then(({ data }) => { currentPhotos = data || []; renderPhotoGroups(); });
  } else {
    currentPhotos = [];
    renderPhotoGroups();
  }

  $('fTerminal').value = f ? f.terminal : '';
  $('fTag').value = f ? (f.pipe_tag || '') : '';
  $('fPid').value = f ? (f.pid_no || '') : '';
  $('fService').value = f ? (f.service || '') : '';
  $('fLocationDesc').value = f ? (f.location_desc || '') : '';
  $('fVendor').value = f ? (f.vendor || '') : '';
  $('fReportNo').value = f ? (f.report_no || '') : '';
  $('fReportLink').value = f ? (f.report_link || '') : '';
  $('fInspDate').value = f ? (f.inspection_date || '') : '';
  $('fMethod').value = f ? (f.method || '') : '';
  $('fType').value = f ? f.finding_type : '';
  syncCorrTypeFromFinding(); // corrosion type follows the finding type (a saved assessment overrides it below)
  $('fSeverity').value = f ? (f.severity || '') : '';
  if (f && f.severity) severityTouched = true; // don't auto-overwrite a stored severity
  else suggestSeverityFromType(); // new finding: prefill from the finding type if one is already set
  $('fDescription').value = f ? (f.description || '') : '';
  $('fDefLen').value = f && f.defect_length_mm != null ? f.defect_length_mm : '';
  $('fDefWid').value = f && f.defect_width_mm != null ? f.defect_width_mm : '';
  $('fTargetDate').value = f ? (f.target_date || '') : '';
  $('fSapNotif').value = f ? (f.sap_notification || '') : '';
  $('fSapOrder').value = f ? (f.sap_order || '') : '';
  $('fEstCost').value = f && f.estimated_cost != null ? f.estimated_cost : '';

  // Assessment section: auto-enable for wall-loss types (new) or when the finding carries a
  // reading / a saved assessment (edit). When editing, restore the last saved assessment inputs.
  if (f) {
    if (f.t_nominal != null) $('aTnom').value = f.t_nominal;
    if (f.t_measured != null) $('aTmeas').value = f.t_measured;
    const hasReading = f.t_measured != null;
    if (hasReading || WALL_LOSS_TYPES.includes(f.finding_type)) setAssessOn(true);
    // restore the full saved assessment setup (async; overrides the coarse prefill above)
    sb.from('assessments').select('inputs').eq('finding_id', f.id)
      .order('created_at', { ascending: false }).limit(1)
      .then(({ data }) => {
        if (data && data.length) {
          setAssessOn(true);
          loadAssessmentInto(data[0].inputs, false);
          lastLoadedAssessInputs = JSON.stringify(collectAssessment() ? collectAssessment().inputs : data[0].inputs);
          recalcAssessment();
        }
      });
  } else if (AUTO_ASSESS_TYPES.includes($('fType').value)) {
    setAssessOn(true);
  }

  // map: view is display:none until show() runs, so defer sizing to next tick
  setTimeout(() => {
    ensurePickMap();
    if (pickMarker && pickMap) { pickMap.removeLayer(pickMarker); pickMarker = null; }
    if (f && f.lat != null && f.lng != null) {
      $('fLat').value = f.lat; $('fLng').value = f.lng;
      if (pickMap) {
        pickMarker = L.marker([f.lat, f.lng]).addTo(pickMap);
        pickMap.setView([f.lat, f.lng], 16);
      }
    } else if (!f && pendingNewCoords) {
      // seeded from a dashboard-map double-click — drop the picker pin at those coords
      setPin(pendingNewCoords.lat, pendingNewCoords.lng, true);
      pendingNewCoords = null;
    } else {
      $('fLat').value = ''; $('fLng').value = '';
      if (pickMap) pickMap.setView(DEFAULT_MAP_VIEW.center, DEFAULT_MAP_VIEW.zoom);
    }
  }, 60);
}

function collectForm() {
  const sOrNull = (id) => { const v = val(id).trim(); return v === '' ? null : v; };
  const nOrNull = (id) => { const v = val(id); return v === '' ? null : Number(v); };
  const dOrNull = (id) => val(id) || null;

  let bad = false;
  const need = (id, errId, cond) => {
    if (cond) {
      $(id).setAttribute('aria-invalid', 'true');
      $(errId).style.display = 'block';
      bad = true;
    } else {
      $(id).removeAttribute('aria-invalid');
      $(errId).style.display = 'none';
    }
  };
  need('fTerminal', 'errTerminal', !val('fTerminal'));
  need('fLocationDesc', 'errLocationDesc', !val('fLocationDesc').trim());
  need('fType', 'errType', !val('fType'));
  if (bad) return null;

  // Thickness fields come from the assessment section (single source for the reading).
  const assessOn = $('assessPanel').classList.contains('on');
  const thk = assessOn ? assessThickness() : { t_nom: null, t_meas: null };

  return {
    terminal: val('fTerminal'),
    pipe_tag: sOrNull('fTag'),
    pid_no: sOrNull('fPid'),
    service: sOrNull('fService'),
    location_desc: sOrNull('fLocationDesc'),
    vendor: sOrNull('fVendor'),
    report_no: sOrNull('fReportNo'),
    report_link: sOrNull('fReportLink'),
    inspection_date: dOrNull('fInspDate'),
    method: sOrNull('fMethod'),
    finding_type: val('fType'),
    severity: sOrNull('fSeverity'),
    description: sOrNull('fDescription'),
    t_nominal: (thk.t_nom != null && isFinite(thk.t_nom)) ? thk.t_nom : null,
    t_measured: (thk.t_meas != null && isFinite(thk.t_meas)) ? thk.t_meas : null,
    defect_length_mm: nOrNull('fDefLen'),
    defect_width_mm: nOrNull('fDefWid'),
    lat: nOrNull('fLat'),
    lng: nOrNull('fLng'),
    target_date: dOrNull('fTargetDate'),
    sap_notification: sOrNull('fSapNotif'),
    sap_order: sOrNull('fSapOrder'),
    estimated_cost: nOrNull('fEstCost')
  };
}

// Snapshot the assessment (inputs + full result) for the assessments table, or null if the
// section is off / can't compute. Inputs shape is the long-standing snapshot schema (originally
// defined by the old calculator page's saveAssessmentToFinding) — keep it stable, saved rows depend on it.
function collectAssessment() {
  if (!$('assessPanel').classList.contains('on')) return null;
  const res = computeB313(gatherAssessParams());
  if (res.hasErrors) return null;
  const inputs = {
    nps: $('aNps').value, schedule: $('aSch').value, material: $('aMat').value,
    S: $('aS').value, E: $('aE').value, W: $('aW').value, Y: $('aY').value,
    design_temp: $('aTemp').value, P: $('aP').value, p_unit: $('aPUnit').value,
    ca: $('aCa').value, corr_type: $('aCorrType').value, cr: $('aCr').value,
    mode: aMode(), depth: $('aDepth').value, tmeas: $('aTmeas').value,
    override_tnom: $('aTnom').value
  };
  const results = Object.assign({}, res, {
    // erf_no (current, no-CA) is the headline figure surfaced everywhere this snapshot is later
    // displayed (detail-page card, finding PDF); erf_with kept alongside as the secondary reference.
    erf_no: res.mawp_no > 0 ? res.P_input / res.mawp_no : null,
    erf_with: res.mawp_with > 0 ? res.P_input / res.mawp_with : null
  });
  return { inputs, results };
}

async function uploadPhoto(findingId, file, kind) {
  // 900px / 0.55 — chosen for max headroom on Supabase's free-tier 1GB storage bucket (this
  // table has all of it to itself); still legible for the lightbox and the PDF's largest photo
  // cell (~84x62mm) at typical print/screen resolution.
  const dataUrl = await downscaleImage(file, 900, 0.55);
  const blob = await (await fetch(dataUrl)).blob();
  const path = `${findingId}/${crypto.randomUUID()}.jpg`;
  const up = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
  if (up.error) throw up.error;
  const ins = await sb.from('finding_photos').insert({ finding_id: findingId, kind, storage_path: path });
  if (ins.error) throw ins.error;
}

async function saveForm(addAnother) {
  const payload = collectForm();
  if (!payload) { notify('Please fill the required fields.', true); return; }
  const assessment = collectAssessment();
  const assessWanted = $('assessPanel').classList.contains('on');
  const btn = addAnother ? $('btnSaveAnother') : $('btnSave');
  setBusy(btn, true, 'Saving…');
  try {
    let id = editingId;
    if (editingId) {
      const { error } = await sb.from('findings').update(payload).eq('id', editingId);
      if (error) throw error;
    } else {
      const { data, error } = await sb.from('findings').insert(payload).select('id').single();
      if (error) throw error;
      id = data.id;
      // opening entry of the handover trail
      await sb.from('status_history').insert({
        finding_id: id, old_status: null, new_status: 'Open', note: 'Finding recorded'
      });
      let failed = 0;
      for (const p of pendingPhotos) {
        try { await uploadPhoto(id, p.file, 'found'); } catch (e) { failed++; console.warn('photo upload failed', e); }
      }
      if (failed) notify(`${failed} photo(s) failed to upload — you can retry from the finding page.`, true);
    }
    // attach the assessment snapshot. Insert-only, but skip when editing and the inputs are
    // unchanged from what was loaded — otherwise a metadata-only edit spawns a duplicate.
    const unchanged = editingId && assessment && lastLoadedAssessInputs === JSON.stringify(assessment.inputs);
    if (assessment && !unchanged) {
      const { error: aErr } = await sb.from('assessments').insert({ finding_id: id, inputs: assessment.inputs, results: assessment.results });
      if (aErr) notify('Finding saved, but the assessment could not be recorded: ' + aErr.message, true);
    } else if (assessWanted && !assessment) {
      notify('Finding saved. Assessment left incomplete (needs UT reading + pressure) — not recorded.', true);
    }

    if (addAnother) {
      // keep the report context, reload the list cache so the new row appears, then a fresh form
      await loadFindings();
      const keep = {
        terminal: val('fTerminal'), vendor: val('fVendor'),
        reportNo: val('fReportNo'), inspDate: val('fInspDate'), method: val('fMethod')
      };
      openForm(null);
      $('fTerminal').value = keep.terminal;
      $('fVendor').value = keep.vendor;
      $('fReportNo').value = keep.reportNo;
      $('fInspDate').value = keep.inspDate;
      $('fMethod').value = keep.method;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      notify('Saved. Ready for the next finding on this report.');
    } else {
      notify(editingId ? 'Finding updated.' : 'Finding recorded.');
      location.hash = '#/f/' + id;
    }
  } catch (e) {
    notify('Save failed: ' + e.message, true);
  } finally {
    setBusy(btn, false);
  }
}

async function deleteFinding() {
  if (!editingId) return;
  const f = findings.find(x => x.id === editingId) || current;
  const tag = f ? f.pipe_tag : '';
  if (!window.confirm(`Delete this finding (${tag})? Its photos and history are removed permanently.`)) return;
  const btn = $('btnDelete');
  setBusy(btn, true, 'Deleting…');
  try {
    const { data: ph } = await sb.from('finding_photos').select('storage_path').eq('finding_id', editingId);
    if (ph && ph.length) await sb.storage.from(PHOTO_BUCKET).remove(ph.map(p => p.storage_path));
    const { error } = await sb.from('findings').delete().eq('id', editingId);
    if (error) throw error;
    notify('Finding deleted.');
    location.hash = '#/list';
  } catch (e) {
    notify('Delete failed: ' + e.message, true);
  } finally {
    setBusy(btn, false);
  }
}

/* ---------------- detail view ---------------- */

function dItem(label, valueHtml) {
  return `<div class="d-item"><div class="d-label">${esc(label)}</div><div class="d-val">${valueHtml}</div></div>`;
}

function renderDetail() {
  const f = current;
  photoPasteTarget = 'found'; // Ctrl+V defaults to As Found until the user uses After-Repair's + Add

  $('detailHead').innerHTML =
    `<h2>${esc(f.pipe_tag || f.location_desc || '—')}</h2>${pillHtml(f.status)}${isOverdue(f) ? '<span class="ov-badge">OVERDUE</span>' : ''}` +
    `<span class="dh-meta">${esc(f.terminal)} Terminal — ${esc(f.finding_type)}</span>`;

  const life = [];
  life.push(dItem('Current Status', pillHtml(f.status)));
  if (f.target_date) life.push(dItem('Target Repair Date', `<span class="mono">${fmtDate(f.target_date)}</span>`));
  if (f.next_check_date) life.push(dItem('Re-inspect By', `<span class="mono">${fmtDate(f.next_check_date)}</span>`));
  if (f.sap_notification) life.push(dItem('SAP Notification', `<span class="mono">${esc(f.sap_notification)}</span>`));
  if (f.sap_order) life.push(dItem('SAP Order', `<span class="mono">${esc(f.sap_order)}</span>`));
  if (f.estimated_cost != null) life.push(dItem('Estimated Repair Cost', `<span class="mono">${esc(paFmtBaht(f.estimated_cost))}</span>`));
  if (f.repair_method) life.push(dItem('Repair Method', esc(f.repair_method)));
  if (f.repaired_date) life.push(dItem('Repaired Date', `<span class="mono">${fmtDate(f.repaired_date)}</span>`));
  if (f.closing_note) life.push(dItem('Closing Note', esc(f.closing_note)));
  $('lifecycleGrid').innerHTML = life.join('');

  // status actions: every other status is reachable (single-team tool — flexibility beats ceremony)
  $('statusActions').innerHTML = STATUSES.filter(s => s !== f.status)
    .map(s => `<button type="button" class="btn" data-variant="outline" data-st="${esc(s)}">&#8594; ${esc(s)}</button>`)
    .join('');
  $('statusActions').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => openStatusDialog(btn.dataset.st));
  });

  const d = [];
  d.push(dItem('Terminal', esc(f.terminal)));
  d.push(dItem('P&ID', esc(f.pid_no || '—')));
  d.push(dItem('Service', esc(f.service || '—')));
  d.push(dItem('Location', esc(f.location_desc || '—')));
  d.push(dItem('Vendor', esc(f.vendor || '—')));
  d.push(dItem('Report No.', esc(f.report_no || '—')));
  if (f.report_link) d.push(dItem('Report Link',
    `<a href="${esc(f.report_link)}" target="_blank" rel="noopener" style="color:var(--button-primary);font-weight:600;">Open source report &#8599;</a>`));
  d.push(dItem('Inspection Date', `<span class="mono">${fmtDate(f.inspection_date)}</span>`));
  d.push(dItem('Method', esc(f.method || '—')));
  d.push(dItem('Severity', esc(f.severity || '—')));
  if (f.t_nominal != null) d.push(dItem('Nominal Thk.', `<span class="mono">${f.t_nominal} mm</span>`));
  if (f.t_measured != null) d.push(dItem('Measured Min.', `<span class="mono">${f.t_measured} mm</span>`));
  if (f.defect_length_mm != null || f.defect_width_mm != null)
    d.push(dItem('Defect L × W', `<span class="mono">${f.defect_length_mm != null ? f.defect_length_mm : '—'} × ${f.defect_width_mm != null ? f.defect_width_mm : '—'} mm</span>`));
  if (f.lat != null && f.lng != null)
    d.push(dItem('Coordinates', `<a class="mono" style="color:var(--button-primary);" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${f.lat},${f.lng}">${Number(f.lat).toFixed(6)}, ${Number(f.lng).toFixed(6)}</a>`));
  d.push(dItem('Recorded By', esc(f.created_by_email || '—')));
  d.push(dItem('Recorded At', `<span class="mono">${fmtDateTime(f.created_at)}</span>`));
  $('detailGrid').innerHTML = d.join('');

  $('detailDesc').innerHTML = f.description
    ? `<div class="d-label">Description</div><p class="d-desc">${esc(f.description)}</p>`
    : '';

  renderAssessments();
  renderDetailMap();
  renderPhotoGroups();
  renderTimeline();
}

let detailMap = null, detailMarker = null;

// Satellite map on the detail page, centred on the finding's pin. Hidden when no coordinates.
function renderDetailMap() {
  const f = current;
  const panel = $('detailLocPanel');
  if (!f || f.lat == null || f.lng == null || typeof L === 'undefined') {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  $('detailMapLink').href = `https://www.google.com/maps?q=${f.lat},${f.lng}`;
  const el = $('detailMap');
  if (!detailMap) {
    detailMap = L.map(el, { center: [f.lat, f.lng], zoom: 17, scrollWheelZoom: false });
    L.tileLayer(SAT_TILES.url, { maxZoom: SAT_TILES.maxZoom, attribution: SAT_TILES.attribution }).addTo(detailMap);
    detailMap.on('focus click', () => detailMap.scrollWheelZoom.enable());
    detailMap.on('blur', () => detailMap.scrollWheelZoom.disable());
  }
  // panel was display:none until now -> re-measure, then place the pin and recentre
  setTimeout(() => {
    detailMap.invalidateSize();
    detailMap.setView([f.lat, f.lng], 17);
    const color = STATUS_COLORS[f.status] || '#64748b';
    if (!detailMarker) detailMarker = L.circleMarker([f.lat, f.lng], { radius: 9, weight: 3, color: '#ffffff', fillOpacity: 0.95 }).addTo(detailMap);
    else detailMarker.setLatLng([f.lat, f.lng]);
    detailMarker.setStyle({ fillColor: color });
  }, 80);
}

/* ---------------- assessments (calculator snapshots) ---------------- */

const fmtN = (v, d) => (v != null && isFinite(v)) ? Number(v).toFixed(d) : '—';

// erf_no (no-CA, current-condition) is the headline figure everywhere an assessment result is
// shown. Snapshots saved before this field existed only have erf_with — mawp_no was always part
// of the saved results (it's spread from the raw computeB313() result), so it can still be
// derived from mawp_no + P_input for those older rows rather than showing a blank dash.
function erfNo(r) {
  if (r.erf_no != null) return r.erf_no;
  return (r.mawp_no > 0 && r.P_input > 0) ? r.P_input / r.mawp_no : null;
}

function assessPill(status) {
  // calculator statuses mapped onto the existing pill palette
  const cls = status === 'OK' ? 'st-rep' : status === 'MONITOR' ? 'st-mon' : 'st-open';
  return `<span class="pill ${cls}">${esc(status || '—')}</span>`;
}

function materialName(code) {
  const m = PA_MATERIALS.find(x => x.code === code);
  return m ? m.name.replace(/^[^:]+:\s*/, '') : (code || '—');
}

const CORR_TYPE_LABEL = { external: 'External', internal: 'Internal' };

function assessSetupLine(inputs) {
  if (!inputs) return '';
  const parts = [
    inputs.nps,
    inputs.schedule ? `Sch ${inputs.schedule}` : null,
    materialName(inputs.material),
    inputs.corr_type ? `${CORR_TYPE_LABEL[inputs.corr_type] || inputs.corr_type} corrosion` : null,
    (inputs.P != null && inputs.P !== '') ? `Design P ${inputs.P} ${inputs.p_unit || ''}`.trim() : null
  ].filter(Boolean);
  return esc(parts.join(' · '));
}

// Re-run the shared engine on a snapshot's saved inputs so the detail page can show the full
// workbench (status, cross-section, results, advisor, equations), not just summary tiles.
// Falls back to null (compact tiles) if the inputs can't compute — e.g. a malformed old row.
function resFromSnapshot(a) {
  if (!a || !a.inputs) return null;
  const inp = a.inputs;
  const res = computeB313({
    nps: inp.nps, sch: inp.schedule, overrideOd: '',
    overrideTnom: inp.override_tnom != null ? inp.override_tnom : '',
    mode: inp.mode === 'depth' ? 'depth' : 'tmeas',
    depth: inp.depth != null ? inp.depth : '', tmeas: inp.tmeas != null ? inp.tmeas : '',
    ca: inp.ca != null ? inp.ca : '', pInput: inp.P != null ? inp.P : '',
    pUnit: inp.p_unit || 'bar', S: inp.S, E: inp.E, W: inp.W, Y: inp.Y,
    CR: inp.cr != null ? inp.cr : '', matCode: inp.material,
    isInternal: inp.corr_type === 'internal'
  });
  return res.hasErrors ? null : res;
}

function renderAssessments() {
  const body = $('assessBody');
  if (!currentAssessments.length) {
    body.innerHTML = '<div class="photo-empty">No assessment yet — "Run assessment" opens this finding\'s edit form with the ASME B31.3 workbench; saving records the result here.</div>';
    return;
  }
  const [latest, ...older] = currentAssessments;
  const r = latest.results || {};
  const setupLine = assessSetupLine(latest.inputs);

  let html = `<div class="assess-latest-head">
    <span class="assess-history-label" style="margin:0;">Latest assessment — ${fmtDateTime(latest.created_at)}</span>
    <span class="assess-meta">${setupLine ? setupLine + ' — ' : ''}by ${esc(latest.created_by_email || '—')}</span>
  </div>
  <div id="awDetail"></div>`;

  if (older.length) {
    html += `<div class="assess-history-label">Previous assessments (${older.length})</div>`;
    html += older.map(a => {
      const or = a.results || {};
      const setup = assessSetupLine(a.inputs);
      return `<div class="assess-item">
        ${assessPill(or.status)}
        <span class="kv mono"><b>ERF</b> ${fmtN(erfNo(or), 3)}</span>
        <span class="kv mono"><b>t meas</b> ${fmtN(or.t_meas, 2)} mm</span>
        <span class="kv mono"><b>Margin</b> ${fmtN(or.margin, 3)} mm</span>
        ${or.remainingLife != null ? `<span class="kv mono"><b>Life</b> ${fmtN(or.remainingLife, 1)} y</span>` : ''}
        <span class="assess-meta">${setup ? setup + ' — ' : ''}${fmtDateTime(a.created_at)} — ${esc(a.created_by_email || '')}</span>
      </div>`;
    }).join('');
  }

  body.innerHTML = html;

  // Mount the read-only workbench for the latest snapshot (no drag handle — display only).
  const res = resFromSnapshot(latest);
  const host = $('awDetail');
  if (res) {
    const view = paCreateAssessView(host, {
      sections: ['status', 'svg', 'results', 'advisor', 'equations'],
      collapsed: ['advisor', 'equations']
    });
    view.render(res, { nps: latest.inputs.nps });
  } else {
    // snapshot whose inputs can't re-compute (malformed/legacy row): show the saved results
    host.innerHTML = `<div class="assess-item">
      ${assessPill(r.status)}
      <span class="kv mono"><b>ERF (no CA)</b> ${fmtN(erfNo(r), 3)}</span>
      <span class="kv mono"><b>t meas</b> ${fmtN(r.t_meas, 2)} mm</span>
      <span class="kv mono"><b>Margin</b> ${fmtN(r.margin, 3)} mm</span>
      <span class="kv mono"><b>MAWP (no CA)</b> ${fmtN(r.mawp_no, 2)} ${esc(r.pUnit || '')}</span>
    </div>`;
  }
}

function photoThumb(p) {
  const url = photoUrl(p.storage_path);
  return `<div class="photo-thumb">
    <img src="${esc(url)}" alt="Finding photo" data-url="${esc(url)}">
    <button type="button" class="photo-remove" data-id="${esc(p.id)}" data-path="${esc(p.storage_path)}" title="Delete photo">&#215;</button>
  </div>`;
}

// Photo management (add/remove) is shown in TWO places — the detail page's Photographic
// Record panel, and (identically) the edit form's, so photos can be managed while editing
// without a detour through the detail page. Both read/write the same currentPhotos array and
// both are re-rendered together on every change — the ids differ (gridFound/gridFound2 etc.)
// but the content and behavior are otherwise identical.
const PHOTO_GRID_SETS = [
  { grid: 'gridFound', empty: 'emptyFound', addBtn: 'btnAddFound', kind: 'found' },
  { grid: 'gridRepaired', empty: 'emptyRepaired', addBtn: 'btnAddRepaired', kind: 'repaired' },
  { grid: 'gridFound2', empty: 'emptyFound2', addBtn: 'btnAddFound2', kind: 'found' },
  { grid: 'gridRepaired2', empty: 'emptyRepaired2', addBtn: 'btnAddRepaired2', kind: 'repaired' },
];

function renderPhotoGroups() {
  const found = currentPhotos.filter(p => p.kind === 'found');
  const rep = currentPhotos.filter(p => p.kind === 'repaired');
  PHOTO_GRID_SETS.forEach(({ grid, empty, addBtn, kind }) => {
    const el = $(grid);
    if (!el) return; // markup may not exist yet on first call — harmless no-op
    const rows = kind === 'found' ? found : rep;
    el.innerHTML = rows.map(photoThumb).join('');
    $(empty).style.display = rows.length ? 'none' : 'block';
    const btn = $(addBtn);
    if (btn) {
      const atLimit = rows.length >= PHOTO_LIMIT_PER_KIND;
      btn.disabled = atLimit;
      btn.textContent = atLimit ? `Max ${PHOTO_LIMIT_PER_KIND} reached` : `+ Add (${rows.length}/${PHOTO_LIMIT_PER_KIND})`;
    }
  });

  document.querySelectorAll('#viewDetail .photo-thumb img, #viewForm .photo-thumb img').forEach(img => {
    img.addEventListener('click', () => {
      $('lightboxImg').src = img.dataset.url;
      openDialog($('lightbox'));
    });
  });
  document.querySelectorAll('#viewDetail .photo-remove, #viewForm .photo-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('Delete this photo?')) return;
      try {
        await sb.storage.from(PHOTO_BUCKET).remove([btn.dataset.path]);
        const { error } = await sb.from('finding_photos').delete().eq('id', btn.dataset.id);
        if (error) throw error;
        currentPhotos = currentPhotos.filter(p => p.id !== btn.dataset.id);
        renderPhotoGroups();
        notify('Photo deleted.');
      } catch (e) { notify('Delete failed: ' + e.message, true); }
    });
  });
}

// findingId defaults to current.id (the detail page's usage) but the edit form passes its own
// editingId explicitly, since `current` may not point at the finding being edited (e.g.
// navigating straight from the dashboard list to #/edit/<id> without visiting the detail page).
async function addDetailPhotos(files, kind, findingId) {
  if (!files || !files.length) return;
  const id = findingId || (current && current.id);
  if (!id) return;
  const already = currentPhotos.filter(p => p.kind === kind).length;
  const room = Math.max(0, PHOTO_LIMIT_PER_KIND - already);
  if (room <= 0) {
    notify(`Limit reached: ${PHOTO_LIMIT_PER_KIND} ${kind === 'found' ? 'As Found' : 'After Repair'} photos max.`, true);
    return;
  }
  const toUpload = files.filter(f => f.type && f.type.startsWith('image/')).slice(0, room);
  const skipped = files.length - toUpload.length;
  notify('Uploading ' + toUpload.length + ' photo(s)…');
  let ok = 0, failed = 0;
  for (const f of toUpload) {
    try { await uploadPhoto(id, f, kind); ok++; }
    catch (e) { failed++; console.warn('upload failed', e); }
  }
  const { data } = await sb.from('finding_photos').select('*').eq('finding_id', id).order('created_at', { ascending: true });
  currentPhotos = data || [];
  renderPhotoGroups();
  renderDlgRepairedPhotos(); // no-op if the status-change dialog isn't showing the Repaired target
  const limitNote = skipped ? ` (${skipped} skipped — ${PHOTO_LIMIT_PER_KIND} max reached)` : '';
  if (failed) notify(`${ok} uploaded, ${failed} failed.${limitNote}`, true);
  else notify(`${ok} photo(s) added.${limitNote}`, !!skipped);
}

function renderTimeline() {
  const tl = $('timeline');
  if (!currentHistory.length) {
    tl.innerHTML = '<li><div class="tl-title">No history yet</div></li>';
    return;
  }
  tl.innerHTML = currentHistory.map(h => `
    <li>
      <div class="tl-title">${h.old_status ? `${esc(h.old_status)} &#8594; ` : ''}${esc(h.new_status)}</div>
      <div class="tl-meta">${fmtDateTime(h.changed_at)} — ${esc(h.changed_by_email || '')}</div>
      ${h.note ? `<div class="tl-note">${esc(h.note)}</div>` : ''}
    </li>`).join('');
}

/* ---------------- status-change dialog ---------------- */

let dlgTarget = null;

function openStatusDialog(target) {
  dlgTarget = target;
  $('dlgTitle').textContent = `${current.status} → ${target}`;
  $('dlgNote').value = '';
  $('errDlg').style.display = 'none';

  let extra = '';
  if (target === 'Monitoring') {
    extra = `<label class="f-label req" for="dlgDate">Re-inspect by</label>
             <input id="dlgDate" class="input" type="date" value="${esc(current.next_check_date || '')}">`;
  } else if (target === 'Repair Planned') {
    extra = `<label class="f-label req" for="dlgDate">Target repair date</label>
             <input id="dlgDate" class="input" type="date" value="${esc(current.target_date || '')}">`;
  } else if (target === 'Repaired') {
    extra = `<label class="f-label req" for="dlgDate">Repaired date</label>
             <input id="dlgDate" class="input" type="date" value="${todayISO()}">
             <label class="f-label" for="dlgRepairMethod" style="margin-top:12px;">Repair method (PCC-2 / description)</label>
             <input id="dlgRepairMethod" class="input" type="text" value="${esc(current.repair_method || '')}" placeholder="e.g., Weld overlay / clamp / replacement spool">
             <div class="photo-group" style="margin-top:12px;">
               <div class="photo-group-h">
                 <h3>After Repair photos</h3>
                 <button class="btn" data-variant="outline" id="dlgAddRepairedPhoto" type="button">+ Add</button>
               </div>
               <div class="photo-grid" id="dlgRepairedGrid"></div>
               <div class="photo-empty" id="dlgRepairedEmpty">No after-repair photos yet.</div>
             </div>`;
  }
  $('dlgExtra').innerHTML = extra;
  if (target === 'Repaired') {
    renderDlgRepairedPhotos();
    $('dlgAddRepairedPhoto').addEventListener('click', () => $('fileDlgRepaired').click());
  }
  openDialog($('statusDlg'));
}

// Mirrors renderPhotoGroups' "repaired" slice, scoped to the status-change dialog's own grid —
// kept separate rather than added to PHOTO_GRID_SETS since this markup is rebuilt fresh every
// time the dialog opens (dlgExtra.innerHTML), unlike the detail/edit-form grids that persist.
function renderDlgRepairedPhotos() {
  const grid = $('dlgRepairedGrid');
  if (!grid) return; // dialog closed / not the Repaired target
  const rows = currentPhotos.filter(p => p.kind === 'repaired');
  grid.innerHTML = rows.map(photoThumb).join('');
  $('dlgRepairedEmpty').style.display = rows.length ? 'none' : 'block';
  const btn = $('dlgAddRepairedPhoto');
  const atLimit = rows.length >= PHOTO_LIMIT_PER_KIND;
  btn.disabled = atLimit;
  btn.textContent = atLimit ? `Max ${PHOTO_LIMIT_PER_KIND} reached` : `+ Add (${rows.length}/${PHOTO_LIMIT_PER_KIND})`;
  grid.querySelectorAll('.photo-thumb img').forEach(img => {
    img.addEventListener('click', () => { $('lightboxImg').src = img.dataset.url; openDialog($('lightbox')); });
  });
  grid.querySelectorAll('.photo-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!window.confirm('Delete this photo?')) return;
      try {
        await sb.storage.from(PHOTO_BUCKET).remove([btn.dataset.path]);
        const { error } = await sb.from('finding_photos').delete().eq('id', btn.dataset.id);
        if (error) throw error;
        currentPhotos = currentPhotos.filter(p => p.id !== btn.dataset.id);
        renderDlgRepairedPhotos();
        renderPhotoGroups();
        notify('Photo deleted.');
      } catch (e) { notify('Delete failed: ' + e.message, true); }
    });
  });
}

async function confirmStatusChange() {
  const target = dlgTarget;
  const note = val('dlgNote').trim();
  const dateEl = $('dlgDate');
  const err = $('errDlg');
  err.style.display = 'none';

  const patch = { status: target };
  if (target === 'Monitoring') {
    if (!dateEl.value) { err.textContent = 'Re-inspect date is required for Monitoring.'; err.style.display = 'block'; return; }
    patch.next_check_date = dateEl.value;
  } else if (target === 'Repair Planned') {
    if (!dateEl.value) { err.textContent = 'Target repair date is required.'; err.style.display = 'block'; return; }
    patch.target_date = dateEl.value;
  } else if (target === 'Repaired') {
    if (!dateEl.value) { err.textContent = 'Repaired date is required.'; err.style.display = 'block'; return; }
    patch.repaired_date = dateEl.value;
    const rm = val('dlgRepairMethod').trim();
    if (rm) patch.repair_method = rm;
    const hasRepairedPhoto = currentPhotos.some(p => p.kind === 'repaired');
    if (!hasRepairedPhoto &&
        !window.confirm('No after-repair photo is attached yet. Mark as Repaired anyway? You can add the confirmation photo later.')) {
      return;
    }
  } else if (target === 'Closed') {
    if (!note) { err.textContent = 'A closing note is required to close a finding.'; err.style.display = 'block'; return; }
    patch.closing_note = note;
  }

  const btn = $('dlgConfirm');
  setBusy(btn, true, 'Saving…');
  try {
    const { error } = await sb.from('findings').update(patch).eq('id', current.id);
    if (error) throw error;
    const { error: e2 } = await sb.from('status_history').insert({
      finding_id: current.id, old_status: current.status, new_status: target, note: note || null
    });
    if (e2) throw e2;
    closeDialog($('statusDlg'));
    notify(`Status changed to ${target}.`);
    await loadDetail(current.id);
    renderDetail();
  } catch (e) {
    err.textContent = 'Failed: ' + e.message;
    err.style.display = 'block';
  } finally {
    setBusy(btn, false);
  }
}

/* ===================== Finding PDF report =====================
   Same visual language as the calculator's report (navy headings, hairline
   #cbd5e1 frames, dd/Mmm/yyyy dates, WinAnsi-safe text only). Tables are drawn
   manually — no autotable dependency. Opens in the browser's native PDF viewer
   via a blob anchor (the one approach that also survives file://). */

const PDF_NAVY = '#156B95'; // matches --header-accent / --button-primary exactly
const PDF_TEXT = '#0f172a';
const PDF_MUTED = '#64748b';
const PDF_BORDER = '#cbd5e1';
/* Semantic status colors — match :root's light-mode --ok/--warn/--danger tokens exactly (the
   report always renders in the fixed light palette regardless of app theme). Named constants,
   never re-typed hex per call site — same rule as the old calculator report. */
const PDF_OK = '#059669';
const PDF_WARN = '#d97706';
const PDF_WARN_DARK = '#92400e';   // --warn-text — the CS-reference caveat note
const PDF_WARN_MID = '#b45309';    // warn accent — the bold FFS recommendation
const PDF_DANGER = '#dc2626';

function fetchAsDataUrl(url, timeoutMs) {
  const job = fetch(url)
    .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.blob(); })
    .then(b => new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(b);
    }));
  return Promise.race([job, new Promise(res => setTimeout(() => res(null), timeoutMs))])
    .catch(() => null);
}

function loadImg(src) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
}

/* Deterministic satellite figure from clean Esri tiles ({z}/{y}/{x} axis order) with a
   centre pin + required attribution. Resolves null on any failure so the PDF degrades
   to coordinates-as-text and never hangs. */
async function composeMapPng(lat, lng, zoom, W, H) {
  try {
    const job = (async () => {
      const n = Math.pow(2, zoom);
      const latR = lat * Math.PI / 180;
      const cx = ((lng + 180) / 360) * n * 256;
      const cy = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n * 256;
      const left = cx - W / 2, top = cy - H / 2;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const jobs = [];
      for (let tx = Math.floor(left / 256); tx <= Math.floor((left + W) / 256); tx++) {
        for (let ty = Math.floor(top / 256); ty <= Math.floor((top + H) / 256); ty++) {
          jobs.push(new Promise((res, rej) => {
            const im = new Image();
            im.crossOrigin = 'anonymous'; // Esri sends ACAO — canvas stays exportable
            im.onload = () => { g.drawImage(im, tx * 256 - left, ty * 256 - top); res(); };
            im.onerror = rej;
            im.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty}/${tx}`;
          }));
        }
      }
      await Promise.all(jobs);
      g.beginPath();
      g.arc(W / 2, H / 2, 10, 0, Math.PI * 2);
      g.fillStyle = '#dc2626'; g.fill();
      g.lineWidth = 3; g.strokeStyle = '#ffffff'; g.stroke();
      g.font = '11px Arial';
      const attr = 'Imagery (c) Esri, Maxar, Earthstar Geographics';
      const tw = g.measureText(attr).width;
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.fillRect(W - tw - 10, H - 18, tw + 10, 18);
      g.fillStyle = '#334155';
      g.fillText(attr, W - tw - 5, H - 5);
      return c.toDataURL('image/jpeg', 0.85);
    })();
    return await Promise.race([job, new Promise(res => setTimeout(() => res(null), 7000))]);
  } catch (e) { return null; }
}

async function buildFindingPdf() {
  const f = current;
  const { jsPDF } = await import('jspdf'); const { default: autoTable } = await import('jspdf-autotable');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  registerGoogleSansFonts(doc); // asset/shared.js — use doc.setFont('GoogleSans', ...) below
  const PW = 210, PH = 297, M = 14, CW = PW - 2 * M;
  const HEADER_H = 18, FOOTER_H = 16;
  let y = 0, secNum = 0, figNum = 0;

  // preload images (each degrades independently). Logo is the embedded base64 from shared.js
  // (offline-safe — same source as the calculator report), with a file fetch as a fallback.
  const logo = (typeof OR_LOGO_DATAURL !== 'undefined' && OR_LOGO_DATAURL) || await fetchAsDataUrl('asset/RGB_OR_Full color.png', 3000);
  const logoIm = logo ? await loadImg(logo) : null;
  const mapImg = (f.lat != null && f.lng != null) ? await composeMapPng(f.lat, f.lng, 17, 1000, 500) : null;
  // latest assessment re-computed from its saved inputs (single engine source) + its cross-section
  const assess = currentAssessments.length ? currentAssessments[0] : null;
  const assessRes = assess ? resFromSnapshot(assess) : null;
  const xsecPng = assessRes ? await paCrossSectionPng(assessRes, 2).catch(() => null) : null;
  const photoData = [];
  for (const p of currentPhotos) {
    const d = await fetchAsDataUrl(photoUrl(p.storage_path), 8000);
    if (!d) continue;
    const im = await loadImg(d);
    if (im) photoData.push({ kind: p.kind, src: d, w: im.naturalWidth, h: im.naturalHeight });
  }

  const now = new Date();

  // Header/footer chrome mirrors calculator.html's buildPdfReport so both reports read as one
  // family: full-color OR logo left, navy title right, navy rule beneath; hairline footer with
  // page x/y, generation stamp, and the division attribution.
  function chrome() {
    if (logoIm) {
      const lw = 26, lh = 26 * logoIm.naturalHeight / logoIm.naturalWidth;
      try { doc.addImage(logo, 'PNG', M, 3, lw, lh); }
      catch (_) { doc.setFont('GoogleSans', 'bold'); doc.setFontSize(15); doc.setTextColor(PDF_NAVY); doc.text('OR', M, 12); }
    } else {
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(15); doc.setTextColor(PDF_NAVY);
      doc.text('OR', M, 12);
    }
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(11); doc.setTextColor(PDF_NAVY);
    doc.text('PIPING ABNORMAL FINDING REPORT', PW - M, 8.5, { align: 'right' });
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7.5); doc.setTextColor('#64748b');
    doc.text(`TAG: ${f.pipe_tag || f.location_desc || '—'}   •   ${paFmtDate(now)}`, PW - M, 13.5, { align: 'right' });
    doc.setDrawColor(PDF_NAVY); doc.setLineWidth(0.8);
    doc.line(M, HEADER_H - 1, PW - M, HEADER_H - 1);

    doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
    doc.line(M, PH - FOOTER_H, PW - M, PH - FOOTER_H);
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7.5); doc.setTextColor('#64748b');
    doc.text('Piping integrity — abnormal finding record', M, PH - FOOTER_H + 4);
    doc.text(`Page ${doc.internal.getNumberOfPages()} of {tp}`, PW / 2, PH - FOOTER_H + 4, { align: 'center' });
    doc.text(`Generated ${paFmtDateTime(now)}`, PW - M, PH - FOOTER_H + 4, { align: 'right' });
    doc.setFontSize(6.5); doc.setTextColor('#94a3b8');
    doc.text('Central and Eastern Engineering and Maintenance Division — PTT Oil and Retail Business Public Company Limited', PW / 2, PH - FOOTER_H + 9, { align: 'center' });
    doc.setTextColor(PDF_TEXT);
    y = HEADER_H + 8;
  }

  function ensure(h) {
    if (y + h > PH - FOOTER_H - 4) { doc.addPage(); chrome(); }
  }

  function section(t) {
    ensure(14);
    secNum++;
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(9); doc.setTextColor(PDF_NAVY);
    doc.text(`${secNum}. ${t.toUpperCase()}`, M, y);
    doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
    doc.line(M, y + 1.5, PW - M, y + 1.5);
    y += 7;
    doc.setTextColor(PDF_TEXT);
  }

  function row(label, value) {
    const v = (value == null || value === '') ? '—' : String(value);
    const lines = doc.splitTextToSize(v, CW - 48);
    const h = Math.max(6, lines.length * 4.2 + 2);
    ensure(h);
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8); doc.setTextColor(PDF_MUTED);
    doc.text(label, M, y + 3.6);
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(9); doc.setTextColor(PDF_TEXT);
    doc.text(lines, M + 48, y + 3.7);
    doc.setDrawColor('#e2e8f0'); doc.setLineWidth(0.15);
    doc.line(M, y + h, PW - M, y + h);
    y += h;
  }

  chrome();

  // colored status band — same rounded band + typography as the calculator's INTEGRITY STATUS
  // (fixed hex from STATUS_COLORS; report surface never themes)
  doc.setFillColor(STATUS_COLORS[f.status] || '#64748b');
  doc.roundedRect(M, y, CW, 12, 1.5, 1.5, 'F');
  doc.setFont('GoogleSans', 'bold'); doc.setFontSize(14); doc.setTextColor('#ffffff');
  doc.text(`STATUS: ${(f.status || '').toUpperCase()}`, M + 4, y + 8);
  if (isOverdue(f)) {
    doc.setFont('courier', 'bold'); doc.setFontSize(8);
    doc.text(`OVERDUE - due ${paFmtDate(dueDateOf(f))}`, PW - M - 4, y + 8, { align: 'right' });
  }
  y += 16;
  doc.setTextColor('#334155'); doc.setFont('GoogleSans', 'normal'); doc.setFontSize(8);
  doc.text(`${f.terminal} Terminal   •   ${f.finding_type}`, M, y);
  y += 8;
  doc.setTextColor(PDF_TEXT);

  section('Finding Information');
  row('Terminal', f.terminal);
  row('Pipe Tag / Line', f.pipe_tag);
  row('P&ID No.', f.pid_no);
  row('Service / Fluid', f.service);
  row('Location', f.location_desc);
  row('Recorded By', f.created_by_email);
  row('Recorded At', fmtDateTime(f.created_at));
  y += 4;

  section('Source Inspection');
  row('Vendor', f.vendor);
  row('Report No.', f.report_no);
  if (f.report_link) {
    ensure(6);
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8); doc.setTextColor(PDF_MUTED);
    doc.text('Report Link', M, y + 3.6);
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(9); doc.setTextColor('#156B95');
    doc.textWithLink('Open source report', M + 48, y + 3.7, { url: f.report_link });
    doc.setDrawColor('#e2e8f0'); doc.setLineWidth(0.15);
    doc.line(M, y + 6, PW - M, y + 6);
    doc.setTextColor(PDF_TEXT);
    y += 6;
  }
  row('Inspection Date', paFmtDate(f.inspection_date));
  row('Method', f.method);
  y += 4;

  section('Anomaly');
  row('Finding Type', f.finding_type);
  row('Severity', f.severity);
  if (f.t_nominal != null) row('Nominal Thickness', `${f.t_nominal} mm`);
  if (f.t_measured != null) row('Measured Min. Thickness', `${f.t_measured} mm`);
  if (f.defect_length_mm != null || f.defect_width_mm != null)
    row('Defect L x W', `${f.defect_length_mm != null ? f.defect_length_mm : '—'} x ${f.defect_width_mm != null ? f.defect_width_mm : '—'} mm`);
  row('Description', f.description);
  y += 4;

  section('Lifecycle & SAP References');
  row('Current Status', f.status + (isOverdue(f) ? '  (OVERDUE)' : ''));
  if (f.target_date) row('Target Repair Date', paFmtDate(f.target_date));
  if (f.next_check_date) row('Re-inspect By', paFmtDate(f.next_check_date));
  if (f.sap_notification) row('SAP Notification', f.sap_notification);
  if (f.sap_order) row('SAP Order', f.sap_order);
  if (f.repair_method) row('Repair Method', f.repair_method);
  if (f.repaired_date) row('Repaired Date', paFmtDate(f.repaired_date));
  if (f.closing_note) row('Closing Note', f.closing_note);
  y += 4;

  /* ===== ASME B31.3 assessment sections (full calculator-grade report block) =====
     Only rendered when the finding has a saved assessment whose inputs still compute —
     section auto-numbering means their absence leaves no gap. Numbers are re-derived from
     the saved inputs through the shared computeB313 engine (single math source); a legacy
     snapshot that can't re-compute falls back to a compact summary of its saved results. */
  if (assess && assessRes) {
    const inp = assess.inputs || {};
    const r = assessRes;
    const erf_no = r.mawp_no > 0 ? (r.P_input / r.mawp_no) : 9.99;
    // null mawp_with (remaining wall already at/below CA) -> n/a, not a pegged 9.99
    const erf_with = r.mawp_with == null ? null : (r.mawp_with > 0 ? (r.P_input / r.mawp_with) : 9.99);
    const schLabel = (PA_PIPE_DATABASE[inp.nps] && PA_PIPE_DATABASE[inp.nps].schedules[inp.schedule])
      ? PA_PIPE_DATABASE[inp.nps].schedules[inp.schedule].label : (inp.schedule || '—');

    const tableBase = {
      margin: { left: M, right: M, top: HEADER_H + 6, bottom: FOOTER_H + 4 },
      styles: { font: 'GoogleSans', fontSize: 8, cellPadding: 1.6, lineColor: PDF_BORDER, lineWidth: 0.15 },
      headStyles: { fillColor: PDF_NAVY, textColor: '#ffffff', fontStyle: 'bold', fontSize: 7.5 },
      didDrawPage: () => { if (doc.internal.getNumberOfPages() > 1) chrome(); }
    };

    // --- integrity status band (mirrors the on-screen workbench banner) ---
    section('ASME B31.3 Assessment');
    ensure(24);
    const iColor = r.status === 'OK' ? PDF_OK : r.status === 'MONITOR' ? PDF_WARN : PDF_DANGER;
    doc.setFillColor(iColor);
    doc.roundedRect(M, y, CW, 12, 1.5, 1.5, 'F');
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(14); doc.setTextColor('#ffffff');
    doc.text(`INTEGRITY STATUS: ${r.status}`, M + 4, y + 8);
    doc.setFont('courier', 'bold'); doc.setFontSize(8);
    doc.text(`ERF ${fmtN(erf_no, 3)}   MAWP ${fmtN(r.mawp_no, 1)} ${r.pUnit} (no CA)   MARGIN ${fmtN(r.margin, 3)} mm`, PW - M - 4, y + 8, { align: 'right' });
    y += 16;
    doc.setTextColor('#334155'); doc.setFont('GoogleSans', 'normal'); doc.setFontSize(8);
    const descLines = doc.splitTextToSize(r.desc, CW);
    ensure(descLines.length * 3.6 + 4);
    doc.text(descLines, M, y);
    y += descLines.length * 3.6 + 2;
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor(PDF_MUTED);
    doc.text(`Assessed ${fmtDateTime(assess.created_at)} by ${assess.created_by_email || '—'}`
      + (currentAssessments.length > 1 ? `  •  ${currentAssessments.length} assessments recorded — latest shown` : ''), M, y);
    doc.setTextColor(PDF_TEXT);
    y += 7;

    // --- input parameters ---
    section('Assessment Input Parameters');
    const modeIsDepth = inp.mode === 'depth';
    autoTable(doc, {
      ...tableBase,
      startY: y,
      theme: 'grid',
      head: [['Parameter', 'Symbol', 'Value', 'Unit', 'Source']],
      body: [
        ['Nominal pipe size / schedule', 'NPS', `${inp.nps} / ${schLabel}`, '—', 'ASME B36.10M'],
        ['Outside diameter', 'D', fmtN(r.D, 2), 'mm', 'B36.10M table'],
        ['Nominal wall thickness', 't_nom', fmtN(r.t_nom, 2), 'mm', 'B36.10M / as-built'],
        ['Measurement mode', '—', modeIsDepth ? 'Wall-loss depth' : 'Measured minimum', '—', 'Field input'],
        ['Wall loss depth', 'd', fmtN(r.depth, 2), 'mm', modeIsDepth ? 'Measured' : 'Derived'],
        ['Measured minimum thickness', 't_meas', fmtN(r.t_meas, 2), 'mm', modeIsDepth ? 'Derived' : 'UT measurement'],
        ['Corrosion type', '—', r.isInternal ? 'Internal wall loss' : 'External wall loss', '—', 'Field input'],
        ['Corrosion allowance', 'CA', fmtN(r.ca, 2), 'mm', 'Design'],
        ['Corrosion rate (optional)', 'CR', r.CR > 0 ? fmtN(r.CR, 3) : '—', 'mm/yr', 'Historical/estimated'],
        ['Design pressure', 'P', fmtN(r.P_input, 2), r.pUnit, 'Design'],
        ['Material', '—', materialName(inp.material), '—', 'Specification'],
        ['Allowable stress', 'S', fmtN(r.S, 1), 'MPa', 'B31.3 Table A-1'],
        ['Longitudinal joint factor', 'E', fmtN(r.E, 2), '—', 'B31.3 Table A-1B'],
        ['Weld strength reduction factor', 'W', fmtN(r.W, 2), '—', 'B31.3 Table 302.3.5'],
        ['Wall thickness coefficient', 'Y', fmtN(r.Y, 2), '—', 'B31.3 Table 304.1.1'],
      ],
      columnStyles: {
        1: { font: 'courier', halign: 'center', cellWidth: 18 },
        2: { font: 'courier', fontStyle: 'bold', halign: 'right', cellWidth: 40 },
        3: { halign: 'center', cellWidth: 16 },
      },
    });
    y = doc.lastAutoTable.finalY + 7;

    // --- cross-section figure ---
    if (xsecPng) {
      const figW = 150, figH = figW * 270 / 500;
      ensure(26 + figH + 14);
      section('Wall Thickness Cross-Section');
      doc.addImage(xsecPng, 'PNG', (PW - figW) / 2, y, figW, figH);
      y += figH + 4;
      figNum++;
      doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor(PDF_MUTED);
      doc.text(`Figure ${figNum} — Wall thickness cross-section (localized loss pocket; boundaries: t_req, t_req + CA, API 574 structural minimum)`, PW / 2, y, { align: 'center' });
      doc.setTextColor(PDF_TEXT);
      y += 8;
    }

    // --- results with verdicts ---
    section('Calculation Results');
    const life = r.remainingLife !== null ? (r.remainingLife >= 0 ? `${fmtN(r.remainingLife, 2)} years` : '0.00 years (exceeded)') : '—';
    autoTable(doc, {
      ...tableBase,
      startY: y,
      theme: 'grid',
      head: [['Quantity', 'Value', 'Criterion', 'Verdict']],
      body: [
        [{ content: 'THICKNESS', colSpan: 4, styles: { fillColor: '#e2e8f0', fontStyle: 'bold', fontSize: 7 } }],
        ['Nominal wall thickness t_nom', `${fmtN(r.t_nom, 2)} mm`, '—', ''],
        ['Remaining wall percentage', `${fmtN(r.pctRemainNom, 1)} %`, '>= 50 %', r.pctRemainNom >= 50 ? 'PASS' : 'CHECK'],
        ['Required thickness t_req', `${fmtN(r.t_req_noCA, 3)} mm`, '—', ''],
        ['Required incl. CA (t_req + CA)', `${fmtN(r.t_req_total, 3)} mm`, 't_meas >= t_req + CA', r.margin >= 0 ? 'PASS' : 'CHECK'],
        [`API 574 structural min t_struct${r.isCsRef ? ' *' : ''}`, `${fmtN(r.t_struct, 2)} mm`, 't_meas >= t_struct', r.t_meas >= r.t_struct ? 'PASS' : 'CHECK'],
        ['Remaining margin', `${fmtN(r.margin, 3)} mm`, '>= 0', r.margin >= 0 ? 'PASS' : 'CHECK'],
        [{ content: 'PRESSURE & ERF', colSpan: 4, styles: { fillColor: '#e2e8f0', fontStyle: 'bold', fontSize: 7 } }],
        ['Design pressure P', `${fmtN(r.P_input, 2)} ${r.pUnit}`, '—', ''],
        ['MAWP (no CA — current)', `${fmtN(r.mawp_no, 2)} ${r.pUnit}`, '>= P', r.mawp_no >= r.P_input ? 'PASS' : 'CHECK'],
        ['ERF (no CA — current)', fmtN(erf_no, 3), '<= 1.0', erf_no <= 1.0 ? 'PASS' : 'CHECK'],
        ['MAWP (with CA reserved)', r.mawp_with == null ? 'n/a — wall below CA' : `${fmtN(r.mawp_with, 2)} ${r.pUnit}`, '>= P', r.mawp_with == null ? '—' : (r.mawp_with >= r.P_input ? 'PASS' : 'CHECK')],
        ['ERF (with CA reserved)', erf_with == null ? 'n/a' : fmtN(erf_with, 3), '<= 1.0', erf_with == null ? '—' : (erf_with <= 1.0 ? 'PASS' : 'CHECK')],
        [{ content: 'REMAINING LIFE', colSpan: 4, styles: { fillColor: '#e2e8f0', fontStyle: 'bold', fontSize: 7 } }],
        ['Corrosion allowance CA', `${fmtN(r.ca, 2)} mm`, '—', ''],
        ['Corrosion rate CR', r.CR > 0 ? `${fmtN(r.CR, 3)} mm/yr` : '—', '—', ''],
        ['Estimated remaining life', life, '—', ''],
      ],
      columnStyles: {
        1: { font: 'courier', fontStyle: 'bold', halign: 'right', cellWidth: 42 },
        2: { font: 'courier', halign: 'center', cellWidth: 38 },
        3: { fontStyle: 'bold', halign: 'center', cellWidth: 18 },
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 3) {
          if (data.cell.raw === 'PASS') data.cell.styles.textColor = PDF_OK;
          if (data.cell.raw === 'CHECK') data.cell.styles.textColor = PDF_DANGER;
        }
      },
    });
    y = doc.lastAutoTable.finalY + 3;
    if (r.isCsRef) {
      ensure(6);
      doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor(PDF_WARN_DARK);
      doc.text('* API 574 structural minimum is a carbon/low-alloy steel reference table; not validated for the selected material.', M, y);
      doc.setTextColor(PDF_TEXT);
      y += 6;
    } else {
      y += 4;
    }
    if (r.margin < 0 || r.t_meas < r.t_struct) {
      const ffsText = 'RECOMMENDATION: One or more code checks did not pass. Consider a Level 1/2 fitness-for-service assessment per API 579-1/ASME FFS-1 or a B31G/RSTRENG remaining-strength evaluation before the repair/replace decision.';
      const ffsLines = doc.splitTextToSize(ffsText, CW);
      ensure(ffsLines.length * 3.4 + 4);
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(7.5); doc.setTextColor(PDF_WARN_MID);
      doc.text(ffsLines, M, y);
      doc.setTextColor(PDF_TEXT);
      y += ffsLines.length * 3.4 + 4;
    }

    // --- substituted equations (real stacked fractions, mirroring the on-screen .eq-box) ---
    // segs: plain strings baseline text; { num, den } a stacked fraction. Returns space consumed.
    function drawFractionRow(segs, x0, yTop, opts2) {
      const fs = (opts2 && opts2.fontSize) || 8;
      const font = (opts2 && opts2.font) || 'courier';
      const hasFraction = segs.some(s => typeof s !== 'string');
      const numOffset = 3.4, barOffset = 4.6, denOffset = 8.4;
      const flatBaseline = yTop + 3;
      const barBaseline = yTop + barOffset;
      let x = x0;
      segs.forEach(seg => {
        doc.setFont(font, 'normal'); doc.setFontSize(fs); doc.setTextColor(PDF_TEXT);
        if (typeof seg === 'string') {
          doc.text(seg, x, hasFraction ? barBaseline : flatBaseline);
          x += doc.getTextWidth(seg);
        } else {
          const numW = doc.getTextWidth(seg.num);
          const denW = doc.getTextWidth(seg.den);
          const w = Math.max(numW, denW) + 2;
          doc.text(seg.num, x + w / 2, yTop + numOffset, { align: 'center' });
          doc.setDrawColor(PDF_TEXT); doc.setLineWidth(0.25);
          doc.line(x, yTop + barOffset, x + w, yTop + barOffset);
          doc.text(seg.den, x + w / 2, yTop + denOffset, { align: 'center' });
          x += w;
        }
      });
      doc.setTextColor(PDF_TEXT);
      return hasFraction ? denOffset + 2 : 6;
    }

    const t_use_with = Math.max(0, r.t_meas - r.ca);
    const eqRows = [
      {
        label: 't_req = P · D / (2 · (S · E · W + P · Y))', ref: '[B31.3 304.1.2]',
        segs: ['t_req = ', { num: `${fmtN(r.P, 4)} · ${fmtN(r.D, 2)}`, den: `2(${fmtN(r.S, 1)}·${fmtN(r.E, 2)}·${fmtN(r.W, 2)} + ${fmtN(r.P, 4)}·${fmtN(r.Y, 2)})` }, ` = ${fmtN(r.t_req_noCA, 3)} mm`],
      },
      {
        label: 't_req_total = t_req + CA', ref: '',
        segs: [`t_req_total = ${fmtN(r.t_req_noCA, 3)} + ${fmtN(r.ca, 2)} = ${fmtN(r.t_req_total, 3)} mm`],
      },
      {
        label: 'MAWP (no CA, current) = 2 · S · E · W · t_meas / (D - 2 · Y · t_meas)', ref: '[B31.3 304.1.2]',
        segs: ['MAWP = ', { num: `2 · ${fmtN(r.S, 1)}·${fmtN(r.E, 2)}·${fmtN(r.W, 2)}·${fmtN(r.t_meas, 2)}`, den: `${fmtN(r.D, 2)} - 2·${fmtN(r.Y, 2)}·${fmtN(r.t_meas, 2)}` }, ` = ${fmtN(r.mawp_no, 2)} ${r.pUnit}`],
      },
      {
        label: 'ERF (no CA, current) = P / MAWP', ref: '',
        segs: ['ERF = ', { num: `${fmtN(r.P_input, 2)}`, den: `${fmtN(r.mawp_no, 2)}` }, ` = ${fmtN(erf_no, 3)}`],
      },
      {
        label: 'MAWP (with CA reserved) = 2 · S · E · W · t / (D - 2 · Y · t),  t = max(0, t_meas - CA)', ref: '',
        segs: [`t = ${fmtN(t_use_with, 2)} mm,  MAWP = `, { num: `2 · ${fmtN(r.S, 1)}·${fmtN(r.E, 2)}·${fmtN(r.W, 2)}·${fmtN(t_use_with, 2)}`, den: `${fmtN(r.D, 2)} - 2·${fmtN(r.Y, 2)}·${fmtN(t_use_with, 2)}` }, ` = ${fmtN(r.mawp_with, 2)} ${r.pUnit}`],
      },
      {
        label: 'ERF (with CA reserved) = P / MAWP', ref: '',
        segs: ['ERF = ', { num: `${fmtN(r.P_input, 2)}`, den: `${fmtN(r.mawp_with, 2)}` }, ` = ${fmtN(erf_with, 3)}`],
      },
    ];
    if (r.CR > 0 && r.remainingLife !== null) {
      eqRows.push({
        label: 'Remaining life = (t_meas - t_req_total) / CR', ref: '',
        segs: ['Life = ', { num: `${fmtN(r.t_meas, 2)} - ${fmtN(r.t_req_total, 3)}`, den: `${fmtN(r.CR, 3)}` }, ` = ${fmtN(r.remainingLife, 2)} years`],
      });
    }
    const rowHeight = (rw) => 4 + (rw.segs.some(s => typeof s !== 'string') ? 12.4 : 6) + 3;
    const totalEqH = eqRows.reduce((sum, rw) => sum + rowHeight(rw), 0);
    ensure(26 + Math.min(totalEqH, 120)); // keep the title with at least the first equations
    section('Governing Equations (Substituted)');
    eqRows.forEach(rw => {
      ensure(rowHeight(rw));
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(7.5); doc.setTextColor('#475569');
      doc.text(rw.label, M, y);
      if (rw.ref) {
        doc.setFont('GoogleSans', 'normal'); doc.setTextColor('#94a3b8');
        doc.text(rw.ref, PW - M, y, { align: 'right' });
      }
      y += 4;
      const consumed = drawFractionRow(rw.segs, M, y, { fontSize: 8.5, font: 'courier' });
      y += consumed + 3;
    });
    y += 1;

    // --- PCC-2 recommendation (shared paAdvisorItems — same content as the workbench) ---
    section('ASME PCC-2 Repair Recommendation');
    doc.setFontSize(8);
    paAdvisorItems(r).forEach(item => {
      const leadText = item.title ? `${item.title} ` : '';
      const bodyLines = doc.splitTextToSize(`• ${leadText}${item.body}`, CW - 2);
      ensure(bodyLines.length * 3.6 + item.sub.length * 3.6 + 2);
      doc.setFont('GoogleSans', 'normal'); doc.setTextColor(PDF_TEXT);
      doc.text(bodyLines, M, y);
      y += bodyLines.length * 3.6;
      item.sub.forEach(s => {
        const subLines = doc.splitTextToSize(`    - ${s}`, CW - 6);
        ensure(subLines.length * 3.6);
        doc.text(subLines, M + 2, y);
        y += subLines.length * 3.6;
      });
      y += 1.5;
    });
    y += 3;

    // --- scope & limitations (assessment-scoped disclaimer) ---
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5);
    const scopeLines = doc.splitTextToSize(PA_SCOPE_TEXT, CW);
    ensure(14 + scopeLines.length * 3.3 + 4); // keep the title with its text
    section('Scope & Limitations');
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor('#475569');
    doc.text(scopeLines, M, y);
    doc.setTextColor(PDF_TEXT);
    y += scopeLines.length * 3.3 + 6;
  } else if (assess) {
    // legacy snapshot whose inputs can't re-compute: fall back to its saved results
    const r = assess.results || {};
    section('ASME B31.3 Assessment (Latest)');
    row('Result', r.status);
    row('ERF (no CA — current)', fmtN(erfNo(r), 3));
    row('Required Thk. incl. CA', r.t_req_total != null ? `${fmtN(r.t_req_total, 3)} mm` : null);
    row('Measured Thickness', r.t_meas != null ? `${fmtN(r.t_meas, 2)} mm` : null);
    row('Remaining Margin', r.margin != null ? `${fmtN(r.margin, 3)} mm` : null);
    row('MAWP (no CA — current)', r.mawp_no != null ? `${fmtN(r.mawp_no, 2)} ${r.pUnit || ''}` : null);
    if (r.remainingLife != null) row('Est. Remaining Life', `${fmtN(r.remainingLife, 1)} years`);
    row('Assessed By', assess.created_by_email);
    row('Assessed At', fmtDateTime(assess.created_at));
    y += 4;
  }

  if (f.lat != null && f.lng != null) {
    section('Site Location');
    row('Coordinates', `${Number(f.lat).toFixed(6)}, ${Number(f.lng).toFixed(6)}`);
    if (mapImg) {
      const w = CW, h = w / 2;
      ensure(h + 12);
      y += 2;
      doc.addImage(mapImg, 'JPEG', M, y, w, h);
      doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
      doc.rect(M, y, w, h);
      y += h + 4;
      figNum++;
      doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor(PDF_MUTED);
      doc.text(`Figure ${figNum}: Satellite view of the finding location (pin marks recorded coordinates)`, PW / 2, y, { align: 'center' });
      doc.setTextColor(PDF_TEXT);
      y += 6;
    }
    y += 2;
  }

  if (photoData.length) {
    section('Photographic Record');
    for (const [kind, title] of [['found', 'As Found'], ['repaired', 'After Repair (Confirmation)']]) {
      const items = photoData.filter(p => p.kind === kind);
      if (!items.length) continue;
      ensure(10);
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8.5); doc.setTextColor(PDF_MUTED);
      doc.text(title.toUpperCase(), M, y + 3);
      y += 6;
      doc.setTextColor(PDF_TEXT);
      const gap = 6, cellW = (CW - gap) / 2, maxH = 62;
      for (let i = 0; i < items.length; i += 2) {
        const rowItems = items.slice(i, i + 2).map(p => {
          const s = Math.min(cellW / p.w, maxH / p.h);
          return { src: p.src, w: p.w * s, h: p.h * s };
        });
        const rh = Math.max.apply(null, rowItems.map(d => d.h));
        ensure(rh + 8);
        rowItems.forEach((d, j) => {
          const ix = M + j * (cellW + gap) + (cellW - d.w) / 2;
          doc.addImage(d.src, 'JPEG', ix, y, d.w, d.h);
          doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
          doc.rect(ix, y, d.w, d.h);
        });
        y += rh + 6;
      }
      y += 2;
    }
  }

  if (currentHistory.length) {
    section('Status History');
    // oldest first — a report reads chronologically
    currentHistory.slice().reverse().forEach(h => {
      const head = `${fmtDateTime(h.changed_at)}  —  ${h.old_status ? h.old_status + ' > ' : ''}${h.new_status}${h.changed_by_email ? '  (' + h.changed_by_email + ')' : ''}`;
      const noteLines = h.note ? doc.splitTextToSize(h.note, CW - 8) : [];
      const hh = 5.5 + (noteLines.length ? noteLines.length * 4 + 2 : 0);
      ensure(hh);
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8.5); doc.setTextColor(PDF_TEXT);
      doc.text(head, M, y + 3.5);
      if (noteLines.length) {
        doc.setFont('GoogleSans', 'normal'); doc.setFontSize(8.5); doc.setTextColor(PDF_MUTED);
        doc.text(noteLines, M + 4, y + 8);
        doc.setTextColor(PDF_TEXT);
      }
      y += hh;
    });
  }

  ensure(12);
  y += 5;
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor('#94a3b8');
  doc.text('— End of Report —', PW / 2, y, { align: 'center' });

  if (doc.putTotalPages) doc.putTotalPages('{tp}');
  return doc.output('blob');
}

async function exportFindingPdf() {
  if (!current) return;
  /* jsPDF is dynamic-imported inside the builder; no CDN-availability guard needed */
  const btn = $('btnPdf');
  setBusy(btn, true, 'Building PDF…');
  try {
    const blob = await buildFindingPdf();
    // blob anchor click = the one native-viewer approach that works everywhere incl. file://
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    notify('PDF failed: ' + e.message, true);
  } finally {
    setBusy(btn, false);
  }
}

/* ---------------- Management-summary PDF (the currently filtered register as one table) ---------------- */

// rows are resolved by the export dialog (selection else filter); includeBudget threads through
// to the report chrome + table.
async function exportSummaryPdf(rows, includeBudget) {
  /* jsPDF is dynamic-imported inside the builder; no CDN-availability guard needed */
  if (!rows || !rows.length) { notify('No findings to summarize with the current filters.', true); return; }
  const btn = $('btnExport');
  setBusy(btn, true, 'Building…');
  try {
    const blob = await buildSummaryPdf(rows, includeBudget);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    notify('Summary PDF failed: ' + e.message, true);
  } finally {
    setBusy(btn, false);
  }
}

// The export dialog: one button -> pick format + opt-in budget.
function openExportDialog() {
  const filtered = sortFindings(applyFilters(findings));
  const n = selectedIds.size ? selectedIds.size : filtered.length;
  if (!n) { notify('Nothing to export with the current filters.', true); return; }
  $('exportScope').textContent = selectedIds.size
    ? `Exporting ${selectedIds.size} selected finding${selectedIds.size === 1 ? '' : 's'}`
    : `Exporting ${filtered.length} finding${filtered.length === 1 ? '' : 's'} — current filter`;
  const pdfRadio = document.querySelector('input[name="exportFmt"][value="pdf"]');
  if (pdfRadio) pdfRadio.checked = true;
  $('exportInclBudget').checked = false;
  openDialog($('exportDlg'));
}

function runExport() {
  const fmt = (document.querySelector('input[name="exportFmt"]:checked') || {}).value || 'pdf';
  const includeBudget = $('exportInclBudget').checked;
  const filtered = sortFindings(applyFilters(findings));
  const rows = selectedIds.size ? filtered.filter(f => selectedIds.has(f.id)) : filtered;
  closeDialog($('exportDlg'));
  if (fmt === 'csv') exportCsv(rows, includeBudget);
  else exportSummaryPdf(rows, includeBudget);
}

async function buildSummaryPdf(rows, includeBudget) {
  {
    const { jsPDF } = await import('jspdf'); const { default: autoTable } = await import('jspdf-autotable');
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
    registerGoogleSansFonts(doc); // asset/shared.js — use doc.setFont('GoogleSans', ...) below
    const PW = 297, PH = 210, M = 12; // landscape A4 — extra width for the Map + Photo columns
    const HEADER_H = 13, FOOTER_H = 14;
    const DANGER = '#dc2626';
    const now = new Date();
    // Baht for the PDF: the ฿ glyph (U+0E3F) isn't WinAnsi-safe and jsPDF drops it, so use "THB".
    const thb = n => (n == null || !isFinite(n)) ? '—' : 'THB ' + Math.round(n).toLocaleString('en-US');
    const thbNum = n => (n == null || !isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US');
    const logo = (typeof OR_LOGO_DATAURL !== 'undefined' && OR_LOGO_DATAURL) || await fetchAsDataUrl('asset/RGB_OR_Full color.png', 3000);
    const logoIm = logo ? await loadImg(logo) : null;

    const term = filters.terminal || 'All terminals';
    const stat = filters.status === '__overdue' ? 'Overdue only'
      : filters.status === '__complete' ? 'Complete only'
      : filters.status === '__outstanding' ? 'Outstanding only'
      : (filters.status || 'All statuses');
    const cnt = (s) => rows.filter(f => f.status === s).length;
    const overdue = rows.filter(isOverdue).length;

    // Pre-fetch a small map + the earliest "as found" photo per row. autoTable's didDrawCell
    // runs synchronously during table layout, so every async image fetch has to be resolved
    // before doc.autoTable() is called — there is no way to await inside it. One photo only,
    // even if a finding has several (per design: keep each row a fixed, predictable height).
    const MAP_PX = { w: 240, h: 150 };
    const [mapImgs, photoImgs] = await Promise.all([
      Promise.all(rows.map(f => (f.lat != null && f.lng != null) ? composeMapPng(f.lat, f.lng, 16, MAP_PX.w, MAP_PX.h) : null)),
      Promise.all(rows.map(async f => {
        const p = photoThumbs[f.id];
        if (!p) return null;
        const durl = await fetchAsDataUrl(photoUrl(p.storage_path), 6000);
        if (!durl) return null;
        const im = await loadImg(durl);
        return im ? { dataUrl: durl, ratio: im.naturalWidth / im.naturalHeight } : null;
      }))
    ]);

    // Same header/footer chrome as the finding & calculator reports, compressed to a shorter
    // band (HEADER_H=13 vs the portrait reports' 18 — this report has no title/date subline
    // worth the extra height, so logo + title share one compact row instead of two).
    function chrome() {
      const textOR = () => { doc.setFont('GoogleSans', 'bold'); doc.setFontSize(11); doc.setTextColor(PDF_NAVY); doc.text('OR', M, 8.5); };
      if (logoIm) { const lh = 7.5, lw = lh * logoIm.naturalWidth / logoIm.naturalHeight; try { doc.addImage(logo, 'PNG', M, 2.5, lw, lh); } catch (_) { textOR(); } }
      else textOR();
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(10); doc.setTextColor(PDF_NAVY);
      doc.text('PIPING FINDINGS SUMMARY', PW - M, 6.5, { align: 'right' });
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7); doc.setTextColor('#64748b');
      doc.text(`${term}  ·  ${stat}  ·  ${paFmtDate(now)}`, PW - M, 10.5, { align: 'right' });
      doc.setDrawColor(PDF_NAVY); doc.setLineWidth(0.6); doc.line(M, HEADER_H - 1, PW - M, HEADER_H - 1);

      doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2); doc.line(M, PH - FOOTER_H, PW - M, PH - FOOTER_H);
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7.5); doc.setTextColor('#64748b');
      doc.text('Piping integrity — findings summary', M, PH - FOOTER_H + 4);
      doc.text(`Page ${doc.internal.getNumberOfPages()} of {tp}`, PW / 2, PH - FOOTER_H + 4, { align: 'center' });
      doc.text(`Generated ${paFmtDateTime(now)}`, PW - M, PH - FOOTER_H + 4, { align: 'right' });
      doc.setFontSize(6.5); doc.setTextColor('#94a3b8');
      doc.text('Central and Eastern Engineering and Maintenance Division — PTT Oil and Retail Business Public Company Limited', PW / 2, PH - FOOTER_H + 9, { align: 'center' });
      doc.setTextColor(PDF_TEXT);
    }

    chrome();
    let y = HEADER_H + 8;
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(9); doc.setTextColor(PDF_TEXT);
    doc.text(`${rows.length} findings   ·   Open ${cnt('Open')}   ·   Monitoring ${cnt('Monitoring')}   ·   Repair Planned ${cnt('Repair Planned')}   ·   Repaired ${cnt('Repaired')}`, M, y);
    if (overdue) { doc.setFont('GoogleSans', 'bold'); doc.setTextColor(DANGER); doc.text(`${overdue} OVERDUE`, PW - M, y, { align: 'right' }); doc.setTextColor(PDF_TEXT); doc.setFont('GoogleSans', 'normal'); }
    y += 6;

    // Budget headline (opt-in) — outstanding = not yet Repaired/Closed, with a severity split.
    if (includeBudget) {
      const out = rows.filter(f => f.status !== 'Repaired' && f.status !== 'Closed');
      const sum = arr => arr.reduce((s, f) => s + (Number(f.estimated_cost) || 0), 0);
      const sev = s => thb(sum(out.filter(f => f.severity === s)));
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(9); doc.setTextColor(PDF_NAVY);
      doc.text(`Outstanding repair budget: ${thb(sum(out))}`, M, y);
      doc.setFont('GoogleSans', 'normal'); doc.setTextColor(PDF_MUTED);
      doc.text(`High ${sev('High')}  ·  Medium ${sev('Medium')}  ·  Low ${sev('Low')}`, M + 90, y);
      doc.setTextColor(PDF_TEXT);
      y += 6;
    }

    // Type column carries the finding type plus, on their own wrapped lines, the Location
    // Description and Anomaly Description (when present) — folded in here rather than as two
    // more narrow columns, which would squeeze Map/Photo below a useful size.
    const body = rows.map((f, i) => {
      const typeLines = [f.finding_type];
      // Location is the tag-column label when there's no Line No. yet — don't repeat it here.
      if (f.pipe_tag && f.location_desc) typeLines.push(`Loc: ${f.location_desc}`);
      if (f.description) typeLines.push(`Anomaly: ${f.description}`);
      const cells = [
        String(i + 1), f.terminal, f.pipe_tag || f.location_desc || '—', typeLines.join('\n'), f.status, f.severity || '—',
        (dueDateOf(f) ? paFmtDate(dueDateOf(f)) : '—') + (isOverdue(f) ? '  (OVERDUE)' : ''),
        (ageDays(f) != null ? ageDays(f) + 'd' : '—')
      ];
      if (includeBudget) cells.push(thbNum(f.estimated_cost)); // before Map/Photo (unit in the header)
      cells.push('', ''); // Map, Photo
      return cells;
    });

    // Fit an image into a cell, letterboxed and centered, capped by BOTH the column width and
    // the fixed row height (minCellHeight below) — without this a portrait phone photo would
    // blow the row far taller than its map/text neighbors.
    function drawFitted(dataUrl, format, ratio, cell) {
      const pad = 1.2;
      const availW = cell.width - pad * 2, availH = cell.height - pad * 2;
      let w = availW, h = w / ratio;
      if (h > availH) { h = availH; w = h * ratio; }
      const x = cell.x + (cell.width - w) / 2, y2 = cell.y + (cell.height - h) / 2;
      try { doc.addImage(dataUrl, format, x, y2, w, h); } catch (_) {}
    }
    function drawEmptyNote(text, cell) {
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7); doc.setTextColor('#94a3b8');
      doc.text(text, cell.x + cell.width / 2, cell.y + cell.height / 2, { align: 'center', baseline: 'middle' });
      doc.setTextColor(PDF_TEXT);
    }

    // With the opt-in Est. Cost column, Map/Photo shift right by one; index everything off that.
    const MAP_COL = includeBudget ? 9 : 8;
    const PHOTO_COL = includeBudget ? 10 : 9;
    const head = ['#', 'Terminal', 'Pipe Tag', 'Type', 'Status', 'Sev.', 'Due', 'Age'];
    if (includeBudget) head.push('Est. Cost (THB)');
    head.push('Map', 'Photo');
    const colStyles = {
      0: { cellWidth: 8, halign: 'right', valign: 'middle' },
      1: { cellWidth: 17, valign: 'middle' },
      2: { cellWidth: 42, fontStyle: 'bold', valign: 'middle' }, // long tags (e.g. 953-P-009-10"-D1101-ET-80) need real room
      4: { cellWidth: 20, valign: 'middle' },
      5: { cellWidth: 18, valign: 'middle' }, // "Medium" needs more room than the other two severities
      6: { cellWidth: 22, valign: 'middle' },
      7: { cellWidth: 11, valign: 'middle' },
      // Map/Photo slightly narrower when budget is on to make room for the Est. Cost column.
      [MAP_COL]: { cellWidth: includeBudget ? 28 : 32 },
      [PHOTO_COL]: { cellWidth: includeBudget ? 28 : 32 }
      // column 3 (Type + Loc/Anomaly sub-lines) is left unset -> autoTable gives it whatever
      // width remains; text is drawn manually in didDrawCell so its own valign doesn't matter.
    };
    if (includeBudget) colStyles[8] = { cellWidth: 22, halign: 'right', valign: 'middle', fontStyle: 'bold' };
    autoTable(doc, {
      startY: y,
      head: [head],
      body,
      theme: 'grid',
      styles: { font: 'GoogleSans', fontSize: 8, cellPadding: 1.6, lineColor: '#e2e8f0', lineWidth: 0.1, textColor: '#0f172a', overflow: 'linebreak', minCellHeight: 26, valign: 'top' },
      headStyles: { fillColor: PDF_NAVY, textColor: '#ffffff', fontStyle: 'bold', fontSize: 8, valign: 'middle', cellPadding: { top: 2.2, right: 1.6, bottom: 2.2, left: 1.6 }, minCellHeight: 0 },
      alternateRowStyles: { fillColor: '#f8fafc' },
      columnStyles: colStyles,
      margin: { left: M, right: M, top: HEADER_H + 6, bottom: FOOTER_H + 4 },
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        const f = rows[data.row.index];
        if (data.column.index === 4) { data.cell.styles.textColor = STATUS_COLORS[f.status] || '#334155'; data.cell.styles.fontStyle = 'bold'; }
        if (data.column.index === 6 && isOverdue(f)) { data.cell.styles.textColor = DANGER; data.cell.styles.fontStyle = 'bold'; }
      },
      didDrawCell: (data) => {
        if (data.section !== 'body') return;
        const i = data.row.index;
        if (i < 0 || !rows[i]) return; // autotable fires a spanning row (index -1) at a page break
        if (data.column.index === MAP_COL) {
          const img = mapImgs[i];
          if (img) drawFitted(img, 'JPEG', MAP_PX.w / MAP_PX.h, data.cell);
          else drawEmptyNote('No location', data.cell);
        }
        if (data.column.index === PHOTO_COL) {
          const ph = photoImgs[i];
          if (ph) drawFitted(ph.dataUrl, 'JPEG', ph.ratio, data.cell);
          else drawEmptyNote('No photo', data.cell);
        }
        // Re-draw the Type cell manually: line 1 (finding type) bold/dark, the Loc:/Anomaly:
        // sub-lines muted/smaller — autoTable has no per-line style within one cell.
        if (data.column.index === 3) {
          const f = rows[i];
          const lines = data.cell.text;
          // Use the fill color autoTable itself already computed for this cell (via
          // alternateRowStyles) rather than re-deriving odd/even here — a hand-rolled i%2 can
          // disagree with autoTable's own row parity (e.g. across a page break), which is why
          // the Type column's stripe was drifting out of sync with the rest of the row.
          // Inset the repaint rect by half the grid line width (autoTable centers its border
          // stroke on the cell boundary) so this fill never overpaints the border itself — that
          // was why the Type column's left/right borders looked thinner than every other column's.
          const inset = 0.15;
          doc.setFillColor(data.cell.styles.fillColor || '#ffffff');
          doc.rect(data.cell.x + inset, data.cell.y + inset, data.cell.width - inset * 2, data.cell.height - inset * 2, 'F');
          let ty = data.cell.y + 3.6;
          const tx = data.cell.x + data.cell.styles.cellPadding;
          doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8); doc.setTextColor(PDF_TEXT);
          doc.text(f.finding_type, tx, ty);
          ty += 3.6;
          doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7); doc.setTextColor('#64748b');
          lines.slice(1).forEach(line => { doc.text(line, tx, ty); ty += 3.2; });
          doc.setTextColor(PDF_TEXT);
        }
      },
      didDrawPage: () => chrome()
    });

    if (doc.putTotalPages) doc.putTotalPages('{tp}');
    return doc.output('blob');
  }
}

/* ---------------- init ---------------- */

// The app header is itself position:sticky (theme.css) and its height varies responsively
// (subtitle hidden <640px, smaller logo <700px, font metrics, etc). Sticky elements further
// down the page (the detail toolbar) need to stack BELOW it, not collide at top:0 — measure
// the real height into a custom property so their CSS can offset by it exactly.
function syncHeaderHeight() {
  const header = document.querySelector('body > header');
  if (header) document.documentElement.style.setProperty('--app-header-h', header.offsetHeight + 'px');
}

function initApp() {
  syncHeaderHeight();
  window.addEventListener('resize', syncHeaderHeight);
  window.addEventListener('resize', () => {
    document.querySelectorAll('.view.active .seg-row').forEach(row => positionSegPill(row, false));
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncHeaderHeight);

  if (false) { // Supabase client is bundled (./core/supabase); CDN-load guard can never trigger
    show('viewLogin');
    const errBox = $('loginErr');
    errBox.textContent = 'Could not load the database library — check your internet connection and reload.';
    errBox.style.display = 'block';
    $('btnSignIn').disabled = true;
    return;
  }

  // sb already created at import time (./core/supabase); nothing to do here.

  $('fType').innerHTML = '<option value="" selected disabled>Select type…</option>' +
    FINDING_TYPES.map(t => `<option>${t}</option>`).join('');
  $('filType').innerHTML = '<option value="">All types</option>' +
    FINDING_TYPES.map(t => `<option>${t}</option>`).join('');

  // auth
  $('btnSignIn').addEventListener('click', signIn);
  $('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
  $('btnSignOut').addEventListener('click', async () => { await sb.auth.signOut(); location.hash = ''; });

  // Only re-route when signed-in state actually flips — a TOKEN_REFRESHED event mid-form
  // must not re-render and wipe the user's unsaved input.
  sb.auth.onAuthStateChange((event, s) => {
    const wasAuthed = !!session;
    session = s;
    updateAuthUI();
    if (event === 'INITIAL_SESSION' || wasAuthed !== !!s) route();
  });

  // routing
  window.addEventListener('hashchange', route);

  // list
  $('btnNew').addEventListener('click', () => { location.hash = '#/new'; });
  $('segTerminal').querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $('segTerminal').querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      positionSegPill($('segTerminal'), true);
      filters.terminal = btn.dataset.t;
      renderList();
    });
  });
  $('filStatus').addEventListener('change', () => { filters.status = val('filStatus'); renderList(); });
  $('kpiRingCard').addEventListener('click', () => {
    filters.status = '__complete';
    $('filStatus').value = '__complete';
    renderList();
  });
  $('kpiBudgetCard').addEventListener('click', () => {
    filters.status = '__outstanding';
    $('filStatus').value = '__outstanding';
    renderList();
  });
  $('filType').addEventListener('change', () => { filters.type = val('filType'); renderList(); });
  $('filSearch').addEventListener('input', () => {
    filters.q = val('filSearch');
    const rows = sortFindings(applyFilters(findings));
    renderTable(rows);
    renderMap(rows);
  });
  $('btnResetFilters').addEventListener('click', () => {
    filters.terminal = ''; filters.status = ''; filters.type = ''; filters.q = '';
    $('segTerminal').querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.t === ''));
    positionSegPill($('segTerminal'), true);
    $('filStatus').value = '';
    $('filType').value = '';
    $('filSearch').value = '';
    renderList();
  });
  // Register photo thumbnails: remembered on/off (localStorage), applied on load before the
  // first render so the register never flashes photos-on then off.
  const applyPhotoToggle = (hidden) => {
    document.body.classList.toggle('hide-row-photos', hidden);
    $('btnTogglePhotos').textContent = hidden ? 'Show photos' : 'Hide photos';
    $('btnTogglePhotos').setAttribute('aria-pressed', String(!hidden));
  };
  applyPhotoToggle(localStorage.getItem('hideRowPhotos') === '1');
  $('btnTogglePhotos').addEventListener('click', () => {
    const hidden = !document.body.classList.contains('hide-row-photos');
    localStorage.setItem('hideRowPhotos', hidden ? '1' : '0');
    applyPhotoToggle(hidden);
  });
  $('btnExport').addEventListener('click', openExportDialog);
  $('exportCancel').addEventListener('click', () => closeDialog($('exportDlg')));
  $('exportRun').addEventListener('click', runExport);
  $('btnImport').addEventListener('click', openImportDialog);
  $('importCancel').addEventListener('click', () => closeDialog($('importDlg')));
  $('importTemplateLink').addEventListener('click', (e) => { e.preventDefault(); downloadImportTemplate(); });
  $('importFile').addEventListener('change', (e) => { if (e.target.files[0]) parseImportFile(e.target.files[0]); });
  $('importConfirm').addEventListener('click', doImport);

  $('btnLineList').addEventListener('click', openLineListManageDialog);
  $('lineListManageClose').addEventListener('click', () => closeDialog($('lineListManageDlg')));
  $('lineListSearch').addEventListener('input', renderLineListManageTable);
  $('lineListManageImportBtn').addEventListener('click', openLineListImportDialog);
  $('lineListImportCancel').addEventListener('click', () => closeDialog($('lineListImportDlg')));
  $('lineListImportTemplateLink').addEventListener('click', (e) => { e.preventDefault(); downloadLineListTemplate(); });
  $('lineListImportFile').addEventListener('change', (e) => { if (e.target.files[0]) parseLineListImportFile(e.target.files[0]); });
  $('lineListImportConfirm').addEventListener('click', doLineListImport);
  $('chkSelectAll').addEventListener('change', (e) => {
    lastRenderedRows.forEach(f => { if (e.target.checked) selectedIds.add(f.id); else selectedIds.delete(f.id); });
    renderTable(lastRenderedRows);
  });
  $('btnSelClear').addEventListener('click', () => { selectedIds.clear(); renderTable(lastRenderedRows); });

  // map legend generated from STATUS_COLORS so pins and legend can never drift apart
  $('mapLegend').innerHTML = Object.entries(STATUS_COLORS)
    .map(([st, c]) => `<span class="lg-item"><span class="lg-dot" style="background:${c};"></span>${esc(st)}</span>`)
    .join('') +
    '<span class="lg-item"><span class="lg-dot lg-overdue"></span>Overdue</span>';

  // form
  initAssessment();
  initQuickCalc();
  $('btnSave').addEventListener('click', () => saveForm(false));
  $('btnSaveAnother').addEventListener('click', () => saveForm(true));
  $('fTag').addEventListener('change', applyTagMemory);
  initTagCombo();
  $('btnDelete').addEventListener('click', deleteFinding);
  $('btnClearLoc').addEventListener('click', clearPin);
  const coordChanged = () => {
    const lat = parseFloat(val('fLat')), lng = parseFloat(val('fLng'));
    if (isFinite(lat) && isFinite(lng)) setPin(lat, lng, true);
  };
  $('fLat').addEventListener('change', coordChanged);
  $('fLng').addEventListener('change', coordChanged);

  $('btnAddPendingPhoto').addEventListener('click', () => $('filePending').click());
  $('filePending').addEventListener('change', async (e) => { await addPendingFiles([...e.target.files]); e.target.value = ''; });

  // detail
  $('btnEdit').addEventListener('click', () => { if (current) location.hash = '#/edit/' + current.id; });
  $('btnPdf').addEventListener('click', exportFindingPdf);
  // the full assessment workbench lives on the edit form now (the calculator page is retired)
  $('btnAssess').addEventListener('click', () => { if (current) location.hash = '#/edit/' + current.id; });
  // clicking a group's "+ Add" also makes that group the target for the next Ctrl+V paste
  $('btnAddFound').addEventListener('click', () => { photoPasteTarget = 'found'; $('fileFound').click(); });
  $('btnAddRepaired').addEventListener('click', () => { photoPasteTarget = 'repaired'; $('fileRepaired').click(); });
  $('fileFound').addEventListener('change', (e) => { addDetailPhotos([...e.target.files], 'found'); e.target.value = ''; });
  $('fileRepaired').addEventListener('change', (e) => { addDetailPhotos([...e.target.files], 'repaired'); e.target.value = ''; });

  // Same wiring for the edit form's Photographic Record panel — uploads against editingId
  // explicitly (not current.id: `current` may point at a different finding than the one being
  // edited if the user navigated straight from the dashboard list rather than via its detail page).
  $('btnAddFound2').addEventListener('click', () => { photoPasteTarget = 'found'; $('fileFound2').click(); });
  $('btnAddRepaired2').addEventListener('click', () => { photoPasteTarget = 'repaired'; $('fileRepaired2').click(); });
  $('fileFound2').addEventListener('change', (e) => { addDetailPhotos([...e.target.files], 'found', editingId); e.target.value = ''; });
  $('fileRepaired2').addEventListener('change', (e) => { addDetailPhotos([...e.target.files], 'repaired', editingId); e.target.value = ''; });
  $('fileDlgRepaired').addEventListener('change', (e) => { addDetailPhotos([...e.target.files], 'repaired'); e.target.value = ''; });

  // Ctrl+V paste of an image: on a new finding it queues an as-found photo; on the edit form
  // (existing finding) and the detail page it uploads immediately to whichever group's "+ Add"
  // was last used (defaults to As Found).
  document.addEventListener('paste', onPastePhoto);

  // dialogs
  $('dlgCancel').addEventListener('click', () => closeDialog($('statusDlg')));
  $('dlgConfirm').addEventListener('click', confirmStatusChange);
  $('lightbox').addEventListener('click', () => closeDialog($('lightbox')));
}

export { initApp };