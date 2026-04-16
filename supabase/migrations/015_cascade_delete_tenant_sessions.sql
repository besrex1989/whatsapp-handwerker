-- 015_cascade_delete_tenant_sessions.sql
-- Problem: public.sessions_handwerker.tenant_id references public.tenants(id)
--   without an ON DELETE action, so the default NO ACTION blocks any
--   attempt to delete a tenant row while sessions exist. The new
--   self-service account deletion flow (Edge Function delete-account)
--   would otherwise have to manually purge sessions first.
-- Fix: Swap the FK to ON DELETE CASCADE so the DB cleans up per-tenant
--   chat state automatically whenever the tenant is deleted. Sessions
--   already have an expires_at and are effectively scratch state, so
--   cascading on tenant deletion is the correct semantic.
begin;

alter table public.sessions_handwerker
  drop constraint if exists sessions_handwerker_tenant_id_fkey;

alter table public.sessions_handwerker
  add constraint sessions_handwerker_tenant_id_fkey
  foreign key (tenant_id)
  references public.tenants(id)
  on delete cascade;

commit;
