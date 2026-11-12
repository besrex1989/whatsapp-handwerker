// bexio-recurring-create Edge Function
//
// Serienrechnungen, Schritt 2: SCHREIBT IN BEXIO. Legt für die gewählten
// Vorlage-Rechnungen je eine neue Rechnung als ENTWURF für den Zielmonat
// an (Texte und Daten verschoben, alles andere übernommen). Gestellt und
// versendet wird nichts — das macht der User in Bexio.
//
// Request:  POST { tenant_id, source_from, source_to, target_month, invoice_ids: [..] }
//           Zeitraum und Zielmonat wie bei bexio-recurring-preview.
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
  ExistingCopies,
  isInRange,
  monthsFor,
  parseSeriesRequest,
  planNewInvoice,
  type PositionStep,
  STATUS_CANCELED,
  totalsMatch,
} from "../_shared/recurring-invoice.ts";

const MAX_PER_CALL = 10;

// Legt die Positionen der Reihe nach an und liefert die fertige Rechnung
// (mit Total) zurück. Gruppen-Kinder bekommen die NEUE ID ihres Containers.
async function addPositions(token: string, invoiceId: number, steps: PositionStep[]): Promise<any> {
  const newIds = new Map<number, number>();
  for (const step of steps) {
    const body: Record<string, unknown> = { ...step.body };
    if (step.parentOldId !== null) {
      const parentNew = newIds.get(step.parentOldId);
      if (!parentNew) throw new Error("Gruppe für eine Position wurde nicht angelegt.");
      body.parent_id = parentNew;
    }
    const pos = await bexio(token, "/kb_invoice/" + invoiceId + "/" + step.endpoint, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (step.oldId !== null && pos && pos.id) newIds.set(step.oldId, pos.id);
  }
  return await bexio(token, "/kb_invoice/" + invoiceId);
}

async function deleteDraft(token: string, invoiceId: number): Promise<boolean> {
  try {
    await bexio(token, "/kb_invoice/" + invoiceId, { method: "DELETE" });
    return true;
  } catch (err) {
    console.error("[bexio-recurring-create] cleanup of draft " + invoiceId + " failed:", err);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id } = body;
    if (!tenant_id) return json({ error: "tenant_id ist erforderlich" }, 400);

    const range = parseSeriesRequest(body);
    if ("error" in range) return json({ error: range.error }, 400);

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

    // Aktueller Stand in Bexio: Welche Kopien gibt es schon?
    const listResult = await listAllInvoices(token);
    if (listResult.truncated) {
      // Ohne vollständige Liste ist der Doppel-Schutz nicht verlässlich.
      return json({
        error: "Das Bexio-Konto hat zu viele Rechnungen für die Doppel-Prüfung. Bitte Support kontaktieren.",
      }, 400);
    }
    const existing = new ExistingCopies(listResult.invoices);
    // Vorlage-ID → Rechnungsdatum, um den Zielmonat ohne Detail-Abruf zu kennen.
    const listed = new Map<number, any>(listResult.invoices.map((inv: any) => [inv.id, inv]));

    // Nacheinander, nicht parallel: schont das Bexio-Rate-Limit und hält
    // die Reihenfolge der Rechnungsnummern stabil.
    const results: any[] = [];
    for (const id of ids) {
      try {
        const listedSource = listed.get(id);
        const listedMonths = listedSource ? monthsFor(listedSource, range) : null;
        const copy = listedMonths ? existing.get(id, listedMonths.dst) : null;
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
        const months = monthsFor(source, range);
        if (!months || !isInRange(source, range)) {
          throw new Error("Vorlage liegt nicht im gewählten Zeitraum.");
        }
        // Das Datum kann sich seit dem Listenabruf geändert haben → nochmals prüfen.
        const lateCopy = existing.get(id, months.dst);
        if (lateCopy) {
          results.push({
            source_id: id,
            status: "exists",
            new_id: lateCopy.id,
            new_document_nr: lateCopy.document_nr || "",
          });
          continue;
        }
        if (source.kb_item_status_id === STATUS_CANCELED) {
          throw new Error("Vorlage ist storniert.");
        }

        const plan = planNewInvoice(source, months.src, months.dst);
        let created = await bexio(token, "/kb_invoice", {
          method: "POST",
          body: JSON.stringify(plan.payload),
        });

        if (plan.steps.length > 0) {
          // Rechnung mit Gruppen: Positionen einzeln anlegen. Scheitert ein
          // Schritt, wird der unvollständige Entwurf wieder gelöscht.
          try {
            created = await addPositions(token, created.id, plan.steps);
          } catch (stepErr) {
            const cleaned = await deleteDraft(token, created.id);
            throw new Error(
              String((stepErr as Error).message || stepErr) +
                (cleaned
                  ? ""
                  : " – ACHTUNG: unvollständiger Entwurf " + (created.document_nr || created.id) +
                    " konnte nicht gelöscht werden, bitte in Bexio löschen."),
            );
          }
        }

        // Für weitere IDs im selben Aufruf merken.
        existing.add(id, months.dst, created);

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
      source_from: range.from,
      source_to: range.to,
      delta_months: range.delta,
      created: results.filter((r) => r.status === "created").length,
      exists: results.filter((r) => r.status === "exists").length,
      errors: results.filter((r) => r.status === "error").length,
    }));

    return json({ results }, 200);
  } catch (err) {
    return errorResponse("bexio-recurring-create", err);
  }
});
