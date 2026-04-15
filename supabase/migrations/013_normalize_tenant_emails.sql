-- 013_normalize_tenant_emails.sql
-- Problem: public.tenants.email was historically stored with whatever casing
--   the user typed on signup (or via email-change). The RLS SELECT policy
--   (see migration 003) compares case-insensitively with lower(), but
--   client-side dashboard queries use .eq("email", user.email) — an EXACT
--   match. When the stored casing differed from auth.users.email, the query
--   returned 0 rows and PostgREST's .single() failed with:
--     "Cannot coerce the result to a single JSON object"
--   Symptom: "Tenant-Abfrage fehlgeschlagen" alert on the dashboard, and
--   the Konto card shows only placeholder dashes.
-- Fix:
--   1) Deduplicate any historical rows that differ only in email casing,
--      keeping the most recently updated one.
--   2) Lowercase all remaining tenants.email values.
--   3) Update the signup + email-change triggers to always store the email
--      in lowercase, so this can't drift again.
--   Combined with the client-side switch to case-insensitive lookups
--   (.ilike + .maybeSingle), this makes the tenant lookup robust in both
--   directions.
begin;

-- 1) Collapse case-only duplicates. Keep the newest row per lower(email).
with ranked as (
  select
    id,
    row_number() over (
      partition by lower(email)
      order by
        coalesce(updated_at, created_at) desc nulls last,
        created_at desc nulls last,
        id
    ) as rn
  from public.tenants
)
delete from public.tenants t
using ranked r
where t.id = r.id
  and r.rn > 1;

-- 2) Lowercase remaining addresses.
update public.tenants
   set email = lower(email),
       updated_at = now()
 where email <> lower(email);

-- 3) Ensure the signup trigger always stores lowercase going forward.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tenants (email, full_name, whatsapp_number)
  values (
    lower(new.email),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'whatsapp_number', '+unknown_' || substr(new.id::text, 1, 8))
  )
  on conflict (email) do nothing;
  return new;
end;
$$;

-- 4) Same guarantee for the email-change mirror trigger.
create or replace function public.handle_auth_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email then
    update public.tenants
       set email = lower(new.email),
           updated_at = now()
     where lower(email) = lower(old.email);
  end if;
  return new;
end;
$$;

commit;
