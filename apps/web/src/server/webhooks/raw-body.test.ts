// ACBP-P1-002 Slice 3 — bounded raw-body reader tests (apps/web).
import { describe, test, expect } from 'vitest';
import { readLimitedRawBody, type RawBodyRequest } from './raw-body.js';

function fakeStream(chunks: readonly Uint8Array[], hooks: { onRead?: () => void; onCancel?: () => void } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return {
    getReader() {
      hooks.onRead?.();
      return {
        read: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined }),
        cancel: () => {
          hooks.onCancel?.();
          return Promise.resolve();
        },
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
}

function req(opts: {
  contentLength?: string;
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}): RawBodyRequest {
  const headers = new Headers();
  if (opts.contentLength !== undefined) headers.set('content-length', opts.contentLength);
  return {
    headers,
    body: opts.body ?? null,
    arrayBuffer: opts.arrayBuffer ?? (() => Promise.resolve(new ArrayBuffer(0))),
  };
}

describe('readLimitedRawBody', () => {
  test('an over-limit declared Content-Length is rejected as too_large WITHOUT reading the stream', async () => {
    let read = false;
    const r = await readLimitedRawBody(req({ contentLength: '1000', body: fakeStream([new Uint8Array([1])], { onRead: () => (read = true) }) }), 8);
    expect(r).toEqual({ ok: false, reason: 'too_large' });
    expect(read).toBe(false); // body never read
  });

  test('a stream within the limit reads byte-exact content (incl. high + NUL bytes)', async () => {
    const chunks = [new Uint8Array([0x7b, 0xff]), new Uint8Array([0x00, 0x7d])];
    const r = await readLimitedRawBody(req({ body: fakeStream(chunks) }), 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(Array.from(r.bytes)).toEqual([0x7b, 0xff, 0x00, 0x7d]);
  });

  test('a missing Content-Length within the limit is accepted', async () => {
    const r = await readLimitedRawBody(req({ body: fakeStream([new Uint8Array([1, 2, 3])]) }), 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(Array.from(r.bytes)).toEqual([1, 2, 3]);
  });

  test('a malformed Content-Length is rejected safely as invalid_length', async () => {
    const r = await readLimitedRawBody(req({ contentLength: 'not-a-number', body: fakeStream([new Uint8Array([1])]) }), 1024);
    expect(r).toEqual({ ok: false, reason: 'invalid_length' });
  });

  test('a stream that EXCEEDS the limit (no/under-declared length) aborts with too_large and cancels', async () => {
    let cancelled = false;
    const chunks = [new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([6, 7, 8, 9, 10])];
    const r = await readLimitedRawBody(req({ body: fakeStream(chunks, { onCancel: () => (cancelled = true) }) }), 8);
    expect(r).toEqual({ ok: false, reason: 'too_large' });
    expect(cancelled).toBe(true);
  });

  test('a null body falls back to arrayBuffer, still enforcing the limit', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const r = await readLimitedRawBody(req({ body: null, arrayBuffer: () => Promise.resolve(bytes.buffer) }), 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(Array.from(r.bytes)).toEqual([9, 8, 7]);
  });

  test('a null body whose arrayBuffer exceeds the limit is too_large', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const r = await readLimitedRawBody(req({ body: null, arrayBuffer: () => Promise.resolve(bytes.buffer) }), 8);
    expect(r).toEqual({ ok: false, reason: 'too_large' });
  });
});
