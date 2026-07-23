// @acbp/core — company lifecycle use cases (ACBP-P1-010; CDR-015). Slice 4: read, rename (profile edit),
// pause, resume. Every op runs under the caller's validated CompanyScope (runInCompanyScope) on the restricted
// role: the caller's ACTIVE company-membership role is resolved first, the ADR-022 role check gates the action
// (owner-only mutations; owner+viewer reads), the mutation runs RLS-confined to the company, and — for the
// two owner-driven status transitions and profile edits — the durable `company.*` audit is written in the SAME
// transaction (a write failure rolls the transition back). Status transitions are guarded by the legal-
// transition table (WORKFLOW §1) so an out-of-state pause/resume is rejected, not silently applied.
import { CompanyRepository, CompanyProfileRepository, writeAuditEvent, projectCompanyActivity, type DatabaseClient, type TenantScope, type AuditScope, type AuditWriteContext, type ActivityWriteFn } from '@acbp/database';
import { runInCompanyScope } from './company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  companyUpdated,
  companyPaused,
  companyResumed,
  isLegalCompanyTransition,
  isCompanyStatus,
  toDisplayStatus,
  validationError,
  isPlatformError,
  type AuditEvent,
  type CompanyStatus,
  type CompanyDisplayStatus,
  type PublicErrorEnvelope,
} from '@acbp/contracts';
import type { MemberRole } from '../members/roles.js';
import type { Logger } from '@acbp/observability';

// Local test-seam type (the exported one lives in company-service.ts; identical shape). Kept un-exported so
// the company barrel does not re-export two members named `AuditWriteFn`.
type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;

export interface CompanyLifecycleOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove the transition rolls back). */
  readonly auditWriter?: AuditWriteFn;
  /** TEST SEAM ONLY (ACBP-P1-009): override the in-tx activity projector to force a failure. Never set in production. */
  readonly activityWriter?: ActivityWriteFn;
}

function auditContext(options: CompanyLifecycleOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}

/** A safe, company-member-facing view of a company + its current profile (COMP-005/008). */
export interface CompanyView {
  readonly companyId: string;
  readonly status: CompanyStatus;
  /** Truthful display status (COMP-008): an unrecognized state renders as 'unknown', never a fake healthy state. */
  readonly displayStatus: CompanyDisplayStatus;
  readonly name: string | null;
  readonly description: string | null;
  readonly profileVersion: number | null;
}

export type GetCompanyResult = { readonly status: 'ok'; readonly company: CompanyView } | { readonly status: 'forbidden' } | { readonly status: 'not_found' };
export type RenameResult =
  | { readonly status: 'ok'; readonly changed: boolean; readonly version?: number }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'conflict' }
  | { readonly status: 'validation'; readonly error: PublicErrorEnvelope };
export type StatusTransitionResult =
  | { readonly status: 'ok'; readonly companyStatus: CompanyStatus }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'invalid_transition'; readonly from: CompanyStatus };

interface CommonParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}

// ── read ─────────────────────────────────────────────────────────────────────────────────────────────
export async function getCompany(client: DatabaseClient, params: CommonParams, options: CompanyLifecycleOptions = {}): Promise<GetCompanyResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GetCompanyResult> => {
      // ADR-022 role check (owner|viewer read). A resolved member is always allowed; audited if somehow denied.
      if (checkAuthorization(role, 'company:read', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') {
        return { status: 'forbidden' };
      }
      const company = await new CompanyRepository(scope.db).findById(params.companyId);
      if (company === undefined) return { status: 'not_found' };
      const profile = await new CompanyProfileRepository(scope.db).currentRevision(params.companyId);
      const status: CompanyStatus = isCompanyStatus(company.status) ? company.status : 'draft';
      return {
        status: 'ok',
        company: {
          companyId: company.id,
          status,
          displayStatus: toDisplayStatus(company.status),
          name: profile?.name ?? null,
          description: profile?.description ?? null,
          profileVersion: profile?.version ?? null,
        },
      };
    },
    optionsFor(options),
  );
  return unwrap(run);
}

// ── rename / profile edit ─────────────────────────────────────────────────────────────────────────────
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;

export interface RenameParams extends CommonParams {
  readonly name: unknown;
  readonly description?: unknown;
}

/** Validate + normalize a profile edit (pure). `description: undefined` means "leave unchanged". */
export function validateProfileEdit(params: RenameParams): { readonly ok: true; readonly name: string; readonly description: string | null | undefined } | { readonly ok: false; readonly error: PublicErrorEnvelope } {
  const name = typeof params.name === 'string' ? params.name.trim() : '';
  if (name.length < 1 || name.length > NAME_MAX) {
    return { ok: false, error: validationError({ message: 'A company name is required.', fields: ['name'] }).toPublic() };
  }
  let description: string | null | undefined;
  if (params.description === undefined) {
    description = undefined; // omitted → leave the current description unchanged
  } else if (params.description === null) {
    description = null; // explicit null → clear (consistent with create, which also maps null → no description)
  } else if (typeof params.description === 'string') {
    const d = params.description.trim();
    if (d.length > DESCRIPTION_MAX) return { ok: false, error: validationError({ message: 'The company description is too long.', fields: ['description'] }).toPublic() };
    description = d.length === 0 ? null : d;
  } else {
    return { ok: false, error: validationError({ message: 'The company description must be text.', fields: ['description'] }).toPublic() };
  }
  return { ok: true, name, description };
}

/** Bounded retries for the (company_id, version) optimistic-append race (COMP-004 last-write-wins). */
const MAX_RENAME_ATTEMPTS = 4;

export async function renameCompany(client: DatabaseClient, params: RenameParams, options: CompanyLifecycleOptions = {}): Promise<RenameResult> {
  const validated = validateProfileEdit(params);
  if (!validated.ok) return { status: 'validation', error: validated.error };
  const audit = options.auditWriter ?? writeAuditEvent;

  // Immutable-revision model (COMP-004): a rename INSERTs version+1. Two concurrent renames can both read the
  // same current version; the (company_id, version) PK lets exactly one win and the loser gets a CONFLICT. We
  // RETRY the loser (a fresh transaction re-reads the now-committed version and appends the next one), so
  // concurrent edits resolve last-write-wins with visible history instead of surfacing a 500. After a bounded
  // number of attempts we return a coarse `conflict` (mapped to 409) rather than spin.
  for (let attempt = 1; attempt <= MAX_RENAME_ATTEMPTS; attempt++) {
    try {
      const run = await runInCompanyScope(
        client,
        { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
        async (scope, role): Promise<RenameResult> => {
          if (checkAuthorization(role, 'company:rename', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') {
            return { status: 'forbidden' };
          }
          const profiles = new CompanyProfileRepository(scope.db);
          const current = await profiles.currentRevision(params.companyId);
          if (current === undefined) return { status: 'not_found' };

          const nextName = validated.name;
          const nextDescription = validated.description === undefined ? current.description : validated.description;
          const changed: string[] = [];
          if (nextName !== current.name) changed.push('name');
          if (nextDescription !== current.description) changed.push('description');
          if (changed.length === 0) return { status: 'ok', changed: false }; // idempotent no-op → no version, no audit

          const nextVersion = current.version + 1;
          await profiles.insert({ company_id: params.companyId, version: nextVersion, name: nextName, description: nextDescription, created_by_user_id: params.userId });
          const project = options.activityWriter ?? projectCompanyActivity;
          const updatedEvent = companyUpdated({ companyId: params.companyId, changedFields: changed });
          const auditEventId = await audit(scope, updatedEvent, auditContext(options));
          await project(scope, updatedEvent, auditEventId); // same-tx activity projection (rolls back with the rename)
          options.logger?.info('company.updated', { metadata: { accountId: params.accountId, companyId: params.companyId, changedFields: changed.join(',') } });
          return { status: 'ok', changed: true, version: nextVersion };
        },
        optionsFor(options),
      );
      return unwrap(run);
    } catch (e) {
      // Retry ONLY the version-append race (a normalized conflict); any other error propagates unchanged.
      if (attempt < MAX_RENAME_ATTEMPTS && isPlatformError(e) && e.category === 'conflict') continue;
      if (isPlatformError(e) && e.category === 'conflict') return { status: 'conflict' };
      throw e;
    }
  }
  return { status: 'conflict' };
}

// ── pause / resume (owner-driven status transitions) ────────────────────────────────────────────────
// The transition asserts the SPECIFIC expected `from` (not merely "any legal transition to `to`") so an owner
// resume can only apply to a `paused` company and a pause only to an `active` one — the system-driven
// `onboarding→active` provisioning transition (P1-012) can never be forced through the owner resume endpoint,
// and the audit event is never mislabeled (correctness review F2). The affected-row count is checked before
// auditing, so a 0-row update (e.g. a weakened scope invariant) can never emit a success audit (F5).
async function transition(
  scope: TenantScope,
  companyId: string,
  requiredFrom: CompanyStatus,
  to: CompanyStatus,
  makeEvent: (from: CompanyStatus) => AuditEvent,
  audit: AuditWriteFn,
  project: ActivityWriteFn,
  ctx: AuditWriteContext,
): Promise<StatusTransitionResult> {
  const companies = new CompanyRepository(scope.db);
  const company = await companies.findById(companyId);
  if (company === undefined) return { status: 'not_found' };
  const from = isCompanyStatus(company.status) ? company.status : 'draft';
  if (from !== requiredFrom || !isLegalCompanyTransition(from, to)) return { status: 'invalid_transition', from };
  const updated = await companies.updateStatus(companyId, to);
  if (updated === undefined) return { status: 'not_found' }; // 0 rows affected → do NOT audit a phantom transition
  const event = makeEvent(from);
  const auditEventId = await audit(scope, event, ctx);
  await project(scope, event, auditEventId); // same-tx activity projection (rolls back with the status update)
  return { status: 'ok', companyStatus: to };
}

export type PauseParams = CommonParams;

export async function pauseCompany(client: DatabaseClient, params: PauseParams, options: CompanyLifecycleOptions = {}): Promise<StatusTransitionResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const project = options.activityWriter ?? projectCompanyActivity;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<StatusTransitionResult> => {
      if (checkAuthorization(role, 'company:pause', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') {
        return { status: 'forbidden' };
      }
      // No caller-supplied free-text reason is persisted (data minimization; the immutable audit records only
      // the fact of the transition — security review LOW-1). The contract factory keeps an optional coarse
      // reason for a future SERVER-set value; it is deliberately not populated from request input here.
      const result = await transition(scope, params.companyId, 'active', 'paused', () => companyPaused({ companyId: params.companyId }), audit, project, auditContext(options));
      if (result.status === 'ok') options.logger?.info('company.paused', { metadata: { accountId: params.accountId, companyId: params.companyId } });
      return result;
    },
    optionsFor(options),
  );
  return unwrap(run);
}

export async function resumeCompany(client: DatabaseClient, params: PauseParams, options: CompanyLifecycleOptions = {}): Promise<StatusTransitionResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const project = options.activityWriter ?? projectCompanyActivity;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<StatusTransitionResult> => {
      if (checkAuthorization(role, 'company:resume', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') {
        return { status: 'forbidden' };
      }
      // Resume requires the company be `paused` (requiredFrom) — the system-driven onboarding→active provisioning
      // transition (P1-012) can never be forced through here. No caller free-text reason persisted (LOW-1).
      const result = await transition(scope, params.companyId, 'paused', 'active', () => companyResumed({ companyId: params.companyId }), audit, project, auditContext(options));
      if (result.status === 'ok') options.logger?.info('company.resumed', { metadata: { accountId: params.accountId, companyId: params.companyId } });
      return result;
    },
    optionsFor(options),
  );
  return unwrap(run);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────
function optionsFor(options: CompanyLifecycleOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}

// A resolver denial (blank id / no account membership / no company membership) becomes a coarse `forbidden`
// so the caller cannot distinguish "not a member" from "not allowed" (no oracle).
function unwrap<T extends { status: string }>(run: { kind: 'ran'; value: T; role: MemberRole } | { kind: 'denied'; reason: string }): T | { status: 'forbidden' } {
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
