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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import Stripe from "https://esm.sh/stripe@16.0.0?target=deno";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
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
      return jsonError(`Stripe Price-ID fuer Plan '${plan}' nicht konfiguriert.`, 500);
    }

    // Verify the caller owns this tenant. We use the anon client with the
    // user's JWT so RLS kicks in and we only see the tenant belonging to
    // this email address.
    const authHeader = req.headers.get("Authorization") || "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userResp } = await supabase.auth.getUser();
    const user = userResp?.user;
    if (!user) return jsonError("Nicht angemeldet.", 401);

    // Use service role to read/write the tenant (RLS-agnostic), but only
    // after we confirmed the JWT belongs to a real user above.
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: tenant, error: tenantErr } = await admin
      .from("tenants")
      .select("id, email, full_name, stripe_customer_id")
      .eq("id", tenant_id)
      .single();

    if (tenantErr || !tenant) return jsonError("Tenant nicht gefunden.", 404);
    if (tenant.email !== user.email) return jsonError("Zugriff verweigert.", 403);

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
