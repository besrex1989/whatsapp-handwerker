// Supabase Config — replace with your project values
var SUPABASE_URL = "https://rdbislocgdraggiapxod.supabase.co";
var SUPABASE_ANON_KEY = "DEIN_ANON_KEY_HIER"; // Replace with your anon key

var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== Auth State Check =====
async function checkAuth() {
  var session = await supabase.auth.getSession();
  var user = session.data.session ? session.data.session.user : null;

  // If on login page and already logged in, redirect to dashboard
  if (user && window.location.pathname.indexOf("login") !== -1) {
    window.location.href = "dashboard.html";
  }

  // If on dashboard and NOT logged in, redirect to login
  if (!user && window.location.pathname.indexOf("dashboard") !== -1) {
    window.location.href = "login.html";
  }

  return user;
}

// Run auth check on page load
checkAuth();

// Check if URL has #register hash
if (window.location.hash === "#register") {
  var registerForm = document.getElementById("register-form");
  var loginForm = document.getElementById("login-form");
  if (registerForm && loginForm) {
    registerForm.style.display = "block";
    loginForm.style.display = "none";
  }
}

// ===== Show/Hide Forms =====
function showRegister() {
  document.getElementById("login-form").style.display = "none";
  document.getElementById("register-form").style.display = "block";
}

function showLogin() {
  document.getElementById("register-form").style.display = "none";
  document.getElementById("login-form").style.display = "block";
}

// ===== Login =====
async function handleLogin(e) {
  e.preventDefault();
  var errorEl = document.getElementById("login-error");
  var btn = document.getElementById("login-btn");
  errorEl.style.display = "none";

  var email = document.getElementById("login-email").value;
  var password = document.getElementById("login-password").value;

  btn.textContent = "Wird angemeldet...";
  btn.disabled = true;

  var result = await supabase.auth.signInWithPassword({
    email: email,
    password: password,
  });

  if (result.error) {
    errorEl.textContent = "Login fehlgeschlagen: " + result.error.message;
    errorEl.style.display = "block";
    btn.textContent = "Anmelden";
    btn.disabled = false;
    return;
  }

  window.location.href = "dashboard.html";
}

// ===== Register =====
async function handleRegister(e) {
  e.preventDefault();
  var errorEl = document.getElementById("register-error");
  var successEl = document.getElementById("register-success");
  var btn = document.getElementById("register-btn");
  errorEl.style.display = "none";
  successEl.style.display = "none";

  var name = document.getElementById("reg-name").value;
  var email = document.getElementById("reg-email").value;
  var phone = document.getElementById("reg-phone").value;
  var password = document.getElementById("reg-password").value;

  // Normalize phone number
  phone = phone.replace(/\s+/g, "");
  if (!phone.startsWith("+")) {
    phone = "+" + phone;
  }

  btn.textContent = "Wird erstellt...";
  btn.disabled = true;

  // 1. Create auth user
  var result = await supabase.auth.signUp({
    email: email,
    password: password,
    options: {
      data: {
        full_name: name,
        whatsapp_number: phone,
      },
    },
  });

  if (result.error) {
    errorEl.textContent = "Fehler: " + result.error.message;
    errorEl.style.display = "block";
    btn.textContent = "Kostenlos registrieren";
    btn.disabled = false;
    return;
  }

  // 2. Create tenant record
  var tenantResult = await supabase.from("tenants").insert({
    email: email,
    full_name: name,
    whatsapp_number: phone,
  });

  if (tenantResult.error) {
    // Tenant might already exist
    console.error("Tenant insert error:", tenantResult.error);
  }

  successEl.textContent = "Konto erstellt! Du kannst dich jetzt anmelden.";
  successEl.style.display = "block";
  btn.textContent = "Kostenlos registrieren";
  btn.disabled = false;

  // Auto-redirect after 2 seconds
  setTimeout(function () {
    showLogin();
  }, 2000);
}

// ===== Logout =====
async function handleLogout() {
  await supabase.auth.signOut();
  window.location.href = "login.html";
}
