/*
 * ACBP-FE-012 — the connection state machine.
 *
 * The row asks that "a stream disconnect degrades to polling rather than silently freezing". The trap is in
 * the word DISCONNECT: this stream ALWAYS ends. It carries a bounded lifetime and emits a terminal `closed`
 * event on every exit path, so ending is the NORMAL case and not a fault. A screen that treated every end as
 * an error would cry wolf on a five-minute timer; one that treated every end as routine would keep silently
 * reconnecting a caller whose access was revoked mid-stream.
 *
 * The four `closed` reasons therefore do not share an outcome, and that is what these tests pin.
 */
import { describe, expect, it } from 'vitest';
import { nextStreamState, initialStreamState, describeStream } from './stream-state';

describe('nextStreamState — the terminal reasons must not collapse', () => {
  it('treats a lifetime expiry as routine and reconnects', () => {
    // The server bounds every connection at five minutes and says so. Reconnecting is the client's job, and
    // showing an error here would report a fault the server deliberately caused.
    const s = nextStreamState(initialStreamState(), { kind: 'closed', reason: 'max_lifetime' });
    expect(s.mode).toBe('reconnecting');
    expect(s.isError).toBe(false);
  });

  it('STOPS on unauthorized and does not reconnect', () => {
    // The stream re-authorizes every tick, so this means the caller's access changed WHILE CONNECTED.
    // Reconnecting would hammer an endpoint that will keep refusing, and would hide the reason.
    const s = nextStreamState(initialStreamState(), { kind: 'closed', reason: 'unauthorized' });
    expect(s.mode).toBe('stopped');
    expect(s.isError).toBe(true);
    expect(s.detail.toLowerCase()).toContain('access');
  });

  it('degrades to polling when the server reports it is unavailable', () => {
    const s = nextStreamState(initialStreamState(), { kind: 'closed', reason: 'unavailable' });
    expect(s.mode).toBe('polling');
    expect(s.isError).toBe(false);
  });

  it('degrades to polling when the connection drops with NO terminal event', () => {
    // The one genuine fault: the server promises a `closed` on every exit, so its absence means the
    // connection died on the way. This is the case the row's "rather than silently freezing" is about.
    const s = nextStreamState(initialStreamState(), { kind: 'error' });
    expect(s.mode).toBe('polling');
    expect(s.detail.toLowerCase()).toContain('without');
  });

  it('gives the four terminal outcomes four different sentences', () => {
    const sentences = [
      nextStreamState(initialStreamState(), { kind: 'closed', reason: 'max_lifetime' }).detail,
      nextStreamState(initialStreamState(), { kind: 'closed', reason: 'unauthorized' }).detail,
      nextStreamState(initialStreamState(), { kind: 'closed', reason: 'unavailable' }).detail,
      nextStreamState(initialStreamState(), { kind: 'error' }).detail,
    ];
    expect(new Set(sentences).size).toBe(4);
  });

  it('does not invent an outcome for a reason the server has not defined', () => {
    const s = nextStreamState(initialStreamState(), { kind: 'closed', reason: 'something_new' });
    expect(s.mode).toBe('polling');
    expect(s.detail).toContain('something_new');
  });
});

describe('nextStreamState — a room event', () => {
  it('records the digest and stays live', () => {
    const s = nextStreamState(initialStreamState(), { kind: 'room', digest: 'd1', asOf: '2026-08-18T00:00:00.000Z' });
    expect(s.mode).toBe('live');
    expect(s.lastDigest).toBe('d1');
  });

  it('signals that a RE-READ is needed, because the event carries no items', () => {
    // Stream messages carry the digest and per-queue counts only — never queue payloads. So a change event
    // is a notification that the room moved, not the new room. Rendering counts from it while leaving stale
    // items on screen would show a section whose number and contents disagree.
    const s = nextStreamState(initialStreamState(), { kind: 'room', digest: 'd1', asOf: '2026-08-18T00:00:00.000Z' });
    expect(s.needsReread).toBe(true);
  });

  it('does not ask for a re-read when the digest has not moved', () => {
    const first = nextStreamState(initialStreamState(), { kind: 'room', digest: 'd1', asOf: '2026-08-18T00:00:00.000Z' });
    const again = nextStreamState({ ...first, needsReread: false }, { kind: 'room', digest: 'd1', asOf: '2026-08-18T00:00:01.000Z' });
    expect(again.needsReread).toBe(false);
  });

  it('treats a heartbeat as proof of life without claiming anything changed', () => {
    const s = nextStreamState(initialStreamState(), { kind: 'heartbeat' });
    expect(s.mode).toBe('live');
    expect(s.needsReread).toBe(false);
  });
});

describe('describeStream — the announced sentence', () => {
  it('never calls the connection live, real-time or push', () => {
    // Every server message states `deliveryMode: 'poll_backed'`, because there is no outbox and no
    // LISTEN/NOTIFY behind it. The contract promises only that a change is learned WITHIN one interval, so
    // "live" would claim a mechanism this system does not have.
    for (const state of [
      initialStreamState(),
      nextStreamState(initialStreamState(), { kind: 'room', digest: 'd', asOf: 'x' }),
      nextStreamState(initialStreamState(), { kind: 'closed', reason: 'max_lifetime' }),
      nextStreamState(initialStreamState(), { kind: 'error' }),
    ]) {
      const s = describeStream(state).toLowerCase();
      expect(s).not.toContain('real-time');
      expect(s).not.toContain('live updates');
      expect(s).not.toContain('push');
    }
  });

  it('is stable for an unchanged state, so the live region does not repeat itself', () => {
    const a = nextStreamState(initialStreamState(), { kind: 'heartbeat' });
    const b = nextStreamState(initialStreamState(), { kind: 'heartbeat' });
    expect(describeStream(a)).toBe(describeStream(b));
  });
});
