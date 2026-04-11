import express from 'express';
import { config } from './config';
import { webhookRouter } from './routes/webhook';
import { stripeWebhookRouter } from './routes/stripe-webhook';
import { bexioOAuthRouter } from './routes/bexio-oauth';

export function createServer() {
  const app = express();

  // Stripe needs raw body for signature verification — must come before json parser
  app.use('/stripe', express.raw({ type: 'application/json' }));

  // JSON parser for all other routes
  app.use(express.json());

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Routes
  app.use(webhookRouter);
  app.use(stripeWebhookRouter);
  app.use(bexioOAuthRouter);

  return app;
}

export function startServer() {
  const app = createServer();
  app.listen(config.port, () => {
    console.log(`[Server] WhatsApp-Handwerker running on port ${config.port}`);
  });
}
