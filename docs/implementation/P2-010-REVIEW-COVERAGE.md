# ACBP-P2-010 — independent review coverage

Two independent reviewers examined the complete diff (`main...78f7635`) of the memory browser (edit + delete)
against CDR-025 (deletion semantics owner-ratified) and the CLAUDE.md rules, running against the real-PG test
evidence.

## Security review — CLEAN

No HIGH/MEDIUM production-security findings. Explicit **CORRECT** verdicts on: **soft-delete concurrency
determinism** (single guarded UPDATE; loser conflicts pre-audit; exactly one transition + one audit), **audit
atomicity** (mutation + `memory.item_deleted`/`memory.item_superseded` on the same transaction; failing writer
rolls the mutation back; bounded metadata, no content/PII), and **grant narrowness** (table grants stay
INSERT+SELECT; column-level UPDATE confined to EXACTLY `superseded_by`, `deleted_at`, `deleted_by_user_id`; no
hard-delete grant; 3 SECURITY DEFINER). Tenant isolation on the UPDATE path (dual-keyed FORCE-RLS policy governs
supersede + soft-delete), owner-only distinct authz, server-resolved actor/clock, browser omission of deleted
items, no activity projection, no propagation placeholder, synthetic fixtures — all verified. One LOW.

## Architecture / scope review — PASS, owner decision faithfully implemented

Scope-fidelity PASS (backlog satisfied; propagation honestly deferred, not faked; no restore/purge/includeDeleted
over-build; no P2-007/008/005/012 leakage). Mutability/lifecycle faithful (edit = versioned supersede never
overwrite; active/superseded/deleted mutually exclusive, DB-enforced; soft-delete row-survives). Schema deltas
additive + canon-consistent (0015 untouched by 0016; the 0012 column-UPDATE precedent). Layering clean, precedent
consistent, audit-event naming registered end-to-end + compile-exhaustive partition, future-compatible. Test
adequacy strong. One MEDIUM correctness observation + one LOW doc-hygiene defect.

## Finding dispositions (all addressed; none accepted as-is where actionable)

| # | Severity | Finding | Disposition |
|---|---|---|---|
| ARCH-MED | Medium (correctness) | `editMemoryItem` inserted the new version BEFORE the version-guarded supersede, so a lost concurrent-edit race committed an orphaned active `user_edit` item (two active versions). | **FIXED (code):** the edit now loads the target with **`findByIdForUpdate` (SELECT … FOR UPDATE)** — concurrent editors serialize on the row lock, the loser blocks then re-reads the now-superseded row and conflicts BEFORE inserting, so no orphan is committed. New real-PG test: two concurrent edits → exactly one `ok` + one `conflict`, exactly TWO rows (original superseded + ONE winning version), one active version, one supersede audit. |
| ARCH-LOW | Low (doc hygiene) | Four `CDR-025 §8` references (code comment + 3 docs) pointed at a section the CDR did not have. | **FIXED (doc):** added a dedicated **CDR-025 §7 "Deletion-propagation deferral"** section (mirroring the owner's ratified §C decision) and repointed all four references to §7. |
| SEC-L1 | Low (informational) | A malformed (non-UUID) `memoryItemId` yields the bounded generic 500 (uuid cast) rather than 404. | **Retained (consistent with the codebase).** The reviewer confirmed this is the established Class-R behavior across all routes (interview/Q&A included), is NOT an existence oracle (every malformed id → 500 regardless of existence; well-formed absent/foreign → 404/403), and leaks nothing. Kept for cross-route consistency. |
| SEC-T1 | Test note | Delete/edit route coverage leans on the collection POST for setup. | **No action.** Correct (uses the real `MemoryItemDTO.memoryItemId`); the concurrency-determinism guarantee is proven at the core layer. |

## Residuals

None actionable outstanding. The one behavior fix (edit-concurrency FOR-UPDATE lock + test) and the doc-hygiene
fix (CDR §7) are applied; the retained LOW is a documented, cross-route-consistent Class-R choice. Both reviewers
confirmed the owner-ratified soft-delete decision is faithfully implemented, with correct verdicts on delete
concurrency, audit atomicity, and grant narrowness.
