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
  /**
   * The worker run that caused this call (ACBP-P5-014; the link CDR-057 section 4 deferred to P5-014). Nullable:
   * calls made outside a worker run - planning, strategy, the interview - legitimately have none.
   */
  worker_run_id: ColumnType<string | null, string | null | undefined, never>;
  /**
   * WHY the call fell over to the secondary provider (ACBP-P5-009; NFR-019). The normalized category, never raw
   * provider text. A reason never appears without a fallover (DB CHECK); the converse is guaranteed by the writer
   * rather than the schema, because rows predating migration 0030 carry `fallback_used = true` with no reason.
   */
  fallback_reason: ColumnType<string | null, string | null | undefined, never>;
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

/**
 * Understanding item reviews (ACBP-P2-009; CDR-030 §5). Append-only per-item review decisions over an immutable
 * understanding item. Company-owned, dual-keyed FORCE RLS, APPEND-ONLY (SELECT+INSERT only). `decision` = the closed
 * 5-value control set; `note` (nullable, bounded) = edited text / reject reason / request note. The item's effective
 * review state is its LATEST row. Every column is `never` on update.
 */
export interface UnderstandingItemReviewsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  document_id: ColumnType<string, string, never>;
  item_id: ColumnType<string, string, never>;
  decision: ColumnType<string, string, never>;
  note: ColumnType<string | null, string | null | undefined, never>;
  decided_by_user_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Understanding confirmation events (ACBP-P2-009; CDR-030 §5). The per-version confirm/correct lifecycle. Company-owned,
 * dual-keyed FORCE RLS, APPEND-ONLY (SELECT+INSERT only). `kind` = the closed 2-value set (`confirmed` | `corrected`);
 * UNIQUE `(document_id, kind)`. `correction_ref` + `dependents_flagged` are set ONLY for `corrected` (DISC-008). A
 * version is confirmed-and-active IFF it has a `confirmed` and no `corrected` event. Every column is `never` on update.
 */
export interface UnderstandingConfirmationEventsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  document_id: ColumnType<string, string, never>;
  version: ColumnType<number, number, never>;
  kind: ColumnType<string, string, never>;
  actor_user_id: ColumnType<string, string, never>;
  correction_ref: ColumnType<string | null, string | null | undefined, never>;
  dependents_flagged: ColumnType<number | null, number | null | undefined, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Tasks (ACBP-P4-002; CDR-033). Company-owned, dual-keyed FORCE RLS. `state` is the closed 11-value set;
 * MUTABLE-with-audit — `state` + `updated_at` are updateable, every other column is `never` on update (immutable).
 */
export interface TasksTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  state: ColumnType<string, string | undefined, string>;
  title: ColumnType<string, string, never>;
  description: ColumnType<string | null, string | null | undefined, never>;
  milestone_id: ColumnType<string | null, string | null | undefined, never>;
  /**
   * The planned task's type (ACBP-P4-003; PLAN-001 "each has type and description"). NULL = not stated, rendered as
   * explicitly missing rather than guessed (TASK-002/ADR-019). INSERT-ONLY — the column UPDATE grant stays
   * `(state, updated_at)`.
   */
  task_type: ColumnType<string | null, string | null | undefined, never>;
  /** The planning RANK (0 = first). Not a scale — an invented high/medium/low is fake precision (CDR-040 §8-G1). */
  priority: ColumnType<number | null, number | null | undefined, never>;
  /**
   * PLAN-004: why THIS task was chosen (ACBP-P4-006). NULL = "not recorded" — never invented (ADR-019). INSERT-ONLY,
   * like `task_type`/`priority`: the column UPDATE grant stays exactly `(state, updated_at)`.
   */
  rationale: ColumnType<string | null, string | null | undefined, never>;
  /**
   * TASK-008 lineage: the task this one was repeated FROM (ACBP-P4-005). NULL for anything that is not a repeat.
   * INSERT-ONLY for the same reason as the three above.
   */
  repeated_from_task_id: ColumnType<string | null, string | null | undefined, never>;
  created_by_user_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/**
 * Task dependencies (ACBP-P4-002; CDR-033). A company-owned, dual-keyed FORCE RLS, IMMUTABLE Task↔Task edge
 * (SELECT+INSERT only). UNIQUE (task_id, depends_on_task_id); no self-dependency. Every column is `never` on update.
 */
export interface TaskDependenciesTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  task_id: ColumnType<string, string, never>;
  depends_on_task_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Strategy generations (ACBP-P3-001; CDR-034). A company-owned, dual-keyed FORCE RLS, IMMUTABLE record of one
 * strategy-option generation from a confirmed understanding version (SELECT+INSERT only). Every column is `never`
 * on update; `similarity_check_result` defaults to 'pending' (the P3-002 distinctness engine sets the verdict).
 */
export interface StrategyGenerationsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  understanding_document_id: ColumnType<string, string, never>;
  understanding_version: ColumnType<number, number, never>;
  status: ColumnType<string, string, never>;
  option_count: ColumnType<number, number, never>;
  fewer_reason: ColumnType<string | null, string | null | undefined, never>;
  similarity_check_result: ColumnType<string, string | undefined, never>;
  model_flagged_partial: ColumnType<boolean, boolean | undefined, never>;
  created_by_user_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Strategy options (ACBP-P3-001; CDR-034). A company-owned, dual-keyed FORCE RLS, IMMUTABLE option row carrying the
 * validated 16-field `fields` jsonb object (SELECT+INSERT only). UNIQUE (generation_id, ordinal); every column
 * `never` on update. `fields` is a flat string→string map (the validated 16-field content standard).
 */
export interface StrategyOptionsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  generation_id: ColumnType<string, string, never>;
  ordinal: ColumnType<number, number, never>;
  fields: ColumnType<Record<string, string>, Record<string, string>, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Strategy recommendations (ACBP-P3-003; CDR-036). A company-owned, dual-keyed FORCE RLS, IMMUTABLE advisory
 * recommendation over a generation's options (SELECT+INSERT only). Append-only (latest-wins on read); every column
 * `never` on update. References one option + carries rationale + sensitivities; selects nothing (P3-004 owns selection).
 */
export interface StrategyRecommendationsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  generation_id: ColumnType<string, string, never>;
  recommended_option_id: ColumnType<string, string, never>;
  rationale: ColumnType<string, string, never>;
  sensitivities: ColumnType<string, string, never>;
  created_by_user_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Strategy selections (ACBP-P3-004; CDR-037). A company-owned, dual-keyed FORCE RLS, IMMUTABLE owner decision over a
 * generation's options (SELECT+INSERT only). Append-only (latest-wins on read); every column `never` on update. `mode`
 * is the closed {select, edit, combine, reject} set; `selected_option_id`/`chosen_fields`/`phase_scope`/`reasons` are
 * mode-shaped by CHECK constraints. Records a selection only — NOT a decision record (P3-005), and unlocks no planning.
 */
export interface StrategySelectionsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  generation_id: ColumnType<string, string, never>;
  mode: ColumnType<string, string, never>;
  selected_option_id: ColumnType<string | null, string | null, never>;
  chosen_fields: ColumnType<Record<string, string> | null, Record<string, string> | null, never>;
  phase_scope: ColumnType<string | null, string | null, never>;
  reasons: ColumnType<string | null, string | null, never>;
  created_by_user_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Decision records (ACBP-P3-005; CDR-038; STRAT-006). A company-owned, dual-keyed FORCE RLS, IMMUTABLE, audit-grade
 * record of an owner decision (SELECT+INSERT only). Append-only (latest-wins on read); every column `never` on update —
 * "mutation attempts fail" is the STRAT-006 acceptance criterion. Links the understanding version, the options
 * considered (via `generation_id`), the selection it hardens, and an optional owner-supplied rationale.
 */
export interface DecisionsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  generation_id: ColumnType<string, string, never>;
  selection_id: ColumnType<string, string, never>;
  /** Immutable snapshot of the hardened selection's mode — the P4-001 planning gate keys off a NON-reject decision. */
  mode: ColumnType<string, string, never>;
  understanding_version: ColumnType<number, number, never>;
  rationale: ColumnType<string | null, string | null, never>;
  created_by_user_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Roadmaps (ACBP-P4-001; CDR-039; ROAD-001/002). Company-owned, dual-keyed FORCE RLS, VERSIONED append-only
 * (SELECT+INSERT only): a new version is a NEW ROW, never an in-place edit — which is what makes ROAD-002's "version
 * write failure blocks the edit rather than losing history" structural. Every column `never` on update.
 */
export interface RoadmapsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  version: ColumnType<number, number, never>;
  decision_id: ColumnType<string, string, never>;
  status: ColumnType<string, string, never>;
  origin: ColumnType<string, string, never>;
  supersedes_roadmap_id: ColumnType<string | null, string | null, never>;
  edit_reason: ColumnType<string | null, string | null, never>;
  model_flagged_partial: ColumnType<boolean, boolean | undefined, never>;
  created_by_user_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/** Goals (ACBP-P4-001). Immutable; ordinal-sequenced within one roadmap version. */
export interface GoalsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  roadmap_id: ColumnType<string, string, never>;
  ordinal: ColumnType<number, number, never>;
  title: ColumnType<string, string, never>;
  description: ColumnType<string | null, string | null, never>;
  status: ColumnType<string, string | undefined, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Milestones (ACBP-P4-001; ROAD-001 "target sequencing"). Immutable; sequenced by ORDINAL only — never by an invented
 * date (ADR-019 no fake precision). `goal_id` is pinned to the same roadmap version by a composite FK.
 */
export interface MilestonesTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  roadmap_id: ColumnType<string, string, never>;
  goal_id: ColumnType<string | null, string | null, never>;
  ordinal: ColumnType<number, number, never>;
  title: ColumnType<string, string, never>;
  description: ColumnType<string | null, string | null, never>;
  status: ColumnType<string, string | undefined, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/** Task review flags (ACBP-P4-001; ROAD-002 "changes flag affected tasks"). Immutable append-only. */
export interface TaskReviewFlagsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  task_id: ColumnType<string, string, never>;
  roadmap_id: ColumnType<string, string, never>;
  reason: ColumnType<string | null, string | null, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Planning runs (ACBP-P4-006; PLAN-004). IMMUTABLE — a run is a historical record of what planning considered, and
 * rewriting it would defeat the point of the requirement. Recorded even when generation FAILED (CDR-041 §3-G3).
 */
export interface PlanningRunsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  mode: ColumnType<string, string, never>;
  outcome: ColumnType<string, string, never>;
  roadmap_id: ColumnType<string, string, never>;
  roadmap_version: ColumnType<number, number, never>;
  decision_id: ColumnType<string, string, never>;
  phase_scope: ColumnType<string | null, string | null, never>;
  task_count: ColumnType<number, number, never>;
  tasks_missing_rationale: ColumnType<number, number, never>;
  milestones_in_scope: ColumnType<number, number, never>;
  milestones_omitted: ColumnType<number, number | undefined, never>;
  memory_items_considered: ColumnType<number, number, never>;
  memory_items_omitted: ColumnType<number, number | undefined, never>;
  /** Why the run produced nothing; null unless `outcome = 'failed'` (shape CHECK). */
  failure_reason: ColumnType<string | null, string | null | undefined, never>;
  created_by_user_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * The resolvable links from a run to what it considered (ACBP-P4-006; PLAN-004; MEM-003). Immutable. `kind` is a
 * closed discriminator so a new input kind is an INSERT, not a migration; `ref_id` is a bare id because the kinds span
 * several tables (and two that do not exist yet).
 */
export interface PlanningRunInputsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  run_id: ColumnType<string, string, never>;
  kind: ColumnType<string, string, never>;
  ref_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Task deletions (ACBP-P4-005; TASK-008). IMMUTABLE append-only: `tasks` has no DELETE grant, so a deletion is a
 * RECORDED FACT rather than an erasure — which is also what keeps the audit trail TASK-008 demands intact.
 * `UNIQUE(task_id)` makes a repeat delete the same fact rather than a second one.
 */
export interface TaskDeletionsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  task_id: ColumnType<string, string, never>;
  /** The state the task held when removed — the only place that distinction survives once reads filter it out. */
  state_at_delete: ColumnType<string, string, never>;
  reason: ColumnType<string | null, string | null, never>;
  deleted_by_user_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Durable jobs (ACBP-P5-001a; CDR-049; ADR-008). Company-owned, dual-keyed FORCE RLS. WE own this table — ADR-008's
 * owner amendment makes "job tables remain standard SQL (exit path)" binding, so a runner library may poll it but
 * may not own its DDL. Tenant context is MANDATORY (invariant 3): `account_id`/`company_id` are NOT NULL and
 * immutable to the app role, and the dual-keyed WITH CHECK refuses a foreign pair that NOT NULL cannot see.
 */
export interface JobsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  /** What work this represents. The CLOSED set is validated in the use case, so a new kind is not a migration. */
  kind: ColumnType<string, string, never>;
  /** queued · running · succeeded · failed · dead_letter · cancelled. Mutable via the column-scoped grant. */
  state: ColumnType<string, string | undefined, string>;
  /** References, NEVER secrets (ADR-008 §11). Bounded by CHECK. */
  payload: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, never>;
  /** Attempt counter. P5-001c owns the cap; the column is declared now so b/c extend rather than reshape. */
  attempts: ColumnType<number, number | undefined, number>;
  /**
   * Why a dead-lettered job failed (ACBP-P5-001c). CLOSED category, never provider text. Nullable, and its CHECK is
   * one-directional: a reason implies dead_letter, but history without one stays legal.
   */
  failure_reason: ColumnType<string | null, never, string | null>;
  /** Unique per company WHEN PRESENT — the same logical job enqueued twice is one row (TASK-009/NFR-006). */
  idempotency_key: ColumnType<string | null, string | null | undefined, never>;
  created_by_user_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/**
 * Job checkpoints (ACBP-P5-001b; CDR-050; NFR-005). APPEND-ONLY: a checkpoint records that a STEP COMPLETED, so its
 * PRESENCE is what makes re-execution unnecessary — every column is 
ever on update, matching the SELECT+INSERT
 * grant. Written in the SAME transaction as the step's effect, so a crash can never leave the effect landed and the
 * record missing (CDR-050 §3-G5).
 */
export interface JobCheckpointsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  job_id: ColumnType<string, string, never>;
  /** The completed step. Bounded, but NOT a closed DB set — steps belong to job kinds (the jobs.kind precedent). */
  step_name: ColumnType<string, string, never>;
  /** What the step produced for a later step. References, NEVER secrets (ADR-008 §11). */
  output: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null | undefined, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Tool registry (ACBP-P5-003a; CDR-051; TOOL-001). GLOBAL — no `company_id`, no RLS: a tool is platform
 * configuration, not tenant data. The app role holds SELECT ONLY, so every column is `never` on both insert and
 * update — nothing in the product runtime can register or reclassify a tool.
 */
export interface ToolDefinitionsTable {
  id: ColumnType<string, never, never>;
  tool_id: ColumnType<string, never, never>;
  version: ColumnType<number, never, never>;
  /** NULLABLE on purpose — TOOL-001's "unclassified" must be representable (CDR-051 §4). */
  risk_class: ColumnType<string | null, never, never>;
  description: ColumnType<string, never, never>;
  status: ColumnType<string, never, never>;
  created_at: ColumnType<Date, never, never>;
}

/**
 * Task runs (ACBP-P5-002; CDR-053; TASK-007). ONE EXECUTION ATTEMPT of a task — hence `attempt` in its identity.
 * Company-owned, dual-keyed FORCE RLS. The app role may advance the lifecycle columns only: identity, tenancy, task
 * linkage and attempt number are `never` on update, so a run cannot be re-pointed or renumbered after the fact.
 */
export interface TaskRunsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  task_id: ColumnType<string, string, never>;
  attempt: ColumnType<number, number, never>;
  state: ColumnType<string, string | undefined, string>;
  /** CLOSED category, never worker exception text. Only meaningful on a failed run (enforced by CHECK). */
  failure_category: ColumnType<string | null, never, string | null>;
  started_at: ColumnType<Date | null, never, Date | string | null>;
  /** Liveness: a timestamp the worker advances (CDR-053 §3-G4). */
  last_heartbeat_at: ColumnType<Date | null, never, Date | string | null>;
  /** Durable safe-stop request, so a returning worker still sees it. */
  stop_requested_at: ColumnType<Date | null, never, Date | string | null>;
  ended_at: ColumnType<Date | null, never, Date | string | null>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}
/**
 * Tool calls (ACBP-P5-003b; CDR-054; TOOL-002/003). The 100%-coverage surface of the enforcement chokepoint —
 * REFUSED calls have rows here too, because TOOL-001 requires the attempt to be audited.
 *
 * `tool_id` is text with NO foreign key on purpose: the commonest refusal is a tool that is not registered, and an FK
 * would make the record that refusal requires impossible to write. `risk_class` and `external_effect` are SNAPSHOTS
 * of the gate that was actually applied — re-reading the registry later would misreport a past call.
 */
export interface ToolCallsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  run_id: ColumnType<string, string, never>;
  tool_id: ColumnType<string, string, never>;
  /** Which REGISTERED version was in force. NULL only when the tool was not registered at all. */
  tool_version: ColumnType<number | null, number | null | undefined, never>;
  risk_class: ColumnType<string, string, never>;
  external_effect: ColumnType<boolean, boolean | undefined, never>;
  outcome: ColumnType<string, string | undefined, string>;
  /** CLOSED reason, never engine exception text. Only meaningful on a denied call (enforced by CHECK). */
  denial_reason: ColumnType<string | null, string | null | undefined, string | null>;
  /** sha256 hex of a canonical encoding. NEVER the arguments. Immutable after insert. */
  arguments_digest: ColumnType<string, string, never>;
  idempotency_key: ColumnType<string | null, string | null | undefined, never>;
  receipt_ref: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}
/**
 * Worker definitions (ACBP-P5-004; CDR-056; WORK-001; ADR-012). GLOBAL platform configuration, versioned
 * `(worker_id, version)` — workers are "versioned configuration + prompts over one shared execution runtime", not
 * services. No tenancy and no RLS; the app role holds SELECT only, so an allowlist is a control rather than a
 * suggestion. Every column is `never` on insert and update for the same reason.
 */
export interface WorkerDefinitionsTable {
  id: ColumnType<string, never, never>;
  worker_id: ColumnType<string, never, never>;
  version: ColumnType<number, never, never>;
  capabilities: ColumnType<string[], never, never>;
  /** THE allowlist (WORK-005; invariant 4). Its home. */
  allowed_tools: ColumnType<string[], never, never>;
  input_schema_ref: ColumnType<string, never, never>;
  output_schema_ref: ColumnType<string, never, never>;
  /** Integer micro-units, matching usage_events. IOQ-12 interim values (CDR-056 section 3). */
  max_spend_micros: ColumnType<number, never, never>;
  max_duration_ms: ColumnType<number, never, never>;
  retry_categories: ColumnType<string[], never, never>;
  /** NULL = nothing this worker does is approval-gated. Otherwise the LEAST class that requires approval. */
  approval_threshold_risk_class: ColumnType<string | null, never, never>;
  model_task_class: ColumnType<string, never, never>;
  logging_redaction_class: ColumnType<string, never, never>;
  status: ColumnType<string, never, never>;
  created_at: ColumnType<Date, never, never>;
}

/**
 * Per-company worker state (ACBP-P5-004; CDR-056; WORK-006). Company-owned, dual-keyed FORCE RLS: the platform says
 * what a worker IS, the company owner says whether it may run HERE. Keyed on `worker_id` WITHOUT a version — an
 * owner pauses "the research worker", and pinning to a version would un-pause it the moment a new one was registered.
 */
export interface CompanyWorkerStatesTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  worker_id: ColumnType<string, string, never>;
  state: ColumnType<string, string | undefined, string>;
  reason: ColumnType<string | null, string | null | undefined, string | null>;
  changed_by_user_id: ColumnType<string, string, string>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}
/**
 * Worker runs (ACBP-P5-005; CDR-057; WORK-001..006; NFR-015). THE STAMP linking a task run to the worker executing
 * it — the link `CDR-056 section 6` recorded as missing, in canon's own shape (a Task run HAS a Worker run).
 * Company-owned, dual-keyed FORCE RLS. The stamp and the snapshot bounds are `never` on update: a run cannot be
 * re-attributed to a different worker, nor judged against a budget it was not given.
 */
export interface WorkerRunsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  task_run_id: ColumnType<string, string, never>;
  worker_id: ColumnType<string, string, never>;
  worker_version: ColumnType<number, number, never>;
  /** SNAPSHOT at start. Re-reading the definition would change the budget a run is judged against mid-flight. */
  max_spend_micros: ColumnType<number, number, never>;
  max_duration_ms: ColumnType<number, number, never>;
  /** The ENFORCEMENT counters. Not a reconciliation source — the ledger link is P5-014's (CDR-057 section 4). */
  spend_micros: ColumnType<number, number | undefined, number>;
  steps_completed: ColumnType<number, number | undefined, number>;
  outcome: ColumnType<string, string | undefined, string>;
  failure_category: ColumnType<string | null, never, string | null>;
  halt_reason: ColumnType<string | null, never, string | null>;
  started_at: ColumnType<Date, Date | string | undefined, never>;
  ended_at: ColumnType<Date | null, never, Date | string | null>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}
/**
 * Artifacts (ACBP-P5-011; CDR-060; TASK-005; NFR-014). THE METADATA ROW IS THE ARTIFACT: an object no row points at
 * is unreachable garbage, and a row pointing at an object that was never written is the hollow success TASK-005
 * forbids. Company-owned, dual-keyed FORCE RLS.
 *
 * EVERY COLUMN IS `never` ON UPDATE, because the table has no UPDATE grant at all — not even column-level. The row
 * records which run, worker and model produced a document, and that is what P5-012's revision workflow reads to know
 * what it is revising. A superseded artifact is a NEW row.
 */
export interface ArtifactsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  /** DERIVED from the company prefix + the content hash, never caller-supplied (CDR-060 G2). */
  object_key: ColumnType<string, string, never>;
  content_hash: ColumnType<string, string, never>;
  format: ColumnType<string, string, never>;
  size_bytes: ColumnType<number, number, never>;
  /** PROVENANCE, all NOT NULL (CDR-060 G6). "Unknown provenance" is not a state this table can represent. */
  run_id: ColumnType<string, string, never>;
  worker_id: ColumnType<string, string, never>;
  worker_version: ColumnType<number, number, never>;
  model_version: ColumnType<string, string, never>;
  title: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Artifact revisions (ACBP-P5-012; CDR-064; TASK-005 lineage; J-13). A request for NEW work, never an edit — which is
 * why nothing here writes to `artifacts`, and why every column is `never` on update: the table has no UPDATE grant.
 *
 * THIS ROW IS THE LINEAGE. An artifact is a revision of `original_artifact_id` because its own `run_id` equals the
 * `run_id` here. There is deliberately no `revision_of_artifact_id` column on `artifacts` (CDR-064 G1) — the same
 * fact in two places is a fact that can disagree.
 */
export interface ArtifactRevisionsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  company_id: ColumnType<string, string, never>;
  /** BOTH ENDS, both required. A request naming only one of them is not lineage. */
  original_artifact_id: ColumnType<string, string, never>;
  run_id: ColumnType<string, string, never>;
  /** The founder's instruction. Required: a revision with nothing to change is a re-run that still costs a credit. */
  guidance: ColumnType<string, string, never>;
  idempotency_key: ColumnType<string, string, never>;
  requested_by_user_id: ColumnType<string, string, never>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Credit transactions (ACBP-P5-014; CDR-058; BILL-002; invariant 10). APPEND-ONLY: every field is `never` on update,
 * because the table has no UPDATE grant at all. ACCOUNT-owned with COMPANY attribution — the balance is per account
 * (ADR-003) while each spend records which company burned it, so RLS keys on `account_id` alone.
 * There is NO balance column: canon says the balance is always DERIVED, and `credits` is SIGNED so the sum is it.
 */
export interface CreditTransactionsTable {
  id: ColumnType<string, string | undefined, never>;
  account_id: ColumnType<string, string, never>;
  /** Attribution, not isolation. NULL only for account-level grants. */
  company_id: ColumnType<string | null, string | null | undefined, never>;
  kind: ColumnType<string, string, never>;
  /** SIGNED whole credits: grants and releases positive, reservations and consumptions negative. */
  credits: ColumnType<number, number, never>;
  run_id: ColumnType<string | null, string | null | undefined, never>;
  references_txn_id: ColumnType<string | null, string | null | undefined, never>;
  idempotency_key: ColumnType<string | null, string | null | undefined, never>;
  created_by_user_id: ColumnType<string | null, string | null | undefined, never>;
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
  understanding_item_reviews: UnderstandingItemReviewsTable;
  understanding_confirmation_events: UnderstandingConfirmationEventsTable;
  tasks: TasksTable;
  task_dependencies: TaskDependenciesTable;
  strategy_generations: StrategyGenerationsTable;
  strategy_options: StrategyOptionsTable;
  strategy_recommendations: StrategyRecommendationsTable;
  strategy_selections: StrategySelectionsTable;
  decisions: DecisionsTable;
  roadmaps: RoadmapsTable;
  goals: GoalsTable;
  milestones: MilestonesTable;
  task_review_flags: TaskReviewFlagsTable;
  planning_runs: PlanningRunsTable;
  planning_run_inputs: PlanningRunInputsTable;
  task_deletions: TaskDeletionsTable;
  jobs: JobsTable;
  job_checkpoints: JobCheckpointsTable;
  tool_definitions: ToolDefinitionsTable;
  task_runs: TaskRunsTable;
  tool_calls: ToolCallsTable;
  worker_definitions: WorkerDefinitionsTable;
  company_worker_states: CompanyWorkerStatesTable;
  worker_runs: WorkerRunsTable;
  artifacts: ArtifactsTable;
  artifact_revisions: ArtifactRevisionsTable;
  credit_transactions: CreditTransactionsTable;
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
export type UnderstandingItemReviewRow = Selectable<UnderstandingItemReviewsTable>;
export type NewUnderstandingItemReview = Insertable<UnderstandingItemReviewsTable>;
export type UnderstandingConfirmationEventRow = Selectable<UnderstandingConfirmationEventsTable>;
export type NewUnderstandingConfirmationEvent = Insertable<UnderstandingConfirmationEventsTable>;
export type TaskRow = Selectable<TasksTable>;
export type NewTask = Insertable<TasksTable>;
export type TaskUpdate = Updateable<TasksTable>;
export type TaskDependencyRow = Selectable<TaskDependenciesTable>;
export type NewTaskDependency = Insertable<TaskDependenciesTable>;
export type StrategyGenerationRow = Selectable<StrategyGenerationsTable>;
export type NewStrategyGeneration = Insertable<StrategyGenerationsTable>;
export type StrategyOptionRow = Selectable<StrategyOptionsTable>;
export type NewStrategyOption = Insertable<StrategyOptionsTable>;
export type StrategyRecommendationRow = Selectable<StrategyRecommendationsTable>;
export type NewStrategyRecommendation = Insertable<StrategyRecommendationsTable>;
export type StrategySelectionRow = Selectable<StrategySelectionsTable>;
export type NewStrategySelection = Insertable<StrategySelectionsTable>;
export type DecisionRow = Selectable<DecisionsTable>;
export type NewDecision = Insertable<DecisionsTable>;
export type RoadmapRow = Selectable<RoadmapsTable>;
export type NewRoadmap = Insertable<RoadmapsTable>;
export type GoalRow = Selectable<GoalsTable>;
export type NewGoal = Insertable<GoalsTable>;
export type MilestoneRow = Selectable<MilestonesTable>;
export type NewMilestone = Insertable<MilestonesTable>;
export type TaskReviewFlagRow = Selectable<TaskReviewFlagsTable>;
export type NewTaskReviewFlag = Insertable<TaskReviewFlagsTable>;
export type PlanningRunRow = Selectable<PlanningRunsTable>;
export type NewPlanningRun = Insertable<PlanningRunsTable>;
export type PlanningRunInputRow = Selectable<PlanningRunInputsTable>;
export type NewPlanningRunInput = Insertable<PlanningRunInputsTable>;
export type JobRow = Selectable<JobsTable>;
export type JobCheckpointRow = Selectable<JobCheckpointsTable>;
export type NewJobCheckpoint = Insertable<JobCheckpointsTable>;
export type NewJob = Insertable<JobsTable>;
export type TaskDeletionRow = Selectable<TaskDeletionsTable>;
export type ToolDefinitionRow = Selectable<ToolDefinitionsTable>;
export type TaskRunRow = Selectable<TaskRunsTable>;
export type ToolCallRow = Selectable<ToolCallsTable>;
export type WorkerDefinitionRow = Selectable<WorkerDefinitionsTable>;
export type CompanyWorkerStateRow = Selectable<CompanyWorkerStatesTable>;
export type WorkerRunRow = Selectable<WorkerRunsTable>;
export type ArtifactRow = Selectable<ArtifactsTable>;
export type ArtifactRevisionRow = Selectable<ArtifactRevisionsTable>;
export type NewArtifactRevision = Insertable<ArtifactRevisionsTable>;
export type NewArtifact = Insertable<ArtifactsTable>;
export type CreditTransactionRow = Selectable<CreditTransactionsTable>;
export type NewTaskDeletion = Insertable<TaskDeletionsTable>;
