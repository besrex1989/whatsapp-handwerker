// WhatsApp Handwerker Bot — Meta Cloud API + Bexio + Claude AI
// Deployed via GitHub Actions
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

var supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

var PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
var WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN")!;
var VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN")!;
var GRAPH_API = "https://graph.facebook.com/v21.0/" + PHONE_NUMBER_ID + "/messages";

Deno.serve(async (req: Request) => {
  // GET = Meta Webhook Verification
  if (req.method === "GET") {
    var url = new URL(req.url);
    var mode = url.searchParams.get("hub.mode");
    var token = url.searchParams.get("hub.verify_token");
    var challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("[WhatsApp] Webhook verified");
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") {
    return new Response("OK", { status: 200 });
  }

  try {
    var body = await req.json();

    // Parse incoming message
    var entry = body.entry;
    if (!entry || !entry[0]) return new Response("OK", { status: 200 });
    var changes = entry[0].changes;
    if (!changes || !changes[0]) return new Response("OK", { status: 200 });
    var value = changes[0].value;
    var messages = value.messages;
    if (!messages || !messages[0]) return new Response("OK", { status: 200 });

    var msg = messages[0];
    var from = msg.from; // phone number like 41791234567
    var msgType = msg.type;

    var msgBody = "";
    var buttonId = "";
    var listId = "";
    var mediaId = "";
    var mediaMime = "";

    if (msgType === "text") {
      msgBody = msg.text.body.trim();
    } else if (msgType === "interactive") {
      var interactive = msg.interactive;
      if (interactive.type === "button_reply") {
        buttonId = interactive.button_reply.id;
        msgBody = interactive.button_reply.title;
      } else if (interactive.type === "list_reply") {
        listId = interactive.list_reply.id;
        msgBody = interactive.list_reply.title;
      }
    } else if (msgType === "image" || msgType === "document") {
      mediaId = msg[msgType].id;
      mediaMime = msg[msgType].mime_type || "image/jpeg";
    }

    var phone = from.replace(/\s+/g, "");
    if (!phone.startsWith("+")) { phone = "+" + phone; }

    console.log("[WhatsApp] From: " + phone + ", Type: " + msgType + ", Body: " + msgBody + ", Button: " + buttonId);

    // --- Session laden oder erstellen ---
    var { data: existingSession } = await supabase
      .from("sessions_handwerker")
      .select("*")
      .eq("phone_number", phone)
      .single();

    var session = existingSession;

    if (!session) {
      var { data: newSession } = await supabase
        .from("sessions_handwerker")
        .insert({ phone_number: phone })
        .select()
        .single();
      session = newSession;
    }

    if (session) {
      var expiresAt = new Date(session.expires_at).getTime();
      if (expiresAt < Date.now()) {
        await resetSession(session.id);
        session.step = "start";
      }
    }

    // --- Tenant finden + Abo-/Trial-Gate ---
    // Wichtig: der Gate-Check muss auf JEDER eingehenden Nachricht laufen,
    // nicht nur beim ersten Hello einer Session. Sonst könnte ein User,
    // dessen Trial/Abo während einer laufenden Session abläuft, bis zu
    // 8h weiter Rechnungen erstellen, bevor die Sperre greift.
    if (session) {
      var tenant: any = null;

      if (session.tenant_id) {
        var tenantResp = await supabase
          .from("tenants")
          .select("*")
          .eq("id", session.tenant_id)
          .single();
        tenant = tenantResp.data;
      } else {
        // Try multiple phone formats: +41xxx, whatsapp:+41xxx, 41xxx
        var phoneClean = phone.replace("+", "");
        var lookup = await supabase
          .from("tenants")
          .select("*")
          .or("whatsapp_number.eq." + phone + ",whatsapp_number.eq.whatsapp:" + phone + ",whatsapp_number.eq." + phoneClean)
          .single();
        tenant = lookup.data;

        if (!tenant) {
          await sendText(from, "Willkommen! Deine Nummer ist noch nicht registriert.\nBitte melde dich zuerst auf unserer Website an.");
          return new Response("OK", { status: 200 });
        }

        await supabase.from("sessions_handwerker").update({ tenant_id: tenant.id }).eq("id", session.id);
        session.tenant_id = tenant.id;
      }

      // Gate: aktives Abo oder laufender Trial?
      if (tenant) {
        var planRaw = tenant.plan || "trial";
        var isActive = planRaw === "active"
          || planRaw === "active_monthly"
          || planRaw === "active_yearly";

        if (planRaw === "trial") {
          var trialEnd = tenant.trial_ends_at
            ? new Date(tenant.trial_ends_at).getTime()
            : 0;
          if (trialEnd < Date.now()) {
            await sendText(from,
              "Deine Testphase ist abgelaufen.\n" +
              "Bitte upgrade auf ein Abo unter https://www.whatsbill.ch/dashboard.html");
            return new Response("OK", { status: 200 });
          }
        } else if (!isActive) {
          // past_due, cancelled, pending, oder manuell deaktiviert
          await sendText(from,
            "Dein Konto ist nicht aktiv (" + planRaw + ").\n" +
            "Bitte pruefe dein Abo unter https://www.whatsbill.ch/dashboard.html");
          return new Response("OK", { status: 200 });
        }
      }
    }

    if (!session) return new Response("OK", { status: 200 });

    // --- Globale Befehle ---
    var text = msgBody.toLowerCase();
    var choice = buttonId || listId || text;

    if (choice === "reset" || choice === "abbrechen" || choice === "neustart") {
      await resetSession(session.id);
      await sendText(from, "Session zurueckgesetzt. Schreibe etwas um neu zu starten.");
      return new Response("OK", { status: 200 });
    }

    if (choice === "hilfe" || choice === "help") {
      await sendText(from,
        "*Verfuegbare Befehle:*\n\n" +
        "rechnung - Neue Rechnung erstellen\n" +
        "suche - Kontakt suchen\n" +
        "neustart - Session zuruecksetzen\n" +
        "hilfe - Diese Hilfe anzeigen"
      );
      return new Response("OK", { status: 200 });
    }

    // --- Step-basierter Flow ---
    var step = session.step || "start";
    var tenant = session.tenant_id ? await getTenant(session.tenant_id) : null;

    if (step === "start") {
      await updateStep(session.id, "main_menu");
      await sendButtons(from, "Hallo! Was moechtest du tun?", [
        { id: "invoice", title: "Rechnung erstellen" },
        { id: "search", title: "Kontakt suchen" },
      ]);

    } else if (step === "main_menu") {
      if (choice === "invoice" || choice === "1" || text.includes("rechnung")) {
        await updateStep(session.id, "invoice_choice");
        await sendButtons(from, "Was moechtest du tun?", [
          { id: "new_invoice", title: "Neue Rechnung" },
          { id: "edit_draft", title: "Entwurf bearbeiten" },
        ]);
      } else if (choice === "search" || choice === "2" || text.includes("suche")) {
        await updateStep(session.id, "contact_search");
        await sendText(from, "Gib den Suchbegriff ein:");
      } else {
        await sendButtons(from, "Bitte waehle eine Option:", [
          { id: "invoice", title: "Rechnung erstellen" },
          { id: "search", title: "Kontakt suchen" },
        ]);
      }

    } else if (step === "invoice_choice") {
      if (choice === "new_invoice" || text.includes("neu")) {
        await supabase.from("sessions_handwerker").update({
          step: "contact_search", manual_positions: [], updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendText(from, "Neue Rechnung\n\nGib den Namen des Kunden ein um in Bexio zu suchen.\nOder schreibe *neu* um einen neuen Kontakt anzulegen.");
      } else if (choice === "edit_draft" || text.includes("entwurf") || text.includes("bearbeiten")) {
        if (!tenant || !tenant.bexio_access_token) {
          await sendText(from, "Bexio ist noch nicht verbunden. Bitte verbinde zuerst dein Bexio-Konto.");
        } else {
          await updateStep(session.id, "draft_search");
          await sendText(from, "Entwurf suchen\n\nGib den Kundennamen oder Titel ein.\nOder schreibe *alle* um alle Entwuerfe zu sehen.");
        }
      } else {
        await sendButtons(from, "Bitte waehle:", [
          { id: "new_invoice", title: "Neue Rechnung" },
          { id: "edit_draft", title: "Entwurf bearbeiten" },
        ]);
      }

    } else if (step === "draft_search") {
      if (!tenant || !tenant.bexio_access_token) {
        await sendText(from, "Bexio ist noch nicht verbunden.");
      } else if (msgBody.length < 2 && text !== "alle") {
        await sendText(from, "Bitte gib mindestens 2 Buchstaben ein oder schreibe *alle*.");
      } else {
        try {
          await sendText(from, "Entwuerfe werden geladen...");
          var allDrafts = await bexioListDraftInvoices(tenant);
          if (allDrafts.length === 0) {
            await sendButtons(from, "Keine Entwurfs-Rechnungen in Bexio gefunden.", [
              { id: "new_invoice", title: "Neue Rechnung" },
              { id: "reset", title: "Abbrechen" },
            ]);
            await updateStep(session.id, "invoice_choice");
          } else {
            // Enrich drafts with contact names (parallel fetch)
            var uniqueContactIds: number[] = [];
            allDrafts.forEach(function (d: any) {
              if (d.contact_id && uniqueContactIds.indexOf(d.contact_id) === -1) {
                uniqueContactIds.push(d.contact_id);
              }
            });
            var contactMap: Record<number, string> = {};
            await Promise.all(uniqueContactIds.map(async function (cid: number) {
              try {
                var c = await bexioGetContact(tenant, cid);
                contactMap[cid] = c.name_1 || ("Kontakt " + cid);
              } catch (_e) {
                contactMap[cid] = "Kontakt " + cid;
              }
            }));

            // Attach contact name to each draft
            allDrafts.forEach(function (d: any) {
              d._contact_name = d.contact_id ? (contactMap[d.contact_id] || "") : "";
            });

            // Filter by search term (match title, document_nr, or contact name)
            var filtered = allDrafts;
            if (text !== "alle") {
              var term = text.toLowerCase();
              filtered = allDrafts.filter(function (d: any) {
                var t = (d.title || "").toLowerCase();
                var dn = (d.document_nr || "").toLowerCase();
                var cn = (d._contact_name || "").toLowerCase();
                return t.indexOf(term) !== -1 || dn.indexOf(term) !== -1 || cn.indexOf(term) !== -1;
              });
            }

            if (filtered.length === 0) {
              await sendButtons(from, "Keine Entwuerfe fuer \"" + msgBody + "\" gefunden.", [
                { id: "search_again_draft", title: "Nochmal suchen" },
                { id: "reset", title: "Abbrechen" },
              ]);
              await updateStep(session.id, "draft_search_again");
            } else {
              var dRows: Array<{id: string; title: string; description: string}> = [];
              filtered.slice(0, 10).forEach(function (inv: any) {
                var desc = (inv._contact_name || "Kein Kunde") + " - CHF " + (inv.total || "0");
                if (inv.title) { desc = inv.title + " | " + desc; }
                dRows.push({
                  id: "draft_" + inv.id,
                  title: (inv.document_nr || "Rechnung " + inv.id).slice(0, 24),
                  description: desc.slice(0, 72),
                });
              });
              await sendList(from, filtered.length + " Entwurf(e) gefunden:", "Entwurf waehlen", [
                { title: "Entwuerfe", rows: dRows },
              ]);
              await supabase.from("sessions_handwerker").update({
                step: "draft_select", search_results: filtered.slice(0, 10), updated_at: new Date().toISOString(),
              }).eq("id", session.id);
            }
          }
        } catch (draftErr) {
          console.error("[Draft Search] Error:", draftErr);
          await sendText(from, "Fehler beim Laden der Entwuerfe: " + String(draftErr).slice(0, 200));
        }
      }

    } else if (step === "draft_search_again") {
      if (choice === "search_again_draft") {
        await updateStep(session.id, "draft_search");
        await sendText(from, "Gib einen neuen Suchbegriff ein (oder *alle*):");
      } else {
        await resetSession(session.id);
        await sendText(from, "Abgebrochen. Schreibe etwas um neu zu starten.");
      }

    } else if (step === "draft_select") {
      var draftMatch = (buttonId || listId || "").match(/^draft_(\d+)$/);
      if (draftMatch) {
        var draftId = parseInt(draftMatch[1], 10);
        var drafts2 = (session.search_results || []) as any[];
        var selectedDraft = drafts2.find(function (d: any) { return d.id === draftId; });
        if (selectedDraft) {
          await supabase.from("sessions_handwerker").update({
            bexio_invoice_id: draftId,
            invoice_title: selectedDraft.title || "Rechnung",
            invoice_data: { document_nr: selectedDraft.document_nr, total: selectedDraft.total },
            step: "draft_position_desc", updated_at: new Date().toISOString(),
          }).eq("id", session.id);
          await sendText(from,
            "*Entwurf geoeffnet*\n\n" +
            "Nr: " + (selectedDraft.document_nr || "-") + "\n" +
            "Titel: " + (selectedDraft.title || "-") + "\n" +
            "Aktuelles Total: CHF " + (selectedDraft.total || "0") + "\n\n" +
            "Beschreibe die neue Position:"
          );
        } else {
          await sendText(from, "Entwurf nicht gefunden. Bitte waehle aus der Liste.");
        }
      } else {
        await sendText(from, "Bitte waehle einen Entwurf aus der Liste.");
      }

    } else if (step === "draft_position_desc") {
      if (!msgBody) {
        await sendText(from, "Bitte beschreibe die Position.");
      } else {
        await supabase.from("sessions_handwerker").update({
          current_position_desc: msgBody, step: "draft_position_amount", updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendText(from,
          "Position: *" + msgBody + "*\n\n" +
          "Menge und Einheit?\n" +
          "(z.B. *5 Std*, *2.5 m2*, *3 Stk* oder *pauschal*)"
        );
      }

    } else if (step === "draft_position_amount") {
      var dParsedAu = parseAmountUnit(msgBody);
      if (!dParsedAu) {
        await sendText(from,
          "Bitte im Format *5 Std*, *2.5 m2*, *pauschal* oder nur *1*."
        );
      } else {
        await supabase.from("sessions_handwerker").update({
          current_position_amount: dParsedAu.amount,
          current_position_unit: dParsedAu.unit,
          step: "draft_position_price", updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        var dPricePrompt = (dParsedAu.amount !== 1 && dParsedAu.unit)
          ? "Preis pro " + dParsedAu.unit + " in CHF? (z.B. 120.00)"
          : "Preis in CHF? (z.B. 150.00)";
        await sendText(from, dPricePrompt);
      }

    } else if (step === "draft_position_price") {
      var dPriceText = msgBody.replace("'", "").replace(",", ".");
      var dPrice = parseFloat(dPriceText);
      if (isNaN(dPrice) || dPrice <= 0) {
        await sendText(from, "Bitte gib einen gueltigen Preis ein (z.B. 150.00).");
      } else if (!tenant || !session.bexio_invoice_id) {
        await sendText(from, "Fehler: Kein Entwurf ausgewaehlt.");
      } else {
        try {
          await sendText(from, "Position wird hinzugefuegt...");
          var dAmt = typeof session.current_position_amount === "number"
            ? session.current_position_amount
            : parseFloat(session.current_position_amount || "1");
          if (isNaN(dAmt) || dAmt <= 0) dAmt = 1;
          await bexioAddInvoicePosition(tenant, session.bexio_invoice_id, {
            description: session.current_position_desc || "",
            amount: dAmt,
            unit: session.current_position_unit || "",
            price: dPrice,
          });
          var updated = await bexioGetInvoice(tenant, session.bexio_invoice_id);
          await supabase.from("sessions_handwerker").update({
            current_position_desc: null, current_position_price: null,
            current_position_amount: null, current_position_unit: null,
            step: "draft_position_more", updated_at: new Date().toISOString(),
          }).eq("id", session.id);
          await sendButtons(from,
            "Position hinzugefuegt!\n\nNeues Total: CHF " + (updated.total || "0"),
            [
              { id: "add_more_draft", title: "Weitere Position" },
              { id: "finish_draft", title: "Fertig" },
            ]
          );
        } catch (addErr) {
          console.error("[Draft Add Position] Error:", addErr);
          await sendText(from, "Fehler beim Hinzufuegen: " + String(addErr).slice(0, 200));
        }
      }

    } else if (step === "draft_position_more") {
      if (choice === "add_more_draft" || text === "ja" || text === "weitere") {
        await updateStep(session.id, "draft_position_desc");
        await sendText(from, "Beschreibe die naechste Position:");
      } else if (choice === "finish_draft" || text === "fertig" || text === "nein") {
        await sendText(from, "Fertig! Der Entwurf wurde aktualisiert. Du findest ihn in Bexio.");
        await resetSession(session.id);
      } else {
        await sendButtons(from, "Was moechtest du tun?", [
          { id: "add_more_draft", title: "Weitere Position" },
          { id: "finish_draft", title: "Fertig" },
        ]);
      }

    } else if (step === "contact_search") {
      if (text === "neu") {
        await updateStep(session.id, "contact_new_name");
        await sendText(from, "Neuer Kontakt: Wie heisst der Kunde? (Firma oder Name)");
      } else if (msgBody.length < 2) {
        await sendText(from, "Bitte gib mindestens 2 Buchstaben ein.");
      } else if (!tenant) {
        await sendText(from, "Fehler: Tenant nicht gefunden. Bitte schreibe *neustart*.");
      } else if (!tenant.bexio_access_token) {
        await sendText(from, "Bexio ist noch nicht verbunden.\nBitte verbinde zuerst dein Bexio-Konto im Dashboard.\n\nSchreibe *neu* um einen Kontakt manuell anzulegen.");
      } else {
        try {
          var contacts = await bexioSearchContacts(tenant, msgBody);
          if (contacts.length === 0) {
            await sendButtons(from, "Keine Kontakte fuer \"" + msgBody + "\" gefunden.", [
              { id: "new_contact", title: "Neu anlegen" },
              { id: "search_again", title: "Nochmal suchen" },
            ]);
            await updateStep(session.id, "contact_select");
          } else {
            var rows: Array<{id: string; title: string; description: string}> = [];
            contacts.slice(0, 10).forEach(function (c: any, i: number) {
              var details = [c.address, c.city].filter(Boolean).join(", ");
              rows.push({
                id: "contact_" + c.id,
                title: (c.name_1 || "").slice(0, 24),
                description: details.slice(0, 72),
              });
            });
            await sendList(from, contacts.length + " Kontakt(e) gefunden:", "Kontakt waehlen", [
              { title: "Kontakte", rows: rows },
            ]);
            await supabase.from("sessions_handwerker").update({
              step: "contact_select", search_results: contacts.slice(0, 10), updated_at: new Date().toISOString(),
            }).eq("id", session.id);
          }
        } catch (searchErr) {
          console.error("[Contact Search] Error:", searchErr);
          await sendText(from, "Fehler bei der Bexio-Suche: " + String(searchErr).slice(0, 200) + "\n\nSchreibe *neu* um einen Kontakt manuell anzulegen, oder versuche es erneut.");
        }
      }

    } else if (step === "contact_select") {
      if (choice === "new_contact" || text === "neu") {
        await updateStep(session.id, "contact_new_name");
        await sendText(from, "Wie heisst der Kunde? (Firma oder Name)");
      } else if (choice === "search_again") {
        await updateStep(session.id, "contact_search");
        await sendText(from, "Gib den Suchbegriff ein:");
      } else {
        // Check for list selection (contact_123) or number input
        var contactId = 0;
        var contactName = "";
        var contactMatch = (buttonId || listId || "").match(/^contact_(\d+)$/);
        if (contactMatch) {
          contactId = parseInt(contactMatch[1], 10);
          var results = session.search_results || [];
          var found = results.find(function (c: any) { return c.id === contactId; });
          if (found) contactName = (found as any).name_1;
        } else {
          var idx = parseInt(text, 10);
          var results2 = session.search_results || [];
          if (!isNaN(idx) && idx >= 1 && idx <= results2.length) {
            var selectedContact = results2[idx - 1] as any;
            contactId = selectedContact.id;
            contactName = selectedContact.name_1;
          }
        }
        if (contactId > 0) {
          await supabase.from("sessions_handwerker").update({
            bexio_contact_id: contactId,
            contact_data: { name: contactName },
            step: "invoice_title",
            updated_at: new Date().toISOString(),
          }).eq("id", session.id);
          await sendText(from, "Kontakt: *" + contactName + "*\n\nWie soll die Rechnung heissen? (Titel)");
        } else {
          await sendText(from, "Bitte waehle einen Kontakt aus der Liste.");
        }
      }

    } else if (step === "contact_new_name") {
      if (!msgBody) {
        await sendText(from, "Bitte gib einen Namen ein.");
      } else {
        await supabase.from("sessions_handwerker").update({
          contact_data: { name: msgBody }, step: "contact_new_address", updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendButtons(from, "Adresse eingeben?", [
          { id: "enter_address", title: "Ja, Adresse eingeben" },
          { id: "skip_address", title: "Ueberspringen" },
        ]);
      }

    } else if (step === "contact_new_address") {
      if (choice === "enter_address") {
        await supabase.from("sessions_handwerker").update({
          step: "contact_new_address_input", updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendText(from, "Gib die Adresse ein im Format:\n*Strasse Nr, PLZ Ort*\n\nZ.B. Teststrasse 14, 8000 Zuerich");
      } else if (choice === "skip_address" || text === "skip") {
        if (tenant) {
          try {
            var contactData = (session.contact_data || {}) as any;
            var newContact = await bexioCreateContact(tenant, {
              name: contactData.name || "Unbekannt", address: "", postcode: "", city: "",
            });
            await supabase.from("sessions_handwerker").update({
              bexio_contact_id: newContact.id,
              contact_data: { name: newContact.name_1 },
              step: "invoice_title", updated_at: new Date().toISOString(),
            }).eq("id", session.id);
            await sendText(from, "Kontakt *" + newContact.name_1 + "* erstellt (ID: " + newContact.id + ")\n\nWie soll die Rechnung heissen? (Titel)");
          } catch (err: any) {
            console.error("[Contact create] Error:", err);
            await sendText(from, "Fehler beim Erstellen des Kontakts:\n" + (err?.message || String(err)));
          }
        }
      } else {
        await sendButtons(from, "Bitte waehle aus:", [
          { id: "enter_address", title: "Ja, Adresse eingeben" },
          { id: "skip_address", title: "Ueberspringen" },
        ]);
      }

    } else if (step === "contact_new_address_input") {
      if (!msgBody || msgBody.length < 2) {
        await sendText(from, "Bitte gib die Adresse ein (Strasse Nr, PLZ Ort).");
      } else if (tenant) {
        try {
          var contactData = (session.contact_data || {}) as any;
          var address = "";
          var postcode = "";
          var city = "";
          var parts = msgBody.split(",").map(function (s: string) { return s.trim(); });
          address = parts[0] || "";
          if (parts[1]) {
            var plzMatch = parts[1].match(/^(\d{4})\s+(.+)/);
            if (plzMatch) { postcode = plzMatch[1]; city = plzMatch[2]; }
            else { city = parts[1]; }
          }
          var newContact = await bexioCreateContact(tenant, {
            name: contactData.name || "Unbekannt", address: address, postcode: postcode, city: city,
          });
          await supabase.from("sessions_handwerker").update({
            bexio_contact_id: newContact.id,
            contact_data: { name: newContact.name_1, city: newContact.city || city },
            step: "invoice_title", updated_at: new Date().toISOString(),
          }).eq("id", session.id);
          await sendText(from, "Kontakt *" + newContact.name_1 + "* erstellt (ID: " + newContact.id + ")\n\nWie soll die Rechnung heissen? (Titel)");
        } catch (err: any) {
          console.error("[Contact create] Error:", err);
          await sendText(from, "Fehler beim Erstellen des Kontakts:\n" + (err?.message || String(err)));
        }
      }

    } else if (step === "invoice_title") {
      if (!msgBody) {
        await sendText(from, "Bitte gib einen Titel fuer die Rechnung ein.");
      } else {
        await supabase.from("sessions_handwerker").update({
          invoice_title: msgBody, step: "position_desc", updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendText(from, "Titel: *" + msgBody + "*\n\nJetzt die Positionen.\nBeschreibe die erste Position:");
      }

    } else if (step === "position_desc") {
      if (!msgBody) {
        await sendText(from, "Bitte beschreibe die Position.");
      } else {
        await supabase.from("sessions_handwerker").update({
          current_position_desc: msgBody, step: "position_amount", updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendText(from,
          "Position: *" + msgBody + "*\n\n" +
          "Menge und Einheit?\n" +
          "(z.B. *5 Std*, *2.5 m2*, *3 Stk* oder *pauschal*)"
        );
      }

    } else if (step === "position_amount") {
      var parsedAu = parseAmountUnit(msgBody);
      if (!parsedAu) {
        await sendText(from,
          "Bitte im Format *5 Std*, *2.5 m2*, *pauschal* oder nur *1*."
        );
      } else {
        await supabase.from("sessions_handwerker").update({
          current_position_amount: parsedAu.amount,
          current_position_unit: parsedAu.unit,
          step: "position_price", updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        var pricePrompt = (parsedAu.amount !== 1 && parsedAu.unit)
          ? "Preis pro " + parsedAu.unit + " in CHF? (z.B. 120.00)"
          : "Preis in CHF? (z.B. 150.00)";
        await sendText(from, pricePrompt);
      }

    } else if (step === "position_price") {
      var priceText = msgBody.replace("'", "").replace(",", ".");
      var price = parseFloat(priceText);
      if (isNaN(price) || price <= 0) {
        await sendText(from, "Bitte gib einen gueltigen Preis ein (z.B. 150.00).");
      } else {
        var pAmt = typeof session.current_position_amount === "number"
          ? session.current_position_amount
          : parseFloat(session.current_position_amount || "1");
        if (isNaN(pAmt) || pAmt <= 0) pAmt = 1;
        var pUnit = session.current_position_unit || "";
        var lineTotal = Math.round(pAmt * price * 100) / 100;
        var positions = session.manual_positions || [];
        positions.push({
          description: session.current_position_desc || "",
          amount: pAmt, unit: pUnit, price: price, total: lineTotal,
        });
        var total = positions.reduce(function (s: number, p: any) {
          var lt = typeof p.total === "number" ? p.total : (p.amount || 1) * (p.price || 0);
          return s + lt;
        }, 0);
        await supabase.from("sessions_handwerker").update({
          manual_positions: positions,
          current_position_desc: null, current_position_price: null,
          current_position_amount: null, current_position_unit: null,
          step: "position_more", updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendButtons(from,
          "Position hinzugefuegt!\n\nPositionen: " + positions.length + "\nTotal: CHF " + total.toFixed(2),
          [
            { id: "add_more", title: "Weitere Position" },
            { id: "finish", title: "Rechnung erstellen" },
          ]
        );
      }

    } else if (step === "position_more") {
      if (choice === "add_more" || text === "ja" || text === "weitere") {
        await updateStep(session.id, "position_desc");
        await sendText(from, "Beschreibe die naechste Position:");
      } else if (choice === "finish" || text === "fertig" || text === "nein" || text === "erstellen") {
        var positions2 = session.manual_positions || [];
        var total2 = positions2.reduce(function (s: number, p: any) {
          var lt = typeof p.total === "number" ? p.total : (p.amount || 1) * (p.price || 0);
          return s + lt;
        }, 0);
        var cData = session.contact_data as any;
        var cName = cData ? cData.name : ("ID " + session.bexio_contact_id);
        var summary = "*Rechnungs-Zusammenfassung*\n\n";
        summary += "Titel: " + session.invoice_title + "\n";
        summary += "Kunde: " + cName + "\n\n";
        positions2.forEach(function (p: any, i: number) {
          summary += (i + 1) + ". " + formatPositionLine(p) + "\n";
        });
        summary += "\n*Total: CHF " + total2.toFixed(2) + "*";
        await sendText(from, summary);
        await updateStep(session.id, "invoice_confirm");
        await sendButtons(from, "Rechnung jetzt in Bexio erstellen?", [
          { id: "confirm_invoice", title: "Ja, erstellen" },
          { id: "cancel_invoice", title: "Abbrechen" },
        ]);
      } else {
        await sendButtons(from, "Was moechtest du tun?", [
          { id: "add_more", title: "Weitere Position" },
          { id: "finish", title: "Rechnung erstellen" },
        ]);
      }

    } else if (step === "invoice_confirm") {
      if (choice === "cancel_invoice" || text === "abbrechen" || text === "nein") {
        await resetSession(session.id);
        await sendText(from, "Rechnung abgebrochen. Schreibe etwas um neu zu starten.");
      } else if (choice === "confirm_invoice" || text === "ja" || text === "ok") {
        if (tenant) {
          await sendText(from, "Rechnung wird in Bexio erstellt...");
          try {
            var invoice = await bexioCreateInvoice(tenant, {
              contactId: session.bexio_contact_id,
              title: session.invoice_title || "Rechnung",
              positions: session.manual_positions || [],
            });
            // NICHT issuen — bleibt als Entwurf, damit spaeter Positionen ergaenzt werden koennen
            await sendText(from,
              "*Entwurf erstellt!*\n\n" +
              "Rechnungs-Nr: " + invoice.document_nr + "\n" +
              "Total: CHF " + invoice.total + "\n\n" +
              "Die Rechnung ist als *Entwurf* in Bexio gespeichert.\n" +
              "Du kannst spaeter weitere Positionen hinzufuegen ueber *Rechnung erstellen -> Entwurf bearbeiten*."
            );
            try { await sendEmailNotification(tenant.email, invoice.document_nr, invoice.total); } catch (_e) { /* ok */ }
          } catch (invErr) {
            console.error("Invoice error:", invErr);
            await sendText(from, "Fehler beim Erstellen der Rechnung:\n\n" + String(invErr).slice(0, 300) + "\n\nBitte pruefe deine Bexio-Verbindung.");
          }
          await resetSession(session.id);
        }
      } else {
        await sendButtons(from, "Rechnung erstellen?", [
          { id: "confirm_invoice", title: "Ja, erstellen" },
          { id: "cancel_invoice", title: "Abbrechen" },
        ]);
      }

    } else if (step === "receipt_upload") {
      if (mediaId) {
        await handleReceiptUpload(from, session, tenant, mediaId, mediaMime);
      } else {
        await sendButtons(from, "Bitte sende ein Foto oder PDF des Belegs.", [
          { id: "abbrechen", title: "Abbrechen" },
        ]);
      }

    } else if (step === "receipt_confirm") {
      if (choice === "save_receipt" || text === "ja" || text === "ok") {
        await sendText(from, "Beleg gespeichert!");
        await resetSession(session.id);
      } else if (choice === "discard_receipt" || text === "nein" || text === "abbrechen") {
        await sendText(from, "Beleg verworfen.");
        await resetSession(session.id);
      } else {
        await sendButtons(from, "Beleg speichern?", [
          { id: "save_receipt", title: "Ja, speichern" },
          { id: "discard_receipt", title: "Verwerfen" },
        ]);
      }

    } else {
      await updateStep(session.id, "main_menu");
      await sendButtons(from, "Bitte waehle:", [
        { id: "invoice", title: "Rechnung erstellen" },
        { id: "search", title: "Kontakt suchen" },
      ]);
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[WhatsApp Webhook] Error:", err);
    try {
      var errorFrom = "";
      try { var b = JSON.parse(await req.clone().text()); errorFrom = b.entry[0].changes[0].value.messages[0].from; } catch (_e2) { /* ok */ }
      if (errorFrom) {
        await sendText(errorFrom, "Es ist ein Fehler aufgetreten: " + String(err).slice(0, 200) + "\n\nSchreibe *neustart* um es erneut zu versuchen.");
      }
    } catch (_e3) { /* ok */ }
    return new Response("OK", { status: 200 });
  }
});

// ===== WhatsApp Meta Cloud API - Sending =====

async function sendText(to: string, body: string): Promise<void> {
  await fetch(GRAPH_API, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + WHATSAPP_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: body },
    }),
  });
}

async function sendButtons(to: string, body: string, buttons: Array<{id: string; title: string}>): Promise<void> {
  var buttonItems = buttons.map(function (b) {
    return { type: "reply", reply: { id: b.id, title: b.title } };
  });

  await fetch(GRAPH_API, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + WHATSAPP_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: buttonItems },
      },
    }),
  });
}

async function sendList(
  to: string,
  body: string,
  buttonText: string,
  sections: Array<{title: string; rows: Array<{id: string; title: string; description: string}>}>,
): Promise<void> {
  await fetch(GRAPH_API, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + WHATSAPP_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: { button: buttonText, sections: sections },
      },
    }),
  });
}

// ===== Helper Functions =====

async function updateStep(sessionId: string, step: string): Promise<void> {
  await supabase.from("sessions_handwerker").update({ step: step, updated_at: new Date().toISOString() }).eq("id", sessionId);
}

async function resetSession(sessionId: string): Promise<void> {
  var expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  await supabase.from("sessions_handwerker").update({
    step: "start", contact_data: null, bexio_contact_id: null, bexio_invoice_id: null,
    bexio_invoice_nr: null, invoice_title: null, invoice_data: null, manual_positions: null,
    current_position_desc: null, current_position_price: null,
    current_position_amount: null, current_position_unit: null,
    receipt_data: null,
    receipt_base64: null, receipt_type: null, search_results: null,
    expires_at: expiresAt, updated_at: new Date().toISOString(),
  }).eq("id", sessionId);
}

async function getTenant(tenantId: string): Promise<any> {
  var { data } = await supabase.from("tenants").select("*").eq("id", tenantId).single();
  return data;
}

// ===== Bexio API =====

async function getBexioToken(tenant: any): Promise<string> {
  var token = tenant.bexio_access_token;
  if (tenant.bexio_expires_at) {
    var expiresAt = new Date(tenant.bexio_expires_at).getTime();
    if (Date.now() > expiresAt - 300000) {
      console.log("[Bexio] Token expired, refreshing...");
      var resp = await fetch("https://auth.bexio.com/realms/bexio/protocol/openid-connect/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token", refresh_token: tenant.bexio_refresh_token,
          client_id: Deno.env.get("BEXIO_CLIENT_ID")!, client_secret: Deno.env.get("BEXIO_CLIENT_SECRET")!,
        }),
      });
      if (!resp.ok) {
        var errText = await resp.text();
        console.error("[Bexio] Token refresh failed:", resp.status, errText);
        throw new Error("Bexio Token-Refresh fehlgeschlagen (" + resp.status + ")");
      }
      var data = await resp.json();
      token = data.access_token;
      console.log("[Bexio] Token refreshed successfully");
      await supabase.from("tenants").update({
        bexio_access_token: data.access_token,
        bexio_refresh_token: data.refresh_token || tenant.bexio_refresh_token,
        bexio_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      }).eq("id", tenant.id);
    }
  }
  if (!token) {
    throw new Error("Kein Bexio-Token vorhanden");
  }
  return token;
}

async function bexioSearchContacts(tenant: any, term: string): Promise<any[]> {
  var token = await getBexioToken(tenant);
  console.log("[Bexio] Searching contacts for:", term);
  var resp = await fetch("https://api.bexio.com/2.0/contact/search", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify([{ field: "name_1", value: term, criteria: "like" }]),
  });
  if (!resp.ok) {
    var errText = await resp.text();
    console.error("[Bexio] Search error:", resp.status, errText);
    throw new Error("Bexio Suche fehlgeschlagen (" + resp.status + "): " + errText.slice(0, 200));
  }
  var data = await resp.json();
  if (!Array.isArray(data)) {
    console.error("[Bexio] Search returned non-array:", JSON.stringify(data));
    return [];
  }
  console.log("[Bexio] Found", data.length, "contacts");
  return data;
}

async function bexioCreateContact(tenant: any, c: { name: string; address: string; postcode: string; city: string }): Promise<any> {
  var token = await getBexioToken(tenant);

  // Auto-fetch user_id if missing (required as owner_id)
  var userId = tenant.bexio_user_id;
  if (!userId) {
    console.log("[Bexio] Fetching user_id for contact creation...");
    var userResp = await fetch("https://api.bexio.com/3.0/users/me", {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    if (userResp.ok) {
      var userData = await userResp.json();
      userId = userData.id;
      await supabase.from("tenants").update({ bexio_user_id: userId }).eq("id", tenant.id);
      console.log("[Bexio] Got user_id:", userId);
    } else {
      var userErr = await userResp.text();
      console.error("[Bexio] Failed to fetch user_id:", userErr);
    }
  }

  if (!userId) {
    throw new Error("Bexio user_id konnte nicht ermittelt werden. Bitte Bexio neu verbinden.");
  }

  // Bexio POST /2.0/contact schema accepts: name_1, contact_type_id,
  // user_id (required), owner_id, postcode, city, plus the structured
  // street fields (street_name + house_number). It does NOT accept
  // 'address' (legacy) nor 'zip_code'.
  var payload: any = {
    contact_type_id: 1,
    name_1: c.name,
    user_id: userId,
    owner_id: userId,
  };
  if (c.address) {
    var streetMatch = c.address.match(/^(.+?)\s+(\d+[a-zA-Z]?)\s*$/);
    if (streetMatch) {
      payload.street_name = streetMatch[1].trim();
      payload.house_number = streetMatch[2].trim();
    } else {
      payload.street_name = c.address;
    }
  }
  if (c.postcode) payload.postcode = c.postcode;
  if (c.city) payload.city = c.city;

  console.log("[Bexio] Creating contact:", JSON.stringify(payload));
  var resp = await fetch("https://api.bexio.com/2.0/contact", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    var errText = await resp.text();
    console.error("[Bexio] Create contact failed (" + resp.status + "):", errText);
    throw new Error("Bexio Kontakt-Erstellung fehlgeschlagen: " + errText);
  }

  var data = await resp.json();
  console.log("[Bexio] Contact created:", data.id, data.name_1);
  return data;
}

// Fetch-or-use-cached Bexio per-tenant ids (user_id, account_id, tax_id).
// Force=true ignores the cached values and always pulls fresh from Bexio.
// Also returns an ordered list of alternative tax candidates so callers can
// fall back to the next one if Bexio rejects the first choice on invoice
// creation (e.g. tenant has a historic 7.7% entry that Bexio no longer
// accepts for 2024+ invoices).
async function ensureBexioIds(
  tenant: any, token: string, force: boolean,
): Promise<{ userId: number | null; accountId: number | null; taxId: number | null; taxCandidates: number[] }> {
  var userId = force ? null : tenant.bexio_user_id;
  var accountId = force ? null : tenant.bexio_account_id;
  var taxId = force ? null : tenant.bexio_tax_id;
  var taxCandidates: number[] = [];
  var updated = false;

  if (!userId) {
    console.log("[Bexio] Fetching user_id...");
    var userResp = await fetch("https://api.bexio.com/3.0/users/me", {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    if (userResp.ok) {
      var userData = await userResp.json();
      userId = userData.id;
      updated = true;
    }
  }
  if (!accountId) {
    console.log("[Bexio] Fetching accounts...");
    var accResp = await fetch("https://api.bexio.com/2.0/accounts", {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    if (accResp.ok) {
      var accounts = await accResp.json();
      var revAcc = Array.isArray(accounts)
        ? accounts.find(function (a: any) { return a.account_no && String(a.account_no).startsWith("3"); })
        : null;
      if (revAcc) { accountId = revAcc.id; updated = true; }
    }
  }
  if (!taxId) {
    // Fetch taxes from both the /3.0 and the legacy /2.0 endpoint and merge
    // the results. /3.0/taxes returns empty for many tenants (observed),
    // /2.0/tax is the reliable source. We dedupe by id.
    console.log("[Bexio] Fetching taxes...");
    async function fetchTaxList(path: string): Promise<any[]> {
      try {
        var r = await fetch("https://api.bexio.com" + path, {
          headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        });
        if (!r.ok) {
          console.warn("[Bexio] " + path + " returned", r.status);
          return [];
        }
        var j = await r.json();
        if (Array.isArray(j)) return j;
        if (j && Array.isArray(j.data)) return j.data;
        if (j && Array.isArray(j.items)) return j.items;
        console.warn("[Bexio] " + path + " returned unexpected shape:", JSON.stringify(j).slice(0, 200));
        return [];
      } catch (e) {
        console.warn("[Bexio] " + path + " fetch error:", String(e));
        return [];
      }
    }
    var taxes3 = await fetchTaxList("/3.0/taxes");
    var taxes2 = await fetchTaxList("/2.0/tax");
    var seenIds: Record<string, boolean> = {};
    var taxes = (taxes3.concat(taxes2)).filter(function (t: any) {
      if (!t || t.id == null) return false;
      var key = String(t.id);
      if (seenIds[key]) return false;
      seenIds[key] = true;
      return true;
    });

    // Dump the full list (all fields) so we can diagnose weird setups from
    // the Edge Function logs without having to guess at the schema.
    console.log("[Bexio] Taxes found (3.0=" + taxes3.length + ", 2.0=" + taxes2.length + ", merged=" + taxes.length + "):",
      JSON.stringify(taxes));

    var currentYear = new Date().getFullYear();

    function isSalesLike(t: any): boolean {
      var ty = String(t.type || "").toLowerCase();
      // sales_tax, sales_tax_saldo, sales_tax_reduced, ...
      return ty.indexOf("sales") === 0;
    }
    function isActive(t: any): boolean {
      return t.is_active === undefined || t.is_active === null ? true : !!t.is_active;
    }
    // Valid for the current year: start_year <= year and (end_year >= year
    // or end_year missing). Missing start_year is treated as valid.
    // This is what excludes the historic Swiss 7.7% (UN77) tax whose
    // end_year is typically 2023 while the current year is 2024+.
    function isCurrentlyValid(t: any): boolean {
      var sy = t.start_year != null ? parseInt(String(t.start_year), 10) : null;
      var ey = t.end_year != null ? parseInt(String(t.end_year), 10) : null;
      if (sy && sy > currentYear) return false;
      if (ey && ey < currentYear) return false;
      return true;
    }

    // Build an ordered candidate list — best match first.
    //   tier 1: active, sales-like, currently valid, positive rate
    //   tier 2: active, sales-like, positive rate (ignore year)
    //   tier 3: active, sales-like (any rate)
    //   tier 4: active (any type)
    // Within each tier we sort by year-validity first, then by rate (desc).
    var byPriority: any[] = [];
    var seen: Record<string, boolean> = {};
    function addTier(list: any[]) {
      list.sort(function (a: any, b: any) {
        var av = isCurrentlyValid(a) ? 1 : 0;
        var bv = isCurrentlyValid(b) ? 1 : 0;
        if (av !== bv) return bv - av;
        var ra = parseFloat(String(a.value || "0"));
        var rb = parseFloat(String(b.value || "0"));
        return rb - ra;
      });
      for (var i = 0; i < list.length; i++) {
        var k = String(list[i].id);
        if (seen[k]) continue;
        seen[k] = true;
        byPriority.push(list[i]);
      }
    }
    addTier(taxes.filter(function (t: any) {
      return isActive(t) && isSalesLike(t) && isCurrentlyValid(t) && parseFloat(String(t.value || "0")) > 0;
    }));
    addTier(taxes.filter(function (t: any) {
      return isActive(t) && isSalesLike(t) && parseFloat(String(t.value || "0")) > 0;
    }));
    addTier(taxes.filter(function (t: any) {
      return isActive(t) && isSalesLike(t);
    }));
    addTier(taxes.filter(function (t: any) { return isActive(t); }));

    taxCandidates = byPriority.map(function (t: any) { return t.id; });

    var sales = byPriority[0] || null;
    if (sales) {
      console.log("[Bexio] Selected tax:", sales.id,
        "type=" + sales.type, "value=" + sales.value, "code=" + (sales.code || ""),
        "years=[" + (sales.start_year || "") + "-" + (sales.end_year || "") + "]");
      console.log("[Bexio] Tax candidates (ordered):", JSON.stringify(taxCandidates));
      taxId = sales.id;
      updated = true;
    } else {
      console.warn("[Bexio] No usable tax found in either /3.0/taxes or /2.0/tax.");
    }
  }
  if (updated) {
    await supabase.from("tenants").update({
      bexio_user_id: userId, bexio_account_id: accountId, bexio_tax_id: taxId,
      updated_at: new Date().toISOString(),
    }).eq("id", tenant.id);
    // Keep the in-memory tenant object in sync in case the caller uses it again.
    tenant.bexio_user_id = userId;
    tenant.bexio_account_id = accountId;
    tenant.bexio_tax_id = taxId;
  }
  return { userId: userId, accountId: accountId, taxId: taxId, taxCandidates: taxCandidates };
}

// Detect "stale cached id" errors in a Bexio 422 body.
function isBexioIdValidationError(errText: string): boolean {
  var t = String(errText || "").toLowerCase();
  return t.indexOf("tax_id") >= 0
    || t.indexOf("account_id") >= 0
    || t.indexOf("user_id") >= 0;
}

async function bexioCreateInvoice(tenant: any, params: { contactId: number; title: string; positions: any[] }): Promise<any> {
  var token = await getBexioToken(tenant);

  // Build a single prioritized list of tax options to try in sequence:
  //   1. Cached tax_id (if set)
  //   2. Ordered candidates from ensureBexioIds (current year first, then fallbacks)
  //   3. null (no tax_id, last-resort)
  // We do a force-refresh on the first real candidate run to avoid using a
  // stale cached id that has since been retired.
  var ids = await ensureBexioIds(tenant, token, false);
  if (!ids.userId || !ids.accountId) {
    // Try a force refresh once in case user_id/account_id are missing.
    ids = await ensureBexioIds(tenant, token, true);
    if (!ids.userId || !ids.accountId) {
      throw new Error("Bexio-Konfiguration unvollstaendig (user_id=" + ids.userId + ", account_id=" + ids.accountId + ")");
    }
  }

  var today = new Date().toISOString().split("T")[0];
  var dueDate = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];

  function buildBody(taxOverride: number | null): any {
    var positionItems = params.positions.map(function (p: any) {
      var amt = typeof p.amount === "number" ? p.amount : parseFloat(p.amount || "1");
      if (isNaN(amt) || amt <= 0) amt = 1;
      // Embed the unit in the position text so it appears on the printed
      // invoice. Proper unit_id lookup via /2.0/unit could come later.
      var txt = p.description || "";
      if (p.unit) txt = txt + " (" + p.unit + ")";
      var pos: any = {
        type: "KbPositionCustom",
        text: txt,
        unit_price: (p.price || 0).toFixed(2),
        amount: String(amt),
        account_id: ids.accountId,
      };
      if (taxOverride != null) pos.tax_id = taxOverride;
      return pos;
    });
    return {
      title: params.title, contact_id: params.contactId, user_id: ids.userId,
      is_valid_from: today, is_valid_to: dueDate, mwst_type: 0, mwst_is_net: true, positions: positionItems,
    };
  }

  async function postWithTax(taxOverride: number | null, label: string): Promise<{ ok: boolean; body: any; status: number; errText: string }> {
    console.log("[Bexio] Creating invoice (" + label + ")", {
      userId: ids.userId, accountId: ids.accountId,
      taxId: taxOverride == null ? "(omitted)" : taxOverride,
    });
    var resp = await fetch("https://api.bexio.com/2.0/kb_invoice", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(buildBody(taxOverride)),
    });
    if (resp.ok) {
      return { ok: true, body: await resp.json(), status: resp.status, errText: "" };
    }
    var errText = await resp.text();
    console.warn("[Bexio] Invoice attempt (" + label + ") failed:", resp.status, errText.slice(0, 200));
    return { ok: false, body: null, status: resp.status, errText: errText };
  }

  async function persistWinningTax(tx: number | null) {
    if (tx != null && tx !== tenant.bexio_tax_id) {
      await supabase.from("tenants").update({
        bexio_tax_id: tx, updated_at: new Date().toISOString(),
      }).eq("id", tenant.id);
      tenant.bexio_tax_id = tx;
    }
  }

  // 1) First try the cached tax_id if we have one.
  var first: any = null;
  if (ids.taxId != null) {
    first = await postWithTax(ids.taxId, "cached tax " + ids.taxId);
    if (first.ok) { await persistWinningTax(ids.taxId); return first.body; }
    // If failure is not a tax_id validation, don't bother iterating.
    if (first.status !== 422 || !/tax_id/i.test(first.errText)) {
      throw new Error("Bexio Rechnung (" + first.status + "): " + first.errText.slice(0, 300));
    }
  }

  // 2) Force-refresh ids so we actually get the candidate list populated.
  console.log("[Bexio] Cached tax_id rejected or missing — force-refreshing tax list.");
  ids = await ensureBexioIds(tenant, token, true);

  // 3) Iterate through the prioritized candidate list.
  var tried: Record<string, boolean> = {};
  if (ids.taxId != null && first != null) tried[String(ids.taxId)] = true; // already tried above if same
  var candidates = (ids.taxCandidates || []).filter(function (c) {
    if (tried[String(c)]) return false;
    tried[String(c)] = true;
    return true;
  });
  console.log("[Bexio] Will try tax candidates in order:", JSON.stringify(candidates));

  var lastErrText = first ? first.errText : "";
  var lastStatus = first ? first.status : 0;
  for (var j = 0; j < candidates.length; j++) {
    var tx = candidates[j];
    var r = await postWithTax(tx, "candidate " + (j + 1) + "/" + candidates.length + " id=" + tx);
    if (r.ok) { await persistWinningTax(tx); return r.body; }
    lastStatus = r.status; lastErrText = r.errText;
    // Non-tax_id error: stop, nothing we can fix by swapping tax_id.
    if (r.status !== 422 || !/tax_id/i.test(r.errText)) break;
  }

  // 4) Final fallback: omit tax_id entirely.
  console.log("[Bexio] All tax candidates exhausted — final attempt without tax_id.");
  var noTax = await postWithTax(null, "no tax_id");
  if (noTax.ok) return noTax.body;

  console.error("[Bexio] Invoice create error after all attempts:", noTax.status, noTax.errText);
  throw new Error("Bexio Rechnung (" + noTax.status + "): " + noTax.errText.slice(0, 300));
}

async function bexioIssueInvoice(tenant: any, invoiceId: number): Promise<void> {
  var token = await getBexioToken(tenant);
  await fetch("https://api.bexio.com/2.0/kb_invoice/" + invoiceId + "/issue", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
}

async function bexioGetContact(tenant: any, contactId: number): Promise<any> {
  var token = await getBexioToken(tenant);
  var resp = await fetch("https://api.bexio.com/2.0/contact/" + contactId, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error("Bexio Kontakt laden fehlgeschlagen (" + resp.status + ")");
  }
  return resp.json();
}

async function bexioListDraftInvoices(tenant: any): Promise<any[]> {
  var token = await getBexioToken(tenant);
  console.log("[Bexio] Listing draft invoices...");
  // kb_item_status_id = 7 = Draft (Entwurf) in Bexio
  var resp = await fetch("https://api.bexio.com/2.0/kb_invoice/search?limit=50&order_by=id_desc", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify([{ field: "kb_item_status_id", value: 7, criteria: "=" }]),
  });
  if (!resp.ok) {
    var errText = await resp.text();
    console.error("[Bexio] List drafts error:", resp.status, errText);
    throw new Error("Bexio Entwurfsliste fehlgeschlagen (" + resp.status + ")");
  }
  var data = await resp.json();
  if (!Array.isArray(data)) {
    console.error("[Bexio] List drafts returned non-array:", JSON.stringify(data).slice(0, 200));
    return [];
  }
  console.log("[Bexio] Found", data.length, "drafts");
  return data;
}

async function bexioGetInvoice(tenant: any, invoiceId: number): Promise<any> {
  var token = await getBexioToken(tenant);
  var resp = await fetch("https://api.bexio.com/2.0/kb_invoice/" + invoiceId, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error("Bexio Rechnung laden fehlgeschlagen (" + resp.status + ")");
  }
  return resp.json();
}

async function bexioAddInvoicePosition(
  tenant: any,
  invoiceId: number,
  pos: { description: string; price: number; amount?: number; unit?: string },
): Promise<any> {
  var token = await getBexioToken(tenant);

  var addAmt = typeof pos.amount === "number" ? pos.amount : parseFloat(String(pos.amount || "1"));
  if (isNaN(addAmt) || addAmt <= 0) addAmt = 1;
  var addTxt = pos.description || "";
  if (pos.unit) addTxt = addTxt + " (" + pos.unit + ")";

  var ids = await ensureBexioIds(tenant, token, false);
  if (!ids.accountId) {
    ids = await ensureBexioIds(tenant, token, true);
    if (!ids.accountId) {
      throw new Error("Kein Ertragskonto gefunden. Bitte pruefe deine Bexio-Konfiguration.");
    }
  }

  function buildPosBody(taxOverride: number | null): any {
    var body: any = {
      amount: String(addAmt),
      unit_price: pos.price.toFixed(2),
      text: addTxt,
      account_id: ids.accountId,
    };
    if (taxOverride != null) body.tax_id = taxOverride;
    return body;
  }

  async function postPos(taxOverride: number | null, label: string) {
    console.log("[Bexio] Adding position to invoice", invoiceId, "(" + label + ")", {
      taxId: taxOverride == null ? "(omitted)" : taxOverride,
    });
    var resp = await fetch("https://api.bexio.com/2.0/kb_invoice/" + invoiceId + "/kb_position_custom", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(buildPosBody(taxOverride)),
    });
    if (resp.ok) return { ok: true, body: await resp.json(), status: resp.status, errText: "" };
    var errText = await resp.text();
    console.warn("[Bexio] Add position (" + label + ") failed:", resp.status, errText.slice(0, 200));
    return { ok: false, body: null, status: resp.status, errText: errText };
  }

  async function persistWinningTax(tx: number | null) {
    if (tx != null && tx !== tenant.bexio_tax_id) {
      await supabase.from("tenants").update({
        bexio_tax_id: tx, updated_at: new Date().toISOString(),
      }).eq("id", tenant.id);
      tenant.bexio_tax_id = tx;
    }
  }

  // 1) Try cached tax_id.
  var first: any = null;
  if (ids.taxId != null) {
    first = await postPos(ids.taxId, "cached tax " + ids.taxId);
    if (first.ok) { await persistWinningTax(ids.taxId); return first.body; }
    if (first.status !== 422 || !/tax_id/i.test(first.errText)) {
      throw new Error("Bexio Position (" + first.status + "): " + first.errText.slice(0, 200));
    }
  }

  // 2) Force-refresh to get full candidate list.
  console.log("[Bexio] Cached tax_id rejected or missing — force-refreshing tax list.");
  ids = await ensureBexioIds(tenant, token, true);

  var tried: Record<string, boolean> = {};
  if (ids.taxId != null && first != null) tried[String(ids.taxId)] = true;
  var candidates = (ids.taxCandidates || []).filter(function (c) {
    if (tried[String(c)]) return false;
    tried[String(c)] = true;
    return true;
  });
  console.log("[Bexio] Will try tax candidates in order:", JSON.stringify(candidates));

  var lastErrText = first ? first.errText : "";
  var lastStatus = first ? first.status : 0;
  for (var j = 0; j < candidates.length; j++) {
    var tx = candidates[j];
    var r = await postPos(tx, "candidate " + (j + 1) + "/" + candidates.length + " id=" + tx);
    if (r.ok) { await persistWinningTax(tx); return r.body; }
    lastStatus = r.status; lastErrText = r.errText;
    if (r.status !== 422 || !/tax_id/i.test(r.errText)) break;
  }

  // 3) Final fallback: no tax_id.
  console.log("[Bexio] All tax candidates exhausted — final attempt without tax_id.");
  var noTax = await postPos(null, "no tax_id");
  if (noTax.ok) return noTax.body;

  console.error("[Bexio] Add position error after all attempts:", noTax.status, noTax.errText);
  throw new Error("Bexio Position (" + noTax.status + "): " + noTax.errText.slice(0, 200));
}

// ===== Position amount/unit parsing =====

// Parse free-text like "5 Std", "2.5 m2", "3,5 kg", "1 pauschal", "pauschal",
// or just "1". Returns null for invalid input so the caller can re-prompt.
function parseAmountUnit(input: string): { amount: number; unit: string } | null {
  var t = String(input || "").trim();
  if (!t) return null;
  if (t.toLowerCase() === "pauschal" || t.toLowerCase() === "einmalig") {
    return { amount: 1, unit: "" };
  }
  // <number> [<unit>]  — number may use . or , as decimal separator
  var m = t.match(/^([0-9]+(?:[.,][0-9]+)?)\s*(.*)$/);
  if (!m) return null;
  var amt = parseFloat(m[1].replace(",", "."));
  if (isNaN(amt) || amt <= 0) return null;
  return { amount: amt, unit: normalizeUnit((m[2] || "").trim()) };
}

// Map common shorthand/typos to canonical display units.
function normalizeUnit(u: string): string {
  if (!u) return "";
  var lc = u.toLowerCase();
  var map: Record<string, string> = {
    "h": "Std", "std": "Std", "stunde": "Std", "stunden": "Std", "hr": "Std",
    "stk": "Stk", "stueck": "Stk", "stück": "Stk", "pc": "Stk", "pcs": "Stk",
    "m": "m", "meter": "m",
    "m2": "m²", "m²": "m²", "qm": "m²",
    "m3": "m³", "m³": "m³",
    "kg": "kg",
    "g": "g",
    "l": "l", "liter": "l",
    "tag": "Tag", "tage": "Tag",
    "pauschal": "",
  };
  return map[lc] || u;
}

// Human-friendly line for summary / display.
function formatPositionLine(p: any): string {
  var amt = typeof p.amount === "number" ? p.amount : parseFloat(p.amount || "1");
  if (isNaN(amt) || amt <= 0) amt = 1;
  var unitStr = p.unit ? " " + p.unit : "";
  var total = typeof p.total === "number" ? p.total : (amt * (p.price || 0));
  // Hide the "1 × 120 = 120" redundancy for pauschal positions
  if (amt === 1 && !p.unit) {
    return p.description + " - CHF " + total.toFixed(2);
  }
  return p.description + " (" + amt + unitStr + " a CHF " + (p.price || 0).toFixed(2) +
    ") - CHF " + total.toFixed(2);
}

// ===== Receipt mit Claude AI =====

async function handleReceiptUpload(from: string, session: any, tenant: any, mediaId: string, mediaType: string): Promise<void> {
  await sendText(from, "Beleg wird analysiert...");
  try {
    // Download media from Meta
    var metaResp = await fetch("https://graph.facebook.com/v21.0/" + mediaId, {
      headers: { Authorization: "Bearer " + WHATSAPP_TOKEN },
    });
    var metaData = await metaResp.json();
    var mediaUrl = metaData.url;

    var downloadResp = await fetch(mediaUrl, {
      headers: { Authorization: "Bearer " + WHATSAPP_TOKEN },
    });
    var buffer = await downloadResp.arrayBuffer();
    var bytes = new Uint8Array(buffer);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    var base64 = btoa(binary);

    // Analyze with Claude
    var aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: "Analysiere diesen Beleg und extrahiere als JSON: {\"vendor\":\"...\",\"date\":\"YYYY-MM-DD\",\"total\":\"123.45\",\"items\":[{\"description\":\"...\",\"amount\":\"12.50\"}]}. Antworte NUR mit dem JSON." },
          ],
        }],
      }),
    });

    var aiData = await aiResp.json();
    var aiText = aiData.content[0].text;
    var jsonMatch = aiText.match(/\{[\s\S]*\}/);
    var receiptData = jsonMatch ? JSON.parse(jsonMatch[0]) : { vendor: "unbekannt", date: "unbekannt", total: "unbekannt", items: [] };

    await supabase.from("sessions_handwerker").update({
      receipt_base64: base64, receipt_type: mediaType, receipt_data: receiptData,
      step: "receipt_confirm", updated_at: new Date().toISOString(),
    }).eq("id", session.id);

    var summary = "*Beleg erkannt:*\n\n";
    summary += "Lieferant: " + receiptData.vendor + "\n";
    summary += "Datum: " + receiptData.date + "\n";
    summary += "Total: CHF " + receiptData.total + "\n";
    if (receiptData.items && receiptData.items.length > 0) {
      summary += "\nPositionen:\n";
      receiptData.items.forEach(function (item: any, i: number) {
        summary += (i + 1) + ". " + item.description + " - CHF " + item.amount + "\n";
      });
    }
    await sendText(from, summary);
    await sendButtons(from, "Stimmt das?", [
      { id: "save_receipt", title: "Ja, speichern" },
      { id: "discard_receipt", title: "Verwerfen" },
    ]);
  } catch (err) {
    console.error("Receipt error:", err);
    await sendText(from, "Beleg konnte nicht analysiert werden. Bitte versuche es erneut.");
    await resetSession(session.id);
  }
}

// ===== Email =====

async function sendEmailNotification(email: string, invoiceNr: string, total: string): Promise<void> {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + Deno.env.get("RESEND_API_KEY")!, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "WhatsApp Handwerker <noreply@resend.dev>",
      to: email,
      subject: "Rechnung " + invoiceNr + " erstellt",
      html: "<h2>Neue Rechnung erstellt</h2><p>Rechnungs-Nr: <strong>" + invoiceNr + "</strong></p><p>Total: CHF " + total + "</p><p>Die Rechnung findest du in deinem Bexio-Konto.</p>",
    }),
  });
}
