// @acbp/worker — nightly drift reconciliation command (ACBP-P1-002; CDR-007/008).
//
// Runs ONE reconciliation pass over all active internal identity mappings and exits. It composes the
// domain ONLY through @acbp/core (the worker never imports @acbp/adapters or @acbp/database directly),
// mirroring the web composition boundary. NO scheduler and NO deployment here — a single invocation
// repairs forward drift (non-destructive) and prints a bounded, PII-free summary. Idempotent: a second
// run reports everything in sync. Injectable runtime/logger keep it unit-testable without Clerk/DB.
import { createClerkIdentityRuntime, type ClerkIdentityRuntime, type ReconciliationSummary } from '@acbp/core';
import { loadClerkConfig, loadClerkWebhookConfig, loadDatabaseConfig } from '@acbp/config';
import { PlatformError, ErrorCodes, type ErrorCategory, type ErrorCode } from '@acbp/contracts';
import { createLogger, createRootContext, type Logger } from '@acbp/observability';

export interface ReconcileWorkerDeps {
  /** Inject a composed runtime in tests; production builds one from environment config. */
  readonly createRuntime?: () => ClerkIdentityRuntime;
  readonly logger?: Logger;
}

function defaultRuntime(): ClerkIdentityRuntime {
  const clerkWebhookConfig = loadClerkWebhookConfig();
  return createClerkIdentityRuntime({
    databaseConfig: loadDatabaseConfig(),
    clerkWebhookConfig,
    clerkConfig: loadClerkConfig(),
    expectedInstanceId: clerkWebhookConfig.expectedInstanceId ?? '',
  });
}

/**
 * Execute one reconciliation pass. Returns a process exit code (0 success, 1 failure). Always closes
 * the runtime. Never throws to the caller and never logs PII/secrets — only counts + correlation id.
 */
export async function runReconcile(deps: ReconcileWorkerDeps = {}): Promise<{ readonly code: number; readonly summary?: ReconciliationSummary }> {
  const context = createRootContext();
  const correlationId = context.correlationId;
  const logger = deps.logger ?? createLogger({ component: 'reconcile', context });
  const runtime = (deps.createRuntime ?? defaultRuntime)();
  try {
    logger.info('reconcile.worker.start', { metadata: { correlationId } });
    const summary = await runtime.reconcile({ correlationId, logger });
    logger.info('reconcile.worker.done', { metadata: { correlationId, ...summary } });
    return { code: 0, summary };
  } catch (e) {
    // Log ONLY the stable code + category — never the raw error object. The logger's redaction is
    // field-name-based and does NOT scrub secrets/PII embedded in an arbitrary error message/stack, so
    // passing the raw error could leak. (A DB/reader fault surfaces here as a PlatformError or a raw
    // driver error; either way only the bounded classification is logged.)
    const errorCode: ErrorCode = e instanceof PlatformError ? e.code : ErrorCodes.INTERNAL_ERROR;
    const errorCategory: ErrorCategory = e instanceof PlatformError ? e.category : 'internal';
    logger.error('reconcile.worker.failed', { metadata: { correlationId, errorCode, errorCategory } });
    return { code: 1 };
  } finally {
    await runtime.close();
  }
}
