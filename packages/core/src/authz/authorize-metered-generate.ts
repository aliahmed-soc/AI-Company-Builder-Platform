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
