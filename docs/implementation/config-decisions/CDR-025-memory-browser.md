# CDR-025 — Memory browser (ACBP-P2-010)

**Status:** Accepted. The deletion semantics (§0) were an owner gate, now **RATIFIED by the owner** (all three
recommendations approved: `deleted_at` + `deleted_by_user_id`; `memory.item_deleted` in-tx; propagation
deferred to M3/M4). **Requirement:** MEM-002. **Governing ADR:** ADR-015 (audit).
**Architecture:** API-CONTRACTS.md (Memory), DATA-ARCHITECTURE.md §3, MEMORY.md. **Depends on:** ACBP-P2-006
(Done).

P2-010 is the memory **browser**: list/filter/get the company's typed memory, resolve/display source links,
and the owner **edit** (versioned supersede) + **delete** (soft) operations — all audited (MEM-002). This CDR
records the **canon-resolved, delete-independent** design (edit + read), which proceeds now, and **flags the
deletion-semantics decision as a mandatory owner gate** (§0) — the delete OPERATION, its schema representation,
and the deletion-propagation scope are NOT implemented until the owner ratifies §0.

## 0. Memory deletion semantics — OWNER-RATIFIED

CLAUDE.md lists **"deletion semantics"** among the mandatory owner gates. The owner **approved** all three
recommendations below, so this is now the implemented contract: **(A)** soft delete via nullable `deleted_at
timestamptz` + `deleted_by_user_id uuid` (FK users); **(B)** a `memory.item_deleted` audit event written in the
same transaction as every successful deletion; **(C)** propagation of the deletion into understanding/plans is
deferred to the M3/M4 tickets that introduce those systems (§7). Implemented in migration 0016 + the
core `deleteMemoryItem` operation + the DELETE route. The original gate analysis (kept for the record):

P2-010 operationalizes memory deletion for the first time. Canon **constrains but does not fully pin** it, and
one clause conflicts with reality:

- **Soft vs hard:** canon forbids a hard delete — MEM-002 acceptance is "deletions **persist** and are audited",
  DATA-ARCHITECTURE §3 gives a `deleted` **lifecycle state**, and the item is "User-deletable" (non-destructive).
  **Soft delete is the only canon-consistent reading.** But the **representation is unpinned**: CDR-024 §7
  explicitly deferred "a separate `is_deleted`/soft-delete column" to P2-010, and `confirmation_state` has no
  `deleted` value today. So P2-010 must choose the representation (a new `deleted_at`/`is_deleted` column, or a
  state extension) — a schema decision on deletion semantics.
- **Propagation:** MEM-002 edge + the backlog "Deletion propagates staleness flags" list propagation to
  dependent plans as P2-010 behavior. But **plans (M4) and understanding-staleness (M3/P2-009) do not exist
  yet**, and P2-010's only dependency is P2-006. Propagation cannot be delivered now.

**Recommended answer (for owner ratification):** (1) **soft delete** via a new nullable **`deleted_at
timestamptz`** column + `deleted_by_user_id` (additive migration; a deleted item is one with `deleted_at IS NOT
NULL`; it stays queryable and auditable, never destroyed), gated by a narrow column-level UPDATE grant; (2) a new
in-transaction audit event **`memory.item_deleted`** (`{}` or `{item_type}` metadata, no content); (3) **defer
propagation** to when dependents + the memory fan-out exist (M3/M4), tracked against P2-009/M3. This is the
safer, reversible, canon-aligned reading. **Exact answer needed:** approve (a) the soft-delete `deleted_at`
representation, (b) the `memory.item_deleted` event, and (c) deferring propagation — or specify alternatives.

Until ratified, the delete route/operation/column/event are **NOT built**; P2-010 ships the edit + read half and
is **not Done**.

## 1. Edit — versioned supersede (canon-resolved; proceeds)

Canon pins edit = **new version + forward pointer, never destructive overwrite** (DATA-ARCHITECTURE §3
`superseded_by`; MILESTONE M3 "supersede not overwrite"; CDR-024 §2). `editMemoryItem` (owner-only,
**`memory:edit`**):

1. Load the **current** target row by id (must be visible in scope and **not already superseded**:
   `superseded_by IS NULL`).
2. INSERT a **new** memory item — a user correction: `source_type = 'user_edit'`, `source_ref = <the superseded
   item's id>` (the correction cites what it corrects), `type` + `content` (+ optional `confidence`) from the
   caller, validated by the P2-006 `validateMemorySubmission` (type-by-source-path: a `user_edit` source may
   carry any of the 8 types). `created_by_user_id` = the editor.
3. **Version-guarded UPDATE** of the old row: `UPDATE memory_items SET superseded_by = <new id> WHERE id = <old
   id> AND superseded_by IS NULL` — 0 rows updated ⇒ a concurrent edit already superseded it ⇒ bounded
   `conflict`/`not_found` (optimistic concurrency; the same "guard on the current state" shape as the
   `interview_sessions` from-state guard). "Edit version-guarded" (API-CONTRACTS) = this current-pointer guard.
4. Write **`memory.item_superseded`** in the SAME transaction (a lifecycle transition — ADR-015 in-tx path),
   metadata `{item_type, source_type}` of the new version (no content). The new row's creation is NOT separately
   `memory.item_created` — a supersede is one audited event, not two.

`memory:edit` is **owner-only** (API-CONTRACTS "Owner (edit/delete)") — contrast the P2-006 `memory:write`
(owner|viewer) create grant.

## 2. Read surface — list/filter/get + resolve source link (canon-resolved; proceeds)

- **Filtered list** (`memory:read`): the P2-006 `listMemoryItems` already supports a `type` filter + bounded
  page size; P2-010 exposes the `type` filter (and a `currentOnly` view — `superseded_by IS NULL` — so the
  browser shows current items by default) at the API. Deterministic order (created_at desc, id desc).
- **Get single** (`memory:read`): a single item by id (RLS-confined).
- **Resolve/display source link:** the browser surfaces `source_type` + `source_ref` as-is (P2-006 does not
  verify deep resolvability — CDR-024 §2; deep cross-table resolution is P2-007). No new deref logic in P2-010
  beyond presenting the stored link.

## 3. Schema — migration 0015 (edit only; delete grant is §0-gated)

Additive (0001–0014 untouched; no new SECURITY DEFINER — still three; no BYPASSRLS; no owner runtime). Following
the `interview_sessions` (0012) **column-level UPDATE** precedent: `grant update (superseded_by) on
public.memory_items to acbp_app`. This is the **narrow** grant for edit=supersede — `content`/`type`/`source_*`/
identity columns stay immutable (no content overwrite). The delete column + its grant are added by the §0-gated
delete migration (later), not here.

## 4. Events / audit

- New in-tx audit event **`memory.item_superseded`** (registered in the closed `AUDIT_EVENTS`; core partition +
  factory; EVENT-CATALOG entry), subject = the SUPERSEDED (old) item id, metadata `{item_type, source_type}` of
  the new version — no content, no raw source_ref. Audit-only (no activity projection, no fan-out).
- `memory.item_deleted` is **§0-gated** (not registered until the delete decision is ratified).
- The event NAME (`memory.item_superseded`) is a new name not previously in EVENT-CATALOG — the same
  document-and-flag posture as P2-006's `memory.item_created` (CDR-024 §4; the reviews confirmed event-naming is
  not an owner gate). Flagged for owner visibility.

## 5. Slice plan (delete-independent half)

1. Contracts: `memory:edit` authz (owner-only); the edit submission validation reuse + version-guard result
   shapes; `memory.item_superseded` audit registration + factory + core partition; unit tests.
2. Migration 0015: column-level `UPDATE (superseded_by)` grant + real-PG privilege/immutability test (content/
   type/source still not updatable).
3. Core: `editMemoryItem` (supersede, version-guarded, audited in-tx) + `getMemoryItem` + the current-only/
   filtered list; real-PG suite (supersede chain, version-guard conflict, audit atomicity, cross-tenant).
4. API: filtered GET list (+ `type` query param — the browser's filter), GET single, PATCH edit; web tests +
   build.
5. Adversarial + docs (MEMORY.md browser section, EVENT-CATALOG, AUTHORIZATION, API-CONTRACTS); reviews.

## 6. Out of scope / deferred

**Later tickets:** context assembly + provenance ranking + MEM-004 precedence (P2-007); understanding generation
+ confidence scoring + confirmation-state advancement (P2-008/P2-009); the E2E Slice B demo (P2-012);
interview/answer generation (P2-005). No hard delete, no in-place content overwrite, no restore/undelete/purge/
physical delete (all violate canon or exceed P2-010 scope).

## 7. Deletion-propagation deferral (owner-ratified)

The backlog lists "Deletion propagates staleness flags" as P2-010 behavior, but the dependents do not exist yet:
understanding + its staleness machinery are **M3/P2-009**, and plans/dependent artifacts are **M4** — P2-010's
only dependency is P2-006. Per the owner's ratified decision, P2-010 **durably records** the deletion state
(`deleted_at`/`deleted_by_user_id`) and the `memory.item_deleted` audit event; the **propagation** of that
deletion into understanding, plans, or other dependent artifacts is **deferred** to those later tickets. No
placeholder dependent tables, flags, queues, events, or workers are created. Future consumers detect a deletion
through the durable memory row + the audit history; no downstream system currently exists to update. This
resolves the backlog wording without pretending nonexistent dependents were updated.
