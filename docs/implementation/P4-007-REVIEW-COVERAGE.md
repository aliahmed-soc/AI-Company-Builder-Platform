# ACBP-P4-007 — independent review coverage

Ticket: **ACBP-P4-007** Slice D integration, planned work (ROAD-001 / PLAN-001 / TASK-001). Branch
`p4-007-slice-d-planned-work`, PR **#44**, CDR-044.

Both passes returned **FAIL**. Pass 1 caught the journey quietly violating its own CDR; pass 2 caught an assertion
that would have passed on a board that bucketed every task wrongly.

Worth recording separately: **three field-name errors reached CI before either review pass ran**, and all three were
the same mistake — a hand-written type that was allowed to be wrong. That is a process finding, not just three bugs
(§ "What the CI round-trips actually taught" below).

## Pass 1 — FAIL (0 Blocker, 0 Critical, 1 High, 1 Medium)

### HIGH-1 — the journey mutated product state on the OWNER connection, which its own CDR forbade

CDR-044 §2-G3 said the owner/fixture connection is "used for evidence inspection only, never to prove a guarantee".
The journey then ran `update tasks set state = 'failed'` on it, to reach a state from which `repeatTask` is legal.

The move itself is necessary and defensible: repeat requires a FINISHED task, and nothing in this phase can finish
one — the terminal transitions are driven by execution, which is Phase 5. Skipping repeat until then would leave half
of TASK-008 unproven for two whole phases. But the rule as written did not permit it, and a rule the code visibly
breaks is worse than no rule: the next person reads the violation as precedent.

Resolved by stating the *real* rule rather than letting the code diverge from it. G3 now allows exactly two owner-
connection uses — inspect evidence, and set up a precondition the product genuinely cannot reach yet, marked as such
at the site — and forbids the third, demonstrating a product behaviour. The mutation carries that justification
inline.

### MEDIUM-1 — a dead injection

`SliceDOps` declared `listTasks`, wired through both the CI suite and the demo, and never called by the journey. An
injected dependency nothing uses is a false claim about what the slice exercises. Removed from all three.

## Pass 2 — FAIL (0 Blocker, 0 Critical, 1 High)

### HIGH-1 — "status inspectable" was asserted as "placed somewhere", which is not the same claim

Step 10 checked that `unplaceable === 0` and that the number of placed tasks matched the number confirmed. Both hold
on a board that puts every task in the **wrong bucket** — and "status inspectable" is precisely the acceptance
criterion that failure would violate. The assertion was measuring totality, which P4-004 already proves, and calling
it status.

Fixed: the journey now asserts the confirmed (`planned`) tasks appear in the `to_do` bucket specifically — CDR-042
maps `planned`/`queued` there, "work accepted and awaiting a start" — and that no board task reports a state other
than the one just confirmed. A misbucketing board now fails the step that claims to check bucketing.

## What the CI round-trips actually taught

Three consecutive CI failures, each one field name, each caught only by a real database several minutes in:

| # | Wrote | Contract says | Why the compiler missed it |
| --- | --- | --- | --- |
| 1 | `optionOrdinal` | `selectedOrdinal` | `request` was typed `unknown` |
| 2 | `blockedByDependency` | `dependencyBlocked` | declared **optional** in a hand-rolled subset, so the real DTO stayed assignable |
| 3 | `metadata` column | `payload` | raw SQL — no type at all |

The first two share a root cause: **a structural subset that is allowed to be wrong about a name is not a cheaper
version of the type, it is a silent one.** `@acbp/contracts` is zero-dep and was already a `@acbp/test-support`
dependency, so there was never a reason to hand-roll either shape. `SliceDBoard`/`SliceDDetail` are now aliases of
`TaskBoardDTO`/`TaskDetailDTO`, and the decision request is typed against `StrategyDecisionRequest`.

The third has no type to lean on, so it was fixed by *auditing every remaining assumption at once* rather than
continuing one-bug-per-run: all eight expected audit event names were checked against the registry (finding that
`task.planned` — which CDR-044 §5-G9 had listed in prose — **is not a registered event**), and the `first_phase`
scope was checked against the roadmap fixture to confirm both milestone ordinals stay plannable.

The lesson for the next integration slice: **the static audit belongs before the first push, not after the third
failure.** Local PostgreSQL is unreachable from this machine, so every CI round-trip costs roughly six minutes; the
audit costs minutes once.

## Requirement coverage

| Requirement | Clause | Journey step |
| --- | --- | --- |
| ROAD-001 | roadmap with goals + milestones, ordinal-sequenced | 5 |
| PLAN-001 | ≥3 prioritized tasks from the approved phase, each typed | 6 |
| PLAN-004 | run + input snapshot; per-task rationale, gaps rendered AS gaps | 7, 11 |
| TASK-001 | server-enforced transitions; every task bucketed; dependency + **status** visible | 8, 9, 10 |
| TASK-002 | type / created / description; controls per state | 11, 12 |
| TASK-008 | confirmed audited delete; repeat mints a NEW linked task | 12, 13 |
| Backlog | "Trail verified" — event SET in order, no content in payloads | 14 |
| Backlog | "Demo passes" | `pnpm demo:slice-d`, same implementation |

## Evidence

Hosted CI, exact head, **zero skips** — the only real-PostgreSQL evidence, since every `skipIf` suite is invisible
locally.

| Head | Run | Result |
| --- | --- | --- |
| `722799a` (journey + suite, pre-review) | 30235708580 | **1946 passed (1946)**, 0 skipped — all 14 steps green |
| final head (review fixes) | see PR #44 | recorded at merge |

The demo script itself was **not executed here**: local PostgreSQL is unreachable from this machine. Its guarantee is
that it drives the identical `runSliceDJourney` the CI suite asserts — which is the whole reason the journey is
implemented once.
