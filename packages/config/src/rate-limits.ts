// @acbp/config — API request-limit values (ACBP-P7-013; CDR-082; CDR-008 §8; NFR-010).
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
// configuration in this repository at all (CDR-082 §1.4), so an override here would be a knob nothing can turn,
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
  /**
   * ⚠️ PROVISIONAL — Per company on the METERED GENERATE routes: 5 req/min (CDR-091 §2.3; CDR-092 §2.1).
   *
   * **This number has never been calibrated against anything.** It is one of three places the provisional status
   * is recorded (the others: CDR-092 §2.1, and a PROJECT-STATE entry); a session that changes it is expected to
   * clear all three in the same commit. See also the 60s/90s timeouts, unmeasured for the same reason — no live
   * model call has ever completed from this repository.
   *
   * WHY IT IS TWO ORDERS OF MAGNITUDE BELOW `accountPerMinute`, AND WHY THAT IS A SHAPE NOT A MEASUREMENT: every
   * request on these four routes causes a paid provider call. The read-sized ceilings above bound request
   * frequency against a database; applying anything near 300 to a paid call would be a spend hazard wearing a
   * rate limit's clothing. CDR-090 §3.3 flagged exactly that trap — "the guard passes either way, which is the
   * trap: coverage is not calibration." Single digits is the deliberately conservative side of an unknown; what
   * nobody yet knows is how often a founder legitimately wants to regenerate, or what one generation costs.
   *
   * NOT THE SPEND CAP. NFR-015's ceiling bounds MONEY per company per day and month from `usage_events`. This
   * bounds request FREQUENCY. They share no key, window, unit or storage — one request can spend an unbounded
   * amount and a thousand can spend none.
   *
   * No burst: a burst allowance on a paid call is a licence to spend the whole minute's budget at once, which is
   * the opposite of what this ceiling is for. Capacity therefore equals the rate, as with `accountPerMinute`.
   */
  companyPerMinute: 5,
} as const;

export type RequestLimitDefaults = typeof REQUEST_LIMIT_DEFAULTS;
