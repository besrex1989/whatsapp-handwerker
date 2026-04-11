import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { parseTwilioWebhook } from "../_shared/twilio.ts";
import { handleMessage } from "../_shared/flow.ts";

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    // Twilio sends application/x-www-form-urlencoded
    const body = await req.text();
    const formData = new URLSearchParams(body);
    const message = parseTwilioWebhook(formData);

    console.log(`[WhatsApp] From: ${message.from}, Body: "${message.body}", Media: ${message.numMedia}`);

    // Process message asynchronously — respond to Twilio immediately
    // Use EdgeRuntime.waitUntil if available, otherwise process inline
    const processing = handleMessage({
      from: message.from,
      body: message.body,
      numMedia: message.numMedia,
      mediaUrl: message.mediaUrl,
      mediaType: message.mediaType,
    });

    // Wait for processing to complete
    await processing;

    // Return empty TwiML response (we send responses via the REST API, not TwiML)
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      },
    );
  } catch (err) {
    console.error("[WhatsApp Webhook] Error:", err);
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      },
    );
  }
});
