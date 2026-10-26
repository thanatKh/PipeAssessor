-- One-off patch: add findings.depth_mm (measured wall-loss depth at the deepest point, mm).
-- Paste into the Supabase SQL Editor BEFORE deploying the code that writes it — until the column
-- exists, every finding save fails with PostgREST 42703. Safe to re-run. Mirrored in schema.sql §1.
-- get_public_finding returns to_jsonb(f), so the public share link picks the column up unchanged.

alter table public.findings add column if not exists depth_mm numeric check (depth_mm is null or depth_mm >= 0);
