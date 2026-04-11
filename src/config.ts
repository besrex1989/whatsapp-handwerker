function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  port: parseInt(optional('PORT', '3000'), 10),

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },

  whatsapp: {
    verifyToken: required('WHATSAPP_VERIFY_TOKEN'),
    accessToken: required('WHATSAPP_ACCESS_TOKEN'),
    phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID'),
  },

  bexio: {
    clientId: required('BEXIO_CLIENT_ID'),
    clientSecret: required('BEXIO_CLIENT_SECRET'),
    redirectUri: required('BEXIO_REDIRECT_URI'),
  },

  stripe: {
    secretKey: required('STRIPE_SECRET_KEY'),
    webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
    priceIdMonthly: required('STRIPE_PRICE_ID_MONTHLY'),
  },
} as const;
