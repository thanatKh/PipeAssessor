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
-- 6. Row Level Security — the public anon key alone can see nothing.
--
--    NOTE: the blanket "authenticated full access" policies below are the
--    ORIGINAL single-role model. Section 9 (roles) REPLACES most of them with
--    per-operation, role-aware policies — it drops these by name and recreates
--    them split. This section is kept as-is so the file still reads as the
--    historical build order and stays re-runnable top-to-bottom; section 9
--    always has the last word. Edit role rules in section 9, not here.
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
-- 7a. temp_repair — the emergency stop-leak / temporary repair record.
--
--     ONE row per finding (unique index on finding_id, so the app writes it with
--     a plain upsert on conflict). Only ever filled in for a finding flagged
--     is_leaking; the form panel that writes it is hidden otherwise.
--
--     Deliberately NOT stored here: everything in the legacy Excel form's
--     section 1 (equipment name, tag, location, nature of the problem, product,
--     operating/design pressure and temperature, reference document). All of it
--     already lives on findings (pipe_tag / location_desc / finding_type /
--     description / service / sap_notification) and on the latest assessment
--     snapshot (P / p_unit / design_temp), so the report reads it from there
--     rather than asking for it twice.
--
--     Placed BEFORE section 8 on purpose: get_public_finding is a `language sql`
--     function, whose body Postgres parses and validates at definition time, so
--     the table it selects from must already exist. Same reason section 6a sits
--     ahead of section 6. Self-contained (declares its own RLS) so it can be
--     applied standalone from db/temp-repair-migration.sql.
-- ---------------------------------------------------------------------------
create table if not exists public.temp_repair (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.findings(id) on delete cascade,

  -- 2. รายละเอียดการซ่อมแซมชั่วคราว / temporary repair details
  method text not null check (method in (
    'Mechanical Clamp','Bolted Split Sleeve / Enclosure','Composite Wrap',
    'Epoxy Putty / Sealant','Injection Sealing','Other')),
  method_other text,          -- free text, used only when method = 'Other'
  installed_date date,        -- 2.4 วันที่ติดตั้ง
  installed_by text,
  install_method text,        -- 2.5 วิธีการติดตั้ง / procedure reference
  design_life_months int,     -- intended service life of the temporary repair
  -- clamp branch (2.1 / 2.2 / 2.3)
  clamp_type text,
  clamp_size text,
  clamp_material text,
  rated_pressure_barg numeric,
  -- composite branch (ASME PCC-2 Part 4 / ISO 24817)
  composite_system text,
  composite_layers int,
  composite_thickness_mm numeric,
  surface_prep text,
  cure_note text,

  -- 3. การตรวจสอบหลังติดตั้ง / post-installation verification
  verify_method text,         -- 3.1
  test_pressure_barg numeric, -- 3.2
  tested_at timestamptz,      -- 3.3
  test_result text not null default 'Not yet tested'
    check (test_result in ('Not yet tested','Pass','Pass with observation','Fail')),  -- 3.4
  test_note text,
  monitor_freq text,          -- 3.5 การติดตามเฝ้าระวัง

  -- 4. แผนงานซ่อมแซมถาวร / permanent repair plan
  -- perm_target_date lives HERE, not on findings.target_date: that column is one
  -- of the five pa_guard_repair_fields blocks for inspectors (section 9e), and
  -- this panel sits on the same form an inspector uses to report the leak.
  perm_method text,           -- 4.1, from REPAIR_METHOD_OPTIONS
  perm_target_date date,      -- 4.2
  perm_owner text,            -- 4.3
  precautions text,           -- 4.4

  created_by uuid not null default auth.uid(),
  created_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_temp_repair_finding on public.temp_repair (finding_id);

drop trigger if exists trg_temp_repair_touch on public.temp_repair;
create trigger trg_temp_repair_touch
  before update on public.temp_repair
  for each row execute function public.touch_updated_at();

-- Blanket authenticated access, like `assessments` and unlike `line_list`: this
-- record is filled in on the same form an INSPECTOR uses to report the leak, so
-- gating writes on pa_is_maintenance() would make that save fail outright.
alter table public.temp_repair enable row level security;

drop policy if exists "temp repair authenticated full access" on public.temp_repair;
create policy "temp repair authenticated full access" on public.temp_repair
  for all to authenticated using (true) with check (true);

-- Two new photo kinds for the before/after-installation evidence (Excel section
-- 5). The constraint is recreated rather than altered because its name is the
-- auto-generated one from the section 2 create table.
alter table public.finding_photos drop constraint if exists finding_photos_kind_check;
alter table public.finding_photos add constraint finding_photos_kind_check
  check (kind in ('found','repaired','temp_before','temp_after'));

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
      from public.status_history h where h.finding_id = f.id), '[]'::jsonb),
    'temp_repair', (
      select to_jsonb(t) - 'created_by_email' - 'created_by' - 'updated_by'
      from public.temp_repair t where t.finding_id = f.id)
  ) end
  from public.findings f
  where f.id = p_id;
$$;

revoke all on function public.get_public_finding(uuid) from public;
grant execute on function public.get_public_finding(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Roles: self-registration + Inspector / Maintenance
--    Mirrored standalone in db/roles-migration.sql for a one-off paste if this
--    section alone has not been applied yet (same pattern as section 8).
--
--    Boundary = "reporting vs. repair planning & handover":
--      inspector   : findings, assessments, as-found photos, SAP
--                    notification/order, status Open/Monitoring, bulk import.
--      maintenance : + target date, estimated cost, repair method/date/closing
--                    note, statuses Repair Planned/Repaired/Closed, after-repair
--                    photos, delete, line list, role assignment.
--
--    !! Also required in the Supabase dashboard (cannot be set from SQL) !!
--      Auth -> enable public signups
--      Auth -> enable "Confirm email"  <-- CRITICAL: with auto-approval the
--              email domain IS the access control.
--      Auth -> Site URL / redirects -> https://pipeassessor.onrender.com
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 9a. profiles — role per user
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null default 'inspector' check (role in ('inspector','maintenance')),
  created_at timestamptz not null default now()
);

create index if not exists idx_profiles_role on public.profiles (role);

-- SECURITY DEFINER so RLS policies can call it without recursing into
-- profiles' own RLS (same mechanism as get_public_finding in section 8).
-- STABLE so Postgres evaluates it once per statement rather than per row.
create or replace function public.pa_is_maintenance() returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role = 'maintenance' from public.profiles where id = auth.uid()), false);
$$;

revoke all on function public.pa_is_maintenance() from public;
grant execute on function public.pa_is_maintenance() to authenticated;

-- ---------------------------------------------------------------------------
-- 9b. Signup: restrict to company domains, and auto-create the profile row.
--     The BEFORE INSERT trigger is the real gate (the app also pre-checks the
--     domain client-side, but only for a friendlier message).
-- ---------------------------------------------------------------------------
create or replace function public.pa_enforce_signup_domain() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(split_part(coalesce(new.email, ''), '@', 2))
     not in ('pttor.com', 'pttplc.com') then
    raise exception 'Registration is restricted to PTT OR company email addresses (@pttor.com, @pttplc.com).'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists pa_signup_domain on auth.users;
create trigger pa_signup_domain
  before insert on auth.users
  for each row execute function public.pa_enforce_signup_domain();

create or replace function public.pa_handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'inspector')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists pa_new_user_profile on auth.users;
create trigger pa_new_user_profile
  after insert on auth.users
  for each row execute function public.pa_handle_new_user();

-- ---------------------------------------------------------------------------
-- 9c. Backfill existing accounts.
--     Everyone already registered becomes 'inspector'; the owner is promoted.
--     >>> EDIT THIS EMAIL (or add more) if the maintenance owner changes. <<<
-- ---------------------------------------------------------------------------
insert into public.profiles (id, email, role)
  select id, email, 'inspector' from auth.users
  on conflict (id) do nothing;

update public.profiles
   set role = 'maintenance'
 where lower(email) in ('thanat.k@pttor.com');

-- ---------------------------------------------------------------------------
-- 9d. RLS — replace the blanket "authenticated full access" policies from
--     section 6 with per-operation, role-aware ones.
--     Reads stay open to every signed-in user; only writes are role-gated.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

-- A user always sees their own row (the app reads it to learn its own role);
-- maintenance sees everyone (for the user-management screen).
drop policy if exists "read own or all if maintenance" on public.profiles;
create policy "read own or all if maintenance" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.pa_is_maintenance());

-- Only maintenance may change roles — an inspector must never be able to
-- promote themselves. No insert/delete policy: rows come from the trigger.
drop policy if exists "maintenance updates profiles" on public.profiles;
create policy "maintenance updates profiles" on public.profiles
  for update to authenticated
  using (public.pa_is_maintenance())
  with check (public.pa_is_maintenance());

-- ---- findings: read/create/update open; DELETE is maintenance-only ----
drop policy if exists "authenticated full access" on public.findings;

drop policy if exists "findings read" on public.findings;
create policy "findings read" on public.findings
  for select to authenticated using (true);

drop policy if exists "findings insert" on public.findings;
create policy "findings insert" on public.findings
  for insert to authenticated with check (true);

drop policy if exists "findings update" on public.findings;
create policy "findings update" on public.findings
  for update to authenticated using (true) with check (true);

drop policy if exists "findings delete maintenance" on public.findings;
create policy "findings delete maintenance" on public.findings
  for delete to authenticated using (public.pa_is_maintenance());

-- ---- finding_photos: as-found + temporary-repair evidence for everyone,
--      after-repair for maintenance.
--      'temp_before'/'temp_after' sit on the inspector side of the boundary on
--      purpose: they are attached by the same form panel an inspector uses to
--      report the leak (section 7a), so gating them would break that save.
--      'repaired' stays maintenance-only — those photos ARE the repair handover.
drop policy if exists "authenticated full access" on public.finding_photos;

drop policy if exists "photos read" on public.finding_photos;
create policy "photos read" on public.finding_photos
  for select to authenticated using (true);

drop policy if exists "photos insert" on public.finding_photos;
create policy "photos insert" on public.finding_photos
  for insert to authenticated
  with check (coalesce(kind, 'found') <> 'repaired' or public.pa_is_maintenance());

drop policy if exists "photos update" on public.finding_photos;
create policy "photos update" on public.finding_photos
  for update to authenticated
  using (coalesce(kind, 'found') <> 'repaired' or public.pa_is_maintenance())
  with check (coalesce(kind, 'found') <> 'repaired' or public.pa_is_maintenance());

drop policy if exists "photos delete" on public.finding_photos;
create policy "photos delete" on public.finding_photos
  for delete to authenticated
  using (coalesce(kind, 'found') <> 'repaired' or public.pa_is_maintenance());

-- ---- status_history: only Open/Monitoring entries for inspectors ----
drop policy if exists "authenticated full access" on public.status_history;

drop policy if exists "history read" on public.status_history;
create policy "history read" on public.status_history
  for select to authenticated using (true);

drop policy if exists "history insert" on public.status_history;
create policy "history insert" on public.status_history
  for insert to authenticated
  with check (new_status in ('Open','Monitoring') or public.pa_is_maintenance());

-- ---- assessments: unchanged, open to every signed-in user ----
drop policy if exists "authenticated full access" on public.assessments;
create policy "authenticated full access" on public.assessments
  for all to authenticated using (true) with check (true);

-- ---- line_list: read for all, writes maintenance-only ----
drop policy if exists "authenticated full access" on public.line_list;

drop policy if exists "line list read" on public.line_list;
create policy "line list read" on public.line_list
  for select to authenticated using (true);

drop policy if exists "line list write maintenance" on public.line_list;
create policy "line list write maintenance" on public.line_list
  for all to authenticated
  using (public.pa_is_maintenance())
  with check (public.pa_is_maintenance());

-- ---------------------------------------------------------------------------
-- 9e. Column-level guard on findings.
--     RLS WITH CHECK cannot compare NEW against OLD, so protecting individual
--     columns needs a trigger. Blocks, for inspectors only:
--       * setting status to Repair Planned / Repaired / Closed
--       * setting or changing target_date, estimated_cost, repair_method,
--         repaired_date, closing_note
--     sap_notification / sap_order are deliberately NOT guarded — inspectors
--     own those (they raise the SAP notification).
--     Guarding on INSERT as well as UPDATE is safe because 'Target Date' has
--     been removed from the findings import template (IMPORT_COLS), so none of
--     these columns is importable any more.
-- ---------------------------------------------------------------------------
create or replace function public.pa_guard_repair_fields() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.pa_is_maintenance() then
    return new;
  end if;

  if new.status in ('Repair Planned','Repaired','Closed')
     and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    raise exception 'Inspector role cannot set status to %. Ask maintenance to plan or close the repair.', new.status
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'INSERT' then
    if new.target_date is not null
       or new.estimated_cost is not null
       or new.repair_method is not null
       or new.repaired_date is not null
       or new.closing_note is not null then
      raise exception 'Inspector role cannot set the repair schedule, cost, or outcome fields.'
        using errcode = 'insufficient_privilege';
    end if;
  elsif new.target_date    is distinct from old.target_date
     or new.estimated_cost is distinct from old.estimated_cost
     or new.repair_method  is distinct from old.repair_method
     or new.repaired_date  is distinct from old.repaired_date
     or new.closing_note   is distinct from old.closing_note then
    raise exception 'Inspector role cannot modify the repair schedule, cost, or outcome fields.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists pa_guard_repair on public.findings;
create trigger pa_guard_repair
  before insert or update on public.findings
  for each row execute function public.pa_guard_repair_fields();

-- ---------------------------------------------------------------------------
-- 10. Inspection plan — the scheduling module behind #/plan.
--
--     Two tables: a plan header (scope: year + terminal + pipe category) and
--     its free-text task list. Each task carries a PLANNED month range and an
--     ACTUAL month range, which the Gantt timeline draws as two stacked bars.
--
--     Deliberately NOT stored here: the maintenance side of the timeline. That
--     is derived at render time from findings' own due dates (dueDateOf /
--     isOverdue in src/core/dom.ts), so the plan page can never disagree with
--     the register about what repair work is outstanding.
--
--     Self-contained: unlike line_list (whose RLS lives in section 6), this
--     section enables RLS and declares its own policies, so it can be applied
--     standalone from db/inspection-plan-migration.sql.
-- ---------------------------------------------------------------------------
create table if not exists public.inspection_plan (
  id uuid primary key default gen_random_uuid(),

  name text not null,
  year int not null,
  terminal text check (terminal in ('KBY','SRC','BRP')),
  -- Installation environment. Manual per-plan attribute: line_list has no
  -- category column and deliberately gains none (see CLAUDE.md's note on not
  -- growing a pipe-asset register).
  pipe_category text check (pipe_category in ('Underground','Sub Sea','Piping')),
  status text not null default 'Draft' check (status in ('Draft','Active','Complete')),
  notes text,

  created_by uuid not null default auth.uid(),
  created_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create index if not exists idx_inspection_plan_year on public.inspection_plan (year);
create index if not exists idx_inspection_plan_terminal on public.inspection_plan (terminal);

create table if not exists public.plan_task (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.inspection_plan(id) on delete cascade,

  seq int not null default 0,
  task_name text not null,
  -- SOFT reference to line_list.pipe_tag — deliberately NOT a foreign key, so
  -- re-importing or replacing the master line list can never break a saved
  -- plan (the same invariant line_list itself is built on, section 6a).
  pipe_tag text,

  -- Month granularity: every one of these is a DATE pinned to the 1st of the
  -- month. Stored as a real date (not an int month + parent year) so a plan can
  -- span a year boundary, and so the existing ISO-string date idiom — lexical
  -- comparison, fmtDate, todayISO — applies unchanged.
  plan_start date,
  plan_end date,
  actual_start date,
  actual_end date,

  progress_pct numeric check (progress_pct >= 0 and progress_pct <= 100),
  status text not null default 'Not Started'
    check (status in ('Not Started','In Progress','Done','Cancelled')),
  assignee text,
  notes text,

  created_by uuid not null default auth.uid(),
  created_by_email text not null default coalesce(auth.jwt() ->> 'email', ''),
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create index if not exists idx_plan_task_plan on public.plan_task (plan_id);
create index if not exists idx_plan_task_tag on public.plan_task (pipe_tag);

drop trigger if exists trg_inspection_plan_touch on public.inspection_plan;
create trigger trg_inspection_plan_touch
  before update on public.inspection_plan
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_plan_task_touch on public.plan_task;
create trigger trg_plan_task_touch
  before update on public.plan_task
  for each row execute function public.touch_updated_at();

-- RLS: any authenticated user may read AND write plans.
--
--     This deliberately does NOT follow the line_list pattern (read all / write
--     maintenance). Inspection scheduling is inspector work — unlike repair
--     scheduling, cost and closeout, which stay maintenance-owned on findings
--     via pa_guard_repair_fields. Plans are a shared planning surface, so the
--     policy pair is the same blanket authenticated access `assessments` uses.
alter table public.inspection_plan enable row level security;
alter table public.plan_task enable row level security;

drop policy if exists "plan authenticated full access" on public.inspection_plan;
create policy "plan authenticated full access" on public.inspection_plan
  for all to authenticated using (true) with check (true);

drop policy if exists "plan task authenticated full access" on public.plan_task;
create policy "plan task authenticated full access" on public.plan_task
  for all to authenticated using (true) with check (true);
