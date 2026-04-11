import axios, { AxiosInstance } from 'axios';
import { Tenant, updateTenant } from './supabase';
import { config } from '../config';

const BEXIO_API = 'https://api.bexio.com/2.0';
const BEXIO_AUTH = 'https://idp.bexio.com/authorize';
const BEXIO_TOKEN = 'https://idp.bexio.com/token';

// ---------- OAuth helpers ----------

export function getAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.bexio.clientId,
    redirect_uri: config.bexio.redirectUri,
    response_type: 'code',
    scope: 'openid profile email kb_invoice kb_article contact_show contact_edit',
    state,
  });
  return `${BEXIO_AUTH}?${params}`;
}

export async function exchangeCode(code: string) {
  const { data } = await axios.post(BEXIO_TOKEN, new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.bexio.clientId,
    client_secret: config.bexio.clientSecret,
    redirect_uri: config.bexio.redirectUri,
  }));
  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresIn: data.expires_in as number,
  };
}

async function refreshAccessToken(tenant: Tenant): Promise<string> {
  if (!tenant.bexio_refresh_token) throw new Error('No refresh token');

  const { data } = await axios.post(BEXIO_TOKEN, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tenant.bexio_refresh_token,
    client_id: config.bexio.clientId,
    client_secret: config.bexio.clientSecret,
  }));

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await updateTenant(tenant.id, {
    bexio_access_token: data.access_token,
    bexio_refresh_token: data.refresh_token || tenant.bexio_refresh_token,
    bexio_expires_at: expiresAt,
  });

  return data.access_token as string;
}

async function getClient(tenant: Tenant): Promise<AxiosInstance> {
  let token = tenant.bexio_access_token;

  // Refresh if expired or about to expire (5 min buffer)
  if (tenant.bexio_expires_at) {
    const expiresAt = new Date(tenant.bexio_expires_at).getTime();
    if (Date.now() > expiresAt - 5 * 60 * 1000) {
      token = await refreshAccessToken(tenant);
    }
  }

  if (!token) throw new Error('Bexio not connected');

  return axios.create({
    baseURL: BEXIO_API,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
}

// ---------- Contacts ----------

export interface BexioContact {
  id: number;
  name_1: string;
  name_2?: string;
  address?: string;
  postcode?: string;
  city?: string;
  mail?: string;
  phone_fixed?: string;
}

export async function searchContacts(tenant: Tenant, term: string): Promise<BexioContact[]> {
  const client = await getClient(tenant);
  const { data } = await client.post('/contact/search', [
    { field: 'name_1', value: term, criteria: 'like' },
  ]);
  return data as BexioContact[];
}

export async function createContact(tenant: Tenant, contact: {
  name: string;
  address?: string;
  postcode?: string;
  city?: string;
  email?: string;
}): Promise<BexioContact> {
  const client = await getClient(tenant);
  const { data } = await client.post('/contact', {
    contact_type_id: 1, // Firma
    name_1: contact.name,
    address: contact.address || '',
    postcode: contact.postcode || '',
    city: contact.city || '',
    mail: contact.email || '',
    owner_id: tenant.bexio_user_id,
  });
  return data as BexioContact;
}

// ---------- Invoices ----------

export interface BexioInvoice {
  id: number;
  document_nr: string;
  total: string;
  title: string;
}

export async function createInvoice(tenant: Tenant, params: {
  contactId: number;
  title: string;
  positions: Array<{ description: string; price: number }>;
}): Promise<BexioInvoice> {
  const client = await getClient(tenant);

  const positionItems = params.positions.map((p) => ({
    type: 'KbPositionCustom',
    text: p.description,
    unit_price: p.price.toFixed(2),
    amount: '1',
    account_id: tenant.bexio_account_id,
    tax_id: tenant.bexio_tax_id,
  }));

  const { data } = await client.post('/kb_invoice', {
    title: params.title,
    contact_id: params.contactId,
    user_id: tenant.bexio_user_id,
    is_valid_from: new Date().toISOString().split('T')[0],
    is_valid_to: futureDate(30),
    mwst_type: 0, // inkl. MwSt
    mwst_is_net: true,
    positions: positionItems,
  });

  return data as BexioInvoice;
}

export async function issueInvoice(tenant: Tenant, invoiceId: number): Promise<void> {
  const client = await getClient(tenant);
  await client.post(`/kb_invoice/${invoiceId}/issue`);
}

export async function getInvoicePdf(tenant: Tenant, invoiceId: number): Promise<string> {
  const client = await getClient(tenant);
  const { data } = await client.get(`/kb_invoice/${invoiceId}/pdf`);
  return data.content as string; // base64
}

function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
