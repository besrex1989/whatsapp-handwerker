-- 016_add_article_support_to_sessions.sql
-- Problem: The new product/article selection flow in the WhatsApp bot needs
--   to temporarily store the selected Bexio article ID during the
--   "product_amount" step (between product_select and adding the position).
-- Fix: Add a nullable integer column for the current article ID, analogous
--   to current_position_desc / current_position_price which store other
--   temporary position fields.
-- Note: The manual_positions JSONB array gains an optional `article_id`
--   key per position object. No schema change is needed for that since
--   JSONB is schemaless.

alter table public.sessions_handwerker
  add column if not exists current_article_id integer;
