import Stripe from 'stripe';
import { config } from '../config';
import { supabase } from './supabase';

export const stripe = new Stripe(config.stripe.secretKey);

export async function createCheckoutSession(tenantId: string, email: string): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: email,
    line_items: [{ price: config.stripe.priceIdMonthly, quantity: 1 }],
    metadata: { tenant_id: tenantId },
    success_url: `${config.bexio.redirectUri.replace('/api/bexio/callback', '')}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.bexio.redirectUri.replace('/api/bexio/callback', '')}/cancel`,
  });
  return session.url!;
}

export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const tenantId = session.metadata?.tenant_id;
      if (!tenantId) break;

      await supabase
        .from('tenants')
        .update({
          stripe_customer_id: session.customer as string,
          stripe_subscription_id: session.subscription as string,
          plan: 'active',
          updated_at: new Date().toISOString(),
        })
        .eq('id', tenantId);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      await supabase
        .from('tenants')
        .update({
          plan: 'cancelled',
          is_active: false,
          updated_at: new Date().toISOString(),
        })
        .eq('stripe_subscription_id', sub.id);
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const active = sub.status === 'active' || sub.status === 'trialing';
      await supabase
        .from('tenants')
        .update({
          plan: active ? 'active' : 'past_due',
          is_active: active,
          updated_at: new Date().toISOString(),
        })
        .eq('stripe_subscription_id', sub.id);
      break;
    }
  }
}
