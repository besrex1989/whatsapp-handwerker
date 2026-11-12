// bexio-recurring — gemeinsame Helfer der Serienrechnungs-Functions
// (bexio-recurring-preview, bexio-recurring-create): CORS, Auth, Bexio-
// Token, Bexio-Requests mit Rate-Limit-Wiederholung, Rechnungsliste.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

const BEXIO_API = "https://api.bexio.com/2.0";

export function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export class BexioError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// Aufrufer muss angemeldet sein und der Tenant muss ihm gehören. Liefert
// den Tenant oder eine fertige Fehler-Response.
export async function authorizeTenant(req: Request, tenantId: string): Promise<{ tenant: any } | { response: Response }> {
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userResp } = await userClient.auth.getUser();
  const user = userResp?.user;
  if (!user || !user.email) return { response: json({ error: "Nicht angemeldet." }, 401) };

  const { data: tenant } = await adminClient()
    .from("tenants")
    .select("id, email, bexio_access_token, bexio_refresh_token, bexio_expires_at")
    .eq("id", tenantId)
    .maybeSingle();
  if (!tenant) return { response: json({ error: "Tenant nicht gefunden." }, 404) };
  if (String(tenant.email || "").toLowerCase() !== user.email.toLowerCase()) {
    return { response: json({ error: "Zugriff verweigert." }, 403) };
  }
  if (!tenant.bexio_access_token && !tenant.bexio_refresh_token) {
    return { response: json({ error: "Bexio ist nicht verbunden.", error_code: "bexio_not_connected" }, 400) };
  }
  return { tenant };
}

// Token-Refresh wie in bexio-accounts.
export async function getBexioToken(tenant: any): Promise<string> {
  const now = Date.now();
  const expiresAt = tenant.bexio_expires_at ? new Date(tenant.bexio_expires_at).getTime() : 0;
  if (tenant.bexio_access_token && expiresAt - 60_000 > now) {
    return tenant.bexio_access_token;
  }
  if (!tenant.bexio_refresh_token) {
    throw new BexioError(401, "Bexio nicht verbunden.");
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
    throw new BexioError(401, "Bexio-Anmeldung abgelaufen. Bitte Bexio neu verbinden.");
  }
  const tokens = await tokenResp.json();
  await adminClient().from("tenants").update({
    bexio_access_token: tokens.access_token,
    bexio_refresh_token: tokens.refresh_token || tenant.bexio_refresh_token,
    bexio_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", tenant.id);
  return tokens.access_token;
}

// Bexio-Request mit Wiederholung bei Rate-Limit (429).
export async function bexio(token: string, path: string, init: RequestInit = {}): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(BEXIO_API + path, {
      ...init,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    if (resp.status === 429 && attempt < 4) {
      const wait = Number(resp.headers.get("Retry-After")) || attempt + 1;
      await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
      continue;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new BexioError(resp.status, "Bexio " + path + " (" + resp.status + "): " + text.slice(0, 300));
    }
    return resp.json();
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

// Komplette Rechnungsliste, seitenweise. Neueste zuerst, damit bei sehr
// grossen Konten (Abbruch nach LIST_MAX_PAGES) die aktuellen Monate
// sicher dabei sind.
const LIST_PAGE_SIZE = 2000;
const LIST_MAX_PAGES = 10;

export async function listAllInvoices(token: string): Promise<{ invoices: any[]; truncated: boolean }> {
  const invoices: any[] = [];
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const batch = await bexio(
      token,
      "/kb_invoice?order_by=id_desc&limit=" + LIST_PAGE_SIZE + "&offset=" + page * LIST_PAGE_SIZE,
    );
    if (!Array.isArray(batch)) break;
    for (const inv of batch) invoices.push(inv);
    if (batch.length < LIST_PAGE_SIZE) return { invoices, truncated: false };
  }
  return { invoices, truncated: true };
}

// 401/403 von Bexio → verständliche Meldung fürs Dashboard.
export function errorResponse(tag: string, err: unknown): Response {
  console.error("[" + tag + "] error:", err);
  if (err instanceof BexioError && (err.status === 401 || err.status === 403)) {
    return json({
      error: "Bexio verweigert den Zugriff auf die Rechnungen. Bitte Bexio im Dashboard trennen und neu verbinden.",
      error_code: "bexio_scope",
      detail: err.message,
    }, 403);
  }
  return json({ error: String((err as Error).message || err) }, 500);
}
