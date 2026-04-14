// Toggles a password <input> between type="password" and type="text".
// Called inline from the "Anzeigen" buttons on login / register / reset
// password forms.
function togglePassword(btn) {
  var wrap = btn.closest(".password-field");
  if (!wrap) return;
  var input = wrap.querySelector("input");
  if (!input) return;
  if (input.type === "password") {
    input.type = "text";
    btn.textContent = "Ausblenden";
    btn.setAttribute("aria-label", "Passwort ausblenden");
  } else {
    input.type = "password";
    btn.textContent = "Anzeigen";
    btn.setAttribute("aria-label", "Passwort anzeigen");
  }
}

// Supabase Config — replace with your project values
var SUPABASE_URL = "https://rdbislocgdraggiapxod.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkYmlzbG9jZ2RyYWdnaWFweG9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MDk2NDIsImV4cCI6MjA5MTQ4NTY0Mn0.xreLK3j-9rgW1xPS7G9-WCW7JqQiEgTdHTKsgUeEUJs";

var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// The WhatsApp business number the bot runs on.
var BOT_WHATSAPP_NUMBER = "+41 79 419 73 21";

// ===== Phone helpers =====

// Normalise a user-entered phone number to E.164 (+41...).
// Accepts '0763449800', '076 344 98 00', '+41763449800', '0041...', '41...'.
// Returns { ok: true, phone: "+41763449800" } or { ok: false, error: "..." }.
function normalizePhoneCH(input) {
  if (!input) return { ok: false, error: "Bitte eine Telefonnummer eingeben." };
  var p = String(input).replace(/[\s\-()]+/g, "");
  if (p.startsWith("00")) {
    p = "+" + p.slice(2);
  } else if (p.startsWith("+")) {
    // already international
  } else if (p.startsWith("0")) {
    p = "+41" + p.slice(1);
  } else {
    p = "+" + p;
  }
  if (!/^\+\d{8,15}$/.test(p)) {
    return {
      ok: false,
      error: "Ungültige Telefonnummer. Bitte im Format 076 344 98 00 oder +41 76 344 98 00 eingeben.",
    };
  }
  return { ok: true, phone: p };
}

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
function hideAllAuthForms() {
  var ids = ["login-form", "register-form", "forgot-form"];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el) el.style.display = "none";
  }
}

function showRegister() {
  hideAllAuthForms();
  document.getElementById("register-form").style.display = "block";
}

function showLogin() {
  hideAllAuthForms();
  document.getElementById("login-form").style.display = "block";
}

function showForgotPassword() {
  hideAllAuthForms();
  document.getElementById("forgot-form").style.display = "block";
  // Prefill email if already typed into login form
  var loginEmail = document.getElementById("login-email");
  var forgotEmail = document.getElementById("forgot-email");
  if (loginEmail && forgotEmail && loginEmail.value) {
    forgotEmail.value = loginEmail.value;
  }
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

// ===== Forgot Password =====
async function handleForgotPassword(e) {
  e.preventDefault();
  var errorEl = document.getElementById("forgot-error");
  var successEl = document.getElementById("forgot-success");
  var btn = document.getElementById("forgot-btn");
  errorEl.style.display = "none";
  successEl.style.display = "none";

  var email = document.getElementById("forgot-email").value;

  btn.textContent = "Wird gesendet...";
  btn.disabled = true;

  var redirectTo = window.location.origin + "/reset-password.html";
  var result = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: redirectTo,
  });

  btn.textContent = "Link senden";
  btn.disabled = false;

  if (result.error) {
    errorEl.textContent = "Fehler: " + result.error.message;
    errorEl.style.display = "block";
    return;
  }

  // Always show the same success message, regardless of whether the email
  // exists — avoids leaking which emails are registered.
  successEl.textContent = "Wenn ein Konto mit dieser E-Mail existiert, "
    + "haben wir dir einen Link zum Zurücksetzen geschickt. "
    + "Prüfe dein Postfach.";
  successEl.style.display = "block";
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

  var result = normalizePhoneCH(phone);
  if (!result.ok) {
    errorEl.textContent = result.error;
    errorEl.style.display = "block";
    return;
  }
  phone = result.phone;

  btn.textContent = "Wird erstellt...";
  btn.disabled = true;

  // Create auth user — a database trigger on auth.users automatically creates
  // the matching public.tenants row using full_name / whatsapp_number from
  // raw_user_meta_data. See migration 006_auto_create_tenant_on_signup.sql.
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
