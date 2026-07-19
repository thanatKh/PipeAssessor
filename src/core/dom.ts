/* ============================================================================
   Shared DOM / UI helpers (element lookup, dialogs, toast, formatting, overdue
   logic, status pill). Leaf module — depends only on constants + engine formatters.
   $ returns any so callers can read .value/.style without per-call null handling.
   ============================================================================ */
import { STATUS_META } from './constants';
import { paFmtDate, paFmtDateTime } from '../engine/format';

export const $ = (id: any): any => document.getElementById(id);
export const val = (id) => $(id).value;

// Wraps native <dialog> showModal()/close() with the transitions.dev modal open/close
// animation (see the dialog.app-dlg/#lightbox CSS above) — .is-open drives the scale+fade
// in, .is-closing plays a quicker scale-down before the dialog actually closes so it never
// just vanishes.
// Slides a .seg-row's pill under whichever .seg-btn is currently .active. animate=false
// (first paint, resize, or a freshly-rendered segmented control e.g. #aModeSeg/#qModeSeg)
// suspends the transition so the pill snaps into place instead of sliding in from
// translateX(0)/width:0.
export function positionSegPill(segRow, animate) {
  const pill = segRow.querySelector('.seg-pill');
  const active = segRow.querySelector('.seg-btn.active');
  if (!pill || !active) return;
  if (!animate) {
    const prev = pill.style.transition;
    pill.style.transition = 'none';
    pill.style.transform = `translateX(${active.offsetLeft - segRow.clientLeft}px)`;
    pill.style.width = `${active.offsetWidth}px`;
    void pill.offsetWidth;
    pill.style.transition = prev;
  } else {
    pill.style.transform = `translateX(${active.offsetLeft - segRow.clientLeft}px)`;
    pill.style.width = `${active.offsetWidth}px`;
  }
}

export function openDialog(el) {
  el.showModal();
  el.classList.remove('is-closing');
  void el.offsetWidth; // reflow so the open transition always replays from --modal-scale
  el.classList.add('is-open');
}
export function closeDialog(el) {
  const closeMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--modal-close-dur')) || 150;
  el.classList.remove('is-open');
  el.classList.add('is-closing');
  setTimeout(() => { el.classList.remove('is-closing'); el.close(); }, closeMs);
}

// Native <details> removes its content the instant [open] is toggled off, which would skip
// the collapse animation entirely (the grid-rows/opacity/blur transitions in theme.css's
// accordion-expand block only play while [open] is still present). Intercept the summary
// click, keep `open` set for one more frame, and let it fall away only after the collapse
// transition has had time to run. Opening needs no interception — the browser adds `open`
// immediately and the CSS transitions in from grid-template-rows: 0fr on its own.
document.addEventListener('click', (e) => {
  const summary = (e.target as any).closest('summary.panel-collapse');
  if (!summary) return;
  const details = summary.closest('details.panel');
  if (!details || !details.open) return; // opening — let the browser handle it natively
  e.preventDefault();
  const collapseMs = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--acc-collapse')) || 250;
  // `open` stays set through the whole animation (removing it early would instantly hide the
  // content) — .is-closing is what actually drives the grid-rows back to 0fr (see theme.css's
  // `details.panel.is-closing > .panel-b-track` override). Only strip `open` once the CSS
  // transition has had time to finish, which is what actually collapses the details element.
  details.classList.add('is-closing');
  setTimeout(() => { details.removeAttribute('open'); details.classList.remove('is-closing'); }, collapseMs);
});

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const fmtDate = paFmtDate; // shared "dd Mmm yyyy" helper (src/legacy/shared.js)
export const fmtDateTime = paFmtDateTime; // shared "dd Mmm yyyy HH:mm" (24-hour) helper (src/legacy/shared.js)

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isOverdue(f) {
  const today = todayISO();
  if ((f.status === 'Open' || f.status === 'Repair Planned') && f.target_date && f.target_date < today) return true;
  if (f.status === 'Monitoring' && f.next_check_date && f.next_check_date < today) return true;
  return false;
}

export function dueDateOf(f) {
  if (f.status === 'Monitoring') return f.next_check_date;
  if (f.status === 'Open' || f.status === 'Repair Planned') return f.target_date;
  return null;
}

export function pillHtml(status) {
  const m = STATUS_META[status] || { cls: 'st-closed' };
  return `<span class="pill ${m.cls}">${esc(status)}</span>`;
}

let toastTimer: any = null;
export function notify(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2800);
}

export function setBusy(btn, busy, busyText) {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = busyText || 'Working…';
    btn.disabled = true;
  } else {
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
    btn.disabled = false;
  }
}

// downscaleImage() lives in src/legacy/shared.js

/* ---------------- auth ---------------- */
