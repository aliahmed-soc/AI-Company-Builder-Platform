# Autonomous run log

Append-only. One entry per autonomous work window. Never overwrite a prior report.

---

## Window 3 — 2026-07-25

**Start:** ~2026-07-25 09:30 +03:00 (resumed mid-window from a compacted session; main = `55438de`)
**End of report:** 2026-07-25 ~17:05 +03:00
**Status at report time:** WORKING — continuing straight into window 4 per the owner's standing directive.

### Tickets completed

| Ticket | Squash SHA | PR | Exact-main CI | Result |
| --- | --- | --- | --- | --- |
| chore: `.gitattributes` LF normalization | `c645e8e` | #37 | green | Ends the recurring CRLF/NUL cleanup |
| **ACBP-P3-004** Selection, edit, combine, phase-limited approval | `50bbaa8` | #36 | run 30158606094 — **green, zero-skip (1665/1665, 148 files)** | Done |
| **ACBP-P3-005** Immutable decision records | `766b674` | #38 | run 30160181588 — **green, zero-skip (1695/1695, 150 files)** | Done |

Phase 3 is now **5/7** (only P3-006, blocked on the P2-011 owner gate, and P3-007 remain).
Migrations end **0025** on main. SECURITY DEFINER allowlist unchanged at 3.

### In progress at report time

**ACBP-P4-001** (goals, roadmap and milestones) — branch `p4-001-goals-roadmap-milestones`, draft PR **#39**,
head `199f303`. Both requirements implemented (ROAD-001 generation + ROAD-002 versioned edit), migration **0026**
(`roadmaps`/`goals`/`milestones`/`task_review_flags` + the tenant-pinned `tasks.milestone_id` FK). Independent review
returned FAIL (1 High, 6 Medium, 8 Low); **all High and Medium findings are fixed** and pushed; re-verification is
running. Remaining: re-review verdict → exact-head CI zero-skip → squash-merge → exact-main CI → delete branch.

### Checkpoints

- **c1** — `.gitattributes` merged; P3-004 contracts + migration 0024 landed.
- **c2** — P3-004 core + docs; independent review PASS after fixing one High.
- **c3** — P3-004 merged `50bbaa8`; exact-main CI green zero-skip; branch deleted.
- **c4** — P3-005 CDR-038 + contracts + migration 0025 + core; docs.
- **c5** — P3-005 review: Blocker + High + 3 Medium found and fixed; re-review PASS.
- **c6** — P3-005 merged `766b674`; exact-main CI green zero-skip; branch deleted.
- **c7** — P4-001 discovery, CDR-039, contracts, migration 0026, both core use cases, docs.
- **c8** — P4-001 review: 1 High + 6 Medium found; all fixed and pushed; re-verification in flight.

### Two self-inflicted defects worth the owner's attention

Both were caught **only** by the independent review — the local gate and CI were green throughout. Both are now
prevention rules in my persistent memory.

1. **UTF-8 mojibake across 36 files (P3-004).** A bulk edit used PowerShell `Get-Content -Raw`, which reads
   Windows-1252 in PS 5.1; re-saving as UTF-8 double-encoded every em-dash and box-drawing character. Functionally
   harmless (comments and string literals only) but it would have corrupted the test suite's history. Fixed by
   restoring from main and re-applying the one-line change with a UTF-8-safe writer.
2. **Backlog rows wrongly marked Done (P3-005).** Marking a ticket Done used a bare ticket-id regex, which also
   matched **inside other rows' Dependencies column** — silently flipping ACBP-P3-007 and ACBP-P4-001 to `Done`. The
   next window would have read the backlog and skipped planning and Slice C entirely. Fixed with a line-anchored edit;
   every backlog edit since is diff-verified to touch exactly one row.

### Design issues the reviews caught (worth knowing, all fixed)

- **P3-005:** the CDR claimed the planning gate keys off a non-reject decision, but nothing on the decision recorded
  the mode — so the obvious P4-001 predicate would have let a **rejection unlock planning**. Fixed with an immutable
  `mode` snapshot column, making the safety structural rather than a doc convention.
- **P4-001:** the roadmap **edit** path was ungated, so a rejection could be side-stepped by revising instead of
  regenerating. Fixed by gating the edit identically.
- **P4-001:** the new `tasks.milestone_id` FK was not tenant-pinned. Referential-integrity checks always bypass RLS,
  so one company could reference another's milestone. Fixed with a composite tenant-carrying FK.

### ⚠️ Disk space — needs the owner

**E: is 99.6% full — 0.97 GB free of 244 GB.** This repo is only ~1.6 GB of that; the rest is other projects on the
same drive. Nothing has failed yet (local gates and hosted CI are green), but `pnpm install --frozen-lockfile` is part
of the verification gate and could fail without warning at this level. I did **not** reclaim anything — it is outside
the ticket scope and deletions are irreversible. Candidates the owner may want to consider:

- `pnpm store prune` on the shared store at `E:\.pnpm-store\v11` (safe — re-downloads on demand)
- `$RECYCLE.BIN`
- `E:\AI-Company-Builder-Platform-duplicate-hold-2026-07-18` — an apparent stale duplicate of this repo

Per the owner's stop conditions this is **not** yet a stop ("disk space actually runs out, not just low"), so work
continues.

### Standing owner gates — untouched, as instructed

P2-011 (live model / paid API), P7-006 (live infrastructure), and P5-001 / P5-003 / P6-001 / P6-007 (owner DoR
split-review). Not attempted, not asked about.

### Nothing else needs the owner

No new owner gate was reached, no product-semantics question went unanswered (CDR-037's phase-limited-approval reading
was owner-approved; CDR-038 and CDR-039 resolved theirs from canon after searching the roadmap decision logs, not just
the requirement docs).

---

## Window 4 — 2026-07-25 (started ~17:05 +03:00)

Started immediately after the window-3 report, without pausing, per the standing directive.
Opening state: main = `766b674`, migrations end 0025, tree clean. Active: ACBP-P4-001 on
`p4-001-goals-roadmap-milestones` at `199f303`, awaiting review re-verification then finalization.

### Window 4 report — ended 2026-07-26 ~09:10 +03:00 (~16h elapsed)

Longer than 8h of wall-clock because the window spanned an interruption; work was continuous across it and the tree
was left clean and pushed at every boundary.

**Tickets finalized this window (3), each with exact-main CI green zero-skip:**

| Ticket | Squash | PR | exact-main CI |
| --- | --- | --- | --- |
| ACBP-P3-004 selection, edit, combine, phase-limited approval | `50bbaa8` | #36 | green zero-skip, 1665/1665 |
| ACBP-P3-005 immutable decision records | `766b674` | #37 | green zero-skip, 1695/1695 |
| ACBP-P4-001 goals, roadmap and milestones | `00a580d` | #39 | green zero-skip, 1755/1755 (154 files) |

Plus the one-time housekeeping commit `c645e8e` (`.gitattributes`, `* text=auto eol=lf`).

Phase 3 → 5/7. Phase 4 → 2/7. 53 tickets Done. Migrations end **0026** on main.

**In progress at the boundary: ACBP-P4-003** (task generation + chat steering) on `p4-003-task-generation`, draft
PR #40, CDR-040, migration 0027. Head `ed4be0c`, pushed, tree clean, hosted CI running on that exact SHA. All code and
docs complete; both independent review passes applied. Remaining: exact-head CI green zero-skip → mark PR ready →
squash-merge → exact-main CI green zero-skip → delete branch.

**Disk: E: 107.34 GB free** (C: 15.64 GB). Far above the 3 GB threshold — no cleanup performed or needed. This is a
large improvement on window 3's 0.97 GB; the owner appears to have freed space between windows.

**Three defects worth the owner's attention — all caught by review, not by me:**

1. **P3-005 MEDIUM-2 (design gap).** CDR-038 said the planning gate keys off a non-reject decision, but nothing on the
   decision recorded its mode. The obvious P4-001 predicate would therefore have let a **rejection unlock planning**.
   Fixed with an immutable `mode` snapshot column + closed CHECK before P4-001 was built on top of it.
2. **P4-001 H1.** `editRoadmap` reached a roadmap INSERT with no planning gate — a rejection could be side-stepped by
   revising instead of regenerating. Fixed by applying the same `classifyPlanningGate`; ratified as CDR-039 §7-G9.
3. **P4-003 second pass, 2 High.** My own first-round fix for a partial-commit hazard used a thrown sentinel error
   that **could never be caught** (`withAccountTransaction` re-wraps thrown errors, so the `instanceof` check was
   always false), and the test I added to prove it never reached the code path at all. Both are now fixed by removing
   the hazard rather than recovering from it: every milestone ordinal is resolved before the first insert, so there is
   nothing to roll back. The review-coverage doc records both, including that the first fix was wrong.

Two of my own process mistakes were also caught only by review and are now prevention rules in persistent memory:
UTF-8 mojibake from PowerShell 5.1 `Get-Content -Raw` (36 files, P3-004), and a backlog CSV regex that matched
mid-line and wrongly flipped two other tickets to Done (P3-005).

**Standing owner gates — untouched, as instructed.** P2-011, P7-006, P5-001, P5-003, P6-001, P6-007. Not attempted,
not asked about.

**Nothing needs the owner.** No new owner gate reached; no product-semantics question went unanswered by canon after a
thorough search of the roadmap decision logs and CDRs.

---

## Window 5 — 2026-07-26 (started 09:10 +03:00)

Started immediately after the window-4 report, without pausing, per the standing directive.
Opening state: main = `00a580d`, migrations end 0026 on main (0027 on the branch), tree clean.
Active: ACBP-P4-003 on `p4-003-task-generation` at `ed4be0c`, pushed, hosted CI in flight on that exact SHA.
Plan: finalize P4-003, then re-read the backlog and take the next Ready, unblocked ticket without stopping.

---

## WINDOW CLOCK RESET — new window started 2026-07-26 16:30:58 +03:00

The owner reset the window clock. This timestamp is a real system-clock read, not an estimate, and it **supersedes**
the previous window-5 start (09:10 +03:00) and its 17:10 boundary. The next boundary is
**2026-07-27 00:30:58 +03:00**, to be verified against the actual clock rather than inferred from work completed.

Why the reset: I had been reporting elapsed time by feel rather than by clock — at one point overstating it by about
35 minutes (claimed "~6h45m" when the true figure was 6h10m). Every elapsed figure from here is a measured read
against this recorded start.

**Disk at window start: E: 107.34 GB free** (C: 14.95 GB) — far above the 3 GB threshold; no cleanup performed or
needed.

### State carried into this window

- main = `b8dc466` (ACBP-P4-006 merged; exact-main CI green zero-skip 1846/1846; branch deleted).
- **56 tickets Done. Phase 4 → 4/7. Migrations end 0028.**
- Active: **ACBP-P4-004** (task dependencies and board, TASK-001 views) on
  `p4-004-task-dependencies-and-board`, draft PR **#42**, CDR-042 committed (`0d3ecf0`). Slice 1 (contracts) in
  progress.
- **ACBP-P0-005** ("Decide object-storage provider", Type: Decision) is treated as an OWNER GATE and left alone:
  selecting a provider is an architecture decision changing provider strategy. It is the only other unblocked
  non-gated backlog row, so it will keep appearing in Ready scans and will keep being skipped.

### Work completed in the previous (reset) window, 09:10 → 16:30

| Ticket | Squash | PR | exact-main CI |
| --- | --- | --- | --- |
| ACBP-P4-003 task generation + chat steering | `6274cd3` | #40 | green zero-skip, 1802/1802 |
| ACBP-P4-006 planning transparency | `b8dc466` | #41 | green zero-skip, 1846/1846 |

P4-006 ran two independent review passes, **both FAIL**, and three of the five findings across them were defects in my
own fixes rather than in the original code:

1. Pass 1 — the memory half of the planning prompt was **unbounded** while the roadmap half was capped. A truncating
   provider would have left the run linking memory items the model never read: fabricated traceability inside the
   feature whose entire purpose is an honest input snapshot.
2. Pass 1 — untrusted-origin memory arrived as `system` messages **ahead of** the instruction saying it is not
   instructions.
3. Pass 2 — two pass-1 fixes, each correct alone, combined to produce an invalid `('failed', null)` pair that the new
   shape CHECK rejects, destroying the run record on the gateway-failure-during-staleness path while the other fix's
   error swallow hid it. Pass 1 could not have found this: it reviewed a tree where neither change existed.

---

## WINDOW CLOCK RESET — new window started 2026-07-27 01:59:51 +03:00

Real system-clock read. **Supersedes** the previous 16:30:58 start and its 00:30:58 boundary. Next boundary:
**2026-07-27 09:59:51 +03:00**, verified by checking the clock at each report rather than inferred from work done.

**Disk at window start: E: 105.16 GB free** (the drive this repo lives on) — far above the 3 GB threshold, no cleanup
performed. **Note for the owner: C: is at 3.65 GB**, only just above the line. The repo and `node_modules` are on E:,
but the pnpm/npm temp paths and this session's scratchpad are on C:, so C: is the one that would actually break a
build first. Not cleaned (it is above the threshold), but it is the number to watch.

### State carried into this window

- main = `0a9aa08` (ACBP-P4-004 merged; exact-main CI green zero-skip 161/161 files, 1894/1894 tests; branch deleted).
- **57 tickets Done. Phase 4 → 5/7. Migrations end 0028.**
- Active: **ACBP-P4-005** (task detail and controls, TASK-002/TASK-008) on `p4-005-task-detail-and-controls`, draft
  PR **#43**, CDR-043 committed (`d987dcf`). Tree clean and pushed. Slice 1 (contracts) next.
- **ACBP-P0-005** ("Decide object-storage provider", Type: Decision) remains treated as an OWNER GATE — selecting a
  provider is an architecture decision changing provider strategy. It keeps appearing in Ready scans and keeps being
  skipped.

### Work completed in the previous window (16:30:58 → 01:59:51)

| Ticket | Squash | PR | exact-main CI |
| --- | --- | --- | --- |
| ACBP-P4-004 task dependencies and board views | `0a9aa08` | #42 | green zero-skip, 1894/1894 |

P4-004 ran two independent review passes, **both FAIL**, and four of the ten most serious findings were defects in my
own review fixes rather than the original code:

1. Pass 1 HIGH-2 — the page limit was applied to an UNFILTERED newest-first query, so a planning run's drafts would
   have rendered **every board bucket empty** while planned and running work existed. Every fixture had ≤2 drafts, so
   nothing caught it.
2. Pass 1 HIGH-3 — prerequisites are older than their dependents, so truncation dropped them first and every
   dependent read as blocked on any large board.
3. Pass 1 MEDIUM-6 — my own CDR claimed a compile-exhaustive switch that was not: `switch (state as TaskState)` never
   narrows, so a twelfth state would have compiled clean into `unplaceable`.
4. Pass 2 HIGH — my pass-1 fix filtered prerequisites BEFORE the blocked derivation, turning fail-CLOSED into
   fail-OPEN: work reported ready while its input did not exist. Reachable with no race at all.
5. Pass 2 MEDIUM-3 — the test named "still BLOCKS — fail closed" supplied a state, so it passed on
   `queued !== 'completed'` and never exercised the path. That is what let #4 through.

Also recorded on that ticket: **TASK-001 is NOT fully satisfied** by P4-004 — `recurring` and `rejected` stay
unreachable — so its `Done` row is not requirement coverage.

---

## Window 7 — 2026-07-27 (started 01:59:51 +03:00)

Continuing without pause, per the standing directive. Plan: finish ACBP-P4-005 (Slice 1 contracts → migration 0029 →
core use cases → docs + two review passes → finalization), then re-read the backlog and take the next Ready ticket.

### Window 7 end-of-window report

**Real clock: window started 2026-07-27 01:59:51 +03:00; 8-hour mark 09:59:51 +03:00.**
**This report was written at 2026-07-27 09:24:43 +03:00** — deliberately ahead of the mark so the log is not being edited
at the boundary itself. Work continued to the mark; anything after this timestamp is recorded in window 8.

**Four tickets merged, all with exact-main CI green and ZERO skips. Two phases completed.**

| Ticket | Squash | Exact-main CI | Note |
|---|---|---|---|
| ACBP-P4-005 task detail and controls | `d517203` | 1945/1945 | branch deleted |
| ACBP-P4-007 Slice D integration | `a214c4d` | 1946/1946 | **Phase 4 complete (7/7)** |
| ACBP-P3-007 Slice C integration | `ebbd8f1` | 1947/1947 | **Phase 3 complete** |
| ACBP-P5-010 structured-output hardening | `8239cc3` | 1954/1954 | branch deleted |

Backlog **60 of 101 Done**. Migrations end **0030**.

#### In progress at the boundary — ACBP-P5-009, branch `p5-009-gateway-v2-fallback`, draft PR #47

Slices 1–3 committed and pushed, tree clean, exact-head CI green (1954/1954) on the last pushed head that CI has
seen. Remaining: real-PG proof of migration 0030, the reset-list/catalog sweep for the new column, docs, and the two
review passes.

#### THE THING THE OWNER MOST NEEDS TO KNOW

**ACBP-P5-009 is the last remaining ticket that is both dependency-satisfied and not a standing owner gate.**
Computed over the whole backlog, not eyeballed: every other not-Done ticket is either one of the standing gates
(P0-005, P2-011, P5-001, P5-003, P6-001, P6-007, P7-006) or transitively blocked behind one.

So when P5-009 finishes, **stop condition #1 is reached** and autonomous work has nothing left it may legitimately
take. The gates that unblock the most downstream work are **P5-001** (durable job runner — unblocks P5-002 and the
whole execution chain through Phases 5 and 6) and **P0-005** (object storage — unblocks P5-011 → P7-001).

#### Findings worth the owner's attention

- **P4-005: "delete" could not be a `DELETE`.** `tasks` has no DELETE grant and its column UPDATE is pinned to
  `(state, updated_at)`. TASK-008 requires the delete be *audited*, so granting DELETE would destroy the evidence the
  requirement demands. Deletion became an append-only fact, and the catalog suite now asserts the **unchanged**
  grants in the same commit that added the feature.
- **P4-005 pass 2 found a race pass 1 had approved:** `deleteTask` was a check-then-insert, so a task read as
  `queued` that started running in the window was still deleted — precisely TASK-008's failure clause. Fixed with the
  state guard inside an `INSERT ... SELECT`.
- **P5-010 and P5-009 were both largely ALREADY IMPLEMENTED** by P2-003. Checked before building, per the standing
  rule. P5-010 became a conformance suite rather than a rebuild; P5-009's genuine gaps were only the fallback
  *reason* and the silent-fallback negatives.
- **A migration-safety catch on 0030:** the natural constraint (a reason exactly when `fallback_used`) would have
  passed in CI, where the schema is rebuilt each run, and **failed on the first real deployment carrying history** —
  rows predating the migration have `fallback_used = true` and no reason. Shipped one-directional instead.
- **Process:** P4-007 lost three CI round-trips to hand-rolled types that were allowed to be wrong about a field
  name (an *optional* field left the real DTO assignable, so the compiler stayed silent). Recorded, and P3-007 then
  lost one. The two newest suites are local unit tests and cost zero.

#### Disk (both drives, measured at the boundary)

**C: 22.22 GB free · E: 104.87 GB free.** Neither below the 3 GB line; no cleanup performed or needed. C: is
unchanged from the start of the window, so the build/test churn is not accumulating.

---

## Window 8 — 2026-07-27 (starts at the 09:59:51 +03:00 mark)

Continuing without pause, per the standing directive. Plan: finish ACBP-P5-009 (real-PG proof of 0030, the sweep,
docs, two review passes, finalization). That ticket is the last unblocked non-gated item in the backlog — when it
merges, every remaining ticket sits behind a standing owner gate, which is true stop condition #1.
---

# STOPPED — NEEDS OWNER

**2026-07-27 11:49:02 +03:00.** Window 8 ends here, and no window 9 is started.

**Reason: true stop condition #1.** Every Ready, unblocked, non-gated ticket in the backlog is Done. The only
remaining tickets whose dependencies are all satisfied are the standing owner gates themselves.

Final state: **61 of 101 Done**. Migrations end **0030**. `main` at `55f4c4e`, exact-main CI green **zero-skip
1964/1964**. Working tree clean, no open branches, no draft PRs left behind.

**ACBP-P5-009 merged** (squash `55f4c4e`, PR #47) as the last item of legitimate autonomous work, exactly as
predicted at the end of window 7.

Disk at stop: **C: 21.66 GB free · E: 104.87 GB free.** Neither near the 3 GB line; no cleanup needed.

## 1. Every remaining ticket, grouped by the gate that blocks it

Computed transitively over the dependency graph, not eyeballed. A ticket appears under every gate it is blocked by.

### ACBP-P5-001 — Durable job runner and checkpoints · blocks **24** (largest)

`P5-002` workflow coordinator · `P5-005` worker runtime · `P5-006` research worker · `P5-007` strategy worker ·
`P5-008` document worker · `P5-011` document/artifact storage · `P5-012` revision workflow · `P5-013` failure detail
and visible retries · `P5-014` run preflight and credit ledger · `P5-015` Slice E integration · `P6-009` account usage
rollups · `P6-010` limits and alerts · `P6-011` idempotency and replay hardening · `P6-012` Slice F integration ·
`P7-001` export · `P7-003` operational dashboards · `P7-004` alerting tiers · `P7-005` runbooks · `P7-007` security
test pass · `P7-008` failure-injection pass · `P7-009` E2E MVP suite · `P7-010` release gate · `P7-011` closed-beta
readiness · `P7-012` final model-evaluation gate.

### ACBP-P6-001 — Deterministic policy engine · blocks **16**

`P6-002` dispatcher enforcement · `P6-003` approval engine and inbox · `P6-004` payload binding/expiry/revocation ·
`P6-005` approval invalidation on edit · `P6-006` autonomy levels 1–2 · `P6-008` Decision Room · `P6-010` ·
`P6-012` · `P7-003` · `P7-004` · `P7-005` · `P7-007` · `P7-008` · `P7-009` · `P7-010` · `P7-011`.

### ACBP-P5-003 — Tool registry and dispatcher core · blocks **13**

`P5-004` worker definitions registry · `P5-005` · `P5-006` · `P5-007` · `P5-008` · `P5-011` · `P5-012` · `P5-015` ·
`P7-001` · `P7-009` · `P7-010` · `P7-011` · `P7-012`.

### ACBP-P0-005 — Decide object-storage provider · blocks **8**

`P5-011` · `P5-012` · `P5-015` · `P7-001` · `P7-009` · `P7-010` · `P7-011` · `P7-012`.

### ACBP-P6-007 — Emergency stop and resume review · blocks **7**

`P6-012` · `P7-002` deactivation flows · `P7-007` · `P7-008` · `P7-009` · `P7-010` · `P7-011`.

### ACBP-P2-011 — Discovery model-evaluation suite · blocks **2**

`P3-006` strategy evaluation area · `P7-012` final model-evaluation gate.

### ACBP-P7-006 — Staging validation and restore drill · blocks **2**

`P7-010` release-gate execution · `P7-011` closed-beta readiness.

### Ranked by leverage

1. **P5-001 (24)** — unblocks the entire execution chain. Nothing in Phase 5, 6 or 7 moves without it.
2. **P6-001 (16)** — but it sits behind P5-003, which sits behind P5-001. Not independently startable.
3. **P5-003 (13)** — behind P5-001.
4. **P0-005 (8)** — **independently decidable right now**; needs no other gate.
5. **P6-007 (7)** — behind P6-002 → P6-001 → P5-003 → P5-001.
6. **P2-011 (2)** — independently decidable; needs paid model access.
7. **P7-006 (2)** — independently decidable; needs live infrastructure.

**The single highest-value unlock is P5-001.** It is the root of the only long chain, and three of the other six
gates sit behind it. P0-005 is the best *parallel* unlock — it is a pure decision, blocks 8 tickets, and depends on
nothing.

## 2. Proposed DoR splits for the four owner-conditioned tickets

All four are **T-shirt L** and all four carry `Definition of Ready: Ready (owner-conditioned DoR split review
2026-07-18)`. Below is a concrete proposed split for each — something to approve or edit, not a blank page. Each
sub-scope is drawn from the ticket's own Acceptance criteria and Requirement IDs, and each is independently
reviewable and independently shippable behind the next.

### ACBP-P5-001 → three sub-tickets

Objective: *Postgres-backed jobs (library per ADR-008); checkpoints; tenant-stamped; dead-letter.*
Acceptance: *"Kill-and-resume green; context-stripped job refused."* Trust-critical #3.

| Proposed | Scope | Acceptance clause it owns |
|---|---|---|
| **P5-001a — job store + tenant stamping** | The job row model and migration; every job carries account+company; a job submitted with no tenant context is REFUSED, not defaulted. Invariant 3 chokepoint. | *"context-stripped job refused"* (trust-critical #3) |
| **P5-001b — checkpoints and resume** | Checkpoint records; crash mid-job resumes from the last checkpoint rather than restarting or double-executing. | *"kill-and-resume green"* (NFR-005) |
| **P5-001c — dead-letter and bounded retry** | Retry cap per NFR-007; exhausted jobs land in a dead-letter state that is visible and never silently retried; workflows README. | *"cap = dead-letter"* |

*Why here:* (a) is a security invariant that is fully testable with no durability machinery — it is the piece most
worth reviewing alone, and it is the one whose failure is silent. (b) is the durability property and needs a
kill-harness. (c) is terminal-failure policy. Shipping (a) first also means every later job write is tenant-stamped
by construction rather than retrofitted.

### ACBP-P5-003 → three sub-tickets

Objective: *Registry (risk classes) + dispatcher: allowlist deny-by-default, 100% call records, idempotency keys,
injection boundary.* Acceptance: *"Non-allowlisted denied; every call recorded; injection corpus zero executions."*
Invariants 4/17.

| Proposed | Scope | Acceptance clause it owns |
|---|---|---|
| **P5-003a — tool registry + risk classes** | Tool definitions, the closed risk-class set, and *unclassified ⇒ most restrictive*. Data + contract only; nothing dispatches. | classification correctness |
| **P5-003b — the dispatcher chokepoint** | Deny-by-default allowlist; 100% call records; tenant-stamped calls; idempotency keys. The single chokepoint (invariant 4). | *"non-allowlisted denied; every call recorded"* |
| **P5-003c — injection boundary + fail-closed hooks** | The injection corpus with zero executions; policy/approval hooks stubbed **fail-closed** for gated classes (invariant 17). | *"injection corpus zero executions"*; *"gate outage = fail closed"* |

*Why here:* (b) is the security property the whole ticket exists for and deserves an undiluted review. (a) is inert
data that (b) consumes. (c) is the adversarial surface and carries its own corpus — reviewing it alongside the
chokepoint implementation makes both harder to judge.

### ACBP-P6-001 → three sub-tickets

Objective: *Versioned rules; allow/require_approval/deny; evaluation records; most-restrictive-wins; fail closed.*
Acceptance: *"Same inputs same decision; forbidden beats approval; unavailability denies."*

| Proposed | Scope | Acceptance clause it owns |
|---|---|---|
| **P6-001a — policy model + versioning + evaluation records** | Versioned policy rows; append-only evaluation records (POL-006). Storage and immutability only. | evaluations append-only |
| **P6-001b — the decision function** | `allow / require_approval / deny`; most-restrictive-wins; determinism. A **pure function** — exhaustively testable with no I/O. | *"same inputs same decision; forbidden beats approval"* |
| **P6-001c — fail-closed integration + cap checks** | Engine unreachable ⇒ deny; cap checks read ledger counters. | *"unavailability denies"* |

*Why here:* the determinism acceptance clause lives **entirely** in (b), and (b) needs no database at all — the same
shape as `controlAvailability` and `placeOnBoard`, which were both far easier to review and to trust as pure
functions. Separating it means the most security-critical logic is reviewed without storage noise around it.

### ACBP-P6-007 → three sub-tickets

Objective: *All seven stop scopes; ≤5s halt; held-work queue; review-to-resume; fail-closed controller.*
Acceptance: *"All scopes halt ≤5s (timed); resume requires review."* Trust-critical #9/#10.

| Proposed | Scope | Acceptance clause it owns |
|---|---|---|
| **P6-007a — stop-state model + the seven scopes** | Stop states; scope-correct halting semantics; a scope never halts more or less than it names. | scope correctness |
| **P6-007b — timed halt ≤5s + held-work queue** | The measured guarantee and the drill harness that measures it; work held rather than dropped. | *"all scopes halt ≤5s (timed)"* (trust-critical #9) |
| **P6-007c — review-to-resume safety** | Resume requires review; **nothing auto-fires on resume**; expired approvals are not resurrected. | *"resume requires review"* (trust-critical #10) |

*Why here:* (b) is a *timing* guarantee and needs measurement infrastructure that has nothing to do with the resume
path; (c) is a distinct trust-critical concern about what happens *after* a stop, and is where the subtle failure
lives (silently resurrecting expired approvals). Reviewing them together would let a weak (c) hide behind a
convincing (b).

## 3. The three non-split gates, and what each needs from you

- **ACBP-P0-005 — object-storage provider.** A decision, not a build. Blocks 8 tickets, depends on nothing, and is
  the best parallel unlock. ADR-016 is already blocked on it, so roadmap/document content stays in Postgres until it
  lands.
- **ACBP-P2-011 — discovery model-evaluation suite.** Needs paid model access. Note that the *platform* is ready for
  it: the gateway is provider-neutral, and P5-009 deliberately deferred the concrete Sonnet adapter to this gate.
- **ACBP-P7-006 — staging validation and restore drill.** Needs live infrastructure (P0-003/P0-004 region and plans
  are Done, so the decisions exist; the environment does not).

## 4. What I did NOT do, deliberately

- No gated ticket was started, re-attempted, or partially explored.
- No busywork was manufactured — no speculative refactors, no coverage-padding, no docs written to look busy.
- No window 9 was started, because starting one would only have produced idle churn.

Everything is committed and pushed. Picking any gate above and unblocking it is enough to resume.

---

## Window 9 — 2026-07-27, ACBP-P5-001a (durable job store + tenant stamping)

**Real clock:** window resumed on the owner's unblocking decision; this report written at a checked
**2026-07-27 16:20:24**. **Disk, both drives, checked at the same moment:** C: **22.02 GB** free, E: **104.88 GB**
free. Both far above the 3 GB threshold, so no cleanup — the owner freed space after the earlier windows flagged it.

### What the owner unblocked, and what it opened

DECISION 1 approved P0-005 (merged last window, `b9f101b`). DECISION 2 ratified my own 3-way splits for **P5-001,
P5-003, P6-001, P6-007** as the DoR split-review, each sub-scope separately reviewable at the highest bar.
Re-running dependency reachability after both: **33 tickets reachable**, up from 0. Only P2-011 and P7-006 (and their
four dependents) remain genuinely blocked, exactly as the owner stated.

### Built: ACBP-P5-001a — the first of the twelve sub-scopes

Branch `p5-001a-job-store-tenant-stamping`, draft PR **#50**, CDR-049. Acceptance clause: *"context-stripped job
refused"* (trust-critical #3, invariant 3).

**The load-bearing call was that WE own the job table.** The Objective's "library per ADR-008" reads naively as
"adopt pg-boss and use its job table" — which would have been a serious mistake, because those libraries own their
DDL and a table we do not own cannot carry a `NOT NULL` tenant stamp or dual-keyed RLS. I did not raise this as a
gate, because canon already answers it: the owner's own ADR-008 amendment makes "job tables remain standard SQL (exit
path)" binding, and §13 adds that job semantics are "library-independent design". So P5-001a takes **no library
dependency at all**, which is what makes it cleanly reviewable alone.

Migration **0031** adds `jobs` (migrations now end 0031): dual-keyed FORCE RLS; tenancy NOT NULL and immutable;
closed 6-state CHECK with `dead_letter` declared up front so P5-001b/c extend rather than reshape; per-company
**partial** unique idempotency index; `SELECT`+`INSERT` plus a column-scoped `UPDATE(state, updated_at,
attempts)`; **no DELETE**, because job history is the run trail. Contracts add closed `JOB_KINDS`/`JOB_STATES`
and a validator that **refuses and never repairs**. `job:enqueue` is **owner-only** — canon does not settle the
role, so I took the safer reversible reading. `job.enqueued` is audited in-transaction with `{kind, deduplicated}`
and nothing else.

### Both review passes returned FAIL. So did CI, twice. All five defects were mine.

**The one worth carrying forward: the acceptance clause's refusal was UNREACHABLE.** `runInCompanyScope` trims and
denies a blank company id *itself*, before the use-case body runs — so a context-stripped enqueue came back
`forbidden`, indistinguishable from an authorization failure. "Context-stripped job refused" is not satisfied by
"no row is written" (that was already true); it requires the failure be **distinguishable**, so a caller is told
plainly and the platform can alarm on it. The layer built to expose the problem was hiding it. Neither the unit tests
(which call the validator directly, bypassing the scope) nor any local run (real-PG suites skip here) could reach it —
**reading found it before CI did.**

Fixed by splitting `validateJobTenancy` out and running **only** it ahead of authorization. That is not a hole in
the no-oracle rule but a consequence of it: the tenancy check reports on the shape of ids the *caller supplied* and
discloses no platform state, whereas `invalid_kind` and `payload_too_large` would — and those stay behind the
authz check, with a test pinning that a viewer sending a bad kind still gets only `forbidden`.

Also pass 1: the row was stamped from caller params rather than `scope.tenant` (equal on this path, but equal by
coincidence, and this is the one ticket whose whole subject is that tenancy is a grant and not a claim); and the
unresolvable-conflict branch returned `invalid_idempotency_key` — a reason that would send a caller to change a
correct key and retry forever. Pass 2: the contract did not mirror the migration's closed state set.

**Found by CI, not by reading** — recorded plainly, because "the reviews were clean" would be a false account:
`ON CONFLICT` cannot infer a **partial** unique index from a bare column list (42P10); a **column-level** UPDATE
grant never appears in `role_table_grants`; and **layer 1 was being tested for something layer 2 does** — an insert
omitting a tenancy column is refused by RLS, not by `NOT NULL`, because the column defaults to NULL and the policy
predicate evaluates to NULL rather than true. The code was right and the test's claim was not. `NOT NULL` is the
backstop for paths where RLS does *not* apply (a superuser migration, a backfill, a later-loosened policy), so it is
now proven **structurally** against `information_schema.columns`, with the runtime test accepting either SQLSTATE.
That is recorded as CDR-049 §3-G3a rather than quietly patched, because it changes what each layer is *for*.

### Evidence

**Exact-head CI GREEN, zero skips: 2053/2053 across 170 files at `9dfdf13`** (run 30269133135). All three refusal
layers proven against real PostgreSQL. Local gate all exit 0 throughout.

### State at report time

`main` unchanged at `223f8e5`; branch `p5-001a-job-store-tenant-stamping` at `9dfdf13`, pushed, tree clean,
draft PR #50 with the full review record in its body. Ledger `docs/implementation/P5-001a-REVIEW.md`.

**P5-001 is NOT marked Done** — that is an owner gate, and b/c are not built. The backlog row reads "In progress
(split a/b/c ratified by owner 2026-07-27; a in review)".

### Awaiting an owner gate

P5-001a is complete to the completion standard except the steps that are gates by charter: **mark the ticket Done,
mark PR #50 ready, merge to main, delete the branch after exact-main CI**. Per the owner's finalization protocol every
one of those is a separate gate, so the sub-scope stops here rather than self-merging.

Continuing to **P5-001b** (checkpoints and resume) would build on an unmerged branch. I am proceeding to the next
independent unblocked work instead, and will return to b/c when a is merged.

---

## FLAG — ACBP-P5-003a stopped, one product-semantics question canon does not answer

Raised under the owner's 2026-07-27 instruction: *"flag anything in these four where you have even minor doubt rather
than proceeding past it."* This is not a minor doubt — it is P5-003a's entire deliverable.

**The question: what is the closed set of tool risk classes, and in what order?**

P5-003a's ratified scope is *"tool definitions, the closed risk-class set, and unclassified => most restrictive"*.
Two accepted requirements depend on that set existing:

- **TOOL-001** — *"Risk class mandatory; unclassified = most restrictive"*
- **APPR-001** — *"Class drives defaults"*

Both presuppose an **ordered** set: "most restrictive" is meaningless without one. After a thorough search, canon
names classes only **by example, never as an enumeration**:

| Source | What it says |
|---|---|
| AI-AND-WORKER-ARCHITECTURE.md:41 | MVP workers run *"informational / internal-reversible risk classes only"* |
| AI-AND-WORKER-ARCHITECTURE.md:37 | `web_research` is *"read-only, informational class"* |
| WORKFLOW-STATE-MACHINES.md:75 | *"e.g., informational class at L2"* |
| TECHNICAL-ARCHITECTURE-v1.md:153, EVENT-CATALOG.md:179, ENGINEERING-STANDARDS.md:19 | *"external risk classes"* / *"external-effect"* — treated as ONE undifferentiated group |
| ADR-012 | *"declared side-effect class and risk class"* — names the concept, not the values |

So canon settles two class names and one unsplit group, and never states the order. diagrams/07,
COMPONENT-CATALOG, APPROVAL-AND-POLICY-ARCHITECTURE and the ADRs add nothing further.

**Why I will not simply pick a set.** These names become the platform's authorization vocabulary. They are the input
to the P6-001 policy decision function, they drive APPR-005 approval expiry defaults, and they decide which calls
require idempotency keys (NFR-006). Inventing them here means every one of those later tickets inherits a vocabulary
no one approved — the definition of silently inventing a requirement, which the charter forbids. It is also not a
safely reversible guess: renaming a risk class after policies reference it is a data migration across trust-critical
tables.

### Proposed set, so you have something to approve or edit rather than a blank page

Ordered least to most restrictive. Every name below is either canon's own word or a split of canon's "external" group.

| # | Proposed class | Meaning | Canon basis | Consequences it would drive |
|---|---|---|---|---|
| 1 | `informational` | Reads only; changes nothing anywhere. `web_research`, `memory_read`. | Canon's own term | Never approval-gated; no idempotency key |
| 2 | `internal_reversible` | Writes only inside the platform, and the write can be undone. `artifact_write`. | Canon's own term | Not approval-gated by default; policy-evaluated |
| 3 | `external_reversible` | Visible outside the platform but retractable (e.g. an unpublished draft). | **A split of canon's "external"** | Approval-gated; idempotency key REQUIRED |
| 4 | `external_irreversible` | Leaves the platform and cannot be taken back — sends, payments, deploys, deletions. | **A split of canon's "external"**, matching the PRD-lineage "irreversible, legally binding, paid, externally visible" language | Always approval-gated; idempotency key REQUIRED; receipt REQUIRED for a success claim (invariant 20) |

**Unclassified maps to #4**, the most restrictive — that is TOOL-001 stated directly.

**The one place I am genuinely guessing is the 3/4 split.** Canon has a single "external" notion. Splitting it is
defensible (retractable and unretractable external effects deserve different approval defaults) but it is an addition,
not a reading. **A three-class set — `informational`, `internal_reversible`, `external` — is equally consistent
with canon and simpler**, and MVP is structurally zero-external-actions either way, so nothing in the MVP exercises
the difference. I lean to the four-class set because collapsing it later is easy and splitting it later is a migration
across policy rows, but this is your call, not mine.

**What unblocks P5-003a:** name the set and its order (approve one of the two above, or state your own). Nothing else
about P5-003 is unclear — the dispatcher chokepoint, deny-by-default allowlist, 100% call records and injection
boundary are all fully specified.

**Not stopping overall.** P5-003b and P5-003c both consume this set, so all three sub-scopes wait on it. I am
proceeding to **ACBP-P5-001b** (checkpoints and resume), which needs no owner input.
## Window 10 — 2026-07-27, ACBP-P5-001b + P5-003a

**Real clock at report time: 2026-07-27 19:02:53.** **Disk, both drives, same moment:** C: **19.40 GB** free
(down ~2.6 GB across the window — CI/build temp; still far above the 3 GB threshold), E: **104.88 GB** free. No
cleanup needed.

### Owner input this window

1. **The four-class risk set was approved AS-IS to unblock P5-003b/c**, with an explicit instruction to record it as
   an owner-approved-by-default choice to revisit rather than a deliberated decision. Done: `CDR-051 §0` is a
   dedicated section stating what is provisional (the 3-vs-4 split of canon's single "external" notion), what is not
   (the ordering, and unclassified⇒most-restrictive), and **when it stops being cheap to change** — once P6-001 policy
   rows and APPR-005 expiry defaults key off the values. The same warning heads `risk-class.ts`.
2. **PRs #50 and #51 must NOT be merged or finalized.** Untouched. `main` is still `b9f101b`.

### Built

| Sub-scope | Branch / PR | Exact-head CI |
| --- | --- | --- |
| **P5-001b** checkpoints and resume | `p5-001b-checkpoints-and-resume`, PR **#51** (stacked on a) | GREEN zero-skip **2082/2082** at `22bba6b` |
| **P5-003a** tool registry + risk classes | `p5-003a-tool-registry-risk-classes`, PR **#52** | GREEN zero-skip **2020/2020** at `18c856c` |

**P5-001b** — the centrepiece is a real kill-and-resume: a plan runs, a step crashes mid-flight, the job resumes, and
the completed step is asserted not to have run again. The failure excluded is double execution, not a wasteful
restart, so the checkpoint shares the step's transaction — proven by a companion test where a step writes and *then*
throws, leaving neither the write nor a checkpoint. Review pass 1 found two: `runJobStep` was authorizing with
`job:enqueue` (scheduling and executing are different capabilities — added `job:execute` on the `task:delete`
precedent), and a comment claimed a rollback "discards the effect", which is true only of TRANSACTIONAL work and
would have become false the moment P5-003 lets a step make an HTTP call.

**P5-003a** — the registry is GLOBAL and **SELECT-only for the app role**: there is no runtime write path at all,
which is the structural half of *"trust-critical determinations come from the tool registry"*. `risk_class` is
nullable on purpose, because TOOL-001's "unclassified" has to be representable or the requirement is untestable, and
`resolveRiskClass` never throws — refusing would be a denial of service on the whole registry, so a broken row
dispatches under the strictest gate instead.

### The mistake worth recording: "the reset-list sweep" is not one list

P5-003a's first CI run failed **73 test files**. I had correctly kept `tool_definitions` out of the tenancy catalog
(it is global config, so it rightly has no RLS and rightly is not in `TENANT_TABLES`) — and then wrongly concluded
it did not belong in the reset lists either. Those are different lists: `ALL_TABLES` and the per-suite lists are the
**drop/reset** set and must name every migrated table regardless of tenancy. Omitting it meant the table survived
`resetSchema`, the next `CREATE TABLE` collided, the migration aborted, and every downstream suite ran against a
database with no tables — which is why the visible error was *"expected [tool_definitions, …4] to include users"*
rather than anything about tools.

**The first fix was also incomplete**, and that is the more useful half of the lesson: I patched by text-anchoring on
one list's phrasing, which covered 33 files and silently missed six that write the list differently. Re-done by
ENUMERATING every file containing a drop list and then asserting none was left short. A text-anchored replace covers
only the shape you happened to anchor on.

### Migration ordering — a real constraint the owner should know about

P5-003a's migration is **0033**, because 0031 and 0032 belong to P5-001a and P5-001b. Kysely refuses to run a
migration that sorts before an already-executed one, so **#52 must merge after #50 and #51**. If the owner prefers a
different order, 0033 renumbers to 0031 with no other change.

### State

`main` untouched at `b9f101b`. Three branches pushed, trees clean, all three CI-green on their exact heads:
#50 (P5-001a), #51 (P5-001b), #52 (P5-003a). Remaining on b and P5-003a: review pass 2 and docs.

Next: **P5-003b** (the dispatcher chokepoint). Note for that sub-scope — canon says a tool call *"belongs to a run"*,
and no run entity exists yet, so the call/run linkage needs deciding there; flagged now rather than discovered late.

---

## Window 11 — 2026-07-28, the owner-authorized merge sequence

**Real clock at report time: 2026-07-28 01:15:27.** **Disk, both drives, same moment:** C: **14.45 GB** free (down
~5 GB across the window — CI/build temp; still well above the 3 GB threshold), E: **104.89 GB** free. No cleanup.

### All three merged, in the exact order the owner specified

| # | Ticket | Merge commit | exact-head CI | exact-main CI |
| --- | --- | --- | --- | --- |
| #50 | P5-001a job store + tenant stamping | `ff845fd` | 2053/2053 zero-skip | **2053/2053 zero-skip** |
| #53 | P5-001b checkpoints and resume | `b36f5a8` | 2084/2084 zero-skip | **2084/2084 zero-skip** |
| #52 | P5-003a tool registry + risk classes | `5381389` | 2117/2117 zero-skip | **2117/2117 zero-skip** |

Full sequence on each — backlog, ready, squash-merge, exact-main CI, delete branch — with the exact-main check run
**between** each, never skipped. All three branches deleted local and remote. `main` = `5381389`, migrations end
**0033**. No open PRs remain from this work.

**#51 had to be replaced by #53.** GitHub auto-closes a PR when its base branch is deleted, and a closed PR whose base
no longer exists can be neither reopened nor retargeted. Same branch, rebased onto main, new PR.

### The reset-list guard — the substantive addition this window

The owner asked for it after the same table fell out of the schema-reset lists **three times, by three different
mechanisms**: never added; a text-anchored fix that covered only one list shape (33 files, silently missing six); and
a rebase in which the incoming files, having gained `jobs` and `job_checkpoints`, won every hunk — no conflict, no
type error, no lint warning.

`tools/check-reset-lists.mjs` derives the required set from `DatabaseSchema` and asserts every reset list is a
superset. **Static** — no database — so it runs in `check:static` and fails in seconds locally rather than minutes
into hosted CI, naming the exact files and tables. It **fails loudly on finding no reset lists at all** rather than
passing vacuously over zero files, which is the one failure mode that would make every future omission invisible.
Five self-tests reproduce both real regression shapes and were confirmed failing before the fix and passing after.
Verified running green in both exact-head and exact-main CI.

The root confusion, worth stating because it is easy to repeat: the **tenancy catalog** and the **drop/reset lists**
are different lists with different rules. `tool_definitions` is correctly absent from `TENANT_TABLES` (global config,
no RLS) and must be in every reset list (it is migrated). Reasoning "not a tenant table" answered the first question
and was then wrongly applied to the second.

### Review passes run before merging, not after

Both P5-001b and P5-003a still owed passes when the merge was authorized. Running them first was the right reading of
"non-negotiable regardless of pace", and each found real defects:

- **P5-001b pass 2** — same-transaction checkpoints had no deterministic order (`created_at` is *transaction* time, so
  simultaneous writes tie); and `getResumeState` **threw** on a malformed plan where every sibling read returns a
  typed status.
- **P5-003a pass 1, HIGH** — `riskRank` was a **gate bypass**. Typed `RiskClass` so it looked safe, but types erase at
  runtime and a bare `indexOf` returns **-1** for anything unrecognised — *below* `informational`. The one function
  expressing "how restrictive is this" would have reported the least restrictive rank possible for an unclassified
  value, and it is exported precisely so P6-001 can compare against a policy threshold.
- **P5-003a pass 2** — the drift guard was one-directional (a value added to the CHECK alone would pass); now reads
  `pg_get_constraintdef` and asserts set equality. Plus a unique constraint whose name described the wrong columns.

### A mistake worth recording

I resolved three rebase conflicts with a regex sweep over the conflict markers. It corrupted `schema.ts` — spliced two
interfaces into one broken declaration and mangled an escape sequence inside a doc comment. Typecheck caught it;
reading would not have. **Regex does not understand the structure it is editing**, and conflict resolution is exactly
where that matters. Repaired by restoring from main and re-applying with ordinary edits.

### Risk classes — recorded as the owner directed

The four-class set is approved **by default** to unblock P5-003b/c, and `CDR-051 §0` is a dedicated section saying so:
what is provisional (splitting canon's single "external" notion), what is not (the ordering; unclassified ⇒ most
restrictive), and **when it stops being cheap to change** — once P6-001 policy rows and APPR-005 expiry defaults key
off the values. The same warning heads `risk-class.ts`, where an engineer will actually meet it.

Next: **P5-003b**, the dispatcher chokepoint.

## FLAG — the risk-class set disagrees with canon, and my earlier "canon is silent" was wrong (2026-07-28 03:52 +03:00)

**Not fixed. Left exactly as shipped, flagged for the owner.** This is the one item in this run I am deliberately not
deciding, under the owner's Phase-6-caution rule: a misclassification here means the AI dispatches under a weaker gate
than it should.

### What I got wrong

Researching P5-003b, I read `product-specification/REQUIREMENTS.csv` line 64. APPR-001's description says, verbatim:

> "Every tool/action is classified: **informational, internal-reversible, external, or sensitive-irreversible**;
> classification drives default approval behavior."

Canon enumerates the four classes by name. When I flagged P5-003a as needing an owner decision, I said canon *"never
enumerates the risk classes"*, and the owner approved my four-class set **on that basis**. The claim was false. I had
searched the architecture layer — `AI-AND-WORKER-ARCHITECTURE`, `TECHNICAL-ARCHITECTURE`, `EVENT-CATALOG`,
`ENGINEERING-STANDARDS` — and concluded "silent" without reading the requirements row that CDR-051's own title cites
(`TOOL-001 / APPR-001`). The lesson is narrow and worth keeping: **"canon is silent" is a claim about ALL of canon, and
I asserted it after checking one layer.**

### Why it matters, concretely

The count is the same. The fourth class is not.

| Action | Canon's `sensitive-irreversible` | My `external_irreversible` |
| --- | --- | --- |
| Permanently destroy a company's data — internal, irreversible | **most restrictive** | `internal_reversible`, the second-**least** restrictive value |

Canon's fourth class is about sensitivity and irreversibility **wherever they occur**. Mine pins the top two classes to
**external** effects, which leaves an irreversible *internal* action classified two rungs too low.

### Why nothing is blocked

- No MVP tool performs an irreversible internal action; the MVP is structurally zero-external-action (ADR-012).
- **P5-003b never touches the class NAMES.** It dispatches on `resolveRiskClass` and the ordering alone, so the set can
  be realigned without touching the dispatcher.
- It stays cheap to change until P6-001 policy rows and APPR-005 expiry defaults reference the values. After that it is
  a data migration across trust-critical tables.

### What I need from the owner (no rush — it does not block Phase 5)

One of three:

1. **Adopt canon's four verbatim** — `informational`, `internal_reversible`, `external`, `sensitive_irreversible`. My
   recommendation: it is what canon says, and it closes the irreversible-internal gap.
2. **Keep the shipped set** as a deliberate improvement on canon, with the gap accepted and written down.
3. **Three classes**, the simpler shape I originally raised.

Recorded in `CDR-051 §0.1` and at the top of `packages/contracts/src/tools/risk-class.ts`, so nobody reads either
without seeing it.

## CORRECTION APPLIED — the fourth risk class now carries canon's name (2026-07-28 12:47 +03:00)

**Owner decision received and executed.** `external_irreversible` → `sensitive_irreversible`, everywhere it appears.
Recorded here as a **correction, not a rename**, because other safety logic reads this class.

### What was wrong

APPR-001 enumerates the risk classes — *"informational, internal-reversible, external, or sensitive-irreversible"* —
and I had told the owner canon never enumerated them, having searched only the architecture layer. The owner approved
an invented fourth name on that false basis.

The two names are not the same idea. `external_irreversible` tied the top class to **external** effects, so an
irreversible **internal** action — permanently destroying a company's data — had no home above `internal_reversible`,
the second-*least* restrictive value. Canon's `sensitive_irreversible` is about sensitivity and irreversibility
**wherever they occur**, which is a class a classifier can honestly assign to that action.

### What was changed

| Layer | Change |
| --- | --- |
| Contracts | `RISK_CLASSES[3]`; the module header now records the correction rather than the flag |
| Database | **Migration 0039** — data first, then all three CHECKs (`tool_definitions`, `tool_calls`, `worker_definitions`), fully reversible |
| Policy logic | `EXTERNAL_EFFECT_CLASSES` in the dispatcher — see below, this one needed thought |
| Tests | every literal, plus new behaviour-preservation tests |

**Migration 0039 rather than editing 0033/0036/0038**, which are merged and may have been applied: a migration that has
run is a historical fact, and rewriting it would make the recorded history disagree with what a database actually did.
Data is rewritten *before* the constraints narrow — the only order that cannot strand a row.

### Proving it changed nothing else

Every gate here compares **ranks**, never strings. So the tests pin, by POSITION:

- the ranks as exactly `[0,1,2,3]`;
- the **full comparison matrix** of `isAtLeastAsRestrictiveAs`, asserted positionally, so a class cannot have moved;
- `MOST_RESTRICTIVE_RISK_CLASS` still being the last element;
- the **MVP ceiling still being the second class** — a shift there would silently widen or narrow what a worker may
  hold, and nothing else would have complained;
- the retired name still failing `isRiskClass` and still resolving **upward** to most-restrictive.

Real-database: migration 0039 is asserted to have carried the new name into all three CHECKs **and** to have left no
stranded row anywhere.

### The one place a pure rename WOULD have changed behaviour

`EXTERNAL_EFFECT_CLASSES` drives TOOL-002's receipt rule. Under the old name, membership was tautological — the class
*was* external. Under canon's name a member may be an **internal** action, with no external receipt to store.

I **kept it in the set**. Dropping it would have quietly relaxed a rule TOOL-002 exists to enforce, on the most
dangerous class there is; keeping it is an over-approximation in the safe direction and preserves behaviour exactly.
A real-database test asserts a `sensitive_irreversible` tool still cannot claim `succeeded` without a receipt.

**The proper fix is a different field, and canon already names it:** TOOL-001 asks a tool to declare its *"side-effect
class"* **separately** from its risk category. "Reaches outside the platform" belongs there, not in an inference from
the risk class. Recorded in CDR-051 §0.2 as the thing to do when tools gain declared side-effect classes.

### Deliberately NOT swept along

Canon's third class is plain `external`; this set still splits it into `external_reversible`. That split was mine and
the owner ruled only on the fourth class. Changing an unruled thing under cover of a ruled one is how a decision stops
being traceable to whoever made it, so it stays flagged in CDR-051 §0.3.
