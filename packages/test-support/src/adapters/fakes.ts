// @acbp/test-support — deterministic fake provider adapters (ACBP-P0-019).
//
// These implement the provider-neutral contracts from @acbp/contracts WITHOUT any provider SDK,
// network call, or real credential. They are for contract/conformance tests only (test-support is
// never a production dependency — enforced by P0-012). Fakes are deterministic: identical inputs
// produce identical outputs, and inputs are never mutated.
//
// ⚠ THESE FAKES CANNOT FAIL, AND THAT IS DELIBERATE — THEY PROVE CONTRACT SHAPE, NOT BEHAVIOUR UNDER FAULT.
// `AlwaysSucceedsModelProvider` always reports `finishStatus: 'completed'` (its only non-success path is caller
// abort) and `NonFailingObjectStorage.put` has no failure mode at all. That is the right design for the
// conformance suite, which exercises correlation flow, cancellation, determinism, non-mutation and LIFECYCLE.
//
// IF YOU WANT TO INJECT A FAULT, YOU WANT `@acbp/adapters`:
//   • `FakeModelProvider`      — five normalized failures, `{ kind: 'hang', ms }` to drive a real deadline, and
//                                a `script[]` consumed one-per-call for retry / re-ask / fallback sequences.
//   • `InMemoryObjectStorage`  — `failNextPut` throws, `dropNextPut` reports success and stores NOTHING,
//                                `truncateNextPut` stores fewer bytes than it reports.
//
// ACBP-P7-008 RENAMED the two classes below. They were `FakeModelProvider` and `FakeObjectStorage`, and the
// first collided exactly with the adapters rig. An investigation hunting for the fault-injection machinery
// found THIS one, concluded no such machinery existed, and wrote that into CDR-084 and its pull request before
// slice 1 caught it. The names now state the limitation, and `tools/check-duplicate-exports.mjs` fails the
// build if any exported class name is ever again defined in two packages.
import { Secret } from '@acbp/config';
import { platformError } from '@acbp/contracts';
import type {
  AdapterCallOptions,
  AdapterLifecycle,
  GetObjectResult,
  HeadObjectResult,
  IdentityEvent,
  IdentityEventType,
  IdentityProvider,
  ModelProvider,
  ModelProviderRequest,
  ModelProviderResponse,
  NormalizedIdentity,
  ObjectMetadata,
  ObjectStorage,
  ObjectKey,
  PutObjectInput,
  SecretProvider,
  SecretRef,
  SecretResolution,
  SessionVerification,
} from '@acbp/contracts';

// ---- helpers ---------------------------------------------------------------------------
async function toBytes(body: PutObjectInput['body']): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Deterministic, non-cryptographic hash (djb2) for stable fake diagnostic ids. */
function stableHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function wordCount(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

function aborted(options?: AdapterCallOptions): boolean {
  return options?.signal?.aborted === true;
}

// ---- secret provider -------------------------------------------------------------------
export class FakeSecretProvider implements SecretProvider {
  private readonly store: ReadonlyMap<string, string>;
  private readonly available: boolean;

  constructor(entries: Readonly<Record<string, string>> = {}, options: { readonly available?: boolean } = {}) {
    this.store = new Map(Object.entries(entries));
    this.available = options.available ?? true;
  }

  resolve(ref: SecretRef, _options?: AdapterCallOptions): Promise<SecretResolution> {
    if (!this.available) {
      // Adapter absence / outage => fail closed (never returns a value).
      return Promise.resolve({ status: 'unavailable', error: platformError('provider_unavailable', { internalMessage: 'secret provider unavailable' }) });
    }
    const value = this.store.get(ref);
    if (value === undefined) {
      return Promise.resolve({ status: 'missing', error: platformError('not_found', { internalMessage: 'secret reference not found' }) });
    }
    return Promise.resolve({ status: 'resolved', value: new Secret(value) });
  }
}

// ---- identity provider -----------------------------------------------------------------
export class FakeIdentityProvider implements IdentityProvider {
  private readonly sessions: ReadonlyMap<string, NormalizedIdentity>;
  private readonly available: boolean;

  constructor(options: { readonly sessions?: Readonly<Record<string, NormalizedIdentity>>; readonly available?: boolean } = {}) {
    this.sessions = new Map(Object.entries(options.sessions ?? {}));
    this.available = options.available ?? true;
  }

  verifySession(token: string, _options?: AdapterCallOptions): Promise<SessionVerification> {
    if (!this.available) {
      return Promise.resolve({ status: 'unavailable', error: platformError('provider_unavailable', { internalMessage: 'identity provider unavailable' }) });
    }
    const identity = this.sessions.get(token);
    if (identity === undefined) {
      return Promise.resolve({ status: 'invalid', error: platformError('authn', { internalMessage: 'unknown or expired session token' }) });
    }
    return Promise.resolve({ status: 'valid', identity });
  }

  normalizeClaims(rawClaims: unknown): NormalizedIdentity {
    const c = (rawClaims ?? {}) as Record<string, unknown>;
    const email = typeof c['email'] === 'string' ? c['email'] : undefined;
    const emailVerified = typeof c['email_verified'] === 'boolean' ? c['email_verified'] : undefined;
    const displayName = typeof c['name'] === 'string' ? c['name'] : undefined;
    return {
      providerUserId: typeof c['sub'] === 'string' ? c['sub'] : '',
      ...(email !== undefined ? { email } : {}),
      ...(emailVerified !== undefined ? { emailVerified } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    };
  }

  parseEvent(rawEvent: unknown, _options?: AdapterCallOptions): Promise<IdentityEvent> {
    const e = (rawEvent ?? {}) as Record<string, unknown>;
    const type = e['type'];
    const allowed: readonly IdentityEventType[] = ['user.created', 'user.updated', 'user.deleted', 'session.revoked'];
    if (typeof type !== 'string' || !allowed.includes(type as IdentityEventType)) {
      return Promise.reject(platformError('validation', { internalMessage: 'unknown identity event type' }));
    }
    return Promise.resolve({
      type: type as IdentityEventType,
      eventId: typeof e['id'] === 'string' ? e['id'] : '',
      occurredAt: typeof e['occurred_at'] === 'string' ? e['occurred_at'] : '1970-01-01T00:00:00.000Z',
      identity: this.normalizeClaims(e['data']),
    });
  }
}

// ---- object storage --------------------------------------------------------------------
export class NonFailingObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, { readonly bytes: Uint8Array; readonly metadata: ObjectMetadata }>();

  async put(input: PutObjectInput, _options?: AdapterCallOptions): Promise<ObjectMetadata> {
    const bytes = await toBytes(input.body);
    const metadata: ObjectMetadata = {
      contentType: input.contentType,
      sizeBytes: bytes.length,
      ...(input.checksum !== undefined ? { checksum: input.checksum } : {}),
    };
    this.objects.set(input.key, { bytes, metadata });
    return metadata;
  }

  get(key: ObjectKey, _options?: AdapterCallOptions): Promise<GetObjectResult> {
    const found = this.objects.get(key);
    if (found === undefined) {
      return Promise.reject(platformError('not_found', { internalMessage: 'object not found' }));
    }
    return Promise.resolve({ metadata: found.metadata, body: found.bytes });
  }

  delete(key: ObjectKey, _options?: AdapterCallOptions): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  head(key: ObjectKey, _options?: AdapterCallOptions): Promise<HeadObjectResult> {
    const found = this.objects.get(key);
    return Promise.resolve(found === undefined ? { exists: false } : { exists: true, metadata: found.metadata });
  }
}

// ---- model provider --------------------------------------------------------------------
export class AlwaysSucceedsModelProvider implements ModelProvider, AdapterLifecycle {
  private started = false;

  init(_options?: AdapterCallOptions): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  shutdown(_options?: AdapterCallOptions): Promise<void> {
    this.started = false;
    return Promise.resolve();
  }

  get isStarted(): boolean {
    return this.started;
  }

  generate(request: ModelProviderRequest, options?: AdapterCallOptions): Promise<ModelProviderResponse> {
    if (aborted(options)) {
      // Cancellation is a normalized failure — never a raw provider/abort error.
      return Promise.reject(platformError('internal', { internalMessage: 'model generation aborted by caller' }));
    }
    const joined = request.messages.map((m) => `${m.role}:${m.content}`).join('\n');
    const inputTokens = request.messages.reduce((sum, m) => sum + wordCount(m.content), 0);
    const output = `echo:${stableHash(joined)}`;
    const outputTokens = wordCount(output);
    return Promise.resolve({
      finishStatus: 'completed',
      output,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      modelVersion: `${request.modelId}@fake-1`,
      latencyMs: 0,
      providerRequestId: `fake-${stableHash(joined)}`,
    });
  }
}
