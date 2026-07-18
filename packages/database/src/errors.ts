// @acbp/database — driver-error normalization (ACBP-P0-018; P0-016 integration, ADR-017).
//
// Raw driver errors NEVER reach public output: every database failure becomes a PlatformError with a
// stable code, a safe category, and internal-only diagnostics. We never place SQL text, bound
// parameter values, or connection strings/credentials into the error — only the SQLSTATE and a
// generic internal note. The original driver error is preserved as `cause` for operator logs.
import { PlatformError, ErrorCodes, normalizeError, platformError, type ErrorCategory } from '@acbp/contracts';

/** Postgres SQLSTATE codes we classify explicitly. Everything else falls back to a class-prefix rule. */
interface DbErrorShape {
  readonly code?: string;
  readonly severity?: string;
}

function pgCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as DbErrorShape).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

interface Classification {
  readonly category: ErrorCategory;
  readonly code: (typeof ErrorCodes)[keyof typeof ErrorCodes];
  readonly retryable: boolean;
  readonly note: string;
}

// SQLSTATE reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
function classify(sqlState: string | undefined): Classification {
  switch (sqlState) {
    case '23505': // unique_violation
      return { category: 'conflict', code: ErrorCodes.CONFLICT_DETECTED, retryable: false, note: 'unique constraint violation' };
    case '23503': // foreign_key_violation
    case '23502': // not_null_violation
    case '23514': // check_violation
    case '22P02': // invalid_text_representation
      return { category: 'validation', code: ErrorCodes.VALIDATION_FAILED, retryable: false, note: 'integrity/validation violation' };
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return { category: 'conflict', code: ErrorCodes.CONFLICT_DETECTED, retryable: true, note: 'serialization/deadlock; safe to retry' };
    case '57014': // query_canceled (statement timeout)
      return { category: 'provider_unavailable', code: ErrorCodes.DEPENDENCY_TIMEOUT, retryable: true, note: 'statement timeout' };
    case '53300': // too_many_connections
    case '53400': // configuration_limit_exceeded
      return { category: 'provider_unavailable', code: ErrorCodes.DEPENDENCY_UNAVAILABLE, retryable: true, note: 'connection/resource limit' };
    case '42501': // insufficient_privilege (e.g. blocked by RLS)
      return { category: 'authz', code: ErrorCodes.AUTHORIZATION_DENIED, retryable: false, note: 'insufficient privilege' };
    default:
      break;
  }
  // Class-level fallbacks by SQLSTATE class (first two chars).
  const cls = sqlState?.slice(0, 2);
  if (cls === '08') return { category: 'provider_unavailable', code: ErrorCodes.DEPENDENCY_UNAVAILABLE, retryable: true, note: 'connection exception' };
  if (cls === '57') return { category: 'provider_unavailable', code: ErrorCodes.DEPENDENCY_UNAVAILABLE, retryable: true, note: 'operator intervention' };
  return { category: 'internal', code: ErrorCodes.INTERNAL_ERROR, retryable: false, note: 'unclassified database error' };
}

// Node/libpq connection-level failures that arrive without a SQLSTATE.
const CONNECTION_SYSCODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN']);

/**
 * Normalize any thrown database/driver value into a PlatformError. Never includes SQL, parameters, or
 * credentials. Attaches the correlationId when provided and preserves the original error as cause.
 */
export function toDatabaseError(err: unknown, options: { correlationId?: string; operation?: string } = {}): PlatformError {
  // Already-normalized errors pass through (correlation attached if missing).
  if (err instanceof PlatformError) return normalizeError(err, options);

  const sqlState = pgCode(err);
  const isConnSys = typeof sqlState === 'string' && CONNECTION_SYSCODES.has(sqlState);
  const c = isConnSys
    ? { category: 'provider_unavailable' as ErrorCategory, code: ErrorCodes.DEPENDENCY_UNAVAILABLE, retryable: true, note: 'connection failure' }
    : classify(sqlState);

  const metadata: Record<string, string | boolean> = { note: c.note };
  if (sqlState) metadata['sqlState'] = sqlState;
  if (options.operation) metadata['operation'] = options.operation;

  return platformError(c.category, {
    code: c.code,
    retryable: c.retryable,
    // Internal-only; deliberately free of SQL text and parameter values.
    internalMessage: `database error (${c.note}${sqlState ? `, sqlstate=${sqlState}` : ''})`,
    metadata,
    cause: err,
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
  });
}
