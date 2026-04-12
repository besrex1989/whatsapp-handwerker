-- Fix whatsapp_number format: remove 'whatsapp:' prefix
-- If a row with both formats exists (prefixed + clean), drop the prefixed
-- one first so the subsequent UPDATE doesn't violate the unique constraint.
-- Without this the Supabase Preview CI fails on re-running migrations.
DELETE FROM public.tenants t
WHERE t.whatsapp_number LIKE 'whatsapp:%'
  AND EXISTS (
    SELECT 1 FROM public.tenants t2
    WHERE t2.whatsapp_number = REPLACE(t.whatsapp_number, 'whatsapp:', '')
  );

UPDATE public.tenants
SET whatsapp_number = REPLACE(whatsapp_number, 'whatsapp:', '')
WHERE whatsapp_number LIKE 'whatsapp:%';

-- Clear old sessions so they restart fresh
DELETE FROM public.sessions_handwerker;
