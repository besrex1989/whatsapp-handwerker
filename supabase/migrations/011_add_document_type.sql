-- Support for Bexio Angebote (quotes/offers) alongside Rechnungen.
-- A single session row tracks which document kind is currently being
-- created or edited. "invoice" = Rechnung, "offer" = Angebot.
-- The flow code branches on this value when talking to the Bexio API
-- (/2.0/kb_invoice vs /2.0/kb_offer) and for user-facing labels.
alter table public.sessions_handwerker
  add column if not exists bexio_document_type text default 'invoice';
