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
  if (bexioStatus) {
    if (tenant.bexio_access_token) {
      bexioStatus.textContent = "Verbunden";
      bexioStatus.className = "status-badge active";
      if (bexioBtn) {
        bexioBtn.textContent = "Neu verbinden";
        bexioBtn.className = "btn btn-outline";
      }
    } else {
      bexioStatus.textContent = "Nicht verbunden";
      bexioStatus.className = "status-badge inactive";
    }
  }
}

// Connect Bexio
async function connectBexio() {
  var user = await checkAuth();
  if (!user) return;

  // Get tenant ID
  var result = await supabase
    .from("tenants")
    .select("id")
    .eq("email", user.email)
    .single();

  if (!result.data) {
    alert("Tenant nicht gefunden.");
    return;
  }

  // Call Bexio OAuth Edge Function to get auth URL
  var resp = await fetch(
    SUPABASE_URL + "/functions/v1/bexio-oauth",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenant_id: result.data.id }),
    }
  );

  if (resp.ok) {
    var data = await resp.json();
    window.location.href = data.url;
  } else {
    alert("Fehler beim Verbinden mit Bexio.");
  }
}

// Load dashboard on page load
loadDashboard();
