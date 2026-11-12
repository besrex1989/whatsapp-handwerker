// Serienrechnungen — Vorschau und Erstellen.
//
// Lädt über die Edge Function bexio-recurring-preview alle Rechnungen des
// Quellmonats und zeigt alt/neu nebeneinander (nur lesen). Der Knopf
// «In Bexio erstellen» legt die ausgewählten Rechnungen über
// bexio-recurring-create als Entwurf in Bexio an — in Paketen, mit
// Fortschrittsanzeige. Gestellt und versendet wird nichts.

var _srData = null;

// Auswahl: Rechnungs-ID → true/false. Nach dem Laden sind alle gewählt.
var _srSelected = {};

// Läuft gerade ein Erstell-Vorgang? Sperrt Knöpfe und Häkchen.
var _srCreating = false;

// Rechnungen pro Aufruf von bexio-recurring-create (Server-Limit: 10).
var SR_BATCH_SIZE = 5;

function srMonthString(date) {
  var m = date.getMonth() + 1;
  return date.getFullYear() + "-" + (m < 10 ? "0" + m : "" + m);
}

// "2026-10" + 3 → "2027-01"
function srAddMonths(ym, delta) {
  var parts = String(ym).split("-");
  var idx = Number(parts[0]) * 12 + (Number(parts[1]) - 1) + delta;
  var m = (idx % 12) + 1;
  return Math.floor(idx / 12) + "-" + (m < 10 ? "0" + m : "" + m);
}

function srMonthDelta(fromYm, toYm) {
  var a = String(fromYm).split("-"), b = String(toYm).split("-");
  return (Number(b[0]) - Number(a[0])) * 12 + (Number(b[1]) - Number(a[1]));
}

function srIsoDate(date) {
  var m = date.getMonth() + 1, d = date.getDate();
  return date.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (d < 10 ? "0" + d : d);
}

// "01.10.2026 – 31.12.2026"
function srRangeLabel(from, to) {
  return srFormatDate(from) + " – " + srFormatDate(to);
}

// Erklärt unter den Eingabefeldern, welcher Monat zu welchem wird.
function srUpdateRangeHint() {
  var el = document.getElementById("sr-range-hint");
  if (!el) return;
  var from = document.getElementById("sr-source-from").value;
  var to = document.getElementById("sr-source-to").value;
  var target = document.getElementById("sr-target-month").value;
  if (!from || !to || !/^\d{4}-\d{2}$/.test(target) || from > to) { el.textContent = ""; return; }

  var first = from.slice(0, 7), last = to.slice(0, 7);
  var delta = srMonthDelta(first, target);
  if (delta === 0) { el.textContent = ""; return; }

  var pairs = [];
  var count = srMonthDelta(first, last) + 1;
  for (var i = 0; i < count && i < 3; i++) {
    var ym = srAddMonths(first, i);
    pairs.push(srMonthLabel(ym) + " → " + srMonthLabel(srAddMonths(ym, delta)));
  }
  if (count > 3) pairs.push("… " + srMonthLabel(last) + " → " + srMonthLabel(srAddMonths(last, delta)));
  el.textContent = "Verschiebung um " + Math.abs(delta) + (Math.abs(delta) === 1 ? " Monat" : " Monate") +
    (delta < 0 ? " zurück" : "") + ": " + pairs.join(", ");
}

function srMonthLabel(ym) {
  var parts = String(ym).split("-");
  var d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
  return d.toLocaleDateString("de-CH", { month: "long", year: "numeric" });
}

function srEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Bexio liefert HTML (<br />, <strong>, Entities). Für die Anzeige in
// reinen Text umwandeln. DOMParser-Dokumente sind inert: keine Scripts,
// keine Bild-Requests.
function srHtmlToText(html) {
  if (!html) return "";
  var prepared = String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n");
  var doc = new DOMParser().parseFromString(prepared, "text/html");
  return (doc.body.textContent || "").replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Neuer Text mit Markierung der geänderten Wörter. Die Ersetzung lässt
// die Wortanzahl normalerweise gleich → Vergleich Wort für Wort. Weicht
// die Anzahl ab, zeigen wir den Text ohne Markierung.
function srHighlight(oldText, newText) {
  var oldTokens = oldText.split(/(\s+)/);
  var newTokens = newText.split(/(\s+)/);
  if (oldTokens.length !== newTokens.length) return srEscape(newText);
  var out = "";
  for (var i = 0; i < newTokens.length; i++) {
    if (newTokens[i] !== oldTokens[i]) {
      out += "<mark>" + srEscape(newTokens[i]) + "</mark>";
    } else {
      out += srEscape(newTokens[i]);
    }
  }
  return out;
}

function srFormatDate(iso) {
  if (!iso) return "—";
  var p = String(iso).slice(0, 10).split("-");
  if (p.length !== 3) return iso;
  return p[2] + "." + p[1] + "." + p[0];
}

function srFormatAmount(value) {
  var n = Number(value);
  if (value == null || isNaN(n)) return "—";
  return n.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function srShowMessage(text, isError) {
  var el = document.getElementById("sr-message");
  if (!text) { el.style.display = "none"; return; }
  el.textContent = text;
  el.className = "sr-message" + (isError ? " error" : "");
  el.style.display = "block";
}

function srTextRow(label, pair, metaHtml) {
  var oldText = srHtmlToText(pair.old);
  var newText = srHtmlToText(pair["new"]);
  if (!oldText && !newText) return "";
  return '<div class="sr-row">' +
    '<div class="sr-row-label">' + srEscape(label) + (metaHtml || "") + "</div>" +
    '<div class="sr-old">' + srEscape(oldText) + "</div>" +
    '<div class="sr-new">' + srHighlight(oldText, newText) + "</div>" +
    "</div>";
}

function srRenderInvoice(inv) {
  var newTitle = srHtmlToText(inv.title["new"]) || "(ohne Titel)";
  var oldTitle = srHtmlToText(inv.title.old) || "(ohne Titel)";
  var badge = inv.text_changed ? "" : '<span class="sr-badge">Kein Monat erkannt</span>';
  if (inv.already_created) {
    badge += '<span class="sr-badge done">' +
      (inv.just_created ? "Erstellt" : "Bereits erstellt") +
      (inv.already_created.document_nr ? ": " + srEscape(inv.already_created.document_nr) : "") +
      (inv.already_created.status ? " (" + srEscape(inv.already_created.status) + ")" : "") + "</span>";
  }
  if (inv.total_warning) {
    badge += '<span class="sr-badge">Total weicht ab: ' + srEscape(srFormatAmount(inv.total_warning)) + "</span>";
  }
  if (inv.create_error) {
    badge += '<span class="sr-badge error">Fehler: ' + srEscape(inv.create_error) + "</span>";
  }

  var rows = '<div class="sr-row head"><div></div>' +
    "<div>Bisher (" + srEscape(srMonthLabel(inv.source_month)) + ")</div>" +
    "<div>Neu (" + srEscape(srMonthLabel(inv.target_month)) + ")</div></div>";

  rows += '<div class="sr-row">' +
    '<div class="sr-row-label">Rechnungsdatum</div>' +
    '<div class="sr-old">' + srEscape(srFormatDate(inv.valid_from.old)) + "</div>" +
    '<div class="sr-new">' + srHighlight(srFormatDate(inv.valid_from.old), srFormatDate(inv.valid_from["new"])) + "</div></div>";
  rows += '<div class="sr-row">' +
    '<div class="sr-row-label">Zahlbar bis</div>' +
    '<div class="sr-old">' + srEscape(srFormatDate(inv.valid_to.old)) + "</div>" +
    '<div class="sr-new">' + srHighlight(srFormatDate(inv.valid_to.old), srFormatDate(inv.valid_to["new"])) + "</div></div>";

  rows += srTextRow("Titel", inv.title);
  rows += srTextRow("Kopftext", inv.header);
  for (var i = 0; i < inv.positions.length; i++) {
    var p = inv.positions[i];
    var meta = "";
    if (p.unit_price != null && p.amount != null) {
      meta = '<span class="sr-pos-meta">' + srEscape(srFormatAmount(p.amount)) + " × " +
        srEscape(srFormatAmount(p.unit_price)) + "</span>";
    }
    rows += srTextRow("Position " + (i + 1), p.text, meta);
  }
  rows += srTextRow("Fusstext", inv.footer);

  return '<details class="sr-item' + (inv.text_changed ? "" : " unchanged") + '">' +
    "<summary>" +
    '<input type="checkbox" class="sr-check" aria-label="Rechnung auswählen" data-id="' + srEscape(inv.id) + '"' +
    (_srSelected[inv.id] ? " checked" : "") +
    (inv.already_created || _srCreating ? " disabled" : "") +
    ' onclick="event.stopPropagation()" onchange="srToggle(this)">' +
    '<div class="sr-item-contact">' + srEscape(inv.contact_name) +
    '<div class="sr-item-nr">Vorlage ' + srEscape(inv.document_nr) +
    (inv.status ? " · " + srEscape(inv.status) : "") +
    (_srData.multi_month
      ? ' · <span class="sr-month-tag">' + srEscape(srMonthLabel(inv.source_month)) + " → " +
        srEscape(srMonthLabel(inv.target_month)) + "</span>"
      : "") + "</div></div>" +
    '<div class="sr-item-title">' + srHighlight(oldTitle, newTitle) + badge + "</div>" +
    '<div class="sr-item-total">' + srEscape(srFormatAmount(inv.total)) + "</div>" +
    "</summary>" +
    '<div class="sr-detail">' + rows + "</div>" +
    "</details>";
}

// Abgleich mit Bexio: zeigt, was die Schnittstelle insgesamt geliefert
// hat und welche Rechnungen laut Schnittstelle nicht im Vorlagemonat
// liegen. Hilft, wenn in Bexio mehr Rechnungen sichtbar sind als hier.
function srRenderDiagnostics(data) {
  var d = data.diagnostics;
  if (!d) return "";

  var months = Object.keys(d.by_month || {}).sort().reverse();
  var monthRows = "";
  for (var i = 0; i < months.length; i++) {
    var label = /^\d{4}-\d{2}$/.test(months[i]) ? srMonthLabel(months[i]) : months[i];
    monthRows += "<tr><td>" + srEscape(label) + '</td><td class="num">' + d.by_month[months[i]] + "</td></tr>";
  }

  var outsideRows = "";
  var outside = d.outside || [];
  for (var j = 0; j < outside.length; j++) {
    var o = outside[j];
    outsideRows += "<tr><td>" + srEscape(o.document_nr) + "</td><td>" + srEscape(srFormatDate(o.date)) +
      "</td><td>" + srEscape(o.status) + "</td><td>" + srEscape(srHtmlToText(o.title)) +
      '</td><td class="num">' + srEscape(srFormatAmount(o.total)) + "</td></tr>";
  }

  var html = '<details class="sr-diag"><summary>Abgleich mit Bexio</summary>' +
    '<p class="help-text">Bexio hat über die Schnittstelle insgesamt <strong>' + d.list_total +
    "</strong> Rechnung(en) geliefert, davon <strong>" + d.in_month_list + "</strong> mit Rechnungsdatum im Zeitraum " +
    srEscape(srRangeLabel(data.source_from, data.source_to)) + " (inkl. stornierte)." + (d.list_truncated ? " Die Liste wurde wegen ihrer Grösse gekürzt." : "") + "</p>";

  if (monthRows) {
    html += '<table class="sr-diag-table"><thead><tr><th>Rechnungsdatum im</th><th class="num">Anzahl</th></tr></thead><tbody>' +
      monthRows + "</tbody></table>";
  }
  if (outsideRows) {
    html += '<p class="help-text">Rechnungen, die laut Schnittstelle nicht im Zeitraum ' +
      srEscape(srRangeLabel(data.source_from, data.source_to)) + " liegen:</p>" +
      '<table class="sr-diag-table"><thead><tr><th>Nr.</th><th>Datum</th><th>Status</th><th>Titel</th><th class="num">Total</th></tr></thead><tbody>' +
      outsideRows + "</tbody></table>";
  }
  return html + "</details>";
}

function srRender() {
  var summaryEl = document.getElementById("sr-summary");
  var listEl = document.getElementById("sr-list");
  var data = _srData;
  if (!data) { summaryEl.style.display = "none"; listEl.innerHTML = ""; return; }

  var s = data.summary;
  if (s.total === 0) {
    summaryEl.style.display = "none";
    listEl.innerHTML = "";
    srShowMessage("Im Zeitraum " + srRangeLabel(data.source_from, data.source_to) +
      " wurden in Bexio keine Rechnungen gefunden.", false);
    return;
  }

  var sum = 0;
  for (var i = 0; i < data.invoices.length; i++) sum += Number(data.invoices[i].total) || 0;

  var onlyUnchangedEl = document.getElementById("sr-only-unchanged");
  var onlyUnchanged = onlyUnchangedEl ? onlyUnchangedEl.checked : false;

  var html = "<h3>Vorschau " + srEscape(srRangeLabel(data.source_from, data.source_to)) + " → ab " +
    srEscape(srMonthLabel(data.target_month)) + "</h3>" +
    '<div class="sr-stats">' +
    '<div class="sr-stat"><div class="sr-stat-value">' + s.total + '</div><div class="sr-stat-label">Rechnungen</div></div>' +
    '<div class="sr-stat"><div class="sr-stat-value">' + s.text_changed + '</div><div class="sr-stat-label">Text angepasst</div></div>' +
    '<div class="sr-stat' + (s.text_unchanged > 0 ? " warn" : "") + '"><div class="sr-stat-value">' + s.text_unchanged +
    '</div><div class="sr-stat-label">Kein Monat erkannt</div></div>' +
    '<div class="sr-stat"><div class="sr-stat-value">' + srEscape(srFormatAmount(sum)) + '</div><div class="sr-stat-label">Summe Total</div></div>' +
    "</div>";

  var notes = [];
  if (s.text_unchanged > 0) {
    notes.push("Bei " + s.text_unchanged + " Rechnung(en) wurde im Text keine Monatsangabe gefunden. " +
      "Diese würden mit unverändertem Text kopiert – bitte prüfen.");
  }
  var doneCount = 0;
  for (var a = 0; a < data.invoices.length; a++) if (data.invoices[a].already_created) doneCount++;
  if (doneCount > 0) {
    notes.push(doneCount + " Rechnung(en) wurden für den Zielzeitraum bereits erstellt und können nicht nochmals gewählt werden.");
  }
  if (s.canceled_skipped > 0) {
    notes.push(s.canceled_skipped + " stornierte Rechnung(en) wurden ausgelassen.");
  }
  if (s.truncated) {
    notes.push("Es gibt mehr Rechnungen als auf einmal angezeigt werden können. Die Liste ist gekürzt.");
  }
  for (var n = 0; n < notes.length; n++) {
    html += '<p class="help-text sr-summary-note">' + srEscape(notes[n]) + "</p>";
  }

  html += '<div class="sr-summary-actions">' +
    '<span id="sr-selection-info" class="sr-selection-info"></span>' +
    '<button class="btn btn-outline sr-btn-small" onclick="srSelectAll(true)">Alle</button>' +
    '<button class="btn btn-outline sr-btn-small" onclick="srSelectAll(false)">Keine</button>' +
    (s.text_unchanged > 0 && s.text_changed > 0
      ? '<button class="btn btn-outline sr-btn-small" onclick="srSelectChangedOnly()">Nur mit angepasstem Text</button>'
      : "") +
    "</div>";
  html += '<div class="sr-summary-actions">' +
    '<button id="sr-create-btn" class="btn btn-primary" onclick="srCreateSelected()">In Bexio erstellen</button>' +
    '<span class="help-text" style="margin-top: 0;">Legt Entwürfe in Bexio an. Gestellt und versendet wird nichts.</span>' +
    "</div>";
  if (s.text_unchanged > 0) {
    html += '<div class="sr-summary-actions"><label class="sr-filter">' +
      '<input type="checkbox" id="sr-only-unchanged"' + (onlyUnchanged ? " checked" : "") +
      ' onchange="srRender()"> Nur Rechnungen ohne erkannten Monat anzeigen</label></div>';
  }

  html += srRenderDiagnostics(data);

  summaryEl.innerHTML = html;
  summaryEl.style.display = "block";

  var items = "";
  for (var j = 0; j < data.invoices.length; j++) {
    if (onlyUnchanged && data.invoices[j].text_changed) continue;
    items += srRenderInvoice(data.invoices[j]);
  }
  listEl.innerHTML = items;
  srUpdateSelectionInfo();
}

// Zähler und Summe der Auswahl aktualisieren, ohne die Liste neu zu
// zeichnen (aufgeklappte Rechnungen bleiben offen).
function srUpdateSelectionInfo() {
  if (!_srData) return;
  var count = 0, sum = 0;
  for (var i = 0; i < _srData.invoices.length; i++) {
    var inv = _srData.invoices[i];
    if (_srSelected[inv.id]) { count++; sum += Number(inv.total) || 0; }
  }
  var infoEl = document.getElementById("sr-selection-info");
  if (infoEl) {
    infoEl.textContent = count + " von " + _srData.invoices.length + " ausgewählt · Summe " + srFormatAmount(sum);
  }
  var btn = document.getElementById("sr-create-btn");
  if (btn) {
    btn.textContent = _srCreating ? "Wird erstellt …"
      : count === 1 ? "1 Rechnung in Bexio erstellen" : count + " Rechnungen in Bexio erstellen";
    btn.disabled = _srCreating || count === 0;
  }
}

function srToggle(checkbox) {
  _srSelected[checkbox.getAttribute("data-id")] = checkbox.checked;
  srUpdateSelectionInfo();
}

function srApplySelection(fn) {
  if (!_srData || _srCreating) return;
  for (var i = 0; i < _srData.invoices.length; i++) {
    var inv = _srData.invoices[i];
    // Bereits erstellte Rechnungen sind nie wählbar.
    _srSelected[inv.id] = inv.already_created ? false : fn(inv);
  }
  var boxes = document.querySelectorAll(".sr-check");
  for (var j = 0; j < boxes.length; j++) {
    boxes[j].checked = !!_srSelected[boxes[j].getAttribute("data-id")];
  }
  srUpdateSelectionInfo();
}

function srSelectAll(value) {
  srApplySelection(function () { return value; });
}

function srSelectChangedOnly() {
  srApplySelection(function (inv) { return inv.text_changed; });
}

// Tenant-ID und Access-Token des angemeldeten Users. Leitet bei
// fehlender Session auf die Login-Seite um und liefert dann null.
async function srGetContext() {
  var sessionResult = await supabase.auth.getSession();
  var session = sessionResult.data.session;
  if (!session) { window.location.href = "login.html"; return null; }

  var tenantResult = await supabase
    .from("tenants").select("id")
    .ilike("email", escapeLikePattern(session.user.email))
    .limit(1).maybeSingle();
  if (tenantResult.error || !tenantResult.data) {
    srShowMessage("Konto nicht gefunden.", true);
    return null;
  }
  return { tenantId: tenantResult.data.id, accessToken: session.access_token };
}

function srFindInvoice(id) {
  for (var i = 0; i < _srData.invoices.length; i++) {
    if (String(_srData.invoices[i].id) === String(id)) return _srData.invoices[i];
  }
  return null;
}

// Erstellt die ausgewählten Rechnungen als Entwurf in Bexio. Läuft in
// Paketen, damit die Edge Function nicht ins Timeout läuft und der
// Fortschritt sichtbar ist. Bricht ein Paket ab, bleiben die bereits
// erstellten Rechnungen bestehen; ein erneuter Klick erstellt nur die
// fehlenden (Doppel-Schutz auf dem Server).
async function srCreateSelected() {
  if (!_srData || _srCreating) return;

  var ids = [];
  for (var i = 0; i < _srData.invoices.length; i++) {
    var inv = _srData.invoices[i];
    if (_srSelected[inv.id] && !inv.already_created) ids.push(inv.id);
  }
  if (ids.length === 0) return;

  var targetLabel = (_srData.multi_month ? "ab " : "für ") + srMonthLabel(_srData.target_month);
  var question = (ids.length === 1 ? "1 Rechnung" : ids.length + " Rechnungen") +
    " " + targetLabel + " als Entwurf in Bexio erstellen?";
  if (!confirm(question)) return;

  _srCreating = true;
  var created = 0, existed = 0, failed = 0, warned = 0;
  var fatal = "";
  srRender();

  try {
    var ctx = await srGetContext();
    if (!ctx) return;

    for (var start = 0; start < ids.length; start += SR_BATCH_SIZE) {
      var batch = ids.slice(start, start + SR_BATCH_SIZE);
      srShowMessage("Rechnungen werden in Bexio erstellt: " + start + " von " + ids.length +
        " erledigt. Bitte das Fenster nicht schliessen …", false);

      var resp = await fetch(SUPABASE_URL + "/functions/v1/bexio-recurring-create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + ctx.accessToken,
        },
        body: JSON.stringify({
          tenant_id: ctx.tenantId,
          source_from: _srData.source_from,
          source_to: _srData.source_to,
          target_month: _srData.target_month,
          invoice_ids: batch,
        }),
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        fatal = data.error || ("Fehler (HTTP " + resp.status + ")");
        break;
      }

      var results = data.results || [];
      for (var r = 0; r < results.length; r++) {
        var res = results[r];
        var target = srFindInvoice(res.source_id);
        if (!target) continue;
        target.create_error = "";
        if (res.status === "created" || res.status === "exists") {
          target.already_created = { id: res.new_id, document_nr: res.new_document_nr, status: "Entwurf" };
          target.just_created = res.status === "created";
          _srSelected[target.id] = false;
          if (res.status === "created") {
            created++;
            if (res.total_matches === false) { target.total_warning = res.new_total; warned++; }
          } else {
            existed++;
          }
        } else {
          target.create_error = res.error || "Unbekannter Fehler";
          failed++;
        }
      }
      srRender();
    }
  } catch (err) {
    console.error("[srCreateSelected] exception:", err);
    fatal = "Netzwerkfehler: " + err.message;
  } finally {
    _srCreating = false;
    srRender();
  }

  var parts = [created + " Rechnung(en) als Entwurf in Bexio erstellt."];
  if (existed > 0) parts.push(existed + " waren bereits vorhanden.");
  if (warned > 0) parts.push("Bei " + warned + " weicht das Total von der Vorlage ab – bitte in Bexio prüfen.");
  if (failed > 0) parts.push(failed + " konnten nicht erstellt werden (siehe rote Markierung in der Liste).");
  if (fatal) parts.push("Abgebrochen: " + fatal + " Bereits erstellte Rechnungen bleiben bestehen; ein erneuter Klick erstellt nur die fehlenden.");
  srShowMessage(parts.join(" "), failed > 0 || !!fatal);
}

async function loadRecurringPreview() {
  var sourceFrom = document.getElementById("sr-source-from").value;
  var sourceTo = document.getElementById("sr-source-to").value;
  var targetMonth = document.getElementById("sr-target-month").value;
  var btn = document.getElementById("sr-load-btn");

  if (_srCreating) return;
  if (!sourceFrom || !sourceTo || !targetMonth) {
    srShowMessage("Bitte Von-Datum, Bis-Datum und Zielmonat wählen.", true);
    return;
  }
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
    srShowMessage("Bitte den Zielmonat im Format JJJJ-MM angeben, z. B. 2027-01.", true);
    return;
  }
  if (sourceFrom > sourceTo) {
    srShowMessage("Das Von-Datum liegt nach dem Bis-Datum.", true);
    return;
  }
  if (sourceFrom.slice(0, 7) === targetMonth) {
    srShowMessage("Der Zielmonat muss sich vom ersten Monat des Zeitraums unterscheiden.", true);
    return;
  }

  _srData = null;
  srRender();
  srShowMessage("Rechnungen werden aus Bexio geladen. Das kann bei vielen Rechnungen bis zu einer Minute dauern …", false);
  btn.disabled = true;

  try {
    var sessionResult = await supabase.auth.getSession();
    var session = sessionResult.data.session;
    if (!session) { window.location.href = "login.html"; return; }

    var tenantResult = await supabase
      .from("tenants").select("id")
      .ilike("email", escapeLikePattern(session.user.email))
      .limit(1).maybeSingle();
    if (tenantResult.error || !tenantResult.data) {
      srShowMessage("Konto nicht gefunden.", true);
      return;
    }

    var resp = await fetch(SUPABASE_URL + "/functions/v1/bexio-recurring-preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + session.access_token,
      },
      body: JSON.stringify({
        tenant_id: tenantResult.data.id,
        source_from: sourceFrom,
        source_to: sourceTo,
        target_month: targetMonth,
      }),
    });

    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) {
      srShowMessage(data.error || ("Fehler (HTTP " + resp.status + ")"), true);
      return;
    }

    srShowMessage("", false);
    _srData = data;
    // Mehrere Vorlagemonate → pro Rechnung anzeigen, welcher Monat zu welchem wird.
    _srData.multi_month = data.source_from.slice(0, 7) !== data.source_to.slice(0, 7);
    _srSelected = {};
    for (var k = 0; k < data.invoices.length; k++) {
      _srSelected[data.invoices[k].id] = !data.invoices[k].already_created;
    }
    srRender();
  } catch (err) {
    console.error("[loadRecurringPreview] exception:", err);
    srShowMessage("Netzwerkfehler: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function initSerienrechnungen() {
  var user = await checkAuth();
  if (!user) { window.location.href = "login.html"; return; }

  var emailEl = document.getElementById("user-email");
  if (emailEl) emailEl.textContent = user.email;

  // Standard: Vormonat → aktueller Monat.
  var now = new Date();
  var prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var prevLast = new Date(now.getFullYear(), now.getMonth(), 0);
  document.getElementById("sr-source-from").value = srIsoDate(prev);
  document.getElementById("sr-source-to").value = srIsoDate(prevLast);
  document.getElementById("sr-target-month").value = srMonthString(now);
  srUpdateRangeHint();
}

initSerienrechnungen();
