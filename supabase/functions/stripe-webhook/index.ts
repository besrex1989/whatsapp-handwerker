import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import Stripe from "https://esm.sh/stripe@16.0.0?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return new Response("Missing signature", { status: 400 });
  }

  try {
    const body = await req.text();
    const event = stripe.webhooks.constructEvent(body, sig, WEBHOOK_SECRET);

    console.log(`[Stripe] Event: ${event.type}`);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const tenantId = session.metadata?.tenant_id;
        if (tenantId) {
          await supabase
            .from("tenants")
            .update({
              stripe_customer_id: session.customer,
              stripe_subscription_id: session.subscription,
              plan: "active",
              updated_at: new Date().toISOString(),
            })
            .eq("id", tenantId);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
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

      case "customer.subscription.updated": {
        const sub = event.data.object;
        const active = sub.status === "active" || sub.status === "trialing";
        await supabase
          .from("tenants")
          .update({
            plan: active ? "active" : "past_due",
            is_active: active,
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
    console.error("[Stripe Webhook] Error:", err);
    return new Response(`Webhook Error: ${err}`, { status: 400 });
  }
});
