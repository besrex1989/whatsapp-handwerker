// bexio-recurring-create Edge Function
//
// Serienrechnungen, Schritt 2: SCHREIBT IN BEXIO. Legt für die gewählten
// Vorlage-Rechnungen je eine neue Rechnung als ENTWURF für den Zielmonat
// an (Texte und Daten verschoben, alles andere übernommen). Gestellt und
// versendet wird nichts — das macht der User in Bexio.
//
// Request:  POST { tenant_id, source_month, target_month, invoice_ids: [..] }
//           Höchstens MAX_PER_CALL IDs; das Dashboard ruft in Paketen auf
//           und zeigt den Fortschritt.
// Response: { results: [{ source_id, status, ... }] }
//           status: "created" | "exists" | "error"
//
// Schutz gegen Doppel-Erstellung: Jede neue Rechnung trägt in
// `api_reference` die Vorlage-ID und den Zielmonat. Vor dem Erstellen
// wird die Rechnungsliste geprüft; gibt es die Kopie schon (und ist sie
// nicht storniert), wird nicht nochmals erstellt.
//
// Die Texte werden hier neu berechnet — vom Dashboard kommen nur IDs.
//
// Auth: gültiges Supabase-User-JWT; die E-Mail im JWT muss zum Tenant
// gehören.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { parseMonth } from "../_shared/month-shift.ts";
import {
  authorizeTenant,
  bexio,
  CORS_HEADERS,
  errorResponse,
  getBexioToken,
  json,
  listAllInvoices,
} from "../_shared/bexio-recurring.ts";
import {
  buildNewInvoicePayload,
  findExistingCopies,
  isInMonth,
  STATUS_CANCELED,
  totalsMatch,
} from "../_shared/recurring-invoice.ts";

const MAX_PER_CALL = 10;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, source_month, target_month } = body;
    if (!tenant_id) return json({ error: "tenant_id ist erforderlich" }, 400);

    const src = parseMonth(source_month);
    const dst = parseMonth(target_month);
    if (!src || !dst) {
      return json({ error: "source_month und target_month im Format JJJJ-MM angeben." }, 400);
    }
    if (src.year === dst.year && src.month === dst.month) {
      return json({ error: "Quell- und Zielmonat müssen verschieden sein." }, 400);
    }

    const rawIds = Array.isArray(body.invoice_ids) ? body.invoice_ids : [];
    const ids: number[] = Array.from(new Set(rawIds.map((v: unknown) => Number(v))));
    if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      return json({ error: "invoice_ids muss eine Liste von Rechnungs-IDs sein." }, 400);
    }
    if (ids.length > MAX_PER_CALL) {
      return json({ error: "Höchstens " + MAX_PER_CALL + " Rechnungen pro Aufruf." }, 400);
    }

    const auth = await authorizeTenant(req, tenant_id);
    if ("response" in auth) return auth.response;
    const token = await getBexioToken(auth.tenant);

    // Aktueller Stand in Bexio: Welche Kopien gibt es für den Zielmonat schon?
    const listResult = await listAllInvoices(token);
    if (listResult.truncated) {
      // Ohne vollständige Liste ist der Doppel-Schutz nicht verlässlich.
      return json({
        error: "Das Bexio-Konto hat zu viele Rechnungen für die Doppel-Prüfung. Bitte Support kontaktieren.",
      }, 400);
    }
    const existing = findExistingCopies(listResult.invoices, dst);

    // Nacheinander, nicht parallel: schont das Bexio-Rate-Limit und hält
    // die Reihenfolge der Rechnungsnummern stabil.
    const results: any[] = [];
    for (const id of ids) {
      try {
        const copy = existing.get(id);
        if (copy) {
          results.push({
            source_id: id,
            status: "exists",
            new_id: copy.id,
            new_document_nr: copy.document_nr || "",
          });
          continue;
        }

        const source = await bexio(token, "/kb_invoice/" + id);
        if (!isInMonth(source, src)) {
          throw new Error("Vorlage liegt nicht im gewählten Vorlagemonat.");
        }
        if (source.kb_item_status_id === STATUS_CANCELED) {
          throw new Error("Vorlage ist storniert.");
        }

        const payload = buildNewInvoicePayload(source, src, dst);
        const created = await bexio(token, "/kb_invoice", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        // Für weitere IDs im selben Aufruf merken.
        existing.set(id, created);

        results.push({
          source_id: id,
          status: "created",
          new_id: created.id,
          new_document_nr: created.document_nr || "",
          new_total: created.total ?? null,
          source_total: source.total ?? null,
          total_matches: totalsMatch(created.total, source.total),
        });
      } catch (err) {
        console.error("[bexio-recurring-create] invoice " + id + " failed:", err);
        results.push({
          source_id: id,
          status: "error",
          error: String((err as Error).message || err),
        });
      }
    }

    console.log("[bexio-recurring-create] " + JSON.stringify({
      tenant: tenant_id,
      source_month,
      target_month,
      created: results.filter((r) => r.status === "created").length,
      exists: results.filter((r) => r.status === "exists").length,
      errors: results.filter((r) => r.status === "error").length,
    }));

    return json({ source_month, target_month, results }, 200);
  } catch (err) {
    return errorResponse("bexio-recurring-create", err);
  }
});
