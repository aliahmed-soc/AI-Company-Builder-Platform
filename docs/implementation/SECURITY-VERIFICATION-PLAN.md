# Security Verification Plan

Status: Proposed for owner review. Gate column references RELEASE-GATES.md; launch-gate numbers reference PRD §22.

| Area | Threat | Preventive control | Detective control | Test | Evidence | Milestone | Req IDs | ADRs | Launch-gate status |
|---|---|---|---|---|---|---|---|---|---|
| Authentication | Credential stuffing; session theft | Clerk-managed authn; server-side session verification; rate limits — **attributed, see note ⓐ** | Failed-login alerting; anomaly monitoring | Authn negative tests; session lifecycle tests | CI runs + audit events | M1 | ACC-001/002 | 022 | Foundation for gates 1–3 |
| Internal identity mapping | Forged/ stale identity claims; webhook spoofing | Signature-verified webhooks; replay-safe idempotent consumers; internal mapping authoritative | Drift-reconciliation job alerts | Webhook replay + forged-signature tests | Test runs + sync audit trail | M1 | ACC-001/002 | 022 | Supporting |
| Membership | Privilege via client-supplied org/role values | Internal membership + role checks only (ADR-022 flow) | authz.denied audit events | Forged-claim negative tests (trust-critical #20) | CI negative-suite results | M1 | ADMIN-003, NFR-002 | 007, 022 | Gate 3 support |
| Tenant isolation | Cross-company data access | Two-layer scoping (app + RLS); immutable ownership; tenant-prefixed storage/cache | Isolation probes in staging/prod; denial audits | Adversarial suite (trust-critical #1/#2) | 100% suite pass per gate | M1 | NFR-001, MEM-003 | 007 | **Gates 1, 2** |
| Authorization | Endpoint-level bypass | Server-side authz.check per operation; deny by default | Denied-request auditing | Negative test per privileged endpoint | Endpoint×role matrix results | M1 | NFR-002 | 006, 022 | Gate 3 support |
| Policies | Disallowed/limit-breaking actions executing | Deterministic engine, 3 evaluation points, fail closed; forbidden beats approval | policy.blocked metrics + Decision Room | Limit-breach + forbidden-action tests | Evaluation records (POL-006) | M6 | POL-001/005/006, TOOL-003 | 010 | Gate support |
| Approvals | Unapproved/modified/stale execution; AI self-approval | Payload-hash binding, expiry, revocation, single-use consumption; actor-type restriction | approval.* audit events | Trust-critical #5/#6/#7 | Negative-suite results | M6 | APPR-004/005/006/009 | 009 | **Gates 3, 4** |
| Worker execution | Context-less or over-privileged execution | Mandatory tenant context on jobs; least-privilege allowlists | Worker-run audit trail | Trust-critical #3/#4 | Test runs | M5 | WORK-005, invariant 3/4 | 008, 012 | Gate support |
| Tool execution | Off-chokepoint execution; duplicates | Dispatcher-only execution; idempotency keys | 100% tool-call records (TOOL-002) | Replay tests (trust-critical #11) | Call-record completeness check | M5–M6 | TOOL-001/002/003, NFR-006 | 012 | **Gate 5, 13** |
| Secrets | Leakage via code/logs/responses/prompts | Infisical-only values; bootstrap-only env; serializer denylists; context blocklist | CI + log-pipeline secret scanners (zero-finding) | Trust-critical #15/#16 | Scanner reports + negative API tests | M0 baseline; M7 full pass | NFR-018, INTEG-002 | 014, 021 | **Gate 12** |
| Model context | Prompt injection; tenant-data bleed; secret ingestion | Untrusted-content-as-data; context assembly scoping + blocklist | Injection metrics; quarantine events | Injection corpus (trust-critical #17); context-scope tests | Zero unauthorized tool executions | M2 rules; M5 corpus; M7 pass | NFR-021, invariant 12 | 011, 012, 019 | Gate support |
| Files & artifacts | Cross-tenant artifact access; secret-bearing exports | Tenant-prefixed keys; scoped signed URLs; export secret exclusion | Access-log review; orphan sweeps | Trust-critical #2; signed-URL scope tests | Test runs | M5, M7 | TASK-005, EXPORT-001 | 016 | Gate 12 support |
| Audit records | Tampering; gaps | Append-only store; in-tx writes for high-risk; no product mutation path | Audit-write-failure paging; completeness checks | Mutation-attempt tests; completeness suite | Integrity reports | M1 foundation; M6 complete | ACT-002, NFR-008 | 015 | **Gate 11** |
| Usage records | Under/over-counting; tampering | Append-only events; compensating corrections; atomic reservation | Reconciliation jobs + drift alerts | Trust-critical #12/#13/#14; race test | Reconciliation reports | M5 core; M6 rollups | USAGE-001, BILL-002, NFR-015 | 013 | **Gate 7** |
| Administrative access | Silent impersonation; unbounded access | JIT elevation; reason capture; no approval-as-customer; break-glass alarmed | 100% admin-action audits; alarm on break-glass | Admin-path audit tests | Admin audit trail | M1 foundation; M7 review | SECURITY-ARCHITECTURE §3 | 007, 015 | Gate support |
| Export | Data exfiltration via export; wrong-tenant export | Ownership verification; tenant-scoped archives; no secrets | Export audits | Cross-tenant export denial tests | Test runs + export audit | M7 | EXPORT-001, invariant 19 | 016 | Gate 12 support |
| Deactivation | Zombie autonomous work | Lifecycle checks in job pickup + dispatcher | State-transition audits | Deactivate/pause-then-schedule negative tests (**trust-critical #9** — moved here from the Emergency-stop row by ACBP-P7-007; #9 is a COMPANY-LIFECYCLE negative and belongs to Gate 14) | Test runs | M6–M7 | ACC-004, COMP-006 | 008 | **Gate 14** |
| Emergency stop | Stop failing open; auto-resume surprises | Scoped stop states checked pre-execution; fail-closed controller; review-to-resume | emergency_stop.* audits; stop-latency metric | Trust-critical **#10**; ≤5s halt tests; resume-review tests (#9 moved to the Deactivation row — ACBP-P7-007; grouping it here is the likely origin of the false `(P6-007)` attribution that ACBP-P7-002 disproved) | Timed test evidence | M6 | ADMIN-001/002 | 010 | **Gate 8** |

---

### ⓐ Note on the Authentication row's "rate limits" (ACBP-P7-013; CDR-082 §7)

**This cell asserted one control and meant two different ones, and ACBP-P7-007 found it while auditing whether
canon describes controls that exist.** The correction is an ATTRIBUTION rather than a deletion, because the
original claim was half true and replacing it with "absent" would have been a second wrong sentence.

| Surface | Rate limited? | By what |
|---|---|---|
| Sign-in / sign-up (**the credential-stuffing surface this row names**) | **Yes** | **Clerk.** The surface is the Clerk-hosted `<SignIn/>`/`<SignUp/>` component, so credentials go to Clerk's Frontend API and never reach a route in this repository. Clerk's own limits apply; **nothing here tests or strengthens them, and no test in this repository proves anything about credential stuffing.** |
| Authenticated `apps/web` API routes | **Yes, since ACBP-P7-013** | This platform, at the api layer, at CDR-008 §8's ruled figures. The **session** ceiling (60/min sustained, burst 120) is consumed in `verified-identity.ts`, ahead of the Clerk Backend API call it protects; the **account** ceiling (300/min) is consumed in the request modules at the first point the account id exists. `tools/check-rate-limit-coverage.mjs` fails the build if a route handler stops reaching the session ceiling. |
| Unauthenticated traffic to those routes | **No — and nothing in this repository bounds it** | There is no key to meter before a session exists, and no trusted proxy from which to take a client IP. The correct home is a deployment edge, and **this repository contains no deployment configuration at all** (CDR-082 §1.4/§6.1). Open, owner-gated: CDR-082 §8.1. |
| `/api/webhooks/clerk` | **No, deliberately** | Signature-authenticated, so there is no session key; throttling a signed sender risks dropping identity events (CDR-082 §6.3). Recorded as an explicit exemption in the coverage checker rather than as an absence. |

**NFR-010's other two named baseline items — CSRF protection and security headers / CSP — remain ABSENT** from
`apps/web`. ACBP-P7-013 closes the rate-limiting item only. CDR-080 §4 ruled each of the three a separate
implementation ticket; the other two are CDR-082 §8.2 and §8.3.
