// subscription — darf dieser Tenant kostenpflichtige Funktionen nutzen?
// Rein (keine Deno-APIs), mit Node-Tests:
//   node --test supabase/functions/_shared/subscription.test.ts
//
// Gleiche Regel wie das Gate im whatsapp-webhook: erlaubt ist ein aktives
// Abo (plan = active / active_monthly / active_yearly) oder eine noch
// laufende Testphase (plan = trial und trial_ends_at in der Zukunft).
// Alles andere (past_due, cancelled, pending, unbekannt) ist gesperrt.

export type SubscriptionCheck =
  | { ok: true }
  | { ok: false; reason: "trial_expired" | "inactive"; message: string };

export function checkSubscription(
  tenant: { plan?: string | null; trial_ends_at?: string | null },
  nowMs: number = Date.now(),
): SubscriptionCheck {
  const plan = tenant.plan || "trial";
  if (plan === "active" || plan === "active_monthly" || plan === "active_yearly") {
    return { ok: true };
  }
  if (plan === "trial") {
    const end = tenant.trial_ends_at ? new Date(tenant.trial_ends_at).getTime() : 0;
    if (Number.isFinite(end) && end > nowMs) return { ok: true };
    return {
      ok: false,
      reason: "trial_expired",
      message: "Deine Testphase ist abgelaufen. Serienrechnungen gehören zum Abo – bitte schliesse im Dashboard ein Abo ab.",
    };
  }
  return {
    ok: false,
    reason: "inactive",
    message: "Dein Abo ist nicht aktiv. Serienrechnungen gehören zum Abo – bitte prüfe dein Abo im Dashboard.",
  };
}
