// bexio-accounts Edge Function
//
// Returns the tenant's Bexio revenue accounts (3xxx in the Swiss KMU-
// Kontorahmen) so the dashboard can render a dropdown. The tenant picks
// one and we persist it as tenants.bexio_preferred_account_id; the
// whatsapp-webhook then uses that instead of its built-in heuristic.
//
// Endpoints:
//   GET /bexio-accounts?tenant_id=<uuid>
//     -> { accounts: [{ id, account_no, name }], preferred_account_id }
//   POST /bexio-accounts { tenant_id, account_id|null }
//     -> { success: true }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Minimal token refresh: if the saved access token is expired (or about
// to be), trade the refresh token for a new one and persist.
async function getBexioToken(tenant: any): Promise<string> {
  const now = Date.now();
  const expiresAt = tenant.bexio_expires_at ? new Date(tenant.bexio_expires_at).getTime() : 0;
  // Refresh 60s before expiry to avoid last-second races.
  if (tenant.bexio_access_token && expiresAt - 60_000 > now) {
    return tenant.bexio_access_token;
  }
  if (!tenant.bexio_refresh_token) {
    throw new Error("Bexio nicht verbunden.");
  }
  const tokenResp = await fetch(
    "https://auth.bexio.com/realms/bexio/protocol/openid-connect/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tenant.bexio_refresh_token,
        client_id: Deno.env.get("BEXIO_CLIENT_ID")!,
        client_secret: Deno.env.get("BEXIO_CLIENT_SECRET")!,
      }),
    },
  );
  if (!tokenResp.ok) {
    throw new Error("Bexio token refresh failed: " + (await tokenResp.text()));
  }
  const tokens = await tokenResp.json();
  await supabase.from("tenants").update({
    bexio_access_token: tokens.access_token,
    bexio_refresh_token: tokens.refresh_token || tenant.bexio_refresh_token,
    bexio_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", tenant.id);
  return tokens.access_token;
}

async function loadTenant(tenantId: string): Promise<any> {
  const res = await supabase.from("tenants").select("*").eq("id", tenantId).single();
  if (res.error || !res.data) throw new Error("Tenant nicht gefunden.");
  return res.data;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const tenantId = url.searchParams.get("tenant_id");
      if (!tenantId) {
        return json({ error: "tenant_id required" }, 400);
      }
      const tenant = await loadTenant(tenantId);
      const token = await getBexioToken(tenant);

      const resp = await fetch("https://api.bexio.com/2.0/accounts", {
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      });
      if (!resp.ok) {
        return json({ error: "Bexio /accounts (" + resp.status + ")" }, 502);
      }
      const raw = await resp.json();
      const accounts = Array.isArray(raw) ? raw : [];

      // Return only 3xxx accounts (revenue), excluding 38xx (Skonto) and
      // 39xx (Bestandesaenderungen). Keep 38xx/39xx available under a
      // separate flag in case advanced users really want them.
      function isActive(a: any) {
        return a.is_active === undefined || a.is_active === null ? true : !!a.is_active;
      }
      const filtered = accounts
        .filter((a: any) => {
          const n = String(a.account_no || "");
          return isActive(a) && n.charAt(0) === "3";
        })
        .map((a: any) => ({
          id: a.id,
          account_no: String(a.account_no || ""),
          name: a.name || "",
          // Flag sub-accounts that aren't "real" revenue so the UI can
          // gray them out or put them under "Weitere".
          is_revenue: !(String(a.account_no || "").charAt(1) === "8"
                       || String(a.account_no || "").charAt(1) === "9"),
        }))
        .sort((a: any, b: any) => a.account_no.localeCompare(b.account_no));

      return json({
        accounts: filtered,
        preferred_account_id: tenant.bexio_preferred_account_id || null,
        current_account_id: tenant.bexio_account_id || null,
      }, 200);
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const { tenant_id, account_id } = body;
      if (!tenant_id) return json({ error: "tenant_id required" }, 400);

      // account_id may be null to clear the preference.
      const prefId = account_id == null ? null : Number(account_id);
      if (prefId != null && (!Number.isInteger(prefId) || prefId <= 0)) {
        return json({ error: "account_id must be a positive integer or null" }, 400);
      }

      const upd = await supabase
        .from("tenants")
        .update({
          bexio_preferred_account_id: prefId,
          // Clearing bexio_account_id forces the next invoice to re-evaluate
          // which account to use based on the (new) preference.
          bexio_account_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", tenant_id);
      if (upd.error) return json({ error: upd.error.message }, 500);
      return json({ success: true, preferred_account_id: prefId }, 200);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("[bexio-accounts] error:", err);
    return json({ error: String((err as Error).message || err) }, 500);
  }
});

function json(obj: any, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
