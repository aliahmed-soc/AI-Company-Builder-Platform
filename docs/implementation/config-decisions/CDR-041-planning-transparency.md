# CDR-041 — Planning transparency (ACBP-P4-006, PLAN-004)

Status: proposed by the implementing session. Governs **ACBP-P4-006**. Depends on ACBP-P4-003 (merged `6274cd3`),
ACBP-P4-001 (`00a580d`), ACBP-P2-007 (`68f99e4`), ACBP-P2-006. Governing ADR: **ADR-015** (audit-or-nothing).

## 1. What canon asks for

**PLAN-004** (`product-specification/REQUIREMENTS.csv`), MVP, priority Should, dependencies **PLAN-001; MEM-003**:

> Each planning run shows what inputs it considered (memory items, metrics, prior results) and why the top tasks were
> chosen.
> **Acceptance:** Every planning run links its input snapshot and a rationale per proposed task.
> **Failure:** Missing rationale renders as 'not recorded' and counts against quality metrics.

`AI-AND-WORKER-ARCHITECTURE.md §1` fixes the component chain as **context assembly → template registry → gateway →
structured-output validation → domain validation → persistence → usage recording**, and defines context assembly as
building model context "from typed memory items (provenance-ranked …), understanding version, task inputs".

`CDR-040 §10` explicitly defers "the planning input snapshot and per-task rationale (**P4-006**, PLAN-004 — no
rationale is persisted here)" to this ticket. `EVENT-CATALOG.md` (the P4-003 note) records that P4-003 registered NO
event and that "**P4-006 owns the run/snapshot linkage (PLAN-004)**".

## 2. The load-bearing reading — planning must actually assemble context

P4-003's `generateTasks` builds its prompt from the roadmap milestones ALONE. It never calls `assembleContext`, so
today planning considers no memory items at all.

That makes PLAN-004 ambiguous on its face: "shows what inputs it considered" could be satisfied trivially by
snapshotting the roadmap and nothing else. **Rejected**, on three canonical grounds rather than preference:

1. **PLAN-004 depends on MEM-003** (memory provenance, "resolvable source link"). A snapshot that can never contain a
   memory item makes that dependency meaningless. Canon does not carry dead dependencies.
2. **§1 puts context assembly FIRST in the chain for every generation path.** Planning skipping it is a gap P4-003
   left, not a design P4-003 established — CDR-040 never claims to satisfy PLAN-004, and defers it here.
3. The requirement names the inputs it expects: "memory items, metrics, prior results".

So P4-006 **wires `assembleContext` into planning** and records what it returned. The alternative — snapshotting an
input set we know to be incomplete — would produce a transparency feature whose honest answer is always "the roadmap,
and nothing the founder ever told us", which inverts the requirement's stated user value ("trustworthy, inspectable
planning").

Scope discipline: this changes what planning READS, never how it validates, persists, gates, or ranks. Every P4-003
guarantee (STRAT-005 phase boundary, PLAN-001 minimum, partial honesty, no phantom tasks, no audit on drafts) holds
unchanged, and its tests stay green as written.

**Metrics and prior results are NOT in the snapshot.** No metrics subsystem exists (usage rollups are P6-009) and
"prior results" are task-run artifacts (Phase 5). The snapshot's shape is designed so both are additive later; a
`kind`-discriminated input list means adding them is an INSERT, not a migration.

## 3. Decisions (G-numbered, for review to argue with)

- **G1 — a planning run is a persisted first-class row.** `planning_runs`, written by BOTH `generateTasks` and
  `steerTaskPlanning` (PLAN-002 runs are planning runs too — they propose tasks, so "why these tasks" applies).
- **G2 — the snapshot links, never copies.** Rows store resolvable REFERENCES (`roadmap_id` + version, `decision_id`,
  `selection_id`, in-scope milestone ids, memory item ids) — never the assembled prompt text. Consistent with the
  charter's "raw payloads never persisted" and with MEM-003's "resolvable source link". A copied prompt would also
  duplicate content the secret blocklist already redacted once.
- **G3 — the run is recorded even when generation FAILS.** "Every planning run links its input snapshot" is
  unqualified, and a failed run is exactly the one an owner wants to inspect. This does NOT weaken "no phantom tasks":
  a run row is not a task. The run carries its own outcome (`ok` / `partial` / the P4-003 failure status).
- **G4 — per-task rationale is nullable and rendered "not recorded".** Never fabricated (ADR-019/TASK-002), matching
  how P4-003 already treats a missing `task_type`. The count of rationale-less tasks is surfaced on the result and the
  log line, the same honesty surface as `tasksMissingType`.
- **G5 — the output schema goes to `planning.tasks.output@2`.** Adding a field changes the contract the model is held
  to, and schema refs are the unit of versioning. `@1` is NOT retained: nothing persisted references it, and keeping a
  dead ref invites a caller to pin the version without rationale.
- **G6 — ONE new audit event, `planning.run_recorded`,** subject-typed `planning_run`, metadata scalars only
  (`{outcome, task_count, tasks_missing_rationale, memory_items_considered, milestones_in_scope}` — no titles, no
  rationale text, no memory content). This is the backlog row's "Snapshot linked in audit" and does not contradict
  CDR-040 §7: that rule says a DRAFT TASK is unaudited because it is not on the board. A planning run is not a task —
  it is a platform action taken on the owner's behalf, which is precisely what ADR-015 audits. Requires the four
  coordinated `AUDITED_OPERATIONS` edits (compile-exhaustive).
- **G7 — audit-or-nothing (ADR-015).** The run row + its inputs + its audit event are written in ONE transaction with
  the task drafts. An in-tx audit failure rolls back the whole planning result.
- **G8 — `assembleContext` gains an ADDITIVE return of the item ids it included** (and the ids it withheld for a
  MEM-004 conflict). It already resolves them; it simply does not surface them. No behavioural change: the same items
  are ranked, redacted, and withheld exactly as before, and P2-007's tests stay green unmodified. Withheld-on-conflict
  ids are recorded as *considered-and-withheld*, because "did not use it, and why" is transparency, not noise.
- **G9 — a context-assembly failure does not fail planning.** `assembleContext` returns `forbidden` only when
  `memory:read` is denied; `task:generate` is `['owner','viewer']` and `memory:read` may not be. Planning then proceeds
  with no memory items and the run records zero — degraded honestly rather than blocking a capability the owner has.
- **G10 — no HTTP route, no UI** (CDR-026 §0), no new role, no new SECURITY DEFINER, no BYPASSRLS.

## 4. Storage — migration 0028

| Table | Shape |
| --- | --- |
| `planning_runs` | company-owned, dual-keyed FORCE RLS, **immutable** (SELECT+INSERT only). FKs: `roadmap_id`+`company_id`, `decision_id`+`company_id`. Columns: `mode` (`autonomous`\|`steered`, closed CHECK), `outcome` (closed CHECK), `roadmap_version`, `phase_scope`, counts. |
| `planning_run_inputs` | company-owned, dual-keyed FORCE RLS, immutable. Composite FK `(run_id, company_id)`. `kind` closed CHECK (`memory_item`\|`milestone`\|`roadmap`\|`decision`\|`memory_item_withheld`), `ref_id`. The `kind` discriminator is what makes metrics/prior-results additive later. |
| `tasks.rationale` | ALTER, `text NULL`, bounded CHECK. INSERT-ONLY — the `(state, updated_at)` column grant stays untouched, as in 0027. |

Composite FKs carry `company_id` throughout: RI checks bypass RLS, so a same-tenant FK is the only thing preventing a
cross-tenant reference. Two new tables ⇒ the full reset-list sweep (~38 per-suite lists, two-tenant `ALL_TABLES`,
`catalog.adversarial` `TENANT_TABLES`/`EXPECTED_GRANTS`/no-column-UPDATE, `database.integration` existence), in
FK-safe child-first order: `planning_run_inputs → planning_runs → task_review_flags → …`.

## 5. Slice plan

1. CDR-041 + draft PR + contracts (`planning.tasks.output@2` with rationale, run/input DTOs, `planning.run_recorded`
   registration, authz) + unit tests.
2. Migration 0028 + schema/repo + every reset list + real-PG RLS/privilege/immutability.
3. `assembleContext` additive item-id return (G8) + its unit/real-PG coverage.
4. Wire into `generateTasks` + `steerTaskPlanning`: run row + inputs + rationale + audit, all in the persist tx.
5. Docs + independent review (fix every finding) + finalization.

## 6. Out of scope

Metrics and prior-result inputs (no subsystem yet — G2); quality-metric scoring of missing rationale (PLAN-004's
"counts against quality metrics" needs a metrics store, P6-009/P7-003); task dependencies + board (P4-004); task
detail/controls (P4-005); the Slice D demo (P4-007); any HTTP route or UI.
