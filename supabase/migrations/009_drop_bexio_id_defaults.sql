-- 009_drop_bexio_id_defaults.sql
-- Problem: migration 001 shipped with hard-coded defaults for Bexio IDs
--     bexio_user_id    default 1
--     bexio_account_id default 150
--     bexio_tax_id     default 29
-- These defaults came from the original developer's Bexio instance and are
-- WRONG for every other tenant. Because they are truthy, the auto-fetch
-- code paths in whatsapp-webhook (which only fetch when the id is falsy)
-- never ran for new tenants, and invoice creation then failed with
-- "tax_id [Diese Eingabe ist nicht korrekt]" (HTTP 422).
--
-- Fix:
--   1) Drop the defaults so new tenants start with NULL on all three ids.
--   2) Reset the ids on every existing tenant that still has the exact
--      default tuple (1, 150, 29). The next invoice attempt will fetch
--      the correct ids from that tenant's Bexio instance and cache them.

alter table public.tenants alter column bexio_user_id    drop default;
alter table public.tenants alter column bexio_account_id drop default;
alter table public.tenants alter column bexio_tax_id     drop default;

update public.tenants
   set bexio_user_id    = null,
       bexio_account_id = null,
       bexio_tax_id     = null,
       updated_at       = now()
 where bexio_user_id    = 1
   and bexio_account_id = 150
   and bexio_tax_id     = 29;
