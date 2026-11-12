// Tests für recurring-invoice.ts. Ausführen mit:
//   node --test supabase/functions/_shared/recurring-invoice.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildNewInvoicePayload,
  buildPreview,
  findExistingCopies,
  parseSeriesReference,
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

test("Payload: Unterpositionen und unbekannte Typen werden abgelehnt", () => {
  const sub = { ...source, positions: [{ ...source.positions[0], parent_id: 9 }] };
  assert.throws(() => buildNewInvoicePayload(sub, OKT, JAN27), UnsupportedInvoiceError);
  const unknown = { ...source, positions: [{ type: "KbPositionSubposition", text: "x" }] };
  assert.throws(() => buildNewInvoicePayload(unknown, OKT, JAN27), UnsupportedInvoiceError);
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
  const map = findExistingCopies(list, JAN27);
  assert.deepEqual(Array.from(map.keys()), [42]);
  assert.equal(map.get(42).id, 100);
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
