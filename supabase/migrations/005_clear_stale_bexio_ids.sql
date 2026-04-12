-- 005_clear_stale_bexio_ids.sql
-- Problem: public.tenants defaulted bexio_user_id=1, bexio_account_id=150,
-- bexio_tax_id=29 at signup. These were HdF-specific IDs that don't exist
-- in other Bexio instances. The webhook only auto-fetches the real IDs when
-- the columns are NULL, so tenants connecting a different Bexio got 422s like
-- "positions: 0 [account_id [Diese Eingabe ist nicht korrekt.] tax_id [...]]"
--
-- Fix:
--   1) Drop the misleading column defaults so future signups get NULL
--   2) NULL out the cached IDs on every existing tenant so the webhook
--      re-fetches them from whatever Bexio instance is actually connected.
--      (The access/refresh tokens stay intact, so users don't have to
--      re-do OAuth.)

alter table public.tenants alter column bexio_user_id    drop default;
alter table public.tenants alter column bexio_account_id drop default;
alter table public.tenants alter column bexio_tax_id     drop default;

update public.tenants
set bexio_user_id    = null,
    bexio_account_id = null,
    bexio_tax_id     = null,
    updated_at       = now();
