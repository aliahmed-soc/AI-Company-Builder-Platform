// ACBP-P7-013 — the token-bucket specification (CDR-081 §3.2).
//
// THIS FILE IS THE SPECIFICATION, not merely a test of it. `consumeTokens` is pure and the production consume is
// a single SQL statement (CDR-081 §3.2, for atomicity); the real-PostgreSQL differential suite replays this same
// table of cases through the database and asserts the two agree. So a case added here is a case the SQL must also
// satisfy, and a divergence is a red test rather than a silent drift between two implementations of one rule.
import { describe, expect, it } from 'vitest';
import { consumeTokens, rateLimitRule, MILLI, type RateLimitRule } from './rate-limit.js';

/** 60/min sustained, burst 120 — CDR-008 §8's per-session ceiling, the shape every case below uses. */
const SESSION: RateLimitRule = rateLimitRule({ perMinute: 60, burst: 120 });

describe('rateLimitRule', () => {
  it('derives capacity from the burst and the refill rate from the sustained figure', () => {
    // 120 tokens of capacity; 60 per minute = 1 per second, expressed in milli-tokens.
    expect(SESSION.capacityMilli).toBe(120 * MILLI);
    expect(SESSION.refillMilliPerSecond).toBe(MILLI);
  });

  it('defaults the burst to the sustained rate when none is specified (the account rule has no separate burst)', () => {
    // CDR-008 §8 states no account burst; inventing one would widen a ruled limit.
    expect(rateLimitRule({ perMinute: 300 }).capacityMilli).toBe(300 * MILLI);
  });

  it('refuses a rule that cannot refuse anything', () => {
    expect(() => rateLimitRule({ perMinute: 0 })).toThrow(TypeError);
    expect(() => rateLimitRule({ perMinute: -1 })).toThrow(TypeError);
  });

  it('refuses a burst smaller than one request, which would deny every call', () => {
    // A capacity under one token can never satisfy a cost of one — the bucket would be a permanent outage.
    expect(() => rateLimitRule({ perMinute: 60, burst: 0 })).toThrow(TypeError);
  });
});

describe('consumeTokens — a fresh key', () => {
  it('admits the first request and leaves the burst minus one', () => {
    const d = consumeTokens(SESSION, null, 1_000);
    expect(d.allowed).toBe(true);
    expect(d.remainingMilli).toBe(119 * MILLI);
  });

  it('starts full, so the whole burst is available immediately', () => {
    let state = null as { milli: number; atMs: number } | null;
    let admitted = 0;
    for (let i = 0; i < 120; i += 1) {
      const d = consumeTokens(SESSION, state, 1_000); // same instant: no refill
      if (d.allowed) admitted += 1;
      state = { milli: d.remainingMilli, atMs: 1_000 };
    }
    expect(admitted).toBe(120);
  });
});

describe('consumeTokens — refusal', () => {
  it('refuses when the bucket is empty and does NOT go negative', () => {
    const d = consumeTokens(SESSION, { milli: 0, atMs: 1_000 }, 1_000);
    expect(d.allowed).toBe(false);
    expect(d.remainingMilli).toBe(0);
  });

  it('refuses a partial token — 0.5 of a token is not a request', () => {
    const d = consumeTokens(SESSION, { milli: MILLI / 2, atMs: 1_000 }, 1_000);
    expect(d.allowed).toBe(false);
    // The balance is PRESERVED on refusal, not spent. A refused request that still costs a token would let a
    // throttled client hold its own bucket empty forever.
    expect(d.remainingMilli).toBe(MILLI / 2);
  });

  it('reports when to retry, rounded UP so the advice is never early', () => {
    // Half a token present, refilling at 1 token/sec → 0.5s to reach one token → advertise 1s.
    const d = consumeTokens(SESSION, { milli: MILLI / 2, atMs: 1_000 }, 1_000);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBe(1);
  });

  it('advertises at least one second, never zero', () => {
    // A `Retry-After: 0` invites an immediate retry that is certain to be refused again.
    const d = consumeTokens(SESSION, { milli: MILLI - 1, atMs: 1_000 }, 1_000);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe('consumeTokens — refill', () => {
  it('refills at the sustained rate, not the burst rate', () => {
    // Empty at t=1s; ten seconds later exactly ten tokens are back (60/min = 1/s), minus the one just spent.
    const d = consumeTokens(SESSION, { milli: 0, atMs: 1_000 }, 11_000);
    expect(d.allowed).toBe(true);
    expect(d.remainingMilli).toBe(9 * MILLI);
  });

  it('refills proportionally within a second — the window is rolling, not fixed', () => {
    // A fixed window would admit nothing until the tick; 250ms at 1 token/s is a quarter token.
    const d = consumeTokens(SESSION, { milli: 0, atMs: 1_000 }, 1_250);
    expect(d.allowed).toBe(false);
    expect(d.remainingMilli).toBe(MILLI / 4);
  });

  it('never refills above the burst capacity, however long the key was idle', () => {
    // A day of silence must not bank a day of requests.
    const d = consumeTokens(SESSION, { milli: 0, atMs: 1_000 }, 1_000 + 86_400_000);
    expect(d.allowed).toBe(true);
    expect(d.remainingMilli).toBe(119 * MILLI);
  });

  it('sustains exactly the ruled rate once the burst is spent', () => {
    // The property CDR-008 §8 actually states: after the burst, 60/min and no more.
    let state = { milli: 0, atMs: 0 };
    let admitted = 0;
    // One request every 500ms for 60s = 120 attempts against a 60/min refill.
    for (let i = 1; i <= 120; i += 1) {
      const at = i * 500;
      const d = consumeTokens(SESSION, state, at);
      if (d.allowed) admitted += 1;
      state = { milli: d.remainingMilli, atMs: at };
    }
    expect(admitted).toBe(60);
  });
});

describe('consumeTokens — clock defences', () => {
  it('treats a backwards clock as no elapsed time rather than as negative refill', () => {
    // NTP correction or a replica with a lagging clock must not DRAIN a bucket.
    const d = consumeTokens(SESSION, { milli: 10 * MILLI, atMs: 5_000 }, 1_000);
    expect(d.allowed).toBe(true);
    expect(d.remainingMilli).toBe(9 * MILLI);
  });

  it('is total over absurd stored balances — a corrupt row cannot exceed the ceiling', () => {
    const d = consumeTokens(SESSION, { milli: Number.MAX_SAFE_INTEGER, atMs: 1_000 }, 1_000);
    expect(d.allowed).toBe(true);
    expect(d.remainingMilli).toBe(119 * MILLI);
  });

  it('treats a negative stored balance as empty rather than as credit', () => {
    const d = consumeTokens(SESSION, { milli: -50 * MILLI, atMs: 1_000 }, 1_000);
    expect(d.allowed).toBe(false);
    expect(d.remainingMilli).toBe(0);
  });
});
