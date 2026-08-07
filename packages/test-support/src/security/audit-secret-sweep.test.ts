// ACBP-P7-007 — regression suite for the audit secret sweep (trust-critical #16).
//
// The sweep is a DETECTOR, so a broken sweep is worse than no sweep: every suite that adopts it would report a
// clean audit trail it never actually examined. These cases run against an in-memory fake client, so they need
// no database and can prove the detector fires, stays quiet on clean data, and never prints what it found.
import { describe, test, expect } from 'vitest';
import { sweepAuditPayloadsForSecrets, assertNoSecretsInAuditPayloads, SWEPT_TABLES } from './audit-secret-sweep.js';

// Named PLANTED_URI and not SECRET on purpose. `const SECRET = '…'` matches the scanner's own
// `generic-credential-assignment` rule, and ACBP-P7-007 first answered that by allowlisting this whole file —
// silencing the broadest rule in the scanner, permanently, for every future line here. An independent review
// pointed out the value is byte-identical either way, so the allowlist entry bought nothing and cost the file's
// coverage. Rename, don't suppress.
const PLANTED_URI = 'postgresql://acbp_app:hunter2plusmore@db.internal:5432/acbp';

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
    expect((await sweepAuditPayloadsForSecrets(client)).findings).toEqual([]);
    await expect(assertNoSecretsInAuditPayloads(client)).resolves.toBeUndefined();
  });

  test('a secret in a payload IS found, and located by table, column and row', async () => {
    const client = fakeClient({
      audit_events: [{ id: 'a1', payload: JSON.stringify({ detail: PLANTED_URI }) }],
      activity_events: [],
    });
    const { findings } = await sweepAuditPayloadsForSecrets(client);
    expect(findings).toEqual([{ table: 'audit_events', column: 'payload', rowId: 'a1' }]);
  });

  test('the activity feed is swept too — both permanent tables, not just the audit one', async () => {
    const client = fakeClient({
      audit_events: [],
      activity_events: [{ id: 'e9', summary: `connect failed ${PLANTED_URI}` }],
    });
    const { findings } = await sweepAuditPayloadsForSecrets(client);
    expect(findings).toEqual([{ table: 'activity_events', column: 'summary', rowId: 'e9' }]);
  });

  test('THE FAILURE NEVER PRINTS WHAT IT FOUND — a security test that leaks its finding has moved the leak', async () => {
    const client = fakeClient({ audit_events: [{ id: 'a1', payload: PLANTED_URI }], activity_events: [] });
    await expect(assertNoSecretsInAuditPayloads(client)).rejects.toThrow(/TRUST-CRITICAL #16/);
    const message = await assertNoSecretsInAuditPayloads(client).catch((e: unknown) => String(e));
    expect(message).toContain('audit_events.payload');
    expect(message).toContain('row a1');
    expect(message).not.toContain(PLANTED_URI);
    expect(message).not.toContain('hunter2plusmore');
  });

  test('a missing table is skipped rather than throwing — a suite with a partial schema still sweeps the rest', async () => {
    const client = fakeClient({ audit_events: [{ id: 'a1', payload: PLANTED_URI }] }); // no activity_events
    const { findings } = await sweepAuditPayloadsForSecrets(client);
    expect(findings).toEqual([{ table: 'audit_events', column: 'payload', rowId: 'a1' }]);
  });

  test('non-string columns are serialized before scanning, so a JSONB object cannot hide one', async () => {
    const client = fakeClient({
      audit_events: [{ id: 'a1', payload: { nested: { deeper: PLANTED_URI } } }],
      activity_events: [],
    });
    expect((await sweepAuditPayloadsForSecrets(client)).findings).toEqual([
      { table: 'audit_events', column: 'payload', rowId: 'a1' },
    ]);
  });

  test('both permanent tables are in scope — a table dropped from the list must be a deliberate edit', () => {
    expect([...SWEPT_TABLES]).toEqual(['audit_events', 'activity_events']);
  });

  // ── ACBP-P7-007, SECOND REVIEW PASS: the sweep's own vacuity modes ────────────────────────────────────────
  // An independent review found the detector's most likely real-world outcome was a SILENT PASS. Both swept
  // tables carry FORCE ROW LEVEL SECURITY with an account-scoped policy, so a client outside
  // `withAccountTransaction` — which is exactly what the old docstring told callers to use — reads zero rows
  // and raises no error. Findings would be empty and the assertion would resolve, reporting a clean audit trail
  // that had never been read. These cases pin the difference between "nothing to find" and "did not look".

  test('reading ZERO rows from every table THROWS — an unset RLS scope must not read as a clean trail', async () => {
    const client = fakeClient({ audit_events: [], activity_events: [] });
    await expect(assertNoSecretsInAuditPayloads(client)).rejects.toThrow(/read ZERO rows/);
    await expect(assertNoSecretsInAuditPayloads(client)).rejects.toThrow(/FORCE ROW LEVEL SECURITY/);
  });

  test('…unless the caller states an empty trail is expected, which makes it a written claim', async () => {
    const client = fakeClient({ audit_events: [], activity_events: [] });
    await expect(assertNoSecretsInAuditPayloads(client, { allowEmpty: true })).resolves.toBeUndefined();
  });

  test('when NO table can be read at all, it throws rather than reporting clean', async () => {
    const client = fakeClient({}); // neither table exists
    await expect(assertNoSecretsInAuditPayloads(client)).rejects.toThrow(/could read NONE of its tables/);
  });

  test('the sweep reports WHAT IT READ, not only what it found — the caller can tell clean from blind', async () => {
    const client = fakeClient({ audit_events: [{ id: 'a1', payload: 'fine' }] }); // activity_events absent
    const { swept } = await sweepAuditPayloadsForSecrets(client);
    expect(swept).toEqual([
      { table: 'audit_events', rowsRead: 1 },
      { table: 'activity_events', rowsRead: 0, unreadable: 'relation absent from this schema' },
    ]);
  });

  test('an unreadable table never reports the driver error text — it can carry the failing statement', async () => {
    const client = {
      kysely: {
        selectFrom: () => ({
          selectAll: () => ({
            execute: () => Promise.reject(new Error(`permission denied: SELECT payload FROM audit_events WHERE x = '${PLANTED_URI}'`)),
          }),
        }),
      },
    };
    const { swept } = await sweepAuditPayloadsForSecrets(client);
    const text = JSON.stringify(swept);
    expect(text).not.toContain(PLANTED_URI);
    expect(text).not.toContain('hunter2plusmore');
    expect(text).toContain('query failed (Error)');
    const message = await assertNoSecretsInAuditPayloads(client).catch((e: unknown) => String(e));
    expect(message).not.toContain('hunter2plusmore');
  });
});
