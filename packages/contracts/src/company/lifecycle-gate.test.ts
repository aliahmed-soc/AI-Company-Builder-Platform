// @acbp/contracts — the autonomous-work lifecycle gate (ACBP-P7-002; CDR-079 §3; Gate 14; ACC-004, COMP-006).
//
// THIS IS THE TEST FOR THE THING THAT DID NOT EXIST. Before this ticket, `canPickUpAutonomousWork` was a correct
// predicate with ZERO production callers, a docstring claiming "this pure predicate is the single truth a
// scheduler/worker consults before opening a run", and a green integration test named "pause blocks new
// autonomous-work pickup" that called it directly. Pausing a company was a label, not a control.
import { describe, expect, it } from 'vitest';
import { mayStartAutonomousWork, type LifecycleRow } from './lifecycle-gate.js';

const ACTIVE: LifecycleRow = { status: 'active' };

describe('mayStartAutonomousWork', () => {
  it('allows work ONLY when the company and the account are both active', () => {
    expect(mayStartAutonomousWork(ACTIVE, ACTIVE)).toEqual({ allowed: true });
  });

  it('refuses every non-active company status, including ones the vocabulary has never heard of', () => {
    // CDR-079 §3-G2. The rule is an ALLOWLIST written positively, so a status added by a later migration — or a
    // typo, or a case variant, or `deleted`, which this ticket deliberately does NOT add to the vocabulary — is
    // refused WITHOUT anyone remembering to enumerate it. A denylist leaves the next state silently permitted.
    for (const status of ['draft', 'onboarding', 'paused', 'deactivating', 'deactivated', 'deleted', 'ACTIVE', ' active', 'active ', 'archived', '']) {
      expect(mayStartAutonomousWork({ status }, ACTIVE)).toEqual({ allowed: false, reason: 'company_not_active' });
    }
  });

  it('refuses every non-active ACCOUNT status, whichever value the vocabulary eventually means by it', () => {
    // CDR-079 §9.2 is open: `suspended` and `closed` have no semantic definition anywhere in the repo, and the
    // only canon lifecycle containing the word "deactivated" is the USER's. The gate does not need that answer —
    // an allowlist on 'active' is correct whichever value ends up meaning deactivated. That is why this slice is
    // unblocked by the open question.
    for (const status of ['suspended', 'closed', 'deactivated', 'ACTIVE', 'archived', '']) {
      expect(mayStartAutonomousWork(ACTIVE, { status })).toEqual({ allowed: false, reason: 'account_not_active' });
    }
  });

  it('refuses a status that is not a string at all', () => {
    // The value comes off a database row, so the parameter is `unknown` and not `CompanyStatus`. Typing it as the
    // union would make TypeScript exhaustiveness convince a reviewer that an unrecognised runtime value is
    // impossible — exactly what a widened CHECK, a later migration, or a corrupt row violates.
    for (const status of [undefined, null, 42, {}, [], true, Symbol('active')] as unknown[]) {
      expect(mayStartAutonomousWork({ status }, ACTIVE)).toEqual({ allowed: false, reason: 'company_not_active' });
    }
  });

  it('treats an ABSENT row as unreadable, and refuses', () => {
    // CDR-079 §3-G5. A row that is not there is not an answer. The three in-repo precedents agree — the stop
    // engine's "'no stop is recorded' is a complete answer; 'I could not check' is not", the usage caps' refusal
    // to report a partial total, and `interview-session.ts:79`, where a missing company already refuses.
    expect(mayStartAutonomousWork(undefined, ACTIVE)).toEqual({ allowed: false, reason: 'company_unreadable' });
    expect(mayStartAutonomousWork(ACTIVE, undefined)).toEqual({ allowed: false, reason: 'account_unreadable' });
  });

  it('names the ACCOUNT when both levels are non-active, because that is the cause to fix first', () => {
    // CDR-079 §3-G4. A deactivated account refuses at every one of its companies; reporting `company_not_active`
    // would send an operator to fix the wrong thing. Same reasoning as CDR-075's `limit_scope`.
    expect(mayStartAutonomousWork({ status: 'paused' }, { status: 'suspended' })).toEqual({ allowed: false, reason: 'account_not_active' });
    expect(mayStartAutonomousWork(undefined, { status: 'suspended' })).toEqual({ allowed: false, reason: 'account_not_active' });
    expect(mayStartAutonomousWork(undefined, undefined)).toEqual({ allowed: false, reason: 'account_unreadable' });
  });

  it('is TOTAL — every input pair returns a decision, and none of them throws', () => {
    const values: unknown[] = [undefined, null, 'active', 'paused', 42, {}, []];
    for (const c of values) {
      for (const a of values) {
        const company = c === undefined ? undefined : ({ status: c } as LifecycleRow);
        const account = a === undefined ? undefined : ({ status: a } as LifecycleRow);
        expect(() => mayStartAutonomousWork(company, account)).not.toThrow();
      }
    }
  });

  it('ignores every other column on the row', () => {
    // The gate reads exactly one field. A row carrying an `id`, a name, or anything else must not change the
    // answer — the decision is the status and nothing else.
    const decorated = { status: 'active', id: 'co-1', name: 'Alpha One', deleted_at: null } as unknown as LifecycleRow;
    expect(mayStartAutonomousWork(decorated, decorated)).toEqual({ allowed: true });
  });

  it('has NO input that yields `allowed: true` with anything other than the two exact strings', () => {
    // The property the allowlist exists to guarantee, asserted as a property rather than by example: across a
    // broad sweep of plausible statuses, exactly one pair is permitted.
    const candidates = ['active', 'ACTIVE', 'Active', ' active', 'active ', 'paused', 'draft', 'onboarding', 'deactivating', 'deactivated', 'deleted', 'suspended', 'closed', 'archived', 'enabled', 'ok', ''];
    const permitted: string[] = [];
    for (const c of candidates) {
      for (const a of candidates) {
        if (mayStartAutonomousWork({ status: c }, { status: a }).allowed) permitted.push(`${c}|${a}`);
      }
    }
    expect(permitted).toEqual(['active|active']);
  });
});
