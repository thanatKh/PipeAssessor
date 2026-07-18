/* ============================================================================
   ASME B31.3 assessment engine — the SINGLE source of the wall-thickness math,
   consumed by every assessment surface (form workbench, detail page, quick calc,
   PDF). DOM-free and side-effect-free: validation returns an `errors` map the
   caller maps onto its own UI. Ported 1:1 from asset/shared.js — any change here
   must pass the numeric-identity regression (compute.test.ts) before shipping.
   ============================================================================ */
import type { B313Inputs, B313Result } from '../types/models';
import { PA_PIPE_DATABASE, PA_MATERIALS } from './pipe-data';
import { paFmt } from './format';

// Re-export the reference tables so the engine's public surface is one import.
export { PA_PIPE_DATABASE, PA_MATERIALS };

/* API 574 Default Minimum Structural Thickness for Carbon/Low-Alloy Steel */
export function paGetApi574Min(nps: string): number {
  const map: Record<string, number> = {
    '1/2"': 1.8,
    '3/4"': 1.8,
    '1"': 1.8,
    '1-1/4"': 1.8,
    '1-1/2"': 1.8,
    '2"': 1.8,
    '2-1/2"': 1.8,
    '3"': 2.0,
    '4"': 2.3,
    '6"': 2.8,
    '8"': 2.8,
    '10"': 2.8,
    '12"': 2.8,
    '14"': 2.8,
    '16"': 2.8,
    '18"': 2.8,
    '20"': 3.1,
    '24"': 3.1
  };
  return map[nps] || 3.1;
}

/* Field convention: Sch 80 for small-bore (<=1-1/2"), Sch 40 for 2" NPS and above */
export function paDefaultScheduleForNps(nps: string): string {
  const smallBore = ['1/2"', '3/4"', '1"', '1-1/4"', '1-1/2"'];
  return smallBore.includes(nps) ? '80' : '40';
}

/* Pure ASME B31.3 assessment. Returns an errors map on invalid input (result fields absent),
   otherwise the full result object. Validation field keys: overrideTnom, overrideOd, P, S,
   depth, tmeas, ca. */
export function computeB313(p: B313Inputs): B313Result {
  const num = (v: any, d?: number): number => { const n = parseFloat(v); return isNaN(n) ? (d == null ? NaN : d) : n; };
  const errors: Record<string, true | string> = {};

  const pipe = PA_PIPE_DATABASE[p.nps];
  if (!pipe) return { hasErrors: true, errors: { nps: 'Unknown pipe size.' } } as B313Result;
  const schObj = pipe.schedules[p.sch];
  if (!schObj) return { hasErrors: true, errors: { sch: 'Unknown schedule for this size.' } } as B313Result;

  // OD (optional as-found override)
  let D = pipe.od;
  const ovrOdOn = p.overrideOd !== '' && p.overrideOd != null;
  if (ovrOdOn) {
    const customD = parseFloat(p.overrideOd as any);
    if (!isNaN(customD) && customD > 0) D = customD;
    else errors.overrideOd = true;
  }

  // Nominal wall thickness (optional override)
  let t_nom = schObj.t;
  const ovrTOn = p.overrideTnom !== '' && p.overrideTnom != null;
  if (ovrTOn) {
    const customT = parseFloat(p.overrideTnom as any);
    if (!isNaN(customT) && customT > 0) t_nom = customT;
    else errors.overrideTnom = true;
  }

  const mode = p.mode === 'tmeas' ? 'tmeas' : 'depth';
  let t_meas = 0, depth = 0;
  if (mode === 'depth') {
    depth = num(p.depth, 0);
    t_meas = Math.max(0, t_nom - depth);
  } else {
    t_meas = num(p.tmeas, 0);
    depth = Math.max(0, t_nom - t_meas);
  }

  const ca = num(p.ca, 0);
  const P_input = num(p.pInput, 0);
  const pUnit = p.pUnit === 'psi' ? 'psi' : 'bar';
  const P = (pUnit === 'bar') ? P_input * 0.1 : P_input * 0.006894757;

  const S = num(p.S, 0);
  const E = num(p.E, 1);
  const W = num(p.W, 1);
  const Y = num(p.Y, 0.4);
  const CR = num(p.CR, 0);

  if (P_input <= 0) errors.P = true;
  if (S <= 0) errors.S = true;
  if (mode === 'depth' && depth > t_nom) errors.depth = true;
  if (mode === 'tmeas' && t_meas > t_nom) errors.tmeas = true;
  if (ca < 0) errors.ca = 'CA cannot be negative.';
  // NOTE: CA >= t_meas is NOT a hard error. CA is a forward-looking reserve, not the loss already
  // measured; a thin pipe whose remaining wall is already below its corrosion allowance is a valid
  // (and meaningful) real-world case. The no-CA headline (ERF/MAWP at the measured thickness) still
  // computes fine — only the secondary "with CA" figures become undefined (mawp_with = null below).

  if (Object.keys(errors).length) return { hasErrors: true, errors } as B313Result;

  // ASME B31.3 Para. 304.1.2 required thickness: t = (P*D) / (2*(S*E*W + P*Y))
  const denom = 2 * (S * E * W + P * Y);
  const t_req_noCA = denom > 0 ? (P * D) / denom : 0;
  const t_req_total = t_req_noCA + ca;
  const margin = t_meas - t_req_total;
  const pctRemainNom = (t_meas / t_nom) * 100;

  // MAWP: P = (2*S*E*W*t) / (D - 2*Y*t)
  function computeMAWP(t_use: number): number {
    if (t_use <= 0) return 0;
    const denomM = D - (2 * Y * t_use);
    if (denomM <= 0) return 0;
    const P_mpa = (2 * S * E * W * t_use) / denomM;
    return (pUnit === 'bar') ? P_mpa / 0.1 : P_mpa / 0.006894757;
  }
  // With-CA MAWP is evaluated at the wall left AFTER the reserve is consumed (t_meas − CA). If the
  // remaining wall is already at/below CA there's no valid "with CA" thickness → null (rendered n/a),
  // never a misleading 0. The no-CA MAWP (today's actual capacity at t_meas) is always computed.
  const caExceedsWall = ca >= t_meas;
  const mawp_with = caExceedsWall ? null : computeMAWP(t_meas - ca);
  const mawp_no = computeMAWP(t_meas);

  const t_struct = paGetApi574Min(p.nps);
  const matCode = p.matCode;
  const isCsRef = (matCode === 'TP304' || matCode === 'TP316' || matCode === 'MANUAL');

  let status: 'OK' | 'MONITOR' | 'REPAIR' = 'OK';
  let desc = 'Pipe meets allowable pressure limits with sufficient design margin.';
  let structRefWarning = false;

  if (margin < 0) {
    status = 'REPAIR';
    desc = 'CRITICAL: Remaining wall thickness is below minimum required design limit (including Corrosion Allowance). Immediately plan repair or spool replacement.';
  } else if (t_meas < t_struct) {
    status = 'MONITOR';
    desc = 'WARNING: Remaining wall thickness (' + paFmt(t_meas) + ' mm) is below API 574 minimum structural threshold (' + paFmt(t_struct) + ' mm). Pipeline is at risk of sag or collapse under structural loads.';
    if (isCsRef) structRefWarning = true;
  } else if (margin < 0.1 * t_req_total || pctRemainNom < 50) {
    status = 'MONITOR';
    desc = 'WARNING: Wall thickness is approaching design limits (remaining margin is less than 10% of required limit, or pipe has lost over 50% of its nominal thickness). Increase inspection frequency.';
  }
  if (structRefWarning) {
    desc += ' NOTE: The API 574 structural minimum used above is a carbon/low-alloy steel reference table; it has not been validated for the selected material and may not be an appropriate structural floor for this pipe.';
  }

  let remainingLife: number | null = null;
  if (CR > 0) remainingLife = (t_meas - t_req_total) / CR;

  return {
    hasErrors: false, errors: {},
    t_nom, t_meas, depth, D,
    t_req_noCA, t_req_total, t_struct, isCsRef,
    margin, pctRemainNom, mawp_with, mawp_no, caExceedsWall,
    status, desc, remainingLife,
    ca, CR, P_input, pUnit, isInternal: !!p.isInternal,
    S, E, W, Y, P
  };
}
