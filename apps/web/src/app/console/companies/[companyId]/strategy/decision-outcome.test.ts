/*
 * ACBP-FE-013 — interpreting what the two write endpoints answered.
 *
 * `POST /strategy/selection` and `POST /decisions` have the SAME four-arm domain shape, which is why one module
 * serves both. What differs is what a 404 MEANS, and that difference is the reason `verb` exists rather than one
 * shared sentence: on a selection a 404 is about the generation, while on a decision the core comment names
 * THREE causes — "the generation or the selection is absent/invisible, or the selection belongs to a different
 * generation". A single "not found" for both would describe the wrong thing half the time.
 *
 * TWO COLLISIONS ON THE WIRE THAT THE STATUS CODE ALONE CANNOT SPLIT, and each is a test below:
 *   403 → `{error:'forbidden'}` (owner-only refusal) vs `{error:'email_unverified'}` (a verified-email gate).
 *         Rendering both as "you are not allowed" tells a founder to ask for permission they already have.
 *   400 → the DOMAIN's `{error:{category:'validation',…}}` (the decision itself was refused) vs the ROUTE's
 *         generic envelope (the body never reached the domain — that is our bug, not the founder's).
 */
import { describe, expect, it } from 'vitest';
import { networkFailure, outcomeFor } from './decision-outcome';

describe('a request that never reached the server is not a response', () => {
  it('does not claim the server answered', () => {
    // `fetch` rejecting means no HTTP exchange completed. Routing that through `outcomeFor(0, …)` produced
    // "The server answered with status 0" — a statement about a server that said nothing at all.
    const r = networkFailure('selection');
    expect(r.kind).toBe('unreachable');
    expect(r.detail.toLowerCase()).not.toContain('answered');
    expect(r.detail).not.toContain('status 0');
  });

  it('cannot know whether anything was written, and says so', () => {
    // The request may have been received and committed with only the RESPONSE lost. "Nothing was saved"
    // would be a guarantee this screen has no basis for.
    expect(networkFailure('selection').persisted).toBeNull();
    expect(networkFailure('decision').persisted).toBeNull();
  });

  it('tells the founder to reload rather than to re-submit', () => {
    // Re-submitting is the dangerous guess: a selection is immutable and a second one is a second record.
    expect(networkFailure('decision').detail.toLowerCase()).toContain('reload');
  });
});

describe('the success arms', () => {
  it('reads a recorded selection', () => {
    const r = outcomeFor(200, { selection: { selectionId: 'sel-1' } }, null, 'selection');
    expect(r.kind).toBe('recorded');
  });

  it('reads a recorded decision', () => {
    const r = outcomeFor(200, { decision: { decisionId: 'dec-1' } }, null, 'decision');
    expect(r.kind).toBe('recorded');
  });

  it('does NOT report success when a 200 carries no payload at all', () => {
    // A 200 whose body lost its payload is not a recorded decision. Reporting success there would tell a founder
    // their choice is saved when this screen has no evidence of it.
    const r = outcomeFor(200, {}, null, 'selection');
    expect(r.kind).not.toBe('recorded');
  });
});

describe('403 is two different refusals', () => {
  it('an owner-only refusal says the caller lacks the role', () => {
    const r = outcomeFor(403, { error: 'forbidden' }, null, 'selection');
    expect(r.kind).toBe('forbidden');
  });

  it('an unverified email is NOT reported as a permission problem', () => {
    const r = outcomeFor(403, { error: 'email_unverified' }, null, 'selection');
    expect(r.kind).toBe('email_unverified');
    expect(r.detail.toLowerCase()).toContain('verif');
  });

  it('the forbidden copy does not tell a founder which of several causes applied', () => {
    // The platform's denial is deliberately opaque — "not a member" and "not allowed" are the same 403 with no
    // oracle. Copy that named one would be inventing the half the server withheld.
    const r = outcomeFor(403, { error: 'forbidden' }, null, 'selection');
    expect(r.detail.toLowerCase()).not.toContain('not a member');
  });
});

describe('400 is two different failures', () => {
  it('a domain validation refusal says the decision was rejected and nothing was saved', () => {
    const r = outcomeFor(400, { error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'The decision was rejected.', retryable: false } }, null, 'selection');
    expect(r.kind).toBe('invalid');
    expect(r.detail.toLowerCase()).toContain('nothing');
  });

  it('a malformed body is reported as this screen’s fault, not the founder’s', () => {
    // The route refuses an unparseable body BEFORE the domain sees it, with the generic envelope. That is a bug
    // in what this page sent — telling a founder to fix their input would be blaming them for our defect.
    // `genericErrorBody(400)` returns `{error:'bad_request'}` — the REAL body this route sends. An earlier
    // version of this fixture used 'internal_error', a body the 400 path never produces, so the test passed
    // for the right reason by luck: the detection is on the SHAPE of `error` (string vs object), not its value.
    const r = outcomeFor(400, { error: 'bad_request' }, null, 'selection');
    expect(r.kind).toBe('client_defect');
  });

  it('treats a 400 with no recognisable body as the client defect, not as a domain refusal', () => {
    const r = outcomeFor(400, {}, null, 'selection');
    expect(r.kind).toBe('client_defect');
  });
});

describe('404 means different things per verb', () => {
  it('on a selection it is about the generation', () => {
    const r = outcomeFor(404, { error: 'not_found' }, null, 'selection');
    expect(r.kind).toBe('not_found');
    expect(r.detail.toLowerCase()).toContain('generation');
  });

  it('on a decision it names the selection too, because a mismatched pair produces the same 404', () => {
    const r = outcomeFor(404, { error: 'not_found' }, null, 'decision');
    expect(r.kind).toBe('not_found');
    expect(r.detail.toLowerCase()).toContain('selection');
  });
});

describe('rate limiting', () => {
  it('reads the whole-second Retry-After header', () => {
    const r = outcomeFor(429, { error: 'internal_error' }, '30', 'selection');
    expect(r.kind).toBe('rate_limited');
    expect(r.retryAfterSeconds).toBe(30);
  });

  it('says the server gave no wait when the header is absent, rather than inventing one', () => {
    const r = outcomeFor(429, { error: 'internal_error' }, null, 'selection');
    expect(r.kind).toBe('rate_limited');
    expect(r.retryAfterSeconds).toBeNull();
  });

  it('rejects a non-numeric Retry-After instead of coercing it to a number', () => {
    // `Number('')` is 0 and `parseInt('soon')` is NaN. Either one rendered as a countdown would be a wait time
    // the server never stated.
    for (const header of ['', 'soon', 'NaN', '-5', '1.5.2']) {
      expect(outcomeFor(429, {}, header, 'selection').retryAfterSeconds, `header ${JSON.stringify(header)}`).toBeNull();
    }
  });
});

describe('the remaining arms', () => {
  it('401 maps to the unauthenticated kind and says the session is the problem', () => {
    const r = outcomeFor(401, { error: 'unauthorized' }, null, 'selection');
    expect(r.kind).toBe('unauthenticated');
    expect(r.detail.toLowerCase()).toContain('session');
    expect(r.persisted).toBe(false);
  });

  it('503 names a dependency, says retrying is safe, and states nothing was written', () => {
    const r = outcomeFor(503, { error: 'unavailable' }, null, 'selection');
    expect(r.kind).toBe('unavailable');
    expect(r.detail.toLowerCase()).toContain('dependency');
    expect(r.detail.toLowerCase()).toContain('retry');
    expect(r.persisted).toBe(false);
  });

  it('500 echoes no server detail and refuses to claim the write did not happen', () => {
    // `bounded` was the old name and the body checked nothing of the kind. These are the two properties
    // that actually matter: nothing from the server is repeated, and the outcome is honestly unknown.
    const r = outcomeFor(500, { error: 'internal_error', stack: 'at Foo (bar.ts:1)' }, null, 'selection');
    expect(r.kind).toBe('server_error');
    expect(r.detail).not.toContain('bar.ts');
    expect(r.persisted).toBeNull();
  });

  it('an unhandled status is reported as unhandled rather than guessed at', () => {
    const r = outcomeFor(418, { error: 'whatever' }, null, 'selection');
    expect(r.kind).toBe('unexpected');
    expect(r.detail).toContain('418');
  });
});

describe('every refusal states that nothing was persisted', () => {
  it('never leaves a founder unsure whether their choice was saved', () => {
    // Both use cases are deny-by-default with nothing written on any refusal arm — the core types say so in
    // their own comments. A refusal that does not say this leaves the founder to guess, and the safe guess
    // (re-submitting) is the one that risks a duplicate.
    const refusals = [
      outcomeFor(400, { error: { category: 'validation', code: 'V', message: 'm', retryable: false } }, null, 'selection'),
      outcomeFor(403, { error: 'forbidden' }, null, 'selection'),
      outcomeFor(404, { error: 'not_found' }, null, 'selection'),
      outcomeFor(429, {}, null, 'selection'),
      outcomeFor(503, { error: 'unavailable' }, null, 'selection'),
    ];
    for (const r of refusals) {
      expect(r.persisted, `${r.kind} must state nothing was written`).toBe(false);
    }
  });

  it('the success arm is the only one that reports a write', () => {
    expect(outcomeFor(200, { selection: { selectionId: 's' } }, null, 'selection').persisted).toBe(true);
  });

  it('a 500 does NOT claim nothing was written, because it cannot know', () => {
    // An unexpected throw can happen after a commit. Claiming "nothing was saved" there would be a guarantee
    // this screen has no basis for — the one refusal where the honest answer is that the outcome is unknown.
    const r = outcomeFor(500, { error: 'internal_error' }, null, 'selection');
    expect(r.persisted).toBeNull();
  });
});

describe('an `invalid` means a different thing on each endpoint', () => {
  it('on a selection it names the per-mode rules, because that endpoint runs validateStrategyDecision', () => {
    const r = outcomeFor(400, { error: { category: 'validation', code: 'V', message: 'm', retryable: false } }, null, 'selection');
    expect(r.detail.toLowerCase()).toContain('mode');
  });

  it('on a decision it names the RATIONALE, because that is the only path to invalid there', () => {
    // `recordDecision` runs no per-mode validation at all — `normalizeDecisionRationale` returning undefined
    // is its single route to `invalid`. Naming modes and ordinals here sends a founder to re-check a form
    // this endpoint never looked at.
    const r = outcomeFor(400, { error: { category: 'validation', code: 'V', message: 'm', retryable: false } }, null, 'decision');
    expect(r.detail.toLowerCase()).toContain('reason');
    expect(r.detail.toLowerCase()).not.toContain('ordinal');
    expect(r.detail.toLowerCase()).not.toContain('rejection with no reasons');
  });
});

describe('the selection success does not claim to be the decision', () => {
  it('says the hardening step is still owed', () => {
    // Recording a selection is step one of two. Copy that calls it "this decision ... immutable" at the
    // moment a separate hardening step is still required tells the founder they are finished when they are
    // not — and the planning gate reads the decision, not the selection.
    const r = outcomeFor(200, { selection: { selectionId: 's' } }, null, 'selection');
    expect(r.kind).toBe('recorded');
    expect(r.detail.toLowerCase()).toContain('second');
  });

  it('the decision success, by contrast, IS the final step and says so', () => {
    const r = outcomeFor(200, { decision: { decisionId: 'd' } }, null, 'decision');
    expect(r.detail.toLowerCase()).toContain('planning gate');
  });
});