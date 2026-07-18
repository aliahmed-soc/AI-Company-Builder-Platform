# ADR-010 — Policy Evaluation Model

1. **Title:** Deterministic, versioned, fail-closed policy engine with three mandatory evaluation points
2. **Status:** Accepted (owner review 2026-07-18 — `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`)
3. **Date:** 2026-07-18
4. **Context:** POL-001/005/006 and TOOL-003 require server-side policy authority independent of model judgment (PRD principles 16/17/21).
5. **Decision proposal:** An in-process policy module evaluating deterministic, versioned rules over structured inputs (tool registry risk class, payload fields, cost estimates, usage counters, stop-state, integration status, autonomy level). Output `allow | require_approval | deny(escalate?)` + append-only evaluation record (POL-006). Three evaluation points: at proposal, at approval request, and mandatorily immediately before execution (invariant 6). Most-restrictive-wins conflict rule; engine unavailability = deny. Model-produced classifications are untrusted inputs — trust-critical determinations come from registry/structured fields; where a model signal is the only signal, take the most restrictive path.
6. **Requirement IDs:** POL-001, POL-005, POL-006, TOOL-003, NFR-015, ADMIN-001.
7. **Alternatives:** Model-judged safety (fails principle 17 and NFR-021 threat model); external policy service (network dependency inside the hot path; MVP overkill); policy checks scattered across modules (untestable, drift-prone).
8. **Benefits:** Same inputs → same decision (testable); one place to audit; forbidden-list supremacy simple to prove.
9. **Costs:** Rule-expression design; policy versioning discipline.
10. **Risks:** Rule gaps (mitigate: unclassified → most restrictive; default-deny posture).
11. **Security implications:** The structural barrier between model output and consequential action.
12. **Operational implications:** policy.blocked metrics; policy version changes audited.
13. **Reversal cost:** Medium.
14. **Scale trigger:** Level 3-5 autonomy (category authorizations) extends the rule set, not the engine.
15. **Open questions:** Initial default limits (AOQ-14).
16. **Owner approval:**

```text
Owner decision:
[x] Accept   [ ] Accept with changes   [ ] Reject   [ ] Defer
Notes: Accepted as written.
Date: 2026-07-18
```
