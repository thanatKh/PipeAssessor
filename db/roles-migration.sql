-- ===========================================================================
-- Self-registration + Inspector / Maintenance roles — one-time migration.
-- Paste this whole file into the Supabase SQL Editor and Run. Idempotent
-- (create or replace / if not exists / drop policy if exists) so re-running
-- is safe.
--
-- This is also part of db/schema.sql (section 9); this file is just a
-- convenient standalone copy.
--
-- WHAT THIS DOES
--   * public.profiles      — one row per auth user, holding their role.
--   * signup domain gate   — only @pttor.com / @pttplc.com may register.
--   * auto-profile         — every new user becomes 'inspector'.
--   * backfill             — existing accounts become 'inspector', except the
--                            owner (see the marked line below).
--   * RLS split            — replaces the old blanket "authenticated full
--                            access" policies with per-operation, role-aware
--                            ones.
--   * guard trigger        — column-level protection RLS cannot express
--                            (repair statuses / schedule / cost / outcome).
--
-- ROLE BOUNDARY = "reporting vs. repair planning & handover"
--   inspector   : reports findings, assessments, photos (as-found), SAP
--                 notification/order, status Open/Monitoring, bulk import.
--   maintenance : all of the above, plus target date, estimated cost, repair
--                 method/date/closing note, statuses Repair Planned/Repaired/
--                 Closed, after-repair photos, delete, line list, roles.
--
-- !! REQUIRED Supabase dashboard settings (this SQL cannot set them) !!
--   Auth -> enable public signups
--   Auth -> enable "Confirm email"   <-- CRITICAL. With auto-approval the email
--           domain IS the access control; without confirmation anyone could
--           register as someone@pttor.com without owning that mailbox.
--   Auth -> Site URL / redirect allow-list -> https://pipeassessor.onrender.com
-- ===========================================================================

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

-- ---- finding_photos: as-found for everyone, repaired for maintenance ----
drop policy if exists "authenticated full access" on public.finding_photos;

drop policy if exists "photos read" on public.finding_photos;
create policy "photos read" on public.finding_photos
  for select to authenticated using (true);

drop policy if exists "photos insert" on public.finding_photos;
create policy "photos insert" on public.finding_photos
  for insert to authenticated
  with check (coalesce(kind, 'found') = 'found' or public.pa_is_maintenance());

drop policy if exists "photos update" on public.finding_photos;
create policy "photos update" on public.finding_photos
  for update to authenticated
  using (coalesce(kind, 'found') = 'found' or public.pa_is_maintenance())
  with check (coalesce(kind, 'found') = 'found' or public.pa_is_maintenance());

drop policy if exists "photos delete" on public.finding_photos;
create policy "photos delete" on public.finding_photos
  for delete to authenticated
  using (coalesce(kind, 'found') = 'found' or public.pa_is_maintenance());

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
