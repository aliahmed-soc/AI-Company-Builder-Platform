// ACBP-P6-008 — the Decision Room live channel: GET /api/companies/{companyId}/decision-room/stream (DEC-001).
//
// Transport only. Every decision about what is emitted, when, and when to stop lives in
// `@/server/companies/decision-room-stream`, which is tested without a socket.
//
// THE STREAM IS NEVER OPENED FOR AN UNAUTHORIZED CALLER. The first read happens BEFORE any 200 is written, so
// an unauthenticated or non-member caller receives the ordinary 401/403 JSON envelope. Answering "200, here is
// an event stream" and then closing it would turn an authorization failure into something a client can only
// interpret as a network problem.
import {
  clampStreamIntervalMs,
  DECISION_ROOM_STREAM_MAX_LIFETIME_MS,
} from '@acbp/contracts';
import { getDecisionRoomForRequest } from '@/server/companies/companies-request';
import { toCompaniesResponse } from '@/server/companies/companies-http';
import { decisionRoomStreamEvents } from '@/server/companies/decision-room-stream';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_PARAMS = new Set(['intervalMs']);

export async function GET(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  }

  const read = (): ReturnType<typeof getDecisionRoomForRequest> => getDecisionRoomForRequest(companyId);

  // The gate: authorize first, stream second.
  let first;
  try {
    first = await read();
  } catch {
    return new Response(JSON.stringify(genericErrorBody(500)), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  if (first.status !== 'decision_room') return toCompaniesResponse(first);

  const intervalMs = clampStreamIntervalMs(params.get('intervalMs') ?? undefined);
  const encoder = new TextEncoder();
  // Two ways a connection ends from the client side: the request is aborted, or the consumer cancels the body.
  // Both must stop the loop — a generator still polling the database for a reader that has gone is exactly the
  // leak this bound exists to prevent.
  const closed = new AbortController();
  const signal = AbortSignal.any([request.signal, closed.signal]);

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const events = decisionRoomStreamEvents(
        {
          read,
          // Resolves EARLY on client disconnect so a closed tab does not hold a database read slot for a
          // full interval.
          wait: (ms) =>
            new Promise<void>((resolve) => {
              const timer = setTimeout(finish, ms);
              function finish(): void {
                clearTimeout(timer);
                signal.removeEventListener('abort', finish);
                resolve();
              }
              signal.addEventListener('abort', finish, { once: true });
            }),
          now: () => Date.now(),
          aborted: () => signal.aborted,
        },
        { intervalMs, maxLifetimeMs: DECISION_ROOM_STREAM_MAX_LIFETIME_MS },
      );
      try {
        for await (const chunk of events) {
          if (signal.aborted) break;
          controller.enqueue(encoder.encode(chunk));
        }
      } catch {
        // A broken pipe is not an error worth reporting to a client that is already gone.
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      closed.abort();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // `no-transform` matters as much as `no-cache`: a compressing proxy will buffer an event stream.
      'cache-control': 'no-cache, no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
