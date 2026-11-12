// Tests für recurring-invoice.ts. Ausführen mit:
//   node --test supabase/functions/_shared/recurring-invoice.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildNewInvoicePayload,
  buildPreview,
  ExistingCopies,
  isInRange,
  monthsFor,
  parseSeriesReference,
  parseSeriesRequest,
  planNewInvoice,
  seriesReference,
  totalsMatch,
  UnsupportedInvoiceError,
} from "./recurring-invoice.ts";

const OKT = { year: 2026, month: 10 };
const JAN27 = { year: 2027, month: 1 };

const source = {
  id: 42,
  document_nr: "RE-00295",
  title: "Treuhanddienstleistungen Okt-Dez 2026",
  header: "Leistungen Okt-Dez 2026",
  footer: "Zahlbar innert 10 Tagen",
  contact_id: 10,
  contact_sub_id: null,
  user_id: 1,
  language_id: 1,
  bank_account_id: 3,
  currency_id: 1,
  payment_type_id: 4,
  mwst_type: 0,
  mwst_is_net: false,
  show_position_taxes: false,
  template_slug: "abc",
  contact_address_manual: "",
  is_valid_from: "2026-10-01",
  is_valid_to: "2026-10-10",
  kb_item_status_id: 9,
  total: "2270.10",
  // Felder, die NICHT übernommen werden dürfen:
  kb_item_status_id_ignored: true,
  reference: "RF-OLD",
  esr_id: 5,
  positions: [
    { id: 1, type: "KbPositionCustom", parent_id: null, amount: "1.000000", unit_id: 2, account_id: 101, tax_id: 16, text: "Buchhaltung 01.10.2026 - 31.12.2026", unit_price: "2100.000000", discount_in_percent: null, position_total: "2100.00", pos: "1" },
    { id: 2, type: "KbPositionArticle", parent_id: null, amount: "2", unit_id: 1, account_id: 101, tax_id: 16, text: "Artikel", unit_price: "5", article_id: 77 },
    { id: 3, type: "KbPositionText", parent_id: null, text: "Hinweis Q4 2026", show_pos_nr: false },
    { id: 4, type: "KbPositionSubtotal", parent_id: null, text: "Zwischentotal", value: "2110.00" },
    { id: 5, type: "KbPositionDiscount", text: "Rabatt", is_percentual: true, value: "5.000000", discount_total: "105.50" },
    { id: 6, type: "KbPositionPagebreak", parent_id: null, pagebreak: true },
  ],
};

test("Payload: Texte und Daten verschoben, Rest übernommen", () => {
  const p: any = buildNewInvoicePayload(source, OKT, JAN27);
  assert.equal(p.title, "Treuhanddienstleistungen Jan-Mär 2027");
  assert.equal(p.header, "Leistungen Jan-Mär 2027");
  assert.equal(p.footer, "Zahlbar innert 10 Tagen");
  assert.equal(p.is_valid_from, "2027-01-01");
  assert.equal(p.is_valid_to, "2027-01-10");
  assert.equal(p.api_reference, "whatsbill-serie:42:2027-01");
  assert.equal(p.contact_id, 10);
  assert.equal(p.bank_account_id, 3);
  assert.equal(p.mwst_type, 0);
  assert.equal(p.mwst_is_net, false);
  assert.equal(p.template_slug, "abc");
});

test("Payload: keine Nummer, kein Status, keine schreibgeschützten Felder", () => {
  const p: any = buildNewInvoicePayload(source, OKT, JAN27);
  for (const key of ["id", "document_nr", "kb_item_status_id", "total", "reference", "esr_id", "contact_sub_id", "contact_address_manual"]) {
    assert.equal(key in p, false, key);
  }
});

test("Payload: Positionen je Typ", () => {
  const p: any = buildNewInvoicePayload(source, OKT, JAN27);
  assert.deepEqual(p.positions, [
    { type: "KbPositionCustom", text: "Buchhaltung 01.01.2027 - 31.03.2027", amount: "1.000000", unit_id: 2, account_id: 101, tax_id: 16, unit_price: "2100.000000" },
    { type: "KbPositionArticle", text: "Artikel", amount: "2", unit_id: 1, account_id: 101, tax_id: 16, unit_price: "5", article_id: 77 },
    { type: "KbPositionText", text: "Hinweis Q1 2027", show_pos_nr: false },
    { type: "KbPositionSubtotal", text: "Zwischentotal" },
    { type: "KbPositionDiscount", text: "Rabatt", is_percentual: true, value: "5.000000" },
    { type: "KbPositionPagebreak", pagebreak: true },
  ]);
});

test("Payload: unbekannte Typen und verwaiste Positionen werden abgelehnt", () => {
  const orphan = { ...source, positions: [{ ...source.positions[0], parent_id: 9 }] };
  assert.throws(() => planNewInvoice(orphan, OKT, JAN27), UnsupportedInvoiceError);
  const unknown = { ...source, positions: [{ type: "KbPositionFoo", text: "x" }] };
  assert.throws(() => planNewInvoice(unknown, OKT, JAN27), UnsupportedInvoiceError);
  assert.throws(() => buildNewInvoicePayload({ ...source, contact_id: null }, OKT, JAN27), UnsupportedInvoiceError);
});

test("Kennzeichnung und Doppel-Erkennung", () => {
  assert.equal(seriesReference(42, JAN27), "whatsbill-serie:42:2027-01");
  assert.deepEqual(parseSeriesReference("whatsbill-serie:42:2027-01"), { sourceId: 42, month: "2027-01" });
  assert.equal(parseSeriesReference("irgendwas"), null);
  assert.equal(parseSeriesReference(null), null);

  const list = [
    { id: 100, api_reference: "whatsbill-serie:42:2027-01", kb_item_status_id: 7 },
    { id: 101, api_reference: "whatsbill-serie:43:2027-01", kb_item_status_id: 19 }, // storniert
    { id: 102, api_reference: "whatsbill-serie:44:2026-11", kb_item_status_id: 7 }, // anderer Monat
    { id: 103, api_reference: null, kb_item_status_id: 8 },
  ];
  const copies = new ExistingCopies(list);
  assert.equal(copies.get(42, JAN27).id, 100);
  assert.equal(copies.get(43, JAN27), null); // storniert zählt nicht
  assert.equal(copies.get(44, JAN27), null); // anderer Zielmonat
  assert.equal(copies.get(44, { year: 2026, month: 11 }).id, 102);
  copies.add(45, JAN27, { id: 200 });
  assert.equal(copies.get(45, JAN27).id, 200);
});

test("Zeitraum: Request lesen", () => {
  const r: any = parseSeriesRequest({ source_from: "2026-10-01", source_to: "2026-12-31", target_month: "2027-01" });
  assert.deepEqual(r, { from: "2026-10-01", to: "2026-12-31", delta: 3, target: JAN27 });
  // alte Form
  const old: any = parseSeriesRequest({ source_month: "2026-10", target_month: "2026-11" });
  assert.deepEqual([old.from, old.to, old.delta], ["2026-10-01", "2026-10-31", 1]);
  // mitten im Monat
  const mid: any = parseSeriesRequest({ source_from: "2026-10-15", source_to: "2026-11-14", target_month: "2026-11" });
  assert.equal(mid.delta, 1);

  for (const bad of [
    { source_from: "2026-12-31", source_to: "2026-10-01", target_month: "2027-01" },
    { source_from: "2026-10-01", source_to: "2026-10-31", target_month: "2026-10" },
    { source_from: "2026-02-30", source_to: "2026-03-31", target_month: "2026-04" },
    { source_from: "01.10.2026", source_to: "2026-10-31", target_month: "2026-11" },
    { source_from: "2020-01-01", source_to: "2026-10-31", target_month: "2026-11" },
    { source_from: "2026-10-01", source_to: "2026-10-31" },
    {},
  ]) {
    assert.ok("error" in (parseSeriesRequest(bad) as any), JSON.stringify(bad));
  }
});

test("Zeitraum: jede Rechnung wird um gleich viele Monate verschoben", () => {
  const range: any = parseSeriesRequest({ source_from: "2026-10-01", source_to: "2026-12-31", target_month: "2027-01" });
  assert.deepEqual(monthsFor({ is_valid_from: "2026-10-01" }, range), { src: OKT, dst: JAN27 });
  assert.deepEqual(monthsFor({ is_valid_from: "2026-11-09" }, range), { src: { year: 2026, month: 11 }, dst: { year: 2027, month: 2 } });
  assert.deepEqual(monthsFor({ is_valid_from: "2026-12-01" }, range), { src: { year: 2026, month: 12 }, dst: { year: 2027, month: 3 } });
  assert.equal(monthsFor({ is_valid_from: null }, range), null);
  assert.equal(isInRange({ is_valid_from: "2026-12-31" }, range), true);
  assert.equal(isInRange({ is_valid_from: "2027-01-01" }, range), false);
  assert.equal(isInRange({ is_valid_from: "2026-09-30" }, range), false);

  const nov = { ...source, id: 7, title: "Beratung November 2026", is_valid_from: "2026-11-09", is_valid_to: "2026-11-16", positions: [] };
  const m = monthsFor(nov, range)!;
  const p: any = buildNewInvoicePayload(nov, m.src, m.dst);
  assert.equal(p.title, "Beratung Februar 2027");
  assert.equal(p.is_valid_from, "2027-02-09");
  assert.equal(p.is_valid_to, "2027-02-16");
  assert.equal(p.api_reference, "whatsbill-serie:7:2027-02");
});

test("Vorschau enthält bereits erstellte Kopie", () => {
  const a = buildPreview(source, "Axhi GmbH", OKT, JAN27, null);
  assert.equal(a.already_created, null);
  assert.equal(a.text_changed, true);
  const b = buildPreview(source, "Axhi GmbH", OKT, JAN27, { id: 100, document_nr: "RE-00401", kb_item_status_id: 7 });
  assert.deepEqual(b.already_created, { id: 100, document_nr: "RE-00401", status: "Entwurf" });
});

test("totalsMatch", () => {
  assert.equal(totalsMatch("2270.10", "2270.1"), true);
  assert.equal(totalsMatch("2270.10", "2270.15"), false);
  assert.equal(totalsMatch(null, "1"), false);
});

const group = { id: 50, type: "KbPositionSubposition", parent_id: null, text: "Leistungen Okt-Dez 2026", show_pos_nr: true };
const childA = { id: 51, type: "KbPositionCustom", parent_id: 50, amount: "1", unit_id: 2, account_id: 101, tax_id: 16, text: "Buchhaltung", unit_price: "1000" };
const childB = { id: 52, type: "KbPositionText", parent_id: 50, text: "Periode 01.10.2026 - 31.12.2026", show_pos_nr: false };
const after = { id: 53, type: "KbPositionCustom", parent_id: null, amount: "1", unit_id: 2, account_id: 101, tax_id: 16, text: "Spesen", unit_price: "50" };

const expectedSteps = [
  { endpoint: "kb_position_subposition", body: { text: "Leistungen Jan-Mär 2027", show_pos_nr: true }, oldId: 50, parentOldId: null },
  { endpoint: "kb_position_custom", body: { text: "Buchhaltung", amount: "1", unit_id: 2, account_id: 101, tax_id: 16, unit_price: "1000" }, oldId: 51, parentOldId: 50 },
  { endpoint: "kb_position_text", body: { text: "Periode 01.01.2027 - 31.03.2027", show_pos_nr: false }, oldId: 52, parentOldId: 50 },
  { endpoint: "kb_position_custom", body: { text: "Spesen", amount: "1", unit_id: 2, account_id: 101, tax_id: 16, unit_price: "50" }, oldId: 53, parentOldId: null },
];

test("Gruppen: flach geliefert (parent_id), auch in vertauschter Reihenfolge", () => {
  const plan = planNewInvoice({ ...source, positions: [group, childA, childB, after] }, OKT, JAN27);
  assert.equal("positions" in plan.payload, false);
  assert.deepEqual(plan.steps, expectedSteps);
  // Kinder stehen in der Liste erst nach der Folgeposition
  const shuffled = planNewInvoice({ ...source, positions: [group, after, childA, childB] }, OKT, JAN27);
  assert.deepEqual(shuffled.steps, expectedSteps);
});

test("Gruppen: verschachtelt geliefert (positions im Container)", () => {
  const strip = ({ parent_id, ...rest }: any) => rest;
  const nested = { ...group, positions: [strip(childA), strip(childB)] };
  const plan = planNewInvoice({ ...source, positions: [nested, after] }, OKT, JAN27);
  assert.deepEqual(plan.steps, expectedSteps);
});

test("Gruppen: Vorschau zeigt Container und Kinder; ohne Gruppen bleibt es ein Aufruf", () => {
  const prev = buildPreview({ ...source, positions: [group, after, childA, childB] }, "X", OKT, JAN27, null);
  assert.deepEqual(prev.positions.map((p: any) => p.text.new), [
    "Leistungen Jan-Mär 2027", "Buchhaltung", "Periode 01.01.2027 - 31.03.2027", "Spesen",
  ]);
  const flat = planNewInvoice(source, OKT, JAN27);
  assert.equal(flat.steps.length, 0);
  assert.equal((flat.payload.positions as any[]).length, 6);
  assert.throws(() => buildNewInvoicePayload({ ...source, positions: [group, childA] }, OKT, JAN27), UnsupportedInvoiceError);
});

test("Zeiterfassung: KbPositionMonitoring wird ausgelassen, Rest kopiert", () => {
  const mon = { id: 80, type: "KbPositionMonitoring", parent_id: null, text: "Stunden Okt-Dez 2026", amount: "12.5", unit_price: "150" };
  // ohne Gruppen: ein Aufruf, Monitoring fehlt
  const flat = planNewInvoice({ ...source, positions: [source.positions[0], mon, source.positions[2]] }, OKT, JAN27);
  assert.equal(flat.skipped, 1);
  assert.equal(flat.steps.length, 0);
  assert.deepEqual((flat.payload.positions as any[]).map((p) => p.type), ["KbPositionCustom", "KbPositionText"]);
  // mit Gruppen, Monitoring innerhalb der Gruppe
  const grouped = planNewInvoice({ ...source, positions: [group, childA, { ...mon, parent_id: 50 }, after] }, OKT, JAN27);
  assert.equal(grouped.skipped, 1);
  assert.deepEqual(grouped.steps.map((s) => s.endpoint), ["kb_position_subposition", "kb_position_custom", "kb_position_custom"]);
  // nur Monitoring → Rechnung ohne Positionen
  const only = planNewInvoice({ ...source, positions: [mon] }, OKT, JAN27);
  assert.equal(only.skipped, 1);
  assert.deepEqual(only.payload.positions, []);
  // ohne Monitoring bleibt skipped 0
  assert.equal(planNewInvoice(source, OKT, JAN27).skipped, 0);

  const prev = buildPreview({ ...source, positions: [source.positions[0], mon] }, "X", OKT, JAN27, null);
  assert.equal(prev.ignored_positions, 1);
  assert.deepEqual(prev.positions.map((p: any) => [p.type, p.ignored, p.text.new]), [
    ["KbPositionCustom", false, "Buchhaltung 01.01.2027 - 31.03.2027"],
    ["KbPositionMonitoring", true, ""],
  ]);
});
