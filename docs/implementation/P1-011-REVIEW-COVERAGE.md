# P1-011 — Independent review coverage matrix and findings register

Reviews performed on the committed `p1-011-company-switching-portfolio` diff (base `main` @ `e99b0b3`):
**R1** independent security & tenant-isolation review (all 8 CDR-017 invariant groups upheld; no findings);
**R2** independent scope & correctness review (no Critical/High/Medium; 3 Low/informational notes, dispositions
below); **R3** targeted follow-up review (revoked-selection behavior, paused-company behavior, query-plan
evidence suite — verdict: all three areas SOUND; no Critical/High on product code; 2 Medium + 4 Low confined to
the evidence suite's own robustness, every one fixed or dispositioned in the `T-*` register rows below; also
re-confirmed: exactly three SECURITY DEFINER functions, zero migrations touched on the branch, synthetic-only
fixtures). Test evidence: `DB` = `packages/database/src/integration/portfolio.integration.test.ts`,
`PLAN` = `.../portfolio-plan.integration.test.ts`, `CORE` = `packages/core/src/company/portfolio.integration.test.ts`,
`SWITCH` = `.../portfolio-switch.integration.test.ts`, `P1-010` = `.../company.integration.test.ts` (+ database
`company.integration.test.ts`), `UNIT` = contract/service/web unit tests. All integration evidence is hosted-CI
(zero-skip preflight); local PostgreSQL is unreachable (documented Windows→WSL issue) and is never claimed.

## Coverage matrix

| # | Area | Review | Test evidence |
|---|---|---|---|
| 1 | Membership-filtered visibility (active company_membership per row) | R1 §1, R2 | DB "lists ONLY active-membership companies"; CORE happy path |
| 2 | Account OWNER without company membership gets no row | R1 §1 | DB (account-owned company w/o membership excluded) |
| 3 | Account VIEWER behavior (call allowed; zero rows without company membership) | R1 §5, R2 | CORE "account membership alone yields NO rows"; UNIT authz matrix (`portfolio:read` owner\|viewer) |
| 4 | Enumeration under AccountScope (company GUC intentionally unset) | R1 §2 | DB (no-actor/no-company GUC variants); repository runs on AccountScope executor only |
| 5 | `company_memberships` self-branch is the real gate (not the SQL WHERE) | R1 §1 | DB "self-branch is the real gate" (forged GUC / forged arg / absent actor → nothing) |
| 6 | `companies` account RLS = isolation, NOT product authorization | R1 §1, R2 | DB #2; P1-010 cross-account forgery tests; CDR-017 §2 |
| 7 | Sequential fresh CompanyScope enrichment (no reuse, never parallel) | R1 §2, R2 | CORE enrichment isolation (each candidate gets ITS OWN name) |
| 8 | Stale membership between enumeration and enrichment → row DROPPED | R1 §3, R2 | CORE stale-drop (revoke between phases → dropped, never stale/substituted) |
| 9 | Profile-name cross-company isolation (dual-keyed profile RLS intact) | R1 §2/§6 | CORE enrichment isolation; P1-010 profile RLS tests unchanged |
| 10 | A→B→A switch isolation (sequential re-entry, no bleed) | R1 §2 | SWITCH A→B→A |
| 11 | Concurrent A/B requests isolated (pooled connections) | R1 §2 | SWITCH concurrent entries + concurrent portfolios |
| 12 | Transaction-local GUC cleanup after COMMIT | R1 §2 | SWITCH GUC test (bare tx after committed company work) |
| 13 | Transaction-local GUC cleanup after ROLLBACK | R1 §2 | SWITCH GUC test (SET LOCAL + forced rollback) |
| 14 | URL-only, non-authoritative selection (nothing persisted anywhere) | R1 §6/§8, R2 | SWITCH forged companyId denials; R1 persistence sweep (no column/cookie/Clerk/session/global) |
| 15 | Revoked/stale SELECTION: coarse deny; next read excludes; NO fallback/default company | R3-A | SWITCH "a revoked selection forces reload" (succeed → revoke → SAME request 403 → portfolio excludes); P1-010 resolver-deny tests; DB/CORE revoked-exclusion; R3 no-defaulting sweep |
| 16 | PAUSED company visible with truthful status | R3-B | CORE "a PAUSED company stays visible…" |
| 17 | Cursor account+actor binding; malformed/foreign rejection | R1 §4 | UNIT contract tests (13); CORE strict rejection incl. foreign-actor cursor; UNIT service guards |
| 18 | Equal-created_at keyset (id DESC tie-break across page boundary) | R2 | DB tie-break page-boundary test; PLAN tie trio + keyset walk |
| 19 | Query-plan/index behavior (real-PG EXPLAIN evidence; no unbounded scan) | R3-C | PLAN suite (natural first-page + keyset plans, semantic assertions); `P1-011-PORTFOLIO-QUERY-PLAN.md` |
| 20 | API parsing/privacy/error behavior (params allowlist, redacted DTO, coarse 403) | R1 §7/§8, R2 | UNIT web request/http tests (unknown param 400; invalid limit/cursor 400; opaque forbidden) |
| 21 | No switch endpoint / persistence / UI / durable switch audit event | R1 §6, R2 | R2 absence sweep; closed audit taxonomy unchanged |
| 22 | Exactly three SECURITY DEFINER functions (allowlist unchanged) | R1 §6, R2, R3 | P1-010 catalog test (`prosecdef` count = 3) still green on this branch |
| 23 | P1-012+ deferrals respected (no provisioning/metrics/SSE/retention/UI) | R2 | CDR-017 "Out of scope"; PROJECT-STATE authority limits |

## Findings register (all Low/Informational; none Critical/High/Medium)

| ID | Source | Finding | Disposition |
|---|---|---|---|
| S-1 | R1 | Codec accepts non-canonical trailing bits (no re-encode check) | **Accepted.** Payload is account+actor-bound; a non-canonical token can only decode to the same validated fields; the threat model (CDR-017 §8: tampering only re-windows the caller's own list) explicitly covers it. |
| S-2 | R1 | Up to 1 + limit (≤101) transactions per portfolio page | **Accepted.** The isolation-over-throughput tradeoff CDR-017 §3 sanctions (fresh sequential CompanyScope per candidate); bounded by the max page size. |
| S-3 | R1 | Enrichment DB error propagates as an unhandled 500 rather than a mapped status | **Accepted.** Fail-closed (no partial/stale emission); identical to the existing activity/company endpoints' behavior — mapping to 503 would diverge from the established surface. |
| L-1 | R2 | Epoch extraction routes through `extract(epoch …) * 1000000` | **Accepted with evidence.** Hosted CI runs `postgres:16` (`.github/workflows/ci.yml`), where `extract(epoch from timestamptz)` returns **`numeric`** — the multiply and `::bigint` are exact integer-domain math, not double precision (the PG14+ behavior the P1-009 activity feed already relies on). `microsecondEpochToIso` is integer-only; the cursor binds back via `::timestamptz`, which PostgreSQL parses at full microsecond precision. Round-trip exactness is proven empirically at a page boundary with an equal-`.123456Z` tie (DB tie-break test) and again on the realistic PLAN population. `companies.created_at` is `timestamptz` (microsecond precision) — no schema precision is lost. |
| L-2 | R2 | No single test drives "hasMore + a dropped candidate" through `getCompanyPortfolio` | **Accepted with proof-by-construction.** `nextCursor` is a pure derivation from the ENUMERATED page only (`portfolio-service.ts` — `pageCandidates[pageCandidates.length-1]` → `buildCursor`); `items` (where drops occur) never feeds it. Hence a dropped row cannot duplicate (keyset is strictly older than the cursor position), cannot loop (the (createdAt, id) position strictly decreases every page), and cannot permanently omit later authorized companies (the cursor always covers the full enumerated page; a re-granted membership reappears on the next FRESH first-page read — standard keyset semantics). The two halves are each integration-proven (CORE stale-drop; DB/PLAN keyset walks). A deterministic end-to-end composition test is not constructible without injecting a race between the two phases; the pure seam above is the direct proof. |
| L-3 | R2 | GET query-param allowlist runs before authentication (unknown param → 400 not 401) | **Accepted.** The 400 body is the generic status envelope produced before ANY identity/DB work — it reveals nothing about accounts, companies, or auth state. Identical ordering to the existing `GET /api/companies/[companyId]/activity` route; changing only the portfolio route would create an inconsistent surface for zero privacy gain. |
| T-M1 | R3 | Plan suite's companies-join assertion was not bitmap-tolerant (a legitimate Bitmap Heap + child Bitmap Index plan on `companies` would fail it), contradicting the suite's stated tolerance | **Fixed.** The assertion now also accepts `Bitmap Heap Scan` with `Relation Name = companies` (the zero-Seq-Scan ban keeps it meaningful). |
| T-M2 | R3 | The EXPLAIN "mirror" query could silently drift from the production builder (the agreement test bound behavior, not SQL) | **Fixed structurally.** The mirror was DELETED: `PortfolioRepository.buildListQuery` (the very builder `listActiveMembershipCompanies` executes) is now exposed and the suite EXPLAINs/compiles it directly — drift is impossible. Pure extract-method refactor; the executing method is unchanged (`buildListQuery(...).execute()`). |
| T-L1 | R3 | Zero-Seq-Scan on both relations/both variants is the strictest assertion (judged stable on the seeded, ANALYZEd postgres:16 population; custom one-shot plans; actor in MCVs) | **Accepted (kept).** It is the semantically load-bearing "no unbounded account-wide scan" check; the T-M1 fix removes the realistic false-positive path. Relax per-relation only if a real flake is ever observed. |
| T-L2 | R3 | `Sort Key` substring check for `'id'` was under-assertive (any *id* substring matched) and asserted no direction | **Fixed.** Now `toMatch(/created_at DESC/)` + `toMatch(/\.id DESC/)` — the exact CDR-017 §8 ordering contract, direction included. |
| T-L3 | R3 | Pinning `company_memberships_member_idx` by name fails if a composite membership index is ever added | **Accepted as a deliberate tripwire**, now documented in-test: such a failure means the query-plan evidence must be re-derived, not that the test flaked. |
| T-L4 | R3 | No single end-to-end test drove "active member succeeds → membership revoked → SAME request now 403" verbatim | **Fixed.** Added to the switch suite: succeed → revoke → identical `getCompany` denies coarsely → next portfolio read excludes the company (closes CDR-017 Required-behavior bullet 1 literally). |
| T-L5 | R3 | Paused-company test seeds `status='paused'` by superuser UPDATE rather than the real `pauseCompany` transition | **Accepted.** It is a read-path visibility test; the pause transition itself (owner-gated, audited, atomic) is fully proven by the P1-010 lifecycle suite — re-driving it here would duplicate that coverage. |
