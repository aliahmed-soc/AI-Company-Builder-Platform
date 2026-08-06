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

/** What a swept table actually yielded. `error` is the SANITIZED reason a table could not be read. */
export interface SweptTable {
  readonly table: string;
  readonly rowsRead: number;
  readonly unreadable?: string;
}

export interface SweepResult {
  readonly findings: readonly SweepFinding[];
  /** One entry per table in SWEPT_TABLES, always — so a caller can tell "clean" from "never looked". */
  readonly swept: readonly SweptTable[];
}

/**
 * Scan every swept table for secret-shaped content.
 *
 * NEVER returns the offending value: a failing security test that prints the secret it found has moved the leak
 * rather than closed it. Callers get table, column and row id — enough to locate the row, nothing more.
 *
 * IT RETURNS WHAT IT READ, NOT ONLY WHAT IT FOUND, and that is the whole point of the shape. The first version
 * returned findings alone and swallowed every query error into `continue`, on a comment promising the caller
 * would learn which tables were read "via `sweptTables` on the assertion below" — a field that did not exist
 * anywhere. Two failure modes hid behind that: a table the client lacks SELECT on, and — the one that matters —
 * ROW-LEVEL SECURITY. `audit_events` and `activity_events` both carry FORCE ROW LEVEL SECURITY with an
 * account-scoped policy, so calling this outside `withAccountTransaction` (exactly as the docstring below used
 * to prescribe) returns ZERO ROWS AND NO ERROR. Findings would be empty, the assertion would pass, and the suite
 * would report a clean audit trail it had never read.
 */
export async function sweepAuditPayloadsForSecrets(client: SweepableClient): Promise<SweepResult> {
  const findings: SweepFinding[] = [];
  const swept: SweptTable[] = [];
  for (const table of SWEPT_TABLES) {
    let rows: readonly Record<string, unknown>[];
    try {
      rows = await client.kysely.selectFrom(table).selectAll().execute();
    } catch (error) {
      // Bounded and sanitized: a driver error can carry the failing statement, and a statement can carry a
      // value. Record only the error NAME plus whether it looks like a missing relation.
      const name = error instanceof Error ? error.name : typeof error;
      const missing = error instanceof Error && /does not exist|undefined table|42P01/i.test(error.message);
      swept.push({ table, rowsRead: 0, unreadable: missing ? 'relation absent from this schema' : `query failed (${name})` });
      continue;
    }
    swept.push({ table, rowsRead: rows.length });
    for (const row of rows) {
      const rowId = typeof row['id'] === 'string' ? row['id'] : '<no id>';
      for (const [column, value] of Object.entries(row)) {
        const text = typeof value === 'string' ? value : value === null || value === undefined ? '' : JSON.stringify(value);
        if (text !== '' && containsSecret(text)) findings.push({ table, column, rowId });
      }
    }
  }
  return { findings, swept };
}

/**
 * Assert no swept row carries secret-shaped content. Throws with a located, VALUE-FREE report.
 *
 * CALL IT INSIDE THE ACCOUNT SCOPE whose rows you want swept — these tables are under FORCE ROW LEVEL SECURITY
 * and a client with no `app.current_account` set reads nothing:
 *
 *     await withAccountTransaction(client, accountId, async (tx) => {
 *       await assertNoSecretsInAuditPayloads(tx);
 *     });
 *
 * It THROWS when every table read zero rows. That is not pedantry: zero-rows-everywhere is indistinguishable
 * from a successful sweep in the findings alone, and it is the shape both an unset RLS scope and a torn-down
 * fixture produce. A detector that cannot tell "nothing to find" from "did not look" is not a detector. Pass
 * `{ allowEmpty: true }` where a genuinely empty trail is the expected state, which makes that a written claim
 * by the caller rather than a silent default.
 */
export async function assertNoSecretsInAuditPayloads(
  client: SweepableClient,
  options: { readonly allowEmpty?: boolean } = {},
): Promise<void> {
  const { findings, swept } = await sweepAuditPayloadsForSecrets(client);
  const inventory = swept
    .map((s) => (s.unreadable === undefined ? `${s.table}: ${s.rowsRead} row(s)` : `${s.table}: UNREADABLE — ${s.unreadable}`))
    .join('\n  ');

  if (findings.length > 0) {
    const located = findings.map((f) => `${f.table}.${f.column} (row ${f.rowId})`).join('\n  ');
    throw new Error(
      `TRUST-CRITICAL #16: secret-shaped content reached a permanent audit/activity row.\n  ${located}\n` +
        'Values are deliberately withheld from this message. These tables are append-only — in production such a row could not be removed.\n' +
        `Swept:\n  ${inventory}`,
    );
  }

  const unreadable = swept.filter((s) => s.unreadable !== undefined);
  if (unreadable.length === swept.length) {
    throw new Error(
      `TRUST-CRITICAL #16: the audit sweep could read NONE of its tables, so it proves nothing.\n  ${inventory}`,
    );
  }

  const total = swept.reduce((n, s) => n + s.rowsRead, 0);
  if (total === 0 && options.allowEmpty !== true) {
    throw new Error(
      'TRUST-CRITICAL #16: the audit sweep read ZERO rows from every table, which is what an unset RLS account ' +
        'scope looks like — these tables are under FORCE ROW LEVEL SECURITY, so a client with no ' +
        "`app.current_account` reads nothing and finds nothing.\n  " +
        inventory +
        '\nRun the sweep inside the account transaction whose rows you mean to check, or pass { allowEmpty: true } ' +
        'to state on purpose that an empty trail is the expected result.',
    );
  }
}
