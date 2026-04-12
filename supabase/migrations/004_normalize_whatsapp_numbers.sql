-- 004_normalize_whatsapp_numbers.sql
-- Fixes legacy signup bug: the dashboard used to produce "+0763449800" when
-- a Swiss user entered a national-format number like "0763449800". That
-- doesn't match the E.164 number Meta delivers in webhooks ("+41763449800"),
-- so the bot can't find the tenant and rejects the sender.
--
-- Normalisation rules applied:
--   "+0XXXXXXXXX"  -> "+41XXXXXXXXX"  (dropped 0, prepend country code)
--   "00XXXXXXXXX"  -> "+XXXXXXXXX"    (00 international prefix -> +)
--   "0XXXXXXXXX"   -> "+41XXXXXXXXX"  (raw CH national -> E.164)
--   whitespace/dashes/parens -> removed
-- Anything already matching ^\+\d{8,15}$ is left untouched.

-- Strip whitespace, dashes and parentheses first
update public.tenants
set whatsapp_number = regexp_replace(whatsapp_number, '[\s\-()]+', '', 'g')
where whatsapp_number ~ '[\s\-()]';

-- "+0..." (broken CH signup)  ->  "+41..."
update public.tenants
set whatsapp_number = '+41' || substring(whatsapp_number from 3)
where whatsapp_number like '+0%';

-- "00..." (international prefix)  ->  "+..."
update public.tenants
set whatsapp_number = '+' || substring(whatsapp_number from 3)
where whatsapp_number like '00%';

-- Raw national "0..." (no plus)  ->  "+41..."
update public.tenants
set whatsapp_number = '+41' || substring(whatsapp_number from 2)
where whatsapp_number ~ '^0\d+$';

-- No plus, looks like country code already (e.g. "41763449800")
update public.tenants
set whatsapp_number = '+' || whatsapp_number
where whatsapp_number ~ '^\d{10,15}$';
