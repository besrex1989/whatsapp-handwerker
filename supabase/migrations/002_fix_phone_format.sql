-- Fix whatsapp_number format: remove 'whatsapp:' prefix
UPDATE public.tenants
SET whatsapp_number = REPLACE(whatsapp_number, 'whatsapp:', '')
WHERE whatsapp_number LIKE 'whatsapp:%';

-- Clear old sessions so they restart fresh
DELETE FROM public.sessions_handwerker;
