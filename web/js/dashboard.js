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
    greetingEl.textContent = "Hallo, " + (tenant.full_name || "Handwerker") + "!";
  }

  // Plan
  var planBadge = document.getElementById("plan-badge");
  if (planBadge) {
    var plan = tenant.plan || "trial";
    planBadge.textContent = plan.charAt(0).toUpperCase() + plan.slice(1);
    planBadge.className = "status-badge";
    if (plan === "trial") {
      planBadge.classList.add("trial");
    } else if (plan === "active") {
      planBadge.classList.add("active");
    } else {
      planBadge.classList.add("inactive");
    }
  }

  // Trial end
  var trialEndEl = document.getElementById("trial-end");
  if (trialEndEl && tenant.trial_ends_at) {
    var d = new Date(tenant.trial_ends_at);
    trialEndEl.textContent = d.toLocaleDateString("de-CH");
  }

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

  // Bot number
  var botNrEl = document.getElementById("bot-number");
  if (botNrEl && typeof BOT_WHATSAPP_NUMBER !== "undefined") {
    botNrEl.textContent = BOT_WHATSAPP_NUMBER;
  }
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

// Load dashboard on page load
loadDashboard();
