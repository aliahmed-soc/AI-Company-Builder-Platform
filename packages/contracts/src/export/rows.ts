// @acbp/contracts — per-row ownership and identity for the archive (ACBP-P7-001; CDR-078 §6.3; EXPORT-001;
// SECURITY-ARCHITECTURE "ownership verification per export"; invariant 19).
//
// Pure and total. Both functions here are UNREACHABLE in their interesting branch while row-level security holds,
// and that is the point: invariant 19 is a property of the ARCHIVE, not of the query that filled it. Being pure is
// what lets these be tested — and MUTATED — without first having to break RLS to reach them.
import { exportOrderBy } from './collections.js';

/** A row as read, before anything has decided whether it belongs in the archive. */
export type ExportRowLike = Readonly<Record<string, unknown>>;

/** Shown in a manifest omission when the value itself is absent — a nameless omission is an unenumerated one. */
const UNKNOWN_SEGMENT = '?';
/** Shown when the collection has no declared key at all. */
const UNIDENTIFIED = '<unidentified>';

/**
 * Name a row by its collection's DECLARED key.
 *
 * Not `row.id`: two exported collections (`company_profiles`, `interview_answers`) have no `id` column, so
 * assuming one would leave every omission in them unnamed.
 *
 * TOTAL — never throws. This is called while BUILDING an omission, and an export that died because it could not
 * name a row it was already dropping would turn a partial archive into no archive, which is precisely the
 * exchange CDR-078 §3-G4 refuses. ENFORCED BY: "is TOTAL — an unexported table yields a placeholder".
 */
export function exportRowIdentity(table: string, row: ExportRowLike): string {
  const key = exportOrderBy(table);
  if (key === undefined || key.length === 0) return UNIDENTIFIED;
  return key
    .map((column) => {
      const value: unknown = row?.[column];
      if (value === undefined || value === null) return UNKNOWN_SEGMENT;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
      return UNKNOWN_SEGMENT;
    })
    .join(':');
}

/**
 * What an `ownership_unverified` omission is NAMED, in place of the row's real identifier.
 *
 * The manifest is a document the FOUNDER reads. A row that failed the ownership check is by definition not theirs,
 * so naming it would confirm another tenant's record exists and hand over its id — the exact disclosure CDR-078
 * §3-G8 forbids a refusal from making. One omission is emitted per withheld row, so "how many rows here could not
 * be verified as mine" stays answerable while "whose were they" does not.
 */
export const WITHHELD_IDENTITY = '<withheld>';

export interface OwnershipPartition {
  readonly owned: readonly ExportRowLike[];
  /**
   * HOW MANY rows could not be verified as this company's — deliberately not WHICH.
   *
   * An earlier version returned their identities. Nothing may use them: they are another tenant's row ids, and the
   * only consumer is a manifest the founder reads. A return value that must never be used is an invitation, so it
   * is not returned. ENFORCED BY: "reports only HOW MANY rows failed, never WHICH".
   */
  readonly foreignCount: number;
}

/**
 * Split rows into "verified as this company's" and "everything else" (CDR-078 §6-G6).
 *
 * FAIL CLOSED IN BOTH DIRECTIONS. A row whose `company_id` cannot be read is foreign, and an unusable scope id
 * owns NOTHING rather than everything — the second is the failure that would matter, because a blank comparison
 * that matched every row would turn the last ownership check into a rubber stamp.
 * ENFORCED BY: "treats a row with NO readable company_id as foreign" and "treats an unusable scope id as owning
 * NOTHING, rather than everything".
 *
 * THE COMPARISON IS CASE-INSENSITIVE, and that is a correctness requirement rather than leniency: PostgreSQL
 * renders `uuid` lowercase while a request may not, so a case-sensitive compare would declare a company's ENTIRE
 * business foreign the moment its id arrived upper-cased — failing closed all the way to useless. Same trap
 * `companyPrefix` had to fix in CDR-048. ENFORCED BY: "compares case-INSENSITIVELY".
 */
export function partitionRowsByOwnership(table: string, rows: readonly ExportRowLike[], companyId: string): OwnershipPartition {
  // `Array.isArray` widens a `readonly T[]` to `any[]` in its true branch, so the checked value is re-bound to the
  // declared type rather than used through the narrowing.
  const safeRows: readonly ExportRowLike[] = Array.isArray(rows) ? rows : [];
  const expected = typeof companyId === 'string' ? companyId.trim().toLowerCase() : '';
  const owned: ExportRowLike[] = [];
  let foreignCount = 0;
  for (const row of safeRows) {
    const actual: unknown = row?.['company_id'];
    const matches = expected !== '' && typeof actual === 'string' && actual.trim().toLowerCase() === expected;
    if (matches) owned.push(row);
    else foreignCount += 1;
  }
  return { owned, foreignCount };
}
