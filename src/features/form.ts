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
import { $, val, esc, notify, setBusy, positionSegPill, pillHtml, isOverdue } from '../core/dom';
import {
  R2_UPLOAD_ENDPOINT, PHOTO_LIMIT_PER_KIND, DEFAULT_MAP_VIEW, SAT_TILES, WALL_LOSS_TYPES, NON_LEAKABLE_TYPES,
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
import { exportQuickCalcPdf } from './pdf';
// show() is the router's view-switcher — stays in app.ts (the hub).
import { show } from '../app';
import { addDetailPhotos, renderPhotoGroups } from './detail';

/* ---------------- form (new / edit) ---------------- */

export function clearValidation() {
  ['fTerminal', 'fLocationDesc', 'fType'].forEach(id => $(id).removeAttribute('aria-invalid'));
  ['errTerminal', 'errLocationDesc', 'errType'].forEach(id => $(id).style.display = 'none');
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
       <button type="button" class="photo-remove" data-i="${i}" title="Remove">&#215;</button>
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
  if (files.length > toQueue.length) {
    notify(`${n} photo(s) queued (${files.length - toQueue.length} skipped — ${PHOTO_LIMIT_PER_KIND} max reached).`, true);
  }
  return n;
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
export function syncCorrTypeFromFinding() {
  const c = CORR_TYPE_BY_FINDING[$('fType').value];
  if (c) $('aCorrType').value = c;
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
      if (t && /^\d{1,2}:\d{2}$/.test(t)) {
        const [hh, mm] = t.split(':');
        return `${d}T${hh.padStart(2, '0')}:${mm.padStart(2, '0')}:00`;
      }
      return `${d}T00:00:00`;
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
  const rawTestedAt = tr && tr.tested_at ? String(tr.tested_at).replace(' ', 'T') : '';
  set('fTrTestDate', rawTestedAt ? rawTestedAt.slice(0, 10) : '');
  set('fTrTestTime', rawTestedAt && rawTestedAt.length >= 16 ? rawTestedAt.slice(11, 16) : '');
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
}


export function aMode() {
  const b = document.querySelector('#aModeSeg .seg-btn.active');
  return b ? b.dataset.mode : 'tmeas';
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
  if (!pipe) return;
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
    mode: aMode(), depth: $('aDepth').value, tmeas: $('aTmeas').value,
    ca: $('aCa').value, pInput: $('aP').value, pUnit: $('aPUnit').value,
    S: $('aS').value, E: $('aE').value, W: $('aW').value, Y: $('aY').value, CR: $('aCr').value,
    matCode: $('aMat').value, isInternal: $('aCorrType').value === 'internal'
  };
}

// best-effort thickness for the finding record, even if the full calc can't run (no pressure yet)
export function assessThickness() {
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

export function recalcAssessment() {
  if (!$('assessPanel').classList.contains('on')) { setAssessResult(null); renderRepairAdvisor(); return; }
  const res = computeB313(gatherAssessParams());
  const hint = $('aCalcHint');
  if (res.hasErrors) {
    setAssessResult(null);
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

export function resetAssessment() {
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
  $('aNps').innerHTML = Object.keys(PA_PIPE_DATABASE).map(n => `<option>${n}</option>`).join('');
  $('aMat').innerHTML = PA_MATERIALS.map(m => `<option value="${m.code}">${m.name}</option>`).join('');

  // Full workbench under the inputs (equations ship collapsed to keep the column scannable —
  // the repair advisor is its own standalone panel now, see initRepairAdvisor). The drag handle
  // writes back into whichever reading field is active.
  setAwFormView(paCreateAssessView($('awForm'), {
    sections: ['status', 'svg', 'results', 'equations', 'scope'],
    collapsed: ['equations'],
    onDepthDrag: (depth_mm) => {
      if (!assessResult) return;
      if (aMode() === 'depth') {
        $('aDepth').value = depth_mm.toFixed(2);
      } else {
        $('aTmeas').value = (assessResult.t_nom - depth_mm).toFixed(2);
      }
      recalcAssessment();
    }
  }));
  awFormView.render(null, { neutral: true });

  $('aToggle').addEventListener('change', () => setAssessOn($('aToggle').checked));
  $('btnResetAssessLine').addEventListener('click', resetAssessmentToLineList);
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
      const pUnit = $('qPUnit').value;
      const mawpVal = pUnit === 'psi' ? (lastQuickRes.mawp_no * 145.038).toFixed(1) + ' psi' : (lastQuickRes.mawp_no * 10).toFixed(2) + ' bar';
      if ($('qSpecMawp')) $('qSpecMawp').textContent = mawpVal;
    } else if ($('qSpecMawp')) {
      $('qSpecMawp').textContent = '—';
    }
  };

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
      updateSpecBar();
      return;
    }
    lastQuickRes = res;
    hint.style.display = 'none';
    awQuickView.render(res, { nps: $('qNps').value });
    updateSpecBar();
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

  const copyQuickSummary = () => {
    if (!lastQuickRes) { notify('Enter a valid calculation to copy summary.', true); return; }
    const res = lastQuickRes;
    const nps = $('qNps').value;
    const sch = $('qSch').value;
    const mat = $('qMat').value;
    const pVal = $('qP').value;
    const pUnit = $('qPUnit').value;
    const text = [
      `ASME B31.3 What-If Calculation Summary`,
      `Piping: ${nps} Sch ${sch} (${mat}, OD ${res.D.toFixed(2)}mm, t_nom ${res.t_nom.toFixed(2)}mm)`,
      `Pressure: ${pVal} ${pUnit} | CA: ${res.ca.toFixed(2)}mm`,
      `Measured Min. Thickness: ${res.t_meas.toFixed(2)}mm | Wall Loss Depth: ${res.depth.toFixed(2)}mm`,
      `Required Thickness t_req: ${res.t_req_noCA.toFixed(2)}mm (w/ CA: ${res.t_req_total.toFixed(2)}mm)`,
      `Remaining Wall: ${res.pctRemainNom.toFixed(0)}% of t_nom | MAWP: ${(res.mawp_no * 10).toFixed(2)} bar`,
      `Status: ${res.status} (${res.desc})`
    ].join('\n');

    navigator.clipboard.writeText(text).then(() => {
      notify('Calculation summary copied to clipboard!');
    }).catch(() => {
      notify('Failed to copy to clipboard.', true);
    });
  };

  const exportQuickPdf = () => {
    if (!lastQuickRes) { notify('Enter a valid calculation to export.', true); return; }
    const nps = $('qNps').value;
    const sch = $('qSch').value;
    const pipe = PA_PIPE_DATABASE[nps];
    const schLabel = (pipe && pipe.schedules[sch]) ? pipe.schedules[sch].label : (sch || '—');
    exportQuickCalcPdf({
      nps, schLabel,
      matCode: $('qMat').value,
      mode: qMode(),
      designTemp: $('qTemp').value
    }, lastQuickRes);
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
  $('btnCopyQuickSummary')?.addEventListener('click', copyQuickSummary);
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
  $('fInspDate').value = f ? (f.inspection_date || '') : '';
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
  if (bad) return null;

  // Thickness fields come from the assessment section (single source for the reading).
  const assessOn = $('assessPanel').classList.contains('on');
  const thk = assessOn ? assessThickness() : { t_nom: null, t_meas: null };

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
    t_nominal: (thk.t_nom != null && isFinite(thk.t_nom)) ? thk.t_nom : null,
    t_measured: (thk.t_meas != null && isFinite(thk.t_meas)) ? thk.t_meas : null,
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
    } else if (assessWanted && !assessment) {
      notify('Finding saved. Assessment left incomplete (needs UT reading + pressure) — not recorded.', true);
    }

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

export async function deleteFinding() {
  if (!editingId) return;
  // Deletion is maintenance-only (RLS enforces it; this is the friendly message).
  if (!isMaintenance()) {
    notify('Only the Maintenance role can delete a finding.', true);
    return;
  }
  const f = findings.find(x => x.id === editingId) || current;
  const tag = f ? f.pipe_tag : '';
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

