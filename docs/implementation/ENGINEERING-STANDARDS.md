# Engineering Standards

Status: Proposed for owner review. Binding on every implementation ticket; enforced by CI gates (ACBP-P0-013/020) and code review. Requirement/ADR anchors in parentheses.

## Standards

| Area | Standard |
|---|---|
| Type safety | Strict TypeScript everywhere; no `any` in `domain`/`core` (lint error); contracts schema-first |
| Input validation | Every external input (HTTP, webhook, job payload, model output) validates against a `contracts` schema before use |
| Structured errors | One taxonomy (`contracts`); user envelope `{category, user_message, correlation_id, retryable}`; never raw provider errors to users (ADR-011/017) |
| Static analysis | The aggregate gate `pnpm run check:static` runs typecheck + lint + secret scan + boundary check + boundary regression suite; any failure is non-zero ("red = merge blocked", CI-wired in ACBP-P0-020). Commands, scan scope, and how to fix: [`STATIC-ANALYSIS.md`](./STATIC-ANALYSIS.md). |
| Testing | Single runner (Vitest); `pnpm test` runs the suite, `pnpm run check` is the full gate (static + boundaries + tests). Conventions, unit/integration boundaries, determinism, and test-support policy: [`TESTING.md`](./TESTING.md). Co-locate `*.test.ts`; UTC-pinned, isolated, self-cleaning. |
| Configuration | Validated, provider-neutral config via `@acbp/config` (zod). Public vs server-only separated; web/worker isolated; secrets wrapped in `Secret` and redacted from all output; fail-fast on invalid required config. Contracts, env vars, and how to add one: [`CONFIGURATION.md`](./CONFIGURATION.md). Bootstrap-only env (ADR-021); real secrets live in Infisical, never in code or `.env.example`. |
| Dependency boundaries | Layer/import direction is machine-enforced by `pnpm run check:boundaries` (ACBP-P0-012), with a permanent regression suite (`pnpm run test:boundaries`). Rules, matrix, and how to add a package or propose an exception: [`DEPENDENCY-BOUNDARIES.md`](./DEPENDENCY-BOUNDARIES.md). Violations fail the build. |
| Database access | Only through `database` repositories; repositories require tenant context at construction (invariant 2); raw SQL only inside `database` |
| Tenant scoping | Every tenant-owned table: `company_id NOT NULL` immutable + RLS policy (ADR-007); storage keys/cache keys tenant-prefixed via the single builders |
| Authorization | Server-side `authz.check` on every protected operation following the ADR-022 flow; UI checks are UX only |
| Idempotency | All mutation endpoints honor idempotency keys; all external-effect tool calls require them (NFR-006); consumers dedupe on event/job IDs |
| Transaction boundaries | Authoritative mutation + its audit event + its ledger/job rows commit in one transaction for high-risk classes (ADR-015; ADR-008) |
| Audit events | Every authoritative mutation emits audit; high-risk = in-transaction, write-failure blocks the action |
| Usage recording | Every model/tool/run consumption emits an append-only usage event at the moment of consumption (USAGE-001); metering failure fails closed |
| Logging & redaction | Structured JSON through the redaction pipeline only; correlation ID mandatory; prompts logged by reference (ADR-017). See `packages/observability/README.md`. |
| Secrets | Values only in Infisical (ADR-021); opaque refs in DB; bootstrap-only env vars; per-process machine identities; CI + log-pipeline secret scans must be zero-finding |
| Model calls | Only through the gateway (ADR-011); schema-validated outputs; model+version stamped on derived artifacts; both configured models covered by prompt/schema tests (ADR-019) |
| Tool calls | Only through the dispatcher (ADR-012); allowlist-checked; risk-classed; policy-gated; recorded 100% (TOOL-002) |
| Jobs/workflows | Durable rows with tenant context (invariant 3); checkpointed; resumable; heartbeats; dead-letter surfaced (ADR-008) |
| Retry handling | Bounded exponential backoff per class (NFR-007); retry state visible (TASK-010); never retry non-idempotent effects without keys |
| Feature flags | Only where a milestone requires staged exposure; flags are config, never security controls; removed within one phase of full-on |
| Accessibility | Semantic markup + keyboard paths on new UI from the start; WCAG 2.1 AA audit at Phase 7 (NFR-012) |
| Testing | Per TEST-AND-VERIFICATION-STRATEGY.md; trust-critical work lands with its negative tests in the same PR |
| Documentation | Module README per `core` module; contract changes update `docs/architecture` in the same PR |
| Dependency management | Lockfile committed; high+ advisories block CI (NFR-010); new runtime deps need reviewer justification |
| Code review | Trust-critical paths (tenancy/authz/approvals/ledger/secrets/stop) require the trust-critical routing category and explicit invariant checklist in the PR |
| Migrations | Expand-migrate-contract; one-release backward compatibility; RLS policy review on every tenant-table migration; rehearsed in staging (ADR-018/020) |
| Release discipline | Promote only on green staging; rollback = previous artifact; gates per RELEASE-GATES.md |

## Forbidden patterns (CI/lint/review-blocking)

1. Trusting client-provided tenant IDs, Clerk org IDs, role strings, or active-organization values without internal membership checks (ADR-022).
2. Frontend-only authorization.
3. Raw provider errors shown to users.
4. Direct SDK calls from `domain` or `core` product modules.
5. Unbounded retries.
6. Silent fallback for material model decisions (ADR-019).
7. Updating historical usage events (corrections = compensating entries; invariant 9/10).
8. Mutating audit records through normal APIs (invariant 11).
9. Logging secrets or complete sensitive prompts (NFR-018).
10. Marking tasks completed before authoritative evidence exists (invariant 20).
11. Bypassing the policy or approval path — no tool execution outside the dispatcher.
12. Hardcoding a provider throughout business logic (ADR-011/019 boundary).
13. Test-support imports in production code.
14. New stateful infrastructure (Redis/queues/caches) without the governing ADR trigger evidence (ADR-008/020).
