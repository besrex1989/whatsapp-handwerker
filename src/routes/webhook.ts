import { Router, Request, Response } from 'express';
import { config } from '../config';
import { parseWebhook } from '../services/whatsapp';
import { handleMessage } from '../flows/handwerker-flow';

export const webhookRouter = Router();

// WhatsApp Verification (GET)
webhookRouter.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    console.log('[WhatsApp] Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// WhatsApp Messages (POST)
webhookRouter.post('/webhook', async (req: Request, res: Response) => {
  // Always respond 200 quickly to avoid retries
  res.sendStatus(200);

  try {
    const msg = parseWebhook(req.body);
    if (!msg) return;

    console.log(`[WhatsApp] ${msg.from} → ${msg.type}: ${msg.text || msg.buttonId || msg.listId || 'media'}`);
    await handleMessage(msg);
  } catch (err) {
    console.error('[WhatsApp] Error processing message:', err);
  }
});
