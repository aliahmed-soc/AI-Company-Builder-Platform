# ACBP-P2-003 — independent review coverage

An independent security + scope reviewer examined the complete diff (`main...HEAD`) of the model gateway v1
(contracts → migration 0017 → core gateway + fake provider → composition) against ADR-011, CDR-026, and the
CLAUDE.md rules, alongside the pre-existing contracts it depends on (`model-provider.ts`, `errors.ts`,
`withTenantTransaction`) and the real-PG test evidence.

## Security + scope review — CLEAN (no CRITICAL/HIGH)

All eight reviewed invariants **PASS**, with explicit verdicts:

- **Secrets/redaction:** provider errors are collapsed to the seven-value taxonomy (`classifyProviderError`)
  before anything is logged; raw provider text is caught in `singleCall` and never logged; logs carry only
  `redactedMeta` (provider/model/taskClass/outcome/errorCategory/fallbackUsed/latencyMs/correlationId) — no
  prompt/response content; `usage_events` has no content column. Redaction tests plant a context canary + an
  internal marker and prove neither reaches logs.
- **Architectural boundaries:** `@acbp/core/model` imports only `@acbp/contracts` + `@acbp/observability` (no
  provider SDK, no `@acbp/database`); the fake provider imports only `@acbp/contracts`; the composition is the
  sole importer of `@acbp/database`; no cycle; no provider SDK/dependency added anywhere.
- **Tenancy/RLS:** `usage_events` is dual-keyed FORCE RLS, SELECT+INSERT only — no UPDATE/DELETE grant, no UPDATE
  policy (append-only, invariant 9); the composition writes under the request's company scope; the real-PG
  catalog test asserts exactly `[INSERT, SELECT]` policies+grants and the SECURITY DEFINER allowlist stays at
  three.
- **Fail-closed metering, no silent fallback, money discipline, bounded concurrency, scope** — all confirmed
  correct (retry ≤2 + re-ask ≤1 use separate bounded counters → no unbounded loop; `Promise.race` reactions
  attached to both inputs → no unhandled rejection; generation task class never touches the fallback; no live
  provider SDK/credential/network call/HTTP route added; migration additive; synthetic fixtures only).

## Finding dispositions

| # | Severity | Finding | Disposition |
|---|---|---|---|
| MED-1 | Medium (metering accuracy) | The gateway metered only the FINAL attempt's tokens; a bounded re-ask (or a response-returning failure) consumed additional tokens that went uncounted — a latent under-report once live providers land. | **FIXED (code).** `singleCall` now surfaces per-call `providerUsage` whenever the provider returned a response; `runProvider` ACCUMULATES tokens across every attempt (re-asks) and `callModel` sums primary + fallback consumption into the ONE usage event. Retryable infra failures throw without usage → contribute zero. New/updated unit assertions: a re-asked call (success and invalid_output) meters the SUM of both attempts, not the last try. Recorded in CDR-026 §5. |
| LOW-1 | Low (money discipline) | `estimatedCostMicros` was passed straight from the injected pricing function to the `integer` column; a float would be silently rounded by Postgres rather than rejected. | **FIXED (code).** The gateway coerces the pricing result at the seam: `Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0`. A mis-implemented pricing config can no longer silently violate "never a float." Recorded in CDR-026 §5. |
| LOW-2 | Low (doc precision) | CDR-026 said the usage event is written "in the SAME transaction as the gateway work," but the composition opens its own short transaction AFTER the external model call. | **FIXED (doc) — completed in review round 2.** Round 1 corrected CDR-026 §5 but left the same stale wording in three other sites (CDR-026 §4, the migration 0017 header, the `usage-event-repository.ts` header). All four now consistently state: the usage insert is the ONLY DB write in a gateway call, written in its own short tenant transaction AFTER the external call; fail-closed holds trivially (atomic single write; failure → throw + output withheld). |
| LOW-3 | Low / informational | On a metering-write failure, `normalizeError` retains the raw DB error text INTERNALLY (`internalMessage`/`cause`) of a `category:'internal'` PlatformError; the public envelope is generic. | **Retained (safe by construction).** The gateway never logs it; `toPublic()/toJSON()` are structurally allowlisted. Noted the standing dependency that upstream handlers must not log `.toInternal()`/`.message` for this error — the established platform logging discipline (P0-016/ADR-017). |

## Second review round — five parallel read-only reviewers (canon/scope · contract · tests · security · docs)

A second independent pass ran five read-only reviewers in parallel over the committed branch, one per dimension.
**Security: CLEAN** (no Critical/High/Medium/Low across all seven dimensions). **Scope: CLEAN** (matches backlog +
CDR-026; live path correctly deferred; IOQ-13 faithful; no creep/exclusion breach). **Tests: strong** (all ten
required behaviors covered, zero-skip on CI). Remaining findings and dispositions:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| R2-1 | Medium (correctness) | The enforced timeout used the caller-supplied `request.timeoutClass`, never bound to `taskClass`; a `{taskClass:'generation', timeoutClass:'interactive'}` request capped a 120s generation at 30s. `timeoutClassForTask`/`timeoutMsForTask` were dead code. | **FIXED (code).** `runProvider` derives the deadline from `taskClass` via `timeoutClassForTask` — the task class is the single authority; the request `timeoutClass` field (ADR-011 §5, retained) can no longer under-cut it. New unit test proves the generation class selects its own deadline (mismatched request field ignored). |
| R2-2 | Medium (fail-closed) | If a request set `outputSchemaRef` but the gateway was wired with no `validateOutput`, the raw output was returned as `ok` — unchecked output silently mislabeled as validated. Reachable (the composition wires the validator conditionally). | **FIXED (code).** `callModel` now refuses such a request with a normalized `internal` error BEFORE any provider call (fail-closed; nothing metered, like the caps block), logged as `model.validator_unwired`. New unit test. Confirmed not a leak by the security reviewer. |
| R2-3 | Low (invariant) | Retry/re-ask bounds were defaults, not ceilings; a `GatewayConfig` could set `maxRetries` above the owner-ratified ≤2. | **FIXED (code).** `resolveConfig` clamps both to `[0, max]`; an override can only lower a bound, never widen it past canon. |
| R2-4 | Low (test) | The generation-class (120s) deadline was never runtime-asserted through `callModel`. | **FIXED (test).** Added — doubles as the R2-1 regression guard. |
| R2-5 | Low (test) | Row-level secret non-leakage was structural (no content column) but never directly asserted against a persisted row. | **FIXED (test).** Real-PG composition test plants a context canary and asserts it is absent from the serialized `usage_events` row. |
| R2-6 | Low (doc) | CDR-026 §6 named the token columns `token_usage_input`/`token_usage_output` "(or bounded jsonb)"; shipped columns are `input_tokens`/`output_tokens` integer. | **FIXED (doc).** CDR §6 updated to the shipped names/type. |
| R2-7 | Low (doc) | The "gateway README" deliverable was unmet; no operational/runbook note for the fail-closed metering path. | **FIXED (doc).** Added a Model-gateway section to the `@acbp/core` README (seam, metering, fail-closed operational notes for `model.metering_failed`/`model.validator_unwired`); CDR §7 slice 5 updated to match. |
| R2-8 | Info (doc) | CDR-001 §8 "pinned … at ACBP-P2-003" could be read as claiming the snapshot pin happened here. | **FIXED (doc).** Added a back-reference: the pin is deferred to the live-provider owner gate (CDR-026 §0); P2-003 makes no production call. |
| R2-9 | Info | DB repository types columns as `string`, not the contract enums. | **No action — correct by design.** `@acbp/database` stays independent of contract enums (boundary rule); DB CHECK constraints backstop the values. |

Deviations accepted without change (documented, not defects): "model.call_completed" realized as the append-only
`usage_events` row rather than a separate `audit_events` entry (CDR-026 §5, mirrors CDR-023/024); NFR-015 hard-cap
enforcement is the structural `policyPrecheck → budget_exceeded` hook only, values deferred to P6-010 (CDR-008).

## Residuals

None actionable outstanding. Round 1 fixes (usage accumulation + money-discipline guard) plus the round-2 fixes
above are applied with tests; the retained LOW-3 is a documented, platform-wide redaction guarantee. Both review
rounds confirm the change is scope-clean — the provider-neutral abstraction + a deterministic fake provider only —
with the live-provider path correctly deferred as an owner gate (CDR-026 §0).
