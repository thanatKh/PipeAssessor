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
  if (viewId !== 'viewList') {
    toggleMapPresentation(false);
  }
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === viewId));
  window.scrollTo(0, 0);
  // Seg-row pills measure offsetLeft/offsetWidth, which read 0 while their view was
  // display:none — same gotcha as the dashboard/detail Leaflet maps. Re-snap (no animation)
  // now that the view is visible.
  document.querySelectorAll(`#${viewId} .seg-row`).forEach(row => positionSegPill(row, false));
}

// Public read-only share view (#/s/<id>) — no sign-in required. Intercepted before the auth gate;
// loads via the get_public_finding RPC and renders the normal detail view with read-only chrome
// (body.public-view hides edit/status/nav — see CSS). Kept minimal: any failure shows viewShareError.
async function routePublic(id) {
  document.body.classList.add('public-view');
  const ok = await loadPublicFinding(id);
  if (ok) { renderDetail(); show('viewDetail'); }
  else { show('viewShareError'); }
}

async function route() {
  const h = location.hash || '#/list';
  if (h.startsWith('#/s/')) { await routePublic(h.slice(4)); return; }
  document.body.classList.remove('public-view'); // any non-share route is the normal authed app
  if (!session) { show('viewLogin'); return; }

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
  if (h === '#/risk') {
    // needs current findings + every finding's latest assessment — load fresh each visit so the
    // ranking never shows stale data from before the last dashboard load
    await loadFindings();
    await loadRiskData();
    show('viewRisk');
    renderRiskPage();
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
  loadFindings, ageDays, STATUS_RANK, sortFindings, loadDetail, loadPublicFinding, photoUrl, applyFilters, KPI_RING_CIRCUMFERENCE, renderKpis, renderBudgetKpi, ensureDashMap, popupHtml, showAddFindingPopup, renderMap, highlightPin, flashRow, CAMERA_SVG, ageHtml, renderTable, updateSelectionUI, buildTagOptions, renderList, toggleMapPresentation, resetMapView, togglePresSidebar, toggleMapBaseLayer, toggleRiskRadius,
} from './features/dashboard';

/* ---------------- CSV export (filtered register, Excel-friendly UTF-8 BOM) ---------------- */

import {
  CSV_COLS, exportCsv, IMPORT_COLS, importHeaderMap, resolveFindingType, toImportDate, toImportNum, validateImportRow, renderImportPreview, parseImportFile, doImport, downloadImportTemplate, openImportDialog, LINE_LIST_IMPORT_COLS, lineListHeaderMap, resolveNps, resolveSchedule, resolveMaterialCode, validateLineListRow, renderLineListImportPreview, parseLineListImportFile, doLineListImport, downloadLineListTemplate, openLineListImportDialog, loadLineList, renderLineListManageTable, deleteLineListRow, openLineListManageDialog, initLineListTabs,
} from './features/import-export';

import {
  clearValidation, setPin, clearPin, ensurePickMap, renderPendingGrid, addPendingFiles, imageFilesFromClipboard, onPastePhoto, WALL_LOSS_TYPES, AUTO_ASSESS_TYPES, CORR_TYPE_BY_FINDING, syncCorrTypeFromFinding, syncLeakAndAssessRules, SEVERITY_BY_FINDING, suggestSeverityFromType, aMode, setAssessOn, updateAschedules, autofillAtnom, applyMaterialStress, gatherAssessParams, assessThickness, recalcAssessment, loadAssessmentInto, resetAssessment, initAssessment, initRepairAdvisor, applyTagMemory, TAG_COMBO_MAX, initTagCombo, initQuickCalc, openForm, collectForm, collectAssessment, uploadPhoto, saveForm, deleteFinding,
} from './features/form';

import {
  dItem, renderDetail, renderDetailMap, fmtN, erfNo, assessPill, materialName, CORR_TYPE_LABEL, assessSetupLine, resFromSnapshot, renderAssessments, photoThumb, PHOTO_GRID_SETS, renderPhotoGroups, addDetailPhotos, renderTimeline, openStatusDialog, renderDlgRepairedPhotos, confirmStatusChange,
} from './features/detail';

/* ---------------- Line Risk Ranking ---------------- */

import { loadRiskData, renderRiskPage, initRiskPage } from './features/risk';

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
  if (header) {
    const h = header.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--app-header-h', h.toFixed(2) + 'px');
  }
}

function initApp() {
  // If we're arriving on a public share link, hide the app chrome immediately (before the auth
  // state resolves) so a non-signed-in visitor never sees a flash of the login screen / app nav.
  if ((location.hash || '').startsWith('#/s/')) document.body.classList.add('public-view');
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
  initLineListTabs();
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

  $('mapColorBy').addEventListener('change', () => {
    setMapColorBy($('mapColorBy').value);
    renderList();
  });

  $('btnMapBaseLayer')?.addEventListener('click', () => toggleMapBaseLayer());

  $('presTerminalFilter')?.addEventListener('change', () => {
    filters.terminal = val('presTerminalFilter');
    $('filTerminal').value = filters.terminal;
    renderList();
  });

  $('btnPresReset')?.addEventListener('click', () => resetMapView());
  $('btnPresToggleSidebar')?.addEventListener('click', () => togglePresSidebar());
  $('btnPresSidebarClose')?.addEventListener('click', () => togglePresSidebar(false));
  $('btnRiskRadius')?.addEventListener('click', () => toggleRiskRadius());

  $('btnMapExpand')?.addEventListener('click', () => toggleMapPresentation());
  $('btnPresBack')?.addEventListener('click', () => toggleMapPresentation(false));
  window.addEventListener('keydown', (e) => {
    const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement?.tagName || ''));
    const isPresActive = $('dashMapPanel')?.classList.contains('map-presentation');

    if (e.key === 'Escape' && isPresActive) {
      toggleMapPresentation(false);
    } else if (e.key === '/' && document.activeElement !== $('filSearch') && !isTyping) {
      if (document.querySelector('#viewList.active')) {
        e.preventDefault();
        $('filSearch')?.focus();
      }
    } else if ((e.key === 'f' || e.key === 'F') && !isTyping) {
      if (document.querySelector('#viewList.active')) {
        e.preventDefault();
        toggleMapPresentation();
      }
    } else if ((e.key === 'r' || e.key === 'R') && isPresActive && !isTyping) {
      e.preventDefault();
      resetMapView();
    } else if ((e.key === 'l' || e.key === 'L') && isPresActive && !isTyping) {
      e.preventDefault();
      togglePresSidebar();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      if (document.querySelector('#viewForm.active')) {
        e.preventDefault();
        saveForm(false);
      }
    }
  });

  // Section navigation tabs smooth scrolling & scroll spy
  document.querySelectorAll('.form-section-nav .nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = tab.dataset.target;
      const targetEl = $(targetId);
      if (!targetEl) return;
      tab.parentElement?.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        const view = entry.target.closest('.view');
        const nav = view?.querySelector('.form-section-nav');
        if (nav && id) {
          const tab = nav.querySelector(`.nav-tab[data-target="${CSS.escape(id)}"]`);
          if (tab) {
            nav.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            tab.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
          }
        }
      }
    });
  }, { rootMargin: '-120px 0px -65% 0px', threshold: 0.1 });

  document.querySelectorAll('.panel[id]').forEach(p => sectionObserver.observe(p));

  // Actively Leaking warning toggle
  $('fIsLeaking')?.addEventListener('change', () => {
    syncLeakAndAssessRules();
  });

  // GPS Location button
  $('btnGpsLoc')?.addEventListener('click', () => {
    if (!navigator.geolocation) {
      notify('Geolocation is not supported by your browser.', true);
      return;
    }
    notify('Detecting GPS location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        $('fLat').value = lat.toFixed(6);
        $('fLng').value = lng.toFixed(6);
        setPin(lat, lng, true);
        notify('GPS location updated!');
      },
      (err) => {
        notify('Unable to detect GPS location: ' + err.message, true);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // Drag and Drop photo upload
  function setupDragAndDrop(targetEl, onFiles) {
    if (!targetEl) return;
    targetEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      targetEl.classList.add('drag-active');
    });
    targetEl.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      targetEl.classList.remove('drag-active');
    });
    targetEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      targetEl.classList.remove('drag-active');
      const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
      if (files.length) {
        await onFiles(files);
      }
    });
  }

  setupDragAndDrop($('pendingPhotoPanel'), async (files) => { await addPendingFiles(files); });
  setupDragAndDrop($('detailPanelPhotos'), async (files) => { await addDetailPhotos(files, 'found'); });
  setupDragAndDrop($('editPhotoPanel'), async (files) => { await addDetailPhotos(files, 'found', editingId); });

  // line risk ranking
  initRiskPage();

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