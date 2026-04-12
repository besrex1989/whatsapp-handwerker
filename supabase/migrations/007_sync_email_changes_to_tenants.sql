-- 007_sync_email_changes_to_tenants.sql
-- Problem: When a user changes their email via supabase.auth.updateUser({email})
--   and confirms the link, auth.users.email updates, but public.tenants.email
--   would stay on the old value. The dashboard looks up tenants by
--   .eq("email", user.email), so the tenant row would become unreachable
--   after an email change (and WhatsApp messages from that user still match
--   their number, but the dashboard would show "Tenant nicht gefunden").
-- Fix: Trigger on auth.users that mirrors email changes onto tenants.
--   Runs as SECURITY DEFINER so it bypasses RLS.

create or replace function public.handle_auth_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email then
    update public.tenants
      set email = new.email,
          updated_at = now()
      where lower(email) = lower(old.email);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_email_changed on auth.users;
create trigger on_auth_email_changed
  after update of email on auth.users
  for each row execute function public.handle_auth_email_change();
