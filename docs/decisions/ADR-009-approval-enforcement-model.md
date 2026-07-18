# ADR-009 — Approval Enforcement Model

1. **Title:** Payload-hash-bound, expiring, revocable, single-use approvals enforced at the tool dispatcher
2. **Status:** Accepted (owner review 2026-07-18 — `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`)
3. **Date:** 2026-07-18
4. **Context:** APPR-001…010 define the approval improvement layer; launch gates 3/4 demand server-side negative proof. The MVP exercises full approval mechanics on safe internal actions before any external capability exists (PRD §18 rationale).
5. **Decision proposal:** Approval records bind company, actors, action type, tool@version, canonical-payload hash, destination, cost bound, scope, expiry, and policy version at creation (APPROVAL-AND-POLICY §2). Enforcement lives in the tool dispatcher: verify-and-consume atomically at execution instant (hash match, not expired, not revoked, stop-state clear). Approval decisions writable only via the approval API, which rejects model/worker actor types at schema level (invariant 5). Single-use consumption; edit-then-approve supersedes with a new record. Races resolve to revocation.
6. **Requirement IDs:** APPR-002, APPR-004, APPR-005, APPR-006, APPR-007, APPR-009, TOOL-002, TOOL-003.
7. **Alternatives:** UI-level approval gating (violates NFR-002/invariant-24 class rules); approval flags on tasks without payload binding (approved-then-edited attack); external workflow-approval products (data path + audit control loss).
8. **Benefits:** "What you approved is exactly what runs" is testable; single chokepoint; approval theater impossible.
9. **Costs:** Canonical serialization/normalization rules must be versioned and maintained.
10. **Risks:** Hash-normalization bugs invalidating legitimate approvals (fail-closed = safe failure mode; UX cost only).
11. **Security implications:** Core anti-self-authorization control; negative tests are launch gates.
12. **Operational implications:** Approval latency metrics; expiry defaults per risk class need tuning (AOQ-14 adjacent).
13. **Reversal cost:** Medium-High — this is the trust architecture.
14. **Scale trigger:** Delegation/multi-approver flows (post-MVP roles) extend, don't replace.
15. **Open questions:** Expiry defaults per risk class (configuration, pre-beta).
16. **Owner approval:**

```text
Owner decision:
[x] Accept   [ ] Accept with changes   [ ] Reject   [ ] Defer
Notes: Accepted. Approval authority derives from internal role checks only — never from Clerk claims (ADR-022 boundary).
Date: 2026-07-18
```
