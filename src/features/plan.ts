// @ts-nocheck — Phase 1 posture (see CLAUDE.md's module map) — same as the other features/*
// modules; strict typing added incrementally.
/* ============================================================================
   Inspection Plan (#/plan): the app's scheduling module.

   A PLAN is a programme header scoped by year + terminal + pipe category
   (Underground / Sub Sea / Piping — a manual per-plan attribute, since
   line_list has no category column and deliberately gains none). Under it sit
   free-text TASKS, each carrying a PLANNED month range and an ACTUAL month
   range. The Gantt draws those as two stacked bars per row: outline = the
   commitment, solid = what happened.

   Key modeling facts (confirmed against db/schema.sql section 10):
   - Months are stored as real DATEs pinned to the 1st ('2026-03-01'), not as
     int month numbers. That lets a plan span a year boundary and keeps the
     app's existing ISO-string date idiom (lexical compare, fmtDate, todayISO)
     working unchanged. <input type="month"> yields 'YYYY-MM'; monthInputToIso()
     appends '-01' on the way in, isoToMonthInput() strips it on the way out.
   - plan_task.pipe_tag is a SOFT reference — no foreign key — so re-importing
     the master line list can never break a saved plan. It may name a tag that
     no longer exists; nothing here assumes otherwise.
   - The MAINTENANCE half of the timeline is derived, never stored. Every
     finding with a due date (dueDateOf) becomes a single-month marker at that
     month, coloured by STATUS_COLORS and dashed when isOverdue(). Reusing those
     two helpers verbatim means the timeline can never disagree with the
     register about what repair work is outstanding. Repair work has no start
     date anywhere in the data, so none is invented — a maintenance bar is one
     month wide, a due-by marker rather than a fake span.
   - Both roles may read and write plans (RLS is blanket authenticated, unlike
     line_list's read-all/write-maintenance). Inspection scheduling is inspector
     work; repair scheduling/cost/closeout stays maintenance-owned on findings.

   ganttBarGeom() below is deliberately pure and exported: features/pdf.ts's
   buildPlanPdf imports it and multiplies the same fractions by a millimetre
   track width instead of 100%. One source of truth, so the printed timeline can
   never disagree with the screen.
   ============================================================================ */
import { $, esc, val, notify, openDialog, closeDialog, setBusy, todayISO, isOverdue, dueDateOf } from '../core/dom';
import { sb } from '../core/supabase';
import {
  PLAN_TASK_COLORS, PLAN_TASK_STATUS_META, STATUS_COLORS, FINDING_TYPE_SHORT,
} from '../core/constants';
import { findings, plans, setPlans, planTasks, setPlanTasks, planFilters } from '../core/state';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------------------------------------------------------------- month maths */

// Absolute month ordinal, so a range that crosses a year boundary is plain subtraction.
// Parsed off the ISO string rather than via Date to avoid any timezone shift (same reason
// core/dom.ts's todayISO() builds its string from local getters instead of toISOString()).
export function monthIndex(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})/.exec(String(iso));
  if (!m) return null;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

export function monthIndexToLabel(idx) {
  return `${MONTH_ABBR[idx % 12]} ${Math.floor(idx / 12)}`;
}

/** '2026-03' (an <input type="month"> value) -> '2026-03-01' (a storable date). */
export function monthInputToIso(v) {
  return v ? `${v}-01` : null;
}

/** '2026-03-01' -> '2026-03', for populating an <input type="month">. */
export function isoToMonthInput(v) {
  return v ? String(v).slice(0, 7) : '';
}

/**
 * Fractional position of a bar within a timeline range. Returns null when the bar has no
 * usable dates or falls entirely outside the range; clamps a partially-overlapping bar to the
 * visible window so it renders as a truncated bar rather than overflowing the track.
 *
 * Both the web renderer (x100 -> '%') and the PDF renderer (x track width -> mm) call this.
 */
export function ganttBarGeom(startISO, endISO, rangeStartIdx, monthCount) {
  let s = monthIndex(startISO);
  let e = monthIndex(endISO);
  if (s == null && e == null) return null;
  // A one-ended range is a single month, not an open-ended bar — an unset end date means
  // "we know when it starts, nothing more", which is honestly one month wide.
  if (s == null) s = e;
  if (e == null) e = s;
  if (e < s) { const t = s; s = e; e = t; }

  const rangeEndIdx = rangeStartIdx + monthCount - 1;
  if (e < rangeStartIdx || s > rangeEndIdx) return null;

  const from = Math.max(s, rangeStartIdx);
  const to = Math.min(e, rangeEndIdx);
  return {
    startFrac: (from - rangeStartIdx) / monthCount,
    widthFrac: (to - from + 1) / monthCount,
  };
}

/* ---------------------------------------------------------------- data loading */

// Two bulk queries, same shape as risk.ts's loadRiskData(): load everything, derive views
// client-side, fail soft to [] so a broken read shows an empty page rather than throwing.
// plan_task is paged in 1000-row batches — PostgREST silently caps an unlimited select() at
// 1000 rows server-side, the same trap loadLineList() works around.
export async function loadPlanData() {
  const { data: planRows, error: planErr } = await sb.from('inspection_plan')
    .select('*')
    .order('year', { ascending: false })
    .order('created_at', { ascending: false });
  setPlans(planErr ? [] : (planRows || []));

  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('plan_task')
      .select('*')
      .order('seq', { ascending: true })
      .range(from, from + 999);
    if (error) { setPlanTasks([]); return; }
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  setPlanTasks(all);
}

/* ---------------------------------------------------------------- derive */

// Years offered in the filter: every year that has a plan, plus every year a finding is DUE in,
// plus the current year. Findings matter here because the maintenance overlay exists before any
// plan does — without them, work due in a year with no plan yet would be unreachable in the UI.
export function planYears() {
  const ys = new Set(plans.map(p => p.year).filter(Boolean));
  findings.forEach(f => {
    const due = dueDateOf(f);
    const mi = monthIndex(due);
    if (mi != null) ys.add(Math.floor(mi / 12));
  });
  ys.add(new Date().getFullYear());
  return [...ys].sort((a, b) => b - a);
}

function activeYear() {
  return planFilters.year || new Date().getFullYear();
}

export function visiblePlans() {
  const q = (planFilters.q || '').toLowerCase();
  return plans.filter(p => {
    if (p.year !== activeYear()) return false;
    if (planFilters.terminal && p.terminal !== planFilters.terminal) return false;
    if (planFilters.category && p.pipe_category !== planFilters.category) return false;
    if (!q) return true;
    // A plan stays visible if it matches OR any of its tasks do, so searching a task name
    // never hides the plan it belongs to.
    if (String(p.name || '').toLowerCase().includes(q)) return true;
    return tasksOf(p.id).some(t => taskMatches(t, q));
  });
}

function taskMatches(t, q) {
  return [t.task_name, t.pipe_tag, t.assignee].some(v => String(v || '').toLowerCase().includes(q));
}

export function tasksOf(planId) {
  return planTasks
    .filter(t => t.plan_id === planId)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

export function visibleTasksOf(planId) {
  const q = (planFilters.q || '').toLowerCase();
  const rows = tasksOf(planId);
  if (!q) return rows;
  // If the plan itself matched the search, show all of its tasks rather than none.
  const plan = plans.find(p => p.id === planId);
  if (plan && String(plan.name || '').toLowerCase().includes(q)) return rows;
  return rows.filter(t => taskMatches(t, q));
}

/**
 * Findings that carry a due date, as derived maintenance rows for the timeline.
 *
 * When a range is given, rows whose due month falls outside it are dropped. That range filter is
 * not optional polish: without it a finding due Jan 2027 still produced a row while viewing 2026,
 * but ganttBarGeom correctly returned null for its bar — rendering a labelled row with a visibly
 * empty track. The KPI counts the same filtered set so the tile and the chart always agree.
 */
export function maintenanceRows(startIdx, months) {
  const q = (planFilters.q || '').toLowerCase();
  return findings
    .map(f => ({ f, due: dueDateOf(f) }))
    .filter(({ f, due }) => {
      if (!due) return false;
      if (planFilters.terminal && f.terminal !== planFilters.terminal) return false;
      const mi = monthIndex(due);
      if (mi == null) return false;
      if (startIdx != null && months != null && (mi < startIdx || mi > startIdx + months - 1)) return false;
      if (!q) return true;
      return [f.pipe_tag, f.location_desc, f.finding_type].some(v => String(v || '').toLowerCase().includes(q));
    })
    .sort((a, b) => String(a.due).localeCompare(String(b.due)));
}

function taskIsDelayed(t) {
  if (t.status === 'Done' || t.status === 'Cancelled') return false;
  if (!t.plan_end) return false;
  return String(t.plan_end) < todayISO().slice(0, 7) + '-01';
}

/* ---------------------------------------------------------------- renderers */

export function renderPlanKpis(planRows) {
  const tasks = planRows.flatMap(p => tasksOf(p.id));
  $('planKpiTotal').textContent = String(tasks.length);
  $('planKpiDone').textContent = String(tasks.filter(t => t.status === 'Done').length);
  $('planKpiProg').textContent = String(tasks.filter(t => t.status === 'In Progress').length);
  $('planKpiLate').textContent = String(tasks.filter(taskIsDelayed).length);
  // Same range as the chart draws, so the tile can never claim work the timeline doesn't show.
  const { startIdx, months } = ganttRange(planRows);
  $('planKpiDue').textContent = String(maintenanceRows(startIdx, months).length);
}

/**
 * Timeline range: the calendar year being viewed, widened to cover any task that spills outside
 * it (a Nov->Feb campaign shouldn't get silently clipped at the year edge).
 */
export function ganttRange(planRows) {
  const y = activeYear();
  let lo = y * 12;
  let hi = y * 12 + 11;
  planRows.forEach(p => tasksOf(p.id).forEach(t => {
    [t.plan_start, t.plan_end, t.actual_start, t.actual_end].forEach(d => {
      const i = monthIndex(d);
      if (i == null) return;
      if (i < lo) lo = i;
      if (i > hi) hi = i;
    });
  }));
  return { startIdx: lo, months: hi - lo + 1 };
}

function barHtml(cls, geom, color, title, extraCls) {
  if (!geom) return '';
  return `<div class="gantt-bar ${cls}${extraCls ? ' ' + extraCls : ''}"`
    + ` style="left:${(geom.startFrac * 100).toFixed(4)}%;width:${(geom.widthFrac * 100).toFixed(4)}%;--gantt-c:${color};"`
    + ` title="${esc(title)}"></div>`;
}

function nowMarkerHtml(startIdx, months) {
  const nowIdx = monthIndex(todayISO());
  if (nowIdx == null || nowIdx < startIdx || nowIdx > startIdx + months - 1) return '';
  // Mid-month, so the line reads as "we are inside this month" rather than sitting on a boundary.
  const frac = (nowIdx - startIdx + 0.5) / months;
  return `<div class="gantt-now" style="left:${(frac * 100).toFixed(4)}%;" title="Today"></div>`;
}

export function renderPlanGantt(planRows) {
  const el = $('planGantt');
  const { startIdx, months } = ganttRange(planRows);
  const show = planFilters.show || 'both';
  const showInsp = show === 'both' || show === 'inspection';
  const showMaint = show === 'both' || show === 'maintenance';
  const nowIdx = monthIndex(todayISO());

  const monthCells = Array.from({ length: months }, (_, i) => {
    const idx = startIdx + i;
    const isNow = idx === nowIdx ? ' is-now' : '';
    return `<div class="gantt-month${isNow}">${esc(monthIndexToLabel(idx).replace(' 20', " '"))}</div>`;
  }).join('');

  let body = '';

  if (showInsp) {
    planRows.forEach(p => {
      const tasks = visibleTasksOf(p.id);
      if (!tasks.length) return;
      body += `<div class="gantt-section">${esc(p.name)}${p.terminal ? ' · ' + esc(p.terminal) : ''}${p.pipe_category ? ' · ' + esc(p.pipe_category) : ''}</div>`;
      tasks.forEach(t => {
        const color = PLAN_TASK_COLORS[t.status] || '#2563eb';
        const planGeom = ganttBarGeom(t.plan_start, t.plan_end, startIdx, months);
        const actGeom = ganttBarGeom(t.actual_start, t.actual_end, startIdx, months);
        const label = t.pipe_tag ? `${t.task_name} · ${t.pipe_tag}` : t.task_name;
        body += `<div class="gantt-row">
          <div class="gantt-label" title="${esc(label)}">${esc(t.task_name)}</div>
          <div class="gantt-track" style="--gantt-months:${months};">
            ${nowMarkerHtml(startIdx, months)}
            ${barHtml('gantt-bar-plan', planGeom, color, `Planned: ${fmtRange(t.plan_start, t.plan_end)}`)}
            ${barHtml('gantt-bar-actual', actGeom, color, `Actual: ${fmtRange(t.actual_start, t.actual_end)}`)}
          </div>
        </div>`;
      });
    });
  }

  if (showMaint) {
    const maint = maintenanceRows(startIdx, months);
    if (maint.length) {
      body += `<div class="gantt-section">Maintenance — from findings' due dates</div>`;
      maint.forEach(({ f, due }) => {
        const color = STATUS_COLORS[f.status] || '#dc2626';
        const geom = ganttBarGeom(due, due, startIdx, months);
        const name = f.pipe_tag || f.location_desc || '—';
        const type = FINDING_TYPE_SHORT[f.finding_type] || f.finding_type || '';
        const od = isOverdue(f);
        body += `<div class="gantt-row">
          <div class="gantt-label" title="${esc(name + ' — ' + type)}">${esc(name)}</div>
          <div class="gantt-track" style="--gantt-months:${months};">
            ${nowMarkerHtml(startIdx, months)}
            ${barHtml('gantt-bar-maint', geom, color, `${f.status} · due ${due}${od ? ' (overdue)' : ''}`, od ? 'is-overdue' : '')}
          </div>
        </div>`;
      });
    }
  }

  if (!body) {
    el.innerHTML = '<div class="hint" style="margin:0;">Nothing scheduled for this year and filter. Use “+ New Plan” to start one.</div>';
    return;
  }

  el.innerHTML = `<div class="gantt-inner">
    <div class="gantt-row gantt-head">
      <div class="gantt-label"></div>
      <div class="gantt-months" style="--gantt-months:${months};">${monthCells}</div>
    </div>
    ${body}
    <div class="gantt-legend">
      <span class="legend-item"><span class="legend-swatch" style="background:color-mix(in oklab,#2563eb 22%,transparent);border:1px solid color-mix(in oklab,#2563eb 55%,transparent);"></span>Planned</span>
      <span class="legend-item"><span class="legend-swatch" style="background:#2563eb;"></span>Actual</span>
      <span class="legend-item"><span class="legend-swatch" style="background:color-mix(in oklab,#dc2626 30%,transparent);border:1px solid #dc2626;"></span>Maintenance due</span>
      <span class="legend-item"><span class="legend-swatch" style="background:color-mix(in oklab,#dc2626 30%,transparent);border:2px dashed #dc2626;"></span>Overdue</span>
    </div>
  </div>`;

  $('planGanttNote').textContent = `${months} months from ${monthIndexToLabel(startIdx)}`;
}

function fmtRange(a, b) {
  const si = monthIndex(a);
  const ei = monthIndex(b);
  if (si == null && ei == null) return '—';
  if (si != null && ei != null && si !== ei) return `${monthIndexToLabel(si)} – ${monthIndexToLabel(ei)}`;
  return monthIndexToLabel(si != null ? si : ei);
}

function taskPillHtml(status) {
  const m = PLAN_TASK_STATUS_META[status] || { cls: 'pt-todo' };
  return `<span class="pill ${m.cls}">${esc(status)}</span>`;
}

export function renderPlanTable(planRows) {
  const body = $('planTableBody');
  if (!planRows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="7">
      <div class="empty"><header>
        <h2>No plans for this year.</h2>
        <p>Use “+ New Plan” to create one, then add tasks to it.</p>
      </header></div></td></tr>`;
    $('planTableFoot').textContent = '';
    return;
  }

  body.innerHTML = planRows.map(p => {
    const tasks = visibleTasksOf(p.id);
    const meta = [p.terminal, p.pipe_category, p.status].filter(Boolean).join(' · ');
    const head = `<tr class="plan-row" data-plan-id="${esc(p.id)}">
      <td><span class="expand-caret">▶</span> ${esc(p.name)}<div class="plan-meta">${esc(meta)}</div></td>
      <td>—</td><td>—</td><td>—</td><td>—</td>
      <td>${esc(p.status)}</td>
      <td><button class="btn btn-xs" data-variant="outline" data-add-task="${esc(p.id)}" type="button">+ Task</button>
          <button class="btn btn-xs" data-variant="ghost" data-edit-plan="${esc(p.id)}" type="button">Edit</button></td>
    </tr>`;
    const rows = tasks.map(t => `<tr class="task-row" data-plan-key="${esc(p.id)}" data-task-id="${esc(t.id)}">
      <td class="task-name">${esc(t.task_name)}</td>
      <td>${esc(t.pipe_tag || '—')}</td>
      <td>${esc(fmtRange(t.plan_start, t.plan_end))}</td>
      <td>${esc(fmtRange(t.actual_start, t.actual_end))}</td>
      <td>${esc(t.assignee || '—')}</td>
      <td>${taskPillHtml(t.status)}${taskIsDelayed(t) ? ' <span class="ov-badge">LATE</span>' : ''}</td>
      <td><button class="btn btn-xs" data-variant="ghost" data-edit-task="${esc(t.id)}" type="button">Edit</button></td>
    </tr>`).join('');
    return head + rows;
  }).join('');

  // Rows start collapsed, then listeners are attached — same order as risk.ts's renderRiskTable.
  body.querySelectorAll('tr.task-row').forEach(n => { n.style.display = 'none'; });

  body.querySelectorAll('tr.plan-row[data-plan-id]').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const opening = !row.classList.contains('open');
      row.classList.toggle('open', opening);
      let n = row.nextElementSibling;
      while (n && n.classList.contains('task-row')) {
        n.style.display = opening ? 'table-row' : 'none';
        n = n.nextElementSibling;
      }
    });
  });

  body.querySelectorAll('[data-add-task]').forEach(b =>
    b.addEventListener('click', (e) => { e.stopPropagation(); openTaskDialog(null, b.dataset.addTask); }));
  body.querySelectorAll('[data-edit-plan]').forEach(b =>
    b.addEventListener('click', (e) => { e.stopPropagation(); openPlanDialog(plans.find(p => p.id === b.dataset.editPlan)); }));
  body.querySelectorAll('[data-edit-task]').forEach(b =>
    b.addEventListener('click', (e) => { e.stopPropagation(); openTaskDialog(planTasks.find(t => t.id === b.dataset.editTask)); }));

  const taskCount = planRows.reduce((n, p) => n + visibleTasksOf(p.id).length, 0);
  $('planTableFoot').textContent = `${planRows.length} plan${planRows.length === 1 ? '' : 's'} · ${taskCount} task${taskCount === 1 ? '' : 's'}`;
}

export function renderPlanPage() {
  syncPlanYearOptions();
  const rows = visiblePlans();
  renderPlanKpis(rows);
  renderPlanGantt(rows);
  renderPlanTable(rows);
}

function syncPlanYearOptions() {
  const sel = $('planYearFilter');
  if (!sel) return;
  const years = planYears();
  // Open on the CURRENT year when it's available, not years[0] — the list is sorted descending,
  // so a single finding due next year would otherwise make the page open on a future year and
  // look empty.
  if (!planFilters.year) {
    const thisYear = new Date().getFullYear();
    planFilters.year = years.includes(thisYear) ? thisYear : (years[0] || thisYear);
  }
  const want = years.join(',');
  if (sel.dataset.years !== want) {
    sel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
    sel.dataset.years = want;
  }
  sel.value = String(planFilters.year);
}

/* ---------------------------------------------------------------- plan CRUD */

let editingPlanId = null;

export function openPlanDialog(plan) {
  editingPlanId = plan ? plan.id : null;
  $('planDlgTitle').textContent = plan ? 'Edit inspection plan' : 'New inspection plan';
  $('planDlgName').value = plan ? (plan.name || '') : '';
  $('planDlgYear').value = plan ? plan.year : activeYear();
  $('planDlgTerminal').value = plan ? (plan.terminal || '') : (planFilters.terminal || '');
  $('planDlgCategory').value = plan ? (plan.pipe_category || '') : (planFilters.category || '');
  $('planDlgStatus').value = plan ? (plan.status || 'Draft') : 'Draft';
  $('planDlgNotes').value = plan ? (plan.notes || '') : '';
  $('errPlanDlg').textContent = '';
  $('planDlgDelete').style.display = plan ? '' : 'none';
  openDialog($('planDlg'));
}

async function savePlan() {
  const name = val('planDlgName').trim();
  const year = parseInt(val('planDlgYear'), 10);
  if (!name) { $('errPlanDlg').textContent = 'Plan name is required.'; return; }
  if (!Number.isFinite(year)) { $('errPlanDlg').textContent = 'A valid year is required.'; return; }

  const payload = {
    name,
    year,
    terminal: val('planDlgTerminal') || null,
    pipe_category: val('planDlgCategory') || null,
    status: val('planDlgStatus') || 'Draft',
    notes: val('planDlgNotes').trim() || null,
  };

  const btn = $('planDlgSave');
  setBusy(btn, true, 'Saving…');
  const q = editingPlanId
    ? sb.from('inspection_plan').update(payload).eq('id', editingPlanId)
    : sb.from('inspection_plan').insert(payload);
  const { error } = await q;
  setBusy(btn, false);

  if (error) { $('errPlanDlg').textContent = error.message; return; }
  closeDialog($('planDlg'));
  notify(editingPlanId ? 'Plan updated.' : 'Plan created.');
  await loadPlanData();
  planFilters.year = year;
  renderPlanPage();
}

async function deletePlan() {
  if (!editingPlanId) return;
  if (!window.confirm('Delete this plan and all of its tasks? This cannot be undone.')) return;
  const { error } = await sb.from('inspection_plan').delete().eq('id', editingPlanId);
  if (error) { $('errPlanDlg').textContent = error.message; return; }
  closeDialog($('planDlg'));
  notify('Plan deleted.');
  await loadPlanData();
  renderPlanPage();
}

/* ---------------------------------------------------------------- task CRUD */

let editingTaskId = null;
let editingTaskPlanId = null;

export function openTaskDialog(task, planId) {
  editingTaskId = task ? task.id : null;
  editingTaskPlanId = task ? task.plan_id : planId;
  $('taskDlgTitle').textContent = task ? 'Edit task' : 'New task';
  $('taskDlgName').value = task ? (task.task_name || '') : '';
  $('taskDlgTag').value = task ? (task.pipe_tag || '') : '';
  $('taskDlgAssignee').value = task ? (task.assignee || '') : '';
  $('taskDlgPlanStart').value = isoToMonthInput(task && task.plan_start);
  $('taskDlgPlanEnd').value = isoToMonthInput(task && task.plan_end);
  $('taskDlgActualStart').value = isoToMonthInput(task && task.actual_start);
  $('taskDlgActualEnd').value = isoToMonthInput(task && task.actual_end);
  $('taskDlgStatus').value = task ? (task.status || 'Not Started') : 'Not Started';
  $('taskDlgProgress').value = task && task.progress_pct != null ? task.progress_pct : '';
  $('taskDlgNotes').value = task ? (task.notes || '') : '';
  $('errTaskDlg').textContent = '';
  $('taskDlgDelete').style.display = task ? '' : 'none';
  fillTagDatalist();
  openDialog($('taskDlg'));
}

// Tag suggestions come from findings already recorded — plan_task.pipe_tag is a free-text soft
// reference, so this is a convenience, never a constraint.
function fillTagDatalist() {
  const dl = $('taskDlgTagList');
  if (!dl) return;
  const tags = [...new Set(findings.map(f => f.pipe_tag).filter(Boolean))].sort();
  dl.innerHTML = tags.map(t => `<option value="${esc(t)}"></option>`).join('');
}

async function saveTask() {
  const name = val('taskDlgName').trim();
  if (!name) { $('errTaskDlg').textContent = 'Task name is required.'; return; }
  if (!editingTaskPlanId) { $('errTaskDlg').textContent = 'No plan selected for this task.'; return; }

  const progRaw = val('taskDlgProgress');
  const prog = progRaw === '' ? null : Number(progRaw);
  if (prog != null && (!Number.isFinite(prog) || prog < 0 || prog > 100)) {
    $('errTaskDlg').textContent = 'Progress must be between 0 and 100.'; return;
  }

  const payload = {
    plan_id: editingTaskPlanId,
    task_name: name,
    pipe_tag: val('taskDlgTag').trim() || null,
    assignee: val('taskDlgAssignee').trim() || null,
    plan_start: monthInputToIso(val('taskDlgPlanStart')),
    plan_end: monthInputToIso(val('taskDlgPlanEnd')),
    actual_start: monthInputToIso(val('taskDlgActualStart')),
    actual_end: monthInputToIso(val('taskDlgActualEnd')),
    status: val('taskDlgStatus') || 'Not Started',
    progress_pct: prog,
    notes: val('taskDlgNotes').trim() || null,
  };
  if (!editingTaskId) payload.seq = tasksOf(editingTaskPlanId).length;

  const btn = $('taskDlgSave');
  setBusy(btn, true, 'Saving…');
  const q = editingTaskId
    ? sb.from('plan_task').update(payload).eq('id', editingTaskId)
    : sb.from('plan_task').insert(payload);
  const { error } = await q;
  setBusy(btn, false);

  if (error) { $('errTaskDlg').textContent = error.message; return; }
  closeDialog($('taskDlg'));
  notify(editingTaskId ? 'Task updated.' : 'Task added.');
  await loadPlanData();
  renderPlanPage();
}

async function deleteTask() {
  if (!editingTaskId) return;
  if (!window.confirm('Delete this task?')) return;
  const { error } = await sb.from('plan_task').delete().eq('id', editingTaskId);
  if (error) { $('errTaskDlg').textContent = error.message; return; }
  closeDialog($('taskDlg'));
  notify('Task deleted.');
  await loadPlanData();
  renderPlanPage();
}

/* ---------------------------------------------------------------- PDF */

async function exportPlanPdf() {
  const rows = visiblePlans();
  if (!rows.length) { notify('Nothing to export for this year and filter.', true); return; }
  const btn = $('btnPlanPdf');
  setBusy(btn, true, 'Building…');
  try {
    const { buildPlanPdf } = await import('./pdf');
    const { startIdx, months } = ganttRange(rows);
    await buildPlanPdf({
      plans: rows,
      tasksOf: (id) => visibleTasksOf(id),
      maintenance: (planFilters.show === 'inspection') ? [] : maintenanceRows(startIdx, months),
      startIdx,
      months,
      year: activeYear(),
      filters: { terminal: planFilters.terminal, category: planFilters.category },
    });
  } catch (e) {
    notify('Could not build the PDF: ' + (e && e.message ? e.message : e), true);
  } finally {
    setBusy(btn, false);
  }
}

/* ---------------------------------------------------------------- init */

export function initPlanPage() {
  $('planYearFilter')?.addEventListener('change', (e) => { planFilters.year = parseInt(e.target.value, 10); renderPlanPage(); });
  $('planTerminalFilter')?.addEventListener('change', (e) => { planFilters.terminal = e.target.value; renderPlanPage(); });
  $('planCategoryFilter')?.addEventListener('change', (e) => { planFilters.category = e.target.value; renderPlanPage(); });
  $('planShowFilter')?.addEventListener('change', (e) => { planFilters.show = e.target.value; renderPlanPage(); });
  $('planSearch')?.addEventListener('input', (e) => { planFilters.q = e.target.value; renderPlanPage(); });

  $('btnNewPlan')?.addEventListener('click', () => openPlanDialog(null));
  $('btnPlanPdf')?.addEventListener('click', exportPlanPdf);

  $('planDlgSave')?.addEventListener('click', savePlan);
  $('planDlgDelete')?.addEventListener('click', deletePlan);
  $('planDlgCancel')?.addEventListener('click', () => closeDialog($('planDlg')));

  $('taskDlgSave')?.addEventListener('click', saveTask);
  $('taskDlgDelete')?.addEventListener('click', deleteTask);
  $('taskDlgCancel')?.addEventListener('click', () => closeDialog($('taskDlg')));
}
