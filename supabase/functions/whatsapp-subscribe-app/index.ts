// One-shot admin function to subscribe this Meta App to the WhatsApp
// Business Account's webhook. Without this, messages sent to the
// business phone number never trigger the webhook (even if the app's
// webhook config has the "messages" field subscribed — that's the
// app-side declaration; this call is the WABA-side linkage).
//
// Usage (once):
//   curl -X POST \
//     'https://<project>.supabase.co/functions/v1/whatsapp-subscribe-app' \
//     -H 'Authorization: Bearer <SUPABASE_ANON_KEY>'
//
// Idempotent — calling twice is harmless.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const wabaId = Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID");

  if (!token || !wabaId) {
    return json({
      error: "Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_BUSINESS_ACCOUNT_ID in secrets",
    }, 500);
  }

  // GET = read current subscribed apps (diagnostic)
  if (req.method === "GET") {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const j = await r.json().catch(() => ({}));
    return json({ action: "list", meta_status: r.status, meta_response: j, waba_id: wabaId });
  }

  // POST = subscribe this app to the WABA's webhook events
  const r = await fetch(
    `https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
  );
  const j = await r.json().catch(() => ({}));
  return json(
    { action: "subscribe", meta_status: r.status, meta_response: j, waba_id: wabaId },
    r.ok ? 200 : 502,
  );
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
