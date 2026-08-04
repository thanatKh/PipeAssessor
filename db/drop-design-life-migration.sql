-- One-off patch: remove design_life_months column from public.temp_repair
-- Paste this into the Supabase SQL Editor (https://supabase.com/dashboard/project/_/sql)

ALTER TABLE public.temp_repair DROP COLUMN IF EXISTS design_life_months;
