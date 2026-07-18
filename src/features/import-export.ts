// @ts-nocheck — Phase 1: ported 1:1 from the app monolith, verified behaviorally (engine
// parity + Playwright), not via types yet. Same posture as app.ts; strict typing added
// incrementally per module.
/* ============================================================================
   Import / export: findings CSV export, findings Excel import, and the master
   line-list Excel import + manage dialog. Kept together (not split further) —
   the findings and line-list import pipelines are a deliberately parallel pair
   (see the block comment below), and normHeader/ensureXLSX are shared by both.
   Extracted from the app monolith.
   ============================================================================ */
import { $, esc, notify, openDialog, closeDialog, setBusy, todayISO } from '../core/dom';
import { FINDING_TYPES } from '../core/constants';
import {
  importValidRows, setImportValidRows, lineListValidRows, setLineListValidRows,
  lineList, setLineList,
} from '../core/state';
import { sb } from '../core/supabase';
import { PA_PIPE_DATABASE, PA_MATERIALS } from '../engine/compute';
import { loadFindings, renderList } from './dashboard';

// SheetJS (xlsx) is loaded on demand (import/export only) so it stays out of the initial bundle.
let XLSX: any;
async function ensureXLSX() { if (!XLSX) XLSX = await import('xlsx'); return XLSX; }

export const CSV_COLS = [
  'terminal', 'pipe_tag', 'pid_no', 'service', 'location_desc', 'finding_type', 'severity',
  'status', 'description', 'vendor', 'report_no', 'report_link', 'inspection_date', 'method',
  't_nominal', 't_measured', 'defect_length_mm', 'defect_width_mm', 'lat', 'lng',
  'target_date', 'next_check_date', 'sap_notification', 'sap_order', 'estimated_cost',
  'repair_method', 'repaired_date', 'closing_note', 'created_by_email', 'created_at'
];

export function exportCsv(rows, includeBudget) {
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
export const IMPORT_COLS = [
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


const normHeader = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

export function importHeaderMap() {
  const m = {};
  IMPORT_COLS.forEach(c => { m[normHeader(c.header)] = c; m[normHeader(c.field)] = c; });
  return m;
}

export function resolveFindingType(v) {
  if (!v) return null;
  const n = normHeader(v);
  let hit = FINDING_TYPES.find(t => normHeader(t) === n);
  if (hit) return hit;
  const cands = FINDING_TYPES.filter(t => normHeader(t).includes(n) || n.includes(normHeader(t)));
  return cands.length === 1 ? cands[0] : null;
}

export function toImportDate(v) {
  if (v == null || v === '') return null;
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d)) return undefined; // undefined = present but unparseable -> flagged
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function toImportNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

// Validate one spreadsheet row (object keyed by original headers) -> { payload } or { reasons: [] }.
export function validateImportRow(raw) {
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

export function renderImportPreview(results) {
  const valid = results.filter(r => r.payload);
  const invalid = results.filter(r => r.reasons);
  setImportValidRows(valid.map(r => r.payload));
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

export async function parseImportFile(file) {
  await ensureXLSX();
  $('errImport').style.display = 'none';
  setImportValidRows([]);
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

export async function doImport() {
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

export async function downloadImportTemplate() {
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

export function openImportDialog() {
  ensureXLSX(); // preload the spreadsheet lib while the dialog is open
  $('importFile').value = '';
  $('importPreview').style.display = 'none';
  $('importPreview').innerHTML = '';
  $('errImport').style.display = 'none';
  setImportValidRows([]);
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

export const LINE_LIST_IMPORT_COLS = [
  { header: 'Pipe Tag', field: 'pipe_tag', required: true },
  { header: 'Terminal', field: 'terminal' },
  { header: 'NPS', field: 'nps', required: true },
  { header: 'Schedule', field: 'schedule', required: true },
  { header: 'Material', field: 'material', required: true },
  { header: 'P&ID No.', field: 'pid_no' },
  { header: 'Service', field: 'service' }
];


export function lineListHeaderMap() {
  const m = {};
  LINE_LIST_IMPORT_COLS.forEach(c => { m[normHeader(c.header)] = c; m[normHeader(c.field)] = c; });
  return m;
}

// NPS is a precise engineering value fed straight into computeB313 — unlike
// resolveFindingType's substring fallback, this is exact-match only (normalized for
// whitespace/inch-marker variance); a wrong silent match would produce actively
// incorrect wall-thickness math.
export function resolveNps(v) {
  if (!v) return null;
  let s = String(v).trim().replace(/\s+in(ch(es)?)?\.?$/i, '').replace(/"$/, '').trim();
  const candidate = s + '"';
  if (PA_PIPE_DATABASE[candidate]) return candidate;
  const stripped = s.replace(/\s+/g, '');
  const hit = Object.keys(PA_PIPE_DATABASE).find(k => k.replace(/\s+/g, '').replace(/"$/, '') === stripped);
  return hit || null;
}

// Schedules are NPS-scoped — only call once resolveNps has already succeeded for the row.
export function resolveSchedule(nps, v) {
  if (!v || !PA_PIPE_DATABASE[nps]) return null;
  const s = String(v).trim().replace(/^sch\.?\s*/i, '').toUpperCase();
  const schedules = PA_PIPE_DATABASE[nps].schedules;
  return Object.keys(schedules).find(k => k.toUpperCase() === s) || null;
}

// Match against PA_MATERIALS[].code first (exact, case-insensitive), then fall back to
// PA_MATERIALS[].name via the same loose normHeader-based comparison validateImportRow
// already uses — a line list is more likely to carry a human material description
// ("API 5L Gr. B") than the internal code. Never implicitly matches 'MANUAL'.
export function resolveMaterialCode(v) {
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
export function validateLineListRow(raw) {
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

export function renderLineListImportPreview(results) {
  const valid = results.filter(r => r.payload);
  const invalid = results.filter(r => r.reasons);
  setLineListValidRows(valid.map(r => r.payload));
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

export async function parseLineListImportFile(file) {
  await ensureXLSX();
  $('errLineListImport').style.display = 'none';
  setLineListValidRows([]);
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

export async function doLineListImport() {
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

export async function downloadLineListTemplate() {
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

export function openLineListImportDialog() {
  ensureXLSX(); // preload the spreadsheet lib while the dialog is open
  $('lineListImportFile').value = '';
  $('lineListImportPreview').style.display = 'none';
  $('lineListImportPreview').innerHTML = '';
  $('errLineListImport').style.display = 'none';
  setLineListValidRows([]);
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
export async function loadLineList() {
  const PAGE = 1000;
  let all = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from('line_list').select('*').order('pipe_tag').range(from, from + PAGE - 1);
    if (error) { notify('Failed to load line list: ' + error.message, true); return; }
    all = all.concat(data || []);
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  setLineList(all);
}

export function renderLineListManageTable() {
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

export async function deleteLineListRow(id) {
  const row = lineList.find(r => r.id === id);
  if (!window.confirm(`Delete line list entry "${row ? row.pipe_tag : ''}"?`)) return;
  try {
    const { error } = await sb.from('line_list').delete().eq('id', id);
    if (error) throw error;
    setLineList(lineList.filter(r => r.id !== id));
    renderLineListManageTable();
    notify('Line list entry deleted.');
  } catch (e) { notify('Delete failed: ' + e.message, true); }
}

export function openLineListManageDialog() {
  $('lineListSearch').value = '';
  renderLineListManageTable();
  openDialog($('lineListManageDlg'));
}

