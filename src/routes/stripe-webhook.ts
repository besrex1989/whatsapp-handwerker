import { Router, Request, Response } from 'express';
import { config } from '../config';
import { stripe, handleWebhookEvent } from '../services/stripe';

export const stripeWebhookRouter = Router();

// Stripe uses raw body for signature verification
stripeWebhookRouter.post('/stripe/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;

  try {
    const event = stripe.webhooks.constructEvent(
      req.body, // must be raw Buffer
      sig,
      config.stripe.webhookSecret,
    );

    console.log(`[Stripe] Event: ${event.type}`);
    await handleWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe] Webhook error:', err);
    res.status(400).send('Webhook Error');
  }
});
