// @acbp/contracts — provider-neutral correlation model (ACBP-P0-017; NFR-009).
//
// A CorrelationContext links logs, tasks, tool/model calls, and safe error responses across
// synchronous and asynchronous boundaries. It is passed EXPLICITLY (immutable value objects) —
// there is no global mutable context — so concurrent operations cannot leak identifiers into each
// other. Child operations derive a new context that inherits the trace + tenant/actor identity and
// may add only operation-scoped identifiers.
//
// Tenant/user identifiers (accountId, companyId, actorId) are sensitive operational metadata:
// they belong in access-controlled server logs, never in unrestricted public/user-facing output.

export interface CorrelationContext {
  /** Root identifier of the trace. Immutable within an operation. */
  readonly correlationId: string;
  readonly requestId?: string;
  readonly taskId?: string;
  readonly taskRunId?: string;
  readonly workerRunId?: string;
  readonly toolCallId?: string;
  readonly modelCallId?: string;
  // Sensitive operational identity — server logs only.
  readonly accountId?: string;
  readonly companyId?: string;
  readonly actorId?: string;
}

/** UUID v4 (as produced by crypto.randomUUID). */
export const CORRELATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_RE.test(value);
}

/** Only operation-scoped identifiers may be set on a child; trace + tenant/actor identity are inherited. */
export type OperationIdOverrides = Partial<
  Pick<CorrelationContext, 'requestId' | 'taskId' | 'taskRunId' | 'workerRunId' | 'toolCallId' | 'modelCallId'>
>;

const OPERATION_ID_KEYS = ['requestId', 'taskId', 'taskRunId', 'workerRunId', 'toolCallId', 'modelCallId'] as const;

/**
 * Derive a child context: inherits the parent's correlationId and tenant/actor identity; may add
 * only operation-scoped identifiers. correlationId, accountId, companyId, actorId cannot be
 * overridden here (immutable within the trace).
 */
export function deriveChildContext(parent: CorrelationContext, overrides: OperationIdOverrides = {}): CorrelationContext {
  const allowed: Record<string, string> = {};
  for (const key of OPERATION_ID_KEYS) {
    const v = overrides[key];
    if (v !== undefined) allowed[key] = v;
  }
  return { ...parent, ...allowed };
}
