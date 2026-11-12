// tenant-auth — prüft, dass der Aufrufer angemeldet ist und der Tenant ihm
// gehört. Nötig, weil alle Functions mit --no-verify-jwt deployed werden:
// ohne diese Prüfung ist eine Function für jeden im Internet aufrufbar.
//
// Verwendung:
//   const auth = await requireTenantOwner(req, tenant_id, "id, email");
//   if ("response" in auth) return auth.response;
//   auth.tenant / auth.user

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deny(error: string, status: number): { response: Response } {
  return {
    response: new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    }),
  };
}

// `columns` muss `email` enthalten (wird für den Besitz-Vergleich gebraucht).
export async function requireTenantOwner(
  req: Request,
  tenantId: unknown,
  columns = "id, email",
): Promise<{ tenant: any; user: { id: string; email: string } } | { response: Response }> {
  const authHeader = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+/i.test(authHeader)) return deny("Nicht angemeldet.", 401);

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userResp } = await userClient.auth.getUser();
  const user = userResp?.user;
  if (!user || !user.email) return deny("Nicht angemeldet.", 401);

  if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) {
    return deny("Tenant nicht gefunden.", 404);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: tenant, error } = await admin
    .from("tenants")
    .select(columns)
    .eq("id", tenantId)
    .maybeSingle();
  if (error) {
    console.error("[tenant-auth] tenant lookup failed:", error.message);
    return deny("Tenant-Abfrage fehlgeschlagen.", 500);
  }
  // Fremder und unbekannter Tenant sehen gleich aus, damit sich darüber
  // keine Tenant-IDs erraten lassen.
  if (!tenant || String((tenant as any).email || "").toLowerCase() !== user.email.toLowerCase()) {
    return deny("Zugriff verweigert.", 403);
  }
  return { tenant, user: { id: user.id, email: user.email } };
}
