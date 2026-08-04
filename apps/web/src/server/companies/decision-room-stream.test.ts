// ACBP-P6-008 — unit tests for the Decision Room live channel (no socket, no clock, no database).
//
// The claims under test are the ones a long-lived connection gets wrong in practice: it keeps feeding a caller
// whose access was revoked, it never ends, it leaks payload, or it dies silently.
import { describe, test, expect } from 'vitest';
import { DECISION_ROOM_QUEUES, okSection, type DecisionRoomView } from '@acbp/contracts';
import { decisionRoomStreamEvents, type DecisionRoomStreamDeps } from './decision-room-stream.js';
import type { CompaniesRequestResult } from './companies-request.js';

function room(digest: string, count = 0): DecisionRoomView {
  return {
    sections: DECISION_ROOM_QUEUES.map((q) => okSection(q, [], count)),
    integrity: { unverifiedCompletions: 0 },
    usage: { status: 'ok', figures: null },
    asOf: '2026-08-01T00:00:00.000Z',
    digest,
  };
}

const ok = (digest: string, count = 0): CompaniesRequestResult => ({ status: 'decision_room', room: room(digest, count) });

/** Drives the generator with a scripted sequence of reads and a virtual clock. */
async function run(script: readonly (CompaniesRequestResult | Error)[], options: { intervalMs?: number; maxLifetimeMs?: number; abortAfter?: number } = {}): Promise<string[]> {
  const intervalMs = options.intervalMs ?? 2_000;
  let clock = 0;
  let tick = 0;
  let stopped = false;
  const deps: DecisionRoomStreamDeps = {
    read: () => {
      const step = script[Math.min(tick, script.length - 1)] ?? ok('d0');
      tick += 1;
      if (step instanceof Error) return Promise.reject(step);
      return Promise.resolve(step);
    },
    wait: (ms) => {
      clock += ms;
      if (options.abortAfter !== undefined && tick >= options.abortAfter) stopped = true;
      return Promise.resolve();
    },
    now: () => clock,
    aborted: () => stopped,
  };
  const out: string[] = [];
  for await (const chunk of decisionRoomStreamEvents(deps, { intervalMs, ...(options.maxLifetimeMs !== undefined ? { maxLifetimeMs: options.maxLifetimeMs } : {}) })) {
    out.push(chunk);
    if (out.length > 50) throw new Error('stream did not terminate');
  }
  return out;
}

const parse = (chunk: string): { event: string; data: Record<string, unknown> } => {
  const [head, body] = chunk.split('\n');
  return { event: (head ?? '').replace('event: ', ''), data: JSON.parse((body ?? '').replace('data: ', '')) as Record<string, unknown> };
};

describe('decisionRoomStreamEvents — ACBP-P6-008 (DEC-001 live updates)', () => {
  test('the first event is immediate: a client never waits an interval to see the room', async () => {
    const out = await run([ok('d1')], { maxLifetimeMs: 2_500 });
    expect(parse(out[0] ?? '').event).toBe('room');
  });

  test('emits ONLY on digest change; unchanged ticks are heartbeats, not repeated rooms', async () => {
    const out = await run([ok('d1'), ok('d1'), ok('d2', 3), ok('d2')], { intervalMs: 1_000, maxLifetimeMs: 4_500 });
    const events = out.filter((c) => c.startsWith('event: room')).map((c) => parse(c).data['digest']);
    expect(events).toEqual(['d1', 'd2']);
    expect(out.filter((c) => c.startsWith(': heartbeat')).length).toBeGreaterThan(0);
  });

  test('an event carries counts and the change token — NEVER item payloads', async () => {
    const out = await run([ok('d1', 7)], { maxLifetimeMs: 2_500 });
    const first = parse(out[0] ?? '');
    expect(Object.keys(first.data).sort()).toEqual(['asOf', 'counts', 'deliveryMode', 'digest', 'intervalSeconds']);
    expect(first.data['counts']).toMatchObject({ needs_your_decision: 7 });
    expect(JSON.stringify(first.data)).not.toContain('items');
  });

  test('every message states the delivery mode: the client is told it is POLL-BACKED, not pushed', async () => {
    const out = await run([ok('d1')], { intervalMs: 3_000, maxLifetimeMs: 3_500 });
    expect(parse(out[0] ?? '').data).toMatchObject({ deliveryMode: 'poll_backed', intervalSeconds: 3 });
  });

  test('REVOKED MID-STREAM: the tick that loses authorization ends the stream and says so', async () => {
    const out = await run([ok('d1'), { status: 'forbidden' }], { intervalMs: 1_000, maxLifetimeMs: 60_000 });
    const last = parse(out[out.length - 1] ?? '');
    expect(last.event).toBe('closed');
    expect(last.data).toEqual({ reason: 'unauthorized' });
    // And nothing further was emitted after the refusal.
    expect(out.filter((c) => c.startsWith('event: room')).length).toBe(1);
  });

  test('the close reason is COARSE: not_found and forbidden are indistinguishable on the wire', async () => {
    const forbidden = await run([{ status: 'forbidden' }], { maxLifetimeMs: 60_000 });
    const notFound = await run([{ status: 'not_found' }], { maxLifetimeMs: 60_000 });
    expect(forbidden).toEqual(notFound);
  });

  test('a transient read failure is a heartbeat, not a disconnection — the next tick recovers', async () => {
    const out = await run([new Error('pool exhausted'), ok('d1')], { intervalMs: 1_000, maxLifetimeMs: 3_500 });
    expect(out[0]).toBe(': heartbeat\n\n');
    expect(out.some((c) => c.startsWith('event: room') && parse(c).data['digest'] === 'd1')).toBe(true);
  });

  test('IT ALWAYS ENDS: the lifetime bound closes the stream with a named reason', async () => {
    const out = await run([ok('d1')], { intervalMs: 1_000, maxLifetimeMs: 5_000 });
    const last = parse(out[out.length - 1] ?? '');
    expect(last.event).toBe('closed');
    expect(last.data).toEqual({ reason: 'max_lifetime' });
  });

  test('a disconnected client stops the loop instead of holding a read slot', async () => {
    const out = await run([ok('d1'), ok('d2'), ok('d3')], { intervalMs: 1_000, maxLifetimeMs: 600_000, abortAfter: 2 });
    expect(out.filter((c) => c.startsWith('event: room')).length).toBe(2);
  });
});
