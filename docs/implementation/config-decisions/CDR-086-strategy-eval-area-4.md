# CDR-086 — Strategy evaluation area 4, model-free half (ACBP-P3-006)

**Status:** Accepted (owner-authorized start; the sliced scope below was put to the owner and approved before any code
was written). **Requirements:** STRAT-001. **Governing ADRs:** ADR-019 (§13 ten-area pre-production evaluation gate).
**Governing CDRs:** CDR-002 (eval dataset construction + thresholds), CDR-035 (the distinctness check being measured).
**Depends on:** ACBP-P3-002 (Done). **Blocked half:** ACBP-P2-011 (`Planned`, owner-gated — live paid model account).
**Not trust-critical:** ACBP-P3-006 does not appear in `TEST-AND-VERIFICATION-STRATEGY.md`'s numbered list (checked by
grep, 2026-08-07). No schema change, no migration, no authz change, no audit event, no live model, no metering.

## 1. The finding that reshaped this ticket

The backlog row's Dependencies column reads `ACBP-P2-011;ACBP-P3-002`, and **P2-011 is `Planned`**. CDR-035 §5 already
recorded the same thing from the other side, listing out of scope "the distinctness EVAL area (P3-006, gated on
P2-011)". `PROJECT-STATE.md` said both — its Phase-7 section called P3-006 "Planned, unblocked, and never picked up",
while an earlier line in the same file grouped "P2-011/P3-006/P7-012" as "gated on the live-model eval".

Under the canonical source priority an accepted CDR outranks status prose, so **the gated reading governs**, and the
stale "unblocked" sentence is corrected by this ticket rather than relied upon. (Recording the correction here matters
more than the sentence did: that one word is what put this ticket in front of an agent as ready to start.)

Area 4 is **three-option strategy generation** — the fourth entry in ADR-019 §13's list, matching the row's objective.

## 2. Decision: ship the half that needs no model; declare the other half, do not fake it

CDR-002 §10 sets area 4's hard gate as two clauses joined by "+":

| Clause | Needs a live model? | This ticket |
|---|---|---|
| 100% seeded-near-duplicate rejection | **No** — CDR-035 §1 makes the check "deterministic, model-free … no embeddings, no metering" | **Scored** |
| ≥90% rubric-distinct triples | **Yes** — real generations from both ADR-019 pinned models, metered | **Deferred to ACBP-P2-011** |

The deferred clause is declared in configuration (`AREA_4_DEFERRED_METRICS`) with its threshold, its canon source, its
blocking ticket and the reason. It is carried in the report's `deferred` list and **never in `metrics`**, so a reader
cannot mistake "not run" for "met" — asserted by a test, not by convention.

**This ticket therefore does NOT satisfy the ADR-019 §13 gate for area 4, and does not close ACBP-P3-006.** The report
says so in its own closing line. Setting the row to Done is an owner gate and is not taken here.

## 3. What is built

- **Versioned dataset** (`STRATEGY_EVAL_DATASET_VERSION`, `STRATEGY_DISTINCTNESS_CASES`) — five cases derived from PRD
  J-07 and the MASTER-PRD §103 anti-pattern, fully synthetic (CDR-002 §8 excludes tenant data by construction).
- **Thresholds as versioned config** — every value traces to CDR-002 §10. None is invented.
- **Scorer** (`scoreStrategyDistinctness`) over the real `dedupeByDistinctness`, with the checker injectable so the
  suite can drive mutants through it.
- **Report** (`renderStrategyDistinctnessReport`) — deterministic, no clock, no environment; `pnpm eval:area-4` prints
  it and exits non-zero on failure. Needs no database, no provider, no key, no network, and therefore never skips.

## 4. Why the dataset cannot score itself green (the anti-vacuity design)

A 100% hard gate is the easiest kind of metric to satisfy accidentally. Four mechanisms exist so that it is not:

1. **Control cases.** Two cases plant zero duplicates and must survive untouched. Without them a checker that rejects
   *everything* would score 100% rejection. A control mismatch is a case failure, and any case failure fails the area.
2. **The dataset guard throws.** `assertEvalDatasetWellFormed` rejects a case that declares a planted near-duplicate it
   does not contain — which would otherwise score as a rejection of nothing — and refuses a dataset with no seeds at
   all. It throws rather than returning a verdict, so a malformed dataset cannot be scored at all.
3. **Mutation tests.** Two mutants (one that never rejects, one that rejects everything) are asserted to drive the area
   RED. This is the evidence that a green run means something.
4. **Independent normalization.** The guard re-derives CDR-035 §1's normalization instead of importing
   `distinctnessKey`. Importing it would make the seeds agree with the checker by construction, and a change to the
   contract's normalization would silently redefine what counts as a planted duplicate.

## 5. The warning threshold is null, deliberately

CDR-002 §8's four-tier structure puts a warning threshold at a "5-point/percentage tighter margin" inside the hard
gate. At a hard gate of **100%** no such value exists: a warning tier would have to be either 100% (identical to the
gate, no signal) or above it (unreachable). `AREA_4_SEEDED_REJECTION_THRESHOLD.warning` is therefore `null`, stating
that honestly rather than inventing a number CDR-002 does not authorize. The deferred rubric metric, whose hard gate is
90%, does carry the 95% warning tier the same clause implies.

## 6. Out of scope / deferred (all of it to ACBP-P2-011 unless noted)

The rubric-distinct-triples half; the area-4 **baseline run** against the pinned models (the row's acceptance criterion
in full); CDR-002 §8's comparative benchmark (primary vs fallback) and fixed human-review sample, both of which compare
model outputs; areas 1–3 and 5–10; the general eval harness those areas need — **no eval harness exists in this
repository**, and building one is P2-011's scope, so this module is deliberately self-contained and area-4 only rather
than a framework written ahead of its second caller.
