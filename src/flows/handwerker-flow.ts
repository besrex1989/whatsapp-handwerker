import {
  Session,
  Tenant,
  getOrCreateSession,
  getTenantByWhatsApp,
  updateSession,
  resetSession,
} from '../services/supabase';
import * as wa from '../services/whatsapp';
import * as bexio from '../services/bexio';

/**
 * Main entry: process an incoming WhatsApp message.
 */
export async function handleMessage(msg: wa.IncomingMessage): Promise<void> {
  const session = await getOrCreateSession(msg.from);

  // Identify tenant if not yet linked
  if (!session.tenant_id) {
    const tenant = await getTenantByWhatsApp(msg.from);
    if (!tenant) {
      await wa.sendText(msg.from,
        'Willkommen! Deine Nummer ist noch nicht registriert. ' +
        'Bitte melde dich zuerst unter unserer Website an.');
      return;
    }
    if (!tenant.is_active && tenant.plan !== 'trial') {
      await wa.sendText(msg.from, 'Dein Konto ist nicht aktiv. Bitte erneuere dein Abo.');
      return;
    }
    // Check trial expiry
    if (tenant.plan === 'trial' && new Date(tenant.trial_ends_at) < new Date()) {
      await wa.sendText(msg.from, 'Deine Testphase ist abgelaufen. Bitte upgrade auf ein Abo.');
      return;
    }
    await updateSession(session.id, { tenant_id: tenant.id });
    session.tenant_id = tenant.id;
  }

  // Global reset command
  const text = msg.text?.trim().toLowerCase() || msg.buttonId || msg.listId || '';
  if (text === 'reset' || text === 'abbrechen' || text === 'neustart') {
    await resetSession(session.id);
    await wa.sendText(msg.from, 'Session zurückgesetzt. Schreibe etwas um neu zu starten.');
    return;
  }

  // Route by step
  const step = session.step || 'start';
  const handler = steps[step] || steps['start'];
  await handler(msg, session);
}

// ---------- Step handlers ----------

type StepHandler = (msg: wa.IncomingMessage, session: Session) => Promise<void>;

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
};

// --- START ---
async function handleStart(msg: wa.IncomingMessage, session: Session) {
  await updateSession(session.id, { step: 'main_menu' });
  await wa.sendButtons(msg.from,
    'Hallo! Was möchtest du tun?',
    [
      { id: 'invoice', title: 'Rechnung erstellen' },
      { id: 'receipt', title: 'Beleg erfassen' },
    ],
  );
}

// --- MAIN MENU ---
async function handleMainMenu(msg: wa.IncomingMessage, session: Session) {
  const choice = msg.buttonId || msg.text?.trim().toLowerCase() || '';

  if (choice === 'invoice' || choice === 'rechnung') {
    await updateSession(session.id, { step: 'contact_search', manual_positions: [] });
    await wa.sendText(msg.from,
      'Rechnung erstellen\n\n' +
      'Gib den Namen des Kunden ein um in Bexio zu suchen, ' +
      'oder schreibe *neu* um einen neuen Kontakt anzulegen.');
  } else if (choice === 'receipt' || choice === 'beleg') {
    await updateSession(session.id, { step: 'receipt_upload' });
    await wa.sendText(msg.from,
      'Beleg erfassen\n\n' +
      'Sende mir ein Foto oder PDF des Belegs.');
  } else {
    await wa.sendButtons(msg.from,
      'Bitte wähle eine Option:',
      [
        { id: 'invoice', title: 'Rechnung erstellen' },
        { id: 'receipt', title: 'Beleg erfassen' },
      ],
    );
  }
}

// --- CONTACT SEARCH ---
async function handleContactSearch(msg: wa.IncomingMessage, session: Session) {
  const text = msg.text?.trim() || '';
  const tenant = await requireTenant(session);

  if (text.toLowerCase() === 'neu') {
    await updateSession(session.id, { step: 'contact_new_name' });
    await wa.sendText(msg.from, 'Neuer Kontakt: Wie heisst der Kunde? (Firma oder Name)');
    return;
  }

  if (text.length < 2) {
    await wa.sendText(msg.from, 'Bitte gib mindestens 2 Buchstaben ein.');
    return;
  }

  const results = await bexio.searchContacts(tenant, text);
  if (results.length === 0) {
    await wa.sendButtons(msg.from,
      `Keine Kontakte für "${text}" gefunden.`,
      [
        { id: 'new_contact', title: 'Neu anlegen' },
        { id: 'search_again', title: 'Nochmal suchen' },
      ],
    );
    await updateSession(session.id, { step: 'contact_select' });
    return;
  }

  const rows = results.slice(0, 10).map((c) => ({
    id: `contact_${c.id}`,
    title: c.name_1.slice(0, 24),
    description: [c.address, c.city].filter(Boolean).join(', ').slice(0, 72),
  }));

  await wa.sendList(msg.from,
    `${results.length} Kontakt(e) gefunden:`,
    'Kontakt wählen',
    [{ title: 'Kontakte', rows }],
  );
  await updateSession(session.id, {
    step: 'contact_select',
    search_results: results.slice(0, 10) as unknown as Array<Record<string, unknown>>,
  });
}

// --- CONTACT SELECT ---
async function handleContactSelect(msg: wa.IncomingMessage, session: Session) {
  const choice = msg.listId || msg.buttonId || msg.text?.trim() || '';

  if (choice === 'new_contact' || choice.toLowerCase() === 'neu') {
    await updateSession(session.id, { step: 'contact_new_name' });
    await wa.sendText(msg.from, 'Wie heisst der Kunde? (Firma oder Name)');
    return;
  }
  if (choice === 'search_again') {
    await updateSession(session.id, { step: 'contact_search' });
    await wa.sendText(msg.from, 'Gib den Suchbegriff ein:');
    return;
  }

  const contactMatch = choice.match(/^contact_(\d+)$/);
  if (contactMatch) {
    const contactId = parseInt(contactMatch[1], 10);
    const contact = (session.search_results || []).find(
      (c) => (c as unknown as bexio.BexioContact).id === contactId,
    ) as unknown as bexio.BexioContact | undefined;

    await updateSession(session.id, {
      bexio_contact_id: contactId,
      contact_data: contact ? { name: contact.name_1, city: contact.city } : null,
      step: 'invoice_title',
    });
    await wa.sendText(msg.from,
      `Kontakt gewählt: ${contact?.name_1 || contactId}\n\nWie soll die Rechnung heissen? (Titel)`);
    return;
  }

  await wa.sendText(msg.from, 'Bitte wähle einen Kontakt aus der Liste.');
}

// --- NEW CONTACT: NAME ---
async function handleContactNewName(msg: wa.IncomingMessage, session: Session) {
  const name = msg.text?.trim();
  if (!name) {
    await wa.sendText(msg.from, 'Bitte gib einen Namen ein.');
    return;
  }
  await updateSession(session.id, {
    contact_data: { name },
    step: 'contact_new_address',
  });
  await wa.sendText(msg.from,
    'Adresse? (Strasse, PLZ Ort)\nOder schreibe *skip* um zu überspringen.');
}

// --- NEW CONTACT: ADDRESS ---
async function handleContactNewAddress(msg: wa.IncomingMessage, session: Session) {
  const text = msg.text?.trim() || '';
  const tenant = await requireTenant(session);
  const contactData = (session.contact_data || {}) as Record<string, string>;

  let address = '';
  let postcode = '';
  let city = '';

  if (text.toLowerCase() !== 'skip' && text.length > 0) {
    // Try to parse "Strasse, PLZ Ort"
    const parts = text.split(',').map((s) => s.trim());
    address = parts[0] || '';
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
    name: contactData.name || 'Unbekannt',
    address,
    postcode,
    city,
  });

  await updateSession(session.id, {
    bexio_contact_id: newContact.id,
    contact_data: { name: newContact.name_1, city: newContact.city || city },
    step: 'invoice_title',
  });
  await wa.sendText(msg.from,
    `Kontakt "${newContact.name_1}" erstellt (ID: ${newContact.id}).\n\n` +
    'Wie soll die Rechnung heissen? (Titel)');
}

// --- INVOICE TITLE ---
async function handleInvoiceTitle(msg: wa.IncomingMessage, session: Session) {
  const title = msg.text?.trim();
  if (!title) {
    await wa.sendText(msg.from, 'Bitte gib einen Titel für die Rechnung ein.');
    return;
  }
  await updateSession(session.id, { invoice_title: title, step: 'position_desc' });
  await wa.sendText(msg.from,
    `Titel: ${title}\n\nJetzt die Positionen. Beschreibe die erste Position:`);
}

// --- POSITION DESCRIPTION ---
async function handlePositionDesc(msg: wa.IncomingMessage, session: Session) {
  const desc = msg.text?.trim();
  if (!desc) {
    await wa.sendText(msg.from, 'Bitte beschreibe die Position.');
    return;
  }
  await updateSession(session.id, {
    current_position_desc: desc,
    step: 'position_price',
  });
  await wa.sendText(msg.from, `Position: ${desc}\n\nPreis in CHF? (z.B. 150.00)`);
}

// --- POSITION PRICE ---
async function handlePositionPrice(msg: wa.IncomingMessage, session: Session) {
  const text = msg.text?.trim().replace("'", '').replace(',', '.') || '';
  const price = parseFloat(text);

  if (isNaN(price) || price <= 0) {
    await wa.sendText(msg.from, 'Bitte gib einen gültigen Preis ein (z.B. 150.00).');
    return;
  }

  const positions = session.manual_positions || [];
  positions.push({
    description: session.current_position_desc || '',
    price,
  });

  await updateSession(session.id, {
    manual_positions: positions,
    current_position_desc: null,
    current_position_price: null,
    step: 'position_more',
  });

  const total = positions.reduce((s, p) => s + p.price, 0);
  await wa.sendButtons(msg.from,
    `Position hinzugefügt!\n\n` +
    `Positionen: ${positions.length}\n` +
    `Total: CHF ${total.toFixed(2)}\n\n` +
    `Weitere Position hinzufügen?`,
    [
      { id: 'add_more', title: 'Weitere Position' },
      { id: 'finish', title: 'Rechnung erstellen' },
    ],
  );
}

// --- POSITION MORE ---
async function handlePositionMore(msg: wa.IncomingMessage, session: Session) {
  const choice = msg.buttonId || msg.text?.trim().toLowerCase() || '';

  if (choice === 'add_more' || choice === 'ja' || choice === 'weitere') {
    await updateSession(session.id, { step: 'position_desc' });
    await wa.sendText(msg.from, 'Beschreibe die nächste Position:');
  } else if (choice === 'finish' || choice === 'fertig' || choice === 'erstellen') {
    await updateSession(session.id, { step: 'invoice_confirm' });

    const positions = session.manual_positions || [];
    const total = positions.reduce((s, p) => s + p.price, 0);
    let summary = `*Rechnungs-Zusammenfassung*\n\n`;
    summary += `Titel: ${session.invoice_title}\n`;
    summary += `Kontakt-ID: ${session.bexio_contact_id}\n\n`;
    positions.forEach((p, i) => {
      summary += `${i + 1}. ${p.description} — CHF ${p.price.toFixed(2)}\n`;
    });
    summary += `\n*Total: CHF ${total.toFixed(2)}*`;

    await wa.sendText(msg.from, summary);
    await wa.sendButtons(msg.from, 'Rechnung jetzt in Bexio erstellen?', [
      { id: 'confirm_invoice', title: 'Ja, erstellen' },
      { id: 'cancel_invoice', title: 'Abbrechen' },
    ]);
  } else {
    await wa.sendButtons(msg.from, 'Bitte wähle:', [
      { id: 'add_more', title: 'Weitere Position' },
      { id: 'finish', title: 'Rechnung erstellen' },
    ]);
  }
}

// --- INVOICE CONFIRM ---
async function handleInvoiceConfirm(msg: wa.IncomingMessage, session: Session) {
  const choice = msg.buttonId || msg.text?.trim().toLowerCase() || '';

  if (choice === 'cancel_invoice' || choice === 'abbrechen') {
    await resetSession(session.id);
    await wa.sendText(msg.from, 'Rechnung abgebrochen. Schreibe etwas um neu zu starten.');
    return;
  }

  if (choice !== 'confirm_invoice' && choice !== 'ja') {
    await wa.sendButtons(msg.from, 'Rechnung erstellen?', [
      { id: 'confirm_invoice', title: 'Ja, erstellen' },
      { id: 'cancel_invoice', title: 'Abbrechen' },
    ]);
    return;
  }

  const tenant = await requireTenant(session);

  await wa.sendText(msg.from, 'Rechnung wird erstellt...');

  const invoice = await bexio.createInvoice(tenant, {
    contactId: session.bexio_contact_id!,
    title: session.invoice_title || 'Rechnung',
    positions: session.manual_positions || [],
  });

  // Try to issue the invoice
  try {
    await bexio.issueInvoice(tenant, invoice.id);
  } catch {
    // Not critical — invoice is still created as draft
  }

  await updateSession(session.id, {
    bexio_invoice_id: invoice.id,
    bexio_invoice_nr: invoice.document_nr,
  });

  await wa.sendText(msg.from,
    `Rechnung erstellt!\n\n` +
    `Rechnungs-Nr: ${invoice.document_nr}\n` +
    `Total: CHF ${invoice.total}\n\n` +
    `Die Rechnung findest du in deinem Bexio-Konto.`);

  await resetSession(session.id);
  await wa.sendText(msg.from, 'Schreibe etwas um eine neue Aktion zu starten.');
}

// --- RECEIPT UPLOAD ---
async function handleReceiptUpload(msg: wa.IncomingMessage, session: Session) {
  if (msg.type !== 'image' && msg.type !== 'document') {
    await wa.sendText(msg.from,
      'Bitte sende ein Foto oder PDF des Belegs.\n' +
      'Schreibe *abbrechen* um zurückzukehren.');
    return;
  }

  if (!msg.mediaId) {
    await wa.sendText(msg.from, 'Konnte die Datei nicht lesen. Bitte erneut senden.');
    return;
  }

  await wa.sendText(msg.from, 'Beleg wird verarbeitet...');

  const media = await wa.downloadMedia(msg.mediaId);

  await updateSession(session.id, {
    receipt_base64: media.base64,
    receipt_type: media.mimeType,
  });

  await wa.sendText(msg.from,
    'Beleg gespeichert!\n\n' +
    'Der Beleg wurde in deiner Session hinterlegt. ' +
    'Du kannst ihn in Bexio weiterverarbeiten.');

  await resetSession(session.id);
  await wa.sendText(msg.from, 'Schreibe etwas um eine neue Aktion zu starten.');
}

// ---------- Helpers ----------

async function requireTenant(session: Session): Promise<Tenant> {
  if (!session.tenant_id) throw new Error('No tenant linked');
  const tenant = await getTenantByWhatsApp(session.phone_number);
  if (!tenant) throw new Error('Tenant not found');
  return tenant;
}
