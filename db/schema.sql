-- ============================================================================
-- Pipe Assessor — Findings Tracker schema (Phase 1)
-- Run once in Supabase: SQL Editor -> New query -> paste this whole file -> Run.
-- Safe to re-run (idempotent: IF NOT EXISTS / ON CONFLICT / DROP POLICY IF EXISTS).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. findings — one row per abnormal point found during inspection
-- ---------------------------------------------------------------------------
create table if not exists public.findings (
  id uuid primary key default gen_random_uuid(),

  -- identity
  terminal text not null check (terminal in ('KBY','SRC','BRP')),
  pipe_tag text,          -- optional: engineer assigns the Line No. later (findings are keyed by Location)
  pid_no text,
  service text,
  location_desc text,

  -- source inspection (vendor report the finding came from)
  report_link text,  -- link to the source report (e.g. a SharePoint URL)
  inspection_date date,

  -- the anomaly
  finding_type text not null,
  severity text check (severity in ('Low','Medium','High')),
  is_leaking boolean not null default false, -- orthogonal to finding_type: e.g. External Corrosion WITH a leak
  description text,
  t_nominal numeric,
  t_measured numeric,
  defect_length_mm numeric,
  defect_width_mm numeric,

  -- position (map pin)
  lat double precision,
  lng double precision,

  -- lifecycle
  status text not null default 'Open'
    check (status in ('Open','Monitoring','Repair Planned','Repaired','Closed')),
  target_date date,      -- repair due date (used for overdue when Repair Planned / Open)
  next_check_date date,  -- re-inspect-by date (used for overdue when Monitoring)
  sap_notification text, -- optional SAP PM notification no.
  sap_order text,        -- optional SAP PM order / work order no.
  estimated_cost numeric,-- manual estimated repair cost (THB); rolls up into the outstanding-budget KPI
  repair_method text,    -- PCC-2 method / how it was repaired
  repaired_date date,
  closing_note text,

  -- audit (email denormalized at write time so the app never needs auth.users access)
  created_by uuid not null default auth.uid(),
  created_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create index if not exists idx_findings_status on public.findings (status);
create index if not exists idx_findings_terminal on public.findings (terminal);

-- Patch existing databases (the create-table above is skipped once the table exists, so new
-- columns must be added explicitly; re-running this whole file is safe).
alter table public.findings add column if not exists report_link text;
-- Pipe Tag / Line No. is optional: operators record a finding by Location Description, an
-- engineer assigns the Line No. later. (Idempotent — re-dropping NOT NULL is a no-op.)
alter table public.findings alter column pipe_tag drop not null;
alter table public.findings add column if not exists estimated_cost numeric;
-- Leak used to be a Finding Type; it's now a flag orthogonal to type (a corrosion/dent/etc.
-- finding can independently be actively leaking or not). Existing finding_type = 'Leak' rows are
-- NOT auto-migrated here — reclassify them manually (set is_leaking = true + a real finding_type).
alter table public.findings add column if not exists is_leaking boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. finding_photos — photos live in the 'finding-photos' storage bucket;
--    kind separates as-found evidence from after-repair confirmation shots
-- ---------------------------------------------------------------------------
create table if not exists public.finding_photos (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.findings(id) on delete cascade,
  kind text not null default 'found' check (kind in ('found','repaired')),
  storage_path text not null,
  caption text,
  created_by uuid not null default auth.uid(),
  created_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at timestamptz not null default now()
);

create index if not exists idx_photos_finding on public.finding_photos (finding_id);

-- ---------------------------------------------------------------------------
-- 3. status_history — the handover trail: every status change with note+who+when
-- ---------------------------------------------------------------------------
create table if not exists public.status_history (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.findings(id) on delete cascade,
  old_status text,
  new_status text not null,
  note text,
  changed_by uuid not null default auth.uid(),
  changed_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  changed_at timestamptz not null default now()
);

create index if not exists idx_history_finding on public.status_history (finding_id);

-- ---------------------------------------------------------------------------
-- 4. assessments — snapshot of the B31.3 calculator attached to a finding
--    (created now so Phase 3 needs no migration; unused until then)
-- ---------------------------------------------------------------------------
create table if not exists public.assessments (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.findings(id) on delete cascade,
  inputs jsonb not null,
  results jsonb not null,
  created_by uuid not null default auth.uid(),
  created_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. updated_at / updated_by maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists trg_findings_touch on public.findings;
create trigger trg_findings_touch
  before update on public.findings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 6a. line_list — master pipe-tag reference (terminal/NPS/schedule/material +
--    P&ID/service), imported from Excel/CSV. Used only to pre-fill new
--    findings; never referenced by a foreign key so importing/replacing it
--    can never break existing findings. (Kept before section 6's RLS block,
--    which enables RLS on this table — must exist first.)
-- ---------------------------------------------------------------------------
create table if not exists public.line_list (
  id uuid primary key default gen_random_uuid(),

  pipe_tag text not null,
  terminal text check (terminal in ('KBY','SRC','BRP')),
  nps text,              -- must match a PA_PIPE_DATABASE key, e.g. 2"
  schedule text,         -- must match a schedule key under that nps, e.g. 40
  material text,         -- must match a PA_MATERIALS[].code, e.g. A106B
  design_p_barg numeric, -- design pressure, bar(g) — prefills the assessment's P + p_unit on tag select
  pid_no text,
  service text,

  created_by uuid not null default auth.uid(),
  created_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_line_list_tag on public.line_list (pipe_tag);

drop trigger if exists trg_line_list_touch on public.line_list;
create trigger trg_line_list_touch
  before update on public.line_list
  for each row execute function public.touch_updated_at();

-- Patch existing databases (line_list may already exist from a prior apply of this file
-- without the terminal column / with the now-removed location_desc column).
alter table public.line_list add column if not exists terminal text check (terminal in ('KBY','SRC','BRP'));
alter table public.line_list drop column if exists location_desc;
alter table public.line_list add column if not exists design_p_barg numeric;

-- ---------------------------------------------------------------------------
-- 6. Row Level Security — any logged-in user (you + inspectors) has full
--    read/write; the public anon key alone can see nothing.
-- ---------------------------------------------------------------------------
alter table public.findings enable row level security;
alter table public.finding_photos enable row level security;
alter table public.status_history enable row level security;
alter table public.assessments enable row level security;
alter table public.line_list enable row level security;

drop policy if exists "authenticated full access" on public.findings;
create policy "authenticated full access" on public.findings
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.finding_photos;
create policy "authenticated full access" on public.finding_photos
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.status_history;
create policy "authenticated full access" on public.status_history
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.assessments;
create policy "authenticated full access" on public.assessments
  for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access" on public.line_list;
create policy "authenticated full access" on public.line_list
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 7. Storage bucket for photos.
--    Public READ (data is non-confidential; paths contain UUIDs so they are
--    not guessable) — this lets <img> tags use plain public URLs.
--    WRITE/DELETE require login.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('finding-photos', 'finding-photos', true)
on conflict (id) do nothing;

drop policy if exists "auth insert finding-photos" on storage.objects;
create policy "auth insert finding-photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'finding-photos');

drop policy if exists "auth update finding-photos" on storage.objects;
create policy "auth update finding-photos" on storage.objects
  for update to authenticated using (bucket_id = 'finding-photos');

drop policy if exists "auth delete finding-photos" on storage.objects;
create policy "auth delete finding-photos" on storage.objects
  for delete to authenticated using (bucket_id = 'finding-photos');

-- ---------------------------------------------------------------------------
-- 8. Public read-only single-finding access (for the QR-code share links on the
--    PDF report). The whole app is otherwise RLS-locked to `authenticated`;
--    this is the ONE public read path. It is a SECURITY DEFINER function (runs
--    as the owner, bypassing RLS) that returns EXACTLY ONE finding by id, with
--    all PII stripped (no *_email columns). `anon` is granted EXECUTE on the
--    function only — it can NOT read the tables directly, so it cannot browse or
--    enumerate the register; a caller must already know a finding's UUID.
--    Photos are already public (R2 public bucket), so nothing new is exposed
--    there. Re-runnable (create or replace).
--
--    If you ever want to REVOKE all shared links at once:
--        revoke execute on function public.get_public_finding(uuid) from anon;
-- ---------------------------------------------------------------------------
create or replace function public.get_public_finding(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case when f.id is null then null else jsonb_build_object(
    'finding', to_jsonb(f) - 'created_by_email',
    'assessments', coalesce((
      select jsonb_agg(jsonb_build_object('inputs', a.inputs, 'results', a.results, 'created_at', a.created_at)
             order by a.created_at desc)
      from public.assessments a where a.finding_id = f.id), '[]'::jsonb),
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object('storage_path', p.storage_path, 'kind', p.kind, 'created_at', p.created_at)
             order by p.created_at)
      from public.finding_photos p where p.finding_id = f.id), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('old_status', h.old_status, 'new_status', h.new_status,
                                          'changed_at', h.changed_at, 'note', h.note)
             order by h.changed_at desc)
      from public.status_history h where h.finding_id = f.id), '[]'::jsonb)
  ) end
  from public.findings f
  where f.id = p_id;
$$;

revoke all on function public.get_public_finding(uuid) from public;
grant execute on function public.get_public_finding(uuid) to anon, authenticated;
