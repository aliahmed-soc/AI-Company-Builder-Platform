# ACBP-P5-003a — independent review record

Two full independent passes. **Both returned FAIL.** Design consequences are recorded in `CDR-051`.

The set of risk classes this sub-scope introduces is **owner-approved by default and provisional** — see CDR-051 §0.
That is a decision to revisit, not a review finding, and nothing below re-litigates it.

---

## Pass 1 — the contract

### HIGH-1 — `riskRank` was a gate bypass

Signature was `riskRank(riskClass: RiskClass)`, which *looks* safe. TypeScript types are erased at runtime, and the
body was a bare `RISK_CLASSES.indexOf(...)` — which returns **-1** for anything unrecognised.

−1 is **below** `informational`. So the single function whose job is to express "how restrictive is this" would, for
an unclassified or malformed value, report the **least restrictive rank possible** — the exact inversion the module
exists to prevent, in the module that prevents it.

The path is not hypothetical. `row.risk_class` is `string | null` at the database boundary, and
`riskRank(row.risk_class as RiskClass)` is the obvious thing to write there. `isAtLeastAsRestrictiveAs` was already
safe because it resolves first; `riskRank` was exported raw for P6-001 to compare against a policy threshold, so the
bypass would have surfaced in the policy engine.

**Fix.** `riskRank(value: unknown)` resolving through `resolveRiskClass` first, making it total: never negative, and
an unknown value ranks as the most restrictive. Two regression tests, one of which asserts the rank is `>= 0` for
every input including symbols and negative numbers.

---

## Pass 2 — the migration and the proof, against the fixed tree

Found **clean**: the table is correctly global (no tenancy columns, no RLS, correctly absent from `TENANT_TABLES`);
the SELECT-only grant genuinely has no runtime write path; `risk_class` is nullable so "unclassified" is
representable, without which TOOL-001 would be untestable.

### MEDIUM-1 — the drift guard only worked in one direction

The existing test proved the CHECK **accepts** every contract class. It could not catch the reverse: a value added to
the CHECK but not to the contract. That value would be a class the database permits and no contract code can rank —
and CDR-051 §0 says this set is *expected to be revisited*, which makes one-directional drift precisely the wrong
thing to leave open.

**Fix.** Read the constraint's own definition via `pg_get_constraintdef` and assert set equality with `RISK_CLASSES`.
Two-way, and it fails on either kind of drift.

### MEDIUM-2 — a constraint name that described the wrong columns

`tool_definitions_id_version_uq` covers `(tool_id, version)`, not `(id, version)`. A name that misdescribes its own
columns sends whoever debugs a future conflict to the wrong place. Renamed to `tool_definitions_tool_version_uq`;
free, since the migration has never been deployed.

---

## Found by hosted CI, not by reading

Recorded because "the reviews were clean" would be a false account of this sub-scope.

**The reset-list omission — twice, by two different routes.** `tool_definitions` was missing from the schema-reset
lists, so it survived `resetSchema`, the next `CREATE TABLE` collided, the migration batch aborted, and **73 test
files** failed against a database with no tables. The visible error named `users`, not tools.

The root confusion is worth stating plainly, because it is easy to repeat: the **tenancy catalog** and the
**drop/reset lists** are different lists with different rules. `tool_definitions` is correctly absent from
`TENANT_TABLES` (it is global config with no RLS) and must be present in every reset list (it is a migrated table).
Reasoning "it is not a tenant table" answered the first question and was then wrongly applied to the second.

The first fix was **also incomplete**: it text-anchored on one list's phrasing, covering 33 files and silently missing
six written differently. Then a rebase dropped it from **all 41** — the incoming files had gained `jobs` and
`job_checkpoints` and won every hunk, with no conflict, type error or lint warning.

**This is now structurally prevented rather than remembered.** `tools/check-reset-lists.mjs` derives the required
table set from `DatabaseSchema` and asserts every reset list is a superset. It is static (no database), runs in
`check:static`, names the offending files and tables, and **fails loudly if it finds no reset lists at all** rather
than passing vacuously over zero files. Its own five tests reproduce both real regression shapes — one list short, and
every list short — and were confirmed to fail before the fix and pass after.
