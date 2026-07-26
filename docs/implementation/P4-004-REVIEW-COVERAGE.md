# ACBP-P4-004 — independent review coverage

Ticket: **ACBP-P4-004** task dependencies and board (TASK-001 views). Branch `p4-004-task-dependencies-and-board`,
PR **#42**, CDR-042.

Both passes returned **FAIL**. Across them, **four of the ten most serious findings were defects in my own review
fixes rather than in the original code** — the pattern that makes the second pass non-optional.

## The design decision both passes upheld

TASK-001 names six states; P4-002 implemented eleven. Pass 1 was asked to attack that head-on and confirmed the CDR's
reading on three independent grounds: `raw-audit/evidence/task-states.csv` records four of the six as **empty tabs**
("existence observed; instances unknown"), so the 97-confidence rating is backed by *tab existence*; TASK-001's
acceptance clause is entirely about transitions, which is P4-002's obligation and already met; and the backlog scopes
this ticket to `TASK-001 (views)`. Adding a `recurring` or `rejected` state would have been fabrication.

Pass 1 also attached a condition worth recording: because two of the six buckets are unreachable in this version,
**TASK-001 is not satisfied by this ticket** — it is honestly partially deferred to PLAN-003/TASK-003 (Post-MVP) and
P4-005. The board is lossy but non-destructive: `BoardTaskDTO.task.state` still carries the exact internal state.

## Pass 1 — FAIL (0 Blocker, 0 Critical, **3 High**, 3 Medium, 4 Low)

### HIGH-2 — the page limit was applied before drafts were filtered

The board read an **unfiltered**, newest-first task page. Drafts are rows, and being newest they sort *first*. A
planning run minting 200 drafts against `DEFAULT_LIMIT = 200` would have produced a page of 200 drafts and zero board
tasks: **every bucket empty**, `truncated: true`, while the company held 30 `planned` and 5 `running` tasks that were
simply invisible.

This is exactly the "a task in no bucket is invisible" failure G5 exists to prevent, arriving through the pagination
door instead of the projection door. No test caught it because every fixture had ≤2 drafts. Fixed: `listBoardPage`
excludes drafts in SQL, `countDrafts` reports them separately, so the limit bounds **board** rows (**G11**).

### HIGH-3 — the blocked flag was systematically wrong under truncation

Prerequisites are by construction *older* than their dependents, and the page is newest-first — so prerequisites are
the first rows dropped when a board truncates. Failing closed on an unfetched prerequisite is the safe direction, but
it meant that on any truncated board essentially every dependent read as blocked. An owner would reasonably conclude
work was gridlocked. Fixed: `findStatesByIds` resolves off-page prerequisite states, so the flag is a fact (**G12**).

### HIGH-1 — the backlog was flipped to `Done` before the review passes finished

Contradicting PROJECT-STATE's own "CORE DONE / IN REVIEW", and — given the condition above — a `Done` row risked
reading as "TASK-001 satisfied". Reverted; the flip now happens only in the finalization commit.

### Medium / Low

| # | Finding | Resolution |
| --- | --- | --- |
| M-4 | Edge query was company-wide and unbounded while the page was capped | scoped to the rendered page's ids (**G13**) |
| M-5 | Draft endpoints surfaced in `blocksTaskIds`, putting preview work on the board sideways | filtered from display (**G14**) — see pass 2, this fix was itself wrong |
| M-6 | G5's "compile-exhaustive switch" claim was **false**: `switch (state as TaskState)` never narrows, so `default` was unchecked and a twelfth state would compile clean into `unplaceable` | narrowed with `isTaskState` before the switch so `default` assigns to `never`; CDR corrected rather than left overstating |
| L-7 | Raw `params.companyId` used for a query while the resolver trims → `22P02` on an authorized read | trimmed once at the top |
| L-8 | `NaN` limit propagated through both clamps into SQL | non-integers replaced with the default, not clamped |
| L-9 | `toBeDefined()` over a `Record` type — vacuous | now asserts the value is one of the two legal labels |
| L-10 | No test had one task blocking two dependents; a last-writer-wins reverse index would have passed the suite | added |

## Pass 2 — FAIL (0 Blocker, 0 Critical, **2 High**, 2 Medium, 4 Low)

### 2H-1 / 2H-2 — pass 1's own M-5 fix turned fail-CLOSED into fail-OPEN

One root cause. Filtering draft and unresolvable endpoints out of the `dependsOn` index **before** deriving the blocked
flag means `isDependencyBlocked([])` returns `false` — so a prerequisite that could not be resolved, or one still an
unconfirmed draft, **unblocked** its dependent. The board would report work as ready to run while its input does not
exist yet.

Strictly worse than the id leak it was fixing, and in direct conflict with G7 and G12. Reachable with **no race**:
create A (draft), create B (draft), `addTaskDependency(B → A)` — legal, no state requirement — then `planTask(B)`.

Fixed by the rule now written into **CDR-042 §3-G14**: **filter for display, derive over the full set.** The draft's
id stays hidden; the derivation still sees it and blocks.

### 2M-3 — the test that named the property did not test it

`'a prerequisite whose state cannot be found at all still BLOCKS — fail closed'` supplied a state (`queued`), so it
passed on `queued !== 'completed'` and never exercised the fail-closed path. **A test that names a property it does
not test is worse than no test**, because it buys false confidence — and it is precisely what let 2H-1 through.
Corrected to supply nothing; it now fails against the pre-fix code.

### 2M-4 / 2L-5 / 2L-6 / 2L-7 / 2L-8

| # | Finding | Resolution |
| --- | --- | --- |
| 2M-4 | Page-scoping bounded the edge query's PREDICATE but not its RESULT — one task may carry unlimited edges, and the harvested ids feed an `in (...)` that fails past Postgres' bind-parameter ceiling | explicit `MAX_EDGES` limit on the query |
| 2L-5 | `countDrafts` ran after the page read; each statement takes its own read-committed snapshot, so a task confirmed between them was counted as **neither** — invisible for that render | count first, so the residual skew is "briefly visible twice" (a task shown twice is confusing; a task shown nowhere is a lie) |
| 2L-6 | `unplaceable` was documented as "could not classify", but a `draft` **is** classified | contract widened to "page rows that did not land in a bucket" |
| 2L-7 | `draftsOffBoard` became an unvalidated input once it stopped being derived | clamped |
| 2L-8 | The exhaustiveness `default` returned the narrowed state itself — at runtime a raw string where callers switch on `.kind`, i.e. a silent drop | keeps the `never` assignment, returns a proper placement |

### Confirmed correct by pass 2

The exhaustiveness narrowing; the `missing`-set computation (deduped, both directions, every edge has ≥1 on-page
endpoint); `listBoardPage` relying on RLS without a `company_id` predicate, which is **consistent** with the sibling
`list`/`findById`/`listDependencies` and enforced by the dual-keyed FORCE-RLS policy; the limit cast and the trim; and
no charter regression — no writes anywhere on the board path, tenant isolation intact, contracts still zero-dep, no
cycle, no secrets or PII.

## Verification

Local gate all exit 0: `typecheck`, `lint`, `check:secrets`, `check:boundaries`, unit **1112 passed / 0 failed**,
`git diff --check`, 0 mojibake.

Hosted CI on the exact head `aecad4d`: **1894/1894, zero skips** — including all 15 real-PostgreSQL board tests. Real
-PostgreSQL evidence is hosted CI, never the local run: these suites are discovered but skipped on the dev machine,
and a skipped suite is not a green one.
