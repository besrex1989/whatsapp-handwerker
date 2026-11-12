-- 017_restrict_tenant_writes.sql
-- Problem: The RLS policies from migration 003 let a logged-in user UPDATE
--   (and INSERT) their own public.tenants row, but RLS only decides WHICH
--   ROWS — not which columns. Supabase grants ALL on public tables to
--   `authenticated` by default, so a user could call the REST API directly
--   with their own session token and set e.g. plan = 'pro' or push
--   trial_ends_at years into the future. The WhatsApp bot gates usage on
--   exactly those columns, so that is a free permanent subscription.
--   Same for is_active, stripe_customer_id, stripe_subscription_id and the
--   subscription_* columns, which only stripe-webhook may write.
-- Symptom: none visible — the dashboard never does this. Only reachable
--   by someone crafting the request by hand.
-- Fix: Replace the table-wide INSERT/UPDATE grant with column-level
--   grants covering exactly what the dashboard writes:
--     UPDATE: full_name, whatsapp_number, updated_at and the Bexio
--             connection columns (cleared by "Verbindung trennen").
--     INSERT: email, full_name, whatsapp_number (everything else takes its
--             default; the signup trigger from migration 006 normally
--             creates the row anyway, as security definer).
--   Row scope stays with the existing RLS policies. Edge Functions use the
--   service role and are not affected. SELECT is unchanged.
--   `anon` never had a matching policy; its write grants are removed too.
--   DELETE/TRUNCATE are not used by the frontend (delete-account runs as
--   service role) and are revoked as well — TRUNCATE is not covered by RLS.
-- Rollback (compensation migration):
--   grant insert, update, delete on public.tenants to authenticated;
begin;

revoke insert, update, delete, truncate on public.tenants from anon, authenticated;

grant update (
  full_name,
  whatsapp_number,
  updated_at,
  bexio_access_token,
  bexio_refresh_token,
  bexio_expires_at,
  bexio_user_id,
  bexio_account_id,
  bexio_tax_id
) on public.tenants to authenticated;

grant insert (email, full_name, whatsapp_number) on public.tenants to authenticated;

commit;
