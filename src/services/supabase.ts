import { createClient } from '@supabase/supabase-js';
import { config } from '../config';

export const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey);

// ---------- Tenants ----------

export interface Tenant {
  id: string;
  email: string;
  full_name: string | null;
  whatsapp_number: string;
  plan: string;
  trial_ends_at: string;
  is_active: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  bexio_access_token: string | null;
  bexio_refresh_token: string | null;
  bexio_expires_at: string | null;
  bexio_user_id: number;
  bexio_account_id: number;
  bexio_tax_id: number;
}

export async function getTenantByWhatsApp(phone: string): Promise<Tenant | null> {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('whatsapp_number', phone)
    .single();
  if (error) return null;
  return data as Tenant;
}

export async function updateTenant(id: string, updates: Partial<Tenant>) {
  const { error } = await supabase
    .from('tenants')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// ---------- Sessions ----------

export interface Session {
  id: string;
  phone_number: string;
  step: string;
  tenant_id: string | null;
  contact_data: Record<string, unknown> | null;
  bexio_contact_id: number | null;
  bexio_invoice_id: number | null;
  bexio_invoice_nr: string | null;
  invoice_title: string | null;
  invoice_data: Record<string, unknown> | null;
  manual_positions: Array<{ description: string; price: number }> | null;
  current_position_desc: string | null;
  current_position_price: number | null;
  receipt_data: Record<string, unknown> | null;
  receipt_base64: string | null;
  receipt_type: string | null;
  search_results: Array<Record<string, unknown>> | null;
  expires_at: string;
}

export async function getOrCreateSession(phone: string): Promise<Session> {
  // Try to find an existing, non-expired session
  const { data: existing } = await supabase
    .from('sessions_handwerker')
    .select('*')
    .eq('phone_number', phone)
    .single();

  if (existing) {
    // Check if expired
    if (new Date(existing.expires_at) < new Date()) {
      await resetSession(existing.id);
      return { ...existing, step: 'start', expires_at: newExpiry() } as Session;
    }
    return existing as Session;
  }

  // Create new session
  const { data, error } = await supabase
    .from('sessions_handwerker')
    .insert({ phone_number: phone })
    .select()
    .single();
  if (error) throw error;
  return data as Session;
}

export async function updateSession(id: string, updates: Partial<Session>) {
  const { error } = await supabase
    .from('sessions_handwerker')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function resetSession(id: string) {
  await supabase
    .from('sessions_handwerker')
    .update({
      step: 'start',
      contact_data: null,
      bexio_contact_id: null,
      bexio_invoice_id: null,
      bexio_invoice_nr: null,
      invoice_title: null,
      invoice_data: null,
      manual_positions: null,
      current_position_desc: null,
      current_position_price: null,
      receipt_data: null,
      receipt_base64: null,
      receipt_type: null,
      search_results: null,
      expires_at: newExpiry(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
}

function newExpiry(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
}
