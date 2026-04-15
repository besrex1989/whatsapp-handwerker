-- 014_backfill_missing_tenants.sql
-- Problem: Some auth.users rows have no matching public.tenants row. This
--   happens when:
--     - The user signed up before migration 006 (auto-create trigger) existed.
--     - The trigger silently failed (e.g. duplicate whatsapp_number unique
--       violation, or raw_user_meta_data missing required fields).
--     - An earlier backfill (migrations 003, 006) was run before the signup
--       trigger was in place and the user signed up in between.
--   Symptom in the UI: the dashboard shows only "—" placeholders and the
--   "Mit Bexio verbinden" button triggers "Tenant-Abfrage fehlgeschlagen:
--   Cannot coerce the result to a single JSON object" (PGRST116) — the
--   tenant row simply doesn't exist.
-- Fix: For every auth.users row without a matching tenant (case-insensitive
--   email compare), create one from the signup metadata. full_name and
--   whatsapp_number come from raw_user_meta_data if present; otherwise we
--   fall back to safe, deterministic values so the NOT NULL + UNIQUE
--   constraints on tenants are satisfied. Users can edit both later from
--   the dashboard.
-- Note: Uses alias `au` (not `u`) to avoid the Supabase SQL Editor
--   interpreting `u.id` as a template variable placeholder.

begin;

insert into public.tenants (email, full_name, whatsapp_number)
select
  lower(au.email),
  coalesce(
    au.raw_user_meta_data ->> 'full_name',
    split_part(au.email, '@', 1)
  ),
  coalesce(
    au.raw_user_meta_data ->> 'whatsapp_number',
    '+unknown_' || md5(au.email)
  )
from auth.users au
where au.email is not null
  and not exists (
    select 1
    from public.tenants t
    where lower(t.email) = lower(au.email)
  )
on conflict (email) do nothing;

commit;
