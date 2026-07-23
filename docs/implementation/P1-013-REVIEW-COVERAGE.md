# ACBP-P1-013 — Independent review ledger (CDR-019)

Three independent adversarial reviewers covered the owner's eight lenses against branch head `ae53442`.
Result: **no Critical, no High.** One Medium (raised independently by two reviewers), six Lows, one
informational — every one fixed in `966e44d` and verified by the exact-head hosted CI run **30021770562**
(93 files / 1038 tests / 0 failed / 0 skipped).

## Lens coverage

| Lens | Scope | Verdict |
|---|---|---|
| 1 | Admin identity and operational setup | 1 Low (fixed) |
| 2 | Target-scope mechanics and RLS preservation | 1 Medium (fixed) |
| 3 | Audit atomicity, exact reason capture, privacy | 1 Medium (same finding, independently raised) + 1 Low (fixed) |
| 4 | No-impersonation structure | 2 Lows (fixed) |
| 5 | API authorization and existence-oracle resistance | No findings + 1 informational (applied) |
| 6 | Activity-taxonomy non-expansion | No findings |
| 7 | Migration / RLS / catalog correctness | 3 Lows (fixed) |
| 8 | P1-013 scope and break-glass/JIT deferrals | No scope violations + 1 doc-accuracy Low (fixed) |

## Finding ledger

| # | Lens | Sev | Evidence / path | Resolution | Verification | Fix |
|---|---|---|---|---|---|---|
| 1 | 2 + 3 | **Medium** | `auditWriter` (public `AdminOpOptions`, forwarded by the composed runtime) and the 5th `audit` parameter of `executeAdminCompanyRead` handed the LIVE target-scoped transaction to injectable code — an in-process caller could return tenant data with no audit row, or run arbitrary reads/writes under the target tenant's armed RLS scope | Seam REMOVED from both public surfaces; replaced by a **no-argument** post-audit failpoint that receives neither the transaction nor the scope and fires only AFTER the unconditional `writeAuditEvent` | `admin-access.ts` now calls `writeAuditEvent` directly and unconditionally; atomicity test rewritten against the failpoint (rollback ⇒ no audit row, no data) | `966e44d` |
| 2 | 1 | Low | Soft-deleted users (`users.status='deleted'`) kept `active` admin rows; only the web identity boundary denied them | The in-transaction self-check now `innerJoin`s `users` and requires `users.status='active'` | DB-layer test (gate returns nothing for a soft-deleted admin) + core test (coarse `forbidden`, zero audit rows) | `966e44d` |
| 3 | 3 | Low | Lone surrogates survive a fatal UTF-8 body decode via JSON escapes, pass validation, then fail the `jsonb` insert → mid-transaction 500 instead of 400 | `validateAdminReason` gained an explicit surrogate-pair scan (lib-neutral; `isWellFormed` needs es2024) | Contract test (lone high/low/split rejected; real pairs accepted) + route test (escaped-surrogate body → 400) | `966e44d` |
| 4 | 4 | Low | `{ actorType: 'admin', ...ctx }` spread order let a caller-supplied ctx re-label the admin as a tenant user | Order inverted: `{ ...ctx, actorType: 'admin' }` — the admin label is pinned last | Source-pinned + integration assertion `actor_type='admin'` | `966e44d` |
| 5 | 4 | Low | Boundary guard scanned only 2 files; the whole apps/web admin layer (which holds the full tenant runtime) was unguarded; string checks evadable; bare `memberships` not deny-listed | Guard now auto-discovers EVERY production admin-path file (core + web + route + primitive), strips comments, bans quoted membership/profile tables incl. bare `memberships`, raw-SQL INSERT forms, `onBehalfOf`, tenant use-cases and generic scope runners | Self-coverage assertion (route/http/request/service/primitive present); 20 boundary tests green | `966e44d` |
| 6 | 7 | Low | SECURITY DEFINER pin counted only `proname like 'acbp_%'` — an unprefixed 4th would pass | Pin now enumerates ALL `public`-namespace `prosecdef` functions **by exact name** | Real-PG catalog test asserts exactly `['acbp_accept_invite','acbp_provision_account','acbp_resolve_own_membership']` | `966e44d` |
| 7 | 7 | Low | RLS pin checked `relforcerowsecurity` only — FORCE is inert if row security is disabled | Pin asserts BOTH `relrowsecurity` and `relforcerowsecurity` | Real-PG catalog test | `966e44d` |
| 8 | 7 | Low | Grant pin did not exclude grants to other roles / PUBLIC | Added a negative assertion: no `platform_admins` grant to any grantee besides `acbp_app` and the table owner | Real-PG catalog test | `966e44d` |
| 9 | 8 | Low (doc) | `ADMINISTRATIVE-ACCESS.md` claimed "leak-canary tests at the web and core layers"; core had no log-capturing canary | Core log canary added (capturing logger over success + denial paths asserts the reason never appears) | Core real-PG test | `966e44d` |
| 10 | 5 | Info | No `Cache-Control` on admin responses (POST + `force-dynamic` already non-cacheable) | `cache-control: no-store` set on EVERY admin response | Unit assertion | `966e44d` |

## Accepted / dispositioned without code change

| Item | Disposition |
|---|---|
| **Denial timing residual** | Early exits (malformed selector, unmapped user, unverified email) reveal only the CALLER's own state. Target existence becomes timing-observable only AFTER the admin self-check passes — i.e. only to an active admin, who is authorized to learn it via the read itself. A non-admin short-circuits before any target GUC or `companies` query, so target existence is structurally invisible to them in both body and timing. Not a practical oracle; accepted and documented. |
| **No reified `AdminCapability`** | Deviation from the literal instruction, accepted as strictly stronger: no admin-authority VALUE exists to cache, serialize, pass, or forge. The capability is the freshly-verified position inside the one transaction. Enforced structurally by the private primitive (no generic scope export; `createTenantScope` unexported), narrow composition, and executable boundary tests. Recorded in DECISION-LOG. |
| **Generic 400 for every malformed cause** | Stricter than the tenant surfaces' 413/415 split — deliberate: no malformed-cause oracle on the admin surface. Recorded in DECISION-LOG. |
| **Audit metadata bound 512 → 1024 UTF-16 units** | Required so a 512-**code-point** astral reason fits. The PUBLIC reason limit is unchanged at exactly 512 code points (`ADMIN_REASON_MAX_CODE_POINTS`); only the generic per-value metadata envelope moved. Total-payload bound unchanged. Boundary tests pin 1024 ok / 1025 throws. |
| **postcss GHSA-6g55-p6wh-862q** | New HIGH advisory (transitive via `next`) published mid-slice; broke the High+ gate on run 30020713762. Remediated with a `pnpm-workspace.yaml` override `postcss: ">=8.5.12"` alongside the existing `sharp` remediation. Not ticket-feature scope; required to keep the repo-wide gate green. |
| **Break-glass documentation precision** | `BREAK-GLASS-DESIGN.md` verified by review to contain all ten mandated statements (not implemented; separate from routine access; dual control; incident/change reference; time-limited credential; alarms; post-use review; automatic expiry/revocation; no silent impersonation; no customer-approval simulation). Design only — nothing built. |
| **Runbook offboarding** | Added as a required procedure: revoke the `platform_admins` row when the user is offboarded/soft-deleted (defence in depth on top of the new DB-layer gate). |

**No unresolved Critical, High, Medium, or reasonable in-scope Low remains.**
