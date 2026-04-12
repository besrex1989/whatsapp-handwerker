// Dashboard logic — loads tenant data and displays it

async function loadDashboard() {
  var user = await checkAuth();
  if (!user) return;

  // Show user email
  var emailEl = document.getElementById("user-email");
  if (emailEl) {
    emailEl.textContent = user.email;
  }

  // Load tenant data
  var result = await supabase
    .from("tenants")
    .select("*")
    .eq("email", user.email)
    .single();

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
  if (bexioStatus) {
    if (tenant.bexio_access_token) {
      bexioStatus.textContent = "Verbunden";
      bexioStatus.className = "status-badge active";
      if (bexioBtn) {
        bexioBtn.textContent = "Neu verbinden";
        bexioBtn.className = "btn btn-outline";
      }
      if (bexioDisconnectBtn) bexioDisconnectBtn.style.display = "";
    } else {
      bexioStatus.textContent = "Nicht verbunden";
      bexioStatus.className = "status-badge inactive";
      if (bexioBtn) {
        bexioBtn.textContent = "Mit Bexio verbinden";
        bexioBtn.className = "btn btn-primary";
      }
      if (bexioDisconnectBtn) bexioDisconnectBtn.style.display = "none";
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
    .eq("email", user.email);

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
    "Wir senden dir einen Bestaetigungs-Link an die neue Adresse. " +
    "Die Aenderung wird erst aktiv, nachdem du den Link geklickt hast.",
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
    alert("Bitte eine gueltige E-Mail-Adresse eingeben.");
    return;
  }

  var result = await supabase.auth.updateUser({ email: input });
  if (result.error) {
    alert("Fehler: " + result.error.message);
    return;
  }

  alert(
    "Bestaetigungs-Link gesendet an " + input + ".\n\n" +
    "Bitte klicke den Link in der E-Mail, um die Aenderung abzuschliessen. " +
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
    .eq("email", user.email);

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
  if (btn) { btn.disabled = true; btn.textContent = "Trenne..."; }

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
    .eq("email", user.email);

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

    // Get tenant ID
    var result = await supabase
      .from("tenants")
      .select("id")
      .eq("email", user.email)
      .single();

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

// ===== Abo / Subscription =====

// Build the content of the "Abo" card on the dashboard. Called by
// loadDashboard() once we have the tenant row.
function renderSubscriptionCard(tenant, planRaw, isActive) {
  var infoEl = document.getElementById("subscription-info");
  var actionsEl = document.getElementById("subscription-actions");
  if (!infoEl || !actionsEl) return;

  actionsEl.innerHTML = "";

  if (isActive) {
    var planLabel = planRaw === "active_yearly" ? "Jaehrlich (199 CHF / Jahr)"
      : planRaw === "active_monthly" ? "Monatlich (19 CHF / Monat)"
      : "Aktiv";
    infoEl.innerHTML = "<strong>Dein Abo ist aktiv.</strong><br>Plan: " + planLabel;

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
        (daysLeft === 1 ? "" : "e") + "</strong>. Upgrade jederzeit moeglich.";
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
      .from("tenants").select("id").eq("email", user.email).single();
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
      .from("tenants").select("id").eq("email", user.email).single();
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

// Load dashboard on page load
loadDashboard();
