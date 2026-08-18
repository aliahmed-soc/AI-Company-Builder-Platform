/*
 * ACBP-FE-012 — what the Decision Room screen believes about its connection, as a pure state machine.
 *
 * THE ROW'S REQUIREMENT HAS A TRAP IN IT. It asks that "a stream disconnect degrades to polling rather than
 * silently freezing", which reads as though disconnecting were the exceptional case. It is not: this stream
 * carries a bounded lifetime (five minutes) and emits a terminal `closed` event on EVERY exit path, so it
 * always ends, on purpose, and usually for a reason that is nobody's fault. The server's own comment gives
 * the motive — "a stream that just stops is indistinguishable to a browser from a network fault, and 'the
 * room went quiet' must never be the way a founder learns their access changed."
 *
 * So the interesting decision is not "did it disconnect" but WHICH of four endings happened, and those four
 * do not share an outcome:
 *
 *   max_lifetime  → routine. Reconnect. Showing an error here would report a fault the server chose.
 *   unauthorized  → STOP. The stream re-authorizes on every tick, so this means access changed WHILE
 *                   CONNECTED. Reconnecting would hammer an endpoint that will keep refusing and would bury
 *                   the one thing the founder needs to know.
 *   unavailable   → degrade to polling. The dependency is down; the plain read may still work.
 *   no event      → the genuine fault. The server promises a terminal event, so its ABSENCE means the
 *                   connection died in transit. This is the case the row's phrase is really about.
 *
 * A `room` EVENT IS A NOTIFICATION, NOT THE ROOM. Stream messages carry the digest and per-queue counts
 * only — never queue payloads, deliberately, so a long-lived connection cannot become a slow leak of item
 * content. The screen therefore re-reads through the authorized request path when the digest moves;
 * rendering the event's counts against still-stale items would show a section whose number and contents
 * disagree.
 *
 * AND THE WORD "LIVE" IS BANNED FROM THE COPY. Every server message states `deliveryMode: 'poll_backed'`
 * because there is no outbox and no LISTEN/NOTIFY behind it — the contract promises only that a change is
 * learned WITHIN one interval. Calling it real-time or push would claim a mechanism this system does not
 * have.
 */

/** What the screen is doing about updates right now. */
export type StreamMode = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'stopped';

export interface StreamState {
  readonly mode: StreamMode;
  /** True only for an ending the founder should treat as a problem — NOT for a routine lifetime expiry. */
  readonly isError: boolean;
  readonly detail: string;
  /** The last digest seen, so an unchanged re-emission does not trigger a pointless re-read. */
  readonly lastDigest: string | null;
  /** Set when the digest moved: the event carries no items, so the caller must re-read to render them. */
  readonly needsReread: boolean;
}

/** The events the screen can observe. `error` means the connection ended WITHOUT a terminal event. */
export type StreamSignal =
  | { readonly kind: 'room'; readonly digest: string; readonly asOf: string }
  | { readonly kind: 'heartbeat' }
  | { readonly kind: 'closed'; readonly reason: string }
  | { readonly kind: 'error' };

export function initialStreamState(): StreamState {
  return { mode: 'connecting', isError: false, detail: 'Connecting to the update channel.', lastDigest: null, needsReread: false };
}

export function nextStreamState(state: StreamState, signal: StreamSignal): StreamState {
  switch (signal.kind) {
    case 'room': {
      const moved = signal.digest !== state.lastDigest;
      return { mode: 'live', isError: false, detail: 'Connected. The server re-checks for changes on a short interval.', lastDigest: signal.digest, needsReread: moved };
    }
    case 'heartbeat':
      // Proof the connection is alive, and an explicit statement that nothing moved. It must NOT be read as
      // a change, or every idle tick would trigger a re-read.
      return { ...state, mode: 'live', isError: false, detail: 'Connected. The server re-checks for changes on a short interval.', needsReread: false };
    case 'closed':
      switch (signal.reason) {
        case 'max_lifetime':
          return { ...state, mode: 'reconnecting', isError: false, detail: 'The update channel reached its time limit, which is normal — the server ends every connection after a few minutes. Reconnecting.', needsReread: false };
        case 'unauthorized':
          return { ...state, mode: 'stopped', isError: true, detail: 'The server ended the update channel because your access to this company changed while it was open. Nothing further will load here until that is resolved. Reload to see what you can still read.', needsReread: false };
        case 'unavailable':
          return { ...state, mode: 'polling', isError: false, detail: 'The server reported that something the update channel depends on is down, so this page will re-read the room on a timer instead.', needsReread: false };
        default:
          // Names the reason rather than guessing at it. A server that adds a fifth reason should not be
          // silently folded into one of the four this screen happens to know.
          return { ...state, mode: 'polling', isError: false, detail: `The server ended the update channel with a reason this page does not recognise (${signal.reason}), so it will re-read the room on a timer instead.`, needsReread: false };
      }
    case 'error':
    default:
      // The genuine fault: the server emits a terminal event on every exit it controls, so an ending
      // WITHOUT one means the connection was lost rather than closed.
      return { ...state, mode: 'polling', isError: false, detail: 'The update channel ended without the server saying why, which usually means the connection was lost. This page will re-read the room on a timer instead.', needsReread: false };
  }
}

/**
 * The one sentence the polite live region announces. Pure over the state, so an unchanged state produces an
 * identical string and the region stays quiet.
 */
export function describeStream(state: StreamState): string {
  switch (state.mode) {
    case 'connecting':
      return 'Connecting to the update channel.';
    case 'live':
      // Deliberately says "re-checks", never "live" or "real-time": the channel is poll-backed and its own
      // payload says so.
      return 'The update channel is connected and re-checks for changes on a short interval.';
    case 'reconnecting':
      return 'The update channel reached its normal time limit and is reconnecting.';
    case 'polling':
      return 'The update channel is not connected. This page is re-reading the room on a timer instead.';
    case 'stopped':
    default:
      return 'The update channel stopped because your access to this company changed.';
  }
}
