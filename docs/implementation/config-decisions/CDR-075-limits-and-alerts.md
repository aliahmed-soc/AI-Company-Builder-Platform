# CDR-075 — Limits and alerts (ACBP-P6-010)

Governing: **NFR-015** (cost control, hard caps ≤1 billing increment overrun), **POL-001** (spending limits);
ADR-010 (policy evaluation), ADR-013 (usage and cost ledger), ADR-003 §16 (pre-beta control list);
`diagrams/10-usage-and-cost-flow.mmd`; **CDR-008** (interim values, Accepted).
Depends on **ACBP-P6-001** (policy engine, Done) and **ACBP-P6-009** (account rollups, Done).

---

## §0 The finding that reorders this whole ticket

**CDR-067 left a landmine pointed directly at ACBP-P6-010, and said so in writing.** Quoting its post-review
correction verbatim:

> The dispatcher supplies the engine exactly ONE observation: `risk_class`, from `tool_definitions`. A rule on any
> other dimension — `spending_limit`, `usage_limit`, `working_hours`, `emergency_stop`, `allowed_tools` — has no
> observation to read, is therefore **unevaluable**, and by CDR-066 §3-G9 contributes `deny`. So a company whose
> policy carried a spend cap would have **every tool call refused**, not approval-gated. Fail-closed and therefore
> not a hole, and **latent today because no product path writes rules until P6-010** […]

Read that last clause again: *latent today because no product path writes rules until P6-010*. **This ticket is the
product path that writes the rules.** So the naive shape of P6-010 — "add a `spending_limit` rule carrying the cap"
— **bricks every company it is applied to.** Not a subtle degradation: every tool call denied, for a company whose
only sin was having a spend cap configured.

That inverts the ticket's centre of gravity. The hard part is not *deciding* the cap. It is **supplying the
observation** so a cap rule is evaluable at all. A rule without its observation is not a weaker control — under
CDR-066 §3-G9 it is a total outage wearing a control's clothing.

**Consequence for sequencing (§3-G1):** the observation supply ships **before or with** any rule-writing path, never
after. A commit that can write a spend rule while the dispatcher still supplies only `risk_class` is a commit that
can brick a tenant, and no test of the rule-writing path would show it — the rule would look correctly stored.

## §1 What already exists — this is WIRING, not greenfield

| Piece | Where | State |
|---|---|---|
| `spending_limit` / `usage_limit` dimensions | `contracts/policy/evaluate.ts` | exist, are **trust-critical** (never model-sourced) |
| `at_or_over_limit` condition | same | exists, total, unit-tested |
| Unevaluable → `deny` | CDR-066 §3-G9 | enforced — **this is the landmine's mechanism** |
| Per-run budget, ≤1 increment | `decideStepAdmission` (P5-005) | **built and enforced** — runs check BEFORE the step |
| Account/company usage totals | `account_usage_rollups`, `sumCompanyUsage` (P6-009) | built; account-keyed RLS |
| `usage.limit_reached` event | EVENT-CATALOG:277 — `limit_type, scope, threshold (hard/soft)`, audited | **catalogued, never emitted** |
| Gateway caps pre-check | `ModelGatewayDeps.policyPrecheck` | **an optional seam; "omit → always allowed", and NO production caller supplies one** |
| Interim cap values | CDR-008 §8 | **Accepted, owner-authorized** |

Two of those rows are holes of the same shape this programme keeps finding: a mechanism that exists, is documented,
and is wired to nothing. `usage.limit_reached` is catalogued but never emitted. `policyPrecheck` defaults to
*allow* and no caller fills it — so **the gateway enforces no cap today**, and the P2-003 comment calling it "the
caps/tier pre-check" describes an intention, not a behaviour.

## §2 The values are ALREADY RULED, and the two open-question registers disagree about it

This needs stating plainly because a standing instruction to this session says *"AOQ-14 limit values remain the
owner's"*, and the repo says two different things:

| Register | Entry | Status |
|---|---|---|
| `IMPLEMENTATION-OPEN-QUESTIONS.md:17` | **IOQ-09** — initial usage caps and rate limits, consumer ticket **P6-010** | **Resolved (CDR-008)** |
| `ARCHITECTURE-OPEN-QUESTIONS.md:22` | **AOQ-14** — initial usage caps, rate limits, alert thresholds | **open**, `[PHASE — before beta]`, *needs alpha usage data* |
| `PROJECT-STATE.md:400` | — | *"AOQ-14's limit values remain unruled and unshipped."* |

**These are reconcilable, and the reconciliation is the ruling this section makes.** CDR-008 is Accepted, dated
2026-07-18, owner-authorized, explicitly **interim**, mandatory-revisit-bound at first alpha telemetry, and its
§20 names *"ACBP-P6-010 (values)"* as the ticket that consumes it. AOQ-14 stays open because the **final** values
need alpha data that does not exist yet — there is no live deployment (P7-006 is owner-gated).

So: **interim values are ruled; final values are not.** DECIDED accordingly —

- **G2.1 — No value is invented by this ticket.** Every number traces to CDR-008 §8 or does not ship.
- **G2.2 — No value lives in `@acbp/contracts` or `@acbp/core`.** CDR-066 §3-G8 is explicit that contracts carry no
  default limits, and its stated reason is the right one: *"a default limit is a statement about when a founder's
  money is spent without asking them."* Values live in **configuration**, read at the edge.
- **G2.3 — A cap is a POLICY RULE, not a code constant.** The enforceable cap for a company is whatever rule its
  policy carries. CDR-008's numbers are the recommended **starting configuration**, not a fallback baked into the
  evaluator.
- **G2.4 — An ABSENT cap is not an infinite cap, and not a denial either.** Rules restrict; they do not grant
  (CDR-066). A company with no spend rule is unrestricted *by that dimension*, exactly as today. What this ticket
  must never do is make "the owner has not configured a cap" evaluate to `deny` — that is the landmine again, from
  the other side.

**Flagged for the owner, not silently resolved:** if the intent is that AOQ-14 blocks *shipping any value at all*,
then this ticket ships the mechanism with configuration left unset and the recommended values documented only.
The mechanism is identical either way; only the config file differs. §4 carries this as the single open decision.

## §3 Design gates

- **G1 — Observation before rules.** (§0.) The `spending_limit` and `usage_limit` observations must be supplied at
  every evaluation point that can see a rule, in the same change that makes rules writable — or earlier.
- **G2 — Values: see §2** (G2.1–G2.4).
- **G3 — The check happens BEFORE the spend.** NFR-015's *≤1 billing increment* overrun bound holds only if the
  decision precedes the call. This is the shape `decideStepAdmission` already uses and the reason it holds; the
  gateway and dispatcher checks copy it rather than inventing a second discipline.
- **G4 — Both evaluation points, and they are not redundant.** The **gateway** bounds model spend (the money);
  the **dispatcher** bounds tool calls (the actions). A cap enforced only at the gateway leaves tool-driven spend
  unbounded; only at the dispatcher leaves direct model calls unbounded. The backlog says *"policy gate + gateway"*
  and means both.
- **G5 — Per company AND per account.** Company usage comes from `sumCompanyUsage`; the account figure is the
  account-keyed rollup (P6-009), which is the only place an account-spanning total may be read — the
  `credit_transactions` precedent. An account cap enforced from a company-scoped sum would under-count by exactly
  the other companies it is supposed to include.
- **G6 — Unreadable usage HALTS.** If the total cannot be read, the cap is unevaluable. Consistent with
  `decideStepAdmission` ("an unreadable bound HALTS rather than reading as no limit") and with CDR-066 §3-G9. A
  cap that fails open is not a cap.
- **G7 — Soft alert is an EVENT, never a block.** CDR-008 §8 sets the soft threshold at **75% of any hard cap**.
  At the soft threshold the work proceeds and `usage.limit_reached` is emitted with `threshold: 'soft'`. Blocking
  at 75% would be a hard cap wearing a soft cap's name.
- **G8 — The alert must not become a firehose.** A soft alert emitted on every call once usage passes 75% is
  indistinguishable from noise and will be filtered out, which makes it worth nothing at the moment it matters.
  Emission is once per (scope, period, threshold) crossing — and the mechanism that makes "once" true has to be
  named, not assumed. **This is where P6-011's suppression work is reused rather than re-invented.**
- **G9 — `usage.limit_reached` carries the catalogued fields.** EVENT-CATALOG:277 fixes them: `limit_type`,
  `scope`, `threshold`. Audited, retention ≥ billing. The event is not free-form.
- **G10 — A cap block is not a usage event.** CDR-026 §4 already rules this for the gateway: usage records model
  CALLS, and a blocked call is not a call. A cap block must not inflate the very total it is bounding.
- **G11 — Values are config, and config is not a secret.** Cap values are operational settings, not credentials.
  They may appear in logs and audit metadata; the amounts spent may not be attributed to a person.
- **G12 — A cap is decided against the LEDGER, never against `account_usage_rollups`.** Found while wiring: the
  rollup is a **projection** (CDR-073 §0 — "the ledger is the truth and the rollup is a bug" when they disagree)
  and is rebuilt on a schedule. A cap decided from a projection under-counts by exactly however stale that
  projection is, and the failure is silent, self-consistent, and in the customer's favour — which is the shape
  that survives longest. The rollup remains the right source for *reporting*; it is the wrong source for
  *enforcement*, and the two must not be conflated because they carry the same numbers.
- **G13 — Daily buckets are UTC, for a sharper reason than monthly ones.** A daily cap read in the session's
  local zone resets at local midnight, so a founder in UTC+14 gets a fresh daily allowance fourteen hours before
  one in UTC, and the same account enforces two different ceilings depending on which server answered.

### §3.1 A gap P6-009 left that only a daily cap reveals

**Every aggregation shipped by ACBP-P6-009 buckets by MONTH.** `sumCompanyUsage`, `sumCompanyCorrections`, the
`account_usage_rollups` period key — all `date_trunc('month', …)`. CDR-008 §8 sets a **daily** ceiling next to the
monthly one, and a day cannot be derived from a month in the direction needed.

So this ticket adds `sumCompanyUsageForDay`, deliberately mirroring `sumCompanyUsage` rather than generalising it
into a parameterised bucket. A `bucket: 'day' | 'month'` argument would put the UTC discipline and the exact
`date_trunc` expression behind a branch, and CDR-073 §1-G8 requires that expression to agree *exactly* with
`usagePeriodStart` in contracts — an agreement that is currently pinned by a test calling the method under a
UTC+14 session zone. Two explicit readers each pinned by their own test is worth more here than one clever one.

**The account-scope loop is unchanged and reused**: an account total is the sum over the account's companies,
each read under `elevateToCompanyScope` (P6-009 §1-G3), never under `runInCompanyScope` — a membership-filtered
total is a per-caller view, and a cap must not depend on who asked.

## §4 RULED BY THE OWNER — ship CDR-008's interim values as active configuration

**Decision (owner, this session): ship them.** The caps below are active configuration from this ticket forward,
carrying CDR-008's own labelling: **interim**, and **mandatory-revisit-bound at first alpha telemetry review**
(CDR-008 §21). AOQ-14 stays open for the *final* values; it is not closed by this ruling, and nothing here should
be read as answering it.

Active interim values, every one traced to **CDR-008 §8** and none invented here:

| Cap | Value | Scope |
|---|---|---|
| Platform model spend, daily | **$5 / day** | per company |
| Platform model spend, monthly | **$50 / month** | per company |
| Account ceiling | **3× the company cap** | per account, across its companies |
| Soft alert threshold | **75%** of any hard cap | per scope, per period |

Consequences that follow, and are gates in their own right:

- **G4.1 — The values live in configuration, never in `@acbp/contracts` or `@acbp/core`** (§2-G2.2 stands
  unchanged). Shipping them active changes *what the config contains*, not *where values may live*.
- **G4.2 — Every shipped value is labelled interim at the point of definition**, with CDR-008 §21's revisit
  trigger named there rather than only here. A number whose provisional status lives only in a document three
  hops away will be read as settled by the next person who finds it.
- **G4.3 — A cap that is active must be visible.** Because these now block real work, the block must say which
  cap fired, at which scope, and against which period — a refusal a founder cannot attribute is indistinguishable
  from a bug in their own product.

*(The original framing of this section is kept below, because the reasoning that produced the recommendation is
what a later reader will want when the revisit trigger fires.)*

### §4.1 `usage.limit_reached` — designed, deliberately NOT yet registered

The event's shape is settled; its registration waits for its producer, and the reason is a guard doing its job.

**Attempting to register it early was refused**, by `audit-operations.test.ts`'s *"every REGISTERED audit event is
produced by exactly one approved operation (no orphan events)"*. The same guard caught ACBP-P6-009 registering
names a slice ahead of their emitters, and `audit.ts`'s own comment records that `DEFERRED_REGISTERED_EVENTS` was
deliberately **not** used to route around it then. It is not being used to route around it now either: the
registration ships in the same commit as the gateway cap check that emits it.

Decided, so the next slice implements rather than re-derives:

- **Name and fields are EVENT-CATALOG:277's, not invented**: `limit_type`, `scope`, `threshold` (`hard`/`soft`),
  audited, retention ≥ billing. Plus the amounts needed to make a refusal attributable (§4-G4.3): the cap value,
  the spend, and the threshold crossed.
- **Subject is the COMPANY, even when an ACCOUNT-scoped cap fired**, because the company is what was stopped —
  a reader asking "why did this company's work halt" starts there. `limit_scope` distinguishes them, so an
  account ceiling is never misread as a company one.
- **ONE event name for both thresholds.** A second name would fragment the count exactly as per-surface
  suppression names would have (CDR-074 §5.1's reasoning, same shape).
- **A soft event does NOT mean work stopped.** `threshold: 'soft'` is emitted while the call proceeds (§3-G7).
  Only `'hard'` accompanies a refusal. A reader treating every one as an outage would mis-report three quarters
  of them, and the field is the only thing preventing that.
- **Audit outcome is `success` for both**, deliberately. The outcome describes whether the PLATFORM acted
  correctly, not whether the founder liked the answer — a cap that fires is the control working. `failure` is
  reserved for the `halt` case, where the spend could not be read and the platform genuinely failed.
- **§3-G8 still applies**: emission is once per (scope, period, threshold) crossing, and the mechanism making
  "once" true must be named rather than assumed.

### §4.3 The ceiling is REACHABLE and UNREACHED — found by the independent review

**No production caller passes `caps`, because there is no production gateway composition at all.**
`createModelGateway` is constructed only by demo scripts, journey helpers and integration tests. So after this
ticket the gateway still enforces no ceiling on any real path.

This is the same defect §1 diagnoses in `policyPrecheck` — "an optional seam whose default is *always allowed*,
with no production caller" — reproduced one layer up by the fix for it. The review caught it because §1's own
wording ("**this is the function that fills it**") reads as though the gap were closed. It is not closed; it is
**closeable**, which is a different claim and the only one this ticket can make.

Deliberately NOT worked around: wiring `caps` into the demo scripts would make the ceiling *look* enforced in the
one place it does not matter, and would leave the real gap exactly where it is. The honest state is recorded here
instead, matching CDR-074 §5.4's treatment of the usage idempotency key.

**It becomes live the moment a production composition passes `caps`** — one argument, already typed, already
tested, and guarded against being silently overridden (`caps` + `policyPrecheck` together throws).

### §4.2 A property of CDR-008's numbers, found by the real-PG suite

**The account ceiling can only bind when an account holds FOUR OR MORE companies.** It is 3× the company cap, so
three companies each sitting just under their own ceiling still total just under the account ceiling; the
per-company cap always fires first. With one to three companies the account ceiling is unreachable.

That is not a defect — the per-company caps are doing the work, and the account ceiling exists to stop a founder
multiplying their allowance by creating companies, which is exactly the ≥4 case. It is recorded because it is
invisible from the numbers alone and will look like a broken account cap to whoever first tests it with two
companies. **It also means the account ceiling is untested by any fixture with fewer than four companies** — the
first version of the integration suite made precisely that mistake, asserted an account block, and got a company
block instead. The system was right and the test was wrong.

Worth re-examining at CDR-008 §21's revisit: if the intent was for the account ceiling to bind earlier, the
multiplier is the lever, not the per-company value.

### The decision as it stood before the ruling

**Does P6-010 ship CDR-008's interim values as active configuration, or ship the mechanism with caps unset?**

- **Ship them (CDR-008's own reading).** §20 names this ticket as the consumer; §8's values are authorized; §21
  binds a mandatory revisit at first alpha telemetry. Runaway-cost protection is active from the first model call,
  which is ADR-003 §16's stated intent.
- **Ship unset (the AOQ-14 register's reading).** No cap fires until the owner sets one. Nothing can wrongly block
  a founder's work, and no number ships that alpha data has not justified.

**Recommendation: ship them, as clearly-labelled interim configuration**, because CDR-008 already made this
decision at owner level and the alternative leaves the platform with no cost ceiling at all while its stated
purpose is to have one. **Not actioned until the owner confirms**, because the standing instruction to this session
names AOQ-14 as owner-held, and a session cannot resolve a contradiction between the instruction it was given and a
document it found — it can only surface it, which is what this section is.

**Everything else in this ticket proceeds regardless**: the mechanism, the observations, both evaluation points,
the event, the audit, and the tests are identical under either answer. Only the config file's contents differ.
