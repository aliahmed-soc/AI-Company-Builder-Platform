# ACBP-P2-005 — independent review coverage

An independent security + scope reviewer examined the complete diff (`main...HEAD`) of the adaptive question
orchestration against CDR-028, diagram 04, INTERVIEW.md, the backlog row, and the CLAUDE.md rules.

## Security + scope review — CLEAN (no CRITICAL / HIGH / MEDIUM)

All seven reviewed dimensions PASS:
- **Secrets/redaction:** the only log (`interview.batch_generated`) carries `{accountId, companyId, source, count}` —
  no prompt/answer content, no PII, no provider text. Interview answers flow into `contextParts` for the gateway
  only (founder-authored, trusted-as-input — correctly not treated as secrets), never logged or persisted raw.
- **Boundaries:** `check-boundaries` 0 violations; the two new templates pass the provider-neutrality guard; the
  new contracts are zero-dep; `core/discovery/orchestration.ts` imports the gateway strictly as an injected
  function type (not from composition), no provider SDK, no direct DB beyond the existing scoped repos; no cycle.
- **Tenancy/RLS:** every persistence op runs under `runInCompanyScope`; the model call sits strictly BETWEEN
  scoped ops (never in a held tx); migration 0018 is additive (immutable append-only columns, no new grant/policy/
  SECURITY DEFINER/BYPASSRLS); cross-company isolation proven (non-member forbidden).
- **DISC correctness:** ≤3 enforced (parseFollowUps rejects >3, never truncates; re-checked defensively); honest
  static-fallback flag on any error/malformed output; detection fails OPEN to clear (safe — never blocks the
  founder); contradiction surfaced, never a silent memory override; assumption stored as ai_assumption/
  model_generation, never user_fact.
- **Type-by-source-path:** clear → user_fact/interview_answer; assumption → ai_assumption/model_generation; even
  on fail-open-to-clear the stored `user_fact` content is the FOUNDER's own answer (never model-generated) — the
  invariant holds unconditionally.
- **Metering:** exactly one metered (fail-closed) gateway call per use case; `usageCount===1` asserted on success
  AND error paths; no unregistered audit event claimed.
- **Scope:** no live provider SDK / real key / real model call (fake provider only, tests only); `formatPriorAnswers`
  is a simple formatter, NOT P2-007 context assembly; no P2-008/P2-009 logic. No scope creep.

## Finding dispositions

| # | Severity | Finding | Disposition |
|---|---|---|---|
| LOW-1 | Low (documented tradeoff) | On a model outage `evaluateAnswer` fails open to `clear` and stores the founder's answer as a `user_fact`, so a genuine contradiction is not surfaced DURING the outage. | **Retained (intended, safe).** The stored content is founder-authored (never fabricated), memory is append-only with provenance (nothing overwritten), and a later check can still catch it. A model outage must never block the founder. Documented in CDR-028 §3. |
| LOW-2 | Low (inherent constraint) | `generateAdaptiveBatch` persists questions in a loop; a mid-loop `forbidden`/`not_found` (e.g. session deleted concurrently) would leave earlier append-only questions committed while returning an error. | **Retained.** Practically unreachable (the same scope already succeeded for `getSessionQa` + earlier inserts); append-only questions make a partial batch benign; inherent to the "model call cannot be inside a transaction" constraint. |
| LOW-3 | Low (cosmetic) | The same loop defensively skips a `validation`-status insert, which on that path would return `ok` with fewer questions rather than signalling. | **Retained.** Unreachable — `FOLLOWUP_MAX_LEN=500 < PROMPT_MAX=4000` and `batchRationale` is capped at `RATIONALE_MAX=1000`, so a bounded generated question can never fail prompt/rationale validation. |
| INFO | Informational (scope) | CDR-028 §8 defers the HTTP/runtime wrapper to the live-provider owner gate (CDR-026 §0), shipping the engine + composition seam proven by the scripted real-PG integration suite — mirroring P2-003 (gateway shipped with no route). The backlog phrases the cap as "≤3 **per screen**"; no UI/route ships this ticket, so "per screen" is proven at the engine. | **Accepted (documented decision).** Every P2-005 orchestration endpoint invokes gated model generation (unlike P2-002's pure-persistence routes), and a route serving only degraded static-fallback content adds no verifiable value while the provider is deferred. The engine + scripted integration proof deliver the backlog acceptance behaviours (≤3, seeded vague/contradiction, assumption on skip, usage metered). Surfaced prominently in the PR body + PROJECT-STATE for owner visibility. |

## Residuals

None actionable. The review found no security, boundary, tenancy, or correctness defect. The three LOW items are
retained (intended/unreachable/inherent); the API-deferral is a documented, precedent-consistent scope decision
delivering the fully-proven engine, surfaced for owner visibility.
