-- 006_auto_create_tenant_on_signup.sql
-- Problem: When a new user registers via supabase.auth.signUp() in the browser,
--   email confirmation may be enabled, meaning the user has NO active session
--   immediately after signup. The client-side INSERT into public.tenants then
--   runs as role `anon`, not `authenticated`, and is blocked by the
--   "Users can insert own tenant" RLS policy (which requires `to authenticated`).
--   Symptom: "new row violates row-level security policy for table tenants".
-- Fix: Auto-create the tenant row via a trigger on auth.users. The trigger
--   function runs with SECURITY DEFINER (owner = postgres), so it bypasses
--   RLS entirely. The client no longer needs to insert the tenant row itself.
--   Metadata (full_name, whatsapp_number) is pulled from raw_user_meta_data
--   that was set during signUp({ options: { data: {...} } }).

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tenants (email, full_name, whatsapp_number)
  values (
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'whatsapp_number', '+unknown_' || substr(new.id::text, 1, 8))
  )
  on conflict (email) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Backfill: catch any auth.users rows that were created before this trigger
-- existed (e.g. signups that failed on the client-side tenant insert and left
-- an orphaned auth user without a tenant row).
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
