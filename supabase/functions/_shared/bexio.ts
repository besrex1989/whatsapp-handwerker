import { type Tenant, updateTenant } from "./supabase.ts";

const BEXIO_API = "https://api.bexio.com/2.0";
const BEXIO_TOKEN_URL = "https://idp.bexio.com/token";

const BEXIO_CLIENT_ID = () => Deno.env.get("BEXIO_CLIENT_ID")!;
const BEXIO_CLIENT_SECRET = () => Deno.env.get("BEXIO_CLIENT_SECRET")!;

// ---------- Token management ----------

async function refreshAccessToken(tenant: Tenant): Promise<string> {
  if (!tenant.bexio_refresh_token) throw new Error("No Bexio refresh token");

  const resp = await fetch(BEXIO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tenant.bexio_refresh_token,
      client_id: BEXIO_CLIENT_ID(),
      client_secret: BEXIO_CLIENT_SECRET(),
    }),
  });

  if (!resp.ok) throw new Error(`Bexio token refresh failed: ${resp.status}`);
  const data = await resp.json();

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await updateTenant(tenant.id, {
    bexio_access_token: data.access_token,
    bexio_refresh_token: data.refresh_token || tenant.bexio_refresh_token,
    bexio_expires_at: expiresAt,
  });

  return data.access_token;
}

async function getToken(tenant: Tenant): Promise<string> {
  let token = tenant.bexio_access_token;

  if (tenant.bexio_expires_at) {
    const expiresAt = new Date(tenant.bexio_expires_at).getTime();
    if (Date.now() > expiresAt - 5 * 60 * 1000) {
      token = await refreshAccessToken(tenant);
    }
  }

  if (!token) throw new Error("Bexio nicht verbunden");
  return token;
}

async function bexioFetch(tenant: Tenant, path: string, options: RequestInit = {}) {
  const token = await getToken(tenant);
  const resp = await fetch(`${BEXIO_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Bexio API ${path} failed (${resp.status}): ${err}`);
  }
  return resp.json();
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
  return bexioFetch(tenant, "/contact/search", {
    method: "POST",
    body: JSON.stringify([{ field: "name_1", value: term, criteria: "like" }]),
  });
}

export async function createContact(
  tenant: Tenant,
  contact: { name: string; address?: string; postcode?: string; city?: string; email?: string },
): Promise<BexioContact> {
  return bexioFetch(tenant, "/contact", {
    method: "POST",
    body: JSON.stringify({
      contact_type_id: 1,
      name_1: contact.name,
      address: contact.address || "",
      postcode: contact.postcode || "",
      city: contact.city || "",
      mail: contact.email || "",
      owner_id: tenant.bexio_user_id,
    }),
  });
}

// ---------- Invoices ----------

export interface BexioInvoice {
  id: number;
  document_nr: string;
  total: string;
  title: string;
}

export async function createInvoice(
  tenant: Tenant,
  params: {
    contactId: number;
    title: string;
    positions: Array<{ description: string; price: number }>;
  },
): Promise<BexioInvoice> {
  const positions = params.positions.map((p) => ({
    type: "KbPositionCustom",
    text: p.description,
    unit_price: p.price.toFixed(2),
    amount: "1",
    account_id: tenant.bexio_account_id,
    tax_id: tenant.bexio_tax_id,
  }));

  return bexioFetch(tenant, "/kb_invoice", {
    method: "POST",
    body: JSON.stringify({
      title: params.title,
      contact_id: params.contactId,
      user_id: tenant.bexio_user_id,
      is_valid_from: todayStr(),
      is_valid_to: futureDate(30),
      mwst_type: 0,
      mwst_is_net: true,
      positions,
    }),
  });
}

export async function issueInvoice(tenant: Tenant, invoiceId: number): Promise<void> {
  await bexioFetch(tenant, `/kb_invoice/${invoiceId}/issue`, { method: "POST" });
}

export async function getInvoicePdf(tenant: Tenant, invoiceId: number): Promise<string> {
  const data = await bexioFetch(tenant, `/kb_invoice/${invoiceId}/pdf`);
  return data.content; // base64
}

// ---------- Helpers ----------

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}
