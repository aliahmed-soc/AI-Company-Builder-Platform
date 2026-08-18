'use client';

/*
 * ACBP-FE-012 — the Decision Room's live half.
 *
 * THE CONNECTION LOGIC LIVES IN `stream-state.ts`, not here. This component owns the transport and nothing
 * else, for the same reason the server split its generator from its route: the interesting decisions — which
 * of four endings happened, whether a re-read is owed — are testable only if they are not tangled up with an
 * EventSource.
 *
 * EVENTSOURCE'S OWN RECONNECT IS TURNED OFF BY CLOSING IT. The browser reconnects automatically on a dropped
 * connection, which would fight the state machine in the one case that matters: an `unauthorized` close means
 * access was revoked mid-stream, and an automatic retry would hammer an endpoint that will keep refusing
 * while hiding the reason. So every terminal event closes the source explicitly, and reconnection happens
 * only where this screen decides it should.
 *
 * A CHANGE EVENT TRIGGERS A RE-READ, NEVER A RENDER. Stream messages carry the digest and per-queue counts
 * only, so painting those counts beside the items already on screen would show a section whose number and
 * contents disagree. The digest moving means "go and look", and looking is the plain authorized GET.
 *
 * NOTHING HERE MUTATES. The row excludes inline decision actions until FE-013's APIs exist, and they do not
 * exist — so this screen sends no unsafe method at all, and there is no same-origin write to protect.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DecisionRoomView } from '@acbp/contracts';
import { describeRoom, toRoomView, type QueueView } from './room-view';
import { describeStream, initialStreamState, nextStreamState, type StreamState } from './stream-state';

/** How often to re-read when the channel is not connected. Deliberately slower than the stream's own tick. */
const POLL_INTERVAL_MS = 15_000;

export function DecisionRoomPanel({ companyId, initialRoom }: { companyId: string; initialRoom: DecisionRoomView }): React.JSX.Element {
  const [room, setRoom] = useState<DecisionRoomView>(initialRoom);
  const [stream, setStream] = useState<StreamState>(initialStreamState());
  const [readError, setReadError] = useState<string | null>(null);
  const streamRef = useRef<StreamState>(stream);
  streamRef.current = stream;

  const base = `/api/companies/${encodeURIComponent(companyId)}/decision-room`;

  const reread = useCallback(async (): Promise<void> => {
    try {
      // No query string: the read allows none, and a cache-buster would turn every refresh into a 400.
      const res = await fetch(base, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        // A failed re-read says nothing about the room — only about this page's view of it. The existing
        // room stays on screen, flagged, rather than being replaced by an empty one.
        setReadError('The room could not be re-read just now, so what is shown may be out of date.');
        return;
      }
      const body = (await res.json()) as { room: DecisionRoomView };
      setRoom(body.room);
      setReadError(null);
    } catch {
      setReadError('The room could not be re-read just now, so what is shown may be out of date.');
    }
  }, [base]);

  // The update channel. Re-established when the state machine asks for it, and never by EventSource itself.
  useEffect(() => {
    if (stream.mode === 'stopped' || stream.mode === 'polling') return;

    const source = new EventSource(`${base}/stream`);
    let live = true;

    const advance = (signal: Parameters<typeof nextStreamState>[1]): void => {
      if (!live) return;
      const next = nextStreamState(streamRef.current, signal);
      setStream(next);
      if (next.needsReread) void reread();
      if (next.mode === 'stopped' || next.mode === 'polling' || next.mode === 'reconnecting') source.close();
    };

    source.addEventListener('room', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent<string>).data) as { digest?: unknown; asOf?: unknown };
        if (typeof data.digest === 'string' && typeof data.asOf === 'string') advance({ kind: 'room', digest: data.digest, asOf: data.asOf });
      } catch {
        // An unreadable event is not a change; the next tick will carry the digest again.
      }
    });

    source.addEventListener('closed', (e) => {
      let reason = 'unknown';
      try {
        const data = JSON.parse((e as MessageEvent<string>).data) as { reason?: unknown };
        if (typeof data.reason === 'string') reason = data.reason;
      } catch {
        /* fall through with 'unknown' — the state machine names it rather than guessing */
      }
      advance({ kind: 'closed', reason });
    });

    // EventSource surfaces a comment-only tick as nothing at all, so `message` standing in for the
    // heartbeat is the closest observable signal that the connection is alive.
    source.addEventListener('message', () => advance({ kind: 'heartbeat' }));

    // An `error` here means the connection ended WITHOUT the server's terminal event — the genuine fault.
    source.addEventListener('error', () => advance({ kind: 'error' }));

    return () => {
      live = false;
      source.close();
    };
    // `stream.mode` is the trigger: a move to `reconnecting` tears this down and mounts a fresh connection.
  }, [base, stream.mode, reread]);

  // The polling fallback. Runs ONLY when the channel is not carrying updates, so the two never double up.
  useEffect(() => {
    if (stream.mode !== 'polling') return;
    const t = setInterval(() => void reread(), POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [stream.mode, reread]);

  const view = toRoomView(room);
  const announcement = `${describeRoom(view)} ${describeStream(stream)}`;
  const lastAnnounced = useRef<string>('');
  const changed = announcement !== lastAnnounced.current;
  if (changed) lastAnnounced.current = announcement;

  return (
    <>
      {/* Polite and sr-only: queue movement is information, not an interruption, and the counts below say
          the same thing visually. A separate node from the queues, because a live region whose children
          re-render wholesale frequently announces nothing at all. */}
      <p aria-live="polite" className="cs-sr-only" data-announcement={changed ? 'changed' : 'same'}>
        {announcement}
      </p>

      <section className="cs-card" aria-labelledby="cs-dr-status-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-dr-status-h">
            Updates
          </h2>
          <span className={`cs-badge cs-badge--muted cs-dr-mode`} data-mode={stream.mode}>
            {stream.mode}
          </span>
        </div>
        {/* The channel's own state, in words. `isError` is true ONLY for an ending the founder should treat
            as a problem — a lifetime expiry is routine and must not be dressed as a failure. */}
        <p className={stream.isError ? 'cs-control-outcome cs-control-outcome--refused' : 'cs-help'} role="status">
          {stream.detail}
        </p>
        <div aria-live="polite" className="cs-outcome-region">
          {readError === null ? null : (
            <p className="cs-control-outcome cs-control-outcome--error" role="status">
              {readError}
            </p>
          )}
        </div>
        <p className="cs-help">
          As of {view.asOf}. {view.incomplete ? `${view.answeredCount} of ${view.totalQueues} queues reported — the rest are shown without a number.` : `All ${view.totalQueues} queues reported.`}
        </p>
      </section>

      <section className="cs-card" aria-labelledby="cs-dr-q-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-dr-q-h">
            Queues
          </h2>
        </div>
        <ul className="cs-queues">
          {view.queues.map((q) => (
            <QueueCard key={q.queue} q={q} />
          ))}
        </ul>
      </section>
    </>
  );
}

function QueueCard({ q }: { q: QueueView }): React.JSX.Element {
  const headingId = `cs-dr-q-${q.queue}`;
  return (
    <li className={`cs-queue cs-queue--${q.tone}`} data-queue={q.queue} data-tone={q.tone}>
      <div className="cs-queue-h">
        <h3 className="cs-queue-t" id={headingId}>
          {q.label}
        </h3>
        {/* An em dash where a number would go, for a queue that did not report. Never a 0 — that would be an
            answer the server explicitly declined to give. The note beside it carries the real meaning, so
            the distinction is never left to a glyph alone. */}
        <span className="cs-queue-count" aria-label={q.count === null ? `${q.label}: no count reported` : `${q.label}: ${String(q.count)} items`}>
          {q.countLabel}
        </span>
      </div>
      {q.note === null ? null : <p className="cs-queue-note">{q.note}</p>}
      {q.items.length === 0 ? null : (
        <ul className="cs-queue-items" aria-labelledby={headingId}>
          {q.items.map((it) => (
            <li key={it.id} className="cs-queue-item">
              <span className="cs-queue-item-t">{it.title}</span>
              <span className="cs-queue-item-meta">
                {it.kind} · {it.state}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
