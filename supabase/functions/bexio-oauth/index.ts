import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const BEXIO_TOKEN_URL = "https://idp.bexio.com/token";

serve(async (req) => {
  const url = new URL(req.url);

  // Handle OAuth callback: GET /bexio-oauth?code=xxx&state=tenant_id&redirect_uri=xxx
  if (req.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state"); // tenant_id
    const redirectUri = url.searchParams.get("redirect_uri")
      || Deno.env.get("SUPABASE_URL") + "/functions/v1/bexio-oauth";

    if (!code || !state) {
      return new Response("Fehlende Parameter (code oder state).", { status: 400 });
    }

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
        return new Response("Fehler bei der Bexio-Verbindung.", { status: 500 });
      }

      const tokens = await tokenResp.json();

      // Save tokens to tenant
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      await supabase
        .from("tenants")
        .update({
          bexio_access_token: tokens.access_token,
          bexio_refresh_token: tokens.refresh_token,
          bexio_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", state);

      return new Response(
        `<!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>Bexio verbunden</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px">
          <h1>✅ Bexio erfolgreich verbunden!</h1>
          <p>Du kannst dieses Fenster jetzt schliessen und WhatsApp verwenden.</p>
        </body>
        </html>`,
        {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    } catch (err) {
      console.error("[Bexio OAuth] Error:", err);
      return new Response("Interner Fehler bei der Bexio-Verbindung.", { status: 500 });
    }
  }

  // Generate authorization URL: POST /bexio-oauth { tenant_id: "..." }
  if (req.method === "POST") {
    const { tenant_id } = await req.json();
    if (!tenant_id) {
      return new Response(JSON.stringify({ error: "tenant_id required" }), { status: 400 });
    }

    const params = new URLSearchParams({
      client_id: Deno.env.get("BEXIO_CLIENT_ID")!,
      redirect_uri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/bexio-oauth`,
      response_type: "code",
      scope: "openid profile email kb_invoice kb_article contact_show contact_edit",
      state: tenant_id,
    });

    const authUrl = `https://idp.bexio.com/authorize?${params}`;

    return new Response(JSON.stringify({ url: authUrl }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
});
