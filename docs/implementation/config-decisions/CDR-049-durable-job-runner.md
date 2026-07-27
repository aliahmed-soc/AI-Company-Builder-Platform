# CDR-049 — Durable job runner and checkpoints (ACBP-P5-001, NFR-005 / NFR-007)

Status: proposed by the implementing session. Governs **ACBP-P5-001**, which the owner ratified on 2026-07-27 as a
**three-way split**, each sub-scope separately reviewable. Governing ADRs: **ADR-008** (accepted with amendment),
**ADR-020**. Security: **invariant 3** (tenant context mandatory), **trust-critical #3**.

## 1. The ratified split

| Sub-scope | Owns | Acceptance clause |
| --- | --- | --- |
| **P5-001a** — job store + tenant stamping | The `jobs` table; every job carries account + company; a job with no tenant context is REFUSED, not defaulted | *"context-stripped job refused"* (trust-critical #3) |
| **P5-001b** — checkpoints and resume | Checkpoint records; crash mid-job resumes from the last checkpoint rather than restarting or double-executing | *"kill-and-resume green"* (NFR-005) |
| **P5-001c** — dead-letter and bounded retry | Retry cap (NFR-007); exhausted jobs reach a visible dead-letter state, never silently retried | *"cap = dead-letter"* |

This CDR governs all three; **this document's §4 is P5-001a's scope**, and b/c amend it when they land.

## 2. Load-bearing reading — WE own the job tables, the library does not

The Objective says "Postgres-backed jobs (**library per ADR-008**)", and ADR-008 names a "pg-boss/graphile-worker
class" library. Taken naively that suggests adopting a library and using *its* job table — which would be a serious
mistake here, because those libraries manage their own DDL, and a table we do not own cannot carry a `NOT NULL`
tenant stamp, dual-keyed FORCE RLS, or the refusal this ticket exists to deliver.

**The owner already decided this**, in the ADR-008 amendment and the ADR body:

> "job tables **remain standard SQL** (exit path)" — owner amendment, 2026-07-18
> "job semantics (idempotency, checkpoints) are **library-independent design**" — ADR-008 §13
> "Job rows carry **mandatory tenant context** (invariant 3)" — ADR-008 §5

- **G1 — the `jobs` table is ours, standard SQL, company-owned and dual-keyed like every other tenant table.** A
  runner library may later *poll and process* it; it may not own the schema. If the library owned the DDL, the
  "exit path" the owner made binding would not exist, and invariant 3 would drop from structural to advisory.
- **G2 — P5-001a therefore takes NO library dependency at all**, which is what makes it a clean sub-scope: the store
  and its tenancy guarantee are complete and reviewable before any runner exists. Choosing the specific library is
  deferred to the sub-scope that actually *runs* jobs, and is constrained by G1 to one that can operate over an
  externally-owned table.

## 3. Load-bearing reading — what "refused, not defaulted" has to mean

The acceptance clause is *"context-stripped job refused"*, and trust-critical #3 is *"jobs refuse missing context"*.
The failure being excluded is a job that loses its tenant context somewhere in the enqueue path and gets a plausible
default — the current company, the first company, `NULL` treated as "system" — and then executes against the wrong
tenant. Defaulting is worse than crashing, because it succeeds.

- **G3 — enforced at THREE layers, deliberately redundant**, because each catches a different mistake:
  1. **`NOT NULL` on `account_id` and `company_id`.** A job row without tenant context cannot physically exist. This
     catches a bug that forgets the fields entirely.
  2. **Dual-keyed FORCE RLS `WITH CHECK`.** An insert must match `app.current_account` *and* `app.current_company`.
     This catches a caller that supplies *someone else's* ids — which `NOT NULL` cannot see.
  3. **A typed refusal in the use case.** Enqueue returns a refusal result rather than throwing an opaque error, so
     the caller is told plainly and the platform can alarm on it.
- **G3a — which layer fires first, established by hosted CI.** An insert that OMITS `company_id` is refused by RLS,
  not by `NOT NULL`: the column defaults to NULL, the policy's `company_id::text = current_company` evaluates to NULL
  rather than true, and the row is rejected as a policy violation before any constraint is reached. This does not make
  layer 1 redundant — it locates it. `NOT NULL` is the backstop for every path where RLS does **not** apply: a
  superuser migration, a backfill, a maintenance script, or a policy someone later loosens. It is therefore proven
  STRUCTURALLY (the column cannot be nullable, asserted against `information_schema.columns`) rather than by a runtime
  race between two guards, and the runtime test accepts either SQLSTATE because which one appears is an ordering
  detail rather than a guarantee.
- **G4 — `company_id` is `NOT NULL`, not nullable-for-future-account-jobs.** A nullable column would let "no company"
  become a legal state the moment anything wrote `NULL`, which is precisely the defaulting this ticket forbids. If an
  account-scoped job type is genuinely needed later (P6-009 usage rollups are the plausible candidate), that is an
  explicit decision with its own table or its own discriminator — not a hole left open now on the chance it is
  wanted.

## 4. P5-001a — the store

| Element | Shape |
| --- | --- |
| `jobs` | Company-owned, dual-keyed FORCE RLS. `account_id`/`company_id` NOT NULL and IMMUTABLE (no column UPDATE grant). |
| state | Closed CHECK set. `queued · running · succeeded · failed · dead_letter · cancelled`. |
| `kind` | Bounded text naming the work; validated against a closed set at the use-case layer, not the DB, so adding a job type is not a migration. |
| `payload` | `jsonb`, **references not secrets** (ADR-008 §11). Bounded size. |
| `idempotency_key` | Nullable, UNIQUE per company when present — the same logical job enqueued twice is one row (TASK-009/NFR-006). |
| grants | SELECT + INSERT + a column-scoped `UPDATE(state, updated_at, attempts)` only. Identity and payload immutable to the app role, exactly as `tasks` is. |

- **G5 — no DELETE grant.** Job history is the run trail the audit behaviour ("Run trail audited") depends on.
  Archival is a later, deliberate operation, not a routine capability.
- **G6 — the state set is closed and includes `dead_letter` from the start**, even though P5-001c implements
  reaching it. A state added later by migration is a state the earlier code never handled; declaring it now costs
  nothing and means b and c extend behaviour rather than reshape the table.

## 4b. What the two review passes changed (P5-001a)

Recorded here rather than only in the commit, because two of these are reasoning a later reader would otherwise have
to rediscover.

- **G7 — the tenancy refusal must be checked BEFORE scope resolution.** As first written, `enqueueJob` validated
  inside `runInCompanyScope`. But that function denies an absent or blank company id *itself*, so a context-stripped
  enqueue never reached the validator and came back `forbidden` — which is exactly what an authorization failure looks
  like. The acceptance clause is not merely "no row is written"; it is that the platform can *see* a job arriving with
  no tenant context. Hiding that inside `forbidden` defeats §3-G3.3 entirely.
  Only the TENANCY fields moved ahead of authorization, and only because they leak nothing: they report on the shape
  of ids the caller supplied, never on platform state. `invalid_kind` and `payload_too_large` stay behind the authz
  check, where a reason would be a genuine oracle. `validateJobTenancy` is therefore split out and `validateJobRequest`
  delegates to it, so the two can never disagree about what valid tenancy is.
- **G8 — the row is stamped from `scope.tenant`, not from the caller's params.** They are equal on this call path
  (membership was verified against exactly those ids), but equal by coincidence of the path rather than by
  construction — and this is the one sub-scope whose entire subject is that a job's tenancy is a grant, not a claim.
- **G9 — an unresolvable idempotency conflict is its own status, not a refusal reason.** Reporting
  `invalid_idempotency_key` for a key that was perfectly valid would send the caller to change it and retry forever.
  It should be unreachable, which is precisely why it has to stay distinguishable if it ever happens.
- **G10 — `JOB_STATES` in `@acbp/contracts` mirrors the CHECK**, with a real-PostgreSQL test asserting every declared
  state is accepted. The migration commits to the closed set for G6's reasons; a contract that stayed silent about it
  would leave a reader taking an absent list as the answer.

Two further defects were found by hosted CI rather than by reading: PostgreSQL will not infer a **partial** unique
index from a bare `ON CONFLICT` column list (42P10 — the arbiter must restate the predicate), and a **column-level**
UPDATE grant never appears in `information_schema.role_table_grants`, so the catalog suite's table-level expectation
for `jobs` is `INSERT`/`SELECT` with the column grant asserted separately.

## 5. Out of scope for P5-001a

Checkpoints and resume (**P5-001b**). Retry caps and the dead-letter transition (**P5-001c**). The runner library and
any polling loop. The workflow coordinator (**P5-002**). No new authz action beyond what enqueue needs, no HTTP
route, no UI.

## 6. Slice plan for P5-001a

1. CDR-049 + branch + draft PR.
2. Migration: `jobs` + RLS + grants + CHECKs; schema + repository; the reset-list/catalog sweep.
3. Core `enqueueJob` with the typed refusal; real-PostgreSQL proof of all three refusal layers (§3-G3).
4. Docs + **TWO** independent review passes + finalization.
