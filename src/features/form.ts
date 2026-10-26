// @ts-nocheck — Phase 1: ported 1:1 from the app monolith, verified behaviorally (engine
// parity + Playwright), not via types yet. Same posture as app.ts; strict typing added
// incrementally per module.
/* ============================================================================
   Finding form (new / edit): position picker, pending-photo queue, the
   assessment-workbench wiring (auto-enable, corrosion-type sync, severity
   suggestion, live recalc, tag combobox + per-tag memory), quick calc, and
   the form CRUD (open/collect/save/delete). Extracted from the app monolith.
   ============================================================================ */
import L from 'leaflet';
import { paPressureUsePct, paLimitGap, PA_LABELS } from '../workbench/labels';
import { icon } from '../core/icons';
import { syncSectionNav } from '../core/section-nav';
import { $, val, esc, notify, setBusy, positionSegPill, pillHtml, isOverdue, todayISO, inspectionDateIssue } from '../core/dom';
import {
  R2_UPLOAD_ENDPOINT, PUBLIC_BASE_URL, PHOTO_LIMIT_PER_KIND, DEFAULT_MAP_VIEW, SAT_TILES, WALL_LOSS_TYPES, NON_LEAKABLE_TYPES,
  REPAIR_METHOD_OPTIONS, TEMP_REPAIR_METHODS, TEMP_REPAIR_METHOD_KIND, TEMP_REPAIR_VERIFY_RESULTS,
  TEMP_REPAIR_VERIFY_METHODS, TEMP_REPAIR_MONITOR_FREQS,
} from '../core/constants';
import { sb } from '../core/supabase';
import { computeB313, PA_PIPE_DATABASE, PA_MATERIALS, paDefaultScheduleForNps } from '../engine/compute';
import { downscaleImage } from '../engine/branding';
import { paCreateAssessView } from '../workbench/assess-view';
import { resolveAdvisor, paRenderRepairAdvisor } from '../workbench/repair-advisor';
import {
  session, current, setCurrent, editingId, setEditingId, pendingPhotos, setPendingPhotos,
  pickMap, setPickMap, pickMarker, setPickMarker,
  assessResult, setAssessResult, severityTouched, setSeverityTouched,
  lastLoadedAssessInputs, setLastLoadedAssessInputs,
  awFormView, setAwFormView, assessToggleTouched, setAssessToggleTouched,
  awQuickView, setAwQuickView, photoPasteTarget, setPhotoPasteTarget,
  findings, lineList, pendingNewCoords, setPendingNewCoords, setCurrentPhotos, dlgTarget, isMaintenance,
} from '../core/state';
import { loadFindings, buildTagOptions } from './dashboard';
import { loadLineList } from './import-export';
import { exportQuickCalcPdf, buildQuickCalcPdf } from './pdf';
// show() is the router's view-switcher — stays in app.ts (the hub).
import { show } from '../app';
import { addDetailPhotos, renderPhotoGroups, materialName, photoAddUsable, photoAddTileHtml, syncPhotoDropZone } from './detail';
import { paFmtDate } from '../engine/format';

/* ---------------- form (new / edit) ---------------- */

export function clearValidation() {
  ['fTerminal', 'fLocationDesc', 'fType', 'fDepth', 'fInspDate', 'fEstCost'].forEach(id => $(id).removeAttribute('aria-invalid'));
  ['errTerminal', 'errLocationDesc', 'errType', 'errDepth', 'errInspDate', 'errEstCost'].forEach(id => $(id).style.display = 'none');
}

export function setPin(lat, lng, recenter) {
  $('fLat').value = lat.toFixed(6);
  $('fLng').value = lng.toFixed(6);
  if (pickMap && typeof L !== 'undefined') {
    if (!pickMarker) setPickMarker(L.marker([lat, lng]).addTo(pickMap));
    else pickMarker.setLatLng([lat, lng]);
    if (recenter) pickMap.setView([lat, lng], Math.max(pickMap.getZoom(), 16));
  }
}

export function clearPin() {
  $('fLat').value = '';
  $('fLng').value = '';
  if (pickMarker && pickMap) { pickMap.removeLayer(pickMarker); setPickMarker(null); }
}

export function ensurePickMap() {
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
  setPickMap(L.map(el, { center: DEFAULT_MAP_VIEW.center, zoom: DEFAULT_MAP_VIEW.zoom, scrollWheelZoom: true }));
  L.tileLayer(SAT_TILES.url, { maxZoom: SAT_TILES.maxZoom, attribution: SAT_TILES.attribution }).addTo(pickMap);
  pickMap.on('click', (e) => setPin(e.latlng.lat, e.latlng.lng, false));
  setTimeout(() => pickMap.invalidateSize(), 150);
}

export function renderPendingGrid() {
  const grid = $('pendingPhotoGrid');
  grid.innerHTML = pendingPhotos.map((p, i) =>
    `<div class="photo-thumb">
       <img src="${p.previewUrl}" alt="Pending photo">
       <button type="button" class="photo-remove" data-i="${i}" title="Remove" aria-label="Remove photo">${icon('x')}</button>
     </div>`).join('');
  // 'flex' not 'block' — see the identical note on detail.ts's renderPhotoGroups().
  $('pendingPhotoEmpty').style.display = pendingPhotos.length ? 'none' : 'flex';
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
  const usable = photoAddUsable(addBtn);
  syncPhotoDropZone($('pendingPhotoEmpty'), 'btnAddPendingPhoto', usable);
  if (pendingPhotos.length && usable) grid.insertAdjacentHTML('beforeend', photoAddTileHtml('btnAddPendingPhoto'));
}

// Queue as-found photos on the new-finding form (downscaled preview held in memory until save).
export async function addPendingFiles(files) {
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
  await applyPhotoExif(toQueue);
  if (files.length > toQueue.length) {
    notify(`${n} photo(s) queued (${files.length - toQueue.length} skipped — ${PHOTO_LIMIT_PER_KIND} max reached).`, true);
  }
  return n;
}

// Fill the pin and Inspection Date from the photos' EXIF (GPS + DateTimeOriginal) — only
// fields that are still empty, so a manually placed pin or typed date always wins. Read
// from the original File (downscaleImage's canvas output carries no EXIF). exifr is
// lazy-loaded like jspdf/xlsx. Phones may strip GPS on upload (iOS: the picker's
// "Location" option), so absence is normal and silent.
async function applyPhotoExif(files) {
  const needPin = !val('fLat') && !val('fLng');
  const needDate = !val('fInspDate');
  if (!files.length || (!needPin && !needDate)) return;
  let exifr;
  try { exifr = (await import('exifr')).default; } catch (err) { console.warn('exifr load failed', err); return; }
  let gps = null, taken = null;
  for (const file of files) {
    try {
      if (needPin && !gps) {
        const g = await exifr.gps(file);
        if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) gps = g;
      }
      if (needDate && !taken) {
        const t = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
        const d = t && (t.DateTimeOriginal || t.CreateDate);
        if (d instanceof Date && !isNaN(d)) taken = d;
      }
    } catch (err) { console.warn('exif read failed', err); }
    if ((!needPin || gps) && (!needDate || taken)) break;
  }
  const filled = [];
  if (gps) { setPin(gps.latitude, gps.longitude, true); filled.push('position'); }
  if (taken) {
    const pad = (x) => String(x).padStart(2, '0');
    $('fInspDate').value = `${taken.getFullYear()}-${pad(taken.getMonth() + 1)}-${pad(taken.getDate())}`;
    filled.push('inspection date');
  }
  if (filled.length) notify(`Filled ${filled.join(' & ')} from photo — check before saving.`);
}

// Which detail-page photo group a Ctrl+V paste targets (set when a group's "+ Add" is used).

// Extract image files from a clipboard/DataTransfer; [] when the paste is plain text.
export function imageFilesFromClipboard(dt) {
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

export async function onPastePhoto(e) {
  if (!session) return;
  const files = imageFilesFromClipboard(e.clipboardData);
  if (!files.length) return; // not an image paste — let normal text paste happen
  // The status-change dialog's "After Repair photos" uploader sits on top of the detail view —
  // check it first so a paste while the dialog is open doesn't fall through to the page beneath.
  if ($('statusDlg').open && dlgTarget === 'Repaired') {
    e.preventDefault();
    addDetailPhotos(files, 'repaired'); // shows its own progress/result toast, refreshes the dialog grid
  } else if ($('viewForm').classList.contains('active')) {
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

// WALL_LOSS_TYPES now lives in core/constants.ts (shared with the repair advisor); re-exported
// here since existing importers (app.ts) pull it from this module.
export { WALL_LOSS_TYPES };

// Finding types that auto-enable the assessment panel. Deliberately excludes CUI/CUS — under
// insulation/supports a thickness reading usually isn't available at the time the finding is
// first logged (needs insulation/support removal to inspect), so auto-opening the assessment
// there was more often wrong than helpful. The user can still turn it on manually for those types.
export const AUTO_ASSESS_TYPES = ['External Corrosion', 'Internal Corrosion'];

// The finding type dictates whether the wall loss is internal or external, so the assessment's
// Corrosion Type follows it automatically (CUI/CUS are external-surface mechanisms).
export const CORR_TYPE_BY_FINDING = {
  'External Corrosion': 'external',
  'Internal Corrosion': 'internal',
  'CUI (Corrosion Under Insulation)': 'external',
  'CUS (Corrosion Under Support)': 'external'
};
// When the finding type decides the side, the select is LOCKED to it (no second input of the same
// fact); it stays editable only for types that don't (e.g. Dent / Other assessed manually).
export function syncCorrTypeFromFinding() {
  const c = CORR_TYPE_BY_FINDING[$('fType').value];
  if (c) $('aCorrType').value = c;
  $('aCorrType').disabled = !!c;
  const hint = $('aCorrTypeHint');
  if (hint) hint.style.display = c ? 'block' : 'none';
}

// Sensible starting severity by finding type, shown before any assessment has run — the user
// can always override it (severityTouched short-circuits every auto-suggestion below once set).
// Corrosion/CUI/CUS start at Medium since the real severity depends on the reading, which isn't
// known yet; cosmetic coating damage starts Low. (Leak is no longer a finding type — see
// applyLeakingSeverityBump below for its own severity effect, independent of type.)
export const SEVERITY_BY_FINDING = {
  'External Corrosion': 'Medium',
  'Internal Corrosion': 'Medium',
  'CUI (Corrosion Under Insulation)': 'Medium',
  'CUS (Corrosion Under Support)': 'Medium',
  'Coating / Painting Damage': 'Low',
  'Pipe Support Defect': 'Medium',
  'Dent / Mechanical Damage': 'Medium'
};
export function suggestSeverityFromType() {
  if (severityTouched) return;
  const sev = SEVERITY_BY_FINDING[$('fType').value];
  if (!sev) return;
  $('fSeverity').value = sev;
}

// Actively Leaking is safety-relevant regardless of finding type, so checking it bumps Severity
// to High immediately — same one-way severityTouched override rule as every other auto-suggestion
// here (a manual Severity edit, before or after checking the box, wins from then on).
export function applyLeakingSeverityBump() {
  if (severityTouched) return;
  if ($('fIsLeaking').checked) $('fSeverity').value = 'High';
}

export function syncLeakAndAssessRules() {
  const fType = $('fType').value;
  const isNonLeakable = NON_LEAKABLE_TYPES.includes(fType);
  const isLnk = $('fIsLeaking').checked;

  // Non-leakable types (Coating / Support Damage) cannot activate leaking
  if (isNonLeakable) {
    if (isLnk) {
      $('fIsLeaking').checked = false;
    }
    $('fIsLeaking').disabled = true;
    if ($('leakHint')) $('leakHint').style.display = 'block';
  } else {
    $('fIsLeaking').disabled = false;
    if ($('leakHint')) $('leakHint').style.display = 'none';
  }

  const effectiveLnk = $('fIsLeaking').checked;

  if ($('leakingBanner')) $('leakingBanner').hidden = !effectiveLnk;
  if ($('panelAnomaly')) $('panelAnomaly').classList.toggle('is-leaking', effectiveLnk);

  // If line is actively leaking, no ASME B31.3 assessment is needed
  if (effectiveLnk) {
    setAssessOn(false);
    $('aToggle').disabled = true;
    if ($('aLeakingNote')) $('aLeakingNote').style.display = 'flex';
  } else {
    $('aToggle').disabled = false;
    if ($('aLeakingNote')) $('aLeakingNote').style.display = 'none';
  }

  // The emergency stop-leak panel only exists for a leaking finding. Toggled from HERE rather than
  // from the checkbox's own listener so it can never drift out of agreement with #leakingBanner /
  // the assessment lockout — one function owns every leak-dependent piece of the form.
  if ($('panelTempRepair')) $('panelTempRepair').style.display = effectiveLnk ? '' : 'none';
  syncTempRepairFields();
  syncSectionNav('formSectionNav'); // the Temporary repair link follows its panel
}

/* ---------------- temporary repair (emergency stop-leak) ----------------
   Second level of progressive disclosure inside #panelTempRepair: the fields stay hidden until
   #fTrInstalled is ticked, so "leaking but not yet clamped" is a one-glance state rather than a
   screen of empty inputs. */

// Whether the finding being edited already had a temp_repair row when the form opened. Only used
// to decide whether unticking "Installed" needs a confirm before deleting (photos hang off it).
let loadedTempRepairExists = false;
function setLoadedTempRepairExists(v) { loadedTempRepairExists = v; }

export function syncTempRepairFields() {
  const on = !!($('fTrInstalled') && $('fTrInstalled').checked);
  if ($('trFields')) $('trFields').style.display = on ? '' : 'none';
  if ($('trHintIdle')) $('trHintIdle').style.display = on ? 'none' : '';
  // The before/after photo groups live in the Photographic Record panel further down the form and
  // are revealed by the same switch — renderPhotoGroups reads #fTrInstalled for the form-scoped set.
  renderPhotoGroups();
  if (!on) return;

  // Which method-specific block shows is keyed off the method VALUE via TEMP_REPAIR_METHOD_KIND,
  // never the select's index — reordering TEMP_REPAIR_METHODS must not swap clamp for composite.
  const method = val('fTrMethod');
  const kind = TEMP_REPAIR_METHOD_KIND[method] || 'other';
  if ($('fTrClampBlock')) $('fTrClampBlock').style.display = kind === 'clamp' ? '' : 'none';
  if ($('fTrCompositeBlock')) $('fTrCompositeBlock').style.display = kind === 'composite' ? '' : 'none';
  if ($('fTrMethodOtherWrap')) $('fTrMethodOtherWrap').style.display = method === 'Other' ? '' : 'none';
  if ($('fTrVerifyMethodOtherWrap')) $('fTrVerifyMethodOtherWrap').style.display = val('fTrVerifyMethod') === 'Other' ? '' : 'none';
  if ($('fTrMonitorFreqOtherWrap')) $('fTrMonitorFreqOtherWrap').style.display = val('fTrMonitorFreq') === 'Other' ? '' : 'none';
  if ($('fTrPermMethodOtherWrap')) $('fTrPermMethodOtherWrap').style.display = val('fTrPermMethod') === 'Other' ? '' : 'none';
}

/**
 * Snapshot the panel into a temp_repair row, or null when nothing should be stored.
 *
 * Deliberately carries NOTHING from the legacy Excel form's section 1 (equipment, tag, location,
 * nature of the problem, product, design pressure/temperature, reference document) — all of it is
 * already on the finding or its assessment, and workbench/temp-repair.ts's tempRepairRows reads it
 * from there when rendering the panel and the PDF section.
 */
export function collectTempRepair(findingId) {
  if (!$('fIsLeaking').checked) return null;
  if (!$('fTrInstalled') || !$('fTrInstalled').checked) return null;
  const method = val('fTrMethod');
  if (!method) return null;

  const s = (id) => { const v = val(id); return v && v.trim() ? v.trim() : null; };
  const n = (id) => { const v = val(id); return v === '' || v == null ? null : Number(v); };
  const kind = TEMP_REPAIR_METHOD_KIND[method] || 'other';
  const vmSel = val('fTrVerifyMethod');
  const mfSel = val('fTrMonitorFreq');
  const permSel = val('fTrPermMethod');

  return {
    finding_id: findingId,
    method,
    method_other: method === 'Other' ? s('fTrMethodOther') : null,
    installed_date: s('fTrInstalledDate'),
    installed_by: s('fTrInstalledBy'),
    install_method: s('fTrInstallMethod'),
    // Only the selected branch's columns are written; switching method clears the other branch's
    // values rather than leaving stale clamp data on a composite record (and vice versa).
    clamp_type: kind === 'clamp' ? s('fTrClampType') : null,
    clamp_size: kind === 'clamp' ? s('fTrClampSize') : null,
    clamp_material: kind === 'clamp' ? s('fTrClampMaterial') : null,
    rated_pressure_barg: kind === 'clamp' ? n('fTrRatedP') : null,
    composite_system: kind === 'composite' ? s('fTrCompSystem') : null,
    composite_layers: kind === 'composite' ? n('fTrCompLayers') : null,
    composite_thickness_mm: kind === 'composite' ? n('fTrCompThk') : null,
    surface_prep: kind === 'composite' ? s('fTrSurfacePrep') : null,
    cure_note: kind === 'composite' ? s('fTrCure') : null,
    verify_method: vmSel === 'Other' ? s('fTrVerifyMethodOther') : (vmSel || null),
    test_pressure_barg: n('fTrTestP'),
    tested_at: (() => {
      const d = s('fTrTestDate');
      const t = s('fTrTestTime');
      if (!d) return null;
      const hh = t && /^\d{1,2}:\d{2}$/.test(t) ? t.split(':')[0].padStart(2, '0') : '00';
      const mm = t && /^\d{1,2}:\d{2}$/.test(t) ? t.split(':')[1].padStart(2, '0') : '00';
      const localDate = new Date(`${d}T${hh}:${mm}:00`);
      return isNaN(localDate.getTime()) ? `${d}T${hh}:${mm}:00` : localDate.toISOString();
    })(),
    test_result: val('fTrTestResult') || 'Not yet tested',
    test_note: s('fTrTestNote'),
    monitor_freq: mfSel === 'Other' ? s('fTrMonitorFreqOther') : (mfSel || null),
    perm_method: permSel === 'Other' ? s('fTrPermMethodOther') : (permSel || null),
    perm_target_date: s('fTrPermDate'),
    perm_owner: s('fTrPermOwner'),
    precautions: s('fTrPrecautions'),
  };
}

/** Fill the panel from a saved row (or reset it when there is none). */
export function loadTempRepairInto(tr) {
  const set = (id, v) => { if ($(id)) $(id).value = v == null ? '' : String(v); };
  $('fTrInstalled').checked = !!tr;
  set('fTrMethod', tr ? tr.method : TEMP_REPAIR_METHODS[0]);
  set('fTrMethodOther', tr && tr.method === 'Other' ? tr.method_other : '');
  set('fTrInstalledDate', tr && tr.installed_date);
  set('fTrInstalledBy', tr && tr.installed_by);
  set('fTrInstallMethod', tr && tr.install_method);
  set('fTrClampType', tr && tr.clamp_type);
  set('fTrClampSize', tr && tr.clamp_size);
  set('fTrClampMaterial', tr && tr.clamp_material);
  set('fTrRatedP', tr && tr.rated_pressure_barg);
  set('fTrCompSystem', tr && tr.composite_system);
  set('fTrCompLayers', tr && tr.composite_layers);
  set('fTrCompThk', tr && tr.composite_thickness_mm);
  set('fTrSurfacePrep', tr && tr.surface_prep);
  set('fTrCure', tr && tr.cure_note);

  const vm = (tr && tr.verify_method) || '';
  const vmKnown = TEMP_REPAIR_VERIFY_METHODS.includes(vm);
  set('fTrVerifyMethod', vm && !vmKnown ? 'Other' : vm);
  set('fTrVerifyMethodOther', vm && !vmKnown ? vm : '');

  set('fTrTestP', tr && tr.test_pressure_barg);
  if (tr && tr.tested_at) {
    const dt = new Date(tr.tested_at);
    if (!isNaN(dt.getTime())) {
      const yyyy = dt.getFullYear();
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const dd = String(dt.getDate()).padStart(2, '0');
      const hh = String(dt.getHours()).padStart(2, '0');
      const min = String(dt.getMinutes()).padStart(2, '0');
      set('fTrTestDate', `${yyyy}-${mm}-${dd}`);
      set('fTrTestTime', `${hh}:${min}`);
    } else {
      const raw = String(tr.tested_at).replace(' ', 'T');
      set('fTrTestDate', raw.slice(0, 10));
      set('fTrTestTime', raw.slice(11, 16));
    }
  } else {
    set('fTrTestDate', '');
    set('fTrTestTime', '');
  }
  set('fTrTestResult', (tr && tr.test_result) || TEMP_REPAIR_VERIFY_RESULTS[0]);
  set('fTrTestNote', tr && tr.test_note);

  const mf = (tr && tr.monitor_freq) || '';
  const mfKnown = TEMP_REPAIR_MONITOR_FREQS.includes(mf);
  set('fTrMonitorFreq', mf && !mfKnown ? 'Other' : mf);
  set('fTrMonitorFreqOther', mf && !mfKnown ? mf : '');

  // Same legacy handling as the status dialog's repair-method select: a stored value that is not in
  // the closed list selects 'Other' and prefills the free text, so nothing is ever silently dropped.
  const pm = (tr && tr.perm_method) || '';
  const pmKnown = REPAIR_METHOD_OPTIONS.includes(pm);
  set('fTrPermMethod', pm && !pmKnown ? 'Other' : pm);
  set('fTrPermMethodOther', pm && !pmKnown ? pm : '');
  set('fTrPermDate', tr && tr.perm_target_date);
  set('fTrPermOwner', tr && tr.perm_owner);
  set('fTrPrecautions', tr && tr.precautions);
  syncTempRepairFields();
}

export function initTempRepair() {
  $('fTrMethod').innerHTML = TEMP_REPAIR_METHODS.map(m => `<option>${esc(m)}</option>`).join('');
  $('fTrVerifyMethod').innerHTML =
    '<option value="">—</option>' + TEMP_REPAIR_VERIFY_METHODS.map(m => `<option>${esc(m)}</option>`).join('');
  $('fTrTestResult').innerHTML = TEMP_REPAIR_VERIFY_RESULTS.map(r => `<option>${esc(r)}</option>`).join('');
  $('fTrMonitorFreq').innerHTML =
    '<option value="">—</option>' + TEMP_REPAIR_MONITOR_FREQS.map(f => `<option>${esc(f)}</option>`).join('');
  $('fTrPermMethod').innerHTML =
    '<option value="">—</option>' + REPAIR_METHOD_OPTIONS.map(m => `<option>${esc(m)}</option>`).join('');

  ['fTrInstalled', 'fTrMethod', 'fTrVerifyMethod', 'fTrMonitorFreq', 'fTrPermMethod'].forEach(id => {
    if ($(id)) $(id).addEventListener('change', syncTempRepairFields);
  });

  if ($('fTrTestTime')) {
    $('fTrTestTime').addEventListener('blur', () => {
      let v = val('fTrTestTime').trim().replace(/[^0-9]/g, '');
      if (!v) return;
      if (v.length <= 2) {
        let hh = Math.min(23, parseInt(v, 10) || 0);
        $('fTrTestTime').value = String(hh).padStart(2, '0') + ':00';
      } else {
        let hh = Math.min(23, parseInt(v.slice(0, 2), 10) || 0);
        let mm = Math.min(59, parseInt(v.slice(2, 4), 10) || 0);
        $('fTrTestTime').value = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
      }
    });
  }

  // The stop-leak's permanent-repair target date pre-fills the finding's Target Repair Date when
  // that is still empty — maintenance-only, because target_date is guarded for inspectors (and
  // collectForm omits it for them). Never overwrites a date already set.
  $('fTrPermDate').addEventListener('change', () => {
    if (isMaintenance() && val('fTrPermDate') && !val('fTargetDate')) $('fTargetDate').value = val('fTrPermDate');
  });
}


// The finding form records ONE reading: the wall-loss depth at the deepest point, entered in the
// Anomaly section (#fDepth) and saved on the finding (findings.depth_mm). Localized corrosion is the
// governing damage, so depth is the reading; the snapshot keeps its long-standing mode/depth/tmeas
// shape with mode 'depth'. (Quick Calc keeps its own depth / measured-thickness toggle.)
export function aMode() {
  return 'depth';
}

// The assessment's read-only "depth used" line (#aDepthRef) — points back to Anomaly when empty.
export function syncDepthRef() {
  const el = $('aDepthRef');
  if (!el) return;
  const d = $('fDepth').value.trim();
  el.innerHTML = d !== ''
    ? `Wall-loss depth used: <b>${esc(d)} mm</b> <span class="hint" style="margin:0;">(from the Anomaly section)</span>`
    : `<span>No wall-loss depth yet —</span> <a href="#" data-goto-depth>enter it in the Anomaly section</a>`;
}

export function setAssessOn(on) {
  $('assessPanel').classList.toggle('on', on);
  $('aToggle').checked = on;
  if (on) recalcAssessment();
  else { setAssessResult(null); renderRepairAdvisor(); }
}

export function updateAschedules(keepValue) {
  const nps = $('aNps').value;
  const pipe = PA_PIPE_DATABASE[nps];
  if (!pipe) { $('aSch').innerHTML = '<option value="">—</option>'; $('aTnom').value = ''; return; }
  const prev = $('aSch').value;
  $('aSch').innerHTML = Object.keys(pipe.schedules)
    .map(s => `<option value="${s}">${pipe.schedules[s].label}</option>`).join('');
  const def = paDefaultScheduleForNps(nps);
  $('aSch').value = (keepValue && pipe.schedules[prev]) ? prev : (pipe.schedules[def] ? def : Object.keys(pipe.schedules)[0]);
  autofillAtnom();
}

export function autofillAtnom() {
  const pipe = PA_PIPE_DATABASE[$('aNps').value];
  const sch = pipe && pipe.schedules[$('aSch').value];
  if (sch) $('aTnom').value = sch.t;
}

export function applyMaterialStress() {
  const m = PA_MATERIALS.find(x => x.code === $('aMat').value);
  if (m && m.stress !== null) { $('aS').value = m.stress; $('aS').disabled = true; }
  else { $('aS').disabled = false; }
}

export function gatherAssessParams() {
  return {
    nps: $('aNps').value, sch: $('aSch').value,
    overrideTnom: $('aTnom').value, overrideOd: '',
    mode: 'depth', depth: $('fDepth').value, tmeas: '',
    ca: $('aCa').value, pInput: $('aP').value, pUnit: $('aPUnit').value,
    S: $('aS').value, E: $('aE').value, W: $('aW').value, Y: $('aY').value, CR: $('aCr').value,
    matCode: $('aMat').value, isInternal: $('aCorrType').value === 'internal'
  };
}

// The form's live workbench instance (paCreateAssessView), created in initAssessment().

// The UT reading box for the active mode is still blank. The engine reads a blank depth as 0 mm
// (parity-locked), which would show "OK, 100% wall left" for an unmeasured pipe — so a blank reading
// is handled here as "not entered yet": neutral banner, no result, nothing saved.
export function aReadingEmpty() {
  return $('fDepth').value.trim() === '';
}

export function recalcAssessment() {
  if (!$('assessPanel').classList.contains('on')) { setAssessResult(null); renderRepairAdvisor(); return; }
  if (aReadingEmpty()) {
    setAssessResult(null);
    $('aCalcHint').style.display = 'none';
    if (awFormView) awFormView.render(null, { neutral: true });
    renderRepairAdvisor();
    return;
  }
  const res = computeB313(gatherAssessParams());
  const hint = $('aCalcHint');
  if (res.hasErrors) {
    setAssessResult(null);
    // Distinguish "not filled in yet" (neutral banner, no red) from "typed something invalid"
    // (ERROR banner + targeted message) — same cold-load rule the calculator used. (CA >= t_meas
    // is no longer an error — a thin wall below its reserve is a valid case; only ca < 0 errors.)
    const readingEmpty = aReadingEmpty();
    const msg = (res.errors.tmeas || res.errors.depth) && !readingEmpty ? 'Check the wall-loss depth (it cannot exceed the original wall thickness).'
      : (res.errors.ca && !readingEmpty) ? (typeof res.errors.ca === 'string' ? res.errors.ca : 'Check the corrosion allowance.')
      : (res.errors.P && $('aP').value !== '') ? 'Design pressure must be positive.'
      : res.errors.overrideTnom ? 'Check the nominal thickness.'
      : (res.errors.S && $('aS').value !== '') ? 'Allowable stress S must be positive.'
      : '';
    hint.style.display = msg ? 'block' : 'none';
    hint.textContent = msg;
    if (awFormView) awFormView.render(res, { neutral: !msg, nps: $('aNps').value });
    renderRepairAdvisor();
    return;
  }
  setAssessResult(res);
  hint.style.display = 'none';
  if (awFormView) awFormView.render(res, { nps: $('aNps').value });
  renderRepairAdvisor();

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
export function loadAssessmentInto(inp, skipReading) {
  if (!inp) return;
  if (inp.nps && PA_PIPE_DATABASE[inp.nps]) { $('aNps').value = inp.nps; updateAschedules(false); }
  if (inp.schedule) { $('aSch').value = inp.schedule; autofillAtnom(); }
  if (inp.material) { $('aMat').value = inp.material; applyMaterialStress(); }
  if (inp.S != null && inp.S !== '') $('aS').value = inp.S;
  if (inp.design_temp != null) $('aTemp').value = inp.design_temp;
  if (inp.P != null) $('aP').value = inp.P;
  if (inp.p_unit) $('aPUnit').value = inp.p_unit;
  if (inp.ca != null) $('aCa').value = inp.ca;
  // A saved corrosion type only applies when the finding type doesn't already decide it (the
  // select is locked then — see syncCorrTypeFromFinding).
  if (inp.corr_type && !CORR_TYPE_BY_FINDING[$('fType').value]) $('aCorrType').value = inp.corr_type;
  if (inp.cr != null) $('aCr').value = inp.cr;
  if (inp.E != null) $('aE').value = inp.E;
  if (inp.W != null) $('aW').value = inp.W;
  if (inp.Y != null) $('aY').value = inp.Y;
  if (inp.override_tnom != null && inp.override_tnom !== '') $('aTnom').value = inp.override_tnom;
  // The depth comes from the finding (depth_mm) when it has one. Findings saved before depth_mm
  // existed carry their reading only in the snapshot: a depth-mode snapshot gives it directly; a
  // measured-thickness snapshot converts with that snapshot's OWN pipe size (real data, not a guess).
  if (!skipReading && $('fDepth').value.trim() === '') {
    let d = null;
    if (inp.mode === 'depth' && inp.depth != null && String(inp.depth).trim() !== '') d = Number(inp.depth);
    else if (inp.mode === 'tmeas' && inp.tmeas != null && String(inp.tmeas).trim() !== '' && $('aTnom').value !== '')
      d = Math.max(0, Number($('aTnom').value) - Number(inp.tmeas));
    if (d != null && isFinite(d)) $('fDepth').value = +d.toFixed(2);
  }
  syncDepthRef();
}

export function resetAssessment() {
  // Pipe size starts blank: a preset size looked like a real answer to an operator who never chose
  // it, and used to turn their depth into a guessed thickness on save.
  $('aNps').value = '';
  $('aSch').innerHTML = '<option value="">—</option>';
  $('aTnom').value = '';
  $('aMat').value = 'API5LB'; // default line-pipe material
  applyMaterialStress();
  $('aTemp').value = '';
  $('aP').value = '';
  $('aPUnit').value = 'bar';
  $('aCa').value = '1.5';
  $('aCorrType').value = 'external';
  $('aCr').value = '';
  $('aE').value = '1.0'; $('aW').value = '1.0'; $('aY').value = '0.4';
  syncDepthRef();
  setAssessResult(null);
  $('aCalcHint').style.display = 'none';
  if (awFormView) awFormView.render(null, { neutral: true });
  renderRepairAdvisor();
}

// Force the assessment's pipe-setup inputs to the master line list entry for the currently
// selected Pipe Tag / Line No. Unlike applyTagMemory (which prefers a prior finding's assessment
// and only fills empty metadata), this deliberately OVERRIDES the current pipe setup with the
// line-list authority — for when the user has picked/changed the tag and wants a clean reset to
// the registered line data. Only the pipe setup (NPS/Schedule/Material/design pressure) is reset;
// the UT reading (depth / t_meas) is left untouched via loadAssessmentInto's skipReading.
export async function resetAssessmentToLineList() {
  const tag = $('fTag').value.trim();
  if (!tag) { notify('Enter or select a Pipe Tag / Line No. first.', true); return; }
  if (!lineList.length) await loadLineList(); // lazy-load: #/new is reachable without visiting #/list
  const lineRow = lineList.find(r => r.pipe_tag === tag);
  if (!lineRow || !lineRow.nps) { notify('No master line list entry found for this tag.', true); return; }
  if (!$('assessPanel').classList.contains('on')) setAssessOn(true);
  const setupParams = { nps: lineRow.nps, schedule: lineRow.schedule, material: lineRow.material };
  if (lineRow.design_p_barg != null && lineRow.design_p_barg !== '') {
    setupParams.P = String(lineRow.design_p_barg);
    setupParams.p_unit = 'bar(g)';
  }
  loadAssessmentInto(setupParams, true); // skipReading: keep the measured wall-loss, reset only the setup
  recalcAssessment();
  notify('Reset pipe setup to the master line list' + (setupParams.P ? ' (incl. design pressure).' : '.'));
}

/* ---------------- standalone repair advisor (form panel, always available) ---------------- */

// Renders src/workbench/repair-advisor.ts's resolveAdvisor() output into #raBody, and toggles
// the "View full ASME B31.3 workbench" link for wall-loss finding types.
export function renderRepairAdvisor() {
  const root = $('raBody');
  if (!root) return;
  const findingType = $('fType').value;
  paRenderRepairAdvisor(root, findingType, assessResult, $('fIsLeaking').checked);
  const link = $('advisorAssessLink');
  if (link) link.style.display = WALL_LOSS_TYPES.includes(findingType) ? 'inline' : 'none';
}

export function initRepairAdvisor() {
  renderRepairAdvisor();
  const link = $('advisorAssessLink');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (!$('assessPanel').classList.contains('on')) setAssessOn(true);
      $('assessPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  $('fIsLeaking').addEventListener('change', () => {
    syncLeakAndAssessRules();
    applyLeakingSeverityBump();
    renderRepairAdvisor();
  });
}

export function initAssessment() {
  $('aNps').innerHTML = '<option value="">Select size…</option>' + Object.keys(PA_PIPE_DATABASE).map(n => `<option>${n}</option>`).join('');
  $('aMat').innerHTML = PA_MATERIALS.map(m => `<option value="${m.code}">${m.name}</option>`).join('');

  // Full workbench under the inputs (equations ship collapsed to keep the column scannable —
  // the repair advisor is its own standalone panel now, see initRepairAdvisor). The drag handle
  // writes back into whichever reading field is active.
  setAwFormView(paCreateAssessView($('awForm'), {
    sections: ['status', 'svg', 'results', 'equations', 'scope'],
    collapsed: ['equations'],
    onDepthDrag: (depth_mm) => {
      if (!assessResult) return;
      $('fDepth').value = depth_mm.toFixed(2); // the one depth field (Anomaly section)
      syncDepthRef();
      recalcAssessment();
    }
  }));
  awFormView.render(null, { neutral: true });

  $('aToggle').addEventListener('change', () => setAssessOn($('aToggle').checked));
  $('btnResetAssessLine').addEventListener('click', resetAssessmentToLineList);
  $('aNps').addEventListener('change', () => { updateAschedules(false); recalcAssessment(); });
  $('aSch').addEventListener('change', () => { autofillAtnom(); recalcAssessment(); });
  $('aMat').addEventListener('change', () => { applyMaterialStress(); recalcAssessment(); });
  $('fDepth').addEventListener('input', () => { syncDepthRef(); recalcAssessment(); });
  $('aDepthRef').addEventListener('click', (e) => {
    if (!e.target.closest('[data-goto-depth]')) return;
    e.preventDefault();
    $('panelAnomaly').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => $('fDepth').focus({ preventScroll: true }), 400);
  });
  ['aTnom', 'aCa', 'aP', 'aPUnit', 'aCorrType', 'aS', 'aTemp', 'aE', 'aW', 'aY', 'aCr']
    .forEach(id => $(id).addEventListener('input', recalcAssessment));

  $('fType').addEventListener('change', () => {
    // corrosion type follows the finding type
    syncCorrTypeFromFinding();
    syncLeakAndAssessRules();
    // auto-enable the assessment for types where a UT reading is normally already on hand
    // (only when creating, and only if the user hasn't already turned it on/off deliberately for
    // this finding) — CUI/CUS are deliberately excluded, see AUTO_ASSESS_TYPES.
    if (!editingId && !assessToggleTouched && !$('fIsLeaking').checked) {
      setAssessOn(AUTO_ASSESS_TYPES.includes($('fType').value));
    }
    suggestSeverityFromType();
    recalcAssessment();
  });
  $('aToggle').addEventListener('change', () => { setAssessToggleTouched(true); });

  $('fSeverity').addEventListener('change', () => {
    setSeverityTouched(true);
  });
}


// Per-tag memory: reuse metadata + pipe setup from the last finding with the same tag, falling
// back to the master line list for tags that have never appeared on a finding before. A prior
// finding's own recorded assessment always wins over the line list — it reflects what an
// engineer actually measured and verified for that tag (possibly correcting a stale master-list
// entry), while the line list is a bulk-imported, unverified-per-row reference. Metadata fields
// combine both sources under the same fill-only-if-empty rule rather than picking one source
// exclusively, so a partially-known prior finding can still pick up whatever the line list has
// that it doesn't.
export async function applyTagMemory() {
  if (editingId) return; // only when creating
  const tag = $('fTag').value.trim();
  if (!tag) return;
  if (!lineList.length) await loadLineList(); // lazy-load: #/new is reachable without #/list first
  const lineRow = lineList.find(r => r.pipe_tag === tag);
  const prior = findings.filter(f => f.pipe_tag === tag)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  // metadata: prior finding first, then whatever the line list has that's still empty. Both
  // sources fill the same field set (Terminal/P&ID/Service) so a tag's prefill doesn't depend on
  // which source happened to match. (Location Description is NOT prefilled from either — it's
  // specific to where on the line THIS finding was seen, e.g. two findings on the same tag can
  // legitimately sit at different spots along it; silently copying a prior location risked the
  // inspector not noticing and leaving a stale/wrong location on the new record.)
  const last = prior[0];
  if (last) {
    if (!$('fTerminal').value && last.terminal) $('fTerminal').value = last.terminal;
    if (!$('fPid').value && last.pid_no) $('fPid').value = last.pid_no;
    if (!$('fService').value && last.service) $('fService').value = last.service;
  }
  if (lineRow) {
    if (!$('fTerminal').value && lineRow.terminal) $('fTerminal').value = lineRow.terminal;
    if (!$('fPid').value && lineRow.pid_no) $('fPid').value = lineRow.pid_no;
    if (!$('fService').value && lineRow.service) $('fService').value = lineRow.service;
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
    const setupParams = {
      nps: lineRow.nps,
      schedule: lineRow.schedule,
      material: lineRow.material
    };
    if (lineRow.design_p_barg != null && lineRow.design_p_barg !== '') {
      setupParams.P = String(lineRow.design_p_barg);
      setupParams.p_unit = 'bar(g)'; // key must match loadAssessmentInto (reads inp.p_unit, not pUnit)
    }
    loadAssessmentInto(setupParams, true);
    recalcAssessment();
    notify('Pre-filled pipe data & design pressure from the master line list.');
  }
}

// Searchable combobox for #fTag: options come from buildTagOptions() (tag + learned location +
// terminal), typing filters on tag OR location so a location-only search finds the tag, and the
// list is scoped to whichever Terminal is currently selected (a KBY finding has no business
// suggesting an SRC tag) — tags with no known terminal (never seen on a finding or line-list row)
// still show, since scoping them out would just hide legitimately unknown tags. Free text is
// always preserved (it's a plain <input>); selecting an option fires a native `change` so
// applyTagMemory runs. Keeps #fTag as the source of truth — collectForm still just reads its .value.
export const TAG_COMBO_MAX = 50; // raised from 20 so a large tag list doesn't hide likely matches

export function initTagCombo() {
  const input = $('fTag');
  const menu = $('tagCombo');
  let items = [];   // current filtered [{tag, location, terminal}]
  let active = -1;  // highlighted index

  const isOpen = () => menu.classList.contains('is-open');
  const close = () => {
    if (!isOpen()) return;
    const closeMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dropdown-close-dur')) || 150;
    menu.classList.remove('is-open');
    menu.classList.add('is-closing');
    setTimeout(() => menu.classList.remove('is-closing'), closeMs);
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  // position:fixed menu — escape .panel's overflow:hidden (see the .combo-menu CSS comment).
  // Re-measured on every open since the field can be anywhere in a scrolled form.
  const position = () => {
    const r = input.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top = (r.bottom + 2) + 'px';
    menu.style.width = r.width + 'px';
    // Clamp height to what's actually visible above the on-screen keyboard — CSS's own
    // max-height:360px assumes a full-height viewport, but on a phone with the keyboard open,
    // window.innerHeight still reports the pre-keyboard height (iOS Safari doesn't shrink it),
    // so the menu was extending its lower rows underneath the keyboard, unreachable. visualViewport
    // reflects the actual visible area and is what iOS resizes when the keyboard opens/closes.
    const viewportH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const available = viewportH - (r.bottom + 2) - 8; // 8px breathing room off the bottom edge
    menu.style.maxHeight = Math.max(120, Math.min(360, available)) + 'px';
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
    menu.classList.remove('is-closing');
    menu.classList.add('is-open');
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
  $('fTerminal').addEventListener('change', () => { if (isOpen()) openFiltered(); });
  window.addEventListener('resize', () => { if (isOpen()) position(); });
  window.addEventListener('scroll', () => { if (isOpen()) position(); }, true);
  // iOS Safari doesn't fire window's own resize/scroll when just the on-screen keyboard opens/
  // closes or the page auto-scrolls to keep a focused field visible above it — only
  // visualViewport does, since window.innerHeight stays pinned to the pre-keyboard height there.
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => { if (isOpen()) position(); });
    window.visualViewport.addEventListener('scroll', () => { if (isOpen()) position(); });
  }
  input.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
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

// Set by initQuickCalc (it needs that function's closures); the router calls applyQuickCalcLink
// for #/calc?… links shared from the Quick Calc message.
let applyQuickLinkImpl = null;
export function applyQuickCalcLink(search) {
  if (applyQuickLinkImpl) applyQuickLinkImpl(search);
}
// Same pattern: show() leaves presentation mode when the router switches away from #/calc.
let setQuickPresentImpl = null;
export function exitQuickPresent() {
  if (setQuickPresentImpl) setQuickPresentImpl(false);
}

export function initQuickCalc() {
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

  const updateSpecBar = () => {
    const pipe = PA_PIPE_DATABASE[$('qNps').value];
    const od = pipe ? pipe.od : null;
    const tnom = Number($('qTnom').value) || (pipe && pipe.schedules[$('qSch').value] ? pipe.schedules[$('qSch').value].t : null);
    const S = Number($('qS').value);
    if ($('qSpecOd')) $('qSpecOd').textContent = od ? `${od.toFixed(2)} mm` : '—';
    if ($('qSpecTnom')) $('qSpecTnom').textContent = tnom ? `${tnom.toFixed(2)} mm` : '—';
    if ($('qSpecS')) $('qSpecS').textContent = S ? `${S.toFixed(1)} MPa` : '—';

    if (lastQuickRes && lastQuickRes.mawp_no != null) {
      // mawp_no is already in the input pressure unit (computeB313 converts back from MPa). The
      // old "* 10" (bar) / "* 145.038" (psi) conversions showed this 10x / 145x too high.
      if ($('qSpecMawp')) $('qSpecMawp').textContent = `${lastQuickRes.mawp_no.toFixed(2)} ${lastQuickRes.pUnit}`;
    } else if ($('qSpecMawp')) {
      $('qSpecMawp').textContent = '—';
    }
  };

  const recalcQuickCore = () => {
    const hint = $('qCalcHint');
    // blank reading = "not entered yet", not 0 mm lost (see aReadingEmpty)
    if ((qMode() === 'tmeas' ? $('qTmeas').value : $('qDepth').value).trim() === '') {
      lastQuickRes = null;
      hint.style.display = 'none';
      awQuickView.render(null, { neutral: true });
      updateSpecBar();
      return;
    }
    const res = computeB313(params());
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
      updateSpecBar();
      return;
    }
    lastQuickRes = res;
    hint.style.display = 'none';
    awQuickView.render(res, { nps: $('qNps').value });
    updateSpecBar();
  };

  /* ---- Presentation mode: verdict banner, four result tiles and the scenario line ----
     Filled on every recalculation (cheap), so entering the mode needs no separate refresh. The
     banner reuses the health-banner colours (.hb-ok/-monitor/-repair/-pending); every label comes
     from PA_LABELS, like the workbench and the PDFs. */
  const PRES_HB = { OK: 'hb-ok', MONITOR: 'hb-monitor', REPAIR: 'hb-repair' };
  const renderPresentation = () => {
    const res = lastQuickRes;
    const banner = $('cpBanner');
    banner.className = 'cp-only cp-banner ' + (res ? (PRES_HB[res.status] || 'hb-pending') : 'hb-pending');
    banner.innerHTML = res
      ? `<div class="cp-word"><span>Integrity</span><b>${esc(res.status)}</b></div><div class="cp-line">${esc(res.desc || '')}</div>`
      : `<div class="cp-word"><span>Integrity</span><b>—</b></div><div class="cp-line">${esc($('qCalcHint').style.display !== 'none' && $('qCalcHint').textContent ? $('qCalcHint').textContent : 'Enter the wall-loss reading and design pressure to see the result.')}</div>`;

    const n2 = (v) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(2));
    let tiles;
    if (!res) {
      tiles = [['erfNo', '—', '', '', ''], ['mawpNo', '—', '', '', ''], ['tMeas', '—', '', '', ''], ['pct', '—', '', '', '']]
        .map(([k, v]) => ({ k, value: v, unit: '', sym: PA_LABELS[k].sym, note: '', tone: '' }));
    } else {
      const unit = res.pUnit;
      const erf = res.mawp_no > 0 ? res.P_input / res.mawp_no : null;
      // The limit that decides the verdict (same rule as the cross-section's bracket).
      const structDecides = res.t_struct > res.t_req_total;
      const limit = Math.max(res.t_struct, res.t_req_total);
      const tone = { OK: 'ok', MONITOR: 'warn', REPAIR: 'bad' }[res.status] || '';
      let wallNote = `${n2(res.depth)} of ${n2(res.t_nom)} mm lost`;
      if (res.CR > 0 && res.remainingLife != null) wallNote += ` · ~${Math.max(0, res.remainingLife).toFixed(1)} yr left`;
      tiles = [
        { k: 'erfNo', value: paPressureUsePct(erf).replace('%', ''), unit: erf == null ? '' : '%',
          sym: erf == null ? 'ERF' : `ERF ${erf.toFixed(2)}`, note: `of the safe limit at ${res.P_input} ${unit}`,
          tone: erf == null ? '' : erf > 1 ? 'bad' : erf >= 0.8 ? 'warn' : 'ok' },
        { k: 'mawpNo', value: res.mawp_no == null ? '—' : res.mawp_no.toFixed(1), unit, sym: PA_LABELS.mawpNo.sym,
          note: `design is ${res.P_input} ${unit}`, tone: res.mawp_no >= res.P_input ? 'ok' : 'bad' },
        { k: 'tMeas', value: n2(res.t_meas), unit: 'mm', sym: PA_LABELS.tMeas.sym,
          note: paLimitGap(res.t_meas - limit, 2, structDecides ? 'the API 574 minimum' : 'min. + corrosion allowance'), tone },
        { k: 'pct', value: res.pctRemainNom == null ? '—' : res.pctRemainNom.toFixed(0), unit: '%', sym: PA_LABELS.pct.sym,
          note: wallNote, tone: '' },
      ];
    }
    $('cpTiles').innerHTML = tiles.map(t => `
      <div class="cp-tile${t.tone ? ' t-' + t.tone : ''}">
        <div class="cp-tile-h"><span>${esc(PA_LABELS[t.k].short)}</span><span class="lbl-sym">${esc(t.sym)}</span></div>
        <div class="cp-tile-v">${esc(t.value)}${t.unit ? ` <small>${esc(t.unit)}</small>` : ''}</div>
        <div class="cp-tile-n">${esc(t.note)}</div>
      </div>`).join('');

    const pipe = PA_PIPE_DATABASE[$('qNps').value];
    const reading = qMode() === 'depth'
      ? ($('qDepth').value ? `${$('qCorrType').value === 'internal' ? 'internal' : 'external'} loss ${$('qDepth').value} mm` : 'no reading yet')
      : ($('qTmeas').value ? `measured wall ${$('qTmeas').value} mm` : 'no reading yet');
    const parts = [
      `${$('qNps').value} ${schLabelOf()}`, materialName($('qMat').value),
      pipe ? `OD ${pipe.od.toFixed(1)} mm` : '', reading,
      $('qP').value ? `${$('qP').value} ${$('qPUnit').value}` : 'no design pressure',
      `CA ${$('qCa').value || 0} mm`,
    ].filter(Boolean);
    $('cpFoot').innerHTML = `<span><b>Scenario</b> ${esc(parts.join(' · '))}</span><span>Not a recorded finding</span>`;
  };

  const recalcQuick = () => {
    recalcQuickCore();
    renderPresentation();
  };

  const applyPreset = (key) => {
    const presets = {
      hsd: { nps: '10"', sch: 'STD', mat: 'API5LB', P: '10', unit: 'bar', depth: '1.50', ca: '1.5' },
      lpg: { nps: '4"', sch: '80', mat: 'A106B', P: '18', unit: 'bar', depth: '1.00', ca: '1.5' },
      fo:  { nps: '8"', sch: 'STD', mat: 'A53B', P: '7', unit: 'bar', depth: '2.00', ca: '1.5' },
      thin: { nps: '6"', sch: 'STD', mat: 'API5LB', P: '12', unit: 'bar', depth: '5.00', ca: '1.5' }
    };
    const p = presets[key];
    if (!p) return;
    $('qNps').value = p.nps;
    updateSchedules(false);
    if (p.sch && $('qSch').querySelector(`option[value="${p.sch}"]`)) $('qSch').value = p.sch;
    $('qMat').value = p.mat;
    applyStress();
    $('qP').value = p.P; $('qPUnit').value = p.unit;
    $('qCa').value = p.ca;
    document.querySelectorAll('#qModeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'depth'));
    positionSegPill($('qModeSeg'), false);
    $('qTmeasGrp').style.display = 'none';
    $('qDepthGrp').style.display = 'block';
    $('qDepth').value = p.depth; $('qTmeas').value = '';
    autofillTnom();
    recalcQuick();
  };

  /* ---- Sharing a what-if with the team (LINE chat) ----
     One message builder used by Copy Summary and Share: verdict first (colour dot, readable from
     the chat-list preview), one fact per line, a ✅/❌ on every code check, plain-Thai labels with
     English technical terms (the Repair Advisor's convention), the margin stated outright, and a
     link that reopens this exact calculation (#/calc is public — no sign-in needed). */
  const schLabelOf = () => {
    const pipe = PA_PIPE_DATABASE[$('qNps').value];
    const sch = $('qSch').value;
    return (pipe && pipe.schedules[sch]) ? pipe.schedules[sch].label : (sch || '—');
  };
  // e.g. PA-QCALC-8in-Sch40-24Oct2026.pdf — LINE showed the old blob download as "Unknown.pdf".
  const quickFileName = () => {
    const nps = $('qNps').value.replace(/"/g, 'in').replace(/[^a-zA-Z0-9-]/g, '-');
    const sch = 'Sch' + $('qSch').value.replace(/[^a-zA-Z0-9]/g, '');
    return `PA-QCALC-${nps}-${sch}-${paFmtDate(new Date()).replace(/\s+/g, '')}.pdf`;
  };
  const quickInputs = () => ({
    nps: $('qNps').value, schLabel: schLabelOf(), matCode: $('qMat').value, mode: qMode(),
    designTemp: $('qTemp').value, fileTitle: quickFileName().replace(/\.pdf$/, ''),
  });
  // Only non-default inputs go in the link, so it stays short enough to paste into a chat.
  const quickPermalink = () => {
    const q = new URLSearchParams();
    const pipe = PA_PIPE_DATABASE[$('qNps').value];
    const schT = pipe && pipe.schedules[$('qSch').value] ? pipe.schedules[$('qSch').value].t : null;
    q.set('nps', $('qNps').value); q.set('sch', $('qSch').value); q.set('mat', $('qMat').value);
    q.set('mode', qMode());
    if (qMode() === 'depth') q.set('depth', $('qDepth').value); else q.set('tmeas', $('qTmeas').value);
    q.set('p', $('qP').value); q.set('unit', $('qPUnit').value); q.set('ca', $('qCa').value);
    if ($('qTnom').value && Number($('qTnom').value) !== schT) q.set('tnom', $('qTnom').value);
    if ($('qCorrType').value === 'internal') q.set('corr', 'internal');
    if ($('qCr').value) q.set('cr', $('qCr').value);
    if (!$('qS').disabled && $('qS').value) q.set('s', $('qS').value);
    if ($('qE').value && Number($('qE').value) !== 1) q.set('e', $('qE').value);
    if ($('qW').value && Number($('qW').value) !== 1) q.set('w', $('qW').value);
    if ($('qY').value && Number($('qY').value) !== 0.4) q.set('y', $('qY').value);
    if ($('qTemp').value) q.set('temp', $('qTemp').value);
    return `${PUBLIC_BASE_URL}/#/calc?${q.toString()}`;
  };
  const STATUS_LINE = {
    OK: ['🟢', 'ท่อยังรับความดันได้ ไม่ต้องซ่อมเร่งด่วน'],
    MONITOR: ['🟡', 'ใกล้ถึงค่าขั้นต่ำ — ควรติดตามและเพิ่มความถี่การตรวจ'],
    REPAIR: ['🔴', 'ต่ำกว่าเกณฑ์ที่ยอมรับได้ — ต้องวางแผนซ่อมหรือเปลี่ยนท่อ'],
  };
  const quickShareText = (res) => {
    const [dot, meaning] = STATUS_LINE[res.status] || ['⚪', ''];
    const ok = (pass) => pass ? '✅' : '❌';
    const n2 = (v) => Number(v).toFixed(2);
    // mawp_no is already in the input pressure unit (computeB313 converts back from MPa) — an
    // earlier "* 10" here reported MAWP 10x too high in every copied summary.
    const erf = res.mawp_no > 0 ? res.P_input / res.mawp_no : null;
    const unit = res.pUnit;
    const lines = [
      `${dot} INTEGRITY: ${res.status} — ASME B31.3`,
      meaning,
      '━━━━━━━━━━━━',
      `📍 ${$('qNps').value} ${schLabelOf()} · ${materialName($('qMat').value)}`,
      `📏 เนื้อท่อเหลือ ${n2(res.t_meas)} / ${n2(res.t_nom)} mm (${res.pctRemainNom.toFixed(0)}%)`,
      `🔻 ผนังหายไป ${n2(res.depth)} mm`,
      `${ok(res.margin >= 0)} ขั้นต่ำที่ต้องมี ${n2(res.t_req_total)} mm (รวมค่าเผื่อการกัดกร่อน ${n2(res.ca)}) → ${res.margin >= 0 ? 'สูงกว่าขั้นต่ำ' : 'ต่ำกว่าขั้นต่ำ'} ${n2(Math.abs(res.margin))} mm`,
      `${ok(res.t_meas >= res.t_struct)} API 574 ขั้นต่ำเชิงโครงสร้าง ${n2(res.t_struct)} mm`,
      `${ok(res.mawp_no >= res.P_input)} รับความดันได้สูงสุด ${n2(res.mawp_no)} ${unit} ${res.mawp_no >= res.P_input ? '≥' : '<'} Design ${res.P_input} ${unit}`
        + (erf != null ? ` (ใช้ไป ${paPressureUsePct(erf)})` : ''),
    ];
    if (res.CR > 0 && res.remainingLife != null) {
      lines.push(`⏳ อายุใช้งานคงเหลือ ~${Math.max(0, res.remainingLife).toFixed(1)} ปี (CR ${res.CR} mm/yr)`);
    }
    lines.push('━━━━━━━━━━━━', '📎 รายละเอียด + สมการ ใน PDF ที่แนบ', `🔗 เปิดคำนวณนี้: ${quickPermalink()}`);
    return lines.join('\n');
  };

  const copyQuickSummary = () => {
    if (!lastQuickRes) { notify('Enter a valid calculation to copy summary.', true); return; }
    navigator.clipboard.writeText(quickShareText(lastQuickRes)).then(() => {
      notify('Summary copied — paste it into the chat.');
    }).catch(() => {
      notify('Failed to copy to clipboard.', true);
    });
  };

  const exportQuickPdf = () => {
    if (!lastQuickRes) { notify('Enter a valid calculation to export.', true); return; }
    exportQuickCalcPdf(quickInputs(), lastQuickRes);
  };

  // Share (phones): hands the NAMED PDF to the OS share sheet (pick LINE) with the message, and
  // also copies the message, since some apps keep only the file. navigator.share needs a fresh tap;
  // if building the PDF took too long the browser refuses, so the file is cached and a second tap
  // shares instantly.
  let sharedPdf = null; // { key, file }
  const shareQuick = async () => {
    if (!lastQuickRes) { notify('Enter a valid calculation to share.', true); return; }
    const text = quickShareText(lastQuickRes);
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch (_) { /* share still works */ }
    const key = quickPermalink();
    if (!sharedPdf || sharedPdf.key !== key) {
      const btn = $('btnQuickShare');
      setBusy(btn, true, 'Preparing…');
      try {
        const blob = await buildQuickCalcPdf(quickInputs(), lastQuickRes);
        sharedPdf = { key, file: new File([blob], quickFileName(), { type: 'application/pdf' }) };
      } catch (e) {
        notify('PDF failed: ' + e.message, true);
        return;
      } finally {
        setBusy(btn, false);
      }
    }
    try {
      await navigator.share({ files: [sharedPdf.file], title: sharedPdf.file.name, text });
      if (copied) notify('Shared. The summary is also copied — paste it if the chat only got the PDF.');
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user closed the share sheet
      if (e && e.name === 'NotAllowedError') { notify('PDF ready — tap Share again to send it.'); return; }
      notify('Share failed: ' + (e && e.message ? e.message : e), true);
    }
  };
  const canShareFiles = (() => {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] })); }
    catch (_) { return false; }
  })();
  if ($('btnQuickShare')) $('btnQuickShare').style.display = canShareFiles ? '' : 'none';

  // Re-open a shared calculation (#/calc?nps=…&sch=…). Unknown/invalid values are ignored and fall
  // back to the form's defaults, so a mangled link still opens a usable calculator.
  applyQuickLinkImpl = (search) => {
    const q = new URLSearchParams(search);
    const nps = q.get('nps');
    if (!nps || !PA_PIPE_DATABASE[nps]) return;
    $('qNps').value = nps;
    updateSchedules(false);
    const sch = q.get('sch');
    if (sch && PA_PIPE_DATABASE[nps].schedules[sch]) { $('qSch').value = sch; autofillTnom(); }
    if (q.get('tnom')) $('qTnom').value = q.get('tnom');
    const mat = q.get('mat');
    if (mat && PA_MATERIALS.some(m => m.code === mat)) $('qMat').value = mat;
    applyStress();
    if (q.get('s') && !$('qS').disabled) $('qS').value = q.get('s');
    $('qP').value = q.get('p') || '';
    const unit = q.get('unit');
    if (unit && [...$('qPUnit').options].some(o => o.value === unit)) $('qPUnit').value = unit;
    $('qCa').value = q.get('ca') || '1.5';
    $('qCorrType').value = q.get('corr') === 'internal' ? 'internal' : 'external';
    $('qCr').value = q.get('cr') || '';
    $('qE').value = q.get('e') || '1.0'; $('qW').value = q.get('w') || '1.0'; $('qY').value = q.get('y') || '0.4';
    $('qTemp').value = q.get('temp') || '';
    const mode = q.get('mode') === 'tmeas' ? 'tmeas' : 'depth';
    document.querySelectorAll('#qModeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    positionSegPill($('qModeSeg'), false);
    $('qTmeasGrp').style.display = mode === 'tmeas' ? 'block' : 'none';
    $('qDepthGrp').style.display = mode === 'depth' ? 'block' : 'none';
    $('qDepth').value = q.get('depth') || '';
    $('qTmeas').value = q.get('tmeas') || '';
    recalcQuick();
  };

  setAwQuickView(paCreateAssessView($('awQuick'), {
    sections: ['status', 'svg', 'results', 'equations', 'scope'],
    collapsed: ['equations'],
    onDepthDrag: (depth_mm) => {
      if (!lastQuickRes) return;
      if (qMode() === 'depth') $('qDepth').value = depth_mm.toFixed(2);
      else $('qTmeas').value = (lastQuickRes.t_nom - depth_mm).toFixed(2);
      recalcQuick();
    }
  }));

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
    updateSpecBar();
    renderPresentation();
  };

  /* ---- Full-screen presentation mode (laptop + projector) ----
     #viewCalc itself becomes the full-screen surface (.calc-pres), so the presenter keeps editing
     the real inputs and dragging the real cross-section handle — nothing to copy back on exit.
     Also asks the browser for true full screen (hides tabs/address bar on the projector); if the
     browser leaves full screen on its own (its own Esc handling), presentation mode ends with it. */
  const view = $('viewCalc');
  const isPresenting = () => view.classList.contains('calc-pres');
  const setInputsShown = (shown) => {
    view.classList.toggle('cp-no-inputs', !shown);
    const b = $('btnCpInputs');
    b.setAttribute('aria-pressed', shown ? 'true' : 'false');
    b.querySelector('.t-text-swap').textContent = shown ? 'Hide inputs' : 'Show inputs';
  };
  const setPresenting = (on) => {
    if (on === isPresenting()) return;
    view.classList.toggle('calc-pres', on);
    // The app header/footer sit under the overlay; keep Tab from wandering onto them.
    document.querySelectorAll('body > header, body > footer').forEach(el => {
      if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    });
    document.body.style.overflow = on ? 'hidden' : '';
    if (on) {
      setInputsShown(true);
      renderPresentation();
      if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => { /* overlay still fills the window */ });
      }
      $('btnCpExit').focus();
    } else {
      view.classList.remove('cp-no-inputs');
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      $('btnQuickPresent').focus({ preventScroll: true });
    }
    positionSegPill($('qModeSeg'), false); // the panel changed width
  };
  setQuickPresentImpl = setPresenting;
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && isPresenting()) setPresenting(false);
  });
  $('btnQuickPresent').addEventListener('click', () => setPresenting(true));
  $('btnCpExit').addEventListener('click', () => setPresenting(false));
  $('btnCpReset').addEventListener('click', reset);
  $('btnCpInputs').addEventListener('click', () => setInputsShown(view.classList.contains('cp-no-inputs')));
  window.addEventListener('keydown', (e) => {
    if (!view.classList.contains('active') || e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName || '');
    if (e.key === 'Escape' && isPresenting()) {
      setPresenting(false);
    } else if (typing) {
      return;
    } else if (e.key === 'f' || e.key === 'F') {
      // laptop only — same breakpoint that hides the Present button
      if (!isPresenting() && window.innerWidth < 1024) return;
      e.preventDefault();
      setPresenting(!isPresenting());
    } else if ((e.key === 'h' || e.key === 'H') && isPresenting()) {
      e.preventDefault();
      setInputsShown(view.classList.contains('cp-no-inputs'));
    }
  });

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
  $('btnCopyQuickSummary')?.addEventListener('click', copyQuickSummary);
  $('btnQuickShare')?.addEventListener('click', shareQuick);
  $('btnQuickPdf')?.addEventListener('click', exportQuickPdf);
  document.querySelectorAll('.preset-chip[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => applyPreset((btn as HTMLElement).dataset.preset));
  });

  reset();
}

export function openForm(f) {
  setEditingId(f ? f.id : null);
  // Lightbox watermark (detail.ts's renderLightboxFrame) reads `current` for the tag — the edit
  // form doesn't otherwise keep `current` pointed at the finding being edited when reached
  // directly (e.g. dashboard list -> #/edit/<id> without visiting the detail page first).
  if (f) setCurrent(f);
  clearValidation();
  setPendingPhotos([]);
  renderPendingGrid();
  setSeverityTouched(false);
  setAssessToggleTouched(false);
  setLastLoadedAssessInputs(null);
  resetAssessment();
  setAssessOn(false);

  // Sticky-toolbar identity, same pattern as detail.ts's $('detailHead') — plain title while
  // creating (nothing to identify yet), tag/status/terminal-type once editing a real record.
  $('formHead').innerHTML = f
    ? `<h2>${esc(f.pipe_tag || f.location_desc || '—')}</h2>${pillHtml(f.status)}${isOverdue(f) ? '<span class="ov-badge">OVERDUE</span>' : ''}` +
      `<span class="dh-meta">${esc(f.terminal)} Terminal — ${esc(f.finding_type)}</span>`
    : `<h2>New Finding</h2>`;
  $('btnDelete').style.display = f ? 'inline-flex' : 'none';
  // New findings queue photos in memory (uploaded on save); existing findings manage photos
  // immediately via the same Photographic Record panel/logic the detail page uses.
  $('pendingPhotoPanel').style.display = f ? 'none' : 'block';
  $('editPhotoPanel').style.display = f ? 'block' : 'none';
  setPhotoPasteTarget('found'); // Ctrl+V defaults to As Found until a group's "+ Add" is clicked
  if (f) {
    // `current` may not point at this finding (e.g. navigating straight from the dashboard
    // list to #/edit/<id> without visiting the detail page first) — load its photos explicitly
    // rather than assuming currentPhotos is already correct.
    sb.from('finding_photos').select('*').eq('finding_id', f.id).order('created_at', { ascending: true })
      .then(({ data }) => { setCurrentPhotos(data || []); renderPhotoGroups(); });
  } else {
    setCurrentPhotos([]);
    renderPhotoGroups();
  }

  $('fTerminal').value = f ? f.terminal : '';
  $('fTag').value = f ? (f.pipe_tag || '') : '';
  $('fPid').value = f ? (f.pid_no || '') : '';
  $('fService').value = f ? (f.service || '') : '';
  $('fLocationDesc').value = f ? (f.location_desc || '') : '';
  $('fReportLink').value = f ? (f.report_link || '') : '';
  $('fInspDate').value = f ? (f.inspection_date || '') : todayISO(); // field reports are nearly always same-day
  $('fInspDate').max = todayISO(); // no future inspection dates (the picker greys them out)
  $('fType').value = f ? f.finding_type : '';
  const isLnk = f ? !!f.is_leaking : false;
  $('fIsLeaking').checked = isLnk;
  syncCorrTypeFromFinding(); // corrosion type follows the finding type (a saved assessment overrides it below)
  // Reset the temporary-repair panel synchronously so a previously-opened finding's clamp details
  // can never linger; the real row (if any) is fetched just below and re-applied.
  setLoadedTempRepairExists(false);
  loadTempRepairInto(null);
  if (f) {
    sb.from('temp_repair').select('*').eq('finding_id', f.id).maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        setLoadedTempRepairExists(true);
        loadTempRepairInto(data);
      });
  }
  syncLeakAndAssessRules(); // sync non-leakable type & active leak ASME rules
  renderRepairAdvisor(); // show guidance for the loaded finding type/leak state immediately, not just on next change
  // Populate from the stored value without marking severityTouched — the field shows what was
  // saved, but auto-suggestion (leaking bump, ERF-based bump, finding-type prefill) still applies
  // to whatever the user does next in this session, same as a brand-new finding. Only the user's
  // own edit to the Severity <select> (its change listener below) should set severityTouched.
  $('fSeverity').value = f ? (f.severity || '') : '';
  if (!f || !f.severity) suggestSeverityFromType(); // prefill from the finding type if none stored yet
  $('fDescription').value = f ? (f.description || '') : '';
  $('fDefLen').value = f && f.defect_length_mm != null ? f.defect_length_mm : '';
  $('fDefWid').value = f && f.defect_width_mm != null ? f.defect_width_mm : '';
  $('fDepth').value = f && f.depth_mm != null ? f.depth_mm : '';
  syncDepthRef();
  $('fTargetDate').value = f ? (f.target_date || '') : '';
  $('fSapNotif').value = f ? (f.sap_notification || '') : '';
  $('fSapOrder').value = f ? (f.sap_order || '') : '';
  $('fEstCost').value = f && f.estimated_cost != null ? f.estimated_cost : '';

  // Assessment section: auto-enable for wall-loss types (new) or when the finding carries a
  // reading / a saved assessment (edit). When editing, restore the last saved assessment inputs.
  if (f) {
    const hasReading = f.depth_mm != null || f.t_measured != null;
    if (hasReading || WALL_LOSS_TYPES.includes(f.finding_type)) setAssessOn(true);
    // restore the full saved assessment setup (async; overrides the coarse prefill above)
    sb.from('assessments').select('inputs').eq('finding_id', f.id)
      .order('created_at', { ascending: false }).limit(1)
      .then(({ data }) => {
        if (data && data.length) {
          setAssessOn(true);
          loadAssessmentInto(data[0].inputs, false);
          setLastLoadedAssessInputs(JSON.stringify(collectAssessment() ? collectAssessment().inputs : data[0].inputs));
          recalcAssessment();
        }
      });
  } else if (AUTO_ASSESS_TYPES.includes($('fType').value)) {
    setAssessOn(true);
  }

  // map: view is display:none until show() runs, so defer sizing to next tick
  setTimeout(() => {
    ensurePickMap();
    if (pickMarker && pickMap) { pickMap.removeLayer(pickMarker); setPickMarker(null); }
    if (f && f.lat != null && f.lng != null) {
      $('fLat').value = f.lat; $('fLng').value = f.lng;
      if (pickMap) {
        setPickMarker(L.marker([f.lat, f.lng]).addTo(pickMap));
        pickMap.setView([f.lat, f.lng], 16);
      }
    } else if (!f && pendingNewCoords) {
      // seeded from a dashboard-map double-click — drop the picker pin at those coords
      setPin(pendingNewCoords.lat, pendingNewCoords.lng, true);
      setPendingNewCoords(null);
    } else {
      $('fLat').value = ''; $('fLng').value = '';
      if (pickMap) pickMap.setView(DEFAULT_MAP_VIEW.center, DEFAULT_MAP_VIEW.zoom);
    }
  }, 60);
  syncSectionNav('formSectionNav'); // new vs existing finding show different photo panels
}

export function collectForm() {
  const sOrNull = (id) => { const v = val(id).trim(); return v === '' ? null : v; };
  const nOrNull = (id) => { const v = val(id); return v === '' ? null : Number(v); };
  const dOrNull = (id) => val(id) || null;

  let bad = false;
  const need = (id, errId, cond) => {
    const el = $(id);
    if (cond) {
      el.setAttribute('aria-invalid', 'true');
      $(errId).style.display = 'block';
      // replay the shake even if it's already invalid (e.g. a repeat Save click)
      el.classList.remove('is-shaking');
      void el.offsetWidth; // force reflow so the animation restarts
      el.classList.add('is-shaking');
      bad = true;
    } else {
      el.removeAttribute('aria-invalid');
      $(errId).style.display = 'none';
      el.classList.remove('is-shaking');
    }
  };
  need('fTerminal', 'errTerminal', !val('fTerminal'));
  need('fLocationDesc', 'errLocationDesc', !val('fLocationDesc').trim());
  need('fType', 'errType', !val('fType'));
  need('fDepth', 'errDepth', val('fDepth') !== '' && !(Number(val('fDepth')) >= 0));
  need('fInspDate', 'errInspDate', inspectionDateIssue(val('fInspDate')) === 'future');
  need('fEstCost', 'errEstCost', val('fEstCost') !== '' && Number(val('fEstCost')) < 0);
  if (bad) return null;
  // before 2000 is allowed (old vendor reports exist) but usually a typing slip: ask once
  if (inspectionDateIssue(val('fInspDate')) === 'old' &&
      !window.confirm(`The inspection date is ${val('fInspDate')} — before 2000. Is that right?`)) return null;

  // t_nominal / t_measured come ONLY from a complete assessment (real pipe size + the depth). With
  // no assessment the keys are omitted, so an edit never wipes values already on the row and a new
  // finding stores none — never a thickness worked out from a pipe size nobody chose.
  const a = collectAssessment();

  const patch = {
    terminal: val('fTerminal'),
    pipe_tag: sOrNull('fTag'),
    pid_no: sOrNull('fPid'),
    service: sOrNull('fService'),
    location_desc: sOrNull('fLocationDesc'),
    report_link: sOrNull('fReportLink'),
    inspection_date: dOrNull('fInspDate'),
    finding_type: val('fType'),
    severity: sOrNull('fSeverity'),
    is_leaking: $('fIsLeaking').checked,
    description: sOrNull('fDescription'),
    depth_mm: nOrNull('fDepth'),
    ...(a ? { t_nominal: a.results.t_nom, t_measured: a.results.t_meas } : {}),
    defect_length_mm: nOrNull('fDefLen'),
    defect_width_mm: nOrNull('fDefWid'),
    lat: nOrNull('fLat'),
    lng: nOrNull('fLng'),
    sap_notification: sOrNull('fSapNotif'),
    sap_order: sOrNull('fSapOrder')
  };

  /* Repair schedule + budget are maintenance-only. Their inputs still exist in the DOM for an
     inspector (the .maintenance-only wrappers are only visually hidden), so they must be OMITTED
     from the patch rather than sent as null: PostgREST writes only the keys present, so an absent
     key leaves the column untouched (NEW.x = OLD.x) and the pa_guard_repair_fields trigger passes.
     Sending them would both wipe a maintenance-set date/budget on every inspector save AND trip
     that trigger, failing the save. See db/schema.sql section 9. */
  if (isMaintenance()) {
    patch.target_date = dOrNull('fTargetDate');
    patch.estimated_cost = nOrNull('fEstCost');
  }
  return patch;
}

// Snapshot the assessment (inputs + full result) for the assessments table, or null if the
// section is off / can't compute. Inputs shape is the long-standing snapshot schema (originally
// defined by the old calculator page's saveAssessmentToFinding) — keep it stable, saved rows depend on it.
export function collectAssessment() {
  if (!$('assessPanel').classList.contains('on')) return null;
  // nothing to record: no UT reading yet, or actively leaking (the calculation does not apply)
  if (aReadingEmpty() || ($('fIsLeaking') && $('fIsLeaking').checked)) return null;
  const res = computeB313(gatherAssessParams());
  if (res.hasErrors) return null;
  const inputs = {
    nps: $('aNps').value, schedule: $('aSch').value, material: $('aMat').value,
    S: $('aS').value, E: $('aE').value, W: $('aW').value, Y: $('aY').value,
    design_temp: $('aTemp').value, P: $('aP').value, p_unit: $('aPUnit').value,
    ca: $('aCa').value, corr_type: $('aCorrType').value, cr: $('aCr').value,
    mode: 'depth', depth: $('fDepth').value, tmeas: '',
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

export async function uploadPhoto(findingId, file, kind) {
  // 1600px / 0.75 — R2's free tier (10GB, zero egress fees) has far more headroom than
  // Supabase Storage's 1GB free cap did; still comfortably legible for the lightbox and the
  // PDF's largest photo cell (~84x62mm) at typical print/screen resolution, just sharper.
  const dataUrl = await downscaleImage(file, 1600, 0.75);
  const blob = await (await fetch(dataUrl)).blob();
  const { data: sess } = await sb.auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) throw new Error('Not signed in.');
  const up = await fetch(`${R2_UPLOAD_ENDPOINT}/upload?findingId=${encodeURIComponent(findingId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
    body: blob
  });
  if (!up.ok) throw new Error('Photo upload failed (' + up.status + ').');
  const { path } = await up.json();
  const ins = await sb.from('finding_photos').insert({ finding_id: findingId, kind, storage_path: path });
  if (ins.error) throw ins.error;
}

export async function deletePhotos(paths) {
  if (!paths || !paths.length) return;
  const { data: sess } = await sb.auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) throw new Error('Not signed in.');
  const res = await fetch(`${R2_UPLOAD_ENDPOINT}/delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths })
  });
  if (!res.ok) throw new Error('Photo delete failed (' + res.status + ').');
}

export async function saveForm(addAnother) {
  const payload = collectForm();
  if (!payload) { notify('Please fill the required fields.', true); return; }
  const assessment = collectAssessment();
  const assessWanted = $('assessPanel').classList.contains('on');
  // Dropping the temporary-repair record also orphans its before/after photos, so confirm before
  // saving rather than after — asked here, outside the try, so a "no" costs nothing.
  const tempRepairWanted = !!collectTempRepair('x');
  if (loadedTempRepairExists && !tempRepairWanted &&
      !window.confirm('The temporary repair record for this finding will be deleted. Its before/after photos will no longer be grouped under it. Continue?')) {
    return;
  }
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
    }
    // An operator saving location + damage (+ depth) with no pipe data is the intended flow, not an
    // error: say what happens next in the ONE save message (two stacked toasts covered the toolbar).
    const pendingNote = (assessWanted && !assessment && !$('fIsLeaking').checked)
      ? ($('fDepth').value.trim() !== ''
        ? ' Assessment pending — an engineer adds the pipe size and design pressure.'
        : ' No wall-loss depth yet — add it when measured.')
      : '';

    // Attach (or clear) the emergency stop-leak record. Upsert on finding_id, since temp_repair is
    // ONE row per finding — unlike assessments, this is the current state, not a dated snapshot.
    const tempRepair = collectTempRepair(id);
    if (tempRepair) {
      const { error: tErr } = await sb.from('temp_repair').upsert(tempRepair, { onConflict: 'finding_id' });
      if (tErr) notify('Finding saved, but the temporary repair could not be recorded: ' + tErr.message, true);
      else setLoadedTempRepairExists(true);
    } else if (loadedTempRepairExists) {
      const { error: tErr } = await sb.from('temp_repair').delete().eq('finding_id', id);
      if (tErr) notify('Finding saved, but the temporary repair could not be removed: ' + tErr.message, true);
      else setLoadedTempRepairExists(false);
    }

    if (addAnother) {
      // keep the report context, reload the list cache so the new row appears, then a fresh form
      await loadFindings();
      const keep = { terminal: val('fTerminal'), inspDate: val('fInspDate') };
      openForm(null);
      $('fTerminal').value = keep.terminal;
      $('fInspDate').value = keep.inspDate;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      notify('Saved.' + pendingNote + ' Ready for the next finding on this report.');
    } else {
      notify((editingId ? 'Finding updated.' : 'Finding recorded.') + pendingNote);
      location.hash = '#/f/' + id;
    }
  } catch (e) {
    notify('Save failed: ' + e.message, true);
  } finally {
    setBusy(btn, false);
  }
}

export async function deleteFinding() {
  if (!editingId) return;
  // Deletion is maintenance-only (RLS enforces it; this is the friendly message).
  if (!isMaintenance()) {
    notify('Only the Maintenance role can delete a finding.', true);
    return;
  }
  const f = findings.find(x => x.id === editingId) || current;
  const tag = f ? (f.pipe_tag || f.location_desc || '') : ''; // location-first: operator findings have no tag
  if (!window.confirm(`Delete this finding (${tag})? Its photos and history are removed permanently.`)) return;
  const btn = $('btnDelete');
  setBusy(btn, true, 'Deleting…');
  try {
    const { data: ph } = await sb.from('finding_photos').select('storage_path').eq('finding_id', editingId);
    if (ph && ph.length) await deletePhotos(ph.map(p => p.storage_path));
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

