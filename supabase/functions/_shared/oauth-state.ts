// oauth-state — signierter, kurzlebiger `state`-Parameter für den Bexio-
// OAuth-Flow. Rein (nur WebCrypto), läuft in Deno und Node.
//   node --test supabase/functions/_shared/oauth-state.test.ts
//
// Format: <tenant_id>.<ablauf in unix-sekunden>.<base64url HMAC-SHA256>
//
// Ohne Signatur konnte jeder, der eine Tenant-ID kennt, einen Callback für
// diesen Tenant fälschen. Die Signatur beweist, dass bexio-oauth (POST)
// den Flow für genau diesen Tenant gestartet hat, und zwar vor kurzem.

export const STATE_TTL_SECONDS = 15 * 60;

// Trennt diese Signaturen von anderen Verwendungen desselben Secrets.
const CONTEXT = "whatsbill-bexio-oauth-state-v1";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("OAuth-State-Secret fehlt.");
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// Cast: neuere TS-Versionen unterscheiden Uint8Array<ArrayBufferLike> von
// BufferSource; zur Laufzeit ist es dasselbe.
function payload(tenantId: string, exp: number): BufferSource {
  return new TextEncoder().encode(`${CONTEXT}.${tenantId.toLowerCase()}.${exp}`) as BufferSource;
}

export async function signState(
  tenantId: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<string> {
  if (!isUuid(tenantId)) throw new Error("Ungültige Tenant-ID.");
  const exp = Math.floor(nowMs / 1000) + STATE_TTL_SECONDS;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), payload(tenantId, exp));
  return `${tenantId.toLowerCase()}.${exp}.${toBase64Url(new Uint8Array(sig))}`;
}

export type StateResult =
  | { ok: true; tenantId: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export async function verifyState(
  state: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<StateResult> {
  const parts = String(state || "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [tenantId, expStr, sigStr] = parts;
  if (!isUuid(tenantId) || !/^\d{1,12}$/.test(expStr)) return { ok: false, reason: "malformed" };
  const sig = fromBase64Url(sigStr);
  if (!sig) return { ok: false, reason: "malformed" };

  const exp = Number(expStr);
  // crypto.subtle.verify vergleicht in konstanter Zeit.
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig as BufferSource, payload(tenantId, exp));
  if (!valid) return { ok: false, reason: "bad_signature" };
  if (exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, tenantId: tenantId.toLowerCase() };
}
