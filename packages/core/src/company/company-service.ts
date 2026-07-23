// @acbp/core — company lifecycle use cases (ACBP-P1-010; CDR-015). Slice 3: create.
//
// Provider-neutral. Company creation runs under the caller's validated AccountScope on the restricted role: the
// acting user's ACTIVE account membership is resolved first, `company:create` is authorized from that ACCOUNT
// role (owner-only), and then a SINGLE transaction inserts the company (account-keyed RLS), elevates to a
// CompanyScope from the authoritative inserted row, and — under that company scope — inserts the initial
// profile revision, the creator's active `owner` company membership, and the durable `company.created` audit.
// A failure at any step rolls the whole transaction back (all-or-nothing; no orphan company/profile/membership,
// no audit for an uncreated company). No 4th SECURITY DEFINER function — creation reuses the existing scope.
import {
  CompanyRepository,
  CompanyProfileRepository,
  CompanyMembershipRepository,
  MembershipRepository,
  ProvisioningRepository,
  elevateToCompanyScope,
  writeAuditEvent,
  projectCompanyActivity,
  type DatabaseClient,
  type TenantScope,
  type AuditScope,
  type AuditWriteContext,
  type ActivityWriteFn,
} from '@acbp/database';
import { runInAccountScope } from '../tenancy/account-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  companyCreated,
  provisioningStarted,
  isCompanyCreationMode,
  INITIAL_COMPANY_STATUS,
  PROVISIONING_STEPS,
  validationError,
  platformError,
  ErrorCodes,
  type AuditEvent,
  type CompanyCreationMode,
  type CompanyStatus,
  type PublicErrorEnvelope,
} from '@acbp/contracts';
import { isMemberRole } from '../members/roles.js';
import { resumeProvisioning, type ProvisioningRunnerFn } from './provisioning-service.js';
import type { Logger } from '@acbp/observability';

/** TEST SEAM ONLY (mirrors membership-service): override the in-tx audit writer to force a failure. */
export type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;

export interface CreateCompanyParams {
  readonly accountId: string;
  readonly actingUserId: string;
  readonly creationMode: unknown;
  readonly name: unknown;
  readonly description?: unknown;
}

export interface CompanyOpOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /** TEST SEAM ONLY (ACBP-P1-008/010): override the in-tx audit writer to force a failure. Never set in production. */
  readonly auditWriter?: AuditWriteFn;
  /** TEST SEAM ONLY (ACBP-P1-009): override the in-tx activity projector to force a failure. Never set in production. */
  readonly activityWriter?: ActivityWriteFn;
  /** TEST SEAM ONLY (ACBP-P1-012): override (or with `null` suppress) the post-commit inline provisioning run,
   *  so tests can observe the committed bootstrap state. Production always uses the real resume service. */
  readonly provisioningRunner?: ProvisioningRunnerFn | null;
}

export type CreateCompanyResult =
  | { readonly status: 'ok'; readonly companyId: string; readonly companyStatus: CompanyStatus; readonly creationMode: CompanyCreationMode }
  | { readonly status: 'forbidden' }
  | { readonly status: 'validation'; readonly error: PublicErrorEnvelope };

const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;

/** Validated, normalized create-company input (pure; unit-testable without a database). */
export interface NormalizedCreateCompany {
  readonly creationMode: CompanyCreationMode;
  readonly name: string;
  readonly description: string | null;
}

export type ValidateResult = { readonly ok: true; readonly value: NormalizedCreateCompany } | { readonly ok: false; readonly error: PublicErrorEnvelope };

/**
 * Validate + normalize the caller-facing create-company input. Pure: rejects an unknown creation mode, an
 * empty/over-long name, or an over-long description. The creation MODE is onboarding input only — it does not
 * affect cardinality (CDR-015 §1). The initial status is server-selected, never accepted here.
 */
export function validateCreateCompanyInput(params: CreateCompanyParams): ValidateResult {
  if (!isCompanyCreationMode(params.creationMode)) {
    return { ok: false, error: validationError({ message: 'Unknown company creation mode.', fields: ['creationMode'] }).toPublic() };
  }
  const name = typeof params.name === 'string' ? params.name.trim() : '';
  if (name.length < 1 || name.length > NAME_MAX) {
    return { ok: false, error: validationError({ message: 'A company name is required.', fields: ['name'] }).toPublic() };
  }
  let description: string | null = null;
  if (typeof params.description === 'string' && params.description.trim().length > 0) {
    const d = params.description.trim();
    if (d.length > DESCRIPTION_MAX) {
      return { ok: false, error: validationError({ message: 'The company description is too long.', fields: ['description'] }).toPublic() };
    }
    description = d;
  }
  return { ok: true, value: { creationMode: params.creationMode, name, description } };
}

function auditContext(options: CompanyOpOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}

/**
 * Create a company (COMP-001/005). Runs the whole bootstrap in ONE transaction under the caller's AccountScope.
 * Owner-gated by the ACCOUNT role; a non-owner (or non-member) is denied → `forbidden`. On success returns the
 * new company's id + server-selected status + creation mode.
 */
export async function createCompany(client: DatabaseClient, params: CreateCompanyParams, options: CompanyOpOptions = {}): Promise<CreateCompanyResult> {
  const validated = validateCreateCompanyInput(params);
  if (!validated.ok) return { status: 'validation', error: validated.error };
  const input = validated.value;
  const audit = options.auditWriter ?? writeAuditEvent;

  const run = await runInAccountScope(
    client,
    { userId: params.actingUserId, requestedAccountId: params.accountId },
    async (accountScope): Promise<CreateCompanyResult> => {
      // Authorize `company:create` from the caller's ACTIVE ACCOUNT role (owner-only). A denial is audited by
      // checkAuthorization and mapped to a coarse `forbidden` (account ownership does not auto-grant, but
      // creating a company requires being an account OWNER — CDR-015 §2/§3).
      const membershipRow = await new MembershipRepository(accountScope.db).findActiveByAccountAndUser(params.accountId, params.actingUserId);
      const accountRole = membershipRow !== undefined && isMemberRole(membershipRow.role) ? membershipRow.role : null;
      if (checkAuthorization(accountRole, 'company:create', { accountId: params.accountId, actorId: params.actingUserId }, options).kind === 'deny') {
        return { status: 'forbidden' };
      }

      // 1) Insert the company (account-keyed RLS binds account_id). Server-selected status; no caller authority.
      const company = await new CompanyRepository(accountScope.db).insert({
        account_id: params.accountId,
        creation_mode: input.creationMode,
        status: INITIAL_COMPANY_STATUS,
      });
      // 2) Elevate to a CompanyScope from the AUTHORITATIVE inserted row (same transaction).
      const companyScope: TenantScope = await elevateToCompanyScope(accountScope, company.id);
      // 3) Initial profile revision (v1) under the company scope.
      await new CompanyProfileRepository(companyScope.db).insert({
        company_id: company.id,
        version: 1,
        name: input.name,
        description: input.description,
        created_by_user_id: params.actingUserId,
      });
      // 4) The creator's EXPLICIT active `owner` company membership (account ownership never auto-grants access).
      await new CompanyMembershipRepository(companyScope.db).insert({
        account_id: params.accountId,
        company_id: company.id,
        member_user_id: params.actingUserId,
        role: 'owner',
        status: 'active',
      });
      // 5) Durable `company.created` audit + activity projection — SAME transaction + company scope. The activity
      //    row is keyed by the audit event id; a projection failure rolls the whole bootstrap back (fail-closed).
      const project = options.activityWriter ?? projectCompanyActivity;
      const createdEvent = companyCreated({ companyId: company.id, creationMode: input.creationMode });
      const auditEventId = await audit(companyScope, createdEvent, auditContext(options));
      await project(companyScope, createdEvent, auditEventId);
      // 6) Workspace provisioning bootstrap (ACBP-P1-012; CDR-018 §10) — STILL the same transaction:
      //    six PENDING checkpoints, the system-driven draft→onboarding transition, and the provisioning.started
      //    audit. Any of these failing rolls the WHOLE creation back (no partial company, no orphan checkpoints).
      //    NO step executes here — execution is request-driven and begins only after this transaction commits.
      await new ProvisioningRepository(companyScope.db).seedCheckpoints(params.accountId, company.id);
      const transitioned = await new CompanyRepository(companyScope.db).updateStatus(company.id, 'onboarding');
      if (transitioned === undefined) {
        // The just-inserted company must be visible/mutable under its own scope — anything else is an internal
        // inconsistency; throw so the whole bootstrap rolls back (fail-closed).
        throw platformError('internal', { code: ErrorCodes.INTERNAL_ERROR, internalMessage: 'Company bootstrap could not transition draft→onboarding.' });
      }
      await audit(companyScope, provisioningStarted({ companyId: company.id, stepCount: PROVISIONING_STEPS.length }), auditContext(options));
      options.logger?.info('company.created', { metadata: { accountId: params.accountId, companyId: company.id, creationMode: input.creationMode } });

      const status: CompanyStatus = 'onboarding';
      return { status: 'ok', companyId: company.id, companyStatus: status, creationMode: input.creationMode };
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );

  const created = run.kind === 'ran' ? run.value : ({ status: 'forbidden' } as const);
  if (created.status !== 'ok') return created;

  // AUTOMATIC POST-COMMIT PROVISIONING (CDR-018 §3/§10): the creation transaction has COMMITTED; now run the
  // request-driven resume service INLINE (awaited — never a detached promise/timer). The creator is the
  // company owner (the bootstrap just made them one), so provisioning:resume authorizes. A step failure — or
  // any unexpected error here — NEVER rolls back or fails the already-created company: it stays `onboarding`
  // with truthful checkpoints, and a later explicit owner resume continues from the first incomplete step.
  if (options.provisioningRunner !== null) {
    const runner = options.provisioningRunner ?? resumeProvisioning;
    try {
      const provisioned = await runner(client, { userId: params.actingUserId, accountId: params.accountId, companyId: created.companyId }, options);
      if (provisioned.status === 'ok' && provisioned.provisioning.completed) {
        return { ...created, companyStatus: 'active' }; // truthful final status after successful auto-provisioning
      }
    } catch {
      // Logged coarsely; the company itself was created successfully and remains resumable.
      options.logger?.warn('provisioning.post_create_run_failed', { metadata: { companyId: created.companyId } });
    }
  }
  return created;
}
