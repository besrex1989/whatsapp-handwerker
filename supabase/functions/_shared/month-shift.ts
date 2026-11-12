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
//   - Zeitraum ab Quellmonat                          "Okt-Dez 2026", "01.10.–31.12.2026"
//   - Quartal (bei Verschiebung um ganze Quartale)    "Q4 2026", "4. Quartal 2026"
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

// ---------- Zeiträume über mehrere Monate ----------
//
// Quartals- und Mehrmonatsrechnungen: "Okt-Dez 2026" → "Jan-Mär 2027".
// Beginnt ein Zeitraum im Quellmonat, wird auch sein Ende um die gleiche
// Anzahl Monate verschoben. Ergebnisse werden als Platzhalter eingesetzt,
// damit die späteren Einzel-Ersetzungen sie nicht ein zweites Mal treffen.

interface MonthToken {
  month: number; // 1–12
  lang: string;
  abbr: boolean;
}

const MONTH_TOKENS: Map<string, MonthToken> = (() => {
  const map = new Map<string, MonthToken>();
  for (const lang of Object.keys(NAMES)) {
    NAMES[lang].forEach((name, i) => {
      for (const v of [name, withEntities(name)]) {
        const key = v.toLowerCase();
        if (!map.has(key)) map.set(key, { month: i + 1, lang, abbr: false });
      }
    });
  }
  ABBR_DE.forEach((list, i) => {
    for (const a of list) {
      const key = a.toLowerCase();
      if (!map.has(key)) map.set(key, { month: i + 1, lang: "de", abbr: true });
    }
  });
  return map;
})();

const MONTH_ALT = Array.from(MONTH_TOKENS.keys())
  .sort((a, b) => b.length - a.length)
  .map(escapeRe)
  .join("|");

const RANGE_SEP = "(\\s*(?:-|–|—|&ndash;|&mdash;|\\/)\\s*|(?:\\s|&nbsp;)+(?:bis|und|à|au|to)(?:\\s|&nbsp;)+)";

export function monthDelta(src: MonthRef, dst: MonthRef): number {
  return (dst.year - src.year) * 12 + (dst.month - src.month);
}

export function addMonths(ref: MonthRef, delta: number): MonthRef {
  const idx = ref.year * 12 + (ref.month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

// "2026-10-15" → { year: 2026, month: 10 }
export function monthOfIso(iso: string): MonthRef | null {
  return parseMonth(String(iso || "").slice(0, 7));
}

function renderMonthToken(found: string, token: MonthToken, month: number, dot: string): string {
  let rep: string;
  let keepDot = dot;
  if (token.abbr) {
    rep = ABBR_DE[month - 1][0];
    // "Mai" hat keine Abkürzung mit Punkt.
    if (rep.toLowerCase() === NAMES.de[month - 1].toLowerCase()) keepDot = "";
  } else {
    rep = NAMES[token.lang][month - 1];
  }
  rep = matchCase(found, rep);
  if (found.indexOf("&") !== -1) rep = withEntities(rep);
  return rep + keepDot;
}

function shiftRanges(text: string, src: MonthRef, dst: MonthRef, keep: (s: string) => string): string {
  let out = text;
  const delta = monthDelta(src, dst);

  // Monatsnamen: "Okt-Dez 2026", "Oktober bis Dezember 2026", "Okt. 2026 – Jan. 2027".
  const nameRe = new RegExp(
    NOT_LETTER_BEFORE + "(" + MONTH_ALT + ")(\\.?)(?:((?:\\s|&nbsp;)+)(\\d{4}))?" + RANGE_SEP +
      "(" + MONTH_ALT + ")(\\.?)" + NOT_LETTER_AFTER + YEAR_TAIL,
    "giu",
  );
  out = out.replace(nameRe, (
    all,
    m1: string, dot1: string, sep1: string | undefined, y1: string | undefined,
    sep: string,
    m2: string, dot2: string, sep2: string | undefined, y2: string | undefined,
  ) => {
    const t1 = MONTH_TOKENS.get(m1.toLowerCase());
    const t2 = MONTH_TOKENS.get(m2.toLowerCase());
    if (!t1 || !t2 || t1.month !== src.month) return all;
    const wraps = t2.month < t1.month;
    let startYear: number | null = null;
    if (y1 !== undefined) startYear = Number(y1);
    else if (y2 !== undefined) startYear = Number(y2) - (wraps ? 1 : 0);
    if (startYear !== null && startYear !== src.year) return all;

    const baseYear = startYear === null ? src.year : startYear;
    const startIdx = baseYear * 12 + (t1.month - 1) + delta;
    const endIdx = (baseYear + (wraps ? 1 : 0)) * 12 + (t2.month - 1) + delta;
    const newStart = renderMonthToken(m1, t1, (startIdx % 12) + 1, dot1);
    const newEnd = renderMonthToken(m2, t2, (endIdx % 12) + 1, dot2);
    return keep(
      newStart + (y1 !== undefined ? sep1 + String(Math.floor(startIdx / 12)) : "") + sep +
        newEnd + (y2 !== undefined ? sep2 + String(Math.floor(endIdx / 12)) : ""),
    );
  });

  // Datumsbereiche: "01.10.2026 – 31.12.2026", "1.10. bis 31.12.2026".
  const dateRe = new RegExp(
    "(?<![\\d.])(\\d{1,2})\\.(0?" + src.month + ")\\.(\\d{4}|\\d{2})?" + RANGE_SEP +
      "(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4}|\\d{2})(?!\\d)",
    "g",
  );
  out = out.replace(dateRe, (
    all,
    d1: string, mo1: string, y1: string | undefined, sep: string,
    d2: string, mo2: string, y2: string,
  ) => {
    const day1 = Number(d1), day2 = Number(d2), month2 = Number(mo2);
    if (day1 < 1 || day1 > 31 || day2 < 1 || day2 > 31 || month2 < 1 || month2 > 12) return all;
    const fullYear = (y: string) => y.length === 4 ? Number(y) : 2000 + Number(y);
    const endYear = fullYear(y2);
    const startYear = y1 !== undefined ? fullYear(y1) : endYear - (month2 < src.month ? 1 : 0);
    if (startYear !== src.year) return all;

    const endIdx = endYear * 12 + (month2 - 1) + delta;
    const newEnd = { year: Math.floor(endIdx / 12), month: (endIdx % 12) + 1 };
    const newDay2 = shiftDay(day2, { year: endYear, month: month2 }, newEnd);
    const fmtYear = (y: number, like: string) => like.length === 4 ? String(y) : String(y).slice(2);
    return keep(
      pad(shiftDay(day1, src, dst), d1.length) + "." + pad(dst.month, mo1.length) + "." +
        (y1 !== undefined ? fmtYear(dst.year, y1) : "") + sep +
        pad(newDay2, d2.length) + "." + pad(newEnd.month, mo2.length) + "." + fmtYear(newEnd.year, y2),
    );
  });

  // Quartale: "Q4 2026", "4. Quartal 2026" — nur wenn um ganze Quartale
  // verschoben wird.
  if (delta % 3 === 0) {
    const srcQ = Math.floor((src.month - 1) / 3) + 1;
    const dstQ = Math.floor((dst.month - 1) / 3) + 1;
    const qRe = new RegExp(
      "(?<![\\p{L}\\d])(?:(Q)([1-4])|([1-4])(\\.\\s*Quartal))(?![\\p{L}\\d])(?:(\\s*\\/?\\s*|(?:\\s|&nbsp;)+)(\\d{4})(?!\\d))?",
      "giu",
    );
    out = out.replace(qRe, (
      all,
      qLetter: string | undefined, qNum1: string | undefined,
      qNum2: string | undefined, qWord: string | undefined,
      sep: string | undefined, year: string | undefined,
    ) => {
      const q = Number(qNum1 !== undefined ? qNum1 : qNum2);
      if (q !== srcQ) return all;
      if (year !== undefined && Number(year) !== src.year) return all;
      const head = qLetter !== undefined ? qLetter + String(dstQ) : String(dstQ) + qWord;
      return keep(head + (year !== undefined ? sep + String(dst.year) : ""));
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
    // Erst Zeiträume (als Platzhalter geschützt), dann Einzelangaben.
    const kept: string[] = [];
    const keep = (v: string) => "\u0000" + (kept.push(v) - 1) + "\u0000";
    let shifted = shiftRanges(part, src, dst, keep);
    shifted = shiftNames(shiftNumeric(shifted, src, dst), src, dst);
    parts[i] = shifted.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => kept[Number(idx)]);
  }
  return parts.join("");
}
