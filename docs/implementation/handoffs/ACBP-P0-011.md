# Execution Handoff — ACBP-P0-011

Prepared 2026-07-18 from `EXECUTION-HANDOFF-TEMPLATE.md`. **Authorized for execution only after wave start is confirmed by the owner — this handoff document does not itself start implementation.** The agent works under `.cursor/rules/model-routing.mdc` and must not modify the PRD or accepted ADRs.

## Ticket identity
- **Ticket:** ACBP-P0-011 — Repository scaffold (`BACKLOG.csv`)
- **Phase / Epic / Type / Size:** P0 / Repository & boundaries / Foundation / M
- **Routing category:** Routine implementation (structure verified against spec at review)

## Objective
Create the monorepo skeleton exactly per `docs/implementation/REPOSITORY-SCAFFOLD-SPEC.md` so all later tickets have their homes and boundaries.

## Authorized scope
- Create the workspace structure: `apps/web`, `apps/worker`, and packages `contracts`, `domain`, `core` (with the 20 module folders fenced by index files), `database`, `gateway`, `adapters` (clerk/, infisical/, storage/), `observability`, `config`, `test-support` — **empty module skeletons with index/placeholder-free README stubs**, not implementations.
- Workspace manifest(s) and TypeScript project configuration **to the minimum needed for `install`, `typecheck`, and an empty test run to succeed** (these are the scaffold's own artifacts, authorized by this ticket).
- Root README describing the structure and pointing to the spec.
- Pin the toolchain versions chosen at scaffold time (Node LTS, package manager, TS) and record them in the completion handoff.

## Explicit non-scope
- **No product functionality of any kind.** No domain logic, no API routes, no UI beyond a placeholder entry point that compiles, no database schema or migrations, no provider SDK installation beyond types needed for empty adapter interfaces (prefer none), no CI workflow files (ACBP-P0-020), no lint rules (P0-012/013), no test harness beyond the empty runner (P0-014), no deployment or environment configuration, no secrets of any kind.
- No renaming or restructuring of the spec's layout without a planning change.

## Requirements
NFR-013 (maintainability foundations). Technical-foundation ticket — see `REQUIREMENTS.csv` for the NFR text.

## Governing ADRs
ADR-006 (modular monolith, module seams, two process types) · ADR-020 (Render: one repo, one artifact, two processes — structure must allow this) · ADR-011/014/021/022 (adapters exist as fenced packages only).

## Relevant architecture files
`docs/implementation/REPOSITORY-SCAFFOLD-SPEC.md` (the contract) · `docs/architecture/COMPONENT-CATALOG.md` (module list) · `docs/implementation/ENGINEERING-STANDARDS.md`.

## Dependencies
Decision tickets resolved (CDR-001…009); ACBP-P0-005 does **not** block this ticket. No prior implementation tickets.

## Current repository state
`E:\AI-Company-Builder-Platform` contains documentation only (product-specification/, docs/, tooling/, .cursor/) and an uninitialized-for-code git repo with nothing committed. **Application code lives in this same repository going forward; do not create a second repository.**

## Required implementation
The directory tree per spec §Recommended structure; each package's README stub stating its responsibility + allowed/forbidden dependencies (copied from spec §per-package table); `core` module folders each with a public `index` stub; compile-clean empty skeleton.

## Security invariants
None of the 20 runtime invariants are exercisable yet; structural preconditions apply: `test-support` excluded from production build config (invariant-13-adjacent structure); no secrets anywhere (NFR-018).

## Tenant invariants
None yet (no persistence). Do not create database code.

## Approval and policy implications
None (no dispatcher exists).

## Usage and audit implications
None yet.

## Failure behavior
If the spec is ambiguous or infeasible at any point, **stop and report BLOCKED with the specific conflict** — do not improvise structure.

## Acceptance criteria
1. Structure matches spec §Recommended structure exactly (deviation list must be empty or explicitly approved).
2. Fresh `install` + `typecheck` + empty test run succeed on a clean checkout.
3. Every package README states responsibility + dependency rules.
4. Zero product functionality, zero secrets, zero CI/migration/deployment files.

## Required tests
Empty test runner executes green; typecheck green. (Boundary lint arrives in P0-012.)

## Required verification
Run install/typecheck/test on a clean clone; capture command outputs; produce a full `tree`-style structure listing diffed against the spec.

## Files expected to change
New: workspace manifests, TS configs, package skeletons, README stubs under `apps/` and `packages/`; root code README. Nothing else.

## Files forbidden to change
`product-specification/**` · `docs/decisions/**` (all 22 accepted ADRs + CDRs) · `docs/architecture/**` · `docs/implementation/**` (except appending the completion handoff reference) · `.cursor/rules/**` · `.gitignore` (exists; extend only if the toolchain requires, listing every addition in the handoff).

## Completion handoff format
Standing protocol: `Status: DONE | PARTIAL | BLOCKED` · Summary (+ NFR-013 reference) · Files (exact paths) · Verification (command → result) · Risks/assumptions · Blockers · Recommended next step (ACBP-P0-012). Update `REQUIREMENT-TO-TICKET-TRACEABILITY.csv` only if coverage changed (it should not).
