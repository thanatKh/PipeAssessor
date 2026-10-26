// @ts-nocheck — Phase 1: ported 1:1 from the app monolith, verified behaviorally (engine
// parity + Playwright), not via types yet. Same posture as app.ts; strict typing added
// incrementally per module.
/* ============================================================================
   Dashboard: data loading (findings + detail), the map (Leaflet) + its color-by
   legend, the KPI cards + budget, the register table + filters + selection, and
   CSV export helpers shared with import-export. Extracted from the app monolith.
   ============================================================================ */
import L from 'leaflet';
import { $, esc, notify, fmtDate, isOverdue, dueDateOf, pillHtml, inspectionDateIssue, friendlyError } from '../core/dom';
import { FINDING_TYPE_SHORT, STATUS_COLORS, TYPE_COLORS, SEVERITY_COLORS, DEFAULT_MAP_VIEW, SAT_TILES, R2_PUBLIC_BASE, WALL_LOSS_TYPES } from '../core/constants';
import { paFmtBahtShort } from '../engine/format';
import { sb } from '../core/supabase';
import { snapshotHasReading, resolveIntegrityBanner } from '../workbench/assess-view';
import { icon } from '../core/icons';
import { resFromSnapshot } from './detail';
import {
  findings, setFindings, lineList, filters, selectedIds, setSelectedIds,
  current, setCurrent, currentPhotos, setCurrentPhotos, currentHistory, setCurrentHistory,
  currentAssessments, setCurrentAssessments, setCurrentTempRepair, photoCounts, setPhotoCounts, photoThumbs, setPhotoThumbs,
  dashMap, setDashMap, dashLayer, setDashLayer, dashMarkers, setDashMarkers,
  dashAddMarker, setDashAddMarker, pendingNewCoords, setPendingNewCoords, lastRenderedRows, setLastRenderedRows,
  mapColorBy,
  mapShowRiskRadius, setMapShowRiskRadius, dashRiskLayer, setDashRiskLayer,
} from '../core/state';

// Real-world radius (metres) of the presentation-mode risk-zone circle — a fixed visual proximity
// aid, not a computed consequence/PHA distance (the app has no such model; see CLAUDE.md's Line
// Risk Ranking note on avoiding anything that reads like a certified quantitative figure).
const RISK_RADIUS_M = 40;

// Resolves a finding's map/legend color for the current mapColorBy mode. Falls back to the
// status palette's default ('#64748b') when a value has no palette entry (e.g. severity unset).
function colorFor(f) {
  if (mapColorBy === 'type') return TYPE_COLORS[f.finding_type] || '#64748b';
  if (mapColorBy === 'severity') return SEVERITY_COLORS[f.severity] || '#64748b';
  return STATUS_COLORS[f.status] || '#64748b';
}

// Map legend generated from whichever palette mapColorBy currently selects, so pins and legend
// can never drift apart. Each swatch also shows a count of mapped findings in that bucket (of
// `rows` — the same filtered set rendered as pins, so the numbers always match what's on screen;
// replaced the old separate "Findings by Type" radar panel, which counted globally/unfiltered).
// Status mode also gets an Overdue swatch (unlike Type/Severity, overdue is drawn as a separate
// dashed ring, not a fill color, so it needs its own legend entry, with its own count).
export function renderMapLegend(rows) {
  rows = rows || [];
  const mode = mapColorBy === 'type' ? 'finding_type' : mapColorBy === 'severity' ? 'severity' : 'status';
  const palette = mapColorBy === 'type' ? TYPE_COLORS : mapColorBy === 'severity' ? SEVERITY_COLORS : STATUS_COLORS;
  const countOf = k => rows.filter(f => f[mode] === k).length;
  // Type mode uses the same short axis labels the old findings-by-type radar used
  // (FINDING_TYPE_SHORT) instead of the full names — 8 full names ("CUI (Corrosion Under
  // Insulation)") wrap poorly even on their own row; short labels keep the legend scannable.
  const overdueCount = mapColorBy === 'status' ? rows.filter(isOverdue).length : 0;
  const overdueEntry = mapColorBy === 'status'
    ? `<span class="lg-item"><span class="lg-dot lg-overdue"></span>Overdue <b>${overdueCount}</b></span>`
    : '';
  $('mapLegend').innerHTML = Object.entries(palette)
    .map(([k, c]) => `<span class="lg-item"><span class="lg-dot" style="background:${c};"></span>${esc(mapColorBy === 'type' ? (FINDING_TYPE_SHORT[k] || k) : k)} <b>${countOf(k)}</b></span>`)
    .join('') + overdueEntry;
}

// skeleton loader and reveal (transitions.dev): #listSkelWrap mounts already showing the pulsing
// skeleton (baked into index.html) so it's visible before any JS runs. Call this once, after the
// first successful loadFindings()+renderList() on the #/list route, to cross-fade to the real
// table. It's a one-shot per page session — later loadFindings() calls (returning to the list,
// post-save/import refreshes) just re-render in place with no repeat skeleton flash.
let listSkeletonPending = true;
export function revealListSkeleton() {
  if (!listSkeletonPending) return;
  listSkeletonPending = false;
  $('listSkelWrap')?.classList.add('is-revealed');
}

// Findings with a usable assessment (a saved snapshot WITH a reading) — for needsEngineer() — and
// the latest such snapshot per finding, for integrityOf().
let assessedIds = new Set();
let latestAssessByFinding = new Map();

// An operator can save a finding with only a location + the damage (+ depth); an engineer completes
// it. "Needs engineer" = still unresolved AND either no Line No. yet, or a wall-loss finding with no
// ASME B31.3 result yet (leaking ones excepted — the calculation does not apply to them). Drives the
// KPI chip and the __needs_eng register filter, so engineers have one list to work through.
export function needsEngineer(f) {
  if (f.status === 'Repaired' || f.status === 'Closed') return false;
  if (!f.pipe_tag) return true;
  return WALL_LOSS_TYPES.includes(f.finding_type) && !f.is_leaking && !assessedIds.has(f.id);
}

export async function loadFindings() {
  selectedIds.clear(); // fresh data -> drop any selection from a previous load (ids may be stale)
  const [fq, pq, aq] = await Promise.all([
    sb.from('findings').select('*').order('created_at', { ascending: false }),
    sb.from('finding_photos').select('finding_id, storage_path, kind, created_at').order('created_at', { ascending: true }),
    sb.from('assessments').select('finding_id, inputs, results, created_at').order('created_at', { ascending: false })
  ]);
  const usable = (aq.data || []).filter(snapshotHasReading);
  assessedIds = new Set(usable.map(a => a.finding_id));
  latestAssessByFinding = new Map();
  usable.forEach(a => { if (!latestAssessByFinding.has(a.finding_id)) latestAssessByFinding.set(a.finding_id, a); });
  integrityCache = new Map();
  if (fq.error) { notify('Could not load the findings. ' + friendlyError(fq.error), true); return; }
  setFindings(fq.data || []);
  // DEV ONLY (break-ui): ?data=worst|empty|one|huge swaps in a worst-case fixture at the data
  // boundary, plus a small toggle to flip between them. The production build drops this branch.
  if (import.meta.env.DEV) {
    const which = new URLSearchParams(location.search).get('data') || '';
    const { fixtureFor } = await import('../dev/dashboard-fixtures');
    const fx = fixtureFor(which);
    if (fx) { setFindings(fx); assessedIds = new Set(); latestAssessByFinding = new Map(); integrityCache = new Map(); }
    if (which) mountDevDataToggle(which); // only while a test dataset is open: it covers the phone FAB
  }
  setPhotoCounts({});
  setPhotoThumbs({}); // finding_id -> storage_path of its earliest "found" photo (falls back to any)
  (pq.data || []).forEach(p => {
    photoCounts[p.finding_id] = (photoCounts[p.finding_id] || 0) + 1;
    const cur = photoThumbs[p.finding_id];
    if (!cur || (cur.kind !== 'found' && p.kind === 'found')) photoThumbs[p.finding_id] = p;
  });
}

// DEV ONLY: the break-ui "Demo data / Worst case" switch, fixed bottom-centre. Plain chrome, not
// part of the design under test. Selection lives in the URL (?data=…) so a reload keeps it.
function mountDevDataToggle(which) {
  if (document.getElementById('devDataToggle')) return;
  const el = document.createElement('div');
  el.id = 'devDataToggle';
  el.style.cssText = 'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:9999;display:flex;gap:2px;padding:3px;border-radius:999px;background:#e5e7eb;font:12px system-ui;box-shadow:0 2px 8px rgba(0,0,0,.15)';
  [['', 'Demo data'], ['worst', 'Worst case'], ['empty', 'Empty'], ['one', 'One'], ['huge', '1,200 rows']].forEach(([v, label]) => {
    const a = document.createElement('a');
    a.textContent = label;
    a.href = (v ? '?data=' + v : location.pathname) + '#/list';
    a.style.cssText = 'padding:4px 10px;border-radius:999px;color:#111;text-decoration:none;' + (v === which ? 'background:#fff;font-weight:600' : '');
    el.appendChild(a);
  });
  document.body.appendChild(el);
}

/* Days since the inspection date (falls back to created_at) — how long the finding has existed. */
export function ageDays(f) {
  if (inspectionDateIssue(f.inspection_date)) return null; // future or pre-2000: not a real age
  const base = f.inspection_date || f.created_at;
  if (!base) return null;
  const ms = Date.now() - new Date(base).getTime();
  if (isNaN(ms)) return null;
  return Math.max(0, Math.floor(ms / 86400000));
}

/* Sort priority: overdue first, then nearest due date (nulls last), then newest — surfaces
   exactly what needs attention instead of burying it under recently-added rows. */
export const STATUS_RANK = { 'Open': 0, 'Repair Planned': 1, 'Monitoring': 2, 'Repaired': 3, 'Closed': 4 };
export function sortFindings(rows) {
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

export async function loadDetail(id) {
  // temp_repair is ONE row per finding (unique index on finding_id), so maybeSingle — a finding
  // with no emergency stop-leak record resolves to null rather than erroring.
  const [f, ph, hi, as, tr] = await Promise.all([
    sb.from('findings').select('*').eq('id', id).single(),
    sb.from('finding_photos').select('*').eq('finding_id', id).order('created_at', { ascending: true }),
    sb.from('status_history').select('*').eq('finding_id', id).order('changed_at', { ascending: false }),
    sb.from('assessments').select('*').eq('finding_id', id).order('created_at', { ascending: false }),
    sb.from('temp_repair').select('*').eq('finding_id', id).maybeSingle()
  ]);
  if (f.error) { notify('Finding not found.', true); return false; }
  setCurrent(f.data);
  setCurrentPhotos(ph.data || []);
  setCurrentHistory(hi.data || []);
  setCurrentAssessments((as.data || []).filter(snapshotHasReading));
  setCurrentTempRepair(tr.data || null);
  return true;
}

// Public read-only load for the QR share link (#/s/<id>) — no sign-in required. Goes through the
// get_public_finding SECURITY DEFINER RPC (see db/public-share-migration.sql), the ONE public read
// path, which returns a single finding with PII stripped and its assessments/photos/history. The
// anon key can call this function but cannot read the tables directly. Populates the same state the
// authenticated detail page uses, so renderDetail() renders it unchanged.
export async function loadPublicFinding(id) {
  try {
    const { data, error } = await sb.rpc('get_public_finding', { p_id: id });
    if (error || !data || !data.finding) return false;
    setCurrent(data.finding);
    setCurrentPhotos(data.photos || []);
    setCurrentHistory(data.history || []);
    setCurrentAssessments((data.assessments || []).filter(snapshotHasReading));
    setCurrentTempRepair(data.temp_repair || null);
    return true;
  } catch (_) {
    return false;
  }
}

export function photoUrl(path) {
  return `${R2_PUBLIC_BASE}/${path}`;
}

/* ---------------- list view ---------------- */


export function applyFilters(rows) {
  const q = filters.q.trim().toLowerCase();
  return rows.filter(f => {
    if (filters.terminal && f.terminal !== filters.terminal) return false;
    if (filters.status === '__overdue') { if (!isOverdue(f)) return false; }
    else if (filters.status === '__complete') { if (f.status !== 'Repaired' && f.status !== 'Closed') return false; }
    else if (filters.status === '__outstanding') { if (f.status === 'Repaired' || f.status === 'Closed') return false; }
    else if (filters.status === '__needs_eng') { if (!needsEngineer(f)) return false; }
    else if (filters.status === '__leaking') { if (!isLeakingNow(f)) return false; }
    else if (filters.status === '__repair') { if (!isRepairRequired(f)) return false; }
    else if (filters.status && f.status !== filters.status) return false;
    if (filters.type && f.finding_type !== filters.type) return false;
    if (filters.severity && f.severity !== filters.severity) return false;
    if (q) {
      const hay = [f.pipe_tag, f.description, f.location_desc, f.sap_notification, f.sap_order, f.pid_no, f.service]
        .map(x => (x || '').toLowerCase()).join(' ');
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Integrity of each finding for the dashboard (stripe, badge, "Leaking now" / "Repair required"),
// from the SAME resolver the detail page's banner uses, on the finding's latest usable assessment
// re-derived through computeB313 (resFromSnapshot) — so the dashboard can never disagree with the
// finding's own page. Cached per loadFindings().
let integrityCache = new Map();
export function integrityOf(f) {
  if (!integrityCache.has(f.id)) {
    const snap = latestAssessByFinding.get(f.id);
    integrityCache.set(f.id, resolveIntegrityBanner(f, snap ? resFromSnapshot(snap) : null).key);
  }
  return integrityCache.get(f.id);
}
const isResolved = (f) => f.status === 'Repaired' || f.status === 'Closed';
export const isLeakingNow = (f) => !isResolved(f) && !!f.is_leaking;
export const isRepairRequired = (f) => !isResolved(f) && !f.is_leaking && integrityOf(f) === 'repair';

// Quick views above the register — each is a filters.status value (the #filStatus select carries
// the same values, so the two always agree).
const QUICK_VIEWS = [
  { label: 'All', filter: '' },
  { label: 'Open', filter: 'Open' },
  { label: 'Leaking', filter: '__leaking' },
  { label: 'Repair required', filter: '__repair' },
  { label: 'Needs engineer', filter: '__needs_eng' },
  { label: 'Overdue', filter: '__overdue' },
];

function setStatusFilter(value) {
  filters.status = value;
  filters.severity = '';
  $('filStatus').value = value;
  renderList();
}

// Plural-safe "N finding(s)"
const nFindings = (n) => `${n} finding${n === 1 ? '' : 's'}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Everything above the map | register: sub-line, "Needs attention" cards, status bar + budget,
// new findings per month, open by terminal / severity, and the quick-view tabs. Global counts
// (independent of the active filter), like the old KPI chips. Name kept: app.ts and renderList call it.
export function renderKpis() {
  const count = (st) => findings.filter(f => f.status === st).length;
  const open = findings.filter(f => !isResolved(f));
  const resolved = findings.length - open.length;
  const terms = [...new Set(open.map(f => f.terminal).filter(Boolean))].sort();
  $('dashSub').textContent = findings.length
    ? `${open.length} open${terms.length ? ' across ' + new Intl.ListFormat('en', { type: 'conjunction' }).format(terms) : ''} · ${resolved} resolved`
    : 'No findings recorded yet';

  // ---- Needs attention: the four lists to act on today, with their first findings by name
  const groups = [
    { key: 'leak', label: 'Leaking now', filter: '__leaking', icon: 'alert', rows: findings.filter(isLeakingNow),
      note: 'Pressure boundary breached — contain the leak first.', none: 'No finding is actively leaking.' },
    { key: 'repair', label: 'Repair required', filter: '__repair', icon: 'wrench', rows: findings.filter(isRepairRequired),
      note: 'The wall or the defect needs repair.', none: 'No finding needs repair right now.' },
    { key: 'eng', label: 'Needs engineer', filter: '__needs_eng', icon: 'ruler', rows: findings.filter(needsEngineer),
      note: 'No Line No. or no assessment yet.', none: 'Every open finding has a Line No. and an assessment.' },
    { key: 'due', label: 'Overdue', filter: '__overdue', icon: 'clock', rows: findings.filter(isOverdue),
      note: 'Past the target or re-check date.', none: 'Nothing is past its target or re-check date.' },
  ];
  $('attnGrid').innerHTML = groups.map(g => {
    const top = sortFindings(g.rows).slice(0, 3);
    const items = top.map(f => {
      const meta = g.key === 'due' ? `due ${fmtDate(dueDateOf(f))}`
        : `${esc(f.terminal || '')} · ${ageDays(f) ?? '—'} d`; // terminal + age tell same-named findings apart
      const name = f.pipe_tag || f.location_desc || '—';
      return `<li><a href="#/f/${esc(f.id)}" title="${esc(name)}">${esc(name)}</a><span>${meta}</span></li>`;
    }).join('');
    const n = g.rows.length;
    return `<article class="attn-card attn-${g.key}${n ? '' : ' is-clear'}${filters.status === g.filter ? ' active' : ''}">
      <button type="button" class="attn-head" data-filter="${g.filter}" aria-label="${esc(g.label)}: ${n}. Show in the register">
        <span class="attn-ico" aria-hidden="true">${icon(n ? g.icon : 'check')}</span>
        <span class="attn-label">${esc(g.label)}</span>
        <span class="attn-num">${n}</span>
      </button>
      <p class="attn-note">${esc(n ? g.note : g.none)}</p>
      ${items ? `<ul class="attn-list">${items}</ul>` : ''}
      ${n > top.length ? `<button type="button" class="attn-more" data-filter="${g.filter}">View all ${n}</button>` : ''}
    </article>`;
  }).join('');
  $('attnGrid').querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => setStatusFilter(b.dataset.filter)));

  // ---- Status bar (one segment per status, sized by count) + legend with counts
  const statuses = ['Open', 'Monitoring', 'Repair Planned', 'Repaired', 'Closed'];
  $('statusBar').innerHTML = statuses.filter(st => count(st) > 0).map(st =>
    `<button type="button" class="sb-seg${filters.status === st ? ' active' : ''}" data-filter="${esc(st)}" style="flex:${count(st)} 1 0; background:${STATUS_COLORS[st]};" title="${esc(st)}: ${count(st)}" aria-label="${esc(st)}: ${count(st)}"></button>`
  ).join('') || '<span class="sb-empty"></span>';
  $('statusLegend').innerHTML = statuses.map(st =>
    `<li><button type="button" class="sl-item${filters.status === st ? ' active' : ''}" data-filter="${esc(st)}"><i style="background:${STATUS_COLORS[st]};"></i>${esc(st)}<b>${count(st)}</b></button></li>`
  ).join('');
  ['statusBar', 'statusLegend'].forEach(id => $(id).querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => setStatusFilter(b.dataset.filter))));

  // completion: Repaired + Closed vs all
  const total = findings.length;
  const pct = total > 0 ? Math.round((resolved / total) * 100) : 0;
  $('kpiRingPct').textContent = `${pct}%`;
  $('kpiRingFraction').textContent = `${resolved} of ${total}`;
  $('kpiRingCard').classList.toggle('active', filters.status === '__complete');

  renderBudgetKpi();
  renderTrend();

  // ---- Open findings by terminal (bars) and severity (chips)
  const byTerm = terms.map(t => ({ t, n: open.filter(f => f.terminal === t).length }));
  const maxT = Math.max(1, ...byTerm.map(x => x.n));
  $('openTotal').textContent = nFindings(open.length);
  $('termBars').innerHTML = byTerm.map(({ t, n }) =>
    `<button type="button" class="tb-row${filters.terminal === t ? ' active' : ''}" data-term="${esc(t)}" aria-label="${esc(t)}: ${n} open">
      <span class="tb-name">${esc(t)}</span><span class="tb-track"><span style="width:${Math.round((n / maxT) * 100)}%;"></span></span><b>${n}</b>
    </button>`).join('') || '<p class="dcard-meta">No open findings.</p>';
  $('termBars').querySelectorAll('[data-term]').forEach(b => b.addEventListener('click', () => {
    filters.terminal = filters.terminal === b.dataset.term ? '' : b.dataset.term;
    $('filTerminal').value = filters.terminal;
    renderList();
  }));
  const sevs = ['High', 'Medium', 'Low'];
  $('sevRow').innerHTML = `<span class="dcard-meta">Severity</span>` + sevs.map(s =>
    `<button type="button" class="sev-chip sev-${s.toLowerCase()}${filters.severity === s ? ' active' : ''}" data-sev="${s}">${s} <b>${open.filter(f => f.severity === s).length}</b></button>`).join('');
  $('sevRow').querySelectorAll('[data-sev]').forEach(b => b.addEventListener('click', () => {
    filters.severity = filters.severity === b.dataset.sev ? '' : b.dataset.sev;
    renderList();
  }));

  // ---- Quick-view tabs (counts are global, like the cards)
  const tabCount = { '': findings.length, 'Open': count('Open'), '__leaking': groups[0].rows.length, '__repair': groups[1].rows.length, '__needs_eng': groups[2].rows.length, '__overdue': groups[3].rows.length };
  $('quickTabs').innerHTML = QUICK_VIEWS.map(v =>
    `<button type="button" class="qt${filters.status === v.filter ? ' active' : ''}" data-filter="${v.filter}" aria-pressed="${filters.status === v.filter}">${esc(v.label)} <span>${tabCount[v.filter]}</span></button>`).join('');
  $('quickTabs').querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => setStatusFilter(b.dataset.filter)));
}

// New findings per month over the last 12 months (by inspection date, else record date). One
// series, one accent colour, rounded bar tops, the peak labelled, a native tooltip per bar. Drawn
// as HTML (not a scaling SVG) so the labels keep their size on a 320px phone (break-ui #6).
function renderTrend() {
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ y: d.getFullYear(), m: d.getMonth(), n: 0 });
  }
  findings.forEach(f => {
    const base = f.inspection_date || f.created_at;
    if (!base) return;
    const d = new Date(base);
    const hit = months.find(x => x.y === d.getFullYear() && x.m === d.getMonth());
    if (hit) hit.n++;
  });
  const max = Math.max(1, ...months.map(x => x.n));
  const peakIdx = months.findIndex(x => x.n === max && x.n > 0);
  const cols = months.map((x, i) => {
    const label = `${MONTHS[x.m]} ${x.y}: ${x.n} new finding${x.n === 1 ? '' : 's'}`;
    const h = x.n ? Math.max(4, Math.round((x.n / max) * 100)) : 0;
    return `<button type="button" class="tr-col" title="${label}" aria-label="${label}" data-read="${label}">
      <span class="tr-plot">${i === peakIdx ? `<span class="tr-peak">${x.n}</span>` : ''}<span class="tr-bar" style="height:${h}%;"></span></span>
      <span class="tr-m"><span class="tr-m-s">${MONTHS[x.m][0]}</span><span class="tr-m-l">${MONTHS[x.m]}</span></span>
    </button>`;
  }).join('');
  const aria = 'New findings per month, ' + months.map(x => `${MONTHS[x.m]} ${x.y} ${x.n}`).join(', ');
  $('trendChart').innerHTML = `<div class="trend" role="group" aria-label="${aria}">${cols}</div>`;
  const first = months[0], last = months[11];
  $('trendRange').textContent = `${MONTHS[first.m]} ${first.y} – ${MONTHS[last.m]} ${last.y}`;
  const total12 = months.reduce((s, x) => s + x.n, 0);
  const resolved = findings.filter(isResolved).length;
  const note = $('trendNote');
  const defaultNote = `${total12} new in 12 months · ${resolved} resolved so far`;
  note.textContent = defaultNote;
  // A bar's value is readable by hover, keyboard focus or a tap — not only a native tooltip.
  const cols$ = [...$('trendChart').querySelectorAll('.tr-col')];
  const show = (c) => { cols$.forEach(x => x.classList.toggle('is-read', x === c)); note.textContent = c ? c.dataset.read : defaultNote; };
  cols$.forEach(c => {
    c.addEventListener('mouseenter', () => show(c));
    c.addEventListener('focus', () => show(c));
    c.addEventListener('click', () => show(c));
    c.addEventListener('mouseleave', () => show(null));
    c.addEventListener('blur', () => show(null));
  });
}

// Outstanding repair budget: Σ estimated_cost over findings not yet Repaired/Closed, with a
// High/Medium/Low split. Computed globally, independent of the active filter.
export function renderBudgetKpi() {
  const out = findings.filter(f => !isResolved(f));
  const sum = arr => arr.reduce((s, f) => s + (Number(f.estimated_cost) || 0), 0);
  const noEst = out.filter(f => f.estimated_cost == null).length;
  $('kbTotal').textContent = paFmtBahtShort(sum(out));
  $('kbSub').textContent = noEst ? `${noEst} not yet estimated` : nFindings(out.length);
  const sev = s => paFmtBahtShort(sum(out.filter(f => f.severity === s)));
  $('kbSev').innerHTML = ['High', 'Medium', 'Low'].map(s =>
    `<span class="kb-sev-item kb-${s.toLowerCase()}"><i></i>${s === 'Medium' ? 'Med' : s} <b>${sev(s)}</b></span>`).join('');
  $('kpiBudgetCard').classList.toggle('active', filters.status === '__outstanding');
}

export function updateFilterUI() {
  const isTerm = !!filters.terminal;
  const isStat = !!filters.status;
  const isType = !!filters.type;
  const isSev = !!filters.severity;
  const isQ = !!filters.q.trim();

  $('filTerminal')?.classList.toggle('has-filter', isTerm);
  $('filStatus')?.classList.toggle('has-filter', isStat);
  $('filType')?.classList.toggle('has-filter', isType);
  $('filSearch')?.classList.toggle('has-filter', isQ);

  const activeCount = [isTerm, isStat, isType, isSev, isQ].filter(Boolean).length;
  const badgeWrap = $('filActiveBadgeWrap');
  const badge = $('filActiveBadge');
  if (badgeWrap && badge) {
    badgeWrap.dataset.open = String(activeCount > 0);
    badge.textContent = `${activeCount}`;
  }
}

/* ---------------- dashboard map ---------------- */

export function ensureDashMap() {
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
  setDashMap(L.map(el, { center: DEFAULT_MAP_VIEW.center, zoom: DEFAULT_MAP_VIEW.zoom, scrollWheelZoom: false }));
  L.tileLayer(SAT_TILES.url, { maxZoom: SAT_TILES.maxZoom, attribution: SAT_TILES.attribution }).addTo(dashMap);
  // Risk-radius circles get their OWN pane, z-indexed below Leaflet's default overlayPane (400,
  // where circleMarker pins live). This guarantees pins always paint on top of the circles
  // regardless of DOM insertion order — relying on layer-group creation order isn't enough, since
  // toggling the risk overlay redraws only dashRiskLayer (not the pins), and a shared-pane SVG
  // stacks purely by insertion order, which that toggle would otherwise disturb.
  dashMap.createPane('riskPane');
  dashMap.getPane('riskPane').style.zIndex = 350;
  setDashRiskLayer(L.layerGroup().addTo(dashMap));
  setDashLayer(L.layerGroup().addTo(dashMap));
  // scroll-zoom only after the user clicks the map — otherwise page scrolling gets hijacked
  dashMap.on('focus click', () => dashMap.scrollWheelZoom.enable());
  dashMap.on('blur', () => dashMap.scrollWheelZoom.disable());
  // double-click drops a pin and offers "Add finding here" instead of zooming
  dashMap.doubleClickZoom.disable();
  dashMap.on('dblclick', (e) => showAddFindingPopup(e.latlng));
  dashMap.on('popupclose', () => { if (dashAddMarker) { dashLayer.removeLayer(dashAddMarker); setDashAddMarker(null); } });
  setTimeout(() => dashMap.invalidateSize(), 150);
}

export function popupHtml(f) {
  const thumb = photoThumbs[f.id];
  const imgUrl = thumb ? photoUrl(thumb.storage_path) : null;
  const overdueBadge = isOverdue(f) ? '<span class="mp-badge-overdue">OVERDUE</span>' : '';

  return `<div class="mp-card ${imgUrl ? 'has-thumb' : ''}">
    ${imgUrl ? `
      <div class="mp-card-banner">
        <img src="${esc(imgUrl)}" alt="" class="mp-card-img" loading="lazy">
        ${overdueBadge ? `<div class="mp-card-badges">${overdueBadge}</div>` : ''}
      </div>
    ` : ''}
    <div class="mp-card-content">
      <div class="mp-card-top">
        <div class="mp-card-tag" title="${esc(f.pipe_tag || f.location_desc || '')}">${esc(f.pipe_tag || f.location_desc || '—')}</div>
        ${pillHtml(f.status)}
      </div>
      ${!imgUrl && overdueBadge ? `<div style="margin-top:2px;">${overdueBadge}</div>` : ''}
      <div class="mp-card-meta">
        <span class="mp-meta-chip">${esc(f.terminal)}</span>
        <span class="mp-meta-dot">•</span>
        <span class="mp-meta-type" title="${esc(f.finding_type)}">${esc(f.finding_type)}</span>
      </div>
      ${(f.pipe_tag && f.location_desc) ? `<div class="mp-card-loc" title="${esc(f.location_desc)}">Loc: ${esc(f.location_desc)}</div>` : ''}
      <a href="#/f/${esc(f.id)}" class="mp-card-btn">
        <span>Open Finding</span>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
      </a>
    </div>
  </div>`;
}


// Double-click the dashboard map -> drop a temporary pin + a small popup that opens the New
// Finding form pre-seeded with these coordinates. openForm(null) reads pendingNewCoords in its
// map-init branch and calls setPin() to place the picker pin.
export function showAddFindingPopup(latlng) {
  if (dashAddMarker) dashLayer.removeLayer(dashAddMarker);
  setDashAddMarker(L.circleMarker(latlng, {
    radius: 8, color: '#156B95', fillColor: '#38bdf8', fillOpacity: 0.9, weight: 2
  }).addTo(dashLayer));

  const node = document.createElement('div');
  node.className = 'mp-card-content';
  node.innerHTML = `<div class="mp-card-tag">Add finding here?</div>
    <div class="mp-card-meta mono">${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}</div>`;
  const btn = document.createElement('button');
  btn.className = 'mp-card-btn';
  btn.type = 'button';
  btn.style.border = 'none';
  btn.style.width = '100%';
  btn.style.cursor = 'pointer';
  btn.textContent = 'Add finding here';
  btn.addEventListener('click', () => {
    setPendingNewCoords({ lat: latlng.lat, lng: latlng.lng });
    dashMap.closePopup();
    location.hash = '#/new';
  });
  node.appendChild(btn);

  L.popup({ closeButton: true }).setLatLng(latlng).setContent(node).openOn(dashMap);
}

// Presentation-mode risk-zone overlay: a small translucent, gently pulsing L.circle (real-world
// metres, so it scales correctly with zoom, unlike a pixel-radius circleMarker) around every
// plotted pin, colored to match that pin's current color-by fill. Purely a proximity/clustering
// visual aid for the big screen — not a computed consequence distance — so it's deliberately
// fixed-radius and only ever shown when mapShowRiskRadius is on (the map toolbar's Risk Zones
// switch — see toggleRiskRadius below; available on the normal dashboard, not presentation-only).
// Drawn into its own 'riskPane' (z-indexed below the pins' default
// overlayPane in ensureDashMap) so the pin markers always stay visually on top of the circles no
// matter which function (this one, or a full renderMap) last touched either layer. The pulse
// animation is pure CSS (`.risk-radius-circle` in app.css) driven off Leaflet's `className` option.
function renderRiskRadius(pts) {
  if (!dashRiskLayer) return;
  dashRiskLayer.clearLayers();
  if (!mapShowRiskRadius) return;
  pts.forEach(f => {
    dashRiskLayer.addLayer(L.circle([f.lat, f.lng], {
      pane: 'riskPane', className: 'risk-radius-circle',
      radius: RISK_RADIUS_M, color: colorFor(f), weight: 1.5, opacity: 0.55,
      fillColor: colorFor(f), fillOpacity: 0.12, interactive: false
    }));
  });
}

// Toggles the risk-radius overlay (available on the dashboard map generally, not just presentation
// mode) and redraws it against whatever's currently plotted — cheap, since it only touches
// dashRiskLayer, not the pins/legend/sidebar.
export function toggleRiskRadius(forceState) {
  const next = typeof forceState === 'boolean' ? forceState : !mapShowRiskRadius;
  setMapShowRiskRadius(next);
  const btn = $('btnRiskRadius');
  if (btn) { btn.classList.add('is-init'); btn.classList.toggle('is-on', next); btn.setAttribute('aria-checked', String(next)); }
  renderRiskRadius(lastRenderedRows.filter(f => f.lat != null && f.lng != null));
}

export function renderMap(rows) {
  ensureDashMap();
  const pts = rows.filter(f => f.lat != null && f.lng != null);
  renderMapLegend(pts); // counts reflect exactly what's plotted as pins, not the full filtered set
  if (!dashMap) return;
  // The container was display:none while another view was active; Leaflet's cached size is
  // stale (0×0), and fitBounds against a zero-size map computes a world-level zoom. Re-measure
  // synchronously — show('viewList') has already run by the time renderMap is called. A second,
  // deferred invalidate is cheap insurance against any layout not being fully settled yet
  // (fonts/webfont swap, etc.) on the first paint.
  dashMap.invalidateSize();
  setTimeout(() => dashMap.invalidateSize(), 100);
  renderRiskRadius(pts); // drawn first so pins stack visually above the circles
  dashLayer.clearLayers();
  setDashMarkers({});
  pts.forEach(f => {
    const color = colorFor(f);
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
    pin.bindTooltip(esc(f.pipe_tag || f.location_desc || 'Finding'), { direction: 'top', offset: [0, -6], className: 'map-pin-tooltip' });
    pin.on('click', () => {
      const card = document.querySelector(`#presSidebarList .pres-sidebar-card[data-id="${CSS.escape(f.id)}"]`);
      if (card) {
        document.querySelectorAll('#presSidebarList .pres-sidebar-card').forEach(c => c.classList.remove('is-selected'));
        card.classList.add('is-selected');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
    dashLayer.addLayer(pin);
    dashMarkers[f.id] = pin;
  });
  renderPresSidebar(pts);
  if (pts.length) {
    dashMap.fitBounds(L.latLngBounds(pts.map(f => [f.lat, f.lng])).pad(0.25), { maxZoom: 17 });
  } else {
    dashMap.setView(DEFAULT_MAP_VIEW.center, DEFAULT_MAP_VIEW.zoom);
  }
}

/* row -> pin: emphasize the marker while hovering its row */
export function highlightPin(id, on) {
  const m = dashMarkers[id];
  if (!m) return;
  m.setRadius(on ? 12 : 8);
  m.setStyle({ weight: on ? 3 : 2 });
  if (on) m.bringToFront();
}

/* pin -> row: scroll the row into view and flash it */
export function flashRow(id) {
  showRowFor(id);
  const tr = document.querySelector(`#listBody tr[data-id="${CSS.escape(id)}"]`);
  if (!tr) return;
  tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  tr.classList.remove('row-flash');
  void tr.offsetWidth; // restart the animation
  tr.classList.add('row-flash');
}

export const CAMERA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
export const NO_PHOTO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/><line x1="2" y1="2" x2="22" y2="22" stroke="currentColor" stroke-width="1.5"/></svg>';

export function ageHtml(f) {
  const d = ageDays(f);
  if (d == null) return inspectionDateIssue(f.inspection_date)
    ? `<span class="age" title="Check the inspection date (${esc(f.inspection_date)})">—</span>`
    : '<span class="age">—</span>';
  const active = f.status !== 'Repaired' && f.status !== 'Closed';
  const cls = active && d >= 180 ? 'age age-old' : active && d >= 90 ? 'age age-warn' : 'age';
  return `<span class="${cls}" title="Days since inspection">${d}d</span>`;
}

// Row selection for the Summary PDF (see exportSummaryPdf): a plain Set of finding ids,
// persisted across re-renders/filter changes within the same list load, cleared whenever
// loadFindings() pulls fresh data (stale ids could otherwise reference deleted rows).

// basecoat's .empty component (components/empty.css: header > figure/h2/p, centered) — nested
// inside the register's single-cell placeholder <tr><td> since .empty itself can't be a direct
// table child. EMPTY_ICON is a plain inbox/tray glyph (no basecoat icon set is bundled; matches
// the outline-SVG convention CAMERA_SVG already uses elsewhere in this file).
const EMPTY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';

// Register status pill: the full status, plus a short form the phone layout shows instead (the
// status column is 64px there and "MONITORING" / "REPAIR PLANNED" spilled out of it).
const STATUS_SHORT = { 'Open': 'Open', 'Monitoring': 'Monitor', 'Repair Planned': 'Planned', 'Repaired': 'Repaired', 'Closed': 'Closed' };
function regPill(status) {
  return pillHtml(status).replace(/>([^<]*)<\/span>$/, (m, t) => `><span class="pl-full">${t}</span><span class="pl-short" aria-hidden="true">${esc(STATUS_SHORT[status] || t)}</span></span>`);
}

// The register draws REG_PAGE rows at a time with a "Show more" row, instead of every finding at
// once (1,200 findings added ~0.7 s and keeps growing). The map still shows every filtered pin;
// renderList() resets the count whenever the filters change.
const REG_PAGE = 50;
let regLimit = REG_PAGE;
export function resetRegisterPage() { regLimit = REG_PAGE; }
export function showRowFor(id) {
  const i = lastRenderedRows.findIndex(f => f.id === id);
  if (i >= regLimit) { regLimit = Math.ceil((i + 1) / REG_PAGE) * REG_PAGE; renderTable(lastRenderedRows); }
}

export function renderTable(rows) {
  setLastRenderedRows(rows);
  const body = $('listBody');
  if (!rows.length) {
    const hasAnyFindings = !!findings.length;
    body.innerHTML = `<tr class="empty-row"><td colspan="6">
      <div class="empty">
        <header>
          <figure>${EMPTY_ICON}</figure>
          <h2>${hasAnyFindings ? 'No findings match the current filters.' : 'No findings recorded yet.'}</h2>
          <p>${hasAnyFindings ? 'Try a different terminal, status, or search term.' : 'Use “New finding” to add the first one.'}</p>
        </header>
      </div>
    </td></tr>`;
    $('regMore').hidden = true;
    updateSelectionUI();
    return;
  }
  const shown = rows.slice(0, regLimit);
  body.innerHTML = shown.map(f => {
    const due = dueDateOf(f);
    const dueHtml = isOverdue(f)
      ? `<span class="ov-badge">${fmtDate(due)}</span>`
      : `<span class="mono">${fmtDate(due)}</span>`;
    const np = photoCounts[f.id] || 0;
    const photoChip = np ? `<span class="t-photos">${CAMERA_SVG}${np}</span>` : '';
    const thumb = photoThumbs[f.id];
    const thumbHtml = thumb
      ? `<img class="row-thumb" src="${esc(photoUrl(thumb.storage_path))}" alt="" loading="lazy">`
      : `<div class="row-thumb row-thumb-empty">${NO_PHOTO_SVG}<span>No Photo</span></div>`;
    const dim = (f.status === 'Repaired' || f.status === 'Closed') ? ' row-dim' : '';
    const checked = selectedIds.has(f.id) ? ' checked' : '';
    // integrity stripe + badge (leaking / repair / monitor only — OK and pending stay quiet)
    const ig = isResolved(f) ? '' : integrityOf(f);
    const IG_WORD = { leaking: 'LEAKING', repair: 'REPAIR', monitor: 'MONITOR' };
    const igBadge = IG_WORD[ig] ? `<span class="ig-badge ig-${ig}">${IG_WORD[ig]}</span>` : '';
    const engFlag = needsEngineer(f) ? `<span class="eng-flag" title="Needs engineer">${icon('ruler')}<span class="eng-txt">Needs engineer</span></span>` : '';
    // data-state="selected" is applied by updateSelectionUI() below (also the row's live sync
    // point), not here — one place to keep new-render and post-toggle state in agreement.
    return `<tr data-id="${esc(f.id)}" class="${(dim + (IG_WORD[ig] ? ' ig-row ig-' + ig : '')).trim()}">
      <td class="c-check"><input type="checkbox" class="row-check" data-sel="${esc(f.id)}"${checked}></td>
      <td>${regPill(f.status)}</td>
      <td class="c-tag">
        <div class="c-tag-flex">
          ${thumbHtml}
          <div class="c-tag-text">
            <div class="t-ident">
            <div class="t-tag-row"><span class="t-tag" title="${esc(f.pipe_tag || f.location_desc || '')}">${esc(f.pipe_tag || f.location_desc || '—')}</span>${igBadge}${photoChip}${engFlag}</div>
            <div class="t-type" title="${esc(f.finding_type)}">${esc(f.finding_type)}</div>
            </div>
            <div class="t-detail">
            ${(f.pipe_tag && f.location_desc) ? `<div class="t-desc" title="${esc(f.location_desc)}"><span class="t-desc-label">Loc:</span> ${esc(f.location_desc)}</div>` : ''}
            ${f.description ? `<div class="t-desc" title="${esc(f.description)}"><span class="t-desc-label">Anomaly:</span> ${esc(f.description)}</div>` : ''}
            </div>
          </div>
        </div>
      </td>
      <td>${esc(f.terminal)}</td>
      <td>${ageHtml(f)}</td>
      <td><div class="due-row-flex">${dueHtml}<span class="row-arrow" title="View details">&#8594;</span></div></td>
    </tr>`;
  }).join('');
  const more = $('regMore');
  more.hidden = rows.length <= shown.length;
  more.innerHTML = more.hidden ? '' : `<button type="button" class="btn btn-sm" data-variant="outline" id="btnRegMore">Show ${Math.min(REG_PAGE, rows.length - shown.length)} more</button><span class="more-note">Showing ${shown.length} of ${rows.length}</span>`;
  $('btnRegMore')?.addEventListener('click', () => { regLimit += REG_PAGE; renderTable(rows); });
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

// text states swap (transitions.dev): old text exits up+blurred, new text enters from below.
// No-ops when the text hasn't changed so a re-render with the same value doesn't replay it.
export function swapText(el, next) {
  if (!el || el.textContent === next) return;
  el.classList.add('is-exit');
  const dur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--text-swap-dur')) || 150;
  setTimeout(() => {
    el.textContent = next;
    el.classList.remove('is-exit');
    el.classList.add('is-enter-start');
    void el.offsetHeight; // force reflow so the entrance transitions
    el.classList.remove('is-enter-start');
  }, dur);
}

// Syncs the header "select all" checkbox (checked/indeterminate) and the selection bar
// (count + Summary PDF button label) to the current selectedIds / rendered-rows state.
export function updateSelectionUI() {
  const selectAll = $('chkSelectAll');
  const idsOnPage = lastRenderedRows.map(f => f.id);
  const selectedOnPage = idsOnPage.filter(id => selectedIds.has(id)).length;
  if (selectAll) {
    selectAll.checked = idsOnPage.length > 0 && selectedOnPage === idsOnPage.length;
    selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < idsOnPage.length;
  }
  // basecoat's .table styles tr[data-state="selected"] with a --muted background (table.css) —
  // .list replicates that one rule (app.css) since the register isn't basecoat's .table class.
  $('listBody').querySelectorAll('tr[data-id]').forEach(tr => {
    if (selectedIds.has(tr.dataset.id)) tr.setAttribute('data-state', 'selected');
    else tr.removeAttribute('data-state');
  });
  const bar = $('selBar');
  const btn = $('btnExport').querySelector('.t-text-swap');
  if (selectedIds.size > 0) {
    bar.hidden = false;
    $('selCount').textContent = `${selectedIds.size} selected`;
    swapText(btn, `Export (${selectedIds.size})`);
  } else {
    bar.hidden = true;
    swapText(btn, 'Export');
  }
  // The pinned column headers sit just below the pinned selection bar (app.css) — tell them its height.
  bar.closest('.dash-list-panel')?.style.setProperty('--sel-bar-h', bar.hidden ? '0px' : `${bar.offsetHeight}px`);
}

// Tag combobox options: union of findings' own history and the master line list, each paired
// with a location (for search) and a terminal (so the list can be scoped to whichever terminal
// is selected on the form — a KBY finding has no business suggesting an SRC tag). Findings supply
// the learned location (most recent wins); line-list-only tags show their service as the sub-line.
let tagOptionsCache = null;
let lastCacheKey = null;

export function invalidateTagOptionsCache() {
  tagOptionsCache = null;
}

export function buildTagOptions() {
  const currentKey = `${findings.length}_${lineList.length}`;
  if (tagOptionsCache && lastCacheKey === currentKey) {
    return tagOptionsCache;
  }
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
  tagOptionsCache = [...byTag.entries()].map(([tag, o]) => ({ tag, location: o.location, terminal: o.terminal })).sort((a, b) => a.tag.localeCompare(b.tag));
  lastCacheKey = currentKey;
  return tagOptionsCache;
}

export function renderList() {
  resetRegisterPage();
  renderKpis();
  updateFilterUI();
  const rows = sortFindings(applyFilters(findings));
  renderTable(rows);
  renderMap(rows);
}

// Phones (<=640px): the map is behind a "Show map" button so the register comes first; on wider
// screens the button is hidden by CSS and the map always shows.
export function toggleMobileMap(force) {
  const on = typeof force === 'boolean' ? force : !document.body.classList.contains('show-dash-map');
  document.body.classList.toggle('show-dash-map', on);
  const btn = $('btnShowMap');
  if (btn) { btn.setAttribute('aria-pressed', String(on)); swapText(btn.querySelector('.t-text-swap'), on ? 'Hide map' : 'Show map'); }
  if (on && dashMap) setTimeout(() => dashMap.invalidateSize(), 60);
}

export function resetMapView() {
  if (!dashMap || !lastRenderedRows) return;
  const pts = lastRenderedRows.filter(f => f.lat != null && f.lng != null);
  if (pts.length) {
    dashMap.fitBounds(L.latLngBounds(pts.map(f => [f.lat, f.lng])).pad(0.25), { maxZoom: 17 });
  } else {
    dashMap.setView(DEFAULT_MAP_VIEW.center, DEFAULT_MAP_VIEW.zoom);
  }
}

export function toggleMapPresentation(forceState?: boolean) {
  const panel = $('dashMapPanel');
  const btn = $('btnMapExpand');
  if (!panel || !btn) return;

  const isPres = typeof forceState === 'boolean' ? forceState : !panel.classList.contains('map-presentation');
  const wasPres = panel.classList.contains('map-presentation');
  if (isPres === wasPres) return;

  // icon swap (transitions.dev): both the expand and collapse glyphs live in the DOM
  // permanently (see index.html's .t-icon-swap markup) — cross-fade via data-state instead of
  // replacing innerHTML, which used to snap between icons with no transition at all.
  const iconSwap = btn.querySelector('.t-icon-swap');
  if (iconSwap) iconSwap.setAttribute('data-state', isPres ? 'b' : 'a');
  // Icon-only — title carries the visible tooltip/shortcut hint; aria-label carries the same text
  // as the accessible name, since title alone isn't reliably exposed to screen readers on a button
  // with no visible text content.
  const presLabel = isPres ? 'Exit presentation (Esc)' : 'Full-screen presentation (F)';
  btn.title = presLabel;
  btn.setAttribute('aria-label', presLabel);

  const presControls = document.querySelectorAll('.pres-only');
  presControls.forEach(el => { el.hidden = !isPres; });

  const summary = $('presSummaryBar');
  if (summary) {
    summary.hidden = !isPres;
    if (isPres) {
      const activePts = lastRenderedRows.filter(f => f.lat != null && f.lng != null);
      const overduePts = activePts.filter(isOverdue).length;
      summary.textContent = `${activePts.length} on the map · ${overduePts} overdue`;
    }
  }

  const sel = $('presTerminalFilter');
  if (sel && isPres) sel.value = filters.terminal || '';

  // Every other view/table/register on the dashboard is still in the DOM underneath the fixed
  // overlay; without this, Tab can leave the presentation surface and land on a background
  // control the user can't see. Restored on exit so normal dashboard keyboard nav resumes.
  // (the page head, attention cards and overview sit above .dash-split; the register is the
  // map's sibling inside it)
  document.querySelectorAll('.dash-head, .dash-attn, .dash-overview, .dash-list-panel').forEach(el => {
    if (!(el instanceof HTMLElement) || el.contains(panel)) return;
    if (isPres) el.setAttribute('inert', ''); else el.removeAttribute('inert');
  });

  // Double-click drops an "Add finding here" pin — a real hazard during a hands-off screen-share
  // presentation, so disarm it for the duration rather than merely hiding the hint text.
  if (dashMap) {
    if (isPres) dashMap.doubleClickZoom.disable();
    dashMap.off('dblclick');
    if (!isPres) dashMap.on('dblclick', (e: any) => showAddFindingPopup(e.latlng));
  }

  if (isPres) {
    panel.classList.remove('map-presentation-out');
    panel.classList.add('map-presentation');
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = '';
    togglePresSidebar(false);
    // Risk Zones is a regular map layer toggle now (like Satellite) — available on the normal
    // dashboard too, so it deliberately stays as the user left it across a presentation-mode
    // enter/exit rather than being forced off.
    // Play the reverse animation, then swap the fixed-overlay class off once it finishes so the
    // panel doesn't just disappear on the same frame Exit is clicked. animationend can fail to
    // fire (browser quirks, animations disabled, reduced-motion) — a timeout fallback guarantees
    // the exit always completes even if the visual animation doesn't run.
    panel.classList.add('map-presentation-out');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      panel.classList.remove('map-presentation', 'map-presentation-out');
      panel.removeEventListener('animationend', finish);
      if (dashMap) {
        dashMap.invalidateSize();
        // Mirror of the entry fix: presentation mode fits/zooms in for the full-screen container,
        // so once it shrinks back to the normal dashboard size that same zoom now shows too little
        // area — refit to the plotted points at the smaller container's dimensions too.
        resetMapView();
      }
    };
    panel.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 200);
  }

  if (dashMap) {
    dashMap.invalidateSize();
    setTimeout(() => dashMap.invalidateSize(), 50);
    setTimeout(() => {
      dashMap.invalidateSize();
      // The container just grew to full-screen but the map kept its previous (smaller-view)
      // zoom/center — at that same zoom level the much bigger viewport now shows far more
      // surrounding area, which reads as "zoomed out" relative to the plotted points. Refit
      // once the expand animation has settled, same fit-bounds logic as the Reset View button.
      if (isPres) resetMapView();
    }, 250);
  }
}

export function renderPresSidebar(rows) {
  const container = $('presSidebarList');
  const countEl = $('presSidebarCount');
  if (!container) return;

  const pts = rows.filter(f => f.lat != null && f.lng != null);
  if (countEl) countEl.textContent = `${pts.length}`;

  if (!pts.length) {
    container.innerHTML = `<div class="pres-sidebar-empty">No findings with a map location in this view.</div>`;
    return;
  }

  container.innerHTML = pts.map(f => {
    const thumb = photoThumbs[f.id];
    const thumbHtml = thumb
      ? `<img class="pres-card-thumb" src="${esc(photoUrl(thumb.storage_path))}" alt="" loading="lazy">`
      : `<div class="pres-card-thumb pres-card-thumb-empty">${NO_PHOTO_SVG}</div>`;
    return `<div class="pres-sidebar-card" data-id="${esc(f.id)}">
      ${thumbHtml}
      <div class="pres-card-text">
        <div class="pres-card-row">
          <span class="pres-card-tag" title="${esc(f.pipe_tag || f.location_desc || '')}">${esc(f.pipe_tag || f.location_desc || '—')}</span>
          ${pillHtml(f.status)}
        </div>
        <div class="pres-card-sub">${esc(f.terminal)} • ${esc(f.finding_type)}</div>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.pres-sidebar-card[data-id]').forEach(card => {
    const id = card.dataset.id;
    card.addEventListener('click', () => {
      container.querySelectorAll('.pres-sidebar-card').forEach(c => c.classList.remove('is-selected'));
      card.classList.add('is-selected');
      const f = findings.find(x => x.id === id);
      if (f && f.lat != null && f.lng != null && dashMap) {
        dashMap.flyTo([f.lat, f.lng], 16, { duration: 0.8 });
        dashMarkers[id]?.openPopup();
      }
    });
  });
}

export function togglePresSidebar(forceState?: boolean) {
  const sidebar = $('presSidebar');
  const btn = $('btnPresToggleSidebar');
  if (!sidebar) return;

  const show = typeof forceState === 'boolean' ? forceState : sidebar.hidden;
  btn?.classList.toggle('active', show);

  const invalidate = () => {
    if (!dashMap) return;
    dashMap.invalidateSize();
    setTimeout(() => dashMap.invalidateSize(), 50);
    setTimeout(() => dashMap.invalidateSize(), 250);
  };

  if (show) {
    sidebar.classList.remove('pres-sidebar-out');
    sidebar.hidden = false;
    invalidate(); // the map reflows to the sidebar's width immediately; only the sidebar's own
                   // content animates in via slideInRight, so this stays synchronous with open
  } else {
    if (sidebar.hidden) return; // already closed — .pres-sidebar-out CSS existed but nothing
                                 // ever applied it, so close used to just snap via [hidden] with
                                 // no animation at all, unlike open's slideInRight
    sidebar.classList.add('pres-sidebar-out');
    // read from the CSS custom property (rather than hardcoding) so this stays in sync with
    // .pres-sidebar-out's own animation-duration if --duration-medium is ever retuned
    const closeMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--duration-medium')) || 350;
    setTimeout(() => {
      sidebar.hidden = true;
      sidebar.classList.remove('pres-sidebar-out');
      invalidate(); // wait for the close animation so the map only widens once the sidebar is gone
    }, closeMs);
  }
}
