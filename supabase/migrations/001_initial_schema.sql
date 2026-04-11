create table if not exists public.tenants (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz default now(),
  updated_at            timestamptz default now(),
  email                 text unique not null,
  full_name             text,
  whatsapp_number       text unique not null,
  plan                  text default 'trial',
  trial_ends_at         timestamptz default (now() + interval '14 days'),
  stripe_customer_id    text,
  stripe_subscription_id text,
  is_active             boolean default true,
  bexio_access_token    text,
  bexio_refresh_token   text,
  bexio_expires_at      timestamptz,
  bexio_user_id         integer default 1,
  bexio_account_id      integer default 150,
  bexio_tax_id          integer default 29
);

alter table public.tenants enable row level security;
create policy "Service role full access tenants" on public.tenants for all to service_role using (true);

create table if not exists public.sessions_handwerker (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  phone_number text not null unique,
  step text default 'start',
  tenant_id uuid references public.tenants(id),
  contact_data jsonb,
  bexio_contact_id integer,
  bexio_invoice_id integer,
  bexio_invoice_nr text,
  invoice_title text,
  invoice_data jsonb,
  manual_positions jsonb,
  current_position_desc text,
  current_position_price numeric,
  receipt_data jsonb,
  receipt_base64 text,
  receipt_type text,
  search_results jsonb,
  expires_at timestamptz default (now() + interval '8 hours')
);

alter table public.sessions_handwerker enable row level security;
create policy "Service role full access sessions_handwerker" on public.sessions_handwerker for all to service_role using (true);

create index if not exists idx_tenants_whatsapp on public.tenants(whatsapp_number);
create index if not exists idx_sessions_handwerker_phone on public.sessions_handwerker(phone_number);
