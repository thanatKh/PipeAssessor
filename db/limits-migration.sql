-- One-off patch (Oct 2026 break-ui audit): length limits on the free-text finding fields and no
-- negative repair cost. Paste into the Supabase SQL Editor. Safe to re-run. Mirrored in schema.sql §1.
-- Existing data was checked first: longest values were 26 / 41 / 48 / 33 / 13 characters and no
-- negative costs, so none of these can fail on old rows. Keep in step with FIELD_LIMITS
-- (src/core/constants.ts). The inspection-date rule (not in the future) stays in the app: a CHECK
-- constraint cannot reference today's date.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'findings_pipe_tag_len') then
    alter table public.findings add constraint findings_pipe_tag_len check (char_length(pipe_tag) <= 80);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'findings_location_desc_len') then
    alter table public.findings add constraint findings_location_desc_len check (char_length(location_desc) <= 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'findings_description_len') then
    alter table public.findings add constraint findings_description_len check (char_length(description) <= 4000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'findings_pid_no_len') then
    alter table public.findings add constraint findings_pid_no_len check (char_length(pid_no) <= 80);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'findings_service_len') then
    alter table public.findings add constraint findings_service_len check (char_length(service) <= 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'findings_estimated_cost_nonneg') then
    alter table public.findings add constraint findings_estimated_cost_nonneg check (estimated_cost is null or estimated_cost >= 0);
  end if;
end $$;
