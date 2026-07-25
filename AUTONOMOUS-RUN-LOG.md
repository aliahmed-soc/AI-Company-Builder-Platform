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
