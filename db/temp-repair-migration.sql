-- ===========================================================================
-- Temporary Repair (emergency stop-leak) record — one-time migration.
-- Paste this whole file into the Supabase SQL Editor and Run. Idempotent
-- (create table if not exists / drop constraint|policy if exists) so re-running
-- is safe.
--
-- This is also part of db/schema.sql (section 7a, plus the two edits to
-- sections 8 and 9d noted below); this file is just a convenient standalone
-- copy.
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT WRITES THIS TABLE. Until it exists
-- every save of a leaking finding that carries a temporary repair fails with
-- PostgREST 42703 / 404 — the same ordering rule as any column addition in this
-- project.
--
-- WHAT THIS DOES
--   * public.temp_repair       — ONE row per finding (unique index on
--                                finding_id, so the app upserts on conflict).
--                                Written only for findings flagged is_leaking;
--                                the form panel is hidden otherwise.
--   * touch trigger            — reuses the existing public.touch_updated_at().
--   * RLS                      — blanket authenticated read+write (see below).
--   * finding_photos.kind      — widened with 'temp_before' / 'temp_after' for
--                                the before/after-installation evidence.
--   * finding_photos policies  — the insert/update/delete gate flips from
--                                "'found' or maintenance" to "not 'repaired' or
--                                maintenance", so an inspector can attach the
--                                temporary-repair photos.
--   * get_public_finding       — returns the record too, so a QR-scanned public
--                                view shows the same section the app does.
--
-- NOT STORED HERE: the whole of the legacy Excel form's section 1 (equipment
-- name, Tag No., location, nature of the problem, product, operating/design
-- pressure and temperature, reference document). Every one of those already
-- lives on findings (pipe_tag / location_desc / finding_type / description /
-- service / sap_notification / sap_order) or on the latest assessment snapshot
-- (P / p_unit / design_temp). The report reads them from there rather than
-- asking for them a second time — that is the point of bringing this in-app.
--
-- Also not stored: findings.target_date. The permanent-repair date is
-- temp_repair.perm_target_date instead, because target_date is one of the five
-- columns pa_guard_repair_fields blocks for inspectors (schema.sql section 9e)
-- and this panel sits on the same form an inspector uses to report the leak.
--
-- ACCESS MODEL — deliberately NOT the line_list pattern, for the same reason:
--   both roles get full access, the blanket policy public.assessments uses.
--   Recording the emergency stop-leak is part of reporting the leak, not part
--   of the repair handover. To tighten later so only maintenance may write,
--   replace the policy with:
--     for select to authenticated using (true)
--     for all    to authenticated using (public.pa_is_maintenance())
--                                 with check (public.pa_is_maintenance())
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The record
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

alter table public.temp_repair enable row level security;

drop policy if exists "temp repair authenticated full access" on public.temp_repair;
create policy "temp repair authenticated full access" on public.temp_repair
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 2. Photo kinds for the before/after-installation evidence (Excel section 5).
--    The constraint is recreated rather than altered because its name is the
--    auto-generated one from finding_photos' original create table.
-- ---------------------------------------------------------------------------
alter table public.finding_photos drop constraint if exists finding_photos_kind_check;
alter table public.finding_photos add constraint finding_photos_kind_check
  check (kind in ('found','repaired','temp_before','temp_after'));

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

-- ---------------------------------------------------------------------------
-- 3. Public share RPC — same body as db/schema.sql section 8, plus the
--    'temp_repair' key. Kept byte-identical to that section on purpose; if you
--    edit one, edit the other.
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
