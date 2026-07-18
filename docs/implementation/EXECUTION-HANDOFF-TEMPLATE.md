# Execution Handoff Template

Use this template verbatim when assigning one implementation ticket to Claude Code, Codex, or another engineering agent. One ticket per handoff. The agent works under the standing project protocol (`.cursor/rules/model-routing.mdc`) and must not modify the PRD or accepted ADRs — if implementation reveals a spec problem, the agent reports it and proposes options (protocol §4).

---

## Ticket identity
- **Ticket:** ACBP-P_-___ — <title> (from `BACKLOG.csv`)
- **Phase / Epic / Type / Size:** …
- **Routing category:** Routine | High-reasoning | Trust-critical | Architecture-review

## Objective
<one sentence, from the ticket>

## Authorized scope
<what may be built/changed — from ticket Scope>

## Explicit non-scope
<from ticket Non-scope; plus standing exclusions: no external-action capability, no post-MVP features, no new infrastructure without ADR trigger evidence>

## Requirements
<Requirement IDs + their acceptance criteria pasted from REQUIREMENTS.csv>

## Governing ADRs
<IDs + the specific constraints that bind this ticket>

## Relevant architecture files
<exact paths + sections>

## Dependencies
<ticket IDs that must be Done; current status of each>

## Current repository state
<branch, last green commit, known quirks, environment notes>

## Required implementation
<concrete expected behavior; contracts to satisfy; data objects touched>

## Security invariants
<from TECHNICAL-ARCHITECTURE §11 — list the invariant numbers this ticket must uphold>

## Tenant invariants
<tenant-context requirements; isolation tests that must stay green>

## Approval and policy implications
<whether the change touches the dispatcher chain; which evaluation points apply>

## Usage and audit implications
<events that must be emitted; transactional requirements>

## Failure behavior
<from ticket; fail-closed expectations>

## Acceptance criteria
<verbatim from ticket>

## Required tests
<including mandatory negative tests for trust-critical work>

## Required verification
<executable commands/procedure; evidence to capture>

## Files expected to change
<paths/globs>

## Files forbidden to change
Always: `product-specification/**` (except traceability updates explicitly authorized), `docs/decisions/ADR-001..022` (accepted), `docs/architecture/**` unless the ticket authorizes a doc sync. Plus ticket-specific list.

## Completion handoff format
End with the standing protocol structure — `Status: DONE | PARTIAL | BLOCKED` · Summary (+ requirement IDs) · Files (exact paths) · Verification (command → result) · Risks and assumptions · Blockers/required actions · Recommended next step. **DONE is forbidden** with failing tests, skipped verification, placeholders, or hidden defects. Update `REQUIREMENT-TO-TICKET-TRACEABILITY.csv` coverage if it changed.
