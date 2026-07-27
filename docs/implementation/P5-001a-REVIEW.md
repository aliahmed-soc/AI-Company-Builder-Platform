# ACBP-P5-001a — independent review record

Two full independent passes, per the owner's 2026-07-27 instruction to hold P5-001/P5-003/P6-001/P6-007 to the highest
review bar. Both passes returned **FAIL**. Hosted CI then found two further defects that reading did not.

Governed by `CDR-049-durable-job-runner.md`; the design consequences are recorded there (§4b) so a later reader meets
them where the decision lives rather than only in this ledger.

---

## Pass 1 — the enqueue path, read as an adversary

### HIGH-1 — the acceptance clause's refusal was UNREACHABLE

**What.** `enqueueJob` validated tenant context *inside* `runInCompanyScope`. That function trims `requestedCompanyId`
and returns `{kind: 'denied', reason: 'company_not_specified'}` for an empty result **before** the callback ever runs,
and the use case maps a denial to `forbidden`.

**Why it matters.** The acceptance clause is *"context-stripped job refused"* (trust-critical #3). It is not satisfied
by "no row is written" — that was already true. It requires that a job arriving with no tenant context be
**distinguishable**, so a caller is told plainly and the platform can alarm on it. Reporting `forbidden` makes the one
failure this sub-scope exists to expose look exactly like an ordinary authorization failure. The layer intended to
make the problem visible was hiding it.

**How it survived writing.** The integration test asserted `{status: 'refused', reason: 'missing_company'}`, which is
what the code *should* do — so the test was correct and would have failed in CI. But it was written by the same person
who wrote the ordering, and neither the unit tests (which call the validator directly, bypassing the scope) nor local
runs (real-PG suites skip) could reach it. Reading found it before CI did.

**Fix.** `validateJobTenancy` split out of `validateJobRequest`, run **before** scope resolution.

**Why this does not reintroduce an oracle.** Only the tenancy fields moved ahead of authorization, and only because
they disclose nothing: they report on the shape of ids the *caller themselves supplied* — not whether a company
exists, not membership, not any platform state. `invalid_kind` and `payload_too_large` stay behind the authz check,
where a reason would genuinely tell an unauthorized caller something. A test pins that a viewer sending a bad `kind`
still gets `forbidden`.

**Regression guard.** A test drives five context-stripped shapes (`undefined`, `''`, `'   '`, `'null'`, `'0'`) through
a **legitimate owner** — nothing about the caller is wrong, only the context — and asserts each names the context.
`validateJobRequest` delegates to `validateJobTenancy`, with a test asserting the two never disagree.

### MEDIUM-1 — the row was stamped from caller params, not from the resolved scope

`jobs.insert` took `request.accountId`/`request.companyId`. Those are equal to the scope on this call path, because
`runInCompanyScope` verified membership against exactly those ids — but equal *by coincidence of the path*, not by
construction. This is the one sub-scope whose entire subject is that a job's tenancy is a grant rather than a claim.
Now stamped from `scope.tenant`.

### MEDIUM-2 — a refusal reason that was a lie

The unresolvable-conflict branch returned `refused: invalid_idempotency_key`. The key was valid; the conflict was
unresolvable. A caller acting on that reason would change a correct key and retry forever. Now a distinct
`conflict_unresolved` status, logged at error. It should be unreachable — a conflict implies a committed row visible
to the transaction — which is exactly why it must stay distinguishable if it ever occurs.

---

## Pass 2 — the schema and the contract, read fresh

Checked and found **clean**: the FK strategy matches `tasks` exactly (same three FKs, same delete actions); the
charter's composite tenant-pinned FK rule does not apply here, because both FKs target the tenancy anchors themselves
rather than a company-owned child; the column-grant set matches the migration; `down()` is complete.

### MEDIUM-3 — the contract did not mirror the closed state set

The migration commits to six states and declares `dead_letter` up front (§4-G6) precisely so P5-001b/c extend
behaviour rather than reshape the table. The contract said nothing about states, so a reader would take that silence
as the answer and a later divergence would be invisible. Added `JOB_STATES`/`isJobState` plus a real-PostgreSQL test
asserting **every** declared state is accepted by `jobs_state_valid` — a cross-check, not a restatement.

---

## Found by hosted CI, not by reading

Recorded because "the reviews were clean" would be a false account of this ticket.

- **42P10 — `ON CONFLICT` cannot infer a PARTIAL unique index** from a bare column list. The arbiter must restate the
  index predicate (`where('idempotency_key', 'is not', null)`). Nothing local could catch this: it is a planner error
  raised only when the statement actually executes against PostgreSQL.
- **Layer 1 was being tested for something layer 2 does.** The two `LAYER 1 — NOT NULL` tests asserted `23502` on an
  insert that omitted a tenancy column, and got `42501` instead: the omitted column defaults to NULL, so the policy's
  `company_id::text = current_company` evaluates to NULL rather than true and RLS refuses the row **before** any
  constraint is reached. The code was right; the test's claim was not. `NOT NULL` is the backstop for paths where RLS
  does not apply (a superuser migration, a backfill, a later-loosened policy), so it is now proven **structurally**
  against `information_schema.columns` — the column cannot be nullable — with the runtime test accepting either
  SQLSTATE, because which guard wins is an ordering detail rather than a guarantee. Recorded as CDR-049 §3-G3a.
- **The catalog suite's `EXPECTED_GRANTS.jobs` wrongly listed `UPDATE`.** A **column-level** grant never appears in
  `information_schema.role_table_grants` — the same reason `provisioning_steps` and `interview_sessions` show none
  there, which that file's own comments state. The table-level expectation is `INSERT`/`SELECT`; the column-scoped
  `UPDATE(state, updated_at, attempts)` is asserted against `column_privileges`, where it was already covered.

## Standing note

No doubt on this sub-scope required escalation. The one genuine tension — whether a runner library should own the job
table — was settled decisively by existing canon (the ADR-008 amendment), not by a judgement call, so it was a reading
to record rather than a gate to raise.
