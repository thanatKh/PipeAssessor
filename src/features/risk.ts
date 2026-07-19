// @ts-nocheck — Phase 1 posture (see CLAUDE.md's module map) — same as the other features/*
// modules; strict typing added incrementally.
/* ============================================================================
   Line Risk Ranking (#/risk): a qualitative risk ranking of piping LINES, not
   findings — rolled up from each line's findings' ASME B31.3 status. NOT an
   API 581 quantitative POF (no damage-factor tables, inspection-effectiveness
   history, or consequence modeling here) — deliberately named "Risk Ranking"
   rather than "POF" so it's never mistaken for a certified RBI figure.

   Key modeling facts (confirmed against db/schema.sql before building this):
   - A "line" is keyed by pipe_tag; findings with no pipe_tag can't group into
     a line, so each becomes its own single-finding pseudo-line keyed by
     location_desc (falls back to '—' — mirrors the tag-fallback convention
     used everywhere else in the app, e.g. pillHtml/PDF tag columns).
   - Location and finding_type (damage mechanism) BOTH live on the finding, not
     the line — line_list has no location_desc column at all (explicitly
     dropped, see schema.sql) and no mechanism column either. So a line with
     multiple findings can have multiple locations AND multiple mechanisms;
     this is surfaced honestly (a location count + up to 2 mechanism chips),
     never flattened to one value.
   - Risk band = worst ASME B31.3 status across the line's assessed findings
     (REPAIR > MONITOR > OK), re-derived from each finding's LATEST assessment
     snapshot via resFromSnapshot() (detail.ts) — same function the detail page
     uses, so this page and the detail page can never disagree.
   - Non-wall-loss finding types (Dent, Coating, Pipe Support Defect, Other)
     never get a computeB313 result at all — they're deliberately still shown,
     permanently in the "Not Assessed" band, since a bad Dent is still a real
     risk even without a numeric wall-thickness score (confirmed with the user
     — excluding them would hide real problems).
   ============================================================================ */
import { $, esc, fmtDate } from '../core/dom';
import { WALL_LOSS_TYPES, TYPE_COLORS, FINDING_TYPE_SHORT } from '../core/constants';
import { sb } from '../core/supabase';
import { paFmt } from '../engine/format';
import {
  findings, riskAssessments, setRiskAssessments, riskFilters,
} from '../core/state';
import { resFromSnapshot } from './detail';

export type RiskBand = 'high' | 'medium' | 'low' | 'na';

const BAND_RANK: Record<RiskBand, number> = { high: 0, medium: 1, low: 2, na: 3 };
const STATUS_TO_BAND: Record<string, RiskBand> = { REPAIR: 'high', MONITOR: 'medium', OK: 'low' };
const BAND_LABEL: Record<RiskBand, string> = { high: 'High', medium: 'Medium', low: 'Low', na: 'Not Assessed' };

// Loads every finding's assessment history in one query (not per-finding, like the detail page —
// this page needs all of them at once) and keeps only the latest row per finding_id client-side.
// Mirrors loadFindings()'s "load everything, derive views client-side" shape; assessments RLS is
// unrestricted "authenticated full access" (schema.sql), so an unfiltered select is allowed.
export async function loadRiskData() {
  const { data, error } = await sb.from('assessments')
    .select('finding_id, inputs, results, created_at')
    .order('created_at', { ascending: false });
  if (error) { setRiskAssessments([]); return; }
  const latestByFinding = new Map();
  (data || []).forEach(a => { if (!latestByFinding.has(a.finding_id)) latestByFinding.set(a.finding_id, a); });
  setRiskAssessments([...latestByFinding.values()]);
}

// One entry per finding: its line key, resolved risk band, and the re-derived B313Result (if any).
function buildFindingRiskRows() {
  const assessByFinding = new Map(riskAssessments.map(a => [a.finding_id, a]));
  return findings
    .filter(f => riskFilters.includeResolved || (f.status !== 'Repaired' && f.status !== 'Closed'))
    .filter(f => !riskFilters.terminal || f.terminal === riskFilters.terminal)
    .map(f => {
      const lineKey = f.pipe_tag || null; // null = can't group; becomes its own pseudo-line below
      let band: RiskBand = 'na';
      let res = null;
      if (WALL_LOSS_TYPES.includes(f.finding_type)) {
        const a = assessByFinding.get(f.id);
        res = a ? resFromSnapshot(a) : null;
        if (res) band = STATUS_TO_BAND[res.status] || 'na';
      }
      return { finding: f, lineKey, band, res };
    });
}

// Groups finding-risk-rows into lines (by pipe_tag; ungrouped findings become their own
// single-finding line keyed by a synthetic id so they don't collide with each other) and rolls
// each line up to its worst band, its set of distinct locations, and its set of distinct
// mechanisms — never picking just one of either, per the file-header note.
export function computeLineRisk() {
  const rows = buildFindingRiskRows();
  const lines = new Map();
  rows.forEach(r => {
    const key = r.lineKey || `__solo_${r.finding.id}`;
    let line = lines.get(key);
    if (!line) {
      line = { tag: r.lineKey, terminal: r.finding.terminal, findingRows: [] };
      lines.set(key, line);
    }
    line.findingRows.push(r);
  });

  return [...lines.values()].map(line => {
    const sorted = [...line.findingRows].sort((a, b) => BAND_RANK[a.band] - BAND_RANK[b.band]);
    const worst = sorted[0];
    const locations = [...new Set(line.findingRows.map(r => r.finding.location_desc || '—'))];
    const mechanisms = [...new Set(line.findingRows.map(r => r.finding.finding_type))];
    const isLeaking = line.findingRows.some(r => r.finding.is_leaking);
    return {
      tag: line.tag, // null for a single ungrouped finding
      displayTag: line.tag || line.findingRows[0].finding.location_desc || '—',
      terminal: line.terminal,
      band: worst.band,
      findingRows: sorted, // worst-first, for the expand panel
      locations,
      mechanisms,
      isLeaking,
      worstRes: worst.res,
      findingCount: line.findingRows.length,
    };
  }).sort((a, b) => {
    if (BAND_RANK[a.band] !== BAND_RANK[b.band]) return BAND_RANK[a.band] - BAND_RANK[b.band];
    // within a band, most urgent (shortest remaining life) first; lines with no computed
    // remaining life (e.g. Not Assessed, or CR not entered) sort after ones that have it
    const al = a.worstRes && a.worstRes.remainingLife != null ? a.worstRes.remainingLife : Infinity;
    const bl = b.worstRes && b.worstRes.remainingLife != null ? b.worstRes.remainingLife : Infinity;
    if (al !== bl) return al - bl;
    return (a.displayTag || '').localeCompare(b.displayTag || '');
  });
}

function bandPillHtml(band: RiskBand) {
  const cls = band === 'high' ? 'risk-high' : band === 'medium' ? 'risk-med' : band === 'low' ? 'risk-low' : 'risk-na';
  return `<span class="risk-pill ${cls}"><span class="dot"></span>${BAND_LABEL[band]}</span>`;
}

function mechChipsHtml(mechanisms) {
  const shown = mechanisms.slice(0, 2);
  const extra = mechanisms.length - shown.length;
  const chips = shown.map(m => {
    const color = TYPE_COLORS[m] || '#64748b';
    const label = FINDING_TYPE_SHORT[m] || m;
    return `<span class="mech-chip" style="background:color-mix(in oklab, ${color} 14%, transparent); color:${color};">${esc(label)}</span>`;
  }).join('');
  const more = extra > 0 ? `<span class="mech-more">+${extra}</span>` : '';
  return `<span class="mech-chips">${chips}${more}</span>`;
}

function remainingLifeHtml(res) {
  if (!res || res.remainingLife == null) return '<span class="rl-none">—</span>';
  const yrs = res.remainingLife;
  const pct = Math.max(0, Math.min(100, (yrs / 15) * 100)); // 15y+ reads as a full bar
  const color = yrs < 2 ? 'var(--danger-color)' : yrs < 5 ? 'var(--warn-color)' : 'var(--ok-color)';
  const label = yrs < 1 ? '< 1 yr' : yrs >= 15 ? '15+ yr' : `${paFmt(yrs, 1)} yr`;
  return `<span class="life-bar"><span class="life-track"><span class="life-fill" style="width:${pct}%; background:${color}"></span></span>${label}</span>`;
}

function pctWallHtml(res) {
  return res ? `${paFmt(res.pctRemainNom, 0)}%` : '—';
}

function childRowHtml(r) {
  const f = r.finding;
  const marker = r.band === 'high' ? 'm-high' : r.band === 'medium' ? 'm-med' : r.band === 'low' ? 'm-low' : 'm-na';
  const statusText = r.res ? r.res.status : 'N/A';
  const statusCls = r.band === 'high' ? 'cs-high' : r.band === 'medium' ? 'cs-med' : r.band === 'low' ? 'cs-low' : 'cs-na';
  return `<tr class="child-row" data-finding-id="${esc(f.id)}">
    <td></td>
    <td><div class="child-loc"><span class="child-marker ${marker}"></span><span class="child-loc-text">${esc(f.location_desc || '—')}${f.is_leaking ? ' <span class="leak-flag">· leaking</span>' : ''}</span></div></td>
    <td></td>
    <td class="mech-cell-child">${esc(FINDING_TYPE_SHORT[f.finding_type] || f.finding_type)}</td>
    <td></td>
    <td class="num rl-child">${pctWallHtml(r.res)}</td>
    <td class="rl-child">${r.res ? remainingLifeHtml(r.res) : '<span class="rl-none">—</span>'}</td>
    <td><span class="child-status ${statusCls}">${esc(statusText)}</span></td>
  </tr>`;
}

function lineRowHtml(line) {
  const multi = line.findingRows.length > 1;
  // Always reserve the caret's slot (same markup either way, just invisible when there's nothing
  // to expand) so every row's tag text starts at the same x position — a single-location row with
  // no caret markup at all left its tag text flush left, while a multi-location row's caret pushed
  // its tag text ~19px right, so tag text didn't column-align down the table.
  const caret = `<span class="expand-caret"${multi ? '' : ' style="visibility:hidden"'}>▶</span>`;
  const subParts = [];
  if (multi) subParts.push(`<span class="loc-count">${line.locations.length} location${line.locations.length === 1 ? '' : 's'}</span>`);
  else subParts.push(esc(line.locations[0]));
  if (multi) subParts.push(`<span class="worst-tag">worst: ${line.worstRes ? esc(line.worstRes.status) : 'N/A'}</span>`);
  if (line.isLeaking) subParts.push('<span class="leak-flag">LEAKING</span>');
  const sub = subParts.join(' · ');

  const rowCls = multi ? 'line-row' : 'line-row single';
  const rowsAttr = multi ? ` data-line-key="${esc(line.tag || line.displayTag)}"` : '';

  return `<tr class="${rowCls}"${rowsAttr}>
    <td>${bandPillHtml(line.band)}</td>
    <td><div class="tag-cell">${caret}${esc(line.displayTag)}</div><div class="tag-sub">${sub}</div></td>
    <td><span class="chip">${esc(line.terminal || '—')}</span></td>
    <td>${mechChipsHtml(line.mechanisms)}</td>
    <td class="num">${line.findingCount}</td>
    <td class="num">${pctWallHtml(line.worstRes)}</td>
    <td>${remainingLifeHtml(line.worstRes)}</td>
    <td><span class="chip">${esc(line.findingRows[0].finding.status)}</span></td>
  </tr>` + (multi ? line.findingRows.map(childRowHtml).join('') : '');
}

export function renderRiskKpis(lines) {
  const counts = { high: 0, medium: 0, low: 0, na: 0 };
  lines.forEach(l => counts[l.band]++);
  $('riskKpiTotal').textContent = String(lines.length);
  $('riskKpiHigh').textContent = String(counts.high);
  $('riskKpiMed').textContent = String(counts.medium);
  $('riskKpiLow').textContent = String(counts.low);
  $('riskKpiNa').textContent = String(counts.na);
}

const RISK_LEGEND_HTML = `<div class="legend">
  <span class="legend-item"><span class="legend-dot" style="background:var(--danger-color)"></span>High Risk</span>
  <span class="legend-item"><span class="legend-dot" style="background:var(--warn-color)"></span>Medium Risk</span>
  <span class="legend-item"><span class="legend-dot" style="background:var(--ok-color)"></span>Low Risk</span>
  <span class="legend-item"><span class="legend-dot" style="background:var(--text-light)"></span>Not Assessed</span>
</div>`;

export function renderRiskTerminalChart(lines) {
  const terminals = ['KBY', 'SRC', 'BRP'];
  const el = $('riskTerminalChart');
  const bars = terminals.map(t => {
    const rows = lines.filter(l => l.terminal === t);
    if (!rows.length) return '';
    const counts = { high: 0, medium: 0, low: 0, na: 0 };
    rows.forEach(l => counts[l.band]++);
    const total = rows.length;
    const seg = (n, cls) => n ? `<div class="stack-seg ${cls}" style="width:${(n / total) * 100}%"></div>` : '';
    return `<div class="stack-row">
      <span class="stack-label">${esc(t)}</span>
      <div class="stack-bar">${seg(counts.high, 'seg-high')}${seg(counts.medium, 'seg-med')}${seg(counts.low, 'seg-low')}${seg(counts.na, 'seg-na')}</div>
      <span class="stack-total">${total}</span>
    </div>`;
  }).join('');
  el.innerHTML = bars ? bars + RISK_LEGEND_HTML : '<div class="hint" style="margin:0;">No lines match the current filters.</div>';
}

export function renderRiskMechanismChart(lines) {
  const counts = {};
  lines.filter(l => l.band === 'high').forEach(l => {
    l.mechanisms.forEach(m => { counts[m] = (counts[m] || 0) + 1; });
  });
  const entries = Object.entries(counts).sort((a, b) => (b[1] as number) - (a[1] as number));
  const max = entries.length ? (entries[0][1] as number) : 0;
  const el = $('riskMechanismChart');
  if (!entries.length) { el.innerHTML = '<div class="hint" style="margin:0;">No High-risk lines.</div>'; return; }
  el.innerHTML = entries.map(([m, n]) => {
    const color = TYPE_COLORS[m] || '#64748b';
    return `<div class="mech-row">
      <span class="mech-label">${esc(FINDING_TYPE_SHORT[m] || m)}</span>
      <div class="mech-track"><div class="mech-fill" style="width:${((n as number) / max) * 100}%; background:${color}"></div></div>
      <span class="mech-num">${n}</span>
    </div>`;
  }).join('');
}

export function renderRiskTable(lines) {
  const body = $('riskTableBody');
  if (!lines.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="8">
      <div class="empty"><header><h2>No lines match the current filters.</h2><p>Try a different terminal or include resolved findings.</p></header></div>
    </td></tr>`;
    $('riskTableFoot').textContent = '';
    return;
  }
  body.innerHTML = lines.map(lineRowHtml).join('');
  body.querySelectorAll('tr.line-row[data-line-key]').forEach(row => {
    row.addEventListener('click', () => {
      const opening = !row.classList.contains('open');
      row.classList.toggle('open', opening);
      let n = row.nextElementSibling;
      while (n && n.classList.contains('child-row')) {
        (n as HTMLElement).style.display = opening ? '' : 'none';
        n = n.nextElementSibling;
      }
    });
  });
  // children start collapsed
  body.querySelectorAll('tr.child-row').forEach(n => { (n as HTMLElement).style.display = 'none'; });
  $('riskTableFoot').textContent = `Showing ${lines.length} line${lines.length === 1 ? '' : 's'} · High → Low risk, then remaining life ascending; Not-Assessed last`;
}

export function renderRiskPage() {
  const lines = computeLineRisk();
  renderRiskKpis(lines);
  renderRiskTerminalChart(lines);
  renderRiskMechanismChart(lines);
  renderRiskTable(lines);
}

export function initRiskPage() {
  $('riskTerminalFilter').addEventListener('change', (e) => {
    riskFilters.terminal = (e.target as HTMLSelectElement).value;
    renderRiskPage();
  });
  $('riskIncludeResolved').addEventListener('change', (e) => {
    riskFilters.includeResolved = (e.target as HTMLInputElement).checked;
    renderRiskPage();
  });
}
