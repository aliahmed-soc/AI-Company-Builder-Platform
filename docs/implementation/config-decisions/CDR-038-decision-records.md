# CDR-038 — Immutable decision records (ACBP-P3-005)

Design record for ACBP-P3-005. Canon-derived; every non-obvious reading is documented in §6 rather than guessed.

## 1. What a decision record is (canon)

**STRAT-006** (`product-specification/REQUIREMENTS.csv`, Strategy / "Decision record", Must / MVP, deps
`STRAT-003;MEM-001`) — verbatim:

> "Every strategy selection/edit/rejection creates a durable decision record linking inputs, options considered, and
> rationale." Rationale: "Institutional memory of why." Acceptance: "Decision records are immutable, timestamped,
> linked to the understanding version, and visible in history." Fail: "Failed record writes block the transition
> (decision is not silently unrecorded)."

**J-08** (`MASTER-PRD-v1.md:375`): "select / edit / combine → re-rendered for confirmation → immutable decision record
links understanding version + options considered + rationale (STRAT-003/006). … Fail: record-write failure blocks
transition. Accept: **decision recorded before any planning**."

**WORKFLOW-STATE-MACHINES.md** (strategy `ready_for_review→selected`): actor owner only; precondition "decision record
write succeeds (STRAT-006 — record failure blocks transition)"; effects "planning unlocked; immutable decision"; audit
`strategy.selected` + `decision.recorded`.

**DATA-ARCHITECTURE.md** (Decision entity row): company-owned (`C`), `decision_id`, "links understanding version +
options considered + selection", state `recorded (terminal)`, class **I** (immutable), retention **permanent with
company**, event `decision.recorded`.

**ADR-015**: high-risk operations write their audit record in the SAME transaction — write failure blocks the action;
append-only, no mutation path through product APIs.

### Relationship to P3-004 (already merged)
`CDR-037 §6-G1` ratified the split: **P3-004 writes the SELECTION only** (`strategy_selections` + `strategy.selected`);
the immutable audit-grade Decision record (`decision.recorded`) is P3-005, and it **hardens on top of a recorded
selection**. P4-001 planning gates on the Decision, so J-08's "decision recorded before any planning" holds. P3-005
therefore does NOT re-model selection: it references the existing immutable selection row.

### What "record-write failure blocks the transition" means here
There is no mutable status column to flip — every strategy table is immutable append-only and "no decision = absence of
a row" (the P3-004 convention). The guarantee is realized as: **the `decisions` INSERT and the `decision.recorded`
audit write happen in ONE company-scoped transaction (audit-or-nothing)**. If either fails, nothing persists, no
decision row exists, and the downstream planning gate (P4-001, which reads for a **non-reject** decision — see §6-G1)
cannot pass.

**Precisely scoped:** what this ticket guarantees is that *a decision write never half-lands* — there is no state in
which a decision row exists without its audit event, or vice versa. It does **not** guarantee that every selection is
followed by a decision: selection (P3-004) and decision (P3-005) are separate owner operations in separate
transactions, per the already-accepted CDR-037 §6-G1 split. A client that records a selection and then never calls
`recordDecision` leaves a selection with no decision — which is exactly why **P4-001 gates on the decision, not on the
selection**: an unpaired selection is inert and unlocks nothing, so the STRAT-006 harm ("the decision is acted on but
not recorded") cannot occur. Composing the two writes into a single owner operation is a reasonable future
simplification, not a correctness fix.

## 2. Storage — migration 0025 (additive; one table)

Additive only: migrations 0001–0024 untouched, no new SECURITY DEFINER (the closed allowlist stays exactly three), no
new role, no BYPASSRLS, no policy change. The ONE change to an existing table is additive and reversed by `down()`:
a `UNIQUE(id, generation_id)` on `strategy_selections` so the composite FK below can reference it (the same trick 0023
used for `strategy_options`).

`decisions` — company-owned, dual-keyed FORCE-RLS, **IMMUTABLE** (`I`), SELECT+INSERT only (the
`strategy_selections` 0024 / `strategy_recommendations` 0023 pattern):

| column | notes |
| --- | --- |
| `id` | uuid PK, `gen_random_uuid()` — the `decision_id` |
| `account_id`, `company_id` | the dual key (RLS) |
| `generation_id` | FK `strategy_generations` — **"options considered" IS this generation's immutable option set** |
| `selection_id` | FK `strategy_selections` — the owner decision this record hardens |
| `mode` | IMMUTABLE snapshot of the hardened selection's mode, closed set `{select, edit, combine, reject}` (§6-G1) |
| `understanding_version` | integer snapshot — STRAT-006 "linked to the understanding version" |
| `rationale` | text NULL, bounded 1..4000 when present (§6-G2) |
| `created_by_user_id` | FK `users` |
| `created_at` | timestamptz `now()` — STRAT-006 "timestamped" |

- **Composite FK** `(selection_id, generation_id) → strategy_selections(id, generation_id)` so a decision can never
  reference a selection from a different generation. This requires an additive `UNIQUE(id, generation_id)` on
  `strategy_selections` (exactly the trick 0023 used for `strategy_options`); `id` is already the PK so the pair is
  trivially unique.
- FK cascade from generation/company/account; actor `no action`. CHECK `rationale is null or char_length between 1 and
  4000`. Index `(generation_id, created_at desc)`.
- Grants: `select, insert` to `acbp_app` — **no UPDATE, no DELETE** (immutable; mutation attempts fail, which is the
  STRAT-006 acceptance criterion). `ENABLE` + `FORCE` RLS; dual-keyed fail-closed `select`/`insert` policies.

## 3. The use case — `recordDecision`

Owner-only. Loads the generation + the named selection under company scope, snapshots the generation's
`understanding_version` and its option count, then persists ONE immutable `decisions` row + the `decision.recorded`
audit event in a single transaction. **No model call, no metering, no external resource** — pure persistence + audit.
Deny-by-default: an absent/invisible generation or selection, or a selection belonging to a different generation, is
`not_found`/`invalid` and persists nothing.

## 4. Audit + authz

- **Audit:** new event `decision.recorded` (schemaVersion 1, subjectType `decision`; subject = the decision id).
  Bounded metadata is **scalars only** (the `AuditMetadata` contract forbids arrays): `understanding_version`,
  `options_considered_count`, `mode` (the selection's mode). **Never** option content, chosen fields, reject reasons,
  the rationale text, or any PII. Written in-tx (ADR-015 audit-or-nothing).
  `packages/core/src/audit/audit-operations.ts` is compile-exhaustive, so `'decision.record' → 'decision.recorded'` is
  added to the partition.
- **Authz:** new closed action `decision:record`, **`owner`-only** — the `strategy:select` / `understanding:confirm`
  precedent (STRAT-003/J-08 "Actor: owner"). Reads reuse `strategy:read` (the decision is surfaced on the strategy
  read); a dedicated `decision:read` + Decisions list/get surface is deferred with the strategy HTTP/UI surface
  (CDR-026 §0).

## 5. What this does NOT unlock

Recording a decision writes a row and an audit event. It does **not** generate goals, a roadmap, milestones, or tasks —
that is **P4-001**, which must gate on a **non-reject** decision (`decisions.mode <> 'reject'`; §6-G1), not on the mere
existence of a decision row. It does not enforce `phase_scope` (a P3-004 flag;
enforcement is P4-003). It does not mutate the understanding, the selection, or the options — all remain immutable.

## 6. Ratified design decisions (canon-derived; documented, not guessed)

- **G1 — a `reject` selection DOES get a decision record, and the record snapshots its `mode`.** STRAT-006 is explicit:
  "Every strategy selection/**edit/rejection** creates a durable decision record"; the rationale ("institutional memory
  of why") applies most strongly to a rejection. J-08's flow lists only select/edit/combine because it describes the
  forward path, and it is the less specific source. A decision is therefore recorded 1:1 with ANY recorded selection.
  **The safety of this reading rests on the `mode` column**, so it is not left implicit: `decisions.mode` is an
  immutable snapshot of the hardened selection's mode, and **the P4-001 planning gate MUST key off a NON-reject
  decision** (`mode <> 'reject'`), never merely "a decisions row exists". Without the snapshot, a P4-001 implementer
  reading the obvious predicate would let a rejection unlock planning, contradicting WORKFLOW-STATE-MACHINES.md where
  `→rejected` is a distinct terminal state that routes back to understanding review. The column is denormalized
  deliberately: the latest selection may be a *different, later* one than the decision hardened, so re-reading
  `strategy_selections` at gate time can misreport the decision's own mode.
- **G2 — `rationale` is optional and owner-supplied.** STRAT-006 requires the record to link "rationale", but no canon
  pins a rationale-capture control at decision time (P3-004 captures reject `reasons` only; the STRAT-004 AI rationale
  is advisory). A nullable, bounded owner-supplied `rationale` satisfies the linkage without inventing a hard gate
  canon never specified — a missing rationale must never make a decision "silently unrecorded" (the STRAT-006 failure
  mode). The advisory model rationale is **never** auto-copied as the owner's reasoning (it would misattribute the
  model's reasoning to the owner).
- **G3 — the decision REFERENCES the selection; it does not re-capture it.** DATA-ARCHITECTURE says the Decision
  "links … selection" and CDR-037 §6-G1 says it "hardens on top of the recorded selection". `mode`, chosen fields and
  reasons are already immutably stored on `strategy_selections`; duplicating them would create two sources of truth.
- **G4 — "options considered" is the generation link, not a join table.** The generation's option set is immutable, so
  `generation_id` fixes exactly the options considered. The audit event carries the scalar
  `options_considered_count` (EVENT-CATALOG's `options_considered[]` shorthand cannot be metadata — arrays are
  forbidden there; this mirrors `strategy.generated`'s `option_count`).
- **G5 — append-only, latest-wins (no uniqueness constraint).** DATA-ARCHITECTURE marks the Decision state "recorded
  (terminal)", but every sibling strategy table is append-only and the owner may legitimately revise. Append-only
  matches the established pattern and is the reversible choice: adding `UNIQUE(generation_id)` later is additive,
  whereas removing rows to satisfy a constraint added now is not.

## 7. Slice plan

1. CDR-038 + branch + draft PR + contracts (DecisionDTO, `decision.recorded` event + factory, `decision:record` authz,
   the audited-operations partition entry) + unit tests.
2. Migration 0025 (`strategy_selections` unique + `decisions`) + repo/schema/index + every reset list + catalog
   surfaces + a real-PG immutability/RLS/composite-FK suite.
3. Core `recordDecision` + surface the latest decision on the strategy read + a real-PG integration suite.
4. Docs + independent review (fix every finding) + finalization (exact-head CI → squash-merge → exact-main CI → delete
   branch).

## 8. Out of scope / deferred

Planning/roadmap/goals/milestones/tasks (P4-001); phase-scope enforcement (P4-003); a Decisions list/get HTTP route +
history UI (deferred with the strategy surface, CDR-026 §0); any model call or metering; any new SECURITY DEFINER,
role, or BYPASSRLS.
