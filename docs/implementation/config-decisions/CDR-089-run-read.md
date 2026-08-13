# CDR-089 — the run read

**Status:** proposed · **Ticket:** ACBP-API-003 · **Base:** `main` at `bbf9f43` ·
**Origin:** CDR-088 §0.2 — the owner ruled this its own ticket rather than letting slice 2 author a core
read under a "pure exposure" framing.

**Number:** 089. 086 is claimed by ACBP-P3-006 on an unmerged branch; 087 and 088 are the two shipped
slices. Checked with `git ls-remote` before claiming, per the ACBP-P7-013 collision.

---

## §0 — What this ticket is, and how it differs from its two predecessors

**A DOMAIN ADDITION, NOT AN EXPOSURE.** CDR-087 and CDR-088 both stated "no new domain logic"; that
framing **does not apply here** and must not be inherited. This ticket authors a use case that does not
exist: repository read → authz action → result union → real-PostgreSQL integration tests → HTTP route.

### §0.1 — DISCOVERY FINDING: the entity is `task_runs`, and the directory name misled me
I proposed this ticket as "the run read" from the name of `packages/core/src/runs/`. The schema says
otherwise: the table is **`task_runs`** (migration `0035_task_runs.ts`), and a run is always a run OF A
TASK. There is no free-standing "run" entity.

**This is recorded because it nearly produced the wrong route.** Had the CDR been written before reading
the schema, §2 would have specified a shape derived from a directory name rather than from the data.

### §0.2 — But a run IS addressable on its own — verified, not assumed
`packages/database/src/task-run-repository.ts` exposes BOTH:
- `findById(runId): Promise<TaskRunRow | undefined>` — a run is addressable by its own id;
- `listForTask(taskId): Promise<TaskRunRow[]>` — and enumerable under its task.

So the already-shipped `GET .../runs/{runId}/artifacts` (CDR-088) is **consistent, not anomalous**: the
id in that path is a task-run id, and a sibling `GET .../runs/{runId}` is legitimate. Both routes below
are therefore backed by a query that already exists; only the USE CASE around them is new.

## §1 — Authorization: `run:read` must be AUTHORED, and must justify itself
A repo-wide search returns **zero** matches for `run:read`. It has to be added to
`packages/contracts/src/authz/authz.ts`.

**A new action needs a reason, not just a string.** That file's own comments set the standard — `task:delete`
is separate from `task:create` "because it is the only task control that removes work from view — a named
action makes a future owner-only tightening a one-line policy change instead of a refactor."

**DECISION: `run:read` is its own action, not folded into `task:read`.** A run carries execution detail a
task does not — worker identity, attempt counts, failure categories, stop requests. Folding it into
`task:read` would mean any future decision to restrict execution internals (to owners, or to operators)
becomes a refactor of every task read instead of a policy edit. **If review finds no case where the two
would ever diverge, this decision should be REVERSED and the action folded** — a separate action that can
never differ is ceremony, and the burden is on this CDR to justify it.

Grant: owner + viewer, matching `task:read`, until a reason to narrow appears.

## §2 — The two routes

| Route | Repository query | Notes |
|---|---|---|
| `GET .../runs/{runId}` | `findById` | one run's detail |
| `GET .../tasks/{taskId}/runs` | `listForTask` | newest first (P5-002) |

**A `TaskRunRow` IS A RAW DATABASE ROW, and CDR-088 §2.1a's lesson applies directly.** The approvals
inbox shipped an ALLOWLIST DTO for exactly this reason, and that guard is the one mutation-proven kill in
slice 2 (run `31638284349`). **The run read must map to an allowlisted DTO too** — named fields, never a
spread-and-delete, so a column added to `task_runs` later stays invisible until a human publishes it.

Fields to decide explicitly at implementation, each justified: run id, task id, state, attempt, timestamps,
failure category. **Excluded by default and requiring an argument to include:** worker identity, any
payload column, and internal scoping ids.

## §3 — Result shape
Tagged, like every use case except the two artifact outliers: `{ status: 'ok', … } | { forbidden } |
{ not_found }`. **Do NOT copy the bare-union shape** of `getArtifact` — CDR-088 §2.1a adapted around it and
recorded it as a hazard, not a pattern.

`not_found` stays DISTINCT from `forbidden` (CDR-088 §5). Within each granularity a foreign id and an
unknown one must be indistinguishable.

## §4 — The adversarial matrix, and what it can honestly claim
Extend the existing suite. G-cross, G-oracle at BOTH granularities (company and run id), G-malformed.

**`task_runs` seeds from a task, and tasks seed standalone** — proven in slice 2, where the task matrices
were the only ones able to assert data-invisibility. So **this matrix CAN make the stronger claim**: seed a
real run in company B and assert it stays invisible. The roadmap/artifact/approvals matrices could not, and
said so; this one has no such excuse.

## §5 — Mutation testing, with the partition already known
CDR-088 established it empirically: guards over an APPLICATION DECISION are mutation-provable; TENANT-
ISOLATION guards are RLS-enforced and structurally unmeasurable in app code.

**So mutate the DTO allowlist** (an application decision — the same class as the one kill that landed
cleanly), and **do not** burn runs mutating the cross-company guards, which will survive for the reason
already demonstrated by run `31643354339`. Record the unmeasurable ones with that reason rather than
leaving them silently unattempted.

## §6 — Verification standard
Real-PostgreSQL integration tests; hosted CI green with **zero skips** on the exact head; two independent
review passes; the local gate before every commit. Skipped is not green.
