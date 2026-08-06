// @acbp/core — the lifecycle guard's READ (ACBP-P7-002; CDR-079 §3, §6-G3; launch Gate 14).
//
// What the guard DECIDES is `mayStartAutonomousWork`, tested exhaustively in @acbp/contracts. What it READS is
// tested here: the right two rows, from the RESOLVED scope, under a lock. The lock is the part a real-PostgreSQL
// test cannot reliably prove — a write-skew window is a race, and a green race proves nothing — so it is asserted
// structurally, where its removal is detectable every run.
import { describe, it, expect } from 'vitest';
import type { TenantScope } from '@acbp/database';
import { readLifecycleDecision } from './lifecycle-guard.js';

interface Recorded {
  readonly tables: string[];
  readonly ids: unknown[];
  forShare: number;
}

/** A stand-in for the scope's transaction that records the queries the guard builds. */
function recordingScope(rows: Record<string, { status: unknown } | undefined>): { scope: TenantScope; recorded: Recorded } {
  const recorded: Recorded = { tables: [], ids: [], forShare: 0 };
  let current = '';
  const chain = {
    select: () => chain,
    where: (_col: unknown, _op: unknown, value: unknown) => {
      recorded.ids.push(value);
      return chain;
    },
    forShare: () => {
      recorded.forShare += 1;
      return chain;
    },
    executeTakeFirst: () => Promise.resolve(rows[current]),
  };
  const db = {
    selectFrom: (table: string) => {
      current = table;
      recorded.tables.push(table);
      return chain;
    },
  };
  const scope = { db, tenant: { accountId: 'acc-1', companyId: 'co-1' } } as unknown as TenantScope;
  return { scope, recorded };
}

describe('readLifecycleDecision', () => {
  it('allows work when both rows read active', async () => {
    const { scope } = recordingScope({ companies: { status: 'active' }, accounts: { status: 'active' } });
    await expect(readLifecycleDecision(scope)).resolves.toEqual({ allowed: true });
  });

  it('refuses when the company is paused', async () => {
    const { scope } = recordingScope({ companies: { status: 'paused' }, accounts: { status: 'active' } });
    await expect(readLifecycleDecision(scope)).resolves.toEqual({ allowed: false, reason: 'company_not_active' });
  });

  it('refuses when the company row is absent, rather than assuming anything', async () => {
    const { scope } = recordingScope({ companies: undefined, accounts: { status: 'active' } });
    await expect(readLifecycleDecision(scope)).resolves.toEqual({ allowed: false, reason: 'company_unreadable' });
  });

  it('reads BOTH levels — the account is not skipped while its transition is deferred', async () => {
    // ACC-004's transitions are deferred to a later slice, but the ENFORCEMENT is not: nothing in production
    // writes a non-active account status today, so reading it costs nothing and is already correct for the day
    // something does. Omitting the read now would leave a gate that has to be re-opened later.
    //
    // Both rows are ACTIVE here on purpose — that is the only case in which both reads happen, because a
    // non-active account short-circuits (see the last test). An earlier version of this test used a suspended
    // account AND asserted both reads, which the short-circuit makes impossible; the two assertions were pulled
    // apart rather than weakening either.
    const { scope, recorded } = recordingScope({ companies: { status: 'active' }, accounts: { status: 'active' } });
    await readLifecycleDecision(scope);
    expect(recorded.tables).toEqual(['accounts', 'companies']);
  });

  it('refuses on a non-active ACCOUNT, naming the account', async () => {
    const { scope } = recordingScope({ companies: { status: 'active' }, accounts: { status: 'suspended' } });
    await expect(readLifecycleDecision(scope)).resolves.toEqual({ allowed: false, reason: 'account_not_active' });
  });

  it('refuses when the ACCOUNT row is absent', async () => {
    const { scope } = recordingScope({ companies: { status: 'active' }, accounts: undefined });
    await expect(readLifecycleDecision(scope)).resolves.toEqual({ allowed: false, reason: 'account_unreadable' });
  });

  it('reads the ids from the RESOLVED SCOPE, never from a caller parameter', async () => {
    // Invariant 19's discipline, and the reason the function takes a scope rather than ids: the two are equal
    // only by coincidence of the current call path, and a gate keyed on a request parameter is a gate the
    // request can move.
    const { scope, recorded } = recordingScope({ companies: { status: 'active' }, accounts: { status: 'active' } });
    await readLifecycleDecision(scope);
    expect(recorded.ids).toEqual(['acc-1', 'co-1']);
  });

  it('LOCKS both rows, so a deactivation cannot commit between the check and the work', async () => {
    // CDR-079 §6-G3. `withTenantTransaction` runs READ COMMITTED and the deactivation side updates a different
    // row, so without a lock neither transaction blocks and a run can start strictly AFTER the transition
    // commits. Same-transaction reads bound how STALE the read is, not the ORDERING. Two locks: one per row.
    const { scope, recorded } = recordingScope({ companies: { status: 'active' }, accounts: { status: 'active' } });
    await readLifecycleDecision(scope);
    expect(recorded.forShare).toBe(2);
  });

  it('stops at the ACCOUNT when the account is not active — no wasted company read', async () => {
    // Not an optimisation: the account answer is the one an operator must act on first (§3-G4), and reading the
    // company afterwards could only produce a reason that names the wrong level.
    const { scope, recorded } = recordingScope({ accounts: { status: 'suspended' }, companies: { status: 'active' } });
    await readLifecycleDecision(scope);
    expect(recorded.tables).toEqual(['accounts']);
  });
});
