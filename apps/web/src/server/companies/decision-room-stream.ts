// ACBP-P6-008 — the Decision Room live channel (DEC-001 "live updates"), as a pure event generator.
//
// The transport (Response/ReadableStream) lives in the route; everything that decides WHAT is emitted lives
// here so it can be tested without HTTP, a socket or a clock. Three properties are the reason this file is
// separate from the route at all:
//
//  1. RE-AUTHORIZATION ON EVERY TICK. The loop does not capture an authorized snapshot and then trust it for
//     five minutes. Each tick calls the SAME authorized request path a plain GET uses, so a membership
//     revoked mid-stream stops the stream on the next tick instead of continuing to feed a former member.
//     A long-lived connection is the easiest place in a system to accidentally build a permission that
//     outlives its grant, which is exactly what this loop refuses to do.
//  2. NO PAYLOAD ON THE WIRE. Events carry the digest and the per-queue counts only. A stream that shipped
//     item content would turn one authorization check into an open-ended content feed.
//  3. IT ALWAYS ENDS. Bounded lifetime, and every exit path emits a terminal `closed` event naming its
//     reason — a stream that just stops is indistinguishable to a browser from a network fault, and "the
//     room went quiet" must never be the way a founder learns their access changed.
import {
  clampStreamIntervalMs,
  streamCountsOf,
  DECISION_ROOM_STREAM_MAX_LIFETIME_MS,
  type DecisionRoomStreamEvent,
  type DecisionRoomView,
} from '@acbp/contracts';
import type { CompaniesRequestResult } from './companies-request.js';

/** Why a stream ended. Coarse ON PURPOSE: `unauthorized` never distinguishes "not a member" from "not allowed". */
export type StreamCloseReason = 'max_lifetime' | 'unauthorized' | 'unavailable' | 'client';

export interface DecisionRoomStreamDeps {
  /** The authorized read — the same one the plain GET uses. Called ONCE PER TICK, never cached. */
  readonly read: () => Promise<CompaniesRequestResult>;
  /** Sleep that resolves early when the client goes away. Injected so tests need no real time. */
  readonly wait: (ms: number) => Promise<void>;
  /** Monotonic-enough clock for the lifetime bound. */
  readonly now: () => number;
  /** True once the client has disconnected. */
  readonly aborted: () => boolean;
}

export interface DecisionRoomStreamOptions {
  readonly intervalMs?: unknown;
  readonly maxLifetimeMs?: number;
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function roomEvent(room: DecisionRoomView, intervalMs: number): DecisionRoomStreamEvent {
  return {
    // Stated in every message, not just the docs: the client is told it is being polled on its behalf, so no
    // consumer can build on a push guarantee this system does not provide (CDR-076 §3-G6).
    deliveryMode: 'poll_backed',
    intervalSeconds: intervalMs / 1000,
    asOf: room.asOf,
    digest: room.digest,
    counts: streamCountsOf(room.sections),
  };
}

/**
 * The event sequence for one connection.
 *
 * Emits an immediate `room` event (so a client is never left staring at an empty pane waiting for the first
 * tick), then one `room` event per DIGEST CHANGE, a `: heartbeat` comment on unchanged ticks (which keeps
 * proxies from reaping an idle connection without pretending something happened), and exactly one terminal
 * `closed` event.
 *
 * A `read` that THROWS does not kill the connection: the room's own composition already degrades per section,
 * so a transient failure of the whole read is treated as "nothing new this tick" and retried on the next one.
 * Persisting past the lifetime bound is impossible either way.
 */
export async function* decisionRoomStreamEvents(deps: DecisionRoomStreamDeps, options: DecisionRoomStreamOptions = {}): AsyncGenerator<string> {
  const intervalMs = clampStreamIntervalMs(options.intervalMs);
  const maxLifetimeMs = options.maxLifetimeMs ?? DECISION_ROOM_STREAM_MAX_LIFETIME_MS;
  const startedAt = deps.now();
  let lastDigest: string | null = null;

  for (;;) {
    if (deps.aborted()) return;

    let result: CompaniesRequestResult | null;
    try {
      result = await deps.read();
    } catch {
      result = null; // Transient: fall through to the wait and try again on the next tick.
    }

    if (result !== null && result.status !== 'decision_room') {
      // The caller's authorization changed (or the store went away) WHILE CONNECTED. Say so and stop.
      yield sseEvent('closed', { reason: result.status === 'unavailable' ? 'unavailable' : ('unauthorized' satisfies StreamCloseReason) });
      return;
    }

    if (result !== null && result.room.digest !== lastDigest) {
      lastDigest = result.room.digest;
      yield sseEvent('room', roomEvent(result.room, intervalMs));
    } else {
      yield ': heartbeat\n\n';
    }

    if (deps.now() - startedAt + intervalMs > maxLifetimeMs) {
      // Reconnection is the client's business; an unbounded server-held connection is not.
      yield sseEvent('closed', { reason: 'max_lifetime' satisfies StreamCloseReason });
      return;
    }
    await deps.wait(intervalMs);
  }
}