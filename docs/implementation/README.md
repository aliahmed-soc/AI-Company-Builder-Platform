# Implementation Planning — AI Company Builder Platform

**Status: Approved by owner (2026-07-18)** — roadmap, milestone plan, first wave, and the 101-ticket backlog are the working implementation plan, with the conditional DoR split review on ACBP-P5-001/P5-003/P6-001/P6-007. Phase 0 decision sprint executed the same day: **9/10 decision tickets resolved** (`PHASE-0-DECISION-PACK.md`, `config-decisions/CDR-001…009`); **ACBP-P0-005 (object-storage provider) awaits owner selection**. Execution sequence: `PHASE-0-EXECUTION-ORDER.md`; scaffold handoff ready: `handoffs/ACBP-P0-011.md`. Accepted requirements and ADRs remain authoritative; backlog changes require traceability updates. **Application implementation has NOT started — no code, scaffold, migrations, manifests, CI, or infrastructure exist.**

| Artifact | Contents |
|---|---|
| `IMPLEMENTATION-ROADMAP-v1.md` | Principles, 8 dependency-ordered phases, critical path, routing categories |
| `MILESTONE-PLAN.md` | M0–M7 with entry/exit criteria, demos, blocking tests |
| `REPOSITORY-SCAFFOLD-SPEC.md` | Future repo structure (12 packages), dependency rules, technology table — **not created yet** |
| `ENGINEERING-STANDARDS.md` | Enforceable standards + 14 forbidden patterns |
| `DEFINITION-OF-READY-AND-DONE.md` | DoR/DoD + status semantics per the project protocol |
| `TEST-AND-VERIFICATION-STRATEGY.md` | 17 test layers + the 20 mandatory trust-critical negative tests |
| `SECURITY-VERIFICATION-PLAN.md` | 18 control areas: threat → controls → tests → evidence → gates |
| `RELEASE-GATES.md` | 5 gates; closed beta = PRD launch gates 1–15, residency-restricted audience |
| `IMPLEMENTATION-OPEN-QUESTIONS.md` | IOQ-01…13 with decision tickets — nothing silently resolved |
| `MVP-BACKLOG.md` | Tickets by phase/epic + model-routing recommendations + slices + first wave |
| `BACKLOG.csv` | **Canonical ticket registry — 101 tickets × 28 fields** |
| `REQUIREMENT-TO-TICKET-TRACEABILITY.csv` | All 141 requirements → tickets/epics; 98 MVP requirements covered |
| `RISK-TO-TICKET-TRACEABILITY.csv` | 21 PRD risks → preventive/detective/recovery/verification tickets |
| `EXECUTION-HANDOFF-TEMPLATE.md` | Per-ticket handoff format for implementation agents |
| `diagrams/` | Dependency graph, vertical slices, critical path, release gates |

**Rules:** `REQUIREMENTS.csv` is the canonical requirement registry; accepted ADRs are binding; implementation agents must not modify the PRD or accepted ADRs; MVP contains **zero external autonomous operations** by structure; excluded scope appears only as roadmap epics.
