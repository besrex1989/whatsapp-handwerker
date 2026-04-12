// Receives events from Stripe and keeps the tenants table in sync with
// subscription state. Stripe posts here with a signed body — we verify
// the signature before trusting anything.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import Stripe from "https://esm.sh/stripe@16.0.0?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
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
        const active = sub.status === "active" || sub.status === "trialing";
        const priceId = sub.items.data[0]?.price?.id;
        const planLabel = priceId && PRICE_TO_PLAN[priceId]
          ? PRICE_TO_PLAN[priceId]
          : (active ? "active" : "past_due");

        // Cache the period dates so the dashboard can show "gestartet am"
        // and "nächste Abrechnung am" without needing to hit Stripe.
        const startedAt = sub.start_date
          ? new Date(sub.start_date * 1000).toISOString()
          : null;
        const renewsAt = (sub as any).current_period_end
          ? new Date((sub as any).current_period_end * 1000).toISOString()
          : null;
        const cancelAtPeriodEnd = !!sub.cancel_at_period_end;

        // Prefer subscription.metadata.tenant_id (set by stripe-checkout);
        // fall back to matching by stripe_subscription_id for subscriptions
        // created before we started stamping metadata.
        const tenantId = sub.metadata?.tenant_id;
        const commonFields = {
          plan: active ? planLabel : "past_due",
          is_active: active,
          subscription_started_at: startedAt,
          subscription_renews_at: renewsAt,
          subscription_cancel_at_period_end: cancelAtPeriodEnd,
          updated_at: new Date().toISOString(),
        };
        const query = tenantId
          ? supabase.from("tenants").update({
              ...commonFields,
              stripe_subscription_id: sub.id,
              stripe_customer_id: sub.customer,
            }).eq("id", tenantId)
          : supabase.from("tenants").update(commonFields)
              .eq("stripe_subscription_id", sub.id);

        await query;
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
