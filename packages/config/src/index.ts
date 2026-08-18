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
 * Which database role a connection uses (ACBP-P1-006; CDR-013). `owner` = the migration/owner role
 * (`DATABASE_URL`) used ONLY by migrations and explicit administrative setup; `app` = the restricted,
 * non-owner, NOBYPASSRLS application role (`DATABASE_APP_URL`) used for all ordinary runtime traffic. The
 * two URLs are never interchanged and the app path never silently falls back to the owner URL.
 */
export type DatabaseRole = 'owner' | 'app';

/**
 * Validated, server-only PostgreSQL access configuration (ACBP-P0-018; ADR-020).
 * `url` is wrapped in {@link Secret} — it carries credentials and must never be logged or returned
 * to clients. Production defaults are safe (SSL required) rather than development-convenient.
 */
export interface DatabaseConfig {
  readonly appEnv: AppEnv;
  /** Which role this connection uses (ACBP-P1-006; CDR-013): `owner` (migrations) or `app` (runtime). */
  readonly role: DatabaseRole;
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

/**
 * Validated Clerk WEBHOOK configuration (ACBP-P1-002; ADR-022 §13, CDR-007/008). Kept separate from
 * {@link ClerkConfig} (CDR-008 #6): it is loaded only on the webhook composition path. The signing
 * secret is server-only, {@link Secret}-wrapped, and never exposed via NEXT_PUBLIC. The optional
 * expected instance id is a non-secret guard the verifier may check against the event `instance_id`.
 */
export interface ClerkWebhookConfig {
  /** Server-only webhook signing secret (whsec_…). Redacted everywhere; revealed only at verify time. */
  readonly signingSecret: Secret;
  /** Optional expected provider instance id; when set, the verifier rejects events from other instances. */
  readonly expectedInstanceId?: string;
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
// ANTHROPIC_API_KEY joins this set in the SAME commit that introduces it (ACBP-API-006; CDR-091 §4). Membership
// here is what makes a value redacted in config errors and diagnostics; a provider credential added to the schema
// but not to this set would be a key that leaks through the one surface built to describe misconfiguration.
const SECRET_FIELDS = new Set(['INFISICAL_CLIENT_SECRET', 'DATABASE_URL', 'DATABASE_APP_URL', 'CLERK_SECRET_KEY', 'CLERK_JWT_KEY', 'CLERK_WEBHOOK_SIGNING_SECRET', 'ANTHROPIC_API_KEY']);

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

// Clerk webhook config (ACBP-P1-002). Signing secret is server-only + Secret-wrapped + redacted.
const clerkWebhookSchema = z
  .object({
    CLERK_WEBHOOK_SIGNING_SECRET: z.preprocess(
      emptyToUndef,
      z.string({ required_error: 'required (missing or empty)' }).regex(/^whsec_/, 'must be a Clerk webhook signing secret (whsec_…)'),
    ),
    CLERK_WEBHOOK_INSTANCE_ID: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  })
  .transform((o) => ({
    signingSecret: new Secret(o.CLERK_WEBHOOK_SIGNING_SECRET),
    ...(o.CLERK_WEBHOOK_INSTANCE_ID !== undefined ? { expectedInstanceId: o.CLERK_WEBHOOK_INSTANCE_ID } : {}),
  }));

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

/**
 * Parse validated database configuration for a specific role (ACBP-P1-006; CDR-013). The connection URL
 * is selected STRICTLY by role — `owner` reads `DATABASE_URL`, `app` reads `DATABASE_APP_URL` — with NO
 * silent fallback between them: an `app` config whose `DATABASE_APP_URL` is missing/empty fails closed
 * (rather than borrowing the owner URL). Both URLs are SECRET_FIELDS, so validation errors are redacted.
 */
export function parseDatabaseConfig(env: EnvRecord, opts: { role?: DatabaseRole } = {}): DatabaseConfig {
  const role = opts.role ?? 'owner';
  const urlVar = role === 'app' ? 'DATABASE_APP_URL' : 'DATABASE_URL';
  // Feed the role-selected URL into the schema's DATABASE_URL slot; the OTHER url variable is ignored, so
  // the two can never be interchanged and the app path cannot inherit the owner URL.
  const normalized: EnvRecord = { ...env, DATABASE_URL: env[urlVar] };
  const r = databaseSchema.safeParse(normalized);
  if (!r.success) {
    // Re-label the DATABASE_URL field as the role's actual variable so the error names the right knob.
    const issues = r.error.issues.map((i) => ({
      field: String(i.path[0]) === 'DATABASE_URL' ? urlVar : i.path.join('.') || '(root)',
      message: SECRET_FIELDS.has(String(i.path[0]) === 'DATABASE_URL' ? urlVar : String(i.path[0])) ? 'invalid (redacted)' : i.message,
    }));
    throw new ConfigValidationError(issues);
  }
  return { ...r.data, role };
}

/** Parse Clerk configuration (ACBP-P1-001). Secret fields are redacted in validation errors. */
export function parseClerkConfig(env: EnvRecord): ClerkConfig {
  const r = clerkSchema.safeParse(env);
  if (!r.success) throw toError(r.error);
  return r.data;
}

/** Parse Clerk webhook configuration (ACBP-P1-002). The signing secret is redacted in errors. */
export function parseClerkWebhookConfig(env: EnvRecord): ClerkWebhookConfig {
  const r = clerkWebhookSchema.safeParse(env);
  if (!r.success) throw toError(r.error);
  return r.data;
}

/**
 * Validated MODEL-PROVIDER configuration (ACBP-API-006; CDR-091 §4).
 *
 * Kept separate from every other config the way `ClerkWebhookConfig` is: it loads only on the composition path
 * that builds a paid model gateway, so a deployment that never generates does not have to hold a provider key.
 */
export interface ModelProviderConfig {
  /** Server-only Anthropic API key. {@link Secret}-wrapped; revealed only when constructing the SDK client. */
  readonly apiKey: Secret;
  /** The configuration-bound model id (ADR-019: model selection is config, never derived at runtime). */
  readonly modelId: string;
}

const modelProviderSchema = z
  .object({
    // No format assertion beyond non-empty. A prefix check would encode today's key shape into config validation
    // and reject a perfectly valid future key format — an outage caused by a guess about someone else's namespace.
    ANTHROPIC_API_KEY: requiredString,
    ANTHROPIC_MODEL_ID: z.preprocess((v) => (v === '' || v === undefined ? 'claude-opus-5' : v), z.string().min(1)),
  })
  .transform((o) => ({ apiKey: new Secret(o.ANTHROPIC_API_KEY), modelId: o.ANTHROPIC_MODEL_ID }));

/**
 * Parse model-provider configuration. The API key is redacted in validation errors (it is in `SECRET_FIELDS`).
 *
 * THROWS when the key is absent — deliberately, and at STARTUP rather than on the first paid call (CDR-090 §1-G3,
 * CDR-091 §4). A gateway that constructed itself without a credential would fail once per request, at the moment a
 * founder was waiting for a generation, instead of once at boot where an operator can see it.
 */
export function parseModelProviderConfig(env: EnvRecord): ModelProviderConfig {
  const r = modelProviderSchema.safeParse(env);
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
 * Deterministic Clerk webhook config for tests using a clearly-FAKE signing secret (never a real
 * whsec_; hyphenated so the secret scanner's key-format patterns cannot match).
 */
export function loadTestClerkWebhookConfig(env: EnvRecord = {}): ClerkWebhookConfig {
  return parseClerkWebhookConfig({
    CLERK_WEBHOOK_SIGNING_SECRET: env['CLERK_WEBHOOK_SIGNING_SECRET'] ?? 'whsec_fake-local-webhook-signing',
    ...(env['CLERK_WEBHOOK_INSTANCE_ID'] !== undefined ? { CLERK_WEBHOOK_INSTANCE_ID: env['CLERK_WEBHOOK_INSTANCE_ID'] } : {}),
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
  return parseDatabaseConfig(process.env, { role: 'owner' });
}
/**
 * Read the RESTRICTED APPLICATION database configuration (ACBP-P1-006; CDR-013) from process.env at the
 * runtime composition boundary. Uses `DATABASE_APP_URL` (the non-owner, NOBYPASSRLS `acbp_app` connection)
 * and fails fast if it is missing — normal runtime traffic must NEVER use the owner/migration connection,
 * and there is no fallback from the app URL to the owner URL.
 */
export function loadAppDatabaseConfig(): DatabaseConfig {
  return parseDatabaseConfig(process.env, { role: 'app' });
}
/**
 * Read validated Clerk configuration from process.env at a trusted web/server composition boundary.
 * In staging/production the CLERK_* values are supplied by the runtime secret mechanism (Infisical per
 * ADR-021); this loader only reads what the composition root placed in the environment. Fails fast.
 */
export function loadClerkConfig(): ClerkConfig {
  return parseClerkConfig(process.env);
}
/**
 * Read validated Clerk webhook configuration from process.env at the webhook composition boundary.
 * In staging/production the CLERK_WEBHOOK_* values come from the runtime secret mechanism (ADR-021).
 * Fails fast if the signing secret is missing/invalid. (ACBP-P1-002.)
 */
export function loadClerkWebhookConfig(): ClerkWebhookConfig {
  return parseClerkWebhookConfig(process.env);
}

// Usage caps: CDR-008's interim per-company and per-account spend ceilings and the soft-alert threshold
// (ACBP-P6-010; CDR-075 §4). INTERIM — CDR-008 §21 binds a mandatory revisit at first alpha telemetry.
export * from './usage-caps.js';

// API request limits: CDR-008 §8's FIRST layer — per-session and per-account request ceilings (ACBP-P7-013;
// CDR-082; NFR-010). A DIFFERENT limit from the caps above: frequency, not money (CDR-082 §5). Same INTERIM
// standing and the same CDR-008 §21 revisit trigger.
export * from './rate-limits.js';
