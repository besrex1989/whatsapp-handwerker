const ACCOUNT_SID = () => Deno.env.get("TWILIO_ACCOUNT_SID")!;
const AUTH_TOKEN = () => Deno.env.get("TWILIO_AUTH_TOKEN")!;

function twilioApiUrl(accountSid: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
}

function authHeader(accountSid: string, authToken: string): string {
  return "Basic " + btoa(`${accountSid}:${authToken}`);
}

export async function sendWhatsApp(to: string, body: string): Promise<void> {
  const sid = ACCOUNT_SID();
  const token = AUTH_TOKEN();

  // Ensure whatsapp: prefix
  const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  // Use the tenant's number or a default — Twilio sandbox uses +14155238886
  const fromNumber = `whatsapp:${Deno.env.get("TWILIO_WHATSAPP_FROM") || "+14155238886"}`;

  const params = new URLSearchParams({
    To: toNumber,
    From: fromNumber,
    Body: body,
  });

  const resp = await fetch(twilioApiUrl(sid), {
    method: "POST",
    headers: {
      Authorization: authHeader(sid, token),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error("[Twilio] send error:", err);
    throw new Error(`Twilio error: ${resp.status}`);
  }
}

export async function sendWhatsAppMedia(to: string, body: string, mediaUrl: string): Promise<void> {
  const sid = ACCOUNT_SID();
  const token = AUTH_TOKEN();

  const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
  const fromNumber = `whatsapp:${Deno.env.get("TWILIO_WHATSAPP_FROM") || "+14155238886"}`;

  const params = new URLSearchParams({
    To: toNumber,
    From: fromNumber,
    Body: body,
    MediaUrl: mediaUrl,
  });

  const resp = await fetch(twilioApiUrl(sid), {
    method: "POST",
    headers: {
      Authorization: authHeader(sid, token),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error("[Twilio] send media error:", err);
  }
}

// ---------- Parse incoming Twilio webhook ----------

export interface TwilioMessage {
  from: string;          // whatsapp:+41791234567
  to: string;
  body: string;          // text body
  numMedia: number;
  mediaUrl?: string;     // first media URL
  mediaType?: string;    // first media content type
}

export function parseTwilioWebhook(formData: URLSearchParams): TwilioMessage {
  const numMedia = parseInt(formData.get("NumMedia") || "0", 10);

  return {
    from: formData.get("From") || "",
    to: formData.get("To") || "",
    body: formData.get("Body")?.trim() || "",
    numMedia,
    mediaUrl: numMedia > 0 ? formData.get("MediaUrl0") || undefined : undefined,
    mediaType: numMedia > 0 ? formData.get("MediaContentType0") || undefined : undefined,
  };
}

// Validate Twilio webhook signature
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  // Build the data string: URL + sorted params
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const token = AUTH_TOKEN();

  // HMAC-SHA1
  const encoder = new TextEncoder();
  const keyData = encoder.encode(token);
  const msgData = encoder.encode(data);

  // Use Web Crypto API
  return crypto.subtle
    .importKey("raw", keyData, { name: "HMAC", hash: "SHA-1" }, false, ["sign"])
    .then((key) => crypto.subtle.sign("HMAC", key, msgData))
    .then((sig) => {
      const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
      return computed === signature;
    })
    .catch(() => false) as unknown as boolean;
}
