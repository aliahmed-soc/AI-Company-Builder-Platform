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
import { nextStreamState, initialStreamState, describeStream, streamModeLabel } from './stream-state';

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
    const s = nextStreamState(initialStreamState(), { kind: 'lost' });
    expect(s.mode).toBe('polling');
    expect(s.detail.toLowerCase()).toContain('without');
    // A lost connection is not the founder's problem to solve, so it must NOT be flagged as an error.
    expect(s.isError).toBe(false);
  });

  it('gives the four terminal outcomes four different sentences', () => {
    const sentences = [
      nextStreamState(initialStreamState(), { kind: 'closed', reason: 'max_lifetime' }).detail,
      nextStreamState(initialStreamState(), { kind: 'closed', reason: 'unauthorized' }).detail,
      nextStreamState(initialStreamState(), { kind: 'closed', reason: 'unavailable' }).detail,
      nextStreamState(initialStreamState(), { kind: 'lost' }).detail,
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

  it('treats the connection opening as proof of life without claiming anything changed', () => {
    const s = nextStreamState(initialStreamState(), { kind: 'open' });
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
      nextStreamState(initialStreamState(), { kind: 'lost' }),
    ]) {
      const s = describeStream(state).toLowerCase();
      expect(s).not.toContain('real-time');
      expect(s).not.toContain('live updates');
      expect(s).not.toContain('push');
    }
  });

  it('is stable for an unchanged state, so the live region does not repeat itself', () => {
    const a = nextStreamState(initialStreamState(), { kind: 'open' });
    const b = nextStreamState(initialStreamState(), { kind: 'open' });
    expect(describeStream(a)).toBe(describeStream(b));
  });
});

describe('nextStreamState — the connection epoch is what actually reconnects', () => {
  it('bumps the epoch on a lifetime expiry, so a repeated expiry still reopens', () => {
    // The freeze an independent review found: keying the transport effect on `mode` meant a second
    // max_lifetime produced reconnecting -> reconnecting, an unchanged dependency string, a closed socket
    // and no replacement — the badge said "reconnecting" forever while nothing was connected and polling
    // stayed inert. The epoch changes on every expiry, so each one reopens.
    const first = nextStreamState(initialStreamState(), { kind: 'closed', reason: 'max_lifetime' });
    const second = nextStreamState(first, { kind: 'closed', reason: 'max_lifetime' });
    expect(first.connectionEpoch).toBe(1);
    expect(second.connectionEpoch).toBe(2);
    expect(second.mode).toBe('reconnecting');
  });

  it('does not bump the epoch for endings that must NOT reopen', () => {
    for (const reason of ['unauthorized', 'unavailable']) {
      expect(nextStreamState(initialStreamState(), { kind: 'closed', reason }).connectionEpoch).toBe(0);
    }
    expect(nextStreamState(initialStreamState(), { kind: 'lost' }).connectionEpoch).toBe(0);
    expect(nextStreamState(initialStreamState(), { kind: 'refused' }).connectionEpoch).toBe(0);
  });
});

describe('nextStreamState — a refusal to OPEN is not a lost connection', () => {
  it('separates them, because the route answers a refusal as an ordinary envelope on purpose', () => {
    const refused = nextStreamState(initialStreamState(), { kind: 'refused' });
    const lost = nextStreamState(initialStreamState(), { kind: 'lost' });
    expect(refused.detail).not.toBe(lost.detail);
    expect(refused.isError).toBe(true);
    expect(lost.isError).toBe(false);
    expect(refused.detail.toLowerCase()).toContain('refused');
  });

  it('still degrades to polling on both, because the plain read may work when the channel does not', () => {
    expect(nextStreamState(initialStreamState(), { kind: 'refused' }).mode).toBe('polling');
    expect(nextStreamState(initialStreamState(), { kind: 'lost' }).mode).toBe('polling');
  });
});

describe('nextStreamState — the seeded digest', () => {
  it('does not treat the first event as a change when it matches the server-rendered room', () => {
    // Without the seed, the stream's immediate first event always looked like a change and fired a
    // redundant full re-read of the room already on screen.
    const s = nextStreamState(initialStreamState('d1'), { kind: 'room', digest: 'd1', asOf: 'x' });
    expect(s.needsReread).toBe(false);
  });

  it('still detects a genuine first change', () => {
    expect(nextStreamState(initialStreamState('d1'), { kind: 'room', digest: 'd2', asOf: 'x' }).needsReread).toBe(true);
  });
});

describe('the unauthorized copy must not sharpen a coarse token', () => {
  it('says the server refused without asserting which cause', () => {
    // The server maps EVERY non-room, non-unavailable result onto `unauthorized`, and its own comment says
    // the reason never distinguishes "not a member" from "not allowed". An earlier draft asserted the
    // caller's access "changed while it was open" — a specific cause the server declined to state.
    const d = nextStreamState(initialStreamState(), { kind: 'closed', reason: 'unauthorized' }).detail.toLowerCase();
    expect(d).toContain('refused');
    expect(d).not.toContain('changed while it was open');
  });
});

describe('streamModeLabel — what a founder actually sees', () => {
  it('NEVER renders the internal `live` token', () => {
    // Three files declare the word banned because the channel is poll-backed. The badge used to render the
    // raw mode, which put it on screen anyway; the previous test only inspected describeStream.
    const labels = (['connecting', 'live', 'reconnecting', 'polling', 'stopped'] as const).map(streamModeLabel);
    for (const l of labels) expect(l).not.toContain('live');
    expect(streamModeLabel('live')).toBe('connected');
  });

  it('gives all five modes distinct labels', () => {
    const labels = (['connecting', 'live', 'reconnecting', 'polling', 'stopped'] as const).map(streamModeLabel);
    expect(new Set(labels).size).toBe(5);
  });
});

describe('describeStream — the content, not just its stability', () => {
  it('gives all five modes distinct sentences', () => {
    // The earlier pair of tests (absence of substrings, plus equality of two identical states) were both
    // satisfied by a constant function — proved by mutation. This is the assertion that was missing.
    const all = (['connecting', 'live', 'reconnecting', 'polling', 'stopped'] as const).map((mode) => describeStream({ ...initialStreamState(), mode }));
    expect(new Set(all).size).toBe(5);
  });

  it('describes the stopped mode as a refusal rather than a disconnection', () => {
    expect(describeStream({ ...initialStreamState(), mode: 'stopped' }).toLowerCase()).toContain('refused');
  });
});