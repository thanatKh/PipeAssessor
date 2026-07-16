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
  pipe_tag text not null,
  pid_no text,
  service text,
  location_desc text,

  -- source inspection (vendor report the finding came from)
  vendor text,
  report_no text,
  inspection_date date,
  method text,

  -- the anomaly
  finding_type text not null,
  severity text check (severity in ('Low','Medium','High')),
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
-- 6. Row Level Security — any logged-in user (you + inspectors) has full
--    read/write; the public anon key alone can see nothing.
-- ---------------------------------------------------------------------------
alter table public.findings enable row level security;
alter table public.finding_photos enable row level security;
alter table public.status_history enable row level security;
alter table public.assessments enable row level security;

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
