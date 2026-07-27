# CDR-043 — Task detail and controls (ACBP-P4-005, TASK-002 / TASK-008)

Status: proposed by the implementing session. Governs **ACBP-P4-005**. Depends on ACBP-P4-002 (merged; the eleven-state
machine + `tasks`/`task_dependencies`) and ACBP-P4-004 (merged `0a9aa08`; the board projection). Governing ADR:
**ADR-008**.

## 1. What canon asks for

**TASK-002** (MVP): "Each task exposes type, creation time, structured description, and controls appropriate to its
state." Failure: "Missing fields render explicitly as missing."

**TASK-008** (MVP): "Tasks can be repeated (re-queued as a new task) or deleted, with confirmation for delete."
Acceptance: "Repeat creates a linked new task; delete requires confirmation and is audited." Failure: "**Delete of a
running task is refused; cancel first.**"

The backlog row scopes this to `TASK-002;TASK-008`, with acceptance "Controls behave per state; repeat links lineage"
and security note "Delete confirmed; running-delete refused".

## 2. Load-bearing reading #1 — there is NO task "reject" control, and this ticket does not invent one

The backlog **Objective** field reads "Detail (type/created/description) + repeat/delete/**reject** controls". That
word is not backed by anything:

- **No requirement provides it.** `TASK-002` and `TASK-008` — the two the backlog row itself names — mention repeat
  and delete only. Across the whole requirement set, task rejection appears nowhere; the `reject` verb belongs to
  `UNDER-003` (understanding items), `STRAT-003` (strategy options) and `APPR-007` (approvals), all different objects.
- **The same backlog row's own Acceptance criteria** say "Controls behave per state; repeat links lineage" — no reject.
- **It was never observed.** `raw-audit/04-task-and-agent-system.md` records the detail view as showing status, `Type`,
  `Created`, a structured description, `Delete`, `Repeat`, and (for Todo) `Run now`. The same file lists "task
  rejection" under **"Controls not exercised"**, stating the audit "cannot establish their full runtime behavior".

So `reject` is shorthand in a summary field, contradicted by the acceptance criteria beside it and unsupported by any
requirement or observation. Building it would mean **inventing a state transition and a user-facing control from a
single word**, which is exactly the fabrication ADR-019 forbids.

**Consequence to record honestly:** CDR-042 §3-G3 said the board's `rejected` bucket was "empty by construction
because the reject control is ACBP-P4-005". That is now corrected — the bucket stays unreachable because **no
requirement defines task rejection at all**, not because it is merely pending. TASK-001's `Rejected` bucket therefore
remains declared-but-unreachable indefinitely, and the board already renders it as `not_in_this_version`.

## 3. Load-bearing reading #2 — "delete" cannot be a DELETE, and must not widen a pinned grant

`tasks` (migration 0021) grants the app role SELECT + INSERT + a **column-level UPDATE on exactly
`(state, updated_at)`**. There is no DELETE privilege, and the adversarial catalog suite pins that exact grant set.

Three options were considered:

1. **Grant DELETE.** Rejected: destroys history, defeats the audit trail TASK-008 itself demands, and `task_dependencies`
   / `planning_run_inputs` reference tasks.
2. **Add a `deleted_at` column and widen the UPDATE grant.** Rejected: widening a grant the tenant-isolation suite pins
   is a security-relevant change, and P4-003 §8-G9 already declined to widen it for a *feature* (J-10 priorities).
3. **A separate append-only `task_deletions` table.** **Chosen** — and it is the established precedent: CDR-039 chose
   exactly this shape for `task_review_flags`, for exactly this reason ("a separate append-only table rather than a
   column on `tasks`, because `tasks` grants only UPDATE(state, updated_at) and the adversarial catalog suite pins
   that exact grant set").

So deletion is a **recorded fact, not an erasure**. The task row survives; reads exclude it.

## 4. Decisions (G-numbered)

- **G1 — delete is a soft, append-only record.** `task_deletions` (company-owned, dual-keyed FORCE RLS, SELECT+INSERT
  only, UNIQUE on `task_id` so a repeat delete is idempotent rather than a second row). Deleting is audited
  (`task.deleted`) in the SAME transaction as the record (ADR-015).
- **G2 — delete of a RUNNING task is refused, and the refusal names the remedy.** TASK-008's failure clause is
  explicit: "cancel first". The refusal is a typed result, not an exception. Extended to every non-terminal ACTIVE
  state — `running` plus the four hold states — because a task waiting on an approval is equally mid-flight; a
  `queued` task is not yet executing and TASK-007 owns cancellation, so it deletes cleanly.
- **G3 — "confirmation" is the CALLER's obligation, expressed as an explicit parameter.** The use case takes
  `confirmed: true`; anything else is refused as `confirmation_required`. Canon says delete "requires confirmation";
  a core use case has no UI, so the honest encoding is a required, explicit acknowledgement rather than a comment
  saying the UI should ask. This makes an unconfirmed delete impossible to perform by accident from any caller.
- **G4 — repeat creates a NEW task in `draft`, linked to its source.** "Re-queued as a new task" (TASK-008) means a
  new row, never a state rewind: the original's history stays intact. `draft` is the canon-native minting state
  (CDR-033 §4); the owner confirms it onto the board exactly as with any other new task. Migration 0029 adds
  `tasks.repeated_from_task_id` — nullable, tenant-pinned composite FK, **INSERT-ONLY** (the `(state, updated_at)`
  grant is untouched), matching `task_type`/`priority`/`rationale`.
- **G5 — repeat copies CONTENT, never provenance or outcome.** Title, description, type and milestone carry over;
  `priority`, `rationale`, state and timestamps do not. A repeat is new work, and inheriting the source's planning
  rationale would attribute a model's reasoning about one task to a different one (ADR-019).
- **G6 — a DELETED task cannot be repeated, and repeating a task does not resurrect it.** Repeat reads the source; if
  the source is deleted the control is refused. Otherwise a deleted task could be silently revived through a link.
- **G7 — the detail view states which controls are AVAILABLE and why not, per state.** TASK-002 wants "controls
  appropriate to its state"; the honest form is a derived, closed set of `{control, available, reason}` rather than a
  bare list, so a UI can explain "delete: unavailable — cancel the running task first" instead of hiding the button.
  Derived, never stored (the `isFullyExplained` / `isDependencyBlocked` precedent).
- **G8 — missing fields render as MISSING.** TASK-002's failure clause. `taskType`, `description`, `milestoneId`,
  `priority` and `rationale` are already nullable and already surface as `null`; the detail DTO adds no defaulting.
- **G9 — deleted tasks disappear from the board and the list, and are EXCLUDED from the draft count.** A deleted task
  is not off-board-but-pending; it is gone. The board's `draftsOffBoard` must not count deleted drafts, or an owner
  would be told preview work exists that they cannot reach.
- **G10 — two new audit events**, `task.repeated` and `task.deleted`, scalars only (no titles, no descriptions).
  "Controls audited" is the backlog's own requirement. Four coordinated `AUDITED_OPERATIONS` edits each.
- **G11 — no HTTP route, no UI** (CDR-026 §0); no new role, no new SECURITY DEFINER, no BYPASSRLS.
- **G12 — ONE new authz action, `task:delete`, `owner|viewer`.** Decided during Slice 3, recorded here.
  - *Why owner|viewer, not owner-only.* The backlog row's Data-scope is "Company-scoped" and TASK-008 says nothing
    about role, so an owner-only gate would be an invented requirement. The sibling task actions (`task:create`,
    `task:read`) are both `owner|viewer`, and a member who may create work should be able to withdraw it. Deletion is
    append-only and audited, so the grant destroys nothing.
  - *Why a distinct action rather than folding into `task:create`.* Delete is the only task control that removes work
    from view. Naming it makes a future owner-only tightening a one-line policy change; folding it in would make that
    a refactor. This is the reversible direction.
  - *Why REPEAT adds no action.* It mints a task, which is exactly what `task:create` authorizes — the same reasoning
    that folded `task:depend` into `task:create` (CDR-033 §4). Inventing `task:repeat` would add a policy surface with
    no distinct policy behind it.
  - The DETAIL read reuses `task:read`. Confirmation (G3) is checked BEFORE the task is read, so an unconfirmed delete
    cannot serve as an existence oracle for task ids.

## 5. Storage — migration 0029

| Change | Shape |
| --- | --- |
| `task_deletions` (new) | company-owned, dual-keyed FORCE RLS, SELECT+INSERT only. `UNIQUE(task_id)`; composite FK `(task_id, company_id) → tasks(id, company_id)`; bounded optional `reason`. |
| `tasks.repeated_from_task_id` | ALTER, `uuid NULL`, tenant-pinned composite FK to `tasks(id, company_id)`, INSERT-ONLY. |

`tasks` needs an additive `UNIQUE(id, company_id)` for those composite FKs (the 0025/0026/0028 precedent). One new
table ⇒ the full reset-list sweep, child-first: `task_deletions` before `tasks`.

## 6. Slice plan

1. CDR-043 + draft PR + contracts (control availability projection, repeat/delete results, the two audit events).
2. Migration 0029 + repo + every reset list/catalog + real-PG RLS/privilege/immutability.
3. Core `repeatTask` / `deleteTask` / detail read + board and list exclusion + real-PG integration.
4. Docs + TWO independent review passes (fix every finding from both) + finalization.

## 7. Out of scope

Task rejection (§2 — no requirement defines it); `Run now` / manual execution (**TASK-004**, needs the credit
preflight); cancellation and safe-stop (**TASK-007**); failure detail (**TASK-006**); retry policy (**TASK-010**);
the Slice D demo (**P4-007**); any HTTP route or UI.
