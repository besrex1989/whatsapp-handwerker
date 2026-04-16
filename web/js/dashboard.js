// Dashboard logic — loads tenant data and displays it

async function loadDashboard() {
  var user = await checkAuth();
  if (!user) return;

  // Show user email
  var emailEl = document.getElementById("user-email");
  if (emailEl) {
    emailEl.textContent = user.email;
  }

  // Load tenant data.
  //
  // We match on email case-insensitively (.ilike with escaped LIKE wildcards)
  // because the tenants.email column has historically been stored with mixed
  // casing, while auth.users.email for the current session may differ in
  // case. The RLS SELECT policy is already case-insensitive — using .ilike
  // keeps the client filter consistent with it. .maybeSingle() returns
  // { data: null } instead of a PGRST116 error when no row matches, and
  // .limit(1) guards against the (theoretical) multi-row case so we never
  // surface the confusing "Cannot coerce the result to a single JSON object"
  // alert to the user.
  var result = await supabase
    .from("tenants")
    .select("*")
    .ilike("email", escapeLikePattern(user.email))
    .limit(1)
    .maybeSingle();

  var tenant = result.data;

  if (!tenant) {
    document.getElementById("greeting").textContent = "Willkommen!";
    return;
  }

  // Greeting
  var greetingEl = document.getElementById("greeting");
  if (greetingEl) {
    greetingEl.textContent = "Hallo" + (tenant.full_name ? ", " + tenant.full_name : "") + "!";
  }

  // Plan
  var planBadge = document.getElementById("plan-badge");
  var planRaw = tenant.plan || "trial";
  // "active_monthly" / "active_yearly" from stripe-webhook both count as active
  var isActive = planRaw === "active" || planRaw.indexOf("active_") === 0;
  if (planBadge) {
    var label = planRaw === "active_monthly" ? "Monatlich"
      : planRaw === "active_yearly" ? "Jaehrlich"
      : planRaw.charAt(0).toUpperCase() + planRaw.slice(1);
    planBadge.textContent = label;
    planBadge.className = "status-badge";
    if (planRaw === "trial") {
      planBadge.classList.add("trial");
    } else if (isActive) {
      planBadge.classList.add("active");
    } else {
      planBadge.classList.add("inactive");
    }
  }

  // Abo-Karte füllen
  renderSubscriptionCard(tenant, planRaw, isActive);

  // Trial end
  var trialEndEl = document.getElementById("trial-end");
  if (trialEndEl && tenant.trial_ends_at) {
    var d = new Date(tenant.trial_ends_at);
    trialEndEl.textContent = d.toLocaleDateString("de-CH");
  }

  // Name + email (read-only display; edits go through changeFullName / changeEmail)
  var nameEl = document.getElementById("tenant-name");
  if (nameEl) nameEl.textContent = tenant.full_name || "—";
  var emailEl2 = document.getElementById("tenant-email");
  if (emailEl2) emailEl2.textContent = tenant.email || user.email || "—";

  // WhatsApp number
  var whatsappEl = document.getElementById("whatsapp-nr");
  if (whatsappEl) {
    whatsappEl.textContent = tenant.whatsapp_number || "—";
  }

  // Bexio status
  var bexioStatus = document.getElementById("bexio-status");
  var bexioBtn = document.getElementById("bexio-connect-btn");
  var bexioDisconnectBtn = document.getElementById("bexio-disconnect-btn");
  var bexioAccountBlock = document.getElementById("bexio-account-block");
  if (bexioStatus) {
    if (tenant.bexio_access_token) {
      bexioStatus.textContent = "Verbunden";
      bexioStatus.className = "status-badge active";
      if (bexioBtn) {
        bexioBtn.textContent = "Neu verbinden";
        bexioBtn.className = "btn btn-outline";
      }
      if (bexioDisconnectBtn) bexioDisconnectBtn.style.display = "";
      if (bexioAccountBlock) {
        bexioAccountBlock.style.display = "";
        // Fire-and-forget: load accounts into the dropdown. Don't await —
        // we don't want to block the rest of the dashboard render.
        loadBexioAccounts(tenant.id);
      }
    } else {
      bexioStatus.textContent = "Nicht verbunden";
      bexioStatus.className = "status-badge inactive";
      if (bexioBtn) {
        bexioBtn.textContent = "Mit Bexio verbinden";
        bexioBtn.className = "btn btn-primary";
      }
      if (bexioDisconnectBtn) bexioDisconnectBtn.style.display = "none";
      if (bexioAccountBlock) bexioAccountBlock.style.display = "none";
    }
  }

  // Bot number + WhatsApp deep link (wa.me expects digits only, no "+" or spaces)
  var botNrEl = document.getElementById("bot-number");
  var botLinkEl = document.getElementById("bot-whatsapp-link");
  if (typeof BOT_WHATSAPP_NUMBER !== "undefined") {
    if (botNrEl) botNrEl.textContent = BOT_WHATSAPP_NUMBER;
    if (botLinkEl) {
      var digits = String(BOT_WHATSAPP_NUMBER).replace(/\D/g, "");
      botLinkEl.href = "https://wa.me/" + digits + "?text=" + encodeURIComponent("hilfe");
    }
  }
}

// Change full name (or company name)
async function changeFullName() {
  var user = await checkAuth();
  if (!user) { alert("Nicht angemeldet."); return; }

  var currentEl = document.getElementById("tenant-name");
  var current = currentEl ? currentEl.textContent : "";
  var input = prompt(
    "Neuen Namen eingeben (Vorname Nachname oder Firmenname):",
    current && current !== "—" ? current : ""
  );
  if (input === null) return; // cancelled
  input = String(input).trim();
  if (!input) { alert("Bitte einen Namen eingeben."); return; }

  var updateResult = await supabase
    .from("tenants")
    .update({ full_name: input, updated_at: new Date().toISOString() })
    .ilike("email", escapeLikePattern(user.email));

  if (updateResult.error) {
    alert("Fehler beim Speichern: " + updateResult.error.message);
    return;
  }

  // Also keep the name in the auth user metadata in sync so it stays
  // consistent if we ever re-seed the tenant from metadata.
  await supabase.auth.updateUser({ data: { full_name: input } });

  loadDashboard();
}

// Change email address.
// Supabase sends a confirmation link to the NEW address; only after the user
// clicks it does auth.users.email actually change. A database trigger then
// mirrors the new email onto the tenants row (see migration 007).
async function changeEmail() {
  var user = await checkAuth();
  if (!user) { alert("Nicht angemeldet."); return; }

  var input = prompt(
    "Neue E-Mail-Adresse eingeben:\n\n" +
    "Wir senden dir einen Bestätigungs-Link an die neue Adresse. " +
    "Die Änderung wird erst aktiv, nachdem du den Link geklickt hast.",
    user.email || ""
  );
  if (input === null) return;
  input = String(input).trim().toLowerCase();
  if (!input) { alert("Bitte eine E-Mail eingeben."); return; }
  if (input === String(user.email || "").toLowerCase()) {
    alert("Das ist bereits deine aktuelle E-Mail-Adresse.");
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) {
    alert("Bitte eine gültige E-Mail-Adresse eingeben.");
    return;
  }

  var result = await supabase.auth.updateUser({ email: input });
  if (result.error) {
    alert("Fehler: " + result.error.message);
    return;
  }

  alert(
    "Bestätigungs-Link gesendet an " + input + ".\n\n" +
    "Bitte klicke den Link in der E-Mail, um die Änderung abzuschliessen. " +
    "Danach musst du dich mit der neuen Adresse einloggen."
  );
}

// Change WhatsApp number
async function changeWhatsappNumber() {
  var user = await checkAuth();
  if (!user) { alert("Nicht angemeldet."); return; }

  var currentEl = document.getElementById("whatsapp-nr");
  var current = currentEl ? currentEl.textContent : "";
  var input = prompt(
    "Neue WhatsApp-Nummer eingeben\n(Format: 076 344 98 00 oder +41 76 344 98 00):",
    current && current !== "—" ? current : ""
  );
  if (input === null) return; // cancelled

  var norm = normalizePhoneCH(input);
  if (!norm.ok) {
    alert(norm.error);
    return;
  }

  var updateResult = await supabase
    .from("tenants")
    .update({ whatsapp_number: norm.phone, updated_at: new Date().toISOString() })
    .ilike("email", escapeLikePattern(user.email));

  if (updateResult.error) {
    // Most likely cause: another tenant already owns that number (unique constraint)
    if (String(updateResult.error.message || "").toLowerCase().indexOf("duplicate") >= 0
        || updateResult.error.code === "23505") {
      alert("Diese Nummer ist bereits bei einem anderen Konto registriert.");
    } else {
      alert("Fehler beim Speichern: " + updateResult.error.message);
    }
    return;
  }

  alert("Nummer aktualisiert: " + norm.phone);
  loadDashboard();
}

// Disconnect Bexio
async function disconnectBexio() {
  var user = await checkAuth();
  if (!user) { alert("Nicht angemeldet."); return; }

  if (!confirm("Bexio-Verbindung wirklich trennen? Der Bot kann dann bis zur erneuten Verbindung keine Rechnungen mehr erstellen.")) {
    return;
  }

  var btn = document.getElementById("bexio-disconnect-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Trennt..."; }

  var updateResult = await supabase
    .from("tenants")
    .update({
      bexio_access_token: null,
      bexio_refresh_token: null,
      bexio_expires_at: null,
      // Clear cached per-instance IDs as well; the next invoice creation
      // will re-fetch them from the newly connected Bexio instance.
      bexio_user_id: null,
      bexio_account_id: null,
      bexio_tax_id: null,
      updated_at: new Date().toISOString(),
    })
    .ilike("email", escapeLikePattern(user.email));

  if (btn) { btn.disabled = false; btn.textContent = "Verbindung trennen"; }

  if (updateResult.error) {
    alert("Fehler: " + updateResult.error.message);
    return;
  }

  alert("Bexio-Verbindung getrennt.");
  loadDashboard();
}

// Connect Bexio
async function connectBexio() {
  var btn = document.getElementById("bexio-connect-btn");
  var originalLabel = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Verbinde..."; }

  try {
    var user = await checkAuth();
    if (!user) { alert("Nicht angemeldet."); return; }

    // Get tenant ID — case-insensitive match to tolerate historical
    // mixed-case emails; .maybeSingle() keeps "no tenant yet" as a clean
    // null result instead of a PGRST116 error.
    var result = await supabase
      .from("tenants")
      .select("id")
      .ilike("email", escapeLikePattern(user.email))
      .limit(1)
      .maybeSingle();

    if (result.error) {
      alert("Tenant-Abfrage fehlgeschlagen: " + result.error.message);
      return;
    }
    if (!result.data) {
      alert("Tenant nicht gefunden.");
      return;
    }

    // Current user's access token (sent to Edge Function as Bearer)
    var sessionResult = await supabase.auth.getSession();
    var accessToken = sessionResult.data.session
      ? sessionResult.data.session.access_token
      : SUPABASE_ANON_KEY;

    // The Vercel-hosted callback page that Bexio has registered as redirect URI
    var callbackUrl = window.location.origin + "/bexio-callback.html";

    // Call Bexio OAuth Edge Function to get auth URL
    var resp;
    try {
      resp = await fetch(
        SUPABASE_URL + "/functions/v1/bexio-oauth",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": "Bearer " + accessToken,
          },
          body: JSON.stringify({
            tenant_id: result.data.id,
            redirect_uri: callbackUrl,
          }),
        }
      );
    } catch (netErr) {
      console.error("[connectBexio] network error:", netErr);
      alert("Netzwerkfehler: " + netErr.message);
      return;
    }

    if (!resp.ok) {
      var errBody = await resp.text();
      console.error("[connectBexio] response not ok", resp.status, errBody);
      alert("Fehler beim Verbinden mit Bexio (" + resp.status + "): " + errBody);
      return;
    }

    var data = await resp.json();
    if (!data.url) {
      alert("Keine Auth-URL erhalten.");
      return;
    }
    window.location.href = data.url;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

// ===== Bexio Erlöskonto Präferenz =====

// Remember the tenant id so saveRevenueAccountPreference() can reuse it
// without having to re-query tenants.
var _bexioAccountsTenantId = null;

// Fetch the tenant's Bexio revenue accounts and populate the dropdown.
// Silent on failure — this is a non-critical enhancement; if the Edge
// Function is unavailable the dashboard should still work.
async function loadBexioAccounts(tenantId) {
  _bexioAccountsTenantId = tenantId;
  var select = document.getElementById("bexio-account-select");
  var currentLabel = document.getElementById("bexio-account-current");
  if (!select) return;
  select.innerHTML = '<option value="">Lädt...</option>';
  select.disabled = true;

  try {
    var sessionResult = await supabase.auth.getSession();
    var accessToken = sessionResult.data.session
      ? sessionResult.data.session.access_token
      : SUPABASE_ANON_KEY;

    var resp = await fetch(
      SUPABASE_URL + "/functions/v1/bexio-accounts?tenant_id=" + encodeURIComponent(tenantId),
      {
        method: "GET",
        headers: {
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + accessToken,
        },
      },
    );

    if (!resp.ok) {
      var errBody = await resp.text();
      console.warn("[loadBexioAccounts] failed:", resp.status, errBody);
      select.innerHTML = '<option value="">Konten konnten nicht geladen werden</option>';
      return;
    }

    var data = await resp.json();
    var accounts = Array.isArray(data.accounts) ? data.accounts : [];
    var preferredId = data.preferred_account_id;

    select.innerHTML = "";
    var optAuto = document.createElement("option");
    optAuto.value = "";
    optAuto.textContent = "Automatisch (3400 > 3200 > 3000)";
    select.appendChild(optAuto);

    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      var opt = document.createElement("option");
      opt.value = String(a.id);
      var label = a.account_no + " " + (a.name || "");
      if (!a.is_revenue) label += " (Skonto/Bestand)";
      opt.textContent = label;
      if (preferredId != null && Number(a.id) === Number(preferredId)) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }

    // Update the "current" line above the select.
    if (currentLabel) {
      if (preferredId != null) {
        var picked = null;
        for (var j = 0; j < accounts.length; j++) {
          if (Number(accounts[j].id) === Number(preferredId)) { picked = accounts[j]; break; }
        }
        currentLabel.textContent = picked
          ? (picked.account_no + " " + (picked.name || ""))
          : ("Konto-ID " + preferredId);
      } else {
        currentLabel.textContent = "Automatisch";
      }
    }
  } catch (err) {
    console.warn("[loadBexioAccounts] error:", err);
    select.innerHTML = '<option value="">Fehler beim Laden</option>';
  } finally {
    select.disabled = false;
  }
}

// Save the selected revenue account as the tenant's preference.
async function saveRevenueAccountPreference() {
  var select = document.getElementById("bexio-account-select");
  if (!select) return;
  if (!_bexioAccountsTenantId) {
    alert("Tenant-Kontext fehlt. Bitte Seite neu laden.");
    return;
  }

  var raw = select.value;
  var accountId = raw === "" ? null : Number(raw);

  var btnList = document.querySelectorAll('#bexio-account-block button');
  for (var b = 0; b < btnList.length; b++) btnList[b].disabled = true;

  try {
    var sessionResult = await supabase.auth.getSession();
    var accessToken = sessionResult.data.session
      ? sessionResult.data.session.access_token
      : SUPABASE_ANON_KEY;

    var resp = await fetch(
      SUPABASE_URL + "/functions/v1/bexio-accounts",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + accessToken,
        },
        body: JSON.stringify({
          tenant_id: _bexioAccountsTenantId,
          account_id: accountId,
        }),
      },
    );

    if (!resp.ok) {
      var errBody = await resp.text();
      alert("Speichern fehlgeschlagen (" + resp.status + "): " + errBody);
      return;
    }

    alert(accountId == null
      ? "Erlöskonto-Vorzug entfernt — Auto-Erkennung aktiv."
      : "Erlöskonto gespeichert. Wird bei der nächsten Rechnung verwendet.");
    loadDashboard();
  } catch (err) {
    alert("Netzwerkfehler: " + (err && err.message ? err.message : err));
  } finally {
    for (var b2 = 0; b2 < btnList.length; b2++) btnList[b2].disabled = false;
  }
}

// ===== Abo / Subscription =====

// Build the content of the "Abo" card on the dashboard. Called by
// loadDashboard() once we have the tenant row.
function renderSubscriptionCard(tenant, planRaw, isActive) {
  var infoEl = document.getElementById("subscription-info");
  var actionsEl = document.getElementById("subscription-actions");
  if (!infoEl || !actionsEl) return;

  actionsEl.innerHTML = "";

  if (isActive) {
    var planLabel = planRaw === "active_yearly" ? "Jährlich (199 CHF / Jahr)"
      : planRaw === "active_monthly" ? "Monatlich (19 CHF / Monat)"
      : "Aktiv";

    // Build the info block as a stack of label/value rows (matching the
    // other dashboard cards) plus a feature list.
    var rows = "";
    rows += subRow("Plan", planLabel);
    if (tenant.subscription_started_at) {
      rows += subRow("Gestartet am", formatDate(tenant.subscription_started_at));
    }
    if (tenant.subscription_renews_at) {
      var renewsLabel = tenant.subscription_cancel_at_period_end
        ? "Läuft ab am"
        : "Nächste Abrechnung";
      rows += subRow(renewsLabel, formatDate(tenant.subscription_renews_at));
    }

    var features = [
      "Unbegrenzte Rechnungen",
      "Unbegrenzte Angebote",
      "Bexio Integration",
      "WhatsApp Bot & PDF-Vorschau",
      "E-Mail Support",
    ];
    var featuresList = '<ul class="sub-features">' +
      features.map(function (f) { return "<li>" + f + "</li>"; }).join("") +
      "</ul>";

    var cancelNote = tenant.subscription_cancel_at_period_end
      ? '<p class="help-text" style="margin-top: 10px;">Dein Abo wurde gekündigt und läuft am oben genannten Datum aus.</p>'
      : "";

    infoEl.innerHTML = rows + featuresList + cancelNote;

    var invoicesBtn = document.createElement("button");
    invoicesBtn.className = "btn btn-outline";
    invoicesBtn.textContent = "Rechnungen anzeigen";
    invoicesBtn.onclick = function () { toggleInvoicesList(invoicesBtn); };
    actionsEl.appendChild(invoicesBtn);

    var manageBtn = document.createElement("button");
    manageBtn.className = "btn btn-outline";
    manageBtn.textContent = "Abo verwalten";
    manageBtn.onclick = function () { openBillingPortal(); };
    actionsEl.appendChild(manageBtn);
    return;
  }

  // Trial or expired — show upgrade options
  if (planRaw === "trial" && tenant.trial_ends_at) {
    var daysLeft = Math.ceil(
      (new Date(tenant.trial_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
    );
    if (daysLeft > 0) {
      infoEl.innerHTML = "Deine Testphase laeuft noch <strong>" + daysLeft + " Tag" +
        (daysLeft === 1 ? "" : "e") + "</strong>. Upgrade jederzeit möglich.";
    } else {
      infoEl.innerHTML = "<strong style=\"color:#d93025\">Deine Testphase ist abgelaufen.</strong><br>" +
        "Bitte upgrade, um den Bot weiter zu nutzen.";
    }
  } else if (planRaw === "past_due") {
    infoEl.innerHTML = "<strong style=\"color:#d93025\">Deine letzte Zahlung ist fehlgeschlagen.</strong><br>" +
      "Bitte aktualisiere deine Zahlungsmethode.";
  } else if (planRaw === "cancelled") {
    infoEl.innerHTML = "<strong>Dein Abo wurde gekuendigt.</strong><br>" +
      "Du kannst jederzeit ein neues abschliessen.";
  } else {
    infoEl.innerHTML = "Kein aktives Abo.";
  }

  var monthlyBtn = document.createElement("button");
  monthlyBtn.className = "btn btn-primary";
  monthlyBtn.textContent = "Monatlich (19 CHF)";
  monthlyBtn.onclick = function () { upgradeSubscription("monthly"); };
  actionsEl.appendChild(monthlyBtn);

  var yearlyBtn = document.createElement("button");
  yearlyBtn.className = "btn btn-outline";
  yearlyBtn.textContent = "Jaehrlich (199 CHF)";
  yearlyBtn.onclick = function () { upgradeSubscription("yearly"); };
  actionsEl.appendChild(yearlyBtn);
}

// Start a Stripe Checkout flow for the chosen plan.
async function upgradeSubscription(plan) {
  var user = await checkAuth();
  if (!user) { alert("Nicht angemeldet."); return; }

  var actionsEl = document.getElementById("subscription-actions");
  if (actionsEl) {
    var buttons = actionsEl.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].disabled = true;
    }
  }

  try {
    var tenantResult = await supabase
      .from("tenants").select("id")
      .ilike("email", escapeLikePattern(user.email))
      .limit(1).maybeSingle();
    if (tenantResult.error || !tenantResult.data) {
      alert("Tenant nicht gefunden.");
      return;
    }

    var sessionResult = await supabase.auth.getSession();
    var accessToken = sessionResult.data.session
      ? sessionResult.data.session.access_token
      : SUPABASE_ANON_KEY;

    var origin = window.location.origin;
    var resp = await fetch(
      SUPABASE_URL + "/functions/v1/stripe-checkout",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + accessToken,
        },
        body: JSON.stringify({
          tenant_id: tenantResult.data.id,
          plan: plan,
          success_url: origin + "/subscription-success.html",
          cancel_url: origin + "/dashboard.html",
        }),
      },
    );

    if (!resp.ok) {
      var errTxt = await resp.text();
      console.error("[upgradeSubscription] not ok:", resp.status, errTxt);
      alert("Fehler beim Upgrade (" + resp.status + "): " + errTxt);
      return;
    }

    var data = await resp.json();
    if (!data.url) {
      alert("Keine Checkout-URL erhalten.");
      return;
    }
    window.location.href = data.url;
  } catch (err) {
    console.error("[upgradeSubscription] exception:", err);
    alert("Netzwerkfehler: " + err.message);
  } finally {
    if (actionsEl) {
      var buttons2 = actionsEl.querySelectorAll("button");
      for (var j = 0; j < buttons2.length; j++) {
        buttons2[j].disabled = false;
      }
    }
  }
}

// Open the Stripe Customer Portal so the user can manage an active sub.
async function openBillingPortal() {
  var user = await checkAuth();
  if (!user) { alert("Nicht angemeldet."); return; }

  try {
    var tenantResult = await supabase
      .from("tenants").select("id")
      .ilike("email", escapeLikePattern(user.email))
      .limit(1).maybeSingle();
    if (tenantResult.error || !tenantResult.data) {
      alert("Tenant nicht gefunden.");
      return;
    }

    var sessionResult = await supabase.auth.getSession();
    var accessToken = sessionResult.data.session
      ? sessionResult.data.session.access_token
      : SUPABASE_ANON_KEY;

    var resp = await fetch(
      SUPABASE_URL + "/functions/v1/stripe-portal",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + accessToken,
        },
        body: JSON.stringify({
          tenant_id: tenantResult.data.id,
          return_url: window.location.origin + "/dashboard.html",
        }),
      },
    );

    if (!resp.ok) {
      var errTxt = await resp.text();
      alert("Fehler (" + resp.status + "): " + errTxt);
      return;
    }

    var data = await resp.json();
    if (!data.url) {
      alert("Keine Portal-URL erhalten.");
      return;
    }
    window.location.href = data.url;
  } catch (err) {
    console.error("[openBillingPortal] exception:", err);
    alert("Netzwerkfehler: " + err.message);
  }
}

// Toggles an inline list of Stripe invoices below the subscription-info
// block. First click fetches + renders, next click collapses it.
async function toggleInvoicesList(triggerBtn) {
  var existing = document.getElementById("invoices-list");
  if (existing) {
    existing.remove();
    triggerBtn.textContent = "Rechnungen anzeigen";
    return;
  }

  var infoEl = document.getElementById("subscription-info");
  if (!infoEl) return;

  // Placeholder while fetching.
  var listEl = document.createElement("div");
  listEl.id = "invoices-list";
  listEl.className = "invoices-list";
  listEl.innerHTML = '<p class="help-text">Rechnungen werden geladen...</p>';
  infoEl.parentNode.insertBefore(listEl, infoEl.nextSibling);

  triggerBtn.disabled = true;
  try {
    var user = await checkAuth();
    if (!user) { listEl.innerHTML = '<p class="help-text">Nicht angemeldet.</p>'; return; }

    var tenantResult = await supabase
      .from("tenants").select("id")
      .ilike("email", escapeLikePattern(user.email))
      .limit(1).maybeSingle();
    if (tenantResult.error || !tenantResult.data) {
      listEl.innerHTML = '<p class="help-text">Tenant nicht gefunden.</p>';
      return;
    }

    var sessionResult = await supabase.auth.getSession();
    var accessToken = sessionResult.data.session
      ? sessionResult.data.session.access_token
      : SUPABASE_ANON_KEY;

    var resp = await fetch(SUPABASE_URL + "/functions/v1/stripe-invoices", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + accessToken,
      },
      body: JSON.stringify({ tenant_id: tenantResult.data.id }),
    });

    if (!resp.ok) {
      var errData = await resp.json().catch(function () { return {}; });
      listEl.innerHTML = '<p class="help-text">Fehler: ' +
        escapeHtml(errData.error || ("HTTP " + resp.status)) + "</p>";
      return;
    }

    var data = await resp.json();
    var invoices = (data && data.invoices) || [];
    if (invoices.length === 0) {
      listEl.innerHTML = '<p class="help-text">Noch keine Rechnungen vorhanden.</p>';
      triggerBtn.textContent = "Liste ausblenden";
      return;
    }

    var rows = invoices.map(function (inv) {
      var date = inv.created ? formatDate(new Date(inv.created * 1000).toISOString()) : "—";
      var amount = ((inv.amount_paid || inv.amount_due || 0) / 100).toFixed(2);
      var currency = (inv.currency || "chf").toUpperCase();
      var statusLabel = inv.status === "paid" ? "Bezahlt"
        : inv.status === "open" ? "Offen"
        : inv.status === "void" ? "Storniert"
        : inv.status === "uncollectible" ? "Uneinbringlich"
        : (inv.status || "—");
      var statusClass = inv.status === "paid" ? "active"
        : inv.status === "open" ? "trial"
        : "inactive";
      var pdfLink = inv.invoice_pdf
        ? '<a href="' + escapeHtml(inv.invoice_pdf) + '" target="_blank" rel="noopener">PDF</a>'
        : "";
      var portalLink = inv.hosted_invoice_url
        ? '<a href="' + escapeHtml(inv.hosted_invoice_url) + '" target="_blank" rel="noopener">Ansehen</a>'
        : "";
      var linksCell = [portalLink, pdfLink].filter(function (x) { return x; }).join(" &middot; ");
      return '<tr>' +
        '<td>' + escapeHtml(date) + '</td>' +
        '<td>' + escapeHtml(inv.number || inv.id) + '</td>' +
        '<td class="num">' + escapeHtml(currency) + " " + escapeHtml(amount) + '</td>' +
        '<td><span class="status-badge ' + statusClass + '">' + escapeHtml(statusLabel) + '</span></td>' +
        '<td class="links">' + linksCell + '</td>' +
        "</tr>";
    }).join("");

    listEl.innerHTML =
      '<table class="invoices-table">' +
        '<thead><tr>' +
          '<th>Datum</th><th>Nummer</th><th>Betrag</th><th>Status</th><th></th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';
    triggerBtn.textContent = "Liste ausblenden";
  } catch (err) {
    console.error("[toggleInvoicesList]", err);
    listEl.innerHTML = '<p class="help-text">Netzwerkfehler: ' + escapeHtml(err.message || String(err)) + "</p>";
  } finally {
    triggerBtn.disabled = false;
  }
}

// ===== Konto löschen (Gefahrenzone) =====

// Triggers the full account wipe via the delete-account Edge Function.
// UX is two-step: a confirm(), then a prompt() asking the user to type
// LÖSCHEN. Once the Edge Function reports success we sign the user out
// locally and redirect to login.html#deleted so the login page can show
// a "Konto gelöscht" banner.
async function deleteAccount() {
  var user = await checkAuth();
  if (!user) { alert("Nicht angemeldet."); return; }

  if (!confirm(
    "Willst du dein Konto wirklich unwiderruflich löschen?\n\n" +
    "• Alle deine Daten (Profil, Bexio-Verbindung, Bot-Sessions) werden entfernt.\n" +
    "• Ein aktives Abo wird sofort bei Stripe gekündigt.\n" +
    "• Diese Aktion kann nicht rückgängig gemacht werden."
  )) return;

  var typed = prompt('Zum Bestätigen bitte LÖSCHEN eingeben:');
  if (typed === null) return;
  if (String(typed).trim().toUpperCase() !== "LÖSCHEN") {
    alert("Abgebrochen — du musst \"LÖSCHEN\" eingeben.");
    return;
  }

  var btn = document.getElementById("delete-account-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Lösche..."; }

  try {
    var sessionResult = await supabase.auth.getSession();
    var accessToken = sessionResult.data.session
      ? sessionResult.data.session.access_token
      : SUPABASE_ANON_KEY;

    var resp = await fetch(
      SUPABASE_URL + "/functions/v1/delete-account",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + accessToken,
        },
        body: JSON.stringify({}),
      },
    );

    if (!resp.ok) {
      var errBody = await resp.text();
      console.error("[deleteAccount] not ok:", resp.status, errBody);
      alert("Löschung fehlgeschlagen (" + resp.status + "): " + errBody);
      if (btn) { btn.disabled = false; btn.textContent = "Konto unwiderruflich löschen"; }
      return;
    }
  } catch (err) {
    console.error("[deleteAccount] network error:", err);
    alert("Netzwerkfehler: " + (err && err.message ? err.message : err));
    if (btn) { btn.disabled = false; btn.textContent = "Konto unwiderruflich löschen"; }
    return;
  }

  // Success — drop the local session and redirect. The hash is picked up
  // by login.html to show the "Konto gelöscht" banner.
  try { await supabase.auth.signOut(); } catch (_e) { /* ignore — auth user is gone anyway */ }
  window.location.href = "login.html#deleted";
}

// ----- Helpers used by renderSubscriptionCard -----

function subRow(label, value) {
  return '<div class="dash-row">' +
    '<span class="label">' + escapeHtml(label) + "</span>" +
    '<span class="value">' + escapeHtml(value) + "</span>" +
    "</div>";
}

function formatDate(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("de-CH", { day: "numeric", month: "long", year: "numeric" });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Load dashboard on page load
loadDashboard();
