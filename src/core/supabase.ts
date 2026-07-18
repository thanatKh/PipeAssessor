/* ============================================================================
   Supabase client — created once at module load from the publishable key
   (safe to commit; every table is RLS-gated to the authenticated role).
   Replaces the old window.supabase UMD global + in-initApp createClient call.
   ============================================================================ */
import { createClient } from '@supabase/supabase-js';

export const PA_SUPABASE_URL = 'https://uuwcftjduphtngmhwvrb.supabase.co';
export const PA_SUPABASE_KEY = 'sb_publishable_-wA0hWoW-SIOpdlSpNrXkw_-YsUQYMH';

export const sb = createClient(PA_SUPABASE_URL, PA_SUPABASE_KEY);
