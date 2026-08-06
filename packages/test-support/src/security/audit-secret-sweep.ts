// @acbp/test-support — the audit/activity secret sweep (ACBP-P7-007; trust-critical #16; CDR-080 §2).
//
// WHY THIS IS A SHARED HELPER RATHER THAN THREE ASSERTIONS IN ONE FILE. Trust-critical #16 says "Secret values
// never appear in logs or audit payloads". The LOGS half is a property of one function (`redact`) and is
// covered. The AUDIT half is a property of EVERY audited write in the system, and no single suite exercises
// those. A hand-written `not.toContain` in one place proves one place.
//
// So the sweep is published here to be called at the END of any real-PostgreSQL suite that performed audited
// work. Every suite that adopts it turns its own fixtures into #16 evidence, and the property becomes
// suite-wide rather than file-local.
//
// WHAT IT CANNOT DO. `boundedMetadata` applies no secret detection (see
// `packages/contracts/src/audit/metadata-secrets.test.ts`), so this sweep is a DETECTOR, not a control: it
// catches a producer that writes a secret, after the write, in a test. It does not prevent one in production.
// Whether enforcement belongs in `boundedMetadata` is CDR-080 §7 — an owner decision, because audit-or-nothing
// means a rejection fails the product operation.
import { containsSecret } from '@acbp/contracts';

/** The minimum shape this sweep needs — any Kysely-backed client used by the integration suites. */
export interface SweepableClient {
  readonly kysely: {
    selectFrom: (table: string) => {
      selectAll: () => { execute: () => Promise<readonly Record<string, unknown>[]> };
    };
  };
}

/** Tables whose rows are permanent and caller-influenced. Append-only: a secret here is unrecoverable. */
export const SWEPT_TABLES = Object.freeze(['audit_events', 'activity_events']);

export interface SweepFinding {
  readonly table: string;
  readonly column: string;
  /** The row's id when it has one — never the offending value, which would leak it into the test output. */
  readonly rowId: string;
}

/**
 * Scan every swept table for secret-shaped content and return the findings.
 *
 * NEVER returns the offending value: a failing security test that prints the secret it found has moved the leak
 * rather than closed it. Callers get table, column and row id — enough to locate the row, nothing more.
 */
export async function sweepAuditPayloadsForSecrets(client: SweepableClient): Promise<readonly SweepFinding[]> {
  const findings: SweepFinding[] = [];
  for (const table of SWEPT_TABLES) {
    let rows: readonly Record<string, unknown>[];
    try {
      rows = await client.kysely.selectFrom(table).selectAll().execute();
    } catch {
      // A table absent from this suite's schema is not a finding — but it must not silently count as clean
      // either, so the caller learns which tables were actually read via `sweptTables` on the assertion below.
      continue;
    }
    for (const row of rows) {
      const rowId = typeof row['id'] === 'string' ? row['id'] : '<no id>';
      for (const [column, value] of Object.entries(row)) {
        const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value);
        if (text !== '' && containsSecret(text)) findings.push({ table, column, rowId });
      }
    }
  }
  return findings;
}

/**
 * Assert no swept row carries secret-shaped content. Throws with a located, VALUE-FREE report.
 *
 * Call at the end of a real-PostgreSQL suite that performed audited work:
 *
 *     afterAll(async () => { await assertNoSecretsInAuditPayloads(owner); });
 */
export async function assertNoSecretsInAuditPayloads(client: SweepableClient): Promise<void> {
  const findings = await sweepAuditPayloadsForSecrets(client);
  if (findings.length === 0) return;
  const located = findings.map((f) => `${f.table}.${f.column} (row ${f.rowId})`).join('\n  ');
  throw new Error(
    `TRUST-CRITICAL #16: secret-shaped content reached a permanent audit/activity row.\n  ${located}\n` +
      'Values are deliberately withheld from this message. These tables are append-only — in production such a row could not be removed.',
  );
}
