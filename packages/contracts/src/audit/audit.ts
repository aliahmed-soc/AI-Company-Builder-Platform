// @acbp/contracts — provider-neutral audit event contract (ACBP-P1-008; ADR-015; EVENT-CATALOG envelope;
// CDR-014 Option A). The transport- and provider-neutral currency for the append-only audit store.
//
// This module defines WHAT a durable audit event is, not how it is written. It is a distinct system from
// operational logging (@acbp/observability): audit events are typed, registered, bounded, and destined for an
// append-only, immutable store (invariant 11). Zero-dependency like the rest of @acbp/contracts.
//
// Forgery resistance: a caller may only describe an event's NAME, SUBJECT, OUTCOME, and BOUNDED METADATA via a
// typed factory. The account, actor, event id, and timestamp are bound SERVER-SIDE by the writer from the
// caller's validated AccountScope — never accepted here — so they cannot be forged through this contract.
import { validationError } from '../errors.js';
import type { CompanyCreationMode } from '../company/company.js';

/** Actor types (EVENT-CATALOG `actor.type`). `worker` actors can never appear on approval decisions (inv. 5). */
export type AuditActorType = 'user' | 'worker' | 'system' | 'admin';
export const AUDIT_ACTOR_TYPES: readonly AuditActorType[] = ['user', 'worker', 'system', 'admin'];
export function isAuditActorType(v: unknown): v is AuditActorType {
  return typeof v === 'string' && (AUDIT_ACTOR_TYPES as readonly string[]).includes(v);
}

/** Bounded outcome codes (not free text). */
export type AuditOutcome = 'success' | 'denied' | 'blocked';
export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['success', 'denied', 'blocked'];

/**
 * The CLOSED registry of durable audit event names (dot-namespaced, past tense) with the current schema
 * version per name. Anything not registered here is REJECTED (deny unregistered event types). CDR-014 Option A
 * persists exactly the two account-scoped high-risk lifecycle successes for the P1-008 first cut; more names
 * are added deliberately as later tickets migrate events.
 */
export const AUDIT_EVENTS = {
  'membership.invited': { schemaVersion: 1, subjectType: 'membership' },
  'membership.revoked': { schemaVersion: 1, subjectType: 'membership' },
  // Company lifecycle (ACBP-P1-010; CDR-015 §5) — exactly four durable company events. Company-scoped:
  // the writer stamps `company_id` from the CompanyScope (never caller-supplied).
  'company.created': { schemaVersion: 1, subjectType: 'company' },
  'company.updated': { schemaVersion: 1, subjectType: 'company' },
  'company.paused': { schemaVersion: 1, subjectType: 'company' },
  'company.resumed': { schemaVersion: 1, subjectType: 'company' },
  // Workspace provisioning (ACBP-P1-012; CDR-018 §8) — exactly six durable, company-scoped, AUDIT-ONLY events.
  // NONE of these are projectable into the activity feed (the P1-009 four-event taxonomy stays closed): the
  // projector's `isProjectableActivity` allowlist excludes them by construction. Subject is the company id.
  'provisioning.started': { schemaVersion: 1, subjectType: 'company' },
  'provisioning.step_started': { schemaVersion: 1, subjectType: 'company' },
  'provisioning.step_completed': { schemaVersion: 1, subjectType: 'company' },
  'provisioning.step_failed': { schemaVersion: 1, subjectType: 'company' },
  'provisioning.retry_requested': { schemaVersion: 1, subjectType: 'company' },
  'provisioning.completed': { schemaVersion: 1, subjectType: 'company' },
  // Platform-administrative access (ACBP-P1-013; CDR-019 §7) — exactly ONE audit-only admin event. Scoped to the
  // TARGET tenant (account+company stamped from the admin path's transaction-local target scope) so the access
  // is visible in that tenant's own audit trail (SECURITY §3 tenant visibility); actor_type='admin' with the
  // REAL administrator's internal user id. Never activity-projected.
  'admin.tenant_read': { schemaVersion: 1, subjectType: 'company' },
  // Interview session lifecycle (ACBP-P2-001; CDR-022 §4) — exactly ONE durable, company-scoped event: the
  // session was started (not_started→in_progress). Subject is the SESSION id (EVENT-CATALOG payload `session_id`);
  // the writer stamps `company_id`/`account_id` from the caller's CompanyScope. AUDIT-ONLY here — the EVENT-CATALOG
  // activity fan-out is DEFERRED (CDR-022 §4) so P1-009's closed activity taxonomy is not expanded in a
  // persistence slice. `interview.question_answered` (EVENT-CATALOG:48) is a P2-002 concern and is NOT registered.
  'interview.started': { schemaVersion: 1, subjectType: 'interview_session' },
  // Typed memory (ACBP-P2-006; CDR-024 §4) — a memory item was created. AUDITED (MEM-003 "All changes audited"),
  // written in the same transaction as the insert. Subject = the memory item id; metadata carries only the
  // bounded {item_type, source_type} references — never the content or the raw source_ref value.
  'memory.item_created': { schemaVersion: 1, subjectType: 'memory_item' },
  // Memory browser (ACBP-P2-010; CDR-025 §4) — an item was superseded by a corrected version (the OLD item is
  // the subject; the forward pointer now targets the new version). AUDITED in-tx (a lifecycle transition,
  // ADR-015). Metadata carries only the bounded {item_type, source_type} of the new version — never content.
  'memory.item_superseded': { schemaVersion: 1, subjectType: 'memory_item' },
  // Memory browser (ACBP-P2-010; CDR-025 §0 owner decision) — an item was SOFT-deleted. AUDITED in-tx.
  // Subject = the deleted item. Metadata = the bounded {item_type, source_type, transition:'active_to_deleted'}
  // — never content, never the raw source_ref.
  'memory.item_deleted': { schemaVersion: 1, subjectType: 'memory_item' },
  // Understanding generation (ACBP-P2-008; CDR-029 §6; UNDER-001) — a classified understanding document version was
  // generated. AUDITED in-tx with the persist (audit-or-nothing). Subject = the document id; metadata carries only
  // the bounded {version, status, item_count} — never the generated content.
  'understanding.generated': { schemaVersion: 1, subjectType: 'understanding_document' },
  // Understanding review (ACBP-P2-009; CDR-030 §6; UNDER-003 "Item decisions audited") — an owner recorded one of the
  // five review controls on an item. AUDITED in-tx with the decision row. Subject = the reviewed item id; metadata is
  // the bounded {decision, version} — never the item content, the edited text, or a reject reason.
  'understanding.item_reviewed': { schemaVersion: 1, subjectType: 'understanding_item' },
  // Understanding confirmation (ACBP-P2-009; CDR-030 §3; EVENT-CATALOG:60; WORKFLOW §2) — the owner confirmed a version
  // (ready_for_review→confirmed; strategy unlocked). AUDITED in-tx (a high-risk lifecycle transition, ADR-015). Subject
  // = the document id; metadata is the bounded {version} — the confirming actor is the server-stamped audit actor.
  'understanding.confirmed': { schemaVersion: 1, subjectType: 'understanding_document' },
  // Understanding correction (ACBP-P2-009; CDR-030 §4; EVENT-CATALOG:56; DISC-008) — a material correction superseded a
  // confirmation (confirmed→superseded; dependents flagged). AUDITED in-tx (ADR-015). Subject = the document id;
  // metadata is the bounded {version, correction_ref, dependents_flagged} — correction_ref is a reference/short code
  // (never content), dependents_flagged is the count of downstream stages invalidated.
  'understanding.corrected': { schemaVersion: 1, subjectType: 'understanding_document' },
  // Context assembly (ACBP-P2-007; CDR-032 §3; MEM-004) — a same-subject conflict (a confirmed user item and an AI
  // assumption on one source_ref) was flagged during context assembly; both items were HELD OUT of the model context
  // and surfaced as an open question (never silently rank-resolved). AUDITED (BACKLOG P2-007 "Conflict events audited").
  // Subject = the confirmed item id; metadata is the bounded {confirmed_count, assumption_count} — never content or the
  // source_ref value. Outcome `blocked` (the items were withheld from context).
  'context.conflict_flagged': { schemaVersion: 1, subjectType: 'memory_item' },
  // Task lifecycle (ACBP-P4-002; CDR-033 §4; TASK-001; WORKFLOW §4) — a task appeared on the board (draft→planned).
  // AUDITED in-tx (ADR-015). Subject = the task id; metadata is the bounded {has_milestone} — never the title or
  // description. The other task.* transition events (queued/started/completed/failed/cancelled/waiting_*) are
  // registered by the P5/P6 tickets that implement their transitions.
  'task.created': { schemaVersion: 1, subjectType: 'task' },
  // Strategy option generation (ACBP-P3-001; CDR-034 §4; STRAT-001/002) — a set of strategy options was generated
  // from a CONFIRMED understanding version. AUDITED in-tx (ADR-015). Subject = the generation id; metadata is the
  // bounded {understanding_version, option_count, similarity_check_result} — NEVER option content/fields/reason text.
  // The other strategy.* events (strategy.selected, decision.recorded) are registered by the P3-004/005 tickets.
  'strategy.generated': { schemaVersion: 1, subjectType: 'strategy_generation' },
  // Immutable decision record (ACBP-P3-005; CDR-038 §4; STRAT-006) — a durable, audit-grade record of the owner's
  // decision, linking the understanding version + the options considered + the selection. AUDITED in-tx (ADR-015 —
  // "failed record writes block the transition"). Subject = the decision id; bounded metadata
  // {understanding_version, options_considered_count, mode} — NEVER option content, chosen fields, reject reasons, or
  // the rationale text. Recording a decision unlocks NO planning (that gate is P4-001).
  'decision.recorded': { schemaVersion: 1, subjectType: 'decision' },
  // Roadmap generation (ACBP-P4-001; CDR-039 §5; ROAD-001) — goals + sequenced milestones were planned from the
  // DECIDED strategy. AUDITED in-tx (ADR-015). Subject = the roadmap version id; bounded metadata
  // {roadmap_version, goal_count, milestone_count, status, model_flagged_partial} — NEVER titles, descriptions, or any
  // plan content. EVENT-CATALOG's `task_ids[]` cannot be metadata (arrays are forbidden) and P4-001 plans no tasks.
  'roadmap.generated': { schemaVersion: 1, subjectType: 'roadmap' },
  // Roadmap edit (ACBP-P4-001; CDR-039 §7-G2; ROAD-002 "Versions audited") — an OWNER authored a new roadmap version.
  // AUDITED in-tx with the version row + its affected-task flags, so a version-write failure blocks the edit rather
  // than losing history. Subject = the NEW version id; bounded metadata {roadmap_version, supersedes_version,
  // affected_task_count, has_reason} — NEVER the reason text, titles, or descriptions.
  'roadmap.edited': { schemaVersion: 1, subjectType: 'roadmap' },
  // Planning transparency (ACBP-P4-006; CDR-041 §3-G6; PLAN-004) — a planning run happened, and its inputs are
  // linked. AUDITED in-tx with the run row, its input links and the task drafts (ADR-015). Subject = the run id;
  // bounded metadata {mode, outcome, task_count, tasks_missing_rationale, memory_items_considered,
  // milestones_in_scope} — NEVER rationale text, task titles, or any memory content.
  //
  // The event's OUTCOME is `success` even for a run whose generation failed: the audited operation is *recording the
  // run*, which succeeded, and the run's own result is the `outcome` metadata scalar. This follows `strategy.selected`,
  // which records a `reject` mode as metadata rather than as a non-success audit outcome. Reserving `denied`/`blocked`
  // for authorization and policy keeps them meaningful.
  //
  // This does NOT contradict CDR-040 §7 (planning writes no event): that rule holds because a DRAFT TASK is not on the
  // board. A planning RUN is a platform action taken on the owner's behalf — precisely what ADR-015 audits.
  'planning.run_recorded': { schemaVersion: 1, subjectType: 'planning_run' },
  // Task repeat (ACBP-P4-005; CDR-043 §4-G4; TASK-008 "repeated (re-queued as a new task)"). AUDITED in-tx with the
  // NEW task row. Subject = the NEW task id; bounded metadata {source_task_id, source_state} — never titles or
  // descriptions. A repeat is a new row, never a state rewind, so the original's history stays intact.
  'task.repeated': { schemaVersion: 1, subjectType: 'task' },
  // Task delete (ACBP-P4-005; CDR-043 §4-G1; TASK-008 "delete requires confirmation and is audited"). AUDITED in-tx
  // with the append-only `task_deletions` record. Subject = the deleted task id; bounded metadata
  // {state_at_delete, has_reason} — never the reason text. `tasks` has NO DELETE grant: the row survives and reads
  // exclude it, so "deleted" is a recorded fact rather than an erasure that would destroy this very audit trail.
  'task.deleted': { schemaVersion: 1, subjectType: 'task' },
  // Owner strategy decision (ACBP-P3-004; CDR-037 §4; STRAT-003/005) — the owner selected/edited/combined/rejected a
  // generation's options (with an optional phase-scope flag). AUDITED in-tx (ADR-015). Subject = the selection id;
  // bounded metadata {mode, phase_scope?} — NEVER option content / chosen fields / reject reasons. The immutable
  // Decision record (decision.recorded, STRAT-006) is P3-005's separate event.
  'strategy.selected': { schemaVersion: 1, subjectType: 'strategy_selection' },
  // Durable job enqueue (ACBP-P5-001a; CDR-049 §4; ADR-008 "Run trail audited"). AUDITED in-tx with the `jobs` row
  // (ADR-015 audit-or-nothing), so a job cannot exist without the record of who scheduled it. Subject = the job id;
  // bounded metadata {kind, deduplicated} — NEVER the payload, which carries references chosen by the caller and is
  // not a reviewed surface. `deduplicated` records that an idempotency key matched an existing job, which is the one
  // enqueue outcome that produces no new row and would otherwise be invisible in the trail.
  'job.enqueued': { schemaVersion: 1, subjectType: 'job' },
  // Dead-letter (ACBP-P5-001c; CDR-052; NFR-007). AUDITED in-tx with the terminal transition: a job that stopped
  // retrying and vanished from the run trail is exactly the case someone needs explained. Bounded metadata
  // {kind, attempts, reason} - the reason is a CLOSED category, never provider exception text, and never the payload.
  // Task runs (ACBP-P5-002; CDR-053; EVENT-CATALOG). Three RUN-DRIVEN task transitions, audited in-tx with the run
  // state change ("Transitions audited"). 	ask.completed is DELIBERATELY NOT here: canon requires artifact_refs[]
  // on it ("no artifactless completion", TASK-005), and a run succeeding is not the same fact as a task completing -
  // the task completes when its artifact is persisted, which belongs to the ticket that owns artifacts.
  'task.started': { schemaVersion: 1, subjectType: 'task' },
  'task.failed': { schemaVersion: 1, subjectType: 'task' },
  'task.cancelled': { schemaVersion: 1, subjectType: 'task' },
  'job.dead_lettered': { schemaVersion: 1, subjectType: 'job' },
  // Tool calls (ACBP-P5-003b; CDR-054; TOOL-002 "100% of tool calls have records"). The subject is the CALL, not the
  // task: a reader asking "what did the chokepoint decide about this call" wants one row per call, and the run and
  // task reach it through the `tool_calls` row. `tool.call_started` is NOT registered — nothing executes tools yet
  // (P5-005 owns the worker runtime), so registering it would declare an event no code can emit.
  'tool.call_requested': { schemaVersion: 1, subjectType: 'tool_call' },
  'tool.call_completed': { schemaVersion: 1, subjectType: 'tool_call' },
  'tool.call_failed': { schemaVersion: 1, subjectType: 'tool_call' },
  // Worker pause/disable per company (ACBP-P5-004; CDR-056; WORK-006 'Definition changes audited'). Subject = the
  // WORKER id: an owner asking 'who turned research off and when' wants one thread per worker, not per company.
  'worker.state_changed': { schemaVersion: 1, subjectType: 'worker' },
} as const;

export type AuditEventName = keyof typeof AUDIT_EVENTS;
export function isAuditEventName(v: unknown): v is AuditEventName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, v);
}

/** Bounded metadata: a flat map of scalars only. NO nesting, arrays, Error objects, secrets, or PII. */
export type AuditMetadata = Readonly<Record<string, string | number | boolean>>;

// Metadata bounds (references/digests only — EVENT-CATALOG `:18`). Deliberately tight. The per-value length is
// measured in UTF-16 units and sized at 1024 so the canonically-mandated VERBATIM admin reason (ACBP-P1-013;
// CDR-019 §4: ≤512 UNICODE CODE POINTS, which is up to 1024 UTF-16 units when astral characters are used) can
// never be rejected at write time after passing its own strict validation. Every other producer stays far below.
const META_MAX_KEYS = 16;
const META_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const META_MAX_VALUE_LEN = 1024;
const META_MAX_TOTAL_BYTES = 4096;

/**
 * Validate + freeze caller metadata into bounded {@link AuditMetadata}. Rejects unknown value types (null,
 * undefined, objects, arrays, functions, symbols, bigint), non-finite numbers, over-long/mis-shaped keys,
 * over-long string values, too many keys, or an over-large serialized total. Throws a validation PlatformError
 * carrying only the offending KEY NAME (never the value). The audit writer must persist nothing that fails here.
 */
export function boundedMetadata(input: Readonly<Record<string, unknown>>): AuditMetadata {
  const keys = Object.keys(input);
  if (keys.length > META_MAX_KEYS) {
    throw validationError({ message: 'Audit metadata has too many keys.', fields: ['metadata'] });
  }
  const out: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    if (!META_KEY_RE.test(key)) {
      throw validationError({ message: 'Audit metadata key is invalid.', fields: [`metadata.${key}`] });
    }
    const value = input[key];
    if (typeof value === 'string') {
      if (value.length > META_MAX_VALUE_LEN) throw validationError({ message: 'Audit metadata value is too long.', fields: [`metadata.${key}`] });
      out[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw validationError({ message: 'Audit metadata number is not finite.', fields: [`metadata.${key}`] });
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else {
      // null, undefined, object, array, function, symbol, bigint — all rejected (no nesting, no Error objects).
      throw validationError({ message: 'Audit metadata value type is not allowed.', fields: [`metadata.${key}`] });
    }
  }
  if (JSON.stringify(out).length > META_MAX_TOTAL_BYTES) {
    throw validationError({ message: 'Audit metadata is too large.', fields: ['metadata'] });
  }
  return Object.freeze(out);
}

/** A subject identifier (bounded). `id` is an opaque internal id; `type` is a short registered noun. */
const SUBJECT_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SUBJECT_ID_MAX = 64;

/**
 * The caller-facing description of an event to record. Deliberately EXCLUDES account id, actor, event id, and
 * timestamp — those are bound server-side by the writer from the validated AccountScope (unforgeable).
 */
export interface AuditEvent {
  readonly name: AuditEventName;
  readonly schemaVersion: number;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: AuditOutcome;
  readonly metadata: AuditMetadata;
}

function makeEvent(name: AuditEventName, subjectId: string, outcome: AuditOutcome, metadata: Readonly<Record<string, unknown>>): AuditEvent {
  const spec = AUDIT_EVENTS[name];
  if (typeof subjectId !== 'string' || subjectId.length === 0 || subjectId.length > SUBJECT_ID_MAX) {
    throw validationError({ message: 'Audit subject id is invalid.', fields: ['subjectId'] });
  }
  if (!SUBJECT_TYPE_RE.test(spec.subjectType)) {
    throw validationError({ message: 'Audit subject type is invalid.', fields: ['subjectType'] });
  }
  return Object.freeze({ name, schemaVersion: spec.schemaVersion, subjectType: spec.subjectType, subjectId, outcome, metadata: boundedMetadata(metadata) });
}

// ── Typed event factories (the ONLY way to construct an AuditEvent — no free-form event objects) ────────────

/** A member was invited to an account (high-risk lifecycle transition; success). */
export function membershipInvited(input: { readonly membershipId: string; readonly role: 'owner' | 'viewer' }): AuditEvent {
  return makeEvent('membership.invited', input.membershipId, 'success', { role: input.role });
}

/** A membership was revoked (high-risk lifecycle transition; success). */
export function membershipRevoked(input: { readonly membershipId: string; readonly role: 'owner' | 'viewer' }): AuditEvent {
  return makeEvent('membership.revoked', input.membershipId, 'success', { role: input.role });
}

// ── Company lifecycle factories (ACBP-P1-010; CDR-015 §5). Subject is the company id; payloads carry only
//    bounded, non-PII references (creation mode, changed-field NAMES, optional coarse reason/count). ─────────

/** A company was created (subject = company id; success). */
export function companyCreated(input: { readonly companyId: string; readonly creationMode: CompanyCreationMode }): AuditEvent {
  return makeEvent('company.created', input.companyId, 'success', { creation_mode: input.creationMode });
}

/** A company profile/name was edited (success). Records the CHANGED FIELD NAMES only — never the values. */
export function companyUpdated(input: { readonly companyId: string; readonly changedFields: readonly string[] }): AuditEvent {
  // Metadata is a flat scalar map (no arrays), so the field NAMES are joined into a bounded string.
  return makeEvent('company.updated', input.companyId, 'success', { changed_fields: input.changedFields.join(',') });
}

/** A company was paused (success). Optional coarse, non-PII reason. */
export function companyPaused(input: { readonly companyId: string; readonly reason?: string }): AuditEvent {
  return makeEvent('company.paused', input.companyId, 'success', input.reason !== undefined ? { reason: input.reason } : {});
}

/** A company was resumed (success). Optional coarse reason + count of work items released on resume. */
export function companyResumed(input: { readonly companyId: string; readonly reason?: string; readonly heldWorkCount?: number }): AuditEvent {
  const metadata: Record<string, string | number> = {};
  if (input.reason !== undefined) metadata['reason'] = input.reason;
  if (input.heldWorkCount !== undefined) metadata['held_work_count'] = input.heldWorkCount;
  return makeEvent('company.resumed', input.companyId, 'success', metadata);
}

// ── Workspace-provisioning factories (ACBP-P1-012; CDR-018 §8). Subject is the company id. Metadata is the
//    EXACT per-event allowlist — bounded step/code identifiers and small integers only; never a raw exception,
//    SQL text, free-form reason, credential, or internal id. All AUDIT-ONLY (never activity-projected). ────────

/** Provisioning began for a company (seeded in the creation transaction, or first resume of a backfilled draft). */
export function provisioningStarted(input: { readonly companyId: string; readonly stepCount: number }): AuditEvent {
  return makeEvent('provisioning.started', input.companyId, 'success', { step_count: input.stepCount });
}

/** A provisioning step attempt began (recorded atomically with the attempt's committed outcome). */
export function provisioningStepStarted(input: { readonly companyId: string; readonly step: string; readonly attempt: number }): AuditEvent {
  return makeEvent('provisioning.step_started', input.companyId, 'success', { step: input.step, attempt: input.attempt });
}

/** A provisioning step completed with its closed result code. */
export function provisioningStepCompleted(input: { readonly companyId: string; readonly step: string; readonly attempt: number; readonly resultCode: string }): AuditEvent {
  return makeEvent('provisioning.step_completed', input.companyId, 'success', { step: input.step, attempt: input.attempt, result_code: input.resultCode });
}

/** A provisioning step failed with its closed failure code (controlled failure; the outcome is `blocked`). */
export function provisioningStepFailed(input: { readonly companyId: string; readonly step: string; readonly attempt: number; readonly failureCode: string }): AuditEvent {
  return makeEvent('provisioning.step_failed', input.companyId, 'blocked', { step: input.step, attempt: input.attempt, failure_code: input.failureCode });
}

/** An authenticated OWNER explicitly requested a resume of a failed step (the only user-actor provisioning event). */
export function provisioningRetryRequested(input: { readonly companyId: string; readonly step: string; readonly nextAttempt: number }): AuditEvent {
  return makeEvent('provisioning.retry_requested', input.companyId, 'success', { step: input.step, next_attempt: input.nextAttempt });
}

/** All six steps completed — recorded atomically with the onboarding→active transition. */
export function provisioningCompleted(input: { readonly companyId: string; readonly stepCount: number }): AuditEvent {
  return makeEvent('provisioning.completed', input.companyId, 'success', { step_count: input.stepCount });
}

// ── Platform-administrative access factory (ACBP-P1-013; CDR-019 §7). Subject = the TARGET company. ──────────

/**
 * An administrator read a tenant's company overview. Metadata is EXACTLY `{reason, scope}`: the reason is the
 * caller-validated VERBATIM string (strictly bounded upstream by `validateAdminReason` — ≤512 code points, no
 * NUL, non-empty; never trimmed/normalized), `scope` is the closed operation code. Never a route, IP,
 * user-agent, email, token, SQL, stack trace, or any other request field.
 */
export function adminTenantRead(input: { readonly companyId: string; readonly reason: string; readonly scope: string }): AuditEvent {
  return makeEvent('admin.tenant_read', input.companyId, 'success', { reason: input.reason, scope: input.scope });
}

// ── Interview session factory (ACBP-P2-001; CDR-022 §4). Subject = the session id. ───────────────────────────

/**
 * An interview session was started (not_started→in_progress; success). Subject is the SESSION id; the writer
 * stamps the owning company from the CompanyScope. Metadata is empty — the payload is the subject itself
 * (EVENT-CATALOG `session_id`), and no PII or free text is ever attached.
 */
export function interviewStarted(input: { readonly sessionId: string }): AuditEvent {
  return makeEvent('interview.started', input.sessionId, 'success', {});
}

// ── Typed memory factory (ACBP-P2-006; CDR-024 §4). Subject = the memory item id. ────────────────────────────

/**
 * A typed memory item was created. Metadata is EXACTLY `{item_type, source_type}` — bounded provenance
 * references only; NEVER the memory content or the raw source_ref value (data minimization). Written in the
 * same transaction as the item insert.
 */
export function memoryItemCreated(input: { readonly memoryItemId: string; readonly itemType: string; readonly sourceType: string }): AuditEvent {
  return makeEvent('memory.item_created', input.memoryItemId, 'success', { item_type: input.itemType, source_type: input.sourceType });
}

/**
 * `understanding.generated` (ACBP-P2-008; CDR-029). Subject = the understanding document id; metadata is the
 * bounded {version, status, item_count} — never the generated content. Written in the same transaction as the
 * document+items insert (audit-or-nothing).
 */
export function understandingGenerated(input: { readonly documentId: string; readonly version: number; readonly status: string; readonly itemCount: number }): AuditEvent {
  return makeEvent('understanding.generated', input.documentId, 'success', { version: input.version, status: input.status, item_count: input.itemCount });
}

/**
 * `understanding.item_reviewed` (ACBP-P2-009; CDR-030 §6; UNDER-003 "Item decisions audited"). Subject = the reviewed
 * understanding item id; metadata is the bounded `{decision, version}` — NEVER the item content, edited text, or reject
 * reason. Written in the same transaction as the review-decision row (audit-or-nothing).
 */
export function understandingItemReviewed(input: { readonly itemId: string; readonly decision: string; readonly version: number }): AuditEvent {
  return makeEvent('understanding.item_reviewed', input.itemId, 'success', { decision: input.decision, version: input.version });
}

/**
 * `understanding.confirmed` (ACBP-P2-009; CDR-030 §3; EVENT-CATALOG:60). Subject = the confirmed understanding document
 * id; metadata is the bounded `{version}`. The confirming user is the SERVER-STAMPED audit actor (not duplicated in
 * metadata). Written in the same transaction as the confirmation-event row (a high-risk lifecycle transition, ADR-015).
 */
export function understandingConfirmed(input: { readonly documentId: string; readonly version: number }): AuditEvent {
  return makeEvent('understanding.confirmed', input.documentId, 'success', { version: input.version });
}

/**
 * `understanding.corrected` (ACBP-P2-009; CDR-030 §4; EVENT-CATALOG:56; DISC-008). Subject = the corrected
 * understanding document id; metadata is the bounded `{version, correction_ref, dependents_flagged}` — `correction_ref`
 * is a reference/short code (never content), `dependents_flagged` is the count of downstream stages invalidated by the
 * supersession. Written in the same transaction as the correction-event row (ADR-015).
 */
export function understandingCorrected(input: { readonly documentId: string; readonly version: number; readonly correctionRef: string; readonly dependentsFlagged: number }): AuditEvent {
  return makeEvent('understanding.corrected', input.documentId, 'success', { version: input.version, correction_ref: input.correctionRef, dependents_flagged: input.dependentsFlagged });
}

/**
 * `context.conflict_flagged` (ACBP-P2-007; CDR-032 §3; MEM-004). A same-subject conflict (confirmed user item + AI
 * assumption on one `source_ref`) was flagged during context assembly and both items withheld from the model context.
 * Subject = the confirmed item id; metadata is the bounded `{confirmed_count, assumption_count}` — never content or the
 * raw source_ref. Outcome `blocked`.
 */
export function contextConflictFlagged(input: { readonly itemId: string; readonly confirmedCount: number; readonly assumptionCount: number }): AuditEvent {
  return makeEvent('context.conflict_flagged', input.itemId, 'blocked', { confirmed_count: input.confirmedCount, assumption_count: input.assumptionCount });
}

/**
 * `task.created` (ACBP-P4-002; CDR-033 §4; WORKFLOW §4). A task appeared on the board (`draft → planned`). Subject =
 * the task id; metadata is the bounded `{has_milestone}` — NEVER the title or description. Written in the same
 * transaction as the state transition (audit-or-nothing).
 */
export function taskCreated(input: { readonly taskId: string; readonly hasMilestone: boolean }): AuditEvent {
  return makeEvent('task.created', input.taskId, 'success', { has_milestone: input.hasMilestone });
}

/**
 * A set of strategy options was generated from a confirmed understanding version (ACBP-P3-001). Subject = the
 * generation id; metadata is the bounded `{understanding_version, option_count, similarity_check_result}` — NEVER
 * option content, fields, or the fewer-than-three reason text. Written in the same transaction as the generation.
 */
export function strategyGenerated(input: { readonly generationId: string; readonly understandingVersion: number; readonly optionCount: number; readonly similarityCheckResult: string }): AuditEvent {
  return makeEvent('strategy.generated', input.generationId, 'success', { understanding_version: input.understandingVersion, option_count: input.optionCount, similarity_check_result: input.similarityCheckResult });
}

/**
 * The owner made a strategy decision (ACBP-P3-004). Subject = the selection id; metadata is the bounded `{mode}` (+
 * `phase_scope` when set) — NEVER option content, chosen fields, or reject reasons. Written in the same transaction as
 * the selection insert (audit-or-nothing).
 */
export function strategySelected(input: { readonly selectionId: string; readonly mode: string; readonly phaseScope: string | null }): AuditEvent {
  return makeEvent('strategy.selected', input.selectionId, 'success', input.phaseScope !== null ? { mode: input.mode, phase_scope: input.phaseScope } : { mode: input.mode });
}

/**
 * An immutable decision record was written (ACBP-P3-005; STRAT-006). Subject = the DECISION id; metadata is the bounded
 * `{understanding_version, options_considered_count, mode}` — NEVER option content, chosen fields, reject reasons, or
 * the rationale text. Written in the same transaction as the decision insert: a failed write blocks the transition, so
 * a decision is never silently unrecorded (STRAT-006 failure mode; ADR-015).
 *
 * `options_considered_count` is a SCALAR count of the generation's options (audit metadata forbids arrays); the exact
 * set considered is recoverable from the decision's immutable `generation_id`.
 */
export function decisionRecorded(input: { readonly decisionId: string; readonly understandingVersion: number; readonly optionsConsideredCount: number; readonly mode: string }): AuditEvent {
  return makeEvent('decision.recorded', input.decisionId, 'success', { understanding_version: input.understandingVersion, options_considered_count: input.optionsConsideredCount, mode: input.mode });
}

/**
 * A roadmap version was planned from the decided strategy (ACBP-P4-001; ROAD-001). Subject = the roadmap version id;
 * metadata is the bounded `{roadmap_version, goal_count, milestone_count, status, model_flagged_partial}` — NEVER goal
 * or milestone titles/descriptions. Written in the same transaction as the version + its goals/milestones.
 */
export function roadmapGenerated(input: { readonly roadmapId: string; readonly roadmapVersion: number; readonly goalCount: number; readonly milestoneCount: number; readonly status: string; readonly modelFlaggedPartial: boolean }): AuditEvent {
  return makeEvent('roadmap.generated', input.roadmapId, 'success', { roadmap_version: input.roadmapVersion, goal_count: input.goalCount, milestone_count: input.milestoneCount, status: input.status, model_flagged_partial: input.modelFlaggedPartial });
}

/**
 * An owner authored a new roadmap version (ACBP-P4-001; ROAD-002). Subject = the NEW version's id; metadata is the
 * bounded `{roadmap_version, supersedes_version, affected_task_count, has_reason}` — NEVER the reason text or any plan
 * content. Written in the same transaction as the version + its affected-task flags: a failure blocks the edit rather
 * than losing history.
 */
export function roadmapEdited(input: { readonly roadmapId: string; readonly roadmapVersion: number; readonly supersedesVersion: number; readonly affectedTaskCount: number; readonly hasReason: boolean }): AuditEvent {
  return makeEvent('roadmap.edited', input.roadmapId, 'success', { roadmap_version: input.roadmapVersion, supersedes_version: input.supersedesVersion, affected_task_count: input.affectedTaskCount, has_reason: input.hasReason });
}

/**
 * A planning run was recorded with its input snapshot (ACBP-P4-006; PLAN-004). Subject = the planning run id.
 *
 * Metadata is scalars only (audit metadata forbids arrays): the exact inputs are recoverable through the run's
 * immutable `planning_run_inputs` rows, so the counts here are a summary, never the set. NEVER carries rationale text,
 * task titles, or memory content. `outcome` is the RUN's result — a failed generation is still a recorded run
 * (CDR-041 §3-G3), because a failed run is exactly the one an owner wants to inspect.
 */
export function planningRunRecorded(input: {
  readonly runId: string;
  readonly mode: string;
  readonly outcome: string;
  readonly taskCount: number;
  readonly tasksMissingRationale: number;
  readonly memoryItemsConsidered: number;
  readonly milestonesInScope: number;
}): AuditEvent {
  return makeEvent('planning.run_recorded', input.runId, 'success', {
    mode: input.mode,
    outcome: input.outcome,
    task_count: input.taskCount,
    tasks_missing_rationale: input.tasksMissingRationale,
    memory_items_considered: input.memoryItemsConsidered,
    milestones_in_scope: input.milestonesInScope,
  });
}

/**
 * A task was repeated — re-queued as a NEW task (ACBP-P4-005; TASK-008). Subject = the NEW task id, because that is
 * the row this event brought into existence; the source is metadata, so the lineage reads forward from either end.
 * Bounded scalars only — never the copied title or description.
 */
export function taskRepeated(input: { readonly newTaskId: string; readonly sourceTaskId: string; readonly sourceState: string }): AuditEvent {
  return makeEvent('task.repeated', input.newTaskId, 'success', { source_task_id: input.sourceTaskId, source_state: input.sourceState });
}

/**
 * A task was deleted (ACBP-P4-005; TASK-008 "delete requires confirmation and is audited"). Subject = the deleted
 * task id. `state_at_delete` records what the owner actually removed — a completed task and a queued one are very
 * different losses. `has_reason` is a boolean: the reason TEXT is owner-authored free text and never enters the audit
 * payload.
 */
export function taskDeleted(input: { readonly taskId: string; readonly stateAtDelete: string; readonly hasReason: boolean }): AuditEvent {
  return makeEvent('task.deleted', input.taskId, 'success', { state_at_delete: input.stateAtDelete, has_reason: input.hasReason });
}

/**
 * A durable job was enqueued (ACBP-P5-001a; CDR-049 §4). Subject = the job id.
 *
 * The tenant ids are deliberately NOT in the metadata: the audit row is itself account-scoped and written in the
 * caller's company scope, so repeating them would add nothing and invite the habit of copying tenancy into payloads,
 * where it can drift from the row it claims to describe.
 */
export function jobEnqueued(input: { readonly jobId: string; readonly kind: string; readonly deduplicated: boolean }): AuditEvent {
  return makeEvent('job.enqueued', input.jobId, 'success', { kind: input.kind, deduplicated: input.deduplicated });
}

/**
 * A run began (ACBP-P5-002). Subject = the TASK, per EVENT-CATALOG, with the run and attempt as metadata: a reader
 * asking "what happened to this task" wants one thread, not one per attempt.
 */
export function taskStarted(input: { readonly taskId: string; readonly runId: string; readonly attempt: number }): AuditEvent {
  return makeEvent('task.started', input.taskId, 'success', { run_id: input.runId, attempt: input.attempt });
}

/**
 * A run failed (ACBP-P5-002; TASK-006 "no blank failures" - which means a CATEGORY, never a stack trace).
 *
 * EVENT-CATALOG also lists `retry_state`; that is TASK-010 retry VISIBILITY, owned by ACBP-P5-013, and will arrive as
 * schema version 2 rather than being guessed at here.
 */
export function taskFailed(input: { readonly taskId: string; readonly runId: string; readonly attempt: number; readonly failureCategory: string }): AuditEvent {
  return makeEvent('task.failed', input.taskId, 'blocked', { run_id: input.runId, attempt: input.attempt, failure_category: input.failureCategory });
}

/**
 * A run was cancelled (ACBP-P5-002; TASK-007). phase is canon's own distinction - queued cancels instantly,
 * `running` is a bounded safe-stop - and it is the field that makes the two operations distinguishable after the
 * fact. EVENT-CATALOG lists cancelled_by; that is the SERVER-STAMPED audit actor, and copying it into the payload
 * would let the two disagree.
 */
export function taskCancelled(input: { readonly taskId: string; readonly runId: string; readonly phase: string }): AuditEvent {
  return makeEvent('task.cancelled', input.taskId, 'success', { run_id: input.runId, phase: input.phase });
}

/**
 * A tool call was PROPOSED at the chokepoint (ACBP-P5-003b; TOOL-002 "100% of tool calls have records").
 *
 * Emitted for REFUSALS as well as authorizations — TOOL-001's failure clause is "attempts are audited", and an
 * attempt that is turned away is exactly the attempt worth auditing. `outcome` carries the difference, so a reader
 * counting denials never has to parse metadata to find them. The arguments DIGEST is deliberately absent: it is on
 * the `tool_calls` row, and duplicating it here would put the same fact in two places that can disagree.
 */
export function toolCallRequested(input: {
  readonly callId: string;
  readonly toolId: string;
  /** Which registered version was in force. Null when the tool was not registered — canon pairs 	ool_id+version. */
  readonly toolVersion: number | null;
  readonly riskClass: string;
  readonly externalEffect: boolean;
  readonly denialReason?: string;
  /**
   * Which injection signals the untrusted context matched (ACBP-P5-003c). A comma-joined CLOSED vocabulary, never
   * the content — this is what a human reads when deciding whether to quarantine. Absent when there were none, so an
   * empty string never has to be read as either 'none matched' or 'not checked'.
   */
  readonly injectionSignals?: string;
}): AuditEvent {
  // `tool_version` is OMITTED when null rather than sent as null: audit metadata is scalars only, and an absent key
  // says "this tool had no registered version" exactly as well as a null would have — without breaking the bound.
  const base = {
    tool_id: input.toolId,
    risk_class: input.riskClass,
    external_effect: input.externalEffect,
    ...(input.toolVersion === null ? {} : { tool_version: input.toolVersion }),
    ...(input.injectionSignals === undefined || input.injectionSignals === '' ? {} : { injection_signals: input.injectionSignals }),
  };
  return input.denialReason === undefined
    ? makeEvent('tool.call_requested', input.callId, 'success', base)
    : makeEvent('tool.call_requested', input.callId, 'denied', { ...base, denial_reason: input.denialReason });
}

/**
 * A tool call reported its outcome (ACBP-P5-003b; TOOL-002).
 *
 * `has_receipt` is a BOOLEAN, not the receipt: whether an external effect could be evidenced is the auditable fact,
 * and the reference itself is on the row. `unconfirmed` is NOT a success — canon says a missing receipt marks the
 * call unconfirmed, "never 'succeeded'" — so only `succeeded` carries the success outcome here.
 */
export function toolCallCompleted(input: { readonly callId: string; readonly toolId: string; readonly riskClass: string; readonly callOutcome: string; readonly hasReceipt: boolean }): AuditEvent {
  const name = input.callOutcome === 'failed' ? 'tool.call_failed' : 'tool.call_completed';
  const outcome: AuditOutcome = input.callOutcome === 'succeeded' ? 'success' : 'blocked';
  return makeEvent(name, input.callId, outcome, { tool_id: input.toolId, risk_class: input.riskClass, call_outcome: input.callOutcome, has_receipt: input.hasReceipt });
}

/**
 * An owner paused, disabled or re-enabled a worker for their company (ACBP-P5-004; WORK-006).
 *
 * `has_reason` is a BOOLEAN, matching `task.deleted`: whether the owner explained themselves is useful, and the free
 * text they wrote is theirs and stays out of the audit payload entirely.
 */
export function workerStateChanged(input: { readonly workerId: string; readonly state: string; readonly hasReason: boolean }): AuditEvent {
  return makeEvent('worker.state_changed', input.workerId, 'success', { state: input.state, has_reason: input.hasReason });
}

/**
 * A durable job exhausted its retry cap and was dead-lettered (ACBP-P5-001c; NFR-007). Subject = the job id.
 * `attempts` is the count that was reached, so the record shows the cap was honoured rather than merely claimed.
 */
export function jobDeadLettered(input: { readonly jobId: string; readonly kind: string; readonly attempts: number; readonly reason: string }): AuditEvent {
  return makeEvent('job.dead_lettered', input.jobId, 'blocked', { kind: input.kind, attempts: input.attempts, reason: input.reason });
}

/**
 * A memory item was superseded by a corrected version (ACBP-P2-010). Subject = the SUPERSEDED (old) item id.
 * Metadata is EXACTLY `{item_type, source_type}` of the NEW version — bounded references only, never content.
 */
export function memoryItemSuperseded(input: { readonly supersededItemId: string; readonly newItemType: string; readonly newSourceType: string }): AuditEvent {
  return makeEvent('memory.item_superseded', input.supersededItemId, 'success', { item_type: input.newItemType, source_type: input.newSourceType });
}

/**
 * A memory item was SOFT-deleted (ACBP-P2-010; CDR-025 §0). Subject = the deleted item id. Metadata is EXACTLY
 * `{item_type, source_type, transition:'active_to_deleted'}` — bounded references only, never content or the raw
 * source_ref.
 */
export function memoryItemDeleted(input: { readonly memoryItemId: string; readonly itemType: string; readonly sourceType: string }): AuditEvent {
  return makeEvent('memory.item_deleted', input.memoryItemId, 'success', { item_type: input.itemType, source_type: input.sourceType, transition: 'active_to_deleted' });
}
