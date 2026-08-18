/*
 * ACBP-FE-012 — what the Decision Room screen believes about its connection, as a pure state machine.
 *
 * THE ROW'S REQUIREMENT HAS A TRAP IN IT. It asks that "a stream disconnect degrades to polling rather than
 * silently freezing", which reads as though disconnecting were the exceptional case. It is not: this stream
 * carries a bounded lifetime (five minutes) and emits a terminal `closed` event on every exit IT CONTROLS,
 * so it usually ends on purpose and for a reason that is nobody's fault. The server's own comment gives the
 * motive — "a stream that just stops is indistinguishable to a browser from a network fault, and 'the room
 * went quiet' must never be the way a founder learns their access changed."
 *
 * So the decision is not "did it disconnect" but WHICH ending happened, and five do not share an outcome:
 *
 *   max_lifetime  → routine. Reconnect. Showing an error would report a fault the server chose.
 *   unauthorized  → STOP. The server will keep refusing; retrying buries the reason.
 *   unavailable   → degrade to polling. The dependency is down; the plain read may still work.
 *   refused       → the connection was NEVER OPENED. A refusal, not a lost connection.
 *   lost          → ended with no terminal event. The genuine transport fault.
 *
 * `unauthorized` IS A COARSE TOKEN AND THE COPY MUST NOT SHARPEN IT. The server maps EVERY non-room,
 * non-unavailable result onto it, and its own comment says the reason "never distinguishes 'not a member'
 * from 'not allowed'". An earlier version of this file asserted it meant the caller's membership changed
 * while connected — a specific cause the server declined to state. It now says only that the server
 * refused, and that reconnecting will not change that.
 *
 * A `room` EVENT IS A NOTIFICATION, NOT THE ROOM. Messages carry the digest and per-queue counts only, so
 * the screen re-reads through the authorized path when the digest moves; rendering the event's counts
 * against still-stale items would show a section whose number and contents disagree.
 *
 * THE WORD "LIVE" IS NEVER SHOWN TO A FOUNDER. Every server message states `deliveryMode: 'poll_backed'` —
 * there is no outbox and no LISTEN/NOTIFY — so the contract promises only that a change is learned WITHIN
 * one interval. `StreamMode` keeps `live` as an INTERNAL token because it is the honest name for the machine
 * state; what a founder sees comes from {@link streamModeLabel}. An earlier version rendered the raw mode
 * into a badge, which put the banned word on screen while three files declared it banned.
 */

/** Internal machine state. NEVER rendered directly — see {@link streamModeLabel}. */
export type StreamMode = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'stopped';

export interface StreamState {
  readonly mode: StreamMode;
  /** True only for an ending a founder should treat as a problem — never for a routine lifetime expiry. */
  readonly isError: boolean;
  readonly detail: string;
  readonly lastDigest: string | null;
  /** Set when the digest moved: the event carries no items, so the caller must re-read to render them. */
  readonly needsReread: boolean;
  /**
   * Bumped ONLY when a NEW transport connection should be established. The panel keys its effect on this
   * rather than on `mode`, and that is load-bearing in both directions:
   *   - keying on `mode` froze the screen permanently: a second `max_lifetime` produced
   *     `reconnecting → reconnecting`, the handler closed the socket, the dependency string was unchanged
   *     so the effect never re-ran, and no replacement was ever opened — while polling stayed inert because
   *     it requires `mode === 'polling'`. The badge then said "reconnecting" forever;
   *   - and it tore down a HEALTHY connection on its first event, because `connecting → live` changes the
   *     same string, doubling connections and authorized reads on every cycle.
   */
  readonly connectionEpoch: number;
}

/** What the screen observes. `lost` = ended with no terminal event; `refused` = never opened at all. */
export type StreamSignal =
  | { readonly kind: 'room'; readonly digest: string; readonly asOf: string }
  | { readonly kind: 'open' }
  | { readonly kind: 'closed'; readonly reason: string }
  | { readonly kind: 'lost' }
  | { readonly kind: 'refused' };

/**
 * `seedDigest` is the digest of the room the SERVER already rendered. Without it the stream's immediate
 * first event always looks like a change and fires a redundant full re-read of a room already on screen —
 * a wasted authorized read on every connection.
 */
export function initialStreamState(seedDigest: string | null = null): StreamState {
  return { mode: 'connecting', isError: false, detail: 'Connecting to the update channel.', lastDigest: seedDigest, needsReread: false, connectionEpoch: 0 };
}

const CONNECTED_DETAIL = 'Connected. The server re-checks for changes on a short interval.';

export function nextStreamState(state: StreamState, signal: StreamSignal): StreamState {
  switch (signal.kind) {
    case 'room': {
      const moved = signal.digest !== state.lastDigest;
      return { ...state, mode: 'live', isError: false, detail: CONNECTED_DETAIL, lastDigest: signal.digest, needsReread: moved };
    }
    case 'open':
      // THE CONNECTION IS ESTABLISHED. Deliberately NOT a heartbeat listener: the server does emit a
      // heartbeat on every unchanged tick, but writes it as an SSE COMMENT, and EventSource ignores comments
      // entirely — they dispatch no event. Its only named events are `room` and `closed`, and `message`
      // fires only for a message with no event field, so a heartbeat is invisible to this client by
      // construction. Listening for one would have been a branch that could never run.
      return { ...state, mode: 'live', isError: false, detail: CONNECTED_DETAIL, needsReread: false };
    case 'closed':
      switch (signal.reason) {
        case 'max_lifetime':
          // The EPOCH BUMP is what actually reconnects — see `connectionEpoch`.
          return { ...state, mode: 'reconnecting', isError: false, detail: 'The update channel reached its time limit, which is normal — the server ends every connection after a few minutes. Reconnecting.', needsReread: false, connectionEpoch: state.connectionEpoch + 1 };
        case 'unauthorized':
          return { ...state, mode: 'stopped', isError: true, detail: 'The server refused to keep the update channel open for this company, and reconnecting will not change that. It does not say which of several reasons applied. What is shown below is from the last successful read — reload to see what you can still access.', needsReread: false };
        case 'unavailable':
          return { ...state, mode: 'polling', isError: false, detail: 'The server reported that something the update channel depends on is down, so this page will re-read the room on a timer instead.', needsReread: false };
        default:
          return { ...state, mode: 'polling', isError: false, detail: `The server ended the update channel with a reason this page does not recognise (${signal.reason}), so it will re-read the room on a timer instead.`, needsReread: false };
      }
    case 'refused':
      // NEVER OPENED. The route authorizes BEFORE writing a 200 precisely so a refusal arrives as an
      // ordinary error envelope rather than as a dead stream — reporting it as "the connection was lost"
      // would throw away the distinction the route was built to preserve.
      return { ...state, mode: 'polling', isError: true, detail: 'The server would not open the update channel — it refused the request rather than dropping it. This page will re-read the room on a timer instead; if the room stops loading too, your access has probably changed.', needsReread: false };
    case 'lost':
    default:
      return { ...state, mode: 'polling', isError: false, detail: 'The update channel ended without the server saying why, which usually means the connection was lost in transit. This page will re-read the room on a timer instead.', needsReread: false };
  }
}

/**
 * The founder-facing name for a machine state. `mode` is never rendered: its `live` token is exactly the
 * word this screen must not show, because the channel is poll-backed and its own payload says so.
 */
export function streamModeLabel(mode: StreamMode): string {
  switch (mode) {
    case 'connecting':
      return 'connecting';
    case 'live':
      return 'connected';
    case 'reconnecting':
      return 'reconnecting';
    case 'polling':
      return 'on a timer';
    case 'stopped':
    default:
      return 'stopped';
  }
}

/** The one sentence the polite live region announces about the channel. Pure over state. */
export function describeStream(state: StreamState): string {
  switch (state.mode) {
    case 'connecting':
      return 'Connecting to the update channel.';
    case 'live':
      return 'The update channel is connected and re-checks for changes on a short interval.';
    case 'reconnecting':
      return 'The update channel reached its normal time limit and is reconnecting.';
    case 'polling':
      return 'The update channel is not connected. This page is re-reading the room on a timer instead.';
    case 'stopped':
    default:
      return 'The update channel stopped because the server refused to keep it open.';
  }
}
