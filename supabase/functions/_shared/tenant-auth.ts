// tenant-auth — prüft, dass der Aufrufer angemeldet ist und der Tenant ihm
// gehört.
//
// Hintergrund: Alle Edge Functions werden mit --no-verify-jwt deployt
// (siehe deploy-functions.yml), sind also ohne Token erreichbar. Jede
// Function, die eine tenant_id entgegennimmt, MUSS deshalb selbst prüfen,
// wem der Tenant gehört — sonst kann jeder, der eine Tenant-ID kennt,
// fremde Daten lesen oder ändern.
//
// Verwendung:
//   const auth = await requireTenantOwner(req, tenantId);
//   if ("response" in auth) return auth.response;
//   const tenant = auth.tenant;

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function deny(message: string, status: number): { response: Response } {
  return {
    response: new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    }),
  };
}

export async function requireTenantOwner(
  req: Request,
  tenantId: unknown,
  columns = "*",
): Promise<{ tenant: any; user: any } | { response: Response }> {
  if (typeof tenantId !== "string" || tenantId === "") {
    return deny("tenant_id ist erforderlich.", 400);
  }

  // Wer ruft auf? Das User-JWT kommt im Authorization-Header. Mit dem
  // anon-Key (kein eingeloggter User) liefert getUser() nichts.
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userResp } = await userClient.auth.getUser();
  const user = userResp?.user;
  if (!user || !user.email) return deny("Nicht angemeldet.", 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: tenant } = await admin
    .from("tenants")
    .select(columns)
    .eq("id", tenantId)
    .maybeSingle();

  // Unbekannte und fremde Tenants gleich beantworten, damit sich gültige
  // Tenant-IDs nicht durch Ausprobieren finden lassen.
  // E-Mails case-insensitiv vergleichen (historisch gemischte Schreibweise).
  if (!tenant || String((tenant as any).email || "").toLowerCase() !== user.email.toLowerCase()) {
    return deny("Zugriff verweigert.", 403);
  }
  return { tenant, user };
}
