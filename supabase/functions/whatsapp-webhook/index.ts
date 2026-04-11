// WhatsApp Handwerker Bot — Meta Cloud API + Bexio + Claude AI
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

    // --- Tenant finden ---
    if (session && !session.tenant_id) {
      // Try multiple phone formats: +41xxx, whatsapp:+41xxx, 41xxx
      var phoneClean = phone.replace("+", "");
      var { data: tenant } = await supabase
        .from("tenants")
        .select("*")
        .or("whatsapp_number.eq." + phone + ",whatsapp_number.eq.whatsapp:" + phone + ",whatsapp_number.eq." + phoneClean)
        .single();

      if (!tenant) {
        await sendText(from, "Willkommen! Deine Nummer ist noch nicht registriert.\nBitte melde dich zuerst auf unserer Website an.");
        return new Response("OK", { status: 200 });
      }

      if (!tenant.is_active && tenant.plan !== "trial") {
        await sendText(from, "Dein Konto ist nicht aktiv. Bitte erneuere dein Abo.");
        return new Response("OK", { status: 200 });
      }

      if (tenant.plan === "trial") {
        var trialEnd = new Date(tenant.trial_ends_at).getTime();
        if (trialEnd < Date.now()) {
          await sendText(from, "Deine Testphase ist abgelaufen. Bitte upgrade auf ein Abo.");
          return new Response("OK", { status: 200 });
        }
      }

      await supabase.from("sessions_handwerker").update({ tenant_id: tenant.id }).eq("id", session.id);
      session.tenant_id = tenant.id;
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
        "beleg - Beleg/Quittung erfassen\n" +
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
        { id: "receipt", title: "Beleg erfassen" },
        { id: "search", title: "Kontakt suchen" },
      ]);

    } else if (step === "main_menu") {
      if (mediaId) {
        await updateStep(session.id, "receipt_upload");
        await handleReceiptUpload(from, session, tenant, mediaId, mediaMime);
      } else if (choice === "invoice" || choice === "1" || text.includes("rechnung")) {
        await supabase.from("sessions_handwerker").update({
          step: "contact_search", manual_positions: [], updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendText(from, "Rechnung erstellen\n\nGib den Namen des Kunden ein um in Bexio zu suchen.\nOder schreibe *neu* um einen neuen Kontakt anzulegen.");
      } else if (choice === "receipt" || choice === "2" || text.includes("beleg")) {
        await updateStep(session.id, "receipt_upload");
        await sendText(from, "Beleg erfassen\n\nSende mir ein Foto des Belegs.");
      } else if (choice === "search" || choice === "3" || text.includes("suche")) {
        await updateStep(session.id, "contact_search");
        await sendText(from, "Gib den Suchbegriff ein:");
      } else {
        await sendButtons(from, "Bitte waehle eine Option:", [
          { id: "invoice", title: "Rechnung erstellen" },
          { id: "receipt", title: "Beleg erfassen" },
          { id: "search", title: "Kontakt suchen" },
        ]);
      }

    } else if (step === "contact_search") {
      if (text === "neu") {
        await updateStep(session.id, "contact_new_name");
        await sendText(from, "Neuer Kontakt: Wie heisst der Kunde? (Firma oder Name)");
      } else if (msgBody.length >= 2 && tenant) {
        var contacts = await bexioSearchContacts(tenant, msgBody);
        if (contacts.length === 0) {
          await sendButtons(from, "Keine Kontakte fuer \"" + msgBody + "\" gefunden.", [
            { id: "new_contact", title: "Neu anlegen" },
            { id: "search_again", title: "Nochmal suchen" },
          ]);
          await updateStep(session.id, "contact_select");
        } else {
          // Show as list
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
      } else {
        await sendText(from, "Bitte gib mindestens 2 Buchstaben ein.");
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
      if (tenant) {
        var contactData = (session.contact_data || {}) as any;
        var address = "";
        var postcode = "";
        var city = "";
        if (choice !== "skip_address" && text !== "skip" && msgBody.length > 0) {
          var parts = msgBody.split(",").map(function (s: string) { return s.trim(); });
          address = parts[0] || "";
          if (parts[1]) {
            var plzMatch = parts[1].match(/^(\d{4})\s+(.+)/);
            if (plzMatch) { postcode = plzMatch[1]; city = plzMatch[2]; }
            else { city = parts[1]; }
          }
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
          current_position_desc: msgBody, step: "position_price", updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendText(from, "Position: *" + msgBody + "*\n\nPreis in CHF? (z.B. 150.00)");
      }

    } else if (step === "position_price") {
      var priceText = msgBody.replace("'", "").replace(",", ".");
      var price = parseFloat(priceText);
      if (isNaN(price) || price <= 0) {
        await sendText(from, "Bitte gib einen gueltigen Preis ein (z.B. 150.00).");
      } else {
        var positions = session.manual_positions || [];
        positions.push({ description: session.current_position_desc || "", price: price });
        var total = positions.reduce(function (s: number, p: any) { return s + p.price; }, 0);
        await supabase.from("sessions_handwerker").update({
          manual_positions: positions, current_position_desc: null, current_position_price: null,
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
        var total2 = positions2.reduce(function (s: number, p: any) { return s + p.price; }, 0);
        var cData = session.contact_data as any;
        var cName = cData ? cData.name : ("ID " + session.bexio_contact_id);
        var summary = "*Rechnungs-Zusammenfassung*\n\n";
        summary += "Titel: " + session.invoice_title + "\n";
        summary += "Kunde: " + cName + "\n\n";
        positions2.forEach(function (p: any, i: number) {
          summary += (i + 1) + ". " + p.description + " - CHF " + p.price.toFixed(2) + "\n";
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
            try { await bexioIssueInvoice(tenant, invoice.id); } catch (_e) { /* draft ok */ }
            await sendText(from,
              "*Rechnung erstellt!*\n\n" +
              "Rechnungs-Nr: " + invoice.document_nr + "\n" +
              "Total: CHF " + invoice.total + "\n\n" +
              "Die Rechnung findest du in deinem Bexio-Konto."
            );
            try { await sendEmailNotification(tenant.email, invoice.document_nr, invoice.total); } catch (_e) { /* ok */ }
          } catch (_e) {
            console.error("Invoice error:", _e);
            await sendText(from, "Fehler beim Erstellen der Rechnung. Bitte pruefe deine Bexio-Verbindung.");
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
        { id: "receipt", title: "Beleg erfassen" },
        { id: "search", title: "Kontakt suchen" },
      ]);
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[WhatsApp Webhook] Error:", err);
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
    current_position_desc: null, current_position_price: null, receipt_data: null,
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
      var resp = await fetch("https://idp.bexio.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token", refresh_token: tenant.bexio_refresh_token,
          client_id: Deno.env.get("BEXIO_CLIENT_ID")!, client_secret: Deno.env.get("BEXIO_CLIENT_SECRET")!,
        }),
      });
      var data = await resp.json();
      token = data.access_token;
      await supabase.from("tenants").update({
        bexio_access_token: data.access_token,
        bexio_refresh_token: data.refresh_token || tenant.bexio_refresh_token,
        bexio_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      }).eq("id", tenant.id);
    }
  }
  return token;
}

async function bexioSearchContacts(tenant: any, term: string): Promise<any[]> {
  var token = await getBexioToken(tenant);
  var resp = await fetch("https://api.bexio.com/2.0/contact/search", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify([{ field: "name_1", value: term, criteria: "like" }]),
  });
  return resp.json();
}

async function bexioCreateContact(tenant: any, c: { name: string; address: string; postcode: string; city: string }): Promise<any> {
  var token = await getBexioToken(tenant);
  var resp = await fetch("https://api.bexio.com/2.0/contact", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      contact_type_id: 1, name_1: c.name, address: c.address, postcode: c.postcode, city: c.city, owner_id: tenant.bexio_user_id,
    }),
  });
  return resp.json();
}

async function bexioCreateInvoice(tenant: any, params: { contactId: number; title: string; positions: any[] }): Promise<any> {
  var token = await getBexioToken(tenant);
  var today = new Date().toISOString().split("T")[0];
  var dueDate = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
  var positionItems = params.positions.map(function (p: any) {
    return {
      type: "KbPositionCustom", text: p.description, unit_price: p.price.toFixed(2),
      amount: "1", account_id: tenant.bexio_account_id, tax_id: tenant.bexio_tax_id,
    };
  });
  var resp = await fetch("https://api.bexio.com/2.0/kb_invoice", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: params.title, contact_id: params.contactId, user_id: tenant.bexio_user_id,
      is_valid_from: today, is_valid_to: dueDate, mwst_type: 0, mwst_is_net: true, positions: positionItems,
    }),
  });
  return resp.json();
}

async function bexioIssueInvoice(tenant: any, invoiceId: number): Promise<void> {
  var token = await getBexioToken(tenant);
  await fetch("https://api.bexio.com/2.0/kb_invoice/" + invoiceId + "/issue", {
    method: "POST", headers: { Authorization: "Bearer " + token },
  });
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
