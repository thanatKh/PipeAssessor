// @ts-nocheck — Phase 1: ported 1:1 from the app monolith, verified behaviorally (engine
// parity + Playwright), not via types yet. Same posture as app.ts; strict typing added
// incrementally per module.
/* ============================================================================
   PDF report builders: the unified finding PDF (buildFindingPdf) and the
   management-summary PDF (buildSummaryPdf), plus their shared image-loading
   helpers and the export dialog. jsPDF/jspdf-autotable/xlsx (via exportCsv)
   are dynamic-imported at their call sites — never in the eager entry chunk.
   Extracted from the app monolith.
   ============================================================================ */
import { $, val, esc, notify, todayISO, isOverdue, dueDateOf, openDialog, closeDialog, setBusy, fmtDate, fmtDateTime } from '../core/dom';
import { STATUS_COLORS, R2_UPLOAD_ENDPOINT, PUBLIC_BASE_URL, PLAN_TASK_COLORS } from '../core/constants';
import { computeB313, PA_PIPE_DATABASE } from '../engine/compute';
import { paFmtDate, paFmtDateTime } from '../engine/format';
import { OR_LOGO_DATAURL } from '../engine/branding';
import { registerGoogleSansFonts } from '../engine/fonts';
import { PA_SCOPE_TEXT, paCrossSectionPng, resolveIntegrityBanner } from '../workbench/assess-view';
import { resolveAdvisor } from '../workbench/repair-advisor';
import { tempRepairRows, tempRepairHeadline, tempRepairResultColor } from '../workbench/temp-repair';
import {
  findings, filters, selectedIds, current, currentPhotos, currentHistory, currentAssessments,
  currentTempRepair, photoThumbs,
} from '../core/state';
import { applyFilters, sortFindings, ageDays, photoUrl } from './dashboard';
import { resFromSnapshot, erfNo, materialName, fmtN } from './detail';
import { exportCsv } from './import-export';
import { sb } from '../core/supabase';

export const PDF_NAVY = '#156B95'; // matches --header-accent / --button-primary exactly
export const PDF_TEXT = '#0f172a';
export const PDF_MUTED = '#64748b';
export const PDF_BORDER = '#cbd5e1';
/* Semantic status colors — match :root's light-mode --ok/--warn/--danger tokens exactly (the
   report always renders in the fixed light palette regardless of app theme). Named constants,
   never re-typed hex per call site — same rule as the old calculator report. */
export const PDF_OK = '#059669';
export const PDF_WARN = '#d97706';
export const PDF_WARN_DARK = '#92400e';   // --warn-text — the CS-reference caveat note
export const PDF_WARN_MID = '#b45309';    // warn accent — the bold FFS recommendation
export const PDF_DANGER = '#dc2626';
export const PDF_NAVY_TINT = '#eef4f8'; // very light navy wash for title-block / section accents
export const PDF_PANEL = '#f1f5f9';     // neutral panel fill (title-block header strips, labels)

/* Slugify a tag/location into a DOC REF suffix (PA-RPT-<slug>). Disallowed characters are DROPPED,
   not replaced with '_' — a naive replace turns e.g. 906100-8"-D3101-N into 906100-8_-D3101-N (a
   stray underscore from the inch-mark). Dropping keeps 906100-8-D3101-N clean; repeated/edge
   separators are then collapsed/trimmed so the result never doubles or starts/ends on a dash. */
function docRefSlug(s) {
  return String(s || '')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function fetchAsDataUrl(url, timeoutMs = 8000) {
  if (!url) return null;
  if (url.startsWith('data:')) return url;

  // Primary method: fetch blob -> FileReader
  const fetchPromise = (async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('http ' + r.status);
      const blob = await r.blob();
      return await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
    } catch (_) { return null; }
  })();

  // Fallback method: HTML Image + Canvas drawing
  const canvasPromise = (async () => {
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch (_) { return null; }
  })();

  const res = await Promise.race([fetchPromise, new Promise(r => setTimeout(() => r(null), timeoutMs))]);
  if (res) return res;
  return await Promise.race([canvasPromise, new Promise(r => setTimeout(() => r(null), timeoutMs))]);
}

export function loadImg(src) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
}

/* Deterministic satellite figure from clean Esri tiles ({z}/{y}/{x} axis order) with a
   centre pin + required attribution. Resolves null on any failure so the PDF degrades
   to coordinates-as-text and never hangs. */
export async function composeMapPng(lat, lng, zoom, W, H) {
  try {
    const job = (async () => {
      const n = Math.pow(2, zoom);
      const latR = lat * Math.PI / 180;
      const cx = ((lng + 180) / 360) * n * 256;
      const cy = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n * 256;
      const left = cx - W / 2, top = cy - H / 2;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const jobs = [];
      for (let tx = Math.floor(left / 256); tx <= Math.floor((left + W) / 256); tx++) {
        for (let ty = Math.floor(top / 256); ty <= Math.floor((top + H) / 256); ty++) {
          jobs.push(new Promise((res, rej) => {
            const im = new Image();
            im.crossOrigin = 'anonymous'; // Esri sends ACAO — canvas stays exportable
            im.onload = () => { g.drawImage(im, tx * 256 - left, ty * 256 - top); res(); };
            im.onerror = rej;
            im.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty}/${tx}`;
          }));
        }
      }
      await Promise.all(jobs);
      g.beginPath();
      g.arc(W / 2, H / 2, 10, 0, Math.PI * 2);
      g.fillStyle = '#dc2626'; g.fill();
      g.lineWidth = 3; g.strokeStyle = '#ffffff'; g.stroke();
      g.font = '11px Arial';
      const attr = 'Imagery (c) Esri, Maxar, Earthstar Geographics';
      const tw = g.measureText(attr).width;
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.fillRect(W - tw - 10, H - 18, tw + 10, 18);
      g.fillStyle = '#334155';
      g.fillText(attr, W - tw - 5, H - 5);
      return c.toDataURL('image/jpeg', 0.85);
    })();
    return await Promise.race([job, new Promise(res => setTimeout(() => res(null), 7000))]);
  } catch (e) { return null; }
}

async function cropToUniformAspect(img: HTMLImageElement, targetAspect = 4 / 3): Promise<{ src: string; w: number; h: number }> {
  try {
    const canvas = document.createElement('canvas');
    let sw = img.naturalWidth;
    let sh = img.naturalHeight;
    const currentAspect = sw / sh;
    let sx = 0, sy = 0;

    if (currentAspect > targetAspect) {
      sw = sh * targetAspect;
      sx = (img.naturalWidth - sw) / 2;
    } else {
      sh = sw / targetAspect;
      sy = (img.naturalHeight - sh) / 2;
    }

    canvas.width = 1200;
    canvas.height = 900;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { src: img.src, w: img.naturalWidth, h: img.naturalHeight };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 1200, 900);
    return { src: canvas.toDataURL('image/jpeg', 0.92), w: 1200, h: 900 };
  } catch (_) {
    return { src: img.src, w: img.naturalWidth, h: img.naturalHeight };
  }
}

/* ---------------- shared ASME B31.3 result rendering (buildFindingPdf + buildQuickCalcPdf) ----------------
   Pure functions of a computeB313 result r — no jsPDF page-position state — so both PDF builders
   substitute the exact same numbers into the exact same table rows/equations. Only the
   position/pagination logic (ensure/section/y bookkeeping) differs between the two reports, since
   a finding report has many more sections around this one. */

// segs: plain strings drawn on the baseline; { num, den } drawn as a stacked fraction. Returns the
// vertical space consumed so the caller can advance y.
export function drawFractionRow(doc, segs, x0, yTop, opts2) {
  const fs = (opts2 && opts2.fontSize) || 8;
  const font = (opts2 && opts2.font) || 'courier';
  const hasFraction = segs.some(s => typeof s !== 'string');
  const numOffset = 3.4, barOffset = 4.6, denOffset = 8.4;
  const flatBaseline = yTop + 3;
  const barBaseline = yTop + barOffset;
  let x = x0;
  segs.forEach(seg => {
    doc.setFont(font, 'normal'); doc.setFontSize(fs); doc.setTextColor(PDF_TEXT);
    if (typeof seg === 'string') {
      doc.text(seg, x, hasFraction ? barBaseline : flatBaseline);
      x += doc.getTextWidth(seg);
    } else {
      const numW = doc.getTextWidth(seg.num);
      const denW = doc.getTextWidth(seg.den);
      const w = Math.max(numW, denW) + 2;
      doc.text(seg.num, x + w / 2, yTop + numOffset, { align: 'center' });
      doc.setDrawColor(PDF_TEXT); doc.setLineWidth(0.25);
      doc.line(x, yTop + barOffset, x + w, yTop + barOffset);
      doc.text(seg.den, x + w / 2, yTop + denOffset, { align: 'center' });
      x += w;
    }
  });
  doc.setTextColor(PDF_TEXT);
  return hasFraction ? denOffset + 2 : 6;
}

export function fractionRowHeight(rw) {
  return 4 + (rw.segs.some(s => typeof s !== 'string') ? 12.4 : 6) + 3;
}

// Governing-equations rows (label, standard reference, drawFractionRow segs) — same substituted
// numbers as the on-screen workbench's equation panel.
export function buildEquationRows(r) {
  const erf_no = r.mawp_no > 0 ? (r.P_input / r.mawp_no) : 9.99;
  const erf_with = r.mawp_with == null ? null : (r.mawp_with > 0 ? (r.P_input / r.mawp_with) : 9.99);
  const t_use_with = Math.max(0, r.t_meas - r.ca);
  const eqRows = [
    {
      label: 't_req = P · D / (2 · (S · E · W + P · Y))', ref: '[B31.3 304.1.2]',
      segs: ['t_req = ', { num: `${fmtN(r.P, 4)} · ${fmtN(r.D, 2)}`, den: `2(${fmtN(r.S, 1)}·${fmtN(r.E, 2)}·${fmtN(r.W, 2)} + ${fmtN(r.P, 4)}·${fmtN(r.Y, 2)})` }, ` = ${fmtN(r.t_req_noCA, 3)} mm`],
    },
    {
      label: 't_req_total = t_req + CA', ref: '',
      segs: [`t_req_total = ${fmtN(r.t_req_noCA, 3)} + ${fmtN(r.ca, 2)} = ${fmtN(r.t_req_total, 3)} mm`],
    },
    {
      label: 'MAWP (no CA, current) = 2 · S · E · W · t_meas / (D - 2 · Y · t_meas)', ref: '[B31.3 304.1.2]',
      segs: ['MAWP = ', { num: `2 · ${fmtN(r.S, 1)}·${fmtN(r.E, 2)}·${fmtN(r.W, 2)}·${fmtN(r.t_meas, 2)}`, den: `${fmtN(r.D, 2)} - 2·${fmtN(r.Y, 2)}·${fmtN(r.t_meas, 2)}` }, ` = ${fmtN(r.mawp_no, 2)} ${r.pUnit}`],
    },
    {
      label: 'ERF (no CA, current) = P / MAWP', ref: '',
      segs: ['ERF = ', { num: `${fmtN(r.P_input, 2)}`, den: `${fmtN(r.mawp_no, 2)}` }, ` = ${fmtN(erf_no, 3)}`],
    },
    {
      label: 'MAWP (with CA reserved) = 2 · S · E · W · t / (D - 2 · Y · t),  t = max(0, t_meas - CA)', ref: '',
      segs: [`t = ${fmtN(t_use_with, 2)} mm,  MAWP = `, { num: `2 · ${fmtN(r.S, 1)}·${fmtN(r.E, 2)}·${fmtN(r.W, 2)}·${fmtN(t_use_with, 2)}`, den: `${fmtN(r.D, 2)} - 2·${fmtN(r.Y, 2)}·${fmtN(t_use_with, 2)}` }, ` = ${fmtN(r.mawp_with, 2)} ${r.pUnit}`],
    },
    {
      label: 'ERF (with CA reserved) = P / MAWP', ref: '',
      segs: ['ERF = ', { num: `${fmtN(r.P_input, 2)}`, den: `${fmtN(r.mawp_with, 2)}` }, ` = ${fmtN(erf_with, 3)}`],
    },
  ];
  if (r.CR > 0 && r.remainingLife !== null) {
    eqRows.push({
      label: 'Remaining life = (t_meas - t_req_total) / CR', ref: '',
      segs: ['Life = ', { num: `${fmtN(r.t_meas, 2)} - ${fmtN(r.t_req_total, 3)}`, den: `${fmtN(r.CR, 3)}` }, ` = ${fmtN(r.remainingLife, 2)} years`],
    });
  }
  return eqRows;
}

// Calculation Results autotable body — THICKNESS / PRESSURE & ERF / REMAINING LIFE sections with
// PASS/CHECK verdicts, identical rows/criteria used by both PDF reports.
export function buildResultsTableBody(r) {
  const erf_no = r.mawp_no > 0 ? (r.P_input / r.mawp_no) : 9.99;
  const erf_with = r.mawp_with == null ? null : (r.mawp_with > 0 ? (r.P_input / r.mawp_with) : 9.99);
  const life = r.remainingLife !== null ? (r.remainingLife >= 0 ? `${fmtN(r.remainingLife, 2)} years` : '0.00 years (exceeded)') : '—';
  return [
    [{ content: 'THICKNESS', colSpan: 4, styles: { fillColor: '#e2e8f0', fontStyle: 'bold', fontSize: 7 } }],
    ['Nominal wall thickness t_nom', `${fmtN(r.t_nom, 2)} mm`, '—', ''],
    ['Remaining wall percentage', `${fmtN(r.pctRemainNom, 1)} %`, '>= 50 %', r.pctRemainNom >= 50 ? 'PASS' : 'CHECK'],
    ['Required thickness t_req', `${fmtN(r.t_req_noCA, 3)} mm`, '—', ''],
    ['Required incl. CA (t_req + CA)', `${fmtN(r.t_req_total, 3)} mm`, 't_meas >= t_req + CA', r.margin >= 0 ? 'PASS' : 'CHECK'],
    [`API 574 structural min t_struct${r.isCsRef ? ' *' : ''}`, `${fmtN(r.t_struct, 2)} mm`, 't_meas >= t_struct', r.t_meas >= r.t_struct ? 'PASS' : 'CHECK'],
    ['Remaining margin', `${fmtN(r.margin, 3)} mm`, '>= 0', r.margin >= 0 ? 'PASS' : 'CHECK'],
    [{ content: 'PRESSURE & ERF', colSpan: 4, styles: { fillColor: '#e2e8f0', fontStyle: 'bold', fontSize: 7 } }],
    ['Design pressure P', `${fmtN(r.P_input, 2)} ${r.pUnit}`, '—', ''],
    ['MAWP (no CA — current)', `${fmtN(r.mawp_no, 2)} ${r.pUnit}`, '>= P', r.mawp_no >= r.P_input ? 'PASS' : 'CHECK'],
    ['ERF (no CA — current)', fmtN(erf_no, 3), '<= 1.0', erf_no <= 1.0 ? 'PASS' : 'CHECK'],
    ['MAWP (with CA reserved)', r.mawp_with == null ? 'n/a — wall below CA' : `${fmtN(r.mawp_with, 2)} ${r.pUnit}`, '>= P', r.mawp_with == null ? '—' : (r.mawp_with >= r.P_input ? 'PASS' : 'CHECK')],
    ['ERF (with CA reserved)', erf_with == null ? 'n/a' : fmtN(erf_with, 3), '<= 1.0', erf_with == null ? '—' : (erf_with <= 1.0 ? 'PASS' : 'CHECK')],
    [{ content: 'REMAINING LIFE', colSpan: 4, styles: { fillColor: '#e2e8f0', fontStyle: 'bold', fontSize: 7 } }],
    ['Corrosion allowance CA', `${fmtN(r.ca, 2)} mm`, '—', ''],
    ['Corrosion rate CR', r.CR > 0 ? `${fmtN(r.CR, 3)} mm/yr` : '—', '—', ''],
    ['Estimated remaining life', life, '—', ''],
  ];
}

export function resultsTableDidParseCell(data) {
  if (data.section === 'body' && data.column.index === 3) {
    if (data.cell.raw === 'PASS') {
      data.cell.styles.fillColor = '#dcfce7';
      data.cell.styles.textColor = '#15803d';
      data.cell.styles.fontStyle = 'bold';
    } else if (data.cell.raw === 'CHECK') {
      data.cell.styles.fillColor = '#fee2e2';
      data.cell.styles.textColor = '#b91c1c';
      data.cell.styles.fontStyle = 'bold';
    }
  }
}

/* Numbered section header shared by buildFindingPdf + buildQuickCalcPdf so both reports read as one
   document family — a solid navy number chip, a navy title, and a full-width navy rule beneath.
   This replaced the old flat "navy uppercase text + hairline" heading (which read as a generic word
   processor template) with a structured, numbered engineering-document heading. Pure of page-state:
   the caller owns y-advance + the ensure() that keeps a heading from being orphaned at a page foot.
   Returns the vertical space the header occupies. */
export function drawSectionHeader(doc, num, title, x, y, right) {
  const chip = 5.6;
  doc.setFillColor(PDF_NAVY);
  doc.roundedRect(x, y, chip, chip, 0.9, 0.9, 'F');
  doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8); doc.setTextColor('#ffffff');
  doc.text(String(num), x + chip / 2, y + chip / 2 + 1.35, { align: 'center' });
  doc.setFont('GoogleSans', 'bold'); doc.setFontSize(9.5); doc.setTextColor(PDF_NAVY);
  doc.text(String(title).toUpperCase(), x + chip + 3, y + 4.35);
  doc.setDrawColor(PDF_NAVY); doc.setLineWidth(0.5);
  doc.line(x, y + chip + 1.9, right, y + chip + 1.9);
  doc.setTextColor(PDF_TEXT);
  return chip + 5.6; // total header block height (caller advances y by this)
}

export async function buildFindingPdf() {
  const f = current;
  const { jsPDF } = await import('jspdf'); const { default: autoTable } = await import('jspdf-autotable');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await registerGoogleSansFonts(doc); // loads Sarabun (Latin + Thai in one face) under the 'GoogleSans' jsPDF font name — use doc.setFont('GoogleSans', ...) below
  const PW = 210, PH = 297, M = 14, CW = PW - 2 * M;
  const HEADER_H = 18, FOOTER_H = 16;
  let y = 0, secNum = 0, figNum = 0;

  // Type scale — consolidated from 11 ad hoc literals (5.7/6.5/6.8/7/7.5/8/8.5/11/13/13.5/15) down
  // to named roles. tbCell's per-cell `opts.fs` overrides (8.5/8/9.5/9/7.5) are left as-is — they're
  // deliberately tuned per grid cell to fit that cell's own content width (short "Severity" gets a
  // bigger size, longer "Finding Type" gets a smaller one), not meaningless near-duplicates.
  const FS_MICRO = 5.7;    // smallest — tbCell uppercase eyebrow labels, OVERDUE tag
  const FS_FOOTER_MICRO = 6.5; // footer division-attribution line, record footnote
  const FS_CAPTION = 7;    // italic footnote captions — figure captions, standards-note footer
  const FS_LABEL = 7.5;    // header/footer meta text, muted italic footnotes, bold caveats, eq. row labels
  const FS_BODY = 8;       // body text — row() labels, table text, descriptions, banner-callout copy
  const FS_VALUE = 8.5;    // emphasized body — row() values, banner titles, equation fraction digits
  const FS_TITLE = 11;     // header report title, health-banner ERF metric
  const FS_SUB = 13;       // assessment "INTEGRITY STATUS:" headline
  const FS_HERO = 13.5;    // top-of-report health banner hero word
  const FS_LOGO = 15;      // logo-fallback "OR" lettering

  // preload images (each degrades independently). Logo is the embedded base64 from shared.js
  // (offline-safe — same source as the calculator report), with a file fetch as a fallback.
  const logo = (typeof OR_LOGO_DATAURL !== 'undefined' && OR_LOGO_DATAURL) || await fetchAsDataUrl('/RGB_OR_Full color.png', 3000);
  const logoIm = logo ? await loadImg(logo) : null;
  const mapImg = (f.lat != null && f.lng != null) ? await composeMapPng(f.lat, f.lng, 17, 1000, 500) : null;
  // latest assessment re-computed from its saved inputs (single engine source) + its cross-section
  const assess = currentAssessments.length ? currentAssessments[0] : null;
  const assessRes = assess ? resFromSnapshot(assess) : null;
  const xsecPng = assessRes ? await paCrossSectionPng(assessRes, 2).catch(() => null) : null;
  // Emergency stop-leak record, or null. loadDetail already fetched it, so nothing extra is
  // requested here — and with no record the whole Temporary Repair section below is skipped.
  const tempRepair = currentTempRepair || null;

  // QR code → the read-only public share page for this finding (no sign-in). Lazy-imported so
  // qrcode stays out of the entry bundle; degrades to no-QR on any failure.
  const shareUrl = `${PUBLIC_BASE_URL}/#/s/${f.id}`;
  let qrDataUrl = null;
  try {
    const QR = (await import('qrcode')).default;
    qrDataUrl = await QR.toDataURL(shareUrl, { margin: 1, width: 240, errorCorrectionLevel: 'M', color: { dark: '#0f172aff', light: '#ffffffff' } });
  } catch (_) { qrDataUrl = null; }

  // Fetch photos if currentPhotos is unpopulated
  let photos = currentPhotos || [];
  if ((!photos || !photos.length) && f && f.id) {
    const { data: phData } = await sb.from('finding_photos')
      .select('*')
      .eq('finding_id', f.id)
      .order('created_at', { ascending: true });
    if (phData && phData.length) photos = phData;
  }

  const photoData = [];
  for (const p of photos) {
    const pPath = p.storage_path || p.path;
    if (!pPath) continue;
    const isFullUrl = pPath.startsWith('http://') || pPath.startsWith('https://') || pPath.startsWith('data:');
    let d = null;
    if (isFullUrl) {
      d = await fetchAsDataUrl(pPath, 8000);
    } else {
      const primaryUrl = `${R2_UPLOAD_ENDPOINT}/photo?path=${encodeURIComponent(pPath)}`;
      const fallbackUrl = photoUrl(pPath);
      d = await fetchAsDataUrl(primaryUrl, 8000);
      if (!d) d = await fetchAsDataUrl(fallbackUrl, 5000);
    }
    if (!d) continue;
    const im = await loadImg(d);
    if (im && im.naturalWidth > 0 && im.naturalHeight > 0) {
      const cropped = await cropToUniformAspect(im, 4 / 3);
      photoData.push({ kind: (p.kind || 'found').toLowerCase().trim(), src: cropped.src, w: cropped.w, h: cropped.h });
    }
  }

  const now = new Date();

  // Header/footer chrome mirrors calculator.html's buildPdfReport so both reports read as one
  // family: full-color OR logo left, navy title right, navy rule beneath; hairline footer with
  // page x/y, generation stamp, and the division attribution.
  function chrome() {
    if (logoIm) {
      const lw = 26, lh = 26 * logoIm.naturalHeight / logoIm.naturalWidth;
      try { doc.addImage(logo, 'PNG', M, 3, lw, lh); }
      catch (_) { doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LOGO); doc.setTextColor(PDF_NAVY); doc.text('OR', M, 12); }
    } else {
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LOGO); doc.setTextColor(PDF_NAVY);
      doc.text('OR', M, 12);
    }
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_TITLE); doc.setTextColor(PDF_NAVY);
    doc.text('PIPING ABNORMAL FINDING REPORT', PW - M, 8.5, { align: 'right' });
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_LABEL); doc.setTextColor('#64748b');
    const tagRef = docRefSlug(f.pipe_tag || f.location_desc || f.id.slice(0, 8));
    doc.text(`DOC REF: PA-RPT-${tagRef}-${paFmtDate(now).replace(/\s+/g, '')}`, PW - M, 13.5, { align: 'right' });
    doc.setDrawColor(PDF_NAVY); doc.setLineWidth(0.8);
    doc.line(M, HEADER_H - 1, PW - M, HEADER_H - 1);

    doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
    doc.line(M, PH - FOOTER_H, PW - M, PH - FOOTER_H);
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_LABEL); doc.setTextColor('#64748b');
    doc.text('Piping integrity — abnormal finding record', M, PH - FOOTER_H + 4);
    doc.text(`Page ${doc.internal.getNumberOfPages()} of {tp}`, PW / 2, PH - FOOTER_H + 4, { align: 'center' });
    doc.text(`Generated ${paFmtDateTime(now)}`, PW - M, PH - FOOTER_H + 4, { align: 'right' });
    doc.setFontSize(FS_FOOTER_MICRO); doc.setTextColor('#94a3b8');
    doc.text(['Central and Eastern Engineering and Maintenance Division', 'PTT Oil and Retail Business Public Company Limited'], PW / 2, PH - FOOTER_H + 9, { align: 'center', lineHeightFactor: 1.35 });
    doc.setTextColor(PDF_TEXT);
    y = HEADER_H + 4;
  }

  function ensure(h) {
    if (y + h > PH - FOOTER_H - 4) { doc.addPage(); chrome(); }
  }

  // Orphan control: reserve the header + at least `minBodyHeight` of body so a heading never lands
  // alone at a page foot with its content pushed to the next page.
  function section(t, minBodyHeight = 20) {
    ensure(11.2 + minBodyHeight);
    secNum++;
    y += drawSectionHeader(doc, secNum, t, M, y, PW - M);
  }

  function row(label, value) {
    const v = (value == null || value === '') ? '—' : String(value);
    const lines = doc.splitTextToSize(v, CW - 48);
    const h = Math.max(6, lines.length * 4 + 2);
    ensure(h);
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_MUTED);
    doc.text(label, M, y + 3.5);
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_VALUE); doc.setTextColor(PDF_TEXT);
    doc.text(lines, M + 48, y + 3.5);
    doc.setDrawColor('#e2e8f0'); doc.setLineWidth(0.15);
    doc.line(M, y + h, PW - M, y + h);
    y += h;
  }

  chrome();

  // --- Summary block: a color-filled "integrity health" banner (the at-a-glance hero — a quick
  // reviewer reads healthy/unhealthy from the band color + plain-language line before any detail)
  // over a neutral identity grid. The band reflects the ENGINEERING health (ASME B31.3 verdict /
  // leaking), which is what "positive vs. negative" means here; workflow (Finding Status/Overdue)
  // stays in the grid below. Band fills are 700-tier shades so white text clears WCAG on all. ---
  const stColor = STATUS_COLORS[f.status] || PDF_MUTED;
  const reportRef = `PA-RPT-${docRefSlug(f.pipe_tag || f.location_desc || f.id.slice(0, 8))}`;
  const hb = resolveIntegrityBanner(f, assessRes); // shared with the web detail page's banner

  const bandH = 15, tbRowH = 10.5;
  ensure(bandH + 3 + Math.max(tbRowH * 2, 28) + 7);

  // health banner
  doc.setFillColor(hb.fill);
  doc.rect(M, y, CW, bandH, 'F');
  doc.setFillColor(hb.spine);
  doc.rect(M, y, 2.4, bandH, 'F'); // darker spine for depth
  doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_HERO); doc.setTextColor('#ffffff');
  doc.text(hb.word, M + 6, y + 7);
  doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_VALUE); doc.setTextColor('#f1f5f9');
  doc.text(doc.splitTextToSize(hb.line, CW - 62)[0], M + 6, y + 12);
  if (hb.metrics) {
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_TITLE); doc.setTextColor('#ffffff');
    doc.text(`ERF ${hb.metrics.erf}`, PW - M - 5, y + 6.8, { align: 'right' });
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_LABEL); doc.setTextColor('#f1f5f9');
    doc.text(`MAWP ${hb.metrics.mawp}  ·  ${hb.metrics.pct}% wall`, PW - M - 5, y + 11.5, { align: 'right' });
  }
  y += bandH + 3;

  // identity grid on the left; QR share code on the right (when generated). The QR opens the
  // read-only public finding page (no sign-in) — scannable from paper and tappable in a viewer.
  const qrShown = !!qrDataUrl;
  const qrZoneW = qrShown ? 34 : 0;
  const qrGap = qrShown ? 5 : 0;
  const gridW = CW - qrZoneW - qrGap;
  const tbCol = gridW / 4;

  // neutral identity grid
  const tbCell = (cx, cw, ry, label, value, opts) => {
    opts = opts || {};
    doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
    doc.rect(cx, ry, cw, tbRowH);
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_MICRO); doc.setTextColor(PDF_MUTED);
    doc.text(label.toUpperCase(), cx + 2.4, ry + 3.3);
    let vx = cx + 2.4;
    if (opts.swatch) {
      doc.setFillColor(opts.swatch);
      doc.circle(cx + 3.5, ry + tbRowH - 3.0, 1.35, 'F');
      vx = cx + 6.6;
    }
    // opts.fs is a deliberate per-cell override (tuned to each cell's own content width — e.g. the
    // short "Severity" value gets a bigger size, the longer "Finding Type" gets a smaller one) —
    // preserved as-is, not collapsed into a shared constant. FS_VALUE is just the tbCell default.
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(opts.fs || FS_VALUE); doc.setTextColor(opts.color || PDF_TEXT);
    const v = (value == null || value === '') ? '—' : String(value);
    doc.text(doc.splitTextToSize(v, cw - (vx - cx) - 2.5)[0], vx, ry + tbRowH - 2.6);
  };

  // Row 1 — identity.
  tbCell(M,             tbCol, y, 'Line Tag', f.pipe_tag || f.location_desc || '—', { fs: 8.5 });
  tbCell(M + tbCol,     tbCol, y, 'Terminal', f.terminal || '—', { fs: 8.5 });
  tbCell(M + tbCol * 2, tbCol, y, 'Finding Type', f.finding_type || '—', { fs: 8 });
  tbCell(M + tbCol * 3, tbCol, y, 'Severity', f.severity || '—', { fs: 9.5 });
  // Row 2 — workflow + reference.
  const tbY2 = y + tbRowH;
  tbCell(M,             tbCol, tbY2, 'Report Ref', reportRef, { fs: 8 });
  tbCell(M + tbCol,     tbCol, tbY2, 'Finding Status', (f.status || '—').toUpperCase(), { swatch: stColor, color: stColor, fs: 9 });
  if (isOverdue(f)) {
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_MICRO); doc.setTextColor(PDF_DANGER);
    doc.text('OVERDUE', M + tbCol * 2 - 2.4, tbY2 + 3.3, { align: 'right' });
  }
  tbCell(M + tbCol * 2, tbCol, tbY2, 'Inspection Date', paFmtDate(f.inspection_date), { fs: 8.5 });
  tbCell(M + tbCol * 3, tbCol, tbY2, 'Recorded By', f.created_by_email || '—', { fs: 7.5 });

  // QR share code (right zone, vertically centered against the two-row grid) — no caption text
  // beneath it any more (kept the block tighter to the next section; the QR is self-explanatory
  // next to the "no sign-in" badge already implied by scanning it).
  if (qrShown) {
    const qs = 24;
    const qx = M + gridW + qrGap + (qrZoneW - qs) / 2;
    const qy = y + (tbRowH * 2 - qs) / 2;
    doc.addImage(qrDataUrl, 'PNG', qx, qy, qs, qs);
    doc.link(qx, qy, qs, qs, { url: shareUrl }); // tappable in a PDF viewer
  }
  y += tbRowH * 2 + 5;

  // (No separate "ACTIVELY LEAKING" bar here — the health banner above already reads
  // "SEVERITY: CRITICAL" with the same emergency-containment line, so a second red bar was a
  // duplicate. Leaking is still surfaced in detail by the Repair Advisor's leaking overlay and the
  // ASME B31.3 Integrity Evaluation Note below.)

  section('Piping Metadata & Source Inspection', 30);
  const infoRows = [
    ['Terminal', f.terminal || '—', 'Inspection Date', paFmtDate(f.inspection_date)],
    ['Pipe Tag / Line', f.pipe_tag || '—', 'Recorded By', f.created_by_email || '—'],
    ['P&ID No.', f.pid_no || '—', 'Recorded At', fmtDateTime(f.created_at)],
    ['Service / Fluid', f.service || '—', 'Source Report', f.report_link ? 'Link Available' : '—'],
    ['Location', f.location_desc || '—', '', ''],
  ];

  autoTable(doc, {
    margin: { left: M, right: M, top: HEADER_H + 6, bottom: FOOTER_H + 4 },
    startY: y,
    theme: 'grid',
    styles: { font: 'GoogleSans', fontSize: FS_BODY, cellPadding: 1.6, lineColor: PDF_BORDER, lineWidth: 0.15 },
    columnStyles: {
      0: { fontStyle: 'bold', textColor: PDF_MUTED, cellWidth: 32, fillColor: '#f8fafc' },
      1: { textColor: PDF_TEXT, cellWidth: 59 },
      2: { fontStyle: 'bold', textColor: PDF_MUTED, cellWidth: 32, fillColor: '#f8fafc' },
      3: { textColor: PDF_TEXT, cellWidth: 59 },
    },
    body: infoRows,
    didParseCell: (data) => {
      if (data.section === 'body' && data.row.index === 3 && data.column.index === 3 && f.report_link) {
        data.cell.styles.textColor = '#156B95';
        data.cell.styles.fontStyle = 'bold';
      }
    }
  });
  y = doc.lastAutoTable.finalY + 5;

  section('Anomaly & Damage Mechanics', 26);
  const anomalyRows = [
    ['Finding Type', f.finding_type || '—', 'Severity Rating', f.severity || '—'],
    ['Active Leak State', f.is_leaking ? 'Yes (Boundary Breached)' : 'No (Non-leaking)', 'Defect L x W', (f.defect_length_mm != null || f.defect_width_mm != null) ? `${f.defect_length_mm ?? '—'} x ${f.defect_width_mm ?? '—'} mm` : '—'],
    ['Nominal Wall t_nom', f.t_nominal != null ? `${fmtN(f.t_nominal, 2)} mm` : '—', 'Measured Min t_meas', f.t_measured != null ? `${fmtN(f.t_measured, 2)} mm` : '—'],
    ['Description', f.description || '—', '', ''],
  ];

  autoTable(doc, {
    margin: { left: M, right: M, top: HEADER_H + 6, bottom: FOOTER_H + 4 },
    startY: y,
    theme: 'grid',
    styles: { font: 'GoogleSans', fontSize: FS_BODY, cellPadding: 1.6, lineColor: PDF_BORDER, lineWidth: 0.15 },
    columnStyles: {
      0: { fontStyle: 'bold', textColor: PDF_MUTED, cellWidth: 32, fillColor: '#f8fafc' },
      1: { textColor: PDF_TEXT, cellWidth: 59 },
      2: { fontStyle: 'bold', textColor: PDF_MUTED, cellWidth: 32, fillColor: '#f8fafc' },
      3: { textColor: PDF_TEXT, cellWidth: 59 },
    },
    body: anomalyRows,
    didParseCell: (data) => {
      if (data.section === 'body' && data.row.index === 1 && data.column.index === 1 && f.is_leaking) {
        data.cell.styles.textColor = PDF_DANGER;
        data.cell.styles.fontStyle = 'bold';
      }
    }
  });
  y = doc.lastAutoTable.finalY + 5;

  // --- Repair Advisor (always rendered, mirroring the web detail page's independent panel: it is
  // NOT gated on an assessment existing) — placed after Anomaly so the "recommended action" reads
  // right after the problem, with the numeric verdict already shown in the page-1 title block. It's
  // status-aware (OK/MONITOR/REPAIR) and mechanism-aware, and prepends the leaking-overlay safety
  // block when the finding is actively leaking. ---
  {
    const adv = resolveAdvisor(f.finding_type, assessRes, f.is_leaking);
    if (adv) {
      // Theme + banner title, mirroring paRenderRepairAdvisor's status/leaking precedence.
      let aC, aTint, aTxt, aBanner;
      if (f.is_leaking) { aC = PDF_DANGER; aTint = '#fef2f2'; aTxt = '#b91c1c'; aBanner = 'ACTIVELY LEAKING — EMERGENCY CONTAINMENT (ASME PCC-2)'; }
      else if (assessRes && assessRes.status === 'REPAIR') { aC = PDF_DANGER; aTint = '#fef2f2'; aTxt = '#b91c1c'; aBanner = 'CRITICAL REPAIR REQUIRED (ASME PCC-2)'; }
      else if (assessRes && assessRes.status === 'MONITOR') { aC = PDF_WARN; aTint = '#fffbeb'; aTxt = PDF_WARN_MID; aBanner = 'INTEGRITY MONITORING STRATEGY'; }
      else if (assessRes && assessRes.status === 'OK') { aC = PDF_OK; aTint = '#ecfdf5'; aTxt = '#15803d'; aBanner = 'OPERATIONAL INTEGRITY COMPLIANT'; }
      else { aC = PDF_NAVY; aTint = PDF_NAVY_TINT; aTxt = PDF_NAVY; aBanner = 'ASME PCC-2 / API 570 GUIDANCE'; }

      section('Repair Advisor', 38);

      // banner callout (light tint + colored spine + banner title + summary), same visual language
      // as the integrity-status band.
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_BODY);
      const sumLines = doc.splitTextToSize(adv.summary, CW - 8);
      const bH = 6.5 + sumLines.length * 3.7 + 2.5;
      ensure(bH + 8);
      doc.setFillColor(aTint); doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
      doc.rect(M, y, CW, bH, 'FD');
      doc.setFillColor(aC); doc.rect(M, y, 2, bH, 'F');
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_VALUE); doc.setTextColor(aTxt);
      doc.text(aBanner, M + 5, y + 5);
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_TEXT);
      doc.text(sumLines, M + 5, y + 9.5);
      y += bH + 3.5;

      // recommendation items — a title/body table (label column tinted like the metadata tables);
      // sub-points become their own bulleted lines inside the body cell.
      const advBody = adv.items.map(it => {
        const title = it.title || 'คำแนะนำทางวิศวกรรม:';
        const bodyText = [it.body, ...(it.sub || []).map(s => '•  ' + s)].filter(Boolean).join('\n');
        return [title, bodyText];
      });
      autoTable(doc, {
        margin: { left: M, right: M, top: HEADER_H + 6, bottom: FOOTER_H + 4 },
        startY: y,
        theme: 'grid',
        styles: { font: 'GoogleSans', fontSize: FS_BODY, cellPadding: 1.8, lineColor: '#e2e8f0', lineWidth: 0.12, valign: 'top', textColor: PDF_TEXT, overflow: 'linebreak' },
        columnStyles: {
          0: { fontStyle: 'bold', textColor: PDF_NAVY, cellWidth: 50, fillColor: '#f8fafc' },
          1: { textColor: PDF_TEXT },
        },
        body: advBody,
        didDrawPage: () => { if (doc.internal.getNumberOfPages() > 1) chrome(); }
      });
      y = doc.lastAutoTable.finalY + 4;

      if (adv.standardsNote) {
        const noteText = '[Standard Reference] ' + adv.standardsNote
          + (adv.needsReview ? ' (คำแนะนำทั่วไป — โปรดตรวจสอบกับมาตรฐานทางวิศวกรรมของโครงการ)' : '');
        const nLines = doc.splitTextToSize(noteText, CW);
        ensure(nLines.length * 3.4 + 4);
        doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_CAPTION); doc.setTextColor(PDF_MUTED);
        doc.text(nLines, M, y + 2);
        doc.setTextColor(PDF_TEXT);
        y += nLines.length * 3.4 + 5;
      }
    }
  }

  // --- Temporary Repair Record (emergency stop-leak) ---
  // Conditional: with no temp_repair row the whole block is skipped, so a finding without one
  // produces exactly the report it produced before this section existed (same section numbering,
  // since secNum only advances inside section()). Placed after the Repair Advisor so the document
  // reads problem -> advice -> what was actually done -> evidence.
  //
  // Sections 1-4 come from the SAME tempRepairRows array the detail page renders, and section 1's
  // rows are read from the finding + the assessment inputs already loaded above — the legacy Excel
  // form's section 1 is deliberately not stored on temp_repair.
  if (tempRepair) {
    const trRows = tempRepairRows(tempRepair, f, assess ? assess.inputs : null);
    if (trRows.length) {
      const trC = tempRepairResultColor(tempRepair);
      const trTint = tempRepair.test_result === 'Pass' ? '#ecfdf5'
        : tempRepair.test_result === 'Fail' ? '#fef2f2'
        : tempRepair.test_result === 'Pass with observation' ? '#fffbeb' : PDF_PANEL;

      section('Temporary Repair Record (Emergency Stop-Leak)', 40);

      // Verification callout — same light-tint + colored-spine language as the integrity band.
      // setFont BEFORE splitTextToSize: it measures against the ACTIVE font, and this string is Thai.
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_BODY);
      const trLines = doc.splitTextToSize(tempRepairHeadline(tempRepair), CW - 8);
      const trH = 6.5 + trLines.length * 3.7 + 2.5;
      ensure(trH + 8);
      doc.setFillColor(trTint); doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
      doc.rect(M, y, CW, trH, 'FD');
      doc.setFillColor(trC); doc.rect(M, y, 2, trH, 'F');
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_VALUE); doc.setTextColor(trC);
      doc.text(`VERIFICATION: ${String(tempRepair.test_result || 'Not yet tested').toUpperCase()}`, M + 5, y + 5);
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_TEXT);
      doc.text(trLines, M + 5, y + 9.5);
      y += trH + 3.5;

      // Label/value table with a full-width section header row wherever the bilingual section
      // changes, so the printed record maps 1:1 onto the legacy Excel form's numbering.
      const trBody = [];
      let trSec = null;
      trRows.forEach(r => {
        if (r.section !== trSec) {
          trSec = r.section;
          trBody.push([{ content: r.section, colSpan: 2, styles: { fillColor: '#e2e8f0', fontStyle: 'bold', textColor: PDF_NAVY } }]);
        }
        trBody.push([r.label, r.value]);
      });
      autoTable(doc, {
        margin: { left: M, right: M, top: HEADER_H + 6, bottom: FOOTER_H + 4 },
        startY: y,
        theme: 'grid',
        styles: { font: 'GoogleSans', fontSize: FS_BODY, cellPadding: 1.8, lineColor: '#e2e8f0', lineWidth: 0.12, valign: 'top', textColor: PDF_TEXT, overflow: 'linebreak' },
        columnStyles: {
          0: { fontStyle: 'bold', textColor: PDF_NAVY, cellWidth: 62, fillColor: '#f8fafc' },
          1: { textColor: PDF_TEXT },
        },
        body: trBody,
        didDrawPage: () => { if (doc.internal.getNumberOfPages() > 1) chrome(); }
      });
      y = doc.lastAutoTable.finalY + 4;

      const trNote = 'บันทึกนี้เป็นการซ่อมแซมชั่วคราวเท่านั้น ต้องดำเนินการซ่อมแซมถาวรตามแผนในหัวข้อ 4 '
        + '(A temporary repair is an interim measure only; the permanent repair in section 4 remains outstanding. '
        + 'ASME PCC-2 Part 3 for mechanical clamps, Part 4 / ISO 24817 for composite wraps.)';
      doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_CAPTION); doc.setTextColor(PDF_MUTED);
      const trNoteLines = doc.splitTextToSize(trNote, CW);
      ensure(trNoteLines.length * 3.4 + 4);
      doc.text(trNoteLines, M, y + 2);
      doc.setTextColor(PDF_TEXT);
      y += trNoteLines.length * 3.4 + 5;
    }
  }

  // --- Site Location (Map) ---
  if (f.lat != null && f.lng != null) {
    section('Site Location & Geographical Pin', mapImg ? 98 : 16);
    if (mapImg) {
      const w = CW, h = w / 2; // 100% natural 2:1 aspect ratio of satellite canvas
      ensure(h + 10);
      doc.addImage(mapImg, 'JPEG', M, y, w, h);
      doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
      doc.rect(M, y, w, h);
      y += h + 3.5;
      figNum++;
      doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_CAPTION); doc.setTextColor(PDF_MUTED);
      doc.text(`Figure ${figNum}: Satellite location pin (${Number(f.lat).toFixed(6)}, ${Number(f.lng).toFixed(6)})`, PW / 2, y, { align: 'center' });
      doc.setTextColor(PDF_TEXT);
      y += 5;
    } else {
      row('Coordinates', `${Number(f.lat).toFixed(6)}, ${Number(f.lng).toFixed(6)}`);
    }
  }

  // --- Photographic Record ---
  if (photoData.length) {
    section('Photographic Record', 75);
    // The two temporary-repair groups only ever have items when a stop-leak was recorded, so no
    // extra guard is needed — `continue` on an empty slice already skips them.
    for (const [kind, title] of [
      ['found', 'As Found'],
      ['temp_before', 'Before Temporary Repair / ก่อนติดตั้ง'],
      ['temp_after', 'After Temporary Repair / หลังติดตั้ง'],
      ['repaired', 'After Repair'],
    ]) {
      const items = photoData.filter(p => p.kind === kind);
      if (!items.length) continue;
      ensure(15);
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_MUTED);
      doc.text(title.toUpperCase(), M, y + 2.5);
      y += 5.5;
      doc.setTextColor(PDF_TEXT);
      const gap = 5, cellW = (CW - gap) / 2;
      for (let i = 0; i < items.length; i += 2) {
        const rowItems = items.slice(i, i + 2).map(p => {
          const s = cellW / p.w; // 100% unconstrained true aspect ratio
          return { src: p.src, w: cellW, h: p.h * s };
        });
        const rh = Math.max.apply(null, rowItems.map(d => d.h));
        ensure(rh + 10);
        rowItems.forEach((d, j) => {
          const ix = M + j * (cellW + gap) + (cellW - d.w) / 2;
          doc.addImage(d.src, 'JPEG', ix, y, d.w, d.h);
          doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
          doc.rect(ix, y, d.w, d.h);
          figNum++;
          doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_CAPTION); doc.setTextColor(PDF_MUTED);
          doc.text(`Figure ${figNum}: Inspection Photo (${title}, #${i + j + 1})`, ix + d.w / 2, y + d.h + 3.5, { align: 'center' });
        });
        y += rh + 7;
      }
      y += 2;
    }
  }

  // --- ASME B31.3 Fitness-for-Service Assessment ---

  if (f.is_leaking) {
    section('ASME B31.3 Integrity Evaluation Note');
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_VALUE); doc.setTextColor(PDF_DANGER);
    doc.text('Notice: ASME B31.3 wall-loss calculation is disabled for actively leaking piping.', M, y + 3);
    y += 5;
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_TEXT);
    const leakNote = 'Pressure boundary integrity is already breached. Per ASME PCC-2 Article 201 / Article 304, immediate mechanical clamping, engineered enclosure, or line isolation is required prior to Fitness-for-Service wall evaluation.';
    const leakLines = doc.splitTextToSize(leakNote, CW);
    doc.text(leakLines, M, y + 3);
    y += leakLines.length * 3.6 + 4;
  } else if (assess && assessRes) {
    const inp = assess.inputs || {};
    const r = assessRes;
    const erf_no = r.mawp_no > 0 ? (r.P_input / r.mawp_no) : 9.99;
    const erf_with = r.mawp_with == null ? null : (r.mawp_with > 0 ? (r.P_input / r.mawp_with) : 9.99);
    const schLabel = (PA_PIPE_DATABASE[inp.nps] && PA_PIPE_DATABASE[inp.nps].schedules[inp.schedule])
      ? PA_PIPE_DATABASE[inp.nps].schedules[inp.schedule].label : (inp.schedule || '—');

    const tableBase = {
      margin: { left: M, right: M, top: HEADER_H + 6, bottom: FOOTER_H + 4 },
      styles: { font: 'GoogleSans', fontSize: FS_BODY, cellPadding: 1.2, lineColor: PDF_BORDER, lineWidth: 0.15 },
      headStyles: { fillColor: PDF_NAVY, textColor: '#ffffff', fontStyle: 'bold', fontSize: FS_LABEL },
      didDrawPage: () => { if (doc.internal.getNumberOfPages() > 1) chrome(); }
    };

    // --- integrity status band: a flat light-tint callout with a solid colored spine + dark
    // semantic text (an engineering callout, not a saturated web card) ---
    section('ASME B31.3 Fitness-for-Service Assessment', 24);
    ensure(24);
    const iColor = r.status === 'OK' ? PDF_OK : r.status === 'MONITOR' ? PDF_WARN : PDF_DANGER;
    const iTint = r.status === 'OK' ? '#ecfdf5' : r.status === 'MONITOR' ? '#fffbeb' : '#fef2f2';
    const iText = r.status === 'OK' ? '#15803d' : r.status === 'MONITOR' ? PDF_WARN_MID : '#b91c1c';
    doc.setFillColor(iTint);
    doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
    doc.rect(M, y, CW, 12, 'FD');
    doc.setFillColor(iColor);
    doc.rect(M, y, 2, 12, 'F'); // colored spine
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_SUB); doc.setTextColor(iText);
    doc.text(`INTEGRITY STATUS: ${r.status}`, M + 5, y + 7.8);
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_TEXT);
    doc.text(`ERF ${fmtN(erf_no, 3)}   MAWP ${fmtN(r.mawp_no, 1)} ${r.pUnit} (no CA)   MARGIN ${fmtN(r.margin, 3)} mm`, PW - M - 4, y + 7.8, { align: 'right' });
    y += 16;
    doc.setTextColor('#334155'); doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_BODY);
    const descLines = doc.splitTextToSize(r.desc, CW);
    ensure(descLines.length * 3.6 + 4);
    doc.text(descLines, M, y);
    y += descLines.length * 3.6 + 2;
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED);
    doc.text(`Assessed ${fmtDateTime(assess.created_at)} by ${assess.created_by_email || '—'}`
      + (currentAssessments.length > 1 ? `  •  ${currentAssessments.length} assessments recorded — latest shown` : ''), M, y);
    doc.setTextColor(PDF_TEXT);
    y += 7;

    // --- input parameters ---
    section('Assessment Input Parameters');
    const modeIsDepth = inp.mode === 'depth';
    autoTable(doc, {
      ...tableBase,
      startY: y,
      theme: 'grid',
      head: [['Parameter', 'Symbol', 'Value', 'Unit', 'Source']],
      body: [
        ['Nominal pipe size / schedule', 'NPS', `${inp.nps} / ${schLabel}`, '—', 'ASME B36.10M'],
        ['Outside diameter', 'D', fmtN(r.D, 2), 'mm', 'B36.10M table'],
        ['Nominal wall thickness', 't_nom', fmtN(r.t_nom, 2), 'mm', 'B36.10M / as-built'],
        ['Measurement mode', '—', modeIsDepth ? 'Wall-loss depth' : 'Measured minimum', '—', 'Field input'],
        ['Wall loss depth', 'd', fmtN(r.depth, 2), 'mm', modeIsDepth ? 'Measured' : 'Derived'],
        ['Measured minimum thickness', 't_meas', fmtN(r.t_meas, 2), 'mm', modeIsDepth ? 'Derived' : 'UT measurement'],
        ['Corrosion type', '—', r.isInternal ? 'Internal wall loss' : 'External wall loss', '—', 'Field input'],
        ['Corrosion allowance', 'CA', fmtN(r.ca, 2), 'mm', 'Design'],
        ['Corrosion rate (optional)', 'CR', r.CR > 0 ? fmtN(r.CR, 3) : '—', 'mm/yr', 'Historical/estimated'],
        ['Design pressure', 'P', fmtN(r.P_input, 2), r.pUnit, 'Design'],
        ['Material', '—', materialName(inp.material), '—', 'Specification'],
        ['Allowable stress', 'S', fmtN(r.S, 1), 'MPa', 'B31.3 Table A-1'],
        ['Longitudinal joint factor', 'E', fmtN(r.E, 2), '—', 'B31.3 Table A-1B'],
        ['Weld strength reduction factor', 'W', fmtN(r.W, 2), '—', 'B31.3 Table 302.3.5'],
        ['Wall thickness coefficient', 'Y', fmtN(r.Y, 2), '—', 'B31.3 Table 304.1.1'],
      ],
      columnStyles: {
        1: { font: 'GoogleSans', fontStyle: 'bold', halign: 'center', cellWidth: 20, fillColor: '#f1f5f9', textColor: PDF_NAVY },
        2: { font: 'GoogleSans', fontStyle: 'bold', halign: 'right', cellWidth: 40 },
        3: { halign: 'center', cellWidth: 16 },
      },
    });
    y = doc.lastAutoTable.finalY + 7;

    // --- cross-section figure ---
    if (xsecPng) {
      const figW = 150, figH = figW * 270 / 500;
      ensure(26 + figH + 14);
      section('Wall Thickness Cross-Section');
      doc.addImage(xsecPng, 'PNG', (PW - figW) / 2, y, figW, figH);
      y += figH + 4;
      figNum++;
      doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED);
      doc.text(`Figure ${figNum} — Wall thickness cross-section (localized loss pocket; boundaries: t_req, t_req + CA, API 574 structural minimum)`, PW / 2, y, { align: 'center' });
      doc.setTextColor(PDF_TEXT);
      y += 8;
    }

    // --- results with verdicts ---
    section('Calculation Results');
    autoTable(doc, {
      ...tableBase,
      startY: y,
      theme: 'grid',
      head: [['Quantity', 'Value', 'Criterion', 'Verdict']],
      body: buildResultsTableBody(r),
      columnStyles: {
        1: { font: 'GoogleSans', fontStyle: 'bold', halign: 'right', cellWidth: 42 },
        2: { font: 'GoogleSans', halign: 'center', cellWidth: 38 },
        3: { fontStyle: 'bold', halign: 'center', cellWidth: 18 },
      },
      didParseCell: resultsTableDidParseCell,
    });
    y = doc.lastAutoTable.finalY + 3;
    if (r.isCsRef) {
      ensure(6);
      doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_WARN_DARK);
      doc.text('* API 574 structural minimum is a carbon/low-alloy steel reference table; not validated for the selected material.', M, y);
      doc.setTextColor(PDF_TEXT);
      y += 6;
    } else {
      y += 4;
    }
    if (r.margin < 0 || r.t_meas < r.t_struct) {
      const ffsText = 'RECOMMENDATION: One or more code checks did not pass. Consider a Level 1/2 fitness-for-service assessment per API 579-1/ASME FFS-1 or a B31G/RSTRENG remaining-strength evaluation before the repair/replace decision.';
      const ffsLines = doc.splitTextToSize(ffsText, CW);
      ensure(ffsLines.length * 3.4 + 4);
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_WARN_MID);
      doc.text(ffsLines, M, y);
      doc.setTextColor(PDF_TEXT);
      y += ffsLines.length * 3.4 + 4;
    }

    // --- substituted equations (real stacked fractions, mirroring the on-screen .eq-box) ---
    const eqRows = buildEquationRows(r);
    const totalEqH = eqRows.reduce((sum, rw) => sum + fractionRowHeight(rw), 0);
    ensure(26 + Math.min(totalEqH, 120)); // keep the title with at least the first equations
    section('Governing Equations (Substituted)');
    y += 2.5;
    /* Two-level layout so the *formula* (symbolic rule) and the *worked substitution* (numbers) read
       as distinct roles instead of two near-identical `var = expr` lines: the navy-bold formula
       heading (with the standard reference right-aligned) on top, then the substituted monospace
       calculation on its own line, lightly indented beneath it. Navy-bold sans = the formula/label,
       dark monospace = the computed numbers — the indent + typeface contrast carry the hierarchy
       (an earlier version added a numbered step chip and a tinted computation band with a navy left
       accent; the chip, band, and accent were all removed at the user's request for a plainer look). */
    eqRows.forEach(rw => {
      const isFrac = rw.segs.some(s => typeof s !== 'string');
      const workedH = isFrac ? 11 : 6;     // vertical space the substituted line occupies
      ensure(7 + workedH + 4);
      // formula (symbolic rule) — navy-bold heading + right-aligned standard reference
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_NAVY);
      doc.text(rw.label, M, y + 2.7);
      if (rw.ref) {
        doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_CAPTION); doc.setTextColor(PDF_MUTED);
        doc.text(rw.ref, PW - M, y + 2.7, { align: 'right' });
      }
      y += 6.5;
      // substituted computation — plain monospace, lightly indented under the formula heading
      drawFractionRow(doc, rw.segs, M + 4, y + (isFrac ? 0.5 : 0.2), { fontSize: FS_VALUE, font: 'courier' });
      y += workedH + 3;
    });
    y += 3;

    // --- scope & limitations (assessment-scoped disclaimer) ---
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL);
    const scopeLines = doc.splitTextToSize(PA_SCOPE_TEXT, CW);
    ensure(14 + scopeLines.length * 3.3 + 4);
    section('Scope & Limitations');
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL); doc.setTextColor('#475569');
    doc.text(scopeLines, M, y + 2);
    doc.setTextColor(PDF_TEXT);
    y += scopeLines.length * 3.3 + 6;
  } else if (assess) {
    // legacy snapshot whose inputs can't re-compute: fall back to its saved results
    const r = assess.results || {};
    section('ASME B31.3 Assessment (Latest)');
    row('Result', r.status);
    row('ERF (no CA — current)', fmtN(erfNo(r), 3));
    row('Required Thk. incl. CA', r.t_req_total != null ? `${fmtN(r.t_req_total, 3)} mm` : null);
    row('Measured Thickness', r.t_meas != null ? `${fmtN(r.t_meas, 2)} mm` : null);
    row('Remaining Margin', r.margin != null ? `${fmtN(r.margin, 3)} mm` : null);
    row('MAWP (no CA — current)', r.mawp_no != null ? `${fmtN(r.mawp_no, 2)} ${r.pUnit || ''}` : null);
    if (r.remainingLife != null) row('Est. Remaining Life', `${fmtN(r.remainingLife, 1)} years`);
    row('Assessed By', assess.created_by_email);
    row('Assessed At', fmtDateTime(assess.created_at));
    y += 4;
  }

  if (currentHistory.length) {
    section('Status History');
    // oldest first — a report reads chronologically
    currentHistory.slice().reverse().forEach(h => {
      const head = `${fmtDateTime(h.changed_at)}  —  ${h.old_status ? h.old_status + ' > ' : ''}${h.new_status}${h.changed_by_email ? '  (' + h.changed_by_email + ')' : ''}`;
      const noteLines = h.note ? doc.splitTextToSize(h.note, CW - 8) : [];
      const hh = 5.5 + (noteLines.length ? noteLines.length * 4 + 2 : 0);
      ensure(hh);
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_VALUE); doc.setTextColor(PDF_TEXT);
      doc.text(head, M, y + 3.5);
      if (noteLines.length) {
        doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_VALUE); doc.setTextColor(PDF_MUTED);
        doc.text(noteLines, M + 4, y + 8);
        doc.setTextColor(PDF_TEXT);
      }
      y += hh;
    });
  }

  // --- System-generated record footnote (no wet-signature approval block — this is a paperless
  // system). A single restrained attribution line keeps traceability: prepared-by, Record ID, and
  // the generation timestamp. ---
  ensure(14);
  y += 4;
  doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
  doc.line(M, y, PW - M, y);
  y += 4;
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_FOOTER_MICRO); doc.setTextColor(PDF_MUTED);
  doc.text(`System-generated record via Pipe Assessor — paperless piping-integrity system. No physical signature required.`, M, y);
  y += 3.6;
  doc.text(`Recorded by ${f.created_by_email || 'System User'}  ·  ASME B31.3-2022 / API 574 assessment engine  ·  Record ID: PA-${f.id}  ·  Generated ${paFmtDateTime(now)}`, M, y);
  doc.setTextColor(PDF_TEXT);
  y += 6;

  ensure(12);
  y += 4;
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL); doc.setTextColor('#94a3b8');
  doc.text('— End of Report —', PW / 2, y, { align: 'center' });

  if (doc.putTotalPages) doc.putTotalPages('{tp}');
  return doc.output('blob');
}

export async function exportFindingPdf() {
  if (!current) return;
  /* jsPDF is dynamic-imported inside the builder; no CDN-availability guard needed */
  const btn = $('btnPdf');
  setBusy(btn, true, 'Building PDF…');
  try {
    const blob = await buildFindingPdf();
    // blob anchor click = the one native-viewer approach that works everywhere incl. file://
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    notify('PDF failed: ' + e.message, true);
  } finally {
    setBusy(btn, false);
  }
}

/* ---------------- Quick Calculator PDF (standalone what-if — not tied to any saved finding) ----------------
   inputs is a plain snapshot of the Quick Calc form's own fields (nps/schLabel/matCode/mode/designTemp) —
   pdf.ts has no access to the #/calc page's DOM ids, so the caller (features/form.ts, which already
   reads these same fields for Copy Summary) builds this object rather than pdf.ts reaching into the
   page itself. res is the live computeB313 result (lastQuickRes) — same shape buildFindingPdf uses,
   which is why the results table/equations/cross-section below can reuse those exact same shared
   helpers (buildResultsTableBody/buildEquationRows/paCrossSectionPng) with byte-identical output. */
export async function buildQuickCalcPdf(inputs, res) {
  if (!res || res.hasErrors) throw new Error('No valid calculation to export.');
  const r = res;
  const { jsPDF } = await import('jspdf'); const { default: autoTable } = await import('jspdf-autotable');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await registerGoogleSansFonts(doc);
  const PW = 210, PH = 297, M = 14, CW = PW - 2 * M;
  const HEADER_H = 18, FOOTER_H = 16;
  let y = 0, secNum = 0, figNum = 0;
  const now = new Date();

  // Type scale — consolidated from 8 ad hoc literals (6.5/6.8/7/7.5/8/11/13/15) down to named
  // roles, mirroring buildFindingPdf's scale (same report family, kept function-local on purpose).
  const FS_FOOTER_MICRO = 6.5; // footer division-attribution line, record footnote
  const FS_DISCLAIMER = 7;     // scratch-calculation disclaimer body text
  const FS_LABEL = 7.5;        // header/footer meta, italic footnotes/captions, bold caveats, eq. row labels
  const FS_BODY = 8;           // body text — status-band ERF/MAWP/MARGIN line, description
  const FS_VALUE = 8.5;        // equation fraction digits (drawFractionRow)
  const FS_TITLE = 11;         // header report title
  const FS_SUB = 13;           // "INTEGRITY STATUS:" headline
  const FS_LOGO = 15;          // logo-fallback "OR" lettering

  const logo = (typeof OR_LOGO_DATAURL !== 'undefined' && OR_LOGO_DATAURL) || await fetchAsDataUrl('/RGB_OR_Full color.png', 3000);
  const logoIm = logo ? await loadImg(logo) : null;
  const xsecPng = await paCrossSectionPng(r, 2).catch(() => null);

  // Same header/footer chrome family as buildFindingPdf (logo left, navy title right, navy rule,
  // hairline footer) but its own title/DOC REF — "QUICK CALCULATION" never reads as a finding
  // report, and the DOC REF is keyed off the pipe size + timestamp since there's no finding id.
  function chrome() {
    if (logoIm) {
      const lw = 26, lh = 26 * logoIm.naturalHeight / logoIm.naturalWidth;
      try { doc.addImage(logo, 'PNG', M, 3, lw, lh); }
      catch (_) { doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LOGO); doc.setTextColor(PDF_NAVY); doc.text('OR', M, 12); }
    } else {
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LOGO); doc.setTextColor(PDF_NAVY);
      doc.text('OR', M, 12);
    }
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_TITLE); doc.setTextColor(PDF_NAVY);
    doc.text('ASME B31.3 QUICK CALCULATION REPORT', PW - M, 8.5, { align: 'right' });
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_LABEL); doc.setTextColor('#64748b');
    const npsRef = String(inputs.nps || '').replace(/[^a-zA-Z0-9-]/g, '');
    doc.text(`DOC REF: PA-QCALC-${npsRef}-${paFmtDate(now).replace(/\s+/g, '')}`, PW - M, 13.5, { align: 'right' });
    doc.setDrawColor(PDF_NAVY); doc.setLineWidth(0.8);
    doc.line(M, HEADER_H - 1, PW - M, HEADER_H - 1);

    doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
    doc.line(M, PH - FOOTER_H, PW - M, PH - FOOTER_H);
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_LABEL); doc.setTextColor('#64748b');
    doc.text('Piping integrity — what-if calculation (not a recorded finding)', M, PH - FOOTER_H + 4);
    doc.text(`Page ${doc.internal.getNumberOfPages()} of {tp}`, PW / 2, PH - FOOTER_H + 4, { align: 'center' });
    doc.text(`Generated ${paFmtDateTime(now)}`, PW - M, PH - FOOTER_H + 4, { align: 'right' });
    doc.setFontSize(FS_FOOTER_MICRO); doc.setTextColor('#94a3b8');
    doc.text(['Central and Eastern Engineering and Maintenance Division', 'PTT Oil and Retail Business Public Company Limited'], PW / 2, PH - FOOTER_H + 9, { align: 'center', lineHeightFactor: 1.35 });
    doc.setTextColor(PDF_TEXT);
    y = HEADER_H + 4;
  }

  function ensure(h) {
    if (y + h > PH - FOOTER_H - 4) { doc.addPage(); chrome(); }
  }

  function section(t, minBodyHeight = 20) {
    ensure(11.2 + minBodyHeight);
    secNum++;
    y += drawSectionHeader(doc, secNum, t, M, y, PW - M);
  }

  chrome();

  // --- scratch-calculation disclaimer: the one thing this report must never be mistaken for is a
  // recorded finding — no finding_id, no assessments row, nothing saved to the database. ---
  ensure(16);
  doc.setDrawColor(PDF_WARN_DARK); doc.setLineWidth(0.3);
  doc.setFillColor('#fffbeb');
  doc.roundedRect(M, y, CW, 13, 1.5, 1.5, 'FD');
  doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_WARN_DARK);
  doc.text('SCRATCH WHAT-IF CALCULATION — NOT A RECORDED FINDING', M + 4, y + 5);
  doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_DISCLAIMER); doc.setTextColor('#78350f');
  doc.text('Produced by the standalone Quick Calculator. No finding record or assessment snapshot was created or saved.', M + 4, y + 9.5);
  doc.setTextColor(PDF_TEXT);
  y += 17;

  // --- integrity status band (same visual language as the finding report's assessment band) ---
  const erf_no = r.mawp_no > 0 ? (r.P_input / r.mawp_no) : 9.99;
  section('Calculation Result', 24);
  ensure(24);
  const iColor = r.status === 'OK' ? PDF_OK : r.status === 'MONITOR' ? PDF_WARN : PDF_DANGER;
  const iTint = r.status === 'OK' ? '#ecfdf5' : r.status === 'MONITOR' ? '#fffbeb' : '#fef2f2';
  const iText = r.status === 'OK' ? '#15803d' : r.status === 'MONITOR' ? PDF_WARN_MID : '#b91c1c';
  doc.setFillColor(iTint);
  doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
  doc.rect(M, y, CW, 12, 'FD');
  doc.setFillColor(iColor);
  doc.rect(M, y, 2, 12, 'F'); // colored spine
  doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_SUB); doc.setTextColor(iText);
  doc.text(`INTEGRITY STATUS: ${r.status}`, M + 5, y + 7.8);
  doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_TEXT);
  doc.text(`ERF ${fmtN(erf_no, 3)}   MAWP ${fmtN(r.mawp_no, 1)} ${r.pUnit} (no CA)   MARGIN ${fmtN(r.margin, 3)} mm`, PW - M - 4, y + 7.8, { align: 'right' });
  y += 16;
  doc.setTextColor('#334155'); doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_BODY);
  const descLines = doc.splitTextToSize(r.desc, CW);
  ensure(descLines.length * 3.6 + 4);
  doc.text(descLines, M, y);
  y += descLines.length * 3.6 + 2;
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED);
  doc.text(`Calculated ${paFmtDateTime(now)}`, M, y);
  doc.setTextColor(PDF_TEXT);
  y += 7;

  // --- input parameters ---
  section('Calculation Input Parameters');
  const modeIsDepth = inputs.mode === 'depth';
  const inputRows = [
    ['Nominal pipe size / schedule', 'NPS', `${inputs.nps} / ${inputs.schLabel}`, '—', 'ASME B36.10M'],
    ['Outside diameter', 'D', fmtN(r.D, 2), 'mm', 'B36.10M table'],
    ['Nominal wall thickness', 't_nom', fmtN(r.t_nom, 2), 'mm', 'B36.10M / as-built'],
    ['Measurement mode', '—', modeIsDepth ? 'Wall-loss depth' : 'Measured minimum', '—', 'Field input'],
    ['Wall loss depth', 'd', fmtN(r.depth, 2), 'mm', modeIsDepth ? 'Measured' : 'Derived'],
    ['Measured minimum thickness', 't_meas', fmtN(r.t_meas, 2), 'mm', modeIsDepth ? 'Derived' : 'UT measurement'],
    ['Corrosion type', '—', r.isInternal ? 'Internal wall loss' : 'External wall loss', '—', 'Field input'],
    ['Corrosion allowance', 'CA', fmtN(r.ca, 2), 'mm', 'Design'],
    ['Corrosion rate (optional)', 'CR', r.CR > 0 ? fmtN(r.CR, 3) : '—', 'mm/yr', 'Historical/estimated'],
    ['Design pressure', 'P', fmtN(r.P_input, 2), r.pUnit, 'Design'],
    ['Material', '—', materialName(inputs.matCode), '—', 'Specification'],
  ];
  if (inputs.designTemp) inputRows.push(['Design temperature', '—', inputs.designTemp, '°C', 'Field input']);
  inputRows.push(
    ['Allowable stress', 'S', fmtN(r.S, 1), 'MPa', 'B31.3 Table A-1'],
    ['Longitudinal joint factor', 'E', fmtN(r.E, 2), '—', 'B31.3 Table A-1B'],
    ['Weld strength reduction factor', 'W', fmtN(r.W, 2), '—', 'B31.3 Table 302.3.5'],
    ['Wall thickness coefficient', 'Y', fmtN(r.Y, 2), '—', 'B31.3 Table 304.1.1'],
  );

  const tableBase = {
    margin: { left: M, right: M, top: HEADER_H + 6, bottom: FOOTER_H + 4 },
    styles: { font: 'GoogleSans', fontSize: FS_BODY, cellPadding: 1.2, lineColor: PDF_BORDER, lineWidth: 0.15 },
    headStyles: { fillColor: PDF_NAVY, textColor: '#ffffff', fontStyle: 'bold', fontSize: FS_LABEL },
    didDrawPage: () => { if (doc.internal.getNumberOfPages() > 1) chrome(); }
  };

  autoTable(doc, {
    ...tableBase,
    startY: y,
    theme: 'grid',
    head: [['Parameter', 'Symbol', 'Value', 'Unit', 'Source']],
    body: inputRows,
    columnStyles: {
      1: { font: 'GoogleSans', fontStyle: 'bold', halign: 'center', cellWidth: 20, fillColor: '#f1f5f9', textColor: PDF_NAVY },
      2: { font: 'GoogleSans', fontStyle: 'bold', halign: 'right', cellWidth: 40 },
      3: { halign: 'center', cellWidth: 16 },
    },
  });
  y = doc.lastAutoTable.finalY + 7;

  // --- cross-section figure ---
  if (xsecPng) {
    const figW = 150, figH = figW * 270 / 500;
    ensure(26 + figH + 14);
    section('Wall Thickness Cross-Section');
    doc.addImage(xsecPng, 'PNG', (PW - figW) / 2, y, figW, figH);
    y += figH + 4;
    figNum++;
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED);
    doc.text(`Figure ${figNum} — Wall thickness cross-section (localized loss pocket; boundaries: t_req, t_req + CA, API 574 structural minimum)`, PW / 2, y, { align: 'center' });
    doc.setTextColor(PDF_TEXT);
    y += 8;
  }

  // --- results with verdicts ---
  section('Calculation Results');
  autoTable(doc, {
    ...tableBase,
    startY: y,
    theme: 'grid',
    head: [['Quantity', 'Value', 'Criterion', 'Verdict']],
    body: buildResultsTableBody(r),
    columnStyles: {
      1: { font: 'GoogleSans', fontStyle: 'bold', halign: 'right', cellWidth: 42 },
      2: { font: 'GoogleSans', halign: 'center', cellWidth: 38 },
      3: { fontStyle: 'bold', halign: 'center', cellWidth: 18 },
    },
    didParseCell: resultsTableDidParseCell,
  });
  y = doc.lastAutoTable.finalY + 3;
  if (r.isCsRef) {
    ensure(6);
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_WARN_DARK);
    doc.text('* API 574 structural minimum is a carbon/low-alloy steel reference table; not validated for the selected material.', M, y);
    doc.setTextColor(PDF_TEXT);
    y += 6;
  } else {
    y += 4;
  }
  if (r.margin < 0 || r.t_meas < r.t_struct) {
    const ffsText = 'RECOMMENDATION: One or more code checks did not pass. Consider a Level 1/2 fitness-for-service assessment per API 579-1/ASME FFS-1 or a B31G/RSTRENG remaining-strength evaluation before the repair/replace decision.';
    const ffsLines = doc.splitTextToSize(ffsText, CW);
    ensure(ffsLines.length * 3.4 + 4);
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_WARN_MID);
    doc.text(ffsLines, M, y);
    doc.setTextColor(PDF_TEXT);
    y += ffsLines.length * 3.4 + 4;
  }

  // --- substituted equations ---
  const eqRows = buildEquationRows(r);
  const totalEqH = eqRows.reduce((sum, rw) => sum + fractionRowHeight(rw), 0);
  ensure(26 + Math.min(totalEqH, 120));
  section('Governing Equations (Substituted)');
  y += 2.5;
  /* Two-level layout mirroring buildFindingPdf's equation section (same report family): navy-bold
     formula heading (with the standard reference right-aligned) on top, then the substituted
     monospace calculation lightly indented beneath it — no chip, band, or accent (all removed at
     the user's request). Scales are function-local, so the ref uses this function's FS_DISCLAIMER. */
  eqRows.forEach(rw => {
    const isFrac = rw.segs.some(s => typeof s !== 'string');
    const workedH = isFrac ? 11 : 6;
    ensure(7 + workedH + 4);
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_NAVY);
    doc.text(rw.label, M, y + 2.7);
    if (rw.ref) {
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_DISCLAIMER); doc.setTextColor(PDF_MUTED);
      doc.text(rw.ref, PW - M, y + 2.7, { align: 'right' });
    }
    y += 6.5;
    drawFractionRow(doc, rw.segs, M + 4, y + (isFrac ? 0.5 : 0.2), { fontSize: FS_VALUE, font: 'courier' });
    y += workedH + 3;
  });
  y += 1;

  // --- scope & limitations ---
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL);
  const scopeLines = doc.splitTextToSize(PA_SCOPE_TEXT, CW);
  ensure(14 + scopeLines.length * 3.3 + 4);
  section('Scope & Limitations');
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL); doc.setTextColor('#475569');
  doc.text(scopeLines, M, y + 2);
  doc.setTextColor(PDF_TEXT);
  y += scopeLines.length * 3.3 + 6;

  // --- System-generated record footnote (matches the finding report's paperless closing; adapted
  // for the scratch what-if — no finding Record ID, and it re-states this is not a recorded finding). ---
  ensure(14);
  y += 2;
  doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
  doc.line(M, y, PW - M, y);
  y += 4;
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_FOOTER_MICRO); doc.setTextColor(PDF_MUTED);
  doc.text('System-generated what-if calculation via Pipe Assessor — paperless piping-integrity system. No physical signature required.', M, y);
  y += 3.6;
  doc.text(`ASME B31.3-2022 / API 574 assessment engine  ·  Not a recorded finding  ·  Generated ${paFmtDateTime(now)}`, M, y);
  doc.setTextColor(PDF_TEXT);
  y += 6;

  ensure(12);
  y += 2;
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL); doc.setTextColor('#94a3b8');
  doc.text('— End of Report —', PW / 2, y, { align: 'center' });

  if (doc.putTotalPages) doc.putTotalPages('{tp}');
  return doc.output('blob');
}

export async function exportQuickCalcPdf(inputs, res) {
  const btn = $('btnQuickPdf');
  setBusy(btn, true, 'Building PDF…');
  try {
    const blob = await buildQuickCalcPdf(inputs, res);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    notify('PDF failed: ' + e.message, true);
  } finally {
    setBusy(btn, false);
  }
}

/* ---------------- Management-summary PDF (the currently filtered register as one table) ---------------- */

// rows are resolved by the export dialog (selection else filter); includeBudget threads through
// to the report chrome + table.
export async function exportSummaryPdf(rows, includeBudget) {
  /* jsPDF is dynamic-imported inside the builder; no CDN-availability guard needed */
  if (!rows || !rows.length) { notify('No findings to summarize with the current filters.', true); return; }
  const btn = $('btnExport');
  setBusy(btn, true, 'Building…');
  try {
    const blob = await buildSummaryPdf(rows, includeBudget);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    notify('Summary PDF failed: ' + e.message, true);
  } finally {
    setBusy(btn, false);
  }
}

// The export dialog: one button -> pick format + opt-in budget.
export function openExportDialog() {
  const filtered = sortFindings(applyFilters(findings));
  const n = selectedIds.size ? selectedIds.size : filtered.length;
  if (!n) { notify('Nothing to export with the current filters.', true); return; }
  $('exportScope').textContent = selectedIds.size
    ? `Exporting ${selectedIds.size} selected finding${selectedIds.size === 1 ? '' : 's'}`
    : `Exporting ${filtered.length} finding${filtered.length === 1 ? '' : 's'} — current filter`;
  const pdfRadio = document.querySelector('input[name="exportFmt"][value="pdf"]');
  if (pdfRadio) pdfRadio.checked = true;
  $('exportInclBudget').checked = false;
  openDialog($('exportDlg'));
}

export function runExport() {
  const fmt = (document.querySelector('input[name="exportFmt"]:checked') || {}).value || 'pdf';
  const includeBudget = $('exportInclBudget').checked;
  const filtered = sortFindings(applyFilters(findings));
  const rows = selectedIds.size ? filtered.filter(f => selectedIds.has(f.id)) : filtered;
  closeDialog($('exportDlg'));
  if (fmt === 'csv') exportCsv(rows, includeBudget);
  else if (fmt === 'slides') exportSlidesPdf(rows, includeBudget);
  else exportSummaryPdf(rows, includeBudget);
}

export async function buildSummaryPdf(rows, includeBudget) {
  {
    const { jsPDF } = await import('jspdf'); const { default: autoTable } = await import('jspdf-autotable');
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
    await registerGoogleSansFonts(doc); // loads Sarabun (Latin + Thai in one face) under the 'GoogleSans' jsPDF font name — use doc.setFont('GoogleSans', ...) below
    const PW = 297, PH = 210, M = 12; // landscape A4 — extra width for the Map + Photo columns
    const HEADER_H = 13, FOOTER_H = 14;
    const DANGER = '#dc2626';
    const now = new Date();

    // Type scale — consolidated from 7 ad hoc literals (6.5/7/7.5/8/9/10/11) down to named roles.
    const FS_FOOTER_MICRO = 6.5; // footer division-attribution line
    const FS_META = 7;           // small muted text — header subline, empty map/photo notes, Type-column sub-lines
    const FS_LABEL = 7.5;        // footer primary line
    const FS_BODY = 8;           // table body/head text, Type-column finding-type line
    const FS_SUMMARY = 9;        // summary counts line, budget headline
    const FS_TITLE = 10;         // header report title
    const FS_LOGO = 11;          // logo-fallback "OR" lettering
    // Baht for the PDF: the ฿ glyph (U+0E3F) isn't WinAnsi-safe and jsPDF drops it, so use "THB".
    const thb = n => (n == null || !isFinite(n)) ? '—' : 'THB ' + Math.round(n).toLocaleString('en-US');
    const thbNum = n => (n == null || !isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US');
    const logo = (typeof OR_LOGO_DATAURL !== 'undefined' && OR_LOGO_DATAURL) || await fetchAsDataUrl('/RGB_OR_Full color.png', 3000);
    const logoIm = logo ? await loadImg(logo) : null;

    const term = filters.terminal || 'All terminals';
    const stat = filters.status === '__overdue' ? 'Overdue only'
      : filters.status === '__complete' ? 'Complete only'
      : filters.status === '__outstanding' ? 'Outstanding only'
      : (filters.status || 'All statuses');
    const cnt = (s) => rows.filter(f => f.status === s).length;
    const overdue = rows.filter(isOverdue).length;

    // Ensure photoThumbs covers all rows being exported
    const missingPhotoRowIds = rows.filter(f => !photoThumbs[f.id]).map(f => f.id);
    if (missingPhotoRowIds.length) {
      try {
        const { data: phData } = await sb.from('finding_photos')
          .select('finding_id, storage_path, kind, created_at')
          .in('finding_id', missingPhotoRowIds)
          .order('created_at', { ascending: true });
        (phData || []).forEach(p => {
          const cur = photoThumbs[p.finding_id];
          if (!cur || (cur.kind !== 'found' && p.kind === 'found')) photoThumbs[p.finding_id] = p;
        });
      } catch (_) {}
    }

    // Pre-fetch a small map + the earliest "as found" photo per row. autoTable's didDrawCell
    // runs synchronously during table layout, so every async image fetch has to be resolved
    // before doc.autoTable() is called — there is no way to await inside it. One photo only,
    // even if a finding has several (per design: keep each row a fixed, predictable height).
    const MAP_PX = { w: 240, h: 150 };
    const [mapImgs, photoImgs] = await Promise.all([
      Promise.all(rows.map(f => (f.lat != null && f.lng != null) ? composeMapPng(f.lat, f.lng, 16, MAP_PX.w, MAP_PX.h) : null)),
      Promise.all(rows.map(async f => {
        const p = photoThumbs[f.id];
        if (!p) return null;
        const pPath = p.storage_path || p.path;
        if (!pPath) return null;
        const isFullUrl = pPath.startsWith('http://') || pPath.startsWith('https://') || pPath.startsWith('data:');
        let durl = null;
        if (isFullUrl) {
          durl = await fetchAsDataUrl(pPath, 8000);
        } else {
          const primaryUrl = `${R2_UPLOAD_ENDPOINT}/photo?path=${encodeURIComponent(pPath)}`;
          const fallbackUrl = photoUrl(pPath);
          durl = await fetchAsDataUrl(primaryUrl, 8000);
          if (!durl) durl = await fetchAsDataUrl(fallbackUrl, 6000);
        }
        if (!durl) return null;
        const im = await loadImg(durl);
        return im ? { dataUrl: durl, ratio: im.naturalWidth / im.naturalHeight } : null;
      }))
    ]);

    // Same header/footer chrome as the finding & calculator reports, compressed to a shorter
    // band (HEADER_H=13 vs the portrait reports' 18 — this report has no title/date subline
    // worth the extra height, so logo + title share one compact row instead of two).
    function chrome() {
      const textOR = () => { doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LOGO); doc.setTextColor(PDF_NAVY); doc.text('OR', M, 8.5); };
      if (logoIm) { const lh = 7.5, lw = lh * logoIm.naturalWidth / logoIm.naturalHeight; try { doc.addImage(logo, 'PNG', M, 2.5, lw, lh); } catch (_) { textOR(); } }
      else textOR();
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_TITLE); doc.setTextColor(PDF_NAVY);
      doc.text('PIPING FINDINGS SUMMARY', PW - M, 6.5, { align: 'right' });
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_META); doc.setTextColor('#64748b');
      doc.text(`${term}  ·  ${stat}  ·  ${paFmtDate(now)}`, PW - M, 10.5, { align: 'right' });
      doc.setDrawColor(PDF_NAVY); doc.setLineWidth(0.6); doc.line(M, HEADER_H - 1, PW - M, HEADER_H - 1);

      doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2); doc.line(M, PH - FOOTER_H, PW - M, PH - FOOTER_H);
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_LABEL); doc.setTextColor('#64748b');
      doc.text('Piping integrity — findings summary', M, PH - FOOTER_H + 4);
      doc.text(`Page ${doc.internal.getNumberOfPages()} of {tp}`, PW / 2, PH - FOOTER_H + 4, { align: 'center' });
      doc.text(`Generated ${paFmtDateTime(now)}`, PW - M, PH - FOOTER_H + 4, { align: 'right' });
      doc.setFontSize(FS_FOOTER_MICRO); doc.setTextColor('#94a3b8');
      doc.text(['Central and Eastern Engineering and Maintenance Division', 'PTT Oil and Retail Business Public Company Limited'], PW / 2, PH - FOOTER_H + 8, { align: 'center', lineHeightFactor: 1.3 });
      doc.setTextColor(PDF_TEXT);
    }

    chrome();
    let y = HEADER_H + 4;
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_SUMMARY); doc.setTextColor(PDF_TEXT);
    doc.text(`${rows.length} findings   ·   Open ${cnt('Open')}   ·   Monitoring ${cnt('Monitoring')}   ·   Repair Planned ${cnt('Repair Planned')}   ·   Repaired ${cnt('Repaired')}`, M, y);
    if (overdue) { doc.setFont('GoogleSans', 'bold'); doc.setTextColor(DANGER); doc.text(`${overdue} OVERDUE`, PW - M, y, { align: 'right' }); doc.setTextColor(PDF_TEXT); doc.setFont('GoogleSans', 'normal'); }
    y += 6;

    // Budget headline (opt-in) — outstanding = not yet Repaired/Closed, with a severity split.
    if (includeBudget) {
      const out = rows.filter(f => f.status !== 'Repaired' && f.status !== 'Closed');
      const sum = arr => arr.reduce((s, f) => s + (Number(f.estimated_cost) || 0), 0);
      const sev = s => thb(sum(out.filter(f => f.severity === s)));
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_SUMMARY); doc.setTextColor(PDF_NAVY);
      doc.text(`Outstanding repair budget: ${thb(sum(out))}`, M, y);
      doc.setFont('GoogleSans', 'normal'); doc.setTextColor(PDF_MUTED);
      doc.text(`High ${sev('High')}  ·  Medium ${sev('Medium')}  ·  Low ${sev('Low')}`, M + 90, y);
      doc.setTextColor(PDF_TEXT);
      y += 6;
    }

    // Type column carries the finding type plus, on their own wrapped lines, the Location
    // Description and Anomaly Description (when present) — folded in here rather than as two
    // more narrow columns, which would squeeze Map/Photo below a useful size.
    const body = rows.map((f, i) => {
      const typeLines = [f.finding_type];
      // Location is the tag-column label when there's no Line No. yet — don't repeat it here.
      if (f.pipe_tag && f.location_desc) typeLines.push(`Loc: ${f.location_desc}`);
      if (f.description) typeLines.push(`Anomaly: ${f.description}`);
      const cells = [
        String(i + 1), f.terminal, f.pipe_tag || f.location_desc || '—', typeLines.join('\n'), f.status, f.severity || '—',
        (dueDateOf(f) ? paFmtDate(dueDateOf(f)) : '—') + (isOverdue(f) ? '  (OVERDUE)' : ''),
        (ageDays(f) != null ? ageDays(f) + 'd' : '—')
      ];
      if (includeBudget) cells.push(thbNum(f.estimated_cost)); // before Map/Photo (unit in the header)
      cells.push('', ''); // Map, Photo
      return cells;
    });

    // Fit an image into a cell, letterboxed and centered, capped by BOTH the column width and
    // the fixed row height (minCellHeight below) — without this a portrait phone photo would
    // blow the row far taller than its map/text neighbors.
    function drawFitted(dataUrl, format, ratio, cell) {
      const pad = 1.2;
      const availW = cell.width - pad * 2, availH = cell.height - pad * 2;
      let w = availW, h = w / ratio;
      if (h > availH) { h = availH; w = h * ratio; }
      const x = cell.x + (cell.width - w) / 2, y2 = cell.y + (cell.height - h) / 2;
      try { doc.addImage(dataUrl, format, x, y2, w, h); } catch (_) {}
    }
    function drawEmptyNote(text, cell) {
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_META); doc.setTextColor('#94a3b8');
      doc.text(text, cell.x + cell.width / 2, cell.y + cell.height / 2, { align: 'center', baseline: 'middle' });
      doc.setTextColor(PDF_TEXT);
    }

    // With the opt-in Est. Cost column, Map/Photo shift right by one; index everything off that.
    const MAP_COL = includeBudget ? 9 : 8;
    const PHOTO_COL = includeBudget ? 10 : 9;
    const head = ['#', 'Terminal', 'Pipe Tag', 'Type', 'Status', 'Sev.', 'Due', 'Age'];
    if (includeBudget) head.push('Est. Cost (THB)');
    head.push('Map', 'Photo');
    const colStyles = {
      0: { cellWidth: 8, halign: 'right', valign: 'middle' },
      1: { cellWidth: 17, valign: 'middle' },
      2: { cellWidth: 55, fontStyle: 'bold', valign: 'middle' }, // long tags (e.g. 953-P-009-10"-D1101-ET-80) need real room to avoid wrapping to a 2nd line
      4: { cellWidth: 20, valign: 'middle' },
      5: { cellWidth: 18, valign: 'middle' }, // "Medium" needs more room than the other two severities
      6: { cellWidth: 22, valign: 'middle' },
      7: { cellWidth: 11, valign: 'middle' },
      // Map/Photo slightly narrower when budget is on to make room for the Est. Cost column.
      [MAP_COL]: { cellWidth: includeBudget ? 28 : 32 },
      [PHOTO_COL]: { cellWidth: includeBudget ? 28 : 32 }
      // column 3 (Type + Loc/Anomaly sub-lines) is left unset -> autoTable gives it whatever
      // width remains; text is drawn manually in didDrawCell so its own valign doesn't matter.
    };
    if (includeBudget) colStyles[8] = { cellWidth: 22, halign: 'right', valign: 'middle', fontStyle: 'bold' };
    autoTable(doc, {
      startY: y,
      head: [head],
      body,
      theme: 'grid',
      styles: { font: 'GoogleSans', fontSize: FS_BODY, cellPadding: 1.6, lineColor: '#e2e8f0', lineWidth: 0.1, textColor: '#0f172a', overflow: 'linebreak', minCellHeight: 26, valign: 'top' },
      headStyles: { fillColor: PDF_NAVY, textColor: '#ffffff', fontStyle: 'bold', fontSize: FS_BODY, valign: 'middle', cellPadding: { top: 2.2, right: 1.6, bottom: 2.2, left: 1.6 }, minCellHeight: 0 },
      alternateRowStyles: { fillColor: '#f8fafc' },
      columnStyles: colStyles,
      margin: { left: M, right: M, top: HEADER_H + 6, bottom: FOOTER_H + 4 },
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        const f = rows[data.row.index];
        if (data.column.index === 4) { data.cell.styles.textColor = STATUS_COLORS[f.status] || '#334155'; data.cell.styles.fontStyle = 'bold'; }
        if (data.column.index === 6 && isOverdue(f)) { data.cell.styles.textColor = DANGER; data.cell.styles.fontStyle = 'bold'; }
      },
      didDrawCell: (data) => {
        if (data.section !== 'body') return;
        const i = data.row.index;
        if (i < 0 || !rows[i]) return; // autotable fires a spanning row (index -1) at a page break
        if (data.column.index === MAP_COL) {
          const img = mapImgs[i];
          if (img) drawFitted(img, 'JPEG', MAP_PX.w / MAP_PX.h, data.cell);
          else drawEmptyNote('No location', data.cell);
        }
        if (data.column.index === PHOTO_COL) {
          const ph = photoImgs[i];
          if (ph) drawFitted(ph.dataUrl, 'JPEG', ph.ratio, data.cell);
          else drawEmptyNote('No photo', data.cell);
        }
        // Re-draw the Type cell manually: line 1 (finding type) bold/dark, the Loc:/Anomaly:
        // sub-lines muted/smaller — autoTable has no per-line style within one cell.
        if (data.column.index === 3) {
          const f = rows[i];
          const lines = data.cell.text;
          // Use the fill color autoTable itself already computed for this cell (via
          // alternateRowStyles) rather than re-deriving odd/even here — a hand-rolled i%2 can
          // disagree with autoTable's own row parity (e.g. across a page break), which is why
          // the Type column's stripe was drifting out of sync with the rest of the row.
          // Inset the repaint rect by half the grid line width (autoTable centers its border
          // stroke on the cell boundary) so this fill never overpaints the border itself — that
          // was why the Type column's left/right borders looked thinner than every other column's.
          const inset = 0.15;
          doc.setFillColor(data.cell.styles.fillColor || '#ffffff');
          doc.rect(data.cell.x + inset, data.cell.y + inset, data.cell.width - inset * 2, data.cell.height - inset * 2, 'F');
          let ty = data.cell.y + 3.6;
          const tx = data.cell.x + data.cell.styles.cellPadding;
          doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_TEXT);
          doc.text(f.finding_type, tx, ty);
          ty += 3.6;
          doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_META); doc.setTextColor('#64748b');
          lines.slice(1).forEach(line => { doc.text(line, tx, ty); ty += 3.2; });
          doc.setTextColor(PDF_TEXT);
        }
      },
      didDrawPage: () => chrome()
    });

    if (doc.putTotalPages) doc.putTotalPages('{tp}');
    return doc.output('blob');
  }
}

/* ---------------- Inspection Plan PDF (A4 landscape Gantt) ----------------
   The timeline drawn as VECTOR rectangles, not a rasterized image. A Gantt bar is literally a
   rounded rect at a computed offset, and jsPDF draws those natively — so this stays crisp at any
   zoom or print DPI, where a rasterized SVG/HTML capture would blur (the same upscaling problem
   that already bit the slide deck's map tile). It also means no html2canvas dependency and no
   <foreignObject> serialization, neither of which could handle the div-based web Gantt anyway.

   Bar geometry comes from ganttBarGeom() in features/plan.ts — the SAME pure function the web
   renderer uses. The web multiplies its fractions by 100 into '%', this multiplies them by the
   track width in mm. One source of truth, so the printed timeline can never disagree with the
   screen (the same principle as re-deriving numbers through computeB313 rather than trusting a
   saved copy).

   Landscape A4 so twelve months of track get real width. `opts` is built by plan.ts's
   exportPlanPdf: { plans, tasksOf, maintenance, startIdx, months, year, filters }. */
export async function buildPlanPdf(opts) {
  const { monthIndex, monthIndexToLabel, ganttBarGeom } = await import('./plan');
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  await registerGoogleSansFonts(doc); // Sarabun (Latin + Thai in one face) under the 'GoogleSans' name
  const PW = 297, PH = 210, M = 12;
  const HEADER_H = 13, FOOTER_H = 14;
  const now = new Date();

  // Type scale — named roles only; no bare setFontSize() literal appears below (house rule across
  // all PDF builders).
  const FS_FOOTER_MICRO = 6.5; // footer division attribution
  const FS_MICRO = 6.5;        // month ruler labels
  const FS_META = 7;           // header subline, muted notes
  const FS_LABEL = 7.5;        // footer primary line, row labels
  const FS_BODY = 8;           // section headings within the chart
  const FS_TITLE = 10;         // header report title
  const FS_LOGO = 11;          // logo-fallback lettering

  const { plans: planRows, tasksOf, maintenance, startIdx, months, year, filters: pf } = opts;

  const logo = (typeof OR_LOGO_DATAURL !== 'undefined' && OR_LOGO_DATAURL) || await fetchAsDataUrl('/RGB_OR_Full color.png', 3000);
  const logoIm = logo ? await loadImg(logo) : null;

  const scopeBits = [pf && pf.terminal ? pf.terminal : 'All terminals', pf && pf.category ? pf.category : 'All pipe types'];

  function chrome() {
    const textOR = () => { doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LOGO); doc.setTextColor(PDF_NAVY); doc.text('OR', M, 8.5); };
    if (logoIm) { const lh = 7.5, lw = lh * logoIm.naturalWidth / logoIm.naturalHeight; try { doc.addImage(logo, 'PNG', M, 2.5, lw, lh); } catch (_) { textOR(); } }
    else textOR();
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_TITLE); doc.setTextColor(PDF_NAVY);
    doc.text('INSPECTION PLAN — PROGRAMME TIMELINE', PW - M, 6.5, { align: 'right' });
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_META); doc.setTextColor(PDF_MUTED);
    doc.text(`${year}  ·  ${scopeBits.join('  ·  ')}  ·  ${paFmtDate(now)}`, PW - M, 10.5, { align: 'right' });
    doc.setDrawColor(PDF_NAVY); doc.setLineWidth(0.6); doc.line(M, HEADER_H - 1, PW - M, HEADER_H - 1);

    doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2); doc.line(M, PH - FOOTER_H, PW - M, PH - FOOTER_H);
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED);
    doc.text('Piping integrity — inspection programme', M, PH - FOOTER_H + 4);
    doc.text(`Page ${doc.internal.getNumberOfPages()} of {tp}`, PW / 2, PH - FOOTER_H + 4, { align: 'center' });
    doc.text(`Generated ${paFmtDateTime(now)}`, PW - M, PH - FOOTER_H + 4, { align: 'right' });
    doc.setFontSize(FS_FOOTER_MICRO); doc.setTextColor('#94a3b8');
    doc.text(['Central and Eastern Engineering and Maintenance Division', 'PTT Oil and Retail Business Public Company Limited'], PW / 2, PH - FOOTER_H + 8, { align: 'center', lineHeightFactor: 1.3 });
    doc.setTextColor(PDF_TEXT);
  }

  // Chart geometry. The label gutter is fixed so every row's bars start at the same x, exactly
  // like the web's CSS grid template.
  const LABEL_W = 62;
  const trackX = M + LABEL_W;
  const trackW = PW - M - trackX;
  const ROW_H = 7;
  const BAR_H = 2.2;

  chrome();
  let y = HEADER_H + 6;

  function ensure(need) {
    if (y + need <= PH - FOOTER_H - 4) return;
    doc.addPage();
    chrome();
    y = HEADER_H + 6;
    drawMonthRuler();
  }

  // Month ruler + vertical month gridlines behind every row. Redrawn per page so a continued
  // chart still reads.
  function drawMonthRuler() {
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_MICRO); doc.setTextColor(PDF_MUTED);
    for (let i = 0; i < months; i++) {
      const cx = trackX + (i + 0.5) * (trackW / months);
      doc.text(monthIndexToLabel(startIdx + i).replace(' 20', " '"), cx, y, { align: 'center' });
    }
    y += 2;
    doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.15);
    doc.line(trackX, y, trackX + trackW, y);
    y += 3;
    doc.setTextColor(PDF_TEXT);
  }

  function gridlines(rowTop, rowH) {
    doc.setDrawColor('#e2e8f0'); doc.setLineWidth(0.1);
    for (let i = 0; i <= months; i++) {
      const gx = trackX + i * (trackW / months);
      doc.line(gx, rowTop, gx, rowTop + rowH);
    }
  }

  function todayLine(rowTop, rowH) {
    const nowIdx = monthIndex(todayISO());
    if (nowIdx == null || nowIdx < startIdx || nowIdx > startIdx + months - 1) return;
    const nx = trackX + ((nowIdx - startIdx + 0.5) / months) * trackW;
    doc.setDrawColor(PDF_NAVY); doc.setLineWidth(0.3);
    doc.line(nx, rowTop, nx, rowTop + rowH);
  }

  // The one place bar geometry becomes millimetres. Everything else about a bar's position is
  // decided by the shared ganttBarGeom().
  function drawBar(geom, rowTop, offsetY, color, filled) {
    if (!geom) return;
    const x = trackX + geom.startFrac * trackW;
    // Floor the width so a single-month bar is never a hairline at a wide month count.
    const w = Math.max(1.2, geom.widthFrac * trackW);
    if (filled) {
      doc.setFillColor(color);
      doc.roundedRect(x, rowTop + offsetY, w, BAR_H, 0.5, 0.5, 'F');
    } else {
      doc.setDrawColor(color); doc.setLineWidth(0.3);
      doc.roundedRect(x, rowTop + offsetY, w, BAR_H, 0.5, 0.5, 'S');
    }
  }

  drawMonthRuler();

  const showInsp = !!(planRows && planRows.length);
  if (showInsp) {
    planRows.forEach(p => {
      const tasks = tasksOf(p.id) || [];
      if (!tasks.length) return;
      ensure(ROW_H * 2);
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_NAVY);
      const head = [p.name, p.terminal, p.pipe_category].filter(Boolean).join('  ·  ');
      doc.text(head, M, y + 3);
      y += 5.5;
      doc.setTextColor(PDF_TEXT);

      tasks.forEach(t => {
        ensure(ROW_H);
        const rowTop = y;
        gridlines(rowTop, ROW_H - 1);
        todayLine(rowTop, ROW_H - 1);

        doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_TEXT);
        // splitTextToSize measures against the ACTIVE font — set it first, or Thai task names
        // mis-measure and can render blank (a real bug this project has hit before).
        const label = doc.splitTextToSize(String(t.task_name || ''), LABEL_W - 3)[0] || '';
        doc.text(label, M, rowTop + 3.6);

        const color = PLAN_TASK_COLORS[t.status] || '#2563eb';
        drawBar(ganttBarGeom(t.plan_start, t.plan_end, startIdx, months), rowTop, 0.8, color, false);
        drawBar(ganttBarGeom(t.actual_start, t.actual_end, startIdx, months), rowTop, 3.6, color, true);
        y += ROW_H;
      });
    });
  }

  if (maintenance && maintenance.length) {
    ensure(ROW_H * 2);
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_NAVY);
    doc.text("Maintenance — from findings' due dates", M, y + 3);
    y += 5.5;
    doc.setTextColor(PDF_TEXT);

    maintenance.forEach(({ f, due }) => {
      ensure(ROW_H);
      const rowTop = y;
      gridlines(rowTop, ROW_H - 1);
      todayLine(rowTop, ROW_H - 1);

      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_TEXT);
      const name = f.pipe_tag || f.location_desc || '—';
      const label = doc.splitTextToSize(String(name), LABEL_W - 3)[0] || '';
      doc.text(label, M, rowTop + 3.6);

      const color = STATUS_COLORS[f.status] || '#dc2626';
      const geom = ganttBarGeom(due, due, startIdx, months);
      if (geom) {
        const x = trackX + geom.startFrac * trackW;
        const w = Math.max(1.2, geom.widthFrac * trackW);
        doc.setFillColor(color);
        doc.roundedRect(x, rowTop + 2.2, w, BAR_H, 0.5, 0.5, 'F');
        if (isOverdue(f)) {
          // Overdue reads as a heavier outline around the block — dashed strokes are unreliable
          // across PDF viewers, so weight carries the distinction instead of a dash pattern.
          doc.setDrawColor(PDF_DANGER); doc.setLineWidth(0.5);
          doc.roundedRect(x - 0.3, rowTop + 1.9, w + 0.6, BAR_H + 0.6, 0.6, 0.6, 'S');
        }
      }
      y += ROW_H;
    });
  }

  // Legend — mirrors the web panel's, so the two read the same way.
  ensure(12);
  y += 3;
  doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
  doc.line(M, y, PW - M, y);
  y += 4;
  const legend = [
    { label: 'Planned', color: '#2563eb', filled: false },
    { label: 'Actual', color: '#2563eb', filled: true },
    { label: 'Maintenance due', color: PDF_DANGER, filled: true },
  ];
  let lx = M;
  doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_META); doc.setTextColor(PDF_MUTED);
  legend.forEach(item => {
    if (item.filled) { doc.setFillColor(item.color); doc.roundedRect(lx, y - 1.8, 6, 2.2, 0.5, 0.5, 'F'); }
    else { doc.setDrawColor(item.color); doc.setLineWidth(0.3); doc.roundedRect(lx, y - 1.8, 6, 2.2, 0.5, 0.5, 'S'); }
    doc.text(item.label, lx + 7.5, y);
    lx += 7.5 + doc.getTextWidth(item.label) + 8;
  });
  doc.setTextColor(PDF_TEXT);
  y += 7;

  ensure(10);
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_FOOTER_MICRO); doc.setTextColor(PDF_MUTED);
  doc.text('System-generated record via Pipe Assessor — paperless piping-integrity system. No physical signature required.', M, y);
  y += 3.6;
  doc.text(`Maintenance bars are derived from findings' due dates and are not editable in the plan  ·  Generated ${paFmtDateTime(now)}`, M, y);
  doc.setTextColor(PDF_TEXT);
  y += 6;

  ensure(10);
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(FS_LABEL); doc.setTextColor('#94a3b8');
  doc.text('— End of Report —', PW / 2, y, { align: 'center' });

  if (doc.putTotalPages) doc.putTotalPages('{tp}');

  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return blob;
}

/* ---------------- Presentation slides PDF (one finding per 16:9 page) ----------------
   A slide deck for meetings / risk reviews: each finding fills one full 16:9 page sized to the
   exact PowerPoint Widescreen canvas (338.67 x 190.5 mm = 13.333 x 7.5 in), so a page drops onto
   a slide with no letterboxing. Web-UI look, not a document: a full-width integrity health banner
   (shared resolveIntegrityBanner — same wording/color as the detail page + finding PDF) over a
   3-column card layout — FINDING DETAILS / SITE EVIDENCE / ASME B31.3 ASSESSMENT. Only the info a
   reviewer needs; NO full Repair Advisor, just one derived recommended-action line
   (resolveAdvisor(...).summary). Single- or multi-finding — one page per row, in the caller's
   (risk-ordered) row order. */
export async function exportSlidesPdf(rows, includeBudget) {
  if (!rows || !rows.length) { notify('No findings to present with the current filters.', true); return; }
  const btn = $('btnExport');
  setBusy(btn, true, 'Building…');
  try {
    const blob = await buildSlidesPdf(rows, includeBudget);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    notify('Presentation PDF failed: ' + e.message, true);
  } finally {
    setBusy(btn, false);
  }
}

export async function buildSlidesPdf(rows, includeBudget) {
  const { jsPDF } = await import('jspdf');
  // 16:9 PowerPoint Widescreen canvas in mm — pass explicit [w, h] so pages are exactly slide-sized.
  const PW = 338.67, PH = 190.5;
  const doc = new jsPDF({ unit: 'mm', format: [PW, PH], orientation: 'landscape' });
  await registerGoogleSansFonts(doc); // Sarabun (Latin + Thai in one face) under the 'GoogleSans' jsPDF font name
  const M = 10, CW = PW - 2 * M;
  const HEADER_H = 16, FOOTER_H = 11; // taller than a document header/footer — bigger logo/text for a projected slide
  const now = new Date();

  // Type scale — was ~18 near-duplicate ad hoc sizes (6.2/6.6/7/7.2/7.3/7.4/7.5/7.6/8/8.2/9/9.5/…)
  // accumulated across several rounds of "make it bigger" edits; consolidated to 7 named sizes so
  // every future adjustment is a single deliberate change instead of hunting down which of five
  // near-identical numbers a given label happens to use.
  const FS_MICRO = 6.6;      // smallest — tile sub-notes (PASS/CHECK captions)
  const FS_LABEL = 7.4;      // uppercase muted field labels / section eyebrows
  const FS_BODY = 8;         // body text — description, 2-col kv values, footer primary line
  const FS_VALUE = 9.8;      // emphasized values — kv row values, card titles, header muted line
  const FS_SUB = 11;         // banner sub-line, not-assessed fallback headline
  const FS_TILE_VALUE = 12.5;// metric tile big numbers (ERF/MAWP/%/life) — its own scale, reads as a stat not text
  const FS_TITLE = 14.5;     // header title, banner identity label
  const FS_HERO = 16;        // banner word, logo fallback "OR"
  const thb = n => (n == null || !isFinite(n)) ? '—' : 'THB ' + Math.round(n).toLocaleString('en-US');

  const logo = (typeof OR_LOGO_DATAURL !== 'undefined' && OR_LOGO_DATAURL) || await fetchAsDataUrl('/RGB_OR_Full color.png', 3000);
  const logoIm = logo ? await loadImg(logo) : null;

  // --- Bulk pre-load per-finding data (never per-page fetching inside the draw loop) ---
  const ids = rows.map(f => f.id);
  // latest assessment per finding (mirrors risk.ts's single bulk load, kept newest per finding_id)
  const assessByFinding = {};
  try {
    const { data: aData } = await sb.from('assessments')
      .select('finding_id, inputs, results, created_at')
      .in('finding_id', ids)
      .order('created_at', { ascending: false });
    (aData || []).forEach(a => { if (!assessByFinding[a.finding_id]) assessByFinding[a.finding_id] = a; });
  } catch (_) {}
  // earliest as-found photo per finding (prefer kind 'found', else whatever exists)
  const photoByFinding = {};
  try {
    const { data: pData } = await sb.from('finding_photos')
      .select('finding_id, storage_path, kind, created_at')
      .in('finding_id', ids)
      .order('created_at', { ascending: true });
    (pData || []).forEach(p => {
      const cur = photoByFinding[p.finding_id];
      const isFound = (p.kind || 'found').toLowerCase().trim() === 'found';
      if (!cur || (cur.kind !== 'found' && isFound)) photoByFinding[p.finding_id] = p;
    });
  } catch (_) {}

  // Map framing tuned to match the finding detail page (its Leaflet map uses zoom 17 in a ~550px
  // container -> ~640 m across). Rendering at zoom 18 with ~2x the pixels reproduces that same
  // site-level framing while staying crisp on the ~96mm slide tile (~290 dpi) — the old zoom 17 at
  // 1000px covered ~1.8x more ground, reading zoomed-out vs. the detail page.
  const MAP_ZOOM = 18;
  const MAP_PX = { w: 1100, h: 700 };
  const perRow = await Promise.all(rows.map(async f => {
    const a = assessByFinding[f.id];
    const res = a ? resFromSnapshot(a) : null;
    const [mapImg, xsec, photo] = await Promise.all([
      (f.lat != null && f.lng != null) ? composeMapPng(f.lat, f.lng, MAP_ZOOM, MAP_PX.w, MAP_PX.h) : Promise.resolve(null),
      // scale 3 (was 2): the source SVG's labels are baked in at a fixed size relative to its
      // 500x270 viewBox, so a low raster scale left them mushy once the figure was drawn large in
      // the slide — bump the source resolution to match the bigger on-slide figH below.
      res ? paCrossSectionPng(res, 3).catch(() => null) : Promise.resolve(null),
      (async () => {
        const p = photoByFinding[f.id];
        const pPath = p && (p.storage_path || p.path);
        if (!pPath) return null;
        const isFullUrl = pPath.startsWith('http://') || pPath.startsWith('https://') || pPath.startsWith('data:');
        let durl = null;
        if (isFullUrl) durl = await fetchAsDataUrl(pPath, 8000);
        else {
          durl = await fetchAsDataUrl(`${R2_UPLOAD_ENDPOINT}/photo?path=${encodeURIComponent(pPath)}`, 8000);
          if (!durl) durl = await fetchAsDataUrl(photoUrl(pPath), 6000);
        }
        if (!durl) return null;
        const im = await loadImg(durl);
        return im ? { src: durl, ratio: im.naturalWidth / im.naturalHeight } : null;
      })()
    ]);
    let xsecRatio = 500 / 270;
    if (xsec) { const xi = await loadImg(xsec); if (xi && xi.naturalWidth) xsecRatio = xi.naturalWidth / xi.naturalHeight; }
    return { res, inputs: a ? a.inputs : null, mapImg, xsec, xsecRatio, photo };
  }));

  // ---- shared draw helpers ----
  const fmt2 = n => (n == null || !isFinite(n)) ? '—' : n.toFixed(2);
  const fmt3 = n => (n == null || !isFinite(n)) ? '—' : n.toFixed(3);

  // Web design tokens (theme.css) so the slide reads as the actual app UI, not a document:
  const PAGE_BG = '#f8fafc';    // --bg-color (app canvas behind the white cards)
  const CARD = '#ffffff';       // --card-bg
  const CARD_BORDER = '#e2e8f0';// --card-border
  const SOFT = '#f8fafc';       // tile / soft-fill background
  const HDR_A = '#156B95', HDR_B = '#38bdf8'; // --header-accent -> --header-accent-2 (the app's accent bar gradient)

  // hex lerp + a horizontal gradient bar reproducing the app header's teal->sky .header-accent-bar
  const lerpHex = (a, b, t) => {
    const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
    const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
    const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
    return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  };
  const accentBar = (bx, by, bw, bh) => {
    const n = 48;
    for (let i = 0; i < n; i++) { doc.setFillColor(lerpHex(HDR_A, HDR_B, i / (n - 1))); doc.rect(bx + (bw * i) / n, by, bw / n + 0.25, bh, 'F'); }
  };

  // letterbox-fit an image inside a box, centered, on a light backing
  // Contain-fit, no backing fill AND no frame — the image floats directly on the card's own white,
  // so an image narrower than its box (like the cross-section, which has its own margins baked into
  // the source SVG) never reads as sitting inside a separate panel.
  const drawFit = (dataUrl, ratio, bx, by, bw, bh) => {
    if (!dataUrl) {
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_BODY); doc.setTextColor('#94a3b8');
      doc.text('—', bx + bw / 2, by + bh / 2, { align: 'center', baseline: 'middle' });
      doc.setTextColor(PDF_TEXT);
      return;
    }
    const pad = 1.2;
    const availW = bw - pad * 2, availH = bh - pad * 2;
    let w = availW, h = w / ratio;
    if (h > availH) { h = availH; w = h * ratio; }
    const ix = bx + (bw - w) / 2, iy = by + (bh - h) / 2;
    try { doc.addImage(dataUrl, 'JPEG', ix, iy, w, h); } catch (_) { try { doc.addImage(dataUrl, 'PNG', ix, iy, w, h); } catch (__) {} }
  };
  const emptyBox = (label, bx, by, bw, bh) => {
    doc.setFillColor('#f8fafc'); doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
    doc.roundedRect(bx, by, bw, bh, 1.4, 1.4, 'FD');
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_BODY); doc.setTextColor('#94a3b8');
    doc.text(label, bx + bw / 2, by + bh / 2, { align: 'center', baseline: 'middle' });
    doc.setTextColor(PDF_TEXT);
  };
  // "cover"-fit an image so it FILLS the whole box (no letterbox gap / grey backing — matches the web
  // map + photo tiles): scale to cover, center, and clip the overflow to the box's rounded rect.
  // Photos/maps use this; the cross-section diagram keeps drawFit (contain) so its labels aren't cropped.
  const drawCover = (dataUrl, ratio, bx, by, bw, bh, label) => {
    if (!dataUrl) { emptyBox(label || '—', bx, by, bw, bh); return; }
    const r = ratio || 1, boxR = bw / bh;
    let dw, dh;
    if (r > boxR) { dh = bh; dw = bh * r; } else { dw = bw; dh = bw / r; } // cover
    const ix = bx - (dw - bw) / 2, iy = by - (dh - bh) / 2;
    doc.saveGraphicsState();
    doc.roundedRect(bx, by, bw, bh, 1.6, 1.6, null); // path only (null style) -> clip region
    doc.clip(); doc.discardPath();
    try { doc.addImage(dataUrl, 'JPEG', ix, iy, dw, dh); } catch (_) { try { doc.addImage(dataUrl, 'PNG', ix, iy, dw, dh); } catch (__) {} }
    doc.restoreGraphicsState();
    doc.setDrawColor(CARD_BORDER); doc.setLineWidth(0.2); doc.roundedRect(bx, by, bw, bh, 1.6, 1.6, 'S'); // hairline frame
  };
  // .panel-style card: white body, 8px-ish rounded corners, hairline border, and a light header row
  // (dark uppercase title + a small navy accent tick + a bottom hairline) — mirrors theme.css's
  // .panel / .panel-h exactly, instead of a solid navy strip. Returns the inner-content top y.
  const card = (x, y, w, h, title) => {
    doc.setFillColor(CARD); doc.setDrawColor(CARD_BORDER); doc.setLineWidth(0.3);
    doc.roundedRect(x, y, w, h, 2, 2, 'FD');
    const hHead = 10.5;
    doc.setFillColor(PDF_NAVY);
    doc.roundedRect(x + 3.6, y + hHead / 2 - 2, 1.8, 4, 0.6, 0.6, 'F'); // accent tick
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_VALUE); doc.setTextColor(PDF_TEXT);
    doc.text(String(title).toUpperCase(), x + 7.2, y + hHead / 2 + 1.6);
    doc.setDrawColor(CARD_BORDER); doc.setLineWidth(0.3);
    doc.line(x, y + hHead, x + w, y + hHead); // .panel-h border-bottom
    doc.setTextColor(PDF_TEXT);
    return y + hHead;
  };

  // per-status light-tint / spine / text palette for the recommended-action callout, keyed off the
  // shared banner state (resolveIntegrityBanner's `key`) so the slide's action strip matches its
  // banner color language. Keys mirror the resolver exactly: leaking/repair/monitor/ok/pending/none.
  const ACTION_THEME = {
    leaking: { tint: '#fef2f2', spine: '#b91c1c', text: '#b91c1c' },
    repair:  { tint: '#fef2f2', spine: '#b91c1c', text: '#b91c1c' },
    monitor: { tint: '#fffbeb', spine: '#b45309', text: '#b45309' },
    ok:      { tint: '#ecfdf5', spine: '#047857', text: '#15803d' },
    pending: { tint: '#f1f5f9', spine: '#475569', text: '#475569' },
    none:    { tint: '#f1f5f9', spine: '#475569', text: '#475569' },
  };

  rows.forEach((f, idx) => {
    if (idx > 0) doc.addPage([PW, PH], 'landscape');
    const { res, inputs, mapImg, xsec, xsecRatio, photo } = perRow[idx];
    const hb = resolveIntegrityBanner(f, res);
    const theme = ACTION_THEME[hb.key] || ACTION_THEME.none;
    // DOC REF + Record ID (same scheme as the finding PDF's title block / record footnote)
    const reportRef = `PA-RPT-${docRefSlug(f.pipe_tag || f.location_desc || (f.id || '').slice(0, 8))}`;
    const recordId = `PA-${f.id}`;

    // ---- page canvas: the app's --bg-color behind the white cards + a white app-header band ----
    doc.setFillColor(PAGE_BG); doc.rect(0, 0, PW, PH, 'F');
    doc.setFillColor('#ffffff'); doc.rect(0, 0, PW, HEADER_H, 'F');

    // ---- header chrome (company logo left, title right, teal->sky accent bar) ----
    // Logo + header text sized up (this is a projected slide, not an A4 document — the original
    // document-scale sizes read too small on a screen/projector) to roughly fill the taller HEADER_H.
    const textOR = () => { doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_HERO); doc.setTextColor(PDF_NAVY); doc.text('OR', M, 11); };
    if (logoIm) { const lh = 11, lw = lh * logoIm.naturalWidth / logoIm.naturalHeight; try { doc.addImage(logo, 'PNG', M, 2.6, lw, lh); } catch (_) { textOR(); } }
    else textOR();
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_TITLE); doc.setTextColor(PDF_NAVY);
    doc.text('PIPING FINDING', PW - M, 8, { align: 'right' });
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_VALUE); doc.setTextColor(PDF_MUTED);
    doc.text(`${f.terminal || '—'}  ·  ${paFmtDate(now)}`, PW - M, 13, { align: 'right' });
    accentBar(0, HEADER_H, PW, 1.4); // the app header's .header-accent-bar (teal -> sky)

    // ---- integrity health banner (the hero — rounded, left spine, white text: matches .health-banner) ----
    // Line text wraps to up to 2 lines (not truncated to 1) — the OK-status line in particular runs
    // long ("...continue corrosion mitigation per the Repair Advisor") and was clipping mid-sentence
    // at a fixed 1-line height; the band grows a bit taller when a 2nd line is actually needed.
    const bandR = 1.8;
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_SUB);
    const hbLines = doc.splitTextToSize(hb.line, CW - 130).slice(0, 2);
    const bandY = HEADER_H + 4;
    const bandH = hbLines.length > 1 ? 24 : 20;
    doc.setFillColor(hb.fill); doc.roundedRect(M, bandY, CW, bandH, bandR, bandR, 'F');
    doc.setFillColor(hb.spine); doc.rect(M, bandY + bandR, 1.8, bandH - bandR * 2, 'F');
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_HERO); doc.setTextColor('#ffffff');
    doc.text(hb.word, M + 7, bandY + 9.5);
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_SUB); doc.setTextColor('#f1f5f9');
    hbLines.forEach((line, i) => doc.text(line, M + 7, bandY + 16 + i * 4.6));
    // finding identity on the banner's right, plus ERF/MAWP/%wall metrics when assessed
    const bandLabel = f.pipe_tag || f.location_desc || '—';
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_TITLE); doc.setTextColor('#ffffff');
    doc.text(doc.splitTextToSize(bandLabel, 100)[0], PW - M - 7, bandY + 8.5, { align: 'right' });
    if (hb.metrics) {
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_VALUE); doc.setTextColor('#f1f5f9');
      doc.text(`ERF ${hb.metrics.erf}  ·  MAWP ${hb.metrics.mawp}  ·  ${hb.metrics.pct}% wall`, PW - M - 7, bandY + 15.5, { align: 'right' });
    } else {
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_VALUE); doc.setTextColor('#f1f5f9');
      doc.text(`${f.finding_type || 'Uncategorised'}  ·  ${f.severity || '—'} severity`, PW - M - 7, bandY + 15.5, { align: 'right' });
    }

    // ---- 3-column card grid ----
    const gTop = bandY + bandH + 3.5;
    const gBottom = PH - FOOTER_H - 2.5;
    const gH = gBottom - gTop;
    const gGap = 4.5;
    const colW = (CW - gGap * 2) / 3;
    const x1 = M, x2 = M + colW + gGap, x3 = M + (colW + gGap) * 2;

    /* ===== Card 1 — FINDING DETAILS ===== */
    {
      let cy = card(x1, gTop, colW, gH, 'Finding Details') + 4;
      const padX = 4;
      const labelW = 32;
      const valX = x1 + padX + labelW;
      const valW = colW - padX * 2 - labelW;
      const rh = 7.5;
      const kv = (label, value, opts) => {
        opts = opts || {};
        doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED);
        doc.text(String(label).toUpperCase(), x1 + padX, cy + 2.9);
        let vx = valX;
        if (opts.swatch) { doc.setFillColor(opts.swatch); doc.circle(valX + 1.7, cy + 1.7, 1.7, 'F'); vx = valX + 5.2; }
        doc.setFont('GoogleSans', opts.bold ? 'bold' : 'normal'); doc.setFontSize(opts.fs || FS_VALUE);
        doc.setTextColor(opts.color || PDF_TEXT);
        const v = (value == null || value === '') ? '—' : String(value);
        doc.text(doc.splitTextToSize(v, valW - (vx - valX))[0], vx, cy + 2.9);
        if (opts.tag) {
          doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_DANGER);
          doc.text(opts.tag, x1 + colW - padX, cy + 2.9, { align: 'right' });
        }
        doc.setDrawColor('#eef2f7'); doc.setLineWidth(0.15);
        doc.line(x1 + padX, cy + rh - 2.2, x1 + colW - padX, cy + rh - 2.2);
        cy += rh;
      };
      // Line Tag is the one row emphasized a step above FS_VALUE — it's the slide's primary identity line.
      kv('Line Tag / No.', f.pipe_tag || f.location_desc || '—', { bold: true, fs: FS_TILE_VALUE - 2 });
      kv('Terminal', f.terminal || '—');
      kv('Location', f.location_desc || '—');
      kv('P&ID', f.pid_no || '—');
      kv('Service / Fluid', f.service || '—');
      kv('Finding Type', f.finding_type || '—');
      kv('Severity', f.severity || '—', { swatch: SEVERITY_HEX(f.severity), bold: true });
      // Status text stays plain dark (like every other row) — only the swatch dot carries the status
      // color. Coloring the text itself (e.g. red "OPEN") read as an alarm competing with the
      // banner's own color language, especially jarring on an otherwise-green OK-severity card.
      kv('Status', (f.status || '—').toUpperCase(), { swatch: STATUS_COLORS[f.status] || PDF_MUTED, bold: true, tag: isOverdue(f) ? 'OVERDUE' : '' });
      kv('Active Leak', f.is_leaking ? 'Yes — boundary breached' : 'No', { color: f.is_leaking ? PDF_DANGER : PDF_TEXT, bold: !!f.is_leaking });
      kv('Inspected', paFmtDate(f.inspection_date));
      kv('Target / Due', (dueDateOf(f) ? paFmtDate(dueDateOf(f)) : '—'), { color: isOverdue(f) ? PDF_DANGER : PDF_TEXT });
      if (includeBudget) kv('Est. Cost', thb(f.estimated_cost));
      kv('Recorded By', f.created_by_email || '—', { fs: FS_BODY });

      // finding Description — fills the remaining card height. NOTE: gH/gTop here reflect
      // per-row banner height (bandH is 20 or 24 depending on whether hb.line wrapped to 2 lines —
      // see the banner block above), so this budget is already correct for either case; it was NOT
      // originally re-verified against the 2-line-banner case specifically, which silently zeroed
      // out the description on any OK-status finding (a long hb.line + 13 kv rows left no room) —
      // caught by rendering both cases live, not by the arithmetic alone.
      cy += 1.2;
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED);
      doc.text('DESCRIPTION', x1 + padX, cy); cy += 3.8;
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_TEXT);
      const dcLimit = (gTop + gH - 3.5) - cy;
      doc.splitTextToSize(f.description ? String(f.description) : 'No anomaly description recorded.', colW - padX * 2)
        .slice(0, Math.max(0, Math.floor(dcLimit / 3.8)))
        .forEach(l => { doc.text(l, x1 + padX, cy); cy += 3.8; });
    }

    /* ===== Card 2 — SITE EVIDENCE (photo + location + description; cross-section moved to Card 3) ===== */
    {
      let cy = card(x2, gTop, colW, gH, 'Site Evidence') + 3;
      const padX = 3.5;
      const innerW = colW - padX * 2;
      // large as-found photo — cover-fit (fills the box, no grey letterbox — like the web tile)
      const photoH = 56;
      drawCover(photo ? photo.src : null, photo ? photo.ratio : 1, x2 + padX, cy, innerW, photoH, 'No site photo');
      cy += photoH + 3.4;
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED);
      doc.text('AS-FOUND PHOTO', x2 + padX + 0.5, cy); cy += 4.2;
      // location map — cover-fit, now expanded to fill ALL remaining card height (description moved
      // to Finding Details), so the aerial reads large and crisp for a projected slide.
      const mapTop = cy;
      const mapH = (gTop + gH - 3.5 - 4) - mapTop; // leave room for the LOCATION label below
      drawCover(mapImg, MAP_PX.w / MAP_PX.h, x2 + padX, mapTop, innerW, mapH, 'No location on record');
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED);
      doc.text('LOCATION', x2 + padX + 0.5, mapTop + mapH + 3.2);
      doc.setTextColor(PDF_TEXT);
    }

    /* ===== Card 3 — ASME B31.3 ASSESSMENT ===== */
    {
      let cy = card(x3, gTop, colW, gH, 'ASME B31.3 Assessment') + 3.4;
      const padX = 3.5;
      const innerW = colW - padX * 2;
      const tile = (tx, ty, tw, th, label, value, note, valColor) => {
        doc.setFillColor(SOFT); doc.setDrawColor(CARD_BORDER); doc.setLineWidth(0.2);
        doc.roundedRect(tx, ty, tw, th, 1.4, 1.4, 'FD');
        doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_MICRO); doc.setTextColor(PDF_MUTED);
        doc.text(String(label).toUpperCase(), tx + 2.6, ty + 3.8);
        doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_TILE_VALUE); doc.setTextColor(valColor || PDF_TEXT);
        doc.text(String(value), tx + 2.6, ty + 10);
        if (note) { doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_MICRO); doc.setTextColor(PDF_MUTED); doc.text(String(note), tx + 2.6, ty + 13.4); }
        doc.setTextColor(PDF_TEXT);
      };
      // sub-section label helper (muted uppercase eyebrow). Adds a small gap *before* drawing, not
      // just after — otherwise a preceding tile/box's bottom edge sits flush against this label's
      // text baseline (baseline sits near the glyph's own bottom, so with no lead-in gap the label
      // reads as jammed against the box above it).
      const eyebrow = (label) => { cy += 1.6; doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED); doc.text(label, x3 + padX, cy); cy += 4.3; doc.setTextColor(PDF_TEXT); };
      // 2-column label/value row (two metrics per line to pack the engineering numbers densely)
      const half = innerW / 2;
      const kv2 = (ry, col, label, val, valColor) => {
        const bx = x3 + padX + (col ? half : 0);
        doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED);
        doc.text(label, bx, ry);
        doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_BODY); doc.setTextColor(valColor || PDF_TEXT);
        doc.text(String(val), bx + 24, ry);
        doc.setTextColor(PDF_TEXT);
      };
      const defect = (f.defect_length_mm != null || f.defect_width_mm != null) ? `${f.defect_length_mm ?? '—'} x ${f.defect_width_mm ?? '—'} mm` : '—';

      if (res) {
        const erf = res.mawp_no > 0 ? (res.P_input / res.mawp_no) : 9.99;
        const erfCa = (res.mawp_with != null && res.mawp_with > 0) ? (res.P_input / res.mawp_with) : null;

        // 1. wall cross-section figure (moved here from Site Evidence) — enlarged so its baked-in
        // SVG labels (Metal Loss Depth / t_req / t_struct / t_meas etc.) read clearly on a
        // projected slide; paired with the scale-3 raster above for a crisp source at this size.
        const figH = 35.5;
        drawFit(xsec, xsecRatio, x3 + padX, cy, innerW, figH);
        cy += figH + 2.6;

        // 2. pipe & design basis setup line — NPS/Sch/Material/OD, design temp, and corrosion
        // mechanism all on one line (freed by dropping the "WALL CROSS-SECTION" eyebrow above) so
        // the assessment card keeps more vertical room for the metric tiles/grids below.
        const setupBits = [
          `NPS ${inputs?.nps ?? '—'}`, `Sch ${inputs?.schedule ?? '—'}`,
          (materialName(inputs?.material) || inputs?.material || '—'),
          `OD ${fmt2(res.D)} mm`,
          inputs?.design_temp ? `${inputs.design_temp} C` : null,
          res.isInternal ? 'Internal corr.' : 'External corr.'
        ].filter(Boolean).join('  ·  ');
        doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED);
        doc.text(setupBits, x3 + padX, cy); cy += 3.7;
        doc.setTextColor(PDF_TEXT); cy += 0.6;

        // 3. headline metric tiles
        const tileW = (innerW - 3) / 2, tileH = 14.5, tGap = 2;
        const life = res.remainingLife != null ? (res.remainingLife >= 0 ? `${fmt2(res.remainingLife)}y` : '0y') : '—';
        tile(x3 + padX, cy, tileW, tileH, 'ERF (no CA)', fmt3(erf), erf <= 1 ? 'PASS  (<= 1.0)' : 'CHECK  (> 1.0)', erf <= 1 ? PDF_OK : PDF_DANGER);
        tile(x3 + padX + tileW + tGap, cy, tileW, tileH, 'MAWP (no CA)', `${fmt2(res.mawp_no)}`, `${res.pUnit} · P ${fmt2(res.P_input)}`, res.mawp_no >= res.P_input ? PDF_OK : PDF_DANGER);
        cy += tileH + tGap;
        tile(x3 + padX, cy, tileW, tileH, '% Wall Remaining', `${(res.pctRemainNom == null ? '—' : res.pctRemainNom.toFixed(0))}%`, res.pctRemainNom >= 50 ? 'PASS  (>= 50%)' : 'CHECK  (< 50%)', res.pctRemainNom >= 50 ? PDF_OK : PDF_WARN);
        tile(x3 + padX + tileW + tGap, cy, tileW, tileH, 'Remaining Life', life, res.CR > 0 ? `at ${fmt3(res.CR)} mm/yr` : 'no CR trend', (res.remainingLife != null && res.remainingLife <= 0) ? PDF_DANGER : PDF_TEXT);
        cy += tileH + tGap + 0.6;

        // 4. wall thickness & flaw geometry (two columns, mm)
        eyebrow('WALL THICKNESS & FLAW (mm)');
        kv2(cy, 0, 'Nominal t_nom', fmt2(res.t_nom)); kv2(cy, 1, 'Required t_req', fmt2(res.t_req_noCA)); cy += 4;
        kv2(cy, 0, 'Measured t_meas', fmt2(res.t_meas)); kv2(cy, 1, 'Req + CA', fmt2(res.t_req_total), res.margin >= 0 ? PDF_OK : PDF_DANGER); cy += 4;
        kv2(cy, 0, 'Wall loss', fmt2(res.depth)); kv2(cy, 1, 'Struct min', fmt2(res.t_struct), res.t_meas >= res.t_struct ? PDF_OK : PDF_DANGER); cy += 4;
        kv2(cy, 0, 'Flaw L x W', defect); kv2(cy, 1, 'Margin', `${fmt2(res.margin)}`, res.margin >= 0 ? PDF_OK : PDF_DANGER); cy += 4.6;

        // 5. design basis (pressure / corrosion inputs)
        eyebrow('DESIGN BASIS');
        kv2(cy, 0, 'Design P', `${fmt2(res.P_input)} ${res.pUnit}`); kv2(cy, 1, 'Allow. S', `${fmt2(res.S)} MPa`); cy += 4;
        kv2(cy, 0, 'Corr. allow CA', `${fmt2(res.ca)} mm`); kv2(cy, 1, 'Corr. rate', res.CR > 0 ? `${fmt3(res.CR)} mm/yr` : '—'); cy += 4;
        kv2(cy, 0, 'MAWP w/ CA', res.mawp_with == null ? 'n/a' : `${fmt2(res.mawp_with)} ${res.pUnit}`); kv2(cy, 1, 'ERF w/ CA', erfCa == null ? 'n/a' : fmt3(erfCa), erfCa == null ? PDF_TEXT : (erfCa <= 1 ? PDF_OK : PDF_DANGER)); cy += 4;
      } else {
        // no numeric assessment — say why (from the shared banner state), don't fake a verdict
        doc.setFillColor(theme.tint); doc.setDrawColor(theme.spine); doc.setLineWidth(0.2);
        doc.roundedRect(x3 + padX, cy, innerW, 17, 1.4, 1.4, 'FD');
        doc.setFillColor(theme.spine); doc.rect(x3 + padX, cy, 1.8, 17, 'F');
        doc.setFont('GoogleSans', 'bold'); doc.setFontSize(FS_VALUE); doc.setTextColor(theme.text);
        doc.text(hb.word, x3 + padX + 4, cy + 6);
        doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_TEXT);
        doc.splitTextToSize(hb.line, innerW - 7).slice(0, 2).forEach((line, i) => doc.text(line, x3 + padX + 4, cy + 11 + i * 3.8));
        cy += 17 + 5.5;
        eyebrow('FLAW GEOMETRY');
        kv2(cy, 0, 'Flaw L x W', defect); kv2(cy, 1, 'Finding type', f.finding_type || '—'); cy += 5;
        doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_LABEL); doc.setTextColor(PDF_MUTED);
        doc.splitTextToSize('No ASME B31.3 wall-loss calculation applies until a UT reading is recorded (or the finding type is a wall-loss mechanism).', innerW).slice(0, 3).forEach(l => { doc.text(l, x3 + padX, cy); cy += 3.9; });
        doc.setTextColor(PDF_TEXT);
      }
    }

    // ---- footer (DOC REF + Record ID, same identifiers as the finding PDF) ----
    doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2); doc.line(M, PH - FOOTER_H, PW - M, PH - FOOTER_H);
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(FS_BODY); doc.setTextColor(PDF_MUTED);
    doc.text(`DOC REF  ${reportRef}`, M, PH - FOOTER_H + 4.4);
    doc.text(`Finding ${idx + 1} of ${rows.length}`, PW / 2, PH - FOOTER_H + 4.4, { align: 'center' });
    doc.text(`Generated ${paFmtDateTime(now)}`, PW - M, PH - FOOTER_H + 4.4, { align: 'right' });
    doc.setFontSize(FS_LABEL); doc.setTextColor('#94a3b8');
    doc.text(`Record ID  ${recordId}`, M, PH - FOOTER_H + 8.4);
    doc.text('Central and Eastern Engineering and Maintenance Division — PTT Oil and Retail Business Public Company Limited', PW / 2, PH - FOOTER_H + 8.4, { align: 'center' });
    doc.setTextColor(PDF_TEXT);
  });

  return doc.output('blob');
}

/* Severity swatch hex for the slide identity list — kept local (the map-legend SEVERITY_COLORS in
   core/constants is keyed the same, but this small helper avoids importing it just for three keys
   and tolerates a missing/unknown severity gracefully). */
function SEVERITY_HEX(sev) {
  if (sev === 'High') return '#dc2626';
  if (sev === 'Medium') return '#d97706';
  if (sev === 'Low') return '#059669';
  return '#94a3b8';
}

