# Phase 0 Execution Order

**Date:** 2026-07-18 · **Status:** Approved sequence for the first implementation wave (owner roadmap approval recorded). Decision tickets ACBP-P0-001…004 and 006…010 are resolved (CDR-001…009); **ACBP-P0-005 remains BLOCKED (owner selection: object-storage provider)** — it does not gate any first-wave ticket (latest safe point: before ACBP-P5-011).

Routing: [R] routine · [H] high-reasoning · [T] trust-critical maximum reasoning. Trust level: standard / elevated / trust-critical. **Nothing below is executed by this planning task.**

| # | Ticket | Title | Depends on | Why here | Parallel with | Routing | Trust | Required review | Expected handoff artifact |
|---|---|---|---|---|---|---|---|---|---|
| 0 | ACBP-P0-001…010 | Decision tickets | — | Resolve every `Ready-pending-decision` gate | each other | [A]/[R] | standard | Owner (done 2026-07-18; P0-005 pending) | CDR-001…009 (done) |
| 1 | ACBP-P0-011 | Repository scaffold | decisions (none blocking it) | Everything depends on the repo existing | — | [R] | standard | Structure vs spec diff review | Completion handoff + structure listing (`handoffs/ACBP-P0-011.md`) |
| 2 | ACBP-P0-012 | Dependency-boundary enforcement | P0-011 | Boundaries must exist before code accumulates | P0-013 | [H] | elevated | Seeded-violation proof reviewed | Handoff + boundary-test evidence |
| 3 | ACBP-P0-013 | Static analysis | P0-011 | Gates before features | P0-012, P0-014 | [R] | standard | CI-gate proof | Handoff + gate runs |
| 4 | ACBP-P0-014 | Test foundation | P0-011 | Tests land with every later ticket | P0-013 | [R] | standard | Sample-suite review | Handoff + green sample suite |
| 5 | ACBP-P0-015 | Configuration validation | P0-011; CDR-005 | Bootstrap contract before any adapter | P0-016 | [R] | standard | Negative-validation proof | Handoff + rejection evidence |
| 6 | ACBP-P0-016 | Structured errors | P0-011 | Error envelope before handlers exist | P0-015, P0-017 | [R] | standard | Contract-test review | Handoff + envelope tests |
| 7 | ACBP-P0-017 | Correlation + redacted logging | P0-011 | Redaction before the first real log line | P0-016 | **[T]** | **trust-critical** | Trust-critical review: seeded-secret negative test | Handoff + redaction evidence |
| 8 | ACBP-P0-018 | PostgreSQL foundation + migration discipline | P0-011; CDR-003/004 (env docs) | Data layer before any persistence feature; RLS-ready session plumbing | P0-017 | [H] | elevated | Migration cycle + tenant-context compile-guard review | Handoff + persistence suite |
| 9 | ACBP-P0-019 | Provider adapter contracts | P0-011; CDR-001/005 | Contracts before any provider code; fakes for all later testing | P0-018 | [H] | elevated | No-plaintext-egress negative test review | Handoff + contract suite |
| 10 | ACBP-P0-021 | Local development setup | P0-018 | New-engineer on-ramp before Phase 1 staffing | P0-020 | [R] | standard | Doc walkthrough | Handoff + walkthrough record |
| 11 | ACBP-P0-020 | CI checks | P0-013, P0-014 | Last: wires every gate; seeded-red proof | P0-021 | [R] | standard | Gate-blocking proof | Handoff + red/green evidence |

**After the wave:** Phase 1 begins at ACBP-P1-001 (Clerk integration; unblocked by CDR-006), strictly ordered per IMPLEMENTATION-ROADMAP-v1.md. The four owner-conditioned tickets (ACBP-P5-001, P5-003, P6-001, P6-007) carry a **mandatory DoR split review** before implementation — recorded in their `Definition of Ready` fields.

**Parallelization summary:** steps 2–7 largely parallel after the scaffold; 8–9 parallel with each other; 10–11 parallel. Serial spine: 1 → (2..7) → 8/9 → 11.
