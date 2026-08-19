# Autonomous run log

Append-only. One entry per autonomous work window. Never overwrite a prior report.

---

## STANDING INSTRUCTIONS — read before starting any window

These persist across every window and every session, regardless of who prompts, and are not
superseded by a later instruction to "keep going" or "work through the backlog".

### OWNER STANDING INSTRUCTION — FRONTEND/UI

> **OWNER STANDING INSTRUCTION — FRONTEND/UI:**
> No frontend or UI work may begin without the owner personally setting
> the UI/UX direction first. The owner has strong design skills and holds
> a high bar for this — the interface is not a checkbox to satisfy or a
> default template to fall back on. Do not scaffold "something to iterate
> on later." Do not pick a component library, colour palette, type scale
> or layout on your own initiative. Do not treat the audit docs' recorded
> style as pre-approval; it is reference material, not a decision.
> When frontend work becomes the next Ready item, STOP and flag it. This
> is a hard gate, same as P2-011 and P7-006.

Recorded 2026-07-28 (window 13); **restated in the owner's own words 2026-07-30 (window 18)**,
which sharpens three things the earlier wording left room to rationalise around: no scaffolding
"to iterate on later", no unilateral choice of component library / palette / type scale / layout,
and the audit documents' recorded style is REFERENCE, not pre-approval. Practically: a ticket whose deliverable is a screen, a
component, a layout, a style system, or a design choice is BLOCKED even when its
dependencies are green and its Definition of Ready says Ready. Backend work that a UI will
later consume — contracts, use cases, API shapes — is not frontend work and continues
normally. When in doubt about which side of the line a ticket falls on, stop and ask; the
cost of asking is a message, and the cost of guessing is a design direction the owner did
not choose.

### The other hard gates

| Gate | Why |
| --- | --- |
| **ACBP-P2-011** | Needs a real paid model account. |
| **ACBP-P7-006** | Needs real live infrastructure. |
| **Any frontend/UI work** | The owner chooses the direction first (above). |
| **Canon's third risk class** (`external` vs `external_reversible`) | Stays flagged in `CDR-051 §0.3` until the owner rules on it separately. Do not resolve it, even though it looks like a small step from the fourth-class correction that was approved. |

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

## Window 12 — 2026-07-28, 02:52 → 13:18 +03:00 (real clock, both endpoints)

Ran long: the boundary fell at 10:52 and this report is late, written at 13:18. The overrun was P5-004's finalization
plus the owner's risk-class correction arriving mid-window; nothing was abandoned and the tree was clean and pushed at
every merge.

**Disk at close:** C: 14.3 GB free (215.5 used) · E: 104.9 GB free (139.3 used). Both far above the 3 GB threshold, so
no cleanup. C: is worth watching — it has not moved all window, but it is the smaller margin.

**`main` at close:** `9f6bfcf`. Migrations end **0039**. Tree clean, no stray branches, everything pushed.

### Merged this window — five, each with two review passes and exact-main CI green zero-skip

| # | Ticket | Squash | Exact-main CI |
| --- | --- | --- | --- |
| 1 | ACBP-P5-002 workflow coordinator | `f3452fc` | 2201/2201, 0 skips |
| 2 | ACBP-P5-003b tool dispatcher chokepoint | `c9c4a5e` | 2265/2265, 0 skips |
| 3 | ACBP-P5-003c injection boundary | `83477a5` | 2294/2294, 0 skips |
| 4 | ACBP-P5-004 worker definitions registry | `f222ae8` | 2334/2334, 0 skips |
| 5 | CORRECTION — risk-class canon rename | `9f6bfcf` | 2341/2341, 0 skips |

**ACBP-P5-003 completed** (a `5381389` + b `c9c4a5e` + c `83477a5`). **ACBP-P5-001 and P5-002 already complete.**

### The four findings that mattered

Every one came from a review pass, not from a red test.

1. **P5-002 pass 2 — `startRun` would begin executing a task the owner had DELETED**, and would start an attempt for a
   task in any state at all. It hid because every test in the suite started runs against `draft` tasks: *the fixtures
   agreed with the bug.*
2. **P5-003b pass 1 — a whitespace receipt satisfied the very CHECK TOOL-002 exists to enforce.** The use case tested
   `trim()`; the database tested only `is null`. The layer meant to hold when something skips the use case was the
   layer that let it through.
3. **P5-003c pass 2 — a complete bypass of the injection boundary.** `tool_output` was classified as *trusted*, so a
   web-fetching tool's output re-entering the context would have laundered injected instructions straight back inside.
   Every corpus test still passed, because the corpus wraps its own content — the hole was one label away and nothing
   exercised it.
4. **P5-004 pass 1 — a guarantee documented and not implemented.** `CDR-056 §2-G4` said the MVP zero-external-actions
   boundary was enforced *structurally*; I wrote the check, tested it against every class, and called it from nothing.
   Worse than never claiming it, because the document is what the next person trusts instead of re-checking.

### The recurring shape, now three tickets running

**One-directional drift guards.** P5-003a pass 2, P5-002 pass 2, P5-003b pass 2 — each time, a CHECK proved it
*accepted* every contract value but could not catch a value the database permits and no contract code can rank. By
P5-004 the set-equality guards were written at authoring time instead. That is the lesson: *shipping the guard for one
constraint does not generalize on its own.*

**Resolve-then-compare is safe for the candidate and dangerous for the threshold.** `riskRank` (P5-003a), then
`requiresApproval` (P5-004), then very nearly `EXTERNAL_EFFECT_CLASSES` during the rename. Same inversion, three
places.

### The owner's correction, executed

`external_irreversible` → `sensitive_irreversible` (APPR-001). Recorded in full at the head of this log and in
`CDR-051 §0.2`. Migration **0039** rather than edits to the merged 0033/0036/0038. Proven behaviour-preserving by
*positional* tests — ranks `[0,1,2,3]`, the full comparison matrix, the MVP ceiling still second — because every gate
here compares ranks and never strings.

The one place a pure rename would have changed behaviour was TOOL-002's receipt rule, and it is now a tested contract
(`hasExternalEffect`) rather than a private constant provable only through a database that skips on a laptop.

### Repository hygiene fixed this window

- **A false negative in my own guard.** `check-reset-lists` matched a table name anywhere in the *file*, so a suite that
  dropped nothing but asserted `toContain('task_runs')` satisfied it — and `database.integration.test.ts` was live in
  that state. Now scoped to the array literals, with a self-test reproducing it.
- **Control characters in three committed files**, eaten by PowerShell backtick escapes. The BEL in `audit.ts` had made
  git classify the blob as **binary**, silently disabling line-ending normalization for it. This recurred a third time
  mid-window; the rule is now absolute: never put code containing backticks through a PowerShell double-quoted string.

### Still open for the owner — neither blocking

- **IOQ-12 budgets** (0.50 USD-equivalent per run, 10 minutes) ride as documented placeholders per the owner's
  instruction. Not owner-ratified; `CDR-056 §3`.
- **Canon's third class** is plain `external`; this set still splits it into `external_reversible`. The owner ruled only
  on the fourth, and it was deliberately not swept along — `CDR-051 §0.3`.

### Next

**ACBP-P5-005 (worker runtime)** — unblocked by P5-002/003/004, and the ticket that stamps a worker onto a run and so
closes WORK-006's *"disable during execution triggers safe-stop"*, recorded as unmet in `CDR-056 §6`.

---

## STANDING RULE (owner instruction, 2026-07-29) — a guard's commit must include a test that FAILS without it

**Not a test that passes while the guard is present — one that fails when it is gone.** Whenever a commit adds a
guard, constraint, allowlist, privilege posture or invariant, the same commit carries a test that has been
*demonstrated* to fail with that guard removed. Demonstrated, not assumed: remove it, watch the test go red, restore
it, watch it go green, and confirm the source file is byte-identical to what was committed.

This exists because eight defects in one stack were guards that were written, believed, and never exercised:

| | The guard | Why the suite still looked green |
| --- | --- | --- |
| D1 | the partial unique index for BILL-002 | every idempotency test short-circuited before the INSERT |
| D3 | revoke of the default PUBLIC EXECUTE | nothing asserted the new function's ACL |
| D9 | one-credit-per-run charging | a **passing** test asserted the double charge as correct |
| D10 | `lockAccountForSpend` serialisation | the FK's own KEY SHARE lock blocked anyway, so "something blocked" proved nothing |
| D11 | the no-minting RLS policy | the `correction` case died on an unrelated CHECK, and the assertion accepted that |

Three failure shapes to test against explicitly, all of which occurred here:

1. **The guard is unreachable.** Something earlier returns, refuses or short-circuits first, so the guarded line never
   runs. Ask: what is the *only* input shape that reaches this line, and is that shape in the suite?
2. **Something else does the guard's job.** A foreign key, a CHECK, a NOT NULL — a neighbouring constraint refuses the
   row for its own reasons and the test cannot tell the difference. Assert *which* mechanism refused, not merely that
   something did: the exact SQLSTATE, the exact statement, the exact policy.
3. **The fixture agrees with the bug.** The expected value was copied from the observed value. When two tests in one
   file disagree about the same arithmetic, one of them is wrong — and it is usually the one that passes.

**Corollary: a poll or retry budget must be strictly less than the timeout that bounds it.** `waitForBlockedBy` polled
400 × 25 ms inside a 10 s test timeout, so its own diagnostic — *"the race was not reproduced"* — could never print
and every failure looked like a bare timeout. Audited repo-wide 2026-07-29: `coordinator.integration.test.ts` polls
5 s inside 10 s (safe); the model gateway applies its timeout **per attempt** rather than as a shared budget (not this
shape). Only the credit suite was affected.

**Corollary: a checker needs the same treatment as the code it checks.** `tools/check-conflict-targets.mjs` carries a
negative self-test that fails the build if its own patterns stop matching a known defect — because a checker that
silently stops matching becomes a checker that always passes, which is this same failure one level up.

**Corollary: before adding a charge to any path, find where the lifecycle ALREADY charges.** Twice now a second
charge has been written onto a path that was already metered once. D9 (P5-014): a `consumption` debited what the
`reservation` had already taken, so a *succeeded* run cost two credits while a failed one cost none. Then CDR-064 G4
(P5-012) planned to reserve a credit in `requestRevision` — but `WORKFLOW-STATE-MACHINES` §4 puts the credit check on
`planned→queued`, which the new task goes through like any other, so that would have charged twice for one revision.
Caught before shipping this time, and pinned by a test that fails if any charge appears on that path. **A credit
lifecycle has exactly one charging point; adding a second is never additive, it is a double charge.**

**Corollary: when a document summarises a journey, go and read the journey.** `AI-AND-WORKER-ARCHITECTURE.md:13`
summarises J-13 as "revisions create lineage-linked new **runs**". `MASTER-PRD-v1.md` J-13 actually says *"new linked
**task** created (lineage to original) → re-execution"*. Taking the summary at face value led P5-012's migration to
model a `run_id` that cannot exist at request time — the run only appears once the new task is queued, and the
original task cannot be re-opened because `running→completed` is terminal. `CLAUDE.md`'s canonical source priority
settles it (PRD #4 above architecture #5); the conflict is now flagged inline at that line so the next reader does
not re-derive it.

**Corollary: a RUNNER that can emit a meaningless red is as dangerous as a test that can emit a meaningless green.**
On 2026-07-29 a sweep on `main` reported *91 files failed, 32 tests failed, 1095 skipped*. All of it was noise:
WSL2's idle timeout was tearing the distro down ~18 s after each `wsl` call returned, so PostgreSQL died mid-sweep
(`received fast shutdown request`, a clean stop — not OOM, memory was 6.3 GB free). **A suite whose `beforeAll`
throws has its remaining tests reported as SKIPPED**, which is indistinguishable from a suite that was never meant
to run — so the failure mode looked exactly like the `skipIf(!hasTestDatabase)` suites being switched off.

I misdiagnosed it twice before reading the PostgreSQL log — first blaming concurrent agent sessions, then their
`alter role acbp_app nologin` teardown. Both were plausible and both were wrong. The log said it in one line.

`.tools/verify-branch.ps1` now carries three guards:

1. **Keep-alive** — hold the WSL distro open for the whole run so the VM cannot idle out under it.
2. **Void-on-restart** — compare `pg_postmaster_start_time()` before and after; if PostgreSQL restarted, the run
   exits **4 = VOID**, not red, and says so loudly. Neither a pass nor a failure may be reported from it.
3. **Single-runner lock** — `acbp_app` is **cluster-wide** and the suites toggle its login in `beforeAll`/`afterAll`,
   so a fresh *database* does **not** isolate two concurrent runs. A second run now refuses to start.

With the guards in place the same commit swept green: **206 files / 2682 tests, zero skips, 404.8 s**, postmaster
stable throughout.

---

## THE SIX-BRANCH MERGE — 2026-07-29, on local verification, CI still blocked

Owner-authorised: merge on local evidence, one at a time, bottom-up, a full local sweep on `main` after each, and
stop dead if any merge turned `main` red. None did. **Every commit and backlog row from this sequence is labelled
"merged on local verification, CI still blocked by the GitHub spending limit" — none of it is CI-proven, and the
full suite must be re-run on `main` when the free minutes reset.**

| # | Ticket | Merge | Files / tests green on `main` after |
| --- | --- | --- | --- |
| 1 | ACBP-P5-014 credit ledger | `a27a93f` | 191 / 2457 |
| 2 | ACBP-P5-013 failure detail | `5bdc84a` | 192 / 2486 |
| 3 | ACBP-P5-011 artifact storage | `149cdbe` | 199 / 2573 |
| 4 | ACBP-P5-006 research worker | `d4ea84e` | 201 / 2612 |
| 5 | ACBP-P5-007 strategy worker | `fb2a3b7` | 204 / 2649 |
| 6 | ACBP-P5-008 document worker | `fdebdca` | 206 / 2682 |

Migrations end at **0043**, strictly ascending: P5-014's `0041`/`0042` merged before P5-011's `0043`, which had been
numbered to leave exactly that gap. The order was verified against the actual migration files before the first merge
rather than taken on trust.

**P5-014 → P5-011 was the hard one, and it is the reset-list hazard for the fourth time.** Both tickets inserted a
table name at the same anchor in 41 schema-reset lists, so **neither side was a superset**: `--ours` would have
dropped `artifacts`, `--theirs` would have dropped `credit_transactions` *and* reverted the D2/D3 catalog fixes.
Resolved as a true union with every token from both sides asserted to survive, and two things surfaced that a careful
read would not have caught:

- `artifacts.integration.test.ts` is a **new** file, so git never raised a conflict on it — and it was missing
  `credit_transactions` entirely. `check:reset-lists` named the file and the table.
- A doc-comment boundary fell inside a conflict hunk, truncating `CreditTransactionsTable`. Typecheck reported it as
  a bogus "octal literals are not allowed" syntax cascade. `schema.ts` was rebuilt from `main` with P5-011's
  additions spliced in at proper boundaries rather than concatenated.

Both are the same lesson as the standing rule above: the guards caught what reading did not.

**Also fixed, and it was already on `main`:** `EVENT-CATALOG.md` carried a corrupted duplicate line —
`` `retry_state` `` had become `etry_state` and `` `task.failed` `` a literal TAB, a PowerShell double-quoted string
having consumed the backticks as `` `r `` and `` `t `` escapes. Same mechanism that has corrupted files here before.

**Mechanism note:** after squashing a branch into `main`, the branches stacked on it were rebased with
`git rebase --onto main <OLD-TIP> <branch>` using the **pre-rebase** tip. Using the rewritten branch name instead
counts its own rewritten commits as unique and tries to replay 26 commits instead of 4.

## Window 13 — 2026-07-28, 13:18 → 21:28 +03:00 (real clock, both endpoints)

Closed 10 minutes before the nominal 8-hour boundary, at the natural stopping point where P5-011's real-PG proof was
committed and pushed and the tree was clean. The first version of this heading said 21:38 — the boundary I was aiming
at rather than the clock I actually read, which is the estimate-instead-of-measurement habit this log is supposed to
be free of.

**Disk at the boundary:** C 10.7 GB free, E 104.9 GB free. Down 0.7 GB on C across the window; not a constraint.

### The single fact that shapes this whole window

**Hosted CI has been dead since 12:46 UTC.** The annotation is *"The job was not started because recent account
payments have failed or your spending limit needs to be increased."* Jobs now last two seconds and run zero steps; as
of 21:26 the two pushes to `p5-011-artifact-storage` did not even produce a run record. Under the completion standard
this repo works to, **hosted zero-skip CI on the exact SHA is the only real-database evidence there is**, and local
PostgreSQL is unreachable here. So:

- **Nothing merged this window.** One thing merged at the very start of it — P5-005 as `bf381e7`, whose CI was green
  before the block.
- **Three branches are parked, complete, pushed and unmergeable.**
- Every real-PG test written since 12:46 is **written but unproven**. `describe.skipIf` drops it silently, and a
  skipped suite reads exactly like a passing one in the local summary. That is stated in each commit message rather
  than left for a reader to infer.

The owner adjudicated this explicitly — *"keep working on other unblocked tickets while CI is down"* — so this is not
being treated as a stop condition. It does mean the queue of merge-ready work only grows until the billing limit is
lifted.

### What was built

| Ticket | State | Branch |
| --- | --- | --- |
| **P5-005** worker runtime | **MERGED** `bf381e7` | deleted |
| **P5-014** credit ledger | complete, both review passes fixed | `p5-014-credit-ledger` |
| **P5-013** failure detail | complete, both review passes fixed, ledger written | `p5-013-failure-detail` |
| **P5-011** artifact storage | CDR + contracts + migration + repo + real-PG proof | `p5-011-artifact-storage` |

### The defects the review passes caught — all three of the named patterns, again

**A guard WRITTEN but never APPLIED (P5-005).** `runWorkerStep` consulted `stop_requested_at` and nothing else. A run
already reclaimed as `worker_lost` can never be `requestStop`-ed again — that guard is `running`-only — so the worker
kept spending on a run everyone else considered finished, while the sweep reported `stopsRequested: 0`. **Permanently
unstoppable.** The fixtures agreed with the bug: `runningRun()` only ever built live task runs, so the false half
could not fail. The checkpoint now reads task-run state, worker state and the stop flag, and fails closed when the
task run is absent.

**A claim STATED but never ENFORCED (P5-005).** Five documents asserted that every tool call passes through one
chokepoint. Nothing enforced it. All five now say the narrower true thing.

**A booby trap (P5-013).** `ACTIVITY_TYPES` had been widened with no migration widening
`activity_events_type_valid`. The projector is fail-closed, so the *first correct wiring of it* would have rolled back
`failRun`'s terminal transition — a landmine armed for whoever touched it next. Reverted, and
`activityTypesMatchDatabase()` now asserts the two sets agree.

**Two minting paths and a free-execution path (P5-014).** A release could exceed its reservation (~2.1bn credits) —
now a BEFORE INSERT trigger. A single-column company FK — now composite. `settleRun` trusted a caller-supplied
outcome, so a caller could declare its own run free; it now reads `task_runs`. My fix for the last one then broke its
own tests, because stripping the parameter left every settlement test settling a still-`running` run.

**Fixtures agreeing with the bug, twice more.** P5-013's blank-failure test seeded `taskInState('draft')` instead of
`'failed'`. P5-011's content-addressing tests would have been unable to express their own failure case without a
second task-run attempt in the fixture, so that attempt was seeded deliberately.

### P5-011, and a dependency the backlog gets wrong

`AI-AND-WORKER-ARCHITECTURE.md:37-39` gives all three MVP workers `artifact_write`. The backlog's Dependencies column
does not. **A research worker with nowhere to write its research is not a research worker**, so P5-011 gates
P5-006/007/008 and P5-012, and doing it first is dependency order rather than preference. Recorded in CDR-060 §0.

Two decisions in it are worth flagging because both took the safer direction over the obvious one:

- **Content addressing never crosses a tenant.** The same bytes in two companies produce two keys and two objects. A
  globally content-addressed store would make one company's read a read of another's write; deduplication is not
  worth a tenant boundary.
- **The uniqueness key is `(company_id, content_hash, run_id)`, not `(company_id, content_hash)`.** The two-column
  form hands run B the row of an earlier run A whenever their bytes match — so the artifact would claim A produced
  what B produced. That is provenance stated but not enforced, the exact pattern this window kept finding. Keying on
  the run keeps retry idempotence and keeps every run's provenance honest.

**IOQ-11 resolved at 8 MiB** per artifact, interim and not owner-ratified — the same standing as IOQ-12's budgets.

### Still open for the owner — none of them blocking today's work

- **The GitHub Actions billing limit.** Everything above waits on it.
- **P5-011's concrete R2/S3 adapter** — a live bucket and real credentials, so an owner gate by definition. The port,
  the semantics and an in-memory implementation all land without it; what remains is one class implementing an
  interface that already exists.
- **IOQ-12 budgets** and **canon's third risk class** (`external` vs `external_reversible`) — unchanged, `CDR-056 §3`
  and `CDR-051 §0.3`.

### Next

**P5-011 slice 4** — core `persistArtifact` with the no-hollow-success rule and the in-memory adapter, then docs and
two review passes. After that P5-006/007/008, which it unblocks.

## STOPPED — NEEDS OWNER: CI DOWN (2026-07-28 23:35 +03:00)

Owner halted stack extension. P5-012, P5-015 and all new tickets are NOT started. This entry is the diagnosis, the
risk, and the exact state to resume from.

### 1. Diagnosis — TWO causes, and I had been conflating them

**I owe a correction first.** I repeatedly reported "~20 pushes produced zero CI runs, therefore CI is blocked by
billing". That inference was wrong, and it made the situation look worse and more uniform than it is.

**Cause A — BILLING. Real, and ONLY the owner can clear it.**

Hard evidence, job `90288386296` (PR #62, `p5-014`, 13:25:16→13:25:18 UTC, zero steps executed):

> *"The job was not started because recent account payments have failed or your spending limit needs to be increased.
> Please check the 'Billing & plans' section in your settings"*

Repo Actions config is healthy and is NOT the problem: `{"enabled": true, "allowed_actions": "all"}`. `ci.yml` parses
and has run green on this repo many times. **This is a GitHub account billing / spending-limit state. Nothing in the
repository can work around it — it needs the owner in GitHub Settings → Billing & plans.**

**Cause B — NO PULL REQUESTS. Mine, and it is process, not config.**

`.github/workflows/ci.yml` triggers on exactly:

```yaml
on:
  pull_request:
  push:
    branches: [main]
```

Of the six branches, **only `p5-014` has a PR** (#62, draft). `p5-013`, `p5-011`, `p5-006`, `p5-007` and `p5-008`
have none. So for those five, pushes to a feature branch with no PR **correctly produce no workflow run** — that is
the configuration working as designed, not a failure.

So the honest position is: **the billing block is demonstrated on `p5-014` only.** For the other five branches I had
no CI evidence of any kind, because I never opened PRs that would have asked for it. "Zero runs across ~20 pushes"
was not the symptom I described it as.

**Is Cause B fixable by me?** The trigger config is not a bug — it is deliberate and documented in the file's own
header ("on pull requests and pushes to main"), and it keeps cost down. I am NOT changing it. Opening the five
missing PRs is the normal path, but it is deferred: the owner said wait, and every run would hit the billing wall
anyway. **No workflow-config fix applies, so the `if and only if fixable by you` clause does not trigger.**

### 2. Risk if the bottom of the stack is wrong — and a second correction

**My "six-branch stack" was wrong.** Verified topology (`git merge-base --is-ancestor`, all six rooted at current
`main`):

- **ONE real stack, 4 deep:** `p5-011` → `p5-006` → `p5-007` → `p5-008`
- **TWO independent branches:** `p5-014` and `p5-013` — neither is under anything, neither carries dependents

**So the owner's question has a better answer than expected: if `p5-014` fails CI, NOTHING above it needs reworking,
because nothing is above it.** A failure there costs `p5-014` alone.

**The branch that actually carries risk is `p5-011`** — 14 commits, and three branches sit on it. Honest worst case
if `p5-011` fails once CI runs:

1. Fix `p5-011`, then rebase `p5-006`, `p5-007`, `p5-008` (a further 7, 4 and 3 commits).
2. The likeliest failure is in migration `0043` itself — its FORCE-RLS policies, the tenant-pinned composite FK, the
   column-grant catalog. Those are exactly the assertions that have never executed.
3. **All three workers call `persistArtifact`.** Any change to its result shape ripples into `runResearch`,
   `runStrategyComparison` and `runDocumentWorker` and their three suites — so a `p5-011` fix is rarely a `p5-011`-only
   fix.
4. Worst realistic case: ~28 commits of rebasing plus re-review of the three workers' persistence paths. Their
   contract-level tests (which DO run locally) would survive; the integration layers would need re-verifying.

**Migration ordering — an ordering constraint, not damage.** `0041`+`0042` (`p5-014`) and `0043` (`p5-011`) do not
collide. But merging `p5-011` first leaves `0041`/`0042` landing *after* an already-applied `0043`, which the default
Kysely migrator treats as corrupted on any database that migrated in between. No long-lived database exists yet
(production is an owner gate and has never been deployed), so today this only constrains merge order:
**`p5-014` before `p5-011`, or renumber.**

### 3. Exact state — every branch, every unproven suite

| Branch | Ahead of main | New migrations | NEW real-PG tests, never executed | PR |
| --- | --- | --- | --- | --- |
| `p5-014-credit-ledger` | 7 | 0041, 0042 | **41** (credit-ledger 20, credit-service 21) | #62 draft |
| `p5-013-failure-detail` | 8 | — | **26** (task-controls) | none |
| `p5-011-artifact-storage` | 14 | 0043 | **44** (artifacts 14, persist 15, complete 15) | none |
| `p5-006-research-worker` | 21 | (inherits 0043) | **16** (research) | none |
| `p5-007-strategy-worker` | 25 | (inherits 0043) | **13** (comparison) | none |
| `p5-008-document-worker` | 28 | (inherits 0043) | **12** (document) | none |

**152 new real-PG tests have never run anywhere.** Beyond those, each branch's reset-list sweep touches ~40 existing
integration files, so the pre-existing real-PG suites are also unverified against the new schema.

What IS proven, on every branch: `pnpm run check` exit 0 — typecheck, lint, secrets, encoding, boundaries,
reset-lists, boundary tests, and the full vitest run (1500 passed / 0 failed on `p5-008`). Every contract-level test
runs locally and passes. **No real database has been touched at any point.**

### 4. The resume order, when billing is cleared

Bottom-up, never merging above an unproven layer:

1. `p5-014` — PR #62 already exists; re-run it. Must be green **zero-skip** before anything else.
2. `p5-013` — independent; open PR, verify, merge.
3. `p5-011` — open PR, verify green zero-skip, merge. **This is the gate for the three workers.**
4. `p5-006` → 5. `p5-007` → 6. `p5-008`, each rebased on the merged parent and verified in turn.

`p5-014` and `p5-013` are independent, so they may be verified in either order — but `p5-014` should still merge
before `p5-011` to keep migration numbers ascending.

### What I am NOT doing

Not starting P5-012, P5-015 or any new ticket. Not opening PRs. Not changing `ci.yml`. Not merging anything. Not
building anything further on unverified work. **Waiting for the owner.**

## SECURITY LAPSE — a trust-all PostgreSQL config, added by an earlier window (found 2026-07-29 ~00:00 +03:00)

**Record this as a lapse, not a footnote.** While fixing local connectivity I found the dedicated `acbp-local-dev`
WSL PostgreSQL configured with BOTH of the following at once:

```
listen_addresses = '*'                                  # postgresql.conf
host  all  all  0.0.0.0/0  trust   # ACBP_TEST_TRUST     # FIRST rule in pg_hba.conf
```

First-match-wins in `pg_hba.conf`, so that rule was the effective policy: **any user, any database, from any IP
address, with no password** — including `postgres` superuser. This machine holds a PUBLIC IP (`149.56.109.100`)
alongside its LAN addresses.

**How it got there.** The `# ACBP_TEST_TRUST` marker is not from the repo's own provisioning: `tools/local/db.ps1`
and `tools/local/provision.sh` generate a random password, write it to git-ignored `.env.local`, and never touch
`pg_hba.conf`. An earlier autonomous window almost certainly added it to force a connection through after the
port had drifted from 5432 to 5433 and the repo tooling reported "no response". That is the failure mode to
remember: **the connection was broken for a mundane reason (wrong port), and the response was to disable
authentication globally rather than find the reason.**

**Mitigating facts, stated so the record is accurate and not alarmist.** WSL2 places the distro behind NAT on a
virtual adapter, so the port was not directly addressable from the LAN without an explicit Windows portproxy or
firewall rule, and I confirmed neither existed. The realistic exposure was every process on this machine and every
other WSL distro — including `docker-desktop` and `OpenClawGateway`. That is still unacceptable, and it is not what
the configuration *said*: the configuration said "anyone, anywhere, no password."

**It also hid a second defect.** With `trust` matching first, the password in `.env.local` was never checked — and it
did not actually match the role. Removing trust surfaced `password authentication failed for user "acbp_dev"`
immediately. A permissive auth rule does not only widen access; it conceals the breakage that would otherwise force
someone to look.

**Removed, not narrowed.** The rule is deleted outright — there is no trust auth at any scope now. The repo already
provisions a password, and CI itself authenticates with one, so trust was never needed. `listen_addresses` is back to
`'localhost'` and the port back to `5432`.

**Verified after the fix, with positive controls on both sides of the negatives** (my first attempt at this
verification was worthless — it ran while the WSL VM was idle-stopped, so "unreachable" proved nothing):

| Check | Result |
| --- | --- |
| Bind address inside WSL (`ss -lntp`) | `127.0.0.1:5432` only |
| Windows listening sockets on 5432 | none — WSL's localhost relay, not a real socket |
| `netsh interface portproxy show all` | no entries |
| Firewall rules matching postgres/5432 | none |
| Reachability from `172.27.144.1`, `172.18.48.1`, `192.168.100.2`, `192.168.100.30`, `149.56.109.100` | **all refused** |
| Reachability from `127.0.0.1` (control, run before AND after the negatives) | succeeds |

**For a future window: do not repeat this.** If the database is unreachable, the cause is a port, a stopped distro,
or a wrong credential — never a reason to widen `pg_hba.conf`. Widening authentication to make a test pass is the
same class of error as deleting an assertion to make a suite green.

---

## LOCAL VERIFICATION — full damage report across the stack (2026-07-29 01:45 +03:00)

**Every number below is LOCALLY VERIFIED, NOT CI-PROVEN.** Nothing merged, nothing marked Done, nothing fixed.

Method, per branch: a freshly created `acbp_verify_<uuid>` database, dropped in a `finally`; migrations from zero;
`vitest run --no-file-parallelism` (serial); no retries; a pre-flight that refuses to start if any other database
still grants privileges to the cluster-wide `acbp_app` role. **Zero skips on every branch** — the real-PG suites
genuinely executed for the first time.

### Per-branch results

| Branch | Test files | Tests | Failed | Skipped |
| --- | --- | --- | --- | --- |
| `p5-014-credit-ledger` | 4 failed / 187 passed (191) | 2451 | **20** | 0 |
| `p5-013-failure-detail` | 1 failed / 188 passed (189) | 2419 | **1** | 0 |
| `p5-011-artifact-storage` | 1 failed / 194 passed (195) | 2477 | **10** | 0 |
| `p5-006-research-worker` | 1 failed / 196 passed (197) | 2516 | **10** | 0 |
| `p5-007-strategy-worker` | 1 failed / 199 passed (200) | 2553 | **10** | 0 |
| `p5-008-document-worker` | 1 failed / 201 passed (202) | 2586 | **10** | 0 |

### The six distinct defects

**D1 — `ON CONFLICT ON CONSTRAINT` naming an INDEX, not a constraint. (p5-014)**
`reserveCredit` (`credit-service.ts:120`) uses `ON CONFLICT ON CONSTRAINT credit_transactions_reservation_key_uq`,
but migration 0041 creates that idempotency guard as a **partial unique index**. PostgreSQL's
`ON CONFLICT ON CONSTRAINT` accepts only real constraints, so every reservation raises `42704`. A partial unique
index can only be targeted by its column list plus its `WHERE` clause. **Every P5-014 reservation path fails at
runtime.** Accounts for 13 credit-service failures and part of the credit-ledger ones.

**D2 — the closed `acbp_` function allowlist was not updated. (p5-014)**
Migration 0041 adds `public.acbp_check_credit_settlement()` — a fourth `acbp_`-prefixed function. The catalog suites
assert *exactly three*. 2 failures (`rls-adversarial`, `bootstrap-functions`). The function is correctly NOT
SECURITY DEFINER; the assertion counts by name prefix, not by definer-ness.

**D3 — PUBLIC holds EXECUTE on that new function. (p5-014)**
`CREATE FUNCTION` grants `EXECUTE` to `PUBLIC` by default and migration 0041 never revoked it, so
"only the restricted app role has EXECUTE; PUBLIC does not" fails. A genuine least-privilege lapse, not a test
expectation problem — and the migration's own comment asserts the privilege posture it does not implement.

**D4 — the migration and its own tests disagree. (p5-014)**
The direct-SQL ledger tests insert reservations without an `idempotency_key`, violating the
`credit_transactions_reservation_needs_key` CHECK that the same migration adds. The CHECK encodes a real CDR-058
rule; the tests were written against the pre-CHECK shape. 4 credit-ledger failures.

**D5 — an incomplete rename. (p5-013)**
`task-controls.integration.test.ts` still expects `nextAttempt: 'scheduled'`; P5-013's own review pass renamed the
contract value to `'retry_eligible'`. The production code is correct; the expectation is stale. 1 failure.

**D6 — a test helper querying columns that do not exist. (p5-011, inherited by three branches)**
`complete.integration.test.ts`'s `completedAudits()` selects `metadata` from `audit_events where event_name = …`.
The real columns are **`payload`** and **`name`**. The helper runs in nearly every test in the file, so one defect
produces 10 failures. **This is the same 10 failures on `p5-011`, `p5-006`, `p5-007` and `p5-008`** — inherited
unchanged down the stack, not four separate problems.

### Same root cause vs genuinely separate

- **D1 + D4** are separate defects but both live in migration 0041's idempotency design (index shape; CHECK vs tests).
- **D2 + D3** are one *change* (the new trigger function) producing two distinct defects: a catalog drift and a
  privilege lapse. D3 is the one that matters.
- **D6 is a single defect counted four times** by the branch table above. 40 of the 61 total failures are D6.
- **D5** is unrelated to everything else.

### The "guard written but never applied" pattern — two more

- **D1**: the idempotency guard exists in the migration (partial unique index) and in the use case (`ON CONFLICT`),
  and the two halves do not connect — the statement errors before the guard can ever apply.
- **D3**: the migration's comment states the privilege posture ("the closed allowlist stays at three") while leaving
  `PUBLIC EXECUTE` in place.

Earlier instances this session: the unstoppable worker (P5-005), the untrusted-content wrapping that transformed
nothing (P5-006), the `void UNKNOWN_FIELD` statement (P5-007), and the prefix CHECK that did not check traversal
(P5-011). **These two were found by EXECUTION rather than by reading** — which is the point the CI outage had been
hiding.

### Where each fix belongs, and what ripples

| Defect | Fix on | Ripples upward? |
| --- | --- | --- |
| D1, D2, D3, D4 | `p5-014` | **No** — nothing is stacked on `p5-014`; it is an independent branch |
| D5 | `p5-013` | **No** — independent branch |
| D6 | `p5-011` | **YES** — `p5-006`, `p5-007`, `p5-008` inherit the file; one fix on `p5-011` plus a rebase clears all three |

### What PASSES, which matters as much

Every worker's own new suite is green: **research 16/16, comparison 13/13, document 12/12, worker-gateways 6/6.**
On `p5-011`, the `artifacts` table suite (14) and `persistArtifact` (15) both pass — only `completeTask` fails, and
only because of D6's helper. The migration-reversal test ("migrations reverse fully and re-apply restores every
managed table") passes on every branch.

### Environment defects fixed to make any of this possible

- A leftover `acbp_p2009_test` database from a merged ticket held `acbp_app` dependencies and blocked
  `DROP ROLE acbp_app` **cluster-wide**, failing the migration-down test from any database. Dropped.
- `acbp_test` held the same grants; recreated empty.
- The `acbp_dev` password did not match `.env.local` (masked by the trust rule); resynced.
- `acbp_dev` lacked SUPERUSER, which CI's `acbp_ci` has by virtue of being the image's `POSTGRES_USER`; granted, so
  local matches CI's privilege level.
- WSL shuts the VM down when idle, which made connectivity flap; held open with a keep-alive process (no
  `.wslconfig` change, nothing global).

### Still true

CI remains blocked on the GitHub Actions spending limit — owner-only. **[SUPERSEDED 2026-07-31 — CI-confirmed by run `30632188407` on `4c12da3`; see "The CI verification debt, cleared" at the end of this log.]** Local proof is **not** a substitute: it does
not exercise the CI service's exact image, and five of six branches still have no PR, so no workflow would run for
them even if billing were restored.

---

## Window 16 — ACBP-P5-015 Slice E integration; PHASE 5 COMPLETE (2026-07-29, ~19:00-20:00 +03)

**Merged to main on local verification:** `19463e7` (merge), slice commits `29f52b3` (CDR-065), `2ea20ad`
(journey + suite), `6b7243e` (demo + activity correction), `b36705a` (revision re-execution), `eaed94d` (lint),
`326f6c5` (review pass 2 + PROJECT-STATE + backlog). Post-merge sweep on main: **211 files / 2731 tests, zero
failures, zero skips**, postmaster stable throughout. **Locally verified, NOT CI-proven.** **[SUPERSEDED 2026-07-31 — CI-confirmed by run `30632188407` on `4c12da3`; see "The CI verification debt, cleared" at the end of this log.]**

**Phase 5 is complete — all 15 tickets Done.** `ACBP-P5-001` and `ACBP-P5-003` were stale bookkeeping: both were
already delivered through their ratified a/b/c sub-scopes, and P5-003's row merely *parsed* as unfinished because
an unquoted comma inside its Definition-of-Ready field shifted every later column. Both are now correct.

### What Slice E is, and what it deliberately is not

The journey (`runSliceEJourney`, shared by `pnpm demo:slice-e` and the CI suite) is 17 steps: 13 positive
(preflight -> queue -> run -> research document -> provenance -> completion -> settlement -> ledger -> audit ->
revision -> re-execution) and 4 negatives (no-hollow-success, release-on-failure, fabricated citation,
unaffordable). Both callers assert the step COUNT, so a truncated run cannot read as a pass.

No production code changed. No migration. No new contract.

### Three findings worth carrying forward

1. **A green demo claimed something false, and the assertion was too weak to notice.** Step 10's first draft
   asserted the activity feed was non-empty and reported that "activity and audit both record the run". It
   passed — on the `company.created` event left behind by SEEDING. `ACTIVITY_TYPES` is exactly the four
   `company.*` events: **no task, run, artifact or credit event reaches the founder-facing feed at all.** The
   step now asserts the ABSENCE, so widening the taxonomy turns it red rather than quietly restoring the
   overstatement. P6-008 owns the real fix.

2. **"Both versions retained" was a claim about one document.** The first draft requested a revision and never
   ran it, so only one artifact ever existed — the assertion would have passed no matter how badly a second
   version were handled. J-13's own words are "new linked task created -> **re-execution** -> both versions
   retained". The journey now executes the revision and compares by id AND by title, because distinct ids alone
   would pass if the worker had written the identical document twice.

3. **The revision's guidance never reaches the worker.** `RunResearchParams` has no guidance field. P5-012
   validates, stores and audits the founder's words, and then a revision re-runs the SAME question. Step 13
   therefore proves retention, not steering. Recorded in CDR-065 §5-G10; it belongs to whichever ticket next
   touches the worker input path.

### Corollary added to the standing rules

**An integration demo asserts what the system does, not what the ticket hoped it would do.** Two of the three
findings above are the same mistake: a step whose wording was written from the requirement rather than from the
run. The test for it is mechanical — ask what value would make this assertion pass, and check whether that value
would satisfy a reader of the step's own text.

### Process defect (mine), fixed

`git add -A tools docs` swept `tools/auto-pm.ps1` and `docs/agent/OWNER-APPROVALS.md` back into tracking — the
two owner-only files that were deliberately untracked one window earlier. Untracked again in `42f1d91`, files
untouched on disk, and both are now in `.gitignore` so a broad `git add` cannot repeat it. Separately, a
`WriteAllLines` on BACKLOG.csv rewrote the working copy to CRLF (the committed content stayed correct because
git normalises on staging, but it broke the LF-anchored `mark-done.ps1` regex until normalised back).

### Still true

CI remains blocked on the GitHub Actions spending limit — owner-only. **[SUPERSEDED 2026-07-31 — CI-confirmed by run `30632188407` on `4c12da3`; see "The CI verification debt, cleared" at the end of this log.]** Everything above is local evidence.

## Window 17 — ACBP-P6-001 + ACBP-P6-002 merged; the policy engine now gates tool calls (2026-07-30, ~00:30–03:00 +03)

State at start: `main == origin/main == 2f51bd7` (Phase 5 complete), migrations ending 0044, disk C 7.53 GB / E 81.47 GB.
State at end: `main == origin/main == 338ae08`, migrations ending **0046**, disk C 7.50 GB / E 81.47 GB. PR #64 MERGED.
**A real PostgreSQL was live for the entire window**, so every `skipIf(!hasTestDatabase)` suite EXECUTED — the first
window in a while where "green" means what it says.

Final gate on the merge commit, on `main`: **`pnpm run check` EXIT 0 — 218 test files, 2881 tests, ZERO SKIPS.**
Locally verified, NOT CI-proven: hosted CI is still blocked on the GitHub Actions spending limit (owner-only). **[SUPERSEDED 2026-07-31 — CI-confirmed by run `30632188407` on `4c12da3`; see "The CI verification debt, cleared" at the end of this log.]**

### What merged

**ACBP-P6-001 (a/b/c) — Done.** The deterministic policy engine: pure evaluator with a required baseline, closed
ordered decision vocabulary, most-restrictive-wins, total over `unknown`; versioned `policies` + append-only
`policy_evaluations` (migration 0045); a fail-closed service where "no active policy" is an **answer** (deny).

**ACBP-P6-002 — merged, and NOT Done.** `ToolGates.policy` is deleted; the dispatcher consults the engine itself
inside the scope already open, so the evaluation, the `tool_calls` row and every audit event commit or roll back
together. Migration 0046 links the call to the evaluation that decided it.

### Two rulings this window, both PM-level and recorded as such

1. **Policy is the authority on whether an approval is needed** (CDR-067 §2-G7) — a LOOSENING of a security check.
2. **Leave `gates.approval` injectable, and give the record teeth** — see below.
3. **Do not wire evaluation point 1**, with the safety argument stated explicitly rather than implied.

### The loosening opened a hole, and a TEST caught it — not review

With the approval demand made conditional on policy, an answer of `allow` left `untrustedContext` with **no effect
whatsoever**: the NFR-021 injection boundary went dead, and laundered content would have reached tools on a plain
`allow`. The boundary had been resting on a mechanism that was not its own — untrusted provenance refused a call by
WITHDRAWING the waiver, which only worked because an approval was demanded of every non-waived call. Remove the
demand, remove the property, silently. Found by the injection corpus (7 failures) during the full sweep.

**The lesson, because it will recur: a security property can rest on a mechanism that is not its own, and removing
the mechanism removes the property with no local sign.** Nothing in the loosening's own tests mentioned untrusted
content.

### Two independent reviews, both of which found things

**Review 1 was scoped to ONE question** — *find any path where a call proceeds without an approval that policy
demanded* — with ten named attack lines and permission to answer "nothing found". `decideDispatch` held on all ten.
Two gaps came out anyway, **both in code this ticket touched but did not change, neither findable from the diff**:
`toPolicyGateAnswer` forwarded the decision unvalidated (and an unreadable decision landed on `unavailable`, the ONE
value the waiver spares — so the failure mode was an informational call proceeding on a decision nobody could read),
and the idempotency short circuit reported a prior DENIED call as `duplicate` and did not bind the key to the
arguments.

**Review 2 (SHIP WITH FIXES, 14 confirmed) found a corrupted source file under a green gate.** Two raw TABs where a
PowerShell escape ate the `t` of `tool_calls`, plus a literal backtick-n that merged two comment lines. Third
recurrence of the class. It also caught that `gate()`'s totality was *claimed*-tested and untested — the INV-4 test's
title named `gate()` while its body exercised `policyGate()`, different codomains — which matters precisely because
the loosening made the approval gate the sole enforcement of `require_approval`.

### Three things I did because a note is not a guard

- **`tools/check-approval-port.mjs`**, in `check:static`. Fails the build the moment an approval store exists while
  `ToolGates` still declares `approval?:`. Carries a negative self-test, exits **2** (distinctly) if it can no longer
  see its target, is itself tested against six fixture trees, and was proven against the real tree. Closing the port
  is now an **acceptance condition of ACBP-P6-003**, recorded in the backlog row.
- **`check-encoding.mjs` now fails on a raw TAB and a lone CR.** Both signals were MEASURED before adoption: TAB
  scored 0 across 584 files; lone-CR scored 1 — a **fourth, previously unnoticed** instance where `running` had lost
  its `r` in a JSDoc comment. Deliberately NOT checked: a backtick followed by an escape letter — it reads like the
  strongest signal and returned 10 hits of which 10 were legitimate template literals. A guard that cries wolf gets
  deleted.
- **A suspicion was TESTED rather than reasoned about.** Review 2 suspected the mutual FK cycle between `tool_calls`
  and `policy_evaluations` would wedge company deletion. It does not — both FKs are `NO ACTION`, checked at end of
  statement, so the cycle resolves inside the cascade. The test now asserts it instead of the CDR explaining it.

### Standing corollary added

**A claim in a document is not evidence, and a test title is not coverage.** Four documentation overstatements were
corrected this window (§2-G8 claimed three `@ts-expect-error` assertions including one that cannot exist; CDR-066
§0.2 cited a test this ticket had deleted; 0045's column comment said the opposite of what P6-002 made true; CDR-067
§1 claimed the *limit* dimension was wired when only `risk_class` is observed) — and every correction is now backed
by a test rather than by a better sentence.

### What is open, and where it lands

- **`gates.approval` is caller-injectable.** Not reachable today (zero non-test callers of `dispatchToolCall`,
  verified independently rather than on the reviewer's word) and not a regression, but the approval gate is now the
  *sole* enforcement of `require_approval`. **ACBP-P6-003 must consult the approval store internally and DELETE the
  port**, as `policy` was deleted here. `gates.stop` is the same shape for P6-007.
- **ACBP-P6-002's acceptance row is UNMET**: one of three evaluation points. Point 2 → ACBP-P6-003. Point 1 → an
  **OWNER GATE** (CDR-067 §1): the engine's observations are tool-shaped, and a point-1 refusal would change P4-002's
  state machine — under the owner-ruled baseline, planning is internal work allowed by default, so a point-1 gate
  refusing planning would deny work the company's own policy permits.
- Five residual risks from review 1 and the truncate-order forward risk from review 2 are logged with disposition in
  CDR-067 §2-G10.

### Still true

CI remains blocked on the GitHub Actions spending limit — owner-only. **[SUPERSEDED 2026-07-31 — CI-confirmed by run `30632188407` on `4c12da3`; see "The CI verification debt, cleared" at the end of this log.]** Everything above is local evidence. **When the
free minutes reset, the full suite must be run on `main` at `338ae08` and confirmed** before any of it is treated as
CI-proven.

---

## Window 18 — 2026-07-30 22:00 → 2026-07-31 02:22 +03:00

**Merged:** `9e339a3` — ACBP-P6-003 human approval engine (sub-scopes a, b, c) squash-merged to `main` from
`p6-003-approval-engine`. Branch head `cc202f5`, 12 commits.

### What shipped

The approval store exists and the dispatcher reads it. Contracts for the five decision paths; migration 0047
(`approval_requests` + append-only `approval_decisions`, dual-keyed FORCE RLS, per-path `iff` CHECKs, the
`decider_is_human` CHECK carrying invariant 5 at the schema level); repository; and the service — `requestApproval`,
`decideApproval`, `listApprovalInbox`, with `approval.*` audit events in the same transaction as the mutation.

**Both carried obligations are met.** The caller-injectable `gates.approval` port is DELETED, and evaluation point 2
is wired. Closing the port means the dispatcher reads a real stored decision instead of a caller's lambda — it does
NOT mean the decision is bound to the payload. That is P6-004 and the record keeps the two apart.

### The reviews are the substance of this window

Two independent passes ran before merge. The second mutation-tested the branch rather than reading it: **35 source
mutations, 15 survived** the full 2953-test suite. That number is the finding.

- **`edit_then_approve` authorized the payload the human edited away.** Nothing read `edited_data`, the dispatcher's
  read had no `r.status` filter, and a superseding decision with no successor was silently downgraded to a plain
  decision on the original request. A human saying "not those 500 recipients, these 3" got the 500. Fixed at three
  layers: the repository excludes non-`decided` requests, the mapping refuses the path by name, and the service
  refuses a supersession with nowhere to go.
- **A deferral was only honoured when policy happened to demand an approval.** A not-yet-due `schedule` mapped to
  `unavailable`, which refuses only when an approval was required — so an informational call riding the no-gate
  waiver discarded the human's deferral and ran the action immediately. An explicit "no" won unconditionally while
  an explicit "not yet" was ignored. `unavailable` now means exactly one thing: no decision exists. The cost is
  reason granularity, taken deliberately in the safe direction.
- **The service had zero tests AND zero consumers.** `packages/core/src/approvals/` was never re-exported from the
  core index, so nothing outside the module could import it. That is why every guard in it survived mutation — the
  D1 unreachable-path shape, on the ticket's headline module. Now exported, with 21 real-PG tests and a
  non-skippable unit suite; 10 of 11 service mutations die.
- **The risk class shown to a human was caller-supplied while labelled `registry`-provenanced.** A model could
  declare `informational` for a `sensitive_irreversible` action, `reversibilityOf` would derive "reversible" from
  the lie, and the CHECK would certify the pair as consistent. Now read from `tool_definitions`.
- **Invariant 5's three layers all tested the same caller-supplied string.** The decider *type* was passed through
  while the user id was overwritten. Now derived server-side and not expressible in the caller's type.
- **"Latest decision" was ordered by a caller-supplied timestamp** with no tie-break. Now `created_at` then `id`.

### Guards

`tools/check-approval-port.mjs` had **four measured holes** — dropping `readonly`, making the field required,
quoting the key, or moving the port to `DispatcherOptions` each produced a working caller-injectable port the guard
declared GONE. All four are now probes in its own self-test, which runs on every invocation. `tools/check-reset-lists.mjs`
was rewritten earlier this window to validate every drop list rather than one per file: 58 drop lists across 43 files.

### Recorded, not silent

- **CDR-068 §2-G4 (preview-equals-execution, APPR-010) is NOT BUILT.** `preview` is free text with no relationship
  to `data`. A failing-by-design marker test asserts the gap so it shows up in every run — the pattern the owner
  asked for when the approval port was left open.
- **Scope enforcement and single-use consumption are deferred to P6-004.** `scope` is shown to the deciding human
  and not applied at the gate; `member_request_ids` is enumerated and never read.
- **P6-003 is NOT Done**: (d), the approval inbox UI, is frontend and sits behind the owner's standing gate. Setting
  a ticket Done is an owner gate in its own right, so the backlog row is untouched.
- **P6-002 remains NOT Done**: two of three evaluation points now wired. Point 1 still needs the owner ruling.

### Evidence

Locally verified, **NOT CI-proven** **[SUPERSEDED 2026-07-31 — CI-confirmed by run `30632188407` on `4c12da3`; see "The CI verification debt, cleared" at the end of this log.]**: `pnpm run check` exit 0 and `pnpm test` exit 0 on `main` at `9e339a3` —
**2989 tests / 223 files, ZERO SKIPS**, real PostgreSQL live throughout.

One full-suite run mid-window came back with 83 failed files and 888 skips. It was **VOID, not a regression**: WSL
had shut its VM down and taken Postgres with it. Diagnosed from `wsl -l --running` reporting no distributions rather
than from the failure text, restarted with a 6-hour keepalive, and re-run clean. Same root cause as the earlier
`ECONNREFUSED` episode.

Disk at window close: C: 7.13 GB free (down from 14.3 GB at run start — the trend continues and is still worth
watching), E: 81.47 GB.

### Still true

CI remains blocked on the GitHub Actions spending limit — owner-only. **[SUPERSEDED 2026-07-31 — CI-confirmed by run `30632188407` on `4c12da3`; see "The CI verification debt, cleared" at the end of this log.]** Everything above is local evidence. **When the
free minutes reset, the full suite must be run on `main` at `9e339a3` and confirmed** before any of it is treated as
CI-proven.

---

## Window 19 — 2026-07-31 02:22 → 15:48 +03:00

**Merged:** `7a5a9ea` — ACBP-P6-004 (payload binding, expiry, revocation, single-use consumption) squash-merged to
`main` from `p6-004-binding-and-consumption`. Branch head `17ae742`, 6 commits.

### What shipped

ADR-009's title, built: *"payload-hash-bound, expiring, revocable, single-use approvals enforced at the tool
dispatcher."* P6-003 made the gate read a real human decision; this makes that decision bind to a specific payload,
expire, be revocable, and be spendable exactly once. Migration 0048, `verifyAndConsume` as one conditional UPDATE,
`revokeApproval` with its own owner-only authority, and three audit events.

It also closes P6-003's `scope` gap: one `approve` on a `one_action` request authorized unlimited calls for the
run's lifetime. Single-use consumption IS that enforcement — the two were always one problem.

**Expiry ships as a mechanism with NO values.** ADR-009 §15 leaves per-risk-class defaults an open owner question
(AOQ-14-adjacent), so `expires_at` is NOT NULL, caller-supplied, and defaulted nowhere in the stack. A nullable
"no expiry" column was rejected: it would make the ABSENCE of an owner decision read as permission to never expire.

### The system caught more than the reviews did, and earlier

Two design errors were caught by the existing suite and the database within minutes of being written:

- **Reading only the REQUEST made a rejected approval authorize.** A reject is `decided` too, as is a not-yet-due
  `schedule` and an `edit_then_approve`. Seven tests across the P6-002 and P6-003 suites went red immediately —
  which is what those suites are for.
- **Consumption was specified to run BEFORE the call was recorded.** `consumed_by_call_id` is a real foreign key,
  so the database refused it outright. The reasoning behind the ordering was also unnecessary: both statements are
  in one transaction, so nothing commits separately.

The second was diagnosed by MEASURING rather than theorising. Seven tests failed with "denied, expected authorized"
and the obvious hypothesis was a hash mismatch; a temporary debug print showed the binding matched and the gate
answered `allow`, which killed every hashing theory at once and left the FK as the only candidate.

A third error came from reading one migration file instead of measuring the schema: 0048 tried to add
`tool_calls_id_company_uq`, which 0045 already created.

### The reviews — 33 mutations, 10 survivors, two executed probes

- **A SPENT APPROVAL POISONED ITS TOOL FOREVER.** The read matched `decided | consumed | revoked`, so after
  consumption a row always stood, the gate read it as an explicit refusal, and EVERY later call was denied —
  including calls policy allows outright and which never needed an approval. Proven by dispatching an
  informational tool a third time. A terminal approval is absent, not refusing.
- **THE SPEND STATEMENT DID NOT MATCH ITS OWN SPECIFICATION.** CDR-069 §1-G5 says `where id = $id`; the code
  matched `(company, run, tool, …)` with no id, and `UPDATE` has no `LIMIT`. Two decided requests for one action
  both matched, both took the same consuming call, and the unique index raised 23505 — throwing out of
  `dispatchToolCall`, whose docblock says it never throws for a refusal, and rolling back so no call record and no
  audit event survived the attempt. A TOOL-002 violation on the calls most worth recording, and permanent.
- **The `tool_version` binding component was inert**, recomputed from the approval's own stored value.
- **Nothing at the dispatcher tested consumption**: `spend=false`, hashing a constant, dropping the usability half,
  deleting the `approval.consumed` audit, and deleting the lost-race correction all left the suite green.
- **CDR-069 §1-G6's compensating alert was specified and never built** — a sentence I wrote and did not implement.
  Now `approval.revoke_failed`, outcome `blocked`, carrying `compensation_required`.
- Plus `0048.down()` failing on any database holding a spent approval, `expiresAt` being the one unvalidated date
  in the stack, and a fractional cost estimate reaching the driver instead of being refused.

Nine new dispatcher tests; 7 of 8 mutations now die. The eighth is an EQUIVALENT mutant — dropping the usability
half changes which layer refuses, not the outcome, because the conditional UPDATE re-checks everything — and is
recorded at the guard site rather than papered over with a contrived test.

### Guards

Six existing guards fired on this ticket and every one was right: the exhaustive authz role-map, the exact
registered-event-name list, the no-orphan-events check, the compile-time exhaustive audit factory switch, the
catalog adversarial column-grant assertion, and the typecheck refusing `node:crypto` in the zero-dep contracts
package. The last one caught a real boundary error in seconds.

### Recorded, not silent

`approval.consumed` is NOT in EVENT-CATALOG and was registered anyway, on source priority (the backlog outranks the
architecture docs). `approval.expired` IS in the catalogue and stays unregistered, because nothing sweeps expiry.
The dispatcher cannot detect COST drift — no cost input, so it recomputes with the request's own stored cost;
execution-time enforcement is P5-005's. Consumption at authorization burns the approval even if the call never
runs. CDR-068 §2-G4 preview-equals-execution is still unbuilt, marker test intact.

**FLAGGED FOR THE OWNER:** `DispatcherOptions.now` is caller-supplied and now governs approval EXPIRY and schedule
due-ness, not just the policy evaluation. Reachability is nil today (no production caller of `dispatchToolCall`),
and it was kept injectable because making it server-only would gut deterministic testing of both. But it is the
same SHAPE as the caller-injectable approval port P6-003 deleted, so before the first HTTP caller lands, that clock
needs a decision.

### Evidence

Locally verified, **NOT CI-proven** **[SUPERSEDED 2026-07-31 — CI-confirmed by run `30632188407` on `4c12da3`; see "The CI verification debt, cleared" at the end of this log.]**: `pnpm run check` exit 0 and `pnpm test` exit 0 on `main` at `7a5a9ea` —
**3053 tests / 225 files, ZERO SKIPS**, real PostgreSQL live for the whole sweep.

The database died once mid-window (WSL idle shutdown again, same signature) and was restarted with an 8-hour
keepalive; the affected run was VOID, not a regression, and was re-run clean. One review pass could not run the DB
suites locally at all — two hung backends from another process held locks — and said so plainly rather than
reporting skipped suites as passing.

Disk at window close: C: 7.57 GB free (recovered slightly from 7.12), E: 81.46 GB.

### Still true

CI remains blocked on the GitHub Actions spending limit — owner-only. **[SUPERSEDED 2026-07-31 — CI-confirmed by run `30632188407` on `4c12da3`; see "The CI verification debt, cleared" at the end of this log.]** Everything above is local evidence. **When
the free minutes reset, the full suite must be run on `main` at `7a5a9ea` and confirmed** before any of it is
treated as CI-proven. Phase 6: 001, 002 (open clause), 003 (a/b/c), 004 merged; 005/006/007 unblocked; P6-003d
remains behind the frontend gate.

---

## The CI verification debt, cleared (2026-07-31)

The owner made the repository public, which restored unlimited free GitHub Actions minutes and ended the outage
that ran from window 15 to window 19. Everything merged in that stretch carried the label *"locally verified, NOT
CI-proven"*. This section replaces that label with a specific run, and is deliberate about what the run does and
does not prove — a vague *"CI is green now"* would re-create exactly the kind of believed-but-underived claim
ACBP-P6-005 was spent correcting.

### What was actually run

| | |
|---|---|
| **Run** | [`30632188407`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/30632188407) — workflow `CI`, job `verify`, conclusion **success** |
| **Commit** | `4c12da39dae71ae5292deae2171f83b6e3a0a0c5` — the tip of `main`. Re-run in place with `gh run rerun`, so it is main's real SHA and not a synthetic commit made to trigger a run |
| **Result** | **225 files / 3053 tests / ZERO SKIPS** |
| **Zero skips is enforced, not observed** | the workflow's `CI database preflight` step fails the job if the real-PostgreSQL suites *would* skip, so a green run cannot be a run that quietly skipped them |

### Which merges that run confirms

`4c12da3` contains all of them, verified with `git merge-base --is-ancestor` rather than by reading the log:

- `338ae08` — ACBP-P6-001 + ACBP-P6-002 (policy engine + dispatcher enforcement, PR #64)
- `9e339a3` — ACBP-P6-003 (human approval engine)
- `7a5a9ea` — ACBP-P6-004 (payload binding, expiry, revocation, single-use consumption)
- and every earlier merge of the local-verification sequence, including ACBP-P5-012 and ACBP-P5-015

### What it does NOT confirm, stated plainly

**This is one run on the cumulative tip.** The intermediate merge commits were each pushed to `main` and each
produced a red run that was never re-run green. The *end state* of the sequence is CI-proven; the individual steps
are not, and no longer can be. Anyone reading a per-ticket "CI-CONFIRMED" line in `PROJECT-STATE.md` should read it
as *"contained in the tip that run 30632188407 proved"*, which is what those lines now say.

### The red runs were VOID, and that was established before anything was touched

The outage instructions required diagnosing a red `main` as regression / environment difference / void **before**
starting any fix. Both reds — `30590300693` at `9e339a3` and `30632014201` at `7a5a9ea` — report `steps=0`: the
`verify` job never executed a single step. That is GitHub's billing startup-failure signature, not a test result.
The same workflow, on the same code, ran green the moment the account block lifted. **No code was changed in
response to those reds, because there was nothing in them to respond to.**

### Why no run existed for most branches

Window 15 recorded that *"five of six branches still have no PR, so no workflow would run for them even if billing
were restored."* That stayed true after billing was restored, and it bit immediately: `ci.yml` triggers on
`pull_request` and on `push` to `main` only, so pushing ACBP-P6-005 to its feature branch started nothing at all.
Draft **PR #65** was opened for it, which is what makes exact-head CI possible — and is required by the charter's
one-ticket-one-PR rule regardless.

### Secret scan over the full history

A public repository exposes every commit ever made, not just the tip, so the working-tree scan that had been run
throughout was no longer sufficient on its own.

- **8,689 objects / 3,989 blobs** swept across `--all` refs plus the reflog.
- **35 pattern matches, every one synthetic or allowlisted** — test fixtures and documentation examples.
- The only `.env`-shaped file ever committed in the repository's history is `.env.example`.
- **Nothing to rotate.**

One gap in the tooling was found and is worth carrying: the working-tree secret scanner had **no
connection-string-with-password pattern**, which had to be added for the history sweep. The scans were clean either
way, but a `postgres://user:password@host` in a committed file would not have been caught by the standing gate.

---

## Window 20 — ACBP-P6-006 merged; P6-007 through the stop service (2026-07-31 ~19:30 → 2026-08-01 ~03:00 +03)

**MERGED: ACBP-P6-006 autonomy levels 1–2**, squash `fdc3065`, PR #66. Exact-head CI `30649500593` on `a9a57f6`
and exact-main `30650127201` on `fdc3065`, both **226 files / 3153 tests, ZERO SKIPS**, Slice A demo green.
Branch tip verified byte-identical to the squash, then deleted local + remote. Also deleted five stale merged
branches (P6-001a/b, P6-002, P6-003, P6-004) after verifying each against **the commit that landed it** — ancestry
alone is wrong for squash merges, and three-dot `main...branch` always shows a squashed branch's own commits.

**ACBP-P6-007 emergency stop — in progress on `p6-007-emergency-stop`, draft PR #67.** Commits: `c8ce3ff` CDR-072;
`999412e` scopes + covering relation; `23b5938` migration 0050; `c6ebf58` StopRepository + §1-G10; `4fbebe8` three
audit events; `215babf` inert scopes made loud; `0a7f00b` three authz actions; plus the stop service.

### The judgment call this window, flagged and unresolved

**SEVEN SCOPES ARE NAMED; FIVE ARE ENFORCEABLE.** The tool registry carries no identity for a capability or an
integration — no column, no call fact — so those two scopes cannot be matched against any call. Shipping them as
activatable would hand an operator a halt that does nothing, which is CDR-072 §0's failure created by the ticket
meant to prevent it. They are storable but refused at activation, and a stored one makes the evaluation
`unreadable → deny`. **This narrows a canon-named control** (diagram 13 lists seven) and whether to pull the
registry work forward so all seven ship together is the owner's call. Reversible in one line.

Making that limitation loud found a REAL DEFECT: `evaluateStops` was treating the two as ordinary identity scopes,
so a stored one would compare against a `null` id, fail to match, and read as **clear** — a stop sitting in the
database silently permitting everything. Now fail-closed, checked before any covering match so an inert row cannot
hide behind a working one.

### What the guards caught, so the record shows the tooling working

- **`check-conflict-targets.mjs`** caught a real runtime bug: `ON CONFLICT ON CONSTRAINT` against a PARTIAL UNIQUE
  INDEX, which PostgreSQL rejects with 42704 — and only on the activate-twice path. Fixed by changing the index to
  plain columns with `NULLS NOT DISTINCT` (PG 15+; CI runs 16) so it is inferable.
- **The audit registry's compile-time partition** refused three unregistered events, then refused a domain type
  missing from `PartitionDomains`. Neither could have shipped silently.
- **The closed authz action list** refused three actions with no role mapping.
- **A test caught a semantic error of mine**: `emergency_stop.activated` was first given outcome `blocked`. Wrong —
  activation is an owner action that SUCCEEDED; what gets blocked is each later tool call, on its own `tool_calls`
  row. Conflating them makes "how many actions were actually stopped" uncountable.
- **A mechanical edit went wrong and typecheck caught it**: adding two tables to 58 reset lists, I anchored on the
  quoted string `'approval_decisions'`, which also appears as a CALL ARGUMENT — 14 insertions landed inside
  `selectFrom(...)`, `createTable(...)` and `dropTable(...)`, including migration 0047 and `approval-repository.ts`,
  i.e. already-merged production code. My first sweep for others reported none and was WRONG: the PowerShell glob
  did not recurse. Re-swept with ripgrep, reverted only the call-argument form, and confirmed both files
  byte-identical to origin/main.

### CI verification debt — CLEARED earlier this window

Run `30632188407` on `4c12da3` (main's real tip, re-run in place): **225 files / 3053 tests, ZERO SKIPS**, covering
`338ae08` (P6-001+002), `9e339a3` (P6-003) and `7a5a9ea` (P6-004), verified by `git merge-base --is-ancestor`. It is
ONE run on the CUMULATIVE TIP: the intermediate merges each produced a red run that was never re-run green, and
both reds were **VOID** (`steps=0` — the GitHub billing startup failure, not a test result). Full-history secret
scan: 8,689 objects / 3,989 blobs, 35 matches all synthetic or allowlisted, nothing to rotate.

### Disk — crossed the stop line and was resolved

C: fell from 8.2 GB to **2.7 GB** in ~3 hours of building, crossing the owner's 3 GB floor. Stopped and reported
rather than acting; nothing was pruned. Read-only investigation found the cause: the `acbp-local-dev` WSL
`ext4.vhdx` (4.91 GB, **not sparse**) grows with repeated migrations-from-zero and **never shrinks on its own**.
The pnpm store was only 0.91 GB and was never the problem. The owner uninstalled Docker Desktop (43 GB
`docker_data.vhdx`, unused here) → **C: 49.7 GB free**. The WSL mechanism remains, so the pressure will return;
compaction is an owner action.

### Scheduled autonomous running

A 20-minute schedule was set up, deleted during the disk block, and recreated. **One wake actually fired** (21:29
local) and correctly **stood down**: it detected this session mid-edit on the same enforcement chokepoint — 48
modified files and an uncommitted migration 0050 — and declined to touch anything. Worth recording precisely: that
demonstrates the AGENT noticed and reasoned its way out, **not** that the scheduler holds a lock. The app exposes
no `lastRunAt` and writes no run log, and there is no Windows Task Scheduler entry — it is app-level only, so it
runs only while the app is open.


---

## Window 20 — 2026-08-01 (early hours) — CI was red for five commits and nobody was looking

### The finding that mattered most

**CI had been failing on five consecutive commits** (`215babf`, `0a7f00b`, `4fbebe8`, `d5d137f`, `5c45359`) while I
kept running the local gate and pushing. The local gate cannot see these failures: every failing suite is
real-PostgreSQL and SKIPS locally. So "green locally" said nothing about the only evidence that counts, and five
pushes went out on it. Reading CI is not a finalization step — it is the check that the last commit was real.

### Three failures, two causes, both mine

1. **A seventh casualty of the over-broad reset-list edit**, this time INSIDE a SQL string literal:
   `where table_name = 'approval_decisions', 'emergency_stops', 'held_work'` — a syntax error rather than a harmless
   extra array element. My earlier revert swept only the call-argument form `(...)`; this one is `= '...'`.
   **That is the wrong-anchor lesson repeating inside the fix for it.** The re-sweep this time enumerated ALL 73
   occurrences repo-wide and classified each by whether its LINE looks like SQL — a different anchor, one suspect,
   exactly this one.
2. **`emergency_stops` and `held_work` were in `TENANT_TABLES` but not in `EXPECTED_GRANTS`**, so P1-014 compared
   their real INSERT/SELECT against `[]`.

### Two things that were nominally done and substantively missing

- **The refusal did not say WHAT halted it.** `denial_reason: 'emergency_stopped'` cannot distinguish "the account
  is halted" from "one task is" — identical evidence for very different halts. `tool.call_requested` now carries
  `stop_scopes` (comma-joined closed vocabulary, no target ids, only on that one reason).
- **Four of the five enforceable scopes had never been proven through the dispatcher.** The contract suite proves
  the covering relation on paper; a scope can be correct there and still never fire because the dispatcher cannot
  populate the identity it matches on. Ten real-PG cases now prove each scope twice — halts what it claims, does
  not halt what it should not — including a cross-account and a sibling-company stop.
- **And gate 8 was measured for ONE scope while CDR-072 §G4 promised "every scope".** A gap between my own design
  record and my own test. The covering case and the timing are now one case per scope, deliberately not splittable
  again, driven off `ENFORCEABLE_STOP_SCOPES` with a guard asserting the keys match exactly.

### Gate 8 is met for FIVE of seven, and that is the honest number

`capability` and `integration` never produce `emergency_stopped` — they deny as `stop_unavailable` — so there is no
halt to time. A timing table showing seven green rows would be the exact false assurance CDR-072 §0 is about.

### A near-miss worth a guard

My first draft of the withheld-column assertions named `work_kind`/`work_id`; the real column is `task_id`.
`not.toContain('work_id')` PASSES against a table with no such column — a vacuous assertion that reads exactly like
a real one. `expectUpdatableColumnsExactly` now resolves every named column against `information_schema.columns`
first. The suite's older hand-written forbidden-lists are still eye-checked only; widening the helper across them
is flagged, not done quietly here.

### State at the end of this window

Branch `p6-007-emergency-stop` at `9ea6a2c`, tree clean and pushed. CI on `791bd56` GREEN with **227/227 files and
3220/3220 tests, ZERO SKIPS** — the red streak is closed. Runs for `d8460ac` and `9ea6a2c` followed; `d8460ac`'s was
cancelled by the newer push (concurrency group), which is expected and is not a failure.

### ADDENDUM — the defect the matrix was built to catch was inside this ticket

`b9d303e`. The dispatcher resolved the `task` and `worker` stop identities with
`select task_run_id, worker_id from worker_runs where id = <runId>`, and `runId` is a `task_runs.id`. The join key
matched nothing, ever — and `task_run_id` is not a task id either, so it could not have matched even had the join
been right. **Both scopes were storable, activatable, visible in the read model, and halted nothing.** An operator
stopping one runaway task would have been told it worked and watched it keep running.

The pure `evaluateStops` was correct throughout and its suite was green. The covering relation was never wrong;
the DISPATCHER's ability to populate the identity it matches on was. That is precisely why the matrix has to run
end-to-end, and it caught this on the first hosted run.

It was caught by a guard I nearly did not write: `runIdentities()` THROWS when the fixture has no worker run,
instead of returning nulls. Nulls would have compared against nulls, gone green, and certified two dead scopes as
enforced — a passing matrix being the most convincing way to ship exactly this bug.

**Launch gate 8, measured on real PostgreSQL in CI (`30680683466`, 227/227 files, 3237/3237 tests, ZERO SKIPS):**

| scope | first refusal after the stop committed |
| --- | --- |
| account_wide | 6.7 ms |
| external_actions_only | 7.1 ms |
| worker | 7.8 ms |
| task | 7.9 ms |
| company | 8.6 ms |

Bound is 5000 ms. `capability` and `integration` are absent because they never produce `emergency_stopped` — there
is no halt to time, which is why the gate is met for FIVE of seven and not seven.
### ADDENDUM 2 — two review passes, two more real defects, and the suite that should have existed

**Pass 1: an `account_wide` stop holds only the raising company's work.** The halt IS account-wide (dual-scope RLS;
the dispatcher denies every company's calls, proven by the matrix), but `held_work.company_id` is NOT NULL with a
tenant-pinned FK and activation runs inside ONE company's scope. So `held_count`/`pending_review_count` count one
company, and **ADMIN-002's mandatory review never sees the other companies' in-flight tasks** — on clear their work
resumes with no confirm-or-discard decision. NOT FIXED: writing `held_work` for sibling companies means establishing
each company's scope inside one account-wide operation, which is a tenant-isolation decision and an **OWNER GATE**.
Three options recorded in CDR-072 §1-G6. **This one needs the owner's call.**

**Pass 2: a `company` stop could name a DIFFERENT company and then halt nothing.** The covering rule matches
`target_id` against the CALL's company while RLS shows the row to the company in `company_id`, and nothing tied them
together — so a stop raised in A naming B was storable, active, visible to A, and covered nothing. Third occurrence
of that exact shape in this ticket. Closed at both layers: a CHECK in migration 0050 makes the row unstorable, and
`activateStop` refuses it with a typed reason.

**And why it survived: migration 0050 had NO real-PostgreSQL suite at all.** Every other table in the repo has one.
The P1-014 catalog covers grants and "RLS is enabled" — never constraint BEHAVIOUR. For a table whose entire purpose
is to make a dishonest stop unstorable, "the constraint is written in the migration" is not the same claim as "the
constraint rejects the row" — the same gap in kind as the covering relation being correct while the scope enforced
nothing. 14 cases now cover it, including a down-to-0049-and-back migration.

**Final evidence: hosted CI `30681663120` on `6e79c73` — 228/228 files, 3251/3251 tests, ZERO SKIPS.**

**Process note, recorded rather than glossed:** the charter calls for an INDEPENDENT review and prior tickets used a
subagent. This session's instructions forbid spawning agents unasked, so both passes were the author's own. They
found real defects, but a self-review is not the independent pass the completion standard specifies.

### STOPPED AT A GATE — P6-008 is the next ticket in order and it is UI

`ACBP-P6-008 Decision Room and activity completion` — *"Ten queues; SSE; proposed-vs-executed marking with evidence
joins"*, acceptance *"Ten queues correct counts; hollow-success rendering impossible"*, required tests *"Decision
Room suite"*, architecture `diagrams/11`, inbox integrated. **The Decision Room is a screen.** That is the owner's
standing FRONTEND/UI gate — no scaffolding, no component library, no layout, and the audit docs' recorded style is
reference rather than pre-approval. Flagged, not started.

**The next backend-only Phase 6 ticket is `ACBP-P6-009` (account usage rollups and reconciliation)** — Type
Security, deps `ACBP-P5-014` which is Done, no UI, Ready. It is genuinely unblocked, and NOT started for two
reasons worth stating rather than assuming: P6-007 is unmerged, so a P6-009 branch would have to fork from `main`
and would add its migration and reset-list entries alongside P6-007's uncommitted-to-main `0050` — the exact shared
files that produced SEVEN mis-edit casualties this session. And three owner decisions are open on P6-007 itself.

Open owner decisions, all of them blocking a clean close:
1. **The account-wide held-work gap** (CDR-072 §1-G6) — fan out per company, hold lazily at dispatch, or accept and
   surface it.
2. **The independent review pass** — both passes were the author's own; the charter specifies an independent one.
3. **Ticket Done / PR #67 ready / merge**, and then branch cleanup.

Plus two carried from earlier: whether policy evaluation point 1 refuses task planning, and whether new companies
should start at L1 rather than L2.

**Final state: branch `p6-007-emergency-stop` at `a469f92`, tree clean and pushed, exact-head CI `30682072277`
GREEN — 228/228 files, 3251/3251 tests, ZERO SKIPS.** C: 50.1 GB free (21.8%).

- 2026-08-01T11:09Z scheduled wake stood down: last commit cf154f6 at 2026-08-01T11:00Z is 9 minutes old, inside the 25-minute serialisation window - a session is actively committing.
- 2026-08-01T11:29Z scheduled wake stood down: last commit 02962e7 at 2026-08-01T11:28Z is 1 minute old, inside the 25-minute serialisation window - a session is actively committing (14:10, 14:16, 14:28 local, all pushed).

### FINAL — P6-007 remediation complete; only owner gates remain

**Both Blockers and all three Highs from the independent review are closed.** Exact-head CI `30699352077` on
`d2505e5` GREEN; the code-bearing evidence is `30698900097` on `4f82b6c` — **229/229 files, 3285/3285 tests, ZERO
SKIPS**, 33 stop-service cases, gate 8 at **4.5 ms measured through `activateStop` itself**.

Blocker 1 was closed the way CANON specified (`WORKFLOW-STATE-MACHINES.md` §4 + `diagrams/13`), not by a design
choice: activation pauses the RUNNING tasks it caught; only a CONFIRMED review resumes one; a DISCARD leaves it
paused rather than cancelled; reviewing while the stop is still active is refused, because ADMIN-002 says clearing
OPENS the review.

**Three lessons this stretch produced, in order of how much they cost:**

1. **A partial diagnosis stated confidently is worse than an open question, because it CLOSES the question.** I
   found a real gap, described its blast radius as the smallest reading that was still bad news, and recorded that
   as fact in the CDR, PROJECT-STATE and a direct report to the owner. Wrong documentation is worse than missing
   documentation.
2. **The independent pass found what two author passes could not** — 2 Blockers, 3 Highs, 10 Medium/Low, including
   two of my own comments claiming "a test asserts this" where no test existed. Self-review has a ceiling.
3. **Every CI failure during remediation was in my INSTRUMENTS, not the code.** The guards that assert their own
   preconditions are the ones that caught things; every place I omitted one, the test passed while proving nothing.

**Open, all owner-gated:** the `account_wide` held-work scoping (CDR-072 §1-G6, three options); ticket Done / PR
#67 ready / merge / branch cleanup; whether policy evaluation point 1 refuses task planning; whether new companies
start at L1 rather than L2. **ACBP-P6-008 (Decision Room) is a SCREEN and is blocked on UI direction**; P6-009 is
the next backend-only Ready ticket and is deliberately not started while P6-007 is unmerged.

C: 46.9 GB free.

- 2026-08-01T13:10Z scheduled wake, no code change: verified rather than assumed. Tree clean, local == origin at
  3950d7d, and the EXACT-HEAD run is `30699664226` on `3950d7d` — 229/229 files, **3285/3285 tests, ZERO SKIPS**
  (the FINAL entry above cited d2505e5 and 4f82b6c, one commit short of the head it was describing). Blocker 1's
  behavioural half confirmed present in source, not just in the log: `activateStop` transitions the running tasks it
  caught `running→paused` and reports `pausedCount`; `reviewHeldWork` does `paused→running` ONLY for `confirmed`,
  and a `discarded` item is deliberately left paused rather than cancelled. Nothing started: P6-008 is a screen, and
  P6-009 stays unstarted while P6-007 is unmerged. All that remains is owner-gated. C: 53.4 GB free.
## ACBP-P6-007 — MERGED. Squash `1f3096d`.

**Exact-head CI `30705908508` on `19f5013` and exact-main CI `30706308683` on `1f3096d`, both GREEN with
229/229 files, 3294/3294 tests, ZERO SKIPS.** Branch deleted local + remote after verifying the branch tip's work
is byte-identical in main (`git diff` across `packages`/`tools`/`docs` empty) — ancestry alone does not hold for a
squash merge. Backlog row Done. C: 46.9 GB free.

### What the ticket cost, stated plainly

**Three independent review passes were needed, and every one found defects the previous work had reported as
complete.** The second found a BLOCKER in code written an hour earlier that a green CI run had already passed
over: a held row could name a stop that never covered the call, leaving a task permanently paused and
uncompletable while the evidence said all was well.

**The implementation was rarely the weak point. The author's own tests and comments were.**

- Assertions that passed vacuously: a negative naming a column that did not exist; null compared against null; a
  positional read over rows sharing a transaction timestamp; a fixture that never established the state it
  claimed; and a guard test reproduced VERBATIM thirty lines above its own corrected twin and explanatory comment.
- Comments claiming guarantees the code did not provide — six in total across the ticket. Three of them were in
  the labelling added FOR the PM condition about not overclaiming.

**What actually caught things**, in order of value:
1. An independent reader who had not been told the author's conclusions.
2. Guards that assert their OWN preconditions — `runIdentities` throwing rather than returning null,
   `expectUpdatableColumnsExactly` resolving column names against `information_schema`, the fixture asserting it
   left the task RUNNING. Every place one was omitted, the test passed while proving nothing.
3. Hosted CI on the exact SHA. A green local gate proved nothing: every suite that mattered skips locally.

### The rule worth carrying forward

> A comment may describe what the code does and why. But the moment it claims a guarantee is ENFORCED, the
> enforcement must be NAMEABLE — a test, a constraint, a checker — or the sentence goes. A comment that lies is
> worse than no comment, because the next reader stops checking.

### Open, all owner-gated

- **ACBP-P6-008 (Decision Room) is a SCREEN** — blocked on the owner's UI direction. Do not start it.
- **ACBP-P6-009** (account usage rollups) is the next backend-only Ready ticket. The collision risk that kept it
  waiting is gone now that P6-007 is merged.
- Whether policy evaluation point 1 refuses task planning; whether new companies start at L1 rather than L2.
- CDR-051 §0.3's third risk class remains flagged and unruled; AOQ-14's limit values remain the owner's.

- 2026-08-01T16:35Z scheduled wake, docs only. **P6-007 is MERGED and the task brief that sent me here was stale** —
  it described Blocker 1's behavioural half as the remaining work; it landed before the merge. Serialisation check
  passed first (tree clean, last commit 44 min old). Re-verified the merge from the CI LOG rather than from the
  previous entry's own summary, because self-reported completion is exactly what cost this ticket three review
  passes: exact-main `30706308683` on `1f3096d` reports 229/229 files, 3294/3294 tests, and NOT ONE `N skipped`
  line in the job log. Blocker 1 confirmed in MAIN's source, not the deleted branch: `stop-service.ts:313` does
  `running -> paused` inside the activation transaction counting only rows that changed, and `reviewHeldWork`
  resumes ONLY on `confirmed`. PR #67 already MERGED, not draft — nothing to update there.
  **What was actually wrong: the docs.** `PROJECT-STATE.md` still headed the ticket **IN PROGRESS**, and by that
  file's own stated rule ("only the topmost ticket without a DONE line above it is genuinely in flight") the merged
  ticket was the one thing reading as in flight. Added the DONE line + renamed the block to "working block" per the
  file's convention, and added the missing merge entry to `EXECUTION-LOG.md`. Both name the `account_wide`
  held-work scoping (CDR-072 §1-G6) as STILL OPEN, so a Done line is not read as closing it.
  Nothing started: P6-008 is a screen (owner UI gate), and P6-009 would be starting a different ticket (owner gate).
  Left stale deliberately and flagged instead: **`## Next executable action` still describes beginning Phase 2** —
  ~30 tickets out of date. Rewriting it means declaring what comes next, which is the owner's call.
  C: 52.8 GB free.

---

## 2026-08-14 — BACKEND COMPLETE (marker entry, appended at the owner's instruction)

**This is the end of the un-gated engineering work.** Everything remaining is an owner gate. The
interesting part of this window was not the volume of tickets but two false claims I made and had to
retract, which turned out to share one mistake.

### What shipped

Fourteen HTTP routes across five tickets, all merged, each pinned to its squash SHA rather than to a status
word: **API-001 `d1d4ae8`**, **API-002 `6faa91c`**, **API-003 `21c7ba1`**, **API-004 `2446e0d`**,
**API-005 `cf769bc`**, plus docs merges `3cbfc89`, `f1136f7`, `bbf9f43`, `4c7a346`. Then **ACBP-API-007**
(PR #106, DRAFT, awaiting the owner): the secret-egress root cause and the CI production build.

### The two retractions, kept because they are the transferable part

**1. "The build is broken on `main`."** It was not. I ran `pnpm exec next build`, bypassing the project
script and its `--webpack` pin; Next 16 then defaulted to Turbopack, which cannot resolve this repo's
workspace barrel re-exports. I "confirmed" the finding by running the same wrong command again on a clean
checkout. **Running the wrong command twice is not corroboration.** Retracted in full, together with the
derived claim that eleven routes had shipped against a broken build. The gap it accidentally exposed was
real and is closed by the CI step in this PR.

**2. "Narrowing the five grants broke no behavioural test."** Read off a local run in which the four
relevant real-PG authz suites are `skipIf`-gated and had **skipped**. Four tests asserted exactly what I
said none did. Worse, the false claim had been used as *support* for the ruling; that argument was
withdrawn.

**Both are one failure: drawing a conclusion from a measurement that could not have come out
differently.** A skipped suite cannot report a break; a Turbopack build cannot succeed here. Neither
result carried information, and I treated both as evidence.

### The secret-egress diagnosis, since a trust-critical guard was involved

The owner's framing was that a trust-critical suite where red sometimes means nothing is worse than no
suite — the ambiguity being the defect, whichever way the diagnosis landed.

Measured rather than reasoned about: the sweep imported every route module *inside the test body*, charging
~88% of a 10s `testTimeout` to module loading (2153 ms warm, 6245 ms cold) while the behaviour under test
cost 303 ms. Route growth 25 → 37 in one session pushed that fixed cost up ~44% against a fixed ceiling;
the observed red was a timeout at 10027 ms.

**There was no race.** No shared resource, no ordering assumption — the suite opens no connection, binds no
port, writes no file. And the hypothesis I carried in ("passes in isolation ⇒ contention") was itself
wrong: the first isolated run *failed* at 10011 ms with nothing else running, and the two that followed
passed only because the caches were by then warm. **Isolation was never the variable** — the same error
shape as the two retractions.

Fixed by hoisting the imports into `beforeAll` (~30× margin, was 1.6×), mutation-tested three ways, with
the flake-vs-leak discriminator written into the file so no future session re-derives it. **M-EG3 is the
one worth carrying:** I wrote a factual claim into a comment, verified it instead of trusting it, and it
was **false** — a failing `beforeAll` reports `Tests 6 skipped`, not 6 failed. The habit that caught it is
the same one that should have prevented both retractions.

### Evidence

Hosted CI on the exact head `6509e0e`: run **31803210130**, all 11 steps green, **4153 passed (4153), zero
skips**. The same suite locally is 2484 passed / 1669 skipped, PostgreSQL being unreachable here — which is
precisely why the hosted run is the only evidence that counts. The new production-build step ran in ~33s
and emitted its full route table.

### Standing, all owner-gated — do not start

ACBP-API-006 (blocked on **P2-011**), **P7-006**, everything in `OWNER-ACTION-PACK.md`, PRs **#86** and
**#10**, and all frontend/UI work under the FRONTEND/UI standing instruction at the top of this file.
PR **#106** is draft and awaits the owner. Branch `p8-api-006-cdr` carries CDR-090 (partial) and has no PR.

C: 38.9 GB free.

---

## STANDING RULE (adopted 2026-08-15, ACBP-API-008) — ask whether the check could have told you otherwise

**Before treating any green result as evidence, ask one question: could a wrong implementation have produced
this same green?** If the answer is no — if the check would have passed whatever the truth was — it is not
evidence, and neither is anything you concluded from it.

This is not a general exhortation to be careful. It is the single failure mode behind **five** separate wrong
conclusions in one session, each of which looked exactly like a passing check:

| The check | Why it could not have failed |
| --- | --- |
| "Narrowing those grants broke no behavioural test" | The four relevant suites are `skipIf`-gated and had **skipped**. A skipped suite cannot report a break. |
| "The build is broken on `main`" | `pnpm exec next build` bypasses the `--webpack` pin, so Turbopack could never succeed here. Running it twice was not corroboration. |
| "M-AP9 survived — the guard has a coverage gap" | The mutation never applied; a here-string failed to match. An **unmutated file passes trivially**. |
| "None of the generate use cases is exported" | Grepping `index.ts` for names that `export *` never writes. The grep could only ever say "not found". |
| "The fail-closed guard is mutation-proven" | There was **no unit test for that service at all**. Nothing existed that a mutation could kill. |

Two of these were caught only because something else forced a second look; the others were caught by asking this
question deliberately. The pattern is that a green result and a meaningless result are visually identical — the
transcript looks the same either way, which is why "I checked" is not the same as "I have evidence".

**How to apply it, concretely:**

- **Mutation testing:** never trust a survival without proving the mutation landed. Assert the file differs on
  disk *and* contains the replacement, then run. `scratchpad/mutate.ps1` in this ticket does exactly this and
  refuses to report a verdict otherwise. A survival is a claim about your tests; an unapplied mutation is a claim
  about nothing.
- **Absence claims** ("X is not exported", "nothing uses Y", "no test covers Z"): verify with an anchor that
  *fails when the claim is false* — resolve the import, run the call, delete the thing and watch something break.
  A name-grep is the weakest possible instrument for an absence claim, because indirection defeats it silently.
- **Suites that can skip:** `skipped` is not `passed`. Read the totals, not the exit code. This repository's
  real-PG suites skip whenever local PostgreSQL is unreachable, which is nearly always.
- **Any command with a project script:** run the script, not your reconstruction of it. A wrapper usually exists
  because a bare invocation is wrong.
- **Before writing a guard is "proven":** confirm a test exists that fails without it. If you cannot name the
  test, it is not proven — it is merely present.

The rule generalises past testing: it applies to any claim of the form "I checked and it was fine."
## 2026-08-17 — FRONTEND, under owner direction (FE slice 1 + the root-layout micro-slice)

The FRONTEND/UI standing instruction at the top of this file was **lifted by the owner for a scoped slice**
(ruling 2026-08-15: Berry visual language, rebuilt natively, dark-first) and then for a second, narrower one
(the root-layout micro-slice). The gate is otherwise unchanged and still governs everything not named in those
two rulings. Nothing here was started on my own initiative.

### What shipped

| Work | Head | PR | Exact-head CI |
| --- | --- | --- | --- |
| **FE slice 1** — console shell + company overview, mock data | `9771880` | #114 (DRAFT) | run **31985116502** — green, **281/281 files, 4167/4167 tests, zero skips**, production build step green with `ƒ /console` in the route table |
| **Root-layout micro-slice** — app-wide viewport, `(site)` route group | see PR | #115 (DRAFT) | pending at time of writing |

Neither ticket is Done, and no backlog row was set to Done — both are owner gates. FE slice 1 is held at
`9771880` awaiting the owner's **visual** verdict.

### A NAMED TRAP: headless Chrome reports `prefers-reduced-motion: reduce` BY DEFAULT

Worth naming because it is silent, it looks like success, and it will catch the next person who verifies a
motion preference the obvious way.

The console honours `prefers-reduced-motion` in two places — CSS duration tokens, and JS, because the counter is
`requestAnimationFrame`-driven and no CSS token can reach a rAF loop. To prove the JS half worked I captured the
page twice, once normally and once with `Emulation.setEmulatedMedia` forcing `reduce`, and the two renders came
back **byte-identical (same sha256)**. That reads as a clean result. It was worthless: **headless Chrome defaults
to `reduce`**, so the "normal" run was also a reduced run and I had measured one condition twice.

The fix is to set **both** directions explicitly — `no-preference` as well as `reduce` — and then the conditions
separate cleanly:

| | normal motion | reduced motion |
| --- | --- | --- |
| `matchMedia` reduce | `false` | `true` |
| computed `--t-base` | `240ms` | `0ms` |
| counter at 250 ms | **10,268** | **48,250** |
| counter at rest | 48,250 | 48,250 |

The identical-sha256 pair is now real evidence, because the two runs are verifiably in *different* media states.
Before, it was the same shape as the two retractions in the 2026-08-14 entry: **a measurement that could not have
come out differently.** Encoded in `tools/measure-render.mjs` with the reason written next to it, so the next
session inherits the answer rather than the trap.

### The standing rule again, in a new medium: A SCREENSHOT IS A CHECK THAT CANNOT SAY NO

Three defects shipped through FE slice 1's visual review. Every one of them was **in the picture** and none was
visible *as a defect*, because an image has no failure mode — it renders whatever is there and looks equally
finished either way. All three were found by asserting a number instead.

1. **No `box-sizing: border-box` anywhere in the app.** This app ships no CSS reset, so padding is added to
   declared widths; every `width: 100%` element with padding overflowed its parent by exactly its horizontal
   padding — **48px** at desktop (2 × `--s-5`), **32px** narrow (2 × `--s-4`). The right edge of every card was
   cut off. In a screenshot that reads as a bad crop, not a bug, and it survived several passes of me looking
   directly at it. A `scrollWidth > innerWidth` assertion named it in one run — and named it on **all three**
   captures at once, including the desktop one I had already accepted.
2. **No viewport meta tag anywhere in the app.** The narrow-width media queries could never have matched on a
   phone: a mobile browser with no viewport meta lays out at a fallback desktop width. Measured — under mobile
   emulation at 420px, `window.innerWidth` reported **1395**. A screenshot cannot report this at all; it just
   shows the desktop layout, which looks correct.
3. **The animated counter server-rendered `0`.** The credits figure was wrong until hydration and permanently
   wrong without JavaScript. A number that is only right when an animation runs is not a decoration, it is a
   false reading.

The lesson is not "take better screenshots". It is that **an artefact that cannot fail is not evidence**, which is
the same rule as skipped suites, Turbopack builds and `skipIf`-gated authz tests — only wearing a picture.
`tools/measure-render.mjs` is the response: it asserts overflow, viewport, layout mode, header presence and the
motion discrimination, and **exits non-zero**. It is committed, so a comment can name it as an enforcement and a
reviewer can re-run it.

> **OWNER RULING 2026-08-17 — `measure-render.mjs` stays UN-WIRED from CI for now. It is a LOCAL PRE-PR GATE,
> not coverage.** Written down deliberately rather than left as an omission, because a check everyone believes is
> running but which never runs is the same defect as a skipped suite. Concretely: nothing in CI executes it, no
> CI failure can arise from it, and **no claim anywhere may cite it as CI coverage** — it drives a real browser
> against a running server, which the verification gate does not provision. Whether it ever joins the gate is its
> own decision, filed as backlog row **ACBP-FE-019** (`Planned`) so the question stays visible instead of quietly
> resolving itself into assumed coverage. If that answer is ever yes, the wiring commit must demonstrate a RED
> run against a seeded regression, per the 2026-07-29 standing rule at the top of this file.

**A corollary, self-inflicted:** `console.css` shipped a comment citing "the no-horizontal-overflow assertion in
the screenshot harness" while no harness existed anywhere in the repo — a comment naming an enforcement nobody
could locate, which is exactly what the 2026-08-06 rule forbids. Caught by an independent review pass, not by me.
Committing the harness is what made the sentence true; the alternative was deleting the sentence.

### The micro-slice found one thing that was nobody's screenshot

Removing `auth()` from the root layout is presentational — its only consumer was the signed-in/out ternary, and
enforcement lives in `proxy.ts` and `resolveVerifiedIdentity()`. But `auth()` reaches `await headers()`, a dynamic
API, and it was **the only one above `/console`**. Deleting it would have flipped `/console` and `/_not-found` to
build-time prerendering — harmless today (the page reads `MOCK_` constants only) but it would have deleted an
app-wide dynamic-rendering guarantee nothing else asserts, and settled **CDR-083 §8 item 9**, the explicitly
undecided nonce/caching question, by accident and in the wrong direction.

Held deliberately with `export const dynamic = 'force-dynamic'` on the root layout, and **verified by removing
it**: with the line, every page is `ƒ` and `prerender-manifest.json` lists only `/_global-error`; without it,
`/console` and `/_not-found` turn `○` and join that manifest.

> **OWNER RULING 2026-08-17 — the `force-dynamic` hold is RATIFIED as an explicit INTERIM ruling.** `/console`'s
> render mode **remains an open decision under CDR-083 §8 item 9**, to be decided deliberately later and **never
> by side effect**. `force-dynamic` is the hold, not the answer, and it is not to be read as a settled choice of
> dynamic rendering. **The measured counterfactual comment stays beside the line**; anyone proposing to remove
> the line re-runs that mutation first and reports the manifest. Recorded in CDR-083 §8 item 9 as well, so the
> open question and its holding mechanism live in the same place.

### Standing, all owner-gated — unchanged

P2-011, P7-006, everything in `OWNER-ACTION-PACK.md`, PRs **#86** and **#10**. The FRONTEND/UI standing
instruction still governs every screen not named in the owner's two rulings above. Sibling work on
`p8-api-008-slice3b` left untouched throughout, as instructed.


### MERGE MARKER — both frontend slices are on `main` (appended 2026-08-17)

Pinned to squash SHAs and run ids rather than to status words, so nothing here can go stale.

| Ticket | Squash SHA | PR | Exact-head CI | Exact-main CI |
| --- | --- | --- | --- | --- |
| **FE slice 1** — console shell + company overview | **`ef3a119`** | #114 | `31985116502` on `9771880` | **`31988034424`** on `ef3a119` |
| **Root-layout micro-slice** — app-wide viewport + `(site)` route group | **`c4a714c`** | #115 | `31988659637` on `9a5c412` (rebased head) | **`31989248948`** on `c4a714c` |

Every one of those four runs: **all 17 steps green, `281 passed (281)` test files, `4167 passed (4167)` tests, and
ZERO lines anywhere in the logs reporting a skip count.** The production-build step ran in each and emitted the
route table; the two later runs show `ƒ /console`, confirming the `force-dynamic` interim hold holds on `main`
and on CI's machine, not only locally.

**Both merges were tree-identity verified before the branch was deleted** — squash tree equal to branch-head
tree, and `git diff <branch> origin/main` empty. Ancestry can never pass for a squash, so the tree is the check.
`fe-slice1-console-shell` (was `9771880`) and `fe-slice2-root-layout` (was `9a5c412`) are both deleted.

**The three page moves survived rebase AND squash as pure renames.** On `main`, `git show --summary` reports
`rename apps/web/src/app/{ => (site)}/page.tsx (100%)` and the same for both auth catch-alls; their git blob
hashes are identical to the pre-move blobs. The ACBP-P1-001 auth pages are byte-for-byte unchanged.

**Backlog at this marker:** `ACBP-FE-001`, `ACBP-FE-002`, `ACBP-FE-011` → **Done** (owner gate granted for
exactly those three rows). `ACBP-FE-019` added as `Planned` — the deferred decision on whether the render
harness joins CI. `FE-016/017/018` unchanged at `Blocked-API`.

**Owner rulings carried by `c4a714c`:** the `force-dynamic` hold ratified as an explicit INTERIM ruling with
`/console`'s render mode left open under CDR-083 §8 item 9; and `tools/measure-render.mjs` confirmed UN-WIRED
from CI — a local pre-PR gate that no claim may cite as coverage.

**Frontend status after this marker:** the FRONTEND/UI standing instruction at the top of this file is UNCHANGED
and still governs every screen. Two slices were released by name; nothing else is. The next slice was proposed to
the owner (ACBP-FE-004, portfolio and company switching) and **awaits confirmation — it is not started.**


### ACBP-FE-004 and ACBP-FE-006 — released by name (owner, 2026-08-17)

The FRONTEND/UI standing instruction at the top of this file is **release-by-name**, so the authorization is
recorded here before the work, not inferred from it afterwards.

- **ACBP-FE-004** — portfolio card grid. Owner ruling: card grid in the Berry language, only the fields the
  portfolio read returns, empty state stating absence plainly with a disabled labelled create control, all six
  refusals distinct with the real `retryAfterSeconds`, no Clerk keys, backlog untouched. Shipped as `b2bbf27`,
  draft PR **#117**, exact-head CI **32023523290** green with zero skips.
- **ACBP-FE-006** — company profile. Owner ruling: single profile page, pause control on the page only; and
  after a preflight, two follow-up rulings — surface the caller's role from core, and use `fetch` rather than a
  Server Action.

Nothing beyond those two names is released. Every other screen remains gated.

### What the FE-006 preflight found, and why it ran before any code

Three questions were checked against the source before building, because two of them could have made the slice
either dishonest or a security change in disguise.

**1. The company read does not carry the caller's role — and the reason cannot be recovered afterwards.**
`CompanyView` is six fields and role is not one of them. That matters because an unauthorized transition comes
back as a bare `forbidden`, *deliberately indistinguishable from "no such company"*, so a viewer's refusal
cannot be explained after a failed attempt: the reason has to be known before the control renders. Four options
existed and three were rejected on evidence — a second portfolio read costs another rate-limit charge and
silently misses any company past the first page; `listMembersForRequest` answers ACCOUNT role, a different
question; and inferring viewer-ness from a derived usage flag would flip to a FALSE ENABLED control the day the
authz matrix widened. The owner chose the fourth: return the role core already resolved. It costs no extra
query and cannot drift from the value that gated the read, because it IS that value.

**2. A pause button falsifies CDR-081's premise — and does not reopen its ruling.** "No page in this
application posts to any of the seventeen state-changing methods" was still literally true at `da50603`
(verified: zero `use server`, zero `<form>`, zero page-side `fetch`), and FE-006 is the first slice in the
repository's history to break it. But that premise is the reason a *token* would have been inert, never the
reason the *gate* works — the gate rests on `Sec-Fetch-Site`/`Origin` being forbidden header names, and §3 had
already pre-ruled that a token is "reversible if a UI ever wants defence in depth". So this is a doc
correction, recorded in CDR-081 §1 with the old sentences rescoped rather than deleted.

**3. The transport was the part that genuinely needed the owner.** A Server Action would have been the tidier
architecture — no second hop, no second rate-limit charge, matching the FE-004 precedent of calling the request
function directly. It is also **invisible to both static guards**: `check-csrf-origin-gate.mjs` enumerates
`route.*` under `api/`, and `check-rate-limit-coverage.mjs` is scoped to `app/api/**`. Both would have stayed
GREEN while their promises stopped covering the app's only mutating control — CDR-082 §2's "a route added next
month cannot silently omit it" would have become false in substance with no test failing. The owner ruled
`fetch` against the existing routes, so both guards keep meaning what they say.

**The rule this leaves behind:** a green checker that has quietly stopped checking is worse than a missing one,
because its greenness is read as coverage. Before adding a new KIND of entry point, ask which existing guard
enumerates entry points and whether it can see this one.


### MERGE MARKER — the portfolio and company-profile slices are on `main` (appended 2026-08-17)

Pinned to squash SHAs and run ids rather than status words, so nothing here can go stale.

| Ticket | Squash SHA | PR | Exact-head CI | Exact-main CI |
| --- | --- | --- | --- | --- |
| **ACBP-FE-004** — portfolio card grid, first console screen reading real data | **`bd87653`** | #117 | `32023523290` on `b2bbf27` | **`32030012519`** on `bd87653` |
| **ACBP-FE-006** — company profile + pause/resume, first state-changing page control | **`51b89d1`** | #119 | `32028907779` on `7e8c19b`, then **`32031059740`** on the rebased `055c9cd` | **`32031931635`** on `51b89d1` |

All five runs: **17/17 steps green, zero failed, and ZERO lines anywhere in the logs reporting a skip count.**
The final main run reports `284 passed (284)` test files and `4204 passed (4204)` tests, and its production build
emitted both `ƒ /console/companies` and `ƒ /console/companies/[companyId]`.

**Both merges were tree-identity verified before the branch was deleted** — squash tree equal to branch-head
tree, and `git diff <branch> origin/main` empty. Ancestry can never pass for a squash, so the tree is the check.
`fe-004-portfolio` (was `b2bbf27`) and `fe-006-company-profile` (was `055c9cd`) are both deleted; no `fe-*`
branch remains on the remote.

**FE-006 ran its CI twice on purpose.** The rebase onto the new `main` produced a different commit (`7e8c19b` →
`055c9cd`) sitting on a main that contains FE-004's SQUASH rather than its branch history, so the earlier green
did not carry. `32031059740` is the run that actually covers what merged.

### What these two slices changed beyond the screens

- **`CompanyView` now returns the caller's own company role** (`packages/core/src/company/company-lifecycle.ts`).
  The value was already resolved by `runInCompanyScope` to authorize the read and was being discarded by
  `unwrap`; it costs no extra query and cannot drift from the value that gated the call. It exists because an
  unauthorized transition returns a bare `forbidden`, deliberately indistinguishable from "no such company" — so
  a viewer's refusal cannot be explained after a failed attempt and must be known before the control renders.
  The real-PG test that proves it is caller-scoped asserts the same company read by two members differs in
  EXACTLY that field; a hardcoded constant passes "owner sees owner" and fails this.
- **CDR-081 §1's premise is corrected, not deleted.** "No page in this application posts to any of the seventeen
  state-changing methods" was still literally true at `da50603` and is false as of `51b89d1`. That premise was
  the reason a TOKEN would have been inert, never the reason the GATE works, so the no-token ruling stands and
  §3's "reversible if a UI ever wants defence in depth" is promoted to a live, named-but-not-taken option.
- **The mutation goes over HTTP deliberately.** A Server Action would have been tidier, but it is a
  state-changing entry point no static guard here can see — `check-csrf-origin-gate.mjs` enumerates `route.*`
  under `api/`, `check-rate-limit-coverage.mjs` is scoped to `app/api/**` — and both would have stayed GREEN
  while their promises stopped covering the app's only mutating control. After the change they still report 21
  state-changing route modules and 36 covered handlers.

### A GitHub behaviour that cost a PR number, recorded so it is not rediscovered

**Deleting a base branch AUTO-CLOSES any PR stacked on it, and GitHub then refuses both `reopen` and a base
change** — "Cannot change the base branch of a closed pull request", "Could not open the pull request". #118 was
lost that way when `fe-004-portfolio` was deleted after #117 merged, and the work continued as #119 with the same
commit. Nothing was lost, but the PR number and its review thread were.

**The rule:** retarget the stacked child to `main` BEFORE deleting the parent branch, never after.

### Verification hygiene note from the same window

A post-merge check reported the new profile page MISSING from `main`. It was present. `Test-Path` treats
`[companyId]` as a wildcard character class, so it returned `False` for a file that exists; `-LiteralPath` and
`git ls-files` both confirm it. The check failed for a reason unrelated to the thing being checked — the same
shape as the headless-Chrome reduced-motion default recorded earlier in this log. It was caught only because
"the route is missing but CI just built it" is incoherent, not because anything announced a problem.

### Backlog and gates at this marker

`ACBP-FE-004` and `ACBP-FE-006` rows are **deliberately unchanged** — the owner granted the `Done` gate by name
for FE-001/002/011 previously and named no rows for these two, so it is treated as unpressed rather than implied
by a merge. `FE-016/017/018` remain `Blocked-API`; `ACBP-FE-019` remains `Planned`.

The FRONTEND/UI standing instruction at the top of this file is UNCHANGED and still governs every screen. Four
slices have been released by name; nothing else is. **Populated screenshots for both slices remain pending
evidence** — they need Clerk credentials this environment does not have, and the committed captures are the real
pages in their signed-out state plus server-rendered previews of the states a browser cannot reach.


### ACBP-API-010 — the CDR-088 disclosure list goes to zero, and two of its three reasons were false

The owner ordered the seeded foreign-roadmap invisibility proof, plus an audit of **every** CDR-088 matrix
block for the same disclosure: *"One ticket, disclosure list to zero — not shrinking by one."* Three blocks
carried it; a fourth was found by review. The audit is the part worth keeping.

**Two of the three disclosures were factually wrong, in the same way.** The artifact block and the approvals
block each justified seeding nothing by saying their `run_id` was *"NOT NULL with an FK to `runs`"*.

**There is no `runs` table in this schema and there never has been.** The tables are `task_runs`,
`planning_runs` and `worker_runs`. The real constraints are `artifacts_run_fk` and
`approval_requests_run_fk`, both tenant-pinned composites onto **`task_runs`** — and the CDR-089 block in
the *same test file*, about two hundred lines above the artifact block, had been seeding that exact chain
all along. `task_runs` needs four columns; `state` defaults.

So neither matrix was blocked by a hard constraint. Each was blocked by **an unverified sentence about
one**, and withheld a provable tenant-isolation claim for as long as the sentence stood. The repository
already had the mirror-image rule from ACBP-P7-014: a control whose justification this repo cannot check
must not ship. This is that rule inverted — an unchecked premise talked two tenant-data matrices *out of*
proving isolation, and nothing ever failed, because a disclosure costs nothing to leave in place.

The roadmap block, the one the owner's ruling was actually about, was the **only** one of the three whose
stated blocker was real: `roadmaps.decision_id` genuinely requires understanding document → generation →
selection → decision. That chain is now built, in
`packages/test-support/src/tenancy/isolation-fixtures.ts`. The journey helpers were checked first, as the
ruling required: `runMvpLoopJourney` does reach a roadmap and an artifact, but only by driving the core use
cases through a **fake model gateway** with an injected `ops` bundle, and the adversarial HTTP suite has
neither.

**Two NOT NULL columns exist only as later `ALTER`s** and would have failed a `CREATE TABLE`-only reading:
`policies.autonomy_level` (0049) and `approval_requests.payload_hash` / `binding_version` / `expires_at`
(0048). The generated Kysely types encode NOT NULL as a *required insert field*, so `tsc` is a real check on
the column set — it also caught `strategy_options.fields` typing its insert as `Record<string, string>`
while `policies.rules` types its own as `string`, two jsonb columns that do not agree.

### THE FIRST MUTATION REPORT WAS WRONG, AND THAT IS THE ENTRY WORTH READING

The ticket was reported complete with: *"planting the three foreign fixtures in the caller's own company
turned **10 tests red** across all three blocks, including the raw-column tripwire."* **False, and
retracted.**

Reading the failure TEXT rather than the COUNT shows the mutation moved each foreign fixture into company A
while the caller's own fixture was already there, putting two version-1 rows in one company:

```
error: duplicate key value violates unique constraint "understanding_documents_company_version_uq"
error: duplicate key value violates unique constraint "policies_company_version_uq"
```

Those threw in `beforeEach`, so **every** test in the roadmap and approvals blocks failed — including
`an unknown query parameter is REFUSED, not ignored`, which has nothing to do with tenant isolation.
All-tests-in-a-block-red is the signature of a fixture error, not of a control being exercised. **Eight of
the ten were fixture errors; two were assertions.**

This log already records *a red exit code is not evidence* (ACBP-P7-013's probe reported 7/7 kills having
run zero tests). This is its subtler form and it defeated the same author on the same day: the tests really
did run, really did go red, and the number was still not evidence, because nothing checked WHY. **A mutation
report must quote the failing assertion messages, not the tally.**

The corrected evidence is two collision-free mutations producing five quoted assertion failures — M1
(marker collision, rows stay in their own companies so no UNIQUE constraint is touched) fires
`A's own roadmap read must not contain B's goal title`, `A's own inbox must not contain B's preview` and
`A's own board must not contain B's task`; M2 (relocation, artifact block, where no UNIQUE constraint
applies) fires `artifact: B's artifact must not surface inside A` and the artifact-granularity
`expected 200 to be 404`. Restored byte-for-byte after each run and re-verified green.

### Independent review found six defects AFTER the work was called complete

Five dimensions, two adversarial refuters per finding: 29 reported, **6 survived**. Four were prose that
this ticket's own change had falsified. Two were live vacuities:

- **The artifact positive control asserted 2 of the 3 routes `callAll` drives.** `lineage` was requested and
  discarded, so every lineage negative was still satisfied by a lineage route serving nothing to anybody —
  the exact vacuity the ticket exists to close, left open on one route. The relocation mutation could not
  reveal it either: `artifact` is index 0, so its assertion throws before lineage is examined. **Partial
  coverage of a multi-route helper is the failure mode; assert every route the helper drives.**
- **Adding a task-board positive control exposed a PRE-EXISTING vacuity nobody was looking for.**
  `tasks.state` defaults to `'draft'`, and drafts are deliberately OFF the board — `getTaskBoard` counts
  them only in `draftsOffBoard`. The foreign task had always been seeded at that default, so *"B's task
  never appears in A's board"* was asserted about a task that appears on **nobody's** board, including its
  own company's. True for a reason unrelated to isolation, and true since the block was written.

A **fifth CDR-088 block the audit never visited** also surfaced: the roadmap EDIT block still claimed an
"inability to seed a roadmap (the decision chain)" that this ticket had just disproved, and rested its
no-write negative on an empty table. It now seeds, so the baseline contains a real foreign roadmap the
refused edit must leave exactly as it found it.

**The pattern, stated plainly: every comparative or absence claim a comment makes about a sibling block goes
stale silently when the sibling improves.** Three of the four prose defects were exactly that shape. The
corrections delete the comparison rather than update it.

### Local PostgreSQL is reachable again, and the documented path did not work

`ACBP_TEST_DATABASE_URL` has been unset on this machine for most of this project's history, which is why so
many real-PG suites in this log were skipped rather than run. The `acbp-local-dev` distro was already
provisioned and `pnpm local:db:setup` is the sanctioned tool. A full `pnpm run check` now runs **284 files /
4207 tests at zero skips** locally.

**`docs/LOCAL-DEVELOPMENT.md` claims the database is reachable at `127.0.0.1:5432` via "WSL localhost
forwarding". That did not hold here** — PostgreSQL accepted connections on WSL's own loopback while Windows
got `ECONNREFUSED`, with no `.wslconfig` and WSL on defaults. Worked around **locally only** by binding the
cluster to the WSL interface and allowing the private WSL subnet (never `0.0.0.0/0`). **No repository file
was changed for this** — one machine's NAT behaviour is not evidence about the documented path, and a doc
rewritten from a single failure is worse than one with a known caveat.

Three hazards from that work, all handled:

- **`pnpm local:db:setup` OVERWRITES `.env.local` wholesale** (`[IO.File]::WriteAllText`), and this
  machine's held the owner's `ANTHROPIC_API_KEY`. Backed up first, merged back after. The script's docstring
  says it writes the file; it does not say it destroys unrelated keys in it.
- **A vitest error dump printed the generated database password** into the session, because the serialized
  `pg` error carries `connectionParameters`. Rotated immediately rather than left live.
- **The WSL VM drops mid-run**, producing `the database system is shutting down` across suites the ticket
  never touched — 17 red tests, all one dead server. Pinned open with a keepalive. Again: read the failure
  text, not the count.

The run that mattered took three attempts for reasons unrelated to the code, and the pattern is one this log
already records: **the connectivity check and the thing being checked kept running in different
invocations.** A `Test-NetConnection` that succeeded and a vitest run that failed were never in the same
shell. Putting the precheck and the run in one invocation is what finally produced a readable result.

### A "zero skips" check that could not have said no

The first CI skip check reported "zero skip lines" — and had also failed to find the *tallies*, which meant
it was not matching the log format at all. A detector that finds nothing because it matches nothing reads
exactly like a clean result. The ANSI strip then removed 3 bytes (a BOM), because the `^[` in GitHub's log
is the literal two-character sequence, not an ESC byte. Only after fixing the parse **and feeding it a
synthetic `4200 passed | 7 skipped (4207)` line to confirm it fires** is "zero skips" evidence rather than
an absence of evidence.

### Three numbering collisions avoided by checking every remote branch, not `main`

`main` has CDRs up to 089, so 090 looked free. **090, 091 and 092 are all claimed on unmerged sibling
branches** — 090 by `origin/p8-api-006-cdr`, 091 and 092 by `origin/p8-api-006-model-gateway` (091 also on
three further branches). This ticket is **CDR-093**. Taking the next number visible on `main` alone would
have collided three times over. The reliable check enumerates CDR numbers across every remote branch with
`git ls-tree`, not the working tree.

### A structural judgment call the owner can reverse

The ruling asked for *"backlog row filed for the ticket itself."* `ACBP-API-*` tickets have **no backlog
anywhere** — they are outside the 104-ticket numbering, and `BACKLOG.csv` is exactly 104 rows, a count
`OWNER-ACTION-PACK.md` states and `FRONTEND-BACKLOG.csv` leans on in a column named *"backend work NOT in
the 104-ticket backlog"*. Making it 105 would falsify a structure other documents depend on.

The row went into a new `docs/implementation/API-BACKLOG.csv`, mirroring the precedent the owner approved
when out-of-backlog frontend work got `FRONTEND-BACKLOG.csv` (PR #95). **It contains this ticket only.**
`ACBP-API-001` through `009` belong to the concurrent session, are recorded in this log, and were
deliberately not backfilled — inventing rows for another session's tickets would be worse than the gap.


### MERGE MARKER — ACBP-API-010 is on `main` (appended 2026-08-17)

Pinned to squash SHAs, tree hashes and run ids rather than status words, so nothing here can go stale.

| Ticket | Squash SHA | PR | Exact-head CI | Exact-main CI |
| --- | --- | --- | --- | --- |
| **ACBP-API-010** — seeded foreign-row invisibility proof for every CDR-088 tenant-data read | **`3ca0971`** | #122 | **`32047608085`** on `dee627d` | **`32048661352`** on `3ca0971` |

Both runs report **`284 passed (284)` test files and `4207 passed (4207)` tests**, plus `12 / 267` for
`test:boundaries`, with **zero failures and no skip tally anywhere in either log**. The production build ran
in both. The two runs agreeing exactly is what a byte-identical squash should produce.

**The skip claim was made with a detector that was first shown capable of failing.** An earlier pass through
the same log reported "zero skip lines" while also failing to find the *tallies* — it was matching nothing at
all, and a detector that finds nothing because it matches nothing is indistinguishable from a clean result.
The `^[` in a GitHub log is the literal two-character sequence, not an ESC byte, so an ANSI strip keyed on
char 27 removes only the BOM. Every "zero skips" figure above was produced by a parser that was fed a
synthetic `4200 passed | 7 skipped (4207)` line and observed to fire on it.

**Merged, then verified, then deleted — in that order.** Branch-head tree `f0d5a04956aa7a8898e2f180d09b6cf5945d8f50`
equals the squash tree on `main`, and `git diff api-010-roadmap-isolation-proof origin/main` was empty.
Ancestry can never pass for a squash, so the tree is the check. `api-010-roadmap-isolation-proof` (was
`dee627d`) is deleted from the remote and locally; no `api-010` ref remains.

**A deletion instruction arrived one step early and was refused.** "Delete the branch and finalize" came
while the merge had not happened: PR #122 was still `OPEN` with `mergedAt: null`, `origin/main` was still
`4a8b377`, and all four commits existed only on the branch. `git merge-base --is-ancestor` said the branch
was not contained in `main`. Deleting then would have destroyed `622baae` (proof + fixtures), `6db2e72`
(the two vacuity fixes and the retraction), `4856581` (this log's entry) and `dee627d` (CDR-093 accepted).
**The tree/ancestry distinction is what made the refusal legible rather than a guess:** ancestry failing is
normally uninformative after a squash, but here there was no squash commit at all, and `main` was byte-for-byte
where it had been three hours earlier.

### What is on `main` that was not before

- **`packages/test-support/src/tenancy/isolation-fixtures.ts`** — model-free builders for tenant rows behind
  a multi-table constraint chain, with a guard that throws rather than returning an id for a row that is not
  there. Every constraint read out of the migrations, including two NOT NULL columns that exist only as later
  `ALTER`s (`policies.autonomy_level`, and `approval_requests.payload_hash` / `binding_version` / `expires_at`).
- **Five CDR-088 blocks now seed** — roadmap read, artifact reads, approvals inbox, task board, roadmap edit —
  each asserting the foreign row EXISTS on the owner connection first, then proving byte-identical refusal
  with it present, then proving the caller's own read still serves the caller's own data.
- **`docs/implementation/API-BACKLOG.csv`** — a new tracking file, because `ACBP-API-*` sits outside the
  104-row `BACKLOG.csv` whose count `OWNER-ACTION-PACK.md` states. Row `ACBP-API-010` is `Done` as of this
  marker, on the owner's instruction. `ACBP-API-001`…`009` belong to the concurrent session and are
  deliberately not backfilled.
- **CDR-093**, accepted by the owner. 090, 091 and 092 were all claimed on unmerged sibling branches.

### The two findings worth carrying forward

**An unverified premise cost two matrices their proof.** The artifact and approvals blocks each declined to
seed because `run_id` supposedly had "an FK to `runs`". No `runs` table exists in this schema; the constraints
are tenant-pinned composites onto `task_runs`, which the CDR-089 block in the same file had been seeding two
hundred lines above. ACBP-P7-014 established that a control whose justification cannot be checked must not
ship. This is the inverse and it is quieter: an unchecked premise talked two tenant-data matrices *out of*
proving isolation, and nothing ever failed, because a disclosure costs nothing to leave in place.

**A positive control is what makes a negative mean anything, and adding one found a bug nobody sought.**
Company A held no roadmap, artifact or board task, so "A's read does not contain B's data" was satisfied by a
read returning nothing to anybody. Adding the task-board positive control then exposed a *pre-existing*
vacuity: `tasks.state` defaults to `'draft'` and drafts are deliberately OFF the board, so the foreign-task
negative had been asserted about a task that appears on **nobody's** board since the block was written.


### MERGE MARKER — ACBP-FE-005 and the FE backlog label correction are on `main` (appended 2026-08-17)

Pinned to squash SHAs, tree hashes and run ids rather than status words, so nothing here can go stale.

| Ticket | Squash SHA | PR | Exact-head CI |
| --- | --- | --- | --- |
| **FE backlog label correction** — FE-013/FE-014 stale `Blocked-API` cells | **`2340fa3`** | #125 | **`32060226143`** on `60d413b` — 284 files / 4207 tests |
| **ACBP-FE-005** — company creation and provisioning progress | **`442c380`** | #124 | **`32058460054`** on `bda5b33` — 288 files / 4248 tests |

Both head runs: **12 / 267 for `test:boundaries`, zero failures, and NO skip tally anywhere in either log.**
FE-005's +4 files / +41 tests over the 284 / 4207 baseline is exactly its four new suites — 15 create-outcome,
12 provisioning-view, 6 resume-outcome, 8 contract-alignment.

**Exact-main CI on the combined tree: `32061460475` on `442c380` — 288 files / 4248 tests, 12 / 267
boundaries, zero failures, no skip tally, production build ran.** It matches FE-005's pre-merge totals
exactly, so the label correction interacted with nothing — which is what the owner's disjoint-diffs ruling
was a judgement about, now measured rather than assumed.

Every "zero skips" figure in this marker was produced by a parser that was first fed a synthetic
`4200 passed | 7 skipped (4207)` line and observed to fire on it. A detector that finds nothing because it
matches nothing is indistinguishable from a clean result, and this log already records one occasion where
that cost a round of worthless evidence.

### The deletion check had to change shape, and the difference is the point

For #125 the usual check held: squash tree `07e622a5f3326ea36efd03fee52c0dabc653d0c5` equalled `main`'s, and
`git diff branch origin/main` was empty.

**For #124 tree-equality FAILED — `1bd505d…` against `63ccbbc…` — and that failure was correct rather than
alarming.** `main` moved between FE-005's CI and its merge, because #125 landed in between. A tree comparison
answers "is main byte-identical to this branch", which is the right question only while main stands still.

So the check became: **is every file this branch touched byte-identical on `main`?** All fifteen were, and the
comparison was self-tested first — fed a file that SHOULD differ, and confirmed to report it — because a
comparison that silently matches nothing reads exactly like a clean result. The single branch-vs-main
difference was `FRONTEND-BACKLOG.csv`, which FE-005 never touched: #125's correction, which the branch
predates.

Recorded because both failure modes were live here: accepting the tree mismatch at face value would have
blocked a legitimate deletion, and waving it through would have risked deleting unmerged work.

### Merged without a rebase, on an explicit owner ruling

FE-005's green was taken against `main` at `ba7b3e8`; `main` was `2340fa3` by merge time. The owner ruled
"merge anyway, diffs are disjoint" after the staleness was raised. Supporting evidence: GitHub reported
`mergeable_state: clean`, and a local `git merge-tree` trial produced **zero conflict markers**. The
pre-merge green still did not itself cover the combined tree — `32061460475` is the first run that does, and
it is cited above rather than assumed.

Also noted so it is not rediscovered: the `main` run for `2340fa3` was **cancelled** by #124 landing on top of
it. A cancelled run is not a failed one, and it is not evidence either.

### What ACBP-FE-005 put on `main`

Two screens — `/console/companies/new` and `/console/companies/{companyId}/provisioning` — three pure
interpreters, and the portfolio's "Create a company" control turned from a disabled button labelled *not built
yet* into a real link. That button had been honest for exactly as long as the claim was true.

**Three contract facts shaped it more than any design choice:**

- **`POST /api/companies` BLOCKS on provisioning** (`core company-service.ts:192-211`), so the 201 already
  carries the verdict. The common render of a "progress" screen is the FINISHED state, and a stall is
  detectable at create time rather than after the first poll.
- **There is no `running` step status.** `PROVISIONING_STEP_STATUSES` is `pending | completed | failed` and the
  contract calls `running` *"intentionally ABSENT: an in-flight step … must never survive a commit"*
  (`contracts provisioning.ts:22-27`). So there is no stepper spinner and deliberately **no `--running` CSS
  modifier** — unreachable styling implying a state the database refuses to hold is the same class of lie as a
  control that cannot act.
- **The stalled signal is a real field.** `resumable` / `exhausted` / `completed` come from
  `deriveProvisioningFlags` (`:137-148`), which also makes four arms mutually exclusive: all three false
  happens IFF the step set is malformed. That arm says an operator must look; it does not imply quiet progress
  and does not offer a resume the server would refuse with 409 — whose body, note, carries **no
  discriminator**, so the copy states the server refused without claiming which of five gates applied.

### Three defects the tests caught that reading would not have

- **The screen was discarding the server's own error message.** The 400 validation arm carries a
  `PublicErrorEnvelope` OBJECT whose `message` names which of three fields is wrong
  (`companies-http.ts:180-181`, `errors.ts:71/:147`). The first interpreter treated `error` as a string and
  substituted vaguer copy of its own — the inversion of this console's founding rule — and **its unit tests
  passed because they asserted the same wrong shape**.
- **`Number('') === 0`**, so an empty `Retry-After` parsed as "retry immediately": a 429 telling a
  rate-limited founder to hammer the endpoint.
- **`create-contract-alignment.test.ts`** drives the REAL `toCompaniesResponse` instead of hand-written bodies,
  because a hand-written body encodes what the author BELIEVED the server sends. Writing it immediately proved
  the `created` arm is FLAT — the `{company:{…}}` nesting is built BY the responder — and that an
  `as CompaniesRequestResult` cast had hidden the wrong shape from the compiler. The cast is gone.

Two more were fixture-shaped: `null ?? 'profile'` in a test helper silently replaced the explicit `null` the
one null-path case existed to exercise, and a phantom `--r-2` CSS token whose fallback would have hidden it
while others copied it forward.

### The evidence limit, stated rather than implied away

The measured harness passes `/console/companies/new` **12/12** — no horizontal overflow at 1440 / 900 / 492,
viewport meta, no auth header, correct shell tracks. It **cannot validate any data-reading console page in
this environment**: without real Clerk credentials they return 500, so those measurements are of Next's error
page. That affected the provisioning screen — and equally `/console/companies` and the company profile, which
are already merged and were previously green on this same harness. **The change did not break them; the absent
credentials did.** Noticing that the failing pages were ones the slice never touched is what prevented
"fixing" working code until the harness went green. Real keys are an owner gate.

### Backlog state at this marker

`ACBP-FE-005` is **`Done`**, set on the owner's instruction in the same breath as merging this marker — so
the row and this paragraph move together rather than the marker shipping a sentence its own commit falsifies.
Its evidence is the table above: squash `442c380`, exact-head `32058460054`, exact-main `32061460475`, all at
zero skips. `FE-013` and
`FE-014` remain `Blocked-API` deliberately: their cells now name only the three genuinely missing
model-driven routes (`generateStrategyOptions`, `recommendStrategy`, `generateRoadmap`), and re-scoping either
row to its read-only half is a planning decision, not a correction.

The method note in those cells is load-bearing: a glob over the api route tree **silently matches nothing**,
because a path segment in square brackets is read as a character class. That produced a confident, empty,
wrong answer twice before a self-test caught it — the same shape as the `Test-Path` wildcard trap recorded
earlier in this log, now seen four times.


### MERGE MARKER — ACBP-FE-007 is on `main` (appended 2026-08-18)

Pinned to squash SHAs, run ids and quoted assertion text rather than status words.

| Ticket | Squash SHA | PR | Exact-head CI |
| --- | --- | --- | --- |
| **ACBP-FE-007** — interview session screen | **`41160b3`** | #127 | implementation `32069651328` on `6097130` — 292 files / **4332** tests |
| | | | review fixes `32072993347` on `7c36db2` — 292 files / **4335** tests |

Both head runs: **12 / 267 boundaries, zero failures, and NO skip tally anywhere in either log.**
The +3 between them is exactly the three view-mapper cases the review fix brought with it — the guard and
the tests that fail without it landed in the same commit.

**The merge was the clean case, and it is worth recording that it CAN be.** `main` stood still at `072ccb6`
from the CI run through to the merge, so the green on `7c36db2` genuinely covered the merged tree, and GitHub
reported `mergeable: MERGEABLE` / `mergeStateStatus: CLEAN`. No per-file fallback was needed, unlike FE-005
two commits earlier where `main` moved underneath the run.

### The finding that reshaped the ticket, before any code

**No HTTP route in this repository can cause an interview question to exist.** Five interview routes exist
(session read, start, qa read, answer write, suspend/resume); `generateAdaptiveBatch`, `evaluateAnswer` and
`suggestAssumptionForSkip` have **zero references anywhere under `apps/web`**, and `INTERVIEW.md` records the
orchestration routes as deferred behind the live-provider owner gate. Verified by **enumerating all 36 route
files**, because a glob over a bracket path silently matches nothing — the trap this log has now recorded
five times.

So a founder starting an interview gets an empty question list permanently. Two of the row's criteria
therefore shipped **disclosed-not-met**: "batched questions" (no batch grouping, id or size exists on the
wire) and "E2E completing an interview" (nothing writes `ready_for_review`, so there is no completion to
reach, and no DOM harness exists in any `package.json`). Every other consequence is an **absence** — no
next-question control, no finish control, no batch chrome — because each would have been a control that
cannot act.

### THE SLICE COMMITTED THE EXACT DEFECT IT WAS BUILT TO PREVENT, AND ONLY THE REVIEW CAUGHT IT

The first commit passed `qa ?? { items: [] }` into the view mapper. A **failed** question-list read therefore
rendered as a positive server assertion: *"There are no questions in this interview yet. The server has not
produced any for this session."* The server had said nothing of the kind — the only event was a GET that
failed.

The screen knew the distinction and stated it correctly one branch above. But that guard tested `qaRefusal`,
a **prop fixed at mount**, so it could only ever represent a server-component refusal; a client-side failure
fell straight through to the definite copy. And `describeInterview` announced the same fabricated fact to the
polite live region — where, unlike the sighted path, **no error banner exists to contradict it**. A refused
read and a true empty list were byte-identical to a screen-reader user.

Fixed where it cannot recur rather than patched at the call site: `toInterviewView` now takes
`SessionQADTO | null` and owns a fourth `unknown` state, so a caller **cannot** substitute an empty list for a
missing read. Mutation-proved — reverting it yields
`AssertionError: expected 'none_exist' to be 'unknown'` **and**
`expected 'there are no questions in this interv…' not to contain 'no questions in this interview'`, the
second catching the announcement lie specifically.

**This is the strongest evidence in this log for why independent review is not optional.** A full local gate,
two green CI runs at zero skips, 84 passing tests including four mutation checks, and a self-review had all
passed over it. The defect was in the one place none of them were looking: the difference between what the
screen knew and what it said.

### The other 20, grouped by what they teach

**A false security comment is worse than none.** The header claimed a native form POST "arrives with
`Origin: null` and is refused". `decideSameOrigin` consults `Sec-Fetch-Site` **first and exclusively when
present** and returns allow for `same-origin` — so a same-origin form POST is *allowed*, and the Origin rows
are never reached. The code was safe; the stated reason was fiction. The real enforcer is the `cross-site`
row plus the no-provenance row.

**Accessibility failures that a screenshot cannot see.** The answer textarea had **no accessible name** at
all (a `<legend>` names the group, not the controls, and `aria-describedby` is a description) — while the
comment beside it justified the id as safe for `aria-describedby`. Three live regions were created in the
same React commit as their text, the exact failure this file's own comment describes and had guarded in
precisely one of four places. The visible badge counted `addressed` while the announcement counted
`answered`, so the two channels reported different numbers the moment anyone skipped. `.cs-help` measured
**3.98:1** and **3.56:1** against a 4.5:1 AA floor.

**A comment can be invalidated by its own commit.** Three findings, one cause: the five comment lines this
ticket *added* to the focus-visible block pushed the selectors below it down by exactly five, so a
`console.css:681-683` citation written in the same commit was **false on arrival**, and a comment asserting
the textarea is covered "so :541 and :542 both match" ended up pointing at its own prose. Citations into
files a commit edits now name **selectors and symbols, never line numbers**.

**An assertion that cannot fail is not coverage.** `expect(body).not.toContain('accountId')` was a tautology:
the arm is typed `SessionQADTO`, which has no such field, so the responder was handed nothing to leak while
the test name promised a redaction guarantee. Replaced with exact key-set assertions that fail if a field is
**added** — the direction a real disclosure would take.

Also corrected: "exactly one of pause/resume can ever act" (false in five of seven branches, and the test
`describe` title repeated it while two tests under it refuted it); "the DTO mirrors those columns exactly"
(it redacts `account_id` and adds the derived `phase`); "every id in this file is per-question" (two are
literals); "Revised N times" (off by one — `revisions` includes the original); the pause/resume 404 asserting
one of its two causes; and a `conflict` refusal arm for a status the read cannot return, which is this
slice's own no-unreachable-arms rule broken by its author.

### It also repaid a debt from FE-005

`provisioning-progress.tsx` rendered `cs-control-outcome--${kind}` for eight `ResumeOutcome` kinds while only
`refused` and `error` had CSS rules — so on the already-merged provisioning screen a **success** and five
distinct refusals rendered identically. All six gaps are closed, and the accent list is now documented as a
maintained claim like the focus-visible one.

### Evidence limits, stated rather than implied away

The measured render harness reaches only the **signed-out refusal** for this page; without Clerk credentials
the authenticated view returns 500. The question cards, the fieldset/legend and the live regions are
therefore **not** covered by it, and the narrow-width case that matters most here — a textarea inside a
fieldset inside a padded card at 492px — rests on the CSS rules and on review. Real keys remain an owner
gate, and the harness is deliberately not in CI.

### Still owed

`packages/contracts/src/interview/interview.ts:29` states *"a session is never inserted directly into
`in_progress`"*, which `packages/database/src/interview-repository.ts:33` does exactly — and whose own comment
says so. It matters because it is the sentence a future reader would use to argue `phase: 'not_started'` is
reachable; it is not, and only two of the six session states occur in practice. Deliberately left for its own
ticket rather than edited from a frontend slice.


### MERGE MARKER — ACBP-FE-010 is on `main` (appended 2026-08-18)

| Ticket | Squash SHA | PR | Exact-head CI |
| --- | --- | --- | --- |
| **ACBP-FE-010** — transparent memory browser | **`bed0a70`** | #130 | `32086960764` on `3935935` — 295 files / **4407** tests, zero skips |

`main` stood still at `1328c46` from the CI run through the merge, so the green covered the merged tree —
no per-file fallback needed. The FOUR NEW PATCH ROUTE TESTS are named in that log as having executed, which
matters because they live in a `skipIf` real-PG suite and vanish silently without a database.

### What the ticket refused to build

**MEM-004 has no wire.** The row requires "any withheld conflicting item" from the server; no memory route
emits one. MEM-004 lives in `assembleContext`, CDR-025 records it as deferred, and the traceability CSV maps
it to ACBP-P2-007. Computing it client-side would be the UI hiding an item on its own — which the same cell
forbids. The row also names the wrong requirement: this screen serves **MEM-002**, which the row omits.

**The delete dialog refuses the word "permanent"**, because it would be false three ways: the delete is soft,
the record is retained, and earlier versions survive and cannot themselves be removed.

### PATCH had no route-level coverage, and the file read as though it did

The `itemRoute` type declared `PATCH`, but nothing under `apps/web` ever called it — the type was the
only thing asserting the verb existed. Four real-PG tests now pin supersede-not-mutate, the provenance
rewrite, the bare 409, the viewer 403, both 415s, the string-vs-object 400 split, and a forged foreign-tenant
denial that writes nothing.

### The review found 42 defects, and the worst one was a fix

**BLOCKER, self-inflicted:** minutes before the review returned I "corrected" a hardcoded `100` by importing
`MEMORY_LIST_DEFAULT_LIMIT` from `@acbp/core` — into a `'use client'` module, dragging the server
composition graph across the client boundary. `check:boundaries` passed it, so **that checker has a gap this
review did not**. The limit is now a prop from the server page.

**Two HIGH on the delete path.** The delete answer could never be read — it was keyed to a table row, and the
reload removes that row, so a 200 "removed", a 404 "nothing was there" and a 409 "state changed" all rendered
**identically**. And the empty state said "an empty list means nothing has been recorded, not that anything
was lost" — reachable one action after a founder deleted their last item.

**The dialogs claimed `aria-modal="true"`** while the CSS shipped in the same commit said, correctly, that a
modal trapping nothing is worse than a form in the page. Nothing trapped focus.

**A reassurance pointing at a door that does not open:** the copy promised the item "still appears in your
data export" — true of the stored row, naming a document no route or screen in this build can produce.

### The encoding guard earned its keep

A PowerShell `.Replace()` with backticks inside a double-quoted string ate an "a" and left a raw BEL in a
comment — damage that survives typecheck, lint and tests because it lands in a literal. `pnpm run check`
caught it. That is the `CHECK=1` this log already records as having been scrolled past once.

### Backlog state

`ACBP-FE-010` → **Done**. The FE board is now **8 Done, 5 Planned, 6 Blocked-API**. Of the Planned five,
**FE-008 and FE-009 are effectively blocked** — verified zero HTTP wiring for the question generator and all
seven understanding use cases — and FE-019 is a ruling rather than a screen. **FE-003 and FE-012 are the only
buildable screens left on the current API.**
### MERGE MARKER — ACBP-FE-012 is on `main` (appended 2026-08-18)

| Ticket | Squash SHA | PR | Exact-head CI |
| --- | --- | --- | --- |
| **ACBP-FE-012** — Decision Room queues | **`ac5ddd6`** | #133 | `32126593976` on `19864a7` — 297 files / **4442** tests, zero skips |

`main` stood still at `bed0a70` from the CI run through the merge, so the green covered the merged tree.

### The row's requirement had a trap in the word "disconnect"

This stream **always ends**: a bounded five-minute lifetime and a terminal `closed` event on every exit the
server controls. Ending is the NORMAL case, not a fault. The server's own comment gives the motive — "the
room went quiet" must never be how a founder learns their access changed. So five endings get five outcomes:
routine expiry reconnects; `unauthorized` **stops**, because the stream re-authorizes every tick and
retrying would hammer an endpoint that keeps refusing; `unavailable` polls; a refusal-to-open is a refusal,
not a loss; and an ending with no terminal event is the genuine transport fault.

### The review found a permanent silent freeze — the exact outcome the row forbids

Keying the transport effect on `stream.mode` meant a SECOND `max_lifetime` produced
`reconnecting → reconnecting`: the handler closed the socket, the dependency string was unchanged so the
effect never re-ran, no replacement opened, and polling stayed inert because it requires `mode === 'polling'`.
The badge would have read "reconnecting" forever while nothing was connected. The same dependency also tore
down HEALTHY connections on their first event. Fixed with an explicit `connectionEpoch`; mutation-proved.

**The banned word was on screen.** Three files declare "live" banned because the channel is `poll_backed` —
and the badge rendered `stream.mode` verbatim. The test named as the enforcement only inspected
`describeStream`, never anything the panel rendered. That is the third consecutive ticket where a guarantee
was asserted in prose with nothing actually enforcing it.

**A dead listener I caught before the review, which it then confirmed independently:** the server writes its
heartbeat as an SSE *comment*, and EventSource ignores comments entirely; its only named events are `room`
and `closed`, and `message` fires only for an event with no name. The listener could never run, and the
comment calling it "the closest observable signal" named an enforcement that did not exist.

### Deliberate departure from the row, and an owed test

**Queues do NOT collapse to tabs on mobile.** Tabs would hide nine of ten queues behind a control, and the
whole point of this screen is seeing at a glance which queues did *not* report. They stack instead.

**No test exercises the EventSource wiring.** Every fix is proved at the reducer, where the logic lives, but
the panel has no test file — so "closing the source suppresses the browser's auto-retry" is enforced by one
line and asserted by nothing. A DOM-level test is impossible here: no DOM harness exists in any
`package.json`.

### Board state, corrected

Marking FE-012 Done exposed that **FE-010 was still `Planned` on `main`** — its marker PR (#132) had been
opened and never merged, so a "9 Done" count stated earlier in this session was wrong. #132 is merged as
`ff9738f`. The FE board now reads **9 Done, 4 Planned, 6 Blocked-API**, and of the four Planned, FE-008 and
FE-009 are effectively blocked (verified zero HTTP wiring) and FE-019 is a ruling rather than a screen —
leaving **FE-003 as the only buildable screen on the current API**.

---

## 2026-08-19 — Next.js loads env per project directory, and a repo-root `.env` reaches no app workspace

**Class lesson, recorded so no future session rediscovers it through a 500.**

`next dev` loads `.env`, `.env.local` and friends from the **project directory it runs in** — for this repo
that is `apps/web`, because `dev` resolves to `next dev` inside that workspace. A `.env` at the monorepo root
is never read by the web app, no matter how correct its contents are. This is not a pnpm-workspace quirk or a
misconfiguration; it is how Next resolves dotenv files, and it applies to every app workspace in any monorepo.

The failure is easy to misread because it does not present as a missing-file error. `apps/web` had **no env
file at all**, so `getClerkIdentityRuntime()` threw `ConfigValidationError: CLERK_WEBHOOK_SIGNING_SECRET:
invalid (redacted)` and `/console/companies` returned a 500 — while `/console` kept rendering fine, because
that screen is entirely mock data and never touches the runtime. One page up, one page down, same server:
the shape of the symptom pointed at the *page* rather than at configuration. Two sessions in a row read that
500 as a database problem, and it never was one: `loadClerkWebhookConfig()` runs at `clerk-runtime.ts:16`,
**before** `loadClerkConfig()` and `loadAppDatabaseConfig()`, so the first missing variable wins and the stack
trace names only it. Read the whole load order before concluding which dependency is absent.

The fix is `apps/web/.env.local` (git-ignored via the root `.gitignore:3` `.env.*` pattern, which matches at
any depth). Three things had to be true together, and any one missing reproduces the same 500: the Clerk
publishable and secret keys — Clerk 7.5.20's **keyless dev mode** provisions a real temporary instance and
writes them to `apps/web/.clerk/.tmp/keyless.json`, so the app boots with no dashboard signup at all; a
`CLERK_WEBHOOK_SIGNING_SECRET`, which locally is a clearly-labelled **placeholder** — it exists only to
satisfy startup validation, no webhook is delivered locally, and a real one would correctly fail signature
verification; and `DATABASE_APP_URL` pointing at the **restricted `acbp_app` role** (never the owner
connection — CDR-013), which additionally required applying all 56 migrations to `acbp_dev` and giving that
role a login password, since the local provisioner creates only `acbp_dev`.

**The generalisation worth keeping:** when a config value must reach a Next app, put it in that app's own
directory and verify by request, not by inspecting the root. And when a validated-config loader throws, the
variable it names is the *first* one it checked, not necessarily the only one missing.

---

## ACBP-API-013 / ACBP-FE-008 / ACBP-FE-009 — 2026-08-19

Full record in `docs/implementation/config-decisions/CDR-095-understanding-read-and-interview-verdicts.md`.

**Class lesson: a CHECK-constrained column will accept an invented value from a fixture right up until the
database sees it, and by then the diagnosis is eight lines away from the cause.**

A new real-PostgreSQL suite seeded an understanding item with `item_class: 'risk'`. There is no such class —
the closed six live in `UNDERSTANDING_CLASSES` and migration 0019 enforces them with
`understanding_items_class_valid`. Every one of the eight tests in the file went red, all of them in
`beforeEach`, with a single underlying error:

```
error: new row for relation "understanding_items" violates check constraint "understanding_items_class_valid"
```

Three things are worth keeping from it.

**One:** all-tests-in-a-file-red is the *fixture-threw* signature, and it means none of them tested anything.
Reading the failure list as eight problems wastes the whole diagnosis; it is one problem, in the setup.

**Two:** the durable fix is the TYPE, not the string. The fixture helper took `readonly [string, string, number]`,
so `'risk'` compiled. It now takes `readonly [UnderstandingClass, string, number]`, which makes an invented
class a compile error in the editor rather than a red CI run nine minutes later. Any fixture writing to a
CHECK-constrained column should take the imported union, never `string` — the constraint already exists, and
the only question is how late you find out you violated it.

**Three, and this is the part that generalises past fixtures:** the SAME widening exists in the read path.
`UnderstandingSectionDTO` types both `class` and `status` as `string`, not as their closed unions. Code
consuming that DTO must narrow defensively — an unrecognised class is counted and reported rather than
rendered under an invented heading or silently dropped, and an unrecognised status falls back to the
deny-by-default reading rather than to a confident one. A DTO that widens a closed vocabulary to `string` is
an invitation to trust it; check the migration's CHECK before mapping any string column, in both directions.

**Why local runs could not have caught this.** Local PostgreSQL is unreachable from Windows here — the
Hyper-V firewall blocks the WSL address, and opening it is a system-security change and an owner action. All
1,704 real-PostgreSQL tests therefore skip locally, silently, while the suite reports a clean exit 0. Hosted
CI at zero skips is not a formality on this repository; on this ticket it was the only thing that ran the
code at all.

---

## The console plan badge — 2026-08-20

**A UI element asserted a commercial fact that has no entity behind it, and it did so in the LAYOUT, which is
what made it more than cosmetic.**

The console top bar rendered `<span className="cs-badge cs-badge--muted">{MOCK_COMPANY.plan}</span>` — the word
"Growth". Removed, with the absence asserted in `apps/web/src/app/console/layout.test.tsx`.

### The verification, because the premise was checked rather than believed

The task arrived asserting "there is no plan entity anywhere in this platform" and instructing that this be
verified first. It was, and the sweep found **one thing the assertion missed**, which is the reason to record
it rather than just say "confirmed":

`accounts.plan_state` exists — migration 0003, `text NOT NULL DEFAULT 'free'`. It is not a plan entity and it
does not rescue the badge, for four reasons that had to be checked separately: its only CHECK is
`char_length(plan_state) > 0`, so it carries **no vocabulary at all**; it is written by nothing but its own
default (`provisioning.ts`: *"the only value in P1-003"*); no contract type, route or authorization action
reads it; and the `'pro'` values that appear in the RLS suites are arbitrary mutable strings proving tenant
isolation, not a domain vocabulary. So the nearest thing to a source for that badge says **`free`**, not
`Growth` — the badge was not merely unsourced, it contradicted the one plan-shaped datum the schema holds.

Everything else the task asserted held: no `plans` / `subscriptions` / `entitlements` table across all 56
migrations, no plan or tier type in `@acbp/contracts`, no route, no authz action. (`billing:read` is in the
authz vocabulary but gates the CREDIT LEDGER — a different thing, and worth naming so the next reader does not
mistake it for entitlement plumbing.) `'Growth'` occurred **exactly once** in the repository and nothing read
it. BILL-001 is Post-MVP with D-02 open; CDR-092 §10 records that nothing debits a balance yet.

### Removed, not labelled — and the second reason is the one that generalises

Option (b) was to keep the badge and mark it visibly a placeholder. Rejected on two grounds.

**One: a placeholder still asserts the category.** Marking "Growth" provisional says this platform HAS plans
and merely has not filled one in. It does not. The failure mode is not a wrong VALUE of a real field; it is a
real-looking field for an entity that does not exist. That distinction is exactly why the company NAME stays
and the plan went: `companies.name` is a real column, so "Northwind Coffee" is a placeholder value for
something the database can hold, while a plan was a placeholder for nothing.

**Two: reach.** The overview page carries a visible mock-data banner. The layout does not and cannot usefully
— it wraps every console screen, including the ones rendering real database rows, so a claim in the chrome
inherits the credibility of whatever it happens to sit above.

An independent corroboration landed mid-session: **ACBP-FE-018 merged as `2acea99` (PR #155) while this work
was in progress**, and its usage screen reached the same conclusion for the same reason on a different
element — it rejected a disabled "Manage plan" button because that *"would imply a billing system exists and
is merely switched off"*, and states in prose that *"no plan or price exists"*. That sentence now renders
directly beneath the top bar, so from `2acea99` until this change the contradiction was live on `main`, not
hypothetical. This work was rebased onto that merge; the two changes touch the same two files in different
hunks and rebased clean.

**A third reason, procedural:** option (b) would have required inventing a visual placeholder treatment —
a design decision under the owner's standing FRONTEND/UI gate. Deleting an element that states something false
is not a design direction; drawing a new one is. The cheaper option was also the only ungated one.

### THE TEST THAT PASSED FOR THE WRONG REASON, CAUGHT BEFORE IT SHIPPED

This is the entry worth reading, and it is AGENTS.md §3 catching its own author in real time.

The vocabulary guard was written as `expect(header.textContent).not.toMatch(/\b(plan|tier|...|growth|...)\b/i)`
and **passed on the first run, against the badge that was still on screen**. DOM `textContent` concatenates
sibling elements with no separator, so the header came back as one run — `...Northwind CoffeeGrowth...` — and
`\bgrowth\b` requires a word boundary before the `G` that two adjacent letters do not provide. The check could
not have failed no matter what the badge said.

It was only visible because the run was read test-by-test rather than as a count: two guards went red and this
one went green, and a guard written specifically for the defect that is green while the defect is present is a
contradiction, not a pass. Fixed by walking text NODES and joining with a space, plus a `toMatch(/\bCoffee\b/)`
sanity line so a future failure is legibly about vocabulary rather than about parsing. It then failed on the
real markup exactly as it should have from the start.

**The generalisation:** `textContent` is not the string a reader sees — it is the string with every boundary
between elements deleted. Any assertion that depends on word boundaries, word counts or adjacency must not be
built on it. And more broadly: when a new guard passes on the FIRST run, before the fix, that is not
reassurance that the code was already fine — it is the signal to go find out why it cannot fail.

### Evidence

- **TDD**: guards written first; three of four red on the unmodified tree with real `AssertionError`s (the
  fourth is the positive control, green by design — a layout rendering nothing would satisfy every negative
  assertion here, so the name and initials are asserted before anything is denied).
- **Mutation-proved both ways**, each break read back from disk before running and each file confirmed
  byte-identical by `sha256sum` afterwards: restoring `plan: 'Growth'` to `MOCK_COMPANY` kills the field guard
  AND turns `tsc` red with `TS2578: Unused '@ts-expect-error' directive` — which also proves, rather than
  assumes, that `tsc` covers `.test.tsx` under `apps/web`; restoring the badge span kills both the
  rendered-badge guard and the vocabulary guard.
- `pnpm run check:static` — **exit 0** (typecheck, lint, all structural checks, 300/300 boundary tests).
- `pnpm run test` — **exit 0, 3250 passed / 1710 skipped**. The skips are the real-PostgreSQL suites; local
  Postgres is unreachable here for the reason the 2026-08-19 entry above records. **Hosted zero-skip CI on the
  exact head is still owed** and is the authoritative evidence; this local run is not a substitute for it.

### Classification and scope

**Defect fix, not a design decision — no CDR.** The decision it does make (remove rather than label) is
recorded here and above the constant in `mock-data.ts`. No backlog row exists or was created: this is a
correction to ACBP-FE-002's shell, not a new slice.

**Deliberately NOT fixed, and flagged rather than folded in:** `MOCK_COMPANY.name` and `.initials`
("Northwind Coffee" / "NC") are still invented, still in the layout, and therefore still render above
real-data screens with no banner. They are a lesser problem for the reason given above — placeholder values of
a real column rather than a fabricated entity — but "lesser" is not "fine", and wiring the chip to the company
the user is actually looking at is a real piece of work with its own scope. It is named here so it is not
mistaken for having been considered and accepted.
