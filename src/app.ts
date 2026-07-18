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
import { registerGoogleSansFonts, registerThaiPdfFont } from './engine/fonts';
import { paCreateAssessView, paAdvisorItems, PA_SCOPE_TEXT, paCrossSectionPng } from './workbench/assess-view';
import {
  filters, session, findings, lineList, current, currentPhotos, currentHistory, currentAssessments, editingId, pendingPhotos, pickMap, pickMarker, dashMap, dashLayer, photoCounts, photoThumbs, dashMarkers, dashAddMarker, pendingNewCoords, selectedIds, lastRenderedRows, importValidRows, lineListValidRows, photoPasteTarget, assessResult, severityTouched, lastLoadedAssessInputs, awFormView, assessToggleTouched, awQuickView, detailMap, detailMarker, dlgTarget, setSession, setFindings, setLineList, setCurrent, setCurrentPhotos, setCurrentHistory, setCurrentAssessments, setEditingId, setPendingPhotos, setPickMap, setPickMarker, setDashMap, setDashLayer, setPhotoCounts, setPhotoThumbs, setDashMarkers, setDashAddMarker, setPendingNewCoords, setSelectedIds, setLastRenderedRows, setImportValidRows, setLineListValidRows, setPhotoPasteTarget, setAssessResult, setSeverityTouched, setLastLoadedAssessInputs, setAwFormView, setAssessToggleTouched, setAwQuickView, setDetailMap, setDetailMarker, setDlgTarget,
} from './core/state';

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
import {
  PHOTO_BUCKET, FINDING_TYPES, FINDING_TYPE_SHORT, STATUSES, PHOTO_LIMIT_PER_KIND, STATUS_META, STATUS_COLORS, DEFAULT_MAP_VIEW, SAT_TILES,
} from './core/constants';
// sb is imported from ./core/supabase (created once at module load).              // Supabase client

/* ---------------- helpers ---------------- */

import {
  $, val, positionSegPill, openDialog, closeDialog, esc, fmtDate, fmtDateTime, todayISO, isOverdue, dueDateOf, pillHtml, notify, setBusy,
} from './core/dom';

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

export function show(viewId) {
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


import {
  loadFindings, ageDays, STATUS_RANK, sortFindings, loadDetail, photoUrl, applyFilters, KPI_RING_CIRCUMFERENCE, renderKpis, renderBudgetKpi, renderTypeRadar, ensureDashMap, popupHtml, showAddFindingPopup, renderMap, highlightPin, flashRow, CAMERA_SVG, ageHtml, renderTable, updateSelectionUI, buildTagOptions, renderList,
} from './features/dashboard';

/* ---------------- CSV export (filtered register, Excel-friendly UTF-8 BOM) ---------------- */

import {
  CSV_COLS, exportCsv, IMPORT_COLS, importHeaderMap, resolveFindingType, toImportDate, toImportNum, validateImportRow, renderImportPreview, parseImportFile, doImport, downloadImportTemplate, openImportDialog, LINE_LIST_IMPORT_COLS, lineListHeaderMap, resolveNps, resolveSchedule, resolveMaterialCode, validateLineListRow, renderLineListImportPreview, parseLineListImportFile, doLineListImport, downloadLineListTemplate, openLineListImportDialog, loadLineList, renderLineListManageTable, deleteLineListRow, openLineListManageDialog,
} from './features/import-export';

import {
  clearValidation, setPin, clearPin, ensurePickMap, renderPendingGrid, addPendingFiles, imageFilesFromClipboard, onPastePhoto, WALL_LOSS_TYPES, AUTO_ASSESS_TYPES, CORR_TYPE_BY_FINDING, syncCorrTypeFromFinding, SEVERITY_BY_FINDING, suggestSeverityFromType, aMode, setAssessOn, updateAschedules, autofillAtnom, applyMaterialStress, gatherAssessParams, assessThickness, recalcAssessment, loadAssessmentInto, resetAssessment, initAssessment, applyTagMemory, TAG_COMBO_MAX, initTagCombo, initQuickCalc, openForm, collectForm, collectAssessment, uploadPhoto, saveForm, deleteFinding,
} from './features/form';

/* ---------------- detail view ---------------- */

function dItem(label, valueHtml) {
  return `<div class="d-item"><div class="d-label">${esc(label)}</div><div class="d-val">${valueHtml}</div></div>`;
}

function renderDetail() {
  const f = current;
  setPhotoPasteTarget('found'); // Ctrl+V defaults to As Found until the user uses After-Repair's + Add

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
    setDetailMap(L.map(el, { center: [f.lat, f.lng], zoom: 17, scrollWheelZoom: false }));
    L.tileLayer(SAT_TILES.url, { maxZoom: SAT_TILES.maxZoom, attribution: SAT_TILES.attribution }).addTo(detailMap);
    detailMap.on('focus click', () => detailMap.scrollWheelZoom.enable());
    detailMap.on('blur', () => detailMap.scrollWheelZoom.disable());
  }
  // panel was display:none until now -> re-measure, then place the pin and recentre
  setTimeout(() => {
    detailMap.invalidateSize();
    detailMap.setView([f.lat, f.lng], 17);
    const color = STATUS_COLORS[f.status] || '#64748b';
    if (!detailMarker) setDetailMarker(L.circleMarker([f.lat, f.lng], { radius: 9, weight: 3, color: '#ffffff', fillOpacity: 0.95 }).addTo(detailMap));
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

export function renderPhotoGroups() {
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
        setCurrentPhotos(currentPhotos.filter(p => p.id !== btn.dataset.id));
        renderPhotoGroups();
        notify('Photo deleted.');
      } catch (e) { notify('Delete failed: ' + e.message, true); }
    });
  });
}

// findingId defaults to current.id (the detail page's usage) but the edit form passes its own
// editingId explicitly, since `current` may not point at the finding being edited (e.g.
// navigating straight from the dashboard list to #/edit/<id> without visiting the detail page).
export async function addDetailPhotos(files, kind, findingId) {
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
  setCurrentPhotos(data || []);
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


function openStatusDialog(target) {
  setDlgTarget(target);
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
        setCurrentPhotos(currentPhotos.filter(p => p.id !== btn.dataset.id));
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
  await registerThaiPdfFont(doc); // auto-switches doc.text() to Noto Sans Thai for Thai codepoints
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
    await registerThaiPdfFont(doc); // auto-switches doc.text() to Noto Sans Thai for Thai codepoints
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
    setSession(s);
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
  $('btnAddFound').addEventListener('click', () => { setPhotoPasteTarget('found'); $('fileFound').click(); });
  $('btnAddRepaired').addEventListener('click', () => { setPhotoPasteTarget('repaired'); $('fileRepaired').click(); });
  $('fileFound').addEventListener('change', (e) => { addDetailPhotos([...e.target.files], 'found'); e.target.value = ''; });
  $('fileRepaired').addEventListener('change', (e) => { addDetailPhotos([...e.target.files], 'repaired'); e.target.value = ''; });

  // Same wiring for the edit form's Photographic Record panel — uploads against editingId
  // explicitly (not current.id: `current` may point at a different finding than the one being
  // edited if the user navigated straight from the dashboard list rather than via its detail page).
  $('btnAddFound2').addEventListener('click', () => { setPhotoPasteTarget('found'); $('fileFound2').click(); });
  $('btnAddRepaired2').addEventListener('click', () => { setPhotoPasteTarget('repaired'); $('fileRepaired2').click(); });
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