/*
 * ACBP-FE-005 — the create POST's response, interpreted.
 *
 * Written BEFORE the module, and every case here is a wire shape verified against the route rather than
 * imagined: `apps/web/src/server/companies/companies-http.ts` maps `createCompanyForRequest`'s arms, and
 * `apps/web/src/app/api/companies/route.ts` adds the pre-domain 415/413/400 refusals.
 *
 * THE ARM THAT DOES NOT EXIST IS ASSERTED TOO. `CreateCompanyResult` is exactly `ok | forbidden | validation`
 * (packages/core/src/company/company-service.ts:68-71), so a 409 can never come back from create. A screen
 * that renders a conflict state would be handling a case the server cannot produce — the mirror of the
 * defect ACBP-API-010 removed, where code carried a claim nobody had checked.
 */
import { describe, test, expect } from 'vitest';
import { interpretCreateResponse, type CreateOutcome } from './create-outcome';

const body = (o: unknown): string => JSON.stringify(o);

describe('ACBP-FE-005 — interpretCreateResponse', () => {
  test('201 with an ACTIVE company means provisioning finished inside the POST', () => {
    // The create route blocks on provisioning (company-service.ts:192-211), so this is the common happy path.
    const r = interpretCreateResponse(201, body({ company: { companyId: 'c-1', status: 'active', creationMode: 'own_idea' } }), null);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') throw new Error('unreachable');
    expect(r.companyId).toBe('c-1');
    expect(r.companyStatus).toBe('active');
    expect(r.provisioningFinishedInline).toBe(true);
  });

  test("201 with an ONBOARDING company means provisioning stopped partway and a resume is owed", () => {
    const r = interpretCreateResponse(201, body({ company: { companyId: 'c-2', status: 'onboarding', creationMode: 'existing_business' } }), null);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') throw new Error('unreachable');
    expect(r.companyStatus).toBe('onboarding');
    expect(r.provisioningFinishedInline).toBe(false);
  });

  test('the status word is carried through VERBATIM, never re-spelled', () => {
    // A status the contract does not list today must still round-trip, for the same reason the portfolio
    // card renders the server's word: this screen does not own the lifecycle vocabulary.
    const r = interpretCreateResponse(201, body({ company: { companyId: 'c-3', status: 'some_future_status', creationMode: 'own_idea' } }), null);
    if (r.kind !== 'created') throw new Error('unreachable');
    expect(r.companyStatus).toBe('some_future_status');
    // Unknown is NOT treated as finished — the conservative reading, since only 'active' is known to mean done.
    expect(r.provisioningFinishedInline).toBe(false);
  });

  test('a 201 whose body is unusable is an error, NOT a silent success', () => {
    // Reporting "created" without an id would strand the founder on a screen that cannot poll.
    for (const bad of [body({}), body({ company: {} }), body({ company: { companyId: '' } }), 'not json']) {
      const r = interpretCreateResponse(201, bad, null);
      expect(r.kind, `body ${bad}`).toBe('error');
    }
  });

  test("a 400 validation surfaces the SERVER'S OWN message verbatim, not copy this screen invented", () => {
    // `case 'validation': jsonResponse(400, { error: result.error })` (companies-http.ts:180-181) where
    // `result.error` is a PublicErrorEnvelope OBJECT — {category, code, message, retryable} (errors.ts:71,:147).
    // The server already names which of three things is wrong; replacing that with a generic sentence throws
    // away the most useful thing in the response. These three messages are the real literals from
    // company-service.ts:92/96/102.
    for (const message of ['Unknown company creation mode.', 'A company name is required.', 'The company description is too long.']) {
      const r = interpretCreateResponse(400, body({ error: { category: 'validation', code: 'VALIDATION_FAILED', message, retryable: false } }), null);
      expect(r.kind).toBe('invalid');
      if (r.kind !== 'invalid') throw new Error('unreachable');
      expect(r.serverMessage, 'the server message must be carried through untouched').toBe(message);
      expect(r.code).toBe('VALIDATION_FAILED');
    }
  });

  test('validation short-circuits, so the screen must not imply it reported every problem', () => {
    // validateCreateCompanyInput returns at the FIRST failure (company-service.ts:91->94->98), so one response
    // can only ever carry one message. A screen that says "fix these" would be describing a list it never got.
    const r = interpretCreateResponse(400, body({ error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'A company name is required.', retryable: false } }), null);
    if (r.kind !== 'invalid') throw new Error('unreachable');
    expect(r.detail.toLowerCase()).toContain('first');
  });

  test('a 400 whose error is NOT an envelope object still refuses honestly', () => {
    const r = interpretCreateResponse(400, body({ error: 'bad_request' }), null);
    expect(r.kind).toBe('malformed');
  });

  test('every refusal arm the route can actually return is DISTINCT', () => {
    const cases: ReadonlyArray<readonly [number, string, CreateOutcome['kind']]> = [
      [400, body({ error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'A company name is required.', retryable: false } }), 'invalid'],
      [400, body({ error: 'bad_request' }), 'malformed'],
      [401, body({ error: 'unauthorized' }), 'signed_out'],
      [403, body({ error: 'forbidden' }), 'forbidden'],
      [403, body({ error: 'email_unverified' }), 'email_unverified'],
      [404, body({ error: 'not_found' }), 'no_user_record'],
      [413, body({ error: 'payload_too_large' }), 'too_large'],
      [415, body({ error: 'unsupported_media_type' }), 'malformed_media'],
      [429, body({ error: 'rate_limited' }), 'rate_limited'],
      [503, body({ error: 'unavailable' }), 'unavailable'],
      [500, body({ error: 'internal_error' }), 'error'],
    ];
    for (const [status, b, kind] of cases) {
      expect(interpretCreateResponse(status, b, null).kind, `HTTP ${status} ${b}`).toBe(kind);
    }
  });

  test('the two 403s do not collapse into one another', () => {
    const forbidden = interpretCreateResponse(403, body({ error: 'forbidden' }), null);
    const unverified = interpretCreateResponse(403, body({ error: 'email_unverified' }), null);
    expect(forbidden.kind).not.toBe(unverified.kind);
  });

  test('the forbidden copy does NOT name one cause, because the server does not distinguish them', () => {
    // A plain 403 covers at least three different situations - not the account owner, the platform user
    // record is gone, and a request that failed the same-origin check - and the body carries no
    // discriminator. Naming any single one would be a guess presented to a founder as a diagnosis.
    const r = interpretCreateResponse(403, body({ error: 'forbidden' }), null);
    if (r.kind !== 'forbidden') throw new Error('unreachable');
    expect(r.detail).toMatch(/does not say|identical|which/i);
    expect(r.detail, 'must not assert deletion as THE cause').not.toMatch(/^The user record .* has been deleted/);
  });

  test('the too-large copy does not blame the founder for a limit this form cannot reach', () => {
    // The body cap is 16 KiB (companies-http.ts:10); a 200-char name plus a 2000-char description cannot
    // approach it. Telling someone to shorten their description would be advice that cannot help.
    const r = interpretCreateResponse(413, body({ error: 'payload_too_large' }), null);
    if (r.kind !== 'too_large') throw new Error('unreachable');
    expect(r.detail).not.toMatch(/shorten/i);
    expect(r.detail).toMatch(/this screen|this page/i);
  });

  test('rate_limited surfaces the ACTUAL Retry-After, and never fabricates one', () => {
    const withHeader = interpretCreateResponse(429, body({ error: 'rate_limited' }), '42');
    expect(withHeader.kind).toBe('rate_limited');
    if (withHeader.kind !== 'rate_limited') throw new Error('unreachable');
    expect(withHeader.retryAfterSeconds).toBe(42);

    // An absent or unparseable header must be null — a fabricated 0 would tell the founder to retry at once.
    for (const h of [null, '', 'soon', '-1']) {
      const r = interpretCreateResponse(429, body({ error: 'rate_limited' }), h);
      if (r.kind !== 'rate_limited') throw new Error('unreachable');
      expect(r.retryAfterSeconds, `header ${String(h)}`).toBeNull();
    }
  });

  test('an unhandled status is reported as unexpected, carrying the status it saw', () => {
    const r = interpretCreateResponse(418, body({ error: 'teapot' }), null);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') throw new Error('unreachable');
    expect(r.detail).toContain('418');
  });

  test('a 409 is handled as unexpected rather than as a real conflict state', () => {
    // create cannot return 409 (CreateCompanyResult is ok|forbidden|validation). If one ever arrives, the
    // honest response is "this should not happen", not a fabricated conflict screen.
    const r = interpretCreateResponse(409, body({ error: 'conflict' }), null);
    expect(r.kind).toBe('error');
  });

  test('every outcome carries user-facing words, and no two kinds share a message', () => {
    const outcomes: CreateOutcome[] = [
      interpretCreateResponse(400, body({ error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'A company name is required.', retryable: false } }), null),
      interpretCreateResponse(400, body({ error: 'bad_request' }), null),
      interpretCreateResponse(415, body({ error: 'unsupported_media_type' }), null),
      interpretCreateResponse(401, body({ error: 'unauthorized' }), null),
      interpretCreateResponse(403, body({ error: 'forbidden' }), null),
      interpretCreateResponse(403, body({ error: 'email_unverified' }), null),
      interpretCreateResponse(404, body({ error: 'not_found' }), null),
      interpretCreateResponse(413, body({ error: 'payload_too_large' }), null),
      interpretCreateResponse(429, body({ error: 'rate_limited' }), '5'),
      interpretCreateResponse(503, body({ error: 'unavailable' }), null),
      interpretCreateResponse(500, body({ error: 'internal_error' }), null),
    ];
    const messages = outcomes.map((o) => (o.kind === 'created' ? '' : o.detail));
    for (const m of messages) expect(m.length).toBeGreaterThan(20);
    expect(new Set(messages).size, 'each refusal must say something different').toBe(messages.length);
  });
});
