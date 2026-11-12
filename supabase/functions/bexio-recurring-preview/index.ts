// bexio-recurring-preview Edge Function
//
// Serienrechnungen, Schritt 1: NUR LESEN. Holt alle Rechnungen eines
// Quellmonats aus Bexio und berechnet, wie Titel, Kopf-/Fusstext,
// Positionstexte und Daten für den Zielmonat aussehen würden. In Bexio
// wird nichts angelegt oder verändert. Das Erstellen macht
// bexio-recurring-create.
//
// Request:  POST { tenant_id, source_from: "2026-10-01", source_to: "2026-12-31",
//                  target_month: "2027-01" }
//           target_month gilt für den ersten Monat des Zeitraums; die
//           übrigen Monate werden um gleich viele Monate verschoben.
//           (Alte Form { source_month } wird weiterhin akzeptiert.)
// Response: { source_from, source_to, target_month, delta_months,
//             invoices: [...], summary, diagnostics }
//
// Auth: gültiges Supabase-User-JWT; die E-Mail im JWT muss zum Tenant
// gehören (gleiches Muster wie stripe-invoices).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeTenant,
  bexio,
  CORS_HEADERS,
  errorResponse,
  getBexioToken,
  json,
  listAllInvoices,
  mapLimit,
} from "../_shared/bexio-recurring.ts";
import {
  buildPreview,
  ExistingCopies,
  isInRange,
  monthsFor,
  parseSeriesRequest,
  STATUS_CANCELED,
  STATUS_LABELS,
} from "../_shared/recurring-invoice.ts";

// Obergrenze pro Aufruf, damit die Function nicht ins Timeout läuft
// (pro Rechnung ein Detail-Request an Bexio).
const MAX_INVOICES = 300;
const DETAIL_CONCURRENCY = 4;

// Kontakt-ID → Anzeigename. Scheitert der Abruf, zeigen wir "Kontakt #id".
async function loadContactNames(token: string): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  try {
    for (let offset = 0; offset < 20000; offset += 2000) {
      const page = await bexio(token, "/contact?limit=2000&offset=" + offset);
      if (!Array.isArray(page)) break;
      for (const c of page) {
        // Firma: name_1 = Firmenname. Person: name_1 = Nachname, name_2 = Vorname.
        const name = c.contact_type_id === 2
          ? [c.name_2, c.name_1].filter(Boolean).join(" ")
          : [c.name_1, c.name_2].filter(Boolean).join(" ");
        names.set(c.id, name || ("Kontakt #" + c.id));
      }
      if (page.length < 2000) break;
    }
  } catch (err) {
    console.error("[bexio-recurring-preview] contacts failed:", err);
  }
  return names;
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

    const auth = await authorizeTenant(req, tenant_id);
    if ("response" in auth) return auth.response;
    const token = await getBexioToken(auth.tenant);

    // Die komplette Rechnungsliste ist die Quelle; der Zeitraum wird lokal
    // gefiltert. Sie liefert zugleich die bereits erstellten Kopien
    // (api_reference).
    const [listResult, contactNames] = await Promise.all([
      listAllInvoices(token),
      loadContactNames(token),
    ]);

    const all = listResult.invoices
      .filter((inv: any) => isInRange(inv, range) && monthsFor(inv, range) !== null)
      .sort((a: any, b: any) => a.id - b.id);
    const canceled = all.filter((inv: any) => inv.kb_item_status_id === STATUS_CANCELED).length;
    const usable = all.filter((inv: any) => inv.kb_item_status_id !== STATUS_CANCELED);
    const truncated = usable.length > MAX_INVOICES || listResult.truncated;
    const selected = usable.slice(0, MAX_INVOICES);

    const existing = new ExistingCopies(listResult.invoices);

    // Die Liste liefert keine Positionen → Detail pro Rechnung nachladen.
    const details = await mapLimit(
      selected,
      DETAIL_CONCURRENCY,
      (inv: any) => bexio(token, "/kb_invoice/" + inv.id),
    );

    const invoices = details
      .map((inv: any) => {
        const months = monthsFor(inv, range)!;
        return buildPreview(
          inv,
          contactNames.get(inv.contact_id) || ("Kontakt #" + inv.contact_id),
          months.src,
          months.dst,
          existing.get(inv.id, months.dst),
        );
      })
      .sort((a: any, b: any) =>
        a.source_month.localeCompare(b.source_month) ||
        a.contact_name.localeCompare(b.contact_name, "de") ||
        String(a.document_nr).localeCompare(String(b.document_nr), "de", { numeric: true })
      );

    // Abgleich fürs Dashboard: Was hat Bexio über die Schnittstelle
    // insgesamt geliefert, und welche Rechnungen liegen laut Schnittstelle
    // NICHT im gewählten Zeitraum?
    const byMonth: Record<string, number> = {};
    for (const inv of listResult.invoices) {
      const key = String(inv.is_valid_from || "").slice(0, 7) || "ohne Datum";
      byMonth[key] = (byMonth[key] || 0) + 1;
    }
    const outside = listResult.invoices
      .filter((inv: any) => !isInRange(inv, range))
      .sort((a: any, b: any) => String(b.is_valid_from || "").localeCompare(String(a.is_valid_from || "")))
      .slice(0, 200)
      .map((inv: any) => ({
        document_nr: inv.document_nr || "",
        date: String(inv.is_valid_from || "").slice(0, 10),
        status: STATUS_LABELS[inv.kb_item_status_id] || String(inv.kb_item_status_id ?? ""),
        title: inv.title || "",
        total: inv.total ?? null,
      }));

    return json({
      source_from: range.from,
      source_to: range.to,
      target_month: body.target_month,
      delta_months: range.delta,
      invoices,
      diagnostics: {
        list_total: listResult.invoices.length,
        list_truncated: listResult.truncated,
        in_month_list: all.length,
        by_month: byMonth,
        outside,
      },
      summary: {
        total: invoices.length,
        text_changed: invoices.filter((i: any) => i.text_changed).length,
        text_unchanged: invoices.filter((i: any) => !i.text_changed).length,
        already_created: invoices.filter((i: any) => i.already_created).length,
        canceled_skipped: canceled,
        truncated,
      },
    }, 200);
  } catch (err) {
    return errorResponse("bexio-recurring-preview", err);
  }
});
