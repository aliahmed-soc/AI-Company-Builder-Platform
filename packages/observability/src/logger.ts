// @acbp/observability — provider-neutral structured logger + correlation (ACBP-P0-017).
//
// Explicit context passing (immutable Logger instances hold their own CorrelationContext) — no
// global mutable state / AsyncLocalStorage — so concurrent operations cannot leak context.
// Every emitted record is redacted before it reaches an adapter; logging never throws to the
// caller (pipeline failure never blocks user work). Console + in-memory test adapters are provided;
// a production/vendor adapter can replace them later without changing call sites.
import { randomUUID } from 'node:crypto';
import type { CorrelationContext, OperationIdOverrides } from '@acbp/contracts';
import { deriveChildContext, normalizeError } from '@acbp/contracts';
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly event: string;
  readonly message?: string;
  readonly context?: Partial<CorrelationContext>;
  readonly metadata?: Record<string, unknown>;
  readonly error?: Record<string, unknown>;
  readonly env?: string;
}

export interface LogFields {
  readonly message?: string;
  readonly metadata?: Record<string, unknown>;
  readonly error?: unknown;
}

export interface LogAdapter {
  emit(record: LogRecord): void;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Derive a child logger for a sub-operation (inherits trace + tenant identity). */
  child(overrides: OperationIdOverrides): Logger;
  /** Bind a different component name. */
  withComponent(component: string): Logger;
  readonly context?: CorrelationContext;
}

export interface LoggerOptions {
  readonly component?: string;
  readonly context?: CorrelationContext;
  readonly minLevel?: LogLevel;
  readonly env?: string;
  readonly adapter?: LogAdapter;
  readonly clock?: () => string;
}

/** Generate a new server-side correlation id (UUID v4). */
export function newCorrelationId(): string {
  return randomUUID();
}

/** Build a root correlation context (generates a correlationId when not supplied). */
export function createRootContext(fields: Partial<CorrelationContext> = {}): CorrelationContext {
  const { correlationId, ...rest } = fields;
  return { correlationId: correlationId ?? newCorrelationId(), ...rest };
}

export const consoleAdapter: LogAdapter = {
  emit(record) {
    // Structured single-line JSON; safe (already redacted) by the time it reaches here.
    console.log(JSON.stringify(record));
  },
};

function safeErrorFields(error: unknown): Record<string, unknown> {
  const pe = normalizeError(error);
  const internal = pe.toInternal();
  return {
    code: internal.code,
    category: internal.category,
    retryable: internal.retryable,
    message: internal.internalMessage,
    causeChain: internal.causeChain,
    ...(internal.correlationId !== undefined ? { correlationId: internal.correlationId } : {}),
    ...(internal.stack !== undefined ? { stack: internal.stack } : {}),
  };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const component = options.component ?? 'app';
  const minLevel = options.minLevel ?? 'info';
  const adapter = options.adapter ?? consoleAdapter;
  const clock = options.clock ?? (() => new Date().toISOString());
  const context = options.context;
  const env = options.env;

  function emit(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    try {
      const record: LogRecord = {
        timestamp: clock(),
        level,
        component,
        event,
        ...(env !== undefined ? { env } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(fields?.message !== undefined ? { message: fields.message } : {}),
        ...(fields?.metadata !== undefined ? { metadata: redact(fields.metadata) as Record<string, unknown> } : {}),
        ...(fields?.error !== undefined ? { error: redact(safeErrorFields(fields.error)) as Record<string, unknown> } : {}),
      };
      adapter.emit(record);
    } catch {
      // Pipeline failure must never block user work.
    }
  }

  return {
    ...(context !== undefined ? { context } : {}),
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (overrides) =>
      createLogger({
        component,
        minLevel,
        adapter,
        clock,
        ...(env !== undefined ? { env } : {}),
        context: context !== undefined ? deriveChildContext(context, overrides) : createRootContext(overrides),
      }),
    withComponent: (nextComponent) =>
      createLogger({
        component: nextComponent,
        minLevel,
        adapter,
        clock,
        ...(env !== undefined ? { env } : {}),
        ...(context !== undefined ? { context } : {}),
      }),
  };
}

export interface TestLogger {
  readonly logger: Logger;
  readonly records: readonly LogRecord[];
  clear(): void;
}

/** In-memory logger for deterministic tests (fixed clock; captures redacted records). */
export function createTestLogger(options: Omit<LoggerOptions, 'adapter'> = {}): TestLogger {
  const records: LogRecord[] = [];
  const adapter: LogAdapter = { emit: (r) => records.push(r) };
  const logger = createLogger({
    minLevel: 'debug',
    clock: () => '1970-01-01T00:00:00.000Z',
    ...options,
    adapter,
  });
  return {
    logger,
    records,
    clear: () => {
      records.length = 0;
    },
  };
}
