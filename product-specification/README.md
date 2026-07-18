# Product Specification — AI Company Builder Platform

## Authority

- **`MASTER-PRD-v1.md` is the draft authoritative specification.** It becomes authoritative **only after explicit owner approval**; until then the owner's latest instruction governs. Current status: **Draft for owner review — architecture-blocking decisions resolved.**
- **The architecture-blocking owner decisions are resolved (2026-07-18):** D-01, D-03, D-04, OQ-19, and the D-08 residency sub-question are **Accepted** as `../docs/decisions/ADR-001…ADR-005`. The Master PRD as a whole **remains pending full owner approval**.
- **Technical architecture may begin** using the accepted ADRs and the current draft requirements (`REQUIREMENTS.csv`). **Architecture must not change product behavior** — any behavior change requires a PRD amendment or a new accepted decision record.
- **Raw Polsia research (`../docs/research/polsia/`) is evidence, not a product specification.** It must never be implemented from directly.
- **Halo Suite and Systevo materials are excluded** unless the owner explicitly imports them (see `SOURCE-CLASSIFICATION.md` and `.cursor/rules/model-routing.mdc` §0).

## Rules of use

- **Architecture must reference requirement IDs** from `REQUIREMENTS.csv` / the PRD (e.g., "satisfies APPR-004, NFR-006").
- **Implementation tickets must reference requirement IDs and their acceptance criteria.**
- **Product behavior changes require a PRD revision or an approved decision record** in `../docs/decisions/` — never a silent code-level reinterpretation.

## Files

| File | Role |
|---|---|
| `MASTER-PRD-v1.md` | The specification: vision, users, principles, evidence method, parity baseline, improvements, risk model, journeys, requirements, MVP, gates, risks, open questions, owner decisions |
| `REQUIREMENTS.csv` | **Canonical requirement registry** — one row per requirement (141: 120 functional + 21 NFR) with full attributes; tie-breaker if any presentation drifts |
| `EVIDENCE-CROSSWALK.csv` | Evidence mapping for all 50 parity requirements (source file, section, screenshot, route, observation, contradictions) |
| `CONTRADICTIONS-RESOLVED.md` | Eight evidence contradictions: seven resolved with reasons, one (extra-company pricing) deliberately unresolved |
| `OPEN-QUESTIONS.md` | 24 open questions grouped by domain; 4 block architecture |
| `OWNER-DECISIONS.md` | Ten decisions reserved for the owner, with recommendations and impacts |
| `SOURCE-CLASSIFICATION.md` | Which pre-existing materials may inform this product (created during repository isolation; referenced, not superseded) |

## Status

Phase: **product specification and evidence consolidation — decision-resolved.** ADR-001 through ADR-005 are Accepted (`../docs/decisions/`); zero open questions block the technical-architecture phase. No application code exists or may be written until the Master PRD is approved (see repository `README.md`); the next artifact is the technical architecture specification built from the accepted ADRs and PRD requirement IDs.
