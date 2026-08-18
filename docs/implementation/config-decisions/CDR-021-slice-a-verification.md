# CDR-021 — Slice A verification approach (ACBP-P1-015)

Status: **Accepted** (autonomous decision under the owner's standing Phase 1 authorization, 2026-07-24;
routine, reversible, least-authority). Governs ACBP-P1-015 *"Slice A integration: secure company creation"*.

Canon: BACKLOG row ACBP-P1-015 (Type = Testing; Vertical slice; reqs ACC-001, ACC-002, PORT-003, COMP-001,
NFR-001; ADR-007 + ADR-022; deps P1-011 and P1-014; acceptance *"Demo script passes E2E incl. live denial"*;
required tests *"E2E + negative set"*; verification *"Run demo script"*; docs *"demo script doc"*);
`MILESTONE-PLAN.md` M1 exit — *"User signs in → internal account created → creates company → switches
companies → cross-company access denied (live adversarial demo)"*.

## 1. What "E2E" means for this slice

The journey is proven **through the real production stack**: the actual Next route handlers, the composed
`ClerkIdentityRuntime`, `@acbp/core`, `@acbp/database`, and the restricted `acbp_app` connection against real
PostgreSQL — the pattern P1-014 established and CI already runs with zero skips.

**Browser-driven E2E is NOT used, and this is forced by facts rather than chosen:**

- There is **no company UI that reads company data**. *(Stated as a dated finding, because the first half of
  this bullet went stale once and would again: as of `85fcb8f`, `apps/web/src/app` contained only the root
  layout/page and Clerk's `sign-in` / `sign-up` catch-alls. As of `9771880` a console shell also exists at
  `/console`, and as of the `(site)` route-group split the root page and the auth catch-alls live under
  `app/(site)/`.)* Company creation, switching, activity and provisioning remain API-only surfaces (P1-010
  through P1-013 each shipped "API-only, no UI, no SSE" by owner decision), and `/console` renders `MOCK_`
  constants only — it reads nothing from the database. So a browser still cannot drive a slice-A journey:
  the reason is now "no screen reads company data", not "no screens exist".
- Driving Clerk's hosted sign-in requires **live provider credentials and a real Clerk instance**, which the
  operating constraints forbid. The one seam permitted — and already used — is the provider SDK at its edge,
  with the production authentication boundary (`resolveVerifiedIdentity`) still executing in full.

`TEST-AND-VERIFICATION-STRATEGY.md` lists a Browser/E2E layer "M1 (slice A) growing per slice" with
"real in staging run". That layer remains **deferred to a staging environment with a real Clerk instance and
real screens**; it is recorded here as deferred scope, not silently dropped.

## 2. What "demo script" means

An **executable, runnable artifact** — `pnpm demo:slice-a` — that performs the journey end to end against the
configured test database, printing each step and its evidence, and **failing loudly** if any step or the final
denial does not hold. It is the "Run demo script" verification procedure, usable by a human on demand.

The same journey is additionally asserted by a **CI test suite**, so the slice is protected on every merge
rather than only when someone runs the script. The script and the suite share one implementation of the
journey, so they cannot drift.

## 3. The journey and its negative set

1. **Sign in** — a verified provider identity reaches the app (ACC-001/ACC-002: email-verified enforcement
   runs in the real boundary).
2. **Mapping** — the provider identity is resolved to an internal user through the production path, proven by
   the `actor_id` the route itself stamps on the audit trail. The read-through's *create-on-miss* branch is
   NOT exercised: it calls the real `@clerk/backend` reader, which is not the seamed module and would need a
   live Clerk instance. Creation-on-miss is covered by `packages/core/src/identity/read-through*.test.ts`.
3. **Account** — the caller's personal account exists (bootstrap).
4. **Company** — created through `POST /api/companies` (COMP-001; the three creation modes).
5. **Switch** — the portfolio lists exactly the caller's companies and each company detail resolves under a
   fresh scope with no bleed (PORT-003).
6. **Live denial** — a second, unrelated tenant's ids are addressed through the same routes and are denied,
   with no foreign content in the response (NFR-001; the "negative demo").
7. **Full trail verified** — the audit and activity rows produced by the journey are asserted: correct tenant
   stamping, the four-event activity taxonomy, and no rows attributed to the other tenant.

## 4. Boundaries

No product feature, route, event, authorization action, schema change or migration. No new dependency (no
browser driver). No production credentials, no live Clerk, no staging access. The demo script is dev/CI only
and never ships in a production bundle. Deferred: browser-level E2E against real screens and a real Clerk
instance, in staging.
