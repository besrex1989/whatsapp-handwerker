-- 008_position_units.sql
-- Add session fields to track quantity and unit of the position currently
-- being entered, so the WhatsApp flow can ask:
--   1) Beschreibung   -> current_position_desc (existing)
--   2) Menge+Einheit  -> current_position_amount + current_position_unit (new)
--   3) Preis/Einheit  -> current_position_price (existing)
-- The final position is then pushed into sessions_handwerker.manual_positions
-- (JSONB) with { description, amount, unit, price, total } shape.

alter table public.sessions_handwerker
  add column if not exists current_position_amount numeric,
  add column if not exists current_position_unit text;
