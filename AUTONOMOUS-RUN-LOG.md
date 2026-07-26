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
