// @ts-nocheck — Phase 1: verified behaviorally (engine parity + Playwright), not via types yet.
// The engine (src/engine) and workbench are strictly typed; this file and the feature modules
// it wires together are typed incrementally in a later phase.
/* ============================================================================
   Pipe Assessor — the wiring hub. Auth (signIn/updateAuthUI), hash routing
   (route), the view switcher (show), header-height sync, and initApp (all
   DOM event wiring, run once on DOMContentLoaded from main.ts). Everything
   else — dashboard, form, detail, import/export, PDF builders — lives in
   ./features/* and ./core/*; this file imports and connects them.
   ============================================================================ */
import L from 'leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIconUrl from 'leaflet/dist/images/marker-icon.png';
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png';
import { sb } from './core/supabase';
import { computeB313, PA_PIPE_DATABASE, PA_MATERIALS, paDefaultScheduleForNps } from './engine/compute';
import { paFmtDate, paFmtDateTime, paFmtBaht, paFmtBahtShort } from './engine/format';
import { downscaleImage, OR_LOGO_DATAURL } from './engine/branding';
import { registerGoogleSansFonts, registerThaiPdfFont } from './engine/fonts';
import { paCreateAssessView, PA_SCOPE_TEXT, paCrossSectionPng } from './workbench/assess-view';
import {
  filters, session, findings, lineList, current, currentPhotos, currentHistory, currentAssessments, editingId, pendingPhotos, pickMap, pickMarker, dashMap, dashLayer, photoCounts, photoThumbs, dashMarkers, dashAddMarker, pendingNewCoords, selectedIds, lastRenderedRows, importValidRows, lineListValidRows, photoPasteTarget, assessResult, severityTouched, lastLoadedAssessInputs, awFormView, assessToggleTouched, awQuickView, detailMap, detailMarker, dlgTarget, setSession, setFindings, setLineList, setCurrent, setCurrentPhotos, setCurrentHistory, setCurrentAssessments, setEditingId, setPendingPhotos, setPickMap, setPickMarker, setDashMap, setDashLayer, setPhotoCounts, setPhotoThumbs, setDashMarkers, setDashAddMarker, setPendingNewCoords, setSelectedIds, setLastRenderedRows, setImportValidRows, setLineListValidRows, setPhotoPasteTarget, setAssessResult, setSeverityTouched, setLastLoadedAssessInputs, setAwFormView, setAssessToggleTouched, setAwQuickView, setDetailMap, setDetailMarker, setDlgTarget, setMapColorBy,
} from './core/state';

// Leaflet resolves its default marker icons relative to its own script URL, which breaks under
// bundling — repoint them at the bundled asset URLs so the position-picker pin shows.
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIconUrl, shadowUrl: markerShadowUrl });

import {
  FINDING_TYPES,
} from './core/constants';

import {
  $, val, positionSegPill, closeDialog, esc, notify, setBusy,
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
  loadFindings, ageDays, STATUS_RANK, sortFindings, loadDetail, photoUrl, applyFilters, KPI_RING_CIRCUMFERENCE, renderKpis, renderBudgetKpi, ensureDashMap, popupHtml, showAddFindingPopup, renderMap, highlightPin, flashRow, CAMERA_SVG, ageHtml, renderTable, updateSelectionUI, buildTagOptions, renderList,
} from './features/dashboard';

/* ---------------- CSV export (filtered register, Excel-friendly UTF-8 BOM) ---------------- */

import {
  CSV_COLS, exportCsv, IMPORT_COLS, importHeaderMap, resolveFindingType, toImportDate, toImportNum, validateImportRow, renderImportPreview, parseImportFile, doImport, downloadImportTemplate, openImportDialog, LINE_LIST_IMPORT_COLS, lineListHeaderMap, resolveNps, resolveSchedule, resolveMaterialCode, validateLineListRow, renderLineListImportPreview, parseLineListImportFile, doLineListImport, downloadLineListTemplate, openLineListImportDialog, loadLineList, renderLineListManageTable, deleteLineListRow, openLineListManageDialog,
} from './features/import-export';

import {
  clearValidation, setPin, clearPin, ensurePickMap, renderPendingGrid, addPendingFiles, imageFilesFromClipboard, onPastePhoto, WALL_LOSS_TYPES, AUTO_ASSESS_TYPES, CORR_TYPE_BY_FINDING, syncCorrTypeFromFinding, SEVERITY_BY_FINDING, suggestSeverityFromType, aMode, setAssessOn, updateAschedules, autofillAtnom, applyMaterialStress, gatherAssessParams, assessThickness, recalcAssessment, loadAssessmentInto, resetAssessment, initAssessment, initRepairAdvisor, applyTagMemory, TAG_COMBO_MAX, initTagCombo, initQuickCalc, openForm, collectForm, collectAssessment, uploadPhoto, saveForm, deleteFinding,
} from './features/form';

import {
  dItem, renderDetail, renderDetailMap, fmtN, erfNo, assessPill, materialName, CORR_TYPE_LABEL, assessSetupLine, resFromSnapshot, renderAssessments, photoThumb, PHOTO_GRID_SETS, renderPhotoGroups, addDetailPhotos, renderTimeline, openStatusDialog, renderDlgRepairedPhotos, confirmStatusChange,
} from './features/detail';

/* ===================== Finding PDF report =====================
   Same visual language as the calculator's report (navy headings, hairline
   #cbd5e1 frames, dd/Mmm/yyyy dates, WinAnsi-safe text only). Tables are drawn
   manually — no autotable dependency. Opens in the browser's native PDF viewer
   via a blob anchor (the one approach that also survives file://). */

import {
  PDF_NAVY, PDF_TEXT, PDF_MUTED, PDF_BORDER, PDF_OK, PDF_WARN, PDF_WARN_DARK, PDF_WARN_MID, PDF_DANGER, fetchAsDataUrl, loadImg, composeMapPng, buildFindingPdf, exportFindingPdf, exportSummaryPdf, openExportDialog, runExport, buildSummaryPdf,
} from './features/pdf';

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
  $('filTerminal').addEventListener('change', () => { filters.terminal = val('filTerminal'); renderList(); });
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
    $('filTerminal').value = '';
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

  // map legend + pin coloring mode (Status/Type/Severity) — see renderMapLegend/colorFor in
  // dashboard.ts; renderMap() renders both together on load and on every filter change.
  $('mapColorBy').addEventListener('change', () => {
    setMapColorBy($('mapColorBy').value);
    renderList();
  });

  // form
  initRepairAdvisor();
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