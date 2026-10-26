/* ============================================================================
   Plain-language labels for the ASME B31.3 results — the ONE source for every
   results label in the web workbench, the cross-section figure, the PDF reports
   and the slide deck. Field users are not engineers, so each quantity leads with
   what it MEANS ("Minimum wall + corrosion allowance") and keeps the engineering
   symbol only as a small secondary hint ("t_req + CA") so an engineer can still
   map it onto the Governing Equations, which deliberately stay symbolic.

   `plain`  — the headline label (no unexplained acronyms).
   `sym`    — the symbol / code term, shown muted beside it ('' = none).
   `short`  — a tighter variant for cramped spots (SVG figure, slide tiles).
   PDF text must stay WinAnsi-safe: write >= / <= / '/', never the Unicode signs.
   ============================================================================ */

export interface PaLabel { plain: string; sym: string; short: string }

export const PA_LABELS = {
  tNom:    { plain: 'Original wall thickness', sym: 't_nom', short: 'Original wall' },
  tMeas:   { plain: 'Thinnest wall measured', sym: 't_meas', short: 'Thinnest wall' },
  depth:   { plain: 'Wall lost', sym: 'd', short: 'Wall lost' },
  pct:     { plain: 'Wall remaining', sym: '% of original', short: 'Wall remaining' },
  tReq:    { plain: 'Minimum wall for pressure', sym: 't_req', short: 'Min. for pressure' },
  tReqCa:  { plain: 'Minimum wall + corrosion allowance', sym: 't_req + CA', short: 'Min. + corrosion allowance' },
  tStruct: { plain: 'Minimum wall for strength (API 574)', sym: 't_struct', short: 'Min. for strength (API 574)' },
  margin:  { plain: 'Thinnest wall vs. min. + corrosion allowance', sym: 'margin', short: 'Vs. min. + CA' },
  p:       { plain: 'Design pressure', sym: 'P', short: 'Design pressure' },
  mawpNo:  { plain: 'Max. safe pressure — today', sym: 'MAWP', short: 'Max. safe pressure' },
  erfNo:   { plain: 'Pressure use — today', sym: 'ERF = P / MAWP', short: 'Pressure use' },
  mawpCa:  { plain: 'Max. safe pressure — keeping the corrosion allowance', sym: 'MAWP, CA reserved', short: 'Max. safe (CA kept)' },
  erfCa:   { plain: 'Pressure use — keeping the corrosion allowance', sym: 'ERF, CA reserved', short: 'Use (CA kept)' },
  ca:      { plain: 'Corrosion allowance — reserve for future loss', sym: 'CA', short: 'Corrosion allowance' },
  cr:      { plain: 'Corrosion rate', sym: 'CR', short: 'Corrosion rate' },
  life:    { plain: 'Estimated remaining life', sym: '', short: 'Remaining life' },
} satisfies Record<string, PaLabel>;

export type PaLabelKey = keyof typeof PA_LABELS;

// "Plain (sym)" — PDF tables and other plain-text spots.
export function paLabelText(key: PaLabelKey): string {
  const l = PA_LABELS[key];
  return l.sym ? `${l.plain} (${l.sym})` : l.plain;
}

// Web: plain label + the symbol in a muted .lbl-sym span, with t_xxx rendered as t<sub>xxx</sub>.
export function paLabelHtml(key: PaLabelKey): string {
  const l = PA_LABELS[key];
  if (!l.sym) return l.plain;
  const sym = l.sym.replace(/t_(\w+)/g, 't<sub>$1</sub>');
  return `${l.plain} <span class="lbl-sym">(${sym})</span>`;
}

// Signed wall distance to a limit, worded "1.11 mm above limit" / "0.40 mm below limit". Users found
// "spare" (and a bare +/- sign) unclear; above/below says which side of the limit the wall is on.
// `limit` names the limit where the context does not (e.g. 'min. + CA' in the PDF result band).
export function paLimitGap(mm: number | null | undefined, decimals = 2, limit = 'limit'): string {
  if (mm == null || !isFinite(mm)) return '—';
  return `${Math.abs(mm).toFixed(decimals)} mm ${mm >= 0 ? 'above' : 'below'} ${limit}`;
}

// ERF as "pressure use": ERF = P / MAWP, i.e. the share of the safe limit the design pressure uses.
export function paPressureUsePct(erf: number | null | undefined): string {
  return erf == null || !isFinite(erf) ? '—' : `${Math.round(erf * 100)}%`;
}
