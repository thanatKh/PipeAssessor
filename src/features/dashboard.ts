// @ts-nocheck — Phase 1: ported 1:1 from the app monolith, verified behaviorally (engine
// parity + Playwright), not via types yet. Same posture as app.ts; strict typing added
// incrementally per module.
/* ============================================================================
   Dashboard: data loading (findings + detail), the map (Leaflet) + its color-by
   legend, the KPI cards + budget, the register table + filters + selection, and
   CSV export helpers shared with import-export. Extracted from the app monolith.
   ============================================================================ */
import L from 'leaflet';
import { $, esc, notify, fmtDate, isOverdue, dueDateOf, pillHtml } from '../core/dom';
import { FINDING_TYPE_SHORT, STATUS_COLORS, TYPE_COLORS, SEVERITY_COLORS, DEFAULT_MAP_VIEW, SAT_TILES, R2_PUBLIC_BASE } from '../core/constants';
import { paFmtBahtShort } from '../engine/format';
import { sb } from '../core/supabase';
import {
  findings, setFindings, lineList, filters, selectedIds, setSelectedIds,
  current, setCurrent, currentPhotos, setCurrentPhotos, currentHistory, setCurrentHistory,
  currentAssessments, setCurrentAssessments, photoCounts, setPhotoCounts, photoThumbs, setPhotoThumbs,
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

export async function loadFindings() {
  selectedIds.clear(); // fresh data -> drop any selection from a previous load (ids may be stale)
  const [fq, pq] = await Promise.all([
    sb.from('findings').select('*').order('created_at', { ascending: false }),
    sb.from('finding_photos').select('finding_id, storage_path, kind, created_at').order('created_at', { ascending: true })
  ]);
  if (fq.error) { notify('Load failed: ' + fq.error.message, true); return; }
  setFindings(fq.data || []);
  setPhotoCounts({});
  setPhotoThumbs({}); // finding_id -> storage_path of its earliest "found" photo (falls back to any)
  (pq.data || []).forEach(p => {
    photoCounts[p.finding_id] = (photoCounts[p.finding_id] || 0) + 1;
    const cur = photoThumbs[p.finding_id];
    if (!cur || (cur.kind !== 'found' && p.kind === 'found')) photoThumbs[p.finding_id] = p;
  });
}

/* Days since the inspection date (falls back to created_at) — how long the finding has existed. */
export function ageDays(f) {
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
  const [f, ph, hi, as] = await Promise.all([
    sb.from('findings').select('*').eq('id', id).single(),
    sb.from('finding_photos').select('*').eq('finding_id', id).order('created_at', { ascending: true }),
    sb.from('status_history').select('*').eq('finding_id', id).order('changed_at', { ascending: false }),
    sb.from('assessments').select('*').eq('finding_id', id).order('created_at', { ascending: false })
  ]);
  if (f.error) { notify('Finding not found.', true); return false; }
  setCurrent(f.data);
  setCurrentPhotos(ph.data || []);
  setCurrentHistory(hi.data || []);
  setCurrentAssessments(as.data || []);
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
    setCurrentAssessments(data.assessments || []);
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

// Circumference of the ring's r=42 circle (2 * PI * 42) — stroke-dasharray/-dashoffset are set
// in absolute SVG units, not percentages, so this constant drives the fill math below.
export const KPI_RING_CIRCUMFERENCE = 2 * Math.PI * 42;

export function renderKpis() {
  const count = (st) => findings.filter(f => f.status === st).length;
  const overdue = findings.filter(isOverdue).length;
  const items = [
    { label: 'Open', num: count('Open'), filter: 'Open' },
    { label: 'Monitoring', num: count('Monitoring'), filter: 'Monitoring' },
    { label: 'Repair Planned', num: count('Repair Planned'), filter: 'Repair Planned' },
    { label: 'Overdue', num: overdue, filter: '__overdue', cls: 'k-overdue' },
    { label: 'Repaired', num: count('Repaired'), filter: 'Repaired' },
    { label: 'All', num: findings.length, filter: '' }
  ];
  $('kpiRowBottom').innerHTML = items.map(it =>
    `<button type="button" class="kpi ${it.cls || ''} ${filters.status === it.filter && (it.filter !== '' || filters.status === '') ? '' : ''}" data-filter="${esc(it.filter)}">
       <span class="k-num">${it.num}</span><span class="k-label">${esc(it.label)}</span>
     </button>`).join('');
  $('kpiRowBottom').querySelectorAll('.kpi').forEach(btn => {
    if (btn.dataset.filter === filters.status) btn.classList.add('active');
    btn.addEventListener('click', () => {
      filters.status = btn.dataset.filter;
      filters.severity = '';
      $('filStatus').value = filters.status;
      renderList();
    });
  });

  // Completion ring: Repaired + Closed vs. all findings. A finding is "resolved" once its
  // repair is confirmed OR the record is formally closed out — matches the register's own
  // dimmed/"row-dim" treatment for these two statuses.
  const total = findings.length;
  const complete = count('Repaired') + count('Closed');
  const pct = total > 0 ? Math.round((complete / total) * 100) : 0;
  const offset = KPI_RING_CIRCUMFERENCE * (1 - (total > 0 ? complete / total : 0));
  $('kpiRingFill').style.strokeDasharray = `${KPI_RING_CIRCUMFERENCE}`;
  $('kpiRingFill').style.strokeDashoffset = `${offset}`;
  $('kpiRingPct').textContent = `${pct}%`;
  $('kpiRingFraction').textContent = `${complete} of ${total}`;
  $('kpiRingCard').classList.toggle('active', filters.status === '__complete');

  renderBudgetKpi();
}

// Outstanding repair budget: Σ estimated_cost over findings not yet Repaired/Closed, with a
// High/Medium/Low split. Computed globally (like the KPI chips), independent of the active filter.
export function renderBudgetKpi() {
  const isOut = f => f.status !== 'Repaired' && f.status !== 'Closed';
  const out = findings.filter(isOut);
  const sum = arr => arr.reduce((s, f) => s + (Number(f.estimated_cost) || 0), 0);
  const noEst = out.filter(f => f.estimated_cost == null).length;
  $('kbTotal').textContent = paFmtBahtShort(sum(out));
  $('kbSub').textContent = `${out.length} finding${out.length === 1 ? '' : 's'}${noEst ? ` · ${noEst} not yet estimated` : ''}`;
  const sev = s => paFmtBahtShort(sum(out.filter(f => f.severity === s)));
  $('kbSev').innerHTML =
    `<button type="button" class="kb-sev-btn kb-hi ${filters.severity === 'High' ? 'active' : ''}" data-sev="High"><i></i>High <b>${sev('High')}</b></button>` +
    `<button type="button" class="kb-sev-btn kb-md ${filters.severity === 'Medium' ? 'active' : ''}" data-sev="Medium"><i></i>Med <b>${sev('Medium')}</b></button>` +
    `<button type="button" class="kb-sev-btn kb-lo ${filters.severity === 'Low' ? 'active' : ''}" data-sev="Low"><i></i>Low <b>${sev('Low')}</b></button>`;

  $('kbSev').querySelectorAll('.kb-sev-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = btn.dataset.sev;
      filters.severity = filters.severity === s ? '' : s;
      renderList();
    });
  });
  $('kpiBudgetCard').classList.toggle('active', filters.status === '__outstanding' || !!filters.severity);
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
  const badge = $('filActiveBadge');
  if (badge) {
    badge.hidden = activeCount === 0;
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
  if (btn) { btn.classList.toggle('is-on', next); btn.setAttribute('aria-checked', String(next)); }
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
  if (d == null) return '<span class="age">—</span>';
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
          <p>${hasAnyFindings ? 'Try a different terminal, status, or search term.' : 'Use “+ New Finding” to add the first one.'}</p>
        </header>
      </div>
    </td></tr>`;
    updateSelectionUI();
    return;
  }
  body.innerHTML = rows.map(f => {
    const due = dueDateOf(f);
    const dueHtml = isOverdue(f)
      ? `<span class="ov-badge">${fmtDate(due)}</span>`
      : `<span class="mono" style="font-size:12px;">${fmtDate(due)}</span>`;
    const np = photoCounts[f.id] || 0;
    const photoChip = np ? `<span class="t-photos">${CAMERA_SVG}${np}</span>` : '';
    const thumb = photoThumbs[f.id];
    const thumbHtml = thumb
      ? `<img class="row-thumb" src="${esc(photoUrl(thumb.storage_path))}" alt="" loading="lazy">`
      : `<div class="row-thumb row-thumb-empty">${NO_PHOTO_SVG}<span>No Photo</span></div>`;
    const dim = (f.status === 'Repaired' || f.status === 'Closed') ? ' row-dim' : '';
    const checked = selectedIds.has(f.id) ? ' checked' : '';
    // data-state="selected" is applied by updateSelectionUI() below (also the row's live sync
    // point), not here — one place to keep new-render and post-toggle state in agreement.
    return `<tr data-id="${esc(f.id)}" class="${dim.trim()}">
      <td class="c-check"><input type="checkbox" class="row-check" data-sel="${esc(f.id)}"${checked}></td>
      <td>${pillHtml(f.status)}</td>
      <td class="c-tag">
        <div class="c-tag-flex">
          ${thumbHtml}
          <div class="c-tag-text">
            <div class="t-tag-row"><span class="t-tag" title="${esc(f.pipe_tag || f.location_desc || '')}">${esc(f.pipe_tag || f.location_desc || '—')}</span>${photoChip}</div>
            <div class="t-type" title="${esc(f.finding_type)}">${esc(f.finding_type)}</div>
            ${(f.pipe_tag && f.location_desc) ? `<div class="t-desc" title="${esc(f.location_desc)}"><span class="t-desc-label">Loc:</span> ${esc(f.location_desc)}</div>` : ''}
            ${f.description ? `<div class="t-desc" title="${esc(f.description)}"><span class="t-desc-label">Anomaly:</span> ${esc(f.description)}</div>` : ''}
          </div>
        </div>
      </td>
      <td style="font-size:12px;">${esc(f.terminal)}</td>
      <td>${ageHtml(f)}</td>
      <td><div class="due-row-flex">${dueHtml}<span class="row-arrow" title="View details">&#8594;</span></div></td>
    </tr>`;
  }).join('');
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
  const btn = $('btnExport');
  if (selectedIds.size > 0) {
    bar.hidden = false;
    $('selCount').textContent = `${selectedIds.size} selected`;
    btn.textContent = `Export (${selectedIds.size})`;
  } else {
    bar.hidden = true;
    btn.textContent = 'Export';
  }
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
  renderKpis();
  updateFilterUI();
  const rows = sortFindings(applyFilters(findings));
  renderTable(rows);
  renderMap(rows);
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

  const EXPAND_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>`;
  const COLLAPSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="10" y1="14" x2="3" y2="21"></line></svg>`;

  // Icon-only — title carries the visible tooltip/shortcut hint; aria-label carries the same text
  // as the accessible name, since title alone isn't reliably exposed to screen readers on a button
  // with no visible text content.
  btn.innerHTML = isPres ? COLLAPSE_ICON : EXPAND_ICON;
  const presLabel = isPres ? 'Exit presentation mode (ESC)' : 'Toggle full-screen presentation mode (press F)';
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
      summary.textContent = `${activePts.length} Pins • ${overduePts} Overdue`;
    }
  }

  const sel = $('presTerminalFilter');
  if (sel && isPres) sel.value = filters.terminal || '';

  // Every other view/table/register on the dashboard is still in the DOM underneath the fixed
  // overlay; without this, Tab can leave the presentation surface and land on a background
  // control the user can't see. Restored on exit so normal dashboard keyboard nav resumes.
  const dashTop = document.querySelector('.dash-top');
  const dashSplit = document.querySelector('.dash-split');
  [dashTop, dashSplit].forEach(el => {
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
      if (dashMap) dashMap.invalidateSize();
    };
    panel.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 200);
  }

  if (dashMap) {
    dashMap.invalidateSize();
    setTimeout(() => dashMap.invalidateSize(), 50);
    setTimeout(() => dashMap.invalidateSize(), 250);
  }
}

export function renderPresSidebar(rows) {
  const container = $('presSidebarList');
  const countEl = $('presSidebarCount');
  if (!container) return;

  const pts = rows.filter(f => f.lat != null && f.lng != null);
  if (countEl) countEl.textContent = `${pts.length}`;

  if (!pts.length) {
    container.innerHTML = `<div class="pres-sidebar-empty">No mapped findings in current view</div>`;
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
  sidebar.hidden = !show;
  btn?.classList.toggle('active', show);

  if (dashMap) {
    dashMap.invalidateSize();
    setTimeout(() => dashMap.invalidateSize(), 50);
    setTimeout(() => dashMap.invalidateSize(), 250);
  }
}
