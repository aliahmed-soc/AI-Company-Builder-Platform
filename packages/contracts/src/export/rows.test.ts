// @acbp/contracts — per-row ownership and identity for the archive (ACBP-P7-001; CDR-078 §6.3; invariant 19).
import { describe, expect, it } from 'vitest';
import { exportRowIdentity, partitionRowsByOwnership, WITHHELD_IDENTITY } from './rows.js';

// THESE IDS CONTAIN HEX LETTERS ON PURPOSE. The obvious fixture — `1111…-1111-…` — is all digits and hyphens, so
// `toUpperCase()` on it is a NO-OP, and mutation testing showed both case-insensitivity tests below were passing
// against an unchanged string: they asserted nothing at all. A fixture that cannot express the difference cannot
// test for it.
const OWN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = 'ffffffff-1111-4222-8333-aaaabbbbcccc';

describe('exportRowIdentity', () => {
  it('names a row by the collection’s DECLARED key, not by assuming `id`', () => {
    expect(exportRowIdentity('tasks', { id: 't-1', title: 'x' })).toBe('t-1');
    expect(exportRowIdentity('interview_answers', { question_id: 'q-7', revision: 2 })).toBe('q-7:2');
    expect(exportRowIdentity('company_profiles', { version: 3 })).toBe('3');
  });

  it('still produces a name when the key column is missing or null', () => {
    // This label is what an OMISSION carries, so it must exist for exactly the rows that went wrong. A row that
    // could not be identified and therefore was not enumerated is the silent gap CDR-078 §0 is about.
    expect(exportRowIdentity('tasks', {})).toBe('?');
    expect(exportRowIdentity('tasks', { id: null })).toBe('?');
    expect(exportRowIdentity('interview_answers', { question_id: 'q-7' })).toBe('q-7:?');
  });

  it('is TOTAL — an unexported table yields a placeholder rather than throwing', () => {
    // Deliberately not a throw. This is called while BUILDING an omission; an export dying because it could not
    // name a row it was already dropping would turn a partial archive into no archive.
    expect(exportRowIdentity('audit_events', { id: 'a-1' })).toBe('<unidentified>');
    expect(exportRowIdentity('', {})).toBe('<unidentified>');
  });
});

describe('partitionRowsByOwnership', () => {
  it('keeps the company’s own rows and separates out anything else', () => {
    const rows = [
      { id: 'a', company_id: OWN },
      { id: 'b', company_id: OTHER },
      { id: 'c', company_id: OWN },
    ];
    const result = partitionRowsByOwnership('tasks', rows, OWN);
    expect(result.owned.map((r) => r['id'])).toEqual(['a', 'c']);
    expect(result.foreignCount).toBe(1);
  });

  it('is UNREACHABLE while RLS holds, and that is exactly why it exists', () => {
    // CDR-078 §6-G6. Invariant 19 is a property of the ARCHIVE, not of the query that filled it. RLS is the layer
    // that should make a foreign row impossible; this is the layer that still refuses if RLS ever does not — and
    // being a pure function is what lets it be tested and mutated without first having to break RLS.
    const result = partitionRowsByOwnership('tasks', [{ id: 'x', company_id: OTHER }], OWN);
    expect(result.owned).toEqual([]);
    expect(result.foreignCount).toBe(1);
  });

  it('treats a row with NO readable company_id as foreign', () => {
    // Fail closed. An unverifiable row is not a verified row, and the direction of the mistake matters: an
    // omission is a complaint, a leaked row is unrecoverable.
    const rows = [{ id: 'a' }, { id: 'b', company_id: null }, { id: 'c', company_id: 42 }, { id: 'd', company_id: '' }];
    const result = partitionRowsByOwnership('tasks', rows, OWN);
    expect(result.owned).toEqual([]);
    expect(result.foreignCount).toBe(4);
  });

  it('treats an unusable scope id as owning NOTHING, rather than everything', () => {
    // The failure direction that would matter most: a blank or non-string company id must not make every row
    // match. It refuses the whole collection instead.
    for (const bad of ['', '   ', undefined as unknown as string, null as unknown as string, 42 as unknown as string]) {
      const result = partitionRowsByOwnership('tasks', [{ id: 'a', company_id: OWN }], bad);
      expect(result.owned).toEqual([]);
      expect(result.foreignCount).toBe(1);
    }
  });

  it('does not let a BLANK scope id match a BLANK row id', () => {
    // WRITTEN BECAUSE MUTATION TESTING FOUND THIS GUARD UNMEASURED. Deleting the `expected !== ''` check left every
    // case above green: the two blank values were never crossed — one test had a blank scope with a real row, the
    // other a blank row with a real scope, and neither reaches the branch where `'' === ''` matches. That branch is
    // the one where the last ownership check becomes a rubber stamp.
    const result = partitionRowsByOwnership('tasks', [{ id: 'a', company_id: '' }], '');
    expect(result.owned).toEqual([]);
    expect(result.foreignCount).toBe(1);
  });

  it('normalises the ROW’s value too, not only the scope’s', () => {
    // Also from mutation testing: the case-insensitivity test below upper-cases the SCOPE id, so dropping the
    // `.toLowerCase()` on the ROW side changed nothing — the fixture's row value was already lowercase. Both sides
    // are normalised, so both sides need a case that proves it.
    const result = partitionRowsByOwnership('tasks', [{ id: 'a', company_id: OWN.toUpperCase() }], OWN);
    expect(result.owned.map((r) => r['id'])).toEqual(['a']);
    expect(result.foreignCount).toBe(0);
  });

  it('compares case-INSENSITIVELY, because PostgreSQL renders uuid lowercase and a request may not', () => {
    // The same trap `companyPrefix` had to fix (CDR-048): the uuid pattern is case-insensitive, so the SAME
    // company arriving upper-cased would have every one of its own rows declared foreign — an export that
    // enumerates the founder's entire business as unverified, and fails closed all the way to useless.
    const result = partitionRowsByOwnership('tasks', [{ id: 'a', company_id: OWN }], OWN.toUpperCase());
    expect(result.owned.map((r) => r['id'])).toEqual(['a']);
    expect(result.foreignCount).toBe(0);
  });

  it('handles a non-array row set as an empty one rather than throwing', () => {
    expect(partitionRowsByOwnership('tasks', undefined as unknown as [], OWN)).toEqual({ owned: [], foreignCount: 0 });
  });

  it('reports only HOW MANY rows failed, never WHICH', () => {
    // FOUND IN THE INDEPENDENT REVIEW. An earlier version returned the failing rows' identities, and the only
    // consumer is a manifest the FOUNDER reads — so a leaked row would have had its id written into their archive,
    // confirming that another tenant's record exists and naming it. That is exactly the disclosure CDR-078 §3-G8
    // forbids a refusal from making, and it would have shipped looking like diligence.
    //
    // The count is what they actually need: "how many rows in this collection could not be verified as mine".
    const result = partitionRowsByOwnership('tasks', [{ id: 'someone-elses-row', company_id: OTHER }], OWN);
    expect(Object.keys(result).sort()).toEqual(['foreignCount', 'owned']);
    expect(JSON.stringify(result)).not.toContain('someone-elses-row');
    expect(JSON.stringify(result)).not.toContain(OTHER);
  });

  it('names the withheld-identity placeholder, so a manifest never has to invent one', () => {
    expect(WITHHELD_IDENTITY).toBe('<withheld>');
  });
});
