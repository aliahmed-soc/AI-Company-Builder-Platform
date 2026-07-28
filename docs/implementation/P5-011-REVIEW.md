# ACBP-P5-011 — review ledger (artifact storage)

Two independent passes, as the standing discipline requires. Both found real defects; neither pass was shortened.
Every finding below is mine, found by reading this ticket's own code adversarially rather than by a test failing.

| | |
| --- | --- |
| Ticket | ACBP-P5-011 — Document and artifact storage |
| Branch | `p5-011-artifact-storage` |
| Decision record | `CDR-060` (resolves IOQ-11 at 8 MiB) |
| Requirements | TASK-005 (artifacts + provenance, no hollow success), NFR-014, ADR-016 |
| Trust-critical | **#2 — prefix isolation** |

## Pass 1 — "does each guard do what its comment claims?"

### HIGH — a prefix CHECK that did not check what its comment claimed

`artifacts_key_is_company_prefixed` was `object_key like 'company/' || lower(company_id::text) || '/%'`, and the
comment above it said *"a derivation bug, a stale key copied from an export, or a **tampered value** all fail here
rather than silently pointing at another tenant's object."*

**LIKE does not understand paths.** `company/<A>/../<B>/artifacts/x/content.md` satisfies that prefix test perfectly.
The constraint written to make trust-critical #2 structural would have accepted a row addressing another tenant's
object, while its own comment asserted the opposite.

This is the **claim STATED but never ENFORCED** pattern, in the constraint whose entire purpose is the property the
ticket is judged on.

- **Fix:** the constraint now also requires `position('..' in object_key) = 0`; two traversal keys are asserted
  refused in the migration suite.
- **Comment corrected** to say what it is — a BACKSTOP behind `companyObjectKey`'s construction-time refusal and
  `verifyKeyBelongsToCompany`'s per-segment re-validation at use, catching a key that reached an INSERT without
  passing either. Claiming less, and now true.

### MEDIUM — a cross-company run threw a raw error AFTER writing the object

The tenant-pinned composite FK refuses an artifact citing another company's run — that is the structural guarantee and
it is unchanged. But it refuses at the **INSERT**, by which point the bytes are already in the bucket. Two consequences:
the caller got an untyped throw where every other outcome is a typed refusal, and the refused write left an orphaned
object behind.

- **Fix:** `persistArtifact` reads the run **before** the object write and returns `run_not_found`. The read is
  RLS-confined, so "not in this company" and "does not exist" are correctly the same answer — which is also the right
  thing to tell a caller. The test now asserts the third thing it could not assert before: no orphaned object.

### LOW — `deduplicated` is advisory

Two concurrent writers of identical bytes can both read `undefined` and both report `deduplicated: false`, while the
unique index still yields exactly one row. **Documented, not fixed:** tightening it means holding a lock across an
object write, and the flag is reporting, not a correctness signal.

## Pass 2 — "can each test actually fail, and where can two sources of truth drift apart?"

### HIGH — the format list lived in two places that could silently disagree

`ARTIFACT_FORMATS` is in the contract; the same three values are also inside `artifacts_format_valid` in migration
0043. Widening the contract without a matching migration breaks **nothing** at build time and **nothing** in any unit
test. It breaks at the first INSERT of the new format, in production, as a constraint violation raised against a code
path that believed it was doing something legal.

**This repo has already walked into this exact trap once.** ACBP-P5-013 widened `ACTIVITY_TYPES` with no migration
widening `activity_events_type_valid`, arming a fail-closed projector to roll back the very transition it was meant to
record. Same shape, different list, one ticket later.

- **Fix:** `ARTIFACT_FORMATS_IN_DATABASE_CHECK` + `artifactFormatsMatchDatabase()`, asserted by a test. Drift is now a
  red build instead of a production incident.

### MEDIUM — a test that could not fail

`verifyPersistedObject`'s "nonsense size" case passed the **same bad value as both** the expected size and the reported
one. The expected-size guard runs first, so the head value was never examined — the test would have passed with the
head validation deleted outright.

- **Fix:** split into two cases — a bad expectation against a valid head, and a bad head against a **valid**
  expectation, so the head branch is genuinely exercised.

### LOW — dead branch, and an implicit `any`

`validateCompletionEvidence` computed `ids` with an `Array.isArray` ternary on the line *before* the `Array.isArray`
guard that returns. And `let head;` in `persistArtifact` was implicitly `any`, so a change to
`verifyPersistedObject`'s parameter type would not have been caught at that call site. Both corrected.

## Known gaps, named rather than assumed

- **`completeTask` is exported and fully tested, but nothing in the product calls it yet.** The worker tickets
  (P5-006/007/008) own that wiring. Recorded here so it is a known gap and not an assumed completion.
- **`persistArtifact` does not require the run to still be running.** An artifact can be written against a run that
  already failed or was cancelled. Canon does not rule on this, and a run that produced partial output before failing
  is a legitimate case, so it is left permissive and flagged rather than guessed at.
- **The concrete R2/S3 adapter is an owner gate** (`CDR-060 §4`) — a live bucket and real credentials. What is proven
  today is the semantics around storage; what remains is one class implementing an interface that already exists.

## Evidence status

`pnpm run check` exits 0 (typecheck, lint, secrets, encoding, boundaries, reset-lists, boundary tests, full suite):
**1432 passed / 0 failed / 1045 skipped.**

**The skips are the whole caveat.** No PostgreSQL is reachable locally, so every real-PG suite in this ticket — 14 for
the `artifacts` table, 16 for `persistArtifact`, 19 for `completeTask` — is silently dropped by `describe.skipIf`, and
a skipped suite reads exactly like a passing one in the summary line. They are unproven until hosted CI runs them on
the exact SHA with zero skips. Hosted CI has been blocked by the GitHub Actions billing limit since 12:46 UTC; six
pushes to this branch have produced no workflow run at all.

What runs and passes locally: the 22 artifact-contract tests, 9 completion-contract tests, 8 verification tests, and
9 in-memory-storage tests — none of which need a database.
