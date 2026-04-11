import {
  type Session,
  type Tenant,
  getOrCreateSession,
  getTenantByWhatsApp,
  updateSession,
  resetSession,
} from "./supabase.ts";
import { sendWhatsApp } from "./twilio.ts";
import * as bexio from "./bexio.ts";
import { analyzeReceipt } from "./anthropic.ts";
import { sendInvoiceNotification } from "./resend.ts";

export interface IncomingMessage {
  from: string;
  body: string;
  numMedia: number;
  mediaUrl?: string;
  mediaType?: string;
}

/**
 * Main entry: process an incoming WhatsApp message.
 */
export async function handleMessage(msg: IncomingMessage): Promise<void> {
  const session = await getOrCreateSession(msg.from);

  // Identify tenant if not yet linked
  if (!session.tenant_id) {
    const tenant = await getTenantByWhatsApp(msg.from);
    if (!tenant) {
      await sendWhatsApp(
        msg.from,
        "Willkommen! Deine Nummer ist noch nicht registriert.\nBitte melde dich zuerst auf unserer Website an.",
      );
      return;
    }
    if (!tenant.is_active && tenant.plan !== "trial") {
      await sendWhatsApp(msg.from, "Dein Konto ist nicht aktiv. Bitte erneuere dein Abo.");
      return;
    }
    if (tenant.plan === "trial" && new Date(tenant.trial_ends_at) < new Date()) {
      await sendWhatsApp(msg.from, "Deine Testphase ist abgelaufen. Bitte upgrade auf ein Abo.");
      return;
    }
    await updateSession(session.id, { tenant_id: tenant.id });
    session.tenant_id = tenant.id;
  }

  // Global commands
  const text = msg.body.toLowerCase();
  if (text === "reset" || text === "abbrechen" || text === "neustart") {
    await resetSession(session.id);
    await sendWhatsApp(msg.from, "Session zurückgesetzt. Schreibe etwas um neu zu starten.");
    return;
  }
  if (text === "hilfe" || text === "help") {
    await sendWhatsApp(
      msg.from,
      "*Verfügbare Befehle:*\n\n" +
        "📄 *rechnung* — Neue Rechnung erstellen\n" +
        "🧾 *beleg* — Beleg/Quittung erfassen\n" +
        "🔍 *suche [Name]* — Kontakt suchen\n" +
        "🔄 *neustart* — Session zurücksetzen\n" +
        "❓ *hilfe* — Diese Hilfe anzeigen",
    );
    return;
  }

  // Route by step
  const step = session.step || "start";
  const handler = steps[step] || steps["start"];
  try {
    await handler(msg, session);
  } catch (err) {
    console.error(`[Flow] Error in step ${step}:`, err);
    await sendWhatsApp(
      msg.from,
      "Es ist ein Fehler aufgetreten. Schreibe *neustart* um es erneut zu versuchen.",
    );
  }
}

// ---------- Step handlers ----------

type StepHandler = (msg: IncomingMessage, session: Session) => Promise<void>;

const steps: Record<string, StepHandler> = {
  start: handleStart,
  main_menu: handleMainMenu,
  contact_search: handleContactSearch,
  contact_select: handleContactSelect,
  contact_new_name: handleContactNewName,
  contact_new_address: handleContactNewAddress,
  invoice_title: handleInvoiceTitle,
  position_desc: handlePositionDesc,
  position_price: handlePositionPrice,
  position_more: handlePositionMore,
  invoice_confirm: handleInvoiceConfirm,
  receipt_upload: handleReceiptUpload,
  receipt_confirm: handleReceiptConfirm,
};

// --- START ---
async function handleStart(msg: IncomingMessage, session: Session) {
  await updateSession(session.id, { step: "main_menu" });
  await sendWhatsApp(
    msg.from,
    "Hallo! 👋 Was möchtest du tun?\n\n" +
      "1️⃣ *rechnung* — Rechnung erstellen\n" +
      "2️⃣ *beleg* — Beleg erfassen (Foto senden)\n" +
      "3️⃣ *suche* — Kontakt in Bexio suchen\n\n" +
      "Antworte mit der Nummer oder dem Wort.",
  );
}

// --- MAIN MENU ---
async function handleMainMenu(msg: IncomingMessage, session: Session) {
  const text = msg.body.toLowerCase();

  // If user sent a photo, treat it as receipt
  if (msg.numMedia > 0) {
    await updateSession(session.id, { step: "receipt_upload" });
    await steps["receipt_upload"](msg, session);
    return;
  }

  if (text === "1" || text.includes("rechnung")) {
    await updateSession(session.id, { step: "contact_search", manual_positions: [] });
    await sendWhatsApp(
      msg.from,
      "📄 *Rechnung erstellen*\n\n" +
        "Gib den Namen des Kunden ein um in Bexio zu suchen.\n" +
        "Oder schreibe *neu* um einen neuen Kontakt anzulegen.",
    );
  } else if (text === "2" || text.includes("beleg")) {
    await updateSession(session.id, { step: "receipt_upload" });
    await sendWhatsApp(msg.from, "🧾 *Beleg erfassen*\n\nSende mir ein Foto des Belegs.");
  } else if (text === "3" || text.includes("suche")) {
    await updateSession(session.id, { step: "contact_search" });
    await sendWhatsApp(msg.from, "🔍 Gib den Suchbegriff ein:");
  } else {
    await sendWhatsApp(
      msg.from,
      "Bitte antworte mit:\n1️⃣ rechnung\n2️⃣ beleg\n3️⃣ suche",
    );
  }
}

// --- CONTACT SEARCH ---
async function handleContactSearch(msg: IncomingMessage, session: Session) {
  const text = msg.body.trim();
  const tenant = await requireTenant(session);

  if (text.toLowerCase() === "neu") {
    await updateSession(session.id, { step: "contact_new_name" });
    await sendWhatsApp(msg.from, "Neuer Kontakt: Wie heisst der Kunde? (Firma oder Name)");
    return;
  }

  if (text.length < 2) {
    await sendWhatsApp(msg.from, "Bitte gib mindestens 2 Buchstaben ein.");
    return;
  }

  const results = await bexio.searchContacts(tenant, text);

  if (results.length === 0) {
    await sendWhatsApp(
      msg.from,
      `Keine Kontakte für "${text}" gefunden.\n\n` +
        "Schreibe *neu* um einen neuen Kontakt anzulegen,\n" +
        "oder gib einen anderen Suchbegriff ein.",
    );
    return;
  }

  // Show results as numbered list
  let listText = `*${results.length} Kontakt(e) gefunden:*\n\n`;
  results.slice(0, 10).forEach((c, i) => {
    const details = [c.address, c.postcode, c.city].filter(Boolean).join(", ");
    listText += `${i + 1}. *${c.name_1}*${details ? ` — ${details}` : ""}\n`;
  });
  listText += "\nAntworte mit der Nummer, oder *neu* für einen neuen Kontakt.";

  await updateSession(session.id, {
    step: "contact_select",
    search_results: results.slice(0, 10) as unknown as Array<Record<string, unknown>>,
  });
  await sendWhatsApp(msg.from, listText);
}

// --- CONTACT SELECT ---
async function handleContactSelect(msg: IncomingMessage, session: Session) {
  const text = msg.body.trim().toLowerCase();

  if (text === "neu") {
    await updateSession(session.id, { step: "contact_new_name" });
    await sendWhatsApp(msg.from, "Wie heisst der Kunde? (Firma oder Name)");
    return;
  }

  const idx = parseInt(text, 10);
  const results = (session.search_results || []) as unknown as bexio.BexioContact[];

  if (isNaN(idx) || idx < 1 || idx > results.length) {
    await sendWhatsApp(msg.from, `Bitte antworte mit einer Nummer (1-${results.length}) oder *neu*.`);
    return;
  }

  const contact = results[idx - 1];
  await updateSession(session.id, {
    bexio_contact_id: contact.id,
    contact_data: { name: contact.name_1, city: contact.city } as Record<string, unknown>,
    step: "invoice_title",
  });
  await sendWhatsApp(
    msg.from,
    `✅ Kontakt: *${contact.name_1}*\n\nWie soll die Rechnung heissen? (Titel)`,
  );
}

// --- NEW CONTACT: NAME ---
async function handleContactNewName(msg: IncomingMessage, session: Session) {
  const name = msg.body.trim();
  if (!name) {
    await sendWhatsApp(msg.from, "Bitte gib einen Namen ein.");
    return;
  }
  await updateSession(session.id, {
    contact_data: { name } as Record<string, unknown>,
    step: "contact_new_address",
  });
  await sendWhatsApp(
    msg.from,
    "Adresse? (Strasse, PLZ Ort)\nOder schreibe *skip* um zu überspringen.",
  );
}

// --- NEW CONTACT: ADDRESS ---
async function handleContactNewAddress(msg: IncomingMessage, session: Session) {
  const text = msg.body.trim();
  const tenant = await requireTenant(session);
  const contactData = (session.contact_data || {}) as Record<string, string>;

  let address = "";
  let postcode = "";
  let city = "";

  if (text.toLowerCase() !== "skip" && text.length > 0) {
    const parts = text.split(",").map((s) => s.trim());
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

  const newContact = await bexio.createContact(tenant, {
    name: contactData.name || "Unbekannt",
    address,
    postcode,
    city,
  });

  await updateSession(session.id, {
    bexio_contact_id: newContact.id,
    contact_data: { name: newContact.name_1, city: newContact.city || city } as Record<string, unknown>,
    step: "invoice_title",
  });
  await sendWhatsApp(
    msg.from,
    `✅ Kontakt *${newContact.name_1}* erstellt (ID: ${newContact.id})\n\n` +
      "Wie soll die Rechnung heissen? (Titel)",
  );
}

// --- INVOICE TITLE ---
async function handleInvoiceTitle(msg: IncomingMessage, session: Session) {
  const title = msg.body.trim();
  if (!title) {
    await sendWhatsApp(msg.from, "Bitte gib einen Titel für die Rechnung ein.");
    return;
  }
  await updateSession(session.id, { invoice_title: title, step: "position_desc" });
  await sendWhatsApp(
    msg.from,
    `Titel: *${title}*\n\nJetzt die Positionen.\nBeschreibe die erste Position:`,
  );
}

// --- POSITION DESC ---
async function handlePositionDesc(msg: IncomingMessage, session: Session) {
  const desc = msg.body.trim();
  if (!desc) {
    await sendWhatsApp(msg.from, "Bitte beschreibe die Position.");
    return;
  }
  await updateSession(session.id, { current_position_desc: desc, step: "position_price" });
  await sendWhatsApp(msg.from, `Position: *${desc}*\n\nPreis in CHF? (z.B. 150.00)`);
}

// --- POSITION PRICE ---
async function handlePositionPrice(msg: IncomingMessage, session: Session) {
  const text = msg.body.trim().replace("'", "").replace(",", ".");
  const price = parseFloat(text);

  if (isNaN(price) || price <= 0) {
    await sendWhatsApp(msg.from, "Bitte gib einen gültigen Preis ein (z.B. 150.00).");
    return;
  }

  const positions = session.manual_positions || [];
  positions.push({ description: session.current_position_desc || "", price });

  const total = positions.reduce((s, p) => s + p.price, 0);

  await updateSession(session.id, {
    manual_positions: positions,
    current_position_desc: null,
    current_position_price: null,
    step: "position_more",
  });

  await sendWhatsApp(
    msg.from,
    `✅ Position hinzugefügt!\n\n` +
      `Positionen: ${positions.length}\n` +
      `Total: CHF ${total.toFixed(2)}\n\n` +
      "Antworte:\n" +
      "*ja* — Weitere Position hinzufügen\n" +
      "*fertig* — Rechnung erstellen",
  );
}

// --- POSITION MORE ---
async function handlePositionMore(msg: IncomingMessage, session: Session) {
  const text = msg.body.trim().toLowerCase();

  if (text === "ja" || text === "weitere" || text === "1") {
    await updateSession(session.id, { step: "position_desc" });
    await sendWhatsApp(msg.from, "Beschreibe die nächste Position:");
    return;
  }

  if (text === "fertig" || text === "nein" || text === "erstellen" || text === "2") {
    const positions = session.manual_positions || [];
    const total = positions.reduce((s, p) => s + p.price, 0);
    const contactName = (session.contact_data as Record<string, string>)?.name || `ID ${session.bexio_contact_id}`;

    let summary = `📄 *Rechnungs-Zusammenfassung*\n\n`;
    summary += `Titel: ${session.invoice_title}\n`;
    summary += `Kunde: ${contactName}\n\n`;
    positions.forEach((p, i) => {
      summary += `${i + 1}. ${p.description} — CHF ${p.price.toFixed(2)}\n`;
    });
    summary += `\n*Total: CHF ${total.toFixed(2)}*\n\n`;
    summary += "Antworte *ja* um die Rechnung in Bexio zu erstellen,\noder *abbrechen* um abzubrechen.";

    await updateSession(session.id, { step: "invoice_confirm" });
    await sendWhatsApp(msg.from, summary);
    return;
  }

  await sendWhatsApp(msg.from, "Antworte mit *ja* (weitere Position) oder *fertig* (Rechnung erstellen).");
}

// --- INVOICE CONFIRM ---
async function handleInvoiceConfirm(msg: IncomingMessage, session: Session) {
  const text = msg.body.trim().toLowerCase();

  if (text === "abbrechen" || text === "nein") {
    await resetSession(session.id);
    await sendWhatsApp(msg.from, "Rechnung abgebrochen. Schreibe etwas um neu zu starten.");
    return;
  }

  if (text !== "ja" && text !== "ok" && text !== "erstellen") {
    await sendWhatsApp(msg.from, "Antworte mit *ja* zum Erstellen oder *abbrechen*.");
    return;
  }

  const tenant = await requireTenant(session);
  await sendWhatsApp(msg.from, "⏳ Rechnung wird in Bexio erstellt...");

  const invoice = await bexio.createInvoice(tenant, {
    contactId: session.bexio_contact_id!,
    title: session.invoice_title || "Rechnung",
    positions: session.manual_positions || [],
  });

  // Try to issue
  try {
    await bexio.issueInvoice(tenant, invoice.id);
  } catch {
    // Draft is fine
  }

  await updateSession(session.id, {
    bexio_invoice_id: invoice.id,
    bexio_invoice_nr: invoice.document_nr,
  });

  await sendWhatsApp(
    msg.from,
    `✅ *Rechnung erstellt!*\n\n` +
      `Rechnungs-Nr: ${invoice.document_nr}\n` +
      `Total: CHF ${invoice.total}\n\n` +
      `Die Rechnung findest du in deinem Bexio-Konto.`,
  );

  // Send email notification
  try {
    await sendInvoiceNotification(tenant.email, invoice.document_nr, invoice.total);
  } catch (err) {
    console.error("[Flow] Email notification failed:", err);
  }

  await resetSession(session.id);
}

// --- RECEIPT UPLOAD ---
async function handleReceiptUpload(msg: IncomingMessage, session: Session) {
  if (msg.numMedia === 0) {
    await sendWhatsApp(
      msg.from,
      "Bitte sende ein Foto oder PDF des Belegs.\nSchreibe *abbrechen* um zurückzukehren.",
    );
    return;
  }

  if (!msg.mediaUrl) {
    await sendWhatsApp(msg.from, "Konnte die Datei nicht lesen. Bitte erneut senden.");
    return;
  }

  await sendWhatsApp(msg.from, "⏳ Beleg wird analysiert...");

  // Download media from Twilio
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const token = Deno.env.get("TWILIO_AUTH_TOKEN")!;

  const mediaResp = await fetch(msg.mediaUrl, {
    headers: { Authorization: "Basic " + btoa(`${sid}:${token}`) },
  });

  if (!mediaResp.ok) {
    await sendWhatsApp(msg.from, "Fehler beim Herunterladen des Belegs. Bitte erneut senden.");
    return;
  }

  const buffer = await mediaResp.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  const mimeType = msg.mediaType || "image/jpeg";

  // Analyze with Claude
  let receiptData;
  try {
    receiptData = await analyzeReceipt(base64, mimeType);
  } catch (err) {
    console.error("[Flow] Receipt analysis error:", err);
    await updateSession(session.id, { receipt_base64: base64, receipt_type: mimeType });
    await sendWhatsApp(
      msg.from,
      "Beleg gespeichert, aber die automatische Erkennung hat nicht geklappt.\n" +
        "Du kannst ihn manuell in Bexio verarbeiten.",
    );
    await resetSession(session.id);
    return;
  }

  await updateSession(session.id, {
    receipt_base64: base64,
    receipt_type: mimeType,
    receipt_data: receiptData as unknown as Record<string, unknown>,
    step: "receipt_confirm",
  });

  let summary = "🧾 *Beleg erkannt:*\n\n";
  summary += `Lieferant: ${receiptData.vendor}\n`;
  summary += `Datum: ${receiptData.date}\n`;
  summary += `Total: CHF ${receiptData.total}\n`;
  if (receiptData.items.length > 0) {
    summary += "\nPositionen:\n";
    receiptData.items.forEach((item, i) => {
      summary += `${i + 1}. ${item.description} — CHF ${item.amount}\n`;
    });
  }
  summary += "\nStimmt das? Antworte *ja* zum Speichern oder *nein* zum Verwerfen.";

  await sendWhatsApp(msg.from, summary);
}

// --- RECEIPT CONFIRM ---
async function handleReceiptConfirm(msg: IncomingMessage, session: Session) {
  const text = msg.body.trim().toLowerCase();

  if (text === "ja" || text === "ok") {
    await sendWhatsApp(msg.from, "✅ Beleg gespeichert! Du findest die Daten in deinem Konto.");
    await resetSession(session.id);
  } else if (text === "nein" || text === "abbrechen") {
    await sendWhatsApp(msg.from, "Beleg verworfen. Schreibe etwas um neu zu starten.");
    await resetSession(session.id);
  } else {
    await sendWhatsApp(msg.from, "Antworte mit *ja* zum Speichern oder *nein* zum Verwerfen.");
  }
}

// ---------- Helpers ----------

async function requireTenant(session: Session): Promise<Tenant> {
  if (!session.tenant_id) throw new Error("No tenant linked");
  const tenant = await getTenantByWhatsApp(session.phone_number);
  if (!tenant) throw new Error("Tenant not found");
  return tenant;
}
