# OWNER-ACTION-PACK

One consolidated list of everything that engineering cannot finish without you. Nothing here is a
request for permission to do ordinary work — routine finalization is pre-authorized. Every item
below needs a credential, a live service, a commercial decision, or a sign-off that only the owner
can give.

**Read this first:** no item below has been faked, stubbed-as-if-real, or claimed. Where a ticket
had an offline half, that half is built and merged and the row says which half.

Backlog state at the time of writing: **104 tickets, 90 `Done`, 14 not `Done`.** Trust-critical
evidence: **14 of 20 rows measured.** `main` = `36ce7d6`.

---

## 1. Live deployment environment (blocks ACBP-P7-006, and the staging half of P7-009)

**Why required.** ACBP-P7-009's acceptance is *"Loop passes headless + staging-real"*. The headless
half is merged (`e1bbc1c`) and runs in the hosted suite. The staging-real half needs a deployed
environment: this repository has no host, no DNS, no TLS and no credentials, and none can be
invented. ACBP-P7-006 (staging validation and restore drill) needs the same thing plus a restore
target.

**What is already done without it.** The full application builds (`next build` green), migrations
run from zero against real PostgreSQL in hosted CI with zero skips, and the E2E journey runs
headless.

**Exact steps for you.**
1. Create the hosting account and a staging service (ADR-018 names Render as the initial provider;
   region and plan are ACBP-P0-003 and P0-004, both already decided and recorded).
2. Provision a PostgreSQL instance for staging and record its connection string in the secret store
   — **do not paste it into this repository or into chat.**
3. Give engineering the service name and the secret *reference* (not the value).

**Verification.** A staging deploy that answers `/auth-check` and a migration run that reaches the
current head. **Rollback.** Delete the staging service; nothing in the repository changes.
**Owner time.** ~30–45 minutes. **Unlocks.** P7-006, the staging half of P7-009, and the deployment
edge in item 3.

> **ALSO BLOCKED HERE, AND PREVIOUSLY UNLISTED: ACBP-P7-003, P7-004 and P7-005.**
>
> This pack did not mention the operational dashboards, alerting tiers or runbooks anywhere, so three
> `Planned` rows read as ordinary un-started work. They are not: P7-003's acceptance is *"All §2 metrics
> live"*, and `live` needs somewhere to send them.
>
> **P7-003, P7-004 and P7-005 need MORE than item 1, so a staging service alone will not unblock them.**
> Verified in the repository rather than assumed: `@acbp/observability` exports a logger, a redactor and
> suppression — **no metric primitives at all** — and no exporter of any kind exists (no Prometheus, StatsD
> or OTLP). So two separate things are missing: an owner-provisioned metrics backend, and engineering work
> to emit metrics into it. The second cannot be finished before the first, because the acceptance word is
> `live`.
>
> Nothing here is hidden work: P7-004 and P7-005 both depend on P7-003, so all three move together.

---

## 2. Paid model provider (blocks ACBP-P2-011 and ACBP-P7-012)

**Why required.** Both tickets' acceptance depends on measuring real model output quality. The
gateway is provider-neutral and fully exercised by a fake adapter; what cannot be faked is evidence
about a *real* model's answers.

**What is already done without it.** The provider-neutral gateway, timeout/fallback/retry policy,
usage and cost instrumentation, redaction, error normalization, and an offline eval harness. **No
live model has been called and no live-model quality is claimed anywhere.**

**Exact steps for you.**
1. Create the provider account and a billing method.
2. Mint an API key scoped to the models pinned by ACBP-P0-001.
3. Store it in the secret manager and give engineering the **reference name only**.

**Verification.** One metered call recorded in `usage_events` with a real provider and model.
**Rollback.** Revoke the key. **Owner time.** ~20 minutes. **Unlocks.** P2-011, P7-012, and the
live-provider half of P3-006 (whose model-free half is built on branch `p3-006-strategy-eval-area`,
draft PR #86).

---

## 3. Deployment edge for unauthenticated traffic (completes ACBP-P7-013's disclosed gap)

**Why required.** HTTP rate limiting is implemented and enforced for **authenticated** routes, and
that is what the ticket's acceptance criterion asks for. Pre-session, unauthenticated traffic is
bounded by nothing in this repository, and cannot be — it needs a CDN/WAF or platform-level rule in
front of the app (CDR-082 §§1.4, 6.1, 8.1). This is scope the repository has no configuration
surface for, not an omission in the code.

**Exact steps for you.** Once item 1 exists, enable the provider's edge rate limiting on the public
hostname. **Verification.** A burst of unauthenticated requests is throttled before reaching the
app. **Owner time.** ~15 minutes.

---

## 4. Release sign-off (blocks ACBP-P7-010 and ACBP-P7-011)

**Why required.** A release gate and closed-beta readiness are approvals, and engineering must not
self-sign them.

**What is already done without it.** Every gate the repository can evaluate is green: zero-skip
hosted suite, boundary checks, secret scan, encoding checks, dependency audit at High+, and the
trust-critical and failure-scenario evidence indexes with recorded hosted mutation run ids.

**What you must decide.** Whether the disclosed, still-open items are acceptable for a closed beta:
the two unmeasurable trust-critical rows, the four not-yet-probed rows, ACBP-P7-008's acceptance
criterion which cannot be met on its literal wording, and items 1–3 above.

---

## 5. Owner decisions already recorded and still open

These are unchanged by this session and are listed so they sit in one place.

| Decision | Where | Effect if unanswered |
|---|---|---|
| Policy evaluation point 1 (does it refuse task planning?) | CDR-067 §1; ACBP-P6-002 | P6-002's acceptance clause stays unmet; points 1–2 sit *earlier* than the mandatory point 3, so their absence cannot let an action through |
| ACBP-P7-002's account-half vocabulary, §§9.2/9.7/9.8/9.10 | CDR-079 | The company-pause half is live; the account half stays unbuilt |
| NFR-019 `Covered` cell in both traceability matrices | CDR-084 §7 | A matrix cell claims coverage its queue/banner/drain half does not have |
| Branding decision D-09 | product canon | Frontend proceeds under the authorized reversible default; final naming/brand is deferred |

---

## 6. Not blocked, and deliberately not done

Recorded here so it is not mistaken for hidden work.

- **Trust-critical #1, #14, #17, #20** — sound rows, unprobed. Their mutations need call paths not
  yet traced. Guessing an anchor produces a mutation that looks right and proves nothing, which is
  the exact defect class this programme removes; three of the five defects found this session were
  that shape.
- **Trust-critical #13** — needs a two-file mutation, because `ColumnType<T, T, never>` makes the
  one-file edit a compile error. A two-file mutation proves less: a reader cannot tell which edit
  the test noticed.
- **Trust-critical #8** — `unprovable`. No integrations entity exists to revoke.
- **An unidentified local test flake.** One `pnpm run check` reported `1 failed / 2429 passed`; two
  later local runs and three hosted runs were clean at zero skips. The failing test was never
  named, because the output was filtered before it was read. Recorded, not closed.
