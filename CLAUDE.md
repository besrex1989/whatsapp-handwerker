# CLAUDE.md — Projekt-Kontext für Claude

Diese Datei wird von jeder Claude-Session automatisch gelesen. Sie erklärt
was dieses Projekt ist, wie es deployed wird und worauf man aufpassen muss.

**User-facing Support-Doku**: siehe `SUPPORT.md`.

---

## Was ist Billaro?

Ein WhatsApp-first Rechnungs-/Angebots-Assistent für Schweizer Handwerker.
Der Handwerker (Tenant) schickt Fotos/Sprachnachrichten an die Bot-Nummer
(+41 79 419 73 21), der Bot erkennt Kontakt/Positionen, lässt sich vom
User die Eckdaten bestätigen und erstellt daraus ein Bexio-Dokument
(Rechnung oder Offerte). PDF-Vorschau kommt zurück via WhatsApp.

Nebenan läuft ein Self-Service-Dashboard auf https://billaro.ch zum
Registrieren, Bexio-Verbinden, Abo-Management.

Domain: **billaro.ch** (Vercel).

## Tech-Stack

- **Frontend**: Vanilla JS + HTML + CSS in `web/`. Kein Build-Step.
  Deployed statisch via **Vercel** (Auto-Deploy von `main`).
- **Backend**: **Supabase Edge Functions** (Deno) in `supabase/functions/`.
- **Datenbank**: **Supabase Postgres** mit SQL-Migrationen in
  `supabase/migrations/` (sequentiell nummeriert `001_…` bis `0NN_…`).
- **Auth**: Supabase Auth (E-Mail + Passwort, Confirmation an).
- **Payments**: **Stripe** (Subscription monatlich/jährlich, Checkout +
  Customer Portal + Webhooks).
- **Bexio**: OAuth + REST API für kb_invoice / kb_offer / contact / tax /
  account / file.
- **WhatsApp**: Meta Cloud API.

## Verzeichnis-Struktur

```
web/                       # Statisches Frontend (Vercel)
  js/auth.js               # Login, Signup, gemeinsame Helpers (Phone, LIKE-Escape)
  js/dashboard.js          # Dashboard-Logik (Tenant-Lookups, Bexio, Stripe, …)
  *.html                   # Pro Seite eine Datei
supabase/
  functions/
    _shared/               # Geteilte Helpers (cors, bexio-token-refresh)
    whatsapp-webhook/      # Haupt-Bot-Logik (längste Funktion)
    bexio-oauth/           # OAuth-Flow-Start + Callback-Verifikation
    bexio-accounts/        # Erlöskonten für Dashboard-Dropdown
    stripe-checkout/       # Startet Stripe Checkout
    stripe-portal/         # Öffnet Stripe Customer Portal
    stripe-webhook/        # Empfängt Stripe-Events → aktualisiert tenants
    stripe-invoices/       # Listet Rechnungen im Dashboard
    whatsapp-register/     # Registriert Tenant-Nummer bei Meta Cloud
    whatsapp-subscribe-app/# Abonniert WABA an die App
  migrations/              # SQL-Migrationen (NICHT rückdatieren — immer
                           # neue Nummer anhängen)
.github/workflows/         # CI (siehe unten)
SUPPORT.md                 # Support-Playbook
```

## Deploy-Flow (wichtig!)

| Änderung | Auto-Deploy? | Via |
|---|---|---|
| `web/**` | ✅ | Vercel (Push auf `main`) |
| `supabase/functions/**` | ✅ | `deploy-functions.yml` (Push auf `main`) |
| `supabase/migrations/**` | ✅ | `deploy-migrations.yml` (Push auf `main`) |
| Stripe-Produkte/Preise | ❌ | Manuell im Stripe Dashboard |
| Meta WhatsApp Templates | ❌ | Manuell im Meta Business Manager |

**Alles was nach `main` gepusht wird, geht sofort live.** Keine
Staging-Umgebung. Entsprechend vorsichtig reviewen.

Preview-Deploys auf Feature-Branches gibt's für **Vercel** (Frontend),
aber NICHT für Supabase (Functions + Migrationen bleiben auf Prod).
Daher: Migration zuerst idempotent/abwärtskompatibel machen, damit alter
Frontend-Code während des Deploy-Fensters nicht bricht.

## GitHub Secrets (müssen gesetzt sein)

| Secret | Wofür |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | CLI-Auth für `supabase link` / `db push` / `functions deploy` |
| `SUPABASE_PROJECT_ID` | Ref der Prod-Datenbank (`rdbislocgdraggiapxod`) |
| `SUPABASE_DB_PASSWORD` | Nötig für `supabase db push` (Settings → Database → Connection string) |

## Konventionen

### SQL-Migrationen
- **Immer idempotent**: `create … if not exists`, `drop policy if exists`,
  `on conflict do nothing`. Migration kann versehentlich zweimal laufen.
- **Nie rückwärts editieren**: Neue Migration `014_…`, `015_…` anhängen.
  Zurückrollen passiert via Compensation-Migration, nicht durch Edit.
- **Kommentar-Block oben**: Problem, Symptom, Fix. Siehe `013_…` als
  Vorlage. Das sind die ersten Zeilen, die ein Future-Me / Claude liest.
- **Bei Triggern**: `security definer` + `set search_path = public` —
  sonst RLS beißt zurück.

### Tenant-Lookups im Frontend
- **Immer case-insensitiv**: `.ilike("email", escapeLikePattern(user.email))`.
- **Immer `.maybeSingle()`** statt `.single()` — vermeidet den PGRST116-
  "Cannot coerce the result to a single JSON object"-Fehler bei 0 Zeilen.
- Helper `escapeLikePattern(s)` lebt in `web/js/auth.js` und escaped
  `_` / `%` / `\` für die LIKE-Pattern-Syntax.

### RLS-Policies
- Die `tenants`-Policies matchen immer `lower(email) = lower(auth.jwt() ->> 'email')`.
- Neue Spalten mit sensiblen Tokens (Bexio, Stripe) **nie** für `anon`
  selectable machen.

### Phone-Numbers
- Intern immer E.164 (`+41…`). Normalisierung via `normalizePhoneCH()`
  in `web/js/auth.js`.
- `tenants.whatsapp_number` ist UNIQUE + NOT NULL. Beim Backfill daher
  Fallback-Platzhalter (`+unknown_<hash>`) verwenden.

### Bexio
- `bexio_access_token` läuft nach 1h ab → Refresh via
  `_shared/bexio-token.ts` (`ensureBexioToken(tenant)`).
- Pro Tenant werden `bexio_user_id`, `bexio_account_id`, `bexio_tax_id`
  gecached (pro Bexio-Instanz unterschiedlich). Beim Disconnect **alle
  drei löschen**, sonst Inkonsistenz beim nächsten Connect.
- `kb_invoice` nutzt `status_id=7` (Entwurf), `kb_offer` nutzt
  `status_id=1` (Entwurf). Siehe `whatsapp-webhook/index.ts`.

### Stripe
- `stripe-webhook` ist die einzige Quelle der Wahrheit für `tenants.plan`
  und `subscription_renews_at`. Nie direkt aus dem Frontend setzen.
- Webhook-Events, die wir handlen: `checkout.session.completed`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.paid`, `invoice.payment_failed`.

### Frontend-Code-Stil
- **Vanilla JS ohne Build**. Keine `import`-Statements. Globale
  Funktionen/Variablen. Scripts werden per `<script>` im HTML in
  definierter Reihenfolge geladen — `auth.js` vor `dashboard.js`.
- `var` statt `let`/`const` (historisch gewachsen — konsistent halten,
  nicht umschreiben).
- Deutsche UI-Strings. Umlaute als echte Umlaute (`ä`, `ö`, `ü`), nicht
  `ae`/`oe`/`ue`.

## Häufige Fallstricke

- **"Cannot coerce the result to a single JSON object"**: `.single()` bei
  0 oder mehr als 1 Zeilen. Fix: `.maybeSingle()` + case-insensitives
  `.ilike()`-Match. Siehe Migration 013 + Fix in `dashboard.js`.
- **"new row violates row-level security policy"**: anon-Key versucht
  Insert während E-Mail-Confirmation noch aussteht. Fix läuft über
  Trigger `handle_new_auth_user` (Migration 006).
- **Duplicate WhatsApp-Nummer**: Zwei User registrieren dieselbe Nummer.
  Frontend fängt 23505 ab und zeigt verständliche Meldung.
- **Bexio 422 "Saldosteuersatz"**: Tax-Lookup muss pro Tenant-Bexio-
  Instanz passieren, nicht gecacht. Siehe Fallback-Logik in
  `_shared/bexio-tax.ts`.
- **Meta 25h-Messaging-Window**: Bot darf nach 24h nur noch via Template
  antworten, sonst 470-Error.

## Claude-Workflow-Tipps

- **Vor jeder Schema-Änderung**: Check, ob's wirklich eine neue Migration
  braucht oder eine bestehende ergänzt werden kann (Antwort ist praktisch
  immer: neue Migration anhängen, nicht alte editieren).
- **Vor RLS-Änderungen**: Service-Role (Edge Functions) bypassed RLS
  sowieso. Policies sind nur für Frontend (`anon` / `authenticated`).
- **Vor Edge-Function-Deploy**: Nicht vergessen, dass Deno 2 strikter ist
  (kein Top-Level-Await in Libraries, striktere Types). Siehe Commit
  `81a0511` als Beispiel.
- **Vor Stripe-Änderungen**: Im Test-Mode-Dashboard testen, nie live.
- **Bei Migrations mit Daten-Löschung**: Erst im SQL-Editor mit einem
  `begin; … rollback;`-Block manuell trocken-laufen lassen.
