# ACBP-P1-014 — Defect ledger

Every defect the tenant-isolation adversarial suite found while being built, classified per **CDR-020 §2**.
No defect was hidden by weakening a test: where an expectation contradicted accepted behavior, the assertion
was replaced with the sharper true invariant, and the accepted behavior is now documented in the suite README.

Classes: **T** test/fixture/support defect (fix autonomously) · **R** narrow implementation bug violating an
already accepted invariant (fix within the CDR-020 limits) · **O/M/A** owner decision required.

## Class R — production fixes (1)

### R1 — HTTP error envelopes were not bounded on the company and account routes

| Field | Value |
|---|---|
| Threat id | `ORACLE-ERROR-DETAIL` |
| Severity | Medium |
| Found by | `http-routes.adversarial` — malformed `companyId` through `GET /api/companies/{companyId}` |
| Reproduction | Sign in as a real member, request `/api/companies/not-a-uuid`. The resolver's uuid cast raises SQLSTATE 22P02, `toDatabaseError` wraps it in a `PlatformError`, and the route — which mapped the result directly — let it escape the handler. |
| Affected invariant | "All cross-boundary/HTTP errors are bounded + sanitized (`PublicErrorEnvelope`)" — already honoured by the P1-012 provisioning routes and the P1-013 admin route, not by the older company/account routes. |
| Root cause | `return toCompaniesResponse(await useCase(...))` has no failure path; only mapped outcomes were bounded. |
| Fix | Added `respondToCompaniesRequest` / `respondToMembersRequest` / `respondToProfileRequest`, which run the use case and convert **any** unexpected throw into the bounded generic 500 envelope. Success and denial semantics are byte-identical to before; only the previously-unmapped throw path changed. No schema, RLS, grant, authorization, event or contract change. |
| Regression tests | `apps/web/src/server/bounded-error-envelope.test.ts` (thrown-error envelope, untouched success/denial mapping, and a **source guard** failing any route that maps directly without a wrapper or its own try/catch) + the malformed-id assertions in `http-routes.adversarial`. |
| Commit | `15a78b5` |
| Hosted CI | 30059425807 — 1143 passed / 0 failed / 0 skipped |

## Class T — test, fixture and support defects (10)

| # | Threat / area | Defect | Resolution | Commit |
|---|---|---|---|---|
| T1 | `admin-boundary` (P1-013 guard) | The comment stripper used `/\/\/.*$/` with no `m` flag. On a CRLF working copy every line ends with `\r`, which `.` cannot match and `$` cannot follow, so **no comment was ever stripped** and the no-impersonation guard silently degraded into a raw-source scan that flagged its own descriptive prose. CI checks out LF, so it could only fail on Windows. | Normalize line endings first; added an LF/CRLF **self-test** proving comments are stripped while real code survives. | `90bdbec` |
| T2 | `catalog.adversarial` | Expected grant sets were wrong for `account_profiles`, `company_memberships` and `provisioning_steps`. | Transcribed from the migrations, recording three real least-privilege facts: no profile INSERT (bootstrap creates it), no company-membership UPDATE, provisioning UPDATE is column-level only and therefore absent from `role_table_grants`. | `f0f8532` |
| T3 | harness | Company B2 seeded with `creationMode: 'exploring'`, which is not one of the three canonical modes, so every suite failed in `beforeAll`. The harness also reported a bare "company bootstrap failed". | Corrected to `platform_suggested`; the harness now names each failing company and its status. | `bb2a67b` |
| T4 | `authority-revocation` | Fixture revoked an account membership by setting `status` alone, which `memberships_revoked_has_ts` rejects. | Set `revoked_at` as production does. | `942697b` |
| T5 | `authority-revocation` | Exact-equality assertion on a `runInCompanyScope` result, which also returns the resolved `role`. | Match structurally. | `942697b` |
| T6 | `scope-establishment` | Expected the memberships self-branch to reveal nothing with an actor but no account context. | The self-branch is **accepted behavior** (P1-006/CDR-013). Assertion replaced with the sharper invariant: self ONLY, never the other four members; a forged/foreign actor sees nothing. | `63d280d` |
| T7 | `authority-revocation` | Pending invite inserted with a `member_user_id`, violating `memberships_invited_shape`. | Insert the legal shape — which is itself the invariant: an unaccepted invite names no user, so it can confer authority on no one. | `63d280d` |
| T8 | `tenancy-concurrency`, `scope-establishment` | Asserted per-company confinement on `companies`, which is **account**-keyed by design (CDR-015). | Assert account-level confinement on `companies` and company-level confinement on a dual-keyed detail table. | `00e3c63`, `917375b` |
| T9 | `rls-predicate-removal` | Treated `company_profiles` as dual-keyed (it carries `company_id` only) and `company_memberships` as strictly dual-keyed (it has an account-bound self-branch); the ON CONFLICT fixture also duplicated a row provisioning had already registered. | Per-table assertions matching the real policies, with two concrete self-branch cases pinned; the ON CONFLICT test now asserts the foreign row as a precondition. | `644c2cc`, `b7f2fcc` |
| T10 | `http-routes` | Placed at the repository root, where `@clerk/nextjs/server` resolves to a different module id than inside `apps/web`, so the provider mock never applied, the real `auth()` threw, and every request returned provider-unavailable — denials and the legitimate control alike. | Relocated into `apps/web`, where the route modules and the SDK resolve exactly as in production; all raw SQL stays in the `packages/core` harness. | `195c5ae` |

## Class O — recorded for the owner, deliberately not fixed

### O1 — malformed selectors answer with a bounded validation error rather than the coarse denial

Non-empty, non-UUID account/company selectors reach the bootstrap function's uuid cast and surface as a
bounded validation error instead of the single coarse denial used for well-formed foreign/unknown ids.

This is **not an existence oracle** — a malformed id exists nowhere by definition — and the response carries
no SQL, constraint, table, connection, tenant or existence detail (asserted at both the core and HTTP
layers). Making it coarse would change public error behavior, so it was left to an owner decision. The
approved P1-014 policy explicitly permits the current shape: malformed and unauthorized inputs need not share
one envelope, provided the protected callback never runs and nothing leaks — both of which are asserted.

## Residual observations (not defects)

- **Denial timing.** Early exits (malformed selector, unmapped user, unverified email) are faster than a full
  denial, but reveal only the *caller's own* state. Target existence becomes timing-observable only after
  authority is established, i.e. only to someone already entitled to the data. No canonical timing bound
  exists; recorded, not asserted.
- **Durable denial audits remain deferred** by CDR-014 §5 — this ticket creates none, by decision.
