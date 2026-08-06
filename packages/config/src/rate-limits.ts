// @acbp/config — API request-limit values (ACBP-P7-013; CDR-081; CDR-008 §8; NFR-010).
//
// ⚠️ THESE VALUES ARE INTERIM AND CARRY A MANDATORY REVISIT — the same standing as the cost caps beside them.
//
// They are CDR-008 §8's FIRST layer, verbatim: *"Technical request limits: per-session API ceiling 60 req/min
// sustained, burst 120; per-account 300 req/min."* Authorized by the product owner on 2026-07-18 as pre-alpha
// calibration; CDR-008 §21 binds a **mandatory revisit at the first alpha telemetry review**, and **AOQ-14
// (final rate limits) remains OPEN** — it needs alpha telemetry that no deployment exists to produce.
//
// CDR-008 §20 named its consumer as ACBP-P6-010. P6-010 implemented the SIXTH layer (hard cost caps) and left
// this one; the figures were accepted and unimplemented for nineteen days. ACBP-P7-013 implements them and
// invents nothing — the charter's "never silently invent a requirement" is the whole reason this file is three
// numbers copied from a decision record rather than a judgement about what a sensible limit would be.
//
// The revisit trigger is named at the definition rather than only in the CDR, for the reason CDR-075 §4-G4.2
// gives: a number whose provisional status lives three documents away is read as settled by whoever finds it.
//
// NO ENVIRONMENT OVERRIDE IS PROVIDED, and that is deliberate rather than an omission. `usage-caps.ts` parses
// env because an operator tuning a spend ceiling mid-incident is a real scenario; there is no deployment
// configuration in this repository at all (CDR-081 §1.4), so an override here would be a knob nothing can turn,
// and a knob nothing can turn reads as tunability that does not exist.

/** CDR-008 §8, as per-minute request figures. Reduced to buckets by `rateLimitRule` in `@acbp/contracts`. */
export const REQUEST_LIMIT_DEFAULTS = {
  /** Per verified session: 60 req/min sustained (CDR-008 §8, interim). */
  sessionPerMinute: 60,
  /** Per verified session: burst 120 (CDR-008 §8, interim). The bucket capacity. */
  sessionBurst: 120,
  /**
   * Per account: 300 req/min (CDR-008 §8, interim).
   *
   * §8 states NO separate account burst, so none is set here and the capacity equals the rate. Inventing one
   * would widen a ruled limit under cover of symmetry with the session rule above.
   */
  accountPerMinute: 300,
} as const;

export type RequestLimitDefaults = typeof REQUEST_LIMIT_DEFAULTS;
