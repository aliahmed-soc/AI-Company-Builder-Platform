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

1. CDR-060 + branch + draft PR.
2. Contracts: artifact provenance + the size cap + the content-addressed key derivation — TDD, pure.
3. Migration: `artifacts` (company-owned, dual-keyed FORCE RLS, provenance NOT NULL, content hash unique per company)
   + repository + reset-list/catalog sweep; real-PG.
4. Core `persistArtifact` with the no-hollow-success rule and the in-memory adapter; real-PG proof of prefix
   isolation, idempotent re-write, and that a failed object write fails the task.
5. Docs + **TWO** independent review passes + finalization.
