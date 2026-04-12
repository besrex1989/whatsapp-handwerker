# Support & Operations

Kurze Referenz für Support-Fälle. Die meisten Fragen lassen sich direkt
im **Supabase Dashboard** (Table Editor + Edge Function Logs) plus
**Stripe Dashboard** beantworten — kein eigenes Admin-UI nötig.

Projekt-URLs:
- Supabase: https://supabase.com/dashboard/project/rdbislocgdraggiapxod
- Stripe:   https://dashboard.stripe.com
- Vercel:   https://vercel.com/<team>/whatsapp-handwerker


## Schema Cheat Sheet

**`tenants`** — ein Row pro Kunde:
- `id` (uuid), `email`, `full_name`, `whatsapp_number`
- `plan` (`trial` / `active_monthly` / `active_yearly` / `cancelled` / `past_due`)
- `trial_ends_at`, `is_active`
- `stripe_customer_id`, `stripe_subscription_id`
- `bexio_access_token`, `bexio_refresh_token`, `bexio_expires_at`
- `bexio_user_id`, `bexio_account_id`, `bexio_tax_id`, `bexio_preferred_account_id`

**`sessions_handwerker`** — ein Row pro WhatsApp-Nummer (Chat-State):
- `phone_number`, `tenant_id`, `step`
- `bexio_contact_id`, `bexio_invoice_id` (= Doc-ID, egal ob Invoice oder Offer),
  `bexio_document_type` (`invoice` | `offer`)
- `manual_positions` (jsonb-Array), `invoice_title`, `contact_data`
- `expires_at` (Session läuft nach 8h ab)


## Wo finde ich was?

| Frage | Ort |
|---|---|
| Welche Kunden gibt es? | Supabase → Table Editor → `tenants` |
| In welchem Step hängt ein Kunde? | Supabase → Table Editor → `sessions_handwerker`, nach `phone_number` filtern |
| Welcher Bexio-Fehler kam zuletzt? | Supabase → Edge Functions → `whatsapp-webhook` → Logs |
| Zahlung fehlgeschlagen? | Stripe Dashboard → Customers → nach E-Mail |
| OAuth-Problem? | Supabase → Edge Functions → `bexio-oauth` → Logs |


## Typische Support-Fälle

### „Nichts passiert wenn ich dem Bot schreibe"

1. Tenant existiert und ist aktiv?
   ```sql
   select id, email, whatsapp_number, plan, is_active, trial_ends_at
   from tenants
   where whatsapp_number = '+41791234567';
   ```
2. Session hängt in altem Zustand?
   ```sql
   select step, updated_at, expires_at
   from sessions_handwerker
   where phone_number = '+41791234567';
   ```
3. Falls `expires_at < now()` oder `step != 'start'`: Session resetten (unten).

### „Ich kann keine Rechnung / kein Angebot erstellen"

Meistens Bexio-Verbindung:

```sql
select email,
       (bexio_access_token is not null) as has_token,
       bexio_expires_at,
       bexio_user_id, bexio_account_id, bexio_tax_id
from tenants
where email = 'kunde@example.ch';
```

Rote Flags:
- `has_token = false` → Kunde muss im Dashboard „Verbinden" klicken.
- `bexio_expires_at < now()` und Bot-Fehler im Log → Refresh-Token-Flow greift nicht (rare — meist Refresh-Token widerrufen → neu verbinden).
- Fehler `403 kb_offer_edit` in den Logs → Kunde hat sich vor dem Scope-Update verbunden → einmal neu verbinden lassen.

### „Die Vorschau wird nicht angezeigt"

Logs `[PDF Preview] Error:` in `whatsapp-webhook`. Typische Ursachen:
- Bexio rendert erst ~5s nach Create → gleich nochmal per „Entwurf bearbeiten → Fertig" triggern.
- WhatsApp Media Upload 400 → Token abgelaufen oder Phone-Nummer-ID falsch.

### „Ich kann mich nicht einloggen"

Supabase → Authentication → Users → E-Mail suchen. Dort:
- Status bestätigt? Wenn nicht: Confirmation-Mail nochmal senden.
- Passwort vergessen: Lass den Kunden den Link auf der Login-Seite benutzen.


## Aktions-SQL (Copy-Paste im SQL Editor)

### Session komplett zurücksetzen
```sql
update sessions_handwerker
set step = 'start',
    contact_data = null, bexio_contact_id = null, bexio_invoice_id = null,
    invoice_title = null, manual_positions = null, search_results = null,
    bexio_document_type = 'invoice',
    updated_at = now(),
    expires_at = now() + interval '8 hours'
where phone_number = '+41791234567';
```

### Trial verlängern (+14 Tage)
```sql
update tenants
set trial_ends_at = greatest(trial_ends_at, now()) + interval '14 days',
    updated_at = now()
where email = 'kunde@example.ch';
```

### Bexio-Token löschen (zwingt Re-OAuth)
```sql
update tenants
set bexio_access_token = null,
    bexio_refresh_token = null,
    bexio_expires_at = null,
    bexio_user_id = null, bexio_account_id = null, bexio_tax_id = null,
    updated_at = now()
where email = 'kunde@example.ch';
```

### Cached Bexio-IDs löschen (z.B. nach Firmenwechsel in Bexio)
```sql
update tenants
set bexio_user_id = null, bexio_account_id = null, bexio_tax_id = null,
    updated_at = now()
where email = 'kunde@example.ch';
```

### Account deaktivieren (sanft)
```sql
update tenants set is_active = false, updated_at = now()
where email = 'kunde@example.ch';
```


## Logs filtern (Edge Functions)

Im Log-Viewer `Explore via query` → SQL, z.B.:

```sql
select timestamp, event_message
from function_edge_logs
where function_id = '<whatsapp-webhook-id>'
  and event_message ilike '%+41791234567%'
order by timestamp desc
limit 50;
```

Alternativ im normalen Log-Viewer einfach die Nummer in die Suche eintippen.


## Wann ein Admin-Dashboard bauen?

Sobald eine dieser Bedingungen erfüllt ist:
- Mehr als ~5 Support-Anfragen pro Woche
- Jemand anderes als du Support macht (und keinen Supabase-Zugriff
  bekommen soll)
- Du dich bei „Session resetten" mehr als einmal pro Woche erwischst
  wie du das SQL hier aus dem Repo kopierst

MVP wäre ein `admin.html` geschützt durch eine `admin_users`-Tabelle,
das die SQL-Snippets oben als Buttons anbietet.
