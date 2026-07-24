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
  filters, session, findings, lineList, current, currentPhotos, currentHistory, currentAssessments, editingId, pendingPhotos, pickMap, pickMarker, dashMap, dashLayer, photoCounts, photoThumbs, dashMarkers, dashAddMarker, pendingNewCoords, selectedIds, lastRenderedRows, importValidRows, lineListValidRows, photoPasteTarget, assessResult, severityTouched, lastLoadedAssessInputs, awFormView, assessToggleTouched, awQuickView, detailMap, detailMarker, dlgTarget, setSession, setFindings, setLineList, setCurrent, setCurrentPhotos, setCurrentHistory, setCurrentAssessments, setEditingId, setPendingPhotos, setPickMap, setPickMarker, setDashMap, setDashLayer, setPhotoCounts, setPhotoThumbs, setDashMarkers, setDashAddMarker, setPendingNewCoords, setSelectedIds, setLastRenderedRows, setImportValidRows, setLineListValidRows, setPhotoPasteTarget, setAssessResult, setSeverityTouched, setLastLoadedAssessInputs, setAwFormView, setAssessToggleTouched, setAwQuickView, setDetailMap, setDetailMarker, setDlgTarget, setMapColorBy, userRole, setUserRole, isMaintenance,
} from './core/state';

// Leaflet resolves its default marker icons relative to its own script URL, which breaks under
// bundling — repoint them at the bundled asset URLs so the position-picker pin shows.
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIconUrl, shadowUrl: markerShadowUrl });

import {
  FINDING_TYPES, ALLOWED_SIGNUP_DOMAINS, PUBLIC_BASE_URL,
} from './core/constants';

import {
  $, val, positionSegPill, closeDialog, esc, notify, setBusy, setPageLoading,
} from './core/dom';

function updateAuthUI() {
  document.body.classList.toggle('authed', !!session);
  // Role chrome: CSS hides maintenance-only controls under body.role-inspector (see app.css).
  // Only stamped while signed in, so the login/public views are unaffected.
  document.body.classList.toggle('role-inspector', !!session && !isMaintenance());
  document.body.classList.toggle('role-maintenance', !!session && isMaintenance());
  $('hdrUser').textContent = session ? (session.user.email || '') : '';
}

/* Read the signed-in user's role from public.profiles. Called before route() on every sign-in so
   the first paint already has the right chrome (same reasoning as the synchronous public-view body
   stamp in initApp). Falls back to the least-privileged role on any error — the DB is the real
   enforcement, so a failed read degrades to "show less", never "show more". */
async function loadProfile() {
  if (!session) { setUserRole('inspector'); return; }
  try {
    const { data, error } = await sb.from('profiles').select('role').eq('id', session.user.id).single();
    if (error) throw error;
    setUserRole(data && data.role === 'maintenance' ? 'maintenance' : 'inspector');
  } catch (_) {
    setUserRole('inspector');
  }
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

/* Toggle the login panel between Sign in and Create account. Pure view state — no auth calls. */
function setAuthMode(mode) {
  const creating = mode === 'register';
  document.body.classList.toggle('auth-register', creating);
  $('loginErr').style.display = 'none';
  $('regDone').hidden = true;
  $('loginTitle').textContent = creating ? 'Create account' : 'Sign in';
  $('loginSub').textContent = creating
    ? `Use your company email (${ALLOWED_SIGNUP_DOMAINS.map(d => '@' + d).join(' or ')}). New accounts start with the Inspector role.`
    : 'Sign in with your company email, or create an account below.';
}

async function signUp() {
  const errBox = $('loginErr');
  errBox.style.display = 'none';
  $('regDone').hidden = true;
  const email = val('loginEmail').trim();
  const pass = val('loginPass');
  const confirm = val('regPass2');
  const fail = (msg) => { errBox.textContent = msg; errBox.style.display = 'block'; };

  if (!email || !pass) return fail('Enter both email and password.');
  if (pass.length < 8) return fail('Password must be at least 8 characters.');
  if (pass !== confirm) return fail('The two passwords do not match.');
  // Friendly pre-check only — pa_enforce_signup_domain on auth.users is the real gate.
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (!ALLOWED_SIGNUP_DOMAINS.includes(domain)) {
    return fail(`Registration is limited to ${ALLOWED_SIGNUP_DOMAINS.map(d => '@' + d).join(' and ')} email addresses.`);
  }

  setBusy($('btnRegister'), true, 'Creating…');
  const { data, error } = await sb.auth.signUp({ email, password: pass });
  setBusy($('btnRegister'), false);
  if (error) {
    // The domain trigger raises a DB error that surfaces here as a generic signup failure.
    return fail(/domain|restricted|check_violation/i.test(error.message)
      ? `Registration is limited to ${ALLOWED_SIGNUP_DOMAINS.map(d => '@' + d).join(' and ')} email addresses.`
      : error.message);
  }
  $('loginPass').value = '';
  $('regPass2').value = '';
  // With "Confirm email" on (required — see db/schema.sql section 9), signUp returns a user with
  // no session; the account only becomes usable after the emailed link is clicked.
  if (data && data.session) { return; } // confirmation disabled: onAuthStateChange routes us in
  $('regDone').hidden = false;
}

async function forgotPassword() {
  const errBox = $('forgotErr');
  errBox.style.display = 'none';
  $('forgotDone').hidden = true;
  const email = val('forgotEmail').trim();
  if (!email) {
    errBox.textContent = 'Enter your account email.';
    errBox.style.display = 'block';
    return;
  }
  setBusy($('btnSendReset'), true, 'Sending…');
  // redirectTo must be on Supabase's URL Configuration allow-list (Site URL / Redirect URLs) or
  // the link silently fails to return the user to the app.
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: PUBLIC_BASE_URL + '/' });
  setBusy($('btnSendReset'), false);
  // Deliberately do NOT branch on error to reveal whether the email exists — Supabase itself
  // returns success either way for this call, but keep the UI's own messaging enumeration-safe
  // too in case that ever changes upstream.
  if (error) {
    errBox.textContent = error.message;
    errBox.style.display = 'block';
    return;
  }
  $('forgotFields').hidden = true;
  $('btnSendReset').hidden = true;
  $('forgotDone').hidden = false;
}

async function setNewPassword() {
  const errBox = $('newPassErr');
  errBox.style.display = 'none';
  const p1 = val('newPass1');
  const p2 = val('newPass2');
  if (!p1 || p1.length < 8) {
    errBox.textContent = 'Password must be at least 8 characters.';
    errBox.style.display = 'block';
    return;
  }
  if (p1 !== p2) {
    errBox.textContent = 'The two passwords do not match.';
    errBox.style.display = 'block';
    return;
  }
  setBusy($('btnSetNewPassword'), true, 'Saving…');
  const { error } = await sb.auth.updateUser({ password: p1 });
  setBusy($('btnSetNewPassword'), false);
  if (error) {
    errBox.textContent = error.message;
    errBox.style.display = 'block';
    return;
  }
  $('newPass1').value = '';
  $('newPass2').value = '';
  notify('Password updated. You are signed in.');
  location.hash = '#/list';
  route();
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

  // Every branch below awaits at least one Supabase round-trip before the view actually renders
  // (most visibly right after sign-in, when this is the very first fetch of the session on
  // possibly a slow connection). Surface the top loading bar for the whole span so a few seconds
  // of "screen looks unchanged" reads as loading, not hung — see setPageLoading()/.page-loading-bar.
  setPageLoading(true);
  try {
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
    revealListSkeleton();
  } finally {
    setPageLoading(false);
  }
}

/* ---------------- data ---------------- */


import {
  loadFindings, ageDays, STATUS_RANK, sortFindings, loadDetail, loadPublicFinding, photoUrl, applyFilters, KPI_RING_CIRCUMFERENCE, renderKpis, renderBudgetKpi, ensureDashMap, popupHtml, showAddFindingPopup, renderMap, highlightPin, flashRow, CAMERA_SVG, ageHtml, renderTable, updateSelectionUI, buildTagOptions, renderList, toggleMapPresentation, resetMapView, togglePresSidebar, toggleRiskRadius, revealListSkeleton, swapText,
} from './features/dashboard';

/* ---------------- CSV export (filtered register, Excel-friendly UTF-8 BOM) ---------------- */

import {
  CSV_COLS, exportCsv, IMPORT_COLS, importHeaderMap, resolveFindingType, toImportDate, toImportNum, validateImportRow, renderImportPreview, parseImportFile, doImport, downloadImportTemplate, openImportDialog, LINE_LIST_IMPORT_COLS, lineListHeaderMap, resolveNps, resolveSchedule, resolveMaterialCode, validateLineListRow, renderLineListImportPreview, parseLineListImportFile, doLineListImport, downloadLineListTemplate, openLineListImportDialog, loadLineList, renderLineListManageTable, deleteLineListRow, openLineListManageDialog, initLineListTabs, openUsersDialog,
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

  // Number inputs (readings, pressures, coordinates, cost, …) default to changing value on
  // mouse-wheel scroll and Up/Down arrow keys while focused — a real hazard on a form full of
  // engineering figures, since scrolling the page past a focused number field silently nudges
  // its value with no visual cue. Both are killed globally (delegated, so it covers every
  // number input on every page without touching each one individually): blurring on wheel stops
  // the browser's own scroll-to-adjust behavior for that field while letting the page keep
  // scrolling normally, and Up/Down are preventDefault'd so tabbing/arrowing through a form
  // can't accidentally increment a value either.
  document.addEventListener('wheel', (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === 'number' && document.activeElement === t) t.blur();
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && t instanceof HTMLInputElement && t.type === 'number') {
      e.preventDefault();
    }
  });

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
  $('btnRegister').addEventListener('click', signUp);
  $('btnShowRegister').addEventListener('click', () => setAuthMode('register'));
  $('btnShowSignIn').addEventListener('click', () => setAuthMode('signin'));
  $('loginPass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.body.classList.contains('auth-register') ? signUp() : signIn();
  });
  $('regPass2').addEventListener('keydown', (e) => { if (e.key === 'Enter') signUp(); });

  $('btnShowForgot').addEventListener('click', () => {
    $('forgotErr').style.display = 'none';
    $('forgotDone').hidden = true;
    $('forgotFields').hidden = false;
    $('btnSendReset').hidden = false;
    $('forgotEmail').value = val('loginEmail'); // carry over whatever they'd typed on the sign-in form
    show('viewForgot');
  });
  $('btnForgotBackToSignIn').addEventListener('click', () => { setAuthMode('signin'); show('viewLogin'); });
  $('btnSendReset').addEventListener('click', forgotPassword);
  $('forgotEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') forgotPassword(); });

  $('btnSetNewPassword').addEventListener('click', setNewPassword);
  $('newPass2').addEventListener('keydown', (e) => { if (e.key === 'Enter') setNewPassword(); });

  $('btnSignOut').addEventListener('click', async () => {
    await sb.auth.signOut();
    setUserRole('inspector');
    setAuthMode('signin'); // never land back on the register form after signing out
    location.hash = '';
  });

  // Only re-route when signed-in state actually flips — a TOKEN_REFRESHED event mid-form
  // must not re-render and wipe the user's unsaved input.
  //
  // The actual work is deferred with setTimeout(...,0) rather than run directly in this
  // callback — a real bug shipped without it: supabase-js/gotrue-js holds an internal lock
  // while dispatching onAuthStateChange, and any Supabase call awaited synchronously inside
  // the callback (loadProfile()'s `sb.from('profiles')...`, or route()'s finding/line-list
  // queries) needs that same lock to attach the current session's Authorization header —
  // deadlock. It never resolved or rejected, so nothing ever threw, and no `.view` ever got
  // `.active`: page stuck blank forever (header/footer still show since those aren't
  // view-gated). Reproduced ONLY on a page load that restores an already-persisted session
  // (SIGNED_IN/INITIAL_SESSION fired during the client's own startup, while the lock is still
  // held) — a fresh interactive sign-in fires the event well after startup, lock already free,
  // which is why this was never caught: every prior E2E pass signed in fresh each time and
  // never reloaded an already-authenticated tab. `setTimeout(...,0)` defers to a new task,
  // after the dispatch (and its lock) has finished — the standard fix for this known
  // supabase-js gotcha.
  sb.auth.onAuthStateChange((event, s) => {
    setTimeout(async () => {
      const wasAuthed = !!session;
      setSession(s);
      const flipped = event === 'INITIAL_SESSION' || wasAuthed !== !!s;
      // Resolve the role BEFORE routing so the first paint already has the right chrome — a later
      // fetch would briefly render maintenance-only controls to an inspector. Only on a real flip:
      // re-fetching on every TOKEN_REFRESHED would be a pointless request every hour. This fetch
      // (plus route()'s own below) is the visible "after sign-in, nothing happens for a moment"
      // gap on a slow connection — keep the loading bar up across both.
      if (flipped) setPageLoading(true);
      try {
        if (flipped) await loadProfile();
        updateAuthUI();
        // PASSWORD_RECOVERY fires when the user lands via the emailed reset link — Supabase has
        // already signed them in with a recovery session at this point, so the normal `flipped ->
        // route()` path below would send them straight to the dashboard instead of letting them set
        // a new password. Show the dedicated view instead and skip the regular route() this one time.
        if (event === 'PASSWORD_RECOVERY') { show('viewNewPassword'); return; }
        if (flipped) route(); // route() manages its own setPageLoading span; not awaited here (unchanged from before)
      } finally {
        if (flipped) setPageLoading(false);
      }
    }, 0);
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
  const applyPhotoToggle = (hidden, animate) => {
    document.body.classList.toggle('hide-row-photos', hidden);
    const label = $('btnTogglePhotos').querySelector('.t-text-swap');
    const next = hidden ? 'Show photos' : 'Hide photos';
    if (animate) swapText(label, next); else label.textContent = next;
    $('btnTogglePhotos').setAttribute('aria-pressed', String(!hidden));
  };
  applyPhotoToggle(localStorage.getItem('hideRowPhotos') === '1', false); // no swap on initial restore
  $('btnTogglePhotos').addEventListener('click', () => {
    const hidden = !document.body.classList.contains('hide-row-photos');
    localStorage.setItem('hideRowPhotos', hidden ? '1' : '0');
    applyPhotoToggle(hidden, true);
  });
  $('btnExport').addEventListener('click', openExportDialog);
  $('exportCancel').addEventListener('click', () => closeDialog($('exportDlg')));
  $('exportRun').addEventListener('click', runExport);
  $('btnImport').addEventListener('click', openImportDialog);
  $('importCancel').addEventListener('click', () => closeDialog($('importDlg')));
  $('importTemplateLink').addEventListener('click', (e) => { e.preventDefault(); downloadImportTemplate(); });
  $('importFile').addEventListener('change', (e) => { if (e.target.files[0]) parseImportFile(e.target.files[0]); });
  $('importConfirm').addEventListener('click', doImport);

  $('btnUsers').addEventListener('click', openUsersDialog);
  $('usersClose').addEventListener('click', () => closeDialog($('usersDlg')));

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
