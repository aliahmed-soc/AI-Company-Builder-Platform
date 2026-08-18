/*
 * ACBP-FE-007 — start, pause and resume share one interpreter because they share one arm set by construction.
 *
 * The pressure point is 409: this surface produces TWO of them with different bodies and different remedies,
 * and a switch on the status number alone would give a founder the wrong diagnosis half the time.
 */
import { describe, expect, it } from 'vitest';
import { interpretSessionResponse } from './session-outcome';

function sessionBody(phase = 'in_progress', state = 'in_progress'): string {
  return JSON.stringify({
    session: { sessionId: 'ses_1', companyId: 'cmp_1', state, phase, startedAt: '2026-08-17T00:00:00.000Z', createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z' },
  });
}

describe('interpretSessionResponse — the 200', () => {
  it('carries the returned session through so the screen renders the server phase, not a guess', () => {
    const out = interpretSessionResponse('pause', 200, sessionBody('awaiting_input', 'waiting_for_user'), null);
    expect(out.kind).toBe('ok');
    expect(out.kind === 'ok' && out.session.phase).toBe('awaiting_input');
  });

  it('treats a 200 whose body is not a session as an error rather than a success', () => {
    const out = interpretSessionResponse('resume', 200, JSON.stringify({ session: { nope: true } }), null);
    expect(out.kind).toBe('error');
  });

  it('makes no claim that a session was newly started, because the boundary drops that flag', () => {
    // Core returns `created: boolean`, and the web boundary discards it — only the answer arm forwards one.
    // So the screen genuinely cannot tell "I just started your interview" from "you already had one open",
    // and must not imply either.
    const out = interpretSessionResponse('start', 200, sessionBody(), null);
    expect(out.detail.toLowerCase()).not.toContain('started a new');
    expect(out.detail.toLowerCase()).not.toContain('created');
  });
});

describe('interpretSessionResponse — the two 409s are different refusals', () => {
  it('reads an illegal transition as its own arm and keeps the state the server named', () => {
    const out = interpretSessionResponse('pause', 409, JSON.stringify({ error: 'invalid_transition', from: 'waiting_for_user' }), null);
    expect(out.kind).toBe('blocked_transition');
    expect(out.kind === 'blocked_transition' && out.from).toBe('waiting_for_user');
  });

  it('puts the server-supplied state into the sentence, since it is the only detail on the refusal', () => {
    const out = interpretSessionResponse('resume', 409, JSON.stringify({ error: 'invalid_transition', from: 'in_progress' }), null);
    expect(out.detail).toContain('in_progress');
  });

  it('reads an inactive company as its own arm, not as a generic conflict', () => {
    const out = interpretSessionResponse('start', 409, JSON.stringify({ error: 'company_not_active' }), null);
    expect(out.kind).toBe('company_not_active');
  });

  it('does NOT collapse the two 409s together', () => {
    const transition = interpretSessionResponse('pause', 409, JSON.stringify({ error: 'invalid_transition', from: 'confirmed' }), null);
    const inactive = interpretSessionResponse('start', 409, JSON.stringify({ error: 'company_not_active' }), null);
    expect(transition.kind).not.toBe(inactive.kind);
  });

  it('falls back honestly on a 409 whose code it does not recognise, rather than picking one', () => {
    const out = interpretSessionResponse('pause', 409, JSON.stringify({ error: 'conflict' }), null);
    expect(out.kind).toBe('conflict');
  });

  it('does not invent a `from` when the server did not send one', () => {
    const out = interpretSessionResponse('pause', 409, JSON.stringify({ error: 'invalid_transition' }), null);
    expect(out.kind).toBe('conflict');
  });
});

describe('interpretSessionResponse — a 404 means different things per action', () => {
  it('reads a 404 on pause as no open interview session, not as a missing company', () => {
    const out = interpretSessionResponse('pause', 404, JSON.stringify({ error: 'not_found' }), null);
    expect(out.kind).toBe('no_session');
    expect(out.detail.toLowerCase()).toContain('interview');
  });

  it('reads a 404 on START as the missing user record, since start has no session to miss', () => {
    // StartInterviewResult is ok | forbidden | company_not_active — there is no domain not_found on start,
    // so a 404 there can only have come from actor resolution.
    const out = interpretSessionResponse('start', 404, JSON.stringify({ error: 'not_found' }), null);
    expect(out.kind).toBe('no_user_record');
  });
});

describe('interpretSessionResponse — the remaining arms', () => {
  it('separates an unverified email from a plain refusal', () => {
    const forbidden = interpretSessionResponse('start', 403, JSON.stringify({ error: 'forbidden' }), null);
    const unverified = interpretSessionResponse('start', 403, JSON.stringify({ error: 'email_unverified' }), null);
    expect(forbidden.kind).toBe('forbidden');
    expect(unverified.kind).toBe('email_unverified');
  });

  it.each([
    [400, 'malformed'],
    [401, 'signed_out'],
    [503, 'unavailable'],
    [500, 'error'],
  ])('maps %i to %s', (status, kind) => {
    const out = interpretSessionResponse('resume', status, JSON.stringify({ error: 'x' }), null);
    expect(out.kind).toBe(kind);
  });

  it('reads a real Retry-After and treats an empty one as absent', () => {
    expect(interpretSessionResponse('pause', 429, '{}', '12')).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 12 });
    expect(interpretSessionResponse('pause', 429, '{}', '')).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: null });
  });

  it('names the action in its copy so a refusal says what did not happen', () => {
    expect(interpretSessionResponse('pause', 503, '{}', null).detail.toLowerCase()).toContain('paused');
    expect(interpretSessionResponse('resume', 503, '{}', null).detail.toLowerCase()).toContain('resumed');
    expect(interpretSessionResponse('start', 503, '{}', null).detail.toLowerCase()).toContain('started');
  });
});
