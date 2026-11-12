// recurring-invoice — reine Logik für Serienrechnungen (keine Deno-APIs,
// läuft auch im Node-Test).
//
// - Vorschau einer Rechnung für den Zielmonat (alt/neu)
// - Payload für die neue Rechnung in Bexio (POST /kb_invoice)
// - Kennzeichnung über `api_reference`, damit dieselbe Vorlage für
//   denselben Zielmonat nicht zweimal erstellt wird

import {
  addDaysIso,
  addMonths,
  diffDaysIso,
  lastDayOfMonth,
  monthDelta,
  monthOfIso,
  type MonthRef,
  parseMonth,
  shiftIsoDate,
  shiftMonthText,
} from "./month-shift.ts";

export const STATUS_DRAFT = 7;
export const STATUS_CANCELED = 19;
export const STATUS_LABELS: Record<number, string> = {
  7: "Entwurf",
  8: "Offen",
  9: "Bezahlt",
  16: "Teilweise bezahlt",
  19: "Storniert",
  31: "Unbezahlt",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function monthKey(ref: MonthRef): string {
  return `${ref.year}-${pad2(ref.month)}`;
}

export function monthRange(ref: MonthRef): { from: string; to: string } {
  return {
    from: `${ref.year}-${pad2(ref.month)}-01`,
    to: `${ref.year}-${pad2(ref.month)}-${pad2(lastDayOfMonth(ref))}`,
  };
}

// ---------- Zeitraum ----------
//
// Vorlagen kommen aus einem frei wählbaren Zeitraum (Rechnungsdatum
// von/bis). `target_month` ist der Zielmonat für den ERSTEN Monat des
// Zeitraums; daraus ergibt sich die Verschiebung in Monaten, die für
// jede Rechnung auf ihren eigenen Monat angewendet wird:
//   Zeitraum 01.10.–31.12.2026, Ziel Januar 2027 (= +3 Monate)
//   → Oktober → Januar, November → Februar, Dezember → März

export interface SeriesRange {
  from: string; // JJJJ-MM-TT
  to: string; // JJJJ-MM-TT
  delta: number; // Verschiebung in Monaten
  target: MonthRef;
}

const MAX_RANGE_DAYS = 366 * 2;

function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Liest den Zeitraum aus dem Request. Akzeptiert weiterhin die alte Form
// { source_month } (ein ganzer Monat).
export function parseSeriesRequest(body: any): SeriesRange | { error: string } {
  let from = body?.source_from;
  let to = body?.source_to;
  if (!from && !to && body?.source_month) {
    const m = parseMonth(body.source_month);
    if (!m) return { error: "source_month im Format JJJJ-MM angeben." };
    ({ from, to } = monthRange(m));
  }
  if (!isIsoDate(from) || !isIsoDate(to)) {
    return { error: "source_from und source_to im Format JJJJ-MM-TT angeben." };
  }
  if (from > to) return { error: "Das Von-Datum liegt nach dem Bis-Datum." };
  if (diffDaysIso(from, to) > MAX_RANGE_DAYS) {
    return { error: "Der Zeitraum darf höchstens zwei Jahre umfassen." };
  }
  const target = parseMonth(body?.target_month);
  if (!target) return { error: "target_month im Format JJJJ-MM angeben." };
  const first = monthOfIso(from);
  if (!first) return { error: "source_from ist ungültig." };
  const delta = monthDelta(first, target);
  if (delta === 0) {
    return { error: "Der Zielmonat muss sich vom ersten Monat des Zeitraums unterscheiden." };
  }
  return { from, to, delta, target };
}

export function isInRange(inv: any, range: SeriesRange): boolean {
  const d = String(inv.is_valid_from || "").slice(0, 10);
  return d >= range.from && d <= range.to;
}

// Quell- und Zielmonat einer einzelnen Rechnung.
export function monthsFor(inv: any, range: SeriesRange): { src: MonthRef; dst: MonthRef } | null {
  const src = monthOfIso(inv.is_valid_from);
  if (!src) return null;
  return { src, dst: addMonths(src, range.delta) };
}

// ---------- Kennzeichnung ----------
//
// Bexio-Feld `api_reference` ist nur über die API les- und schreibbar.
// Format: whatsbill-serie:<Vorlage-ID>:<Zielmonat JJJJ-MM>

const REF_PREFIX = "whatsbill-serie:";

export function seriesReference(sourceInvoiceId: number, target: MonthRef): string {
  return REF_PREFIX + sourceInvoiceId + ":" + monthKey(target);
}

export function parseSeriesReference(ref: unknown): { sourceId: number; month: string } | null {
  const m = /^whatsbill-serie:(\d+):(\d{4}-\d{2})$/.exec(String(ref || ""));
  if (!m) return null;
  return { sourceId: Number(m[1]), month: m[2] };
}

// Bereits erstellte Kopien, nachschlagbar über Vorlage-ID + Zielmonat.
// Stornierte Kopien zählen nicht (dann darf neu erstellt werden); in
// Bexio gelöschte Entwürfe tauchen in der Liste gar nicht mehr auf.
export class ExistingCopies {
  private map = new Map<string, any>();

  constructor(allInvoices: any[]) {
    for (const inv of allInvoices) {
      const ref = parseSeriesReference(inv.api_reference);
      if (!ref) continue;
      if (inv.kb_item_status_id === STATUS_CANCELED) continue;
      this.map.set(ref.sourceId + ":" + ref.month, inv);
    }
  }

  get(sourceId: number, target: MonthRef): any | null {
    return this.map.get(sourceId + ":" + monthKey(target)) || null;
  }

  add(sourceId: number, target: MonthRef, copy: any) {
    this.map.set(sourceId + ":" + monthKey(target), copy);
  }
}

// ---------- Daten ----------

export function shiftedDates(inv: any, src: MonthRef, dst: MonthRef) {
  const validFrom = String(inv.is_valid_from || "").slice(0, 10);
  const validTo = String(inv.is_valid_to || "").slice(0, 10);
  const newFrom = validFrom ? shiftIsoDate(validFrom, src, dst) : "";
  // Zahlungsfrist in Tagen bleibt gleich.
  const newTo = validFrom && validTo ? addDaysIso(newFrom, diffDaysIso(validFrom, validTo)) : "";
  return { validFrom, validTo, newFrom, newTo };
}

// ---------- Vorschau ----------

function pair(oldValue: string, newValue: string) {
  return { old: oldValue, new: newValue, changed: oldValue !== newValue };
}

export function buildPreview(
  inv: any,
  contactName: string,
  src: MonthRef,
  dst: MonthRef,
  existingCopy: any | null,
) {
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

  const dates = shiftedDates(inv, src, dst);
  const textChanged = title.changed || header.changed || footer.changed ||
    positions.some((p: any) => p.text.changed);

  return {
    id: inv.id,
    document_nr: inv.document_nr || "",
    contact_id: inv.contact_id ?? null,
    contact_name: contactName,
    status_id: inv.kb_item_status_id ?? null,
    status: STATUS_LABELS[inv.kb_item_status_id] || "",
    total: inv.total ?? null,
    currency_id: inv.currency_id ?? null,
    source_month: monthKey(src),
    target_month: monthKey(dst),
    valid_from: { old: dates.validFrom, new: dates.newFrom },
    valid_to: { old: dates.validTo, new: dates.newTo },
    title,
    header,
    footer,
    positions,
    text_changed: textChanged,
    already_created: existingCopy
      ? {
        id: existingCopy.id,
        document_nr: existingCopy.document_nr || "",
        status: STATUS_LABELS[existingCopy.kb_item_status_id] || "",
      }
      : null,
  };
}

// ---------- Neue Rechnung ----------

export class UnsupportedInvoiceError extends Error {}

function copyIfSet(target: Record<string, unknown>, source: any, keys: string[]) {
  for (const key of keys) {
    const v = source[key];
    if (v !== undefined && v !== null && v !== "") target[key] = v;
  }
}

function buildPosition(p: any, src: MonthRef, dst: MonthRef): Record<string, unknown> {
  // Unterpositionen verweisen über parent_id auf die ID einer anderen
  // Position der ALTEN Rechnung — lässt sich in einem Aufruf nicht
  // sauber übertragen. Lieber ablehnen als falsch kopieren.
  if (p.parent_id !== undefined && p.parent_id !== null) {
    throw new UnsupportedInvoiceError("Rechnung enthält Unterpositionen – bitte in Bexio von Hand kopieren.");
  }
  const text = shiftMonthText(p.text, src, dst);
  switch (p.type) {
    case "KbPositionCustom":
    case "KbPositionArticle": {
      const out: Record<string, unknown> = { type: p.type, text };
      copyIfSet(out, p, ["amount", "unit_id", "account_id", "tax_id", "unit_price", "discount_in_percent"]);
      if (p.type === "KbPositionArticle") copyIfSet(out, p, ["article_id"]);
      return out;
    }
    case "KbPositionText":
      return { type: p.type, text, show_pos_nr: !!p.show_pos_nr };
    case "KbPositionSubtotal":
      return { type: p.type, text };
    case "KbPositionPagebreak":
      return { type: p.type, pagebreak: true };
    case "KbPositionDiscount":
      return { type: p.type, text, is_percentual: !!p.is_percentual, value: p.value };
    default:
      throw new UnsupportedInvoiceError(
        "Positionstyp «" + String(p.type) + "» wird nicht unterstützt – bitte in Bexio von Hand kopieren.",
      );
  }
}

// Body für POST /kb_invoice. Ohne document_nr (Bexio nummeriert selbst)
// und ohne Status → Bexio legt einen Entwurf an.
export function buildNewInvoicePayload(inv: any, src: MonthRef, dst: MonthRef): Record<string, unknown> {
  const dates = shiftedDates(inv, src, dst);
  if (!dates.newFrom) throw new UnsupportedInvoiceError("Vorlage hat kein Rechnungsdatum.");

  const payload: Record<string, unknown> = {
    title: shiftMonthText(inv.title, src, dst),
    header: shiftMonthText(inv.header, src, dst),
    footer: shiftMonthText(inv.footer, src, dst),
    is_valid_from: dates.newFrom,
    api_reference: seriesReference(inv.id, dst),
  };
  if (dates.newTo) payload.is_valid_to = dates.newTo;

  copyIfSet(payload, inv, [
    "contact_id",
    "contact_sub_id",
    "user_id",
    "pr_project_id",
    "logopaper_id",
    "language_id",
    "bank_account_id",
    "currency_id",
    "payment_type_id",
    "contact_address_manual",
    "template_slug",
  ]);
  // Zahl 0 ist bei mwst_type ein gültiger Wert ("inkl. MWST"), Booleans
  // dürfen false sein → nicht über copyIfSet.
  for (const key of ["mwst_type", "mwst_is_net", "show_position_taxes"]) {
    if (inv[key] !== undefined && inv[key] !== null) payload[key] = inv[key];
  }

  if (!payload.contact_id) throw new UnsupportedInvoiceError("Vorlage hat keinen Kontakt.");

  payload.positions = (Array.isArray(inv.positions) ? inv.positions : [])
    .map((p: any) => buildPosition(p, src, dst));
  return payload;
}

// Kontrolle nach dem Erstellen: Das Total muss dem der Vorlage entsprechen.
export function totalsMatch(a: unknown, b: unknown): boolean {
  const x = Number(a), y = Number(b);
  if (isNaN(x) || isNaN(y)) return false;
  return Math.abs(x - y) < 0.005;
}
