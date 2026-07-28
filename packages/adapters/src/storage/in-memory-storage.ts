// @acbp/adapters — in-memory object storage (ACBP-P5-011; CDR-060 §4; ADR-016).
//
// The FakeModelProvider pattern applied to storage. CDR-060 §4 is explicit that the CONCRETE provider adapter is an
// owner gate — a live bucket and real credentials — and that what this ticket can honestly prove today is the
// SEMANTICS around storage: prefix isolation, content addressing, and TASK-005's no-hollow-success rule. This is the
// implementation those proofs run against.
//
// It also does something a real provider does not: it can LIE. `dropNextPut` returns plausible success metadata and
// stores nothing, and `truncateNextPut` stores fewer bytes than it reports. Those exist because a test asserting
// "the artifact row is written only after the object is really there" is worthless if the fixture cannot produce an
// object that is not really there.
//
// NOT FOR PRODUCTION USE. It holds every object in a process-local Map.
import type { AdapterCallOptions, GetObjectResult, HeadObjectResult, ObjectBody, ObjectKey, ObjectMetadata, ObjectStorage, PutObjectInput } from '@acbp/contracts';

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** Drain a body to bytes. An `AsyncIterable` must be drained FULLY before a size can honestly be reported. */
async function readBody(body: ObjectBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export class InMemoryObjectStorage implements ObjectStorage {
  readonly #objects = new Map<string, StoredObject>();
  #failNext: string | undefined;
  #dropNext = false;
  #truncateNext: number | undefined;

  /** Arm exactly ONE failing put. Single-shot so a test cannot accidentally poison the rest of its own run. */
  failNextPut(message: string): void {
    this.#failNext = message;
  }

  /** Arm exactly one put that REPORTS SUCCESS and stores nothing — the hollow success at its source. */
  dropNextPut(): void {
    this.#dropNext = true;
  }

  /** Arm exactly one put that stores `bytes` bytes while reporting the full size — a partial write claiming to be whole. */
  truncateNextPut(bytes: number): void {
    this.#truncateNext = bytes;
  }

  async put(input: PutObjectInput, _options?: AdapterCallOptions): Promise<ObjectMetadata> {
    const failure = this.#failNext;
    this.#failNext = undefined;
    if (failure !== undefined) throw new Error(failure);

    const bytes = await readBody(input.body);
    const metadata: ObjectMetadata = input.checksum === undefined ? { contentType: input.contentType, sizeBytes: bytes.byteLength } : { contentType: input.contentType, sizeBytes: bytes.byteLength, checksum: input.checksum };

    const drop = this.#dropNext;
    this.#dropNext = false;
    const truncate = this.#truncateNext;
    this.#truncateNext = undefined;

    if (!drop) {
      const stored = truncate === undefined ? bytes : bytes.slice(0, truncate);
      this.#objects.set(input.key, { bytes: stored, contentType: input.contentType });
    }
    // The METADATA describes what was asked for, not what landed. That is precisely the gap a caller must not trust.
    return metadata;
  }

  get(key: ObjectKey, _options?: AdapterCallOptions): Promise<GetObjectResult> {
    const found = this.#objects.get(key);
    // REJECTING rather than returning empty bytes: a caller asking for content that is not there must not receive a
    // plausible-looking empty document. Rejecting (not throwing synchronously) so it behaves like a real provider.
    if (found === undefined) return Promise.reject(new Error('object not found'));
    return Promise.resolve({ metadata: { contentType: found.contentType, sizeBytes: found.bytes.byteLength }, body: found.bytes });
  }

  delete(key: ObjectKey, _options?: AdapterCallOptions): Promise<void> {
    this.#objects.delete(key);
    return Promise.resolve();
  }

  head(key: ObjectKey, _options?: AdapterCallOptions): Promise<HeadObjectResult> {
    const found = this.#objects.get(key);
    if (found === undefined) return Promise.resolve({ exists: false });
    return Promise.resolve({ exists: true, metadata: { contentType: found.contentType, sizeBytes: found.bytes.byteLength } });
  }

  /** Test inspection: every key currently stored. */
  keys(): readonly string[] {
    return [...this.#objects.keys()];
  }
}
