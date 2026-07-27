# CDR-051 — Tool registry and risk classes (ACBP-P5-003a, TOOL-001 / APPR-001)

Status: proposed by the implementing session. Governs **ACBP-P5-003a**, the first of the three sub-scopes the owner
ratified on 2026-07-27. Governing ADRs: **ADR-012** (worker and tool boundaries), **ADR-010** (policy evaluation).
Security: **invariant 4** (single dispatch chokepoint), **invariant 17** (injection boundary) — both enforced by
P5-003b/c, which consume what this sub-scope defines.

---

## 0. THE RISK-CLASS SET IS OWNER-APPROVED BY DEFAULT AND SHOULD BE REVISITED

**Read this before treating anything below as settled.**

The four-class set in §3 is **not a fully deliberated decision**. The implementing session searched canon thoroughly,
found that it *never enumerates* the risk classes, and stopped rather than invent them
(`AUTONOMOUS-RUN-LOG.md`, "FLAG — ACBP-P5-003a stopped"). The owner then approved the proposed four-class set
**as-is, explicitly to unblock P5-003b/c**, and explicitly asked that it be recorded as provisional.

| | |
|---|---|
| **Status** | Owner-approved **by default**, 2026-07-27, to unblock dependent work |
| **NOT** | A deliberated product decision with the classes weighed on their merits |
| **Live uncertainty** | Whether canon's single "external" notion should be **split** into `external_reversible` / `external_irreversible` at all. A **three-class** set — `informational`, `internal_reversible`, `external` — is equally consistent with canon and simpler. |
| **Why it was left as four** | Collapsing four into three later is a value remap; splitting three into four later is a migration across policy rows that already reference a class. Four is the more expensive-to-need-later shape, so it was chosen as the safer default — not because it is known to be right. |
| **When it costs nothing to change** | **Now, and until P6-001 policy rows and APPR-005 expiry defaults key off these values.** After that, changing the set is a data migration across trust-critical tables. |
| **What canon actually says** | `informational` and `internal-reversible` are canon's own words (AI-AND-WORKER-ARCHITECTURE:41). "External" appears only as an undifferentiated group (TECHNICAL-ARCHITECTURE:153, EVENT-CATALOG:179, ENGINEERING-STANDARDS:19). The 3/4 split is **an addition to canon, not a reading of it.** |

**The MVP does not exercise the difference**: it is structurally zero-external-actions (ADR-012), so no MVP tool is in
class 3 or 4 and nothing here changes MVP behaviour either way. That is precisely why the decision is cheap to revisit
now and expensive to revisit later.

---

## 1. What this sub-scope owns

| Acceptance clause | classification correctness — *"Risk class mandatory; unclassified = most restrictive"* (TOOL-001) |
|---|---|
| In scope | The closed risk-class set and its ORDER; the tool-definition registry (global, versioned); `unclassified ⇒ most restrictive` |
| Out of scope | The dispatcher chokepoint, allowlists, call records, idempotency keys (**P5-003b**); the injection boundary and fail-closed policy/approval hooks (**P5-003c**); the policy engine itself (**P6-001**) |

**On the declared P5-001 dependency.** The backlog lists P5-003 as depending on ACBP-P5-001. That dependency binds
**P5-003b/c**, which dispatch tool calls from inside job execution. It does not bind **P5-003a**, which is inert data
and contract: tool definitions are GLOBAL (`DATA-ARCHITECTURE` marks Tool definition `G`, not company-scoped) and
nothing here reads, writes, or references a job. Recorded rather than silently overridden, per the charter.

## 2. Load-bearing reading — what "unclassified = most restrictive" has to mean

TOOL-001's acceptance is *"Risk class mandatory; unclassified = most restrictive"*, and ADR-010's note is sharper:

> "a model may suggest an action's category or sensitivity, but **trust-critical determinations (risk class, spend,
> destination, forbidden match) come from the tool registry**" — APPROVAL-AND-POLICY-ARCHITECTURE §4

- **G1 — the classification is REGISTRY data, never model output.** A tool's class is a fact recorded when the tool is
  registered. Nothing at call time may compute, infer, or accept a class from a payload — that is the whole point of
  the sentence above, and it is why the class lives on the definition rather than the call.
- **G2 — "unclassified" is a REAL runtime case, not a theoretical one.** A tool row can be missing its class only if
  something went wrong, and the safe answer is the most restrictive class rather than a refusal to run: a refusal is a
  denial-of-service on the whole registry, while the most restrictive class means the call still happens but under the
  strictest gate. This is a resolution rule, not a validation rule, so it belongs beside the class set and is applied
  by every consumer.
- **G3 — the set is ORDERED, and the order is the contract.** "Most restrictive" is meaningless without one. The
  ordering is what P6-001 will compare against a policy threshold and what APPR-005 will key expiry defaults to, so it
  is exported as a comparable rank rather than left implicit in array position.

## 3. The set

Ordered least to most restrictive. **See §0** — provisional.

| Rank | Class | Meaning | Basis |
|---|---|---|---|
| 0 | `informational` | Reads only; changes nothing anywhere | canon's own term |
| 1 | `internal_reversible` | Writes inside the platform, undoably | canon's own term |
| 2 | `external_reversible` | Visible outside the platform but retractable | **a split of canon's "external"** |
| 3 | `external_irreversible` | Leaves the platform and cannot be taken back | **a split of canon's "external"** |

`unclassified ⇒ external_irreversible` (rank 3).

## 4. Registry shape

| Element | Shape |
| --- | --- |
| `tool_definitions` | **GLOBAL**, not company-scoped (`DATA-ARCHITECTURE` marks it `G`). Versioned: `UNIQUE(tool_id, version)`. |
| tenancy | **None, deliberately.** A tool is platform configuration, like a model template — not tenant data. It therefore carries no RLS and no `company_id`, and the app role gets **SELECT only**: there is no runtime write path, exactly as `platform_admins` has none (CDR-019). |
| `risk_class` | Nullable text with a CHECK constraining it to the closed set. **Nullable on purpose** — G2's "unclassified" must be representable, or the resolution rule has nothing to resolve. |
| `status` | `active` / `retired`. Retiring is a new version, never an edit — "class changes audited" (DATA-ARCHITECTURE). |

## 5. Slice plan

1. CDR-051 + branch + draft PR.
2. Contracts: the ordered class set, `resolveRiskClass` (the unclassified rule), tool-definition validation — TDD.
3. Migration 0033 `tool_definitions` (global, SELECT-only) + repository + the catalog sweep; real-PostgreSQL proof
   that the CHECK matches the contract set and that the app role cannot write.
4. Docs + **TWO** independent review passes + finalization.
