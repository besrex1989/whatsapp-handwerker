// Tests für oauth-state.ts. Ausführen mit:
//   node --test supabase/functions/_shared/oauth-state.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { signState, STATE_TTL_SECONDS, verifyState } from "./oauth-state.ts";

const TENANT = "3f2b8c1e-0d4a-4e6b-9c7f-1a2b3c4d5e6f";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECRET = "test-secret";
const NOW = 1_800_000_000_000;

test("gültiger state wird akzeptiert", async () => {
  const s = await signState(TENANT, SECRET, NOW);
  assert.deepEqual(await verifyState(s, SECRET, NOW + 60_000), { ok: true, tenantId: TENANT });
});

test("blanke Tenant-ID (altes Format) wird abgelehnt", async () => {
  assert.deepEqual(await verifyState(TENANT, SECRET, NOW), { ok: false, reason: "malformed" });
});

test("leerer / kaputter state wird abgelehnt", async () => {
  for (const s of ["", "a.b.c", `${TENANT}.123`, `${TENANT}.abc.xyz`, `${TENANT}.123.!!!`, `x.${TENANT}.1.a`]) {
    assert.equal((await verifyState(s, SECRET, NOW)).ok, false, s);
  }
});

test("ausgetauschte Tenant-ID wird abgelehnt", async () => {
  const s = await signState(TENANT, SECRET, NOW);
  const forged = [OTHER, ...s.split(".").slice(1)].join(".");
  assert.deepEqual(await verifyState(forged, SECRET, NOW), { ok: false, reason: "bad_signature" });
});

test("verlängertes Ablaufdatum wird abgelehnt", async () => {
  const [t, exp, sig] = (await signState(TENANT, SECRET, NOW)).split(".");
  const forged = `${t}.${Number(exp) + 3600}.${sig}`;
  assert.deepEqual(await verifyState(forged, SECRET, NOW), { ok: false, reason: "bad_signature" });
});

test("veränderte Signatur wird abgelehnt", async () => {
  const s = await signState(TENANT, SECRET, NOW);
  const last = s.slice(-1) === "A" ? "B" : "A";
  assert.equal((await verifyState(s.slice(0, -1) + last, SECRET, NOW)).ok, false);
});

test("anderes Secret wird abgelehnt", async () => {
  const s = await signState(TENANT, "anderes-secret", NOW);
  assert.deepEqual(await verifyState(s, SECRET, NOW), { ok: false, reason: "bad_signature" });
});

test("abgelaufener state wird abgelehnt", async () => {
  const s = await signState(TENANT, SECRET, NOW);
  assert.equal((await verifyState(s, SECRET, NOW + (STATE_TTL_SECONDS - 1) * 1000)).ok, true);
  assert.deepEqual(
    await verifyState(s, SECRET, NOW + STATE_TTL_SECONDS * 1000),
    { ok: false, reason: "expired" },
  );
});

test("signState verlangt eine UUID und ein Secret", async () => {
  await assert.rejects(() => signState("kein-uuid", SECRET, NOW));
  await assert.rejects(() => signState(TENANT, "", NOW));
});
