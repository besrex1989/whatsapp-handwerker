// landing.js — nur für die Startseite (index.html).
// Drei kleine Dinge, alle optional: ohne JS (oder mit "Bewegung reduzieren")
// ist die Seite vollständig sichtbar und der Beispiel-Chat steht statisch da.
//   1) Navigation bekommt beim Scrollen einen Hintergrund.
//   2) Abschnitte blenden beim Scrollen ein.
//   3) Der Beispiel-Chat im Telefon spielt sich Nachricht für Nachricht ab.
// Bei Änderungen das ?v= in index.html hochzählen (ein Jahr immutable gecacht).

(function () {
  var reduceMotion = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --- 1) Navigation ---
  var nav = document.getElementById("lp-nav");
  function updateNav() {
    if (nav) nav.classList.toggle("is-stuck", window.scrollY > 12);
  }
  updateNav();
  window.addEventListener("scroll", updateNav, { passive: true });

  if (reduceMotion || !("IntersectionObserver" in window)) return;

  // --- 2) Einblenden ---
  document.documentElement.classList.add("lp-js");
  var revealEls = document.querySelectorAll("[data-reveal]");
  var revealObserver = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i].isIntersecting) continue;
      entries[i].target.classList.add("is-in");
      revealObserver.unobserve(entries[i].target);
      // Verzögerung danach entfernen, sonst reagiert der Hover-Effekt träge.
      (function (el) {
        window.setTimeout(function () { el.style.transitionDelay = ""; }, 1000);
      })(entries[i].target);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  for (var r = 0; r < revealEls.length; r++) {
    // Karten in derselben Reihe leicht versetzt einblenden.
    revealEls[r].style.transitionDelay = (r % 4) * 70 + "ms";
    revealObserver.observe(revealEls[r]);
  }

  // --- 3) Beispiel-Chat ---
  var chat = document.getElementById("lp-chat");
  if (!chat) return;
  var msgs = chat.querySelectorAll(".lp-msg");
  if (!msgs.length) return;

  var typing = document.createElement("div");
  typing.className = "lp-typing";
  typing.innerHTML = "<i></i><i></i><i></i>";

  var timer = null;
  var visible = false;

  function wait(ms, fn) { timer = window.setTimeout(fn, ms); }

  function reset() {
    for (var i = 0; i < msgs.length; i++) msgs[i].classList.remove("is-in");
    if (typing.parentNode) typing.parentNode.removeChild(typing);
  }

  function show(index) {
    if (!visible) return;
    if (index >= msgs.length) {
      // Fertig: kurz stehen lassen, dann von vorn.
      wait(5200, function () { reset(); wait(700, function () { show(0); }); });
      return;
    }
    var msg = msgs[index];
    var isBot = msg.classList.contains("bot");
    if (isBot) {
      chat.appendChild(typing);
      wait(950, function () {
        if (typing.parentNode) typing.parentNode.removeChild(typing);
        msg.classList.add("is-in");
        wait(1300, function () { show(index + 1); });
      });
    } else {
      msg.classList.add("is-in");
      wait(1100, function () { show(index + 1); });
    }
  }

  chat.classList.add("is-animated");

  // Nur abspielen, solange das Telefon sichtbar ist.
  var chatObserver = new IntersectionObserver(function (entries) {
    var nowVisible = entries[0].isIntersecting;
    if (nowVisible === visible) return;
    visible = nowVisible;
    window.clearTimeout(timer);
    reset();
    if (visible) wait(500, function () { show(0); });
  }, { threshold: 0.25 });
  chatObserver.observe(chat);
})();
