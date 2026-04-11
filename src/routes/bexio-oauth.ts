import { Router, Request, Response } from 'express';
import { exchangeCode } from '../services/bexio';
import { supabase } from '../services/supabase';

export const bexioOAuthRouter = Router();

// Bexio OAuth callback
bexioOAuthRouter.get('/api/bexio/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string; // tenant_id

  if (!code || !state) {
    res.status(400).send('Missing code or state');
    return;
  }

  try {
    const tokens = await exchangeCode(code);

    await supabase
      .from('tenants')
      .update({
        bexio_access_token: tokens.accessToken,
        bexio_refresh_token: tokens.refreshToken,
        bexio_expires_at: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', state);

    res.send('Bexio erfolgreich verbunden! Du kannst dieses Fenster schliessen.');
  } catch (err) {
    console.error('[Bexio] OAuth error:', err);
    res.status(500).send('Fehler bei der Bexio-Verbindung.');
  }
});
