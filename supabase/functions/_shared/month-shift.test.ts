// Tests für month-shift.ts. Ausführen mit:
//   node --test supabase/functions/_shared/month-shift.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMonth, shiftIsoDate, shiftMonthText } from "./month-shift.ts";

const OKT = { year: 2026, month: 10 };
const NOV = { year: 2026, month: 11 };
const DEZ = { year: 2026, month: 12 };
const JAN27 = { year: 2027, month: 1 };
const FEB27 = { year: 2027, month: 2 };
const MRZ27 = { year: 2027, month: 3 };

function eq(input: string, expected: string, src = OKT, dst = NOV) {
  assert.equal(shiftMonthText(input, src, dst), expected);
}

test("Monatsname mit und ohne Jahr", () => {
  eq("Reinigung Oktober 2026", "Reinigung November 2026");
  eq("Miete Oktober", "Miete November");
  eq("HAUSWARTUNG OKTOBER 2026", "HAUSWARTUNG NOVEMBER 2026");
  eq("Leistungen im Oktober 2026 gemäss Vertrag", "Leistungen im November 2026 gemäss Vertrag");
});

test("anderes Jahr bleibt stehen", () => {
  eq("Vertrag vom Oktober 2024", "Vertrag vom Oktober 2024");
  eq("gemäss Offerte vom 01.10.2025", "gemäss Offerte vom 01.10.2025");
});

test("Jahreswechsel", () => {
  eq("Miete Dezember 2026", "Miete Januar 2027", DEZ, JAN27);
  eq("01.12.2026 - 31.12.2026", "01.01.2027 - 31.01.2027", DEZ, JAN27);
  eq("12/2026", "01/2027", DEZ, JAN27);
});

test("Datumsbereiche und Monatsletzter", () => {
  eq("01.10.2026 – 31.10.2026", "01.11.2026 – 30.11.2026");
  eq("01.10. – 31.10.2026", "01.11. – 30.11.2026");
  eq("1.10.26 bis 31.10.26", "1.11.26 bis 30.11.26");
  eq("Periode 01.01.2027-31.01.2027", "Periode 01.02.2027-28.02.2027", JAN27, FEB27);
  eq("Periode 01.02.2027-28.02.2027", "Periode 01.03.2027-31.03.2027", FEB27, MRZ27);
  eq("am 15.10.2026", "am 15.11.2026");
});

test("Monat/Jahr numerisch", () => {
  eq("Abo 10/2026", "Abo 11/2026");
  eq("Abo 10.2026", "Abo 11.2026");
  eq("Periode 2026-10", "Periode 2026-11");
  eq("Rechnung 9/2026", "Rechnung 10/2026", { year: 2026, month: 9 }, OKT);
  eq("Rechnung 09/2026", "Rechnung 10/2026", { year: 2026, month: 9 }, OKT);
});

test("keine Fehltreffer in Beträgen und Nummern", () => {
  eq("Pauschale CHF 110.2026", "Pauschale CHF 110.2026");
  eq("Tel. 044 310 20 26", "Tel. 044 310 20 26");
  eq("Artikel 2026-1045", "Artikel 2026-1045");
  eq("Oktoberfest-Catering", "Oktoberfest-Catering");
});

test("Abkürzungen", () => {
  eq("Okt. 2026", "Nov. 2026");
  eq("Okt 2026", "Nov 2026");
  eq("Wartung Okt.", "Wartung Nov.");
  eq("Jan Müller", "Jan Müller", JAN27, FEB27);
  eq("Apr. 2026", "Mai 2026", { year: 2026, month: 4 }, { year: 2026, month: 5 });
});

test("französisch und italienisch", () => {
  eq("Loyer octobre 2026", "Loyer novembre 2026");
  eq("Affitto ottobre 2026", "Affitto novembre 2026");
  eq("Loyer février 2027", "Loyer mars 2027", FEB27, MRZ27);
});

test("HTML bleibt erhalten, Entities werden erkannt", () => {
  eq(
    '<strong>Reinigung</strong><br />Oktober&nbsp;2026 <span data-x="10/2026">x</span>',
    '<strong>Reinigung</strong><br />November&nbsp;2026 <span data-x="10/2026">x</span>',
  );
  eq("Miete M&auml;rz 2027", "Miete April 2027", MRZ27, { year: 2027, month: 4 });
  eq("Miete Februar 2027", "Miete M&auml;rz 2027".replace("&auml;", "ä"), FEB27, MRZ27);
});

test("leere Werte", () => {
  assert.equal(shiftMonthText(null, OKT, NOV), "");
  assert.equal(shiftMonthText("", OKT, NOV), "");
  assert.equal(shiftMonthText("Pauschale", OKT, NOV), "Pauschale");
});

test("shiftIsoDate", () => {
  assert.equal(shiftIsoDate("2026-10-01", OKT, NOV), "2026-11-01");
  assert.equal(shiftIsoDate("2026-10-31", OKT, NOV), "2026-11-30");
  assert.equal(shiftIsoDate("2026-12-15", DEZ, JAN27), "2027-01-15");
  assert.equal(shiftIsoDate("2027-01-30", JAN27, FEB27), "2027-02-28");
});

test("parseMonth", () => {
  assert.deepEqual(parseMonth("2026-10"), OKT);
  assert.equal(parseMonth("2026-13"), null);
  assert.equal(parseMonth("10/2026"), null);
});

test("Zeiträume über mehrere Monate (Quartalsrechnungen)", () => {
  eq("Treuhanddienstleistungen Okt-Dez 2026", "Treuhanddienstleistungen Jan-Mär 2027", OKT, JAN27);
  eq("Okt. - Dez. 2026", "Jan. - Mär. 2027", OKT, JAN27);
  eq("Oktober bis Dezember 2026", "Januar bis März 2027", OKT, JAN27);
  eq("Oktober 2026 – Dezember 2026", "Januar 2027 – März 2027", OKT, JAN27);
  eq("Okt-Dez", "Jan-Mär", OKT, JAN27);
  eq("Okt/Nov 2026", "Nov/Dez 2026");
  eq("Okt-Dez 2026", "Nov-Jan 2027");
  eq("Nov-Jan 2027", "Dez-Feb 2027", NOV, DEZ);
  eq("Honorar Okt-Dez 2025", "Honorar Okt-Dez 2025", OKT, JAN27);
  eq("Jul-Sep 2026", "Jul-Sep 2026", OKT, JAN27);
  eq("Apr-Jun 2026", "Mai-Jul 2026", { year: 2026, month: 4 }, { year: 2026, month: 5 });
});

test("Datumsbereiche über mehrere Monate", () => {
  eq("01.10.2026 – 31.12.2026", "01.01.2027 – 31.03.2027", OKT, JAN27);
  eq("01.10. bis 31.12.2026", "01.01. bis 31.03.2027", OKT, JAN27);
  eq("01.10.26-31.12.26", "01.01.27-31.03.27", OKT, JAN27);
  eq("01.10.2026 – 30.11.2026", "01.11.2026 – 31.12.2026");
  eq("15.10.2026 - 14.11.2026", "15.11.2026 - 14.12.2026");
});

test("Quartale", () => {
  eq("Buchhaltung Q4 2026", "Buchhaltung Q1 2027", OKT, JAN27);
  eq("4. Quartal 2026", "1. Quartal 2027", OKT, JAN27);
  eq("Q4/2026", "Q1/2027", OKT, JAN27);
  eq("Q4 2026", "Q4 2026");
  eq("Q3 2026", "Q3 2026", OKT, JAN27);
});
