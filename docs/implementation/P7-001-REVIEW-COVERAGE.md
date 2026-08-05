# ACBP-P7-001 — independent review coverage

Ticket: **ACBP-P7-001** export of documents and owned data (EXPORT-001, NFR-014; ADR-002, ADR-016; trust-critical
\#2; invariant 19; SECURITY-VERIFICATION-PLAN gate 12 support). Branch `p7-001-export`, PR **#73**, CDR-078.

**No migration.** This ticket adds no table, deliberately — see §6.7 of the CDR.

The review returned **FAIL** with one HIGH. Mutation testing returned **three additional findings**, two of them
tests that could not fail. Local CI was green for all four.

---

## The design phase found the ticket arguing with itself

Recorded because it changed the shape of the work before a line was written.

Acceptance asks for **both** *"archive matches in-product data"* **and** *"zero secrets"*. When a founder has
typed their own key into their own document those conflict. `SECURITY-ARCHITECTURE:19` settles it — *"archives
never contain secret values"* — so the value is redacted and the surrounding document stays, because dropping a
whole document over one span loses the founder's actual work, which is the failure export exists to prevent.

That forces a third category the manifest has to carry: not just included and omitted, but **included with
redactions**. `redactionCount` is 0 when the emitted bytes are identical to the source, and `manifestIsFaithful`
answers the stronger question `complete` cannot — *"is this everything, exactly as it was?"* A fully complete
archive can still differ from the product wherever a secret was removed.

---

## HIGH-1 — the manifest disclosed other tenants' row identifiers

**Found by reading, not by running**, because nothing could have run it: the branch is unreachable while RLS
holds.

`partitionRowsByOwnership` returned the failing rows' **identities**, and the export wrote them into the manifest
as `ownership_unverified` omissions. A row that leaked past RLS would have had its id handed to the wrong founder
— confirming that another tenant's record exists, and naming it. CDR-078 §3-G8 forbids exactly that: *"a refused
export must not confirm whether another tenant's data exists."*

It would have shipped looking like **diligence**. Enumerating what went wrong is the right instinct everywhere
else in this file; it is wrong for the one class of row whose identifier is not ours to enumerate.

**Fixed at the source, not the call site.** The function now returns a **count**, never the identities: a return
value that must never be used is an invitation. The founder still gets everything actionable — which collection,
and how many rows — because each withheld row is its own enumerated omission carrying `<withheld>`. Every other
omission reason still names its row, because those rows are theirs.

`ENFORCED BY: "reports only HOW MANY rows failed, never WHICH"`.

---

## Mutation testing — 17 guards, four findings

| # | Mutation | Result |
|---|---|---|
| MUT1 | coverage guard fails OPEN on an unreadable schema | caught |
| MUT2 | coverage stops reporting STALE entries | caught |
| MUT3 | unexported table gets an empty sort key instead of `undefined` | caught |
| MUT4 | ownership check removed — every row is owned | caught |
| MUT5 | blank scope id matches everything | **survived → fixed** |
| MUT6 | ownership compare becomes case-SENSITIVE | **survived → fixed** |
| MUT7 | row identity assumes `id` instead of the declared key | caught |
| MUT8 | a secret in a KEY is tolerated instead of excluding the row | caught |
| MUT9 | non-plain objects included instead of excluded | caught |
| MUT10 | an unrepresentable leaf is dropped, row still included | caught |
| MUT11 | value-walk depth bound removed | caught |
| MUT12 | the table allowlist is not enforced | **survived → fixed** |
| MUT13 | the read limit is accepted unvalidated | caught |
| MUT14 | `ORDER BY` dropped — archive row order becomes arbitrary | caught |
| MUT15 | refusals become rejected promises instead of throws | caught |
| MUT16 | `manifestIsFaithful` collapses into `complete` | caught |
| MUT17 | placeholder subtraction removed (re-verifies the manifest slice) | caught |

### MUT5 — a guard nothing measured

Deleting `expected !== ''` left every case green. Two tests existed — a blank scope with a real row, and a blank
row with a real scope — and **neither crossed the two blanks**, which is the only branch where `'' === ''` matches
and the last ownership check becomes a rubber stamp. Test added for exactly that crossing.

### MUT6 — two tests that asserted nothing at all

The case-insensitivity tests used `OWN.toUpperCase()` where `OWN` was `11111111-1111-4111-8111-111111111111` —
**all digits and hyphens, so `toUpperCase()` is a no-op**. Both tests were comparing a string to itself and would
have passed against a case-sensitive comparison, a case-insensitive one, or no comparison at all. The fixture ids
now carry hex letters, and a second test covers the row side (the original only varied the scope side).

*A fixture that cannot express the difference cannot test for it* — the same shape as ACBP-P6-007's fixture-guard
lesson, arriving through a different door.

### MUT12 — a second condition that was not a control

The repository tested both `isExportCollectionTable(table)` and `exportOrderBy(table) === undefined`. Both derive
from `EXPORT_COLLECTIONS`, so they are **equivalent**, and deleting either left every test green. A condition no
test can distinguish reads as defence-in-depth and is not. Collapsed to one, with the sort-key lookup documented
as narrowing rather than guarding.

### And the harness itself

An aborted first run of the mutation script left a **fail-open coverage mutation in the working tree** —
`exportCoverage` returning "all clear" for an unreadable schema. It was caught only because the re-run reported
that mutation's anchor as missing. Had the script not been re-run, it would have been committed.

---

## What is proven, and where

| Property | Proven by | Anchor |
|---|---|---|
| Archive matches in-product data | real-PG: read the archive back, compare against a separate DB read | the database, not the export's own report |
| Zero secrets | real-PG: token in a text column **and** at `rules[0].note` (jsonb, two levels down) | every byte of every object concatenated |
| Cross-tenant denied | real-PG: B's rows absent from A's archive; B's owner refused on A | seeded two-tenant world |
| Owner only | real-PG: a viewer is `forbidden` and leaves no archive behind | `export:create` allow-list |
| Partial enumerates missing | real-PG: `maxRowsPerCollection: 1` over 2 rows | `truncated` omission + `complete: false` |
| Classification covers the schema | real-PG: `information_schema.columns` vs `exportCoverage` | **a different anchor** from the `DatabaseSchema` interface the export reads through |
| No hollow success | real-PG: `dropNextPut()` → export refuses, **no audit row** | the audit table |
| Re-runnable | real-PG: two exports, identical per-collection digests, distinct prefixes | the digests |
| Exclusions are enforced | real-PG: no `audit_events`/`memberships` object; the seeded viewer is named nowhere | the archive's keys and bytes |

**Not proven, and claimed nowhere:** that an archive lands **durably**. There is no S3-compatible adapter
(CDR-078 §1), and none of the properties above are about S3.

---

## Disclosed rather than designed around

- **§1** — mechanism-complete, not production-complete. No storage adapter exists.
- **§6.7** — no `export_jobs` table, though the BACKLOG cell and EVENT-CATALOG `:279` both name one. A job row
  exists to be polled and §4 ruled out the surface that would poll it.
- **§6.8** — the whole export runs inside **one database transaction**, which against a real provider means
  holding it open across ~56 network round trips. Belongs to the ticket that brings the adapter.
- **§7.3** — the exclusion rulings for `memberships` and the billing ledgers are engineering defaults on a
  privacy question, and flagged as the owner's.
