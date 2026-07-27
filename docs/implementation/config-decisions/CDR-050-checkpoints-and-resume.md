# CDR-050 — Checkpoints and resume (ACBP-P5-001b, NFR-005)

Status: proposed by the implementing session. Governs **ACBP-P5-001b**, the second of the three sub-scopes the owner
ratified on 2026-07-27. Governing ADR: **ADR-008**. Extends **CDR-049**, which owns the `jobs` table and the tenancy
guarantee; nothing here revisits that.

Branched from `p5-001a-job-store-tenant-stamping` rather than `main`, because b extends a's table and a is not yet
merged (its finalization is an owner gate). If a changes, b rebases.

## 1. What this sub-scope owns

| Acceptance clause | *"kill-and-resume green"* (NFR-005) |
|---|---|
| In scope | Checkpoint records per job step; resuming from the last checkpoint rather than restarting; never double-executing a step already recorded complete |
| Out of scope | Retry caps and the dead-letter transition (**P5-001c**); the runner library and any polling loop; the workflow coordinator (**P5-002**) |

## 2. What canon actually requires

Verbatim, because the design follows from the exact words:

> "Checkpoints **per workflow step** enable kill-and-resume." — ADR-008 §5
> "resume from checkpoint if job intact … **Checkpointed steps idempotent**" — FAILURE-AND-RECOVERY row 4
> "Checkpoint inventory **vs plan** | Resume from checkpoint **or fail with partials labeled partial** | Steps
> **idempotent by checkpoint design**" — row 12
> "Metered **to checkpoint**" — rows 4, 12, 15, 16

- **G1 — a checkpoint is a record that a STEP COMPLETED, not a snapshot of progress.** "Steps idempotent by
  checkpoint design" only works if the presence of a checkpoint is what makes re-execution unnecessary. A checkpoint
  meaning "we got this far" would still leave the reader guessing whether the step's effect landed.
- **G2 — checkpoints are APPEND-ONLY and one per (job, step).** A step completes once. `UNIQUE(job_id, step_name)`
  makes a duplicate completion the *same fact* rather than a second row, so a crash between the effect and the
  checkpoint write resolves at the database rather than in a check-then-insert race (the P4-005 lesson).
- **G3 — resume computes the remaining plan by DIFFERENCE.** Row 12 says "checkpoint inventory **vs plan**": the
  caller supplies the ordered step plan, and resume returns the steps with no checkpoint. It does not store a cursor,
  because a cursor and the checkpoint set can disagree, and then two sources both claim to know what ran.
- **G4 — "metered to checkpoint" is a CONSEQUENCE, not a feature here.** It follows from G1: a step with a checkpoint
  was executed and therefore already metered. P5-001b records nothing about cost; it just does not re-run paid work.

## 3. The failure being excluded

Not "the job restarts" — restarting is merely wasteful. The failure is **double execution**: a step whose effect
already landed runs a second time after a crash, spending budget twice, or worse, repeating an external effect. That
is why the checkpoint is written **in the same transaction as the step's effect**, exactly as ADR-015 requires of
audit writes. A checkpoint written afterwards would leave a window in which the effect landed and the record did not.

- **G5 — checkpoint-or-nothing.** If the checkpoint write fails, the step's effect rolls back with it. The step then
  genuinely has not run, and re-running it is correct.

## 4. Shape

| Element | Shape |
| --- | --- |
| `job_checkpoints` | Company-owned, dual-keyed FORCE RLS, same as `jobs`. `UNIQUE(job_id, step_name)`. |
| grants | SELECT + INSERT only. **No UPDATE, no DELETE** — a completed step is a fact about the past. |
| `step_name` | Bounded text supplied by the caller's plan. Not a closed DB set: steps belong to job kinds, and adding one must not be a migration (the `jobs.kind` precedent, CDR-049 §4). |
| `output` | Optional bounded `jsonb`, references not content — a resumed step may need what the previous one produced. Same bound and the same "never secrets" rule as `jobs.payload` (ADR-008 §11). |
| tenancy | Stamped from the resolved scope, never from caller params (CDR-049 §4b-G8). |

## 5. Slice plan

1. CDR-050 + branch + draft PR.
2. Migration 0032: `job_checkpoints` + RLS + grants + CHECKs; schema + repository; the reset-list/catalog sweep.
3. Core `recordCheckpoint` (in-transaction with the step) + `resumePlan` (the inventory-vs-plan difference); real-PG
   proof including an actual **kill-and-resume**: crash mid-plan, resume, assert the completed step did not re-run.
4. Docs + **TWO** independent review passes + finalization.
