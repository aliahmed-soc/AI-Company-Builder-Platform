// ACBP-API-008 / CDR-092 §15 — authorizeMeteredGenerate, the consult core exposes so the request
// layer can debit the company bucket only after owner-only authz.
//
// This file is the half that does not need PostgreSQL: the closed action set. An unknown action must
// be forbidden WITHOUT touching the database, because that is what stops this function being pointed
// at `strategy:read` (owner|viewer) and used to let a viewer spend the company's tokens. The
// membership and role cases live in the sibling integration file.
import { describe, test, expect } from 'vitest';
import { authorizeMeteredGenerate, METERED_GENERATE_ACTIONS, authorizeMeteredParticipate, METERED_PARTICIPATE_ACTIONS } from './authorize-metered-generate.js';
import type { DatabaseClient } from '@acbp/database';

describe('authorizeMeteredGenerate — the action set is closed (CDR-092 §15.2)', () => {
  test('a non-generate action is forbidden and never uses the client', async () => {
    // A client that throws if anything touches it. If the action guard is removed, this test goes
    // red on the throw rather than silently becoming an authz oracle for `strategy:read`.
    const client = new Proxy({} as DatabaseClient, {
      get() {
        throw new Error('the database was reached for an action this function must not answer');
      },
    });
    await expect(
      authorizeMeteredGenerate(client, {
        userId: 'u',
        accountId: 'a',
        companyId: 'c',
        action: 'strategy:read' as 'strategy:generate',
      }),
    ).resolves.toBe('forbidden');
  });

  test('the closed set is exactly the four owner-only generate actions', () => {
    expect([...METERED_GENERATE_ACTIONS].sort()).toEqual(
      ['roadmap:generate', 'strategy:generate', 'strategy:recommend', 'task:generate'].sort(),
    );
  });
});

/*
 * ACBP-API-013 — the MEMBER-level sibling. An adversarial review found it had NO test exercising the real
 * function: every reference to it was a stub, so replacing its body with `return 'allowed';` left the whole suite
 * green while an authenticated non-member could pass the gate and debit another company's paid-call bucket. That
 * is the CDR-092 §15 drain with nothing able to catch it.
 */
describe('authorizeMeteredParticipate — the action set is closed too', () => {
  test('a non-participate action is forbidden and never uses the client', async () => {
    // Same Proxy trick as above, and it matters MORE here: this gate admits viewers by design, so if the action
    // guard were removed it would become an authz oracle that lets a viewer spend on the four OWNER-ONLY generate
    // actions — exactly the widening the split was created to avoid.
    const client = new Proxy({} as DatabaseClient, {
      get() {
        throw new Error('the database was reached for an action this function must not answer');
      },
    });
    for (const action of ['strategy:generate', 'roadmap:generate', 'strategy:read'] as const) {
      await expect(
        authorizeMeteredParticipate(client, {
          userId: 'u',
          accountId: 'a',
          companyId: 'c',
          action: action as 'interview:participate',
        }),
      ).resolves.toBe('forbidden');
    }
  });

  test('the closed set is exactly the one member-level participation action', () => {
    expect([...METERED_PARTICIPATE_ACTIONS]).toEqual(['interview:participate']);
  });

  test('the two metered action sets are DISJOINT', () => {
    // The whole point of the split. An overlap would mean one gate could answer for the other's actions, and the
    // owner-only invariant would hold only by luck of which helper a route happened to call.
    const generate = new Set<string>(METERED_GENERATE_ACTIONS);
    for (const action of METERED_PARTICIPATE_ACTIONS) expect(generate.has(action)).toBe(false);
  });
});
