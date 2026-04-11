import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("OK", { status: 200 });
  }

  try {
    const body = await req.text();
    const formData = new URLSearchParams(body);

    const from = formData.get("From") || "";
    const msgBody = formData.get("Body")?.trim() || "";
    const numMedia = parseInt(formData.get("NumMedia") || "0", 10);
    const mediaUrl = numMedia > 0 ? (formData.get("MediaUrl0") || undefined) : undefined;
    const mediaType = numMedia > 0 ? (formData.get("MediaContentType0") || undefined) : undefined;

    const phone = from.replace("whatsapp:", "").replace(/\s+/g, "");

    console.log("[WhatsApp] From: " + from + ", Body: " + msgBody);

    // --- Session laden oder erstellen ---
    const { data: existingSession } = await supabase
      .from("sessions_handwerker")
      .select("*")
      .eq("phone_number", phone)
      .single();

    let session = existingSession;

    if (!session) {
      const { data: newSession } = await supabase
        .from("sessions_handwerker")
        .insert({ phone_number: phone })
        .select()
        .single();
      session = newSession;
    }

    // Session abgelaufen? Reset
    if (session) {
      const expiresAt = new Date(session.expires_at).getTime();
      const now = Date.now();
      if (expiresAt < now) {
        await resetSession(session.id);
        session.step = "start";
      }
    }

    // --- Tenant finden ---
    if (session && !session.tenant_id) {
      const { data: tenant } = await supabase
        .from("tenants")
        .select("*")
        .eq("whatsapp_number", phone)
        .single();

      if (!tenant) {
        await sendWhatsApp(from, "Willkommen! Deine Nummer ist noch nicht registriert.\nBitte melde dich zuerst auf unserer Website an.");
        return twimlResponse();
      }

      if (!tenant.is_active && tenant.plan !== "trial") {
        await sendWhatsApp(from, "Dein Konto ist nicht aktiv. Bitte erneuere dein Abo.");
        return twimlResponse();
      }

      if (tenant.plan === "trial") {
        const trialEnd = new Date(tenant.trial_ends_at).getTime();
        if (trialEnd < Date.now()) {
          await sendWhatsApp(from, "Deine Testphase ist abgelaufen. Bitte upgrade auf ein Abo.");
          return twimlResponse();
        }
      }

      await supabase.from("sessions_handwerker").update({ tenant_id: tenant.id }).eq("id", session.id);
      session.tenant_id = tenant.id;
    }

    if (!session) {
      return twimlResponse();
    }

    // --- Globale Befehle ---
    const text = msgBody.toLowerCase();
    if (text === "reset" || text === "abbrechen" || text === "neustart") {
      await resetSession(session.id);
      await sendWhatsApp(from, "Session zurueckgesetzt. Schreibe etwas um neu zu starten.");
      return twimlResponse();
    }

    if (text === "hilfe" || text === "help") {
      await sendWhatsApp(from,
        "*Verfuegbare Befehle:*\n\n" +
        "rechnung - Neue Rechnung erstellen\n" +
        "beleg - Beleg/Quittung erfassen\n" +
        "suche - Kontakt suchen\n" +
        "neustart - Session zuruecksetzen\n" +
        "hilfe - Diese Hilfe anzeigen"
      );
      return twimlResponse();
    }

    // --- Step-basierter Flow ---
    const step = session.step || "start";
    const tenant = session.tenant_id ? await getTenant(session.tenant_id) : null;

    if (step === "start") {
      await updateStep(session.id, "main_menu");
      await sendWhatsApp(from,
        "Hallo! Was moechtest du tun?\n\n" +
        "1 - Rechnung erstellen\n" +
        "2 - Beleg erfassen (Foto senden)\n" +
        "3 - Kontakt in Bexio suchen\n\n" +
        "Antworte mit der Nummer oder dem Wort."
      );
    } else if (step === "main_menu") {
      if (numMedia > 0 && mediaUrl) {
        await updateStep(session.id, "receipt_upload");
        await handleReceiptUpload(from, session, tenant, mediaUrl, mediaType || "image/jpeg");
      } else if (text === "1" || text.includes("rechnung")) {
        await supabase.from("sessions_handwerker").update({
          step: "contact_search",
          manual_positions: [],
          updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendWhatsApp(from,
          "Rechnung erstellen\n\nGib den Namen des Kunden ein um in Bexio zu suchen.\nOder schreibe *neu* um einen neuen Kontakt anzulegen."
        );
      } else if (text === "2" || text.includes("beleg")) {
        await updateStep(session.id, "receipt_upload");
        await sendWhatsApp(from, "Beleg erfassen\n\nSende mir ein Foto des Belegs.");
      } else if (text === "3" || text.includes("suche")) {
        await updateStep(session.id, "contact_search");
        await sendWhatsApp(from, "Gib den Suchbegriff ein:");
      } else {
        await sendWhatsApp(from, "Bitte antworte mit:\n1 rechnung\n2 beleg\n3 suche");
      }
    } else if (step === "contact_search") {
      if (text === "neu") {
        await updateStep(session.id, "contact_new_name");
        await sendWhatsApp(from, "Neuer Kontakt: Wie heisst der Kunde? (Firma oder Name)");
      } else if (msgBody.length >= 2 && tenant) {
        const contacts = await bexioSearchContacts(tenant, msgBody);
        if (contacts.length === 0) {
          await sendWhatsApp(from, "Keine Kontakte fuer \"" + msgBody + "\" gefunden.\n\nSchreibe *neu* um einen neuen Kontakt anzulegen.");
        } else {
          let list = contacts.length + " Kontakt(e) gefunden:\n\n";
          contacts.slice(0, 10).forEach(function (c: any, i: number) {
            const details = [c.address, c.postcode, c.city].filter(Boolean).join(", ");
            list += (i + 1) + ". " + c.name_1 + (details ? " - " + details : "") + "\n";
          });
          list += "\nAntworte mit der Nummer, oder *neu* fuer einen neuen Kontakt.";
          await supabase.from("sessions_handwerker").update({
            step: "contact_select",
            search_results: contacts.slice(0, 10),
            updated_at: new Date().toISOString(),
          }).eq("id", session.id);
          await sendWhatsApp(from, list);
        }
      } else {
        await sendWhatsApp(from, "Bitte gib mindestens 2 Buchstaben ein.");
      }
    } else if (step === "contact_select") {
      if (text === "neu") {
        await updateStep(session.id, "contact_new_name");
        await sendWhatsApp(from, "Wie heisst der Kunde? (Firma oder Name)");
      } else {
        const idx = parseInt(text, 10);
        const results = session.search_results || [];
        if (isNaN(idx) || idx >= 1 && idx <= results.length) {
          if (!isNaN(idx)) {
            const contact = results[idx - 1] as any;
            await supabase.from("sessions_handwerker").update({
              bexio_contact_id: contact.id,
              contact_data: { name: contact.name_1, city: contact.city },
              step: "invoice_title",
              updated_at: new Date().toISOString(),
            }).eq("id", session.id);
            await sendWhatsApp(from, "Kontakt: " + contact.name_1 + "\n\nWie soll die Rechnung heissen? (Titel)");
          } else {
            await sendWhatsApp(from, "Bitte antworte mit einer Nummer (1-" + results.length + ") oder *neu*.");
          }
        } else {
          await sendWhatsApp(from, "Bitte antworte mit einer Nummer (1-" + results.length + ") oder *neu*.");
        }
      }
    } else if (step === "contact_new_name") {
      if (!msgBody) {
        await sendWhatsApp(from, "Bitte gib einen Namen ein.");
      } else {
        await supabase.from("sessions_handwerker").update({
          contact_data: { name: msgBody },
          step: "contact_new_address",
          updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendWhatsApp(from, "Adresse? (Strasse, PLZ Ort)\nOder schreibe *skip* um zu ueberspringen.");
      }
    } else if (step === "contact_new_address") {
      if (tenant) {
        const contactData = (session.contact_data || {}) as any;
        let address = "";
        let postcode = "";
        let city = "";
        if (text !== "skip" && msgBody.length > 0) {
          const parts = msgBody.split(",").map(function (s: string) { return s.trim(); });
          address = parts[0] || "";
          if (parts[1]) {
            const plzMatch = parts[1].match(/^(\d{4})\s+(.+)/);
            if (plzMatch) {
              postcode = plzMatch[1];
              city = plzMatch[2];
            } else {
              city = parts[1];
            }
          }
        }
        const newContact = await bexioCreateContact(tenant, {
          name: contactData.name || "Unbekannt",
          address: address,
          postcode: postcode,
          city: city,
        });
        await supabase.from("sessions_handwerker").update({
          bexio_contact_id: newContact.id,
          contact_data: { name: newContact.name_1, city: newContact.city || city },
          step: "invoice_title",
          updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendWhatsApp(from, "Kontakt " + newContact.name_1 + " erstellt (ID: " + newContact.id + ")\n\nWie soll die Rechnung heissen? (Titel)");
      }
    } else if (step === "invoice_title") {
      if (!msgBody) {
        await sendWhatsApp(from, "Bitte gib einen Titel fuer die Rechnung ein.");
      } else {
        await supabase.from("sessions_handwerker").update({
          invoice_title: msgBody,
          step: "position_desc",
          updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendWhatsApp(from, "Titel: " + msgBody + "\n\nJetzt die Positionen.\nBeschreibe die erste Position:");
      }
    } else if (step === "position_desc") {
      if (!msgBody) {
        await sendWhatsApp(from, "Bitte beschreibe die Position.");
      } else {
        await supabase.from("sessions_handwerker").update({
          current_position_desc: msgBody,
          step: "position_price",
          updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendWhatsApp(from, "Position: " + msgBody + "\n\nPreis in CHF? (z.B. 150.00)");
      }
    } else if (step === "position_price") {
      const priceText = msgBody.replace("'", "").replace(",", ".");
      const price = parseFloat(priceText);
      if (isNaN(price) || price <= 0) {
        await sendWhatsApp(from, "Bitte gib einen gueltigen Preis ein (z.B. 150.00).");
      } else {
        const positions = session.manual_positions || [];
        positions.push({ description: session.current_position_desc || "", price: price });
        const total = positions.reduce(function (s: number, p: any) { return s + p.price; }, 0);
        await supabase.from("sessions_handwerker").update({
          manual_positions: positions,
          current_position_desc: null,
          current_position_price: null,
          step: "position_more",
          updated_at: new Date().toISOString(),
        }).eq("id", session.id);
        await sendWhatsApp(from,
          "Position hinzugefuegt!\n\n" +
          "Positionen: " + positions.length + "\n" +
          "Total: CHF " + total.toFixed(2) + "\n\n" +
          "Antworte:\n*ja* - Weitere Position hinzufuegen\n*fertig* - Rechnung erstellen"
        );
      }
    } else if (step === "position_more") {
      if (text === "ja" || text === "weitere" || text === "1") {
        await updateStep(session.id, "position_desc");
        await sendWhatsApp(from, "Beschreibe die naechste Position:");
      } else if (text === "fertig" || text === "nein" || text === "erstellen" || text === "2") {
        const positions = session.manual_positions || [];
        const total = positions.reduce(function (s: number, p: any) { return s + p.price; }, 0);
        const cData = session.contact_data as any;
        const cName = cData ? cData.name : ("ID " + session.bexio_contact_id);
        let summary = "Rechnungs-Zusammenfassung\n\n";
        summary += "Titel: " + session.invoice_title + "\n";
        summary += "Kunde: " + cName + "\n\n";
        positions.forEach(function (p: any, i: number) {
          summary += (i + 1) + ". " + p.description + " - CHF " + p.price.toFixed(2) + "\n";
        });
        summary += "\nTotal: CHF " + total.toFixed(2) + "\n\n";
        summary += "Antworte *ja* um die Rechnung in Bexio zu erstellen,\noder *abbrechen*.";
        await updateStep(session.id, "invoice_confirm");
        await sendWhatsApp(from, summary);
      } else {
        await sendWhatsApp(from, "Antworte mit *ja* (weitere Position) oder *fertig* (Rechnung erstellen).");
      }
    } else if (step === "invoice_confirm") {
      if (text === "abbrechen" || text === "nein") {
        await resetSession(session.id);
        await sendWhatsApp(from, "Rechnung abgebrochen. Schreibe etwas um neu zu starten.");
      } else if (text === "ja" || text === "ok" || text === "erstellen") {
        if (tenant) {
          await sendWhatsApp(from, "Rechnung wird in Bexio erstellt...");
          try {
            const invoice = await bexioCreateInvoice(tenant, {
              contactId: session.bexio_contact_id,
              title: session.invoice_title || "Rechnung",
              positions: session.manual_positions || [],
            });
            try {
              await bexioIssueInvoice(tenant, invoice.id);
            } catch (_e) {
              // Draft ist ok
            }
            await sendWhatsApp(from,
              "Rechnung erstellt!\n\n" +
              "Rechnungs-Nr: " + invoice.document_nr + "\n" +
              "Total: CHF " + invoice.total + "\n\n" +
              "Die Rechnung findest du in deinem Bexio-Konto."
            );
            try {
              await sendEmailNotification(tenant.email, invoice.document_nr, invoice.total);
            } catch (_e) {
              console.error("Email error");
            }
          } catch (_e) {
            console.error("Invoice error:", _e);
            await sendWhatsApp(from, "Fehler beim Erstellen der Rechnung. Bitte pruefe deine Bexio-Verbindung.");
          }
          await resetSession(session.id);
        }
      } else {
        await sendWhatsApp(from, "Antworte mit *ja* zum Erstellen oder *abbrechen*.");
      }
    } else if (step === "receipt_upload") {
      if (numMedia > 0 && mediaUrl && tenant) {
        await handleReceiptUpload(from, session, tenant, mediaUrl, mediaType || "image/jpeg");
      } else {
        await sendWhatsApp(from, "Bitte sende ein Foto oder PDF des Belegs.\nSchreibe *abbrechen* um zurueckzukehren.");
      }
    } else if (step === "receipt_confirm") {
      if (text === "ja" || text === "ok") {
        await sendWhatsApp(from, "Beleg gespeichert!");
        await resetSession(session.id);
      } else if (text === "nein" || text === "abbrechen") {
        await sendWhatsApp(from, "Beleg verworfen.");
        await resetSession(session.id);
      } else {
        await sendWhatsApp(from, "Antworte mit *ja* zum Speichern oder *nein* zum Verwerfen.");
      }
    } else {
      await updateStep(session.id, "main_menu");
      await sendWhatsApp(from, "Bitte waehle:\n1 rechnung\n2 beleg\n3 suche");
    }

    return twimlResponse();
  } catch (err) {
    console.error("[WhatsApp Webhook] Error:", err);
    return twimlResponse();
  }
});

// ===== Helper Functions =====

function twimlResponse(): Response {
  return new Response(
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>",
    { status: 200, headers: { "Content-Type": "application/xml" } },
  );
}

async function sendWhatsApp(to: string, body: string): Promise<void> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const token = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const toNumber = to.startsWith("whatsapp:") ? to : "whatsapp:" + to;
  const fromNumber = "whatsapp:" + (Deno.env.get("TWILIO_WHATSAPP_FROM") || "+14155238886");

  const params = new URLSearchParams({
    To: toNumber,
    From: fromNumber,
    Body: body,
  });

  const resp = await fetch(
    "https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json",
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(sid + ":" + token),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );

  if (!resp.ok) {
    const err = await resp.text();
    console.error("[Twilio] Error:", err);
  }
}

async function updateStep(sessionId: string, step: string): Promise<void> {
  await supabase
    .from("sessions_handwerker")
    .update({ step: step, updated_at: new Date().toISOString() })
    .eq("id", sessionId);
}

async function resetSession(sessionId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  await supabase
    .from("sessions_handwerker")
    .update({
      step: "start",
      contact_data: null,
      bexio_contact_id: null,
      bexio_invoice_id: null,
      bexio_invoice_nr: null,
      invoice_title: null,
      invoice_data: null,
      manual_positions: null,
      current_position_desc: null,
      current_position_price: null,
      receipt_data: null,
      receipt_base64: null,
      receipt_type: null,
      search_results: null,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
}

async function getTenant(tenantId: string): Promise<any> {
  const { data } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .single();
  return data;
}

// ===== Bexio API =====

async function getBexioToken(tenant: any): Promise<string> {
  let token = tenant.bexio_access_token;

  if (tenant.bexio_expires_at) {
    const expiresAt = new Date(tenant.bexio_expires_at).getTime();
    const buffer = expiresAt - 300000;
    if (Date.now() > buffer) {
      const resp = await fetch("https://idp.bexio.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tenant.bexio_refresh_token,
          client_id: Deno.env.get("BEXIO_CLIENT_ID")!,
          client_secret: Deno.env.get("BEXIO_CLIENT_SECRET")!,
        }),
      });
      const data = await resp.json();
      token = data.access_token;
      const newExpiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
      await supabase
        .from("tenants")
        .update({
          bexio_access_token: data.access_token,
          bexio_refresh_token: data.refresh_token || tenant.bexio_refresh_token,
          bexio_expires_at: newExpiry,
        })
        .eq("id", tenant.id);
    }
  }

  return token;
}

async function bexioSearchContacts(tenant: any, term: string): Promise<any[]> {
  const token = await getBexioToken(tenant);
  const resp = await fetch("https://api.bexio.com/2.0/contact/search", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ field: "name_1", value: term, criteria: "like" }]),
  });
  return resp.json();
}

async function bexioCreateContact(
  tenant: any,
  c: { name: string; address: string; postcode: string; city: string },
): Promise<any> {
  const token = await getBexioToken(tenant);
  const resp = await fetch("https://api.bexio.com/2.0/contact", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contact_type_id: 1,
      name_1: c.name,
      address: c.address,
      postcode: c.postcode,
      city: c.city,
      owner_id: tenant.bexio_user_id,
    }),
  });
  return resp.json();
}

async function bexioCreateInvoice(
  tenant: any,
  params: { contactId: number; title: string; positions: any[] },
): Promise<any> {
  const token = await getBexioToken(tenant);
  const today = new Date().toISOString().split("T")[0];
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];

  const positionItems = params.positions.map(function (p: any) {
    return {
      type: "KbPositionCustom",
      text: p.description,
      unit_price: p.price.toFixed(2),
      amount: "1",
      account_id: tenant.bexio_account_id,
      tax_id: tenant.bexio_tax_id,
    };
  });

  const resp = await fetch("https://api.bexio.com/2.0/kb_invoice", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: params.title,
      contact_id: params.contactId,
      user_id: tenant.bexio_user_id,
      is_valid_from: today,
      is_valid_to: dueDate,
      mwst_type: 0,
      mwst_is_net: true,
      positions: positionItems,
    }),
  });
  return resp.json();
}

async function bexioIssueInvoice(tenant: any, invoiceId: number): Promise<void> {
  const token = await getBexioToken(tenant);
  await fetch("https://api.bexio.com/2.0/kb_invoice/" + invoiceId + "/issue", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
  });
}

// ===== Receipt mit Claude AI =====

async function handleReceiptUpload(
  from: string,
  session: any,
  tenant: any,
  mediaUrl: string,
  mediaType: string,
): Promise<void> {
  await sendWhatsApp(from, "Beleg wird analysiert...");
  try {
    const sid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const token = Deno.env.get("TWILIO_AUTH_TOKEN")!;

    const mediaResp = await fetch(mediaUrl, {
      headers: { Authorization: "Basic " + btoa(sid + ":" + token) },
    });

    if (!mediaResp.ok) {
      await sendWhatsApp(from, "Fehler beim Herunterladen des Belegs. Bitte erneut senden.");
      return;
    }

    const buffer = await mediaResp.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64 },
              },
              {
                type: "text",
                text: "Analysiere diesen Beleg und extrahiere als JSON: {\"vendor\":\"...\",\"date\":\"YYYY-MM-DD\",\"total\":\"123.45\",\"items\":[{\"description\":\"...\",\"amount\":\"12.50\"}]}. Antworte NUR mit dem JSON.",
              },
            ],
          },
        ],
      }),
    });

    const aiData = await aiResp.json();
    const aiText = aiData.content[0].text;
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const receiptData = jsonMatch
      ? JSON.parse(jsonMatch[0])
      : { vendor: "unbekannt", date: "unbekannt", total: "unbekannt", items: [] };

    await supabase
      .from("sessions_handwerker")
      .update({
        receipt_base64: base64,
        receipt_type: mediaType,
        receipt_data: receiptData,
        step: "receipt_confirm",
        updated_at: new Date().toISOString(),
      })
      .eq("id", session.id);

    let summary = "Beleg erkannt:\n\n";
    summary += "Lieferant: " + receiptData.vendor + "\n";
    summary += "Datum: " + receiptData.date + "\n";
    summary += "Total: CHF " + receiptData.total + "\n";
    if (receiptData.items && receiptData.items.length > 0) {
      summary += "\nPositionen:\n";
      receiptData.items.forEach(function (item: any, i: number) {
        summary += (i + 1) + ". " + item.description + " - CHF " + item.amount + "\n";
      });
    }
    summary += "\nStimmt das? Antworte *ja* zum Speichern oder *nein* zum Verwerfen.";
    await sendWhatsApp(from, summary);
  } catch (err) {
    console.error("Receipt error:", err);
    await sendWhatsApp(from, "Beleg konnte nicht analysiert werden. Bitte versuche es erneut.");
    await resetSession(session.id);
  }
}

// ===== Email =====

async function sendEmailNotification(
  email: string,
  invoiceNr: string,
  total: string,
): Promise<void> {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + Deno.env.get("RESEND_API_KEY")!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "WhatsApp Handwerker <noreply@resend.dev>",
      to: email,
      subject: "Rechnung " + invoiceNr + " erstellt",
      html:
        "<h2>Neue Rechnung erstellt</h2>" +
        "<p>Rechnungs-Nr: <strong>" + invoiceNr + "</strong></p>" +
        "<p>Total: CHF " + total + "</p>" +
        "<p>Die Rechnung findest du in deinem Bexio-Konto.</p>",
    }),
  });
}
