// @acbp/contracts — structured error taxonomy (ACBP-P0-016; NFR-009, ADR-017).
//
// Provider-neutral, transport-neutral errors with a hard split between the SAFE public envelope
// (what clients/other tenants may see) and the internal diagnostic report (logs/operators only).
// Public output NEVER contains: internal messages, causes, stack traces, metadata, secrets, raw
// provider responses, prompts/outputs, DB info, or cross-tenant identifiers. Redaction is
// structural (toPublic()/toJSON() return only allowlisted fields) — not a string-scrubbing habit.
//
// Categories use the canonical terminology from docs/architecture/API-CONTRACTS.md.

export type ErrorCategory =
  | 'validation'
  | 'authn'
  | 'authz'
  | 'not_found'
  | 'conflict'
  | 'limit_exceeded'
  | 'policy_blocked'
  | 'approval_required'
  | 'provider_unavailable'
  | 'internal';

/** Stable, machine-readable error codes (DOMAIN_REASON). Unique; never embed dynamic/sensitive values. */
export const ErrorCodes = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  CONFIG_INVALID: 'CONFIG_INVALID',
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  AUTHORIZATION_DENIED: 'AUTHORIZATION_DENIED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  CONFLICT_DETECTED: 'CONFLICT_DETECTED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  USAGE_LIMIT_EXCEEDED: 'USAGE_LIMIT_EXCEEDED',
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  DEPENDENCY_TIMEOUT: 'DEPENDENCY_TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

interface CategoryDefault {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly message: string;
}
const CATEGORY_DEFAULTS: Record<ErrorCategory, CategoryDefault> = {
  validation: { code: ErrorCodes.VALIDATION_FAILED, status: 400, retryable: false, message: 'The request was invalid.' },
  authn: { code: ErrorCodes.AUTHENTICATION_REQUIRED, status: 401, retryable: false, message: 'Authentication is required.' },
  authz: { code: ErrorCodes.AUTHORIZATION_DENIED, status: 403, retryable: false, message: 'You do not have access to this resource.' },
  not_found: { code: ErrorCodes.RESOURCE_NOT_FOUND, status: 404, retryable: false, message: 'The requested resource was not found.' },
  conflict: { code: ErrorCodes.CONFLICT_DETECTED, status: 409, retryable: false, message: 'The request conflicts with the current state.' },
  limit_exceeded: { code: ErrorCodes.RATE_LIMIT_EXCEEDED, status: 429, retryable: true, message: 'A limit was exceeded. Please try again later.' },
  policy_blocked: { code: ErrorCodes.POLICY_BLOCKED, status: 403, retryable: false, message: 'This action is not permitted by policy.' },
  approval_required: { code: ErrorCodes.APPROVAL_REQUIRED, status: 403, retryable: false, message: 'This action requires approval.' },
  provider_unavailable: { code: ErrorCodes.DEPENDENCY_UNAVAILABLE, status: 503, retryable: true, message: 'A dependency is temporarily unavailable. Please try again later.' },
  internal: { code: ErrorCodes.INTERNAL_ERROR, status: 500, retryable: false, message: 'An internal error occurred.' },
};

/** Safe, client- and cross-tenant-facing error shape. The only representation that leaves the server. */
export interface PublicErrorEnvelope {
  readonly category: ErrorCategory;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlationId?: string;
}

/** Full diagnostic report for logs/operators only. Never returned to clients. */
export interface InternalErrorReport {
  readonly category: ErrorCategory;
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlationId?: string;
  readonly status: number;
  readonly internalMessage: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  readonly docsRef?: string;
  readonly stack?: string;
  readonly causeChain: readonly string[];
}

export interface PlatformErrorOptions {
  readonly code?: ErrorCode;
  /** Safe, user-facing message. Defaults to a generic per-category message. */
  readonly message?: string;
  /** Diagnostic message for logs only. Never exposed publicly. */
  readonly internalMessage?: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly correlationId?: string;
  /** Tenant-safe diagnostic metadata (log/operator only; never in public output). */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  readonly docsRef?: string;
  readonly cause?: unknown;
}

function causeChainOf(err: unknown): string[] {
  const chain: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current instanceof Error && depth < 10) {
    chain.push(`${current.name}: ${current.message}`);
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
  return chain;
}

export class PlatformError extends Error {
  readonly category: ErrorCategory;
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly correlationId?: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  readonly docsRef?: string;

  constructor(category: ErrorCategory, options: PlatformErrorOptions = {}) {
    const d = CATEGORY_DEFAULTS[category];
    const userMessage = options.message ?? d.message;
    super(options.internalMessage ?? userMessage, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PlatformError';
    this.category = category;
    this.code = options.code ?? d.code;
    this.userMessage = userMessage;
    this.status = options.status ?? d.status;
    this.retryable = options.retryable ?? d.retryable;
    if (options.correlationId !== undefined) this.correlationId = options.correlationId;
    this.metadata = Object.freeze({ ...(options.metadata ?? {}) });
    if (options.docsRef !== undefined) this.docsRef = options.docsRef;
  }

  /** SAFE representation for clients/other tenants. Excludes internal message, cause, stack, metadata. */
  toPublic(): PublicErrorEnvelope {
    const base = { category: this.category, code: this.code, message: this.userMessage, retryable: this.retryable };
    return this.correlationId !== undefined ? { ...base, correlationId: this.correlationId } : base;
  }

  /** Full diagnostic report for logs/operators only. */
  toInternal(): InternalErrorReport {
    const base = {
      category: this.category,
      code: this.code,
      message: this.userMessage,
      retryable: this.retryable,
      status: this.status,
      internalMessage: this.message,
      metadata: this.metadata,
      causeChain: causeChainOf(this.cause),
    };
    return {
      ...base,
      ...(this.correlationId !== undefined ? { correlationId: this.correlationId } : {}),
      ...(this.docsRef !== undefined ? { docsRef: this.docsRef } : {}),
      ...(this.stack !== undefined ? { stack: this.stack } : {}),
    };
  }

  /** JSON.stringify(error) is safe by default: only the public envelope is serialized. */
  toJSON(): PublicErrorEnvelope {
    return this.toPublic();
  }
}

export function isPlatformError(value: unknown): value is PlatformError {
  return value instanceof PlatformError;
}

export function statusFor(category: ErrorCategory): number {
  return CATEGORY_DEFAULTS[category].status;
}

function safeStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  try {
    const json = JSON.stringify(value);
    return json ?? '[unserializable value]';
  } catch {
    return '[unserializable value]';
  }
}

/**
 * Normalize any thrown value into a PlatformError. Unknown values and native Errors map to the
 * internal category with a GENERIC public message — raw messages/provider responses stay in the
 * internal diagnostic only (never public). Existing PlatformErrors pass through (correlation id
 * attached if missing).
 */
export function normalizeError(value: unknown, options: { correlationId?: string } = {}): PlatformError {
  if (isPlatformError(value)) {
    if (options.correlationId !== undefined && value.correlationId === undefined) {
      return new PlatformError(value.category, {
        code: value.code,
        message: value.userMessage,
        internalMessage: value.message,
        status: value.status,
        retryable: value.retryable,
        correlationId: options.correlationId,
        metadata: value.metadata,
        ...(value.docsRef !== undefined ? { docsRef: value.docsRef } : {}),
        cause: value.cause,
      });
    }
    return value;
  }
  if (value instanceof Error) {
    return new PlatformError('internal', {
      internalMessage: value.message,
      cause: value,
      ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    });
  }
  return new PlatformError('internal', {
    internalMessage: safeStringify(value),
    cause: value,
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
  });
}

/** Validation error carrying only field NAMES (no values) as internal metadata. */
export function validationError(
  options: { message?: string; fields?: readonly string[]; internalMessage?: string; correlationId?: string; cause?: unknown } = {},
): PlatformError {
  return new PlatformError('validation', {
    code: ErrorCodes.VALIDATION_FAILED,
    ...(options.message !== undefined ? { message: options.message } : {}),
    ...(options.internalMessage !== undefined ? { internalMessage: options.internalMessage } : {}),
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    ...(options.fields && options.fields.length > 0 ? { metadata: { failedFields: options.fields.join(',') } } : {}),
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
  });
}

/** Convenience factory: build a PlatformError for a category with options. */
export function platformError(category: ErrorCategory, options: PlatformErrorOptions = {}): PlatformError {
  return new PlatformError(category, options);
}
