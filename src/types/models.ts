/* ============================================================================
   Core domain types. Phase-1 posture: the assessment-engine types (B313*) are
   genuine and strict — they guard the safety-critical math; the persistence
   row types (Finding, Photo, …) mirror the Supabase tables but keep an index
   signature so the loosely-typed view layer ports 1:1 without fighting the
   compiler. Tighten these as modules are hardened in later phases.
   ============================================================================ */

/* ---------------- ASME B31.3 engine ---------------- */

/** Inputs tolerate string OR number (they come straight off DOM fields). */
export type Numish = number | string | null | undefined;

export interface B313Inputs {
  nps: string;
  sch: string;
  /** as-found overrides: a positive number replaces the table value; '' / null = off */
  overrideTnom?: Numish;
  overrideOd?: Numish;
  mode?: 'depth' | 'tmeas' | string;
  depth?: Numish;
  tmeas?: Numish;
  ca?: Numish;
  pInput?: Numish;
  pUnit?: 'bar' | 'psi' | string;
  S?: Numish;
  E?: Numish;
  W?: Numish;
  Y?: Numish;
  CR?: Numish;
  matCode?: string;
  isInternal?: boolean;
}

export type B313ErrorKey =
  | 'nps' | 'sch' | 'overrideTnom' | 'overrideOd' | 'P' | 'S' | 'depth' | 'tmeas' | 'ca';

/** Field → true (invalid) or a message string the caller surfaces. */
export type B313Errors = Partial<Record<B313ErrorKey, true | string>>;

export interface B313Result {
  hasErrors: boolean;
  errors: B313Errors;
  /** wall thicknesses (mm) */
  t_nom: number;
  t_meas: number;
  depth: number;
  /** outside diameter (mm) */
  D: number;
  t_req_noCA: number;
  t_req_total: number;
  t_struct: number;
  isCsRef: boolean;
  margin: number;
  pctRemainNom: number;
  /** null when the corrosion allowance already meets/exceeds the remaining wall */
  mawp_with: number | null;
  mawp_no: number;
  caExceedsWall: boolean;
  status: 'OK' | 'MONITOR' | 'REPAIR';
  desc: string;
  remainingLife: number | null;
  ca: number;
  CR: number;
  P_input: number;
  /** Echoed back verbatim from the input (defaults to 'bar(g)') and printed as-is, so this is a
      free string, NOT the 'bar' | 'psi' union it was once declared as — that union never actually
      matched the runtime value and made `tsc --noEmit` fail at compute.ts's return statement. */
  pUnit: string;
  isInternal: boolean;
  S: number;
  E: number;
  W: number;
  Y: number;
  /** design pressure converted to MPa */
  P: number;
}

export interface PipeSchedule {
  t: number;
  label: string;
}
export interface PipeSize {
  od: number;
  schedules: Record<string, PipeSchedule>;
}
export interface Material {
  name: string;
  stress: number | null;
  code: string;
}

/* ---------------- persistence rows (Supabase) ---------------- */

export type FindingStatus = 'Open' | 'Monitoring' | 'Repair Planned' | 'Repaired' | 'Closed';
// 'temp_before' / 'temp_after' are the before/after-installation evidence for the temporary repair
// record (see TempRepair below). Mirrors finding_photos' kind check constraint in db/schema.sql.
export type PhotoKind = 'found' | 'repaired' | 'temp_before' | 'temp_after';

export interface Finding {
  id: string;
  pipe_tag: string | null;
  location_desc: string | null;
  terminal: string | null;
  finding_type: string | null;
  status: FindingStatus;
  severity: string | null;
  is_leaking: boolean | null;
  estimated_cost: number | null;
  target_date: string | null;
  next_check_date: string | null;
  inspection_date: string | null;
  report_link: string | null;
  lat: number | null;
  lng: number | null;
  t_nominal: number | null;
  t_measured: number | null;
  created_at: string | null;
  [k: string]: any;
}

export interface Photo {
  id: string;
  finding_id: string;
  kind: PhotoKind;
  /** The R2 object key. Named storage_path in the DB and at every call site. */
  storage_path: string;
  [k: string]: any;
}

/**
 * The emergency stop-leak record — ONE row per finding, written only for a finding flagged
 * is_leaking (public.temp_repair, db/schema.sql section 7a). Replaces the legacy standalone Excel
 * form; its section 1 is deliberately absent because every field of it already lives on the
 * Finding or the latest Assessment snapshot and is read from there.
 */
export interface TempRepair {
  id?: string;
  finding_id: string;
  method: string;
  method_other: string | null;
  installed_date: string | null;
  installed_by: string | null;
  install_method: string | null;
  design_life_months?: number | null;
  // clamp branch
  clamp_type: string | null;
  clamp_size: string | null;
  clamp_material: string | null;
  rated_pressure_barg: number | null;
  // composite branch
  composite_system: string | null;
  composite_layers: number | null;
  composite_thickness_mm: number | null;
  surface_prep: string | null;
  cure_note: string | null;
  // verification
  verify_method: string | null;
  test_pressure_barg: number | null;
  tested_at: string | null;
  test_result: string;
  test_note: string | null;
  monitor_freq: string | null;
  // permanent repair plan
  perm_method: string | null;
  perm_target_date: string | null;
  perm_owner: string | null;
  precautions: string | null;
  [k: string]: any;
}

export interface StatusHistory {
  id: string;
  finding_id: string;
  [k: string]: any;
}

export interface Assessment {
  id?: string;
  finding_id?: string;
  inputs: B313Inputs & Record<string, any>;
  results: Record<string, any>;
  created_at?: string;
  [k: string]: any;
}

export interface LineListRow {
  id?: string;
  pipe_tag: string;
  terminal?: string | null;
  nps?: string | null;
  schedule?: string | null;
  material?: string | null;
  pid_no?: string | null;
  service?: string | null;
  [k: string]: any;
}

/* ---------------- inspection plan (#/plan) ---------------- */

export type PlanStatus = 'Draft' | 'Active' | 'Complete';
export type PlanTaskStatus = 'Not Started' | 'In Progress' | 'Done' | 'Cancelled';
export type PipeCategory = 'Underground' | 'Sub Sea' | 'Piping';

export interface InspectionPlan {
  id?: string;
  name: string;
  year: number;
  terminal?: string | null;
  pipe_category?: PipeCategory | string | null;
  status: PlanStatus | string;
  notes?: string | null;
  created_at?: string | null;
  [k: string]: any;
}

export interface PlanTask {
  id?: string;
  plan_id: string;
  seq?: number;
  task_name: string;
  /** soft reference to line_list.pipe_tag — no FK, may name a tag that no longer exists */
  pipe_tag?: string | null;
  /** all four are ISO dates pinned to the 1st of the month, e.g. '2026-03-01' */
  plan_start?: string | null;
  plan_end?: string | null;
  actual_start?: string | null;
  actual_end?: string | null;
  progress_pct?: number | null;
  status: PlanTaskStatus | string;
  assignee?: string | null;
  notes?: string | null;
  created_at?: string | null;
  [k: string]: any;
}
