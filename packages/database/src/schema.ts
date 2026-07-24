// @acbp/database — Kysely database schema types.
//
// Foundation (ACBP-P0-018) started this empty; ACBP-P1-002 introduces the first product-domain
// tables: the global identity-root `users` mapping and the `identity_webhook_receipts` idempotency
// ledger (see docs/decisions/ADR-022 §13, CDR-007, CDR-008). Kysely is generic over this interface,
// so a query can only reference a table once its type is registered here.
//
// SCOPE (CDR-008): users only. NO tenant_id/account_id/company/membership/role/permission/display-name
// columns — account membership and authorization are ACBP-P1-004.
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** timestamptz, required (no DB default) — must be supplied on insert/update. */
type RequiredTimestamp = ColumnType<Date, Date | string, Date | string>;
/** timestamptz, nullable, no default. */
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;

/**
 * Global identity-root mapping: external provider identity → internal immutable user id.
 * Not tenant-scoped (CDR-008 #1). Uniqueness is (provider, provider_instance_id, provider_user_id).
 * `provider_updated_at` is the ordering guard for last-provider-write-wins convergence (CDR-007 (d)).
 */
export interface UsersTable {
  /** Internal immutable user id (uuid, default gen_random_uuid()). Never derived from the provider. */
  id: Generated<string>;
  /** Identity provider discriminator (e.g. 'clerk'). Non-empty. */
  provider: string;
  /** Provider instance/tenant id (Clerk envelope `instance_id`). Non-empty — isolates instances. */
  provider_instance_id: string;
  /** Opaque provider subject/user id. Non-empty. Not a product identity or authorization grant. */
  provider_user_id: string;
  /** Normalized primary email (PII). Null when unknown or after soft-deletion redaction. Not unique. */
  primary_email: string | null;
  /** Authoritative primary-email verification state. Default false. */
  email_verified: Generated<boolean>;
  /** Lifecycle: 'active' | 'deleted'. Default 'active'. */
  status: Generated<string>;
  /** Provider-reported creation time (informational). */
  provider_created_at: NullableTimestamp;
  /** Provider-reported last-update time — the convergence ordering guard. Required. */
  provider_updated_at: RequiredTimestamp;
  /** Last applied provider webhook event id (diagnostics only). */
  last_event_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  /** Set when soft-deleted; null while active. */
  deleted_at: NullableTimestamp;
}

/**
 * Durable idempotency ledger of SUCCESSFULLY processed identity webhooks (CDR-008 #13). Written in
 * the SAME transaction as the user mutation; a failed mutation rolls this back. No raw payload, no
 * PII, no failure/attempt bookkeeping. PK = (provider, provider_instance_id, event_id).
 */
export interface IdentityWebhookReceiptsTable {
  provider: string;
  provider_instance_id: string;
  /** Provider event/message id (dedupe key). Non-empty. */
  event_id: string;
  event_type: string;
  /** Provider event envelope timestamp. */
  occurred_at: RequiredTimestamp;
  /** Ordering timestamp used for last-write-wins (provider updated_at, or envelope time for deletes). */
  ordering_timestamp: RequiredTimestamp;
  /** Lowercase 64-char hex SHA-256 of the raw verified payload (the payload itself is never stored). */
  payload_sha256: string;
  processed_at: Generated<Date>;
}

/**
 * Account root (ACBP-P1-003; CDR-010). An A-tenant entity: NO `company_id`, no company RLS (that is
 * ACBP-P1-006). `created_by_user_id` is the immutable, UNIQUE founding-owner link (bootstrap 1:1
 * personal account) — provenance only, never an authorization source; ACBP-P1-004 layers the
 * membership/role model on top. Lifecycle status: 'active' | 'suspended' | 'closed'.
 */
export interface AccountsTable {
  /** Internal immutable account id (uuid, default gen_random_uuid()). */
  id: Generated<string>;
  /** Immutable founding-owner user id (FK → users.id), unique (one personal account per user). */
  created_by_user_id: string;
  /** Lifecycle: 'active' | 'suspended' | 'closed'. Default 'active'. */
  status: Generated<string>;
  /** Plan/entitlement state (matches the account.created event payload). Non-empty. Default 'free'. */
  plan_state: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * Mutable, user-facing account profile (ACBP-P1-003; CDR-010 #5). 1:1 with an account (PK =
 * account_id, ON DELETE CASCADE). Email is NOT here — it stays Clerk-authoritative on `users`
 * (read-only in the platform profile). Fields grow here without churning the account root.
 */
export interface AccountProfilesTable {
  /** Owning account id (PK + FK → accounts.id, cascade). */
  account_id: string;
  /** Optional display name; when set, a bounded non-empty string. NULL = not yet set. */
  display_name: string | null;
  /** UI locale (BCP-47-ish, e.g. 'en', 'en-US'). Default 'en'. */
  locale: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * Account membership (ACBP-P1-004; CDR-011). A-tenant: links a user to an account with a role and
 * lifecycle. Authorization derives from THIS row (an active membership's role), never from a Clerk
 * claim or from accounts.created_by_user_id. `company_id` is a nullable structural hook with no FK yet
 * (companies are ACBP-P1-010). A pending invite has member_user_id null + invited_email + token hash.
 */
export interface MembershipsTable {
  id: Generated<string>;
  /** Owning account (FK accounts.id, cascade). */
  account_id: string;
  /** The member's internal user id (FK users.id). Null while an invite is pending; set on accept. */
  member_user_id: string | null;
  /** 'owner' | 'viewer'. */
  role: string;
  /** Lifecycle: 'invited' | 'active' | 'revoked'. Default 'invited'. */
  status: Generated<string>;
  /** Invite target email (PII). Present on a pending invite; null for the backfilled owner. */
  invited_email: string | null;
  /** SHA-256 hash of the single-use invite token (never the raw token). Null once accepted/revoked. */
  invite_token_hash: string | null;
  /** The owner who created the invite (FK users.id). Null for the system backfill. */
  invited_by_user_id: string | null;
  /** Company-scope hook (P1-010 attaches the FK + populates). Always null in P1-004. */
  company_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  accepted_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
}

/**
 * Append-only audit event store (ACBP-P1-008; ADR-015; CDR-014 Option A). A-tenant, account-scoped:
 * `account_id` is NOT NULL and RLS-confined to `app.current_account` (no `company_id` yet — expand-migration
 * at P1-010; no FK to accounts so a redacted trace can survive account deletion). IMMUTABLE (invariant 11):
 * the restricted role has INSERT + SELECT only — no UPDATE/DELETE grant or policy — so the Updateable type is
 * `never` on every column. `event_id`, `actor_*`, and `occurred_at` are bound server-side by the writer from
 * the caller's AccountScope; they are never client-supplied.
 */
export interface AuditEventsTable {
  /** Server-generated ULID (26-char Crockford base32). Primary key. */
  event_id: ColumnType<string, string, never>;
  /** Registered, dot-namespaced, past-tense event name (deny-unregistered enforced in @acbp/contracts). */
  name: ColumnType<string, string, never>;
  /** Integer schema version per event name. */
  schema_version: ColumnType<number, number, never>;
  /** Owning account (tenant stamp). NOT NULL; RLS binds it to app.current_account. No FK (trace survives deletion). */
  account_id: ColumnType<string, string, never>;
  /** Actor type: 'user' | 'worker' | 'system' | 'admin'. */
  actor_type: ColumnType<string, string, never>;
  /** Actor internal id; null for system/provider actors. */
  actor_id: ColumnType<string | null, string | null, never>;
  /** Bounded subject/resource type + id the event is about. */
  subject_type: ColumnType<string, string, never>;
  subject_id: ColumnType<string, string, never>;
  /** Bounded outcome code: 'success' | 'denied' | 'blocked'. */
  outcome: ColumnType<string, string, never>;
  correlation_id: ColumnType<string | null, string | null, never>;
  causation_id: ColumnType<string | null, string | null, never>;
  /** Dedupe key for idempotent producers; unique when present. */
  idempotency_key: ColumnType<string | null, string | null, never>;
  /** Bounded metadata (references/digests only) as jsonb. node-postgres serializes the object to jsonb. */
  payload: ColumnType<Record<string, string | number | boolean>, Record<string, string | number | boolean>, never>;
  /** Immutable server-set event timestamp (default now()). */
  occurred_at: ColumnType<Date, Date | string | undefined, never>;
  /** Company tenant stamp (ACBP-P1-010; CDR-015 §6). NULL for account-scoped events; set server-side from
   *  CompanyScope for company events. No FK (trace survives company deletion). Dual-scope RLS binds it. */
  company_id: ColumnType<string | null, string | null, never>;
}

/**
 * Company root (ACBP-P1-010; CDR-015). A C-root entity owned by exactly one account (`account_id`, immutable).
 * Identity + lifecycle only; the human-facing NAME is versioned in `company_profiles` (a rename is a new
 * revision). Company-scoped under RLS: create is account-keyed, read is account-scoped, mutate is dual-keyed
 * (`app.current_account` + `app.current_company`). Status: 'draft' | 'onboarding' | 'active' | 'paused'
 * (deactivate/delete deferred). `creation_mode` is onboarding provenance (immutable).
 */
export interface CompaniesTable {
  /** Internal immutable company id (uuid, default gen_random_uuid()). Never caller-supplied. */
  id: Generated<string>;
  /** Owning account (FK accounts.id, cascade). Immutable. */
  account_id: ColumnType<string, string, never>;
  /** Lifecycle: 'draft' | 'onboarding' | 'active' | 'paused'. Default 'draft'. Mutated by status transitions. */
  status: Generated<string>;
  /** Onboarding provenance: 'own_idea' | 'platform_suggested' | 'existing_business'. Immutable. */
  creation_mode: ColumnType<string, string, never>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * Versioned company profile (ACBP-P1-010; CDR-015 §Profile versioning; COMP-004). APPEND-ONLY immutable
 * revisions: a rename/edit INSERTs `version + 1`; the current profile is `max(version)` per company. The
 * (company_id, version) PK serializes concurrent writers (loser retries) → last-write-wins with visible
 * history. Dual-keyed RLS; INSERT + SELECT grants only (no UPDATE/DELETE) so every column is `never` on update.
 */
export interface CompanyProfilesTable {
  /** Owning company (FK companies.id, cascade). Part of the composite PK. */
  company_id: ColumnType<string, string, never>;
  /** Monotonic revision number per company (>= 1). Part of the composite PK. */
  version: ColumnType<number, number, never>;
  /** Human-facing company name for this revision (bounded 1..200). */
  name: ColumnType<string, string, never>;
  /** Optional description (bounded 1..2000 when present). */
  description: ColumnType<string | null, string | null, never>;
  /** Author of the revision (FK users.id); null for system-authored revisions. */
  created_by_user_id: ColumnType<string | null, string | null, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Company membership (ACBP-P1-010; CDR-015 §2). SEPARATE from account `memberships` — no reuse of the account
 * uniqueness/index/RLS. Requires an active account membership (enforced in the application layer); account
 * ownership never auto-grants company access. The creator gets an explicit active 'owner' row. Roles
 * 'owner' | 'viewer'. Dual-keyed RLS with a self-branch for pre-context resolution; INSERT + SELECT grants only.
 */
export interface CompanyMembershipsTable {
  id: Generated<string>;
  /** Owning account (FK accounts.id, cascade). */
  account_id: ColumnType<string, string, never>;
  /** Owning company (FK companies.id, cascade). */
  company_id: ColumnType<string, string, never>;
  /** The member's internal user id (FK users.id). Always bound (no pending-invite state in P1-010). */
  member_user_id: ColumnType<string, string, never>;
  /** 'owner' | 'viewer'. */
  role: ColumnType<string, string, never>;
  /** Lifecycle: 'active' | 'revoked'. Default 'active' (no revoke flow in P1-010). */
  status: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * Company activity feed projection (ACBP-P1-009; CDR-016). A separate, APPEND-ONLY, company-scoped projection of
 * the durable `audit_events` company events — written SYNCHRONOUSLY in the same transaction as the lifecycle
 * mutation + audit under the caller's CompanyScope. `event_id` = the source audit event id (idempotency +
 * traceability + rebuildability). Dual-keyed RLS (`app.current_account` + `app.current_company`). IMMUTABLE: the
 * restricted role has INSERT + SELECT only (no UPDATE/DELETE grant or policy), so every column is `never` on
 * update. All identity/tenant/time fields are server-bound from the scope + the source audit row — never client-supplied.
 */
export interface ActivityEventsTable {
  /** Source audit event id (ULID). Primary key — idempotent projection, traceable to the authoritative audit row. */
  event_id: ColumnType<string, string, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  /** One of the four company events: 'company.created' | 'company.updated' | 'company.paused' | 'company.resumed'. */
  activity_type: ColumnType<string, string, never>;
  schema_version: ColumnType<number, number, never>;
  /** Copied from the authoritative audit `occurred_at` (the event time; ordering field). */
  occurred_at: ColumnType<Date, Date | string, never>;
  actor_type: ColumnType<string, string, never>;
  actor_id: ColumnType<string | null, string | null, never>;
  subject_type: ColumnType<string, string, never>;
  subject_id: ColumnType<string, string, never>;
  /** Bounded, redacted display fields (no correlation/causation/raw). node-postgres serializes the object to jsonb. */
  payload: ColumnType<Record<string, string | number | boolean>, Record<string, string | number | boolean>, never>;
  /** When the projection row was written (default now()). Synchronous ⇒ ≈ occurred_at; not the feed's freshness source. */
  projected_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Workspace provisioning checkpoint (ACBP-P1-012; CDR-018). ONE MUTABLE current-state row per (company, step)
 * for the six canonical steps. Durable statuses pending | completed | failed ONLY (`running` is never committed);
 * attempts bounded to 3 total; transition history lives in `audit_events` (same-transaction), not here. Identity
 * columns are immutable to `acbp_app` via COLUMN-LEVEL update grants (only the outcome columns are updatable).
 * Dual-keyed FORCE RLS (`app.current_account` + `app.current_company`); no DELETE/TRUNCATE grant.
 */
export interface ProvisioningStepsTable {
  /** Owning account (FK accounts.id, cascade). Immutable. */
  account_id: ColumnType<string, string, never>;
  /** Owning company (FK companies.id, cascade). Part of the composite PK. Immutable. */
  company_id: ColumnType<string, string, never>;
  /** One of the six canonical steps. Part of the composite PK. Immutable. */
  step: ColumnType<string, string, never>;
  /** The canonical 1-based execution order (CHECK-pinned to the step name). Immutable. */
  step_order: ColumnType<number, number, never>;
  /** 'pending' | 'completed' | 'failed'. Default 'pending'. */
  status: ColumnType<string, string | undefined, string>;
  /** Total committed attempts (0 while pending; 1..3 after outcomes). */
  attempt: ColumnType<number, number | undefined, number>;
  /** When the checkpoint was seeded (creation bootstrap or backfill). Immutable. */
  requested_at: ColumnType<Date, Date | string | undefined, never>;
  started_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  completed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  failed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Closed bounded failure code ('profile_missing' | 'activity_projection_missing' | 'internal_error') or null. */
  failure_code: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/**
 * Minimal workspace-area registry (ACBP-P1-012; CDR-018 §6). APPEND-ONLY: one row per (company, area) for the
 * four creating steps (mission_draft, research, roadmap, documents). INSERT + SELECT only for `acbp_app`;
 * dual-keyed FORCE RLS. profile/activity provision no area (verification steps).
 */
export interface CompanyWorkspaceAreasTable {
  /** Owning account (FK accounts.id, cascade). */
  account_id: ColumnType<string, string, never>;
  /** Owning company (FK companies.id, cascade). Part of the composite PK. */
  company_id: ColumnType<string, string, never>;
  /** 'mission_draft' | 'research' | 'roadmap' | 'documents'. Part of the composite PK. */
  area: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Platform-administrator allowlist (ACBP-P1-013; CDR-019). The SEPARATE platform-operator authority: rows are
 * managed EXCLUSIVELY via explicit owner-connection operational setup — the restricted role has SELECT only,
 * and FORCE RLS confines it to a SELF-CHECK (`user_id = app.current_actor`; no enumeration). Every column is
 * `never` on insert/update for the app role (no runtime write path exists at all).
 */
export interface PlatformAdminsTable {
  /** The administrator's internal user id (PK; FK users.id, cascade). */
  user_id: ColumnType<string, never, never>;
  /** 'active' | 'revoked'. */
  status: ColumnType<string, never, never>;
  created_at: ColumnType<Date, never, never>;
  revoked_at: ColumnType<Date | null, never, never>;
}

/**
 * Interview sessions (ACBP-P2-001; CDR-022; WORKFLOW-STATE-MACHINES §2). The durable founder-discovery session
 * envelope, company-scoped under FORCE RLS. `state` is the mutable lifecycle column (server-enforced
 * transitions live in @acbp/core); identity columns are immutable to the app role at the privilege level
 * (`never` on update). At most one open (non-superseded) session per company (partial unique index).
 */
export interface InterviewSessionsTable {
  /** Session id (PK; server-generated uuid). Immutable. */
  id: ColumnType<string, string | undefined, never>;
  /** Owning account (FK accounts.id, cascade). Immutable. */
  account_id: ColumnType<string, string, never>;
  /** Owning company (FK companies.id, cascade). Immutable. */
  company_id: ColumnType<string, string, never>;
  /** WORKFLOW §2 lifecycle state: not_started|in_progress|waiting_for_user|ready_for_review|confirmed|superseded. */
  state: ColumnType<string, string | undefined, string>;
  /** Set when the session first entered in_progress; null while not_started. */
  started_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/**
 * Interview questions (ACBP-P2-002; CDR-023; DATA-ARCHITECTURE Question `I`). IMMUTABLE, ordered per session;
 * grants are SELECT + INSERT only, so no column is updatable by the app role. The `answered/skipped` lifecycle
 * is derived from `interview_answers`, never stored here.
 */
export interface InterviewQuestionsTable {
  id: ColumnType<string, string | undefined, never>;
  session_id: ColumnType<string, string, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  position: ColumnType<number, number, never>;
  prompt: ColumnType<string, string, never>;
  // Adaptive-orchestration columns (ACBP-P2-005; migration 0018). Set at INSERT, immutable like the rest of the
  // row. `rationale` = the "why we ask" (DISC-006); `source` = 'adaptive' | 'static_fallback' (default 'adaptive').
  rationale: ColumnType<string | null, string | null | undefined, never>;
  source: ColumnType<string, string | undefined, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Interview answers (ACBP-P2-002; CDR-023; DATA-ARCHITECTURE Answer `A`). APPEND-ONLY: a revision is a NEW row,
 * PK `(question_id, revision)`, current = max(revision) per question. Grants are SELECT + INSERT only — never an
 * in-place edit. `content` is NULL iff `status = 'skipped'`.
 */
export interface InterviewAnswersTable {
  question_id: ColumnType<string, string, never>;
  revision: ColumnType<number, number, never>;
  session_id: ColumnType<string, string, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  status: ColumnType<string, string, never>;
  content: ColumnType<string | null, string | null | undefined, never>;
  created_by_user_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Typed memory items (ACBP-P2-006; CDR-024; MEM-001/003; DATA-ARCHITECTURE §3). Company-owned, dual-keyed
 * FORCE RLS. The closed 8-value `type` (set by source path) + 6-value `source_type` provenance + resolvable
 * `source_ref`. P2-006 grants are SELECT + INSERT only (append-only); `superseded_by`/`confirmation_state`
 * advance in P2-010/M3, so they are `never` on update for the app role here.
 */
export interface MemoryItemsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  type: ColumnType<string, string, never>;
  content: ColumnType<string, string, never>;
  source_type: ColumnType<string, string, never>;
  source_ref: ColumnType<string, string, never>;
  confidence: ColumnType<number | null, number | null | undefined, never>;
  confirmation_state: ColumnType<string, string | undefined, never>;
  // `superseded_by` (0015 edit=supersede) and `deleted_at`/`deleted_by_user_id` (0016 soft delete) are the ONLY
  // app-role-updatable columns; every other column stays `never` (immutable — no content overwrite, no hard delete).
  superseded_by: ColumnType<string | null, string | null | undefined, string | null>;
  created_by_user_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  deleted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  deleted_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
}

/**
 * Model-gateway usage events (ACBP-P2-003; CDR-026 §6; ADR-011, ADR-013; USAGE-001, invariant 9;
 * DATA-ARCHITECTURE Usage event). Company-owned, dual-keyed FORCE RLS. APPEND-ONLY: grants are SELECT +
 * INSERT only — every column is `never` on update (a row is immutable once written; a correction is a new
 * row). Bounded, non-secret metadata only — NO prompt/response content. `estimated_cost_micros` is integer
 * micro-units (never a float); `error_category` is present iff `outcome = 'error'`.
 */
export interface UsageEventsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  kind: ColumnType<string, string | undefined, never>;
  provider: ColumnType<string, string, never>;
  model: ColumnType<string, string, never>;
  task_class: ColumnType<string, string, never>;
  outcome: ColumnType<string, string, never>;
  error_category: ColumnType<string | null, string | null | undefined, never>;
  input_tokens: ColumnType<number, number, never>;
  output_tokens: ColumnType<number, number, never>;
  estimated_cost_micros: ColumnType<number, number, never>;
  fallback_used: ColumnType<boolean, boolean, never>;
  latency_ms: ColumnType<number, number, never>;
  correlation_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Understanding documents (ACBP-P2-008; CDR-029; UNDER-001/005; DATA-ARCHITECTURE §3). Company-owned, dual-keyed
 * FORCE RLS. VERSIONED + APPEND-ONLY: grants are SELECT+INSERT only — a version is immutable (a re-generation is a
 * new version; review/correct is P2-009). `status` = complete|partial; `overall_confidence` in [0,1] (weakest
 * section). Every column is `never` on update.
 */
export interface UnderstandingDocumentsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  version: ColumnType<number, number, never>;
  status: ColumnType<string, string, never>;
  overall_confidence: ColumnType<number, number, never>;
  created_by_user_id: ColumnType<string | null, string | null | undefined, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Understanding items (ACBP-P2-008; CDR-029). The classified items of a document version. Company-owned, dual-keyed
 * FORCE RLS, APPEND-ONLY (SELECT+INSERT only). `item_class` = the closed 6-value set; `confidence` in [0,1];
 * `source_ref` = provenance to the originating memory item (nullable, bounded). Every column is `never` on update.
 */
export interface UnderstandingItemsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  document_id: ColumnType<string, string, never>;
  item_class: ColumnType<string, string, never>;
  content: ColumnType<string, string, never>;
  confidence: ColumnType<number, number, never>;
  source_ref: ColumnType<string | null, string | null | undefined, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface DatabaseSchema {
  users: UsersTable;
  identity_webhook_receipts: IdentityWebhookReceiptsTable;
  accounts: AccountsTable;
  account_profiles: AccountProfilesTable;
  memberships: MembershipsTable;
  audit_events: AuditEventsTable;
  companies: CompaniesTable;
  company_profiles: CompanyProfilesTable;
  company_memberships: CompanyMembershipsTable;
  activity_events: ActivityEventsTable;
  provisioning_steps: ProvisioningStepsTable;
  company_workspace_areas: CompanyWorkspaceAreasTable;
  platform_admins: PlatformAdminsTable;
  interview_sessions: InterviewSessionsTable;
  interview_questions: InterviewQuestionsTable;
  interview_answers: InterviewAnswersTable;
  memory_items: MemoryItemsTable;
  usage_events: UsageEventsTable;
  understanding_documents: UnderstandingDocumentsTable;
  understanding_items: UnderstandingItemsTable;
}

// Repository-facing row shapes.
export type UserRow = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type IdentityWebhookReceiptRow = Selectable<IdentityWebhookReceiptsTable>;
export type NewIdentityWebhookReceipt = Insertable<IdentityWebhookReceiptsTable>;
export type AccountRow = Selectable<AccountsTable>;
export type NewAccount = Insertable<AccountsTable>;
export type AccountUpdate = Updateable<AccountsTable>;
export type AccountProfileRow = Selectable<AccountProfilesTable>;
export type NewAccountProfile = Insertable<AccountProfilesTable>;
export type AccountProfileUpdate = Updateable<AccountProfilesTable>;
export type MembershipRow = Selectable<MembershipsTable>;
export type NewMembership = Insertable<MembershipsTable>;
export type MembershipUpdate = Updateable<MembershipsTable>;
export type AuditEventRow = Selectable<AuditEventsTable>;
export type NewAuditEvent = Insertable<AuditEventsTable>;
export type CompanyRow = Selectable<CompaniesTable>;
export type NewCompany = Insertable<CompaniesTable>;
export type CompanyUpdate = Updateable<CompaniesTable>;
export type CompanyProfileRow = Selectable<CompanyProfilesTable>;
export type NewCompanyProfile = Insertable<CompanyProfilesTable>;
export type CompanyMembershipRow = Selectable<CompanyMembershipsTable>;
export type NewCompanyMembership = Insertable<CompanyMembershipsTable>;
export type ActivityEventRow = Selectable<ActivityEventsTable>;
export type NewActivityEvent = Insertable<ActivityEventsTable>;
export type ProvisioningStepRow = Selectable<ProvisioningStepsTable>;
export type NewProvisioningStep = Insertable<ProvisioningStepsTable>;
export type ProvisioningStepUpdate = Updateable<ProvisioningStepsTable>;
export type CompanyWorkspaceAreaRow = Selectable<CompanyWorkspaceAreasTable>;
export type NewCompanyWorkspaceArea = Insertable<CompanyWorkspaceAreasTable>;
export type InterviewSessionRow = Selectable<InterviewSessionsTable>;
export type NewInterviewSession = Insertable<InterviewSessionsTable>;
export type InterviewSessionUpdate = Updateable<InterviewSessionsTable>;
export type InterviewQuestionRow = Selectable<InterviewQuestionsTable>;
export type NewInterviewQuestion = Insertable<InterviewQuestionsTable>;
export type InterviewAnswerRow = Selectable<InterviewAnswersTable>;
export type NewInterviewAnswer = Insertable<InterviewAnswersTable>;
export type MemoryItemRow = Selectable<MemoryItemsTable>;
export type NewMemoryItem = Insertable<MemoryItemsTable>;
export type UsageEventRow = Selectable<UsageEventsTable>;
export type NewUsageEvent = Insertable<UsageEventsTable>;
export type UnderstandingDocumentRow = Selectable<UnderstandingDocumentsTable>;
export type NewUnderstandingDocument = Insertable<UnderstandingDocumentsTable>;
export type UnderstandingItemRow = Selectable<UnderstandingItemsTable>;
export type NewUnderstandingItem = Insertable<UnderstandingItemsTable>;
