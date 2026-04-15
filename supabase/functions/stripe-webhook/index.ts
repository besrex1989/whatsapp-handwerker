// Receives events from Stripe and keeps the tenants table in sync with
// subscription state. Stripe posts here with a signed body — we verify
// the signature before trusting anything.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
// target=denonext + fetch http client: the default node http client inside
// stripe@16 ended up pulling in deno.land/std's node compat layer, which
// called Deno.core.runMicrotasks() — an API that no longer exists in the
// Deno 2.x runtime that Supabase Edge uses, causing the worker to crash
// after each event and leaving tenants stuck on stale plan values.
import Stripe from "https://esm.sh/stripe@18.5.0?target=denonext";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

// Map a Stripe price ID back to our internal plan name. Used so we can
// show "Monatlich" vs "Jaehrlich" in the dashboard later.
const PRICE_TO_PLAN: Record<string, string> = {};
const monthlyId = Deno.env.get("STRIPE_PRICE_ID_MONTHLY");
const yearlyId = Deno.env.get("STRIPE_PRICE_ID_YEARLY");
if (monthlyId) PRICE_TO_PLAN[monthlyId] = "active_monthly";
if (yearlyId) PRICE_TO_PLAN[yearlyId] = "active_yearly";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return new Response("Missing signature", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const body = await req.text();
    // Deno needs the async variant because the crypto operations aren't
    // available synchronously in the Edge runtime.
    event = await stripe.webhooks.constructEventAsync(body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return new Response(`Webhook Error: ${err}`, { status: 400 });
  }

  console.log(`[stripe-webhook] Event: ${event.type}`);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const tenantId = session.metadata?.tenant_id;

        if (!tenantId) {
          console.warn("[stripe-webhook] checkout.session.completed without tenant_id metadata");
          break;
        }

        // Only mark as active if payment actually succeeded. Stripe may
        // send the event for sessions where payment is still pending
        // (e.g. bank transfer).
        const paymentOk = session.payment_status === "paid"
          || session.payment_status === "no_payment_required";

        await supabase
          .from("tenants")
          .update({
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            plan: paymentOk ? "active" : "pending",
            is_active: paymentOk,
            updated_at: new Date().toISOString(),
          })
          .eq("id", tenantId);
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;

        // Map Stripe subscription statuses to our internal plan values.
        // "incomplete" is deliberately NOT mapped: it means the first
        // invoice payment is still settling (SCA / async payment method).
        // The follow-up invoice.payment_succeeded or invoice.payment_failed
        // event will tell us the actual outcome; treating it as past_due
        // here would show a spurious "Zahlung fehlgeschlagen" to the user
        // and could get overwritten out of order with the later event.
        const priceId = sub.items.data[0]?.price?.id;
        let newPlan: string | null = null;
        let newActive: boolean | null = null;
        if (sub.status === "active" || sub.status === "trialing") {
          newPlan = priceId && PRICE_TO_PLAN[priceId] ? PRICE_TO_PLAN[priceId] : "active";
          newActive = true;
        } else if (sub.status === "past_due" || sub.status === "unpaid") {
          newPlan = "past_due";
          newActive = false;
        } else if (sub.status === "canceled" || sub.status === "incomplete_expired") {
          newPlan = "cancelled";
          newActive = false;
        }

        // Cache the period dates so the dashboard can show "gestartet am"
        // and "nächste Abrechnung am" without needing to hit Stripe.
        const startedAt = sub.start_date
          ? new Date(sub.start_date * 1000).toISOString()
          : null;
        const renewsAt = (sub as any).current_period_end
          ? new Date((sub as any).current_period_end * 1000).toISOString()
          : null;
        const cancelAtPeriodEnd = !!sub.cancel_at_period_end;

        const update: Record<string, unknown> = {
          subscription_started_at: startedAt,
          subscription_renews_at: renewsAt,
          subscription_cancel_at_period_end: cancelAtPeriodEnd,
          updated_at: new Date().toISOString(),
        };
        if (newPlan !== null) {
          update.plan = newPlan;
          update.is_active = newActive;
        }

        // Prefer subscription.metadata.tenant_id (set by stripe-checkout);
        // fall back to matching by stripe_subscription_id for subscriptions
        // created before we started stamping metadata.
        const tenantId = sub.metadata?.tenant_id;
        const query = tenantId
          ? supabase.from("tenants").update({
              ...update,
              stripe_subscription_id: sub.id,
              stripe_customer_id: sub.customer,
            }).eq("id", tenantId)
          : supabase.from("tenants").update(update)
              .eq("stripe_subscription_id", sub.id);

        await query;
        break;
      }

      // Authoritative signal that the tenant actually paid: a Stripe
      // invoice cleared. This covers the initial checkout invoice and
      // every renewal. We use it to re-activate a tenant that may have
      // been briefly marked past_due/incomplete while a charge was
      // settling, without having to wait for the subscription.updated
      // event (which can arrive out of order).
      case "invoice.payment_succeeded":
      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = (invoice as any).subscription as string | null;
        if (!subscriptionId) break;

        const priceId = invoice.lines?.data?.[0]?.price?.id;
        const planLabel = priceId && PRICE_TO_PLAN[priceId]
          ? PRICE_TO_PLAN[priceId]
          : "active";

        // invoice.period_end (unix seconds) is the next billing date for
        // subscription invoices — use it so the dashboard shows the right
        // "Nächste Abrechnung" without a separate subscription lookup.
        const renewsAt = (invoice as any).period_end
          ? new Date((invoice as any).period_end * 1000).toISOString()
          : null;

        const update: Record<string, unknown> = {
          plan: planLabel,
          is_active: true,
          updated_at: new Date().toISOString(),
        };
        if (renewsAt) update.subscription_renews_at = renewsAt;

        // Match by subscription id first; fall back to customer id for
        // invoices on subscriptions we don't yet have stamped (e.g. the
        // very first invoice arriving before subscription.created).
        let res = await supabase
          .from("tenants")
          .update(update)
          .eq("stripe_subscription_id", subscriptionId)
          .select("id");

        if (!res.data || res.data.length === 0) {
          const customerId = (invoice as any).customer as string | null;
          if (customerId) {
            await supabase
              .from("tenants")
              .update({ ...update, stripe_subscription_id: subscriptionId })
              .eq("stripe_customer_id", customerId);
          }
        }
        break;
      }

      // Only flag the tenant as past_due once Stripe has actually moved
      // the subscription into past_due/unpaid (i.e. retries exhausted).
      // A single failed charge attempt may still be retried.
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = (invoice as any).subscription as string | null;
        if (!subscriptionId) break;

        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        if (sub.status !== "past_due" && sub.status !== "unpaid") break;

        await supabase
          .from("tenants")
          .update({
            plan: "past_due",
            is_active: false,
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", subscriptionId);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await supabase
          .from("tenants")
          .update({
            plan: "cancelled",
            is_active: false,
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", sub.id);
        break;
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[stripe-webhook] Handler error:", err);
    return new Response(`Handler Error: ${err}`, { status: 500 });
  }
});
