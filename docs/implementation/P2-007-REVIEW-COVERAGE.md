# ACBP-P2-007 — Review coverage ledger (context-assembly contracts slice)

Independent **application-security** review of the P2-007 contracts slice (the secret-blocklist redactor + provenance
ranker in `packages/contracts/src/context/context.ts`). Trust-critical: the redactor is the last gate before founder
memory reaches an LLM prompt (invariant 12 / NFR-018).

## Verdict
Ranker CLEAN. Redactor had **two confirmed HIGH defects** (both fixed) plus documented defense-in-depth gaps.

## Dimensions — CLEAN
- **Redaction correctness:** no partial-secret emission (patterns match the whole run or nothing); the
  `[REDACTED_SECRET]` placeholder is all-uppercase-no-digit so it can never be re-matched (idempotent); sequential
  application is bypass-free.
- **Stateful-regex reuse:** `lastIndex` is reset before every `.test()`/`.replace()`; single-threaded, no re-entrancy.
- **Ranking correctness/security:** tier is a pure function of `type`; an assumption/research item can never sort above
  a tier-1 user item regardless of attacker-controlled confidence/createdAt/confirmationState (those only tiebreak
  within a tier); `invalidated` is excluded first, unconditionally; `Date.parse` NaN is guarded (stable fallback).

## Findings dispositioned
- **H1 (fixed) — Quadratic ReDoS in the PEM pattern.** `[\s\S]*?` scanned to EOF on a missing `END`; a ~1.5 MB crafted
  input blocked the event loop ~23 s (measured), on the synchronous last gate. **Fixed:** bounded the body to
  `{0,16384}?` so each `BEGIN` fails in O(bound) → linear. Regression test: 600 KB of BEGIN markers redacts in <1 s.
- **H2 (fixed) — Truncated PEM failed OPEN, emitting the raw key body.** A `BEGIN…` block with no `END` line matched
  nothing and the base64 body (with `+`/`/`/`=`/line breaks) evaded the catch-all → raw key emitted, contradicting the
  fail-closed claim. **Fixed:** added a BEGIN-anchored fallback that redacts the base64 body even without an `END`
  sentinel (bounded single quantifier → linear). Regression test: an END-less key body is redacted.
- **M1 (partially addressed + documented) — realistic secrets bypass.** Added JWT, `key=value` credential-assignment,
  SendGrid, and npm patterns (with tests). Remaining gaps — raw AWS *secret* keys (plain 40-char base64), sub-40/
  all-lowercase generic tokens, line-wrapped tokens — are **documented in CDR-032 §2** as defense-in-depth limits (the
  primary secret control is ADR-014/021 vault isolation + NFR-018 scanning, not this backstop). Not adding an
  AWS-secret pattern deliberately: a bare-40-char-base64 matcher would over-redact hashes/ids (unacceptable false
  positives).
- **L1 (accepted + documented) — high-entropy catch-all over-redaction.** A rare ≥40-char mixed-case+digit business
  identifier is masked; the failure direction is SAFE (content masked, never leaked). Confirmed common non-secrets
  (git SHAs, SHA-256 hex, UUIDs) pass through. Documented in CDR-032 §2.

## Status
Contracts slice re-verified after the fixes: **24 unit tests** (incl. H1 ReDoS-bound, H2 fail-closed, JWT, key=value)
pass; contracts typecheck + secret scan clean. The core `assembleContext` use case + MEM-004 conflict detection +
real-PG integration + a second review + finalization remain the follow-up core slice (CDR-032 §4, next window).
