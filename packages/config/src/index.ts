// @acbp/config — provider-neutral, validated configuration foundation (ACBP-P0-015; NFR-018, ADR-021).
//
// Design:
//  - parse*(env) functions take an EXPLICIT environment record (pure, testable, no process.env).
//  - load*() wrappers read process.env at the composition boundary and fail fast on invalid config.
//  - Public vs server-only values are structurally separated (public config has an explicit allowlist).
//  - Server secrets are wrapped in Secret and redacted from all output; validation errors never
//    echo values (secret fields are hard-redacted).
//  - Unknown environment variables are stripped (zod .object() default), never auto-exposed.
//  - No provider integration is performed here (bootstrap-only per ADR-021 §8).
import { z } from 'zod';
import { Secret } from './secret.js';

export { Secret } from './secret.js';

export type AppEnv = 'development' | 'test' | 'staging' | 'production';

export interface PublicConfig {
  readonly appEnv: AppEnv;
  readonly publicUrl: string;
}
export interface BootstrapConfig {
  readonly appEnv: AppEnv;
  readonly infisicalSiteUrl: string;
  readonly infisicalClientId: string;
  readonly infisicalClientSecret: Secret;
  readonly infisicalEnvironment: AppEnv;
}
export interface WebServerConfig {
  readonly appEnv: AppEnv;
  readonly publicUrl: string;
  readonly port: number;
  readonly telemetryEnabled: boolean;
  readonly requestTimeoutMs: number;
  readonly bootstrap: BootstrapConfig;
}
export interface WorkerConfig {
  readonly appEnv: AppEnv;
  readonly concurrency: number;
  readonly requestTimeoutMs: number;
  readonly bootstrap: BootstrapConfig;
}

/** SSL posture for the PostgreSQL connection (standard Postgres; no proprietary options). */
export type DatabaseSslMode = 'disable' | 'require' | 'verify-full';

/**
 * Validated, server-only PostgreSQL access configuration (ACBP-P0-018; ADR-020).
 * `url` is wrapped in {@link Secret} — it carries credentials and must never be logged or returned
 * to clients. Production defaults are safe (SSL required) rather than development-convenient.
 */
export interface DatabaseConfig {
  readonly appEnv: AppEnv;
  /** Full `postgresql://` connection string, including credentials. Redacted everywhere. */
  readonly url: Secret;
  readonly poolMin: number;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly applicationName: string;
  readonly ssl: DatabaseSslMode;
  /**
   * Whether the composition root may apply migrations automatically at startup. Defaults to
   * `false`: production startup must NOT apply uncontrolled migrations implicitly — migrations run
   * as an explicit, separately-approved release step (see packages/database/README.md).
   */
  readonly migrateOnStart: boolean;
}

/** Clerk instance kind, derived from the key prefix (test => development, live => production). */
export type ClerkInstanceType = 'development' | 'production';

/**
 * Validated Clerk authentication configuration (ACBP-P1-001; ADR-022). Public vs server-only values
 * are separated: `publishableKey` is client-safe; `secretKey`/`jwtKey` are {@link Secret}-wrapped and
 * never logged, serialized, or returned to clients. Loaded only in trusted web/server processes.
 */
export interface ClerkConfig {
  /**
   * Client-safe publishable key (pk_test_… / pk_live_…). Supplied via the Next.js public-variable
   * convention `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` so it is inlined into the browser bundle safely.
   */
  readonly publishableKey: string;
  /** Server-only secret key (sk_test_… / sk_live_…). Required by @clerk/nextjs server helpers. */
  readonly secretKey: Secret;
  /** Optional PEM public key for networkless JWT verification (server-only). */
  readonly jwtKey?: Secret;
  /** Allowlisted frontend origins (azp) accepted on session tokens; empty = not enforced. */
  readonly authorizedParties: readonly string[];
  /** Optional custom sign-in route (NEXT_PUBLIC_CLERK_SIGN_IN_URL); Clerk defaults to /sign-in. */
  readonly signInUrl?: string;
  /** Optional custom sign-up route (NEXT_PUBLIC_CLERK_SIGN_UP_URL); Clerk defaults to /sign-up. */
  readonly signUpUrl?: string;
  readonly instanceType: ClerkInstanceType;
}

export interface ConfigIssue {
  readonly field: string;
  readonly message: string;
}

/** Thrown when required configuration is missing or invalid. Message never contains a value. */
export class ConfigValidationError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i.field}: ${i.message}`).join('\n')}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

// ---- shared zod building blocks --------------------------------------------------------
type EnvRecord = Record<string, string | undefined>;
const SECRET_FIELDS = new Set(['INFISICAL_CLIENT_SECRET', 'DATABASE_URL', 'CLERK_SECRET_KEY', 'CLERK_JWT_KEY']);

const appEnv = z.enum(['development', 'test', 'staging', 'production']);
const emptyToUndef = (v: unknown): unknown => (v === '' ? undefined : v);

const requiredString = z.preprocess(emptyToUndef, z.string({ required_error: 'required (missing or empty)' }).min(1));
const urlRequired = z.preprocess(emptyToUndef, z.string({ required_error: 'required (missing or empty)' }).url('must be a valid URL'));
// Optional-with-default coercers: absent OR empty falls back to the (string) default, which is
// then validated by the same rules as a provided value. Defaults live inside preprocess because
// zod's .default() treats its argument as pre-parse input, not the coerced output.
const intInRange = (min: number, max: number, def: number) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? String(def) : v),
    z
      .string()
      .regex(/^-?\d+$/, 'must be an integer')
      .transform((s) => Number(s))
      .pipe(z.number().int().min(min, `must be >= ${min}`).max(max, `must be <= ${max}`)),
  );
const boolFlag = (def: 'true' | 'false') =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? def : v),
    z.enum(['true', 'false', '1', '0'], { errorMap: () => ({ message: 'must be a boolean (true|false|1|0)' }) }).transform((v) => v === 'true' || v === '1'),
  );
const durationMs = (def: string) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? def : v),
    z
      .string()
      .regex(/^\d+(ms|s|m)?$/, 'must be a duration like 500ms, 30s, or 5m')
      .transform((s) => {
        const m = /^(\d+)(ms|s|m)?$/.exec(s);
        const n = Number(m?.[1] ?? 0);
        const unit = m?.[2] ?? 'ms';
        return unit === 'ms' ? n : unit === 's' ? n * 1000 : n * 60_000;
      }),
  );

function toError(err: z.ZodError): ConfigValidationError {
  const issues = err.issues.map((i) => {
    const field = i.path.join('.') || '(root)';
    // Never echo a value for secret fields (defence in depth; string checks don't echo anyway).
    const message = SECRET_FIELDS.has(String(i.path[0])) ? 'invalid (redacted)' : i.message;
    return { field, message };
  });
  return new ConfigValidationError(issues);
}

// ---- schemas ---------------------------------------------------------------------------
const bootstrapSchema = z
  .object({
    APP_ENV: appEnv,
    INFISICAL_SITE_URL: z.preprocess(emptyToUndef, z.string().url('must be a valid URL').optional().default('https://app.infisical.com')),
    INFISICAL_CLIENT_ID: requiredString,
    INFISICAL_CLIENT_SECRET: requiredString,
    INFISICAL_ENVIRONMENT: z.preprocess(emptyToUndef, appEnv.optional()),
  })
  .transform((o) => ({
    appEnv: o.APP_ENV,
    infisicalSiteUrl: o.INFISICAL_SITE_URL,
    infisicalClientId: o.INFISICAL_CLIENT_ID,
    infisicalClientSecret: new Secret(o.INFISICAL_CLIENT_SECRET),
    infisicalEnvironment: o.INFISICAL_ENVIRONMENT ?? o.APP_ENV,
  }));

const publicSchema = z
  .object({ APP_ENV: appEnv, APP_PUBLIC_URL: urlRequired })
  .superRefine((o, ctx) => {
    if (o.APP_ENV === 'production' && !o.APP_PUBLIC_URL.startsWith('https://')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['APP_PUBLIC_URL'], message: 'must use https in production' });
    }
  })
  .transform((o) => ({ appEnv: o.APP_ENV, publicUrl: o.APP_PUBLIC_URL }));

const webServerSchema = z
  .object({
    APP_ENV: appEnv,
    APP_PUBLIC_URL: urlRequired,
    PORT: intInRange(1, 65_535, 3000),
    APP_TELEMETRY_ENABLED: boolFlag('false'),
    REQUEST_TIMEOUT: durationMs('30000'),
  })
  .superRefine((o, ctx) => {
    if (o.APP_ENV === 'production' && !o.APP_PUBLIC_URL.startsWith('https://')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['APP_PUBLIC_URL'], message: 'must use https in production' });
    }
  });

const workerSchema = z.object({
  APP_ENV: appEnv,
  WORKER_CONCURRENCY: intInRange(1, 64, 2),
  REQUEST_TIMEOUT: durationMs('30000'),
});

const sslMode = z.enum(['disable', 'require', 'verify-full']);
const databaseSchema = z
  .object({
    APP_ENV: appEnv,
    // Validated as a postgres URL; DATABASE_URL is a SECRET_FIELD so error messages are redacted.
    DATABASE_URL: z.preprocess(
      emptyToUndef,
      z
        .string({ required_error: 'required (missing or empty)' })
        .min(1)
        .regex(/^postgres(ql)?:\/\//i, 'must be a postgresql:// connection URL'),
    ),
    DATABASE_POOL_MIN: intInRange(0, 1000, 0),
    DATABASE_POOL_MAX: intInRange(1, 1000, 10),
    DATABASE_CONNECTION_TIMEOUT: durationMs('10000'),
    DATABASE_IDLE_TIMEOUT: durationMs('30000'),
    DATABASE_STATEMENT_TIMEOUT: durationMs('30000'),
    DATABASE_APP_NAME: z.preprocess(emptyToUndef, z.string().min(1).optional().default('acbp')),
    DATABASE_SSL: z.preprocess(emptyToUndef, sslMode.optional()),
    DATABASE_MIGRATE_ON_START: boolFlag('false'),
  })
  .superRefine((o, ctx) => {
    if (o.DATABASE_POOL_MAX < o.DATABASE_POOL_MIN) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_POOL_MAX'], message: 'must be >= DATABASE_POOL_MIN' });
    }
    // Safe-by-default posture: never silently run production without TLS to the database.
    if ((o.APP_ENV === 'production' || o.APP_ENV === 'staging') && o.DATABASE_SSL === 'disable') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_SSL'], message: 'must not be "disable" in staging/production' });
    }
  })
  .transform((o) => ({
    appEnv: o.APP_ENV,
    url: new Secret(o.DATABASE_URL),
    poolMin: o.DATABASE_POOL_MIN,
    poolMax: o.DATABASE_POOL_MAX,
    connectionTimeoutMs: o.DATABASE_CONNECTION_TIMEOUT,
    idleTimeoutMs: o.DATABASE_IDLE_TIMEOUT,
    statementTimeoutMs: o.DATABASE_STATEMENT_TIMEOUT,
    applicationName: o.DATABASE_APP_NAME,
    // Safe default: TLS required outside local dev/test unless explicitly overridden.
    ssl: o.DATABASE_SSL ?? (o.APP_ENV === 'production' || o.APP_ENV === 'staging' ? 'require' : 'disable'),
    migrateOnStart: o.DATABASE_MIGRATE_ON_START,
  }));

// Clerk authentication (ACBP-P1-001; ADR-022). publishable = public; secret/jwtKey = server-only.
const clerkSchema = z
  .object({
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.preprocess(
      emptyToUndef,
      z.string({ required_error: 'required (missing or empty)' }).regex(/^pk_(test|live)_/, 'must be a Clerk publishable key (pk_test_… / pk_live_…)'),
    ),
    CLERK_SECRET_KEY: z.preprocess(
      emptyToUndef,
      z.string({ required_error: 'required (missing or empty)' }).regex(/^sk_(test|live)_/, 'must be a Clerk secret key (sk_test_… / sk_live_…)'),
    ),
    CLERK_JWT_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),
    CLERK_AUTHORIZED_PARTIES: z.preprocess(emptyToUndef, z.string().optional()),
    NEXT_PUBLIC_CLERK_SIGN_IN_URL: z.preprocess(emptyToUndef, z.string().min(1).optional()),
    NEXT_PUBLIC_CLERK_SIGN_UP_URL: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  })
  .superRefine((o, ctx) => {
    // Publishable and secret keys must belong to the same instance (both test or both live).
    const pubEnv = o.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.startsWith('pk_live_') ? 'live' : 'test';
    const secEnv = o.CLERK_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test';
    if (pubEnv !== secEnv) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CLERK_SECRET_KEY'], message: 'publishable and secret keys must be from the same Clerk instance (test vs live)' });
    }
  })
  .transform((o) => {
    const instanceType: ClerkInstanceType = o.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.startsWith('pk_live_') ? 'production' : 'development';
    return {
      publishableKey: o.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      secretKey: new Secret(o.CLERK_SECRET_KEY),
      ...(o.CLERK_JWT_KEY !== undefined ? { jwtKey: new Secret(o.CLERK_JWT_KEY) } : {}),
      authorizedParties: (o.CLERK_AUTHORIZED_PARTIES ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      ...(o.NEXT_PUBLIC_CLERK_SIGN_IN_URL !== undefined ? { signInUrl: o.NEXT_PUBLIC_CLERK_SIGN_IN_URL } : {}),
      ...(o.NEXT_PUBLIC_CLERK_SIGN_UP_URL !== undefined ? { signUpUrl: o.NEXT_PUBLIC_CLERK_SIGN_UP_URL } : {}),
      instanceType,
    };
  });

// ---- parsers (pure) --------------------------------------------------------------------
export function parseBootstrapConfig(env: EnvRecord): BootstrapConfig {
  const r = bootstrapSchema.safeParse(env);
  if (!r.success) throw toError(r.error);
  return r.data;
}
export function parsePublicConfig(env: EnvRecord): PublicConfig {
  const r = publicSchema.safeParse(env);
  if (!r.success) throw toError(r.error);
  return r.data;
}
export function parseWebServerConfig(env: EnvRecord): WebServerConfig {
  const base = webServerSchema.safeParse(env);
  if (!base.success) throw toError(base.error);
  const bootstrap = parseBootstrapConfig(env);
  return {
    appEnv: base.data.APP_ENV,
    publicUrl: base.data.APP_PUBLIC_URL,
    port: base.data.PORT,
    telemetryEnabled: base.data.APP_TELEMETRY_ENABLED,
    requestTimeoutMs: base.data.REQUEST_TIMEOUT,
    bootstrap,
  };
}
export function parseWorkerConfig(env: EnvRecord): WorkerConfig {
  const base = workerSchema.safeParse(env);
  if (!base.success) throw toError(base.error);
  const bootstrap = parseBootstrapConfig(env);
  return {
    appEnv: base.data.APP_ENV,
    concurrency: base.data.WORKER_CONCURRENCY,
    requestTimeoutMs: base.data.REQUEST_TIMEOUT,
    bootstrap,
  };
}

export function parseDatabaseConfig(env: EnvRecord): DatabaseConfig {
  const r = databaseSchema.safeParse(env);
  if (!r.success) throw toError(r.error);
  return r.data;
}

/** Parse Clerk configuration (ACBP-P1-001). Secret fields are redacted in validation errors. */
export function parseClerkConfig(env: EnvRecord): ClerkConfig {
  const r = clerkSchema.safeParse(env);
  if (!r.success) throw toError(r.error);
  return r.data;
}

/**
 * Deterministic Clerk config for tests using clearly-FAKE development placeholders (never real keys;
 * hyphenated so the secret scanner's key-format patterns cannot match).
 */
export function loadTestClerkConfig(env: EnvRecord = {}): ClerkConfig {
  return parseClerkConfig({
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'] ?? 'pk_test_fake-local-publishable',
    CLERK_SECRET_KEY: env['CLERK_SECRET_KEY'] ?? 'sk_test_fake-local-secret',
    ...(env['CLERK_JWT_KEY'] !== undefined ? { CLERK_JWT_KEY: env['CLERK_JWT_KEY'] } : {}),
    CLERK_AUTHORIZED_PARTIES: env['CLERK_AUTHORIZED_PARTIES'] ?? 'http://localhost:3000',
  });
}

/**
 * Deterministic database configuration for tests. Uses a clearly-fake local placeholder URL unless
 * ACBP_TEST_DATABASE_URL is provided (the developer/CI's own isolated, disposable database). No real
 * credentials are ever embedded here.
 */
export function loadTestDatabaseConfig(env: EnvRecord = process.env): DatabaseConfig {
  return parseDatabaseConfig({
    APP_ENV: 'test',
    DATABASE_URL: env['ACBP_TEST_DATABASE_URL'] ?? 'postgresql://acbp:acbp@localhost:5432/acbp_test',
    DATABASE_SSL: 'disable',
    DATABASE_APP_NAME: 'acbp-test',
  });
}

/** Deterministic, credential-free configuration for use in tests. */
export function loadTestConfig(): WebServerConfig {
  return parseWebServerConfig({
    APP_ENV: 'test',
    APP_PUBLIC_URL: 'http://localhost:3000',
    INFISICAL_CLIENT_ID: 'test-client-id',
    INFISICAL_CLIENT_SECRET: 'test-boot-0001',
    INFISICAL_ENVIRONMENT: 'test',
  });
}

// ---- loaders (read process.env at the composition boundary; fail fast) -----------------
export function loadPublicConfig(): PublicConfig {
  return parsePublicConfig(process.env);
}
export function loadWebServerConfig(): WebServerConfig {
  return parseWebServerConfig(process.env);
}
export function loadWorkerConfig(): WorkerConfig {
  return parseWorkerConfig(process.env);
}
export function loadBootstrapConfig(): BootstrapConfig {
  return parseBootstrapConfig(process.env);
}
/**
 * Read validated database configuration from process.env at the composition boundary. In
 * staging/production the DATABASE_* values are supplied by the runtime secret/config mechanism
 * (Infisical per ADR-021; the managed Postgres URL injected by the platform) — this loader only
 * reads whatever the composition root has placed in the environment. Fails fast on invalid input.
 */
export function loadDatabaseConfig(): DatabaseConfig {
  return parseDatabaseConfig(process.env);
}
/**
 * Read validated Clerk configuration from process.env at a trusted web/server composition boundary.
 * In staging/production the CLERK_* values are supplied by the runtime secret mechanism (Infisical per
 * ADR-021); this loader only reads what the composition root placed in the environment. Fails fast.
 */
export function loadClerkConfig(): ClerkConfig {
  return parseClerkConfig(process.env);
}
