/* ============================================================================
   Assessment workbench view layer — ported 1:1 from the pre-migration asset/assess-ui.js.
   Injects the workbench markup and renders computeB313 results into it (status
   banner, cross-section SVG + drag handle, compliance verdicts, ERF gauge,
   results grid, advisor, equations, scope notice). Also rasterizes the SVG for
   the PDF figure. DOM-free helpers stay pure; every element lookup is data-k
   scoped to the instance root, so multiple instances coexist in one document.
   ============================================================================ */
import { paFmt } from '../engine/format';
import { PA_LABELS, paLabelHtml, paPressureUsePct, paLimitGap, paStatusText } from './labels';
import { computeB313 } from '../engine/compute';
import { WALL_LOSS_TYPES } from '../core/constants';

/* ---------------- severity health banner (shared: PDF report + web detail page) ----------------
   One resolver so the finding PDF's title-block banner and the detail page's banner can never
   disagree on wording, color, or which state a finding is in. Reflects ENGINEERING risk, not
   workflow — headlined as SEVERITY (CRITICAL/HIGH/MEDIUM/LOW), not a compliance/"integrity"
   verdict: a plain OK/MONITOR/REPAIR framing reads as "MONITOR = just watch, nothing to do",
   which is wrong — every tier except a genuinely closed-out finding has a real action attached
   (arrest the corrosion mechanism, increase inspection frequency, repair/replace), and the line
   text always names it. Wall-loss types (WALL_LOSS_TYPES) with a computed result map the numeric
   ASME B31.3 verdict to a severity tier (REPAIR->HIGH, MONITOR->MEDIUM, OK->LOW) — precise and
   always wins when available. Non-wall-loss types (Coating, Support, Dent, Other) have no numeric
   result, so the banner falls back to the finding's own Severity field instead (High/Medium/Low
   map the same way) — same red/amber/green language, just sourced from a human judgment call
   rather than a calculation. is_leaking is the top override regardless of type, its own CRITICAL
   tier. PENDING is a wall-loss type still awaiting a reading; NOT ASSESSED is no finding type at
   all — neither has a severity yet. Fills are 700-tier shades so white text clears WCAG; spine is
   a darker shade for depth. `finding` needs { is_leaking, finding_type, severity }; `res` is a
   computeB313 result or null. */
export interface IntegrityBanner {
  key: 'leaking' | 'repair' | 'monitor' | 'ok' | 'pending' | 'none';
  word: string;
  line: string;
  fill: string;
  spine: string;
  metrics: { erf: string; mawp: string; pct: string; usage: string } | null;
}

const HB_REPAIR  = { fill: '#b91c1c', spine: '#7f1d1d' };
const HB_MONITOR = { fill: '#b45309', spine: '#92400e' };
const HB_OK      = { fill: '#047857', spine: '#065f46' };
const HB_NEUTRAL = { fill: '#475569', spine: '#334155' };

/* A saved assessment snapshot without a UT reading has NO result. computeB313 (parity-locked legacy
   behaviour) reads a blank wall-loss depth as 0 mm, so re-computing such a row reports "OK, 100% wall
   left" for a finding nobody measured. Every display load filters these out (detail page, public
   share, risk ranking, slides) and resFromSnapshot refuses them; the form no longer saves them. */
export function snapshotHasReading(a: any): boolean {
  const i = a && a.inputs;
  if (!i) return true; // legacy row without inputs: the saved-results fallback decides
  const v = i.mode === 'tmeas' ? i.tmeas : i.depth;
  return v != null && String(v).trim() !== '';
}

export function resolveIntegrityBanner(finding: any, res: any): IntegrityBanner {
  const f3 = (n: number) => (n == null || !isFinite(n)) ? '—' : n.toFixed(3);
  const f1 = (n: number) => (n == null || !isFinite(n)) ? '—' : n.toFixed(1);
  const f0 = (n: number) => (n == null || !isFinite(n)) ? '—' : n.toFixed(0);
  const metrics = res ? {
    erf: f3(res.mawp_no > 0 ? (res.P_input / res.mawp_no) : 9.99),
    mawp: `${f1(res.mawp_no)} ${res.pUnit}`,
    usage: paPressureUsePct(res.mawp_no > 0 ? (res.P_input / res.mawp_no) : null),
    pct: f0(res.pctRemainNom),
  } : null;
  const ft = finding && finding.finding_type;
  const isWallLoss = ft && WALL_LOSS_TYPES.includes(ft);

  if (finding && finding.is_leaking)
    // no metrics: the B31.3 wall-loss numbers do not apply once the boundary is breached ("pressure
    // use 11% / 100% wall left" beside LEAKING contradicted the banner)
    return { key: 'leaking', word: 'INTEGRITY: LEAKING', line: 'Pressure boundary breached — emergency containment required (ASME PCC-2)', ...HB_REPAIR, metrics: null };
  if (res && res.status === 'REPAIR')
    return { key: 'repair', word: 'INTEGRITY: REPAIR', line: 'Wall loss below acceptable limit — repair or replacement required', ...HB_REPAIR, metrics };
  if (res && res.status === 'MONITOR')
    return { key: 'monitor', word: 'INTEGRITY: MONITOR', line: 'Wall loss is approaching the design or structural limit — mitigate the corrosion now and increase the inspection frequency', ...HB_MONITOR, metrics };
  if (res && res.status === 'OK')
    return { key: 'ok', word: 'INTEGRITY: OK', line: 'Within acceptable design limits — no pressure-boundary repair required, continue corrosion mitigation per the Repair Advisor', ...HB_OK, metrics };
  if (ft && !isWallLoss) {
    const sev = finding && finding.severity;
    if (sev === 'High')
      return { key: 'repair', word: 'INTEGRITY: REPAIR', line: 'Requires remediation — see the Repair Advisor for the recommended action', ...HB_REPAIR, metrics: null };
    if (sev === 'Medium')
      return { key: 'monitor', word: 'INTEGRITY: MONITOR', line: 'Requires ongoing remediation action — see the Repair Advisor', ...HB_MONITOR, metrics: null };
    return { key: 'ok', word: 'INTEGRITY: OK', line: 'No pressure-boundary repair required — see the Repair Advisor for routine maintenance actions', ...HB_OK, metrics: null };
  }
  if (ft)
    return { key: 'pending', word: 'PENDING ASSESSMENT', line: finding && finding.depth_mm != null
      ? `Wall-loss depth ${finding.depth_mm} mm recorded — awaiting pipe size and design pressure` // one line in the PDF banner
      : 'Awaiting a wall-loss depth reading for the ASME B31.3 assessment', ...HB_NEUTRAL, metrics: null };
  return { key: 'none', word: 'NOT ASSESSED', line: 'No assessment on record for this finding', ...HB_NEUTRAL, metrics: null };
}

/* Single source of truth for the Scope & Limitations text (on-screen notice + PDF section). */
export const PA_SCOPE_HTML = '<strong>Scope &amp; Limitations:</strong> This assessment applies ASME B31.3 thickness/MAWP equations to a single uniform wall-loss reading and is intended for general (non-localized) corrosion screening only. It is <strong>not</strong> a Level 1/2 fitness-for-service evaluation (API 579-1/ASME FFS-1) or a B31G/RSTRENG remaining-strength calculation, and is not valid for assessing isolated pits, gouges, or other localized flaws &mdash; a separate FFS assessment is required for those. Results reflect one manually entered reading; they do not represent a full CML survey grid or a multi-survey corrosion-rate trend. Confirm all material- and temperature-dependent inputs (S, E, W, Y) before relying on this output for a repair/replace decision.';
export const PA_SCOPE_TEXT = PA_SCOPE_HTML.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&mdash;/g, '—');

/* Fixed pixel geometry of the unrolled wall profile (see drawSvg below). The viewBox stays 500x270
   because the finding PDF and the slide deck place the rasterized figure at that aspect ratio. */
const PA_WALL_PLOT = { left: 64, right: 250, yOd: 36, yId: 226, pocketL: 92, pocketR: 222, pocketC: 157, pocketHalfW: 65 };
// x of the right-hand label column (leaders run from the plot edge to here)
const PA_LABEL_X = 280;
// verdict colours for the above/below-limit bracket (the same 700-tier shades as the health banner)
const PA_VERDICT_HEX: Record<string, string> = { OK: '#047857', MONITOR: '#b45309', REPAIR: '#b91c1c' };
// each workbench instance gets its own gradient ids: a gradient inside a display:none view
// (the form and the detail page both exist in the DOM) would otherwise not paint for the other
let paSvgSeq = 0;

/* ---------------- workbench markup (no ids — data-k lookups, instance-scoped) ---------------- */

/* Design (Oct 2026 redesign): the figure answers ONE question first — how much wall is left above
   the limit that decides the result — with a verdict-coloured dimension bracket ("0.72 mm above limit").
   That deciding limit is drawn bold with a full-colour label; the other two limits are thin and
   muted. The wall is a steel gradient and the lost metal is rust (the user's chosen palette, from a
   pipe-sketch experiment); green/amber/red stay reserved for the verdict bracket. Labels are two-line
   (name muted, value bold) and placed beside their true height with collision spacing instead of
   fixed rows; a mm ruler on the left makes the drawing read as being to scale. No legend: every
   element is labelled directly. */
const PA_AW_SVG = `
  <svg class="assess-svg" data-k="pipeSvg" width="100%" height="270" viewBox="0 0 500 270" xmlns="http://www.w3.org/2000/svg" style="background: var(--svg-bg); border-radius: 8px;">
    <!-- Longitudinal wall-thickness profile: the pipe wall is shown unrolled as a straight strip
         (OD at top, nominal ID at bottom) with the localized wall-loss patch drawn as a dip.
         NOTE: no double-hyphen anywhere inside SVG comments, or XML serialization for the PDF
         export breaks. -->
    <defs>
      <!-- steel wall: light at the outside surface, darker towards the bore -->
      <linearGradient id="paXsMetal" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e2e8f0" /><stop offset="0.35" stop-color="#cbd5e1" />
        <stop offset="0.7" stop-color="#94a3b8" /><stop offset="1" stop-color="#64748b" />
      </linearGradient>
      <!-- rust metal loss: pale at the original surface, darkest at the deepest point (drawSvg flips
           it for internal loss, where the pit grows up from the bore) -->
      <linearGradient id="paXsLoss" data-k="svgLossGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fdba74" /><stop offset="0.4" stop-color="#c2410c" />
        <stop offset="1" stop-color="#7c2d12" />
      </linearGradient>
    </defs>
    <g data-k="svgRuler"></g>
    <text data-k="svgOdCap" font-size="10" font-family="Google Sans, Inter, sans-serif" fill="#64748b"></text>
    <text data-k="svgIdCap" font-size="10" font-family="Google Sans, Inter, sans-serif" fill="#64748b"></text>
    <g data-k="wallGroup">
      <rect data-k="svgWallRect" x="64" y="36" width="186" height="190" fill="url(#paXsMetal)" stroke="#64748b" stroke-width="1" rx="2" />
      <path data-k="svgPocketLoss" d="" fill="url(#paXsLoss)" stroke="#7c2d12" stroke-width="1" stroke-linejoin="round" />
      <path data-k="svgPocketNominalLine" d="" fill="none" stroke="#7c2d12" stroke-dasharray="2 2" stroke-width="1.2" opacity="0.55" />
      <line data-k="svgOdLine" x1="64" y1="36" x2="250" y2="36" stroke="var(--text-color)" stroke-width="1.2" opacity="0.45" />
      <line data-k="svgNomLine" x1="64" y1="226" x2="250" y2="226" stroke="var(--text-color)" stroke-width="1.2" opacity="0.45" />
      <line data-k="svgReqTotalLine" x1="0" y1="0" x2="0" y2="0" stroke="var(--limit-reqca)" stroke-dasharray="5 3" />
      <line data-k="svgReqNoCaLine" x1="0" y1="0" x2="0" y2="0" stroke="var(--limit-req)" />
      <line data-k="svgStructLine" x1="0" y1="0" x2="0" y2="0" stroke="var(--limit-struct)" stroke-dasharray="2 2" />
    </g>
    <g data-k="svgSpare" style="display:none;">
      <line data-k="svgSpareLine" stroke-width="1.6" />
      <line data-k="svgSpareCapA" stroke-width="1.6" />
      <line data-k="svgSpareCapB" stroke-width="1.6" />
      <rect data-k="svgSparePill" rx="4" height="18" />
      <text data-k="svgSpareText" font-size="11" font-family="Google Sans, Inter, sans-serif" font-weight="700" fill="#ffffff"></text>
    </g>
    <!-- Empty-state text is filled by JS (a static CSS-variable fill on a parsed text node was
         observed not to paint in Chromium). -->
    <text data-k="svgEmptyState" x="157" y="118" text-anchor="middle" font-size="11" font-family="Google Sans, Inter, sans-serif" font-weight="600"></text>
    <text data-k="svgEmptyState2" x="157" y="134" text-anchor="middle" font-size="11" font-family="Google Sans, Inter, sans-serif" font-weight="600"></text>
    <text data-k="svgEmptyState3" x="157" y="150" text-anchor="middle" font-size="11" font-family="Google Sans, Inter, sans-serif" font-weight="600"></text>
    <circle data-k="svgDragHandle" class="drag-handle" cx="0" cy="0" r="6" style="display:none;"><title>Drag up or down to change the wall-loss depth</title></circle>
    <path data-k="svgLMeasLine" d="" fill="none" stroke="#94a3b8" stroke-width="1" />
    <text data-k="svgLMeasText" font-family="Google Sans, Inter, sans-serif"></text>
    <path data-k="svgLReqTotalLine" d="" fill="none" stroke="var(--limit-reqca)" stroke-width="1" />
    <text data-k="svgLReqTotalText" font-family="Google Sans, Inter, sans-serif"></text>
    <path data-k="svgLReqNoLine" d="" fill="none" stroke="var(--limit-req)" stroke-width="1" />
    <text data-k="svgLReqNoText" font-family="Google Sans, Inter, sans-serif"></text>
    <path data-k="svgLStructLine" d="" fill="none" stroke="var(--limit-struct)" stroke-width="1" />
    <text data-k="svgLStructText" font-family="Google Sans, Inter, sans-serif"></text>
  </svg>`;

const PA_AW_SECTIONS = {
  status: {
    title: null,
    body: `
      <div class="status-banner" data-k="statusBox">
        <div class="status-label">Integrity Status</div>
        <div class="status-value" data-k="statusVal">-</div>
      </div>
      <div class="status-desc" data-k="statusNotes">—</div>`
  },
  scope: {
    title: null,
    body: `<div class="scope-notice">${PA_SCOPE_HTML}</div>`
  },
  svg: {
    title: 'Pipe Wall Thickness Cross-Section',
    body: `
      <div class="svg-container">${PA_AW_SVG}</div>
      <div class="aw-svg-note">Rust-coloured area = metal lost · the <b>bold</b> line is the limit that decides the result · the coloured bracket is the distance from the thinnest point to that limit</div>`
  },
  results: {
    title: 'Calculation Results',
    body: `
      <div class="compliance-box">
        <div class="compliance-row">
          <span class="compliance-name">ASME B31.3 — Wall thick enough for the pressure <span class="lbl-sym">(t<sub>meas</sub> &ge; t<sub>req</sub> + CA)</span></span>
          <span class="compliance-badge" data-k="compB313">—</span>
        </div>
        <div class="compliance-row">
          <span class="compliance-name">API RP 574 — Wall thick enough to stay strong <span class="lbl-sym">(t<sub>meas</sub> &ge; t<sub>struct</sub>)</span></span>
          <span class="compliance-badge" data-k="comp574">—</span>
        </div>
        <div class="compliance-ffs-note" data-k="ffsNote" style="display:none;">
          One or more code checks did not pass. Consider a Level 1/2 fitness-for-service assessment per
          <strong>API 579-1/ASME FFS-1</strong> or a <strong>B31G/RSTRENG</strong> remaining-strength evaluation
          before making the repair/replace decision.
        </div>
      </div>

      <div class="pressure-gauge-container">
        <div class="pressure-gauge-labels">
          <span>0%</span>
          <span style="font-size: var(--fs-base); font-weight: 800; color: var(--text-color);">${PA_LABELS.erfNo.plain}: <span data-k="gaugeErfVal">—</span><span data-k="gaugeErfOvershoot" style="display:none; color: var(--danger-color);"> (off scale)</span></span>
          <span>Limit 100%</span>
        </div>
        <div class="pressure-gauge-bar-wrapper">
          <div class="pressure-gauge-track" data-k="gaugeTrack">
            <div class="pressure-zone safe" data-k="zoneSafe"></div>
            <div class="pressure-zone warning" data-k="zoneWarning"></div>
            <div style="position: absolute; left: 66.7%; top: 0; bottom: 0; width: 2px; background: rgba(0,0,0,0.5); z-index: 5;" title="Critical Limit (1.0)"></div>
            <div class="pressure-gauge-pointer" data-k="pressurePointer" title="Current ERF">
              <div class="pointer-tip"></div>
            </div>
          </div>
        </div>
        <div class="pressure-gauge-legend">
          <span class="legend-item"><span class="legend-color p-safe-color"></span> Safe (under 80%)</span>
          <span class="legend-item"><span class="legend-color p-warn-color"></span> Warning (80–100%)</span>
          <span class="legend-item"><span class="legend-color p-crit-color"></span> Action required (over 100%)</span>
        </div>
      </div>

      <div class="res-section-title">Thickness</div>
      <div class="res-grid">
        <div class="res-item"><span class="res-name">${paLabelHtml('tNom')}</span><span class="res-val" data-k="resTnom">-</span></div>
        <div class="res-item"><span class="res-name">${paLabelHtml('pct')}</span><span class="res-val" data-k="resPct">-</span></div>
        <div class="res-item"><span class="res-name">${paLabelHtml('tReq')}</span><span class="res-val" data-k="resTreq">-</span></div>
        <div class="res-item"><span class="res-name">${paLabelHtml('tReqCa')}</span><span class="res-val" data-k="resTreqCa">-</span></div>
        <div class="res-item"><span class="res-name">${paLabelHtml('tStruct')}</span><span class="res-val" data-k="resTstruct">-</span></div>
        <div class="res-item"><span class="res-name">${paLabelHtml('margin')}</span><span class="res-val" data-k="resMargin">-</span></div>
      </div>

      <div class="res-section-title">Pressure</div>
      <div class="res-grid">
        <div class="res-item"><span class="res-name">${paLabelHtml('p')}</span><span class="res-val" data-k="resPres">-</span></div>
        <div class="res-item"><span class="res-name">${paLabelHtml('mawpNo')}</span><span class="res-val" data-k="resMawpNoCA">-</span></div>
        <div class="res-item"><span class="res-name">${paLabelHtml('erfNo')}</span><span class="res-val" data-k="resErfNo">-</span></div>
        <div class="res-item"><span class="res-name">${paLabelHtml('mawpCa')}</span><span class="res-val" data-k="resMawpWith">-</span></div>
        <div class="res-item"><span class="res-name">${paLabelHtml('erfCa')}</span><span class="res-val" data-k="resErfWith">-</span></div>
      </div>

      <div class="res-section-title">Remaining Life</div>
      <div class="res-grid">
        <div class="res-item"><span class="res-name">${paLabelHtml('ca')}</span><span class="res-val" data-k="resCa">-</span></div>
        <div class="res-item"><span class="res-name">${paLabelHtml('cr')}</span><span class="res-val" data-k="resCr">-</span></div>
        <div class="res-item"><span class="res-name">${paLabelHtml('life')}</span><span class="res-val" data-k="resLife">-</span></div>
      </div>
      <p class="report-caveat" data-k="erlCaveat" style="margin-top:10px; display:none;">
        Assumes a single, constant, linear corrosion rate for the life of the pipe &mdash; it is not a substitute for trending multiple UT surveys over time. Per API 570 practice, the next inspection interval should not exceed half the estimated remaining life (subject to a code-defined maximum).
      </p>`
  },
  equations: {
    title: 'Calculation References & Equations',
    body: `
      <div class="eq-section">
        <h3 class="eq-title">ASME B31.3 Para. 304.1.2 — Required Wall Thickness (t<sub>req</sub>)</h3>
        <div class="eq-box">
          t<sub>req</sub> = <div class="fraction"><span class="numerator">P &middot; D</span><span class="denominator">2 &middot; (S &middot; E &middot; W + P &middot; Y)</span></div>
        </div>
        <div class="eq-box">
          t<sub>req_total</sub> = t<sub>req</sub> + CA
        </div>
        <div class="eq-sub-container">
          <span class="eq-sub-title">Dynamic Calculation Substitution:</span>
          <div class="eq-sub-step">
            t<sub>req</sub> = <div class="fraction"><span class="numerator"><span class="sub-P">—</span> &middot; <span class="sub-D">—</span></span><span class="denominator">2 &middot; (<span class="sub-S">—</span> &middot; <span class="sub-E">—</span> &middot; <span class="sub-W">—</span> + <span class="sub-P">—</span> &middot; <span class="sub-Y">—</span>)</span></div> = <strong class="sub-treq-val">—</strong> mm
          </div>
          <div class="eq-sub-step" style="margin-top: 8px;">
            t<sub>req_total</sub> = <span class="sub-treq-val">—</span> mm + <span class="sub-CA">—</span> mm = <strong class="sub-treq-total-val">—</strong> mm
          </div>
        </div>
        <ul class="eq-legend-list">
          <li><strong>P:</strong> Internal Design Pressure (MPa)</li>
          <li><strong>D:</strong> Pipe Outside Diameter (mm)</li>
          <li><strong>S:</strong> Allowable Material Stress (MPa)</li>
          <li><strong>E:</strong> Joint Quality Factor</li>
          <li><strong>W:</strong> Weld Strength Reduction Factor</li>
          <li><strong>Y:</strong> Temperature Coefficient</li>
          <li><strong>CA:</strong> Corrosion Allowance (mm)</li>
        </ul>
      </div>

      <div class="eq-section" style="margin-top:16px; border-top:1px dashed var(--card-border); padding-top:16px;">
        <h3 class="eq-title">ASME B31.3 Para. 304.1.2 — Max Allowable Working Pressure (MAWP)</h3>
        <div class="eq-box">
          MAWP = <div class="fraction"><span class="numerator">2 &middot; S &middot; E &middot; W &middot; t<sub>use</sub></span><span class="denominator">D - 2 &middot; Y &middot; t<sub>use</sub></span></div>
        </div>
        <div class="eq-sub-container">
          <span class="eq-sub-title">Dynamic Calculation Substitution:</span>
          <div class="eq-sub-step">
            t<sub>use</sub> (no CA) = <span class="sub-tmeas">—</span> mm<br>
            MAWP (No CA) = <div class="fraction"><span class="numerator">2 &middot; <span class="sub-S">—</span> &middot; <span class="sub-E">—</span> &middot; <span class="sub-W">—</span> &middot; <span class="sub-tmeas">—</span></span><span class="denominator"><span class="sub-D">—</span> - 2 &middot; <span class="sub-Y">—</span> &middot; <span class="sub-tmeas">—</span></span></div> = <span class="sub-mawp-no-mpa">—</span> MPa = <strong class="sub-mawp-no-res">—</strong> <span class="p-unit-lbl">bar</span>
          </div>
          <div class="eq-sub-step" style="margin-top: 12px; border-top: 1px dotted var(--card-border); padding-top: 8px;">
            t<sub>use</sub> (with CA) = max(0, <span class="sub-tmeas">—</span> - <span class="sub-CA">—</span>) = <span class="sub-tuse-with">—</span> mm<br>
            MAWP (With CA) = <div class="fraction"><span class="numerator">2 &middot; <span class="sub-S">—</span> &middot; <span class="sub-E">—</span> &middot; <span class="sub-W">—</span> &middot; <span class="sub-tuse-with">—</span></span><span class="denominator"><span class="sub-D">—</span> - 2 &middot; <span class="sub-Y">—</span> &middot; <span class="sub-tuse-with">—</span></span></div> = <span class="sub-mawp-with-mpa">—</span> MPa = <strong class="sub-mawp-with-res">—</strong> <span class="p-unit-lbl">bar</span>
          </div>
        </div>
        <ul class="eq-legend-list">
          <li><strong>MAWP (No CA):</strong> Calculated using t<sub>use</sub> = t<sub>meas</sub> — the pipe's actual current capacity, matching its real, already-measured wall loss. This is the primary/headline figure used elsewhere in this app (gauge, status band, saved snapshots).</li>
          <li><strong>MAWP (With CA):</strong> Calculated using t<sub>use</sub> = max(0, t<sub>meas</sub> - CA) — a supplementary, more conservative figure that reserves an additional corrosion allowance on top of the already-measured thickness (not the current condition).</li>
          <li><strong>t<sub>meas</sub>:</strong> Remaining measured wall thickness (mm)</li>
        </ul>
      </div>

      <div class="eq-section" style="margin-top:16px; border-top:1px dashed var(--card-border); padding-top:16px;">
        <h3 class="eq-title">API RP 574 — Structural Minimum Thickness (t<sub>struct</sub>)</h3>
        <p style="font-size:var(--fs-sm); color:var(--text-muted); line-height:1.4; margin-top:4px;">
          Absolute minimum threshold to prevent mechanical sagging, buckling, or collapse at support points (lookup based on NPS size).
        </p>
        <div class="eq-sub-container" style="margin-top: 10px;">
          <span class="eq-sub-title">Dynamic Lookup & Status:</span>
          <div class="eq-sub-step">
            For NPS = <strong><span class="sub-nps">—</span></strong>: structural minimum t<sub>struct</sub> = <strong><span class="sub-tstruct">—</span> mm</strong>.<br>
            Remaining measured wall thickness t<sub>meas</sub> = <strong><span class="sub-tmeas">—</span> mm</strong>.<br>
            Status: <span data-k="eqSubStructStatus" class="eq-status-badge">—</span>
          </div>
        </div>
      </div>

      <div class="eq-section" data-k="eqSectionErl" style="margin-top:16px; border-top:1px dashed var(--card-border); padding-top:16px; display: none;">
        <h3 class="eq-title">Estimated Remaining Life (ERL)</h3>
        <div class="eq-box">
          ERL = <div class="fraction"><span class="numerator">t<sub>meas</sub> - t<sub>req_total</sub></span><span class="denominator">CR</span></div>
        </div>
        <div class="eq-sub-container">
          <span class="eq-sub-title">Dynamic Calculation Substitution:</span>
          <div class="eq-sub-step">
            ERL = <div class="fraction"><span class="numerator"><span class="sub-tmeas">—</span> - <span class="sub-treq-total-val">—</span></span><span class="denominator"><span class="sub-CR">—</span></span></div> = <strong class="sub-erl-val">—</strong> years
          </div>
        </div>
        <ul class="eq-legend-list">
          <li><strong>CR:</strong> Corrosion Rate (mm/year)</li>
          <li>If Corrosion Rate is zero, ERL is infinite (or not applicable).</li>
        </ul>
      </div>`
  }
};

/* Rasterize a workbench cross-section <svg> to a PNG dataURL for PDF embedding.
   Two fixes are mandatory (learned on the old calculator): CSS variables don't resolve inside
   a standalone serialized SVG (inject a fixed palette — keep this hex list in sync with
   theme.css's svg/limit token values), and webfonts aren't available in the isolated SVG
   image context (rewrite text to Arial). */
export function paSvgToPng(svgEl, scale) {
  scale = scale || 3;
  return new Promise((resolve, reject) => {
    const clone = svgEl.cloneNode(true);
    const drag = clone.querySelector('.drag-handle');
    if (drag) drag.remove();

    const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    styleEl.textContent = ':root{--svg-bg:#f8fafc;--text-color:#0f172a;--text-light:#64748b;--text-muted:#475569;--limit-reqca:#92400e;--limit-req:#991b1b;--limit-struct:#5b21b6;}';
    clone.insertBefore(styleEl, clone.firstChild);
    clone.style.background = '#f8fafc';
    clone.querySelectorAll('text').forEach(t => t.setAttribute('font-family', 'Arial, Helvetica, sans-serif'));

    const w = 500 * scale, h = 270 * scale;
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);

    const svgBlob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG rasterization failed')); };
    img.src = url;
  });
}

/* Offscreen cross-section render: mounts an svg-only workbench in a hidden container, renders
   the given computeB313 result, rasterizes, and cleans up. Resolves null on any failure so PDF
   builders can degrade to a text-only section instead of throwing. */
export async function paCrossSectionPng(res, scale) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute; left:-10000px; top:0; width:520px;';
  document.body.appendChild(host);
  try {
    const view = paCreateAssessView(host, { sections: ['svg'] });
    view.render(res, {});
    return await paSvgToPng(view.getSvg(), scale);
  } catch (e) {
    return null;
  } finally {
    host.remove();
  }
}

export function paCreateAssessView(root, opts) {
  opts = opts || {};
  const sections = opts.sections || ['status', 'scope', 'svg', 'results', 'equations'];
  const collapsed = opts.collapsed || [];

  root.classList.add('aw');
  root.innerHTML = sections.map(key => {
    const sec = PA_AW_SECTIONS[key];
    if (!sec) return '';
    // Sections with no title (status/scope) are plain blocks, not cards — .panel's own
    // margin-bottom (via aw-plain) keeps their vertical rhythm matching the card sections.
    if (!sec.title) return `<div class="aw-plain" data-sec="${key}">${sec.body}</div>`;
    const isOpen = collapsed.includes(key) ? '' : ' open';
    // Reuses the app's own .panel/.panel-h/.panel-b card shell (same one index.html's
    // dashboard uses) instead of a separate hand-rolled clone — .panel-collapse adds only the
    // <details>/<summary> toggle behavior (cursor, chevron) on top of the shared header look.
    // .panel-b-track/.panel-b-inner: grid-rows 0fr<->1fr height animation (see theme.css's
    // accordion-expand block) — wrapping only collapsible sections; plain dashboard .panel-b
    // usage elsewhere stays a single unwrapped div.
    return `<details class="panel" data-sec="${key}"${isOpen}>
      <summary class="panel-h panel-collapse">${sec.title}</summary>
      <div class="panel-b-track"><div class="panel-b-inner"><div class="panel-b">${sec.body}</div></div></div>
    </details>`;
  }).join('').replace(/paXs(Metal|Loss)/g, ((n) => (m) => m + n)(++paSvgSeq));

  const q = (k) => root.querySelector(`[data-k="${k}"]`);
  const qa = (sel) => root.querySelectorAll(sel);
  const has = (k) => !!q(k);
  const svg = q('pipeSvg');
  let lastRes: any = null;
  let lastCtx = {};

  /* ---- cross-section (unrolled wall profile; see PA_WALL_PLOT geometry) ---- */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag: string, attrs: Record<string, any>, text?: string) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, String(attrs[k]));
    if (text != null) el.textContent = text;
    return el;
  };

  // Two-line label in the right column: name (small) over value (bold), joined to the line's true
  // height by an elbow leader.
  function setLabel(id, trueY, rowY, name, value, nameFill, valueFill, strong) {
    q(id + 'Line').setAttribute('d', `M ${PA_WALL_PLOT.right} ${trueY} L 262 ${trueY} L 270 ${rowY} L ${PA_LABEL_X - 4} ${rowY}`);
    q(id + 'Line').setAttribute('opacity', strong ? '0.9' : '0.45');
    const t = q(id + 'Text');
    t.textContent = '';
    t.appendChild(svgEl('tspan', { x: PA_LABEL_X, y: rowY - 3, 'font-size': 10.5, 'font-weight': strong ? 700 : 500, fill: nameFill }, name));
    t.appendChild(svgEl('tspan', { x: PA_LABEL_X, y: rowY + 11, 'font-size': 12, 'font-weight': 700, fill: valueFill }, value));
  }

  function clearSvg() {
    ['svgLMeas', 'svgLReqNo', 'svgLReqTotal', 'svgLStruct'].forEach(id => {
      q(id + 'Line').setAttribute('d', '');
      q(id + 'Text').textContent = '';
    });
    q('svgPocketLoss').setAttribute('d', '');
    q('svgPocketNominalLine').setAttribute('d', '');
    ['svgReqTotalLine', 'svgReqNoCaLine', 'svgStructLine'].forEach(id => {
      const el = q(id);
      el.setAttribute('x1', 0); el.setAttribute('x2', 0); el.setAttribute('y1', 0); el.setAttribute('y2', 0);
    });
    q('svgRuler').textContent = '';
    q('svgOdCap').textContent = '';
    q('svgIdCap').textContent = '';
    q('svgSpare').style.display = 'none';
    q('svgDragHandle').style.display = 'none';
  }

  function drawSvg(res) {
    if (!svg) return;
    if (!res || res.hasErrors) {
      clearSvg();
      // Literal hex, not var(--text-light): a CSS custom property used as a static SVG fill was
      // observed to compute correctly but not paint in Chromium.
      const emptyLines = ['Enter pipe geometry', '& design pressure to', 'see the wall profile'];
      ['svgEmptyState', 'svgEmptyState2', 'svgEmptyState3'].forEach((id, i) => {
        const el = q(id);
        el.setAttribute('fill', '#94a3b8');
        el.textContent = emptyLines[i];
      });
      return;
    }
    ['svgEmptyState', 'svgEmptyState2', 'svgEmptyState3'].forEach(id => { q(id).textContent = ''; });

    const { left: PLOT_L, right: PLOT_R, yOd: Y_OD, yId: Y_ID, pocketL: POCKET_L, pocketR: POCKET_R, pocketC: POCKET_C, pocketHalfW: POCKET_HW } = PA_WALL_PLOT;
    const scale = (Y_ID - Y_OD) / res.t_nom;
    const tMeasDraw = Math.min(res.t_nom, res.t_meas);
    const clampY = (y) => Math.max(Y_OD - 6, Math.min(Y_ID + 6, y));
    // Wall thickness t is measured from the side that is NOT corroding: from the inside surface for
    // external loss, from the outside surface for internal loss. The ruler uses the same origin, so
    // every limit line reads straight off it.
    const yAt = (t) => clampY(res.isInternal ? Y_OD + t * scale : Y_ID - t * scale);

    // Flat pocket floor with smooth cosine shoulders — reads like a UT thickness-survey /
    // API 579 flaw profile rather than a sharp notch.
    const buildPocketPoints = (yFlat, yFloor, floorIsBelowFlat) => {
      const amp = Math.abs(yFloor - yFlat);
      const plateau = POCKET_HW * 0.35;
      const pts: any[] = [];
      for (let x = POCKET_L; x <= POCKET_R; x += 2) {
        const dx = Math.abs(x - POCKET_C);
        let frac;
        if (dx <= plateau) {
          frac = 1;
        } else {
          const t = Math.min(1, (dx - plateau) / (POCKET_HW - plateau));
          frac = Math.cos(t * Math.PI / 2) ** 2;
        }
        const y = floorIsBelowFlat ? yFlat + amp * frac : yFlat - amp * frac;
        pts.push(`${x},${paFmt(y, 1)}`);
      }
      return pts;
    };

    const y_meas = yAt(tMeasDraw);
    const yFlat = res.isInternal ? Y_ID : Y_OD;
    const lg = q('svgLossGrad');
    if (lg) { lg.setAttribute('y1', res.isInternal ? '1' : '0'); lg.setAttribute('y2', res.isInternal ? '0' : '1'); }
    const points = buildPocketPoints(yFlat, y_meas, !res.isInternal);
    q('svgPocketLoss').setAttribute('d', `M ${POCKET_L} ${yFlat} L ` + points.join(' L ') + ` L ${POCKET_R} ${yFlat} Z`);
    q('svgPocketNominalLine').setAttribute('d', `M ${POCKET_L} ${yFlat} L ${POCKET_R} ${yFlat}`);

    // surface captions (small, muted — they orient, they are not results)
    const od = q('svgOdCap'), idc = q('svgIdCap');
    od.setAttribute('x', PLOT_L); od.setAttribute('y', Y_OD - 8); od.textContent = 'Outside surface';
    idc.setAttribute('x', PLOT_L); idc.setAttribute('y', Y_ID + 17); idc.textContent = 'Original inside surface';

    // mm ruler on the left: a "nice" step giving at most ~7 intervals
    const ruler = q('svgRuler');
    ruler.textContent = '';
    const step = [0.5, 1, 2, 2.5, 5, 10, 20].find(st => res.t_nom / st <= 7) || 50;
    const RX = PLOT_L - 8;
    ruler.appendChild(svgEl('line', { x1: RX, y1: Y_OD, x2: RX, y2: Y_ID, stroke: '#cbd5e1', 'stroke-width': 1 }));
    for (let v = 0; v <= res.t_nom + 1e-9; v += step) {
      const y = yAt(v);
      ruler.appendChild(svgEl('line', { x1: RX - 4, y1: y, x2: RX, y2: y, stroke: '#94a3b8', 'stroke-width': 1 }));
      ruler.appendChild(svgEl('text', { x: RX - 7, y: y + 3, 'text-anchor': 'end', 'font-size': 9, 'font-family': 'Google Sans, Inter, sans-serif', fill: '#94a3b8' }, String(+v.toFixed(1))));
    }
    ruler.appendChild(svgEl('text', { x: RX - 7, y: res.isInternal ? Y_ID + 17 : Y_OD - 8, 'text-anchor': 'end', 'font-size': 9, 'font-family': 'Google Sans, Inter, sans-serif', fill: '#94a3b8', 'font-weight': 600 }, 'mm'));

    // The deciding limit = the higher of t_req + CA (REPAIR below it) and the API 574 minimum
    // (MONITOR below it) — the line the verdict is actually measured against (computeB313).
    const govIsStruct = res.t_struct > res.t_req_total;
    const govT = govIsStruct ? res.t_struct : res.t_req_total;
    const limits = [
      { id: 'svgLReqTotal', line: 'svgReqTotalLine', t: res.t_req_total, name: PA_LABELS.tReqCa.short, color: 'var(--limit-reqca)', gov: !govIsStruct, d: 3 },
      { id: 'svgLReqNo', line: 'svgReqNoCaLine', t: res.t_req_noCA, name: PA_LABELS.tReq.short, color: 'var(--limit-req)', gov: false, d: 3 },
      { id: 'svgLStruct', line: 'svgStructLine', t: res.t_struct, name: PA_LABELS.tStruct.short, color: 'var(--limit-struct)', gov: govIsStruct, d: 2 },
    ];
    limits.forEach(L => {
      const el = q(L.line), y = yAt(L.t);
      el.setAttribute('x1', PLOT_L); el.setAttribute('x2', PLOT_R);
      el.setAttribute('y1', y); el.setAttribute('y2', y);
      el.setAttribute('stroke-width', L.gov ? '2.6' : '1.2');
      el.setAttribute('opacity', L.gov ? '1' : '0.55');
    });

    // Right-column labels at their true heights, pushed apart just enough not to overlap
    const items = [
      { id: 'svgLMeas', y: y_meas, name: PA_LABELS.tMeas.short, value: `${paFmt(res.t_meas)} mm  (${paFmt(res.depth)} mm lost)`, nameFill: '#334155', valueFill: '#0f172a', strong: true },
      ...limits.map(L => ({
        id: L.id, y: yAt(L.t),
        name: L.gov ? `${L.name} · decides` : L.name,
        value: `${paFmt(L.t, L.d)} mm`,
        nameFill: L.gov ? L.color : '#64748b', valueFill: L.gov ? L.color : '#475569', strong: L.gov,
      })),
    ].sort((a, b) => a.y - b.y);
    const GAP = 31, TOP = 16, BOTTOM = 252;
    const rows = items.map(it => it.y);
    for (let i = 0; i < rows.length; i++) rows[i] = Math.max(rows[i], TOP, i ? rows[i - 1] + GAP : TOP);
    for (let i = rows.length - 1; i >= 0; i--) rows[i] = Math.min(rows[i], i === rows.length - 1 ? BOTTOM : rows[i + 1] - GAP);
    items.forEach((it, i) => setLabel(it.id, it.y, rows[i], it.name, it.value, it.nameFill, it.valueFill, it.strong));

    // Above/below-limit bracket: from the thinnest point to the deciding limit, in the verdict colour
    const spare = res.t_meas - govT;
    const color = PA_VERDICT_HEX[res.status] || '#475569';
    const yG = yAt(govT);
    // The bracket rises from the drag handle (the thinnest point, centre of the pocket floor); its
    // pill sits ON the bracket, inside the pipe, so it never runs into the label column. When the gap
    // is too small for the pill, it moves just past the bracket's far end (into solid metal).
    const BX = POCKET_C;
    q('svgSpare').style.display = '';
    const setLine = (k, x1, y1, x2, y2) => {
      const el = q(k);
      el.setAttribute('x1', x1); el.setAttribute('y1', y1); el.setAttribute('x2', x2); el.setAttribute('y2', y2);
      el.setAttribute('stroke', color);
    };
    setLine('svgSpareLine', BX, y_meas, BX, yG);
    setLine('svgSpareCapA', BX - 6, y_meas, BX + 6, y_meas);
    setLine('svgSpareCapB', BX - 6, yG, BX + 6, yG);
    // measured to whichever limit decides, so it can differ from the results' "Vs. min. + CA" row
    const label = paLimitGap(spare, 2);
    const w = label.length * 6.2 + 14; // width estimate: getComputedTextLength is 0 while hidden
    const lo = Math.max(y_meas, yG), hi = Math.min(y_meas, yG);
    let cy = (y_meas + yG) / 2;
    if (lo - hi < 30) cy = lo + 18 <= Y_ID - 10 ? lo + 18 : hi - 18;
    cy = Math.max(Y_OD + 10, Math.min(Y_ID - 10, cy));
    const pill = q('svgSparePill');
    pill.setAttribute('x', BX - w / 2); pill.setAttribute('y', cy - 9); pill.setAttribute('width', w); pill.setAttribute('fill', color);
    const st = q('svgSpareText');
    st.setAttribute('x', BX); st.setAttribute('y', cy + 4); st.setAttribute('text-anchor', 'middle'); st.textContent = label;

    const dragHandle = q('svgDragHandle');
    dragHandle.setAttribute('cx', POCKET_C);
    dragHandle.setAttribute('cy', y_meas);
    dragHandle.style.display = opts.onDepthDrag ? 'block' : 'none';
  }

  /* ---- hover cross-highlighting between limit lines and their labels ---- */

  const HOVER_MAP = {
    'svgReqTotalLine': ['svgReqTotalLine', 'svgLReqTotalLine', 'svgLReqTotalText'],
    'svgReqNoCaLine': ['svgReqNoCaLine', 'svgLReqNoLine', 'svgLReqNoText'],
    'svgStructLine': ['svgStructLine', 'svgLStructLine', 'svgLStructText'],
    'svgPocketLoss': ['svgPocketLoss', 'svgLMeasLine', 'svgLMeasText']
  };

  function initHover() {
    if (!svg) return;
    const reverseMap = {};
    for (const targets of Object.values(HOVER_MAP)) {
      targets.forEach(targetId => { reverseMap[targetId] = targets; });
    }
    Object.keys(reverseMap).forEach(id => {
      const el = q(id);
      if (!el) return;
      el.style.pointerEvents = 'all';
      el.addEventListener('mouseenter', () => {
        svg.classList.add('has-highlight');
        reverseMap[id].forEach(t => { const te = q(t); if (te) te.classList.add('highlighted'); });
      });
      el.addEventListener('mouseleave', () => {
        svg.classList.remove('has-highlight');
        reverseMap[id].forEach(t => { const te = q(t); if (te) te.classList.remove('highlighted'); });
      });
    });
  }

  /* ---- drag handle: vertical drag adjusts wall-loss depth via the host callback ---- */

  function initDrag() {
    if (!svg || !opts.onDepthDrag) return;
    const handle = q('svgDragHandle');
    if (!handle) return;
    let dragging = false;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      handle.classList.add('dragging');
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging || !lastRes || lastRes.hasErrors) return;
      const rect = svg.getBoundingClientRect();
      const mouseY = ((e.clientY - rect.top) / rect.height) * 270;
      const t_nom_val = lastRes.t_nom;
      const { yOd: Y_OD, yId: Y_ID } = PA_WALL_PLOT;
      const scale = (Y_ID - Y_OD) / t_nom_val;
      const y_m = Math.max(Y_OD, Math.min(Y_ID, mouseY));
      const depth_px = lastRes.isInternal ? (Y_ID - y_m) : (y_m - Y_OD);
      const depth_mm = Math.max(0, Math.min(t_nom_val - 0.1, depth_px / scale));
      opts.onDepthDrag(depth_mm);
    });

    window.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        handle.classList.remove('dragging');
      }
    });
  }

  /* ---- substituted equations ---- */

  function renderEquations(res, nps?) {
    if (!root.querySelector('.eq-section')) return;
    const setAll = (sel, text) => qa('.eq-section ' + sel).forEach(el => el.textContent = text);

    if (!res || res.hasErrors) {
      ['.sub-P', '.sub-D', '.sub-S', '.sub-E', '.sub-W', '.sub-Y', '.sub-CA', '.sub-tmeas', '.sub-CR',
       '.sub-treq-val', '.sub-treq-total-val', '.sub-tuse-with', '.sub-mawp-with-mpa', '.sub-mawp-with-res',
       '.sub-mawp-no-mpa', '.sub-mawp-no-res', '.sub-nps', '.sub-tstruct'].forEach(sel => setAll(sel, '—'));
      const structBadge = q('eqSubStructStatus');
      if (structBadge) { structBadge.className = 'eq-status-badge'; structBadge.textContent = '—'; }
      const erlSec = q('eqSectionErl');
      if (erlSec) erlSec.style.display = 'none';
      return;
    }

    setAll('.sub-P', paFmt(res.P, 3));
    setAll('.sub-D', paFmt(res.D, 2));
    setAll('.sub-S', paFmt(res.S, 1));
    setAll('.sub-E', paFmt(res.E, 2));
    setAll('.sub-W', paFmt(res.W, 2));
    setAll('.sub-Y', paFmt(res.Y, 1));
    setAll('.sub-CA', paFmt(res.ca, 2));
    setAll('.sub-tmeas', paFmt(res.t_meas, 2));
    setAll('.sub-treq-val', paFmt(res.t_req_noCA, 3));
    setAll('.sub-treq-total-val', paFmt(res.t_req_total, 3));

    const t_use_with = Math.max(0, res.t_meas - res.ca);
    const denom_with = res.D - (2 * res.Y * t_use_with);
    const mawp_with_mpa = denom_with > 0 ? (2 * res.S * res.E * res.W * t_use_with) / denom_with : 0;
    const denom_no = res.D - (2 * res.Y * res.t_meas);
    const mawp_no_mpa = denom_no > 0 ? (2 * res.S * res.E * res.W * res.t_meas) / denom_no : 0;

    setAll('.sub-tuse-with', paFmt(t_use_with, 2));
    setAll('.sub-mawp-with-mpa', paFmt(mawp_with_mpa, 2));
    setAll('.sub-mawp-with-res', paFmt(res.mawp_with, 2));
    setAll('.sub-mawp-no-mpa', paFmt(mawp_no_mpa, 2));
    setAll('.sub-mawp-no-res', paFmt(res.mawp_no, 2));
    setAll('.sub-nps', nps || '—');
    setAll('.sub-tstruct', paFmt(res.t_struct, 2));
    qa('.p-unit-lbl').forEach(el => el.textContent = res.pUnit);

    const structBadge = q('eqSubStructStatus');
    if (structBadge) {
      structBadge.className = 'eq-status-badge';
      if (res.t_meas < res.t_struct) {
        structBadge.classList.add('warning');
        structBadge.textContent = 'Thin (t_meas < t_struct)';
      } else {
        structBadge.classList.add('ok');
        structBadge.textContent = 'OK (t_meas ≥ t_struct)';
      }
    }

    const erlSec = q('eqSectionErl');
    if (erlSec) {
      if (res.CR > 0) {
        erlSec.style.display = 'block';
        setAll('.sub-CR', paFmt(res.CR, 2));
        qa('.eq-section .sub-erl-val').forEach(el => {
          el.textContent = res.remainingLife !== null
            ? (res.remainingLife >= 0 ? paFmt(res.remainingLife, 2) : '0.00')
            : '—';
        });
      } else {
        erlSec.style.display = 'none';
      }
    }
  }

  /* ---- orchestrator ---- */

  function render(res, ctx) {
    ctx = ctx || {};
    lastRes = res;
    lastCtx = ctx;

    if (!res || res.hasErrors) {
      const neutral = !!ctx.neutral;
      if (has('statusBox')) {
        q('statusBox').className = 'status-banner' + (neutral ? ' s-neutral' : ' s-rep');
        q('statusVal').textContent = neutral ? '—' : 'ERROR';
        q('statusNotes').textContent = neutral
          ? 'Enter pipe geometry and design pressure to begin.'
          : 'Calculation halted. Please check highlighted invalid input parameters.';
      }
      if (has('resTnom')) {
        ['resTnom', 'resPct', 'resTreq', 'resTreqCa', 'resTstruct', 'resMargin', 'resPres', 'resMawpWith', 'resMawpNoCA', 'resErfWith', 'resErfNo', 'resCa', 'resCr', 'resLife', 'gaugeErfVal'].forEach(k => {
          const el = q(k);
          if (el) el.textContent = '—';
        });
        q('erlCaveat').style.display = 'none';
        // Neutral "no data yet" state: the track's own base color is the danger-red overpressure
        // zone (see .pressure-gauge-track in theme.css — it's the backdrop the safe/warning zones
        // overlay), so with both zones at 0% width the whole bar would otherwise read as solid red
        // before the user has entered anything. is-neutral swaps it to a plain gray until a real
        // result exists.
        q('gaugeTrack').classList.add('is-neutral');
        q('zoneSafe').style.width = '0%';
        q('zoneWarning').style.width = '0%';
        q('pressurePointer').style.left = '0%';
        q('gaugeErfOvershoot').style.display = 'none';
        ['compB313', 'comp574'].forEach(k => {
          const el = q(k);
          el.textContent = '—';
          el.className = 'compliance-badge';
        });
        q('ffsNote').style.display = 'none';
      }
      drawSvg(null);
      renderEquations(null);
      return;
    }

    // mawp_with is null when the remaining wall is already at/below CA (no valid "with CA"
    // thickness) — carry that through as a null ERF so both render as "n/a", not a pegged 9.99.
    const erf_with = res.mawp_with == null ? null : (res.mawp_with > 0 ? (res.P_input / res.mawp_with) : 9.99);
    const erf_no = res.mawp_no > 0 ? (res.P_input / res.mawp_no) : 9.99;

    if (has('statusBox')) {
      const banner = q('statusBox');
      banner.className = 'status-banner';
      if (res.status === 'OK') banner.classList.add('s-ok');
      else if (res.status === 'MONITOR') banner.classList.add('s-mon');
      else if (res.status === 'REPAIR') banner.classList.add('s-rep');
      q('statusVal').textContent = res.status;
      q('statusNotes').textContent = paStatusText(res);
    }

    if (has('resTnom')) {
      q('resTnom').textContent = `${paFmt(res.t_nom)} mm`;
      q('resPct').textContent = `${paFmt(res.pctRemainNom, 1)} %`;
      q('resTreq').textContent = `${paFmt(res.t_req_noCA, 3)} mm`;
      q('resTreqCa').textContent = `${paFmt(res.t_req_total, 3)} mm`;
      q('resTstruct').textContent = `${paFmt(res.t_struct)} mm${res.isCsRef ? ' (carbon-steel reference; not verified for this material)' : ''}`;
      q('resMargin').textContent = paLimitGap(res.margin, 3);
      q('resPres').textContent = `${paFmt(res.P_input, 1)} ${res.pUnit}`;
      q('resMawpWith').textContent = res.mawp_with == null ? 'n/a — wall below CA' : `${paFmt(res.mawp_with, 2)} ${res.pUnit}`;
      q('resMawpNoCA').textContent = `${paFmt(res.mawp_no, 2)} ${res.pUnit}`;
      q('resErfWith').textContent = erf_with == null ? 'n/a' : `${paPressureUsePct(erf_with)} (ERF ${paFmt(erf_with, 3)})`;
      q('resErfNo').textContent = `${paPressureUsePct(erf_no)} (ERF ${paFmt(erf_no, 3)})`;
      q('resCa').textContent = `${paFmt(res.ca)} mm`;
      q('resCr').textContent = res.CR > 0 ? `${paFmt(res.CR, 2)} mm/year` : '—';

      // ERF gauge — headline is the no-CA figure (today's actual capacity from the
      // measured thickness); "with CA" stays a secondary reference in the grid only.
      q('gaugeErfVal').textContent = paPressureUsePct(erf_no);
      q('gaugeTrack').classList.remove('is-neutral');
      const ERF_GAUGE_MAX = 1.5;
      const isOffScale = isFinite(erf_no) && erf_no > ERF_GAUGE_MAX;
      const pointerPct = Math.min(100, Math.max(0, (erf_no / ERF_GAUGE_MAX) * 100));
      q('zoneSafe').style.width = '53.3%';
      q('zoneWarning').style.width = '13.3%';
      const pointerEl = q('pressurePointer');
      pointerEl.style.left = pointerPct.toFixed(1) + '%';
      pointerEl.classList.toggle('pinned', isOffScale);
      pointerEl.title = isOffScale ? `Pressure use ${paPressureUsePct(erf_no)} — beyond the gauge scale` : 'Pressure use today';
      q('gaugeErfOvershoot').style.display = isOffScale ? 'inline' : 'none';

      if (res.remainingLife !== null) {
        q('resLife').textContent = res.remainingLife >= 0
          ? `${paFmt(res.remainingLife, 2)} years`
          : '0.00 years (exceeded design limit)';
        q('erlCaveat').style.display = 'block';
      } else {
        q('resLife').textContent = '—';
        q('erlCaveat').style.display = 'none';
      }

      const b313Pass = res.margin >= 0;
      const api574Pass = res.t_meas >= res.t_struct;
      const compB = q('compB313');
      compB.textContent = b313Pass ? 'PASS' : 'FAIL';
      compB.className = 'compliance-badge ' + (b313Pass ? 'pass' : 'fail');
      const comp5 = q('comp574');
      comp5.textContent = api574Pass ? 'PASS' : 'FAIL';
      comp5.className = 'compliance-badge ' + (api574Pass ? 'pass' : 'fail');
      q('ffsNote').style.display = (b313Pass && api574Pass) ? 'none' : 'block';
    }

    drawSvg(res);
    renderEquations(res, ctx.nps);
  }

  initHover();
  initDrag();

  return {
    root,
    render,
    getSvg: () => svg,
    getLastRes: () => lastRes
  };
}
