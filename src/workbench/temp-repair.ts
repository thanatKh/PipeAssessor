/* ============================================================================
   Temporary repair (emergency stop-leak) — presentation logic, shared by the
   finding detail page and the finding PDF.

   The record itself is public.temp_repair, ONE row per finding, written only
   for a finding flagged is_leaking. It replaces a standalone Excel form whose
   five sections were:

     1  ข้อมูลพื้นฐานของอุปกรณ์และระบบ   equipment / system data
     2  รายละเอียดการซ่อมแซมชั่วคราว     temporary repair details
     3  การตรวจสอบหลังติดตั้ง            post-installation verification
     4  แผนงานและกำหนดการซ่อมแซมถาวร    permanent repair plan
     5  เอกสารแนบและหลักฐานประกอบ       attachments and evidence

   Section 1 is NOT stored on temp_repair. Every one of its rows already lives
   on the finding (pipe_tag / location_desc / finding_type / description /
   service / sap_notification / sap_order) or on the latest assessment snapshot
   (P / p_unit / design_temp), so tempRepairRows reads them from there instead
   of asking the user to type them a second time. Section 5 is finding_photos
   rows of kind temp_before / temp_after, rendered by the existing photo-group
   machinery rather than by this module.

   tempRepairRows is the single source for sections 1-4 on BOTH surfaces: the
   detail page renders the returned array as .d-item pairs, buildFindingPdf
   renders the same array as autotable rows. Same principle as
   resolveIntegrityBanner and ganttBarGeom — the screen and the printed report
   cannot disagree about what the record says, because there is only one list.

   Labels are bilingual (Thai first, English second) so the generated report
   maps onto the legacy Excel form an auditor already knows, while staying
   readable to everyone else. Technical nouns stay English inside the Thai, the
   same split repair-advisor.ts uses.
   ============================================================================ */
import type { TempRepair } from '../types/models';
import { TEMP_REPAIR_METHOD_KIND, TEMP_REPAIR_RESULT_COLORS } from '../core/constants';
import { paFmtDate, paFmtDateTime } from '../engine/format';

export type TempRepairMethodKind = 'clamp' | 'composite' | 'other';

export interface TempRepairRow {
  /** Section heading the row belongs under, already bilingual. */
  section: string;
  label: string;
  value: string;
}

/**
 * Which branch of method-specific fields applies. Keyed off the stored method string via
 * TEMP_REPAIR_METHOD_KIND, never array/DOM position, so reordering the method list can never
 * silently swap a clamp record's fields for a composite one's.
 */
export function tempRepairMethodKind(tr: TempRepair | null | undefined): TempRepairMethodKind {
  if (!tr || !tr.method) return 'other';
  return ((TEMP_REPAIR_METHOD_KIND as Record<string, string>)[tr.method] as TempRepairMethodKind) || 'other';
}

/** The method as displayed — 'Other' resolves to whatever was typed in the free-text field. */
export function tempRepairMethodLabel(tr: TempRepair | null | undefined): string {
  if (!tr) return '';
  if (tr.method === 'Other') return (tr.method_other || '').trim() || 'Other';
  return tr.method || '';
}

/** The colour for the verification callout / headline strip. Fixed hex — the PDF cannot resolve CSS vars. */
export function tempRepairResultColor(tr: TempRepair | null | undefined): string {
  const r = (tr && tr.test_result) || 'Not yet tested';
  return (TEMP_REPAIR_RESULT_COLORS as Record<string, string>)[r] || TEMP_REPAIR_RESULT_COLORS['Not yet tested'];
}

/** One-line summary: method, when it went on, and whether it has been proven. */
export function tempRepairHeadline(tr: TempRepair | null | undefined): string {
  if (!tr) return '';
  const bits = [tempRepairMethodLabel(tr)];
  if (tr.installed_date) bits.push(`Installed ${paFmtDate(tr.installed_date as any)}`);
  bits.push(`Result: ${tr.test_result || 'Not yet tested'}`);
  return bits.filter(Boolean).join('  ·  ');
}

/* ---------------------------------------------------------------------------
   Row assembly. Every push goes through `add`, which drops empty values, so a
   half-filled record prints only what is actually known rather than a wall of
   em-dashes. Numbers keep their unit in the value string (there is no separate
   unit column on either surface).
   --------------------------------------------------------------------------- */

const S2 = 'Temporary Repair Details';
const S3 = 'Post-Installation Verification';
const S4 = 'Permanent Repair Plan';

function isEmpty(v: unknown): boolean {
  return v == null || v === '' || (typeof v === 'number' && !isFinite(v));
}

function num(v: unknown, unit: string): string {
  if (isEmpty(v)) return '';
  const n = Number(v);
  if (!isFinite(n)) return '';
  return `${n} ${unit}`.trim();
}

/* paFmtDate/paFmtDateTime return an em-dash for null so their callers can print a placeholder.
   Here an absent date should drop the row entirely instead, so these wrappers return '' and let
   `add`'s isEmpty check do that. */
function dt(v: unknown): string {
  return isEmpty(v) ? '' : paFmtDate(v as any);
}
function dtt(v: unknown): string {
  return isEmpty(v) ? '' : paFmtDateTime(v as any);
}

/**
 * The label/value list for sections 1-4.
 *
 * @param tr           the temp_repair row (sections 2-4)
 * @param finding      the finding it hangs off (section 1)
 * @param assessInputs the latest assessment snapshot's `inputs`, or null — section 1's pressure and
 *                     temperature come from here and are labelled as DESIGN values, because the app
 *                     stores the design envelope, not the operating condition at the time of the leak.
 */
export function tempRepairRows(
  tr: TempRepair | null | undefined,
  finding: any,
  assessInputs?: Record<string, any> | null
): TempRepairRow[] {
  if (!tr) return [];
  const rows: TempRepairRow[] = [];
  const add = (section: string, label: string, value: unknown) => {
    if (isEmpty(value)) return;
    rows.push({ section, label, value: String(value) });
  };

/* ---- 1. temporary repair details ---- */
  add(S2, 'Repair Method', tempRepairMethodLabel(tr));
  const kind = tempRepairMethodKind(tr);
  if (kind === 'clamp') {
    add(S2, 'Clamp Type', tr.clamp_type);
    add(S2, 'Clamp Size', tr.clamp_size);
    add(S2, 'Clamp Material', tr.clamp_material);
    add(S2, 'Rated Pressure', num(tr.rated_pressure_barg, 'bar(g)'));
  } else if (kind === 'composite') {
    add(S2, 'Composite System', tr.composite_system);
    add(S2, 'Layers', isEmpty(tr.composite_layers) ? '' : String(tr.composite_layers));
    add(S2, 'Laminate Thickness', num(tr.composite_thickness_mm, 'mm'));
    add(S2, 'Surface Prep', tr.surface_prep);
    add(S2, 'Cure', tr.cure_note);
  }
  add(S2, 'Installed Date', dt(tr.installed_date));
  add(S2, 'Installed By', tr.installed_by);
  add(S2, 'Installation Method', tr.install_method);

  /* ---- 3. post-installation verification ---- */
  add(S3, 'Verification Method', tr.verify_method);
  add(S3, 'Test Pressure', num(tr.test_pressure_barg, 'bar(g)'));
  add(S3, 'Tested At', dtt(tr.tested_at));
  add(S3, 'Test Result', tr.test_result);
  add(S3, '', tr.test_note);   // unlabelled continuation of Result
  add(S3, 'Monitoring', tr.monitor_freq);

  /* ---- 4. permanent repair plan ---- */
  add(S4, 'Planned Method', tr.perm_method);
  add(S4, 'Target Date', dt(tr.perm_target_date));
  add(S4, 'Responsible', tr.perm_owner);
  add(S4, 'Precautions', tr.precautions);

  return rows;
}
