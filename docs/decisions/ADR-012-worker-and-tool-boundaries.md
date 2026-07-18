# ADR-012 — Worker and Tool Boundaries

1. **Title:** Versioned worker definitions over one shared runtime; registry-enforced tool allowlists; dispatcher as sole execution chokepoint
2. **Status:** Accepted (owner review 2026-07-18 — `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`)
3. **Date:** 2026-07-18
4. **Context:** WORK-001…006 and TOOL-001…003 require least-privilege structure; C-04 forbids assuming reference-product agent architecture; PRD §20 excludes microservice-per-agent.
5. **Decision proposal:** Workers are versioned configuration (capability, tool allowlist, IO schemas, budget, duration, retry eligibility, approval profile, model profile, logging policy) executed by one shared runtime in the worker process. All capability = registered tools with declared side-effect class and risk class (TOOL-001); no unregistered execution path exists. Every tool call flows through one dispatcher performing: allowlist check (deny-by-default, invariant 4) → policy evaluation №3 → approval verify/consume where gated → stop-state + integration checks → idempotency-key assignment (external classes) → execution → receipt/record (TOOL-002). MVP workers (research/strategy/document) carry only informational/internal tools — the zero-external-actions MVP boundary is structural. Ephemeral sandboxes become mandatory before any generated code executes (future trigger).
6. **Requirement IDs:** WORK-001, WORK-002, WORK-003, WORK-004, WORK-005, WORK-006, TOOL-001, TOOL-002, TOOL-003, NFR-021.
7. **Alternatives:** Independent agent services (excluded by PRD §20; ops burden; unproven need); free-form function calling without registry (unauditable, unenforceable); per-worker processes (premature isolation).
8. **Benefits:** Adding a worker = configuration, not deployment; single chokepoint makes launch-gate tests concrete; capability quality tracked per worker version.
9. **Costs:** Registry/definition tooling; discipline against ad-hoc tool additions.
10. **Risks:** Chokepoint performance (mitigate: cheap checks, metrics); definition sprawl.
11. **Security implications:** Least privilege is data, not code review; injection defense anchored here (invariant 17).
12. **Operational implications:** Worker pause/disable per company (WORK-006) is a registry state check.
13. **Reversal cost:** Low-Medium.
14. **Scale trigger:** Software generation → sandboxed executor class added behind the same dispatcher.
15. **Open questions:** AOQ-09 (sandbox confirmation timing).
16. **Owner approval:**

```text
Owner decision:
[x] Accept   [ ] Accept with changes   [ ] Reject   [ ] Defer
Notes: Accepted. Sandbox escalation before any generated code executes is reaffirmed as binding.
Date: 2026-07-18
```
