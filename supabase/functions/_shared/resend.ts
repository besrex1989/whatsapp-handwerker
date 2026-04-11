const RESEND_API_KEY = () => Deno.env.get("RESEND_API_KEY")!;

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  from?: string;
}): Promise<void> {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: params.from || "WhatsApp Handwerker <noreply@resend.dev>",
      to: params.to,
      subject: params.subject,
      html: params.html,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error("[Resend] Error:", err);
    throw new Error(`Resend error: ${resp.status}`);
  }
}

export async function sendInvoiceNotification(tenantEmail: string, invoiceNr: string, total: string) {
  await sendEmail({
    to: tenantEmail,
    subject: `Rechnung ${invoiceNr} erstellt`,
    html: `
      <h2>Neue Rechnung erstellt</h2>
      <p>Über WhatsApp wurde eine neue Rechnung erstellt:</p>
      <ul>
        <li><strong>Rechnungs-Nr:</strong> ${invoiceNr}</li>
        <li><strong>Total:</strong> CHF ${total}</li>
      </ul>
      <p>Du findest die Rechnung in deinem Bexio-Konto.</p>
    `,
  });
}
