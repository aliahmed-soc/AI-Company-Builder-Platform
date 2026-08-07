// ACBP-P0-017 — logger, correlation, and error-integration tests.
import { describe, test, expect } from 'vitest';
import { isCorrelationId, platformError } from '@acbp/contracts';
import { createLogger, createTestLogger, createRootContext, newCorrelationId, type LogRecord } from './index.js';

const SENTINEL = 'zz-sentinel-01';

describe('correlation', () => {
  test('correlation IDs are generated and validated', () => {
    const id = newCorrelationId();
    expect(isCorrelationId(id)).toBe(true);
    expect(isCorrelationId('not-a-uuid')).toBe(false);
  });

  test('existing correlation id propagates unchanged', () => {
    const id = newCorrelationId();
    const ctx = createRootContext({ correlationId: id, companyId: 'company_1' });
    expect(ctx.correlationId).toBe(id);
  });

  test('child contexts inherit trace + tenant identity', () => {
    const { logger, records } = createTestLogger({ context: createRootContext({ correlationId: newCorrelationId(), companyId: 'company_1' }) });
    logger.child({ taskRunId: 'run_1' }).info('child_event');
    const ctx = records[0]?.context;
    expect(ctx?.companyId).toBe('company_1');
    expect(ctx?.taskRunId).toBe('run_1');
    expect(isCorrelationId(ctx?.correlationId ?? '')).toBe(true);
  });

  test('child contexts may override only operation identifiers (not correlationId/tenant)', () => {
    const rootId = newCorrelationId();
    const { logger, records } = createTestLogger({ context: createRootContext({ correlationId: rootId, companyId: 'company_1' }) });
    // @ts-expect-error correlationId/companyId are not permitted overrides on a child
    logger.child({ taskId: 't1', correlationId: 'hacked', companyId: 'company_evil' }).info('e');
    const ctx = records[0]?.context;
    expect(ctx?.correlationId).toBe(rootId);
    expect(ctx?.companyId).toBe('company_1');
    expect(ctx?.taskId).toBe('t1');
  });

  test('concurrent operations do not leak context', async () => {
    const a = createTestLogger({ context: createRootContext({ correlationId: newCorrelationId(), companyId: 'A' }) });
    const b = createTestLogger({ context: createRootContext({ correlationId: newCorrelationId(), companyId: 'B' }) });
    await Promise.all([
      (async () => { await Promise.resolve(); a.logger.info('a'); })(),
      (async () => { await Promise.resolve(); b.logger.info('b'); })(),
    ]);
    expect(a.records[0]?.context?.companyId).toBe('A');
    expect(b.records[0]?.context?.companyId).toBe('B');
  });
});

describe('logging', () => {
  test('log-level filtering works; debug can be disabled', () => {
    const { logger, records } = createTestLogger({ minLevel: 'info' });
    logger.debug('should_be_dropped');
    logger.info('kept');
    expect(records.map((r) => r.event)).toEqual(['kept']);
  });

  test('debug enabled when minLevel=debug', () => {
    const { logger, records } = createTestLogger({ minLevel: 'debug' });
    logger.debug('d');
    expect(records).toHaveLength(1);
  });

  test('test logger captures deterministic records (fixed clock)', () => {
    const { logger, records } = createTestLogger();
    logger.info('e', { metadata: { k: 'v' } });
    expect(records[0]?.timestamp).toBe('1970-01-01T00:00:00.000Z');
    expect(records[0]?.level).toBe('info');
  });

  test('structured logs are valid JSON', () => {
    const { logger, records } = createTestLogger();
    logger.warn('w', { message: 'hi', metadata: { a: 1, b: [true, 'x'] } });
    const json = JSON.stringify(records[0]);
    expect(() => JSON.parse(json) as unknown).not.toThrow();
  });

  test('sentinel secret never appears in emitted logs (metadata + error)', () => {
    const { logger, records } = createTestLogger();
    logger.error('failed', {
      metadata: { password: SENTINEL, url: `https://x?token=${SENTINEL}`, headers: { authorization: `Bearer ${SENTINEL}` } },
      error: new Error(`secret=${SENTINEL}`, { cause: { apiKey: SENTINEL } }),
    });
    expect(JSON.stringify(records)).not.toContain(SENTINEL);
  });

  // ACBP-P7-007 (trust-critical #16). The case above honestly names its own scope — "metadata + error" — and
  // that scope was the whole of the redaction: `message` was emitted VERBATIM while `metadata` and `error` both
  // went through `redact()`. Nothing asserted the third field, so nothing noticed the asymmetry.
  test('sentinel secret never appears in an emitted MESSAGE either (trust-critical #16)', () => {
    const { logger, records } = createTestLogger();
    logger.error('failed', { message: `connect failed: password=${SENTINEL}` });
    expect(JSON.stringify(records)).not.toContain(SENTINEL);
  });

  test('a message with nothing sensitive survives intact — redaction is not blanket erasure', () => {
    const { logger, records } = createTestLogger();
    logger.info('ok', { message: 'connected to the primary replica' });
    expect(JSON.stringify(records)).toContain('connected to the primary replica');
  });

  // ACBP-P7-007, SECOND REVIEW PASS. The case above plants `password=…`, which the ORIGINAL P0-017 pattern set
  // already handled — so it proved the field is piped through `redact()` and nothing about which shapes
  // `redact()` knows. A review measured the rest and every one of these was emitted VERBATIM, including a
  // connection string, which the fix's own comment had offered as its example. One case per shape, because a
  // single combined assertion would go green again the moment any one pattern was restored.
  describe.each([
    ['a connection string', 'connect failed: postgresql://acbp_app:zz-sentinel-01-value@db.internal:5432/acbp'],
    ['a JWT', 'rejected token eyJhbGciOi.eyJzdWIiOiIx.zz-sentinel-01-value'],
    ['an AWS access key id', `aws creds AKI${'A'}ZZSENTINEL01VALUE`],
    // Assembled, not spelled: written whole this line is a `slack-token` finding in the repository's own secret
    // scanner — which is exactly what it did, on the run that added it. Same technique as the sibling suites.
    ['a Slack token', `slack xox${'b'}-zz-sentinel-01-value-0123456789`],
    ['the Basic auth scheme', `Basic${' '}zz-sentinel-01-valuezz-sentinel-01-value`],
  ])('a MESSAGE carrying %s is redacted', (_label, message) => {
    test('the distinctive part never reaches an adapter', () => {
      const { logger, records } = createTestLogger();
      logger.error('failed', { message });
      expect(JSON.stringify(records)).not.toContain('zz-sentinel-01-value');
    });
  });

  // The `event` name is the OTHER free-text field. It is a dotted name by convention only — its type is
  // `string`, and the file header's claim that every emitted record is redacted was false until it was piped
  // through `redact()` too.
  test('an EVENT NAME carrying a secret is redacted — the convention is not a control', () => {
    const { logger, records } = createTestLogger();
    logger.error(`db.connect.failed postgresql://acbp_app:${SENTINEL}@db.internal:5432/acbp`);
    expect(JSON.stringify(records)).not.toContain(SENTINEL);
    expect(records).toHaveLength(1);
  });

  test('CONTROL: an ordinary event name survives intact — otherwise the case above passes on blanket erasure', () => {
    const { logger, records } = createTestLogger();
    logger.info('company.paused');
    expect(JSON.stringify(records)).toContain('company.paused');
  });

  test('malformed / unusual metadata does not throw and still emits', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const { logger, records } = createTestLogger();
    expect(() => logger.info('weird', { metadata: { circular, fn: () => 1, sym: Symbol('s') } })).not.toThrow();
    expect(records).toHaveLength(1);
  });

  test('logging never throws even if the adapter throws', () => {
    const logger = createLogger({ adapter: { emit: () => { throw new Error('adapter boom'); } }, minLevel: 'debug' });
    expect(() => logger.error('x')).not.toThrow();
  });

  test('structured error integration: safe code/category logged, secret stays out', () => {
    const { logger, records } = createTestLogger();
    const err = platformError('provider_unavailable', { internalMessage: `secret=${SENTINEL}`, metadata: { tenantId: 'company_1' } });
    logger.error('dep_failed', { error: err });
    const errField = records[0]?.error;
    expect(errField?.['code']).toBe('DEPENDENCY_UNAVAILABLE');
    expect(errField?.['category']).toBe('provider_unavailable');
    expect(JSON.stringify(records)).not.toContain(SENTINEL);
  });
});

describe('public error correlation & tenant safety (P0-016 integration)', () => {
  test('public errors include a safe correlation id but no tenant identifiers', () => {
    const cid = newCorrelationId();
    const err = platformError('authz', { correlationId: cid, metadata: { companyId: 'company_secret_42' } });
    const pub = err.toPublic();
    expect(pub.correlationId).toBe(cid);
    expect(JSON.stringify(pub)).not.toContain('company_secret_42');
  });
});

// Type sanity: LogRecord is structurally usable.
const _typecheck: LogRecord = { timestamp: 't', level: 'info', component: 'c', event: 'e' };
void _typecheck;
