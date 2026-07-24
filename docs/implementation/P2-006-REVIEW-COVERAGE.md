# ACBP-P2-006 — independent review coverage

Two independent reviewers examined the complete diff (`main...8bfc668`) against CDR-024 and the CLAUDE.md rules,
running against the real-PG test evidence. Both were asked for explicit verdicts on the migration root-cause fix
and the audit decision.

## Security review — CLEAN

No HIGH/MEDIUM production-security findings. **Migration root-cause fix: CORRECT** (only 0014 added; 0013.down
reverted to its own tables with a net-zero diff vs main; full apply/down/up/reapply holds). **Audit atomicity:
CORRECT** (`memory.item_created` written on `scope.db` in the same transaction as the insert; a failing writer
rolls the item back; actor/account/company server-stamped; metadata exactly `{item_type, source_type}`, subject
= item id). Tenant isolation (dual-keyed FORCE RLS, fail-closed, SELECT+INSERT only, every op on `scope.db`),
authorization (fresh company role; server-resolved account/company/actor), dual-layer type-by-source, provenance
(source_ref NOT NULL + bounded), API redaction/bounded errors, no new privilege (3 SECURITY DEFINER), and
synthetic-only fixtures all verified. One LOW.

## Architecture / scope review — CLEAN, no must-fix

**Scope-fidelity: PASS** (every backlog clause satisfied; CDR-024 §7 deferrals honored; no P2-005/007/008/010
leakage). **Audit decision: CORRECT** — a reversible documented interpretation, NOT an owner gate (auditing is
canon-required by MEM-003/backlog/ADR-015; registering a new event name for the ticket's own table changes none
of the 14 gate axes; documentation consistent across contracts/core/EVENT-CATALOG/AUDIT/MEMORY/CDR-024).
Data-model fidelity PASS (exact match to DATA-ARCHITECTURE §3; type-by-source CHECK faithful), migration fix
sound (true root cause, not a workaround; speculative changes correctly reverted), layering clean (no dep/cycle),
precedent consistency PASS, future supersede-compatibility a clean additive path, test adequacy STRONG (no
vacuous assertions). One MEDIUM (doc accuracy) + four LOW observations.

## Finding dispositions (addressed at the review-fix commit; none accepted as-is where actionable)

| # | Severity | Finding | Disposition |
|---|---|---|---|
| SEC-LOW | Low (defensive) | The DTO's `assertType`/`assertSourceType` coerced an out-of-set (corrupt) value toward the **most-trusted** `user_fact`/`user_edit` — the opposite of fail-safe for a trust-critical field. | **FIXED (code):** both now **throw** on an out-of-set value (a can't-happen invariant violation, since the DB CHECK guarantees valid enums) rather than silently relabel — fail closed, never serve a corrupt row as a founder-stated fact. |
| ARCH-a | Medium (doc accuracy) | CDR-024 §2 / MEMORY.md called `source_ref` "resolvable" and its shape "validated", but the contract only checks non-empty + length ≤256 (no per-source shape check, no resolvability). | **FIXED (doc):** CDR-024 §2, MEMORY.md, and the core comment now state precisely that `source_ref` is enforced **non-empty + bounded** (that is what makes an item "source-linked"); the `(question_id, revision)` encoding is a **convention** P2-006 does not parse; deep polymorphic resolvability is **P2-007**'s concern. |
| ARCH-c | Low (YAGNI) | `MemoryItemRepository.findById` was unused in P2-006 (only `insert`/`list` consumed). | **FIXED (code):** removed — P2-007/P2-010 can add a source-resolution read when they need it. |
| ARCH-b | Low (judgment) | `memory:write` (create) granted to owner\|viewer diverges mildly from API-CONTRACTS' "Owner (edit/delete), member (read)". | **Retained, documented.** Create is a member write (viewers propose; edit/delete/confirm stay owner-gated in P2-010/M3); recorded in CDR-024 §3 + AUTHORIZATION.md, flagged here for owner awareness. Not a defect. |
| ARCH-d | Low (note) | `confirmation_state` ships without its §3 companion `confirmed_by`. | **Correct as-is.** Only advancement writes `confirmed_by` (deferred to P2-008/P2-009); the additive `confirmed_by` column is a P2-008 prerequisite. `confirmation_state` belongs in P2-006 (every item is born `proposed`). Noted. |
| ARCH-e / SEC | Low (note) | The `auditWriter` test seam sits on the production `MemoryOptions` interface. | **Retained.** Clearly labeled TEST SEAM ONLY, never passed by the route/request layer — matches the established audited-op testing approach (P2-001). |

## Residuals

None actionable outstanding. Every actionable finding is fixed (one code fail-closed hardening, one dead-code
removal, doc-accuracy corrections); the retained items are documented judgment calls with owner-visibility notes.
Both reviewers gave explicit CORRECT verdicts on the migration root-cause fix and the audit atomicity/decision.
