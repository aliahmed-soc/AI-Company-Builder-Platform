/*
 * ACBP-API-011 — the emergency stop surface (ADMIN-001; CDR-072).
 *
 * ⚠️ WHAT THIS SUITE CAN AND CANNOT PROVE, STATED FIRST SO NOTHING HERE IS READ AS MORE THAN IT IS.
 *
 * THE AUTHORIZATION IS NOT TESTED HERE, BECAUSE IT DOES NOT LIVE HERE. `stop:activate` is checked inside
 * `activateStop` in `@acbp/core` (stop-service.ts), against the company role resolved from an active membership,
 * and the binding evidence is `stop-service.integration.test.ts` → "a VIEWER may not activate, clear or review —
 * and no row is written by the attempt", which runs against real PostgreSQL. A unit test at this layer that
 * asserted "a viewer gets 403" would be asserting its own stub.
 *
 * WHAT THIS LAYER CAN BE HELD TO IS THE OPPOSITE PROPERTY: that it adds NO second authority, forwards the domain's
 * refusal unchanged, and cannot turn a refusal into an accidental success. That is what the rows below check.
 */
import { describe, expect, it, vi } from 'vitest';
import { STOP_REFUSAL_REASONS, type StopRefusalReason } from '@acbp/core';
import { toCompaniesResponse, parseActivateStopBody } from './companies-http.js';
import { getStopStateForRequest, activateStopForRequest, type CompaniesRequestResult } from './companies-request.js';

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('a refusal never becomes a success', () => {
  /*
   * THE ROW THAT MATTERS MOST ON THIS SURFACE. `already_active` means the halt you asked for IS ALREADY IN FORCE,
   * and it is the one refusal an operator could reasonably misread as a failure to stop. It must not be 2xx.
   */
  it('already_active is a 409, never a 2xx', async () => {
    const res = toCompaniesResponse({ status: 'stop_refused', reason: 'already_active' });
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: 'stop_refused', reason: 'already_active' });
  });

  it('NO refusal reason maps to a 2xx status', () => {
    // Driven from the CONTRACT'S OWN ARRAY, never a restated list — a reason added to core joins this test
    // automatically instead of slipping past a hand-copied set.
    for (const reason of STOP_REFUSAL_REASONS) {
      const status = toCompaniesResponse({ status: 'stop_refused', reason }).status;
      expect(status, reason).toBeGreaterThanOrEqual(400);
    }
  });

  it('every reason keeps its own code, so a caller can tell the eleven apart', async () => {
    const seen = new Map<StopRefusalReason, unknown>();
    for (const reason of STOP_REFUSAL_REASONS) seen.set(reason, (await bodyOf(toCompaniesResponse({ status: 'stop_refused', reason })))['reason']);
    // The reason SURVIVES to the wire. Flattening these to a bare 400 would undo the closed union's whole purpose.
    expect([...seen.entries()].every(([reason, wire]) => wire === reason)).toBe(true);
  });

  it('the three kinds of no get the three right statuses', () => {
    const status = (r: StopRefusalReason): number => toCompaniesResponse({ status: 'stop_refused', reason: r }).status;
    // Malformed request — retrying unchanged cannot succeed.
    expect(status('not_a_scope')).toBe(400);
    expect(status('scope_not_enforceable')).toBe(400);
    expect(status('target_required')).toBe(400);
    expect(status('target_not_allowed')).toBe(400);
    expect(status('target_must_be_own_company')).toBe(400);
    // Named thing absent HERE — under RLS "not yours" and "not there" are genuinely one answer.
    expect(status('target_not_found')).toBe(404);
    // Refused by current state.
    expect(status('already_active')).toBe(409);
  });
});

describe('the activation answer states what actually happened', () => {
  const ACTIVATED = {
    status: 'stop_activated',
    stop: { stopId: 's_1', scope: 'account_wide', heldCount: 9, pausedCount: 2, stopRequestedCount: 1 },
  } as const satisfies CompaniesRequestResult;

  it('all THREE counts travel, because they mean different things', async () => {
    // heldCount = interrupted, pausedCount = actually transitioned running→paused, stopRequestedCount = live runs
    // asked to halt. They legitimately differ; publishing one would let a surface report a larger halt than
    // happened, which CDR-072 §1-G2 names as a defect in its own right rather than a rounding.
    expect(await bodyOf(toCompaniesResponse(ACTIVATED))).toEqual({ stopId: 's_1', scope: 'account_wide', heldCount: 9, pausedCount: 2, stopRequestedCount: 1 });
  });

  it('the body is an ALLOWLIST — a field added to core does not publish itself', async () => {
    const withExtra = { ...ACTIVATED, stop: { ...ACTIVATED.stop, secretInternalField: 'leak' } } as unknown as CompaniesRequestResult;
    expect(Object.keys(await bodyOf(toCompaniesResponse(withExtra))).sort()).toEqual(['heldCount', 'pausedCount', 'scope', 'stopId', 'stopRequestedCount']);
  });
});

describe('the state read carries its own honesty signals', () => {
  const CAVEAT = 'The held-work queue records what this stop INTERRUPTED, not everything it covers.';
  const STATE = {
    status: 'stop_state',
    stopState: {
      activeStops: [{ stopId: 's_1', scope: 'account_wide', targetId: null, activatedAt: '2026-08-19T00:00:00.000Z', heldQueueCompleteness: 'grows_lazily' }],
      scopes: [
        { scope: 'account_wide', enforceable: true },
        { scope: 'capability', enforceable: false, unavailableReason: 'Not enforceable in this release: the tool registry carries no identity for it, so activation is refused.' },
      ],
      heldQueueCaveat: CAVEAT,
    },
  } as unknown as CompaniesRequestResult;

  it('heldQueueCaveat reaches the wire', async () => {
    // Core's own comment says this field is "SUPPLIED, NOT ENFORCED — a surface can ignore this field entirely and
    // nothing in the codebase will notice". This route is the first surface that COULD ignore it. An operator
    // reading a queue that looks exhaustive and is not is CDR-072 §0 arriving through a read model.
    const state = (await bodyOf(toCompaniesResponse(STATE)))['stopState'] as Record<string, unknown>;
    expect(state['heldQueueCaveat']).toBe(CAVEAT);
  });

  it('the per-stop completeness marker reaches the wire too', async () => {
    const state = (await bodyOf(toCompaniesResponse(STATE)))['stopState'] as { activeStops: { heldQueueCompleteness: string }[] };
    // `grows_lazily` is the statement that the count is a FLOOR. Dropping it would leave a client with a number
    // and no way to know it is not a total.
    expect(state.activeStops[0]?.heldQueueCompleteness).toBe('grows_lazily');
  });

  it('an UNENFORCEABLE scope keeps its reason, so a surface cannot present seven working scopes', async () => {
    const state = (await bodyOf(toCompaniesResponse(STATE)))['stopState'] as { scopes: { scope: string; enforceable: boolean; unavailableReason?: string }[] };
    const capability = state.scopes.find((s) => s.scope === 'capability');
    expect(capability?.enforceable).toBe(false);
    expect(capability?.unavailableReason).toContain('refused');
  });
});

/*
 * ── THE REQUEST LAYER ITSELF ────────────────────────────────────────────────────────────────────────────────────
 *
 * The block above exercises `toCompaniesResponse` against literals this file supplies, which pins the HTTP mapping
 * and NOTHING about the code that builds those literals. These rows drive `getStopStateForRequest` and
 * `activateStopForRequest` with a stubbed core, so the mapper under test is the one this ticket wrote.
 */
const CORE_CAVEAT =
  'The held-work queue records what this stop INTERRUPTED, not everything it covers. A covered task that never ' +
  'attempts a tool call is never held and never paused.';

function stopDeps(stub: Partial<Record<'activateStop' | 'readStopState', (params: unknown) => Promise<unknown>>>): Parameters<typeof getStopStateForRequest>[1] {
  // CAST, and the guarantee it bypasses lives elsewhere on purpose: `companies-request.test.ts` holds the FULL
  // fake whose required members make an omission a compile error. Rebuilding all 40+ methods here would duplicate
  // that guarantee rather than add one, and the two methods under test are real.
  const runtime = {
    checkRequestLimit: () => Promise.resolve({ kind: 'allowed' } as const),
    resolveInternalUser: () => Promise.resolve({ status: 'active', userId: 'usr_internal' }),
    ensurePersonalAccount: () => Promise.resolve({ accountId: 'acct_session', created: false }),
    activateStop: stub.activateStop ?? ((): Promise<unknown> => Promise.reject(new Error('activateStop not stubbed'))),
    readStopState: stub.readStopState ?? ((): Promise<unknown> => Promise.reject(new Error('readStopState not stubbed'))),
  } as never;
  return {
    runtime,
    identity: {
      getUserId: () => Promise.resolve('clerk_1'),
      getSessionId: () => Promise.resolve('sess_test'),
      checkSessionLimit: () => Promise.resolve({ kind: 'allowed' } as const),
      getBackendUser: () =>
        Promise.resolve({
          id: 'clerk_1',
          primaryEmailAddressId: 'e1',
          emailAddresses: [{ id: 'e1', emailAddress: 'me@example.com', verification: { status: 'verified' } }],
          firstName: null,
          lastName: null,
        }),
    } as never,
  };
}

describe('the request layer forwards the domain, and adds no authority of its own', () => {
  it("core's heldQueueCaveat survives the mapper — this layer does not summarise it away", async () => {
    // Core: "IT IS SUPPLIED, NOT ENFORCED. A surface can ignore this field entirely and nothing in the codebase
    // will notice." This row is that noticing.
    const r = await getStopStateForRequest(
      'co_1',
      stopDeps({
        readStopState: () =>
          Promise.resolve({ status: 'ok', activeStops: [], scopes: [{ scope: 'account_wide', enforceable: true }], heldQueueCaveat: CORE_CAVEAT }),
      }),
    );
    expect(r.status).toBe('stop_state');
    if (r.status === 'stop_state') expect(r.stopState.heldQueueCaveat).toBe(CORE_CAVEAT);
  });

  it('activatedAt becomes an ISO string, and an unreadable one does NOT throw the whole read', async () => {
    const r = await getStopStateForRequest(
      'co_1',
      stopDeps({
        readStopState: () =>
          Promise.resolve({
            status: 'ok',
            scopes: [],
            heldQueueCaveat: CORE_CAVEAT,
            activeStops: [
              { stopId: 's_1', scope: 'account_wide', targetId: null, activatedAt: new Date('2026-08-19T00:00:00Z'), heldQueueCompleteness: 'grows_lazily' },
              { stopId: 's_2', scope: 'external_actions_only', targetId: null, activatedAt: 'not-a-date', heldQueueCompleteness: 'never_holds' },
            ],
          }),
      }),
    );
    // ONE unreadable timestamp must not turn the halt screen into a 500 — the screen that cannot render the
    // platform's own stops is the worst possible 500 on this surface.
    expect(r.status).toBe('stop_state');
    if (r.status === 'stop_state') {
      expect(r.stopState.activeStops[0]?.activatedAt).toBe('2026-08-19T00:00:00.000Z');
      expect(r.stopState.activeStops[1]?.activatedAt).toBe('not-a-date');
    }
  });

  it("a viewer's refusal from core is forwarded UNCHANGED — this layer never re-decides", async () => {
    // The authorization itself is core's (`stop:activate`, owner-only) and is proven against real PostgreSQL by
    // stop-service.integration.test.ts. What is proven HERE is the property this layer owns: a `forbidden` is
    // passed through as `forbidden`, never softened, never re-derived from a role read a second time.
    const r = await activateStopForRequest('co_1', { scope: 'account_wide' }, stopDeps({ activateStop: () => Promise.resolve({ status: 'forbidden' }) }));
    expect(r).toEqual({ status: 'forbidden' });
    expect(toCompaniesResponse(r).status).toBe(403);
  });

  it('the raw scope reaches core untouched, including one core will refuse by name', async () => {
    const seen = vi.fn();
    await activateStopForRequest(
      'co_1',
      { scope: 'capability', targetId: 'anything', reason: 'because' },
      stopDeps({
        activateStop: (params) => {
          seen(params);
          return Promise.resolve({ status: 'refused', reason: 'scope_not_enforceable' });
        },
      }),
    );
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ scope: 'capability', targetId: 'anything', reason: 'because', companyId: 'co_1', userId: 'usr_internal' }));
  });

  it('a NON-STRING targetId becomes null rather than "[object Object]"', async () => {
    const seen = vi.fn();
    await activateStopForRequest(
      'co_1',
      { scope: 'task', targetId: { evil: true } },
      stopDeps({
        activateStop: (params) => {
          seen(params);
          return Promise.resolve({ status: 'refused', reason: 'target_required' });
        },
      }),
    );
    // Coercing would produce a target core refuses as `target_not_found` — which reads as "your task is gone"
    // instead of "you sent the wrong kind of thing".
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ targetId: null }));
  });
});

describe('the body parser forwards rather than judges', () => {
  function jsonRequest(body: string): Request {
    return new Request('https://example.test/api/companies/co_1/stops', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  }

  it('an UNENFORCEABLE scope is forwarded, not pre-filtered into a generic 400', async () => {
    // THE POINT: `activateStop` refuses `capability` BY NAME (`scope_not_enforceable`) so a human learns the scope
    // halts nothing. A boundary that rejected it here would replace that with an anonymous 400 and the operator
    // would never find out why — refusing by name only works if the name arrives.
    const parsed = await parseActivateStopBody(jsonRequest(JSON.stringify({ scope: 'capability' })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.input.scope).toBe('capability');
  });

  it('a nonsense scope is forwarded too — refusing it is the domain\'s job', async () => {
    const parsed = await parseActivateStopBody(jsonRequest(JSON.stringify({ scope: 42 })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.input.scope).toBe(42);
  });

  it('a non-JSON content type is refused with 415 before a byte is read', async () => {
    const req = new Request('https://example.test/x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'scope=account_wide' });
    expect(await parseActivateStopBody(req)).toEqual({ ok: false, status: 415 });
  });

  it('an oversize body is refused with 413 — the emergency control is not an unbounded parser', async () => {
    // No global body cap exists in apps/web, so without the shared bounded reader an UNAUTHENTICATED caller could
    // make the server buffer an arbitrary payload in front of the one route that halts the platform.
    const req = new Request('https://example.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'x'.repeat(20 * 1024) }) });
    expect(await parseActivateStopBody(req)).toEqual({ ok: false, status: 413 });
  });

  it('malformed JSON is refused with 400 and NOTHING of the body is echoed', async () => {
    const res = await parseActivateStopBody(jsonRequest('{"scope":'));
    expect(res).toEqual({ ok: false, status: 400 });
  });
});
