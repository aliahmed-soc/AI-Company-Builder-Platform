// ACBP-P7-007 — regression suite for the audit secret sweep (trust-critical #16).
//
// The sweep is a DETECTOR, so a broken sweep is worse than no sweep: every suite that adopts it would report a
// clean audit trail it never actually examined. These cases run against an in-memory fake client, so they need
// no database and can prove the detector fires, stays quiet on clean data, and never prints what it found.
import { describe, test, expect } from 'vitest';
import { sweepAuditPayloadsForSecrets, assertNoSecretsInAuditPayloads, SWEPT_TABLES } from './audit-secret-sweep.js';

const SECRET = 'postgresql://acbp_app:hunter2plusmore@db.internal:5432/acbp';

/** A minimal stand-in for the Kysely-backed clients the integration suites use. */
function fakeClient(tables: Readonly<Record<string, readonly Record<string, unknown>[]>>): {
  kysely: { selectFrom: (t: string) => { selectAll: () => { execute: () => Promise<readonly Record<string, unknown>[]> } } };
} {
  return {
    kysely: {
      selectFrom: (table: string) => ({
        selectAll: () => ({
          execute: () => {
            const rows = tables[table];
            if (rows === undefined) return Promise.reject(new Error(`relation "${table}" does not exist`));
            return Promise.resolve(rows);
          },
        }),
      }),
    },
  };
}

describe('audit secret sweep — ACBP-P7-007 trust-critical #16', () => {
  test('CONTROL: a clean trail yields no findings', async () => {
    const client = fakeClient({
      audit_events: [{ id: 'a1', payload: JSON.stringify({ count: 3, reason: 'paused' }) }],
      activity_events: [{ id: 'e1', summary: 'company paused' }],
    });
    expect(await sweepAuditPayloadsForSecrets(client)).toEqual([]);
    await expect(assertNoSecretsInAuditPayloads(client)).resolves.toBeUndefined();
  });

  test('a secret in a payload IS found, and located by table, column and row', async () => {
    const client = fakeClient({
      audit_events: [{ id: 'a1', payload: JSON.stringify({ detail: SECRET }) }],
      activity_events: [],
    });
    const findings = await sweepAuditPayloadsForSecrets(client);
    expect(findings).toEqual([{ table: 'audit_events', column: 'payload', rowId: 'a1' }]);
  });

  test('the activity feed is swept too — both permanent tables, not just the audit one', async () => {
    const client = fakeClient({
      audit_events: [],
      activity_events: [{ id: 'e9', summary: `connect failed ${SECRET}` }],
    });
    const findings = await sweepAuditPayloadsForSecrets(client);
    expect(findings).toEqual([{ table: 'activity_events', column: 'summary', rowId: 'e9' }]);
  });

  test('THE FAILURE NEVER PRINTS THE SECRET — a security test that leaks what it found has moved the leak', async () => {
    const client = fakeClient({ audit_events: [{ id: 'a1', payload: SECRET }], activity_events: [] });
    await expect(assertNoSecretsInAuditPayloads(client)).rejects.toThrow(/TRUST-CRITICAL #16/);
    const message = await assertNoSecretsInAuditPayloads(client).catch((e: unknown) => String(e));
    expect(message).toContain('audit_events.payload');
    expect(message).toContain('row a1');
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('hunter2plusmore');
  });

  test('a missing table is skipped rather than throwing — a suite with a partial schema still sweeps the rest', async () => {
    const client = fakeClient({ audit_events: [{ id: 'a1', payload: SECRET }] }); // no activity_events
    const findings = await sweepAuditPayloadsForSecrets(client);
    expect(findings).toEqual([{ table: 'audit_events', column: 'payload', rowId: 'a1' }]);
  });

  test('non-string columns are serialized before scanning, so a JSONB object cannot hide one', async () => {
    const client = fakeClient({
      audit_events: [{ id: 'a1', payload: { nested: { deeper: SECRET } } }],
      activity_events: [],
    });
    expect(await sweepAuditPayloadsForSecrets(client)).toEqual([
      { table: 'audit_events', column: 'payload', rowId: 'a1' },
    ]);
  });

  test('both permanent tables are in scope — a table dropped from the list must be a deliberate edit', () => {
    expect([...SWEPT_TABLES]).toEqual(['audit_events', 'activity_events']);
  });
});
