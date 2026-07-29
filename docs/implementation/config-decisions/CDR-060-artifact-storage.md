# CDR-060 — Document and artifact storage: metadata first, no hollow success (ACBP-P5-011)

| | |
| --- | --- |
| Ticket | ACBP-P5-011 — Document and artifact storage |
| Requirements | TASK-005 (artifacts with provenance), NFR-014 |
| Decisions | ADR-016; CDR-048 (provider class, owner 2026-07-27); P0-019 + P0-005 (the port) |
| Trust-critical | **#2 — prefix isolation.** A tenant must never be able to read or write another tenant's object. |
| Resolves | **IOQ-11** (per-artifact size cap) as the configuration record the open-questions register requires |
| Owner gate | The CONCRETE provider adapter — see §4. Everything else lands here. |

## 0. Why this ticket became the bottleneck

The backlog lists P5-006/007/008 as depending on P5-005 alone. **Canon disagrees.**
`AI-AND-WORKER-ARCHITECTURE.md:37-39` gives all three MVP workers `artifact_write` in their tool list, and defines
each one's output as an artifact or a document. A research worker with nowhere to write its research is not a
research worker. So this ticket gates three others plus P5-012 (revision), and doing it first is dependency order,
not preference. The backlog's Dependencies column is incomplete against canon; that is worth recording rather than
silently working around.

## 1. What canon fixes

- **TASK-005 — no hollow success.** `FAILURE-AND-RECOVERY` row 7 is explicit: *"Artifact persist fails ⇒ **task
  fails** (no hollow success)"*. A task that reports completion while its output vanished is the worst failure mode
  this system has, because every downstream reader believes it.
- **Trust-critical #2 — prefix isolation.** Keys are tenant-prefixed and the derivation *"never derives cross-tenant
  keys"* (P0-019's own header). This is the property the whole ticket is judged on.
- **Content-addressed, idempotent** (the backlog's rollback column). Writing the same bytes twice is one artifact.
- **Open formats** (the objective). Markdown/JSON, not a proprietary blob.

## 2. Guarantees

- **G1 — THE METADATA ROW IS THE ARTIFACT.** An object in a bucket that no row points at is unreachable garbage; a
  row pointing at an object that was never written is a hollow success. The row is written **only after** the object
  write returns, in the same transaction as the task's completion — so a persist failure fails the task by
  construction rather than by a caller remembering to check.
- **G2 — the key is DERIVED, never accepted.** Callers supply a company scope and a logical name; the tenant prefix
  comes from the scope. There is no code path that takes a caller-supplied key, which is what makes trust-critical #2
  structural rather than a validation someone could skip.
- **G3 — content-addressed.** The object key embeds a sha256 of the bytes, so re-writing identical content is a
  no-op and a retry cannot produce a second artifact. This is also what makes the write safe to retry at all
  (`FAILURE-AND-RECOVERY` row 7: *"Content-addressed writes safe"*).
- **G4 — size is CAPPED, and the cap is recorded.** IOQ-11. See §3.
- **G5 — reads are SCOPED SIGNED URLs, never public.** CDR-048 forbids public bucket access outright, so a signed,
  expiring, prefix-scoped URL is the only browser read path. The port already models this (`SignedReadUrl` carries an
  absolute `expiresAt`, not a duration — a duration has to be added to something, and that something is where
  "expires in 15 minutes" quietly becomes "expires 15 minutes after whenever this was read").
- **G6 — provenance is REQUIRED, not optional.** Every artifact records which run, which worker and which model
  version produced it. An artifact whose origin is unknown cannot be trusted, corrected, or revised, and TASK-005
  asks for provenance by name.

## 3. IOQ-11 — the per-artifact size cap

The open-questions register says the recommendation is a *"sensible per-artifact cap (e.g., single-digit MB class)
set at P5-011 as config"*, and that "Unlimited" is rejected.

**Chosen: 8 MiB (8,388,608 bytes) per artifact.**

The reasoning, so a later reviewer can disagree with the argument rather than the number: MVP artifacts are
generated *documents* — research write-ups, business plans, comparison tables — in open text formats. A 8 MiB
markdown document is roughly a million words; nothing this system generates approaches it. The cap exists to bound
storage cost and to make a runaway generation fail loudly rather than quietly filling a bucket, not to constrain
legitimate output.

**This is an interim technical value, not an owner-ratified one** — the same standing as IOQ-12's budgets in
CDR-056 §3. It lives in `@acbp/config` so changing it is a config change, not a deploy.

## 4. THE OWNER GATE — the concrete provider adapter

This ticket delivers everything except one thing: **the real provider adapter**. Standing that up means a live
bucket, real credentials, and a provider account — every one of which is an owner gate under the charter.

So the shape is the FakeModelProvider pattern, which this repo has used successfully three times:

- the **port** already exists (P0-019 + P0-005) and is provider-neutral;
- this ticket adds an **in-memory implementation** used by every test, which is what makes the metadata semantics,
  the prefix isolation and the no-hollow-success rule provable *today* against a real database;
- the **R2/S3 adapter** is a separate, later, owner-gated step. It is a class implementing an interface that already
  exists — deliberately the smallest possible remaining piece.

Nothing here claims object storage works against a real bucket. What it claims is that the *semantics around it* are
correct and enforced, and that the remaining piece is one adapter.

## 5. Slice plan

1. ~~CDR-060 + branch + draft PR.~~ **Done** — `7493717`.
2. ~~Contracts: artifact provenance + the size cap + the content-addressed key derivation — TDD, pure.~~ **Done** —
   `666f664`.
3. ~~Migration: `artifacts` + repository + reset-list/catalog sweep; real-PG.~~ **Done** — `4ed102a` (table, repo,
   40 reset lists, grant catalog) + `76cbdf2` (14 real-PG tests).
4. ~~Core `persistArtifact` with the no-hollow-success rule and the in-memory adapter.~~ **Done** — `af54e99`
   (`persistArtifact` + `InMemoryObjectStorage` + `verifyPersistedObject`), plus `88e4ed9` and `9759857`, which are
   the scope §6 addition below.
5. Docs + **TWO** independent review passes (`P5-011-REVIEW.md`, both done — `eeb0405`, `529ae08`) + finalization.
   **Finalization is blocked**: hosted CI has produced no run since the Actions billing limit was reached, and this
   ticket's 49 real-PG tests are unproven until it runs them zero-skip on the exact SHA.

### Deviation from the plan, deliberate: the uniqueness key

Slice 3 was planned as *"content hash unique per company"*. It shipped as unique per **(company, content hash, run)**.
The two-column form hands run B the row of an earlier run A whenever their bytes match, so the artifact would claim A
produced what B produced — provenance (G6) stated and not enforced. Keying on the run keeps retry idempotence intact
while every distinct run gets its own honest row pointing at the same deduplicated object.

## 6. Scope this ticket ABSORBED from canon: `task.completed`

Not in the original plan, and not optional. `EVENT-CATALOG` line 168 and `audit.ts` both recorded the same deferral in
the same words: `task.completed` requires `artifact_refs[]` (*"no artifactless completion"*, TASK-005), a succeeded RUN
is not a completed TASK, and the task completes when its artifact is persisted — *"which belongs to the ticket that
owns artifacts"*. **This is that ticket.** Leaving it would have shipped artifact storage while TASK-005 remained a
claim asserted in four documents and enforced in none.

- `validateCompletionEvidence` admits exactly the two shapes canon's wording permits — artifact refs, or an explicit
  no-artifact rationale — and `CompletionEvidence` has no third member, so the forbidden case cannot be constructed.
  **An empty artifact list is a refusal, not a synonym for "no artifacts"**: a worker that produced nothing will pass
  `[]` long before it thinks to pass a rationale.
- `completeTask` is where that guard is APPLIED, and it re-checks against the database — every cited artifact must
  exist, in this company, produced by this run. The shape check is perfectly happy with a well-formed id naming
  nothing, and the audit row would have faithfully recorded `artifact_count: 1` for it.
- The payload carries `artifact_count` + `no_artifact_rationale` rather than canon's literal `artifact_refs[]`, because
  audit metadata is scalars-only by design. The refs reach a reader through `run_id`, one join away, and cannot drift
  from the artifacts table. `0` + `true` makes an artifactless completion visible; `0` + `false` is unreachable.
