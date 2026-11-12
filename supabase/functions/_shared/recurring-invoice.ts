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

  const nodes = flattenPositions(inv);
  const ignoredCount = nodes.filter((n) => isIgnoredPosition(n.position)).length;
  const positions = nodes
    .map((node) => node.position)
    .filter((p: any) => isIgnoredPosition(p) || (typeof p.text === "string" && p.text !== ""))
    .map((p: any) => {
      const ignored = isIgnoredPosition(p);
      const oldText = typeof p.text === "string" ? p.text : "";
      return {
        type: p.type,
        amount: p.amount ?? null,
        unit_price: p.unit_price ?? null,
        position_total: p.position_total ?? null,
        // Ausgelassene Positionen erscheinen in der neuen Rechnung nicht.
        ignored,
        text: ignored ? { old: oldText, new: "", changed: false } : pair(oldText, shiftMonthText(oldText, src, dst)),
      };
    });

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
    ignored_positions: ignoredCount,
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

// ---------- Positionen ----------
//
// Bexio kennt Gruppen («Unterpositionen», KbPositionSubposition): ein
// Container mit Text, dessen Kinder über parent_id auf ihn verweisen.
// Je nach Endpunkt liefert Bexio die Kinder flach (parent_id) oder
// verschachtelt (`positions` im Container) — beides wird verstanden.

// Positionen aus der Bexio-Zeiterfassung (KbPositionMonitoring) sind mit
// erfassten Stunden verknüpft und lassen sich über die API nicht anlegen.
// Entscheid des Betreibers: beim Kopieren AUSLASSEN — die übrige Rechnung
// wird erstellt, die Stunden verrechnet der User in Bexio selbst.
const IGNORED_POSITION_TYPES = new Set(["KbPositionMonitoring"]);

export function isIgnoredPosition(p: any): boolean {
  return IGNORED_POSITION_TYPES.has(String(p?.type));
}

export interface PositionNode {
  position: any;
  oldId: number | null;
  parentOldId: number | null;
}

// Alle Positionen in Dokument-Reihenfolge: Container, dann seine Kinder.
export function flattenPositions(inv: any): PositionNode[] {
  const all: PositionNode[] = [];
  const collect = (list: any[], inheritedParent: number | null) => {
    for (const p of list) {
      const parentOldId = p.parent_id !== undefined && p.parent_id !== null ? Number(p.parent_id) : inheritedParent;
      const oldId = p.id !== undefined && p.id !== null ? Number(p.id) : null;
      all.push({ position: p, oldId, parentOldId });
      if (Array.isArray(p.positions)) collect(p.positions, oldId);
    }
  };
  collect(Array.isArray(inv.positions) ? inv.positions : [], null);

  // Kinder direkt hinter ihren Container sortieren (bei flacher Lieferung
  // stehen sie nicht zwingend dort).
  const known = new Set(all.map((n) => n.oldId));
  const childrenOf = new Map<number | null, PositionNode[]>();
  for (const node of all) {
    if (node.parentOldId !== null && !known.has(node.parentOldId)) {
      throw new UnsupportedInvoiceError("Position verweist auf eine unbekannte Gruppe – bitte in Bexio von Hand kopieren.");
    }
    const list = childrenOf.get(node.parentOldId) || [];
    list.push(node);
    childrenOf.set(node.parentOldId, list);
  }
  const ordered: PositionNode[] = [];
  const visit = (parent: number | null, depth: number) => {
    if (depth > 5) throw new UnsupportedInvoiceError("Zu tief verschachtelte Gruppen – bitte in Bexio von Hand kopieren.");
    for (const node of childrenOf.get(parent) || []) {
      ordered.push(node);
      if (node.oldId !== null) visit(node.oldId, depth + 1);
    }
  };
  visit(null, 0);
  return ordered;
}

const POSITION_ENDPOINTS: Record<string, string> = {
  KbPositionCustom: "kb_position_custom",
  KbPositionArticle: "kb_position_article",
  KbPositionText: "kb_position_text",
  KbPositionSubtotal: "kb_position_subtotal",
  KbPositionPagebreak: "kb_position_pagebreak",
  KbPositionDiscount: "kb_position_discount",
  KbPositionSubposition: "kb_position_subposition",
};

// Felder einer Position für die neue Rechnung (ohne type / parent_id).
function buildPositionBody(p: any, src: MonthRef, dst: MonthRef): Record<string, unknown> {
  const text = shiftMonthText(p.text, src, dst);
  switch (p.type) {
    case "KbPositionCustom":
    case "KbPositionArticle": {
      const out: Record<string, unknown> = { text };
      copyIfSet(out, p, ["amount", "unit_id", "account_id", "tax_id", "unit_price", "discount_in_percent"]);
      if (p.type === "KbPositionArticle") copyIfSet(out, p, ["article_id"]);
      return out;
    }
    case "KbPositionText":
    case "KbPositionSubposition":
      return { text, show_pos_nr: !!p.show_pos_nr };
    case "KbPositionSubtotal":
      return { text };
    case "KbPositionPagebreak":
      return { pagebreak: true };
    case "KbPositionDiscount":
      return { text, is_percentual: !!p.is_percentual, value: p.value };
    default:
      throw new UnsupportedInvoiceError(
        "Positionstyp «" + String(p.type) + "» wird nicht unterstützt – bitte in Bexio von Hand kopieren.",
      );
  }
}

// Ein Schritt beim Einzel-Anlegen: POST /kb_invoice/{id}/{endpoint}.
// parentOldId → muss beim Ausführen auf die NEUE ID des Containers
// umgeschrieben werden (body.parent_id).
export interface PositionStep {
  endpoint: string;
  body: Record<string, unknown>;
  oldId: number | null;
  parentOldId: number | null;
}

export interface NewInvoicePlan {
  // Body für POST /kb_invoice.
  payload: Record<string, unknown>;
  // Leer → alle Positionen stecken schon im payload (ein einziger Aufruf).
  // Sonst: Rechnung ohne Positionen anlegen, dann diese Schritte der Reihe
  // nach ausführen. Nötig bei Gruppen, weil POST /kb_invoice keine
  // KbPositionSubposition annimmt.
  steps: PositionStep[];
  // Anzahl ausgelassener Positionen (Zeiterfassung). > 0 → das Total der
  // neuen Rechnung weicht absichtlich von der Vorlage ab.
  skipped: number;
}

// Plan für die neue Rechnung. Ohne document_nr (Bexio nummeriert selbst)
// und ohne Status → Bexio legt einen Entwurf an.
export function planNewInvoice(inv: any, src: MonthRef, dst: MonthRef): NewInvoicePlan {
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

  const allNodes = flattenPositions(inv);
  const nodes = allNodes.filter((n) => !isIgnoredPosition(n.position));
  const skipped = allNodes.length - nodes.length;
  const hasGroups = nodes.some((n) => n.parentOldId !== null || n.position.type === "KbPositionSubposition");

  if (!hasGroups) {
    payload.positions = nodes.map((n) => ({ type: n.position.type, ...buildPositionBody(n.position, src, dst) }));
    return { payload, steps: [], skipped };
  }

  const steps = nodes.map((n) => {
    const endpoint = POSITION_ENDPOINTS[n.position.type];
    const body = buildPositionBody(n.position, src, dst); // wirft bei unbekanntem Typ
    return { endpoint, body, oldId: n.oldId, parentOldId: n.parentOldId };
  });
  return { payload, steps, skipped };
}

// Body für POST /kb_invoice bei Rechnungen ohne Gruppen (ein Aufruf).
export function buildNewInvoicePayload(inv: any, src: MonthRef, dst: MonthRef): Record<string, unknown> {
  const plan = planNewInvoice(inv, src, dst);
  if (plan.steps.length > 0) {
    throw new UnsupportedInvoiceError("Rechnung enthält Gruppen und braucht mehrere Aufrufe (planNewInvoice).");
  }
  return plan.payload;
}

// Kontrolle nach dem Erstellen: Das Total muss dem der Vorlage entsprechen.
export function totalsMatch(a: unknown, b: unknown): boolean {
  const x = Number(a), y = Number(b);
  if (isNaN(x) || isNaN(y)) return false;
  return Math.abs(x - y) < 0.005;
}
