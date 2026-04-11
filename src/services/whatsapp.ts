import axios from 'axios';
import { config } from '../config';

const API_BASE = `https://graph.facebook.com/v21.0/${config.whatsapp.phoneNumberId}`;

const headers = {
  Authorization: `Bearer ${config.whatsapp.accessToken}`,
  'Content-Type': 'application/json',
};

export async function sendText(to: string, body: string): Promise<void> {
  await axios.post(
    `${API_BASE}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    },
    { headers },
  );
}

export async function sendButtons(
  to: string,
  body: string,
  buttons: Array<{ id: string; title: string }>,
): Promise<void> {
  await axios.post(
    `${API_BASE}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    },
    { headers },
  );
}

export async function sendList(
  to: string,
  body: string,
  buttonText: string,
  sections: Array<{
    title: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>,
): Promise<void> {
  await axios.post(
    `${API_BASE}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: buttonText,
          sections,
        },
      },
    },
    { headers },
  );
}

export async function downloadMedia(mediaId: string): Promise<{ base64: string; mimeType: string }> {
  // Step 1: Get media URL
  const { data: meta } = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, { headers });

  // Step 2: Download binary
  const { data: buffer, headers: respHeaders } = await axios.get(meta.url, {
    headers,
    responseType: 'arraybuffer',
  });

  return {
    base64: Buffer.from(buffer).toString('base64'),
    mimeType: respHeaders['content-type'] || 'application/octet-stream',
  };
}

// ---------- Parse incoming webhook ----------

export interface IncomingMessage {
  from: string;        // sender phone number
  type: string;        // text | interactive | image | document
  text?: string;       // text body
  buttonId?: string;   // interactive button reply id
  listId?: string;     // interactive list reply id
  mediaId?: string;    // image/document media id
  mimeType?: string;   // media mime type
}

export function parseWebhook(body: Record<string, unknown>): IncomingMessage | null {
  try {
    const entry = body.entry as Array<Record<string, unknown>>;
    const changes = entry?.[0]?.changes as Array<Record<string, unknown>>;
    const value = changes?.[0]?.value as Record<string, unknown>;
    const messages = value?.messages as Array<Record<string, unknown>>;
    if (!messages?.length) return null;

    const msg = messages[0];
    const from = msg.from as string;
    const type = msg.type as string;

    const result: IncomingMessage = { from, type };

    if (type === 'text') {
      result.text = (msg.text as Record<string, string>)?.body;
    } else if (type === 'interactive') {
      const interactive = msg.interactive as Record<string, unknown>;
      const interactiveType = interactive?.type as string;
      if (interactiveType === 'button_reply') {
        result.buttonId = (interactive.button_reply as Record<string, string>)?.id;
      } else if (interactiveType === 'list_reply') {
        result.listId = (interactive.list_reply as Record<string, string>)?.id;
      }
    } else if (type === 'image' || type === 'document') {
      const media = msg[type] as Record<string, string>;
      result.mediaId = media?.id;
      result.mimeType = media?.mime_type;
    }

    return result;
  } catch {
    return null;
  }
}
