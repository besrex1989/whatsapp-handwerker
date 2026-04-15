// Creates a Stripe Customer Portal session so the user can manage their
// subscription (change payment method, cancel, view invoices).
//
// Request:  POST { tenant_id, return_url }
// Response: { url }
//
// Auth: requires a valid Supabase user JWT; the JWT's email must match
// the tenant row.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
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
    const { tenant_id, return_url } = body;

    if (!tenant_id || !return_url) {
      return jsonError("tenant_id und return_url sind erforderlich", 400);
    }

    const authHeader = req.headers.get("Authorization") || "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userResp } = await supabase.auth.getUser();
    const user = userResp?.user;
    if (!user) return jsonError("Nicht angemeldet.", 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: tenant } = await admin
      .from("tenants")
      .select("id, email, stripe_customer_id")
      .eq("id", tenant_id)
      .single();

    if (!tenant) return jsonError("Tenant nicht gefunden.", 404);
    if (tenant.email !== user.email) return jsonError("Zugriff verweigert.", 403);
    if (!tenant.stripe_customer_id) {
      return jsonError("Kein Stripe-Kunde hinterlegt. Bitte zuerst ein Abo abschliessen.", 400);
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: tenant.stripe_customer_id,
      return_url,
      locale: "de",
    });

    return new Response(JSON.stringify({ url: portal.url }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err) {
    console.error("[stripe-portal] Error:", err);
    return jsonError("Interner Fehler: " + (err?.message || String(err)), 500);
  }
});

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
