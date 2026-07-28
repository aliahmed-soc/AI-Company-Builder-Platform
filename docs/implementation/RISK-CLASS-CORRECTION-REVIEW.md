# Canon correction — independent review record

The rename `external_irreversible` → `sensitive_irreversible` (owner decision 2026-07-28; `CDR-051 §0.2`).

Two full independent passes. **Pass 1 returned FAIL; pass 2 returned CLEAN.**

---

## Pass 1 — what a rename could break

### MEDIUM-1 — the receipt rule was only provable through a database

`EXTERNAL_EFFECT_CLASSES` was a private constant inside `dispatcher.ts`. It drives TOOL-002's rule that an external
effect cannot claim `succeeded` without a stored receipt — and the only thing asserting its membership was a
real-PostgreSQL suite, which **skips on a laptop**. A safety rule that most runs never check is one edit away from
being relaxed silently, and this rename was exactly such an edit.

**Fix.** Moved to `@acbp/contracts` as `EXTERNAL_EFFECT_RISK_CLASSES` + `hasExternalEffect`, with unit tests that run
everywhere. The membership is asserted **by position** — the top two classes require a receipt, the bottom two do not —
so a future rename cannot narrow it without failing. `hasExternalEffect` also resolves unknown input upward, so an
unclassified call is treated as external-effect.

This also puts the rule where its eventual replacement belongs: TOOL-001 asks a tool to declare a **"side-effect
class"** separately from its risk category, and that is the honest home for "reaches outside the platform".

### The judgement that mattered, made before pass 1

`sensitive_irreversible` is *not* a synonym for what it replaced. Canon's class covers sensitivity and irreversibility
**wherever they occur**, so a member may be an **internal** action with no external receipt to store — which makes
keeping it in the external-effect set an over-approximation.

It was kept anyway. Removing it would have **relaxed** TOOL-002's rule on the most dangerous class in the set, and a
rename is the worst possible cover for loosening a safety rule. Over-refusing a receiptless success is the safe
direction, behaviour is unchanged, and the tension is recorded rather than resolved by guesswork.

---

## Pass 2 — the migration, against the fixed tree

The question pass 2 existed to answer: **does migration 0039 recreate each CHECK with exactly its original
predicate?** Dropping and re-adding a constraint is an opportunity to change it by accident, and a lost `is null`
clause would have been invisible in a diff of the *class list*.

Verified against the merged originals, character by character:

| Constraint | Original predicate | 0039 recreates |
| --- | --- | --- |
| `tool_definitions_risk_class_valid` | `risk_class is null or risk_class in (…)` | identical |
| `tool_calls_risk_class_valid` | `risk_class in (…)` — no null clause, the column is NOT NULL | identical |
| `worker_definitions_approval_threshold_valid` | `approval_threshold_risk_class is null or … in (…)` | identical |

The `is null` clause on `tool_definitions` is load-bearing: TOOL-001 requires "unclassified" to be *representable*, and
silently dropping it would have made an unclassified tool unregistrable. The existing P5-003a test that registers a
null-class tool covers that regression, and it runs in the same CI job.

Also checked and clean: 0039 sorts after 0038, so a fresh database applies it last; `down()` is a true inverse
(data rewritten before the constraints narrow, in both directions); no other module derives external-effect
independently; and nothing outside `packages/` referenced the retired name.

**Found clean.** No pass-2 findings.

---

## What the correction is proven not to have changed

Every gate here compares **ranks**, never strings. So the proof is positional:

- ranks are exactly `[0,1,2,3]`;
- the **full `isAtLeastAsRestrictiveAs` matrix** is asserted position-by-position, so no class moved;
- `MOST_RESTRICTIVE_RISK_CLASS` is still the last element;
- the **MVP ceiling is still the second class** — a shift there would have silently widened or narrowed what a worker
  may hold, and nothing else in the suite would have complained;
- the retired name still fails `isRiskClass` and still resolves **upward**, so it cannot linger as a synonym;
- real-database: all three CHECKs carry the new name, and **no row is stranded** in any of the three tables.
