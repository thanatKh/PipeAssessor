/* ============================================================================
   Engine numeric-identity regression (the hard migration gate).
   Compares the ported, typed computeB313 (src/engine/compute.ts) against the
   pre-migration reference — the original asset/shared.js, evaluated verbatim in
   a VM sandbox — across a broad matrix of sizes / schedules / materials / modes /
   depths / pressures / CA / overrides / factors. Must be 0 mismatches.
   ============================================================================ */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { computeB313 as computeNew } from './compute';
import type { B313Inputs } from '../types/models';

/* ---- Build the reference computeB313 from the original shared.js, verbatim ---- */
const sharedSrc = readFileSync(new URL('../../asset/shared.js', import.meta.url), 'utf8');
const sandbox: any = {
  // registerGoogleSansWebFont() runs at load and touches the DOM — stub just enough.
  document: {
    getElementById: () => null,
    createElement: () => ({} as any),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
  },
};
vm.createContext(sandbox);
vm.runInContext(
  sharedSrc +
    '\n;this.__computeB313 = computeB313;' +
    '\n;this.__PA_PIPE_DATABASE = PA_PIPE_DATABASE;' +
    '\n;this.__PA_MATERIALS = PA_MATERIALS;',
  sandbox,
);
const computeOld = sandbox.__computeB313 as (p: any) => any;
const PIPE_DB = sandbox.__PA_PIPE_DATABASE as Record<string, { od: number; schedules: Record<string, { t: number }> }>;
const MATERIALS = sandbox.__PA_MATERIALS as Array<{ code: string; stress: number | null }>;

/* ---- NaN-aware, order-independent deep compare ---- */
function deepEq(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return (Number.isNaN(a) && Number.isNaN(b));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) { if (!(k in b) || !deepEq(a[k], b[k])) return false; }
    return true;
  }
  return false;
}

/* ---- Matrix ---- */
const MODES: Array<'depth' | 'tmeas'> = ['depth', 'tmeas'];
const DEPTH_FRACS = [0, 0.3, 0.8, 1.05];          // last one drives depth>t_nom → error
const PRESSURES = [
  { pInput: 10, pUnit: 'bar' },
  { pInput: 150, pUnit: 'psi' },
  { pInput: 0, pUnit: 'bar' },                     // P<=0 → error
];
const CA_CASES = [0, 1.0, -0.5];                    // negative → error; large handled via edge loop
const OVERRIDES = [
  {},
  { overrideTnom: 5 },
  { overrideOd: 0 },                               // filled per-case with table OD + 2
  { overrideTnom: 'abc' },                         // invalid → error
];
const FACTORS = [
  { E: 1, W: 1, Y: 0.4, CR: 0 },
  { E: 0.85, W: 1, Y: 0.4, CR: 0.1 },
];

function buildCases(): B313Inputs[] {
  const cases: B313Inputs[] = [];
  let i = 0;
  for (const nps of Object.keys(PIPE_DB)) {
    const size = PIPE_DB[nps];
    for (const sch of Object.keys(size.schedules)) {
      const t_nom = size.schedules[sch].t;
      for (const mat of MATERIALS) {
        const S = mat.stress != null ? mat.stress : 120; // MANUAL supplies a manual stress
        for (const mode of MODES) {
          for (const frac of DEPTH_FRACS) {
            for (const pr of PRESSURES) {
              // rotate ca / override / factors so they're covered without full cartesian blow-up
              const ca = CA_CASES[i % CA_CASES.length];
              const ovrBase = OVERRIDES[i % OVERRIDES.length];
              const ovr: any = { ...ovrBase };
              if ('overrideOd' in ovr) ovr.overrideOd = size.od + 2;
              const fac = FACTORS[i % FACTORS.length];
              i++;
              const depthVal = t_nom * frac;
              cases.push({
                nps, sch, matCode: mat.code,
                mode,
                depth: mode === 'depth' ? depthVal : undefined,
                tmeas: mode === 'tmeas' ? Math.max(0, t_nom - depthVal) : undefined,
                ca,
                pInput: pr.pInput, pUnit: pr.pUnit,
                S, E: fac.E, W: fac.W, Y: fac.Y, CR: fac.CR,
                isInternal: (i % 2 === 0),
                ...ovr,
              });
            }
          }
        }
      }
    }
  }
  // targeted edge cases: CA >= t_meas (the one intended-difference guard — must still MATCH,
  // since both old and new share the caExceedsWall/mawp_with=null behavior after that change).
  for (const nps of ['2"', '6"', '12"']) {
    const size = PIPE_DB[nps];
    for (const sch of Object.keys(size.schedules)) {
      const t_nom = size.schedules[sch].t;
      cases.push({ nps, sch, matCode: 'A106B', mode: 'tmeas', tmeas: t_nom * 0.5, ca: t_nom, pInput: 20, pUnit: 'bar', S: 137.9, E: 1, W: 1, Y: 0.4, CR: 0 });
      cases.push({ nps, sch, matCode: 'A106B', mode: 'tmeas', tmeas: t_nom * 0.4, ca: t_nom * 0.9, pInput: 20, pUnit: 'bar', S: 137.9, E: 1, W: 1, Y: 0.4, CR: 0 });
    }
  }
  return cases;
}

describe('computeB313 numeric-identity vs pre-migration shared.js', () => {
  it('produces byte-identical results across the full matrix', () => {
    const cases = buildCases();
    const mismatches: Array<{ p: B313Inputs; old: any; neu: any }> = [];
    for (const p of cases) {
      const old = computeOld({ ...p });
      const neu = computeNew({ ...p });
      if (!deepEq(old, neu)) mismatches.push({ p, old, neu });
    }
    if (mismatches.length) {
      const m = mismatches[0];
      // surface the first divergence for debugging
      // eslint-disable-next-line no-console
      console.error('First mismatch input:', JSON.stringify(m.p));
      console.error('old:', JSON.stringify(m.old));
      console.error('new:', JSON.stringify(m.neu));
    }
    expect({ total: cases.length, mismatches: mismatches.length }).toEqual({ total: cases.length, mismatches: 0 });
    expect(cases.length).toBeGreaterThan(2000);
  });
});
