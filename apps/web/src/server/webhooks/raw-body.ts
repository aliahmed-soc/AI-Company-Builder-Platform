// ACBP-P1-002 Slice 3 — bounded, byte-exact raw-body reader for the webhook Route Handler (apps/web).
//
// Preserves the EXACT request bytes (no decode/re-encode) for signature verification + payload SHA-256,
// and enforces a hard size cap two ways: reject an over-limit declared Content-Length BEFORE reading,
// and independently count bytes while streaming (never trust Content-Length alone). Never logs the body
// and never derives any payload identifier here (that happens only after verification, in the adapter).
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024; // 256 KiB

export type RawBodyResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'too_large' | 'invalid_length' | 'read_error' };

/** Minimal structural view of the parts of a web Request this reader touches (keeps tests trivial). */
export interface RawBodyRequest {
  readonly headers: Pick<Headers, 'get'>;
  readonly body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export async function readLimitedRawBody(request: RawBodyRequest, maxBytes: number = MAX_WEBHOOK_BODY_BYTES): Promise<RawBodyResult> {
  // (1) Reject an over-limit / malformed declared Content-Length before reading a single byte.
  const declared = request.headers.get('content-length');
  if (declared !== null && declared !== undefined) {
    const trimmed = declared.trim();
    if (!/^\d+$/.test(trimmed)) return { ok: false, reason: 'invalid_length' };
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n)) return { ok: false, reason: 'invalid_length' };
    if (n > maxBytes) return { ok: false, reason: 'too_large' };
  }

  // (2) No stream available: fall back to arrayBuffer, still enforcing the limit.
  const body = request.body;
  if (body === null) {
    try {
      const buf = new Uint8Array(await request.arrayBuffer());
      if (buf.byteLength > maxBytes) return { ok: false, reason: 'too_large' };
      return { ok: true, bytes: buf };
    } catch {
      return { ok: false, reason: 'read_error' };
    }
  }

  // (3) Stream, counting bytes independently and aborting as soon as the limit is exceeded.
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return { ok: false, reason: 'too_large' };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { ok: false, reason: 'read_error' };
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: out };
}
