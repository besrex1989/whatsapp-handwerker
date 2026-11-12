// Tests für subscription.ts. Ausführen mit:
//   node --test supabase/functions/_shared/subscription.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSubscription } from "./subscription.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");

test("aktive Abos sind erlaubt", () => {
  for (const plan of ["active", "active_monthly", "active_yearly"]) {
    assert.deepEqual(checkSubscription({ plan, trial_ends_at: null }, NOW), { ok: true }, plan);
  }
});

test("laufende Testphase ist erlaubt", () => {
  assert.deepEqual(checkSubscription({ plan: "trial", trial_ends_at: "2026-11-20T00:00:00Z" }, NOW), { ok: true });
});

test("fehlender plan gilt als trial", () => {
  assert.equal(checkSubscription({ trial_ends_at: "2026-11-20T00:00:00Z" }, NOW).ok, true);
  assert.equal(checkSubscription({ plan: null, trial_ends_at: "2026-11-01T00:00:00Z" }, NOW).ok, false);
});

test("abgelaufene Testphase ist gesperrt", () => {
  const r = checkSubscription({ plan: "trial", trial_ends_at: "2026-04-24T00:00:00Z" }, NOW);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "trial_expired");
});

test("trial ohne oder mit kaputtem Enddatum ist gesperrt", () => {
  assert.equal(checkSubscription({ plan: "trial", trial_ends_at: null }, NOW).ok, false);
  assert.equal(checkSubscription({ plan: "trial", trial_ends_at: "kein-datum" }, NOW).ok, false);
});

test("Testphase endet genau jetzt -> gesperrt", () => {
  assert.equal(checkSubscription({ plan: "trial", trial_ends_at: new Date(NOW).toISOString() }, NOW).ok, false);
});

test("past_due, cancelled, pending und Unbekanntes sind gesperrt", () => {
  for (const plan of ["past_due", "cancelled", "pending", "pro", "ACTIVE"]) {
    const r = checkSubscription({ plan, trial_ends_at: "2030-01-01T00:00:00Z" }, NOW);
    assert.equal(r.ok, false, plan);
    assert.equal(!r.ok && r.reason, "inactive", plan);
  }
});
