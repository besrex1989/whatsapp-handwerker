// bexio-recurring-preview Edge Function
//
// Serienrechnungen, Schritt 1: NUR LESEN. Holt alle Rechnungen eines
// Quellmonats aus Bexio und berechnet, wie Titel, Kopf-/Fusstext,
// Positionstexte und Daten für den Zielmonat aussehen würden. In Bexio
// wird nichts angelegt oder verändert.
//
// Request:  POST { tenant_id, source_month: "2026-10", target_month: "2026-11" }
// Response: { source_month, target_month, invoices: [...], summary: {...} }
//
// Auth: gültiges Supabase-User-JWT; die E-Mail im JWT muss zum Tenant
// gehören (gleiches Muster wie stripe-invoices).
//
// Bexio-Scope: GET/Search auf kb_invoice verlangt laut Bexio-Doku
// `kb_invoice_show`. Antwortet Bexio mit 401/403, liefern wir
// `error_code: "bexio_scope"`, damit das Dashboard "Bexio neu verbinden"
// anzeigen kann.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  addDaysIso,
  diffDaysIso,
  lastDayOfMonth,
  type MonthRef,
  parseMonth,
  shiftIsoDate,
  shiftMonthText,
} from "../_shared/month-shift.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

const BEXIO_API = "https://api.bexio.com/2.0";

// Storniert — wird nie als Vorlage verwendet.
const STATUS_CANCELED = 19;
const STATUS_LABELS: Record<number, string> = {
  7: "Entwurf",
  8: "Offen",
  9: "Bezahlt",
  16: "Teilweise bezahlt",
  19: "Storniert",
  31: "Unbezahlt",
};

// Obergrenze pro Aufruf, damit die Function nicht ins Timeout läuft
// (pro Rechnung ein Detail-Request an Bexio).
const MAX_INVOICES = 300;
const DETAIL_CONCURRENCY = 4;

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

class BexioError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Token-Refresh wie in bexio-accounts.
async function getBexioToken(tenant: any): Promise<string> {
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
  await admin.from("tenants").update({
    bexio_access_token: tokens.access_token,
    bexio_refresh_token: tokens.refresh_token || tenant.bexio_refresh_token,
    bexio_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", tenant.id);
  return tokens.access_token;
}

// Bexio-Request mit Wiederholung bei Rate-Limit (429).
async function bexio(token: string, path: string, init: RequestInit = {}): Promise<any> {
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

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

async function listAllInvoices(token: string): Promise<{ invoices: any[]; truncated: boolean }> {
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

function pair(oldValue: string, newValue: string) {
  return { old: oldValue, new: newValue, changed: oldValue !== newValue };
}

function buildPreview(inv: any, contactNames: Map<number, string>, src: MonthRef, dst: MonthRef) {
  const title = pair(inv.title || "", shiftMonthText(inv.title, src, dst));
  const header = pair(inv.header || "", shiftMonthText(inv.header, src, dst));
  const footer = pair(inv.footer || "", shiftMonthText(inv.footer, src, dst));

  const positions = (Array.isArray(inv.positions) ? inv.positions : [])
    .filter((p: any) => typeof p.text === "string" && p.text !== "")
    .map((p: any) => ({
      type: p.type,
      amount: p.amount ?? null,
      unit_price: p.unit_price ?? null,
      position_total: p.position_total ?? null,
      text: pair(p.text, shiftMonthText(p.text, src, dst)),
    }));

  const validFrom = String(inv.is_valid_from || "").slice(0, 10);
  const validTo = String(inv.is_valid_to || "").slice(0, 10);
  const newFrom = validFrom ? shiftIsoDate(validFrom, src, dst) : "";
  // Zahlungsfrist in Tagen bleibt gleich.
  const newTo = validFrom && validTo ? addDaysIso(newFrom, diffDaysIso(validFrom, validTo)) : "";

  const textChanged = title.changed || header.changed || footer.changed ||
    positions.some((p: any) => p.text.changed);

  return {
    id: inv.id,
    document_nr: inv.document_nr || "",
    contact_id: inv.contact_id ?? null,
    contact_name: contactNames.get(inv.contact_id) || ("Kontakt #" + inv.contact_id),
    status_id: inv.kb_item_status_id ?? null,
    status: STATUS_LABELS[inv.kb_item_status_id] || "",
    total: inv.total ?? null,
    currency_id: inv.currency_id ?? null,
    valid_from: { old: validFrom, new: newFrom },
    valid_to: { old: validTo, new: newTo },
    title,
    header,
    footer,
    positions,
    text_changed: textChanged,
  };
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

    // Aufrufer muss angemeldet sein und der Tenant muss ihm gehören.
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userResp } = await userClient.auth.getUser();
    const user = userResp?.user;
    if (!user || !user.email) return json({ error: "Nicht angemeldet." }, 401);

    const { data: tenant } = await admin
      .from("tenants")
      .select("id, email, bexio_access_token, bexio_refresh_token, bexio_expires_at")
      .eq("id", tenant_id)
      .maybeSingle();
    if (!tenant) return json({ error: "Tenant nicht gefunden." }, 404);
    if (String(tenant.email || "").toLowerCase() !== user.email.toLowerCase()) {
      return json({ error: "Zugriff verweigert." }, 403);
    }
    if (!tenant.bexio_access_token && !tenant.bexio_refresh_token) {
      return json({ error: "Bexio ist nicht verbunden.", error_code: "bexio_not_connected" }, 400);
    }

    const token = await getBexioToken(tenant);

    const from = `${src.year}-${String(src.month).padStart(2, "0")}-01`;
    const to = `${src.year}-${String(src.month).padStart(2, "0")}-${String(lastDayOfMonth(src)).padStart(2, "0")}`;

    // Zwei Quellen, vereinigt über die Rechnungs-ID:
    //   1. Suche mit Datumsfilter (schnell)
    //   2. komplette Rechnungsliste, seitenweise (vollständig)
    // Grund: Die Suche allein hat in der Praxis nicht alle Rechnungen des
    // Monats geliefert (37 statt 46). Die Liste ist die verlässliche Quelle;
    // der Monat wird danach lokal gefiltert.
    const inMonth = (inv: any) => {
      const d = String(inv.is_valid_from || "").slice(0, 10);
      return d >= from && d <= to;
    };

    const [searchResult, listResult] = await Promise.all([
      bexio(token, "/kb_invoice/search?limit=2000&order_by=id", {
        method: "POST",
        body: JSON.stringify([
          { field: "is_valid_from", value: from, criteria: ">=" },
          { field: "is_valid_from", value: to, criteria: "<=" },
        ]),
      }).catch((err) => {
        // 401/403 betrifft auch die Liste → dort wird der Fehler gemeldet.
        console.error("[bexio-recurring-preview] search failed:", err);
        return [];
      }),
      listAllInvoices(token),
    ]);

    const fromSearch = (Array.isArray(searchResult) ? searchResult : []).filter(inMonth);
    const fromList = listResult.invoices.filter(inMonth);

    const byId = new Map<number, any>();
    for (const inv of fromList) byId.set(inv.id, inv);
    for (const inv of fromSearch) if (!byId.has(inv.id)) byId.set(inv.id, inv);
    const all = Array.from(byId.values()).sort((a: any, b: any) => a.id - b.id);

    // Diagnose: Abweichungen zwischen Suche und Liste ins Log.
    const searchIds = new Set(fromSearch.map((inv: any) => inv.id));
    const listIds = new Set(fromList.map((inv: any) => inv.id));
    const onlyInList = fromList.filter((inv: any) => !searchIds.has(inv.id));
    const onlyInSearch = fromSearch.filter((inv: any) => !listIds.has(inv.id));
    console.log("[bexio-recurring-preview] " + JSON.stringify({
      month: source_month,
      list_total: listResult.invoices.length,
      list_pages_truncated: listResult.truncated,
      in_month_list: fromList.length,
      in_month_search: fromSearch.length,
      only_in_list: onlyInList.map((inv: any) => ({
        nr: inv.document_nr, date: inv.is_valid_from, status: inv.kb_item_status_id,
      })),
      only_in_search: onlyInSearch.map((inv: any) => ({
        nr: inv.document_nr, date: inv.is_valid_from, status: inv.kb_item_status_id,
      })),
    }));

    const canceled = all.filter((inv: any) => inv.kb_item_status_id === STATUS_CANCELED).length;
    const usable = all.filter((inv: any) => inv.kb_item_status_id !== STATUS_CANCELED);
    const truncated = usable.length > MAX_INVOICES || listResult.truncated;
    const selected = usable.slice(0, MAX_INVOICES);

    // Die Suche liefert keine Positionen → Detail pro Rechnung nachladen.
    const [details, contactNames] = await Promise.all([
      mapLimit(selected, DETAIL_CONCURRENCY, (inv: any) => bexio(token, "/kb_invoice/" + inv.id)),
      loadContactNames(token),
    ]);

    const invoices = details
      .map((inv: any) => buildPreview(inv, contactNames, src, dst))
      .sort((a: any, b: any) =>
        a.contact_name.localeCompare(b.contact_name, "de") ||
        String(a.document_nr).localeCompare(String(b.document_nr), "de", { numeric: true })
      );

    // Abgleich fürs Dashboard: Was hat Bexio über die Schnittstelle
    // insgesamt geliefert, und welche Rechnungen liegen laut Schnittstelle
    // NICHT im Quellmonat? Damit lässt sich klären, warum eine Rechnung
    // fehlt, die in Bexio sichtbar ist.
    const byMonth: Record<string, number> = {};
    for (const inv of listResult.invoices) {
      const key = String(inv.is_valid_from || "").slice(0, 7) || "ohne Datum";
      byMonth[key] = (byMonth[key] || 0) + 1;
    }
    const outside = listResult.invoices
      .filter((inv: any) => !inMonth(inv))
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
      source_month,
      target_month,
      invoices,
      diagnostics: {
        list_total: listResult.invoices.length,
        list_truncated: listResult.truncated,
        in_month_list: fromList.length,
        in_month_search: fromSearch.length,
        by_month: byMonth,
        outside,
      },
      summary: {
        total: invoices.length,
        text_changed: invoices.filter((i: any) => i.text_changed).length,
        text_unchanged: invoices.filter((i: any) => !i.text_changed).length,
        canceled_skipped: canceled,
        found_by_list: fromList.length,
        found_by_search: fromSearch.length,
        truncated,
      },
    }, 200);
  } catch (err) {
    console.error("[bexio-recurring-preview] error:", err);
    if (err instanceof BexioError && (err.status === 401 || err.status === 403)) {
      return json({
        error: "Bexio verweigert das Lesen der Rechnungen. Bitte Bexio im Dashboard trennen und neu verbinden.",
        error_code: "bexio_scope",
        detail: err.message,
      }, 403);
    }
    return json({ error: String((err as Error).message || err) }, 500);
  }
});

function json(obj: any, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
