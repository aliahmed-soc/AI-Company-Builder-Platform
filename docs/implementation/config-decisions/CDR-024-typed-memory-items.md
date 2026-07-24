# CDR-024 — Typed memory items with provenance (ACBP-P2-006)

**Status:** Accepted (autonomous lead, under the standing Phase 2 authorization). **Requirements:** MEM-001,
MEM-003, UNDER-002 (classes). **Governing ADRs:** ADR-015 (audit), ADR-007 (tenancy). **Architecture:**
DATA-ARCHITECTURE.md §3. **Depends on:** ACBP-P1-005 (Done).

Records the interpretation decisions for P2-006. The memory data model is **fully pinned by canon** (§1); the
one interpretation — the **mechanism** of "All changes audited" (§4) — is resolved and flagged for owner
visibility. No owner gate: the enum, provenance, mutability and tenancy are all canonically decided.

## 1. What P2-006 is (and is not)

P2-006 is the **typed memory-item substrate**: the `memory_items` table (migration 0014) with the closed
8-type enum, the provenance fields, company-scoped dual-keyed FORCE RLS, and the persistence operations to
**create** a typed memory item (type set by the source path; untyped writes rejected) and **list** items with
their provenance. A memory item creation is **audited in the same transaction** (§4).

P2-006 is **NOT**: context assembly / provenance ranking / MEM-004 instruction precedence (**P2-007**);
understanding generation and confidence *scoring* (**P2-008**); the memory **browser** UI + edit/delete/supersede
operations (**P2-010**); interview/answer generation (**P2-005**). P2-006 provides the create + list surface and
the schema columns those later tickets populate/mutate.

## 2. Data model — `memory_items` (migration 0014; additive; company-scoped; FORCE RLS)

Additive expand migration (0001–0013 untouched; **no** new SECURITY DEFINER — still exactly three; no BYPASSRLS;
no owner runtime). One company-owned, dual-keyed FORCE-RLS table (the 0013 pattern). Columns follow
DATA-ARCHITECTURE §3 exactly:

- `id uuid pk`; `account_id`, `company_id` (dual-key, FKs to accounts/companies, cascade).
- **`type text`** — `CHECK (type in (…the eight…))`: `user_fact`, `user_preference`, `constraint`,
  `ai_assumption`, `research_finding`, `approved_decision`, `measured_outcome`, `correction`. **The type is set
  by the SOURCE PATH, never by content** (MEM-001) — the create operation derives/validates the type from the
  caller's declared provenance, and an unknown type is rejected ("untyped writes rejected").
- `content text` — the business content (bounded).
- **`source_type text`** — `CHECK (source_type in (…the six…))`: `interview_answer`, `user_edit`, `task_result`,
  `model_generation`, `imported_document`, `system_measurement` (MEM-003).
- **`source_ref text NOT NULL`** — a **resolvable** link to the originating record (MEM-003: "100% of items
  carry a resolvable source link"; "source-less legacy items are flagged 'unsourced', never presented as
  fact"). For `source_type = interview_answer` the substrate exposes no single-column answer id — an answer's
  identity is the **composite `(question_id, revision)`** (migration 0013) — so `source_ref` encodes the
  **specific pinned revision** the item was derived from (the exact revision, not "current"), keeping the link
  stable under later answer revisions. Shape validated in `@acbp/contracts`.
- `confidence double precision` (nullable; `CHECK (confidence is null or (confidence >= 0 and confidence <= 1))`)
  and `confidence_class text` (nullable) — canonical columns (§3 "numeric + class per PRD §7 bands"). The COLUMN
  is P2-006; **scoring/population is P2-008/UNDER-002**, so items are created with null confidence unless a
  caller supplies it.
- `created_by_user_id uuid` (nullable — an item may be worker/system-authored, e.g. `model_generation`;
  founder-authored items carry the server-verified user id). Author accountability is also captured in the
  audit event (§4).
- `confirmation_state text NOT NULL DEFAULT 'proposed'` — `CHECK in ('proposed','accepted','validated',
  'invalidated')` (UNDER-004). Items are created `proposed`; **advancing the state is M3** (P2-008/P2-009), not
  P2-006.
- `superseded_by uuid` (nullable self-FK; null = current) — the **forward pointer** on a correction/replacement
  (never a destructive overwrite). The column is P2-006; **the supersede OPERATION is P2-010** (the memory
  browser's edit/delete), which will add the column-level UPDATE grant then.
- `created_at timestamptz NOT NULL DEFAULT now()`.

**Grants (P2-006):** `SELECT + INSERT` only — a memory item is created, never edited, in P2-006 scope
(append-only for this ticket; P2-010 adds the column-level UPDATE for `superseded_by`/`confirmation_state`). No
DELETE/TRUNCATE. **FORCE RLS**, dual-keyed fail-closed select/insert policies requiring `account_id =
current_account AND company_id = current_company` (a validated `CompanyScope`; "cross-company reads are
impossible", MEM-003 trust-critical).

## 3. Operations + authorization

- **`createMemoryItem`** (`memory:write`): validate the submission (known type + known source_type + non-empty
  bounded `source_ref` + bounded content + optional confidence in [0,1]); **the type must be consistent with
  the source path** — a `model_generation`/`task_result` source can never produce a `user_fact`
  (backlog: "Generated claims never stored as user_fact"); insert the item `proposed`, `superseded_by=null`; and
  write the `memory.item_created` audit event in the SAME transaction (§4).
- **`listMemoryItems`** (`memory:read`): the company's memory items with their provenance, filterable by type
  (the "remain distinct" property at the persistence layer — the browser UI is P2-010). Redacted DTO.
- Two new authz actions: `memory:write` and `memory:read`, both `owner | viewer` active company members
  (creation is driven by the founder and by later system layers acting within the company; edit/delete —
  owner-only per API-CONTRACTS — are P2-010's `memory:edit`/`memory:delete`, added there).

## 4. Audit — `memory.item_created`, in-transaction (REQUIRED; contrast with P2-002)

Unlike P2-002 (whose EVENT-CATALOG audit column was "—", so events were deferred), P2-006's backlog audit
column and MEM-003 affirmatively require **"All changes audited."** P2-006 therefore **emits an audit event**:

- Register **`memory.item_created`** in the closed `AUDIT_EVENTS` set; write it in the **same transaction** as
  the memory-item insert (ADR-015's high-risk in-transaction path — a write failure rolls the item back). Wire
  it into the core audit-completeness partition (every registered event produced by exactly one operation).
- Subject = the memory item id; `actor_type` from the scope; metadata = **`{ item_type, source_type }`** only —
  bounded, non-PII references; **never the content or the raw `source_ref` value**.
- This is an **audit-store** event, not an activity projection (P1-009's taxonomy stays closed) and not a
  domain/outbox fan-out (the `memory` consumers of `interview.question_answered`/`understanding.corrected` are
  M3 and have no outbox — that fan-out remains deferred).

**Owner-visibility note (flagged, not a gate):** `memory.item_created` is a **new** audit event name not
pre-listed in EVENT-CATALOG (the catalog has no `memory.*` producer). Registering it *implements* the
canonically-required "All changes audited" behavior for the trust-critical memory table — it does not invent a
requirement — and the event name is added to EVENT-CATALOG here. It is additive and reversible. Flagged for
owner visibility given the trust-critical tag; the owner may redirect the mechanism (e.g. a different event
name, or additional create/supersede events) without reworking the table.

## 5. Recorded discrepancies (from canonical discovery; none block)

1. **Type-count layering.** MEM-001/§3 define the closed **8**-type enum; the M2 milestone names **4** illustrative
   categories and UNDER-002 names **6** understanding classes. These are three different layers — the memory
   enum stays **8, closed**; M2's four are illustrative of the "remain distinct" property, not a redefinition.
2. **`source_ref` shape vs substrate.** `interview_answers` has no single-column id; its identity is the
   composite `(question_id, revision)` (0013). A memory item's `source_ref` for an interview answer therefore
   encodes the **pinned `(question_id, revision)`** it was derived from (§2), resolving the "ID of the
   originating answer" language against the shipped substrate.
3. **`answer_id` doc drift.** DATA-ARCHITECTURE:19 lists the Answer key as "answer_id, question_id" but the
   shipped `interview_answers` (0013) has PK `(question_id, revision)` and no `answer_id` column. Cosmetic doc
   drift — noted; not corrected here (out of P2-006 scope to edit the P2-002 entity).

## 6. Slice plan

1. **Contracts** (`@acbp/contracts`): the closed memory-type + source-type enums, the type-by-source-path rule
   (which source_types may produce which types; `model_generation`/`task_result`/`system_measurement` can never
   be `user_fact`), the submission validation, the confirmation-state enum, the redacted DTOs; `memory:read`/
   `memory:write` authz; `memory.item_created` audit registration + factory; unit tests.
2. **Migration 0014** `memory_items` + real-PostgreSQL RLS/privilege/type-CHECK/provenance/catalog + down/up/
   reapply tests; existing drop-lists extended.
3. **Core operations** (`@acbp/core` memory module): `createMemoryItem` (audited in-tx; type-by-source-path;
   untyped/cross-type rejected) + `listMemoryItems`; real-PG typed/provenance/isolation/audit suite.
4. **API boundary**: authenticated create + list routes; strict parsing; bounded errors; forged-scope negatives;
   `next build`.
5. **Adversarial + docs**: real-DB HTTP adversarial (cross-company read impossible, forged claims, type/scope
   negatives); MEMORY.md + DATA-ARCHITECTURE/AUTHORIZATION/EVENT-CATALOG updates; reviews; finalization.

## 7. Out of scope / deferred (explicit)

Context assembly/ranking + MEM-004 precedence (P2-007); understanding generation + confidence scoring +
confirmation-state advancement (P2-008/P2-009/M3); the memory browser UI + edit/delete + the supersede
OPERATION and its column-level UPDATE grant (P2-010); interview/answer generation (P2-005); the
`interview.question_answered`/`understanding.corrected` → memory domain fan-out (M3, no outbox yet); a separate
`is_deleted`/soft-delete column (P2-010).
