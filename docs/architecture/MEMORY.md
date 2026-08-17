# MEMORY.md — typed company memory (ACBP-P2-006)

Governed by **CDR-024**; requirements **MEM-001** (typed items), **MEM-003** (provenance + company scope),
UNDER-002 (classes). ADRs: ADR-015 (audit), ADR-007 (tenancy). P2-006 delivers the **typed memory substrate**:
persist a typed, source-linked memory item and list a company's items. P2-010 has since added the supersede
(edit) and soft-delete operations plus the browser's read filters — see "Memory browser" below. The browser
**UI** and advancing `confirmation_state` (confirm) are still later work; context assembly and provenance
ranking are P2-007; understanding generation and confidence *scoring* are P2-008.

## The typed item (DATA-ARCHITECTURE §3)

A memory item is **company-owned** (`C`; `company_id` immutable), **append-only in P2-006** (a revision/supersede
model arrives with P2-010), and carries its provenance. Migration `0014` (`memory_items`):

| Column | Meaning |
|---|---|
| `id` | server-generated memory item id (the audit subject; a future `source_ref` target) |
| `account_id`, `company_id` | dual-key tenancy (immutable; FORCE-RLS predicate) |
| `type` | the **CLOSED 8-value** enum — `user_fact`, `user_preference`, `constraint`, `ai_assumption`, `research_finding`, `approved_decision`, `measured_outcome`, `correction` |
| `content` | the business content (1–10 000 chars) |
| `source_type` | the **CLOSED 6-value** provenance enum — `interview_answer`, `user_edit`, `task_result`, `model_generation`, `imported_document`, `system_measurement` |
| `source_ref` | **NOT NULL**, non-empty, bounded (≤256) — the source link (MEM-003 "source-linked"). By convention `interview_answer` refs encode the pinned `(question_id, revision)`; P2-006 does NOT shape-check the encoding or verify resolvability (a polymorphic ref has no hard FK — deep resolution is P2-007's concern) |
| `confidence` | nullable numeric in `[0,1]` — the class band (PRD §7) is *derived* by P2-008; P2-006 stores the number |
| `confirmation_state` | `proposed`→`accepted`→`validated`/`invalidated` (UNDER-004); created `proposed`, advanced in M3 |
| `superseded_by` | nullable self-FK forward pointer (DATA-ARCHITECTURE §3); always null in P2-006 (the supersede OPERATION is P2-010) |
| `created_by_user_id` | the author (server-verified) |
| `created_at` | creation timestamp |

CHECKs: the 8-type and 6-source enums; **type-by-source-path** (`type not in ('user_fact','user_preference') OR
source_type in ('interview_answer','user_edit')`) so a generated claim can NEVER be stored as a `user_fact`;
content length; `source_ref` length; confidence range; confirmation-state set. Indexes: `(company_id, type)` and
`(company_id, created_at desc, id desc)`.

**Tenancy:** ENABLE + FORCE RLS with dual-keyed fail-closed select/insert policies requiring `account_id =
current_account AND company_id = current_company`. Grants are `SELECT`+`INSERT` only — no UPDATE/DELETE.
Cross-company reads are impossible (MEM-003 trust-critical, proven by the real-PG suite).

## Operations (`@acbp/core`)

- **`createMemoryItem`** (`memory:write`): validate the submission (known type + known source_type +
  type-by-source-path + non-empty bounded content + non-empty bounded `source_ref` + confidence in `[0,1]`);
  insert the item (`proposed`, `superseded_by` null, server-verified author); write **`memory.item_created`** in
  the SAME transaction. Runs under the caller's validated `CompanyScope` on the restricted `acbp_app` role.
- **`listMemoryItems`** (`memory:read`): the company's items, newest-first with a deterministic total order
  `(created_at desc, id desc)`, optional single-`type` filter, bounded page size (default 100, max 500 — never
  unbounded).

Authz reuses **`memory:read`** and **`memory:write`**, both `owner|viewer` active company members. The type is
set by the **source path**, never by content.

## HTTP

- `GET  /api/companies/{companyId}/memory` — list (redacted, newest-first, bounded). Accepts ONLY the P2-010
  browser filters `type` and `currentOnly`; any OTHER query parameter → bounded 400.
- `POST /api/companies/{companyId}/memory` — create (`201`), body `{ type, content, sourceType, sourceRef,
  confidence? }`. account/company/actor are **server-resolved** — a request cannot forge them; extra body fields
  are ignored. Denial → one opaque 403; validation → 400; unexpected throw → the bounded generic 500. POST takes
  no query parameter. The COLLECTION route exposes no PATCH/DELETE verb — supersede and delete are P2-010 verbs
  on the ITEM route `…/memory/{id}`, specified under "Memory browser" below.

## Audit — `memory.item_created` (in-transaction; REQUIRED)

MEM-003 / the backlog require "all changes audited," so a memory item creation **emits an audit-store event** —
the contrast with P2-002's persistence-only Q&A (CDR-024 §4). `memory.item_created` is registered in the closed
`AUDIT_EVENTS` set and written in the SAME transaction as the insert (audit-or-nothing: a write failure rolls the
item back — no unaudited memory). Subject = the memory item id; actor/account/company stamped server-side;
metadata is EXACTLY `{item_type, source_type}` — never the founder content or the raw `source_ref` value. It is
**audit-only** (never activity-projected — P1-009's closed taxonomy is untouched), and no domain/outbox fan-out
is emitted (the `interview.question_answered`→memory and `understanding.corrected`→memory consumers are M3, and
no transactional outbox exists yet). `memory.item_created` is a new event name added to EVENT-CATALOG here,
flagged for owner visibility in CDR-024 §4 — additive/reversible.

## Memory browser (ACBP-P2-010; CDR-025)

The browser reads and mutates the P2-006 substrate. A memory item has a **derived lifecycle** (mutually
exclusive): **active** (`superseded_by IS NULL AND deleted_at IS NULL`), **superseded**
(`superseded_by` set), **deleted** (`deleted_at` set) — enforced by a DB mutual-exclusion CHECK.

- **Read** (`memory:read`): `GET …/memory` (filtered by `type` / `currentOnly`; **deleted items are always
  omitted** — no `includeDeleted` toggle) and `GET …/memory/{id}` (a deleted item reads as `not_found`). The
  row survives for history/audit; owner inspection at the DB level still sees it.
- **Edit** = versioned **supersede** (`memory:edit`, OWNER-only): `PATCH …/memory/{id}` inserts a new
  `user_edit` version (citing the corrected item) and points the old row's `superseded_by` at it —
  **never a content overwrite**. Version-guarded (only a current row can be edited; a raced/terminal state →
  `409`). Writes `memory.item_superseded` in-tx.
- **Delete** = **soft delete** (`memory:delete`, OWNER-only; CDR-025 §0 owner decision): `DELETE …/memory/{id}`
  sets `deleted_at` (server clock) + `deleted_by_user_id` on a current active item, guarded so exactly one
  transaction transitions (a concurrent/already-deleted/superseded delete → `409`). Writes `memory.item_deleted`
  in-tx (metadata `{item_type, source_type, transition:'active_to_deleted'}`, no content). **No hard delete, no
  restore/purge, no dependent propagation** (deferred — below). The row persists for history and later
  staleness processing.

**Grants (migration 0015 + 0016):** the app role gains column-level `UPDATE` on EXACTLY the lifecycle-pointer
columns — `superseded_by` (0015) + `deleted_at`/`deleted_by_user_id` (0016). Content/type/source/confidence/
confirmation/identity/creation stay immutable; there is no DELETE/TRUNCATE grant. The 0015 dual-keyed FORCE-RLS
UPDATE policy governs all three.

## Deferred (explicit)

Context assembly, provenance ranking, MEM-004 instruction precedence (P2-007); understanding generation +
confidence-class scoring + confirmation-state advancement (P2-008/M3); **deletion propagation** to dependent
understanding/plans — P2-010 durably records the delete + its audit; the propagation of staleness to dependents
belongs to M3/P2-009 (understanding) and M4 (plans), which do not exist yet (CDR-025 §7); the domain fan-out of
`memory.item_created` and the memory consumption of `interview.question_answered` / `understanding.corrected`
(M3, no outbox yet). No restore/undelete/purge/physical-delete in P2-010.
