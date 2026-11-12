// Creates a Stripe Checkout Session for a tenant and returns the hosted
// checkout URL. The dashboard calls this when the user clicks
// "Jetzt upgraden".
//
// Request: POST { tenant_id, plan: "monthly" | "yearly", success_url, cancel_url }
// Response: { url }
//
// Auth: requires a valid Supabase user JWT in the Authorization header.
// We verify the JWT's email matches the tenant row so one user can't
// upgrade another tenant's subscription.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireTenantOwner } from "../_shared/tenant-auth.ts";
import Stripe from "https://esm.sh/stripe@18.5.0?target=denonext";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

// Fetch http client — see stripe-webhook for context on why the node
// http client breaks on Supabase Edge Runtime (Deno 2.x).
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, plan, success_url, cancel_url } = body;

    if (!tenant_id || !plan || !success_url || !cancel_url) {
      return jsonError("tenant_id, plan, success_url und cancel_url sind erforderlich", 400);
    }

    // Look up the price ID for the chosen plan
    const priceId = plan === "yearly"
      ? Deno.env.get("STRIPE_PRICE_ID_YEARLY")
      : Deno.env.get("STRIPE_PRICE_ID_MONTHLY");

    if (!priceId) {
      return jsonError(`Stripe Price-ID für Plan '${plan}' nicht konfiguriert.`, 500);
    }

    // Aufrufer muss angemeldet sein und der Tenant muss ihm gehören
    // (E-Mail-Vergleich ohne Gross-/Kleinschreibung).
    const auth = await requireTenantOwner(req, tenant_id, "id, email, full_name, stripe_customer_id");
    if ("response" in auth) return auth.response;
    const tenant = auth.tenant;

    // Re-use an existing Stripe customer if we already created one for this
    // tenant, otherwise let Checkout create one via customer_email.
    const checkoutArgs: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url,
      cancel_url,
      allow_promotion_codes: true,
      metadata: { tenant_id: tenant.id },
      subscription_data: {
        metadata: { tenant_id: tenant.id },
      },
      // Swiss-friendly locale
      locale: "de",
    };

    if (tenant.stripe_customer_id) {
      checkoutArgs.customer = tenant.stripe_customer_id;
    } else {
      checkoutArgs.customer_email = tenant.email;
    }

    const session = await stripe.checkout.sessions.create(checkoutArgs);

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err) {
    console.error("[stripe-checkout] Error:", err);
    return jsonError("Interner Fehler: " + (err?.message || String(err)), 500);
  }
});

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
