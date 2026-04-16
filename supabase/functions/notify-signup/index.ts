// Fires an admin notification whenever a new row is inserted into
// public.tenants. Wired up via a Supabase Database Webhook (configured
// once in the Dashboard → Database → Webhooks; see the setup instructions
// in the PR description).
//
// Payload shape (Supabase Database Webhook default):
//   { type: "INSERT", table: "tenants", schema: "public",
//     record: { ...new row... }, old_record: null }
//
// Auth: this Edge Function is public (deployed with --no-verify-jwt like
// all our functions). The webhook configures a shared secret in a custom
// HTTP header which we validate here. Without a matching secret, the
// request is rejected so random callers can't spam the inbox.

import { sendEmail } from "../_shared/resend.ts";

const WEBHOOK_SECRET = Deno.env.get("NOTIFY_SIGNUP_SECRET") || "";
const ADMIN_EMAIL = Deno.env.get("ADMIN_NOTIFY_EMAIL") || "info@whatsbill.ch";
const FROM_ADDRESS = Deno.env.get("NOTIFY_FROM_ADDRESS")
  || "WhatsBill <noreply@whatsbill.ch>";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Shared-secret check. The Supabase DB webhook lets you add a custom
  // header — we look for x-webhook-secret.
  const incoming = req.headers.get("x-webhook-secret") || "";
  if (!WEBHOOK_SECRET) {
    console.error("[notify-signup] NOTIFY_SIGNUP_SECRET env var not set");
    return new Response("Server misconfigured", { status: 500 });
  }
  if (incoming !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // We only care about INSERTs on tenants. If the webhook is
    // misconfigured (wrong table or event) we silently no-op with 200
    // so Supabase doesn't flag the webhook as failing.
    if (body.type !== "INSERT" || body.table !== "tenants") {
      return new Response("ignored", { status: 200 });
    }

    const t = body.record || {};
    const name = t.full_name || "—";
    const email = t.email || "—";
    const whatsapp = t.whatsapp_number || "—";
    const plan = t.plan || "trial";
    const trialEnd = t.trial_ends_at
      ? new Date(t.trial_ends_at).toLocaleDateString("de-CH")
      : "—";

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeWhatsapp = escapeHtml(whatsapp);
    const safePlan = escapeHtml(plan);
    const safeTrialEnd = escapeHtml(trialEnd);

    await sendEmail({
      from: FROM_ADDRESS,
      to: ADMIN_EMAIL,
      subject: `Neuer WhatsBill-Kunde: ${name}`,
      html: `
        <div style="font-family: -apple-system, Segoe UI, Helvetica, sans-serif;
                    max-width: 520px; color: #111;">
          <h2 style="margin-bottom: 6px;">Neue Registrierung</h2>
          <p style="color:#555; margin-top:0;">
            Gerade hat sich jemand auf <a href="https://whatsbill.ch">whatsbill.ch</a>
            registriert.
          </p>
          <table cellpadding="6" style="border-collapse: collapse; margin-top: 12px;">
            <tr><td><strong>Name</strong></td><td>${safeName}</td></tr>
            <tr><td><strong>E-Mail</strong></td><td>${safeEmail}</td></tr>
            <tr><td><strong>WhatsApp</strong></td><td>${safeWhatsapp}</td></tr>
            <tr><td><strong>Plan</strong></td><td>${safePlan}</td></tr>
            <tr><td><strong>Trial endet</strong></td><td>${safeTrialEnd}</td></tr>
          </table>
          <p style="color:#888; font-size:12px; margin-top:24px;">
            Diese Mail kommt automatisch von Supabase → notify-signup Edge
            Function. Empfänger steuerst du via ADMIN_NOTIFY_EMAIL env var.
          </p>
        </div>
      `,
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[notify-signup] Error:", err);
    return new Response(
      "Error: " + ((err as Error).message || String(err)),
      { status: 500 },
    );
  }
});

function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
