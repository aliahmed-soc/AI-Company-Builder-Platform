# CDR-064 — The revision workflow: lineage-linked runs, and an original that cannot be overwritten (ACBP-P5-012)

**Ticket:** ACBP-P5-012 · **Requirements:** TASK-005 (lineage), J-13 · **Governing ADR:** ADR-016 · **Depends on:**
ACBP-P5-011 (artifacts), ACBP-P5-014 (credit ledger), ACBP-P4-002/P5-002 (tasks and task runs)

## 1. What canon actually asks for

Four sources, and they agree:

- **ADR-016 §5** — *"Versioning: new version per revision, lineage-linked (J-13); no destructive overwrite."*
- **`AI-AND-WORKER-ARCHITECTURE.md:13`** — *"revisions (J-13) create lineage-linked new runs."*
- **`API-CONTRACTS.md:55`** (Documents row) — *request revision* takes **revision guidance**, returns **revision
  lineage**, is **Member (read), owner (revise)**, and the **revision request is idempotent**.
- **Backlog** — audit: *lineage audited*; usage: *new run metered*; failure: *original never overwritten*;
  acceptance: *revision lineage visible; both versions retained*.

So a revision is not an edit. It is a **new run**, on the same task, whose output is a new artifact, with a durable
link back to what it was revising and the guidance that asked for it.

## 2. Decisions

### G1 — Lineage lives in ONE place: `artifact_revisions`, keyed by the run it created

A revision request records: the original artifact, the guidance, who asked, and the **run it started**. An artifact
produced by that run is a revision of the original *because its `run_id` is that run* — the link is derived, not
copied.

**Rejected: a `revision_of_artifact_id` column on `artifacts`.** It reads more directly, and that is its whole
appeal. But it puts lineage in two places that can disagree — the column and the request row — and this repo has
already paid for that shape twice (`cancelled_by` and the tenant ids were kept out of audit payloads for exactly
this reason; CDR-058 kept the balance derived rather than stored for the same one). A revision run that wrote three
artifacts would need the column set correctly three times, and the one that was missed would be a document with no
visible ancestor. Derivation cannot drift.

The cost is one join to answer "what is this a revision of". That is a read-shape cost, paid once in the query, and
it buys an invariant.

### G2 — The original is untouched, structurally, not by discipline

`artifacts` has **no UPDATE grant at all — not even column-level** (CDR-060), and every column is `never` on update
in the schema type. "Original never overwritten" is therefore already true of the table and needs no new enforcement;
what this ticket must not do is introduce the first UPDATE path. **No migration in this ticket grants UPDATE on
`artifacts`.** The test that matters asserts the original row is byte-identical after a revision completes.

### G3 — Idempotent by key, and the key is per REQUEST, not per artifact

API-CONTRACTS says the revision request is idempotent. Requesting twice with one key yields **one** request, **one**
run and **one** charge; the second call returns the first request rather than an error, because a retried request is
an ordinary client behaviour and not a fault.

**REVISED IN SLICE 2, and the revision is the point.** Slice 1 planned a *partial* unique index targeted by
inference, copying P5-014. Writing the migration showed that was the wrong lesson to copy: `idempotency_key` is
**NOT NULL** on this table, because a revision request without a key is not a thing. P5-014's guard had to be
partial (`WHERE kind = 'reservation' AND idempotency_key IS NOT NULL`) only because there just *some* rows carry a
key — and PostgreSQL unique CONSTRAINTS cannot be partial, which is precisely how D1 happened.

Here the predicate is unnecessary, so `addUniqueConstraint('artifact_revisions_company_key_uq', ...)` is available,
and a **real named constraint is strictly better**: it is a legal `ON CONFLICT ON CONSTRAINT` target, so the D1 class
cannot arise at all. `tools/check-conflict-targets.mjs` agrees — it flags `.constraint(...)` only when the name
belongs to an index, and stays silent here.

The coupling also fails in the *safe* direction. Removing the constraint makes **every** insert raise `42704`
immediately and unmissably — demonstrated in slice 2. D1's danger was the opposite: a name that never existed,
failing only on a real database, on the money path.

**Scoped to the COMPANY, not the account.** The operation is company-scoped and the RLS is dual-keyed, so a key means
"this request, in the company I am acting in". Account-scoping would refuse a second company's legitimate reuse of a
client-chosen string.

**Not idempotent by `(artifact, guidance)` content.** Two genuinely separate revision requests with the same guidance
("make it shorter") are a real thing a founder does after reading the first result, and collapsing them would silently
refuse the second.

### G4 — Metered, because a revision is real work

*"New run metered."* The revision run reserves a credit through P5-014 exactly as any manual run does. Two
consequences taken deliberately:

- A revision **can be refused for insufficient credits**, and that refusal is honest — it reports balance and cost
  (TASK-004), it does not silently queue.
- The **reservation and the revision request are one transaction**. A request row whose run was never paid for, or a
  charge with no request, are both worse than a clean refusal.

### G5 — Owner-only, matching the Documents row

`artifact:revise` is a new authz action, **owner-only**. Members read documents; the owner spends credits. This
mirrors `strategy:select` (P3-004), which is owner-only for the same reason: it commits the company to work.

### G6 — The task must be able to take another run

A revision starts a new run on the task that produced the original. The task has finished, so this is the first
place in the system that starts a run on a **completed** task. Whether that is a new attempt on the same task or a
transition back into a runnable state is a **state-machine question owned by WORKFLOW-STATE-MACHINES**, and it is
resolved in slice 3 against the real state machine rather than guessed at here. The contracts in slice 1 do not
assume an answer: they name the original artifact and the guidance, and nothing about run numbering.

### G7 — Guidance is validated, bounded, and never audited verbatim

Guidance is founder prose. It is:

- **required and non-blank** — a revision request with no guidance is a re-run wearing a revision's name, and the
  worker would have nothing to do differently;
- **bounded** (`REVISION_GUIDANCE_MAX`), because unbounded caller text in a durable row is a storage and a log
  hazard;
- **never placed in the audit payload**, following `task.deleted`'s reason text (P4-005). `AuditMetadata` is flat
  scalars by design, and founder prose in an audit row is unbounded PII-adjacent text. The audit records THAT a
  revision was requested, by whom, of what — never the words.

## 3. What this ticket is NOT

- **Not the document API surface.** No HTTP route here; the use case is the unit of work, as in every P3/P4 ticket.
- **Not usefulness ratings (J-12).** The Documents row pairs them, but they are a separate concern with no lineage
  semantics, and nothing in this ticket's acceptance criteria mentions them.
- **Not an orphan/reconciliation sweep.** ADR-016 names one for orphaned objects; it is operational and unscheduled.

## 4. Slice plan

1. **CDR-064 + branch + draft PR + contracts** — guidance validation, the refusal taxonomy, the revision DTO, the
   `artifact:revise` authz action and the `artifact.revision_requested` audit event. TDD, pure, no database.
2. **Migration 0044** `artifact_revisions` — company-owned dual-keyed FORCE RLS, SELECT + INSERT only, tenant-pinned
   composite FKs to the original artifact and the created run, the partial unique idempotency index; repository,
   schema, every reset list and grant catalog; real-PG RLS/privilege/lifecycle proof.
3. **Core `requestRevision`** — owner gate, original-artifact lookup (RLS-confined, foreign reads as absent), the
   run-start question of G6 resolved against the real state machine, credit reservation and the request row in ONE
   transaction, audit-or-nothing; real-PG integration including the idempotency path and the insufficient-credit
   refusal.
4. **The lineage read + docs + TWO independent review passes + finalization.**

Every guard in every slice ships with a test **demonstrated to fail when that guard is removed** — remove it, watch
it go red, restore it, confirm the source is byte-identical to what was committed (standing rule, 2026-07-29).
