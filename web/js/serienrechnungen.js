// Serienrechnungen — Vorschau (nur lesen).
//
// Lädt über die Edge Function bexio-recurring-preview alle Rechnungen des
// Quellmonats und zeigt alt/neu nebeneinander. Erstellt wird hier noch
// nichts — das kommt in einem späteren Schritt.

var _srData = null;

// Auswahl: Rechnungs-ID → true/false. Nach dem Laden sind alle gewählt.
var _srSelected = {};

function srMonthString(date) {
  var m = date.getMonth() + 1;
  return date.getFullYear() + "-" + (m < 10 ? "0" + m : "" + m);
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

  var rows = '<div class="sr-row head"><div></div>' +
    "<div>Bisher (" + srEscape(srMonthLabel(_srData.source_month)) + ")</div>" +
    "<div>Neu (" + srEscape(srMonthLabel(_srData.target_month)) + ")</div></div>";

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
    ' onclick="event.stopPropagation()" onchange="srToggle(this)">' +
    '<div class="sr-item-contact">' + srEscape(inv.contact_name) +
    '<div class="sr-item-nr">Vorlage ' + srEscape(inv.document_nr) +
    (inv.status ? " · " + srEscape(inv.status) : "") + "</div></div>" +
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
    "</strong> Rechnung(en) geliefert, davon <strong>" + d.in_month_list + "</strong> mit Rechnungsdatum im " +
    srEscape(srMonthLabel(data.source_month)) + " (inkl. stornierte). Die Bexio-Suche fand " +
    d.in_month_search + "." + (d.list_truncated ? " Die Liste wurde wegen ihrer Grösse gekürzt." : "") + "</p>";

  if (monthRows) {
    html += '<table class="sr-diag-table"><thead><tr><th>Rechnungsdatum im</th><th class="num">Anzahl</th></tr></thead><tbody>' +
      monthRows + "</tbody></table>";
  }
  if (outsideRows) {
    html += '<p class="help-text">Rechnungen, die laut Schnittstelle nicht im ' +
      srEscape(srMonthLabel(data.source_month)) + " liegen:</p>" +
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
    srShowMessage("Im " + srMonthLabel(data.source_month) + " wurden in Bexio keine Rechnungen gefunden.", false);
    return;
  }

  var sum = 0;
  for (var i = 0; i < data.invoices.length; i++) sum += Number(data.invoices[i].total) || 0;

  var onlyUnchangedEl = document.getElementById("sr-only-unchanged");
  var onlyUnchanged = onlyUnchangedEl ? onlyUnchangedEl.checked : false;

  var html = "<h3>Vorschau " + srEscape(srMonthLabel(data.source_month)) + " → " +
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
    '<button id="sr-create-btn" class="btn btn-primary" disabled title="Folgt im nächsten Schritt">In Bexio erstellen</button>' +
    '<span class="help-text" style="margin-top: 0;">Das Erstellen folgt im nächsten Schritt. Aktuell nur Vorschau.</span>' +
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
    btn.textContent = count === 1 ? "1 Rechnung in Bexio erstellen" : count + " Rechnungen in Bexio erstellen";
  }
}

function srToggle(checkbox) {
  _srSelected[checkbox.getAttribute("data-id")] = checkbox.checked;
  srUpdateSelectionInfo();
}

function srApplySelection(fn) {
  if (!_srData) return;
  for (var i = 0; i < _srData.invoices.length; i++) {
    var inv = _srData.invoices[i];
    _srSelected[inv.id] = fn(inv);
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

async function loadRecurringPreview() {
  var sourceMonth = document.getElementById("sr-source-month").value;
  var targetMonth = document.getElementById("sr-target-month").value;
  var btn = document.getElementById("sr-load-btn");

  if (!sourceMonth || !targetMonth) {
    srShowMessage("Bitte beide Monate wählen.", true);
    return;
  }
  if (sourceMonth === targetMonth) {
    srShowMessage("Vorlage- und Zielmonat müssen verschieden sein.", true);
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
        source_month: sourceMonth,
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
    _srSelected = {};
    for (var k = 0; k < data.invoices.length; k++) _srSelected[data.invoices[k].id] = true;
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
  document.getElementById("sr-source-month").value = srMonthString(prev);
  document.getElementById("sr-target-month").value = srMonthString(now);
}

initSerienrechnungen();
