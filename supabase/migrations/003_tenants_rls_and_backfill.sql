-- 003_tenants_rls_and_backfill.sql
-- Problem: public.tenants had RLS enabled with only a service_role policy,
--   so the browser dashboard (anon + authenticated keys) could neither
--   insert a tenant row on signup nor read its own row after login.
--   Symptom in the UI: "Tenant nicht gefunden." even though the auth user
--   exists.
-- Fix:
--   1) Allow authenticated users to read/insert/update THEIR OWN tenant row
--      (matched by email = their JWT email claim).
--   2) Backfill: for every auth.users row without a matching tenant, create
--      a tenant record from the signup metadata (full_name, whatsapp_number)
--      that was stored on auth.users.raw_user_meta_data.

-- --- RLS policies ---

drop policy if exists "Users can read own tenant" on public.tenants;
create policy "Users can read own tenant" on public.tenants
  for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'));

drop policy if exists "Users can insert own tenant" on public.tenants;
create policy "Users can insert own tenant" on public.tenants
  for insert to authenticated
  with check (lower(email) = lower(auth.jwt() ->> 'email'));

drop policy if exists "Users can update own tenant" on public.tenants;
create policy "Users can update own tenant" on public.tenants
  for update to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'))
  with check (lower(email) = lower(auth.jwt() ->> 'email'));

-- --- Backfill existing auth users without a tenant row ---

insert into public.tenants (email, full_name, whatsapp_number)
select
  u.email,
  coalesce(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1)),
  coalesce(u.raw_user_meta_data ->> 'whatsapp_number', '+unknown_' || substr(u.id::text, 1, 8))
from auth.users u
left join public.tenants t on lower(t.email) = lower(u.email)
where t.id is null
  and u.email is not null
on conflict (email) do nothing;
