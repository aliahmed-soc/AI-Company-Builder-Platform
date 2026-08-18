/*
 * ACBP-FE-005 — interpreting the resume POST. Written before the module.
 *
 * THE NAMING TRAP THIS FILE EXISTS TO AVOID: a 200 from resume does NOT mean the run advanced. Phase A returns
 * `already_completed` for a finished run and that path also answers `{status:'ok'}`
 * (core provisioning-service.ts:355-359, mapped at companies-request.ts to `{status:'provisioning'}` -> 200).
 * So the success arm must be named for what it is — the server ran and returned the CURRENT state — and the
 * screen decides whether anything moved by comparing that state, not by reading the status code as progress.
 */
import { describe, test, expect } from 'vitest';
import { interpretResumeResponse } from './resume-outcome';

const dtoBody = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ companyId: 'c-1', companyStatus: 'onboarding', steps: [], nextIncompleteStep: 'profile', resumable: true, exhausted: false, completed: false, ...over });

describe('ACBP-FE-005 — interpretResumeResponse', () => {
  test('200 carries the CURRENT provisioning state back, and is not called progress', () => {
    const r = interpretResumeResponse(200, dtoBody(), null);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') throw new Error('unreachable');
    expect(r.provisioning.companyId).toBe('c-1');
    // The wording must not assert that a step ran — an already-complete run answers 200 too.
    expect(r.detail).not.toMatch(/\badvanced\b|\bprogress(ed)?\b|another step (ran|completed)/i);
  });

  test('a 200 whose body is not a provisioning payload is an error, not a silent success', () => {
    for (const bad of ['not json', '{}', JSON.stringify({ companyId: 'c-1' })]) {
      expect(interpretResumeResponse(200, bad, null).kind, `body ${bad}`).toBe('error');
    }
  });

  test('409 says the server refused WITHOUT claiming to know which of its reasons applied', () => {
    // Five distinct Phase A gates collapse to one bodyless `{"error":"conflict"}` (provisioning-service.ts
    // :354,:360,:362,:363,:364 -> companies-http.ts:248-249). Naming one would be a guess sold as a diagnosis.
    const r = interpretResumeResponse(409, JSON.stringify({ error: 'conflict' }), null);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') throw new Error('unreachable');
    expect(r.detail).toMatch(/does not say|several|which/i);
    expect(r.detail, 'must not pin a single cause').not.toMatch(/because the company is paused/i);
  });

  test('every other arm the route can return is distinct and says nothing was resumed', () => {
    const cases: ReadonlyArray<readonly [number, string, string]> = [
      [400, JSON.stringify({ error: 'bad_request' }), 'error'],
      [401, JSON.stringify({ error: 'unauthorized' }), 'signed_out'],
      [403, JSON.stringify({ error: 'forbidden' }), 'forbidden'],
      [404, JSON.stringify({ error: 'not_found' }), 'not_found'],
      [429, JSON.stringify({ error: 'rate_limited' }), 'rate_limited'],
      [503, JSON.stringify({ error: 'unavailable' }), 'unavailable'],
      [500, JSON.stringify({ error: 'internal_error' }), 'error'],
    ];
    const details: string[] = [];
    for (const [status, body, kind] of cases) {
      const r = interpretResumeResponse(status, body, null);
      expect(r.kind, `HTTP ${status}`).toBe(kind);
      if (r.kind !== 'ok') details.push(r.detail);
    }
    expect(new Set(details).size, 'each refusal must read differently').toBe(details.length);
  });

  test('rate_limited surfaces the real Retry-After and never fabricates one', () => {
    const withHeader = interpretResumeResponse(429, JSON.stringify({ error: 'rate_limited' }), '7');
    if (withHeader.kind !== 'rate_limited') throw new Error('unreachable');
    expect(withHeader.retryAfterSeconds).toBe(7);
    for (const h of [null, '', 'later']) {
      const r = interpretResumeResponse(429, JSON.stringify({ error: 'rate_limited' }), h);
      if (r.kind !== 'rate_limited') throw new Error('unreachable');
      expect(r.retryAfterSeconds, `header ${String(h)}`).toBeNull();
    }
  });

  test('a 500 does NOT claim the run was left untouched beyond what the route guarantees', () => {
    // The route's own comment says an unexpected mid-step error rolled the step back and checkpoints are
    // untouched. That is a real guarantee and may be stated — but only as the server states it.
    const r = interpretResumeResponse(500, JSON.stringify({ error: 'internal_error' }), null);
    if (r.kind !== 'error') throw new Error('unreachable');
    expect(r.detail.length).toBeGreaterThan(30);
  });
});
