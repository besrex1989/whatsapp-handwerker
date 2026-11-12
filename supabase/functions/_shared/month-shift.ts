// month-shift — verschiebt Monatsangaben in Rechnungstexten.
//
// Zweck: Serienrechnungen. Eine Rechnung vom Vormonat wird kopiert, dabei
// muss "Oktober 2026" zu "November 2026" werden, "01.10.2026 – 31.10.2026"
// zu "01.11.2026 – 30.11.2026" usw.
//
// Bewusst rein (keine Imports, kein Deno-API), damit die Datei sowohl in
// der Edge Function als auch im Node-Test (month-shift.test.ts) läuft.
//
// Erkannte Schreibweisen (immer nur für den QUELL-Monat):
//   - Monatsname de/fr/it/en, mit oder ohne Jahr     "Oktober 2026", "octobre"
//   - Deutsche Abkürzung mit Punkt oder Jahr          "Okt. 2026", "Okt 2026"
//   - Datum                                           "31.10.2026", "1.10.26", "01.10."
//   - Monat/Jahr                                      "10/2026", "10.2026", "10-2026"
//   - Jahr-Monat                                      "2026-10"
//
// Steht bei einer Angabe ein ANDERES Jahr als das Quell-Jahr ("Vertrag vom
// 01.10.2024"), bleibt sie unverändert — sie meint nicht die Rechnungsperiode.

export interface MonthRef {
  year: number;
  month: number; // 1–12
}

const NAMES: Record<string, string[]> = {
  de: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
  fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
  it: ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};

// Deutsche Abkürzungen. Mehrere Varianten pro Monat möglich; die erste ist
// die, die beim Ersetzen geschrieben wird.
const ABBR_DE: string[][] = [
  ["Jan"], ["Feb"], ["Mär", "Mrz"], ["Apr"], ["Mai"], ["Jun"],
  ["Jul"], ["Aug"], ["Sep", "Sept"], ["Okt"], ["Nov"], ["Dez"],
];

const ENTITIES: Record<string, string> = {
  "ä": "&auml;", "é": "&eacute;", "û": "&ucirc;",
};

export function parseMonth(s: string): MonthRef | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  return { year, month };
}

export function lastDayOfMonth(ref: MonthRef): number {
  return new Date(Date.UTC(ref.year, ref.month, 0)).getUTCDate();
}

// Tag im Zielmonat: Monatsletzter bleibt Monatsletzter (31.10. → 30.11.),
// sonst gleicher Tag, begrenzt auf die Länge des Zielmonats.
function shiftDay(day: number, src: MonthRef, dst: MonthRef): number {
  const srcLast = lastDayOfMonth(src);
  const dstLast = lastDayOfMonth(dst);
  if (day >= srcLast) return dstLast;
  return Math.min(day, dstLast);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

// "2026-10-15" → "2026-11-15". Liegt das Datum nicht im Quellmonat, wird
// es um die gleiche Anzahl Monate verschoben (Tag begrenzt).
export function shiftIsoDate(iso: string, src: MonthRef, dst: MonthRef): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return iso;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y === src.year && mo === src.month) {
    return `${dst.year}-${pad(dst.month, 2)}-${pad(shiftDay(d, src, dst), 2)}`;
  }
  const delta = (dst.year - src.year) * 12 + (dst.month - src.month);
  const idx = y * 12 + (mo - 1) + delta;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  const last = lastDayOfMonth({ year: ny, month: nm });
  return `${ny}-${pad(nm, 2)}-${pad(Math.min(d, last), 2)}`;
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDaysIso(fromIso: string, toIso: string): number {
  const a = new Date(fromIso.slice(0, 10) + "T00:00:00Z").getTime();
  const b = new Date(toIso.slice(0, 10) + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withEntities(s: string): string {
  return s.replace(/[äéû]/g, (c) => ENTITIES[c]);
}

// Gross-/Kleinschreibung des Fundes auf den Ersatz übertragen.
function matchCase(found: string, replacement: string): string {
  const letters = found.replace(/&[a-z]+;/gi, "x");
  if (letters.length > 1 && letters === letters.toUpperCase()) return replacement.toUpperCase();
  const first = found.charAt(0);
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement.charAt(0).toLowerCase() + replacement.slice(1);
}

const NOT_LETTER_BEFORE = "(?<![\\p{L}\\d;])";
const NOT_LETTER_AFTER = "(?![\\p{L}\\d])";
const YEAR_TAIL = "(?:((?:\\s|&nbsp;)+)(\\d{4})(?!\\d))?";

function shiftNames(text: string, src: MonthRef, dst: MonthRef): string {
  let out = text;

  // Ausgeschriebene Monatsnamen. Gleichlautende Namen über Sprachen hinweg
  // (z. B. "September" de/en) nur einmal behandeln.
  const seen = new Set<string>();
  for (const lang of Object.keys(NAMES)) {
    const srcName = NAMES[lang][src.month - 1];
    const dstName = NAMES[lang][dst.month - 1];
    const key = srcName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const variants = [srcName];
    if (withEntities(srcName) !== srcName) variants.push(withEntities(srcName));
    const re = new RegExp(
      NOT_LETTER_BEFORE + "(" + variants.map(escapeRe).join("|") + ")" + NOT_LETTER_AFTER + YEAR_TAIL,
      "giu",
    );
    out = out.replace(re, (all, name: string, sep: string | undefined, year: string | undefined) => {
      if (year !== undefined && Number(year) !== src.year) return all;
      let rep = matchCase(name, dstName);
      if (name.indexOf("&") !== -1) rep = withEntities(rep);
      return year !== undefined ? rep + sep + String(dst.year) : rep;
    });
  }

  // Deutsche Abkürzungen: nur mit Punkt oder Jahr dahinter, sonst zu viele
  // Fehltreffer ("Jan" als Vorname).
  const srcFull = NAMES.de[src.month - 1].toLowerCase();
  const abbrs = ABBR_DE[src.month - 1].filter((a) => a.toLowerCase() !== srcFull);
  if (abbrs.length > 0) {
    const dstAbbr = ABBR_DE[dst.month - 1][0];
    const re = new RegExp(
      NOT_LETTER_BEFORE + "(" + abbrs.map(escapeRe).join("|") + ")(\\.?)" + NOT_LETTER_AFTER + YEAR_TAIL,
      "giu",
    );
    out = out.replace(re, (all, name: string, dot: string, sep: string | undefined, year: string | undefined) => {
      if (!dot && year === undefined) return all;
      if (year !== undefined && Number(year) !== src.year) return all;
      // "Mai" hat keine Abkürzung mit Punkt.
      const isFull = dstAbbr.toLowerCase() === NAMES.de[dst.month - 1].toLowerCase();
      const rep = matchCase(name, dstAbbr) + (isFull ? "" : dot);
      return year !== undefined ? rep + sep + String(dst.year) : rep;
    });
  }

  return out;
}

function shiftNumeric(text: string, src: MonthRef, dst: MonthRef): string {
  let out = text;
  const mm = "(0?" + src.month + ")";
  const yyyy = String(src.year);
  const yy = yyyy.slice(2);

  // Datum: "31.10.2026", "1.10.26", "01.10." (ohne Jahr).
  const dateRe = new RegExp("(?<![\\d.])(\\d{1,2})\\." + mm + "\\.(\\d{4}|\\d{2})?(?!\\d)", "g");
  out = out.replace(dateRe, (all, day: string, month: string, year: string | undefined) => {
    const d = Number(day);
    if (d < 1 || d > 31) return all;
    if (year !== undefined && year !== yyyy && year !== yy) return all;
    const newDay = pad(shiftDay(d, src, dst), day.length);
    const newMonth = pad(dst.month, month.length);
    let newYear = "";
    if (year !== undefined) {
      newYear = year.length === 4 ? String(dst.year) : String(dst.year).slice(2);
    }
    return newDay + "." + newMonth + "." + newYear;
  });

  // Monat/Jahr: "10/2026", "10.2026", "10-2026".
  const myRe = new RegExp("(?<![\\d./\\-])" + mm + "([/.\\-])" + yyyy + "(?![\\d./\\-])", "g");
  out = out.replace(myRe, (_all, month: string, sep: string) => {
    return pad(dst.month, month.length) + sep + String(dst.year);
  });

  // Jahr-Monat: "2026-10".
  const ymRe = new RegExp("(?<![\\d./\\-])" + yyyy + "-" + pad(src.month, 2) + "(?![\\d./\\-])", "g");
  out = out.replace(ymRe, () => String(dst.year) + "-" + pad(dst.month, 2));

  return out;
}

// Hauptfunktion. Bexio-Texte enthalten HTML (<br />, <strong>…): Tags
// bleiben unangetastet, ersetzt wird nur im Text dazwischen.
export function shiftMonthText(text: string | null | undefined, src: MonthRef, dst: MonthRef): string {
  if (!text) return text == null ? "" : String(text);
  if (src.year === dst.year && src.month === dst.month) return text;
  const parts = String(text).split(/(<[^>]*>)/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part.charAt(0) === "<") continue;
    parts[i] = shiftNames(shiftNumeric(part, src, dst), src, dst);
  }
  return parts.join("");
}
