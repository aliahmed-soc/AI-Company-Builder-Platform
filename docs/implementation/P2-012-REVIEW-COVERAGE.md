# ACBP-P2-012 — Review coverage ledger (Slice B integration: confirmed understanding)

Independent adversarial review of the P2-012 change set (`875a00c..HEAD`; branch `p2-012-slice-b`) across eight
dimensions. **Verdict: sound and ships what it claims — no Blocker/Critical/High defects.** The journey's 13 steps are
substantially falsifiable, boundaries are clean, no migration/authz/audit was added, no live model is called, and the
exit-code/skip discipline is correct. Six Low findings; the worthwhile ones fixed below.

## Dimensions — CLEAN
1–2. **Correctness / test integrity** — every step verdict is an `&&` chain of strict checks; the `?? ''`/`?? 0`/`?? []`
   fallbacks each FAIL the assertion they feed (none masks a failure into green); the evidence-only `?? 'n/a'` is in the
   detail string, not the boolean. The E2E test asserts `failures==0` AND `steps.length===13` (guards truncation) AND
   `every(ok)`; the journey is strictly linear (no early return). Every asserted contract field is real.
3. **Acceptance coverage** — demo passes/exits-nonzero; E2E + negative present; confirm gate proven at both edges;
   trail + usage + resumability demonstrated; the fallback-flag negative is honest (static_fallback surfaced on every
   fallen-back question; understanding generation returns generation_failed and persists nothing — real before/after
   document count).
4. **Boundaries** — `slice-b-journey.ts` imports only `@acbp/database` + `kysely` + the local slice-a type — NO
   `@acbp/core` (no workspace cycle); use cases + gateway factory injected (Slice A pattern); the demo's `@acbp/adapters`
   import is in `tools/` (out of the boundary scanner's scope, legitimate for a dev tool).
5. **Scope** — single-line `package.json` diff (the demo script); NO migration touched; no new authz action/audit event;
   FakeModelProvider only; no owner gate; no P3-001 strategy behavior; deferred routes/live provider stated, not shipped.
6. **Tenancy/security** — every use case runs through the restricted `acbp_app` role under FORCE RLS
   (`assertRestrictedRole` verifies); the owner connection is used ONLY for evidence SQL, never to prove a guarantee.
7. **Determinism** — fixed scripted fake outputs; the `order by id limit 1` picks a row whose identity doesn't affect
   any assertion; usage is a lower-bound (`>= 4`); audit uses set-membership + scoped `every`.
8. **Docs** — CDR-031 honestly scopes the ticket; the session-vs-version confirmation boundary is stated plainly (§4).

## Findings dispositioned (6 Low)
- **Low-1 (fixed).** Step 3's `verdict === 'clear'` alone is not fully falsifiable (`resolveAnswerQuality` fails open to
  `clear` on gateway failure). **Fixed:** step 3 now also asserts the resulting `user_fact` content **carries the
  founder's answer text** ("coffee shops"), proving the answer flowed through classification into memory (and step 2
  independently catches a broken interview gateway via `source==='adaptive'`).
- **Low-4 (fixed).** Step 12's `every()` spanned the seed's provisioning/company.created audit rows, coupling the
  tenant+actor assertion to a provisioning actor-stamping invariant. **Fixed:** the assertion is now scoped to the
  journey's OWN event set (`interview.started`/`memory.item_created`/`understanding.generated`/`.confirmed`/`.corrected`).
- **Informational (fixed).** The demo lacked the CI suite's `steps.length===13` guard. **Fixed:** the demo now marks a
  truncated run as a failure (defense-in-depth parity with the suite).
- **Low-2 (fixed, docs).** CDR §2 step 6 "from that memory" overclaimed the derivation (the fake returns a fixed
  payload). **Fixed:** §2 reworded — the step proves the generation pipeline versions/classifies/persists+audits+meters;
  the live derivation is the deferred live-provider surface.
- **Low-6 (fixed, docs).** CDR §1 said "nine" tickets. **Fixed:** enumerated (P2-001/002/003/005/006/008/009/010).
- **Low-3, Low-5 (accepted).** The structural `SliceBOps` net is loose (method-signature bivariance + `SliceBGateway =
  unknown`) — accepted: gross substitutions are still caught and the caller supplies the real functions; and step 10's
  `dependentsFlagged >= 1` compares against the `STRATEGY_DEPENDENT_COUNT = 1` constant — accepted, because it is paired
  with the REAL DISC-008 re-block check (`gateAfterCorrection.confirmed === false`) that carries the actual guarantee.

## Re-verification
The fixes touch the journey (steps 3 + 12), the demo (guard), and CDR wording only — no product code. Re-verified after
the changes: E2E integration 1/1, `pnpm demo:slice-b` 13/13, full recursive typecheck + lint clean.
