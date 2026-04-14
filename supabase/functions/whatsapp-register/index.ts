// One-shot admin function to register the WhatsApp phone number with the
// Meta Cloud API. After a number is added + verified in the Business
// Manager, it sits in status "Ausstehend" until POST /{phone_number_id}/register
// is called. This function performs that call using the System User token
// from WHATSAPP_ACCESS_TOKEN (which has asset-level access to the number),
// avoiding the permission issues we hit when calling Meta from the Graph
// Explorer with a user token.
//
// Usage (once):
//   curl -X POST \
//     'https://<project>.supabase.co/functions/v1/whatsapp-register' \
//     -H 'Authorization: Bearer <SUPABASE_ANON_KEY>' \
//     -H 'Content-Type: application/json' \
//     -d '{"pin":"173254"}'
//
// The PIN is a 6-digit 2FA PIN the caller chooses. Note it down — Meta
// requires it to reactivate the number after any future deregistration.
//
// After use, this function should be removed (or left as-is; it does
// nothing harmful once the number is registered, subsequent calls return
// a "phone already registered" error).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

  if (!token || !phoneNumberId) {
    return json({
      error: "Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID in secrets",
    }, 500);
  }

  let body: { pin?: string } = {};
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const pin = body.pin;
  if (!pin || !/^\d{6}$/.test(pin)) {
    return json({ error: "Missing or invalid pin — must be exactly 6 digits" }, 400);
  }

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/register`;
  const metaResp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });

  const metaJson = await metaResp.json().catch(() => ({}));

  return json({
    meta_status: metaResp.status,
    meta_response: metaJson,
    phone_number_id: phoneNumberId,
  }, metaResp.ok ? 200 : 502);
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
