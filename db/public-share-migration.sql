-- ===========================================================================
-- Public read-only single-finding access — one-time migration for the QR-code
-- share links on the PDF report. Paste this whole file into the Supabase SQL
-- Editor and Run. It is idempotent (create or replace) so re-running is safe.
--
-- What it does: adds ONE SECURITY DEFINER function that returns EXACTLY ONE
-- finding by id (PII stripped) and grants EXECUTE to the anon role. The anon
-- role still cannot read any table directly, so the register cannot be browsed
-- or enumerated — a caller must already know a finding's UUID (from a QR/link).
--
-- This is also part of db/schema.sql (section 8); this file is just a convenient
-- standalone copy.
--
-- PREREQUISITE: public.temp_repair must already exist (db/temp-repair-migration
-- .sql, or schema.sql section 7a). The function body selects from it, and a
-- `language sql` body is parsed and validated at definition time, so this file
-- errors on a database that predates that table — apply that migration first.
-- db/temp-repair-migration.sql also ends with this exact function, so applying
-- it alone is enough; keep the two bodies byte-identical if you edit either.
--
-- To revoke ALL shared links at once, run:
--     revoke execute on function public.get_public_finding(uuid) from anon;
-- ===========================================================================
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
