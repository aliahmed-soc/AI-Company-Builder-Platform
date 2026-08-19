// @acbp/core — consult whether a caller may commission a metered generate (ACBP-API-008; CDR-092 §15).
//
// The request layer debits the per-company rate-limit bucket only after this returns `allowed`. It does
// not decide authorization itself (CDR-088 §1): this is `runInCompanyScope` plus the same
// `checkAuthorization` the generate use cases already run, restricted to the four owner-only generate
// actions. The use case still decides, and still re-checks inside the persist transaction.
//
// An unknown action is `forbidden` without touching the database. This function exists to gate a
// company-scoped debit; answering `allowed` for `strategy:read` (owner|viewer) would let a viewer
// spend the company's tokens.
import type { DatabaseClient } from '@acbp/database';
import type { Logger } from '@acbp/observability';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from './authz-service.js';

export const METERED_GENERATE_ACTIONS = ['strategy:generate', 'strategy:recommend', 'roadmap:generate', 'task:generate'] as const;

export type MeteredGenerateAction = (typeof METERED_GENERATE_ACTIONS)[number];

export interface AuthorizeMeteredGenerateParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly action: MeteredGenerateAction;
}

export interface AuthorizeMeteredGenerateOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

export type AuthorizeMeteredGenerateResult = 'allowed' | 'forbidden';

function isMeteredGenerateAction(action: string): action is MeteredGenerateAction {
  return (METERED_GENERATE_ACTIONS as readonly string[]).includes(action);
}

export async function authorizeMeteredGenerate(
  client: DatabaseClient,
  params: AuthorizeMeteredGenerateParams,
  options: AuthorizeMeteredGenerateOptions = {},
): Promise<AuthorizeMeteredGenerateResult> {
  if (!isMeteredGenerateAction(params.action)) return 'forbidden';

  const opts = {
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    (_scope, role) =>
      Promise.resolve(
        checkAuthorization(role, params.action, { accountId: params.accountId, actorId: params.userId }, opts).kind === 'allow'
          ? ('allowed' as const)
          : ('forbidden' as const),
      ),
    opts,
  );
  if (run.kind !== 'ran') return 'forbidden';
  return run.value;
}

// ── The MEMBER-level metered actions (ACBP-API-013; DISC-003/005) ─────────────────────────────────────────────
//
// ⚠️ WHY THIS IS A SECOND FUNCTION AND NOT A WIDER `METERED_GENERATE_ACTIONS`.
//
// The set above is closed to four OWNER-ONLY actions on purpose, and this file says why in its own header: a
// company-scoped debit authorized against an owner+viewer action would let a viewer spend the company's tokens.
// That reasoning is correct and stays.
//
// But `evaluateAnswer` and `suggestAssumptionForSkip` (ACBP-FE-008) are metered too, and they are NOT owner-only.
// They check no action of their own — they inherit refusal from `getSessionQa` (`interview:read`) and
// `createMemoryItem` (`memory:write`), both `['owner', 'viewer']` — because answering an interview question is
// something a viewer legitimately does. Routing them through `authorizeMeteredGenerate` would refuse every viewer
// mid-interview; adding them to the four would silently retract the invariant above for the other four as well.
//
// So the debit gate is split by POSTURE rather than widened: owner-only generation above, member-level
// participation here. What both keep is CDR-092 §15's actual guarantee — the company bucket is debited only after
// an authorization check has passed, never before — which is the property that stops an unauthorized caller
// draining a company's ceiling.
//
// `interview:participate` is REUSED, not invented: it is the action `recordInterviewAnswer` already enforces for
// the answer path (`interview-qa.ts`), so this gate admits exactly the callers the use case would admit anyway.
export const METERED_PARTICIPATE_ACTIONS = ['interview:participate'] as const;

export type MeteredParticipateAction = (typeof METERED_PARTICIPATE_ACTIONS)[number];

export interface AuthorizeMeteredParticipateParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly action: MeteredParticipateAction;
}

function isMeteredParticipateAction(action: string): action is MeteredParticipateAction {
  return (METERED_PARTICIPATE_ACTIONS as readonly string[]).includes(action);
}

/**
 * Consult whether a caller may commission a MEMBER-level metered call, before the company bucket is debited.
 *
 * Same machinery and same fail-closed posture as {@link authorizeMeteredGenerate}: an unknown action is
 * `forbidden` without touching the database, a scope that will not resolve is `forbidden`, and the use case still
 * decides again inside its own scope. This is a pre-debit gate, never the authority.
 */
export async function authorizeMeteredParticipate(
  client: DatabaseClient,
  params: AuthorizeMeteredParticipateParams,
  options: AuthorizeMeteredGenerateOptions = {},
): Promise<AuthorizeMeteredGenerateResult> {
  if (!isMeteredParticipateAction(params.action)) return 'forbidden';

  const opts = {
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    (_scope, role) =>
      Promise.resolve(
        checkAuthorization(role, params.action, { accountId: params.accountId, actorId: params.userId }, opts).kind === 'allow' ? ('allowed' as const) : ('forbidden' as const),
      ),
    opts,
  );
  if (run.kind !== 'ran') return 'forbidden';
  return run.value;
}
