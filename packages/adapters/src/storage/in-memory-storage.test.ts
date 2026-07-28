// ACBP-P5-011 — the in-memory object storage (CDR-060 §4). The FakeModelProvider pattern, applied to storage.
//
// The interesting capability here is not `put`/`get`. It is {@link InMemoryObjectStorage.dropNextPut}: a provider
// that returns plausible success metadata and stores NOTHING. Without a fixture that can lie, a test asserting "the
// artifact row is only written after the object is really there" passes whether or not the verification exists — the
// fixtures-agree-with-the-bug failure this repo has hit repeatedly.
import { describe, test, expect } from 'vitest';
import { toObjectKey } from '@acbp/contracts';
import { InMemoryObjectStorage } from './in-memory-storage.js';

const KEY = toObjectKey('company/aaaa/artifacts/hash/content.md');
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Chunks arrive awaited, the way a real stream delivers them — not all at once from a synchronous array. */
async function* stream(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield await Promise.resolve(bytes(c));
}

describe('put / get / head / delete', () => {
  test('stores bytes and reports honest metadata', async () => {
    const storage = new InMemoryObjectStorage();
    const meta = await storage.put({ key: KEY, body: bytes('hello'), contentType: 'text/markdown' });
    expect(meta).toEqual({ contentType: 'text/markdown', sizeBytes: 5 });
    expect(await storage.head(KEY)).toEqual({ exists: true, metadata: { contentType: 'text/markdown', sizeBytes: 5 } });
    const got = await storage.get(KEY);
    expect(new TextDecoder().decode(got.body as Uint8Array)).toBe('hello');
  });

  test('a streamed body is fully drained before the size is reported', async () => {
    // A provider that reported the size of the first chunk would silently truncate. The size must describe what was
    // actually stored.
    const storage = new InMemoryObjectStorage();
    const meta = await storage.put({ key: KEY, body: stream('abc', 'de'), contentType: 'text/plain' });
    expect(meta.sizeBytes).toBe(5);
    expect(new TextDecoder().decode((await storage.get(KEY)).body as Uint8Array)).toBe('abcde');
  });

  test('head on a missing key reports absence rather than throwing', async () => {
    expect(await new InMemoryObjectStorage().head(KEY)).toEqual({ exists: false });
  });

  test('get on a missing key throws — a caller asking for bytes that are not there must not receive empty ones', async () => {
    await expect(new InMemoryObjectStorage().get(KEY)).rejects.toThrow();
  });

  test('delete removes the object and is idempotent', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.put({ key: KEY, body: bytes('x'), contentType: 'text/plain' });
    await storage.delete(KEY);
    expect(await storage.head(KEY)).toEqual({ exists: false });
    await expect(storage.delete(KEY)).resolves.toBeUndefined();
  });

  test('re-putting the same key with the same bytes is a no-op in effect — content addressing depends on it', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.put({ key: KEY, body: bytes('same'), contentType: 'text/markdown' });
    await storage.put({ key: KEY, body: bytes('same'), contentType: 'text/markdown' });
    expect(storage.keys()).toEqual([KEY as string]);
  });
});

describe('the failure injections that let a test prove a guard exists', () => {
  test('failNextPut makes exactly the next put throw, and stores nothing', async () => {
    const storage = new InMemoryObjectStorage();
    storage.failNextPut('provider unavailable');
    await expect(storage.put({ key: KEY, body: bytes('x'), contentType: 'text/plain' })).rejects.toThrow();
    expect(await storage.head(KEY)).toEqual({ exists: false });
    // Exactly one: the arming is consumed, so a test cannot accidentally poison the rest of its own run.
    await expect(storage.put({ key: KEY, body: bytes('x'), contentType: 'text/plain' })).resolves.toBeDefined();
  });

  test('dropNextPut RETURNS SUCCESS and stores nothing — the lying provider', async () => {
    // This is the hollow success at its source. A caller that believes `put`'s return value now has a key pointing
    // at nothing, and only a read-back can tell the difference.
    const storage = new InMemoryObjectStorage();
    storage.dropNextPut();
    const meta = await storage.put({ key: KEY, body: bytes('hello'), contentType: 'text/markdown' });
    expect(meta).toEqual({ contentType: 'text/markdown', sizeBytes: 5 });
    expect(await storage.head(KEY)).toEqual({ exists: false });
  });

  test('truncateNextPut stores FEWER bytes than it reports — a partial write that claims to be whole', async () => {
    const storage = new InMemoryObjectStorage();
    storage.truncateNextPut(2);
    const meta = await storage.put({ key: KEY, body: bytes('hello'), contentType: 'text/markdown' });
    expect(meta.sizeBytes).toBe(5);
    const head = await storage.head(KEY);
    expect(head.exists && head.metadata.sizeBytes).toBe(2);
  });
});
