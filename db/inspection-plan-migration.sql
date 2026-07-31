-- ===========================================================================
-- Inspection Plan module — one-time migration.
-- Paste this whole file into the Supabase SQL Editor and Run. Idempotent
-- (create table if not exists / drop policy if exists) so re-running is safe.
--
-- This is also part of db/schema.sql (section 10); this file is just a
-- convenient standalone copy.
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT WRITES THESE TABLES. Until the
-- tables exist every plan save fails with PostgREST 42703 / 404 — the same
-- ordering rule as any column addition in this project.
--
-- WHAT THIS DOES
--   * public.inspection_plan — a plan header, scoped by year + terminal +
--                              pipe category (Underground / Sub Sea / Piping).
--   * public.plan_task       — free-text tasks under a plan, each with a
--                              PLANNED and an ACTUAL month range. The Gantt
--                              timeline on #/plan draws these as two stacked
--                              bars per row.
--   * touch triggers         — reuse the existing public.touch_updated_at().
--   * RLS                    — blanket authenticated read+write (see below).
--
-- NOT STORED HERE: the maintenance half of the timeline. Finding-derived
-- repair work is computed at render time from each finding's own due date
-- (dueDateOf / isOverdue in src/core/dom.ts), so the plan page can never drift
-- out of agreement with the findings register.
--
-- ACCESS MODEL — deliberately NOT the line_list pattern.
--   line_list is read-all / write-maintenance because it is reference data.
--   Inspection planning is inspector work, unlike repair scheduling, cost and
--   closeout (which stay maintenance-owned on findings via the
--   pa_guard_repair_fields trigger). So both roles get full access here, the
--   same blanket policy public.assessments uses.
--
--   To tighten later so only maintenance may write, replace each policy with:
--     for select to authenticated using (true)
--     for all    to authenticated using (public.pa_is_maintenance())
--                                 with check (public.pa_is_maintenance())
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Plan header
-- ---------------------------------------------------------------------------
create table if not exists public.inspection_plan (
  id uuid primary key default gen_random_uuid(),

  name text not null,
  year int not null,
  terminal text check (terminal in ('KBY','SRC','BRP')),
  -- Installation environment. Manual per-plan attribute: line_list has no
  -- category column and deliberately gains none.
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

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
create table if not exists public.plan_task (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.inspection_plan(id) on delete cascade,

  seq int not null default 0,
  task_name text not null,
  -- SOFT reference to line_list.pipe_tag — deliberately NOT a foreign key, so
  -- re-importing or replacing the master line list can never break a saved
  -- plan (the same invariant line_list itself is built on).
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

-- ---------------------------------------------------------------------------
-- updated_at / updated_by maintenance (reuses the function from schema.sql §5;
-- recreated here so this file can be applied standalone on a fresh database)
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists trg_inspection_plan_touch on public.inspection_plan;
create trigger trg_inspection_plan_touch
  before update on public.inspection_plan
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_plan_task_touch on public.plan_task;
create trigger trg_plan_task_touch
  before update on public.plan_task
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security — see ACCESS MODEL in the header above.
-- ---------------------------------------------------------------------------
alter table public.inspection_plan enable row level security;
alter table public.plan_task enable row level security;

drop policy if exists "plan authenticated full access" on public.inspection_plan;
create policy "plan authenticated full access" on public.inspection_plan
  for all to authenticated using (true) with check (true);

drop policy if exists "plan task authenticated full access" on public.plan_task;
create policy "plan task authenticated full access" on public.plan_task
  for all to authenticated using (true) with check (true);
