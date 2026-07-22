// @ts-nocheck — Phase 1: ported 1:1 from the app monolith, verified behaviorally (engine
// parity + Playwright), not via types yet. Same posture as app.ts; strict typing added
// incrementally per module.
/* ============================================================================
   Detail page: the finding detail view (metadata, assessment snapshot
   history, photo groups, status timeline), the status-change dialog, and
   the position map. Extracted from the app monolith.
   ============================================================================ */
import L from 'leaflet';
import { $, val, esc, notify, todayISO, isOverdue, fmtDate, fmtDateTime, pillHtml, openDialog, closeDialog, setBusy } from '../core/dom';
import {
  PHOTO_LIMIT_PER_KIND, SAT_TILES, STATUSES, STATUS_COLORS,
} from '../core/constants';
import { sb } from '../core/supabase';
import { computeB313, PA_MATERIALS } from '../engine/compute';
import { paFmtBaht } from '../engine/format';
import { paCreateAssessView, resolveIntegrityBanner } from '../workbench/assess-view';
import { paRenderRepairAdvisor } from '../workbench/repair-advisor';
import {
  current, setCurrent, currentPhotos, setCurrentPhotos, currentHistory, setCurrentHistory,
  currentAssessments, editingId, dlgTarget, setDlgTarget,
  detailMap, setDetailMap, detailMarker, setDetailMarker, photoPasteTarget, setPhotoPasteTarget,
} from '../core/state';
import { loadDetail, photoUrl } from './dashboard';
import { uploadPhoto, deletePhotos } from './form';

/* ---------------- detail view ---------------- */

export function dItem(label, valueHtml) {
  return `<div class="d-item"><div class="d-label">${esc(label)}</div><div class="d-val">${valueHtml}</div></div>`;
}

export function renderDetail() {
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
  if (f.report_link) d.push(dItem('Report Link',
    `<a href="${esc(f.report_link)}" target="_blank" rel="noopener" style="color:var(--button-primary);font-weight:600;">Open source report &#8599;</a>`));
  d.push(dItem('Inspection Date', `<span class="mono">${fmtDate(f.inspection_date)}</span>`));
  d.push(dItem('Severity', esc(f.severity || '—')));
  if (f.is_leaking) d.push(dItem('Leaking', '<span class="ov-badge">ACTIVELY LEAKING</span>'));
  if (f.t_nominal != null) d.push(dItem('Nominal Thk.', `<span class="mono">${fmtN(f.t_nominal, 2)} mm</span>`));
  if (f.t_measured != null) d.push(dItem('Measured Min.', `<span class="mono">${fmtN(f.t_measured, 2)} mm</span>`));
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

  renderHealthBanner();
  renderRepairAdvisor();
  renderAssessments();
  renderDetailMap();
  renderPhotoGroups();
  renderTimeline();
}

// Integrity health banner at the top of the detail page — same design and (via the shared
// resolveIntegrityBanner) the exact same wording/color/state as the finding PDF's top banner, so
// the two can never disagree. Reflects engineering health, not workflow status.
export function renderHealthBanner() {
  const host = $('detailHealthBanner');
  if (!host) return;
  const latest = currentAssessments.length ? currentAssessments[0] : null;
  const res = latest ? resFromSnapshot(latest) : null;
  const hb = resolveIntegrityBanner(current, res);
  const metricsHtml = hb.metrics
    ? `<div class="hb-metrics"><div class="hb-erf">ERF ${esc(hb.metrics.erf)}</div>`
      + `<div class="hb-sub">MAWP ${esc(hb.metrics.mawp)} &middot; ${esc(hb.metrics.pct)}% wall</div></div>`
    : '';
  host.innerHTML = `<div class="health-banner hb-${hb.key}">`
    + `<div class="hb-main"><div class="hb-word">${esc(hb.word)}</div><div class="hb-line">${esc(hb.line)}</div></div>`
    + metricsHtml
    + `</div>`;
}

// Standalone Repair Advisor panel — always available, independent of whether an assessment
// snapshot exists (resFromSnapshot returns null in that case, and resolveAdvisor falls back to
// the generic per-finding-type guidance; see src/workbench/repair-advisor.ts).
export function renderRepairAdvisor() {
  const root = $('raDetailBody');
  if (!root) return;
  const latest = currentAssessments.length ? currentAssessments[0] : null;
  paRenderRepairAdvisor(root, current.finding_type, latest ? resFromSnapshot(latest) : null, current.is_leaking);
}


// Satellite map on the detail page, centred on the finding's pin. Hidden when no coordinates.
export function renderDetailMap() {
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

export const fmtN = (v, d) => (v != null && isFinite(v)) ? Number(v).toFixed(d) : '—';

// erf_no (no-CA, current-condition) is the headline figure everywhere an assessment result is
// shown. Snapshots saved before this field existed only have erf_with — mawp_no was always part
// of the saved results (it's spread from the raw computeB313() result), so it can still be
// derived from mawp_no + P_input for those older rows rather than showing a blank dash.
export function erfNo(r) {
  if (r.erf_no != null) return r.erf_no;
  return (r.mawp_no > 0 && r.P_input > 0) ? r.P_input / r.mawp_no : null;
}

export function assessPill(status) {
  // calculator statuses mapped onto the existing pill palette
  const cls = status === 'OK' ? 'st-rep' : status === 'MONITOR' ? 'st-mon' : 'st-open';
  return `<span class="pill ${cls}">${esc(status || '—')}</span>`;
}

export function materialName(code) {
  const m = PA_MATERIALS.find(x => x.code === code);
  return m ? m.name.replace(/^[^:]+:\s*/, '') : (code || '—');
}

export const CORR_TYPE_LABEL = { external: 'External', internal: 'Internal' };

export function assessSetupLine(inputs) {
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
export function resFromSnapshot(a) {
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

export function renderAssessments() {
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
      sections: ['status', 'svg', 'results', 'equations'],
      collapsed: ['equations']
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

export function photoThumb(p) {
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
export const PHOTO_GRID_SETS = [
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
    // 'flex' not 'block' — .photo-empty's CSS lays the icon + text out in a row (display:flex),
    // but an inline style always beats a class rule, so 'block' here silently broke that layout,
    // stacking the icon above the text on its own line instead of beside it.
    $(empty).style.display = rows.length ? 'none' : 'flex';
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
        await deletePhotos([btn.dataset.path]);
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

export function renderTimeline() {
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


export function openStatusDialog(target) {
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
               <span class="hint" style="margin:0;">Tip: paste a screenshot with <kbd>Ctrl</kbd>+<kbd>V</kbd></span>
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
export function renderDlgRepairedPhotos() {
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
        await deletePhotos([btn.dataset.path]);
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

export async function confirmStatusChange() {
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
    if (note) patch.closing_note = note;
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

