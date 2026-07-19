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
  pUnit: 'bar' | 'psi';
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
export type PhotoKind = 'found' | 'repaired';

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
  vendor: string | null;
  report_no: string | null;
  report_link: string | null;
  method: string | null;
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
  path: string;
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
