-- 010_bexio_preferred_account.sql
-- Let tenants override the auto-detected revenue account used for Bexio
-- invoice positions. When null, whatsapp-webhook falls back to the built-in
-- ranking (3400 Dienstleistungsertrag > 3200 Handelsertrag > 3000 > 3600
-- > 3700, skipping 3800 Skonto and 3900 Bestandesaenderungen).
--
-- The value stored here is the Bexio numeric account id (same format as
-- bexio_account_id), NOT the account_no string. The dashboard lets the
-- user pick from a dropdown of their actual Bexio accounts.

alter table public.tenants
  add column if not exists bexio_preferred_account_id integer;
