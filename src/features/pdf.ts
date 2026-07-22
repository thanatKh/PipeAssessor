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
import { STATUS_COLORS, R2_UPLOAD_ENDPOINT, PUBLIC_BASE_URL } from '../core/constants';
import { computeB313, PA_PIPE_DATABASE } from '../engine/compute';
import { paFmtDate, paFmtDateTime } from '../engine/format';
import { OR_LOGO_DATAURL } from '../engine/branding';
import { registerGoogleSansFonts } from '../engine/fonts';
import { PA_SCOPE_TEXT, paCrossSectionPng, resolveIntegrityBanner } from '../workbench/assess-view';
import { resolveAdvisor } from '../workbench/repair-advisor';
import {
  findings, filters, selectedIds, current, currentPhotos, currentHistory, currentAssessments, photoThumbs,
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

  // preload images (each degrades independently). Logo is the embedded base64 from shared.js
  // (offline-safe — same source as the calculator report), with a file fetch as a fallback.
  const logo = (typeof OR_LOGO_DATAURL !== 'undefined' && OR_LOGO_DATAURL) || await fetchAsDataUrl('/RGB_OR_Full color.png', 3000);
  const logoIm = logo ? await loadImg(logo) : null;
  const mapImg = (f.lat != null && f.lng != null) ? await composeMapPng(f.lat, f.lng, 17, 1000, 500) : null;
  // latest assessment re-computed from its saved inputs (single engine source) + its cross-section
  const assess = currentAssessments.length ? currentAssessments[0] : null;
  const assessRes = assess ? resFromSnapshot(assess) : null;
  const xsecPng = assessRes ? await paCrossSectionPng(assessRes, 2).catch(() => null) : null;

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
      catch (_) { doc.setFont('GoogleSans', 'bold'); doc.setFontSize(15); doc.setTextColor(PDF_NAVY); doc.text('OR', M, 12); }
    } else {
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(15); doc.setTextColor(PDF_NAVY);
      doc.text('OR', M, 12);
    }
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(11); doc.setTextColor(PDF_NAVY);
    doc.text('PIPING ABNORMAL FINDING REPORT', PW - M, 8.5, { align: 'right' });
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7.5); doc.setTextColor('#64748b');
    const tagRef = (f.pipe_tag || f.location_desc || f.id.slice(0, 8)).replace(/[^a-zA-Z0-9-]/g, '_');
    doc.text(`DOC REF: PA-RPT-${tagRef}-${paFmtDate(now).replace(/\s+/g, '')}`, PW - M, 13.5, { align: 'right' });
    doc.setDrawColor(PDF_NAVY); doc.setLineWidth(0.8);
    doc.line(M, HEADER_H - 1, PW - M, HEADER_H - 1);

    doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
    doc.line(M, PH - FOOTER_H, PW - M, PH - FOOTER_H);
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7.5); doc.setTextColor('#64748b');
    doc.text('Piping integrity — abnormal finding record', M, PH - FOOTER_H + 4);
    doc.text(`Page ${doc.internal.getNumberOfPages()} of {tp}`, PW / 2, PH - FOOTER_H + 4, { align: 'center' });
    doc.text(`Generated ${paFmtDateTime(now)}`, PW - M, PH - FOOTER_H + 4, { align: 'right' });
    doc.setFontSize(6.5); doc.setTextColor('#94a3b8');
    doc.text('Central and Eastern Engineering and Maintenance Division — PTT Oil and Retail Business Public Company Limited', PW / 2, PH - FOOTER_H + 9, { align: 'center' });
    doc.setTextColor(PDF_TEXT);
    y = HEADER_H + 8;
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
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8); doc.setTextColor(PDF_MUTED);
    doc.text(label, M, y + 3.5);
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(8.5); doc.setTextColor(PDF_TEXT);
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
  const reportRef = `PA-RPT-${(f.pipe_tag || f.location_desc || f.id.slice(0, 8)).replace(/[^a-zA-Z0-9-]/g, '_')}`;
  const hb = resolveIntegrityBanner(f, assessRes); // shared with the web detail page's banner

  const bandH = 15, tbRowH = 10.5;
  ensure(bandH + 3 + Math.max(tbRowH * 2, 28) + 7);

  // health banner
  doc.setFillColor(hb.fill);
  doc.rect(M, y, CW, bandH, 'F');
  doc.setFillColor(hb.spine);
  doc.rect(M, y, 2.4, bandH, 'F'); // darker spine for depth
  doc.setFont('GoogleSans', 'bold'); doc.setFontSize(13.5); doc.setTextColor('#ffffff');
  doc.text(hb.word, M + 6, y + 7);
  doc.setFont('GoogleSans', 'normal'); doc.setFontSize(8.5); doc.setTextColor('#f1f5f9');
  doc.text(doc.splitTextToSize(hb.line, CW - 62)[0], M + 6, y + 12);
  if (hb.metrics) {
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(11); doc.setTextColor('#ffffff');
    doc.text(`ERF ${hb.metrics.erf}`, PW - M - 5, y + 6.8, { align: 'right' });
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7.5); doc.setTextColor('#f1f5f9');
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
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(5.7); doc.setTextColor(PDF_MUTED);
    doc.text(label.toUpperCase(), cx + 2.4, ry + 3.3);
    let vx = cx + 2.4;
    if (opts.swatch) {
      doc.setFillColor(opts.swatch);
      doc.circle(cx + 3.5, ry + tbRowH - 3.0, 1.35, 'F');
      vx = cx + 6.6;
    }
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(opts.fs || 8.5); doc.setTextColor(opts.color || PDF_TEXT);
    const v = (value == null || value === '') ? '—' : String(value);
    doc.text(doc.splitTextToSize(v, cw - (vx - cx) - 2.5)[0], vx, ry + tbRowH - 2.6);
  };

  // Row 1 — identity.
  tbCell(M,             tbCol, y, 'Line Tag', f.pipe_tag || f.location_desc || '—', { fs: 7.5 });
  tbCell(M + tbCol,     tbCol, y, 'Terminal', f.terminal || '—', { fs: 7.5 });
  tbCell(M + tbCol * 2, tbCol, y, 'Finding Type', f.finding_type || '—', { fs: 7 });
  tbCell(M + tbCol * 3, tbCol, y, 'Severity', f.severity || '—');
  // Row 2 — workflow + reference.
  const tbY2 = y + tbRowH;
  tbCell(M,             tbCol, tbY2, 'Report Ref', reportRef, { fs: 7 });
  tbCell(M + tbCol,     tbCol, tbY2, 'Finding Status', (f.status || '—').toUpperCase(), { swatch: stColor, color: stColor, fs: 8 });
  if (isOverdue(f)) {
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(5.7); doc.setTextColor(PDF_DANGER);
    doc.text('OVERDUE', M + tbCol * 2 - 2.4, tbY2 + 3.3, { align: 'right' });
  }
  tbCell(M + tbCol * 2, tbCol, tbY2, 'Inspection Date', paFmtDate(f.inspection_date), { fs: 7.5 });
  tbCell(M + tbCol * 3, tbCol, tbY2, 'Recorded By', f.created_by_email || '—', { fs: 6.5 });

  // QR share code (right zone, top-aligned with the grid)
  if (qrShown) {
    const qs = 22;
    const qx = M + gridW + qrGap + (qrZoneW - qs) / 2;
    doc.addImage(qrDataUrl, 'PNG', qx, y, qs, qs);
    doc.link(qx, y, qs, qs, { url: shareUrl }); // tappable in a PDF viewer
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(6); doc.setTextColor(PDF_MUTED);
    doc.text('Scan to view online', qx + qs / 2, y + qs + 2.6, { align: 'center' });
    doc.text('(no sign-in required)', qx + qs / 2, y + qs + 5.0, { align: 'center' });
    doc.setTextColor(PDF_TEXT);
  }
  y += Math.max(tbRowH * 2, qrShown ? 27.5 : 0) + 5;

  // (No separate "ACTIVELY LEAKING" bar here — the health banner above already reads
  // "INTEGRITY: LEAKING" with the same emergency-containment line, so a second red bar was a
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
    styles: { font: 'GoogleSans', fontSize: 8, cellPadding: 1.6, lineColor: PDF_BORDER, lineWidth: 0.15 },
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
    styles: { font: 'GoogleSans', fontSize: 8, cellPadding: 1.6, lineColor: PDF_BORDER, lineWidth: 0.15 },
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
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(8);
      const sumLines = doc.splitTextToSize(adv.summary, CW - 8);
      const bH = 6.5 + sumLines.length * 3.7 + 2.5;
      ensure(bH + 8);
      doc.setFillColor(aTint); doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
      doc.rect(M, y, CW, bH, 'FD');
      doc.setFillColor(aC); doc.rect(M, y, 2, bH, 'F');
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8.5); doc.setTextColor(aTxt);
      doc.text(aBanner, M + 5, y + 5);
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(8); doc.setTextColor(PDF_TEXT);
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
        styles: { font: 'GoogleSans', fontSize: 8, cellPadding: 1.8, lineColor: '#e2e8f0', lineWidth: 0.12, valign: 'top', textColor: PDF_TEXT, overflow: 'linebreak' },
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
        doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7); doc.setTextColor(PDF_MUTED);
        doc.text(nLines, M, y + 2);
        doc.setTextColor(PDF_TEXT);
        y += nLines.length * 3.4 + 5;
      }
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
      doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7); doc.setTextColor(PDF_MUTED);
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
    for (const [kind, title] of [['found', 'As Found'], ['repaired', 'After Repair (Confirmation)']]) {
      const items = photoData.filter(p => p.kind === kind);
      if (!items.length) continue;
      ensure(15);
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8); doc.setTextColor(PDF_MUTED);
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
          doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7); doc.setTextColor(PDF_MUTED);
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
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8.5); doc.setTextColor(PDF_DANGER);
    doc.text('Notice: ASME B31.3 wall-loss calculation is disabled for actively leaking piping.', M, y + 3);
    y += 5;
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(8); doc.setTextColor(PDF_TEXT);
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
      styles: { font: 'GoogleSans', fontSize: 8, cellPadding: 1.2, lineColor: PDF_BORDER, lineWidth: 0.15 },
      headStyles: { fillColor: PDF_NAVY, textColor: '#ffffff', fontStyle: 'bold', fontSize: 7.5 },
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
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(13); doc.setTextColor(iText);
    doc.text(`INTEGRITY STATUS: ${r.status}`, M + 5, y + 7.8);
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8); doc.setTextColor(PDF_TEXT);
    doc.text(`ERF ${fmtN(erf_no, 3)}   MAWP ${fmtN(r.mawp_no, 1)} ${r.pUnit} (no CA)   MARGIN ${fmtN(r.margin, 3)} mm`, PW - M - 4, y + 7.8, { align: 'right' });
    y += 16;
    doc.setTextColor('#334155'); doc.setFont('GoogleSans', 'normal'); doc.setFontSize(8);
    const descLines = doc.splitTextToSize(r.desc, CW);
    ensure(descLines.length * 3.6 + 4);
    doc.text(descLines, M, y);
    y += descLines.length * 3.6 + 2;
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor(PDF_MUTED);
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
      doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor(PDF_MUTED);
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
      doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor(PDF_WARN_DARK);
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
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(7.5); doc.setTextColor(PDF_WARN_MID);
      doc.text(ffsLines, M, y);
      doc.setTextColor(PDF_TEXT);
      y += ffsLines.length * 3.4 + 4;
    }

    // --- substituted equations (real stacked fractions, mirroring the on-screen .eq-box) ---
    const eqRows = buildEquationRows(r);
    const totalEqH = eqRows.reduce((sum, rw) => sum + fractionRowHeight(rw), 0);
    ensure(26 + Math.min(totalEqH, 120)); // keep the title with at least the first equations
    section('Governing Equations (Substituted)');
    y += 2;
    eqRows.forEach(rw => {
      ensure(fractionRowHeight(rw));
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(7.5); doc.setTextColor('#475569');
      doc.text(rw.label, M, y + 2);
      if (rw.ref) {
        doc.setFont('GoogleSans', 'normal'); doc.setTextColor('#94a3b8');
        doc.text(rw.ref, PW - M, y + 2, { align: 'right' });
      }
      y += 6;
      const consumed = drawFractionRow(doc, rw.segs, M, y, { fontSize: 8.5, font: 'courier' });
      y += consumed + 4;
    });
    y += 3;

    // --- scope & limitations (assessment-scoped disclaimer) ---
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5);
    const scopeLines = doc.splitTextToSize(PA_SCOPE_TEXT, CW);
    ensure(14 + scopeLines.length * 3.3 + 4);
    section('Scope & Limitations');
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor('#475569');
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
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8.5); doc.setTextColor(PDF_TEXT);
      doc.text(head, M, y + 3.5);
      if (noteLines.length) {
        doc.setFont('GoogleSans', 'normal'); doc.setFontSize(8.5); doc.setTextColor(PDF_MUTED);
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
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(6.8); doc.setTextColor(PDF_MUTED);
  doc.text(`System-generated record via Pipe Assessor — paperless piping-integrity system. No physical signature required.`, M, y);
  y += 3.6;
  doc.text(`Recorded by ${f.created_by_email || 'System User'}  ·  ASME B31.3-2022 / API 574 assessment engine  ·  Record ID: PA-${f.id}  ·  Generated ${paFmtDateTime(now)}`, M, y);
  doc.setTextColor(PDF_TEXT);
  y += 6;

  ensure(12);
  y += 4;
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor('#94a3b8');
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
      catch (_) { doc.setFont('GoogleSans', 'bold'); doc.setFontSize(15); doc.setTextColor(PDF_NAVY); doc.text('OR', M, 12); }
    } else {
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(15); doc.setTextColor(PDF_NAVY);
      doc.text('OR', M, 12);
    }
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(11); doc.setTextColor(PDF_NAVY);
    doc.text('ASME B31.3 QUICK CALCULATION REPORT', PW - M, 8.5, { align: 'right' });
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7.5); doc.setTextColor('#64748b');
    const npsRef = String(inputs.nps || '').replace(/[^a-zA-Z0-9-]/g, '');
    doc.text(`DOC REF: PA-QCALC-${npsRef}-${paFmtDate(now).replace(/\s+/g, '')}`, PW - M, 13.5, { align: 'right' });
    doc.setDrawColor(PDF_NAVY); doc.setLineWidth(0.8);
    doc.line(M, HEADER_H - 1, PW - M, HEADER_H - 1);

    doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2);
    doc.line(M, PH - FOOTER_H, PW - M, PH - FOOTER_H);
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7.5); doc.setTextColor('#64748b');
    doc.text('Piping integrity — what-if calculation (not a recorded finding)', M, PH - FOOTER_H + 4);
    doc.text(`Page ${doc.internal.getNumberOfPages()} of {tp}`, PW / 2, PH - FOOTER_H + 4, { align: 'center' });
    doc.text(`Generated ${paFmtDateTime(now)}`, PW - M, PH - FOOTER_H + 4, { align: 'right' });
    doc.setFontSize(6.5); doc.setTextColor('#94a3b8');
    doc.text('Central and Eastern Engineering and Maintenance Division — PTT Oil and Retail Business Public Company Limited', PW / 2, PH - FOOTER_H + 9, { align: 'center' });
    doc.setTextColor(PDF_TEXT);
    y = HEADER_H + 8;
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
  doc.setFont('GoogleSans', 'bold'); doc.setFontSize(7.5); doc.setTextColor(PDF_WARN_DARK);
  doc.text('SCRATCH WHAT-IF CALCULATION — NOT A RECORDED FINDING', M + 4, y + 5);
  doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7); doc.setTextColor('#78350f');
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
  doc.setFont('GoogleSans', 'bold'); doc.setFontSize(13); doc.setTextColor(iText);
  doc.text(`INTEGRITY STATUS: ${r.status}`, M + 5, y + 7.8);
  doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8); doc.setTextColor(PDF_TEXT);
  doc.text(`ERF ${fmtN(erf_no, 3)}   MAWP ${fmtN(r.mawp_no, 1)} ${r.pUnit} (no CA)   MARGIN ${fmtN(r.margin, 3)} mm`, PW - M - 4, y + 7.8, { align: 'right' });
  y += 16;
  doc.setTextColor('#334155'); doc.setFont('GoogleSans', 'normal'); doc.setFontSize(8);
  const descLines = doc.splitTextToSize(r.desc, CW);
  ensure(descLines.length * 3.6 + 4);
  doc.text(descLines, M, y);
  y += descLines.length * 3.6 + 2;
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor(PDF_MUTED);
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
    styles: { font: 'GoogleSans', fontSize: 8, cellPadding: 1.2, lineColor: PDF_BORDER, lineWidth: 0.15 },
    headStyles: { fillColor: PDF_NAVY, textColor: '#ffffff', fontStyle: 'bold', fontSize: 7.5 },
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
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor(PDF_MUTED);
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
    doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor(PDF_WARN_DARK);
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
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(7.5); doc.setTextColor(PDF_WARN_MID);
    doc.text(ffsLines, M, y);
    doc.setTextColor(PDF_TEXT);
    y += ffsLines.length * 3.4 + 4;
  }

  // --- substituted equations ---
  const eqRows = buildEquationRows(r);
  const totalEqH = eqRows.reduce((sum, rw) => sum + fractionRowHeight(rw), 0);
  ensure(26 + Math.min(totalEqH, 120));
  section('Governing Equations (Substituted)');
  y += 2;
  eqRows.forEach(rw => {
    ensure(fractionRowHeight(rw));
    doc.setFont('GoogleSans', 'bold'); doc.setFontSize(7.5); doc.setTextColor('#475569');
    doc.text(rw.label, M, y + 2);
    if (rw.ref) {
      doc.setFont('GoogleSans', 'normal'); doc.setTextColor('#94a3b8');
      doc.text(rw.ref, PW - M, y + 2, { align: 'right' });
    }
    y += 6;
    const consumed = drawFractionRow(doc, rw.segs, M, y, { fontSize: 8.5, font: 'courier' });
    y += consumed + 4;
  });
  y += 3;

  // --- scope & limitations ---
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5);
  const scopeLines = doc.splitTextToSize(PA_SCOPE_TEXT, CW);
  ensure(14 + scopeLines.length * 3.3 + 4);
  section('Scope & Limitations');
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor('#475569');
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
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(6.8); doc.setTextColor(PDF_MUTED);
  doc.text('System-generated what-if calculation via Pipe Assessor — paperless piping-integrity system. No physical signature required.', M, y);
  y += 3.6;
  doc.text(`ASME B31.3-2022 / API 574 assessment engine  ·  Not a recorded finding  ·  Generated ${paFmtDateTime(now)}`, M, y);
  doc.setTextColor(PDF_TEXT);
  y += 6;

  ensure(12);
  y += 2;
  doc.setFont('GoogleSans', 'italic'); doc.setFontSize(7.5); doc.setTextColor('#94a3b8');
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
      const textOR = () => { doc.setFont('GoogleSans', 'bold'); doc.setFontSize(11); doc.setTextColor(PDF_NAVY); doc.text('OR', M, 8.5); };
      if (logoIm) { const lh = 7.5, lw = lh * logoIm.naturalWidth / logoIm.naturalHeight; try { doc.addImage(logo, 'PNG', M, 2.5, lw, lh); } catch (_) { textOR(); } }
      else textOR();
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(10); doc.setTextColor(PDF_NAVY);
      doc.text('PIPING FINDINGS SUMMARY', PW - M, 6.5, { align: 'right' });
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7); doc.setTextColor('#64748b');
      doc.text(`${term}  ·  ${stat}  ·  ${paFmtDate(now)}`, PW - M, 10.5, { align: 'right' });
      doc.setDrawColor(PDF_NAVY); doc.setLineWidth(0.6); doc.line(M, HEADER_H - 1, PW - M, HEADER_H - 1);

      doc.setDrawColor(PDF_BORDER); doc.setLineWidth(0.2); doc.line(M, PH - FOOTER_H, PW - M, PH - FOOTER_H);
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7.5); doc.setTextColor('#64748b');
      doc.text('Piping integrity — findings summary', M, PH - FOOTER_H + 4);
      doc.text(`Page ${doc.internal.getNumberOfPages()} of {tp}`, PW / 2, PH - FOOTER_H + 4, { align: 'center' });
      doc.text(`Generated ${paFmtDateTime(now)}`, PW - M, PH - FOOTER_H + 4, { align: 'right' });
      doc.setFontSize(6.5); doc.setTextColor('#94a3b8');
      doc.text('Central and Eastern Engineering and Maintenance Division — PTT Oil and Retail Business Public Company Limited', PW / 2, PH - FOOTER_H + 9, { align: 'center' });
      doc.setTextColor(PDF_TEXT);
    }

    chrome();
    let y = HEADER_H + 8;
    doc.setFont('GoogleSans', 'normal'); doc.setFontSize(9); doc.setTextColor(PDF_TEXT);
    doc.text(`${rows.length} findings   ·   Open ${cnt('Open')}   ·   Monitoring ${cnt('Monitoring')}   ·   Repair Planned ${cnt('Repair Planned')}   ·   Repaired ${cnt('Repaired')}`, M, y);
    if (overdue) { doc.setFont('GoogleSans', 'bold'); doc.setTextColor(DANGER); doc.text(`${overdue} OVERDUE`, PW - M, y, { align: 'right' }); doc.setTextColor(PDF_TEXT); doc.setFont('GoogleSans', 'normal'); }
    y += 6;

    // Budget headline (opt-in) — outstanding = not yet Repaired/Closed, with a severity split.
    if (includeBudget) {
      const out = rows.filter(f => f.status !== 'Repaired' && f.status !== 'Closed');
      const sum = arr => arr.reduce((s, f) => s + (Number(f.estimated_cost) || 0), 0);
      const sev = s => thb(sum(out.filter(f => f.severity === s)));
      doc.setFont('GoogleSans', 'bold'); doc.setFontSize(9); doc.setTextColor(PDF_NAVY);
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
      doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7); doc.setTextColor('#94a3b8');
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
      styles: { font: 'GoogleSans', fontSize: 8, cellPadding: 1.6, lineColor: '#e2e8f0', lineWidth: 0.1, textColor: '#0f172a', overflow: 'linebreak', minCellHeight: 26, valign: 'top' },
      headStyles: { fillColor: PDF_NAVY, textColor: '#ffffff', fontStyle: 'bold', fontSize: 8, valign: 'middle', cellPadding: { top: 2.2, right: 1.6, bottom: 2.2, left: 1.6 }, minCellHeight: 0 },
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
          doc.setFont('GoogleSans', 'bold'); doc.setFontSize(8); doc.setTextColor(PDF_TEXT);
          doc.text(f.finding_type, tx, ty);
          ty += 3.6;
          doc.setFont('GoogleSans', 'normal'); doc.setFontSize(7); doc.setTextColor('#64748b');
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

