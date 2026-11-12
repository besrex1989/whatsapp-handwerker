// Lists the tenant's Stripe invoices so the dashboard can show them
// directly without bouncing the user through the billing portal.
//
// Request:  POST { tenant_id }
// Response: { invoices: [{ id, number, created, amount_paid, currency,
//                           status, hosted_invoice_url, invoice_pdf }] }
//
// Auth: requires a valid Supabase user JWT; the JWT's email must match
// the tenant row.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireTenantOwner } from "../_shared/tenant-auth.ts";
import Stripe from "https://esm.sh/stripe@18.5.0?target=denonext";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

// Fetch http client — see stripe-webhook for context on why the node
// http client breaks on Supabase Edge Runtime (Deno 2.x).
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id } = body;
    if (!tenant_id) return jsonError("tenant_id ist erforderlich", 400);

    // Aufrufer muss angemeldet sein und der Tenant muss ihm gehören
    // (E-Mail-Vergleich ohne Gross-/Kleinschreibung).
    const auth = await requireTenantOwner(req, tenant_id, "id, email, stripe_customer_id");
    if ("response" in auth) return auth.response;
    const tenant = auth.tenant;
    if (!tenant.stripe_customer_id) {
      return new Response(JSON.stringify({ invoices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    const list = await stripe.invoices.list({
      customer: tenant.stripe_customer_id,
      limit: 20,
    });

    const invoices = list.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      created: inv.created,
      amount_paid: inv.amount_paid,
      amount_due: inv.amount_due,
      currency: inv.currency,
      status: inv.status,
      hosted_invoice_url: inv.hosted_invoice_url,
      invoice_pdf: inv.invoice_pdf,
    }));

    return new Response(JSON.stringify({ invoices }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err) {
    console.error("[stripe-invoices] Error:", err);
    // Die gespeicherte Stripe-Kundennummer existiert im verwendeten
    // Stripe-Konto nicht (z. B. im Testmodus angelegt, Function läuft live,
    // oder Kunde in Stripe gelöscht). Verständliche Meldung statt des
    // internen Stripe-Texts mit Kundennummer.
    if (isMissingStripeCustomer(err)) {
      return jsonError(
        "Zu diesem Konto wurden bei Stripe keine Abo-Daten gefunden. "
          + "Bitte melde dich beim Support (info@whatsbill.ch).",
        404,
      );
    }
    return jsonError("Interner Fehler: " + (err?.message || String(err)), 500);
  }
});

function isMissingStripeCustomer(err: unknown): boolean {
  const e = err as { code?: string; param?: string; message?: string } | null;
  return e?.code === "resource_missing"
    && (e?.param === "customer" || /no such customer/i.test(e?.message || ""));
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
