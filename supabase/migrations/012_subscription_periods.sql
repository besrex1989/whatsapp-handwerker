-- Cache the subscription's start date and next billing date on the tenant
-- row so the dashboard can show them without calling Stripe on every page
-- load. These are populated by the stripe-webhook on subscription.created
-- and subscription.updated events.
--
-- subscription_cancel_at_period_end mirrors Stripe's flag: when the user
-- cancels via the portal, Stripe keeps the subscription active until the
-- end of the paid period. We use this to show "Läuft ab am ..." instead
-- of "Nächste Abrechnung ...".
alter table public.tenants
  add column if not exists subscription_started_at timestamptz,
  add column if not exists subscription_renews_at timestamptz,
  add column if not exists subscription_cancel_at_period_end boolean default false;
