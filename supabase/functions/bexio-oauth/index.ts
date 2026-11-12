import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { requireTenantOwner } from "../_shared/tenant-auth.ts";
import { signState, verifyState } from "../_shared/oauth-state.ts";

// Sicherheit: Die Function wird mit --no-verify-jwt deployed, ist also ohne
// Login erreichbar. Beide Einstiege prüfen deshalb selbst:
//   POST  — Aufrufer ist angemeldet und der Tenant gehört ihm. Der `state`
//           ist signiert (Tenant-ID + Ablauf, HMAC) und 15 Minuten gültig.
//   GET   — `state` ist echt und nicht abgelaufen UND der Aufrufer ist
//           angemeldet und Besitzer des Tenants im `state`. Erst danach
//           wird der Code getauscht und gespeichert.
// So kann niemand einem fremden Tenant ein Bexio unterschieben, und ein
// fremdes Bexio lässt sich nicht an den eigenen Tenant binden.

// Bexio migrated from idp.bexio.com to auth.bexio.com (Keycloak)
const BEXIO_TOKEN_URL = "https://auth.bexio.com/realms/bexio/protocol/openid-connect/token";

// Secret für die state-Signatur. BEXIO_CLIENT_SECRET ist ohnehin gesetzt
// (ohne es funktioniert der Flow nicht); oauth-state.ts trennt die
// Verwendung über einen festen Kontext-String.
function stateSecret(): string {
  return Deno.env.get("BEXIO_CLIENT_SECRET") || "";
}

function jsonResp(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);

  // Handle OAuth callback: GET /bexio-oauth?code=xxx&state=tenant_id&redirect_uri=xxx
  if (req.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state"); // signiert, siehe oauth-state.ts
    const redirectUri = url.searchParams.get("redirect_uri")
      || Deno.env.get("SUPABASE_URL") + "/functions/v1/bexio-oauth";

    if (!code || !state) {
      return new Response("Fehlende Parameter (code oder state).", {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    const checked = await verifyState(state, stateSecret());
    if (!checked.ok) {
      return jsonResp({
        error: checked.reason === "expired"
          ? "Die Bexio-Anfrage ist abgelaufen. Bitte im Dashboard erneut auf «Bexio verbinden» klicken."
          : "Ungültige Bexio-Anfrage. Bitte im Dashboard erneut auf «Bexio verbinden» klicken.",
        error_code: checked.reason === "expired" ? "state_expired" : "state_invalid",
      }, 400);
    }
    const tenantId = checked.tenantId;

    const auth = await requireTenantOwner(req, tenantId, "id, email");
    if ("response" in auth) return auth.response;

    try {
      // Exchange code for tokens
      const tokenResp = await fetch(BEXIO_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: Deno.env.get("BEXIO_CLIENT_ID")!,
          client_secret: Deno.env.get("BEXIO_CLIENT_SECRET")!,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenResp.ok) {
        const err = await tokenResp.text();
        console.error("[Bexio OAuth] Token error:", err);
        return new Response("Fehler bei der Bexio-Verbindung: " + err, {
          status: 500,
          headers: CORS_HEADERS,
        });
      }

      const tokens = await tokenResp.json();

      // Save tokens to tenant
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      const upd = await supabase
        .from("tenants")
        .update({
          bexio_access_token: tokens.access_token,
          bexio_refresh_token: tokens.refresh_token,
          bexio_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          // Clear any previously cached per-instance IDs — they may belong to
          // a different Bexio company if the user just reconnected. The
          // whatsapp-webhook auto-fetches them on the first invoice attempt.
          bexio_user_id: null,
          bexio_account_id: null,
          bexio_tax_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tenantId);
      if (upd.error) {
        console.error("[Bexio OAuth] Tenant update failed:", upd.error.message);
        return jsonResp({ error: "Bexio-Verbindung konnte nicht gespeichert werden." }, 500);
      }

      return new Response(
        JSON.stringify({ success: true, message: "Bexio erfolgreich verbunden!" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        },
      );
    } catch (err) {
      console.error("[Bexio OAuth] Error:", err);
      return new Response("Interner Fehler bei der Bexio-Verbindung.", {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  }

  // Generate authorization URL: POST /bexio-oauth { tenant_id, redirect_uri? }
  if (req.method === "POST") {
    let body: any = {};
    try { body = await req.json(); } catch { /* empty body */ }
    const { tenant_id, redirect_uri } = body;
    if (!tenant_id) {
      return new Response(JSON.stringify({ error: "tenant_id required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    const auth = await requireTenantOwner(req, tenant_id, "id, email");
    if ("response" in auth) return auth.response;

    // Prefer the caller-supplied redirect_uri (e.g. the Vercel callback page
    // that Bexio has registered). Fall back to the Edge Function URL.
    const effectiveRedirect = redirect_uri
      || `${Deno.env.get("SUPABASE_URL")}/functions/v1/bexio-oauth`;

    const params = new URLSearchParams({
      client_id: Deno.env.get("BEXIO_CLIENT_ID")!,
      redirect_uri: effectiveRedirect,
      response_type: "code",
      scope: "openid profile offline_access contact_show contact_edit kb_invoice_edit kb_offer_edit article_show accounting",
      state: await signState(auth.tenant.id, stateSecret()),
    });

    const authUrl = `https://auth.bexio.com/realms/bexio/protocol/openid-connect/auth?${params}`;

    return new Response(JSON.stringify({ url: authUrl }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  return new Response("Method not allowed", {
    status: 405,
    headers: CORS_HEADERS,
  });
});
