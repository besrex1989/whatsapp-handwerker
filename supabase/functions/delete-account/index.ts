// Self-service account deletion. Called from the dashboard "Gefahrenzone"
// card after the user types LÖSCHEN to confirm.
//
// Request:  POST (no body needed — caller identified via JWT)
// Response: { ok: true } or { error: string }
//
// Auth: requires a valid Supabase user JWT. We match the tenant to that
// user via case-insensitive email lookup (in line with the RLS SELECT
// policy after migration 013).
//
// Deletion order, designed to fail safely:
//   1) Cancel the Stripe subscription immediately. Best-effort — if
//      Stripe is down or the sub is already gone we log and continue,
//      because the user's right to erasure does not depend on Stripe.
//   2) Delete the tenants row. FK ON DELETE CASCADE from migration 015
//      removes all sessions_handwerker rows for that tenant in the same
//      transaction, so no chat state is left behind.
//   3) Delete the auth.users row via the admin API. This is last on
//      purpose: if step 2 fails we abort before invalidating the session
//      so the user can retry; if step 3 fails after step 2 succeeded,
//      the user is a harmless "ghost" auth row with no data attached —
//      recoverable manually by support.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import Stripe from "https://esm.sh/stripe@18.5.0?target=denonext";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

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
    // Identify the caller via their JWT.
    const authHeader = req.headers.get("Authorization") || "";
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userResp } = await authClient.auth.getUser();
    const user = userResp?.user;
    if (!user || !user.email) return jsonError("Nicht angemeldet.", 401);

    // Admin client for the actual teardown.
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Load tenant by case-insensitive email match (same as dashboard.js).
    const { data: tenant } = await admin
      .from("tenants")
      .select("id, email, stripe_subscription_id")
      .ilike("email", user.email)
      .limit(1)
      .maybeSingle();

    // 1) Stripe — best-effort immediate cancel.
    if (tenant?.stripe_subscription_id) {
      try {
        await stripe.subscriptions.cancel(tenant.stripe_subscription_id);
      } catch (stripeErr) {
        // Subscription could already be cancelled or deleted. Log and
        // proceed — don't block data deletion on a Stripe hiccup.
        console.warn(
          "[delete-account] Stripe cancel failed (ignored):",
          (stripeErr as Error)?.message || stripeErr,
        );
      }
    }

    // 2) Delete tenant row. Migration 015 cascades to sessions_handwerker.
    if (tenant?.id) {
      const { error: tenantErr } = await admin
        .from("tenants")
        .delete()
        .eq("id", tenant.id);
      if (tenantErr) {
        console.error("[delete-account] tenant delete failed:", tenantErr);
        return jsonError(
          "Daten konnten nicht gelöscht werden: " + tenantErr.message,
          500,
        );
      }
    }

    // 3) Delete auth user.
    const { error: authDelErr } = await admin.auth.admin.deleteUser(user.id);
    if (authDelErr) {
      console.error("[delete-account] auth delete failed:", authDelErr);
      return jsonError(
        "Auth-Löschung fehlgeschlagen: " + authDelErr.message,
        500,
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err) {
    console.error("[delete-account] Unexpected error:", err);
    return jsonError(
      "Interner Fehler: " + ((err as Error)?.message || String(err)),
      500,
    );
  }
});

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
